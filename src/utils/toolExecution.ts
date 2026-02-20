/**
 * Tool execution - runs agent tool calls against the filesystem and shell.
 *
 * validatePath() ensures all file operations stay within the project root.
 * executeTool() dispatches to individual tool handlers.
 * listDirectory() and htmlToText() are private helpers.
 * createActionLog() converts a ToolCall+ToolResult into a history ActionLog.
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, relative, resolve, isAbsolute } from 'path';
import { executeCommand } from './shell';
import { recordWrite, recordEdit, recordDelete, recordMkdir, recordCommand } from './history';
import { loadIgnoreRules, isIgnored } from './gitignore';
import { normalizeToolName } from './toolParsing';
import { getZaiMcpConfig, getMinimaxMcpConfig, callZaiMcp, callMinimaxApi } from './mcpIntegration';
import { ToolCall, ToolResult, ActionLog } from './tools';

const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    console.error('[DEBUG]', ...args);
  }
};

/**
 * Validate path is within project root.
 */
export function validatePath(path: string, projectRoot: string): { valid: boolean; absolutePath: string; error?: string } {
  let normalizedPath = path;
  if (isAbsolute(path) && path.startsWith(projectRoot)) {
    normalizedPath = relative(projectRoot, path);
  }

  if (isAbsolute(normalizedPath)) {
    return { valid: false, absolutePath: normalizedPath, error: `Absolute path '${path}' not allowed. Use relative paths.` };
  }

  const absolutePath = resolve(projectRoot, normalizedPath);
  const relativePath = relative(projectRoot, absolutePath);

  if (relativePath.startsWith('..')) {
    return { valid: false, absolutePath, error: `Path '${path}' is outside project directory` };
  }

  return { valid: true, absolutePath };
}

/**
 * List directory contents, respecting .gitignore rules.
 */
function listDirectory(dir: string, projectRoot: string, recursive: boolean, prefix: string = '', ignoreRules?: ReturnType<typeof loadIgnoreRules>): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  const rules = ignoreRules || loadIgnoreRules(projectRoot);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (isIgnored(fullPath, rules)) continue;

    if (entry.isDirectory()) {
      files.push(`${prefix}${entry.name}/`);
      if (recursive) {
        files.push(...listDirectory(fullPath, projectRoot, true, prefix + '  ', rules));
      }
    } else {
      files.push(`${prefix}${entry.name}`);
    }
  }

  return files;
}

/**
 * Convert HTML to readable plain text, preserving structure.
 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  text = mainMatch?.[1] || articleMatch?.[1] || bodyMatch?.[1] || text;

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n');
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  text = text.replace(/<\/[uo]l>/gi, '\n');
  text = text.replace(/<[uo]l[^>]*>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/th>/gi, '\t');
  text = text.replace(/<\/td>/gi, '\t');
  text = text.replace(/<hr[^>]*>/gi, '\n---\n');
  text = text.replace(/<\/blockquote>/gi, '\n');
  text = text.replace(/<blockquote[^>]*>/gi, '\n> ');
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  text = text.replace(/<[^>]+>/g, '');

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Execute a tool call and return the result.
 */
export async function executeTool(toolCall: ToolCall, projectRoot: string): Promise<ToolResult> {
  const tool = normalizeToolName(toolCall.tool);
  const parameters = toolCall.parameters;

  debug(`Executing tool: ${tool}`, parameters.path || parameters.command || '');

  try {
    switch (tool) {
      case 'read_file': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };
        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };

        const stat = statSync(validation.absolutePath);
        if (stat.isDirectory()) return { success: false, output: '', error: `Path is a directory, not a file: ${path}`, tool, parameters };
        if (stat.size > 100 * 1024) return { success: false, output: '', error: `File too large (${stat.size} bytes). Max: 100KB`, tool, parameters };

        return { success: true, output: readFileSync(validation.absolutePath, 'utf-8'), tool, parameters };
      }

      case 'write_file': {
        const path = parameters.path as string;
        let content = parameters.content as string;

        if (!path) {
          debug('write_file failed: missing path');
          return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };
        }
        if (content === undefined || content === null) {
          debug('write_file: content was undefined, using placeholder');
          content = '<!-- Content was not provided -->\n';
        }

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        const dir = dirname(validation.absolutePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        recordWrite(validation.absolutePath);
        const existed = existsSync(validation.absolutePath);
        writeFileSync(validation.absolutePath, content, 'utf-8');
        return { success: true, output: `${existed ? 'Updated' : 'Created'} file: ${path}`, tool, parameters };
      }

      case 'edit_file': {
        const path = parameters.path as string;
        const oldText = parameters.old_text as string;
        const newText = parameters.new_text as string;

        if (!path || oldText === undefined || newText === undefined) {
          return { success: false, output: '', error: 'Missing required parameters', tool, parameters };
        }

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };
        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };

        const content = readFileSync(validation.absolutePath, 'utf-8');
        if (!content.includes(oldText)) {
          return { success: false, output: '', error: 'Text not found in file. Make sure old_text matches exactly.', tool, parameters };
        }

        let matchCount = 0;
        let searchPos = 0;
        while ((searchPos = content.indexOf(oldText, searchPos)) !== -1) {
          matchCount++;
          searchPos += oldText.length;
        }

        if (matchCount > 1) {
          return { success: false, output: '', error: `old_text matches ${matchCount} locations in the file. Provide more surrounding context to make it unique (only 1 match allowed).`, tool, parameters };
        }

        recordEdit(validation.absolutePath);
        writeFileSync(validation.absolutePath, content.replace(oldText, newText), 'utf-8');
        return { success: true, output: `Edited file: ${path}`, tool, parameters };
      }

      case 'delete_file': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };
        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `Path not found: ${path}`, tool, parameters };

        recordDelete(validation.absolutePath);
        const stat = statSync(validation.absolutePath);
        if (stat.isDirectory()) {
          rmSync(validation.absolutePath, { recursive: true, force: true });
          return { success: true, output: `Deleted directory: ${path}`, tool, parameters };
        } else {
          unlinkSync(validation.absolutePath);
          return { success: true, output: `Deleted file: ${path}`, tool, parameters };
        }
      }

      case 'list_files': {
        const path = (parameters.path as string) || '.';
        const recursive = (parameters.recursive as boolean) || false;

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };
        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `Directory not found: ${path}`, tool, parameters };

        const stat = statSync(validation.absolutePath);
        if (!stat.isDirectory()) return { success: false, output: '', error: `Path is not a directory: ${path}`, tool, parameters };

        const files = listDirectory(validation.absolutePath, projectRoot, recursive);
        return { success: true, output: files.join('\n'), tool, parameters };
      }

      case 'create_directory': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        if (existsSync(validation.absolutePath)) {
          const stat = statSync(validation.absolutePath);
          if (stat.isDirectory()) return { success: true, output: `Directory already exists: ${path}`, tool, parameters };
          return { success: false, output: '', error: `Path exists but is a file: ${path}`, tool, parameters };
        }

        recordMkdir(validation.absolutePath);
        mkdirSync(validation.absolutePath, { recursive: true });
        return { success: true, output: `Created directory: ${path}`, tool, parameters };
      }

      case 'execute_command': {
        const command = parameters.command as string;
        const args = (parameters.args as string[]) || [];

        if (!command) return { success: false, output: '', error: 'Missing required parameter: command', tool, parameters };

        recordCommand(command, args);

        const result = executeCommand(command, args, {
          cwd: projectRoot,
          projectRoot,
          timeout: 120000,
        });

        if (result.success) return { success: true, output: result.stdout || '(no output)', tool, parameters };
        return { success: false, output: result.stdout, error: result.stderr, tool, parameters };
      }

      case 'search_code': {
        const pattern = parameters.pattern as string;
        const searchPath = (parameters.path as string) || '.';

        if (!pattern) return { success: false, output: '', error: 'Missing required parameter: pattern', tool, parameters };

        const validation = validatePath(searchPath, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        const result = executeCommand('grep', ['-rn', '--include=*.{ts,tsx,js,jsx,json,md,css,html,py,go,rs,rb,kt,kts,swift,php,java,cs,c,cpp,h,hpp,vue,svelte,yaml,yml,toml,sh,sql,xml,scss,less}', pattern, validation.absolutePath], {
          cwd: projectRoot,
          projectRoot,
          timeout: 30000,
        });

        if (result.exitCode === 0) {
          const lines = result.stdout.split('\n').slice(0, 50);
          return { success: true, output: lines.join('\n') || 'No matches found', tool, parameters };
        } else if (result.exitCode === 1) {
          return { success: true, output: 'No matches found', tool, parameters };
        }
        return { success: false, output: '', error: result.stderr || 'Search failed', tool, parameters };
      }

      case 'find_files': {
        const pattern = parameters.pattern as string;
        const searchPath = (parameters.path as string) || '.';

        if (!pattern) return { success: false, output: '', error: 'Missing required parameter: pattern', tool, parameters };

        const validation = validatePath(searchPath, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        const findArgs: string[] = [validation.absolutePath, '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.codeep', '-o', '-name', 'dist', '-o', '-name', 'build', '-o', '-name', '.next', ')', '-prune', '-o'];

        if (pattern.includes('/')) {
          findArgs.push('-path', `*/${pattern}`, '-print');
        } else {
          findArgs.push('-name', pattern, '-print');
        }

        const result = executeCommand('find', findArgs, { cwd: projectRoot, projectRoot, timeout: 15000 });

        if (result.exitCode === 0 || result.stdout) {
          const files = result.stdout.split('\n').filter(Boolean);
          const relativePaths = files.map(f => relative(projectRoot, f) || f).slice(0, 100);
          if (relativePaths.length === 0) return { success: true, output: `No files matching "${pattern}"`, tool, parameters };
          return { success: true, output: `Found ${relativePaths.length} file(s):\n${relativePaths.join('\n')}`, tool, parameters };
        }
        return { success: false, output: '', error: result.stderr || 'Find failed', tool, parameters };
      }

      case 'fetch_url': {
        const url = parameters.url as string;
        if (!url) return { success: false, output: '', error: 'Missing required parameter: url', tool, parameters };

        try { new URL(url); } catch { return { success: false, output: '', error: 'Invalid URL format', tool, parameters }; }

        const result = executeCommand('curl', ['-s', '-L', '-m', '30', '-A', 'Codeep/1.0', '--max-filesize', '1000000', url], {
          cwd: projectRoot,
          projectRoot,
          timeout: 35000,
        });

        if (result.success) {
          let content = result.stdout;
          if (content.includes('<html') || content.includes('<!DOCTYPE')) {
            content = htmlToText(content);
          }
          if (content.length > 10000) content = content.substring(0, 10000) + '\n\n... (truncated)';
          return { success: true, output: content, tool, parameters };
        }
        return { success: false, output: '', error: result.stderr || 'Failed to fetch URL', tool, parameters };
      }

      // === Z.AI MCP Tools ===

      case 'web_search': {
        const mcpConfig = getZaiMcpConfig();
        if (!mcpConfig) return { success: false, output: '', error: 'web_search requires a Z.AI API key. Configure one via /provider z.ai', tool, parameters };

        const query = parameters.query as string;
        if (!query) return { success: false, output: '', error: 'Missing required parameter: query', tool, parameters };

        const args: Record<string, unknown> = { search_query: query };
        if (parameters.domain_filter) args.search_domain_filter = parameters.domain_filter;
        if (parameters.recency) args.search_recency_filter = parameters.recency;

        const result = await callZaiMcp(mcpConfig.endpoints.webSearch, 'webSearchPrime', args, mcpConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'web_read': {
        const mcpConfig = getZaiMcpConfig();
        if (!mcpConfig) return { success: false, output: '', error: 'web_read requires a Z.AI API key. Configure one via /provider z.ai', tool, parameters };

        const url = parameters.url as string;
        if (!url) return { success: false, output: '', error: 'Missing required parameter: url', tool, parameters };
        try { new URL(url); } catch { return { success: false, output: '', error: 'Invalid URL format', tool, parameters }; }

        const args: Record<string, unknown> = { url };
        if (parameters.format) args.return_format = parameters.format;

        const result = await callZaiMcp(mcpConfig.endpoints.webReader, 'webReader', args, mcpConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'github_read': {
        const mcpConfig = getZaiMcpConfig();
        if (!mcpConfig) return { success: false, output: '', error: 'github_read requires a Z.AI API key. Configure one via /provider z.ai', tool, parameters };

        const repo = parameters.repo as string;
        const action = parameters.action as string;
        if (!repo) return { success: false, output: '', error: 'Missing required parameter: repo', tool, parameters };
        if (!repo.includes('/')) return { success: false, output: '', error: 'Invalid repo format. Use owner/repo (e.g. facebook/react)', tool, parameters };
        if (!action || !['search', 'tree', 'read_file'].includes(action)) {
          return { success: false, output: '', error: 'Invalid action. Must be: search, tree, or read_file', tool, parameters };
        }

        let mcpToolName: string;
        const args: Record<string, unknown> = { repo_name: repo };

        if (action === 'search') {
          mcpToolName = 'search_doc';
          const query = parameters.query as string;
          if (!query) return { success: false, output: '', error: 'Missing required parameter: query (for action=search)', tool, parameters };
          args.query = query;
        } else if (action === 'tree') {
          mcpToolName = 'get_repo_structure';
          if (parameters.path) args.dir_path = parameters.path;
        } else {
          mcpToolName = 'read_file';
          const filePath = parameters.path as string;
          if (!filePath) return { success: false, output: '', error: 'Missing required parameter: path (for action=read_file)', tool, parameters };
          args.file_path = filePath;
        }

        const result = await callZaiMcp(mcpConfig.endpoints.zread, mcpToolName, args, mcpConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      // === MiniMax MCP Tools ===

      case 'minimax_web_search': {
        const mmConfig = getMinimaxMcpConfig();
        if (!mmConfig) return { success: false, output: '', error: 'minimax_web_search requires a MiniMax API key. Configure one via /provider minimax', tool, parameters };

        const query = parameters.query as string;
        if (!query) return { success: false, output: '', error: 'Missing required parameter: query', tool, parameters };

        const result = await callMinimaxApi(mmConfig.host, '/v1/coding_plan/search', { q: query }, mmConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'minimax_understand_image': {
        const mmConfig = getMinimaxMcpConfig();
        if (!mmConfig) return { success: false, output: '', error: 'minimax_understand_image requires a MiniMax API key. Configure one via /provider minimax', tool, parameters };

        const prompt = parameters.prompt as string;
        const imageUrl = parameters.image_url as string;
        if (!prompt) return { success: false, output: '', error: 'Missing required parameter: prompt', tool, parameters };
        if (!imageUrl) return { success: false, output: '', error: 'Missing required parameter: image_url', tool, parameters };

        const result = await callMinimaxApi(mmConfig.host, '/v1/coding_plan/vlm', { prompt, image_url: imageUrl }, mmConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
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
 * Create action log from tool result
 */
export function createActionLog(toolCall: ToolCall, result: ToolResult): ActionLog {
  const normalizedTool = normalizeToolName(toolCall.tool);

  const typeMap: Record<string, ActionLog['type']> = {
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    delete_file: 'delete',
    execute_command: 'command',
    search_code: 'search',
    list_files: 'list',
    create_directory: 'mkdir',
    find_files: 'search',
    fetch_url: 'fetch',
    web_search: 'fetch',
    web_read: 'fetch',
    github_read: 'fetch',
    minimax_web_search: 'fetch',
    minimax_understand_image: 'fetch',
  };

  const target = (toolCall.parameters.path as string) ||
    (toolCall.parameters.command as string) ||
    (toolCall.parameters.pattern as string) ||
    (toolCall.parameters.url as string) ||
    (toolCall.parameters.query as string) ||
    (toolCall.parameters.repo as string) ||
    'unknown';

  let details: string | undefined;
  if (result.success) {
    if (normalizedTool === 'write_file' && toolCall.parameters.content) {
      details = toolCall.parameters.content as string;
    } else if (normalizedTool === 'edit_file' && toolCall.parameters.new_text) {
      details = toolCall.parameters.new_text as string;
    } else if (normalizedTool === 'execute_command') {
      details = result.output.slice(0, 1000);
    } else {
      details = result.output.slice(0, 500);
    }
  } else {
    details = result.error;
  }

  return {
    type: typeMap[normalizedTool] || 'command',
    target,
    result: result.success ? 'success' : 'error',
    details,
    timestamp: Date.now(),
  };
}
