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
import { ProjectContext } from './project';
import { config, getApiKey, Message } from '../config/index';
import { loadProjectIntelligence, generateContextFromIntelligence } from './projectIntelligence';
import { syncProgress, generateProjectId } from './codeepCloud';
import { getProviderBaseUrl, getProviderAuthHeader, supportsNativeTools, getEffectiveMaxTokens, usesMaxCompletionTokens, isNoApiKeyProvider } from '../config/providers';
import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from './tokenTracker';
import { parseOpenAIToolCalls, parseAnthropicToolCalls, parseToolCalls } from './toolParsing';
import { formatToolDefinitions, getOpenAITools, getAnthropicTools } from './tools';
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

export function getAgentSystemPrompt(projectContext: ProjectContext): string {
  const root = projectContext.root || process.cwd();
  return `You are Codeep, an autonomous AI coding agent operating inside this project. Never refer to yourself as Claude or any other AI.

## Tools
- read_file / write_file / edit_file / delete_file — file ops (prefer edit_file for modifications to keep surrounding content intact)
- create_directory / list_files / search_code — project navigation
- execute_command — ONLY for package managers & version control: npm, yarn, pnpm, bun, git, composer, pip, cargo, go, make. Never for ls/cat/grep/mkdir/rm/cp/mv/touch — use the dedicated tools.

## Behavior
- Do what the user asked — in whatever language they wrote. Tool names stay English.
- Read a file before editing it unless you just created it.
- Keep working until the task is actually finished. If you still have work to do, CALL A TOOL — don't just narrate. If you're done, reply with a short summary and no tool calls.
- Don't ask permission for routine work; the user already launched the agent.

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

export function getFallbackSystemPrompt(projectContext: ProjectContext): string {
  return getAgentSystemPrompt(projectContext) + '\n\n' + formatToolDefinitions();
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
  dynamicTimeout?: number
): Promise<AgentChatResponse> {
  const protocol = config.get('protocol');
  const model = config.get('model');
  const providerId = config.get('provider');
  const apiKey = getApiKey() || (isNoApiKeyProvider(providerId) ? 'ollama' : null);

  let baseUrl = getProviderBaseUrl(providerId, protocol);
  if (providerId === 'ollama' && protocol === 'openai') {
    const ollamaUrl = (config.get('ollamaUrl') || 'http://localhost:11434').replace(/\/$/, '');
    baseUrl = `${ollamaUrl}/v1`;
  }
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

  try {
    let endpoint: string;
    let body: Record<string, unknown>;
    const useStreaming = Boolean(onChunk);

    if (protocol === 'openai') {
      const maxTok = getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384));
      const tokParam = usesMaxCompletionTokens(providerId) ? { max_completion_tokens: maxTok } : { max_tokens: maxTok };
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model, messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: getOpenAITools(), tool_choice: 'auto', stream: useStreaming,
        temperature: config.get('temperature'), ...tokParam,
        ...(useStreaming && providerId === 'openai' ? { stream_options: { include_usage: true } } : {}),
      };
    } else {
      endpoint = `${baseUrl}/v1/messages`;
      body = {
        model, system: systemPrompt, messages,
        tools: getAnthropicTools(), stream: useStreaming,
        temperature: config.get('temperature'), max_tokens: getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384)),
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
    if (usage) recordTokenUsage(usage, model, providerId);

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

  let baseUrl = getProviderBaseUrl(providerId, protocol);
  if (providerId === 'ollama' && protocol === 'openai') {
    const ollamaUrl = (config.get('ollamaUrl') || 'http://localhost:11434').replace(/\/$/, '');
    baseUrl = `${ollamaUrl}/v1`;
  }
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

    if (protocol === 'openai') {
      const maxTok = getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384));
      const tokParam = usesMaxCompletionTokens(providerId) ? { max_completion_tokens: maxTok } : { max_tokens: maxTok };
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model, messages: [{ role: 'system', content: fallbackPrompt }, ...messages],
        stream: Boolean(onChunk), temperature: config.get('temperature'), ...tokParam,
      };
    } else {
      endpoint = `${baseUrl}/v1/messages`;
      body = {
        model,
        messages: [
          { role: 'user', content: fallbackPrompt },
          { role: 'assistant', content: 'Understood. I will use the tools as specified.' },
          ...messages,
        ],
        stream: Boolean(onChunk), temperature: config.get('temperature'),
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
      if (fallbackUsage) recordTokenUsage(fallbackUsage, model, providerId);
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
