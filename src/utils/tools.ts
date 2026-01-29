/**
 * Agent tools - definitions and execution
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, relative, resolve, isAbsolute } from 'path';
import { executeCommand, CommandResult } from './shell';
import { recordWrite, recordEdit, recordDelete, recordMkdir, recordCommand } from './history';

// OpenAI Function Calling format
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; items?: { type: string } }>;
      required: string[];
    };
  };
}

// Anthropic Tool Use format
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: { type: string } }>;
    required: string[];
  };
}

// Tool call interface
export interface ToolCall {
  tool: string;
  parameters: Record<string, unknown>;
  id?: string;
}

// Tool result interface
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  tool: string;
  parameters: Record<string, unknown>;
}

// Action log for tracking what agent did
export interface ActionLog {
  type: 'read' | 'write' | 'edit' | 'delete' | 'command' | 'search' | 'list' | 'mkdir' | 'fetch';
  target: string;
  result: 'success' | 'error';
  details?: string;
  timestamp: number;
}

// Tool definitions for system prompt
export const AGENT_TOOLS = {
  read_file: {
    name: 'read_file',
    description: 'Read the contents of a file. Use this to examine existing code.',
    parameters: {
      path: { type: 'string', description: 'Path to the file relative to project root', required: true },
    },
  },
  write_file: {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file with new content.',
    parameters: {
      path: { type: 'string', description: 'Path to the file relative to project root', required: true },
      content: { type: 'string', description: 'The complete content to write to the file', required: true },
    },
  },
  edit_file: {
    name: 'edit_file',
    description: 'Edit an existing file by replacing specific text. Use for targeted changes.',
    parameters: {
      path: { type: 'string', description: 'Path to the file relative to project root', required: true },
      old_text: { type: 'string', description: 'The exact text to find and replace', required: true },
      new_text: { type: 'string', description: 'The new text to replace with', required: true },
    },
  },
  delete_file: {
    name: 'delete_file',
    description: 'Delete a file or directory from the project. For directories, deletes recursively.',
    parameters: {
      path: { type: 'string', description: 'Path to the file or directory relative to project root', required: true },
    },
  },
  list_files: {
    name: 'list_files',
    description: 'List files and directories in a path. Use to explore project structure.',
    parameters: {
      path: { type: 'string', description: 'Path to directory relative to project root (use "." for root)', required: true },
      recursive: { type: 'boolean', description: 'Whether to list recursively (default: false)', required: false },
    },
  },
  create_directory: {
    name: 'create_directory',
    description: 'Create a new directory (folder). Creates parent directories if needed.',
    parameters: {
      path: { type: 'string', description: 'Path to the directory to create, relative to project root', required: true },
    },
  },
  execute_command: {
    name: 'execute_command',
    description: 'Execute a shell command. Use for npm, git, build tools, tests, etc.',
    parameters: {
      command: { type: 'string', description: 'The command to run (e.g., npm, git, node)', required: true },
      args: { type: 'array', description: 'Command arguments as array (e.g., ["install", "lodash"])', required: false },
    },
  },
  search_code: {
    name: 'search_code',
    description: 'Search for a text pattern in the codebase. Returns matching files and lines.',
    parameters: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for', required: true },
      path: { type: 'string', description: 'Path to search in (default: entire project)', required: false },
    },
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch content from a URL (documentation, APIs, web pages). Returns text content.',
    parameters: {
      url: { type: 'string', description: 'The URL to fetch content from', required: true },
    },
  },
};

/**
 * Format tool definitions for system prompt (text-based fallback)
 */
export function formatToolDefinitions(): string {
  const lines: string[] = [];
  
  for (const [name, tool] of Object.entries(AGENT_TOOLS)) {
    lines.push(`### ${name}`);
    lines.push(tool.description);
    lines.push('Parameters:');
    for (const [param, info] of Object.entries(tool.parameters)) {
      const required = (info as any).required ? '(required)' : '(optional)';
      lines.push(`  - ${param}: ${(info as any).type} ${required} - ${(info as any).description}`);
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Get tools in OpenAI Function Calling format
 */
export function getOpenAITools(): OpenAITool[] {
  return Object.entries(AGENT_TOOLS).map(([name, tool]) => {
    const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
    const required: string[] = [];
    
    for (const [param, info] of Object.entries(tool.parameters)) {
      const paramInfo = info as { type: string; description: string; required: boolean };
      
      if (paramInfo.type === 'array') {
        properties[param] = {
          type: 'array',
          description: paramInfo.description,
          items: { type: 'string' },
        };
      } else {
        properties[param] = {
          type: paramInfo.type,
          description: paramInfo.description,
        };
      }
      
      if (paramInfo.required) {
        required.push(param);
      }
    }
    
    return {
      type: 'function' as const,
      function: {
        name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties,
          required,
        },
      },
    };
  });
}

/**
 * Get tools in Anthropic Tool Use format
 */
export function getAnthropicTools(): AnthropicTool[] {
  return Object.entries(AGENT_TOOLS).map(([name, tool]) => {
    const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
    const required: string[] = [];
    
    for (const [param, info] of Object.entries(tool.parameters)) {
      const paramInfo = info as { type: string; description: string; required: boolean };
      
      if (paramInfo.type === 'array') {
        properties[param] = {
          type: 'array',
          description: paramInfo.description,
          items: { type: 'string' },
        };
      } else {
        properties[param] = {
          type: paramInfo.type,
          description: paramInfo.description,
        };
      }
      
      if (paramInfo.required) {
        required.push(param);
      }
    }
    
    return {
      name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties,
        required,
      },
    };
  });
}

/**
 * Parse tool calls from OpenAI response
 */
/**
 * Normalize tool name to lowercase with underscores
 */
function normalizeToolName(name: string): string {
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
    'fetchurl': 'fetch_url',
    'fetch_url': 'fetch_url',
  };
  
  const lower = name.toLowerCase().replace(/-/g, '_');
  return toolNameMap[lower] || lower;
}

export function parseOpenAIToolCalls(toolCalls: any[]): ToolCall[] {
  if (!toolCalls || !Array.isArray(toolCalls)) return [];
  
  return toolCalls.map(tc => {
    let parameters = {};
    try {
      parameters = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      parameters = {};
    }
    
    return {
      tool: normalizeToolName(tc.function?.name || ''),
      parameters,
      id: tc.id,
    };
  }).filter(tc => tc.tool);
}

/**
 * Parse tool calls from Anthropic response
 */
export function parseAnthropicToolCalls(content: any[]): ToolCall[] {
  if (!content || !Array.isArray(content)) return [];
  
  return content
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      tool: normalizeToolName(block.name || ''),
      parameters: block.input || {},
      id: block.id,
    }))
    .filter(tc => tc.tool);
}

/**
 * Parse tool calls from LLM response
 * Supports multiple formats:
 * - <tool_call>{"tool": "name", "parameters": {...}}</tool_call>
 * - <toolcall>{"tool": "name", "parameters": {...}}</toolcall>
 * - <toolcall>toolname{"parameters": {...}}</toolcall>
 * - ```tool\n{"tool": "name", "parameters": {...}}\n```
 * - Direct JSON blocks with tool property
 */
export function parseToolCalls(response: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  
  // Format 1: <tool_call>...</tool_call> or <toolcall>...</toolcall> with JSON inside
  const toolCallRegex = /<tool_?call>\s*([\s\S]*?)\s*<\/tool_?call>/gi;
  let match;
  
  while ((match = toolCallRegex.exec(response)) !== null) {
    const parsed = tryParseToolCall(match[1].trim());
    if (parsed) toolCalls.push(parsed);
  }
  
  // Format 2: <toolcall>toolname{...} or <toolcall>toolname, "parameters": {...}
  const malformedRegex = /<toolcall>(\w+)[\s,]*(?:"parameters"\s*:\s*)?(\{[\s\S]*?\})/gi;
  while ((match = malformedRegex.exec(response)) !== null) {
    const toolName = match[1].toLowerCase();
    let jsonPart = match[2];
    
    // Map common variations to actual tool names
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
    };
    
    const actualToolName = toolNameMap[toolName] || toolName;
    
    try {
      const parsed = JSON.parse(jsonPart);
      const params = parsed.parameters || parsed;
      toolCalls.push({
        tool: actualToolName,
        parameters: params,
      });
    } catch {
      // Try to extract parameters manually
      const params = tryExtractParams(jsonPart);
      if (params) {
        toolCalls.push({
          tool: actualToolName,
          parameters: params,
        });
      }
    }
  }
  
  // Format 2b: Even more malformed - toolname followed by loose JSON-like content
  const looseRegex = /<toolcall>(\w+)[,\s]+["']?parameters["']?\s*:\s*(\{[\s\S]*?\})(?:<\/toolcall>|<|$)/gi;
  while ((match = looseRegex.exec(response)) !== null) {
    // Skip if already parsed
    const toolName = match[1].toLowerCase();
    const toolNameMap: Record<string, string> = {
      'executecommand': 'execute_command',
      'readfile': 'read_file',
      'writefile': 'write_file',
      'editfile': 'edit_file',
      'deletefile': 'delete_file',
      'listfiles': 'list_files',
      'searchcode': 'search_code',
    };
    const actualToolName = toolNameMap[toolName] || toolName;
    
    // Check if we already have this tool call
    if (toolCalls.some(t => t.tool === actualToolName)) continue;
    
    const params = tryExtractParams(match[2]);
    if (params) {
      toolCalls.push({
        tool: actualToolName,
        parameters: params,
      });
    }
  }
  
  // Format 3: ```tool or ```json with tool calls
  const codeBlockRegex = /```(?:tool|json)?\s*\n?([\s\S]*?)\n?```/g;
  while ((match = codeBlockRegex.exec(response)) !== null) {
    const content = match[1].trim();
    // Only parse if it looks like a tool call JSON
    if (content.includes('"tool"') || content.includes('"parameters"')) {
      const parsed = tryParseToolCall(content);
      if (parsed && !toolCalls.some(t => t.tool === parsed.tool && JSON.stringify(t.parameters) === JSON.stringify(parsed.parameters))) {
        toolCalls.push(parsed);
      }
    }
  }
  
  // Format 4: Inline JSON objects with tool property (fallback)
  if (toolCalls.length === 0) {
    const jsonRegex = /\{[^{}]*"tool"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[^{}]*\}[^{}]*\}/g;
    while ((match = jsonRegex.exec(response)) !== null) {
      const parsed = tryParseToolCall(match[0]);
      if (parsed) toolCalls.push(parsed);
    }
  }
  
  return toolCalls;
}

/**
 * Try to extract parameters from a malformed JSON string
 */
function tryExtractParams(str: string): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};
  
  // Extract "args": [...] 
  const argsMatch = str.match(/"args"\s*:\s*\[([\s\S]*?)\]/);
  if (argsMatch) {
    try {
      params.args = JSON.parse(`[${argsMatch[1]}]`);
    } catch {
      // Try to extract string array manually
      const items = argsMatch[1].match(/"([^"]*)"/g);
      if (items) {
        params.args = items.map(i => i.replace(/"/g, ''));
      }
    }
  }
  
  // Extract "command": "..."
  const cmdMatch = str.match(/"command"\s*:\s*"([^"]*)"/);
  if (cmdMatch) {
    params.command = cmdMatch[1];
  }
  
  // Extract "path": "..."
  const pathMatch = str.match(/"path"\s*:\s*"([^"]*)"/);
  if (pathMatch) {
    params.path = pathMatch[1];
  }
  
  // Extract "content": "..."
  const contentMatch = str.match(/"content"\s*:\s*"([\s\S]*?)(?<!\\)"/);
  if (contentMatch) {
    params.content = contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  
  // Extract "old_text" and "new_text"
  const oldTextMatch = str.match(/"old_text"\s*:\s*"([\s\S]*?)(?<!\\)"/);
  if (oldTextMatch) {
    params.old_text = oldTextMatch[1];
  }
  const newTextMatch = str.match(/"new_text"\s*:\s*"([\s\S]*?)(?<!\\)"/);
  if (newTextMatch) {
    params.new_text = newTextMatch[1];
  }
  
  // Extract "pattern": "..."
  const patternMatch = str.match(/"pattern"\s*:\s*"([^"]*)"/);
  if (patternMatch) {
    params.pattern = patternMatch[1];
  }
  
  // Extract "recursive": true/false
  const recursiveMatch = str.match(/"recursive"\s*:\s*(true|false)/i);
  if (recursiveMatch) {
    params.recursive = recursiveMatch[1].toLowerCase() === 'true';
  }
  
  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Try to parse a string as a tool call
 */
function tryParseToolCall(str: string): ToolCall | null {
  try {
    // Clean up common issues
    let cleaned = str
      .replace(/[\r\n]+/g, ' ')  // Remove newlines
      .replace(/,\s*}/g, '}')     // Remove trailing commas
      .replace(/,\s*]/g, ']')     // Remove trailing commas in arrays
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
    // Try to extract tool name and parameters manually for malformed JSON
    const toolMatch = str.match(/"tool"\s*:\s*"([^"]+)"/i);
    if (toolMatch) {
      const tool = normalizeToolName(toolMatch[1]);
      const params: Record<string, unknown> = {};
      
      // Extract simple string parameters
      const paramMatches = str.matchAll(/"(\w+)"\s*:\s*"([^"]*)"/g);
      for (const m of paramMatches) {
        if (m[1] !== 'tool') {
          params[m[1]] = m[2];
        }
      }
      
      // Extract boolean parameters
      const boolMatches = str.matchAll(/"(\w+)"\s*:\s*(true|false)/gi);
      for (const m of boolMatches) {
        params[m[1]] = m[2].toLowerCase() === 'true';
      }
      
      if (Object.keys(params).length > 0 || AGENT_TOOLS[tool as keyof typeof AGENT_TOOLS]) {
        return { tool, parameters: params };
      }
    }
  }
  return null;
}

/**
 * Validate path is within project
 */
function validatePath(path: string, projectRoot: string): { valid: boolean; absolutePath: string; error?: string } {
  const absolutePath = isAbsolute(path) ? path : resolve(projectRoot, path);
  const relativePath = relative(projectRoot, absolutePath);
  
  if (relativePath.startsWith('..')) {
    return { valid: false, absolutePath, error: `Path '${path}' is outside project directory` };
  }
  
  return { valid: true, absolutePath };
}

/**
 * Execute a tool call
 */
export function executeTool(toolCall: ToolCall, projectRoot: string): ToolResult {
  const { tool, parameters } = toolCall;
  
  try {
    switch (tool) {
      case 'read_file': {
        const path = parameters.path as string;
        if (!path) {
          return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };
        }
        
        const validation = validatePath(path, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        if (!existsSync(validation.absolutePath)) {
          return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };
        }
        
        const stat = statSync(validation.absolutePath);
        if (stat.isDirectory()) {
          return { success: false, output: '', error: `Path is a directory, not a file: ${path}`, tool, parameters };
        }
        
        // Limit file size
        if (stat.size > 100 * 1024) { // 100KB
          return { success: false, output: '', error: `File too large (${stat.size} bytes). Max: 100KB`, tool, parameters };
        }
        
        const content = readFileSync(validation.absolutePath, 'utf-8');
        return { success: true, output: content, tool, parameters };
      }
      
      case 'write_file': {
        const path = parameters.path as string;
        const content = parameters.content as string;
        
        if (!path) {
          return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };
        }
        if (content === undefined) {
          return { success: false, output: '', error: 'Missing required parameter: content', tool, parameters };
        }
        
        const validation = validatePath(path, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        // Create directory if needed
        const dir = dirname(validation.absolutePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        
        // Record for undo
        recordWrite(validation.absolutePath);
        
        const existed = existsSync(validation.absolutePath);
        writeFileSync(validation.absolutePath, content, 'utf-8');
        
        const action = existed ? 'Updated' : 'Created';
        return { success: true, output: `${action} file: ${path}`, tool, parameters };
      }
      
      case 'edit_file': {
        const path = parameters.path as string;
        const oldText = parameters.old_text as string;
        const newText = parameters.new_text as string;
        
        if (!path || oldText === undefined || newText === undefined) {
          return { success: false, output: '', error: 'Missing required parameters', tool, parameters };
        }
        
        const validation = validatePath(path, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        if (!existsSync(validation.absolutePath)) {
          return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };
        }
        
        const content = readFileSync(validation.absolutePath, 'utf-8');
        
        if (!content.includes(oldText)) {
          return { success: false, output: '', error: `Text not found in file. Make sure old_text matches exactly.`, tool, parameters };
        }
        
        // Record for undo
        recordEdit(validation.absolutePath);
        
        const newContent = content.replace(oldText, newText);
        writeFileSync(validation.absolutePath, newContent, 'utf-8');
        
        return { success: true, output: `Edited file: ${path}`, tool, parameters };
      }
      
      case 'delete_file': {
        const path = parameters.path as string;
        
        if (!path) {
          return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };
        }
        
        const validation = validatePath(path, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        if (!existsSync(validation.absolutePath)) {
          return { success: false, output: '', error: `Path not found: ${path}`, tool, parameters };
        }
        
        // Record for undo (before delete)
        recordDelete(validation.absolutePath);
        
        const stat = statSync(validation.absolutePath);
        if (stat.isDirectory()) {
          // Delete directory recursively
          rmSync(validation.absolutePath, { recursive: true, force: true });
          return { success: true, output: `Deleted directory: ${path}`, tool, parameters };
        } else {
          unlinkSync(validation.absolutePath);
          return { success: true, output: `Deleted file: ${path}`, tool, parameters };
        }
      }
      
      case 'list_files': {
        const path = (parameters.path as string) || '.';
        const recursive = parameters.recursive as boolean || false;
        
        const validation = validatePath(path, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        if (!existsSync(validation.absolutePath)) {
          return { success: false, output: '', error: `Directory not found: ${path}`, tool, parameters };
        }
        
        const stat = statSync(validation.absolutePath);
        if (!stat.isDirectory()) {
          return { success: false, output: '', error: `Path is not a directory: ${path}`, tool, parameters };
        }
        
        const files = listDirectory(validation.absolutePath, projectRoot, recursive);
        return { success: true, output: files.join('\n'), tool, parameters };
      }
      
      case 'create_directory': {
        const path = parameters.path as string;
        
        if (!path) {
          return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };
        }
        
        const validation = validatePath(path, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        if (existsSync(validation.absolutePath)) {
          const stat = statSync(validation.absolutePath);
          if (stat.isDirectory()) {
            return { success: true, output: `Directory already exists: ${path}`, tool, parameters };
          } else {
            return { success: false, output: '', error: `Path exists but is a file: ${path}`, tool, parameters };
          }
        }
        
        // Record for undo
        recordMkdir(validation.absolutePath);
        
        mkdirSync(validation.absolutePath, { recursive: true });
        return { success: true, output: `Created directory: ${path}`, tool, parameters };
      }
      
      case 'execute_command': {
        const command = parameters.command as string;
        const args = (parameters.args as string[]) || [];
        
        if (!command) {
          return { success: false, output: '', error: 'Missing required parameter: command', tool, parameters };
        }
        
        // Record command (can't undo but tracked)
        recordCommand(command, args);
        
        const result = executeCommand(command, args, {
          cwd: projectRoot,
          projectRoot,
          timeout: 120000, // 2 minutes for commands
        });
        
        if (result.success) {
          return { success: true, output: result.stdout || '(no output)', tool, parameters };
        } else {
          return { success: false, output: result.stdout, error: result.stderr, tool, parameters };
        }
      }
      
      case 'search_code': {
        const pattern = parameters.pattern as string;
        const searchPath = (parameters.path as string) || '.';
        
        if (!pattern) {
          return { success: false, output: '', error: 'Missing required parameter: pattern', tool, parameters };
        }
        
        const validation = validatePath(searchPath, projectRoot);
        if (!validation.valid) {
          return { success: false, output: '', error: validation.error, tool, parameters };
        }
        
        // Use grep for search
        const result = executeCommand('grep', ['-rn', '--include=*.{ts,tsx,js,jsx,json,md,css,html,py,go,rs}', pattern, validation.absolutePath], {
          cwd: projectRoot,
          projectRoot,
          timeout: 30000,
        });
        
        if (result.exitCode === 0) {
          // Limit output
          const lines = result.stdout.split('\n').slice(0, 50);
          return { success: true, output: lines.join('\n') || 'No matches found', tool, parameters };
        } else if (result.exitCode === 1) {
          return { success: true, output: 'No matches found', tool, parameters };
        } else {
          return { success: false, output: '', error: result.stderr || 'Search failed', tool, parameters };
        }
      }
      
      case 'fetch_url': {
        const url = parameters.url as string;
        
        if (!url) {
          return { success: false, output: '', error: 'Missing required parameter: url', tool, parameters };
        }
        
        // Validate URL
        try {
          new URL(url);
        } catch {
          return { success: false, output: '', error: 'Invalid URL format', tool, parameters };
        }
        
        // Use curl to fetch URL
        const result = executeCommand('curl', [
          '-s', '-L', 
          '-m', '30', // 30 second timeout
          '-A', 'Codeep/1.0',
          '--max-filesize', '1000000', // 1MB max
          url
        ], {
          cwd: projectRoot,
          projectRoot,
          timeout: 35000,
        });
        
        if (result.success) {
          // Try to extract text content (strip HTML tags for basic display)
          let content = result.stdout;
          
          // If it looks like HTML, try to extract text
          if (content.includes('<html') || content.includes('<!DOCTYPE')) {
            // Simple HTML to text - remove script/style and tags
            content = content
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          }
          
          // Limit output
          if (content.length > 10000) {
            content = content.substring(0, 10000) + '\n\n... (truncated)';
          }
          
          return { success: true, output: content, tool, parameters };
        } else {
          return { success: false, output: '', error: result.stderr || 'Failed to fetch URL', tool, parameters };
        }
      }
      
      default:
        return { success: false, output: '', error: `Unknown tool: ${tool}`, tool, parameters };
    }
  } catch (error) {
    const err = error as Error;
    return { success: false, output: '', error: err.message, tool, parameters };
  }
}

/**
 * List directory contents
 */
function listDirectory(dir: string, projectRoot: string, recursive: boolean, prefix: string = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  
  // Skip common directories
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
  
  for (const entry of entries) {
    const relativePath = relative(projectRoot, join(dir, entry.name));
    
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      
      files.push(`${prefix}${entry.name}/`);
      
      if (recursive) {
        const subFiles = listDirectory(join(dir, entry.name), projectRoot, true, prefix + '  ');
        files.push(...subFiles);
      }
    } else {
      files.push(`${prefix}${entry.name}`);
    }
  }
  
  return files;
}

/**
 * Create action log from tool result
 */
export function createActionLog(toolCall: ToolCall, result: ToolResult): ActionLog {
  const typeMap: Record<string, ActionLog['type']> = {
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    delete_file: 'delete',
    execute_command: 'command',
    search_code: 'search',
    list_files: 'list',
    create_directory: 'mkdir',
    fetch_url: 'fetch',
  };
  
  const target = (toolCall.parameters.path as string) || 
                 (toolCall.parameters.command as string) ||
                 (toolCall.parameters.pattern as string) ||
                 (toolCall.parameters.url as string) ||
                 'unknown';
  
  return {
    type: typeMap[toolCall.tool] || 'command',
    target,
    result: result.success ? 'success' : 'error',
    details: result.success ? result.output.slice(0, 200) : result.error,
    timestamp: Date.now(),
  };
}
