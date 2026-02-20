/**
 * Agent tools - definitions, interfaces, and re-exports.
 *
 * Heavy implementation is split into:
 *   mcpIntegration.ts  — Z.AI and MiniMax MCP API helpers
 *   toolParsing.ts     — parseToolCalls, parseOpenAIToolCalls, parseAnthropicToolCalls
 *   toolExecution.ts   — executeTool, validatePath, createActionLog
 */

import { hasZaiMcpAccess, hasMinimaxMcpAccess, ZAI_MCP_TOOLS, MINIMAX_MCP_TOOLS } from './mcpIntegration';

// Tool parameter info shape (used in formatToolDefinitions)
interface ToolParamInfo { type: string; required?: boolean; description: string }

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
    description: 'Edit an existing file by replacing specific text. The old_text must match exactly ONE location in the file. If it matches multiple locations, include more surrounding context to make it unique.',
    parameters: {
      path: { type: 'string', description: 'Path to the file relative to project root', required: true },
      old_text: { type: 'string', description: 'The exact text to find and replace. Must be unique in the file - include enough context lines.', required: true },
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
    description: 'Search for a text pattern in the codebase. Searches across common file types: TypeScript, JavaScript, JSON, Markdown, CSS, HTML, Python, Go, Rust, Ruby, Kotlin, Swift, PHP, Java, C#, C/C++, Vue, Svelte, YAML, TOML, Shell, SQL, XML, SCSS, LESS.',
    parameters: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for', required: true },
      path: { type: 'string', description: 'Path to search in (default: entire project)', required: false },
    },
  },
  find_files: {
    name: 'find_files',
    description: 'Find files matching a glob pattern. Use to find files by name or extension (e.g., "**/*.test.ts", "src/**/*.css", "*.json").',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern to match (e.g., "**/*.test.ts", "src/**/*.css")', required: true },
      path: { type: 'string', description: 'Directory to search in relative to project root (default: ".")', required: false },
    },
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch content from a URL (documentation, APIs, web pages). Returns text content.',
    parameters: {
      url: { type: 'string', description: 'The URL to fetch content from', required: true },
    },
  },
  web_search: {
    name: 'web_search',
    description: 'Search the web for real-time information. Returns titles, URLs, and summaries. Requires a Z.AI API key.',
    parameters: {
      query: { type: 'string', description: 'Search query', required: true },
      domain_filter: { type: 'string', description: 'Limit results to specific domain (e.g. github.com)', required: false },
      recency: { type: 'string', description: 'Time filter: oneDay, oneWeek, oneMonth, oneYear, noLimit', required: false },
    },
  },
  web_read: {
    name: 'web_read',
    description: 'Fetch and parse a web page into clean readable text/markdown. Better than fetch_url for documentation and articles. Requires a Z.AI API key.',
    parameters: {
      url: { type: 'string', description: 'The URL to read', required: true },
      format: { type: 'string', description: 'Output format: markdown or text (default: markdown)', required: false },
    },
  },
  github_read: {
    name: 'github_read',
    description: 'Search documentation/code or read files from a public GitHub repository. Requires a Z.AI API key.',
    parameters: {
      repo: { type: 'string', description: 'GitHub repository in owner/repo format (e.g. facebook/react)', required: true },
      action: { type: 'string', description: 'Action: search, tree, or read_file', required: true },
      query: { type: 'string', description: 'Search query (for action=search)', required: false },
      path: { type: 'string', description: 'File path (for action=read_file) or directory path (for action=tree)', required: false },
    },
  },
  minimax_web_search: {
    name: 'minimax_web_search',
    description: 'Search the web using MiniMax search engine. Returns relevant results with summaries. Requires a MiniMax API key.',
    parameters: {
      query: { type: 'string', description: 'Search query', required: true },
    },
  },
  minimax_understand_image: {
    name: 'minimax_understand_image',
    description: 'Analyze and understand an image using MiniMax vision model. Can describe images, read text from screenshots, understand diagrams, and answer questions about visual content. Requires a MiniMax API key.',
    parameters: {
      prompt: { type: 'string', description: 'Question or instruction about the image (e.g. "Describe this image", "What text is in this screenshot?")', required: true },
      image_url: { type: 'string', description: 'URL of the image or base64-encoded image data', required: true },
    },
  },
};

/**
 * Get filtered tool entries (excludes provider-specific tools when API key not available)
 */
function getFilteredToolEntries(): [string, typeof AGENT_TOOLS[keyof typeof AGENT_TOOLS]][] {
  const hasMcp = hasZaiMcpAccess();
  const hasMinimaxMcp = hasMinimaxMcpAccess();
  return Object.entries(AGENT_TOOLS).filter(([name]) => {
    if (ZAI_MCP_TOOLS.includes(name)) return hasMcp;
    if (MINIMAX_MCP_TOOLS.includes(name)) return hasMinimaxMcp;
    return true;
  });
}

/**
 * Format tool definitions for system prompt (text-based fallback)
 */
export function formatToolDefinitions(): string {
  const lines: string[] = [];

  for (const [name, tool] of getFilteredToolEntries()) {
    lines.push(`### ${name}`);
    lines.push(tool.description);
    lines.push('Parameters:');
    for (const [param, info] of Object.entries(tool.parameters) as [string, ToolParamInfo][]) {
      const required = info.required ? '(required)' : '(optional)';
      lines.push(`  - ${param}: ${info.type} ${required} - ${info.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get tools in OpenAI Function Calling format
 */
export function getOpenAITools(): OpenAITool[] {
  return getFilteredToolEntries().map(([name, tool]) => {
    const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
    const required: string[] = [];

    for (const [param, info] of Object.entries(tool.parameters)) {
      const paramInfo = info as { type: string; description: string; required: boolean };
      if (paramInfo.type === 'array') {
        properties[param] = { type: 'array', description: paramInfo.description, items: { type: 'string' } };
      } else {
        properties[param] = { type: paramInfo.type, description: paramInfo.description };
      }
      if (paramInfo.required) required.push(param);
    }

    return {
      type: 'function' as const,
      function: {
        name,
        description: tool.description,
        parameters: { type: 'object' as const, properties, required },
      },
    };
  });
}

/**
 * Get tools in Anthropic Tool Use format
 */
export function getAnthropicTools(): AnthropicTool[] {
  return getFilteredToolEntries().map(([name, tool]) => {
    const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
    const required: string[] = [];

    for (const [param, info] of Object.entries(tool.parameters)) {
      const paramInfo = info as { type: string; description: string; required: boolean };
      if (paramInfo.type === 'array') {
        properties[param] = { type: 'array', description: paramInfo.description, items: { type: 'string' } };
      } else {
        properties[param] = { type: paramInfo.type, description: paramInfo.description };
      }
      if (paramInfo.required) required.push(param);
    }

    return {
      name,
      description: tool.description,
      input_schema: { type: 'object' as const, properties, required },
    };
  });
}

// Re-export from sub-modules so existing imports don't break
export { normalizeToolName, parseOpenAIToolCalls, parseAnthropicToolCalls, parseToolCalls } from './toolParsing';
export { executeTool, validatePath, createActionLog } from './toolExecution';
