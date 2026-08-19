/**
 * Tool execution - runs agent tool calls against the filesystem and shell.
 *
 * validatePath() ensures all file operations stay within the project root.
 * executeTool() dispatches to individual tool handlers.
 * listDirectory() and htmlToText() are private helpers.
 * createActionLog() converts a ToolCall+ToolResult into a history ActionLog.
 */

import { existsSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, realpathSync } from 'fs';
import { join, dirname, relative, resolve, isAbsolute, sep } from 'path';
import { executeCommandAsync } from './shell';
import { recordWrite, recordEdit, recordDelete, recordMkdir, recordCommand } from './history';
import { loadIgnoreRules, isIgnored } from './gitignore';
import { normalizeToolName } from './toolParsing';
import { getZaiMcpConfig, getZaiVisionConfig, getMinimaxMcpConfig, callZaiMcp, callZaiVisionApi, callMinimaxApi } from './mcpIntegration';
import { ToolCall, ToolResult, ActionLog } from './tools';
import { logger } from './logger';
import { runHook } from './hooks';
import { checkCommandRateLimit } from './ratelimit';
import { isMcpToolName, callSessionTool, isVirtualMcpToolName, callSessionVirtualTool } from './mcpRegistry';
// SSRF guard (isBlockedIp / assertFetchUrlAllowed) moved to ./ssrfGuard —
// shared with shell.ts for curl/wget URL checks. Re-exported here so the
// existing tests that import it from toolExecution keep working.
export { isBlockedIp, assertFetchUrlAllowed } from './ssrfGuard';
import { assertFetchUrlAllowed } from './ssrfGuard';

const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

/**
 * Validate path is within project root.
 * Uses realpathSync to resolve symlinks, preventing symlink traversal attacks
 * where a symlink inside the project could point to files outside it.
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

  // Resolve the deepest existing ancestor, not only the complete target. A
  // write to `project/link-to-outside/new.txt` has a non-existent leaf, but
  // still follows the existing symlinked parent. lstat is intentional: unlike
  // existsSync it also sees a broken symlink, which must fail closed rather
  // than be followed by writeFileSync.
  try {
    const realRoot = realpathSync(projectRoot);
    let existingAncestor = absolutePath;
    while (true) {
      try {
        lstatSync(existingAncestor);
        break;
      } catch {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) {
          return { valid: false, absolutePath, error: `Path '${path}' could not be resolved` };
        }
        existingAncestor = parent;
      }
    }

    const realAncestor = realpathSync(existingAncestor);
    const ancestorRelative = relative(realRoot, realAncestor);
    if (ancestorRelative === '..' || ancestorRelative.startsWith(`..${sep}`) || isAbsolute(ancestorRelative)) {
      return { valid: false, absolutePath, error: `Path '${path}' resolves outside project directory (symlink traversal)` };
    }
  } catch {
    // realpathSync fails for broken symlinks and inaccessible ancestors.
    return { valid: false, absolutePath, error: `Path '${path}' could not be resolved` };
  }

  return { valid: true, absolutePath };
}

/**
 * List directory contents, respecting .gitignore rules.
 * Tracks visited inodes to prevent infinite loops caused by circular symlinks.
 */
function listDirectory(
  dir: string,
  projectRoot: string,
  recursive: boolean,
  prefix: string = '',
  ignoreRules?: ReturnType<typeof loadIgnoreRules>,
  visitedInodes: Set<number> = new Set()
): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  const rules = ignoreRules || loadIgnoreRules(projectRoot);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (isIgnored(fullPath, rules)) continue;

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      try {
        // Recursive listing must not follow an in-workspace symlink into an
        // external directory. Top-level paths already pass validatePath, but
        // each discovered symlink needs the same boundary check.
        if (entry.isSymbolicLink() && !validatePath(fullPath, projectRoot).valid) continue;
        const st = statSync(fullPath); // follows symlinks
        if (st.isDirectory()) {
          if (visitedInodes.has(st.ino)) continue; // circular symlink — skip
          files.push(`${prefix}${entry.name}/`);
          if (recursive) {
            visitedInodes.add(st.ino);
            files.push(...listDirectory(fullPath, projectRoot, true, prefix + '  ', rules, visitedInodes));
            visitedInodes.delete(st.ino);
          }
        } else {
          files.push(`${prefix}${entry.name}`);
        }
      } catch {
        // Broken symlink or permission error — skip silently
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
 * Optional filesystem delegation. When an ACP client advertises `fs`
 * capability (Zed always does, VS Code may), the server should route
 * read/write through the client instead of touching disk directly — that
 * way the client's unsaved buffers, undo history, and virtual filesystems
 * stay authoritative. Callbacks must already use absolute paths.
 */
export interface FsCallbacks {
  readTextFile?: (absolutePath: string) => Promise<string>;
  writeTextFile?: (absolutePath: string, content: string) => Promise<void>;
}

/**
 * Execute a tool call and return the result.
 *
 * `fs` is optional — if provided and the relevant method is defined, file
 * read/write is delegated to the client. Otherwise we fall back to direct
 * disk I/O. A delegated call that throws also falls back to disk so a
 * single client hiccup doesn't kill the agent loop.
 */
export async function executeTool(
  toolCall: ToolCall,
  projectRoot: string,
  fs?: FsCallbacks,
  mcpSessionId?: string,
): Promise<ToolResult> {
  const tool = normalizeToolName(toolCall.tool);
  const parameters = toolCall.parameters;

  debug(`Executing tool: ${tool}`, parameters.path || parameters.command || '');

  // pre_tool_call hook runs first, even for MCP tools. A `pre_tool_call`
  // script is the policy gate (block writes to certain dirs, refuse risky
  // commands, deny outbound calls to specific MCP servers, etc.), so
  // letting MCP traffic bypass it would defeat the gate's purpose.
  // Failing closed is the safe default.
  const preHook = runHook({ event: 'pre_tool_call', workspaceRoot: projectRoot, toolName: tool, toolParams: parameters });
  if (preHook.blocked) {
    const msg = preHook.stderr?.trim() || preHook.stdout?.trim() || `pre_tool_call hook exited ${preHook.exitCode}`;
    return {
      success: false,
      output: '',
      error: `Blocked by pre_tool_call hook: ${msg}`,
      tool,
      parameters,
    };
  }

  // MCP-prefixed tool names (`<server>__<tool>`) route through the
  // per-session MCP registry. We still fire on_error so logging hooks
  // see MCP failures the same way they see built-in failures, but skip
  // post_edit — MCP tools aren't file-edit operations in the local sense
  // (they may do anything; we don't have enough info to call it an edit).
  //
  // IMPORTANT: lookup uses the RAW tool name from the model, not the
  // normalized one. `normalizeToolName` lowercases and converts hyphens
  // to underscores — fine for built-in tools, but it mangles MCP server
  // names that legitimately contain hyphens (e.g. `my-fs__read_file`
  // would become `my_fs__read_file` and miss the registry lookup).
  const rawTool = toolCall.tool;

  // invoke_skill — agent-driven skill bundle invocation. Returns the
  // bundle's SKILL.md body so the agent can read its instructions in
  // the next iteration. Project-scoped bundles win over global.
  if (rawTool === 'invoke_skill') {
    const name = String((parameters as Record<string, unknown>).name ?? '').trim();
    if (!name) {
      return { success: false, output: '', error: 'invoke_skill requires a `name` argument', tool: rawTool, parameters };
    }
    try {
      const { findSkillBundle } = await import('./skillBundles');
      const bundle = findSkillBundle(name, projectRoot);
      if (!bundle) {
        return { success: false, output: '', error: `Skill "${name}" not found. Use the catalog in your system prompt or ask the user to /skills bundles.`, tool: rawTool, parameters };
      }
      // Prefix the body with a header so the model sees clear framing.
      const output = `# Skill: ${bundle.name}\n_${bundle.description}_\n\n${bundle.body}`;
      return { success: true, output, tool: rawTool, parameters };
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message, tool: rawTool, parameters };
    }
  }

  if (isMcpToolName(rawTool) && mcpSessionId) {
    let result: ToolResult;
    try {
      // Virtual wrappers (resource_list / resource_read / prompt_list /
      // prompt_get) live in mcpRegistry alongside the real tools. We
      // dispatch them through their own helper so the registry stays the
      // single source of truth for what's namespaced under each server.
      const output = isVirtualMcpToolName(rawTool)
        ? await callSessionVirtualTool(mcpSessionId, rawTool, parameters)
        : await callSessionTool(mcpSessionId, rawTool, parameters);
      result = { success: true, output, tool: rawTool, parameters };
    } catch (err) {
      result = { success: false, output: '', error: (err as Error).message, tool: rawTool, parameters };
    }
    if (!result.success) {
      runHook({ event: 'on_error', workspaceRoot: projectRoot, toolName: rawTool, toolParams: parameters });
    }
    return result;
  }

  // Wrap the original dispatch so we can run on_error / post_edit hooks
  // around it without indenting every case.
  const result = await dispatchTool(tool, parameters, projectRoot, fs, toolCall);

  if (!result.success) {
    runHook({
      event: 'on_error',
      workspaceRoot: projectRoot,
      toolName: tool,
      toolParams: parameters,
    });
  } else if (tool === 'write_file' || tool === 'edit_file') {
    const filePath = parameters.path as string | undefined;
    if (filePath) {
      const abs = isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
      // post_edit is advisory — non-zero exit doesn't roll back the write.
      // Typical use is `prettier --write "$CODEEP_HOOK_FILE"`.
      runHook({
        event: 'post_edit',
        workspaceRoot: projectRoot,
        toolName: tool,
        filePath: abs,
      });
    }
  }

  return result;
}

async function dispatchTool(
  tool: string,
  parameters: Record<string, unknown>,
  projectRoot: string,
  fs: FsCallbacks | undefined,
  toolCall: ToolCall,
): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'read_file': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        // Try client delegation first. The client owns the source of truth
        // for unsaved buffers, so we prefer it even if the file also exists
        // on disk. The 100 KB cap below is enforced on the delegated result
        // too — a malicious or misconfigured client could otherwise return
        // an arbitrarily large blob that blows up the agent's context.
        if (fs?.readTextFile) {
          try {
            const content = await fs.readTextFile(validation.absolutePath);
            // Cap is on character count, not raw bytes — JS strings are
            // UTF-16 in memory, so 100K chars ≈ 200K bytes of process
            // memory plus whatever the model context costs. Either way,
            // a 1GB blob from a misbehaving client gets rejected here.
            if (content.length > 100 * 1024) {
              return { success: false, output: '', error: `File too large (${content.length} chars via client). Max: 100K chars`, tool, parameters };
            }
            return { success: true, output: content, tool, parameters };
          } catch (err) {
            debug('fs/read_text_file delegation failed, falling back to disk:', err);
            // fall through to disk read
          }
        }

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
          debug('write_file failed: content was undefined');
          return { success: false, output: '', error: 'File content was empty or truncated by the API. Try writing a smaller file or splitting into multiple writes.', tool, parameters };
        }

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        // Client delegation: lets editors keep dirty buffers, undo history,
        // and lint-on-save reactions consistent. The client is responsible
        // for creating parent directories — VS Code's WorkspaceEdit does;
        // for the disk fallback below we do it ourselves.
        if (fs?.writeTextFile) {
          try {
            const existed = existsSync(validation.absolutePath);
            await fs.writeTextFile(validation.absolutePath, content);
            // Only record after the write actually succeeded — otherwise a
            // failed delegation that falls through to disk would double-log.
            recordWrite(validation.absolutePath);
            return { success: true, output: `${existed ? 'Updated' : 'Created'} file: ${path}`, tool, parameters };
          } catch (err) {
            debug('fs/write_text_file delegation failed, falling back to disk:', err);
            // fall through to disk write
          }
        }

        const dir = dirname(validation.absolutePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const existed = existsSync(validation.absolutePath);
        writeFileSync(validation.absolutePath, content, 'utf-8');
        recordWrite(validation.absolutePath);
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

        // Read through the client when delegation is available — the dirty
        // buffer in the editor is the authoritative version for an edit.
        let content: string;
        let readDelegated = false;
        if (fs?.readTextFile) {
          try {
            content = await fs.readTextFile(validation.absolutePath);
            readDelegated = true;
          } catch (err) {
            debug('fs/read_text_file (in edit_file) failed, falling back to disk:', err);
            if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };
            content = readFileSync(validation.absolutePath, 'utf-8');
          }
        } else {
          if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };
          content = readFileSync(validation.absolutePath, 'utf-8');
        }

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
        // Function replacer so newText is written literally — a plain-string
        // replacement interprets $&, $1, $$ etc., which silently corrupts any
        // edit whose new_text contains `$` (shell vars, template literals, regex).
        const updated = content.replace(oldText, () => newText);

        if (fs?.writeTextFile) {
          try {
            await fs.writeTextFile(validation.absolutePath, updated);
            return { success: true, output: `Edited file: ${path}`, tool, parameters };
          } catch (err) {
            debug('fs/write_text_file (in edit_file) failed, falling back to disk:', err);
            // If we read through the client but write back to disk, the
            // editor's dirty buffer could be discarded next save. Log and
            // continue — better than silently dropping the edit.
            if (readDelegated) debug('warning: edit_file read via client but writing to disk');
          }
        }
        writeFileSync(validation.absolutePath, updated, 'utf-8');
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

        // Command throttle — guards against agent loops that spawn commands
        // every iteration (each can be up to 2 minutes of subprocess time).
        // Rate-limited *after* permission resolution: an allowed command
        // consumes budget, a denied one never reaches here.
        const cmdRate = checkCommandRateLimit();
        if (!cmdRate.allowed) {
          return { success: false, output: '', error: cmdRate.message || 'Command rate limit exceeded', tool, parameters };
        }

        recordCommand(command, args);

        const result = await executeCommandAsync(command, args, {
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

        const result = await executeCommandAsync('grep', ['-rn', '--include=*.{ts,tsx,js,jsx,json,md,css,html,py,go,rs,rb,kt,kts,swift,php,java,cs,c,cpp,h,hpp,vue,svelte,yaml,yml,toml,sh,sql,xml,scss,less}', pattern, validation.absolutePath], {
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

        const result = await executeCommandAsync('find', findArgs, { cwd: projectRoot, projectRoot, timeout: 15000 });

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

        const blockedReason = await assertFetchUrlAllowed(url);
        if (blockedReason) return { success: false, output: '', error: blockedReason, tool, parameters };

        // Restrict to http/https on the initial request AND redirects, and cap
        // redirect hops — defends against protocol-smuggling and limits
        // redirect-based SSRF reach (initial host is already IP-checked above).
        const result = await executeCommandAsync('curl', ['-s', '-L', '--proto', '=http,https', '--proto-redir', '=http,https', '--max-redirs', '5', '-m', '30', '-A', 'Codeep/1.0', '--max-filesize', '1000000', url], {
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

      case 'zai_analyze_image': {
        const zaiVisionConfig = getZaiVisionConfig();
        if (!zaiVisionConfig) return { success: false, output: '', error: 'zai_analyze_image requires a Z.AI API key. Configure one via /provider z.ai-api', tool, parameters };

        const prompt = parameters.prompt as string;
        const imageUrl = parameters.image_url as string;
        if (!prompt) return { success: false, output: '', error: 'Missing required parameter: prompt', tool, parameters };
        if (!imageUrl) return { success: false, output: '', error: 'Missing required parameter: image_url', tool, parameters };

        const result = await callZaiVisionApi(zaiVisionConfig.baseUrl, zaiVisionConfig.apiKey, prompt, imageUrl);
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
