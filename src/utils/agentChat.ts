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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ProjectContext } from './project';
import { config, getApiKey, Message } from '../config/index';
import { getProviderBaseUrl, getProviderAuthHeader, supportsNativeTools, getEffectiveMaxTokens } from '../config/providers';
import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from './tokenTracker';
import { parseOpenAIToolCalls, parseAnthropicToolCalls, parseToolCalls } from './toolParsing';
import { formatToolDefinitions, getOpenAITools, getAnthropicTools } from './tools';
import { handleStream, handleOpenAIAgentStream, handleAnthropicAgentStream } from './agentStream';
import type { AgentChatResponse } from './agentStream';

export type { AgentChatResponse };

const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    console.error('[DEBUG]', ...args);
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
  return `You are an AI coding agent with FULL autonomous access to this project.

## Your Capabilities
- Read, write, edit, and delete files and directories
- Create directories with create_directory tool
- Execute shell commands (npm, git, build tools, etc.)
- Search code in the project
- List directory contents

## IMPORTANT: Follow User Instructions Exactly
- Do EXACTLY what the user asks
- If user says "create a website" -> create ALL necessary files (HTML, CSS, JS, images, etc.)
- If user says "create folder X" -> use create_directory tool to create folder X
- If user says "delete file X" -> use delete_file tool to delete file X
- The user may write in any language - understand their request and execute it
- Tool names and parameters must ALWAYS be in English (e.g., "create_directory", not "kreiraj_direktorij")
- KEEP WORKING until the ENTIRE task is finished - do NOT stop after creating just directories or partial files
- Only stop when you have created ALL files needed for a complete, working solution

## Rules
1. Always read files before editing them to understand the current content
2. Use edit_file for modifications to existing files (preserves other content)
3. Use write_file only for creating new files or complete overwrites
4. Use create_directory to create new folders/directories
5. Use list_files to see directory contents
6. Use search_code to find files or search patterns
7. NEVER use execute_command for: ls, find, cat, grep, mkdir, rm, cp, mv, touch
8. Use execute_command ONLY for: npm, git, composer, pip, cargo (build/package managers)
9. When the task is complete, respond with a summary WITHOUT any tool calls
10. CRITICAL: If the task is NOT complete, you MUST call a tool — never respond with only text mid-task. Do not "think out loud" or describe what you are about to do without calling a tool. Act immediately.

## Project Information
Name: ${projectContext.name || 'Unknown'}
Type: ${projectContext.type || 'unknown'}
Root: ${projectContext.root || process.cwd()}
${projectContext.structure ? `\n## Project Structure\n${projectContext.structure}` : ''}`;
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
  const apiKey = getApiKey();
  const providerId = config.get('provider');

  const baseUrl = getProviderBaseUrl(providerId, protocol);
  const authHeader = getProviderAuthHeader(providerId, protocol);

  if (!baseUrl) throw new Error(`Provider ${providerId} does not support ${protocol} protocol`);

  if (!supportsNativeTools(providerId, protocol)) {
    return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
  }

  const controller = new AbortController();
  const timeoutMs = dynamicTimeout || config.get('apiTimeout');
  let isTimeout = false;

  const timeout = setTimeout(() => { isTimeout = true; controller.abort(); }, timeoutMs);
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => { isTimeout = false; controller.abort(); }, { once: true });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';

  try {
    let endpoint: string;
    let body: Record<string, unknown>;
    const useStreaming = Boolean(onChunk);

    if (protocol === 'openai') {
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model, messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: getOpenAITools(), tool_choice: 'auto', stream: useStreaming,
        temperature: config.get('temperature'), max_tokens: getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384)),
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
  const apiKey = getApiKey();
  const providerId = config.get('provider');

  const baseUrl = getProviderBaseUrl(providerId, protocol);
  const authHeader = getProviderAuthHeader(providerId, protocol);

  if (!baseUrl) throw new Error(`Provider ${providerId} does not support ${protocol} protocol`);

  const controller = new AbortController();
  const timeoutMs = dynamicTimeout || config.get('apiTimeout');
  let isTimeout = false;

  const timeout = setTimeout(() => { isTimeout = true; controller.abort(); }, timeoutMs);
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => { isTimeout = false; controller.abort(); }, { once: true });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';

  const fallbackPrompt = systemPrompt.includes('## Available Tools')
    ? systemPrompt
    : systemPrompt + '\n\n' + formatToolDefinitions();

  try {
    let endpoint: string;
    let body: Record<string, unknown>;

    if (protocol === 'openai') {
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model, messages: [{ role: 'system', content: fallbackPrompt }, ...messages],
        stream: Boolean(onChunk), temperature: config.get('temperature'),
        max_tokens: getEffectiveMaxTokens(providerId, Math.max(config.get('maxTokens'), 16384)),
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
  }
}
