import { describe, it, expect } from 'vitest';
import {
  getOpenAITools,
  getAnthropicTools,
  parseToolCalls,
  parseOpenAIToolCalls,
  parseAnthropicToolCalls,
  createActionLog,
  AGENT_TOOLS,
  OpenAITool,
  AnthropicTool,
  ToolCall,
  ToolResult,
} from './tools';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const ALL_TOOL_NAMES = Object.keys(AGENT_TOOLS);

// MCP tools are filtered out when no API key is configured (e.g. in tests)
const ZAI_MCP_TOOLS = ['web_search', 'web_read', 'github_read'];
const MINIMAX_MCP_TOOLS = ['minimax_web_search'];
const MCP_TOOLS = [...ZAI_MCP_TOOLS, ...MINIMAX_MCP_TOOLS];
const CORE_TOOL_NAMES = ALL_TOOL_NAMES.filter(n => !MCP_TOOLS.includes(n));

// ─── getOpenAITools ──────────────────────────────────────────────────────────

describe('getOpenAITools', () => {
  it('should return one entry per AGENT_TOOLS definition', () => {
    const tools = getOpenAITools();
    // MCP tools are excluded when no Z.AI API key is configured
    expect(tools).toHaveLength(CORE_TOOL_NAMES.length);
  });

  it('should wrap every tool in the OpenAI function-calling envelope', () => {
    const tools = getOpenAITools();
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function).toBeDefined();
      expect(typeof tool.function.name).toBe('string');
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.properties).toBeDefined();
      expect(Array.isArray(tool.function.parameters.required)).toBe(true);
    }
  });

  it('should include all core tool names from AGENT_TOOLS', () => {
    const tools = getOpenAITools();
    const names = tools.map(t => t.function.name);
    for (const name of CORE_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('should mark required parameters correctly for read_file', () => {
    const tools = getOpenAITools();
    const readFile = tools.find(t => t.function.name === 'read_file')!;
    expect(readFile.function.parameters.required).toEqual(['path']);
    expect(readFile.function.parameters.properties.path.type).toBe('string');
  });

  it('should mark required parameters correctly for write_file', () => {
    const tools = getOpenAITools();
    const writeFile = tools.find(t => t.function.name === 'write_file')!;
    expect(writeFile.function.parameters.required).toContain('path');
    expect(writeFile.function.parameters.required).toContain('content');
  });

  it('should mark required parameters correctly for edit_file', () => {
    const tools = getOpenAITools();
    const editFile = tools.find(t => t.function.name === 'edit_file')!;
    expect(editFile.function.parameters.required).toContain('path');
    expect(editFile.function.parameters.required).toContain('old_text');
    expect(editFile.function.parameters.required).toContain('new_text');
  });

  it('should distinguish required from optional parameters for list_files', () => {
    const tools = getOpenAITools();
    const listFiles = tools.find(t => t.function.name === 'list_files')!;
    expect(listFiles.function.parameters.required).toContain('path');
    expect(listFiles.function.parameters.required).not.toContain('recursive');
    expect(listFiles.function.parameters.properties.recursive).toBeDefined();
  });

  it('should represent array-typed parameters with items', () => {
    const tools = getOpenAITools();
    const execCmd = tools.find(t => t.function.name === 'execute_command')!;
    const argsParam = execCmd.function.parameters.properties.args;
    expect(argsParam.type).toBe('array');
    expect(argsParam.items).toEqual({ type: 'string' });
  });

  it('should not include optional parameters in required array for execute_command', () => {
    const tools = getOpenAITools();
    const execCmd = tools.find(t => t.function.name === 'execute_command')!;
    expect(execCmd.function.parameters.required).toContain('command');
    expect(execCmd.function.parameters.required).not.toContain('args');
  });
});

// ─── getAnthropicTools ───────────────────────────────────────────────────────

describe('getAnthropicTools', () => {
  it('should return one entry per AGENT_TOOLS definition', () => {
    const tools = getAnthropicTools();
    // MCP tools are excluded when no Z.AI API key is configured
    expect(tools).toHaveLength(CORE_TOOL_NAMES.length);
  });

  it('should use Anthropic tool-use shape (name, description, input_schema)', () => {
    const tools = getAnthropicTools();
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
    }
  });

  it('should include all core tool names from AGENT_TOOLS', () => {
    const tools = getAnthropicTools();
    const names = tools.map(t => t.name);
    for (const name of CORE_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('should have same required params as OpenAI format', () => {
    const openai = getOpenAITools();
    const anthropic = getAnthropicTools();

    for (const name of CORE_TOOL_NAMES) {
      const oTool = openai.find(t => t.function.name === name)!;
      const aTool = anthropic.find(t => t.name === name)!;
      expect(aTool.input_schema.required).toEqual(oTool.function.parameters.required);
    }
  });

  it('should represent array parameters with items for execute_command', () => {
    const tools = getAnthropicTools();
    const execCmd = tools.find(t => t.name === 'execute_command')!;
    const argsParam = execCmd.input_schema.properties.args;
    expect(argsParam.type).toBe('array');
    expect(argsParam.items).toEqual({ type: 'string' });
  });

  it('should not wrap tools in a function envelope (unlike OpenAI)', () => {
    const tools = getAnthropicTools();
    for (const tool of tools) {
      expect((tool as any).type).toBeUndefined();
      expect((tool as any).function).toBeUndefined();
    }
  });
});

// ─── parseToolCalls ──────────────────────────────────────────────────────────

describe('parseToolCalls', () => {
  it('should return empty array for response with no tool calls', () => {
    expect(parseToolCalls('No tools here, just some text.')).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    expect(parseToolCalls('')).toEqual([]);
  });

  // ── XML <tool_call> format ──

  it('should parse <tool_call> XML tags with valid JSON', () => {
    const response = `
      Let me read the file.
      <tool_call>{"tool": "read_file", "parameters": {"path": "src/index.ts"}}</tool_call>
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
    expect(calls[0].parameters).toEqual({ path: 'src/index.ts' });
  });

  it('should parse <toolcall> XML tags (no underscore)', () => {
    const response = `
      <toolcall>{"tool": "read_file", "parameters": {"path": "README.md"}}</toolcall>
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
  });

  it('should parse multiple <tool_call> tags', () => {
    const response = `
      <tool_call>{"tool": "read_file", "parameters": {"path": "a.ts"}}</tool_call>
      <tool_call>{"tool": "read_file", "parameters": {"path": "b.ts"}}</tool_call>
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(2);
  });

  it('should normalize tool names in XML format', () => {
    const response = `
      <tool_call>{"tool": "readFile", "parameters": {"path": "a.ts"}}</tool_call>
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
  });

  // ── Code block format ──

  it('should parse ```tool code blocks', () => {
    const response = [
      'I will read the file.',
      '```tool',
      '{"tool": "read_file", "parameters": {"path": "package.json"}}',
      '```',
    ].join('\n');
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
    expect(calls[0].parameters).toEqual({ path: 'package.json' });
  });

  it('should parse ```json code blocks with tool property', () => {
    const response = [
      '```json',
      '{"tool": "list_files", "parameters": {"path": ".", "recursive": true}}',
      '```',
    ].join('\n');
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('list_files');
    expect(calls[0].parameters).toEqual({ path: '.', recursive: true });
  });

  it('should ignore code blocks that do not contain tool JSON', () => {
    const response = [
      '```json',
      '{"name": "my-project", "version": "1.0.0"}',
      '```',
    ].join('\n');
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(0);
  });

  // ── Deduplication ──

  it('should deduplicate identical tool calls from different formats', () => {
    // A tool call that could match both XML and code block parsers
    const response = [
      '<tool_call>{"tool": "read_file", "parameters": {"path": "dup.ts"}}</tool_call>',
      '```tool',
      '{"tool": "read_file", "parameters": {"path": "dup.ts"}}',
      '```',
    ].join('\n');
    const calls = parseToolCalls(response);
    // The XML match is found first; code block dedup should prevent the second
    const readDupCalls = calls.filter(
      c => c.tool === 'read_file' && (c.parameters as any).path === 'dup.ts'
    );
    expect(readDupCalls).toHaveLength(1);
  });

  // ── Malformed JSON handling ──

  it('should handle trailing commas in JSON', () => {
    const response = `
      <tool_call>{"tool": "read_file", "parameters": {"path": "test.ts",}}</tool_call>
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
  });

  it('should extract tool info from partially malformed JSON', () => {
    // tryParseToolCall's fallback: extracts "tool" and string params manually
    const response = `
      <tool_call>{"tool": "search_code", "parameters: {"pattern": "TODO"}}</tool_call>
    `;
    const calls = parseToolCalls(response);
    // Even with malformed JSON, the fallback extractor should find tool + pattern
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('search_code');
  });

  // ── Inline JSON fallback ──

  it('should use inline JSON fallback when no other format matches', () => {
    const response = `
      Here is my action: {"tool": "read_file", "parameters": {"path": "hello.ts"}}
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
    expect(calls[0].parameters).toEqual({ path: 'hello.ts' });
  });

  // ── Malformed <toolcall>toolname{...} format ──

  it('should parse malformed <toolcall>toolname{...} format', () => {
    const response = `
      <toolcall>readfile{"path": "src/main.ts"}</toolcall>
    `;
    const calls = parseToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('read_file');
    expect(calls[0].parameters).toEqual({ path: 'src/main.ts' });
  });

  it('should parse <toolcall>executecommand with parameters key', () => {
    const response = `
      <toolcall>executecommand, "parameters": {"command": "npm", "args": ["test"]}</toolcall>
    `;
    const calls = parseToolCalls(response);
    const execCalls = calls.filter(c => c.tool === 'execute_command');
    expect(execCalls.length).toBeGreaterThanOrEqual(1);
    expect(execCalls[0].parameters).toHaveProperty('command', 'npm');
  });
});

// ─── parseOpenAIToolCalls ────────────────────────────────────────────────────

describe('parseOpenAIToolCalls', () => {
  it('should return empty array for null input', () => {
    expect(parseOpenAIToolCalls(null as any)).toEqual([]);
  });

  it('should return empty array for undefined input', () => {
    expect(parseOpenAIToolCalls(undefined as any)).toEqual([]);
  });

  it('should return empty array for empty array', () => {
    expect(parseOpenAIToolCalls([])).toEqual([]);
  });

  it('should parse a single valid tool call', () => {
    const toolCalls = [
      {
        id: 'call_1',
        function: {
          name: 'read_file',
          arguments: '{"path": "src/index.ts"}',
        },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('read_file');
    expect(result[0].parameters).toEqual({ path: 'src/index.ts' });
    expect(result[0].id).toBe('call_1');
  });

  it('should parse multiple tool calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        function: { name: 'read_file', arguments: '{"path": "a.ts"}' },
      },
      {
        id: 'call_2',
        function: { name: 'write_file', arguments: '{"path": "b.ts", "content": "hello"}' },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0].tool).toBe('read_file');
    expect(result[1].tool).toBe('write_file');
    expect(result[1].parameters).toEqual({ path: 'b.ts', content: 'hello' });
  });

  // ── Name normalization ──

  it('should normalize camelCase tool names to snake_case', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'readFile', arguments: '{"path": "x.ts"}' } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result[0].tool).toBe('read_file');
  });

  it('should normalize executecommand (no separator) to execute_command', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'executecommand', arguments: '{"command": "ls"}' } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result[0].tool).toBe('execute_command');
  });

  it('should normalize names with hyphens to underscores', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'read-file', arguments: '{"path": "a.ts"}' } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result[0].tool).toBe('read_file');
  });

  it('should normalize all known tool name variants', () => {
    // Each variant needs arguments that pass its specific validation checks
    const variants: [string, string, string][] = [
      ['readfile', 'read_file', '{"path": "."}'],
      ['writefile', 'write_file', '{"path": "a.ts", "content": "x"}'],
      ['editfile', 'edit_file', '{"path": "a.ts", "old_text": "a", "new_text": "b"}'],
      ['deletefile', 'delete_file', '{"path": "."}'],
      ['listfiles', 'list_files', '{"path": "."}'],
      ['searchcode', 'search_code', '{"pattern": "x"}'],
      ['createdirectory', 'create_directory', '{"path": "dir"}'],
      ['findfiles', 'find_files', '{"pattern": "*.ts"}'],
      ['fetchurl', 'fetch_url', '{"url": "https://example.com"}'],
    ];
    for (const [input, expected, args] of variants) {
      const result = parseOpenAIToolCalls([
        { id: 'x', function: { name: input, arguments: args } },
      ]);
      expect(result[0].tool).toBe(expected);
    }
  });

  // ── Validation: skip calls missing required params ──

  it('should skip read_file calls without a path', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'read_file', arguments: '{}' } },
    ];
    expect(parseOpenAIToolCalls(toolCalls)).toHaveLength(0);
  });

  it('should skip write_file calls without a path', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'write_file', arguments: '{"content": "hello"}' } },
    ];
    expect(parseOpenAIToolCalls(toolCalls)).toHaveLength(0);
  });

  it('should skip edit_file calls missing old_text or new_text', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'edit_file', arguments: '{"path": "a.ts"}' } },
    ];
    expect(parseOpenAIToolCalls(toolCalls)).toHaveLength(0);
  });

  it('should allow edit_file with empty string old_text and new_text', () => {
    const toolCalls = [
      {
        id: 'c1',
        function: {
          name: 'edit_file',
          arguments: '{"path": "a.ts", "old_text": "", "new_text": "new"}',
        },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].parameters).toEqual({ path: 'a.ts', old_text: '', new_text: 'new' });
  });

  // ── Malformed JSON arguments ──

  it('should skip calls with completely unparseable arguments and no extractable params', () => {
    const toolCalls = [
      { id: 'c1', function: { name: 'search_code', arguments: 'not json at all' } },
    ];
    // search_code doesn't have a partial extraction path, so it should be skipped
    expect(parseOpenAIToolCalls(toolCalls)).toHaveLength(0);
  });

  it('should skip entries with empty function name', () => {
    const toolCalls = [
      { id: 'c1', function: { name: '', arguments: '{"path": "a.ts"}' } },
    ];
    expect(parseOpenAIToolCalls(toolCalls)).toHaveLength(0);
  });

  it('should handle missing function property gracefully', () => {
    const toolCalls = [{ id: 'c1' }];
    // normalizeToolName('') returns '', which is falsy, so it gets skipped
    expect(parseOpenAIToolCalls(toolCalls as any)).toHaveLength(0);
  });

  it('should attempt partial extraction for truncated write_file JSON', () => {
    // Simulate a truncated response where JSON.parse fails
    const truncatedArgs = '{"path": "src/app.ts", "content": "const x = 1;\\nconst y = 2;';
    const toolCalls = [
      { id: 'c1', function: { name: 'write_file', arguments: truncatedArgs } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('write_file');
    expect(result[0].parameters).toHaveProperty('path', 'src/app.ts');
    // Content should be extracted even if truncated
    expect(result[0].parameters).toHaveProperty('content');
  });

  it('should attempt partial extraction for truncated read_file JSON', () => {
    const truncatedArgs = '{"path": "src/utils.ts"';
    const toolCalls = [
      { id: 'c1', function: { name: 'read_file', arguments: truncatedArgs } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('read_file');
    expect(result[0].parameters).toEqual({ path: 'src/utils.ts' });
  });

  it('should attempt partial extraction for truncated execute_command JSON', () => {
    const truncatedArgs = '{"command": "npm", "args": ["install", "lodash"]}extra';
    // This will fail JSON.parse because of trailing chars, but extractPartialToolParams handles it
    const toolCalls = [
      { id: 'c1', function: { name: 'execute_command', arguments: truncatedArgs } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    // It should extract command and args from the partial
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('execute_command');
    expect(result[0].parameters).toHaveProperty('command', 'npm');
  });
});

// ─── parseAnthropicToolCalls ─────────────────────────────────────────────────

describe('parseAnthropicToolCalls', () => {
  it('should return empty array for null input', () => {
    expect(parseAnthropicToolCalls(null as any)).toEqual([]);
  });

  it('should return empty array for undefined input', () => {
    expect(parseAnthropicToolCalls(undefined as any)).toEqual([]);
  });

  it('should return empty array for empty array', () => {
    expect(parseAnthropicToolCalls([])).toEqual([]);
  });

  it('should parse a single tool_use block', () => {
    const content = [
      {
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'read_file',
        input: { path: 'src/index.ts' },
      },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('read_file');
    expect(result[0].parameters).toEqual({ path: 'src/index.ts' });
    expect(result[0].id).toBe('toolu_abc');
  });

  it('should parse multiple tool_use blocks', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'toolu_2', name: 'list_files', input: { path: '.' } },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result).toHaveLength(2);
    expect(result[0].tool).toBe('read_file');
    expect(result[1].tool).toBe('list_files');
  });

  it('should filter out non-tool_use blocks', () => {
    const content = [
      { type: 'text', text: 'Let me read the file.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'text', text: 'Done.' },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('read_file');
  });

  it('should handle content with only text blocks', () => {
    const content = [
      { type: 'text', text: 'I cannot do that.' },
    ];
    expect(parseAnthropicToolCalls(content)).toEqual([]);
  });

  it('should normalize tool names', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', name: 'readFile', input: { path: 'a.ts' } },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result[0].tool).toBe('read_file');
  });

  it('should use empty object for missing input', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', name: 'list_files' },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result).toHaveLength(1);
    expect(result[0].parameters).toEqual({});
  });

  it('should skip blocks with empty name after normalization', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', name: '', input: {} },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result).toHaveLength(0);
  });

  it('should skip blocks with no name property', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', input: { path: 'a.ts' } },
    ];
    const result = parseAnthropicToolCalls(content);
    expect(result).toHaveLength(0);
  });
});

// ─── createActionLog ─────────────────────────────────────────────────────────

describe('createActionLog', () => {
  // Helper to build a minimal ToolResult
  function makeResult(overrides: Partial<ToolResult> = {}): ToolResult {
    return {
      success: true,
      output: 'OK',
      tool: 'read_file',
      parameters: {},
      ...overrides,
    };
  }

  // ── Type mapping ──

  it('should map read_file to type "read"', () => {
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'a.ts' } };
    const log = createActionLog(tc, makeResult());
    expect(log.type).toBe('read');
  });

  it('should map write_file to type "write"', () => {
    const tc: ToolCall = { tool: 'write_file', parameters: { path: 'b.ts', content: 'x' } };
    const log = createActionLog(tc, makeResult({ tool: 'write_file' }));
    expect(log.type).toBe('write');
  });

  it('should map edit_file to type "edit"', () => {
    const tc: ToolCall = { tool: 'edit_file', parameters: { path: 'c.ts', old_text: 'a', new_text: 'b' } };
    const log = createActionLog(tc, makeResult({ tool: 'edit_file' }));
    expect(log.type).toBe('edit');
  });

  it('should map delete_file to type "delete"', () => {
    const tc: ToolCall = { tool: 'delete_file', parameters: { path: 'd.ts' } };
    const log = createActionLog(tc, makeResult({ tool: 'delete_file' }));
    expect(log.type).toBe('delete');
  });

  it('should map execute_command to type "command"', () => {
    const tc: ToolCall = { tool: 'execute_command', parameters: { command: 'npm test' } };
    const log = createActionLog(tc, makeResult({ tool: 'execute_command' }));
    expect(log.type).toBe('command');
  });

  it('should map search_code to type "search"', () => {
    const tc: ToolCall = { tool: 'search_code', parameters: { pattern: 'TODO' } };
    const log = createActionLog(tc, makeResult({ tool: 'search_code' }));
    expect(log.type).toBe('search');
  });

  it('should map list_files to type "list"', () => {
    const tc: ToolCall = { tool: 'list_files', parameters: { path: '.' } };
    const log = createActionLog(tc, makeResult({ tool: 'list_files' }));
    expect(log.type).toBe('list');
  });

  it('should map create_directory to type "mkdir"', () => {
    const tc: ToolCall = { tool: 'create_directory', parameters: { path: 'new-dir' } };
    const log = createActionLog(tc, makeResult({ tool: 'create_directory' }));
    expect(log.type).toBe('mkdir');
  });

  it('should map find_files to type "search"', () => {
    const tc: ToolCall = { tool: 'find_files', parameters: { pattern: '*.ts' } };
    const log = createActionLog(tc, makeResult({ tool: 'find_files' }));
    expect(log.type).toBe('search');
  });

  it('should map fetch_url to type "fetch"', () => {
    const tc: ToolCall = { tool: 'fetch_url', parameters: { url: 'https://example.com' } };
    const log = createActionLog(tc, makeResult({ tool: 'fetch_url' }));
    expect(log.type).toBe('fetch');
  });

  it('should map minimax_web_search to type "fetch"', () => {
    const tc: ToolCall = { tool: 'minimax_web_search', parameters: { query: 'test' } };
    const log = createActionLog(tc, makeResult({ tool: 'minimax_web_search' }));
    expect(log.type).toBe('fetch');
  });

  it('should default to type "command" for unknown tools', () => {
    const tc: ToolCall = { tool: 'unknown_tool', parameters: {} };
    const log = createActionLog(tc, makeResult({ tool: 'unknown_tool' }));
    expect(log.type).toBe('command');
  });

  it('should normalize tool name variants for type mapping', () => {
    const tc: ToolCall = { tool: 'readFile', parameters: { path: 'x.ts' } };
    const log = createActionLog(tc, makeResult());
    expect(log.type).toBe('read');
  });

  // ── Target extraction ──

  it('should extract path as target', () => {
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'src/index.ts' } };
    const log = createActionLog(tc, makeResult());
    expect(log.target).toBe('src/index.ts');
  });

  it('should extract command as target when no path', () => {
    const tc: ToolCall = { tool: 'execute_command', parameters: { command: 'npm test' } };
    const log = createActionLog(tc, makeResult({ tool: 'execute_command' }));
    expect(log.target).toBe('npm test');
  });

  it('should extract pattern as target when no path or command', () => {
    const tc: ToolCall = { tool: 'search_code', parameters: { pattern: 'TODO' } };
    const log = createActionLog(tc, makeResult({ tool: 'search_code' }));
    expect(log.target).toBe('TODO');
  });

  it('should extract url as target for fetch_url', () => {
    const tc: ToolCall = { tool: 'fetch_url', parameters: { url: 'https://docs.example.com' } };
    const log = createActionLog(tc, makeResult({ tool: 'fetch_url' }));
    expect(log.target).toBe('https://docs.example.com');
  });

  it('should use "unknown" when no recognized target parameter exists', () => {
    const tc: ToolCall = { tool: 'read_file', parameters: {} };
    const log = createActionLog(tc, makeResult());
    expect(log.target).toBe('unknown');
  });

  // ── Result status ──

  it('should set result to "success" for successful tool results', () => {
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'a.ts' } };
    const log = createActionLog(tc, makeResult({ success: true }));
    expect(log.result).toBe('success');
  });

  it('should set result to "error" for failed tool results', () => {
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'missing.ts' } };
    const log = createActionLog(tc, makeResult({ success: false, error: 'File not found' }));
    expect(log.result).toBe('error');
  });

  // ── Details / truncation ──

  it('should include full content in details for write_file on success', () => {
    const content = 'const x = 1;\nconst y = 2;\n';
    const tc: ToolCall = { tool: 'write_file', parameters: { path: 'a.ts', content } };
    const log = createActionLog(tc, makeResult({ tool: 'write_file' }));
    expect(log.details).toBe(content);
  });

  it('should include full new_text in details for edit_file on success', () => {
    const newText = 'const updated = true;';
    const tc: ToolCall = { tool: 'edit_file', parameters: { path: 'a.ts', old_text: 'old', new_text: newText } };
    const log = createActionLog(tc, makeResult({ tool: 'edit_file' }));
    expect(log.details).toBe(newText);
  });

  it('should truncate command output to 1000 chars for execute_command', () => {
    const longOutput = 'x'.repeat(2000);
    const tc: ToolCall = { tool: 'execute_command', parameters: { command: 'cat big.log' } };
    const log = createActionLog(tc, makeResult({ tool: 'execute_command', output: longOutput }));
    expect(log.details).toHaveLength(1000);
    expect(log.details).toBe(longOutput.slice(0, 1000));
  });

  it('should truncate general output to 500 chars for other tools', () => {
    const longOutput = 'y'.repeat(1000);
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'a.ts' } };
    const log = createActionLog(tc, makeResult({ output: longOutput }));
    expect(log.details).toHaveLength(500);
    expect(log.details).toBe(longOutput.slice(0, 500));
  });

  it('should use error message as details when result is failure', () => {
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'missing.ts' } };
    const log = createActionLog(tc, makeResult({ success: false, error: 'File not found: missing.ts' }));
    expect(log.details).toBe('File not found: missing.ts');
  });

  // ── Timestamp ──

  it('should include a timestamp close to now', () => {
    const before = Date.now();
    const tc: ToolCall = { tool: 'read_file', parameters: { path: 'a.ts' } };
    const log = createActionLog(tc, makeResult());
    const after = Date.now();
    expect(log.timestamp).toBeGreaterThanOrEqual(before);
    expect(log.timestamp).toBeLessThanOrEqual(after);
  });
});
