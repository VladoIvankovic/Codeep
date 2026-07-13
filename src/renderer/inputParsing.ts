/**
 * Pure input-parsing helpers extracted from App.ts.
 *
 * The old `handleCommand` method inlined `input.slice(1).split(' ')` and a
 * `.toLowerCase()` on every call, with no test coverage. Pulling the parse
 * into a pure function lets us unit-test the edge cases (extra whitespace,
 * empty args, uppercase, leading slash) directly.
 */

export interface ParsedCommand {
  /** Lower-cased command name, without the leading slash. */
  command: string;
  /** Remaining args, already split on spaces (empty strings removed). */
  args: string[];
}

/**
 * Parse a raw user input line that begins with `/` into a command name
 * and arguments. Trims and collapses runs of whitespace so `/scan   src`
 * behaves the same as `/scan src`.
 *
 * Returns `null` when the input doesn’t start with `/` or is blank.
 */
export function parseCommandInput(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  // Collapse runs of whitespace so "  " between args doesn’t yield
  // empty-string args, and trim the leading "/" plus surrounding space.
  const parts = input.slice(1).trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return null;
  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1),
  };
}
