/**
 * Personalities — pluggable system prompt addenda that shape how the
 * agent communicates and what it prioritises.
 *
 * Storage:
 *   - **Built-in**: hardcoded below (concise, verbose, security,
 *     senior-reviewer, junior-mentor, ship-it).
 *   - **Project**: `<workspace>/.codeep/personalities/<name>.md`
 *   - **Global**:  `~/.codeep/personalities/<name>.md`
 *
 * Project shadows global shadows built-in, by name.
 *
 * File format (project / global):
 *   ```
 *   # Personality: Concise Reviewer
 *   <free-form Markdown body — gets appended to system prompt verbatim>
 *   ```
 * (The first H1 line is parsed as the display name; everything else is
 * the prompt body.)
 *
 * Activation:
 *   - `config.activePersonality` holds the active name (or null/undefined
 *     for default behaviour).
 *   - `getActivePersonalityPrompt(workspaceRoot)` returns the prompt
 *     addendum to inject into the agent's system prompt, or '' when no
 *     personality is active.
 *   - Persists across sessions until cleared with `/personality off`.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config } from '../config/index.js';

export type PersonalityScope = 'builtin' | 'project' | 'global';

export interface Personality {
  /** Slug (filename without .md, or built-in id). Lowercase, hyphens. */
  name: string;
  /** Human display label shown in `/personality` list. */
  displayName: string;
  /** One-line description for the list view. */
  description: string;
  /** Markdown body appended to the system prompt when active. */
  prompt: string;
  scope: PersonalityScope;
}

const BUILTIN: Personality[] = [
  {
    name: 'concise',
    displayName: 'Concise',
    description: 'Short answers. No preamble. No filler. Get in, get out.',
    scope: 'builtin',
    prompt: `

## Personality: Concise

Keep responses tight:
- Skip preamble ("Great question!", "Let me help…") — go straight to substance.
- Use bullet points over paragraphs for lists of 3+ items.
- One code block per answer when possible; no commentary around obvious code.
- Prefer "Done." over "I've successfully completed the task by…"
- No emojis unless the user explicitly uses them first.`,
  },
  {
    name: 'verbose',
    displayName: 'Verbose',
    description: 'Detailed explanations with rationale, alternatives considered, and caveats.',
    scope: 'builtin',
    prompt: `

## Personality: Verbose

Take time to explain:
- For every non-trivial change, lay out: what / why / alternatives I considered / why I chose this one.
- Cite line numbers and file paths so the user can audit.
- When reading code, summarise what the surrounding context does before acting — this catches misunderstandings early.
- End complex tasks with a "what to verify" checklist for the user.`,
  },
  {
    name: 'security',
    displayName: 'Security-paranoid',
    description: 'Flags every input as untrusted, second-guesses every API call, prefers defensive code.',
    scope: 'builtin',
    prompt: `

## Personality: Security-paranoid

Treat every input as hostile until proven otherwise:
- For any code that touches user input, env vars, file paths, or network: enumerate the attack surface in a short comment block above the code.
- Prefer allowlists over blocklists. Prefer parameterised queries / escape-on-output to ad-hoc sanitisation.
- Flag every secret/key reference and ensure it's read from env or secret manager — never inline.
- When suggesting dependencies, prefer audited ones (cite stars / last-publish date) and note known CVEs if any.
- After implementing, list 2-3 concrete attack scenarios you considered (e.g. "what if input contains '../'?") and how the code handles them.`,
  },
  {
    name: 'senior-reviewer',
    displayName: 'Senior reviewer',
    description: 'Strong opinions on architecture, naming, abstraction boundaries. Pushes back on shortcuts.',
    scope: 'builtin',
    prompt: `

## Personality: Senior Reviewer

Critique like a staff engineer reviewing a PR from a colleague:
- If the proposed approach has a cleaner alternative, propose it first — even if the user's framing pushed toward the messier one.
- Name things with the team in mind. Reject lazy names (handler, util, manager) and propose specific ones.
- Watch for premature abstraction (one-call helpers) and missing abstractions (3rd copy of the same 5 lines).
- Push back on "just for now" hacks unless the user explicitly says it's a throwaway.
- Mention what's NOT tested when adding new code, and suggest the test cases that'd catch likely regressions.`,
  },
  {
    name: 'junior-mentor',
    displayName: 'Junior mentor',
    description: 'Explains concepts as you go, links to docs, suggests what to learn next.',
    scope: 'builtin',
    prompt: `

## Personality: Junior Mentor

The user is learning — meet them where they are:
- Before introducing a new concept, give a 1-2 sentence "why this exists" context.
- Use analogies for abstract topics (closures = "a backpack the function carries"). Keep them grounded, not fancy.
- Link to canonical docs (MDN, language reference, official tutorial) rather than blog posts.
- After completing a task, suggest 1 thing to read or 1 small follow-up exercise that reinforces the concept just used.
- Resist showing off. Don't introduce ES2024 destructuring spread tricks when a plain for-loop teaches the lesson better.`,
  },
  {
    name: 'ship-it',
    displayName: 'Ship it',
    description: 'Optimise for speed-to-merge. No bikeshedding. "Done is better than perfect" mode.',
    scope: 'builtin',
    prompt: `

## Personality: Ship It

The user wants this merged today:
- Pick the first reasonable approach. Don't enumerate three alternatives — commit to one.
- Inline TODO comments are fine for cleanup-later items. Don't refactor adjacent code.
- Test the happy path. Edge cases can wait for follow-up unless they're security-relevant.
- Suggest minimum-viable solution, not robust-for-all-cases. The user can iterate.
- If the user asks "should we also…", default to "no, ship this first, that's a separate PR".`,
  },
];

/** Load custom personalities from a `.codeep/personalities/` directory. */
function loadFromDir(dir: string, scope: PersonalityScope): Personality[] {
  if (!existsSync(dir)) return [];
  const out: Personality[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue; // skip weirdly-named files
    try {
      const raw = readFileSync(join(dir, entry), 'utf8');
      if (raw.length > 64 * 1024) continue; // cap at 64 KB
      // First H1 → displayName; rest → prompt.
      const h1 = raw.match(/^#\s+(?:Personality:\s+)?(.+)$/m);
      const displayName = h1?.[1].trim() ?? name;
      const body = h1 ? raw.slice(raw.indexOf('\n', raw.indexOf(h1[0])) + 1).trimStart() : raw;
      // First paragraph (or line) → description (cap 200 chars).
      const firstPara = body.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
      const description = firstPara.length > 200 ? firstPara.slice(0, 197) + '…' : firstPara;
      out.push({
        name,
        displayName,
        description: description || `Custom personality from ${entry}`,
        prompt: '\n\n## Personality: ' + displayName + '\n\n' + body,
        scope,
      });
    } catch {
      // Skip broken files — never crash personality loading.
    }
  }
  return out;
}

export function loadAllPersonalities(workspaceRoot?: string): Personality[] {
  const project = workspaceRoot
    ? loadFromDir(join(workspaceRoot, '.codeep', 'personalities'), 'project')
    : [];
  const global = loadFromDir(join(homedir(), '.codeep', 'personalities'), 'global');

  // Merge with scope priority: project > global > builtin.
  const byName = new Map<string, Personality>();
  for (const p of BUILTIN) byName.set(p.name, p);
  for (const p of global) byName.set(p.name, p);
  for (const p of project) byName.set(p.name, p);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findPersonality(name: string, workspaceRoot?: string): Personality | null {
  const lower = name.toLowerCase();
  return loadAllPersonalities(workspaceRoot).find((p) => p.name === lower) ?? null;
}

/**
 * Returns the prompt addendum for the currently active personality, or
 * '' when none is set. Called from agent.ts after the base system prompt
 * is composed — appended last so personality overrides apply even if
 * project rules conflict.
 */
export function getActivePersonalityPrompt(workspaceRoot?: string): string {
  const name = config.get('activePersonality') as string | null | undefined;
  if (!name) return '';
  const p = findPersonality(name, workspaceRoot);
  return p?.prompt ?? '';
}

export function formatPersonalityList(workspaceRoot?: string): string {
  const list = loadAllPersonalities(workspaceRoot);
  const active = config.get('activePersonality') as string | null | undefined;
  const lines: string[] = ['## Personalities', ''];
  if (active) {
    lines.push(`**Active:** \`${active}\` — switch with \`/personality <name>\` or clear with \`/personality off\`.`);
  } else {
    lines.push('**Active:** _(none — agent uses default tone)_');
  }
  lines.push('');
  lines.push('| Name | Scope | Description |');
  lines.push('|---|---|---|');
  for (const p of list) {
    const tag = p.scope === 'builtin' ? 'built-in' : p.scope;
    const marker = active === p.name ? ' ✓' : '';
    lines.push(`| \`${p.name}\`${marker} | ${tag} | ${p.description} |`);
  }
  lines.push('');
  lines.push('Drop a `<name>.md` file into `.codeep/personalities/` (project) or `~/.codeep/personalities/` (global) to add your own — first `#` line becomes the display name, body becomes the prompt addendum.');
  return lines.join('\n');
}
