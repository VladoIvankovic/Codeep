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
 * Project shadows global shadows built-in, by name.
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

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

/** Parse `tools: [a, b]` or `tools: a, b` out of a frontmatter line value. */
function parseToolsValue(raw: string): string[] | undefined {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  const list = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Load custom agents from a `.codeep/agents/` directory. */
function loadFromDir(dir: string, scope: AgentScope): AgentDef[] {
  if (!existsSync(dir)) return [];
  const out: AgentDef[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const slug = entry.slice(0, -3).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
    try {
      const raw = readFileSync(join(dir, entry), 'utf8');
      if (raw.length > 64 * 1024) continue;
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const meta: Record<string, string> = {};
      let body = raw;
      if (fm) {
        body = fm[2];
        for (const line of fm[1].split('\n')) {
          const m = line.match(/^([a-zA-Z]+):\s*(.*)$/);
          if (m) meta[m[1].toLowerCase()] = m[2].trim();
        }
      }
      const displayName = meta.name || slug;
      const description = meta.description || `Custom agent from ${entry}`;
      const tools = meta.tools ? parseToolsValue(meta.tools) : undefined;
      const maxIterations = meta.maxiterations ? parseInt(meta.maxiterations, 10) : undefined;
      out.push({
        name: slug,
        displayName,
        description: description.length > 200 ? description.slice(0, 197) + '…' : description,
        prompt: body.trim(),
        tools,
        model: meta.model || undefined,
        personality: meta.personality || undefined,
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
  const project = workspaceRoot ? loadFromDir(join(workspaceRoot, '.codeep', 'agents'), 'project') : [];
  const global = loadFromDir(join(homedir(), '.codeep', 'agents'), 'global');
  const byName = new Map<string, AgentDef>();
  for (const a of BUILTIN) byName.set(a.name, a);
  for (const a of global) byName.set(a.name, a);
  for (const a of project) byName.set(a.name, a);
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
    const tools = a.tools ? `${a.tools.length} scoped` : 'all';
    lines.push(`| \`${a.name}\` | ${tag} | ${tools} | ${a.description} |`);
  }
  lines.push('', 'Add your own: drop a `<name>.md` with frontmatter (name, description, tools, model, personality) in `.codeep/agents/` (project) or `~/.codeep/agents/` (global).');
  return lines.join('\n');
}
