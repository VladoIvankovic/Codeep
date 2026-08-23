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
 * File format (project / global): legacy prompt-only Markdown remains valid;
 * structured custom bots add a small versioned frontmatter block:
 *   ```
 *   ---
 *   codeep: custom-bot/v1
 *   model: automatic
 *   tools: [files, tests, git]
 *   scope: all
 *   projects: []
 *   ---
 *   # Concise Reviewer
 *   <behavior sections — appended to the system prompt>
 *   ```
 * The first H1 is the display name. Tools/model/scope are enforced only for
 * structured files; old files stay unrestricted.
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
import { basename, join } from 'path';
import { homedir } from 'os';
import { config } from '../config/index.js';
import { getProvider } from '../config/providers.js';
import type { ToolCall } from './tools.js';

export type PersonalityScope = 'builtin' | 'project' | 'global';
export type PersonalityCapability = 'files' | 'terminal' | 'tests' | 'git' | 'web' | 'mcp';
export type PersonalityProjectScope = 'all' | 'selected' | 'personal' | 'unspecified';

export interface PersonalityRuntimeModel {
  providerId: string;
  model: string;
  protocol: 'openai' | 'anthropic';
}

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
  /** True for `custom-bot/v1` files and the previous web section format. */
  structured?: boolean;
  /** False when a frontmatter `codeep` schema marker is present but unsupported. */
  schemaValid?: boolean;
  /** `automatic` inherits the user's current provider/model for this run. */
  modelPreference?: string;
  /** Normalised high-level capabilities selected in the builder. */
  tools?: PersonalityCapability[];
  /** Original declared tool values, retained for diagnostics/UI. */
  declaredTools?: string[];
  /** True when a structured file explicitly declares Tools, including `[]`. */
  restrictTools?: boolean;
  projectScope?: PersonalityProjectScope;
  /** False when versioned metadata explicitly declares an unknown scope. */
  scopeValid?: boolean;
  projects?: string[];
  responsibility?: string;
  responseStyle?: string;
  always?: string[];
  never?: string[];
  advancedInstructions?: string;
}

const CAPABILITIES = new Set<PersonalityCapability>([
  'files', 'terminal', 'tests', 'git', 'web', 'mcp',
]);

const FILE_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_files',
  'create_directory', 'search_code', 'find_files',
];
const WEB_TOOLS = [
  'fetch_url', 'web_search', 'web_read', 'github_read', 'minimax_web_search',
];

function unquoteScalar(value: string | undefined): string {
  return (value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

function splitFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
  codeepDeclared: boolean;
  versioned: boolean;
} {
  const normalised = raw.replace(/^\uFEFF/, '');
  if (!normalised.startsWith('---\n') && !normalised.startsWith('---\r\n')) {
    return { meta: {}, body: normalised, codeepDeclared: false, versioned: false };
  }
  const match = normalised.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { meta: {}, body: normalised, codeepDeclared: false, versioned: false };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (parsed) meta[parsed[1].toLowerCase()] = parsed[2];
  }
  const codeepDeclared = Object.prototype.hasOwnProperty.call(meta, 'codeep');
  return {
    meta,
    body: normalised.slice(match[0].length),
    codeepDeclared,
    versioned: codeepDeclared && unquoteScalar(meta.codeep) === 'custom-bot/v1',
  };
}

function parseInlineList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return trimmed ? [trimmed] : [];
  return trimmed.slice(1, -1).split(',').map(item =>
    item.trim().replace(/^(["'])(.*)\1$/, '$2').trim(),
  ).filter(Boolean);
}

function section(body: string, title: string): string | undefined {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = body.search(new RegExp(`^##\\s+${escaped}\\s*$`, 'im'));
  if (start < 0) return undefined;
  const afterHeading = body.slice(start).replace(/^##[^\n]*(?:\r?\n|$)/, '');
  const next = afterHeading.search(/^##\s+/m);
  return (next < 0 ? afterHeading : afterHeading.slice(0, next)).trim();
}

function listSection(body: string, title: string): string[] {
  const value = section(body, title);
  if (value === undefined) return [];
  return value.split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

function normaliseProjectScope(raw: string | undefined): PersonalityProjectScope {
  const value = unquoteScalar(raw).toLowerCase();
  if (['all', 'all projects'].includes(value)) return 'all';
  if (['selected', 'selected projects', 'current project only'].includes(value)) return 'selected';
  if (['personal', 'personal mode', 'personal mode only'].includes(value)) return 'personal';
  return 'unspecified';
}

function normaliseCapabilities(values: string[]): PersonalityCapability[] {
  const out = new Set<PersonalityCapability>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase() as PersonalityCapability;
    if (CAPABILITIES.has(value)) out.add(value);
  }
  return [...out];
}

function exactModelPreference(preference: string | undefined): { providerId: string; model: string } | null {
  const value = preference?.trim() ?? '';
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const providerId = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  return providerId && model ? { providerId, model } : null;
}

/** Whether a structured bot's model field satisfies the portable v1 contract. */
export function isPersonalityModelPreferenceValid(personality: Personality): boolean {
  if (!personality.structured) return true;
  const preference = personality.modelPreference?.trim() || 'automatic';
  if (preference.toLowerCase() === 'automatic') return true;
  const exact = exactModelPreference(preference);
  if (!exact) return false;
  const provider = getProvider(exact.providerId);
  if (!provider) return false;
  return provider.dynamicModels === true || provider.models.some(item => item.id === exact.model);
}

/** Parse both custom-bot/v1 and the original web builder's heading format. */
export function parsePersonalityMarkdown(
  raw: string,
  name: string,
  scope: PersonalityScope,
): Personality {
  const { meta, body, codeepDeclared, versioned } = splitFrontmatter(raw);
  const h1 = body.match(/^#\s+(?:Personality:\s+)?(.+)$/m);
  const displayName = h1?.[1].trim() ?? name;
  const h1Start = h1 ? body.indexOf(h1[0]) : -1;
  const h1End = h1Start >= 0 ? body.indexOf('\n', h1Start) : -1;
  const promptBody = h1
    ? (h1End >= 0 ? body.slice(h1End + 1) : '').trimStart()
    : body.trimStart();

  const responsibility = section(body, 'Responsibility');
  const responseStyle = section(body, 'Response style');
  const advancedInstructions = section(body, 'Advanced instructions');
  const sectionModel = section(body, 'Model');
  const sectionToolsPresent = /^##\s+Tools\s*$/im.test(body);
  const sectionTools = listSection(body, 'Tools');
  const sectionScope = section(body, 'Scope');
  const sectionProjects = listSection(body, 'Projects');
  // The original section-only builder format has no version marker. A single
  // common heading is not a safe signature (`## Tools` is perfectly ordinary
  // legacy prompt prose), so require Responsibility + another builder
  // section. Heading presence, not content, is what matters once that strong
  // signature is met.
  const standardSections = [
    'Responsibility', 'Response style', 'Always', 'Never', 'Model', 'Tools',
    'Scope', 'Projects', 'Advanced instructions',
  ].filter(title => section(body, title) !== undefined);
  const sectionStructured = standardSections.includes('Responsibility') && standardSections.length >= 2;
  // A declared schema marker owns interpretation even when unsupported. Never
  // reinterpret a typo/future version as permissive legacy prose.
  const structured = codeepDeclared || sectionStructured;
  const schemaValid = !codeepDeclared || versioned;

  const frontmatterToolsPresent = Object.prototype.hasOwnProperty.call(meta, 'tools');
  // Portable v1 requires list syntax. Accepting a malformed scalar such as
  // `tools: files` would silently grant a capability when the fail-closed
  // contract says it must become conversation-only.
  const versionedToolsValue = meta.tools?.trim() ?? '';
  const versionedToolsWellFormed = versionedToolsValue.startsWith('[') && versionedToolsValue.endsWith(']');
  const declaredTools = codeepDeclared
    ? (frontmatterToolsPresent && versionedToolsWellFormed ? parseInlineList(meta.tools) : [])
    : (frontmatterToolsPresent ? parseInlineList(meta.tools) : sectionTools);
  const tools = normaliseCapabilities(declaredTools);
  const frontmatterProjectsPresent = Object.prototype.hasOwnProperty.call(meta, 'projects');
  const versionedProjectsValue = meta.projects?.trim() ?? '';
  const versionedProjectsWellFormed = versionedProjectsValue.startsWith('[') && versionedProjectsValue.endsWith(']');
  const projects = codeepDeclared
    ? (frontmatterProjectsPresent && versionedProjectsWellFormed ? parseInlineList(meta.projects) : [])
    : (frontmatterProjectsPresent ? parseInlineList(meta.projects) : sectionProjects);
  const descriptionFromMeta = unquoteScalar(meta.description);
  const descriptionFromQuote = body.match(/^>\s+(.+)$/m)?.[1]?.trim();
  const firstPara = promptBody.split(/\n\s*\n/)[0]?.replace(/^>\s*/, '').replace(/\s+/g, ' ').trim() ?? '';
  const descriptionRaw = descriptionFromMeta || descriptionFromQuote || firstPara;
  const description = descriptionRaw.length > 200 ? descriptionRaw.slice(0, 197) + '…' : descriptionRaw;
  const modelPreference = unquoteScalar((codeepDeclared ? meta.model : (meta.model || sectionModel)) || 'automatic');
  const frontmatterScopePresent = Object.prototype.hasOwnProperty.call(meta, 'scope');
  const projectScope = normaliseProjectScope(codeepDeclared ? meta.scope : (meta.scope || sectionScope));
  const explicitScopePresent = codeepDeclared ? frontmatterScopePresent : (frontmatterScopePresent || sectionScope !== undefined);
  const scopeValid = !(structured && explicitScopePresent && projectScope === 'unspecified');

  return {
    name,
    displayName,
    description: description || `Custom personality from ${name}.md`,
    prompt: '\n\n## Personality: ' + displayName + '\n\n' + promptBody,
    scope,
    structured,
    schemaValid,
    modelPreference,
    tools,
    declaredTools,
    // Versioned v1 is fail-closed: missing, empty, malformed, or unknown Tools
    // all mean no tools. Only true legacy and compatible section-only files
    // without a Tools heading preserve unrestricted prompt-only behavior.
    restrictTools: codeepDeclared || (sectionStructured && sectionToolsPresent),
    projectScope,
    scopeValid,
    projects,
    responsibility,
    responseStyle,
    always: listSection(body, 'Always'),
    never: listSection(body, 'Never'),
    advancedInstructions,
  };
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
      out.push(parsePersonalityMarkdown(raw, name, scope));
    } catch {
      // Skip broken files — never crash personality loading.
    }
  }
  return out;
}

function globMatchesProject(pattern: string, projectName: string): boolean {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (!escaped) return false;
  return new RegExp(`^${escaped}$`, 'i').test(projectName);
}

/**
 * Scope is enforced against the workspace basename only. This intentionally
 * avoids accepting arbitrary paths from cloud-authored metadata.
 */
export function isPersonalityAvailable(personality: Personality, workspaceRoot?: string): boolean {
  if (personality.schemaValid === false) return false;
  if (!isPersonalityModelPreferenceValid(personality)) return false;
  if (personality.scopeValid === false) return false;
  if (!personality.structured || personality.projectScope === 'unspecified' || personality.projectScope === 'all') {
    return true;
  }
  if (personality.projectScope === 'personal') {
    // With no workspace the caller is explicitly in personal mode. When a
    // root is supplied, a directory without common project markers is also
    // considered personal (the TUI always has a cwd).
    if (!workspaceRoot) return true;
    const markers = [
      '.git', '.hg', '.svn', '.idea',
      'package.json', 'pnpm-workspace.yaml', 'deno.json', 'deno.jsonc',
      'pyproject.toml', 'requirements.txt', 'setup.py',
      'Cargo.toml', 'go.mod', 'Package.swift',
      'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
      'Makefile', 'CMakeLists.txt', 'meson.build', 'WORKSPACE', 'WORKSPACE.bazel',
      'composer.json', 'Gemfile', 'mix.exs', 'pubspec.yaml', 'flake.nix',
      join('.codeep', 'project.json'),
    ];
    if (markers.some(marker => existsSync(join(workspaceRoot, marker)))) return false;
    try {
      const projectContainer = /\.(?:xcodeproj|xcworkspace|sln|code-workspace)$/i;
      if (readdirSync(workspaceRoot).some(entry => projectContainer.test(entry))) return false;
    } catch {
      // An unreadable directory is not safe to classify as explicit personal
      // mode, so fail closed.
      return false;
    }
    return true;
  }
  if (personality.projectScope === 'selected') {
    // A project-local file is inherently selected for that project even when
    // an older file has no explicit Projects list.
    if (personality.scope === 'project') return true;
    if (!workspaceRoot || !personality.projects?.length) return false;
    const projectName = basename(workspaceRoot);
    return personality.projects.some(pattern => globMatchesProject(pattern, projectName));
  }
  return true;
}

/** Concrete tool names that may be advertised for a structured custom bot. */
export function getPersonalityToolAllowlist(
  personality: Personality,
  registeredMcpToolNames: ReadonlySet<string> = new Set(),
): string[] | undefined {
  if (!personality.restrictTools) return undefined;
  const allowed = new Set<string>();
  if (personality.tools?.includes('files')) FILE_TOOLS.forEach(tool => allowed.add(tool));
  if (personality.tools?.includes('terminal') || personality.tools?.includes('tests') || personality.tools?.includes('git')) {
    allowed.add('execute_command');
  }
  if (personality.tools?.includes('web')) WEB_TOOLS.forEach(tool => allowed.add(tool));
  if (personality.tools?.includes('mcp')) registeredMcpToolNames.forEach(tool => allowed.add(tool));
  return [...allowed];
}

function commandName(toolCall: ToolCall): string {
  const value = String(toolCall.parameters.command ?? '').trim();
  return basename(value.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}

function commandArgs(toolCall: ToolCall): string[] {
  const raw = toolCall.parameters.args;
  return Array.isArray(raw) ? raw.map(String) : [];
}

function isTestCommand(toolCall: ToolCall): boolean {
  const command = commandName(toolCall);
  const args = commandArgs(toolCall).map(value => value.toLowerCase());
  if (['pytest', 'vitest', 'jest', 'playwright', 'cypress', 'phpunit'].includes(command)) return true;
  if (command === 'go') return args[0] === 'test';
  if (command === 'cargo' || command === 'swift' || command === 'dotnet') return args[0] === 'test';
  if (command === 'python' || command === 'python3') return args[0] === '-m' && ['pytest', 'unittest'].includes(args[1] ?? '');
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(command)) {
    return args[0] === 'test' || (args[0] === 'run' && /^(test|check)(:|$)/.test(args[1] ?? ''));
  }
  if (command === 'npx') return ['vitest', 'jest', 'playwright', 'cypress'].includes(args[0] ?? '');
  if (command === 'mvn' || command === 'mvnw') return args.some(arg => ['test', 'verify'].includes(arg));
  if (command === 'gradle' || command === 'gradlew') return args.some(arg => /(^|:)test$/.test(arg));
  if (command === 'xcodebuild') return args.includes('test');
  return false;
}

const SAFE_GIT_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'blame', 'branch', 'cat-file', 'check-attr',
  'check-ignore', 'checkout', 'cherry-pick', 'clean', 'commit',
  'count-objects', 'describe', 'diff', 'fetch', 'for-each-ref',
  'format-patch', 'fsck', 'grep', 'init', 'log', 'ls-files', 'ls-remote',
  'ls-tree', 'merge', 'merge-base', 'mv', 'name-rev', 'pull', 'push',
  'range-diff', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'revert',
  'rev-list', 'rev-parse', 'rm', 'shortlog', 'show', 'show-branch',
  'sparse-checkout', 'stash', 'status', 'switch', 'symbolic-ref', 'tag',
  'update-index', 'update-ref', 'whatchanged',
]);

function hasOption(args: string[], ...options: string[]): boolean {
  return args.some(arg => options.some(option => arg === option || arg.startsWith(option + '=')));
}

function hasInlineOption(args: string[], ...options: string[]): boolean {
  return args.some(arg => options.some(option => arg.startsWith(option + '=')));
}

function hasAttachedShortOption(args: string[], option: string): boolean {
  return args.some(arg => arg.startsWith(option) && arg.length > option.length);
}

/**
 * Git can dispatch arbitrary `git-<name>` executables and has several options
 * that deliberately execute shell commands. A Git-only bot therefore uses a
 * conservative built-in allowlist instead of trusting the executable name.
 */
function isRestrictedGitCommandAllowed(toolCall: ToolCall): boolean {
  const executable = commandName(toolCall);
  const args = commandArgs(toolCall);
  if (executable !== 'git') return false;
  if (args.length === 0) return false;

  // Global config/dispatch controls. `-C` is also denied: it can move Git
  // outside the workspace before any subcommand runs.
  if (args.some(arg =>
    arg === '-c' || (arg.startsWith('-c') && arg.length > 2)
    || arg === '-C' || (arg.startsWith('-C') && arg.length > 2)
    || hasOption([arg], '--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace')
  )) return false;

  // Only harmless global flags may precede the subcommand. Everything else
  // fails closed so an unknown global option cannot change executable lookup.
  let index = 0;
  const safeGlobal = new Set([
    '--no-pager', '--no-replace-objects', '--literal-pathspecs',
    '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  ]);
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--version' && args.length === 1) return true;
    if (!safeGlobal.has(args[index])) return false;
    index++;
  }
  const subcommand = args[index]?.toLowerCase();
  if (!subcommand) return false;
  const rest = args.slice(index + 1);
  const restLower = rest.map(arg => arg.toLowerCase());

  // Custom aliases and helpers are executable programs. Unknown subcommands
  // are denied by the allowlist below; these explicit names document the
  // high-risk surfaces and guard future allowlist expansion.
  if (['config', 'alias', 'difftool', 'mergetool', 'filter-branch', 'credential', 'help', 'web--browse', 'instaweb'].includes(subcommand)) {
    return false;
  }

  // Reject flags that launch a shell/helper/editor/signing program or replace
  // the remote-side Git binary. `ext::` and unknown `scheme::` URLs dispatch
  // remote-helper executables, so they are denied too.
  if (hasOption(
    rest,
    '--exec', '--config-env', '--ext-diff', '--textconv',
    '--upload-pack', '--receive-pack', '--open-files-in-pager',
    '--show-signature', '--gpg-sign', '--local-user', '--edit-description',
    // These embed filesystem paths in an option token. The generic command
    // validator deliberately skips option-shaped args, so a restricted Git
    // bot must reject them here rather than accidentally writing outside the
    // workspace (for example `diff --output=/tmp/result`).
    '--unsafe-paths', '--separate-git-dir', '--output', '--output-directory',
    '--directory', '--pathspec-from-file', '--template', '--index-output',
    '--object-directory', '--alternate-refs-command', '--contents',
    '--build-fake-ancestor', '--mailmap-file', '--signature-file',
  )) return false;
  // Long `--file=/outside` and attached short path/editor variants bypass the
  // generic shell path check because the entire argument begins with `-`.
  if (hasInlineOption(rest, '--file')) return false;
  if (subcommand === 'format-patch' && (rest.includes('-o') || hasAttachedShortOption(rest, '-o'))) return false;
  if (subcommand === 'init' && (rest.includes('-t') || hasAttachedShortOption(rest, '-t'))) return false;
  if (['fetch', 'pull', 'ls-remote'].includes(subcommand) && (rest.includes('-u') || hasAttachedShortOption(rest, '-u'))) return false;
  if (subcommand === 'grep' && (
    rest.includes('-O') || hasAttachedShortOption(rest, '-O')
    || hasAttachedShortOption(rest, '-f')
  )) return false;
  if (rest.some(arg => /^-[S]($|.)/.test(arg))) return false;
  if (rest.some(arg => {
    const match = arg.match(/^([a-z][a-z0-9+.-]*)::/i);
    return match ? !['http', 'https', 'ssh', 'git', 'file'].includes(match[1].toLowerCase()) : false;
  })) return false;

  if (subcommand === 'submodule') {
    const operation = restLower.find(arg => !arg.startsWith('-'));
    return operation === undefined || operation === 'status' || operation === 'summary';
  }
  if (subcommand === 'bisect') {
    const operation = restLower.find(arg => !arg.startsWith('-'));
    return operation !== 'run' && ['start', 'bad', 'good', 'new', 'old', 'reset', 'log', 'terms'].includes(operation ?? '');
  }
  if (subcommand === 'rebase') {
    if (rest.some(arg => arg === '-x' || arg.startsWith('-x') || arg === '-i')) return false;
    if (hasOption(rest, '--exec', '--interactive', '--edit-todo', '--strategy')) return false;
    if (rest.includes('-s')) return false;
    if (rest.includes('--continue')) return false; // may launch the configured editor
  }
  if (['merge', 'cherry-pick', 'revert'].includes(subcommand)) {
    if (hasOption(rest, '--strategy')) return false;
    if (rest.includes('-s')) return false;
    if (hasOption(rest, '--edit') || rest.includes('-e')) return false;
  }
  if (subcommand === 'merge') {
    const avoidsEditor = hasOption(rest, '--no-edit', '--message')
      || rest.some(arg => arg === '-m' || arg.startsWith('-m'))
      || rest.some(arg => ['--ff-only', '--squash', '--no-commit', '--abort', '--quit'].includes(arg));
    if (!avoidsEditor) return false;
  }
  if (subcommand === 'pull') {
    if (hasOption(rest, '--edit') || rest.includes('-e') || rest.includes('--rebase=interactive')) return false;
    const avoidsEditor = hasOption(rest, '--no-edit')
      || rest.includes('--ff-only')
      || rest.includes('--rebase')
      || rest.includes('-r')
      || rest.some(arg => ['--rebase=true', '--rebase=merges', '--rebase=preserve'].includes(arg));
    if (!avoidsEditor) return false;
  }
  if (subcommand === 'revert') {
    const avoidsEditor = hasOption(rest, '--no-edit', '--no-commit')
      || rest.includes('-n')
      || rest.some(arg => ['--abort', '--quit'].includes(arg));
    if (!avoidsEditor) return false;
  }
  if (subcommand === 'commit') {
    if (rest.includes('-e') || rest.includes('--edit')) return false;
    if (hasOption(rest, '--reedit-message')) return false;
    // A bare commit launches core.editor, which may itself be an arbitrary
    // shell command. Git-only bots must supply a message (or reuse one).
    if (hasAttachedShortOption(rest, '-F') || rest.includes('-t') || hasAttachedShortOption(rest, '-t')) return false;
    const hasMessage = rest.some(arg => arg === '-m' || arg.startsWith('-m') || arg === '-F')
      || hasOption(rest, '--message', '--file', '--reuse-message')
      || rest.includes('--no-edit');
    if (!hasMessage) return false;
  }
  if (subcommand === 'tag') {
    if (hasOption(rest, '--sign') || rest.includes('-s') || rest.includes('-u') || hasAttachedShortOption(rest, '-u')) return false;
    const annotated = rest.includes('-a') || rest.includes('--annotate');
    if (hasAttachedShortOption(rest, '-F')) return false;
    const hasMessage = rest.some(arg => arg === '-m' || arg.startsWith('-m') || arg === '-F')
      || hasOption(rest, '--message', '--file');
    if (annotated && !hasMessage) return false; // otherwise Git launches an editor
  }

  return SAFE_GIT_SUBCOMMANDS.has(subcommand);
}

/** Runtime gate. It is deliberately stricter than the prompt/tool catalog. */
export function isPersonalityToolCallAllowed(
  personality: Personality,
  toolCall: ToolCall,
  registeredMcpToolNames: ReadonlySet<string> = new Set(),
): boolean {
  if (!personality.restrictTools) return true;
  const tool = toolCall.tool.toLowerCase().replace(/-/g, '_');
  if (FILE_TOOLS.includes(tool)) return personality.tools?.includes('files') === true;
  if (WEB_TOOLS.includes(tool)) return personality.tools?.includes('web') === true;
  if (tool === 'execute_command') {
    if (personality.tools?.includes('terminal')) return true;
    if (personality.tools?.includes('git') && isRestrictedGitCommandAllowed(toolCall)) return true;
    if (personality.tools?.includes('tests') && isTestCommand(toolCall)) return true;
    return false;
  }
  if (registeredMcpToolNames.has(toolCall.tool)) return personality.tools?.includes('mcp') === true;
  // Skills, delegation, vision, and future tools are denied until a portable
  // schema adds a capability that can classify them without guessing.
  return false;
}

/** Resolve an exact provider/model preference without mutating global config. */
export function resolvePersonalityRuntimeModel(
  personality: Personality,
  current: { providerId: string; model: string; protocol: 'openai' | 'anthropic' },
): PersonalityRuntimeModel | null {
  const preference = personality.modelPreference?.trim();
  if (!personality.structured || !preference || preference.toLowerCase() === 'automatic') return null;
  // v1 deliberately requires an exact provider/model pair. Invalid bots are
  // unavailable at activation time; keep this guard for callers holding a
  // stale parsed object from before a file changed.
  if (!isPersonalityModelPreferenceValid(personality)) return null;
  const exact = exactModelPreference(preference);
  if (!exact) return null;
  const { providerId, model } = exact;
  const provider = getProvider(providerId);
  if (!provider) return null;
  const protocol = providerId === current.providerId && provider.protocols[current.protocol]
    ? current.protocol
    : provider.defaultProtocol;
  return { providerId, model, protocol };
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
  const personality = loadAllPersonalities(workspaceRoot).find((p) => p.name === lower) ?? null;
  return personality && isPersonalityAvailable(personality, workspaceRoot) ? personality : null;
}

export function getActivePersonality(workspaceRoot?: string): Personality | null {
  const name = config.get('activePersonality') as string | null | undefined;
  return name ? findPersonality(name, workspaceRoot) : null;
}

/**
 * Returns the prompt addendum for the currently active personality, or
 * '' when none is set. Called from agent.ts after the base system prompt
 * is composed — appended last so personality overrides apply even if
 * project rules conflict.
 */
export function getActivePersonalityPrompt(workspaceRoot?: string): string {
  return getActivePersonality(workspaceRoot)?.prompt ?? '';
}

export function formatPersonalityActivation(personality: Personality): string {
  const lines = [
    `Active personality: **${personality.displayName}** (\`${personality.name}\`, ${personality.scope})`,
    '',
    `_${personality.description}_`,
  ];
  if (personality.structured) {
    const model = personality.modelPreference?.toLowerCase() === 'automatic'
      ? 'Automatic (inherits the current model)'
      : personality.modelPreference || 'Automatic';
    const tools = personality.restrictTools
      ? (personality.declaredTools?.join(', ') || 'none')
      : 'Unrestricted';
    lines.push('', `**Model:** ${model} · **Tools:** ${tools} · **Availability:** ${personality.projectScope ?? 'unspecified'}`);
    // Granting Git without Files still exposes committed file contents:
    // `git show HEAD:secrets.env` is functionally `cat secrets.env`, and
    // history inspection cannot be separated from the content it inspects.
    // Say so where the capability is shown, rather than implying otherwise.
    if (personality.restrictTools
        && personality.tools?.includes('git')
        && !personality.tools.includes('files')) {
      lines.push('', '_Note: Git is not read-only. It reads committed file contents (`git show HEAD:file`) and can stage, commit and push changes (`git rm`, `git commit`, `git push`). Grant it only if this bot may do both._');
    }
  }
  lines.push('', 'Clear with `/personality off`.');
  return lines.join('\n');
}

export function formatPersonalityList(workspaceRoot?: string): string {
  const list = loadAllPersonalities(workspaceRoot);
  const active = config.get('activePersonality') as string | null | undefined;
  const lines: string[] = ['## Personalities', ''];
  const activeEntry = active ? list.find(personality => personality.name === active) : undefined;
  const activeAvailable = activeEntry ? isPersonalityAvailable(activeEntry, workspaceRoot) : false;
  if (active && activeAvailable) {
    lines.push(`**Active:** \`${active}\` — switch with \`/personality <name>\` or clear with \`/personality off\`.`);
  } else if (active) {
    lines.push(`**Configured:** \`${active}\` is not available in this workspace, so the agent uses default behavior here.`);
  } else {
    lines.push('**Active:** _(none — agent uses default tone)_');
  }
  lines.push('');
  lines.push('| Name | Scope | Model | Tools | Description |');
  lines.push('|---|---|---|---|---|');
  const cell = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  for (const p of list) {
    const tag = p.scope === 'builtin' ? 'built-in' : p.scope;
    const marker = active === p.name && activeAvailable ? ' ✓' : '';
    const available = isPersonalityAvailable(p, workspaceRoot);
    const scopeLabel = p.projectScope && p.projectScope !== 'unspecified' ? ` · ${p.projectScope}` : '';
    const availability = available ? '' : ' _(not available here)_';
    const model = p.structured ? (p.modelPreference || 'automatic') : 'inherit';
    const tools = p.restrictTools ? (p.declaredTools?.join(', ') || 'none') : 'unrestricted';
    lines.push(`| \`${p.name}\`${marker} | ${cell(tag + scopeLabel)} | ${cell(model)} | ${cell(tools)} | ${cell(p.description)}${availability} |`);
  }
  lines.push('');
  lines.push('Drop a `<name>.md` file into `.codeep/personalities/` (project) or `~/.codeep/personalities/` (global) to add your own — first `#` line becomes the display name, body becomes the prompt addendum.');
  return lines.join('\n');
}
