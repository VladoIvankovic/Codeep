/**
 * Custom slash commands.
 *
 * Users drop `.md` files in either:
 *   - `<workspace>/.codeep/commands/<name>.md`  (project-scoped)
 *   - `~/.codeep/commands/<name>.md`            (global, all projects)
 *
 * Each file becomes a `/<name>` slash command. Project files take precedence
 * over global files with the same name.
 *
 * File format (frontmatter optional):
 *
 *   ---
 *   description: Detailed security review of a file
 *   aliases: [sec, secrev]
 *   ---
 *
 *   Please perform a thorough security review of: {{args}}
 *
 * The body is expanded with the user's arguments and sent as a user message
 * to the agent. Placeholders supported:
 *   - `{{args}}` and `$ARGUMENTS` — full args string (Claude Code compat)
 *   - `{{arg1}}` … `{{argN}}`     — positional args (1-indexed)
 *
 * Custom commands are not invoked automatically — they only fire when the
 * user types `/<name>`. The agent never sees them in its tool catalog.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CustomCommand {
  /** Slash name without the leading `/` */
  name: string;
  /** One-line description for /help and ACP autocomplete */
  description: string;
  /** Body text after frontmatter, with placeholders unresolved */
  body: string;
  /** Filesystem path the command was loaded from */
  source: string;
  /** 'project' if loaded from <workspace>/.codeep/commands, else 'global' */
  scope: 'project' | 'global';
  /** Optional alternative names that also trigger this command */
  aliases: string[];
}

interface ParsedFrontmatter {
  description?: string;
  aliases?: string[];
}

/**
 * Minimal YAML frontmatter parser — handles `key: value` and
 * `key: [a, b, c]`. We deliberately avoid a YAML dependency because the
 * surface area we care about is tiny.
 */
function parseFrontmatter(raw: string): { meta: ParsedFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: ParsedFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let value: string | string[] = kv[2];
    const arr = value.match(/^\[(.*)\]$/);
    if (arr) {
      value = arr[1]
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    if (key === 'description' && typeof value === 'string') meta.description = value;
    if (key === 'aliases' && Array.isArray(value)) meta.aliases = value;
  }
  return { meta, body: match[2].trimStart() };
}

function loadFromDir(dir: string, scope: 'project' | 'global'): CustomCommand[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const commands: CustomCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      // Sanity ceiling — a slash-command template above 64KB is almost
      // certainly someone dumping a doc in the wrong folder.
      if (stat.size > 65_536) continue;
      const raw = readFileSync(fullPath, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      const name = entry.replace(/\.md$/, '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue; // names match `/foo-bar`
      commands.push({
        name,
        description: meta.description ?? `Custom ${scope} command`,
        body: body.trim(),
        source: fullPath,
        scope,
        aliases: (meta.aliases ?? []).map(a => a.toLowerCase()).filter(a => /^[a-z0-9][a-z0-9-]*$/.test(a)),
      });
    } catch {
      // Skip unreadable / malformed files silently — they shouldn't block
      // the rest of the catalog from loading.
    }
  }
  return commands;
}

/**
 * Load all custom commands available in this workspace.
 * Project commands shadow global commands with the same name.
 */
export function loadCustomCommands(workspaceRoot?: string): CustomCommand[] {
  const global = loadFromDir(join(homedir(), '.codeep', 'commands'), 'global');
  const project = workspaceRoot
    ? loadFromDir(join(workspaceRoot, '.codeep', 'commands'), 'project')
    : [];

  // Project wins on name collisions; collapse to a single map keyed by name.
  const byName = new Map<string, CustomCommand>();
  for (const cmd of global) byName.set(cmd.name, cmd);
  for (const cmd of project) byName.set(cmd.name, cmd);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a user-typed slash name to a custom command, checking primary
 * name first then aliases. Project scope wins over global on collisions
 * (handled inside loadCustomCommands).
 */
export function findCustomCommand(name: string, workspaceRoot?: string): CustomCommand | null {
  const lower = name.toLowerCase();
  const all = loadCustomCommands(workspaceRoot);
  return all.find(c => c.name === lower || c.aliases.includes(lower)) ?? null;
}

/**
 * Expand `{{args}}`, `$ARGUMENTS`, and `{{argN}}` placeholders in the
 * command body. If the body has no placeholders, the args are appended
 * on a new line so the agent still sees them.
 */
export function expandCommand(cmd: CustomCommand, args: string[]): string {
  const joined = args.join(' ');
  const hasPlaceholder = /\{\{args\}\}|\$ARGUMENTS|\{\{arg\d+\}\}/.test(cmd.body);

  let expanded = cmd.body
    .replace(/\{\{args\}\}/g, joined)
    .replace(/\$ARGUMENTS/g, joined);

  // Positional: {{arg1}}, {{arg2}}, ...
  expanded = expanded.replace(/\{\{arg(\d+)\}\}/g, (_m, n) => {
    const idx = parseInt(n, 10) - 1;
    return args[idx] ?? '';
  });

  if (!hasPlaceholder && joined) {
    expanded += `\n\n${joined}`;
  }
  return expanded;
}

/**
 * Render the catalog as a Markdown block for `/commands`.
 */
export function formatCommandList(commands: CustomCommand[]): string {
  if (!commands.length) {
    return [
      '_No custom commands yet._',
      '',
      'Create one by adding a Markdown file:',
      '',
      '- `<workspace>/.codeep/commands/<name>.md` — project-scoped',
      '- `~/.codeep/commands/<name>.md` — global (all projects)',
      '',
      'Example:',
      '',
      '```markdown',
      '---',
      'description: Detailed security review of a file',
      '---',
      '',
      'Please perform a thorough security review of: {{args}}',
      '```',
      '',
      'Then call it as `/<name> <args>`.',
    ].join('\n');
  }

  const projectCmds = commands.filter(c => c.scope === 'project');
  const globalCmds = commands.filter(c => c.scope === 'global');

  const lines = ['## Custom Commands', ''];
  if (projectCmds.length) {
    lines.push('**Project**');
    for (const c of projectCmds) {
      const aliasNote = c.aliases.length ? ` (aliases: ${c.aliases.map(a => `\`/${a}\``).join(', ')})` : '';
      lines.push(`- \`/${c.name}\`${aliasNote} — ${c.description}`);
    }
    lines.push('');
  }
  if (globalCmds.length) {
    lines.push('**Global**');
    for (const c of globalCmds) {
      const aliasNote = c.aliases.length ? ` (aliases: ${c.aliases.map(a => `\`/${a}\``).join(', ')})` : '';
      lines.push(`- \`/${c.name}\`${aliasNote} — ${c.description}`);
    }
  }
  return lines.join('\n');
}
