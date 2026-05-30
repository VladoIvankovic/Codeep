import { describe, it, expect } from 'vitest';
import {
  parseOllamaChatLine,
  foldOllamaDelta,
  splitOllamaLines,
  initialOllamaAccumulator,
  extractContextLength,
  extractOllamaToolCalls,
} from './ollamaNative';

describe('parseOllamaChatLine', () => {
  it('extracts content from a streaming line', () => {
    const d = parseOllamaChatLine('{"message":{"role":"assistant","content":"Hel"},"done":false}');
    expect(d).toEqual({ content: 'Hel', done: false });
  });

  it('reads usage + done from the terminating line', () => {
    const d = parseOllamaChatLine('{"message":{"content":""},"done":true,"prompt_eval_count":42,"eval_count":7}');
    expect(d).toEqual({ content: '', done: true, promptTokens: 42, completionTokens: 7 });
  });

  it('returns null for blank lines', () => {
    expect(parseOllamaChatLine('')).toBeNull();
    expect(parseOllamaChatLine('   ')).toBeNull();
  });

  it('returns null (never throws) for non-JSON keepalive', () => {
    expect(parseOllamaChatLine('not json')).toBeNull();
  });

  it('tolerates a missing message field', () => {
    expect(parseOllamaChatLine('{"done":false}')).toEqual({ content: '', done: false });
  });
});

describe('foldOllamaDelta', () => {
  it('concatenates content across deltas and carries usage', () => {
    let acc = initialOllamaAccumulator();
    acc = foldOllamaDelta(acc, parseOllamaChatLine('{"message":{"content":"Hel"},"done":false}'));
    acc = foldOllamaDelta(acc, parseOllamaChatLine('{"message":{"content":"lo"},"done":false}'));
    acc = foldOllamaDelta(acc, parseOllamaChatLine('{"message":{"content":""},"done":true,"prompt_eval_count":10,"eval_count":3}'));
    expect(acc.text).toBe('Hello');
    expect(acc.done).toBe(true);
    expect(acc.promptTokens).toBe(10);
    expect(acc.completionTokens).toBe(3);
  });

  it('ignores null deltas (blank/keepalive lines)', () => {
    let acc = initialOllamaAccumulator();
    acc = foldOllamaDelta(acc, parseOllamaChatLine('{"message":{"content":"a"},"done":false}'));
    acc = foldOllamaDelta(acc, null);
    expect(acc.text).toBe('a');
  });
});

describe('splitOllamaLines', () => {
  it('splits complete lines and keeps the partial tail as rest', () => {
    const { lines, rest } = splitOllamaLines('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it('returns empty rest when buffer ends on a newline', () => {
    const { lines, rest } = splitOllamaLines('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
    expect(rest).toBe('');
  });

  it('reassembles a line split across chunk boundaries', () => {
    // Simulate two network chunks where a line is cut mid-way.
    let buf = '';
    const seen: string[] = [];
    for (const chunk of ['{"message":{"con', 'tent":"hi"},"done":false}\n']) {
      buf += chunk;
      const { lines, rest } = splitOllamaLines(buf);
      buf = rest;
      for (const l of lines) {
        const d = parseOllamaChatLine(l);
        if (d) seen.push(d.content);
      }
    }
    expect(seen).toEqual(['hi']);
  });
});

describe('extractContextLength', () => {
  it('finds an architecture-prefixed context_length key', () => {
    expect(extractContextLength({ model_info: { 'qwen2.context_length': 32768, 'qwen2.block_count': 28 } })).toBe(32768);
    expect(extractContextLength({ model_info: { 'llama.context_length': 131072 } })).toBe(131072);
  });

  it('finds a bare context_length key', () => {
    expect(extractContextLength({ model_info: { context_length: 8192 } })).toBe(8192);
  });

  it('returns null when absent or malformed', () => {
    expect(extractContextLength({ model_info: { 'llama.block_count': 32 } })).toBeNull();
    expect(extractContextLength({})).toBeNull();
    expect(extractContextLength(null)).toBeNull();
    expect(extractContextLength({ model_info: { 'llama.context_length': 0 } })).toBeNull();
  });
});

describe('extractOllamaToolCalls', () => {
  it('normalizes a native tool call (object arguments)', () => {
    const msg = { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] };
    expect(extractOllamaToolCalls(msg)).toEqual([{ name: 'read_file', arguments: { path: 'a.ts' } }]);
  });

  it('parses string-JSON arguments (some Ollama versions stringify)', () => {
    const msg = { tool_calls: [{ function: { name: 'edit_file', arguments: '{"path":"b.ts"}' } }] };
    expect(extractOllamaToolCalls(msg)).toEqual([{ name: 'edit_file', arguments: { path: 'b.ts' } }]);
  });

  it('returns undefined when there are no tool calls', () => {
    expect(extractOllamaToolCalls({ content: 'hi' })).toBeUndefined();
    expect(extractOllamaToolCalls({ tool_calls: [] })).toBeUndefined();
    expect(extractOllamaToolCalls(null)).toBeUndefined();
  });

  it('skips malformed entries (missing name) without throwing', () => {
    const msg = { tool_calls: [{ function: { arguments: {} } }, { function: { name: 'ok', arguments: {} } }] };
    expect(extractOllamaToolCalls(msg)).toEqual([{ name: 'ok', arguments: {} }]);
  });

  it('defaults to empty args when arguments are unparseable', () => {
    const msg = { tool_calls: [{ function: { name: 'run', arguments: 'not json' } }] };
    expect(extractOllamaToolCalls(msg)).toEqual([{ name: 'run', arguments: {} }]);
  });
});

describe('parseOllamaChatLine + fold — tool calls', () => {
  it('surfaces tool calls from a line and folds them into the accumulator', () => {
    const line = '{"message":{"content":"","tool_calls":[{"function":{"name":"list_files","arguments":{"dir":"."}}}]},"done":false}';
    const delta = parseOllamaChatLine(line);
    expect(delta?.toolCalls).toEqual([{ name: 'list_files', arguments: { dir: '.' } }]);
    let acc = initialOllamaAccumulator();
    acc = foldOllamaDelta(acc, delta);
    expect(acc.toolCalls).toEqual([{ name: 'list_files', arguments: { dir: '.' } }]);
  });

  it('accumulator starts with an empty toolCalls array', () => {
    expect(initialOllamaAccumulator().toolCalls).toEqual([]);
  });
});
