/**
 * Single source of truth for Codeep slash commands.
 *
 * Every other place that needs command metadata — the `/` autocomplete in
 * `App.ts`, the `/help` screen in `components/Help.ts`, the dispatcher in
 * `commands.ts`, and the ACP command handler in `acp/commands.ts` — derives
 * from this registry. Adding a command means adding one entry here; the
 * autocomplete list, help screen, and command index all pick it up.
 *
 * ## What lives here vs. elsewhere
 *
 * - **`CommandDef`** is metadata only: name, aliases, description, category.
 *   The actual handler logic stays in `renderer/commands.ts` (CLI) and
 *   `acp/commands.ts` (ACP) — those files keep their per-command `case`
 *   blocks, but they now look up the canonical name/description/alias map here.
 * - **Argument syntax** (e.g. `/rename <name>`, `/mcp browse [id]`) is
 *   documented via the optional `usage` field — surfaced in `/help` only.
 *   The autocomplete list shows just the bare command name.
 * - **Hidden commands** (`hidden: true`) are valid and dispatched, but don't
 *   appear in the autocomplete dropdown or `/help`. Use for aliases that
 *   would clutter the list (single-letter shortcuts) and internal commands.
 *
 * ## Invariants (enforced by `registry.test.ts`)
 *
 * - No two commands share a name or alias.
 * - Every `category` referenced exists in `CATEGORY_ORDER`.
 * - `usage` keys never collide with a sibling command's name.
 */

/** Display categories, in the order `/help` shows them. */
export const CATEGORY_ORDER = [
  'general',
  'sessions',
  'checkpoints',
  'agent',
  'git',
  'code',
  'skills',
  'settings',
  'extensions',
  'cloud',
  'codegen',
  'thinking',
] as const;

export type CommandCategory = (typeof CATEGORY_ORDER)[number];

/** Human-readable title for each category (used by `/help`). */
export const CATEGORY_TITLES: Record<CommandCategory, string> = {
  general: 'General',
  sessions: 'Sessions',
  checkpoints: 'Checkpoints (2.0)',
  agent: 'Agent Mode',
  git: 'Git & Project',
  code: 'Code Operations',
  skills: 'Skills (Shortcuts)',
  settings: 'Settings',
  extensions: 'Extensions & MCP (2.0)',
  cloud: 'Cloud & Account',
  codegen: 'Code Generation',
  thinking: 'Reasoning',
};

export interface CommandDef {
  /** Primary command name, without the leading `/`. */
  name: string;
  /** Alternate names that dispatch to the same handler. Hidden from `/help`
   *  by default (set `aliasListed: true` to show them, e.g. `/effort`). */
  aliases?: string[];
  /** One-line description shown in autocomplete and `/help`. */
  description: string;
  /** Display group in `/help`. */
  category: CommandCategory;
  /** Extra usage rows shown only in `/help` (e.g. `/mcp browse [id]`).
   *  Each entry is rendered as a separate row under the same command. */
  usage?: string[];
  /** When true, the command is valid but hidden from autocomplete + `/help`.
   *  Used for single-letter shortcuts and internal aliases. */
  hidden?: boolean;
  /** When true, an alias is listed in `/help` alongside the primary name
   *  (e.g. `/effort` appears next to `/thinking`). Default false — most
   *  aliases are hidden shortcuts. */
  aliasListed?: boolean;
}

/**
 * The registry. Order within a category is preserved as-is in `/help`,
 * so keep entries grouped by category in source for readability.
 */
export const COMMANDS: CommandDef[] = [
  // ── general ────────────────────────────────────────────────────────────────
  { name: 'help', description: 'Show this help', category: 'general' },
  { name: 'status', description: 'Current status', category: 'general' },
  { name: 'settings', description: 'Open settings', category: 'general' },
  { name: 'version', description: 'Show version', category: 'general' },
  { name: 'update', description: 'Check for updates', category: 'general' },
  {
    name: 'cost',
    aliases: ['stats'],
    description: 'Token usage & cost this session',
    category: 'general',
    aliasListed: true,
  },
  { name: 'clear', description: 'Clear chat', category: 'general', hidden: true },
  { name: 'exit', description: 'Quit application', category: 'general', hidden: true },

  // ── sessions ───────────────────────────────────────────────────────────────
  { name: 'sessions', aliases: ['session'], description: 'List and load sessions', category: 'sessions' },
  { name: 'new', description: 'Start new session', category: 'sessions' },
  { name: 'rename', description: 'Rename current session', category: 'sessions', usage: ['<name>'] },
  { name: 'search', description: 'Search the current session', category: 'sessions', usage: ['<term>'] },
  {
    name: 'recall',
    description: 'Search across ALL saved sessions (cross-session)',
    category: 'sessions',
    usage: ['<query>', '<query> --resume', '<query> --summarize'],
  },
  {
    name: 'cloud',
    description: 'List and resume sessions synced from other devices',
    category: 'sessions',
  },
  { name: 'export', description: 'Export chat', category: 'sessions', usage: ['[md|json|txt]'] },
  { name: 'compact', description: 'AI-summarize older messages to free up context (keeps last N)', category: 'sessions', usage: ['[keepN]'] },

  // ── checkpoints ────────────────────────────────────────────────────────────
  { name: 'checkpoint', description: 'Snapshot conversation + provider/model + git HEAD', category: 'checkpoints', usage: ['[name]', 'delete <id>'] },
  { name: 'checkpoints', description: 'List saved checkpoints in this workspace', category: 'checkpoints' },
  { name: 'rewind', description: 'Restore conversation from a checkpoint', category: 'checkpoints', usage: ['<id>'] },

  // ── agent ──────────────────────────────────────────────────────────────────
  { name: 'agent', description: 'Run agent with task', category: 'agent', usage: ['<task>'] },
  { name: 'agent-dry', description: 'Dry run (no changes)', category: 'agent', usage: ['<task>'] },
  { name: 'plan', description: 'Generate a plan first — review before /go executes', category: 'agent', usage: ['<task>'] },
  { name: 'go', description: 'Execute the pending plan from /plan', category: 'agent' },
  { name: 'stop', description: 'Stop running agent', category: 'agent' },
  { name: 'undo', description: 'Undo last agent action', category: 'agent' },
  { name: 'undo-all', description: 'Undo all agent actions', category: 'agent' },
  { name: 'history', description: 'Show agent history', category: 'agent' },
  { name: 'changes', description: 'Show session changes', category: 'agent' },

  // ── git & project ──────────────────────────────────────────────────────────
  { name: 'diff', description: 'Review git diff with AI', category: 'git', usage: ['--staged'] },
  {
    name: 'commit',
    aliases: ['c'],
    description: 'Generate commit message',
    category: 'git',
    aliasListed: true,
  },
  { name: 'git-commit', description: 'Commit with message', category: 'git', usage: ['<msg>'] },
  { name: 'push', aliases: ['p'], description: 'Git push', category: 'git', aliasListed: true },
  { name: 'pull', description: 'Git pull', category: 'git' },
  { name: 'amend', description: 'Amend last commit', category: 'git' },
  { name: 'branch', description: 'Create/manage branches', category: 'git' },
  { name: 'stash', description: 'Stash changes with a meaningful message', category: 'git' },
  { name: 'unstash', description: 'Apply and drop the most recent stash', category: 'git' },
  { name: 'pr', description: 'Create a pull request description', category: 'git' },
  { name: 'changelog', description: 'Generate changelog from recent commits', category: 'git' },
  { name: 'init', description: 'Initialize project (.codeep/ folder)', category: 'git' },
  { name: 'scan', description: 'Scan project structure', category: 'git' },
  {
    name: 'memory',
    description: 'Add note to project intelligence',
    category: 'git',
    usage: ['list', 'remove <n>', 'clear', '<note>'],
  },
  {
    name: 'review',
    description: 'AI review of unstaged git changes (not full codebase)',
    category: 'git',
    usage: ['--staged', '--static', '<file>'],
  },

  // ── code operations ────────────────────────────────────────────────────────
  { name: 'copy', description: 'Copy code block to clipboard', category: 'code', usage: ['[n]'] },
  { name: 'paste', description: 'Paste from clipboard', category: 'code' },
  { name: 'apply', description: 'Apply file changes from AI', category: 'code' },
  { name: 'add', description: 'Add file to context', category: 'code', usage: ['<path>'] },
  { name: 'drop', description: 'Remove file (or all) from context', category: 'code', usage: ['[path]'] },
  { name: 'multiline', description: 'Toggle multi-line input mode', category: 'code' },

  // ── skills (shortcuts) ─────────────────────────────────────────────────────
  { name: 'test', aliases: ['t'], description: 'Generate/run tests', category: 'skills', aliasListed: true },
  {
    name: 'docs',
    aliases: ['d'],
    description: 'Open web docs for a command (e.g. /docs personality)',
    category: 'skills',
    aliasListed: true,
  },
  { name: 'refactor', aliases: ['r'], description: 'Improve code quality', category: 'skills', aliasListed: true },
  { name: 'fix', aliases: ['f'], description: 'Debug and fix issues', category: 'skills', aliasListed: true },
  { name: 'explain', aliases: ['e'], description: 'Explain code', category: 'skills', aliasListed: true },
  { name: 'optimize', aliases: ['o'], description: 'Optimize performance', category: 'skills', aliasListed: true },
  { name: 'debug', aliases: ['b'], description: 'Debug problems', category: 'skills', aliasListed: true },
  { name: 'security', description: 'Security audit (SQLi, XSS, secrets, auth)', category: 'skills' },
  { name: 'coverage', description: 'Analyze test coverage and suggest improvements', category: 'skills' },
  { name: 'test-fix', description: 'Fix failing tests', category: 'skills' },
  { name: 'e2e', description: 'Generate end-to-end tests', category: 'skills' },
  { name: 'mock', description: 'Generate mock data for testing', category: 'skills' },
  { name: 'readme', description: 'Generate or update README', category: 'skills' },
  { name: 'api-docs', description: 'Generate API documentation', category: 'skills' },
  { name: 'translate', description: 'Translate code comments to English', category: 'skills' },
  { name: 'types', description: 'Add or improve TypeScript types', category: 'skills' },
  { name: 'cleanup', description: 'Clean up code (remove unused, format)', category: 'skills' },
  { name: 'modernize', description: 'Update code to use modern syntax', category: 'skills' },
  { name: 'migrate', description: 'Migrate code to newer version', category: 'skills' },
  { name: 'split', description: 'Split a large file into smaller modules', category: 'skills' },
  { name: 'log', description: 'Add logging to code', category: 'skills' },
  { name: 'skills', description: 'List all 50+ skills', category: 'skills', usage: ['<query>'] },
  {
    name: 'skill',
    description: 'Manage a single skill',
    category: 'skills',
    hidden: true,
    usage: ['create', 'delete', 'help'],
  },

  // ── settings ───────────────────────────────────────────────────────────────
  { name: 'provider', description: 'Change AI provider', category: 'settings' },
  { name: 'model', description: 'Change model', category: 'settings', usage: ['<name>'] },
  { name: 'protocol', description: 'Switch API protocol', category: 'settings' },
  { name: 'lang', description: 'Set response language', category: 'settings' },
  { name: 'grant', description: 'Grant write permission', category: 'settings' },
  { name: 'login', aliases: ['apikey'], description: 'Login with API key', category: 'settings' },
  { name: 'logout', description: 'Logout from provider', category: 'settings' },
  {
    name: 'profile',
    description: 'Save/load settings profiles',
    category: 'settings',
    usage: ['save <name>', 'list', 'apply <name>', 'delete <name>'],
  },
  { name: 'personality', description: 'List or switch agent tone (concise / verbose / security / senior-reviewer / …)', category: 'settings', usage: ['<name>', 'off'] },
  {
    name: 'me',
    description: 'Your user profile (reply language, style, stack) — adapts the agent to you',
    category: 'settings',
    usage: ['init [project]', 'learn [on|off]', 'sync', 'off', 'forget'],
  },
  { name: 'agents', description: 'List sub-agents the agent can delegate to (researcher / reviewer / tester / your own)', category: 'settings' },
  { name: 'insights', description: 'Activity summary — runs, files, tools, projects over the last N days (default 7)', category: 'settings', usage: ['--days N'] },
  { name: 'openrouter', description: 'OpenRouter routing prefs (prefer/ignore providers, fallbacks, privacy)', category: 'settings' },

  // ── extensions & mcp ───────────────────────────────────────────────────────
  {
    name: 'mcp',
    description: 'List connected MCP servers + their tools',
    category: 'extensions',
    usage: ['browse [id]', 'install <id> [args]', 'add <name> <cmd>', 'remove <name>', 'resources', 'prompts'],
  },
  { name: 'hooks', description: 'List installed lifecycle hooks (.codeep/hooks/<event>.sh)', category: 'extensions' },
  { name: 'commands', description: 'List custom slash commands in .codeep/commands/*.md', category: 'extensions' },

  // ── cloud & account ────────────────────────────────────────────────────────
  { name: 'account', description: 'Link this machine to your codeep.dev account', category: 'cloud' },
  { name: 'tasks', description: 'List/add/done/delete codeep.dev tasks', category: 'cloud', usage: ['add <title> [--bug|--feature]'] },
  { name: 'sync', description: 'Sync learning preferences and profiles to codeep.dev', category: 'cloud' },
  { name: 'telemetry', description: 'Show or toggle automatic cloud telemetry (on/off)', category: 'cloud' },
  { name: 'keysync', description: 'Show or toggle syncing API keys to codeep.dev (on/off)', category: 'cloud' },
  { name: 'learn', description: 'Learn code preferences', category: 'cloud' },
  { name: 'context-save', description: 'Save conversation', category: 'cloud', hidden: true },
  { name: 'context-load', description: 'Load conversation', category: 'cloud', hidden: true },
  { name: 'context-clear', description: 'Clear saved context', category: 'cloud', hidden: true },
  { name: 'save', description: 'Save current session', category: 'cloud', hidden: true },

  // ── code generation ────────────────────────────────────────────────────────
  { name: 'build', description: 'Build the project', category: 'codegen' },
  { name: 'deploy', description: 'Build and deploy', category: 'codegen' },
  { name: 'release', description: 'Create a new release', category: 'codegen' },
  { name: 'publish', description: 'Publish package to npm', category: 'codegen' },
  { name: 'component', description: 'Generate UI component', category: 'codegen', usage: ['<name>'] },
  { name: 'api', description: 'Generate API endpoint', category: 'codegen', usage: ['<name>'] },
  { name: 'hook', description: 'Generate a React hook', category: 'codegen' },
  { name: 'service', description: 'Generate a service/utility module', category: 'codegen' },
  { name: 'page', description: 'Generate a new page/route', category: 'codegen' },
  { name: 'form', description: 'Generate a form with validation', category: 'codegen' },
  { name: 'crud', description: 'Generate full CRUD for an entity', category: 'codegen' },
  { name: 'docker', description: 'Generate Dockerfile + compose', category: 'codegen' },
  { name: 'ci', description: 'Generate CI/CD configuration', category: 'codegen' },
  { name: 'env', description: 'Setup environment configuration', category: 'codegen' },
  { name: 'k8s', description: 'Generate Kubernetes manifests', category: 'codegen' },
  { name: 'terraform', description: 'Generate Terraform configuration', category: 'codegen' },
  { name: 'nginx', description: 'Generate Nginx configuration', category: 'codegen' },
  { name: 'monitor', description: 'Add monitoring and observability', category: 'codegen' },

  // ── reasoning ──────────────────────────────────────────────────────────────
  {
    name: 'thinking',
    aliases: ['effort'],
    description: 'Set the thinking/reasoning-effort tier (auto/low/medium/high/max) for models that support it',
    category: 'thinking',
    aliasListed: true,
  },
];

// ─── Derived lookup maps ─────────────────────────────────────────────────────

/** `name → description` for every visible (non-hidden) command + listed alias.
 *  This is the data behind the `/` autocomplete dropdown in `App.ts`.
 *
 *  Single-letter aliases (the `c`/`t`/`d`/… shortcuts) are deliberately
 *  EXCLUDED from the dropdown — bare one-letter rows just clutter it (they
 *  stay fully routable via the dispatcher + show in `/help` as `(/c)` suffixes).
 *  Multi-letter listed aliases (`effort`, `stats`) are kept; they read as real
 *  commands, not noise. */
export const COMMAND_DESCRIPTIONS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const cmd of COMMANDS) {
    if (cmd.hidden) continue;
    out[cmd.name] = cmd.description;
    if (cmd.aliasListed && cmd.aliases) {
      for (const a of cmd.aliases) {
        if (a.length > 1) out[a] = cmd.description; // skip single-letter shortcuts
      }
    }
  }
  return out;
})();

/** Every valid command name, including hidden ones and aliases — used by the
 *  dispatcher to validate input before looking up a handler. */
export const ALL_COMMAND_NAMES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const cmd of COMMANDS) {
    set.add(cmd.name);
    for (const a of cmd.aliases ?? []) set.add(a);
  }
  return set;
})();

/** Resolve an input token (name or alias) to its canonical `CommandDef`,
 *  or `undefined` if unknown. */
const COMMAND_BY_TOKEN = (() => {
  const map = new Map<string, CommandDef>();
  for (const cmd of COMMANDS) {
    map.set(cmd.name, cmd);
    for (const a of cmd.aliases ?? []) map.set(a, cmd);
  }
  return map;
})();

export function resolveCommand(token: string): CommandDef | undefined {
  return COMMAND_BY_TOKEN.get(token);
}

/** All aliases (every value in `aliases` across the registry), for quick
 *  "is this a shortcut?" checks. */
export const ALL_ALIASES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const cmd of COMMANDS) {
    for (const a of cmd.aliases ?? []) set.add(a);
  }
  return set;
})();

// ─── Help-screen overrides ──────────────────────────────────────────────────
//
// Most `/help` rows just render a command's main `description`. A handful of
// subcommand rows carry their own richer description (e.g. `/model <name>`
// means "load saved profile", distinct from the parent "Change model"), and
// some rows are documentation-only entries that don't correspond to a real
// command at all (e.g. `OLLAMA_HOST=0.0.0.0` is an env-var hint, not a
// slash command). Both are kept here, grouped by help category, so the
// `/help` screen stays the single human-curated document while the registry
// is the single machine source of truth for dispatch + autocomplete.
//
// `HelpCategorySpec` mirrors the shape of the old hand-maintained array, so
// the rendered output is byte-identical to before the refactor.

export interface HelpItemSpec {
  /** Visible key in `/help`, including the leading `/`. */
  key: string;
  description: string;
}

export interface HelpCategorySpec {
  title: string;
  items: HelpItemSpec[];
}

/**
 * Hand-curated help layout. Categories appear in this order; each item's `key`
 * is rendered verbatim. The command registry provides autocomplete + dispatch
 * metadata; this layout provides the `/help` rendering. They overlap by design
 * — keeping both lets the help screen document env vars, subcommand flavors,
 * and recommended workflows that don't fit the strict command/alias shape.
 */
export const HELP_LAYOUT: HelpCategorySpec[] = [
  {
    title: 'General',
    items: [
      { key: '/help', description: 'Show this help' },
      { key: '/status', description: 'Current status' },
      { key: '/settings', description: 'Open settings' },
      { key: '/version', description: 'Show version' },
      { key: '/update', description: 'Check for updates' },
      { key: '/stats (/cost)', description: 'Token usage & cost this session' },
      { key: '/clear', description: 'Clear chat' },
      { key: '/exit', description: 'Quit application' },
    ],
  },
  {
    title: 'Sessions',
    items: [
      { key: '/sessions', description: 'List and load sessions' },
      { key: '/new', description: 'Start new session' },
      { key: '/rename <name>', description: 'Rename current session' },
      { key: '/search <term>', description: 'Search the current session' },
      { key: '/recall <query>', description: 'Search across ALL saved sessions (cross-session)' },
      { key: '/recall … --resume', description: 'Load the top-matching session directly' },
      { key: '/recall … --summarize', description: 'LLM recap of what you did across matches' },
      { key: '/export [md|json|txt]', description: 'Export chat' },
      { key: '/compact [keepN]', description: 'AI-summarize older messages to free up context (keeps last N)' },
    ],
  },
  {
    title: 'Checkpoints (2.0)',
    items: [
      { key: '/checkpoint [name]', description: 'Snapshot conversation + provider/model + git HEAD' },
      { key: '/checkpoints', description: 'List saved checkpoints in this workspace' },
      { key: '/rewind <id>', description: 'Restore conversation from a checkpoint' },
      { key: '/checkpoint delete <id>', description: 'Delete a saved checkpoint' },
    ],
  },
  {
    title: 'Agent Mode',
    items: [
      { key: '/agent <task>', description: 'Run agent with task' },
      { key: '/agent-dry <task>', description: 'Dry run (no changes)' },
      { key: '/plan <task>', description: 'Generate a plan first — review before /go executes' },
      { key: '/go', description: 'Execute the pending plan from /plan' },
      { key: '/stop', description: 'Stop running agent' },
      { key: '/undo', description: 'Undo last agent action' },
      { key: '/undo-all', description: 'Undo all agent actions' },
      { key: '/history', description: 'Show agent history' },
      { key: '/changes', description: 'Show session changes' },
    ],
  },
  {
    title: 'Git & Project',
    items: [
      { key: '/diff', description: 'Review git diff with AI' },
      { key: '/diff --staged', description: 'Review staged changes' },
      { key: '/commit (/c)', description: 'Generate commit message' },
      { key: '/git-commit <msg>', description: 'Commit with message' },
      { key: '/push (/p)', description: 'Git push' },
      { key: '/pull', description: 'Git pull' },
      { key: '/amend', description: 'Amend last commit' },
      { key: '/branch', description: 'Create/manage branches' },
      { key: '/stash', description: 'Stash changes' },
      { key: '/init', description: 'Initialize project (.codeep/ folder)' },
      { key: '/scan', description: 'Scan project structure' },
      { key: '/memory <note>', description: 'Add note to project intelligence' },
      { key: '/memory list', description: 'Show all memory notes' },
      { key: '/memory remove <n>', description: 'Remove note by index' },
      { key: '/memory clear', description: 'Clear all memory notes' },
      { key: '/review', description: 'AI review of unstaged git changes (not full codebase)' },
      { key: '/review --staged', description: 'AI review of staged git changes' },
      { key: '/review --static', description: 'Static analysis — changed files, or whole src/ if clean' },
      { key: '/review <file>', description: 'Static analysis of specific file(s)' },
    ],
  },
  {
    title: 'Code Operations',
    items: [
      { key: '/copy [n]', description: 'Copy code block to clipboard' },
      { key: '/paste', description: 'Paste from clipboard' },
      { key: '/apply', description: 'Apply file changes from AI' },
      { key: '/add <path>', description: 'Add file to context' },
      { key: '/drop [path]', description: 'Remove file (or all) from context' },
      { key: '/multiline', description: 'Toggle multi-line input mode' },
    ],
  },
  {
    title: 'Skills (Shortcuts)',
    items: [
      { key: '/test (/t)', description: 'Generate/run tests' },
      { key: '/docs (/d)', description: 'Open web docs for a command' },
      { key: '/refactor (/r)', description: 'Improve code quality' },
      { key: '/fix (/f)', description: 'Debug and fix issues' },
      { key: '/explain (/e)', description: 'Explain code' },
      { key: '/optimize (/o)', description: 'Optimize performance' },
      { key: '/debug (/b)', description: 'Debug problems' },
      { key: '/security', description: 'Security audit (SQLi, XSS, secrets, auth)' },
      { key: '/coverage', description: 'Run/analyze test coverage' },
      { key: '/component <name>', description: 'Generate UI component' },
      { key: '/api <name>', description: 'Generate API endpoint' },
      { key: '/docker', description: 'Generate Dockerfile + compose' },
      { key: '/skills', description: 'List all 50+ skills' },
      { key: '/skills <query>', description: 'Search skills by keyword' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { key: '/provider', description: 'Change AI provider' },
      { key: '/model', description: 'Change model' },
      { key: '/model <name>', description: 'Load saved profile (e.g. /model fast)' },
      { key: '/protocol', description: 'Switch API protocol' },
      { key: '/lang', description: 'Set response language' },
      { key: '/grant', description: 'Grant write permission' },
      { key: '/login', description: 'Login with API key' },
      { key: '/logout', description: 'Logout from provider' },
      { key: '/profile save <name>', description: 'Save current provider+model as profile' },
      { key: '/profile list', description: 'List saved profiles' },
      { key: '/openrouter', description: 'OpenRouter routing prefs (prefer/ignore providers, fallbacks, privacy)' },
      { key: '/personality', description: 'List or switch agent tone (concise / verbose / security / senior-reviewer / …)' },
      { key: '/personality <name>', description: 'Activate a personality. /personality off to clear.' },
      { key: '/me', description: 'Your user profile (reply language, style, stack) — adapts the agent to you' },
      { key: '/me init [project]', description: 'Scaffold a profile template (global, or for this project). /me off to disable' },
      { key: '/me learn [on|off]', description: 'Learn durable prefs from this session now; on/off toggles auto-learn. /me forget clears it' },
      { key: '/me sync', description: 'Push your profile to the codeep.dev dashboard (and pull on a fresh machine)' },
      { key: '/agents', description: 'List sub-agents the agent can delegate to (researcher / reviewer / tester / your own)' },
      { key: '/insights [--days N]', description: 'Activity summary — runs, files, tools, projects over the last N days (default 7)' },
    ],
  },
  {
    title: 'Extensions & MCP (2.0)',
    items: [
      { key: '/mcp', description: 'List connected MCP servers + their tools' },
      { key: '/mcp browse [id]', description: 'Browse marketplace (12 servers) or show one' },
      { key: '/mcp install <id> [args]', description: 'Install a marketplace server into this project' },
      { key: '/mcp add <name> <cmd>', description: 'Add a custom MCP server (npx, binary, etc.)' },
      { key: '/mcp remove <name>', description: 'Remove a project-scoped MCP server' },
      { key: '/mcp reload', description: 'Re-read .codeep/mcp_servers.json (after manual edit)' },
      { key: '/mcp resources', description: 'List resources exposed by connected servers' },
      { key: '/mcp read <uri>', description: 'Read one MCP resource' },
      { key: '/mcp prompts', description: 'List prompt templates exposed by servers' },
      { key: '/mcp prompt <server> <name>', description: 'Materialize a prompt with arguments (key=value)' },
      { key: '/hooks', description: 'List installed lifecycle hooks (.codeep/hooks/<event>.sh)' },
      { key: '/commands', description: 'List custom slash commands (.codeep/commands/*.md)' },
    ],
  },
  {
    title: 'Context',
    items: [
      { key: '/context-save', description: 'Save conversation' },
      { key: '/context-load', description: 'Load conversation' },
      { key: '/context-clear', description: 'Clear saved context' },
      { key: '/learn', description: 'Learn code preferences' },
      { key: '/learn status', description: 'Show learned prefs' },
      { key: '/learn rule <text>', description: 'Add custom rule' },
    ],
  },
  {
    title: 'Ollama (Local AI)',
    items: [
      { key: '/provider', description: 'Select "ollama" for local models' },
      { key: '/settings > Ollama URL', description: 'Set URL (default: http://localhost:11434)' },
      { key: '/model', description: 'Pick installed Ollama model dynamically' },
      { key: '/model pull <model>', description: 'Pull an Ollama model (local Ollama only)' },
      { key: '/model browse', description: 'Browse recommended local coding models and pull one' },
      { key: '/model rm <model>', description: 'Remove a locally-installed Ollama model (local only)' },
      { key: 'OLLAMA_HOST=0.0.0.0', description: 'Required env var for remote Ollama access' },
    ],
  },
];
