/**
 * Agent chat API layer and prompt building.
 *
 * Exported:
 *   loadProjectRules()       — loads .codeep/rules.md or CODEEP.md
 *   formatChatHistoryForAgent() — trims history to fit context window
 *   getAgentSystemPrompt()   — builds system prompt for native-tool mode
 *   getFallbackSystemPrompt() — builds system prompt for text-tool mode
 *   agentChat()              — native tool-calling API call
 *   agentChatFallback()      — text-based tool format fallback
 *   AgentChatResponse        — response type (re-export from agentStream)
 *   TimeoutError             — distinguishes timeout from user abort
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { ProjectContext } from './project';
import { config, getApiKey, Message, resolveBaseUrl } from '../config/index';
import { loadProjectIntelligence, generateContextFromIntelligence } from './projectIntelligence';
import { formatCommandIndex } from './commandIndex';
import { syncProgress, generateProjectId } from './codeepCloud';
import { getProviderAuthHeader, supportsNativeTools, getEffectiveMaxTokens, usesMaxCompletionTokens, requiresDefaultTemperature, modelRejectsSamplingParams, isNoApiKeyProvider, reasoningParamsFor, providerNoStreamWithTools, type ReasoningTier } from '../config/providers';
import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from './tokenTracker';
import { parseOpenAIToolCalls, parseAnthropicToolCalls, parseToolCalls } from './toolParsing';
import { formatToolDefinitions, getOpenAITools, getAnthropicTools, AdditionalToolDef } from './tools';
import { readOpenRouterPreferences } from './openrouterPrefs';
import { handleStream, handleOpenAIAgentStream, handleAnthropicAgentStream } from './agentStream';
import type { AgentChatResponse } from './agentStream';
import { logger } from './logger';

export type { AgentChatResponse };

const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

/**
 * Custom error class for timeout
 */
export class TimeoutError extends Error {
  constructor(message: string = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Load project rules from .codeep/rules.md or CODEEP.md
 */
export function loadProjectRules(projectRoot: string): string {
  const candidates = [
    join(projectRoot, '.codeep', 'rules.md'),
    join(projectRoot, 'CODEEP.md'),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) {
          debug('Loaded project rules from', filePath);
          return `\n\n## Project Rules\nThe following rules are defined by the project owner. You MUST follow these rules:\n\n${content}`;
        }
      } catch (err) {
        debug('Failed to read project rules from', filePath, err);
      }
    }
  }

  return '';
}

/**
 * Load agent progress log from .codeep/progress.md
 * Injected into system prompt so agent knows what was previously done.
 */
export function loadProgressLog(projectRoot: string): string {
  if (!projectRoot) return '';
  const progressFile = join(projectRoot, '.codeep', 'progress.md');
  if (!existsSync(progressFile)) return '';
  try {
    const content = readFileSync(progressFile, 'utf-8').trim();
    if (content) {
      return `\n\n## Previous Session Progress\nThe agent has previously worked on this project. Read this to understand what was already done and what still needs to be done:\n\n${content}`;
    }
  } catch (err) {
    debug('Failed to read progress log from', progressFile, err);
  }
  return '';
}

/**
 * Write agent progress log to .codeep/progress.md
 * Called after each agent run so the next session has context.
 */
export function writeProgressLog(
  projectRoot: string,
  prompt: string,
  result: { success: boolean; iterations: number; actions: Array<{ type: string; target: string }>; finalResponse: string },
  projectName?: string,
): void {
  if (!projectRoot) return;
  const codeepDir = join(projectRoot, '.codeep');
  if (!existsSync(codeepDir)) return; // Only write if .codeep already exists (initialized project)
  try {
    const now = new Date().toISOString();
    const fileWrites = result.actions.filter(a => a.type === 'write' || a.type === 'edit');
    const fileDeletes = result.actions.filter(a => a.type === 'delete');
    const commands = result.actions.filter(a => a.type === 'command');

    const lines: string[] = [
      `# Agent Progress Log`,
      ``,
      `## Last Session: ${now}`,
      ``,
      `### Task`,
      `${prompt}`,
      ``,
      `### Status`,
      result.success ? `✓ Completed (${result.iterations} iterations)` : `⚠ Incomplete — task may need to be continued`,
      ``,
    ];

    if (fileWrites.length > 0) {
      lines.push(`### Files Written/Edited`);
      [...new Set(fileWrites.map(a => a.target))].forEach(f => lines.push(`- ${f}`));
      lines.push('');
    }
    if (fileDeletes.length > 0) {
      lines.push(`### Files Deleted`);
      [...new Set(fileDeletes.map(a => a.target))].forEach(f => lines.push(`- ${f}`));
      lines.push('');
    }
    if (commands.length > 0) {
      lines.push(`### Commands Run`);
      commands.forEach(a => lines.push(`- ${a.target}`));
      lines.push('');
    }
    if (result.finalResponse) {
      lines.push(`### Summary`);
      lines.push(result.finalResponse.slice(0, 3000));
      lines.push('');
    }
    if (!result.success) {
      lines.push(`### What Still Needs to Be Done`);
      lines.push(`The task was not fully completed in the last session. Run the agent again on the same project to continue from where it left off.`);
      lines.push('');
    }

    const content = lines.join('\n');
    writeFileSync(join(codeepDir, 'progress.md'), content, 'utf-8');
    if (projectName && projectRoot) {
      syncProgress({ projectName, projectId: generateProjectId(projectRoot), content });
    }
  } catch (err) {
    debug('Failed to write progress log:', err);
  }
}

/**
 * Format chat session history for inclusion in agent system prompt.
 * Keeps the most recent messages within a character budget.
 */
export function formatChatHistoryForAgent(
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxChars: number = 16000
): string {
  if (!history || history.length === 0) return '';

  const filtered = history.filter(m => {
    const content = m.content.trimStart();
    if (content.startsWith('[AGENT]') || content.startsWith('[DRY RUN]')) return false;
    if (content.startsWith('Agent completed') || content.startsWith('Agent failed') || content.startsWith('Agent stopped')) return false;
    return true;
  });

  if (filtered.length === 0) return '';

  const selected: Array<{ role: string; content: string }> = [];
  let totalChars = 0;

  for (let i = filtered.length - 1; i >= 0; i--) {
    const msg = filtered[i];
    const entry = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
    if (totalChars + entry.length > maxChars && selected.length > 0) break;
    if (entry.length > maxChars) {
      selected.unshift({ role: msg.role, content: msg.content.slice(0, maxChars - 100) + '\n[truncated]' });
      break;
    }
    selected.unshift(msg);
    totalChars += entry.length;
  }

  if (selected.length === 0) return '';

  const lines = selected.map(m =>
    `**${m.role === 'user' ? 'User' : 'Assistant'}:** ${m.content}`
  ).join('\n\n');

  return `\n\n## Prior Conversation Context\nThe following is the recent chat history from this session. Use it as background context to understand the user's intent, but focus on completing the current task.\n\n${lines}`;
}

// Same noise filter formatChatHistoryForAgent uses — kept in sync so the two
// functions agree on which messages are "real" conversation.
function filterAgentHistory<T extends { role: string; content: string }>(history: T[]): T[] {
  return history.filter(m => {
    const content = m.content.trimStart();
    if (content.startsWith('[AGENT]') || content.startsWith('[DRY RUN]')) return false;
    if (content.startsWith('Agent completed') || content.startsWith('Agent failed') || content.startsWith('Agent stopped')) return false;
    return true;
  });
}

// Cache summaries by a hash of the dropped messages, so re-running the agent in
// the same session (same overflow) doesn't re-summarize on every task.
const earlierSummaryCache = new Map<string, string>();

/**
 * Summarize the OVERFLOW that `formatChatHistoryForAgent` drops. When prior
 * history exceeds `maxChars`, that function keeps only the most recent messages
 * and silently discards the older ones — losing early decisions/constraints on
 * long sessions. This condenses those dropped messages into a short recap that
 * the caller prepends *before* the recent verbatim history.
 *
 * Returns '' when: opted out (`autoSummarizeHistory === false`), nothing
 * overflows, or the summarization call fails (graceful fallback — the recent
 * history still goes in, we just don't add a recap).
 */
export async function summarizeEarlierHistory(
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxChars: number = 16000,
): Promise<string> {
  if (config.get('autoSummarizeHistory') === false) return '';
  if (!history || history.length === 0) return '';

  const filtered = filterAgentHistory(history);
  if (filtered.length === 0) return '';

  // Mirror formatChatHistoryForAgent's newest→oldest budget walk to find which
  // messages it KEEPS; everything older than the oldest kept message is dropped.
  let totalChars = 0;
  let firstKept = filtered.length;
  for (let i = filtered.length - 1; i >= 0; i--) {
    const entry = `${filtered[i].role === 'user' ? 'User' : 'Assistant'}: ${filtered[i].content}`;
    if (totalChars + entry.length > maxChars && firstKept < filtered.length) break;
    if (entry.length > maxChars) { firstKept = i; break; }
    firstKept = i;
    totalChars += entry.length;
  }
  const dropped = filtered.slice(0, firstKept);
  if (dropped.length === 0) return '';

  const key = createHash('sha256')
    .update(dropped.map(m => `${m.role}:${m.content}`).join(' '))
    .digest('hex');
  const cached = earlierSummaryCache.get(key);
  if (cached) return cached;

  // Compact transcript of the dropped messages, capped so the summarization
  // prompt stays cheap even when a lot has overflowed.
  const transcript = dropped
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
    .slice(0, 24000);

  const system = 'You are condensing the EARLIER part of an ongoing coding session that no longer fits the context window. Summarize what happened in 3-6 sentences: concrete decisions made, constraints/requirements stated, files or APIs involved, and anything still unfinished. Past tense, no preamble, no bullet headers — just the recap.';

  try {
    const { chat } = await import('../api/index.js');
    const summary = (await chat(transcript, [{ role: 'system', content: system }])).trim();
    if (!summary) return '';
    const block = `\n\n## Earlier Conversation (summarized)\nThe earlier part of this session was condensed to fit context. Treat it as established background:\n\n${summary}`;
    earlierSummaryCache.set(key, block);
    return block;
  } catch {
    return ''; // graceful — recent verbatim history still gets injected
  }
}

export function getAgentSystemPrompt(projectContext: ProjectContext): string {
  const root = projectContext.root || process.cwd();
  // State the real underlying model/provider so "which model are you"
  // gets a truthful answer instead of a hallucinated one.
  const model = String(config.get('model') || '');
  const providerId = String(config.get('provider') || '');
  const identity = model
    ? `You are Codeep, an autonomous AI coding agent operating inside this project. The underlying model is \`${model}\` (via ${providerId}). If asked which model or provider you are, answer truthfully with these details. Never claim to be Claude or any other model unless that is genuinely the configured model.`
    : `You are Codeep, an autonomous AI coding agent operating inside this project. Never refer to yourself as Claude or any other AI unless that is genuinely the configured model.`;
  return `${identity}

## Tools
- read_file / write_file / edit_file / delete_file — file ops (prefer edit_file for modifications to keep surrounding content intact)
- create_directory / list_files / search_code — project navigation
- execute_command — ONLY for package managers & version control: npm, yarn, pnpm, bun, git, composer, pip, cargo, go, make. Never for ls/cat/grep/mkdir/rm/cp/mv/touch — use the dedicated tools.

## Behavior
- Do what the user asked — in whatever language they wrote. Tool names stay English.
- Read a file before editing it unless you just created it.
- Keep working until the task is actually finished. If you still have work to do, CALL A TOOL — don't just narrate. If you're done, reply with a short summary and no tool calls.
- Don't ask permission for routine work; the user already launched the agent.

## About Codeep
Codeep is an open-source, terminal-native AI coding agent — also a native macOS app and a VS Code / Zed extension (over ACP). Beyond the file/command tools above, the user can extend you through Codeep features:
- Skills — reusable workflow bundles (browse/add/run with \`/skills\`)
- MCP — connect external tools & data, e.g. Postgres, GitHub, a browser, the iOS simulator (\`/mcp\`)
- Sub-agents — delegate focused subtasks (\`/agents\`)
- Personalities — change your working style (\`/personality\`)
- A dashboard at codeep.dev for synced sessions, usage & cost
When the user asks what you can do, or a task maps to one of these, point them at the right slash-command:
${formatCommandIndex()}

## Codeep App Storage (your own metadata)
This project uses Codeep. The following paths are Codeep's internal state — **read** them if you need context about prior sessions, but do not edit them manually during a task:
- \`${root}/.codeep/intelligence.json\` — cached project analysis (structure, frameworks, CI/CD, conventions). Refresh via \`/scan\`.
- \`${root}/.codeep/progress.md\` — rolling log of actions from recent sessions.
- \`${root}/.codeep/sessions/\` — saved chat + agent sessions for undo/replay.
- \`${root}/.codeep/rules.md\` or \`${root}/CODEEP.md\` — project-specific rules you must follow (if present).
- \`${root}/.codeep/config.json\` — project-level config (permissions etc.).
- \`~/.config/codeep/config.json\` — global user config + API keys.

## Project Information
Name: ${projectContext.name || 'Unknown'}
Type: ${projectContext.type || 'unknown'}
Root: ${root}
${projectContext.structure ? `\n## Project Structure\n${projectContext.structure}` : ''}${(() => {
  const intelligence = loadProjectIntelligence(root);
  return intelligence ? `\n\n${generateContextFromIntelligence(intelligence)}` : '';
})()}`;
}

export function getFallbackSystemPrompt(
  projectContext: ProjectContext,
  additionalTools?: AdditionalToolDef[],
): string {
  return getAgentSystemPrompt(projectContext) + '\n\n' + formatToolDefinitions(additionalTools);
}

/**
 * Make a chat API call for agent mode with native tool support.
 * Falls back to agentChatFallback() if provider doesn't support tools.
 */
export async function agentChat(
  messages: Message[],
  systemPrompt: string,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal,
  dynamicTimeout?: number,
  /**
   * Extra tool definitions appended to the catalog (currently used to
   * surface MCP-registered tools as first-class entries the model can
   * invoke). Optional — built-in tools work the same whether this is
   * omitted or an empty array.
   */
  additionalTools?: AdditionalToolDef[],
): Promise<AgentChatResponse> {
  const protocol = config.get('protocol');
  const model = config.get('model');
  const providerId = config.get('provider');
  const apiKey = getApiKey() || (isNoApiKeyProvider(providerId) ? 'ollama' : null);

  let baseUrl = resolveBaseUrl(providerId, protocol);
  const authHeader = getProviderAuthHeader(providerId, protocol);

  if (!baseUrl) throw new Error(`Provider ${providerId} does not support ${protocol} protocol`);

  if (!supportsNativeTools(providerId, protocol)) {
    return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
  }

  const controller = new AbortController();
  const timeoutMs = dynamicTimeout || config.get('apiTimeout');
  let isTimeout = false;

  const timeout = setTimeout(() => { isTimeout = true; controller.abort(); }, timeoutMs);
  // Named handler + removal in `finally`. Each agent iteration reuses the same
  // external `abortSignal` — without cleanup, listeners pile up and Node warns
  // after 11 are attached (MaxListenersExceededWarning on AbortSignal).
  const onExternalAbort = () => { isTimeout = false; controller.abort(); };
  if (abortSignal) {
    abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey ?? ''}`;
  } else {
    headers['x-api-key'] = apiKey ?? '';
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  // OpenRouter branding — surfaces "Codeep" in the OpenRouter dashboard
  // attribution so users (and OpenRouter itself, for any partnership
  // tracking) see which app generated the traffic. Spec is informal; both
  // headers are documented at openrouter.ai/docs#headers.
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://codeep.dev';
    headers['X-Title'] = 'Codeep';
  }

  try {
    let endpoint: string;
    let body: Record<string, unknown>;
    // Qwen/DashScope reject `tools` + `stream:true` together; this path always
    // sends tools, so force a non-streamed request there (the non-streaming
    // branch below still emits the content via onChunk). Other providers stream.
    const useStreaming = Boolean(onChunk) && !providerNoStreamWithTools(providerId);

    // Provider-level guard (OpenAI GPT-5+) OR model-level guard — Anthropic's
    // Fable 5 / Opus 4.7+ reject temperature with a 400; omission is safe.
    const tempParam = (requiresDefaultTemperature(providerId) || modelRejectsSamplingParams(model)) ? {} : { temperature: config.get('temperature') };
    // Thinking-effort tier → provider-shaped param ({} for 'auto'/unsupported).
    const reasoningParam = reasoningParamsFor(providerId, model, config.get('reasoningEffort') as ReasoningTier);
    if (protocol === 'openai') {
      const maxTok = getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384));
      const tokParam = usesMaxCompletionTokens(providerId) ? { max_completion_tokens: maxTok } : { max_tokens: maxTok };
      endpoint = `${baseUrl}/chat/completions`;

      // OpenRouter-specific extras: request `usage` block in the response
      // body so we get per-call cost (skips our local pricing lookup), and
      // optionally a provider-routing preferences object the user set via
      // `/openrouter prefer …`.
      const openRouterExtras: Record<string, unknown> = {};
      if (providerId === 'openrouter') {
        openRouterExtras.usage = { include: true };
        const prefs = readOpenRouterPreferences();
        if (prefs) openRouterExtras.provider = prefs;
      }

      // Opt-in native Ollama transport for AGENT mode. When `ollamaNativeApi`
      // is on, route through /api/chat (honors num_ctx + keep_alive + the real
      // context window) and parse native tool_calls. OFF by default → the /v1
      // path below runs unchanged. Returns the agent response directly.
      if (providerId === 'ollama' && config.get('ollamaNativeApi') === true) {
        const { streamOllamaNativeChat, getOllamaContextLength } = await import('../api/ollamaNative.js');
        const ollamaUrl = (config.get('ollamaUrl') as string) || 'http://localhost:11434';
        const cfgCtx = Number(config.get('ollamaNumCtx')) || 0;
        const numCtx = cfgCtx > 0 ? cfgCtx : ((await getOllamaContextLength(model, ollamaUrl)) ?? undefined);
        const res = await streamOllamaNativeChat({
          baseUrl: ollamaUrl,
          model,
          messages: [],
          rawMessages: [{ role: 'system', content: systemPrompt }, ...messages] as unknown[],
          tools: getOpenAITools(additionalTools) as unknown[],
          numCtx,
          keepAlive: (config.get('ollamaKeepAlive') as string) || undefined,
          temperature: requiresDefaultTemperature(providerId) ? undefined : Number(config.get('temperature')),
          timeoutMs,
          onChunk: useStreaming ? onChunk : undefined,
        });
        if (res.promptTokens != null && res.completionTokens != null) {
          recordTokenUsage(
            { promptTokens: res.promptTokens, completionTokens: res.completionTokens, totalTokens: res.promptTokens + res.completionTokens },
            model, providerId,
          );
        }
        const toolCalls = res.toolCalls.map((tc) => ({ tool: tc.name, parameters: tc.arguments }));
        if (toolCalls.length === 0 && res.text) {
          const textCalls = parseToolCalls(res.text);
          if (textCalls.length > 0) return { content: res.text, toolCalls: textCalls, usedNativeTools: false };
        }
        return { content: res.text, toolCalls, usedNativeTools: true };
      }

      body = {
        model, messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: getOpenAITools(additionalTools), tool_choice: 'auto', stream: useStreaming,
        ...tempParam, ...tokParam, ...reasoningParam,
        // Ask ALL OpenAI-compatible providers to emit a usage block in the
        // stream — without this most (DeepSeek/Kimi/Grok/Qwen/GLM/…) send no
        // usage on streamed responses and the whole turn records zero tokens.
        // (OpenRouter also gets usage via openRouterExtras below; both is fine.)
        ...(useStreaming ? { stream_options: { include_usage: true } } : {}),
        ...openRouterExtras,
      };
    } else {
      endpoint = `${baseUrl}/v1/messages`;
      // Anthropic prompt caching. Two cache breakpoints:
      //   1. `system` (largest stable block — system prompt + skills catalog)
      //   2. last tool in `tools` (Anthropic caches everything up to and
      //      including the marker, so this caches the entire tools array)
      // Cache hits cost 0.1× input. Misses ("cache creation") cost 1.25×.
      // Net win after the 2nd same-shape request. Below 1024 input tokens
      // Anthropic silently skips caching — no error path to handle.
      const anthropicTools = getAnthropicTools(additionalTools);
      const cachedTools = anthropicTools.length > 0
        ? [
            ...anthropicTools.slice(0, -1),
            { ...anthropicTools[anthropicTools.length - 1], cache_control: { type: 'ephemeral' as const } },
          ]
        : anthropicTools;
      body = {
        model,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
        messages,
        tools: cachedTools, stream: useStreaming,
        ...tempParam, ...reasoningParam, max_tokens: getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384)),
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (errorText.includes('tools') || errorText.includes('function') || response.status === 400) {
        return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
      }
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    if (useStreaming && response.body) {
      if (protocol === 'openai') return await handleOpenAIAgentStream(response.body, onChunk!, model, providerId);
      else return await handleAnthropicAgentStream(response.body, onChunk!, model, providerId);
    }

    const data = await response.json();
    const usageExtractor = protocol === 'openai' ? extractOpenAIUsage : extractAnthropicUsage;
    const usage = usageExtractor(data);
    if (usage) {
      // OpenRouter returns the authoritative per-call cost in
      // `usage.cost` (USD). Use it instead of our local pricing table
      // since the catalog has 100+ models we don't track ourselves.
      const reportedCost = providerId === 'openrouter' && typeof data?.usage?.cost === 'number'
        ? data.usage.cost
        : undefined;
      recordTokenUsage(usage, model, providerId, reportedCost);
    }

    if (protocol === 'openai') {
      const message = data.choices?.[0]?.message;
      const content = message?.content || '';
      const rawToolCalls = message?.tool_calls || [];
      const toolCalls = parseOpenAIToolCalls(rawToolCalls);

      debug('Parsed tool calls:', toolCalls.length, toolCalls.map((t: { tool: string }) => t.tool));

      if (toolCalls.length === 0 && content) {
        const textToolCalls = parseToolCalls(content);
        if (textToolCalls.length > 0) return { content, toolCalls: textToolCalls, usedNativeTools: false };
      }
      if (onChunk && content) onChunk(content);
      return { content, toolCalls, usedNativeTools: true };
    } else {
      const contentBlocks = data.content || [];
      let textContent = '';
      for (const block of contentBlocks) {
        if (block.type === 'text') { textContent += block.text; if (onChunk) onChunk(block.text); }
      }
      const toolCalls = parseAnthropicToolCalls(contentBlocks);
      return { content: textContent, toolCalls, usedNativeTools: true };
    }
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      if (isTimeout) throw new TimeoutError(`API request timed out after ${timeoutMs}ms`);
      throw error;
    }
    if (err.message.includes('tools') || err.message.includes('function')) {
      return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (abortSignal) abortSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Fallback chat without native tools (text-based tool format)
 */
export async function agentChatFallback(
  messages: Message[],
  systemPrompt: string,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal,
  dynamicTimeout?: number
): Promise<AgentChatResponse> {
  const protocol = config.get('protocol');
  const model = config.get('model');
  const providerId = config.get('provider');
  const apiKey = getApiKey() || (isNoApiKeyProvider(providerId) ? 'ollama' : null);

  let baseUrl = resolveBaseUrl(providerId, protocol);
  const authHeader = getProviderAuthHeader(providerId, protocol);

  if (!baseUrl) throw new Error(`Provider ${providerId} does not support ${protocol} protocol`);

  const controller = new AbortController();
  const timeoutMs = dynamicTimeout || config.get('apiTimeout');
  let isTimeout = false;

  const timeout = setTimeout(() => { isTimeout = true; controller.abort(); }, timeoutMs);
  // See note in main agentChat above — listener cleanup prevents MaxListenersExceededWarning
  // when an agent loop calls this repeatedly with the same external signal.
  const onExternalAbort = () => { isTimeout = false; controller.abort(); };
  if (abortSignal) {
    abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey ?? ''}`;
  } else {
    headers['x-api-key'] = apiKey ?? '';
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';

  const fallbackPrompt = systemPrompt.includes('## Available Tools')
    ? systemPrompt
    : systemPrompt + '\n\n' + formatToolDefinitions();

  try {
    let endpoint: string;
    let body: Record<string, unknown>;

    // Provider-level guard (OpenAI GPT-5+) OR model-level guard — Anthropic's
    // Fable 5 / Opus 4.7+ reject temperature with a 400; omission is safe.
    const tempParam = (requiresDefaultTemperature(providerId) || modelRejectsSamplingParams(model)) ? {} : { temperature: config.get('temperature') };
    // Thinking-effort tier → provider-shaped param ({} for 'auto'/unsupported).
    const reasoningParam = reasoningParamsFor(providerId, model, config.get('reasoningEffort') as ReasoningTier);
    if (protocol === 'openai') {
      const maxTok = getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384));
      const tokParam = usesMaxCompletionTokens(providerId) ? { max_completion_tokens: maxTok } : { max_tokens: maxTok };
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model, messages: [{ role: 'system', content: fallbackPrompt }, ...messages],
        stream: Boolean(onChunk), ...tempParam, ...tokParam, ...reasoningParam,
      };
    } else {
      endpoint = `${baseUrl}/v1/messages`;
      // Fallback path injects system+tools as the first user message
      // (no native tool API). Cache that block — it's large and stable.
      body = {
        model,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: fallbackPrompt, cache_control: { type: 'ephemeral' as const } }],
          },
          { role: 'assistant', content: 'Understood. I will use the tools as specified.' },
          ...messages,
        ],
        stream: Boolean(onChunk), ...tempParam, ...reasoningParam,
        max_tokens: getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384)),
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    let content: string;
    if (onChunk && response.body) {
      content = await handleStream(response.body, protocol, onChunk);
    } else {
      const data = await response.json();
      const fallbackUsageExtractor = protocol === 'openai' ? extractOpenAIUsage : extractAnthropicUsage;
      const fallbackUsage = fallbackUsageExtractor(data);
      if (fallbackUsage) {
        const reportedCost = providerId === 'openrouter' && typeof data?.usage?.cost === 'number'
          ? data.usage.cost
          : undefined;
        recordTokenUsage(fallbackUsage, model, providerId, reportedCost);
      }
      content = protocol === 'openai' ? (data.choices?.[0]?.message?.content || '') : (data.content?.[0]?.text || '');
    }

    const toolCalls = parseToolCalls(content);
    return { content, toolCalls, usedNativeTools: false };
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      if (isTimeout) throw new TimeoutError(`API request timed out after ${timeoutMs}ms`);
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (abortSignal) abortSignal.removeEventListener('abort', onExternalAbort);
  }
}
