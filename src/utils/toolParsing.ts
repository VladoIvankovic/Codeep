/**
 * Tool call parsing from LLM responses.
 *
 * Handles OpenAI function-calling format, Anthropic tool_use format,
 * and legacy text-based tool call formats.
 */

import { ToolCall } from './tools';

const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    console.error('[DEBUG]', ...args);
  }
};

/**
 * Normalize tool name to lowercase with underscores
 */
export function normalizeToolName(name: string): string {
  const toolNameMap: Record<string, string> = {
    'executecommand': 'execute_command',
    'execute_command': 'execute_command',
    'readfile': 'read_file',
    'read_file': 'read_file',
    'writefile': 'write_file',
    'write_file': 'write_file',
    'editfile': 'edit_file',
    'edit_file': 'edit_file',
    'deletefile': 'delete_file',
    'delete_file': 'delete_file',
    'listfiles': 'list_files',
    'list_files': 'list_files',
    'searchcode': 'search_code',
    'search_code': 'search_code',
    'createdirectory': 'create_directory',
    'create_directory': 'create_directory',
    'findfiles': 'find_files',
    'find_files': 'find_files',
    'fetchurl': 'fetch_url',
    'fetch_url': 'fetch_url',
  };

  const lower = name.toLowerCase().replace(/-/g, '_');
  return toolNameMap[lower] || lower;
}

/**
 * Extract parameters from truncated/partial JSON for tool calls.
 * Fallback when JSON.parse fails due to API truncation.
 */
function extractPartialToolParams(toolName: string, rawArgs: string): Record<string, unknown> | null {
  try {
    if (toolName === 'write_file') {
      const pathMatch = rawArgs.match(/"path"\s*:\s*"([^"]+)"/);
      if (pathMatch) {
        const contentMatch = rawArgs.match(/"content"\s*:\s*"([\s\S]*?)(?:"|$)/);
        if (contentMatch) {
          let content = contentMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          if (!content.endsWith('\n') && !content.endsWith('}') && !content.endsWith(';') && !content.endsWith('>')) {
            content += '\n<!-- Content may be truncated -->\n';
          }
          return { path: pathMatch[1], content };
        }
        return { path: pathMatch[1], content: '<!-- Content was truncated by API -->\n' };
      }
    }

    if (toolName === 'read_file' || toolName === 'list_files' || toolName === 'create_directory') {
      const pathMatch = rawArgs.match(/"path"\s*:\s*"([^"]+)"/);
      if (pathMatch) return { path: pathMatch[1] };
    }

    if (toolName === 'edit_file') {
      const pathMatch = rawArgs.match(/"path"\s*:\s*"([^"]+)"/);
      const oldTextMatch = rawArgs.match(/"old_text"\s*:\s*"([\s\S]*?)(?:"|$)/);
      const newTextMatch = rawArgs.match(/"new_text"\s*:\s*"([\s\S]*?)(?:"|$)/);
      if (pathMatch && oldTextMatch && newTextMatch) {
        return {
          path: pathMatch[1],
          old_text: oldTextMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
          new_text: newTextMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
        };
      }
    }

    if (toolName === 'execute_command') {
      const commandMatch = rawArgs.match(/"command"\s*:\s*"([^"]+)"/);
      if (commandMatch) {
        const argsMatch = rawArgs.match(/"args"\s*:\s*\[([\s\S]*?)\]/);
        let args: string[] = [];
        if (argsMatch) {
          const argStrings = argsMatch[1].match(/"([^"]+)"/g);
          if (argStrings) args = argStrings.map(s => s.replace(/"/g, ''));
        }
        return { command: commandMatch[1], args };
      }
    }

    return null;
  } catch (e) {
    debug('Error in extractPartialToolParams:', e);
    return null;
  }
}

export function parseOpenAIToolCalls(toolCalls: unknown[]): ToolCall[] {
  if (!toolCalls || !Array.isArray(toolCalls)) return [];

  const parsed: ToolCall[] = [];

  for (const tc of toolCalls) {
    const t = tc as { function?: { name?: string; arguments?: string }; id?: string };
    const toolName = normalizeToolName(t.function?.name || '');
    if (!toolName) continue;

    let parameters: Record<string, unknown> = {};
    const rawArgs = t.function?.arguments || '{}';

    try {
      parameters = JSON.parse(rawArgs);
    } catch {
      debug(`Failed to parse tool arguments for ${toolName}, attempting partial extraction...`);
      debug('Raw args preview:', rawArgs.substring(0, 200));

      const partialParams = extractPartialToolParams(toolName, rawArgs);
      if (partialParams) {
        debug(`Successfully extracted partial params for ${toolName}:`, Object.keys(partialParams));
        parameters = partialParams;
      } else {
        debug(`Could not extract params, skipping ${toolName}`);
        continue;
      }
    }

    if (toolName === 'write_file' && !parameters.path) {
      debug(`Skipping write_file - missing path. Raw args:`, rawArgs.substring(0, 200));
      continue;
    }
    if (toolName === 'read_file' && !parameters.path) {
      debug(`Skipping read_file - missing path`);
      continue;
    }
    if (toolName === 'edit_file' && (!parameters.path || parameters.old_text === undefined || parameters.new_text === undefined)) {
      debug(`Skipping edit_file - missing required params`);
      continue;
    }

    parsed.push({ tool: toolName, parameters, id: t.id });
  }

  return parsed;
}

export function parseAnthropicToolCalls(content: unknown[]): ToolCall[] {
  if (!content || !Array.isArray(content)) return [];

  return content
    .filter((block): block is { type: string; name?: string; input?: Record<string, unknown>; id?: string } =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use')
    .map(block => ({
      tool: normalizeToolName(block.name || ''),
      parameters: block.input || {},
      id: block.id,
    }))
    .filter(tc => tc.tool);
}

function tryExtractParams(str: string): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};

  const argsMatch = str.match(/"args"\s*:\s*\[([\s\S]*?)\]/);
  if (argsMatch) {
    try {
      params.args = JSON.parse(`[${argsMatch[1]}]`);
    } catch {
      const items = argsMatch[1].match(/"([^"]*)"/g);
      if (items) params.args = items.map(i => i.replace(/"/g, ''));
    }
  }

  const cmdMatch = str.match(/"command"\s*:\s*"([^"]*)"/);
  if (cmdMatch) params.command = cmdMatch[1];

  const pathMatch = str.match(/"path"\s*:\s*"([^"]*)"/);
  if (pathMatch) params.path = pathMatch[1];

  const contentMatch = str.match(/"content"\s*:\s*"([\s\S]*?)(?<!\\)"/);
  if (contentMatch) params.content = contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');

  const oldTextMatch = str.match(/"old_text"\s*:\s*"([\s\S]*?)(?<!\\)"/);
  if (oldTextMatch) params.old_text = oldTextMatch[1];

  const newTextMatch = str.match(/"new_text"\s*:\s*"([\s\S]*?)(?<!\\)"/);
  if (newTextMatch) params.new_text = newTextMatch[1];

  const patternMatch = str.match(/"pattern"\s*:\s*"([^"]*)"/);
  if (patternMatch) params.pattern = patternMatch[1];

  const recursiveMatch = str.match(/"recursive"\s*:\s*(true|false)/i);
  if (recursiveMatch) params.recursive = recursiveMatch[1].toLowerCase() === 'true';

  return Object.keys(params).length > 0 ? params : null;
}

const TEXT_TOOL_NAME_MAP: Record<string, string> = {
  'executecommand': 'execute_command',
  'readfile': 'read_file',
  'writefile': 'write_file',
  'editfile': 'edit_file',
  'deletefile': 'delete_file',
  'listfiles': 'list_files',
  'searchcode': 'search_code',
  'findfiles': 'find_files',
};

function tryParseToolCall(str: string): ToolCall | null {
  try {
    const cleaned = str
      .replace(/[\r\n]+/g, ' ')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.tool && typeof parsed.tool === 'string') {
      return {
        tool: normalizeToolName(parsed.tool),
        parameters: parsed.parameters || {},
        id: parsed.id,
      };
    }
  } catch {
    const toolMatch = str.match(/"tool"\s*:\s*"([^"]+)"/i);
    if (toolMatch) {
      const tool = normalizeToolName(toolMatch[1]);
      const params: Record<string, unknown> = {};

      const paramMatches = str.matchAll(/"(\w+)"\s*:\s*"([^"]*)"/g);
      for (const m of paramMatches) {
        if (m[1] !== 'tool') params[m[1]] = m[2];
      }

      const boolMatches = str.matchAll(/"(\w+)"\s*:\s*(true|false)/gi);
      for (const m of boolMatches) {
        params[m[1]] = m[2].toLowerCase() === 'true';
      }

      if (Object.keys(params).length > 0) {
        return { tool, parameters: params };
      }
    }
  }
  return null;
}

/**
 * Parse tool calls from LLM response text.
 * Supports: <tool_call>, <toolcall>, ```tool blocks, inline JSON.
 */
export function parseToolCalls(response: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Format 1: <tool_call>...</tool_call> or <toolcall>...</toolcall>
  const toolCallRegex = /<tool_?call>\s*([\s\S]*?)\s*<\/tool_?call>/gi;
  let match;
  while ((match = toolCallRegex.exec(response)) !== null) {
    const parsed = tryParseToolCall(match[1].trim());
    if (parsed) toolCalls.push(parsed);
  }

  // Format 2: <toolcall>toolname{...}
  const malformedRegex = /<toolcall>(\w+)[\s,]*(?:"parameters"\s*:\s*)?(\{[\s\S]*?\})/gi;
  while ((match = malformedRegex.exec(response)) !== null) {
    const toolName = match[1].toLowerCase();
    const actualToolName = TEXT_TOOL_NAME_MAP[toolName] || toolName;
    try {
      const parsed = JSON.parse(match[2]);
      toolCalls.push({ tool: actualToolName, parameters: parsed.parameters || parsed });
    } catch {
      const params = tryExtractParams(match[2]);
      if (params) toolCalls.push({ tool: actualToolName, parameters: params });
    }
  }

  // Format 2b: loose toolname + parameters key
  const looseRegex = /<toolcall>(\w+)[,\s]+["']?parameters["']?\s*:\s*(\{[\s\S]*?\})(?:<\/toolcall>|<|$)/gi;
  while ((match = looseRegex.exec(response)) !== null) {
    const toolName = match[1].toLowerCase();
    const actualToolName = TEXT_TOOL_NAME_MAP[toolName] || toolName;
    if (toolCalls.some(t => t.tool === actualToolName)) continue;
    const params = tryExtractParams(match[2]);
    if (params) toolCalls.push({ tool: actualToolName, parameters: params });
  }

  // Format 3: ```tool or ```json code blocks
  const codeBlockRegex = /```(?:tool|json)?\s*\n?([\s\S]*?)\n?```/g;
  while ((match = codeBlockRegex.exec(response)) !== null) {
    const content = match[1].trim();
    if (content.includes('"tool"') || content.includes('"parameters"')) {
      const parsed = tryParseToolCall(content);
      if (parsed && !toolCalls.some(t => t.tool === parsed.tool && JSON.stringify(t.parameters) === JSON.stringify(parsed.parameters))) {
        toolCalls.push(parsed);
      }
    }
  }

  // Format 3b: Tool <arg_key>param</arg_key><arg_value>value</arg_value> format
  // Some models emit: Tool write_file<arg_key>path</arg_key><arg_value>...</arg_value>
  if (toolCalls.length === 0) {
    const argKeyValueRegex = /Tool\s+(\w+)((?:\s*<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>)+)/gi;
    while ((match = argKeyValueRegex.exec(response)) !== null) {
      const toolName = normalizeToolName(match[1]);
      const argBlock = match[2];
      const params: Record<string, unknown> = {};
      const pairRegex = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
      let pairMatch;
      while ((pairMatch = pairRegex.exec(argBlock)) !== null) {
        params[pairMatch[1].trim()] = pairMatch[2].trim();
      }
      if (toolName && Object.keys(params).length > 0) {
        toolCalls.push({ tool: toolName, parameters: params });
      }
    }
  }

  // Format 4: Inline JSON with tool property (fallback)
  if (toolCalls.length === 0) {
    const jsonRegex = /\{[^{}]*"tool"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[^{}]*\}[^{}]*\}/g;
    while ((match = jsonRegex.exec(response)) !== null) {
      const parsed = tryParseToolCall(match[0]);
      if (parsed) toolCalls.push(parsed);
    }
  }

  return toolCalls;
}
