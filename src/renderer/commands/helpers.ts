/**
 * Pure helpers extracted from `renderer/commands.ts`.
 *
 * The dispatcher is one giant switch/case; many cases contain small but
 * tricky bits of pure logic (arg parsing, snippet extraction, message
 * formatting) that were previously untestable because they were inlined
 * alongside `ctx.app.*` calls. Pulling them here gives them direct unit
 * coverage.
 */

// ─── Search snippet extraction ────────────────────────────────────────────────
//
// `/search` builds a preview snippet around each match. The window is
// asymmetric: 30 chars before, 50 after — tighter than the 50/50 used by
// `utils/search.ts` because the inline search panel is narrower. Keeping
// it separate (rather than reusing searchMessages) preserves that
// intentional difference.

export interface SearchSnippet {
  role: string;
  messageIndex: number;
  matchedText: string;
}

/** Snippet window: chars of context before / after the match. */
export const SEARCH_SNIPPET_BEFORE = 30;
export const SEARCH_SNIPPET_AFTER = 50;

/**
 * Build search-result snippets for messages matching `term`. Mirrors the
 * inline loop that used to live in the `/search` case. Case-insensitive.
 */
export function buildSearchSnippets(
  messages: Array<{ role: string; content: string }>,
  term: string,
): SearchSnippet[] {
  const lowerTerm = term.toLowerCase();
  const results: SearchSnippet[] = [];

  messages.forEach((m, index) => {
    const lowerContent = m.content.toLowerCase();
    if (!lowerContent.includes(lowerTerm)) return;

    const matchIdx = lowerContent.indexOf(lowerTerm);
    const matchStart = Math.max(0, matchIdx - SEARCH_SNIPPET_BEFORE);
    const matchEnd = Math.min(m.content.length, matchIdx + lowerTerm.length + SEARCH_SNIPPET_AFTER);
    const matchedText =
      (matchStart > 0 ? '...' : '') +
      m.content.slice(matchStart, matchEnd).replace(/\n/g, ' ') +
      (matchEnd < m.content.length ? '...' : '');

    results.push({ role: m.role, messageIndex: index, matchedText });
  });

  return results;
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Parse the `/compact <n>` argument. Returns a value of at least 2
 * (never compacts below 2 messages); defaults to `fallback` when the arg
 * is missing or unparseable.
 *
 * Note: we use `Number.isNaN` rather than `parsed || fallback` because
 * `0` is a valid (if useless) numeric input that should clamp to 2, not
 * silently fall through to the default.
 */
export function parseKeepRecent(arg: string | undefined, fallback = 4): number {
  if (!arg) return fallback;
  const parsed = parseInt(arg, 10);
  return Math.max(2, Number.isNaN(parsed) ? fallback : parsed);
}

/**
 * Join slash-command args into a single hyphen-separated name, as used by
 * `/rename`. Empty args are dropped so `/rename  my  session ` still
 * yields `my-session`.
 */
export function joinSessionName(args: string[]): string {
  return args.filter((a) => a.length > 0).join('-');
}

// ─── /tasks helpers ───────────────────────────────────────────────────────────

export const TASK_TYPES = ['task', 'bug', 'feature'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Result of parsing `/tasks add` flags. */
export interface ParsedTaskAdd {
  title: string;
  description: string;
  type: TaskType;
}

/**
 * Parse the args following `/tasks add` into a title, description, and
 * type. Flags (`--bug`, `--feature`, `--task`) set the type; `--desc` /
 * `--description` captures the following words until the next flag.
 * Non-flag words before any `--desc` form the title.
 */
export function parseTaskAddArgs(args: string[]): ParsedTaskAdd {
  let type: TaskType = 'task';
  const titleWords: string[] = [];
  const descWords: string[] = [];
  let capturingDesc = false;

  for (const w of args) {
    const flag = /^--([\w-]+)$/.exec(w);
    if (flag) {
      const name = flag[1].toLowerCase();
      if (name === 'desc' || name === 'description') {
        capturingDesc = true;
        continue;
      }
      if ((TASK_TYPES as readonly string[]).includes(name)) type = name as TaskType;
      capturingDesc = false; // any non-desc flag ends description capture
      continue;
    }
    if (capturingDesc) descWords.push(w);
    else titleWords.push(w);
  }

  return {
    title: titleWords.join(' ').trim(),
    description: descWords.join(' ').trim(),
    type,
  };
}

/** Icon/badge for a task type, used in list rendering. */
const TYPE_ICON: Record<string, string> = { bug: '[bug]', feature: '[feature]', task: '[task]' };

/** Render a list of tasks as a Markdown list, mirroring `/tasks`. */
export function formatTaskList(
  tasks: Array<{ title: string; type?: string | null; description?: string | null; project_name?: string | null }>,
  scopeProjectName?: string,
): string {
  const lines = [`## Tasks${scopeProjectName ? ` — ${scopeProjectName}` : ''}`, ''];
  tasks.forEach((t, i) => {
    const icon = TYPE_ICON[t.type ?? 'task'] ?? '[task]';
    const proj = !scopeProjectName && t.project_name ? ` _(${t.project_name})_` : '';
    lines.push(`${i + 1}. ${icon} ${t.title}${proj}${t.description ? `\n   ${t.description}` : ''}`);
  });
  lines.push('', `*${tasks.length} pending task${tasks.length > 1 ? 's' : ''}. Use /tasks done <n> to mark complete.*`);
  lines.push('*Tasks loaded into agent context — agent will see them in the next message.*');
  return lines.join('\n');
}

// ─── /profile formatting ──────────────────────────────────────────────────────

/** Render the `/profile list` Markdown message from saved profile names. */
export function formatProfileList(profiles: string[]): string {
  return `## Profiles\n\n${profiles.map((p) => `- ${p}`).join('\n')}\n\nUse /profile load <name> to apply.`;
}

// ─── /memory list formatting ──────────────────────────────────────────────────

/** Render the `/memory list` Markdown message from saved notes. */
export function formatMemoryList(notes: string[]): string {
  const lines = notes.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
  return `**Project memory notes:**\n${lines}`;
}

// ─── /stats report ────────────────────────────────────────────────────────────
//
// `/stats` builds a multi-section Markdown report: per-model breakdown,
// totals, prompt-cache summary, and a per-1M pricing reference. The whole
// thing is a pure transform of session stats + a pricing table — extracted
// here so the formatting (number formatting, "free" sentinel for ollama,
// table layout) has direct unit tests.

export interface StatsModelRow {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
}

export interface StatsTotals {
  requestCount: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  estimatedCost: number;
}

export interface StatsCache {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedSavingsUsd: number;
}

export interface PricingRow {
  model: string;
  inputPer1M: number;
  outputPer1M: number;
}

/** A formatter for token counts (injected so this module stays pure). */
export type TokenFormatter = (n: number) => string;

/** Format a single model-row's cost string, mirroring the inline logic. */
export function formatModelCost(provider: string, estimatedCost: number): string {
  if (provider === 'ollama') return 'free';
  return estimatedCost > 0 ? `~$${estimatedCost.toFixed(4)}` : '(no pricing data)';
}

/**
 * Build the full `/stats` Markdown report. `currentProvider` controls
 * whether the total shows "free" (ollama) or a dollar figure.
 */
export function formatStatsReport(args: {
  totals: StatsTotals;
  breakdown: StatsModelRow[];
  cache: StatsCache;
  pricing: PricingRow[];
  currentProvider: string;
  fmt: TokenFormatter;
}): string {
  const { totals, breakdown, cache, pricing, currentProvider, fmt } = args;
  const lines: string[] = ['## Session Cost', ''];

  if (totals.requestCount === 0) {
    lines.push('*No API calls made yet this session.*', '');
  } else {
    lines.push(`Requests: ${totals.requestCount}`);
    lines.push(`Tokens: ${fmt(totals.totalTokens)} total (${fmt(totals.totalPromptTokens)} in / ${fmt(totals.totalCompletionTokens)} out)`);
    if (breakdown.length > 0) {
      lines.push('', '### By model');
      for (const b of breakdown) {
        const costStr = formatModelCost(b.provider, b.estimatedCost);
        lines.push(`- **${b.model}** (${b.provider}): ${fmt(b.promptTokens)} in / ${fmt(b.completionTokens)} out — ${costStr}`);
      }
      lines.push('');
      if (currentProvider === 'ollama') {
        lines.push(`**Total: free · ${fmt(totals.totalTokens)} tokens**`);
      } else if (totals.estimatedCost > 0) {
        lines.push(`**Total: ~$${totals.estimatedCost.toFixed(4)}**`);
      }
    }
    if (cache.cacheReadTokens > 0 || cache.cacheCreationTokens > 0) {
      lines.push('', '### Prompt caching');
      lines.push(`Cache reads: ${fmt(cache.cacheReadTokens)} tokens (billed at 0.1× input rate)`);
      if (cache.cacheCreationTokens > 0) {
        lines.push(`Cache writes: ${fmt(cache.cacheCreationTokens)} tokens (billed at 1.25× input rate)`);
      }
      if (cache.estimatedSavingsUsd > 0) {
        lines.push(`Estimated savings vs no caching: $${cache.estimatedSavingsUsd.toFixed(4)}`);
      }
    }
    lines.push('');
  }

  lines.push('### Pricing (per 1M tokens)');
  lines.push('| Model | Input | Output |');
  lines.push('|---|---|---|');
  for (const p of pricing) {
    lines.push(`| ${p.model} | $${p.inputPer1M.toFixed(3)} | $${p.outputPer1M.toFixed(3)} |`);
  }

  return lines.join('\n');
}

// ─── /copy and /apply code-block extraction ───────────────────────────────────

/**
 * Extract every fenced code block body (the text inside ```…```) from a
 * string, mirroring the `/copy` loop. Language fences (```ts) are ignored —
 * only the body is captured.
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/```[\w]*\n([\s\S]*?)```/g)) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Validate a 1-based block index against the available block list, as used
 * by `/copy <n>`. Returns the 0-based index, or `null` when the index is
 * out of range (the caller shows an error).
 */
export function resolveBlockIndex(blockNum: number, blockCount: number): number | null {
  if (blockCount === 0) return null;
  const index = blockNum === -1 ? blockCount - 1 : blockNum - 1;
  if (Number.isNaN(index) || index < 0 || index >= blockCount) return null;
  return index;
}

// ─── /apply file-change extraction ────────────────────────────────────────────

export interface FileChange {
  path: string;
  content: string;
}

/**
 * Extract file-change pairs from an assistant message, mirroring `/apply`.
 * Two patterns are tried in order:
 *   1. fence with a filename header:  ```ts\nsrc/foo.ts\n<body>```
 *   2. fence with a `// File:` / `# Path:` comment header.
 * A path is only accepted when it contains a dot and no spaces.
 */
export function extractFileChanges(text: string): FileChange[] {
  const changes: FileChange[] = [];
  const fenceFilePattern = /```\w*\s+([\w./\\-]+(?:\.\w+))\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceFilePattern.exec(text)) !== null) {
    const p = match[1].trim();
    if (p.includes('.') && !p.includes(' ')) changes.push({ path: p, content: match[2] });
  }
  if (changes.length > 0) return changes;

  const commentPattern = /```(\w+)?\s*\n(?:\/\/|#|--|\/\*)\s*(?:File|Path|file|path):\s*([^\n*]+)\n([\s\S]*?)```/g;
  while ((match = commentPattern.exec(text)) !== null) {
    changes.push({ path: match[2].trim(), content: match[3] });
  }
  return changes;
}

/** Truncate a path for display: keep the last 37 chars, prefixed with “…”. */
export function shortPathForDisplay(path: string, max = 40): string {
  return path.length > max ? '...' + path.slice(-(max - 3)) : path;
}

/**
 * Build a single diff-line summary for a file change, mirroring `/apply`.
 * Returns `null` when `existingContent` is empty (a CREATE), otherwise a
 * MODIFY line with the line-count delta.
 */
export function formatApplyDiffLine(
  change: { path: string; content: string },
  existingContent: string,
): string[] {
  const shortPath = shortPathForDisplay(change.path);
  if (!existingContent) {
    return [`+ CREATE: ${shortPath}`, `  (${change.content.split('\n').length} lines)`];
  }
  const oldLines = existingContent.split('\n').length;
  const newLines = change.content.split('\n').length;
  const lineDiff = newLines - oldLines;
  return [`~ MODIFY: ${shortPath}`, `  ${oldLines} → ${newLines} lines (${lineDiff >= 0 ? '+' : ''}${lineDiff})`];
}

// ─── /mcp helpers ─────────────────────────────────────────────────────────────

/**
 * Parse `key=value` tokens (as used by `/mcp prompt <server> <name> [k=v...]`)
 * into a record. Tokens without an `=` (or with `=` at position 0) are
 * skipped. Mirrors the inline loop.
 */
export function parsePromptArgs(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/** Pluralise "tool"/"tools" based on the count. */
export function pluralTools(n: number): string {
  return `tool${n === 1 ? '' : 's'}`;
}

/**
 * Group a flat list of tools by `serverName`, preserving first-seen order.
 * Used by `/mcp` (default), `/mcp reload`, and the install report.
 */
export function groupToolsByServer<T extends { serverName: string }>(
  tools: T[],
): Array<{ serverName: string; serverTools: T[] }> {
  const byServer = new Map<string, T[]>();
  for (const t of tools) {
    if (!byServer.has(t.serverName)) byServer.set(t.serverName, []);
    byServer.get(t.serverName)!.push(t);
  }
  return Array.from(byServer, ([serverName, serverTools]) => ({ serverName, serverTools }));
}

/** Format the `/mcp` default server/tool listing. */
export function formatMcpServerList<T extends { serverName: string; agentName: string; description?: string }>(
  tools: T[],
  errors: Array<{ server: string; error: string }>,
): string {
  if (tools.length === 0 && errors.length === 0) {
    return [
      '_No MCP servers connected to this session._',
      '',
      'Add one with `/mcp add <name> <command> [args...]` — it persists to `.codeep/mcp_servers.json`.',
      'Or browse the marketplace with `/mcp browse` and install with `/mcp install <id>`.',
    ].join('\n');
  }

  const lines: string[] = ['## MCP servers', ''];
  if (tools.length > 0) {
    for (const { serverName, serverTools } of groupToolsByServer(tools)) {
      lines.push(`**${serverName}** — ${serverTools.length} ${pluralTools(serverTools.length)}`);
      for (const t of serverTools) {
        const desc = t.description ? ` — ${t.description}` : '';
        lines.push(`- \`${t.agentName}\`${desc}`);
      }
      lines.push('');
    }
  }
  if (errors.length > 0) {
    lines.push('### Failed servers');
    for (const e of errors) lines.push(`- **${e.server}** — \`${e.error}\``);
  }
  return lines.join('\n').trim();
}

/** Format the `/mcp reload` report. */
export function formatMcpReloadReport(
  toolCount: number,
  serverCount: number,
  errors: Array<{ server: string; error: string }>,
): string {
  const lines = ['## MCP reloaded', '', `**${toolCount}** ${pluralTools(toolCount)} from **${serverCount}** server${serverCount === 1 ? '' : 's'}.`];
  if (errors.length > 0) {
    lines.push('', '### Failed servers');
    for (const e of errors) lines.push(`- **${e.server}** — \`${e.error}\``);
  }
  return lines.join('\n');
}

/** Format the `/mcp resources` listing. */
export function formatMcpResourcesList(
  groups: Array<{
    serverName: string;
    resources: Array<{ uri: string; name?: string; mimeType?: string; description?: string }>;
  }>,
): string {
  if (groups.length === 0) return '_No MCP server in this session exposes resources._';
  const lines = ['## MCP resources', ''];
  for (const g of groups) {
    lines.push(`**${g.serverName}** — ${g.resources.length} resource${g.resources.length === 1 ? '' : 's'}`);
    for (const r of g.resources) {
      const label = r.name ? `${r.name} — ` : '';
      const mime = r.mimeType ? ` (${r.mimeType})` : '';
      lines.push(`- ${label}\`${r.uri}\`${mime}${r.description ? ` — ${r.description}` : ''}`);
    }
    lines.push('');
  }
  lines.push('Read one with `/mcp read <uri>`.');
  return lines.join('\n').trim();
}

/** Format the `/mcp read` output for a list of resource contents. */
export function formatMcpResourceRead(
  uri: string,
  contents: Array<{ text?: string; blob?: string; mimeType?: string }>,
): string {
  if (contents.length === 0) return `_No content returned for \`${uri}\`._`;
  const lines: string[] = [`## Resource: \`${uri}\``, ''];
  for (const c of contents) {
    if (c.text !== undefined) {
      const fence = c.mimeType?.includes('json') ? 'json' : c.mimeType?.includes('markdown') ? 'markdown' : '';
      lines.push('```' + fence);
      lines.push(c.text);
      lines.push('```');
    } else if (c.blob) {
      lines.push(`_(${c.mimeType ?? 'binary'} blob, ${c.blob.length} base64 chars — not rendered)_`);
    }
  }
  return lines.join('\n');
}

/** Format the `/mcp prompts` listing. */
export function formatMcpPromptsList(
  groups: Array<{
    serverName: string;
    prompts: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; required?: boolean }>;
    }>;
  }>,
): string {
  if (groups.length === 0) return '_No MCP server in this session exposes prompt templates._';
  const lines = ['## MCP prompt templates', ''];
  for (const g of groups) {
    lines.push(`**${g.serverName}** — ${g.prompts.length} prompt${g.prompts.length === 1 ? '' : 's'}`);
    for (const p of g.prompts) {
      const argList = p.arguments?.length
        ? ` (${p.arguments.map((a) => (a.required ? a.name : `[${a.name}]`)).join(', ')})`
        : '';
      lines.push(`- \`${p.name}\`${argList}${p.description ? ` — ${p.description}` : ''}`);
    }
    lines.push('');
  }
  lines.push('Materialise one with `/mcp prompt <server> <name> [key=value...]`.');
  return lines.join('\n').trim();
}

/** Format the `/mcp prompt` materialised output. */
export function formatMcpPromptResult(
  serverName: string,
  name: string,
  description: string | undefined,
  messages: Array<{ role: string; content?: { text?: string } }>,
): string {
  const lines: string[] = [`## Prompt \`${serverName}/${name}\``];
  if (description) lines.push(`_${description}_`);
  lines.push('');
  for (const m of messages) {
    const text = typeof m.content?.text === 'string' ? m.content.text : JSON.stringify(m.content);
    lines.push(`**${m.role}:** ${text}`, '');
  }
  return lines.join('\n').trim();
}

// ─── /insights --days parser ──────────────────────────────────────────────────

/**
 * Parse the `--days N` / `--days=N` flag from `/insights` args. Returns the
 * default (7) when absent or unparseable; clamps negatives to 0.
 */
export function parseInsightsDays(args: string[], fallback = 7): number {
  let days = fallback;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--days' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isFinite(n)) days = n;
    } else if (a.startsWith('--days=')) {
      const n = parseInt(a.slice('--days='.length), 10);
      if (Number.isFinite(n)) days = n;
    }
  }
  return days;
}

// ─── /cloud session-row formatter ─────────────────────────────────────────────

/**
 * Format a single cloud-session row for the `/cloud` picker, mirroring the
 * inline template: `title · date · N msg · [project?]`.
 */
export function formatCloudSessionLabel(
  s: { sessionId: string; sessionName?: string | null; updatedAt: string; messageCount: number; projectName?: string | null },
): string {
  const date = new Date(s.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const title = s.sessionName || s.sessionId.slice(0, 8);
  const projectTag = s.projectName ? ` · ${s.projectName}` : '';
  return `${title}  ·  ${date} · ${s.messageCount} msg${projectTag}`;
}

// ─── /me sync + learn + init formatters ───────────────────────────────────────

/** Format the `/me sync` result list. `pulled` is `1` on success, `0` or `null` otherwise. */
export function formatMeSyncReport(pushed: boolean, pulled: number | null): string {
  const lines: string[] = [];
  if (pushed) lines.push('✓ Profile pushed to the dashboard');
  if (pulled === 1) lines.push('✓ Profile pulled to this machine');
  if (lines.length === 0) lines.push('Nothing to sync yet — run `/me init` and fill in your profile first.');
  return `## Profile sync\n\n${lines.join('\n')}`;
}

/**
 * Format the `/me learn` result. `updated` distinguishes "new facts written"
 * from "already covered"; `file` is the human-readable path.
 */
export function formatMeLearnResult(scope: 'global' | 'project', file: string, res: { updated: boolean; facts: string }): string {
  return res.updated
    ? `Updated your ${scope} learned profile (\`${file}\`):\n\n${res.facts}\n\nClear it anytime with \`/me forget\`.`
    : `No changes — your ${scope} learned profile already covers this:\n\n${res.facts}`;
}

/** Format the `/me init` result. */
export function formatMeInitResult(
  scope: 'global' | 'project',
  res: { created: boolean; path: string },
): string {
  return res.created
    ? `Created ${scope} profile: \`${res.path}\`\n\nEdit it in your editor — Codeep uses it automatically. View anytime with \`/me\`.`
    : `${scope === 'global' ? 'Global' : 'Project'} profile already exists: \`${res.path}\`\n\nEdit it directly, or view it with \`/me\`.`;
}

// ─── /skills show formatter ───────────────────────────────────────────────────

/** Format the `/skills show` detail view from a skill bundle. */
export function formatSkillsShow(bundle: { name: string; description: string; source: string; body: string }): string {
  return `# ${bundle.name}\n_${bundle.description}_\n\n**Source:** ${bundle.source}\n\n---\n\n${bundle.body}`;
}

// ─── /skills browse + publish formatters ──────────────────────────────────────

/** Format the `/skills browse` empty-state message. */
export function formatSkillsBrowseEmpty(query: string): string {
  return query ? `_No public skills matching "${query}"._` : '_No public skills published yet._';
}

/** Format the `/skills publish` success message. */
export function formatSkillsPublishResult(slug: string, isPublic: boolean, owner: string | null | undefined): string {
  return `Published \`${slug}\` (${isPublic ? 'public' : 'private'}) to codeep.dev. Install elsewhere with \`/skills install ${owner ?? '<you>'}/${slug}\`.`;
}
