/**
 * Sub-agents — named, scoped agent definitions the main ("orchestrator") agent
 * can delegate work to via the `delegate` tool. Each runs as a NESTED agent
 * loop with its own fresh context window, an optional tool allowlist, an
 * optional model override, and a role system prompt — then returns only its
 * final summary to the parent. This keeps the parent's context small and lets
 * each sub-task run with a specialist persona.
 *
 * Storage (mirrors personalities/skills):
 *   - **Built-in**: hardcoded below (researcher, reviewer, tester).
 *   - **Project**: `<workspace>/.codeep/agents/<name>.md`
 *   - **Global**:  `~/.codeep/agents/<name>.md`
 * Project shadows global shadows built-in, by name. A project file that
 * shadows a built-in keeps at most the built-in's tools.
 *
 * File format — YAML-ish frontmatter + Markdown body (the role prompt):
 *   ```
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for correctness & security
 *   tools: [read_file, search_code, execute_command]   # allowlist; omit = all
 *   model: glm-5.2            # optional provider/model or model override
 *   personality: security     # optional — reuse a personality preset
 *   maxIterations: 15         # optional budget
 *   ---
 *   You are a senior reviewer. Find correctness & security issues…
 *   ```
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { leadsOutsideProject } from './projectPaths';

export type AgentScope = 'builtin' | 'project' | 'global';

export interface AgentDef {
  /** Slug (filename without .md, or built-in id). Lowercase, hyphens. */
  name: string;
  /** Human display label. */
  displayName: string;
  /** One-line description shown in the catalog + `/agents`. */
  description: string;
  /** Markdown body — the role system prompt for the sub-agent. */
  prompt: string;
  /** Tool allowlist. Undefined = inherit all of the parent's tools. */
  tools?: string[];
  /** Optional model override ("provider/model" or just "model"). */
  model?: string;
  /** Optional personality preset to layer on (by name). */
  personality?: string;
  /** Optional per-run iteration budget. */
  maxIterations?: number;
  scope: AgentScope;
}

const BUILTIN: AgentDef[] = [
  {
    name: 'planner',
    displayName: 'Planner',
    description: 'Read-only planner — investigates, then returns a concrete step-by-step implementation plan.',
    scope: 'builtin',
    tools: ['read_file', 'search_code', 'list_files', 'find_files'],
    prompt: `You are a planning sub-agent. Investigate, then produce a plan — do NOT write code or run commands.
- Read the relevant files to ground the plan in how the code actually works.
- Return a concise, numbered, step-by-step plan: each step names the file(s) to touch and what changes.
- Call out risks, assumptions, and anything the implementer must verify.
- Keep it actionable — the implementer will follow it directly. No code, just the plan.`,
  },
  {
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Read-only explorer — digs through the codebase / web and returns a tight summary.',
    scope: 'builtin',
    tools: ['read_file', 'search_code', 'list_files', 'find_files', 'web_search', 'web_read', 'fetch_url'],
    prompt: `You are a research sub-agent. Your job is to investigate and report — never modify anything.
- Explore the codebase (and the web when relevant) to answer the task precisely.
- You CANNOT write or edit files or run commands — read and search only.
- Return a tight, structured summary: the answer first, then the specific files/lines/sources that back it up.
- Omit dead ends. The caller only sees your final message, so make it self-contained.`,
  },
  {
    name: 'reviewer',
    displayName: 'Reviewer',
    description: 'Read-only senior review — finds correctness, security, and design issues.',
    scope: 'builtin',
    tools: ['read_file', 'search_code', 'list_files', 'find_files', 'execute_command'],
    personality: 'security',
    prompt: `You are a senior code-review sub-agent. Review only — do not change code.
- Read the relevant files (and run read-only git/inspection commands) to understand the change in context.
- Report concrete issues grouped by severity: correctness/bugs, security, then design/naming/tests.
- Cite file:line for each finding and suggest the fix in one sentence.
- If it's solid, say so briefly — don't invent problems.`,
  },
  {
    name: 'tester',
    displayName: 'Tester',
    description: 'Writes and runs tests for a target, then reports pass/fail.',
    scope: 'builtin',
    tools: ['read_file', 'write_file', 'edit_file', 'search_code', 'list_files', 'find_files', 'execute_command'],
    prompt: `You are a testing sub-agent. Write focused tests for the target and run them.
- Match the project's existing test framework and conventions (look at neighbouring tests first).
- Cover the happy path plus the obvious edge cases; don't over-test.
- Run the tests and iterate until they pass (or you've found a real bug — then report it).
- Final message: what you added, the command to run them, and the pass/fail result.`,
  },
];

/** Largest agent file we'll read (64 KB). */
const MAX_AGENT_FILE_BYTES = 64 * 1024;

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');

/** Drop a YAML trailing comment (`read_file  # safe`) from an unquoted value. */
const uncomment = (s: string): string => s.replace(/(^|\s)#.*$/, '');

/**
 * Parse a `tools:` value: `[a, b]`, `a, b`, or a YAML block list. A key that
 * is present always yields a list, possibly empty. Only an absent key means
 * "all tools", so a value we can't read denies tools rather than granting
 * every one of them.
 */
function parseToolsValue(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw.map(unquote).filter(Boolean);
  const inline = raw.trim().match(/^\[([^\]]*)\]/);
  const inner = inline ? inline[1] : uncomment(raw);
  return inner.split(',').map(unquote).filter(Boolean);
}

/**
 * Split an agent file into lowercase frontmatter keys and the body. A key
 * with an empty value collects the `- item` lines under it. Returns null when
 * the file opens a frontmatter fence that never closes: dropping the file is
 * safer than reading its `tools:` line as part of the prompt.
 */
function parseAgentFile(raw: string): { meta: Record<string, string | string[]>; body: string } | null {
  // Windows editors save CRLF and some prepend a BOM; neither may cost the
  // file its frontmatter. Nor may a blank line above the opening fence: read
  // as body, the `tools:` line would be dropped and every tool allowed.
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+(?=---)/, '');
  const meta: Record<string, string | string[]> = {};
  if (!/^---[ \t]*\n/.test(text)) return { meta, body: text };
  // An empty block (`---` twice) is checked first: the general pattern would
  // take a later `---` rule in the body as the closing fence.
  const fm = text.match(/^---[ \t]*\n()---[ \t]*(?:\n([\s\S]*))?$/)
    ?? text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/);
  if (!fm) return null;
  let list: string[] | null = null;
  for (const line of fm[1].split('\n')) {
    // YAML lets a blank line or a comment line sit inside a block list
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && list) {
      list.push(uncomment(item[1]));
      continue;
    }
    list = null;
    const m = line.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
    if (!m) continue;
    // `tools:  # read-only` is an empty value with a comment; the list follows.
    const value = m[2].trim().startsWith('#') ? '' : m[2].trim();
    if (value) {
      meta[m[1].toLowerCase()] = value;
    } else {
      list = [];
      meta[m[1].toLowerCase()] = list;
    }
  }
  return { meta, body: fm[2] ?? '' };
}

const str = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Load custom agents from a `.codeep/agents/` directory. */
function loadFromDir(dir: string, scope: AgentScope, projectRoot?: string): AgentDef[] {
  if (!existsSync(dir)) return [];
  const out: AgentDef[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const slug = entry.slice(0, -3).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
    try {
      const file = join(dir, entry);
      // A project's files come with the repo: a link out of it would put an
      // arbitrary file of the user's (credentials, history) into the prompt.
      if (projectRoot && leadsOutsideProject(file, projectRoot)) continue;
      // statSync follows symlinks: a committed link to /dev/zero or a FIFO
      // never comes back from readFileSync, so check kind and size first.
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_AGENT_FILE_BYTES) continue;
      const parsed = parseAgentFile(readFileSync(file, 'utf8'));
      if (!parsed) continue;
      const { meta, body } = parsed;
      const displayName = str(meta.name) || slug;
      const description = str(meta.description) || `Custom agent from ${entry}`;
      const tools = meta.tools !== undefined ? parseToolsValue(meta.tools) : undefined;
      const iterations = str(meta.maxiterations);
      const maxIterations = iterations ? parseInt(iterations, 10) : undefined;
      out.push({
        name: slug,
        displayName,
        description: description.length > 200 ? description.slice(0, 197) + '…' : description,
        prompt: body.trim(),
        tools,
        model: str(meta.model),
        personality: str(meta.personality),
        maxIterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
        scope,
      });
    } catch {
      // Skip broken files — never crash agent loading.
    }
  }
  return out;
}

export function loadAgents(workspaceRoot?: string): AgentDef[] {
  const project = workspaceRoot ? loadFromDir(join(workspaceRoot, '.codeep', 'agents'), 'project', workspaceRoot) : [];
  const global = loadFromDir(join(homedir(), '.codeep', 'agents'), 'global');
  const byName = new Map<string, AgentDef>();
  for (const a of BUILTIN) byName.set(a.name, a);
  for (const a of global) byName.set(a.name, a);
  for (const a of project) {
    // A cloned repo can replace a built-in's prompt, but not hand it more
    // tools than it ships with: auto-review delegates to `reviewer` after
    // every write, so that allowlist must hold whatever `.codeep/agents/` says.
    const builtin = BUILTIN.find((b) => b.name === a.name);
    if (builtin?.tools) {
      const allowed = builtin.tools;
      a.tools = a.tools ? a.tools.filter((t) => allowed.includes(t)) : [...allowed];
    }
    byName.set(a.name, a);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(name: string, workspaceRoot?: string): AgentDef | null {
  const lower = name.toLowerCase();
  return loadAgents(workspaceRoot).find((a) => a.name === lower) ?? null;
}

/**
 * The catalog block appended to the orchestrator's system prompt so the model
 * knows which sub-agents it can `delegate` to. Empty string is never returned
 * (built-ins always exist), but callers can choose not to inject it.
 */
export function formatAgentsForSysprompt(agents: AgentDef[]): string {
  if (agents.length === 0) return '';
  const lines = [
    '\n\n## Sub-agents (delegation)',
    'You can delegate a self-contained sub-task to a specialist sub-agent with the `delegate` tool. It runs in its own fresh context and returns only a summary — use it to keep your own context focused (e.g. send a researcher to explore, a reviewer to critique, a tester to write tests). Available agents:',
    '',
  ];
  for (const a of agents) lines.push(`- \`${a.name}\` — ${a.description}`);
  lines.push('', 'Call `delegate({ "agent": "<name>", "task": "<clear, self-contained instruction>" })`. Omit `agent` for a general-purpose sub-agent. Do the work yourself for small/quick tasks — delegation has overhead.');
  return lines.join('\n');
}

/** `/agents` list view (mirrors formatPersonalityList). */
export function formatAgentList(workspaceRoot?: string): string {
  const list = loadAgents(workspaceRoot);
  const lines: string[] = ['## Sub-agents', '', 'The agent can `delegate` self-contained sub-tasks to these. Each runs in its own context and returns a summary.', '', '| Name | Scope | Tools | Description |', '|---|---|---|---|'];
  for (const a of list) {
    const tag = a.scope === 'builtin' ? 'built-in' : a.scope;
    const tools = !a.tools ? 'all' : a.tools.length ? `${a.tools.length} scoped` : 'none';
    lines.push(`| \`${a.name}\` | ${tag} | ${tools} | ${a.description} |`);
  }
  lines.push('', 'Add your own: drop a `<name>.md` with frontmatter (name, description, tools, model, personality) in `.codeep/agents/` (project) or `~/.codeep/agents/` (global).');
  return lines.join('\n');
}
