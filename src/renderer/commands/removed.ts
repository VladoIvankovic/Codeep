/**
 * Slash commands that Codeep 4.0 removed, and what to tell someone who types one.
 *
 * Without this a muscle-memory `/push` answered "Unknown command: /push", which
 * reads like a typo. Only the names below get the longer sentence; anything
 * else is still an unknown command. The lookup runs last in the dispatcher's
 * `default:` (renderer/commands.ts): a user's own `.codeep/commands/push.md`
 * or `~/.codeep/skills/push.json` still wins over it.
 *
 * Pure on purpose — no App, no config — so a test, or a one-line `node -e`
 * against `dist`, can ask it without starting the TUI.
 *
 * Do not add a name here that is a registered command: `removed.test.ts`
 * fails if the two ever overlap.
 */

/** The 62 command names removed in 4.0. */
export const REMOVED_COMMANDS: readonly string[] = [
  'add', 'amend', 'api', 'api-docs', 'apply', 'branch', 'build', 'changelog', 'ci',
  'cleanup', 'commands', 'component', 'context-clear', 'context-load', 'context-save', 'copy', 'cost',
  'coverage', 'crud', 'debug', 'deploy', 'docker', 'drop', 'e2e', 'env', 'explain', 'fix', 'form',
  'git-commit', 'hook', 'insights', 'k8s', 'log', 'migrate', 'mock', 'modernize',
  'monitor', 'nginx', 'optimize', 'page', 'paste', 'pr', 'profile', 'publish', 'pull', 'push', 'readme',
  'refactor', 'release', 'search', 'security', 'service', 'split', 'stash', 'stats', 'terraform', 'test',
  'test-fix', 'translate', 'types', 'unstash', 'web-cache',
];

/** Shortcuts that went with the commands they pointed at. */
export const REMOVED_ALIASES: Readonly<Record<string, string>> = {
  p: 'push',
  t: 'test',
  r: 'refactor',
  f: 'fix',
  e: 'explain',
  o: 'optimize',
  b: 'debug',
  webcache: 'web-cache',
};

/** The few removals that have somewhere better to send you than "ask the agent". */
const REDIRECTS: Readonly<Record<string, string>> = {
  cost: '/cost was merged into /usage in Codeep 4.0. Run /usage (add --detail for the per-model breakdown and the pricing table).',
  stats: '/stats was merged into /usage in Codeep 4.0. Run /usage --detail.',
  search: '/search was removed in Codeep 4.0. Use /recall <query> to search your saved sessions.',
  add: '/add was removed in Codeep 4.0. Type @path in your message to attach a file.',
  drop: '/drop was removed in Codeep 4.0. Files are attached per message with @path, so there is nothing to drop.',
};

const REMOVED = new Set(REMOVED_COMMANDS);

/**
 * The sentence for a removed command name (or one of its removed shortcuts),
 * or `null` when `token` was never one — a typo, or a name nobody had.
 * `token` is the lower-cased name as typed, without the slash.
 */
export function removedCommandMessage(token: string): string | null {
  const alias = Object.hasOwn(REMOVED_ALIASES, token) ? REMOVED_ALIASES[token] : undefined;
  if (alias !== undefined) {
    return `/${token} was removed in Codeep 4.0 (it was a shortcut for /${alias}). Ask the agent in plain words, or see /help.`;
  }
  if (!REMOVED.has(token)) return null;
  if (Object.hasOwn(REDIRECTS, token)) return REDIRECTS[token];
  return `/${token} was removed in Codeep 4.0. Ask the agent in plain words, or see /help.`;
}
