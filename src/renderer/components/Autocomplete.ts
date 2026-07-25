/**
 * Autocomplete logic for the `/`-command picker.
 *
 * Extracted from `App.ts` so the filter rule (prefix match, 8-item cap,
 * only triggered for command-shaped input) can be unit-tested without
 * the editor / render machinery.
 */

import { MENTION_BOUNDARY } from '../../utils/mentions.js';

/**
 * Result of filtering a command list for the autocomplete dropdown.
 * `null` means "autocomplete shouldn't be open" (the input isn't a
 * command prefix, or there are no matches).
 */
export interface AutocompleteResult {
  items: string[];
  /** Always 0 on a fresh filter — the caller may move it via arrow keys. */
  index: number;
}

/**
 * Filter `commands` to those that start with the typed prefix and the
 * dropdown should appear.
 *
 * Rules:
 *   - Input must start with `/` (a slash command).
 *   - Input must not contain a space (the user is still typing the
 *     command name, not an argument).
 *   - Match case-insensitively on the text after the `/`.
 *   - Cap at 8 results so the dropdown never grows past the panel.
 *
 * @param value   The raw editor value (e.g. `/h`, `/lo`, `/hel world`).
 * @param commands  The full command-name list (from `COMMAND_DESCRIPTIONS`).
 * @returns Match list, or `null` when the dropdown should be hidden.
 */
export function filterCommands(
  value: string,
  commands: string[],
): AutocompleteResult | null {
  // Only show autocomplete while typing a command name.
  if (!value.startsWith('/') || value.includes(' ')) {
    return null;
  }

  const query = value.slice(1).toLowerCase();
  if (query.length === 0) {
    // Empty query after the slash — the original App.ts code required
    // `query.length > 0`, so an empty `/` keeps the dropdown closed.
    return { items: [], index: 0 };
  }

  const items = commands
    .filter((cmd) => cmd.startsWith(query))
    .slice(0, 8);

  if (items.length === 0) return { items: [], index: 0 };

  return { items, index: 0 };
}

// ─── `@mention` detection ────────────────────────────────────────────────────

/**
 * The position and query of an in-progress `@mention`, or `null` when
 * the cursor isn't inside a mention being typed.
 *
 * A mention is "in progress" when, scanning backwards from `cursorPos`:
 *   1. We find an `@`.
 *   2. Between `@` and the cursor there are only "path characters"
 *      (letters, digits, `/`, `.`, `_`, `-`, `\`) and no whitespace.
 *   3. The `@` itself is at the start of the string OR preceded by a
 *      boundary char (space, `(`, `[`, …) — so `user@host` doesn't
 *      count. Mirrors `extractMentions` in `utils/mentions.ts`.
 */
export interface MentionQuery {
  /** Start index of the `@` in the source string. */
  atStart: number;
  /** The text typed so far after the `@` (may be empty). */
  query: string;
}

const PATH_CHAR = /[A-Za-z0-9._\/\\-]/;

/**
 * Detect whether the cursor sits inside an `@mention` being typed, and
 * if so, return the query text (everything after `@`). Pure — no FS.
 *
 * Used by the autocomplete layer to know when to show the file picker.
 */
export function detectMentionQuery(text: string, cursorPos: number): MentionQuery | null {
  if (cursorPos < 1 || cursorPos > text.length) return null;
  // Scan backwards from the cursor, collecting path chars until we hit `@`.
  let i = cursorPos - 1;
  let query = '';
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      // Found the `@`. Check the preceding char is a boundary (or start).
      // Boundary set mirrors `extractMentions` in `utils/mentions.ts`.
      const before = i > 0 ? text[i - 1] : '';
      // Keep in lockstep with `MENTION_RE`'s lookbehind in utils/mentions.ts.
      // If this set is looser, the picker offers a completion the expander
      // then refuses to treat as a mention and the file is never attached.
      if (before === '' || MENTION_BOUNDARY.test(before)) {
        return { atStart: i, query };
      }
      return null; // `@` not at a boundary → email/handle, not a mention.
    }
    if (!PATH_CHAR.test(ch)) return null; // hit a non-path char before `@`.
    query = ch + query;
    i--;
  }
  return null; // no `@` found before the cursor.
}
