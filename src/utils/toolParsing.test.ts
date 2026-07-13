import { describe, it, expect } from 'vitest';
import {
  normalizeToolName,
  parseOpenAIToolCalls,
  parseAnthropicToolCalls,
  parseToolCalls,
  _extractPartialToolParamsForTest,
  _tryExtractParamsForTest,
  _tryParseToolCallForTest,
} from './toolParsing';

describe('normalizeToolName', () => {
  it('maps camelCase tool names to snake_case', () => {
    expect(normalizeToolName('executeCommand')).toBe('execute_command');
    expect(normalizeToolName('readFile')).toBe('read_file');
    expect(normalizeToolName('writeFile')).toBe('write_file');
    expect(normalizeToolName('editFile')).toBe('edit_file');
    expect(normalizeToolName('searchCode')).toBe('search_code');
    expect(normalizeToolName('createDirectory')).toBe('create_directory');
    expect(normalizeToolName('fetchUrl')).toBe('fetch_url');
  });

  it('passes already-normalised names through unchanged', () => {
    expect(normalizeToolName('execute_command')).toBe('execute_command');
    expect(normalizeToolName('read_file')).toBe('read_file');
  });

  it('lowercases and converts hyphens to underscores', () => {
    expect(normalizeToolName('Read-File')).toBe('read_file');
    expect(normalizeToolName('EXECUTE-COMMAND')).toBe('execute_command');
  });

  it('passes unknown names through (lowercased, hyphens→underscores)', () => {
    expect(normalizeToolName('Mcp__Foo')).toBe('mcp__foo');
    expect(normalizeToolName('custom-tool')).toBe('custom_tool');
  });

  it('handles an empty string', () => {
    expect(normalizeToolName('')).toBe('');
  });
});

describe('parseOpenAIToolCalls', () => {
  it('returns an empty list for falsy / non-array input', () => {
    expect(parseOpenAIToolCalls([])).toEqual([]);
    expect(parseOpenAIToolCalls(null as unknown as [])).toEqual([]);
    expect(parseOpenAIToolCalls(undefined as unknown as [])).toEqual([]);
  });

  it('parses a well-formed function call', () => {
    const out = parseOpenAIToolCalls([
      {
        id: 'call_1',
        function: {
          name: 'read_file',
          arguments: '{"path": "/tmp/foo.ts"}',
        },
      },
    ]);
    expect(out).toEqual([
      { tool: 'read_file', parameters: { path: '/tmp/foo.ts' }, id: 'call_1' },
    ]);
  });

  it('normalises the tool name (camelCase → snake_case)', () => {
    const out = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'readFile', arguments: '{"path": "x"}' } },
    ]);
    expect(out[0].tool).toBe('read_file');
  });

  it('skips entries with an empty tool name', () => {
    const out = parseOpenAIToolCalls([
      { id: 'a', function: { name: '', arguments: '{}' } },
    ]);
    expect(out).toEqual([]);
  });

  it('skips write_file calls missing path even when JSON parses', () => {
    const out = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'write_file', arguments: '{"content": "x"}' } },
    ]);
    expect(out).toEqual([]);
  });

  it('skips read_file calls missing path', () => {
    const out = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'read_file', arguments: '{}' } },
    ]);
    expect(out).toEqual([]);
  });

  it('skips edit_file calls missing any of path/old_text/new_text', () => {
    const out = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'edit_file', arguments: '{"path": "x", "old_text": "a"}' } },
    ]);
    expect(out).toEqual([]);
  });

  it('recovers truncated write_file args via the partial-extractor', () => {
    // Truncated JSON — the closing brace and quote are missing.
    const raw = '{"path": "src/x.ts", "content": "export const y = 1';
    const out = parseOpenAIToolCalls([
      { id: 'a', function: { name: 'write_file', arguments: raw } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].parameters.path).toBe('src/x.ts');
    expect(out[0].parameters.content).toContain('export const y = 1');
    expect(out[0].parameters.content).toContain('truncated');
  });
});

describe('parseAnthropicToolCalls', () => {
  it('returns an empty list for non-array input', () => {
    expect(parseAnthropicToolCalls([])).toEqual([]);
    expect(parseAnthropicToolCalls(null as unknown as [])).toEqual([]);
  });

  it('keeps only tool_use blocks', () => {
    const out = parseAnthropicToolCalls([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', name: 'read_file', input: { path: '/a' }, id: 't1' },
      { type: 'text', text: 'bye' },
    ]);
    expect(out).toEqual([
      { tool: 'read_file', parameters: { path: '/a' }, id: 't1' },
    ]);
  });

  it('normalises the tool name', () => {
    const out = parseAnthropicToolCalls([
      { type: 'tool_use', name: 'WriteFile', input: {}, id: 'x' },
    ]);
    expect(out[0].tool).toBe('write_file');
  });

  it('drops entries with an empty name after normalisation', () => {
    const out = parseAnthropicToolCalls([
      { type: 'tool_use', name: '', input: {}, id: 'x' },
    ]);
    expect(out).toEqual([]);
  });
});

describe('extractPartialToolParams (private helper via test seam)', () => {
  it('extracts write_file path + content and flags truncation', () => {
    const out = _extractPartialToolParamsForTest(
      'write_file',
      '{"path": "a.ts", "content": "x"',
    );
    expect(out).not.toBeNull();
    expect(out!.path).toBe('a.ts');
    expect(out!.content).toContain('truncated');
  });

  it('returns a placeholder content when only path is recoverable', () => {
    const out = _extractPartialToolParamsForTest('write_file', '{"path": "a.ts"');
    expect(out).toEqual({ path: 'a.ts', content: expect.stringContaining('truncated') });
  });

  it('extracts read_file / list_files / create_directory paths', () => {
    for (const tool of ['read_file', 'list_files', 'create_directory']) {
      expect(_extractPartialToolParamsForTest(tool, '{"path": "/x"}')).toEqual({ path: '/x' });
    }
  });

  it('extracts edit_file path / old_text / new_text', () => {
    const out = _extractPartialToolParamsForTest(
      'edit_file',
      '{"path": "a", "old_text": "x", "new_text": "y"}',
    );
    expect(out).toEqual({ path: 'a', old_text: 'x', new_text: 'y' });
  });

  it('extracts execute_command + args', () => {
    const out = _extractPartialToolParamsForTest(
      'execute_command',
      '{"command": "ls", "args": ["-l", "-a"]}',
    );
    expect(out).toEqual({ command: 'ls', args: ['-l', '-a'] });
  });

  it('returns null for an unknown tool', () => {
    expect(_extractPartialToolParamsForTest('unknown', '{"x": 1}')).toBeNull();
  });
});

describe('tryExtractParams (private helper via test seam)', () => {
  it('extracts a known set of fields from a JSON-shaped fragment', () => {
    const out = _tryExtractParamsForTest(
      '{"command": "ls", "args": ["-l"], "path": "/x", "pattern": "foo", "recursive": true}',
    );
    expect(out).toEqual({
      command: 'ls',
      args: ['-l'],
      path: '/x',
      pattern: 'foo',
      recursive: true,
    });
  });

  it('returns null when nothing matches', () => {
    expect(_tryExtractParamsForTest('just some text')).toBeNull();
  });

  it('parses recursive as a boolean', () => {
    expect(_tryExtractParamsForTest('{"recursive": false}')!.recursive).toBe(false);
    expect(_tryExtractParamsForTest('{"recursive": true}')!.recursive).toBe(true);
  });
});

describe('tryParseToolCall (private helper via test seam)', () => {
  it('parses a clean JSON tool call', () => {
    const out = _tryParseToolCallForTest(
      '{"tool": "read_file", "parameters": {"path": "/a"}}',
    );
    expect(out).toEqual({ tool: 'read_file', parameters: { path: '/a' } });
  });

  it('tolerates trailing commas', () => {
    const out = _tryParseToolCallForTest(
      '{"tool": "read_file", "parameters": {"path": "/a",},}',
    );
    expect(out).not.toBeNull();
    expect(out!.tool).toBe('read_file');
  });

  it('returns null for a non-JSON string', () => {
    expect(_tryParseToolCallForTest('hello world')).toBeNull();
  });
});

describe('parseToolCalls (full pipeline)', () => {
  it('returns an empty list for a response with no tool calls', () => {
    expect(parseToolCalls('just a plain message')).toEqual([]);
  });

  it('extracts a fenced ```tool_code block', () => {
    const response = 'Here:\n```tool_code\n{"tool": "read_file", "parameters": {"path": "/x"}}\n```\ndone';
    const out = parseToolCalls(response);
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe('read_file');
    expect(out[0].parameters).toEqual({ path: '/x' });
  });
});
