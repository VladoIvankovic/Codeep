/**
 * Autocomplete logic for the `/`-command picker.
 *
 * Extracted from `App.ts` so the filter rule (prefix match, 8-item cap,
 * only triggered for command-shaped input) can be unit-tested without
 * the editor / render machinery.
 */

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
