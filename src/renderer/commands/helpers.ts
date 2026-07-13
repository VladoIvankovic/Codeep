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
