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
  loadProjectRules,
  loadProgressLog,
  writeProgressLog,
  formatChatHistoryForAgent,
  summarizeEarlierHistory,
} from './agentChat';
import { ApiError } from '../api/index';
import type { AgentChatResponse } from './agentChat';
import type { AgentChatRuntime } from './agentChat';
import { ResponsesRunState } from './responsesRunState';
import type { ToolOutputEntry } from '../api/responses';
import { loadUserProfilePrompt } from './userProfile';
import { beginAuditRun, endAuditRun, recordAuditEvent, describeAuditTarget } from './auditLog';
import {
  getActivePersonality,
  type Personality,
  getPersonalityToolAllowlist,
  isPersonalityToolCallAllowed,
  resolvePersonalityRuntimeModel,
} from './personalities';
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
import { trustBearingWrite, forgetHooksDirectory, NO_CONFIRMER_REFUSAL, type TrustBearingWrite } from './toolExecution';
import { config, Message } from '../config/index';
import { supportsNativeTools } from '../config/providers';
import { isMcpToolName, isVirtualMcpToolName } from './mcpRegistry';
import { startSession, endSession, undoLastAction, undoAllActions, getCurrentSession, getRecentSessions, formatSession, ActionSession } from './history';
import { runAllVerifications, formatErrorsForAgent, hasVerificationErrors, getVerificationSummary, failedChecks, checksNotRun, VerifyResult } from './verify';
import { gatherSmartContext, formatSmartContext, extractTargetFile } from './smartContext';
import { planTasks, formatTaskPlan, TaskPlan, SubTask } from './taskPlanner';
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

// ─── Assistant turns in the flattened history ─────────────────────────────────

/**
 * The text an assistant turn is kept as in the history sent back next time.
 *
 * The loop stores each turn as plain text, and a turn that only called tools
 * has none: Claude often skips the narration, and Opus 5.5 and Fable 5.1 move
 * it into thinking blocks, which the stream parser does not keep. Stored as
 * '', that turn is an empty non-final message on the next request, which
 * Anthropic's Messages API refuses with a 400 ("all messages must have
 * non-empty content except for the optional final assistant message").
 * agentChat turns that 400 into the text-tool fallback, which sends the same
 * history and fails the same way, so the run died on its second iteration.
 * Naming the tools keeps the turn truthful and non-empty.
 */
export function assistantHistoryText(content: string, toolCalls: ReadonlyArray<{ tool: string }>): string {
  if (content.trim()) return content;
  if (toolCalls.length > 0) return `Using ${[...new Set(toolCalls.map(t => t.tool))].join(', ')}.`;
  return '(no reply)';
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

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always';

/**
 * Map a permission outcome to a decision, FAILING CLOSED: a dangerous tool is
 * allowed only on an explicit allow outcome. `reject_*` deny, and — critically —
 * any unknown/malformed outcome from a buggy or hostile client also denies
 * (deny-once) rather than slipping through to execution. Pure + exported so the
 * invariant is unit-tested independently of the agent loop.
 */
export function classifyPermissionOutcome(outcome: string | undefined | null): PermissionDecision {
  if (outcome === 'allow_always') return 'allow-always';
  if (outcome === 'allow_once') return 'allow-once';
  if (outcome === 'reject_always') return 'deny-always';
  return 'deny-once'; // 'reject_once' OR anything unexpected → fail closed
}

/**
 * Build the set of tools that require a permission prompt this run. Derived from
 * the global agentConfirm* settings, plus any `extra` tools forced in for this
 * run only (ACP manual mode passes ['write_file','edit_file'] this way instead
 * of mutating the global `agentConfirmWriteFile` config — which would leak the
 * session's mode into the TUI and race on restore). Exported for unit testing.
 */
export function buildDangerousTools(extra: string[] = []): Set<string> {
  const tools = new Set<string>([
    ...(config.get('agentConfirmDeleteFile') !== false ? ['delete_file'] : []),
    ...(config.get('agentConfirmExecuteCommand') !== false ? ['execute_command'] : []),
    ...(config.get('agentConfirmWriteFile') === true ? ['write_file', 'edit_file'] : []),
  ]);
  for (const t of extra) tools.add(t);
  return tools;
}

/**
 * Whether a tool call must go through the permission prompt this run.
 *
 * MCP tools (`<server>__<tool>`) can do anything their server can — write
 * files, run SQL, drive a browser — and their names never appear in the
 * built-in set, so a mode that confirms dangerous operations confirms these
 * too. The resource/prompt wrappers only read, and stay unprompted.
 */
export function requiresPermission(tool: string, dangerousTools: ReadonlySet<string>): boolean {
  return dangerousTools.has(tool) || (isMcpToolName(tool) && !isVirtualMcpToolName(tool));
}

/** Provider, model and protocol a run talks to. */
export interface AgentModelRuntime {
  providerId: string;
  model: string;
  protocol: 'openai' | 'anthropic';
}

/**
 * Read a sub-agent's `model:` setting ("provider/model" or a bare model) as
 * the runtime for its nested run. A known provider prefix switches provider;
 * anything else is a model on the current provider. The protocol is kept when
 * the provider stays the same and supports it, and is otherwise that
 * provider's default.
 */
export async function resolveDelegateModel(spec: string, current: AgentModelRuntime): Promise<AgentModelRuntime> {
  const slash = spec.indexOf('/');
  if (slash < 0) return { ...current, model: spec };
  const providerId = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  const { getProvider } = await import('../config/providers');
  const provider = getProvider(providerId);
  if (!provider) return { ...current, model };
  const protocol = providerId === current.providerId && provider.protocols[current.protocol]
    ? current.protocol
    : provider.defaultProtocol;
  // getApiKey() only reads the in-memory cache, so warm it for a provider the
  // parent run has not used. Reading a key changes no settings.
  try {
    const { getApiKey, loadApiKey } = await import('../config/index');
    if (!getApiKey(providerId)) await loadApiKey(providerId);
  } catch { /* the request itself reports a missing key */ }
  return { providerId, model, protocol };
}

/**
 * The user-facing account of checks that still fail when verification stops.
 * The command and the first few errors are enough to act on; the full output
 * went to the model.
 */
function describeVerificationFailure(results: VerifyResult[]): string {
  const failed = failedChecks(results);
  const lines = [`✗ Verification failed: ${failed.length}/${results.length} checks`];
  for (const r of failed) {
    lines.push(`- ${r.type}: \`${r.command}\``);
    for (const e of r.errors.slice(0, 5)) {
      const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : '';
      const message = e.message.length > 200 ? e.message.slice(0, 200) + '…' : e.message;
      lines.push(`  - ${where}${message}`);
    }
    if (r.errors.length > 5) lines.push(`  - …and ${r.errors.length - 5} more`);
  }
  return lines.join('\n');
}

/**
 * The user-facing account of checks that could not be carried out, or '' when
 * every check ran. They prove nothing either way, so the user is told the
 * change was not verified by them rather than that it passed or failed.
 */
function describeChecksNotRun(results: VerifyResult[]): string {
  const notRun = checksNotRun(results);
  if (notRun.length === 0) return '';
  const lines = [`⚠ Verification could not run: ${notRun.length}/${results.length} checks`];
  for (const r of notRun) lines.push(`- ${r.type}: \`${r.command}\` — ${r.notRun}`);
  return lines.join('\n');
}

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
  /**
   * Ask the user about one tool call.
   *
   * `trustBearing` is what this run already worked out about the call — the
   * file it would write that decides what runs later, or null when it writes
   * no such file. It is passed so the side putting up the dialog can word it
   * without calling trustBearingWrite() a second time: that call stats the
   * path, follows a symlink and may ask git where the repo's hooks live.
   * Optional, so a caller that would rather work it out itself (or was not
   * called from the gate below) still type-checks.
   */
  onRequestPermission?: (toolCall: ToolCall, trustBearing?: TrustBearingWrite | null) => Promise<PermissionOutcome>;
  /** Tool names to force into the per-run dangerous set, on top of the global
   *  agentConfirm* settings. ACP manual mode passes ['write_file','edit_file']
   *  here to gate them for THIS run only, instead of mutating global config. */
  extraDangerousTools?: string[];
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
  /** Delegated sub-agent run. Skips the undo/history session + progress log so
   *  it doesn't clobber the parent's (history.ts uses a module-level
   *  `currentSession` singleton — a nested startSession would reset it). The
   *  sub-agent's tool actions still record into the parent's session, so undo
   *  spans delegation. */
  nested?: boolean;
  /** Run under this capability boundary instead of whatever the user has
   *  selected. Used by non-interactive callers that must pin the boundary
   *  themselves — a CI fix, for example, runs files+tests regardless of the
   *  machine's active bot. Enforced by the same gate as any other bot; this
   *  chooses which one applies, never whether one does. */
  personalityOverride?: Personality;
  /** Delegation depth. 0 = top-level orchestrator (gets the `delegate` tool);
   *  sub-agents run at depth 1 and cannot delegate further (v1). */
  depth?: number;
  /** Tool allowlist for a scoped sub-agent. Undefined = all tools. Enforced at
   *  dispatch — a disallowed tool call returns an error result. */
  allowedTools?: string[];
  /** Role system-prompt addendum injected for a delegated sub-agent. */
  roleAddendum?: string;
  /** "Always allow" / "always deny" answers shared with a delegating parent,
   *  so a sub-agent neither asks again about a tool the user already decided
   *  on nor runs one the user refused. `alwaysRejectedPaths` holds the same
   *  for a single file that decides what runs later, which is refused by name
   *  rather than by tool. */
  permissionMemory?: { alwaysAllowed: Set<string>; alwaysRejected: Set<string>; alwaysRejectedPaths?: Set<string> };
  /** Provider/model for this run only, used in place of the global selection.
   *  A sub-agent with its own `model:` runs on it this way; the global config
   *  is saved to disk and read by every session in the process, so it is
   *  never changed for a single run. */
  modelOverride?: AgentModelRuntime;
}

/** Why a run stopped early at a safety limit — both are resumable, not errors. */
export type InterruptKind = 'iteration_limit' | 'time_limit';

export interface AgentResult {
  success: boolean;
  iterations: number;
  actions: ActionLog[];
  finalResponse: string;
  error?: string;
  aborted?: boolean;
  /** Set when the run paused at a step/time safety limit. The caller can offer
   *  a "continue" affordance instead of treating it as a failure. */
  interrupted?: InterruptKind;
  /** Commands of the verification checks that still failed when the run
   *  ended. Set only when that is why the run did not succeed. */
  failedChecks?: string[];
  /**
   * The end of `finalResponse` that runAgent wrote itself instead of taking
   * it from the model's last reply: the verification passed / failed / could
   * not run blocks and the auto-review section, or the whole notice when one
   * replaced the reply (stopped, paused, API errors). None of it went through
   * `onChunk`, so a client that streamed the reply sends exactly this after
   * it, separated by a blank line. Trimmed; '' when `finalResponse` is only
   * the model's reply. Set on every result runAgent returns.
   */
  unstreamedText?: string;
}

/** A result whose whole response is a notice runAgent wrote (see unstreamedText). */
function asNotice(result: AgentResult): AgentResult {
  return { ...result, unstreamedText: result.finalResponse.trim() };
}

/**
 * Build the result for a run that paused at a safety limit. Pausing is a normal,
 * resumable state — not an error — so the summary tells the user how to resume.
 * Shared by both limit checks in the loop so the wording + `interrupted` signal
 * stay in sync.
 */
export function buildPausedResult(
  kind: InterruptKind,
  ctx: { iterations: number; actions: ActionLog[]; maxIterations?: number; durationMin?: number },
): AgentResult {
  const editedFiles = [...new Set(
    ctx.actions.filter(a => a.type === 'write' || a.type === 'edit').map(a => a.target),
  )];
  const head = kind === 'time_limit'
    ? `⏸ Paused after the ${ctx.durationMin}-minute time limit.`
    : `⏸ Paused after ${ctx.maxIterations} tool steps (the safety limit).`;
  const lines = [head, '', 'This is a safety limit, not an error — say **continue** to pick up where it left off.'];
  if (editedFiles.length > 0) {
    lines.push('', '**Progress so far — files written/edited:**', ...editedFiles.map(f => `  ✓ \`${f}\``));
  }
  return {
    success: false,
    iterations: ctx.iterations,
    actions: ctx.actions,
    finalResponse: lines.join('\n'),
    error: kind === 'time_limit'
      ? `Exceeded maximum duration of ${ctx.durationMin} min`
      : `Exceeded maximum of ${ctx.maxIterations} iterations`,
    interrupted: kind,
  };
}

const DEFAULT_OPTIONS: AgentOptions = {
  // Modern models (GLM-5.2, Claude 5, GPT-5.x) complete typical coding tasks in
  // 3–8 iterations. The old cap of 100 mostly let broken loops wander for minutes
  // before giving up. 25 is still generous — covers multi-file refactors — without
  // turning small fixes into marathons. Users can still raise this via /settings.
  maxIterations: 25,
  maxDuration: 20 * 60 * 1000, // 20 minutes
  usePlanning: false, // Disable task planning - causes more problems than it solves
};


/**
 * Sleep that gives up when the run is stopped.
 *
 * A plain `setTimeout` promise ignores the abort signal, so pressing Stop
 * during "retrying in 10s" did nothing until the wait expired — and then the
 * loop went on to retry anyway. Ctrl-C behaved the same way, because both
 * routes set the same signal that nothing was reading.
 *
 * Resolves early on abort. Callers must still check `aborted` afterwards; this
 * only stops the waiting, it does not decide what to do next.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

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

  // A structured custom bot is resolved once per run. This keeps a cloud sync
  // or file edit from changing policy halfway through an in-flight request.
  const activePersonality = opts.personalityOverride ?? getActivePersonality(projectContext.root);
  const currentRuntime: AgentModelRuntime = opts.modelOverride ?? {
    providerId: String(config.get('provider')),
    model: String(config.get('model')),
    protocol: config.get('protocol') as 'openai' | 'anthropic',
  };
  const personalityModel = activePersonality
    ? resolvePersonalityRuntimeModel(activePersonality, currentRuntime)
    : null;
  // The run's Responses API replay table (used only when agentChat sends a
  // turn over /responses). One per run: a delegated sub-agent calls runAgent
  // again and gets its own, so no item crosses between parent and child.
  const responsesState = new ResponsesRunState();
  const chatRuntime: AgentChatRuntime = {
    ...(personalityModel ?? currentRuntime),
    responsesState,
  };
  
  // Start history session for undo support. Skipped for nested (delegated)
  // runs so we don't reset the parent's currentSession singleton — the
  // sub-agent's actions still record into the parent's open session.
  // The return value is unused — startSession's point here is the side
  // effect of opening the history session. Binding it hid that from
  // noUnusedLocals, so the dead binding is gone and the call stays.
  const auditRoot = projectContext.root || process.cwd();
  if (!opts.nested) startSession(prompt, auditRoot);
  // A delegated sub-agent records into the parent's run for the same reason it
  // shares the parent's history session: its actions are part of what the run
  // did, not a separate story. Only the top-level call opens a run.
  let auditFailure: string | undefined;
  const auditRun = opts.nested ? '' : beginAuditRun(auditRoot, {
    prompt,
    agent: activePersonality?.displayName,
    capabilities: activePersonality?.declaredTools,
  });
  
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
      }, chatRuntime);
      
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
  const protocol = chatRuntime.protocol ?? config.get('protocol');
  const providerId = chatRuntime.providerId ?? config.get('provider');
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
  const registeredMcpToolNames = new Set<string>();
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
      mcpToolDefs.forEach(tool => registeredMcpToolNames.add(tool.name));
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

  // Sub-agents — the `delegate` tool lets the top-level agent hand a
  // self-contained sub-task to a specialist that runs in its own context and
  // returns a summary. Only advertised at depth 0, so sub-agents can't recurse
  // (delegation depth is capped at 1 for v1).
  let agentsCatalogBlock = '';
  if ((opts.depth ?? 0) === 0) {
    try {
      const { loadAgents, formatAgentsForSysprompt } = await import('./agents.js');
      const agents = loadAgents(projectContext.root);
      if (agents.length > 0) {
        mcpToolDefs.push({
          name: 'delegate',
          description: 'Delegate a self-contained sub-task to a specialist sub-agent that runs in its own fresh context and returns a summary. Use it to keep your own context focused.',
          inputSchema: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Sub-agent name from the catalog (e.g. "researcher"). Omit for a general-purpose sub-agent.' },
              task: { type: 'string', description: 'A clear, self-contained instruction for the sub-agent.' },
            },
            required: ['task'],
          },
        });
        agentsCatalogBlock = formatAgentsForSysprompt(agents);
      }
    } catch {
      // Agent loading must never block the run.
    }
  }

  const updateRuntimeToolAllowlist = () => {
    const personalityToolAllowlist = activePersonality
      ? getPersonalityToolAllowlist(activePersonality, registeredMcpToolNames)
      : undefined;
    let effectiveToolAllowlist: string[] | undefined;
    if (!personalityToolAllowlist && !opts.allowedTools) effectiveToolAllowlist = undefined;
    else if (!personalityToolAllowlist) effectiveToolAllowlist = [...(opts.allowedTools ?? [])];
    else if (!opts.allowedTools) effectiveToolAllowlist = personalityToolAllowlist;
    else {
      const delegated = new Set(opts.allowedTools);
      effectiveToolAllowlist = personalityToolAllowlist.filter(tool => delegated.has(tool));
    }
    if (effectiveToolAllowlist) chatRuntime.allowedToolNames = effectiveToolAllowlist;
    else delete chatRuntime.allowedToolNames;
  };
  updateRuntimeToolAllowlist();

  // Build system prompt - use fallback format if native tools not supported
  let systemPrompt = useNativeTools
    ? getAgentSystemPrompt(projectContext, chatRuntime)
    : getFallbackSystemPrompt(projectContext, mcpToolDefs, chatRuntime);

  // Delegated sub-agent role — its defining instruction. Injected right after
  // the base prompt so it frames everything that follows. Empty for normal runs.
  if (opts.roleAddendum) {
    systemPrompt += '\n\n## Your role (delegated sub-agent)\n' + opts.roleAddendum;
  }

  // Inject the user profile (global ~/.codeep/profile.md + project
  // .codeep/profile.md) so the agent adapts to who it's working with —
  // reply language, style, stack, hard preferences. User-authored and gated
  // by config.userProfile. Lives here (not in the base prompt) so every
  // surface — CLI, ACP, VS Code, Zed — inherits it via this single path.
  const userProfileBlock = loadUserProfilePrompt(projectContext.root);
  if (userProfileBlock) {
    systemPrompt += userProfileBlock;
  }

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

  // Sub-agent catalog (delegate) — only present at depth 0.
  if (agentsCatalogBlock) {
    systemPrompt += agentsCatalogBlock;
  }

  // Active personality goes LAST — appended after skills / project rules /
  // smart context so its tone overrides earlier conventions. Set via
  // `/personality <name>`; empty when no personality is active.
  if (activePersonality?.prompt) {
    systemPrompt += activePersonality.prompt;
    if (activePersonality.restrictTools) {
      const capabilities = activePersonality.tools?.join(', ') || '(none recognised)';
      systemPrompt += `\n\n## Enforced custom-bot capabilities\nThis run is restricted to: ${capabilities}. `
        + 'The runtime enforces this policy even if other prompt text asks for a disallowed tool. '
        + 'Tests permit matching test runners; Git permits a conservative set of built-in git commands. '
        + 'Broader executables (including gh) require Terminal.';
    }
  }

  // Initial user message with optional task plan
  let initialPrompt = prompt;
  if (taskPlan) {
    initialPrompt = `${prompt}\n\n## Task Breakdown\nI've broken this down into subtasks. Complete them in order:\n\n${formatTaskPlan(taskPlan)}\n\nStart with task 1.`;
  }
  messages.push({ role: 'user', content: initialPrompt });
  
  let iteration = 0;
  let finalResponse = '';
  // What the loop added to finalResponse after the model's last reply (see
  // AgentResult.unstreamedText). Reset whenever a reply replaces the response.
  let appended = '';
  const appendToResponse = (text: string) => {
    finalResponse += text;
    appended += text;
  };
  // Initialised rather than merely declared: the `finally` reads it to decide
  // the audit outcome, and TypeScript is right that a throw before assignment
  // would leave it unset.
  let result: AgentResult | undefined;
  let consecutiveTimeouts = 0;
  let incompleteWorkRetries = 0;
  // If the model claims completion but the task isn't actually done, we nudge it
  // once or twice. More retries than that usually means the model is stuck, not
  // that it needs a third chance — bail out instead of spamming identical hints.
  const maxIncompleteWorkRetries = 2;
  // Track tools permanently allowed this session via allow_always. A delegated
  // sub-agent shares its parent's sets, so an answer holds across delegation.
  const alwaysAllowedTools = opts.permissionMemory?.alwaysAllowed ?? new Set<string>();
  // Track tools permanently rejected this session via reject_always
  const alwaysRejectedTools = opts.permissionMemory?.alwaysRejected ?? new Set<string>();
  // Files that decide what runs later and were refused for good this session.
  // Kept apart from the tool set on purpose: the TUI's only "no" button answers
  // reject_always, so saying no to one `.git/config` prompt would otherwise
  // turn off delete_file — and every other use of that tool — for the rest of
  // the run. Keyed by the resolved path, so one answer covers every spelling
  // of the same file.
  const alwaysRejectedPaths = opts.permissionMemory?.alwaysRejectedPaths ?? new Set<string>();
  // Tools that require permission when onRequestPermission is set (configurable)
  const dangerousTools = buildDangerousTools(opts.extraDangerousTools);

  // Delegation handler: run a named (or generic) sub-agent in its own fresh
  // context and return its summary as the tool result. Reachable only when the
  // `delegate` tool was advertised (depth 0). The sub-agent runs nested (no own
  // undo session) at depth 1 and never gets `delegate`, so depth is capped at 1.
  const runDelegate = async (toolCall: ToolCall): Promise<ToolResult> => {
    const params = (toolCall.parameters || {}) as { agent?: string; task?: string };
    const task = String(params.task || '').trim();
    const fail = (error: string): ToolResult => ({ success: false, output: '', error, tool: 'delegate', parameters: toolCall.parameters });
    if (!task) return fail('delegate requires a non-empty "task".');

    let def: import('./agents.js').AgentDef | null = null;
    try {
      const { findAgent } = await import('./agents.js');
      def = params.agent ? findAgent(params.agent, projectContext.root) : null;
      if (params.agent && !def) return fail(`No sub-agent named "${params.agent}". Run /agents to see available agents.`);
    } catch { /* fall back to a generic sub-agent */ }

    let roleAddendum = def?.prompt
      || 'You are a general-purpose sub-agent. Complete the task in your own context and return a concise, self-contained summary of what you did and the outcome.';
    if (def?.tools) {
      roleAddendum += def.tools.length
        ? `\n\nYou may use ONLY these tools: ${def.tools.join(', ')}.`
        : '\n\nYou may not use any tools.';
    }
    if (def?.personality) {
      try {
        const { findPersonality } = await import('./personalities.js');
        const p = findPersonality(def.personality, projectContext.root);
        if (p) roleAddendum += '\n' + p.prompt;
      } catch { /* ignore */ }
    }

    const label = def?.name || 'agent';
    opts.onIteration?.(iteration, `⤷ delegating to ${label}…`);
    const tag = (text: string) => `⤷ ${label}: ${text}`;

    // Model override for the nested run only. It travels as an option, never
    // through config: config is saved to disk and read by every session in
    // this process, so swapping it there leaked the sub-agent's model into
    // concurrent runs, reset the user's protocol on the way back, and stayed
    // behind if the process died mid-delegation.
    let modelOverride = opts.modelOverride;
    if (def?.model) {
      try {
        modelOverride = await resolveDelegateModel(String(def.model), currentRuntime);
      } catch { /* keep parent's model */ }
    }

    try {
      const sub = await runAgent(task, projectContext, {
        ...DEFAULT_OPTIONS,
        nested: true,
        depth: (opts.depth ?? 0) + 1,
        allowedTools: def?.tools,
        roleAddendum,
        maxIterations: def?.maxIterations ?? Math.min(15, opts.maxIterations),
        maxDuration: opts.maxDuration,
        abortSignal: opts.abortSignal,
        // The sub-agent works under the parent's rules: a dry run stays dry,
        // tools gated for this run stay gated, and "always" answers carry over.
        dryRun: opts.dryRun,
        onRequestPermission: opts.onRequestPermission,
        extraDangerousTools: opts.extraDangerousTools,
        permissionMemory: { alwaysAllowed: alwaysAllowedTools, alwaysRejected: alwaysRejectedTools, alwaysRejectedPaths },
        modelOverride,
        onExecuteCommand: opts.onExecuteCommand,
        fs: opts.fs,
        mcpSessionId: opts.mcpSessionId,
        autoVerify: false,
        onIteration: (_i, msg) => opts.onIteration?.(iteration, tag(msg)),
        onThinking: (t) => opts.onThinking?.(tag(t)),
        // No chatHistory → the sub-agent gets a fresh context window.
      });
      const summary = sub.finalResponse?.trim() || '(sub-agent finished without a summary)';
      return { success: sub.success, output: `[${label}] ${summary}`, tool: 'delegate', parameters: toolCall.parameters };
    } catch (err) {
      return fail(`Sub-agent "${label}" failed: ${(err as Error).message}`);
    }
  };

  // One path from "the model asked for a tool" to "the tool ran", shared by
  // the main loop and the verification fix loop, so a tool call cannot skip a
  // gate by arriving through the other one. Returns the tool's result, plus
  // `refusal` (the text for the model) when a gate stopped it. Either way the
  // result has already been reported through onToolResult and logged.
  const dispatchToolCall = async (toolCall: ToolCall): Promise<{ result: ToolResult; refusal?: string }> => {
    const refuse = (error: string, refusal: string) => {
      const result: ToolResult = {
        success: false,
        output: '',
        error,
        tool: toolCall.tool,
        parameters: toolCall.parameters,
      };
      opts.onToolResult?.(result, toolCall);
      actions.push(createActionLog(toolCall, result));
      return { result, refusal };
    };

    // Structured custom-bot policy is a runtime security boundary, not a
    // prompt suggestion. It runs before permission UI or external ACP
    // terminal delegation, so disallowed commands cannot escape via a
    // different execution surface.
    if (activePersonality && !isPersonalityToolCallAllowed(activePersonality, toolCall, registeredMcpToolNames)) {
      const allowed = activePersonality.declaredTools?.join(', ') || 'none';
      const refused = refuse(
        `Tool "${toolCall.tool}" is blocked by custom bot "${activePersonality.displayName}".`,
        `Tool ${toolCall.tool} is blocked by the active custom bot. Allowed capabilities: ${allowed}.`,
      );
      // The one event nothing recorded before. A boundary you cannot audit
      // is a boundary you have to take on faith.
      recordAuditEvent(auditRoot, {
        ts: Date.now(), run: auditRun, tool: toolCall.tool, action: 'refused',
        target: describeAuditTarget(toolCall), outcome: 'refused',
        detail: `blocked by custom bot "${activePersonality.displayName}"; allowed: ${allowed}`,
      });
      return refused;
    }

    // Tool scoping for delegated sub-agents: reject any tool outside the
    // agent's allowlist up front — no permission prompt, no execution.
    if (opts.allowedTools && !opts.allowedTools.includes(toolCall.tool)) {
      return refuse(
        `Tool "${toolCall.tool}" is not available to this sub-agent.`,
        `Tool ${toolCall.tool} is not allowed for this sub-agent. Use only: ${opts.allowedTools.join(', ')}.`,
      );
    }

    const denied = () => refuse(
      `User rejected permission for ${toolCall.tool}`,
      `Tool ${toolCall.tool} was denied by user. Do not attempt this action again.`,
    );

    // Writing a file that decides what runs later is code execution on a
    // delay, not an edit: git runs `core.fsmonitor` itself on the next
    // `git status` the status line makes, a `.codeep/hooks/` script runs on
    // the next tool call, an MCP entry spawns a process. A prompt injection
    // that gets one of these written has walked around every other gate, so
    // the write is confirmed in EVERY confirmation mode — not only the tiers
    // that happen to list write_file — and an "always allow" answer given for
    // the tool never covers it. With nobody to ask, it fails the way a write
    // the editor refused fails: proceeding quietly is the one outcome that
    // cannot be taken back.
    const trustBearing = trustBearingWrite(toolCall, projectContext.root || process.cwd());
    if (trustBearing) {
      if (!opts.onRequestPermission) {
        const refusal = refuse(
          `Refused ${toolCall.tool} on ${trustBearing.path}: ${trustBearing.reason} ${NO_CONFIRMER_REFUSAL}`,
          `Tool ${toolCall.tool} was refused on ${trustBearing.path}. ${trustBearing.reason} Nobody could be asked to confirm it. Do not try again — tell the user to edit that file themselves.`,
        );
        recordAuditEvent(auditRoot, {
          ts: Date.now(), run: auditRun, tool: toolCall.tool, action: 'refused',
          target: describeAuditTarget(toolCall), outcome: 'refused',
          detail: `${trustBearing.path} decides what runs later and no confirmation was possible`,
        });
        return refusal;
      }

      // An "always deny" already given: for the tool, when the user really
      // chose that in an ordinary prompt, or for this file.
      if (alwaysRejectedTools.has(toolCall.tool) || alwaysRejectedPaths.has(trustBearing.file)) return denied();

      const decision = classifyPermissionOutcome(await opts.onRequestPermission(toolCall, trustBearing));
      // Neither answer is remembered for the TOOL. "Always allow" is not
      // remembered at all: it was an answer about THIS file, and the next
      // `.git/config` write must be asked about again. "Always deny" is
      // remembered against the file — the fail-closed half of the same rule.
      // Against the tool it would be a trap: the TUI offers Allow, Always
      // Allow and Deny, and that Deny answers reject_always, so refusing one
      // `.git/config` prompt would silently disable delete_file for the rest
      // of the run.
      if (decision !== 'allow-once' && decision !== 'allow-always') {
        if (decision === 'deny-always') alwaysRejectedPaths.add(trustBearing.file);
        return denied();
      }
    } else if (opts.onRequestPermission && requiresPermission(toolCall.tool, dangerousTools) && !alwaysAllowedTools.has(toolCall.tool)) {
      // Every other tool: the run's dangerous set decides, and only when
      // there is a callback to ask through (e.g. ACP/Zed).

      // Skip without asking if permanently rejected this session
      if (alwaysRejectedTools.has(toolCall.tool)) return denied();

      // `null` and not nothing: this branch runs only when the call writes no
      // such file, and saying so spares the dialog the second lookup.
      const outcome = await opts.onRequestPermission(toolCall, null);
      // Fail CLOSED: allow ONLY on an explicit allow outcome; reject_* and
      // any malformed/unknown outcome deny (see classifyPermissionOutcome).
      const decision = classifyPermissionOutcome(outcome);
      if (decision === 'allow-always') {
        alwaysAllowedTools.add(toolCall.tool);
      } else if (decision !== 'allow-once') {
        if (decision === 'deny-always') alwaysRejectedTools.add(toolCall.tool);
        return denied();
      }
    }

    let toolResult: ToolResult;

    // A dry run simulates every tool, delegation included — a sub-agent
    // started from here would otherwise do the real work.
    if (opts.dryRun) {
      toolResult = {
        success: true,
        output: `[DRY RUN] Would execute: ${toolCall.tool}`,
        tool: toolCall.tool,
        parameters: toolCall.parameters,
      };
    } else if (toolCall.tool === 'delegate') {
      toolResult = await runDelegate(toolCall);
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
          // Runs in the editor's terminal instead of ours, so executeTool's
          // own invalidation never fires — but `git config core.hooksPath
          // .evil` moves this repository's hooks just the same. Drop the
          // cached answer here too, or the next write to the new hook
          // directory goes through unasked.
          forgetHooksDirectory();
          const commandResult = await opts.onExecuteCommand(command, args, cwd);
          toolResult = {
            success: commandResult.exitCode === 0,
            output: commandResult.stdout || '(no output)',
            error: commandResult.exitCode !== 0 ? (commandResult.stderr || `exited with code ${commandResult.exitCode}`) : undefined,
            tool: toolCall.tool,
            parameters: toolCall.parameters,
          };
        } catch (err) {
          // The callback decides where the command runs and whether it can
          // fall back to running here. When it throws, the command may already
          // have run in the editor, so running it again locally could run it
          // twice. Report the failure instead.
          debug('onExecuteCommand callback threw:', err);
          toolResult = {
            success: false,
            output: '',
            error: `Command could not be run: ${(err as Error)?.message ?? String(err)}`,
            tool: toolCall.tool,
            parameters: toolCall.parameters,
          };
        }
      }
    } else {
      toolResult = await executeTool(toolCall, projectContext.root || process.cwd(), opts.fs, opts.mcpSessionId, opts.abortSignal);
    }

    opts.onToolResult?.(toolResult, toolCall);

    // Log action
    const actionLog = createActionLog(toolCall, toolResult);
    actions.push(actionLog);
    // createActionLog already classified this; reuse its verdict rather than
    // re-deriving the action type in a second place that could drift.
    recordAuditEvent(auditRoot, {
      ts: Date.now(), run: auditRun, tool: toolCall.tool, action: actionLog.type,
      target: describeAuditTarget(toolCall),
      outcome: toolResult.success ? 'ok' : 'error',
      detail: toolResult.success ? undefined : toolResult.error,
    });
    return { result: toolResult };
  };
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
        const durationMin = Math.round(opts.maxDuration / 60000);
        result = asNotice(buildPausedResult('time_limit', { iterations: iteration, actions, durationMin }));
        if (!opts.nested) writeProgressLog(projectContext.root || '', prompt, result, projectContext.name);
        return result;
      }
      
      // Check abort signal
      if (opts.abortSignal?.aborted) {
        debug('Agent aborted at iteration', iteration);
        result = asNotice({
          success: false,
          iterations: iteration,
          actions,
          finalResponse: 'Agent was stopped by user',
          aborted: true,
        });
        return result;
      }
      
      iteration++;
      opts.onIteration?.(iteration, `Iteration ${iteration}/${opts.maxIterations}`);

      // Throttle between iterations to avoid rate limits on token-heavy providers.
      // Delay scales with context size: ~1s per 10K tokens, capped at 5s.
      if (iteration > 1) {
        const totalTokensEstimate = messages.reduce((sum, m) => sum + Math.ceil((m.content as string).length / 4), 0);
        const throttleMs = Math.min(Math.floor(totalTokensEstimate / 10000) * 1000, 5000);
        if (throttleMs > 0) await abortableSleep(throttleMs, opts.abortSignal);
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
          const { consumeSessionCatalogChanges, getSessionTools, getSessionVirtualTools } = await import('./mcpRegistry.js');
          const dirty = consumeSessionCatalogChanges(opts.mcpSessionId);
          if (dirty.has('tools')) {
            const [refreshed, refreshedVirtuals] = await Promise.all([
              getSessionTools(opts.mcpSessionId),
              getSessionVirtualTools(opts.mcpSessionId),
            ]);
            const localToolDefs = mcpToolDefs.filter(tool => tool.name === 'invoke_skill' || tool.name === 'delegate');
            const refreshedMcpDefs = [...refreshed, ...refreshedVirtuals].map(t => ({
              name: t.agentName,
              description: t.description,
              inputSchema: t.inputSchema,
            }));
            mcpToolDefs = [...refreshedMcpDefs, ...localToolDefs];
            registeredMcpToolNames.clear();
            refreshedMcpDefs.forEach(tool => registeredMcpToolNames.add(tool.name));
            updateRuntimeToolAllowlist();
            debug(`MCP tool catalog refreshed mid-run: ${refreshedMcpDefs.length} tool(s)`);
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
            chatRuntime,
          );
          consecutiveTimeouts = 0; // Reset consecutive count on success
          consecutiveRateLimits = 0;
          break;
        } catch (error) {
          const err = error as Error;
          
          // Handle user abort (not timeout)
          if (err.name === 'AbortError') {
            result = asNotice({
              success: false,
              iterations: iteration,
              actions,
              finalResponse: 'Agent was stopped by user',
              aborted: true,
            });
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
                result = asNotice({
                  success: false,
                  iterations: iteration,
                  actions,
                  finalResponse: 'Agent stopped due to repeated API timeouts',
                  error: `API timed out ${consecutiveTimeouts} times consecutively. Try increasing the timeout in settings or simplifying the task.`,
                });
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
            await abortableSleep(1000 * retryCount, opts.abortSignal);
            // Stopping during a backoff must actually stop. Without this the
            // wait ended and the loop retried the request the user cancelled.
            if (opts.abortSignal?.aborted) break;
            continue;
          }

          // Don't retry on 4xx client errors except 429 (rate limit)
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            result = asNotice({
              success: false,
              iterations: iteration,
              actions,
              finalResponse: '',
              error: err.message,
            });
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
                result = asNotice({
                  success: false,
                  iterations: iteration,
                  actions,
                  finalResponse: actions.length > 0
                    ? `Agent paused after ${actions.length} action(s) — API rate limit reached. Wait a moment and try again.`
                    : 'API rate limit reached. Wait a moment and run the agent again.',
                  error: `Rate limited (429) after ${maxTimeoutRetries} retries: ${err.message}`,
                });
                return result;
              }
            } else {
              consecutiveRateLimits = 0; // Reset on non-rate-limit errors
            }
            // Don't throw — skip this iteration like timeouts do
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
              result = asNotice({
                success: false,
                iterations: iteration,
                actions,
                finalResponse: actions.length > 0
                  ? `Agent made progress (${actions.length} actions) but API errors prevented completion. You can continue by running the agent again.`
                  : 'Agent could not complete the task due to repeated API errors. Check your API key and network connection.',
                error: `API failed after ${maxTimeoutRetries} retries: ${err.message}`,
              });
              return result;
            }
            messages.push({
              role: 'user',
              content: 'The previous request failed. Please continue with the task.'
            });
            break; // Break retry loop, continue main loop
          }
          await abortableSleep(waitSec * 1000, opts.abortSignal);
          // Stopping during a rate-limit wait must actually stop. Without
          // this the wait ran to completion and the loop retried the request
          // the user had already cancelled.
          if (opts.abortSignal?.aborted) break;
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
          // The model this run talks to, which a sub-agent may have overridden.
          const contextWindow = getModelContextWindow(String(chatRuntime.model ?? config.get('model')));
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
      // Responses API turns only (undefined on Chat Completions and Anthropic):
      // the items to replay, and calls whose arguments did not parse. Those
      // still need an answer, so a turn with only rejected calls is a tool
      // turn, not a final reply.
      const native = chatResponse.native;
      const rejectedCalls = native?.rejectedCalls ?? [];
      if (chatResponse.incompleteReason) {
        opts.onIteration?.(iteration, chatResponse.incompleteReason === 'max_output_tokens'
          ? '⚠ Reply cut off at the output-token limit (reasoning counts toward it) — raise maxTokens in /settings if this repeats'
          : `⚠ Reply incomplete (${chatResponse.incompleteReason})`);
      }

      // If native tools were used but no tool calls returned, try parsing text-based tool calls
      // This handles models that accept tools parameter but respond with text anyway
      if (usedNativeTools && toolCalls.length === 0 && rejectedCalls.length === 0 && iteration === 1) {
        const textToolCalls = parseToolCalls(content);
        if (textToolCalls.length > 0) {
          toolCalls = textToolCalls;
        }
      }

      // Warn the user if Ollama model fails to produce tool calls early on
      if (toolCalls.length === 0 && iteration <= 2 && providerId === 'ollama') {
        const model = String(chatRuntime.model ?? config.get('model'));
        const paramMatch = model.toLowerCase().match(/(\d+(?:\.\d+)?)b/);
        const params = paramMatch ? parseFloat(paramMatch[1]) : null;
        if (params !== null && params < 7) {
          opts.onChunk?.(`\n\n⚠️ **Model too small for agent mode** — \`${model}\` (${params}B) does not reliably support tool calling. Use a 7B+ model (e.g. \`qwen2.5-coder:7b\`) or set Agent Mode to Manual/Off in \`/settings\`.\n`);
        }
      }
      
      // If no tool calls, check if model wants to continue or is really done
      if (toolCalls.length === 0 && rejectedCalls.length === 0) {
        debug(`No tool calls at iteration ${iteration}, content length: ${content.length}`);
        
        // Remove <think>...</think> tags from response (some models include thinking)
        // Also remove Tool parameters/tool call artifacts that AI sometimes includes in text
        appended = '';
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
          const fragment: Message = { role: 'assistant', content: assistantHistoryText(content, toolCalls) };
          messages.push(fragment);
          if (native) responsesState.tagAssistant(fragment, native);
          messages.push({
            role: 'user',
            content: 'Continue. Execute the tool calls now.'
          });
          // The fragment is not an answer. Left in place, it would make a run
          // that later hits the step limit look finished.
          finalResponse = '';
          continue;
        }
        // Reset counter once model produces real output or we give up
        incompleteWorkRetries = 0;
        
        // Model is done
        debug(`Agent finished at iteration ${iteration}`);
        break;
      }
      
      // Add assistant response to history — never empty (see assistantHistoryText).
      const assistantTurn: Message = { role: 'assistant', content: assistantHistoryText(content, toolCalls) };
      messages.push(assistantTurn);
      if (native) responsesState.tagAssistant(assistantTurn, native);
      
      // Execute tool calls
      const toolResults: string[] = [];
      // The same texts keyed by the call they answer — the Responses API
      // sends them as function_call_output items instead of one user message.
      const outputsByCall: ToolOutputEntry[] = [];
      
      for (const toolCall of toolCalls) {
        // Stop kills a running command at once; the calls queued behind it in
        // the same reply must not go ahead and write files after that.
        if (opts.abortSignal?.aborted) break;
        opts.onToolCall?.(toolCall);
        const record = (text: string) => {
          toolResults.push(text);
          if (toolCall.id) outputsByCall.push({ call_id: toolCall.id, output: text });
        };

        const { result: toolResult, refusal } = await dispatchToolCall(toolCall);
        if (refusal) {
          record(refusal);
          continue;
        }

        // ── Infinite loop detection for write/edit ──────────────────────────
        if (toolCall.tool === 'write_file' || toolCall.tool === 'edit_file') {
          const filePath = toolCall.parameters.path as string || '';
          const contentKey = JSON.stringify(toolCall.parameters).slice(0, 500);
          const prevHash = lastWriteHashByPath.get(filePath);
          if (prevHash === contentKey) {
            duplicateWriteCount++;
            if (duplicateWriteCount >= 2) {
              record(`[WARNING] You have written the same content to \`${filePath}\` ${duplicateWriteCount + 1} times in a row. You are stuck in a loop. Stop and think differently — read the file to check its current state, then try a completely different approach.`);
              duplicateWriteCount = 0;
            } else {
              record(`Tool ${toolCall.tool} succeeded (note: same content as previous write to this file):\n${toolResult.output}`);
            }
          } else {
            duplicateWriteCount = 0;
            lastWriteHashByPath.set(filePath, contentKey);
            if (toolResult.success) {
              record(`Tool ${toolCall.tool} succeeded:\n${toolResult.output}`);
            } else {
              record(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
            }
          }
        // ── Duplicate read cache ────────────────────────────────────────────
        } else if (toolCall.tool === 'read_file' && toolResult.success) {
          const filePath = toolCall.parameters.path as string || '';
          if (readCache.has(filePath)) {
            record(`Tool read_file succeeded (cached — file unchanged since last read):\n${readCache.get(filePath)}`);
          } else {
            const truncated = truncateToolResult(toolResult.output, toolCall.tool);
            readCache.set(filePath, truncated);
            record(`Tool read_file succeeded:\n${truncated}`);
          }
        // ── General truncation for other tools ─────────────────────────────
        } else if (toolResult.success) {
          const truncated = truncateToolResult(toolResult.output, toolCall.tool);
          record(`Tool ${toolCall.tool} succeeded:\n${truncated}`);
        } else {
          record(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
        }

        // Invalidate read cache when files may have changed
        if ((toolCall.tool === 'write_file' || toolCall.tool === 'edit_file') && toolResult.success) {
          const filePath = toolCall.parameters.path as string || '';
          readCache.delete(filePath);
        } else if (toolCall.tool === 'execute_command' && toolResult.success) {
          readCache.clear(); // Commands can modify arbitrary files
        }
      }
      
      if (native) {
        // Calls whose arguments did not parse still get an answer, so the
        // model can call again properly; calls a Stop skipped are said to be
        // unexecuted. On Chat Completions `native` is undefined and neither
        // applies — its history is text, with nothing left waiting.
        for (const rejected of rejectedCalls) {
          const text = `Error: arguments for ${rejected.name} could not be parsed (${rejected.reason}). Call it again with valid JSON.`;
          toolResults.push(text);
          outputsByCall.push({ call_id: rejected.call_id, output: text });
        }
        const answered = new Set(outputsByCall.map(o => o.call_id));
        for (const toolCall of toolCalls) {
          if (toolCall.id && !answered.has(toolCall.id)) outputsByCall.push({ call_id: toolCall.id, output: '[not executed: run stopped]' });
        }
      }

      // Add tool results to messages
      const toolResultsMessage: Message = {
        role: 'user',
        content: `Tool results:\n\n${toolResults.join('\n\n')}\n\nContinue with the task. Keep working until everything is fully done.`,
      };
      messages.push(toolResultsMessage);
      if (native && outputsByCall.length > 0) responsesState.tagToolOutputs(toolResultsMessage, outputsByCall);
    }
    
    // Check if we hit max iterations — build partial summary from actions log
    if (iteration >= opts.maxIterations && !finalResponse) {
      result = asNotice(buildPausedResult('iteration_limit', { iterations: iteration, actions, maxIterations: opts.maxIterations }));
      if (!opts.nested) writeProgressLog(projectContext.root || '', prompt, result, projectContext.name);
      return result;
    }
    
    // Self-verification: Run build/test and fix errors if needed
    const autoVerifyRaw = opts.autoVerify ?? config.get('agentAutoVerify');
    // Support legacy boolean values: true -> 'all', false -> 'off'
    const autoVerify = autoVerifyRaw === true ? 'all' : autoVerifyRaw === false ? 'off' : autoVerifyRaw;
    const maxFixAttempts = opts.maxFixAttempts ?? config.get('agentMaxFixAttempts');
    const botAllowsTerminal = !activePersonality?.restrictTools || activePersonality.tools?.includes('terminal') === true;
    const botAllowsTests = botAllowsTerminal || activePersonality?.tools?.includes('tests') === true;
    const verificationPolicy = {
      runBuild: (autoVerify === 'all' || autoVerify === 'build') && botAllowsTerminal,
      runTest: (autoVerify === 'all' || autoVerify === 'test') && botAllowsTests,
      runTypecheck: (autoVerify === 'all' || autoVerify === 'typecheck') && botAllowsTerminal,
      runLint: false,
    };
    const hasPermittedVerification = verificationPolicy.runBuild || verificationPolicy.runTest || verificationPolicy.runTypecheck;
    // Set when the checks still fail as verification stops, whatever stopped
    // it: attempts used up, the step limit, or a fix request that errored.
    let verificationFailure: string | undefined;
    let stillFailing: string[] = [];

    if (autoVerify !== 'off' && !opts.dryRun && hasPermittedVerification) {
      // Check if we made any file changes worth verifying
      const hasFileChanges = actions.some(a => 
        a.type === 'write' || a.type === 'edit' || a.type === 'delete'
      );
      
      if (hasFileChanges) {
        let fixAttempt = 0;
        let previousErrorSignature = '';
        // The latest failing verification, cleared once a later one passes.
        let unresolved: VerifyResult[] | null = null;
        // Set once a verification finishes with no failing check.
        let verified = false;

        while (fixAttempt < maxFixAttempts) {
          // Check abort signal
          if (opts.abortSignal?.aborted) {
            break;
          }

          opts.onIteration?.(iteration, `Verification attempt ${fixAttempt + 1}/${maxFixAttempts}`);

          // Run verifications based on selected mode
          const verifyResults = await runAllVerifications(projectContext.root || process.cwd(), {
            ...verificationPolicy,
            signal: opts.abortSignal,
          });
          // Stopping kills the running checks, which then read as "could not
          // run". That is not a verdict: the run was stopped (handled below).
          if (opts.abortSignal?.aborted) break;

          opts.onVerification?.(verifyResults);

          // Point the agent at errors in files it touched, so it doesn't wander
          // off into unrelated code. This only narrows what the agent is shown;
          // a failing check stays failed. When nothing would be left — every
          // error is in a file this run didn't touch (a rename breaks an
          // importer, a test file fails) or the output couldn't be parsed —
          // the full list stays, since hiding it would pass a broken build.
          const touchedFiles = new Set(
            actions
              .filter(a => a.type === 'write' || a.type === 'edit')
              .map(a => a.target)
          );
          let errorsOutsideTouchedFiles = false;
          for (const vr of verifyResults) {
            if (vr.success) continue;
            const related = vr.errors.filter(e => {
              if (!e.file) return true; // Keep errors without file info (build failures etc)
              return touchedFiles.has(e.file) || [...touchedFiles].some(f => e.file!.endsWith(f) || f.endsWith(e.file!));
            });
            if (related.some(e => e.severity === 'error')) {
              vr.errors = related;
            } else if (vr.errors.some(e => e.file)) {
              errorsOutsideTouchedFiles = true;
            }
          }

          // Checks that could not run are reported, not fixed: there is
          // nothing in them for the model to act on, and they say nothing
          // about whether the change is right.
          if (!hasVerificationErrors(verifyResults)) {
            unresolved = null;
            verified = true;
            const summary = getVerificationSummary(verifyResults);
            if (summary.passed > 0) {
              appendToResponse(`\n\n✓ Verification passed: ${summary.passed}/${summary.total} checks`);
            }
            const notRun = describeChecksNotRun(verifyResults);
            if (notRun) appendToResponse(`\n\n${notRun}`);
            break;
          }

          unresolved = verifyResults;
          fixAttempt++;

          // Out of attempts: stop here and report the failure below.
          if (fixAttempt >= maxFixAttempts) {
            break;
          }

          // Detect if the same errors are repeating (previous fix attempt didn't help)
          let errorMessage = formatErrorsForAgent(verifyResults);
          if (errorsOutsideTouchedFiles) {
            errorMessage += '\n\nSome of these errors are in files you did not change and may predate this task. Fix them only if your change caused them.';
          }
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
              chatRuntime,
            );
            
            const { content: fixContent, toolCalls: fixToolCalls } = fixResponse;
            
            if (fixToolCalls.length === 0) {
              // Agent gave up or thinks it's fixed
              finalResponse = fixContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
              appended = '';
              continue; // Re-run verification
            }
            
            // Execute fix tool calls
            const fixTurn: Message = { role: 'assistant', content: fixContent };
            messages.push(fixTurn);
            if (fixResponse.native) responsesState.tagAssistant(fixTurn, fixResponse.native);
            const fixResults: string[] = [];
            const fixOutputsByCall: ToolOutputEntry[] = [];
            
            for (const toolCall of fixToolCalls) {
              if (opts.abortSignal?.aborted) break;
              opts.onToolCall?.(toolCall);
              const recordFix = (text: string) => {
                fixResults.push(text);
                if (toolCall.id) fixOutputsByCall.push({ call_id: toolCall.id, output: text });
              };

              // Same gates as the main loop: a fix is still a tool call.
              const { result: toolResult, refusal } = await dispatchToolCall(toolCall);
              if (refusal) {
                recordFix(refusal);
                continue;
              }

              if (toolResult.success) {
                const truncated = truncateToolResult(toolResult.output, toolCall.tool);
                recordFix(`Tool ${toolCall.tool} succeeded:\n${truncated}`);
              } else {
                recordFix(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
              }
            }
            if (fixResponse.native) {
              for (const rejected of fixResponse.native.rejectedCalls) {
                fixOutputsByCall.push({ call_id: rejected.call_id, output: `Error: arguments for ${rejected.name} could not be parsed (${rejected.reason}). Call it again with valid JSON.` });
              }
            }
            
            const fixResultsMessage: Message = {
              role: 'user',
              content: `Fix results:\n\n${fixResults.join('\n\n')}\n\nContinue fixing if needed. Re-running verification...`,
            };
            messages.push(fixResultsMessage);
            if (fixResponse.native && fixOutputsByCall.length > 0) responsesState.tagToolOutputs(fixResultsMessage, fixOutputsByCall);
            
          } catch (error) {
            // If fix attempt failed, continue to next attempt
            break;
          }
        }

        // Stopped by the user before verification had its answer: that is a
        // stopped run, whatever the last check said.
        if (!verified && opts.abortSignal?.aborted) {
          debug('Agent aborted during verification');
          const stopped = finalResponse ? '\n\nAgent was stopped by user before verification finished' : 'Agent was stopped by user';
          result = {
            success: false,
            iterations: iteration,
            actions,
            finalResponse: `${finalResponse}${stopped}`,
            aborted: true,
            unstreamedText: `${appended}${stopped}`.trim(),
          };
          return result;
        }

        // Never end a run whose checks still fail as if it had passed: say so
        // in the response and fail the run, so nothing downstream (the
        // completion notice, auto-commit, the progress log) treats it as done.
        if (unresolved) {
          appendToResponse(`\n\n${describeVerificationFailure(unresolved)}`);
          const notRun = describeChecksNotRun(unresolved);
          if (notRun) appendToResponse(`\n\n${notRun}`);
          stillFailing = failedChecks(unresolved).map(r => r.command);
          verificationFailure = `Verification failed: ${stillFailing.join(', ')}`;
        }
      }
    }
    
    // Pipeline (Phase 2): optional automatic review pass. After a top-level run
    // that changed files, delegate to the `reviewer` sub-agent and append its
    // findings — guaranteeing a review stage without relying on the model to
    // self-delegate one. Opt-in (agentAutoReview); depth-0 only; never fatal.
    if (!opts.nested
        && (opts.depth ?? 0) === 0
        && !opts.dryRun
        && !activePersonality?.restrictTools
        && config.get('agentAutoReview') === true
        && !opts.abortSignal?.aborted
        && actions.some(a => a.type === 'write' || a.type === 'edit' || a.type === 'delete')) {
      try {
        const reviewTask = `Review the changes just made for this task:\n\n${prompt}\n\nInspect the current state of the changed files (and the git diff). Report concrete issues by severity — correctness/bugs, security, then design — with file:line and a one-line fix each. If it's solid, say so briefly.`;
        const review = await runDelegate({
          id: 'auto-review',
          tool: 'delegate',
          parameters: { agent: 'reviewer', task: reviewTask },
        } as ToolCall);
        const body = (review.output || '').replace(/^\[reviewer\]\s*/, '').trim();
        if (body) appendToResponse(`\n\n---\n### Auto-review (reviewer)\n${body}`);
      } catch {
        // A failed review must never fail the run.
      }
    }

    result = {
      success: !verificationFailure,
      iterations: iteration,
      actions,
      finalResponse,
      ...(verificationFailure ? { error: verificationFailure, failedChecks: stillFailing } : {}),
      unstreamedText: appended.trim(),
    };
    if (!opts.nested) writeProgressLog(projectContext.root || '', prompt, result, projectContext.name);
    return result;

  } catch (error) {
    const err = error as Error;
    auditFailure = err.message;
    result = asNotice({
      success: false,
      iterations: iteration,
      actions,
      finalResponse: '',
      error: err.message,
    });
    return result;
  } finally {
    // End session and save history. Skipped for nested runs so we don't write
    // a separate session file or null out the parent's open session.
    if (!opts.nested) {
      endSession();
      // In `finally`, so a run that throws still closes its record. An audit
      // trail that only survives success is worth very little — the runs you
      // most want to read are the ones that went wrong.
      //
      // The outcome comes from the result, not from whether an exception
      // escaped. Several failure paths — a user abort, a 4xx from the provider
      // — return `success: false` with a plain `return`, and reading only the
      // catch recorded those as successful runs. An audit record that says a
      // failed run passed is worse than having no record at all.
      const failed = auditFailure ?? (
        result === undefined || result.success
          ? undefined
          : (result.aborted ? 'stopped by the user' : (result.error ?? 'run did not succeed'))
      );
      endAuditRun(auditRoot, auditRun, failed ? 'error' : 'ok', failed);
    }
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
 * Actions of the run undo acts on (see getCurrentSession). Pass the workspace
 * to leave out a run in another one. `result` is 'undone' for an action that
 * has since been undone, 'success' otherwise.
 */
export function getCurrentSessionActions(projectRoot?: string): Array<{ type: string; target: string; result: 'success' | 'undone' }> {
  const session = getCurrentSession(projectRoot);
  if (!session) return [];
  return session.actions.map(a => ({
    type: a.type,
    target: a.path || '',
    result: a.undone ? 'undone' : 'success',
  }));
}
