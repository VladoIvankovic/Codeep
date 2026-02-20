/**
 * Agent streaming handlers for OpenAI and Anthropic protocols.
 *
 * Parses SSE streams and accumulates tool calls from deltas.
 */

import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from './tokenTracker';
import { parseOpenAIToolCalls, parseAnthropicToolCalls, parseToolCalls } from './toolParsing';
import { ToolCall } from './tools';

// Debug logging helper - only logs when CODEEP_DEBUG=1
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    console.error('[DEBUG]', ...args);
  }
};

// Response from agent chat - includes both content and tool calls
export interface AgentChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usedNativeTools: boolean;
}

function tryParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * Handle streaming response (text-based fallback, no native tools)
 */
export async function handleStream(
  body: ReadableStream<Uint8Array>,
  protocol: string,
  onChunk: (chunk: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          let content: string | undefined;

          if (protocol === 'openai') {
            content = parsed.choices?.[0]?.delta?.content;
          } else if (parsed.type === 'content_block_delta') {
            content = parsed.delta?.text;
          }

          if (content) {
            chunks.push(content);
            onChunk(content);
          }
        } catch {
          // Skip parse errors
        }
      }
    }
  }

  return chunks.join('');
}

/**
 * Handle OpenAI streaming response with tool call accumulation
 */
export async function handleOpenAIAgentStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
  model: string,
  providerId: string
): Promise<AgentChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  const toolCallMap: Map<number, { id: string; name: string; arguments: string }> = new Map();
  let usageData: Record<string, unknown> | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);

        if (parsed.usage) {
          usageData = parsed;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          onChunk(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  if (usageData) {
    const usage = extractOpenAIUsage(usageData);
    if (usage) recordTokenUsage(usage, model, providerId);
  }

  const rawToolCalls = Array.from(toolCallMap.values()).map(tc => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.arguments },
  }));

  const toolCalls = parseOpenAIToolCalls(rawToolCalls);

  debug('Stream parsed tool calls:', toolCalls.length, toolCalls.map(t => t.tool));

  if (toolCalls.length === 0 && content) {
    const textToolCalls = parseToolCalls(content);
    if (textToolCalls.length > 0) {
      return { content, toolCalls: textToolCalls, usedNativeTools: false };
    }
  }

  return { content, toolCalls, usedNativeTools: true };
}

/**
 * Handle Anthropic streaming response with tool call accumulation
 */
export async function handleAnthropicAgentStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
  model: string,
  providerId: string
): Promise<AgentChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  const contentBlocks: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
  let currentBlockType = '';
  let currentToolName = '';
  let currentToolId = '';
  let currentToolInput = '';
  let usageData: Record<string, unknown> | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);

      try {
        const parsed = JSON.parse(data);

        if (parsed.usage) usageData = parsed;
        if (parsed.type === 'message_delta' && parsed.usage) usageData = parsed;

        if (parsed.type === 'content_block_start') {
          const block = parsed.content_block;
          if (block.type === 'text') {
            currentBlockType = 'text';
          } else if (block.type === 'tool_use') {
            currentBlockType = 'tool_use';
            currentToolName = block.name || '';
            currentToolId = block.id || '';
            currentToolInput = '';
          }
        } else if (parsed.type === 'content_block_delta') {
          if (currentBlockType === 'text' && parsed.delta?.text) {
            content += parsed.delta.text;
            onChunk(parsed.delta.text);
          } else if (currentBlockType === 'tool_use' && parsed.delta?.partial_json) {
            currentToolInput += parsed.delta.partial_json;
          }
        } else if (parsed.type === 'content_block_stop') {
          if (currentBlockType === 'tool_use') {
            contentBlocks.push({
              type: 'tool_use',
              id: currentToolId,
              name: currentToolName,
              input: tryParseJSON(currentToolInput),
            });
          }
          currentBlockType = '';
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  if (usageData) {
    const usage = extractAnthropicUsage(usageData);
    if (usage) recordTokenUsage(usage, model, providerId);
  }

  const toolCalls = parseAnthropicToolCalls(contentBlocks);
  return { content, toolCalls, usedNativeTools: true };
}
