/**
 * Agent loop - autonomous task execution.
 *
 * Private chat/stream logic lives in agentChat.ts and agentStream.ts.
 */

import { ProjectContext } from './project';

// Debug logging helper - writes to log file when CODEEP_DEBUG=1
import { logger } from './logger';
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

// Import chat layer (prompt building + API calls)
import {
  agentChat,
  getAgentSystemPrompt,
  getFallbackSystemPrompt,
  TimeoutError,
  loadProjectRules,
  loadProgressLog,
  writeProgressLog,
  formatChatHistoryForAgent,
  summarizeEarlierHistory,
} from './agentChat';
import { ApiError } from '../api/index';
import type { AgentChatResponse } from './agentChat';
export { loadProjectRules, loadProgressLog, writeProgressLog, formatChatHistoryForAgent };
export type { AgentChatResponse };

/**
 * Calculate dynamic timeout based on task complexity
 * Complex tasks (creating pages, multiple files) need more time
 */
function calculateDynamicTimeout(iteration: number, baseTimeout: number): number {
  // Simple approach: just use base timeout with small multiplier for later iterations
  // Complex calculations were causing more problems than they solved
  
  let multiplier = 1.0;
  
  // Later iterations have larger context, may need slightly more time
  if (iteration > 3) {
    multiplier = 1.2;
  }
  if (iteration > 8) {
    multiplier = 1.5;
  }
  
  // Minimum 120 seconds, no hard upper cap — let agentApiTimeout setting be the real ceiling
  const calculatedTimeout = baseTimeout * multiplier;
  return Math.max(calculatedTimeout, 120000);
}
import {
  parseToolCalls,
  executeTool,
  createActionLog,
  ToolCall,
  ToolResult,
  ActionLog
} from './tools';
import { config, Message } from '../config/index';
import { supportsNativeTools } from '../config/providers';
import { startSession, endSession, undoLastAction, undoAllActions, getCurrentSession, getRecentSessions, formatSession, ActionSession } from './history';
import { runAllVerifications, formatErrorsForAgent, hasVerificationErrors, getVerificationSummary, VerifyResult } from './verify';
import { gatherSmartContext, formatSmartContext, extractTargetFile } from './smartContext';
import { planTasks, getNextTask, formatTaskPlan, TaskPlan, SubTask } from './taskPlanner';
import { getTaskContextPrompt } from './taskContext';
import { getLastUsage, getModelContextWindow } from './tokenTracker';

// ─── Tool result truncation ───────────────────────────────────────────────────

const TOOL_RESULT_MAX_CHARS = 8_000; // ~2K tokens per tool result

function truncateToolResult(output: string, toolName: string): string {
  if (output.length <= TOOL_RESULT_MAX_CHARS) return output;
  const kept = output.slice(0, TOOL_RESULT_MAX_CHARS);
  const truncated = output.length - TOOL_RESULT_MAX_CHARS;
  return `${kept}\n[... ${truncated} chars truncated — use search_code or read specific sections if you need more]`;
}

// ─── Context window compression ───────────────────────────────────────────────

const CONTEXT_COMPRESS_THRESHOLD = 200_000; // ~50K tokens, safe for all providers
const RECENT_MESSAGES_TO_KEEP = 6; // Always preserve the last N messages verbatim

/**
 * Compress old messages when the conversation grows too large.
 * Keeps the first message (original task) and the last RECENT_MESSAGES_TO_KEEP
 * messages intact. Everything in between is replaced with a compact summary
 * built from the actions log — no extra API call needed.
 */
function compressMessages(messages: Message[], actions: ActionLog[]): Message[] {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars < CONTEXT_COMPRESS_THRESHOLD) return messages;

  // Need at least first + recent block to be worth compressing
  if (messages.length <= RECENT_MESSAGES_TO_KEEP + 1) return messages;

  const firstMessage = messages[0];

  // Build summary from action log
  const fileWrites = actions.filter(a => a.type === 'write' || a.type === 'edit');
  const fileDeletes = actions.filter(a => a.type === 'delete');
  const commands = actions.filter(a => a.type === 'command');
  const reads = actions.filter(a => a.type === 'read');

  const summaryLines: string[] = ['[Context compressed — summary of work so far]'];
  if (fileWrites.length > 0) {
    summaryLines.push(`Files written/edited (${fileWrites.length}): ${fileWrites.map(a => a.target).join(', ')}`);
  }
  if (fileDeletes.length > 0) {
    summaryLines.push(`Files deleted: ${fileDeletes.map(a => a.target).join(', ')}`);
  }
  if (commands.length > 0) {
    summaryLines.push(`Commands run: ${commands.map(a => a.target).join(', ')}`);
  }
  if (reads.length > 0) {
    summaryLines.push(`Files read (${reads.length}): ${reads.slice(-10).map(a => a.target).join(', ')}`);
  }
  summaryLines.push('[End of summary — continuing from current state]');

  const summaryMessage: Message = { role: 'user', content: summaryLines.join('\n') };

  // Reduce recent messages kept until compressed result fits under threshold (min 2)
  let keep = RECENT_MESSAGES_TO_KEEP;
  let recentMessages = messages.slice(-keep);
  while (keep > 2) {
    const compressedChars = firstMessage.content.length + summaryMessage.content.length +
      recentMessages.reduce((sum, m) => sum + m.content.length, 0);
    if (compressedChars < CONTEXT_COMPRESS_THRESHOLD) break;
    keep--;
    recentMessages = messages.slice(-keep);
  }

  debug(`Context compressed: ${totalChars} chars → keeping first + summary + last ${keep} messages`);
  return [firstMessage, summaryMessage, ...recentMessages];
}

// ──────────────────────────────────────────────────────────────────────────────

export type PermissionOutcome = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AgentOptions {
  maxIterations: number;
  maxDuration: number; // milliseconds
  onChunk?: (text: string) => void;
  onToolCall?: (tool: ToolCall) => void;
  onToolResult?: (result: ToolResult, toolCall: ToolCall) => void;
  onIteration?: (iteration: number, message: string) => void;
  onThinking?: (text: string) => void;
  onVerification?: (results: VerifyResult[]) => void;
  onTaskPlan?: (plan: TaskPlan) => void;
  onTaskUpdate?: (task: SubTask) => void;
  onRequestPermission?: (toolCall: ToolCall) => Promise<PermissionOutcome>;
  onExecuteCommand?: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Optional filesystem callbacks. When the ACP client advertises `fs`
   * capability, the server populates these so read_file/write_file/edit_file
   * tools route through the client (preserving dirty buffers and undo
   * history) instead of touching disk directly. Falls back to disk if not
   * provided or if a delegated call throws.
   */
  fs?: import('./toolExecution').FsCallbacks;
  /**
   * Optional ACP session id used to route MCP-prefixed tool calls
   * (`<server>__<tool>`) to the per-session `mcpRegistry`. Not set in TUI
   * mode (no MCP support there yet); set by `runAgentSession` in ACP mode.
   * When set, the agent loop also fetches the session's MCP tool list and
   * passes it into the provider's tool catalog so the model can invoke
   * those tools natively.
   */
  mcpSessionId?: string;
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  autoVerify?: 'off' | 'build' | 'typecheck' | 'test' | 'all' | boolean;
  maxFixAttempts?: number;
  usePlanning?: boolean; // Enable task planning for complex tasks
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>; // Prior chat session context
}

export interface AgentResult {
  success: boolean;
  iterations: number;
  actions: ActionLog[];
  finalResponse: string;
  error?: string;
  aborted?: boolean;
}

const DEFAULT_OPTIONS: AgentOptions = {
  // Modern models (GLM-5.1, Claude 4.5, GPT-4.1) complete typical coding tasks in
  // 3–8 iterations. The old cap of 100 mostly let broken loops wander for minutes
  // before giving up. 25 is still generous — covers multi-file refactors — without
  // turning small fixes into marathons. Users can still raise this via /settings.
  maxIterations: 25,
  maxDuration: 20 * 60 * 1000, // 20 minutes
  usePlanning: false, // Disable task planning - causes more problems than it solves
};


/**
 * Run the agent loop
 */
export async function runAgent(
  prompt: string,
  projectContext: ProjectContext,
  options: Partial<AgentOptions> = {}
): Promise<AgentResult> {
  // Load limits from config
  const configMaxIterations = config.get('agentMaxIterations');
  const configMaxDuration = config.get('agentMaxDuration') * 60 * 1000; // convert minutes to ms
  
  const opts: AgentOptions = { 
    ...DEFAULT_OPTIONS, 
    maxIterations: configMaxIterations,
    maxDuration: configMaxDuration,
    ...options 
  };
  const startTime = Date.now();
  const actions: ActionLog[] = [];
  const messages: Message[] = [];
  
  // Start history session for undo support
  const sessionId = startSession(prompt, projectContext.root || process.cwd());
  
  // Task planning phase (if enabled)
  // Use planning for complex keywords or multi-word prompts
  let taskPlan: TaskPlan | null = null;
  const complexKeywords = ['create', 'build', 'implement', 'add', 'setup', 'generate', 'make', 'develop'];
  const hasComplexKeyword = complexKeywords.some(kw => prompt.toLowerCase().includes(kw));
  const shouldPlan = opts.usePlanning && (prompt.split(' ').length > 3 || hasComplexKeyword);
  
  if (shouldPlan) {
    try {
      opts.onIteration?.(0, 'Planning tasks...');
      taskPlan = await planTasks(prompt, {
        name: projectContext.name,
        type: projectContext.type,
        structure: projectContext.structure,
      });
      
      if (taskPlan.tasks.length > 1) {
        opts.onTaskPlan?.(taskPlan);
        // Mark first task as in_progress
        taskPlan.tasks[0].status = 'in_progress';
      } else {
        taskPlan = null; // Single task, no need for planning
      }
    } catch (error) {
      // Planning failed, continue without it
      taskPlan = null;
    }
  }
  
  // Gather smart context based on the task
  const targetFile = extractTargetFile(prompt);
  const smartContext = gatherSmartContext(targetFile, projectContext, prompt);
  const smartContextStr = formatSmartContext(smartContext);
  
  // Check if provider supports native tools
  const protocol = config.get('protocol');
  const providerId = config.get('provider');
  const useNativeTools = supportsNativeTools(providerId, protocol);

  // Fetch the MCP tool catalog once per agent run. The session id keys into
  // mcpRegistry; if no MCP servers are registered (or mcpSessionId is unset,
  // e.g. TUI mode) we get back an empty array and the agent behaves as
  // before. We do this before building the system prompt so the fallback
  // text path can include MCP tools in its catalog too.
  //
  // We also append per-server "virtual" tools that wrap resource_list /
  // resource_read / prompt_list / prompt_get so the agent can discover and
  // pull MCP resources & prompts without the user having to type `/mcp
  // read <uri>` manually. Servers that don't expose resources or prompts
  // get no virtual tools — the wrappers are only emitted where useful.
  let mcpToolDefs: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] = [];
  if (opts.mcpSessionId) {
    try {
      const { getSessionTools, getSessionVirtualTools } = await import('./mcpRegistry.js');
      const [registered, virtuals] = await Promise.all([
        getSessionTools(opts.mcpSessionId),
        getSessionVirtualTools(opts.mcpSessionId),
      ]);
      mcpToolDefs = [...registered, ...virtuals].map(t => ({
        name: t.agentName,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch {
      // Don't let a registry blip kill the whole agent run.
    }
  }

  // Skill bundles — structured `.codeep/skills/<name>/SKILL.md` directories
  // the agent can discover and invoke via the `invoke_skill` tool. We just
  // add the tool def here; the catalog block is appended to systemPrompt
  // below alongside project rules / progress / etc. so we don't clobber
  // those.
  let skillCatalogBlock = '';
  try {
    const { loadSkillBundles, formatBundlesForSysprompt } = await import('./skillBundles.js');
    const bundles = loadSkillBundles(projectContext.root);
    if (bundles.length > 0) {
      mcpToolDefs.push({
        name: 'invoke_skill',
        description: 'Invoke a Codeep skill bundle (curated workflow). Returns the SKILL.md body — follow its instructions step by step. Use when the user\'s request matches a skill\'s purpose.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name from the catalog (e.g. "deploy").' },
          },
          required: ['name'],
        },
      });
      skillCatalogBlock = formatBundlesForSysprompt(bundles);
    }
  } catch {
    // Skill loading failure shouldn't fail the whole agent run.
  }

  // Build system prompt - use fallback format if native tools not supported
  let systemPrompt = useNativeTools
    ? getAgentSystemPrompt(projectContext)
    : getFallbackSystemPrompt(projectContext, mcpToolDefs);
  
  // Inject project rules (from .codeep/rules.md or CODEEP.md)
  const projectRules = loadProjectRules(projectContext.root);
  if (projectRules) {
    systemPrompt += projectRules;
  }

  // Inject previous session progress (from .codeep/progress.md)
  const progressLog = loadProgressLog(projectContext.root);
  if (progressLog) {
    systemPrompt += progressLog;
  }

  if (smartContextStr) {
    systemPrompt += '\n\n' + smartContextStr;
  }

  const taskCtx = getTaskContextPrompt();
  if (taskCtx) {
    systemPrompt += taskCtx;
  }

  // Inject prior chat session context. When the history overflows the budget,
  // prepend an LLM recap of the dropped (oldest) messages so long sessions
  // keep early decisions/constraints, then the recent messages verbatim.
  const earlierSummary = await summarizeEarlierHistory(opts.chatHistory);
  if (earlierSummary) {
    systemPrompt += earlierSummary;
  }
  const chatHistoryStr = formatChatHistoryForAgent(opts.chatHistory);
  if (chatHistoryStr) {
    systemPrompt += chatHistoryStr;
  }

  // Skill bundles catalog goes last — closest to the user prompt so the
  // model is most likely to remember the available skills when matching
  // intent. Empty string when there are none.
  if (skillCatalogBlock) {
    systemPrompt += '\n\n' + skillCatalogBlock;
  }

  // Active personality goes LAST — appended after skills / project rules /
  // smart context so its tone overrides earlier conventions. Set via
  // `/personality <name>`; empty when no personality is active.
  try {
    const { getActivePersonalityPrompt } = await import('./personalities.js');
    const personalityPrompt = getActivePersonalityPrompt(projectContext.root);
    if (personalityPrompt) {
      systemPrompt += personalityPrompt;
    }
  } catch {
    // Personality loading must never block an agent run.
  }

  // Initial user message with optional task plan
  let initialPrompt = prompt;
  if (taskPlan) {
    initialPrompt = `${prompt}\n\n## Task Breakdown\nI've broken this down into subtasks. Complete them in order:\n\n${formatTaskPlan(taskPlan)}\n\nStart with task 1.`;
  }
  messages.push({ role: 'user', content: initialPrompt });
  
  let iteration = 0;
  let finalResponse = '';
  let result: AgentResult;
  let consecutiveTimeouts = 0;
  let incompleteWorkRetries = 0;
  // If the model claims completion but the task isn't actually done, we nudge it
  // once or twice. More retries than that usually means the model is stuck, not
  // that it needs a third chance — bail out instead of spamming identical hints.
  const maxIncompleteWorkRetries = 2;
  // Track tools permanently allowed this session via allow_always
  const alwaysAllowedTools = new Set<string>();
  // Track tools permanently rejected this session via reject_always
  const alwaysRejectedTools = new Set<string>();
  // Tools that require permission when onRequestPermission is set (configurable)
  const dangerousTools = new Set<string>([
    ...(config.get('agentConfirmDeleteFile') !== false ? ['delete_file'] : []),
    ...(config.get('agentConfirmExecuteCommand') !== false ? ['execute_command'] : []),
    ...(config.get('agentConfirmWriteFile') === true ? ['write_file', 'edit_file'] : []),
  ]);
  const maxTimeoutRetries = 3;
  const maxConsecutiveTimeouts = 30; // Allow more consecutive timeouts before giving up
  const maxConsecutiveRateLimits = 5; // Stop after 5 consecutive rate-limited iterations
  let consecutiveRateLimits = 0;
  const baseTimeout = config.get('agentApiTimeout');

  // Infinite loop detection: track last write hash per file path
  const lastWriteHashByPath = new Map<string, string>();
  let duplicateWriteCount = 0;

  // Duplicate read cache: path → truncated output (avoid re-sending large file content)
  const readCache = new Map<string, string>();
  // Track last token budget warning threshold to avoid repeated messages
  let lastBudgetWarning = 0;
  
  try {
    while (iteration < opts.maxIterations) {
      // Check timeout
      if (Date.now() - startTime > opts.maxDuration) {
        const filesDone = actions.filter(a => a.type === 'write' || a.type === 'edit').map(a => a.target);
        const durationMin = Math.round(opts.maxDuration / 60000);
        const partialLines = [`Agent reached the time limit (${durationMin} min).`];
        if (filesDone.length > 0) {
          partialLines.push(`\n**Partial progress — files written/edited:**`);
          [...new Set(filesDone)].forEach(f => partialLines.push(`  ✓ \`${f}\``));
          partialLines.push(`\nYou can continue by running the agent again.`);
        }
        result = {
          success: false,
          iterations: iteration,
          actions,
          finalResponse: partialLines.join('\n'),
          error: `Exceeded maximum duration of ${durationMin} min`,
        };
        writeProgressLog(projectContext.root || '', prompt, result, projectContext.name);
        return result;
      }
      
      // Check abort signal
      if (opts.abortSignal?.aborted) {
        debug('Agent aborted at iteration', iteration);
        result = {
          success: false,
          iterations: iteration,
          actions,
          finalResponse: 'Agent was stopped by user',
          aborted: true,
        };
        return result;
      }
      
      iteration++;
      opts.onIteration?.(iteration, `Iteration ${iteration}/${opts.maxIterations}`);

      // Throttle between iterations to avoid rate limits on token-heavy providers.
      // Delay scales with context size: ~1s per 10K tokens, capped at 5s.
      if (iteration > 1) {
        const totalTokensEstimate = messages.reduce((sum, m) => sum + Math.ceil((m.content as string).length / 4), 0);
        const throttleMs = Math.min(Math.floor(totalTokensEstimate / 10000) * 1000, 5000);
        if (throttleMs > 0) await new Promise(resolve => setTimeout(resolve, throttleMs));
      }

      // Compress messages if context window is getting full (silent)
      const compressed = compressMessages(messages, actions);
      if (compressed !== messages) {
        messages.length = 0;
        messages.push(...compressed);
      }

      debug(`Starting iteration ${iteration}/${opts.maxIterations}, actions: ${actions.length}`);
      
      // Calculate dynamic timeout based on task complexity
      const dynamicTimeout = calculateDynamicTimeout(iteration, baseTimeout);
      debug(`Using timeout: ${dynamicTimeout}ms (base: ${baseTimeout}ms)`);

      // Refresh MCP tool list if a server flagged its catalog as changed
      // (e.g. via `tools/list_changed` notification, or after an
      // auto-restart). This keeps the agent in sync mid-run instead of
      // requiring a session restart to see new tools.
      if (opts.mcpSessionId) {
        try {
          const { consumeSessionCatalogChanges, getSessionTools } = await import('./mcpRegistry.js');
          const dirty = consumeSessionCatalogChanges(opts.mcpSessionId);
          if (dirty.has('tools')) {
            const refreshed = await getSessionTools(opts.mcpSessionId);
            mcpToolDefs = refreshed.map(t => ({
              name: t.agentName,
              description: t.description,
              inputSchema: t.inputSchema,
            }));
            debug(`MCP tool catalog refreshed mid-run: ${mcpToolDefs.length} tool(s)`);
          }
        } catch {
          // Don't let a refresh hiccup break the iteration.
        }
      }

      // Get AI response with retry logic for timeouts
      let chatResponse: AgentChatResponse | null = null;
      let retryCount = 0;
      
      while (true) {
        try {
          chatResponse = await agentChat(
            messages,
            systemPrompt,
            opts.onChunk,
            opts.abortSignal,
            dynamicTimeout * (1 + retryCount * 0.5), // Increase timeout on retry
            mcpToolDefs,
          );
          consecutiveTimeouts = 0; // Reset consecutive count on success
          consecutiveRateLimits = 0;
          break;
        } catch (error) {
          const err = error as Error;
          
          // Handle user abort (not timeout)
          if (err.name === 'AbortError') {
            result = {
              success: false,
              iterations: iteration,
              actions,
              finalResponse: 'Agent was stopped by user',
              aborted: true,
            };
            return result;
          }
          
          // Handle timeout with retry
          if (err.name === 'TimeoutError') {
            retryCount++;
            consecutiveTimeouts++;
            debug(`Timeout occurred (retry ${retryCount}/${maxTimeoutRetries}, consecutive: ${consecutiveTimeouts})`);
            opts.onIteration?.(iteration, `API timeout, retrying (${retryCount}/${maxTimeoutRetries})...`);

            if (retryCount >= maxTimeoutRetries) {
              // Too many retries for this iteration
              if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
                // Too many consecutive timeouts overall, give up
                result = {
                  success: false,
                  iterations: iteration,
                  actions,
                  finalResponse: 'Agent stopped due to repeated API timeouts',
                  error: `API timed out ${consecutiveTimeouts} times consecutively. Try increasing the timeout in settings or simplifying the task.`,
                };
                return result;
              }

              // Skip this iteration and try next
              messages.push({
                role: 'user',
                content: 'The previous request timed out. Please continue with the task, using simpler responses if needed.'
              });
              break;
            }

            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            continue;
          }

          // Don't retry on 4xx client errors except 429 (rate limit)
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            result = {
              success: false,
              iterations: iteration,
              actions,
              finalResponse: '',
              error: err.message,
            };
            return result;
          }

          // All non-abort errors are retryable — retry with backoff
          retryCount++;
          const isRateLimit = err.message.includes('429') || (err instanceof ApiError && err.status === 429);
          const isServerError = err.message.includes('500') || err.message.includes('502') || err.message.includes('503') || err.message.includes('529');
          const code = isRateLimit ? '429' : isServerError ? '5xx' : 'error';
          // Rate limits need a longer wait; other errors use shorter backoff
          const waitSec = isRateLimit ? Math.min(30 * retryCount, 120) : Math.min(5 * retryCount, 30);
          debug(`${code} (retry ${retryCount}/${maxTimeoutRetries}): ${err.message}`);
          const shortMsg = err.message.length > 80 ? err.message.slice(0, 80) + '…' : err.message;
          opts.onIteration?.(iteration, `API ${code}: ${shortMsg} — retrying in ${waitSec}s (${retryCount}/${maxTimeoutRetries})`);
          if (retryCount >= maxTimeoutRetries) {
            if (isRateLimit) {
              // Rate limit exhausted — stop immediately, no point hammering a throttled API
              consecutiveRateLimits++;
              if (consecutiveRateLimits >= maxConsecutiveRateLimits) {
                result = {
                  success: false,
                  iterations: iteration,
                  actions,
                  finalResponse: actions.length > 0
                    ? `Agent paused after ${actions.length} action(s) — API rate limit reached. Wait a moment and try again.`
                    : 'API rate limit reached. Wait a moment and run the agent again.',
                  error: `Rate limited (429) after ${maxTimeoutRetries} retries: ${err.message}`,
                };
                return result;
              }
            } else {
              consecutiveRateLimits = 0; // Reset on non-rate-limit errors
            }
            // Don't throw — skip this iteration like timeouts do
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
              result = {
                success: false,
                iterations: iteration,
                actions,
                finalResponse: actions.length > 0
                  ? `Agent made progress (${actions.length} actions) but API errors prevented completion. You can continue by running the agent again.`
                  : 'Agent could not complete the task due to repeated API errors. Check your API key and network connection.',
                error: `API failed after ${maxTimeoutRetries} retries: ${err.message}`,
              };
              return result;
            }
            messages.push({
              role: 'user',
              content: 'The previous request failed. Please continue with the task.'
            });
            break; // Break retry loop, continue main loop
          }
          await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
          continue;
        }
      }
      
      // If we broke out due to max retries without a response, continue to next iteration
      if (!chatResponse) {
        continue;
      }

      // Token budget warning — warn once per threshold based on % of model's context window
      {
        const lastUsage = getLastUsage();
        const inputTokens = lastUsage?.promptTokens ?? 0;
        if (inputTokens > 0) {
          const contextWindow = getModelContextWindow(config.get('model') as string);
          const pct = Math.round(inputTokens / contextWindow * 100);
          const threshold = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
          if (threshold > 0 && threshold > lastBudgetWarning) {
            lastBudgetWarning = threshold;
            const msg = threshold >= 95
              ? `⚠ Context at ${pct}% of ${Math.round(contextWindow / 1000)}k window — agent may stop soon`
              : `⚠ Context at ${pct}% of ${Math.round(contextWindow / 1000)}k window`;
            opts.onIteration?.(iteration, msg);
          }
        }
      }

      let { content, toolCalls, usedNativeTools } = chatResponse;

      // If native tools were used but no tool calls returned, try parsing text-based tool calls
      // This handles models that accept tools parameter but respond with text anyway
      if (usedNativeTools && toolCalls.length === 0 && iteration === 1) {
        const textToolCalls = parseToolCalls(content);
        if (textToolCalls.length > 0) {
          toolCalls = textToolCalls;
        }
      }

      // Warn the user if Ollama model fails to produce tool calls early on
      if (toolCalls.length === 0 && iteration <= 2 && providerId === 'ollama') {
        const model = config.get('model');
        const paramMatch = model.toLowerCase().match(/(\d+(?:\.\d+)?)b/);
        const params = paramMatch ? parseFloat(paramMatch[1]) : null;
        if (params !== null && params < 7) {
          opts.onChunk?.(`\n\n⚠️ **Model too small for agent mode** — \`${model}\` (${params}B) does not reliably support tool calling. Use a 7B+ model (e.g. \`qwen2.5-coder:7b\`) or set Agent Mode to Manual/Off in \`/settings\`.\n`);
        }
      }
      
      // If no tool calls, check if model wants to continue or is really done
      if (toolCalls.length === 0) {
        debug(`No tool calls at iteration ${iteration}, content length: ${content.length}`);
        
        // Remove <think>...</think> tags from response (some models include thinking)
        // Also remove Tool parameters/tool call artifacts that AI sometimes includes in text
        finalResponse = content
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
          .replace(/<arg_key>[\s\S]*?<\/arg_value>/gi, '')
          .replace(/Tool parameters:[\s\S]*?(?=\n\n|$)/gi, '')
          .replace(/\{'path'[\s\S]*?\}/g, '')
          .replace(/```(?:json|tool_call)?\s*\{[\s\S]*?\}\s*```/g, '') // Only strip tool-call-like code blocks
          .trim();
        
        // Detect incomplete response using language-agnostic structural signals only.
        // Keyword lists are brittle (language-dependent) — rely on punctuation/length instead.
        const trimmed = finalResponse.trimEnd();
        // A response ending with ':' means the model was about to list steps or execute tools
        const endsWithColon = trimmed.endsWith(':');
        // A very short response (< 120 chars) with no sentence-ending punctuation is likely
        // a mid-thought fragment, not a real conclusion
        const lastChar = trimmed.slice(-1);
        const hasProperEnding = ['.', '!', '?', '"', '\'', '`', ')'].includes(lastChar);
        const isShortFragment = trimmed.length < 120 && !hasProperEnding;
        const hasIncompleteWork = (endsWithColon || isShortFragment)
          && incompleteWorkRetries < maxIncompleteWorkRetries;

        if (hasIncompleteWork) {
          debug('Model wants to continue, prompting for next action');
          incompleteWorkRetries++;
          messages.push({ role: 'assistant', content });
          messages.push({
            role: 'user',
            content: 'Continue. Execute the tool calls now.'
          });
          continue;
        }
        // Reset counter once model produces real output or we give up
        incompleteWorkRetries = 0;
        
        // Model is done
        debug(`Agent finished at iteration ${iteration}`);
        break;
      }
      
      // Add assistant response to history
      messages.push({ role: 'assistant', content });
      
      // Execute tool calls
      const toolResults: string[] = [];
      
      for (const toolCall of toolCalls) {
        opts.onToolCall?.(toolCall);

        // Permission check for dangerous tools (only when callback is provided, e.g. ACP/Zed)
        if (opts.onRequestPermission && dangerousTools.has(toolCall.tool) && !alwaysAllowedTools.has(toolCall.tool)) {
          const rejectResult = () => {
            const toolResult: ToolResult = {
              success: false,
              output: '',
              error: `User rejected permission for ${toolCall.tool}`,
              tool: toolCall.tool,
              parameters: toolCall.parameters,
            };
            opts.onToolResult?.(toolResult, toolCall);
            actions.push(createActionLog(toolCall, toolResult));
            toolResults.push(`Tool ${toolCall.tool} was denied by user. Do not attempt this action again.`);
            return toolResult;
          };

          // Skip without asking if permanently rejected this session
          if (alwaysRejectedTools.has(toolCall.tool)) {
            rejectResult();
            continue;
          }

          const outcome = await opts.onRequestPermission(toolCall);
          if (outcome === 'allow_always') {
            alwaysAllowedTools.add(toolCall.tool);
          } else if (outcome === 'reject_always') {
            alwaysRejectedTools.add(toolCall.tool);
            rejectResult();
            continue;
          } else if (outcome === 'reject_once') {
            rejectResult();
            continue;
          }
        }

        let toolResult: ToolResult;

        if (opts.dryRun) {
          toolResult = {
            success: true,
            output: `[DRY RUN] Would execute: ${toolCall.tool}`,
            tool: toolCall.tool,
            parameters: toolCall.parameters,
          };
        } else if (opts.onExecuteCommand && toolCall.tool === 'execute_command') {
          // Delegate to external terminal (e.g. Zed ACP terminal)
          // Note: onExecuteCommand runs after the permission gate above
          const command = toolCall.parameters.command as string;
          const args = (toolCall.parameters.args as string[]) || [];
          const cwd = projectContext.root || process.cwd();
          if (!command) {
            toolResult = {
              success: false,
              output: '',
              error: 'execute_command called with missing command field',
              tool: toolCall.tool,
              parameters: toolCall.parameters,
            };
          } else {
            try {
              const commandResult = await opts.onExecuteCommand(command, args, cwd);
              toolResult = {
                success: commandResult.exitCode === 0,
                output: commandResult.stdout || '(no output)',
                error: commandResult.exitCode !== 0 ? (commandResult.stderr || `exited with code ${commandResult.exitCode}`) : undefined,
                tool: toolCall.tool,
                parameters: toolCall.parameters,
              };
            } catch (err) {
              debug('onExecuteCommand callback threw, falling back to local execution:', err);
              // Fallback to local execution if callback throws
              toolResult = await executeTool(toolCall, cwd, opts.fs, opts.mcpSessionId);
            }
          }
        } else {
          toolResult = await executeTool(toolCall, projectContext.root || process.cwd(), opts.fs, opts.mcpSessionId);
        }
        
        opts.onToolResult?.(toolResult, toolCall);

        // Log action
        const actionLog = createActionLog(toolCall, toolResult);
        actions.push(actionLog);

        // ── Infinite loop detection for write/edit ──────────────────────────
        if (toolCall.tool === 'write_file' || toolCall.tool === 'edit_file') {
          const filePath = toolCall.parameters.path as string || '';
          const contentKey = JSON.stringify(toolCall.parameters).slice(0, 500);
          const prevHash = lastWriteHashByPath.get(filePath);
          if (prevHash === contentKey) {
            duplicateWriteCount++;
            if (duplicateWriteCount >= 2) {
              toolResults.push(`[WARNING] You have written the same content to \`${filePath}\` ${duplicateWriteCount + 1} times in a row. You are stuck in a loop. Stop and think differently — read the file to check its current state, then try a completely different approach.`);
              duplicateWriteCount = 0;
            } else {
              toolResults.push(`Tool ${toolCall.tool} succeeded (note: same content as previous write to this file):\n${toolResult.output}`);
            }
          } else {
            duplicateWriteCount = 0;
            lastWriteHashByPath.set(filePath, contentKey);
            if (toolResult.success) {
              toolResults.push(`Tool ${toolCall.tool} succeeded:\n${toolResult.output}`);
            } else {
              toolResults.push(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
            }
          }
        // ── Duplicate read cache ────────────────────────────────────────────
        } else if (toolCall.tool === 'read_file' && toolResult.success) {
          const filePath = toolCall.parameters.path as string || '';
          if (readCache.has(filePath)) {
            toolResults.push(`Tool read_file succeeded (cached — file unchanged since last read):\n${readCache.get(filePath)}`);
          } else {
            const truncated = truncateToolResult(toolResult.output, toolCall.tool);
            readCache.set(filePath, truncated);
            toolResults.push(`Tool read_file succeeded:\n${truncated}`);
          }
        // ── General truncation for other tools ─────────────────────────────
        } else if (toolResult.success) {
          const truncated = truncateToolResult(toolResult.output, toolCall.tool);
          toolResults.push(`Tool ${toolCall.tool} succeeded:\n${truncated}`);
        } else {
          toolResults.push(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
        }

        // Invalidate read cache when files may have changed
        if ((toolCall.tool === 'write_file' || toolCall.tool === 'edit_file') && toolResult.success) {
          const filePath = toolCall.parameters.path as string || '';
          readCache.delete(filePath);
        } else if (toolCall.tool === 'execute_command' && toolResult.success) {
          readCache.clear(); // Commands can modify arbitrary files
        }
      }
      
      // Add tool results to messages
      messages.push({
        role: 'user',
        content: `Tool results:\n\n${toolResults.join('\n\n')}\n\nContinue with the task. Keep working until everything is fully done.`,
      });
    }
    
    // Check if we hit max iterations — build partial summary from actions log
    if (iteration >= opts.maxIterations && !finalResponse) {
      const filesDone = actions.filter(a => a.type === 'write' || a.type === 'edit').map(a => a.target);
      const partialLines = [`Agent reached the iteration limit (${opts.maxIterations} steps).`];
      if (filesDone.length > 0) {
        partialLines.push(`\n**Partial progress — files written/edited:**`);
        [...new Set(filesDone)].forEach(f => partialLines.push(`  ✓ \`${f}\``));
        partialLines.push(`\nThe task may be incomplete. You can continue by running the agent again.`);
      }
      result = {
        success: false,
        iterations: iteration,
        actions,
        finalResponse: partialLines.join('\n'),
        error: `Exceeded maximum of ${opts.maxIterations} iterations`,
      };
      writeProgressLog(projectContext.root || '', prompt, result, projectContext.name);
      return result;
    }
    
    // Self-verification: Run build/test and fix errors if needed
    const autoVerifyRaw = opts.autoVerify ?? config.get('agentAutoVerify');
    // Support legacy boolean values: true -> 'all', false -> 'off'
    const autoVerify = autoVerifyRaw === true ? 'all' : autoVerifyRaw === false ? 'off' : autoVerifyRaw;
    const maxFixAttempts = opts.maxFixAttempts ?? config.get('agentMaxFixAttempts');

    if (autoVerify !== 'off' && !opts.dryRun) {
      // Check if we made any file changes worth verifying
      const hasFileChanges = actions.some(a => 
        a.type === 'write' || a.type === 'edit' || a.type === 'delete'
      );
      
      if (hasFileChanges) {
        let fixAttempt = 0;
        let previousErrorSignature = '';

        while (fixAttempt < maxFixAttempts) {
          // Check abort signal
          if (opts.abortSignal?.aborted) {
            break;
          }

          opts.onIteration?.(iteration, `Verification attempt ${fixAttempt + 1}/${maxFixAttempts}`);

          // Run verifications based on selected mode
          const verifyResults = await runAllVerifications(projectContext.root || process.cwd(), {
            runBuild: autoVerify === 'all' || autoVerify === 'build',
            runTest: autoVerify === 'all' || autoVerify === 'test',
            runTypecheck: autoVerify === 'all' || autoVerify === 'typecheck',
            runLint: false,
          });

          opts.onVerification?.(verifyResults);

          // Filter errors: only keep those related to files the agent touched
          const touchedFiles = new Set(
            actions
              .filter(a => a.type === 'write' || a.type === 'edit')
              .map(a => a.target)
          );
          for (const vr of verifyResults) {
            vr.errors = vr.errors.filter(e => {
              if (!e.file) return true; // Keep errors without file info (build failures etc)
              return touchedFiles.has(e.file) || [...touchedFiles].some(f => e.file!.endsWith(f) || f.endsWith(e.file!));
            });
            // Update success based on remaining errors
            if (vr.errors.filter(e => e.severity === 'error').length === 0) {
              vr.success = true;
            }
          }

          // Check if all passed (after filtering)
          if (!hasVerificationErrors(verifyResults)) {
            const summary = getVerificationSummary(verifyResults);
            finalResponse += `\n\n✓ Verification passed: ${summary.passed}/${summary.total} checks`;
            break;
          }

          fixAttempt++;

          // If we've exceeded fix attempts, hand back to the main agent loop
          // instead of stopping — let it keep working freely without the verification constraint
          if (fixAttempt >= maxFixAttempts) {
            const errorMessage = formatErrorsForAgent(verifyResults);
            messages.push({ role: 'assistant', content: finalResponse });
            messages.push({
              role: 'user',
              content: `${errorMessage}\n\nVerification has failed ${fixAttempt} time(s). Stop trying the same approach. Step back, re-read ALL relevant files, and think about the root cause from scratch. Try a fundamentally different solution.`,
            });
            // Re-enter the main agent loop — it will continue until maxIterations
            iteration++;
            break;
          }

          // Detect if the same errors are repeating (previous fix attempt didn't help)
          const errorMessage = formatErrorsForAgent(verifyResults);
          const currentErrorSignature = errorMessage.slice(0, 200);
          const errorsRepeating = previousErrorSignature !== '' && currentErrorSignature === previousErrorSignature;
          previousErrorSignature = currentErrorSignature;

          // Escalate the fix strategy based on attempt number and whether errors are repeating
          let fixPrompt: string;
          if (errorsRepeating) {
            fixPrompt = `${errorMessage}\n\nYour previous fix attempt did NOT resolve these errors — they are still the same. You MUST try a completely different approach:\n- Re-read the affected files to understand the current state\n- Consider whether the root cause is different from what you assumed\n- Try an alternative implementation strategy\n- If it's a missing dependency, install it with execute_command`;
          } else if (fixAttempt === 1) {
            fixPrompt = `${errorMessage}\n\nFix these errors. Read the affected files first to understand the current state before making changes.`;
          } else {
            fixPrompt = `${errorMessage}\n\nAttempt ${fixAttempt}/${maxFixAttempts}: Your previous fix was partially successful but errors remain. Re-read ALL affected files and take a fresh look — consider whether there are related issues you missed.`;
          }

          messages.push({ role: 'assistant', content: finalResponse });
          messages.push({
            role: 'user',
            content: fixPrompt,
          });
          
          iteration++;
          if (iteration >= opts.maxIterations) {
            break;
          }
          
          // Get AI response to fix errors
          try {
            const fixResponse = await agentChat(
              messages,
              systemPrompt,
              opts.onChunk,
              opts.abortSignal,
              undefined,
              mcpToolDefs,
            );
            
            const { content: fixContent, toolCalls: fixToolCalls } = fixResponse;
            
            if (fixToolCalls.length === 0) {
              // Agent gave up or thinks it's fixed
              finalResponse = fixContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
              continue; // Re-run verification
            }
            
            // Execute fix tool calls
            messages.push({ role: 'assistant', content: fixContent });
            const fixResults: string[] = [];
            
            for (const toolCall of fixToolCalls) {
              opts.onToolCall?.(toolCall);

              const toolResult = await executeTool(toolCall, projectContext.root || process.cwd(), opts.fs, opts.mcpSessionId);
              opts.onToolResult?.(toolResult, toolCall);
              
              const actionLog = createActionLog(toolCall, toolResult);
              actions.push(actionLog);
              
              if (toolResult.success) {
                const truncated = truncateToolResult(toolResult.output, toolCall.tool);
                fixResults.push(`Tool ${toolCall.tool} succeeded:\n${truncated}`);
              } else {
                fixResults.push(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
              }
            }
            
            messages.push({
              role: 'user',
              content: `Fix results:\n\n${fixResults.join('\n\n')}\n\nContinue fixing if needed. Re-running verification...`,
            });
            
          } catch (error) {
            // If fix attempt failed, continue to next attempt
            break;
          }
        }
      }
    }
    
    result = {
      success: true,
      iterations: iteration,
      actions,
      finalResponse,
    };
    writeProgressLog(projectContext.root || '', prompt, result, projectContext.name);
    return result;
    
  } catch (error) {
    const err = error as Error;
    result = {
      success: false,
      iterations: iteration,
      actions,
      finalResponse: '',
      error: err.message,
    };
    return result;
  } finally {
    // End session and save history
    endSession();
  }
}

/**
 * Format agent result for display
 */
export function formatAgentResult(result: AgentResult): string {
  const lines: string[] = [];
  
  if (result.success) {
    lines.push(`Agent completed in ${result.iterations} iteration(s)`);
  } else if (result.aborted) {
    lines.push('Agent was stopped by user');
  } else {
    lines.push(`Agent failed: ${result.error}`);
  }
  
  if (result.actions.length > 0) {
    lines.push('');
    lines.push('Actions performed:');
    for (const action of result.actions) {
      const status = action.result === 'success' ? '✓' : '✗';
      lines.push(`  ${status} ${action.type}: ${action.target}`);
    }
  }
  
  return lines.join('\n');
}

// Re-export history functions for undo support
export { 
  undoLastAction, 
  undoAllActions, 
  getCurrentSession, 
  getRecentSessions, 
  formatSession,
  type ActionSession 
};

/**
 * Get agent history for display
 */
export function getAgentHistory(): Array<{
  timestamp: number;
  task: string;
  actions: Array<{ type: string; target: string; result: string }>;
  success: boolean;
}> {
  const sessions = getRecentSessions(10);
  return sessions.map(s => ({
    timestamp: s.startTime,
    task: s.prompt || 'Unknown task',
    actions: s.actions.map(a => ({
      type: a.type,
      target: a.path || '',
      result: 'success',
    })),
    success: s.endTime !== undefined,
  }));
}

/**
 * Get current session actions
 */
export function getCurrentSessionActions(): Array<{ type: string; target: string; result: string }> {
  const session = getCurrentSession();
  if (!session) return [];
  return session.actions.map(a => ({
    type: a.type,
    target: a.path || '',
    result: 'success',
  }));
}
