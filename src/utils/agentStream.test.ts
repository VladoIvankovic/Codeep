import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockRecordTokenUsage, mockExtractOpenAIUsage, mockExtractAnthropicUsage,
        mockParseOpenAIToolCalls, mockParseAnthropicToolCalls, mockParseToolCalls } = vi.hoisted(() => ({
  mockRecordTokenUsage: vi.fn(),
  mockExtractOpenAIUsage: vi.fn(),
  mockExtractAnthropicUsage: vi.fn(),
  mockParseOpenAIToolCalls: vi.fn(),
  mockParseAnthropicToolCalls: vi.fn(),
  mockParseToolCalls: vi.fn(),
}));

vi.mock('./tokenTracker', () => ({
  recordTokenUsage: mockRecordTokenUsage,
  extractOpenAIUsage: mockExtractOpenAIUsage,
  extractAnthropicUsage: mockExtractAnthropicUsage,
}));
vi.mock('./toolParsing', () => ({
  parseOpenAIToolCalls: mockParseOpenAIToolCalls,
  parseAnthropicToolCalls: mockParseAnthropicToolCalls,
  parseToolCalls: mockParseToolCalls,
}));
vi.mock('./tools', () => ({}));

import { handleStream, handleOpenAIAgentStream, handleAnthropicAgentStream } from './agentStream';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a ReadableStream from SSE-formatted lines.
 */
function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.join('\n') + '\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`;
}

describe('handleStream', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns joined content from OpenAI delta chunks', async () => {
    const lines = [
      sseData({ choices: [{ delta: { content: 'Hello ' } }] }),
      sseData({ choices: [{ delta: { content: 'world' } }] }),
      'data: [DONE]',
    ];
    const onChunk = vi.fn();
    const result = await handleStream(makeSSEStream(lines), 'openai', onChunk);
    expect(result).toBe('Hello world');
    expect(onChunk).toHaveBeenCalledWith('Hello ');
    expect(onChunk).toHaveBeenCalledWith('world');
  });

  it('returns joined content from Anthropic content_block_delta chunks', async () => {
    const lines = [
      sseData({ type: 'content_block_delta', delta: { text: 'Hi ' } }),
      sseData({ type: 'content_block_delta', delta: { text: 'there' } }),
    ];
    const onChunk = vi.fn();
    const result = await handleStream(makeSSEStream(lines), 'anthropic', onChunk);
    expect(result).toBe('Hi there');
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it('skips [DONE] marker', async () => {
    const lines = [
      sseData({ choices: [{ delta: { content: 'text' } }] }),
      'data: [DONE]',
    ];
    const result = await handleStream(makeSSEStream(lines), 'openai', vi.fn());
    expect(result).toBe('text');
  });

  it('skips malformed JSON lines', async () => {
    const lines = [
      'data: not-valid-json',
      sseData({ choices: [{ delta: { content: 'valid' } }] }),
    ];
    const result = await handleStream(makeSSEStream(lines), 'openai', vi.fn());
    expect(result).toBe('valid');
  });

  it('returns empty string when no content chunks', async () => {
    const lines = ['data: [DONE]'];
    const result = await handleStream(makeSSEStream(lines), 'openai', vi.fn());
    expect(result).toBe('');
  });

  it('ignores non-data lines', async () => {
    const lines = [
      'event: message',
      sseData({ choices: [{ delta: { content: 'hi' } }] }),
    ];
    const result = await handleStream(makeSSEStream(lines), 'openai', vi.fn());
    expect(result).toBe('hi');
  });
});

describe('handleOpenAIAgentStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseOpenAIToolCalls.mockReturnValue([]);
    mockParseToolCalls.mockReturnValue([]);
    mockExtractOpenAIUsage.mockReturnValue(null);
  });

  it('returns content with usedNativeTools: true when no tool calls', async () => {
    const lines = [
      sseData({ choices: [{ delta: { content: 'Hello' } }] }),
      'data: [DONE]',
    ];
    const result = await handleOpenAIAgentStream(makeSSEStream(lines), vi.fn(), 'gpt-4', 'openai');
    expect(result.content).toBe('Hello');
    expect(result.usedNativeTools).toBe(true);
    expect(result.toolCalls).toEqual([]);
  });

  it('accumulates tool call arguments across multiple chunks', async () => {
    const mockToolCall = { tool: 'read_file', parameters: { path: 'src/index.ts' } };
    mockParseOpenAIToolCalls.mockReturnValue([mockToolCall]);

    const lines = [
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'read_file', arguments: '{"path":' } }] } }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/index.ts"}' } }] } }] }),
      'data: [DONE]',
    ];
    const result = await handleOpenAIAgentStream(makeSSEStream(lines), vi.fn(), 'gpt-4', 'openai');
    expect(mockParseOpenAIToolCalls).toHaveBeenCalledWith([
      { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } },
    ]);
    expect(result.toolCalls).toEqual([mockToolCall]);
  });

  it('falls back to text-based tool parsing when no native tool calls but content has them', async () => {
    const mockTextToolCall = { tool: 'read_file', parameters: { path: 'foo.ts' } };
    mockParseOpenAIToolCalls.mockReturnValue([]); // no native
    mockParseToolCalls.mockReturnValue([mockTextToolCall]);

    const lines = [
      sseData({ choices: [{ delta: { content: '<read_file><path>foo.ts</path></read_file>' } }] }),
      'data: [DONE]',
    ];
    const result = await handleOpenAIAgentStream(makeSSEStream(lines), vi.fn(), 'gpt-4', 'openai');
    expect(result.usedNativeTools).toBe(false);
    expect(result.toolCalls).toEqual([mockTextToolCall]);
  });

  it('records token usage when usage data present in stream', async () => {
    const usagePayload = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    mockExtractOpenAIUsage.mockReturnValue({ inputTokens: 10, outputTokens: 5 });

    const lines = [
      sseData({ choices: [{ delta: { content: 'ok' } }], ...usagePayload }),
      'data: [DONE]',
    ];
    await handleOpenAIAgentStream(makeSSEStream(lines), vi.fn(), 'gpt-4', 'openai');
    expect(mockRecordTokenUsage).toHaveBeenCalled();
  });

  it('handles malformed JSON lines without throwing', async () => {
    const lines = [
      'data: {broken json',
      sseData({ choices: [{ delta: { content: 'safe' } }] }),
    ];
    const result = await handleOpenAIAgentStream(makeSSEStream(lines), vi.fn(), 'gpt-4', 'openai');
    expect(result.content).toBe('safe');
  });
});

describe('handleAnthropicAgentStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseAnthropicToolCalls.mockReturnValue([]);
    mockParseToolCalls.mockReturnValue([]);
  });

  it('returns text content from text blocks', async () => {
    const lines = [
      sseData({ type: 'content_block_start', content_block: { type: 'text' } }),
      sseData({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } }),
      sseData({ type: 'content_block_stop' }),
    ];
    const result = await handleAnthropicAgentStream(makeSSEStream(lines), vi.fn(), 'claude-3', 'anthropic');
    expect(result.content).toBe('Hello world');
    expect(result.usedNativeTools).toBe(true);
  });

  it('calls onChunk for each text delta', async () => {
    const onChunk = vi.fn();
    const lines = [
      sseData({ type: 'content_block_start', content_block: { type: 'text' } }),
      sseData({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } }),
      sseData({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } }),
    ];
    await handleAnthropicAgentStream(makeSSEStream(lines), onChunk, 'claude-3', 'anthropic');
    expect(onChunk).toHaveBeenCalledWith('Hi ');
    expect(onChunk).toHaveBeenCalledWith('there');
  });

  it('accumulates tool use block input deltas', async () => {
    const mockToolCall = { tool: 'read_file', parameters: { path: 'src/index.ts' } };
    mockParseAnthropicToolCalls.mockReturnValue([mockToolCall]);

    const lines = [
      sseData({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } }),
      sseData({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"src/' } }),
      sseData({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'index.ts"}' } }),
      sseData({ type: 'content_block_stop' }),
    ];
    const result = await handleAnthropicAgentStream(makeSSEStream(lines), vi.fn(), 'claude-3', 'anthropic');
    expect(result.toolCalls).toEqual([mockToolCall]);
  });

  it('records token usage from message_delta', async () => {
    mockExtractAnthropicUsage.mockReturnValue({ inputTokens: 20, outputTokens: 10 });
    const lines = [
      sseData({ type: 'message_delta', usage: { output_tokens: 10 } }),
    ];
    await handleAnthropicAgentStream(makeSSEStream(lines), vi.fn(), 'claude-3', 'anthropic');
    expect(mockRecordTokenUsage).toHaveBeenCalled();
  });

  it('returns empty content with no tool calls for empty stream', async () => {
    const result = await handleAnthropicAgentStream(makeSSEStream([]), vi.fn(), 'claude-3', 'anthropic');
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([]);
  });
});
