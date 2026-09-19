// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
import { basename as pathBasename } from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { StdioTransport, AcpRequestError } from './transport.js';
import {
  InitializeParams, InitializeResult,
  SessionNewParams, SessionNewResult,
  SessionLoadParams, SessionLoadResult,
  SessionResumeParams, SessionResumeResult,
  SessionPromptParams,
  SessionCancelParams,
  SessionModeState, SessionConfigOption,
  JsonRpcRequest, JsonRpcNotification,
  RequestPermissionParams, RequestPermissionResult, PermissionOption,
  ListPersonalitiesParams, ListPersonalitiesResult,
  SetPersonalityParams, SetPersonalityResult,
  SyncPersonalitiesParams, SyncPersonalitiesResult,
  TerminalCreateResult, TerminalOutputResult,
  McpServer,
} from './protocol.js';
import { runAgentSession } from './session.js';
import { loadCustomCommands } from '../utils/customCommands.js';
import { registerSessionServers, disposeAllSessions as disposeAllMcpSessions } from '../utils/mcpRegistry.js';
import { selectSessionMcpServers } from '../utils/mcpConfig.js';
import { handleMcpSamplingRequest } from '../utils/mcpSamplingBridge.js';
import { executeCommandAsync, validateCommandAsync, commandEnv } from '../utils/shell.js';
import { checkCommandRateLimit } from '../utils/ratelimit.js';
import { recordCommand } from '../utils/history.js';
import { PermissionOutcome } from '../utils/agent.js';
import { ToolCall } from '../utils/tools.js';
import { trustBearingWrite, type TrustBearingWrite } from '../utils/toolExecution.js';
import { initWorkspace, loadWorkspace, handleCommand, type AcpSession, type AcpAgentRunOptions } from './commands.js';
import { beginTurn } from './turns.js';
import {
  handleSetMode as handleSetModeExternal,
  handleSetConfigOption as handleSetConfigOptionExternal,
  handleSessionList as handleSessionListExternal,
  handleSessionDelete as handleSessionDeleteExternal,
  handleListProviders as handleListProvidersExternal,
  type AcpHandlerDeps,
} from './serverHandlers.js';
import { saveSession, startNewSession, config, getApiKey, getConfiguredProviders } from '../config/index.js';
import { ApiError } from '../api/index.js';
import { PROVIDERS } from '../config/providers.js';
import { getCurrentVersion } from '../utils/update.js';
import { reportStats, syncSession, generateProjectId, pullPersonalities } from '../utils/codeepCloud.js';
import { getCostBreakdown, getRecordCount, createTokenScope, runWithTokenScope, type TokenScope } from '../utils/tokenTracker.js';
import { isGitRepository } from '../utils/git.js';
import { getProjectContext } from '../utils/project.js';
import { findPersonality, isPersonalityAvailable, loadAllPersonalities, type Personality } from '../utils/personalities.js';

// ─── Slash commands advertised to Zed ────────────────────────────────────────

const AVAILABLE_COMMANDS = [
  // Configuration
  { name: 'help',      description: 'Show available commands' },
  { name: 'status',    description: 'Show current config and session info' },
  { name: 'version',   description: 'Show version and current model' },
  { name: 'provider',  description: 'List or switch provider', input: { hint: '<provider-id>' } },
  { name: 'model',     description: 'List or switch model', input: { hint: '<model-id>' } },
  { name: 'login',     description: 'Set API key for a provider', input: { hint: '<providerId> <apiKey>' } },
  { name: 'apikey',    description: 'Show or set API key for current provider', input: { hint: '<key>' } },
  { name: 'lang',      description: 'Set response language', input: { hint: '<code> (en, hr, auto…)' } },
  { name: 'grant',     description: 'Grant write access for workspace' },
  // Sessions
  { name: 'session',   description: 'List sessions, or: new / load <name>', input: { hint: 'new | load <name>' } },
  { name: 'save',      description: 'Save current session', input: { hint: '[name]' } },
  { name: 'recall',    description: 'Search across ALL saved sessions (cross-session)', input: { hint: '<query> [--summarize]' } },
  // Context
  { name: 'add',       description: 'Add files to agent context', input: { hint: '<file> [file2…]' } },
  { name: 'drop',      description: 'Remove files from context (no args = clear all)', input: { hint: '[file…]' } },
  // Actions
  { name: 'diff',      description: 'Git diff with AI review', input: { hint: '[--staged]' } },
  { name: 'undo',      description: 'Undo last agent action' },
  { name: 'undo-all',  description: 'Undo all agent actions in session' },
  { name: 'changes',   description: 'Show all changes made in session' },
  { name: 'cost',      description: 'Show per-session token usage and estimated cost' },
  { name: 'compact',   description: 'Summarize older messages to free up context', input: { hint: '[keepN]' } },
  { name: 'checkpoint', description: 'Save a named snapshot of the current session (or `delete <id>`)', input: { hint: '[name] | delete <id>' } },
  { name: 'checkpoints', description: 'List saved checkpoints in this workspace' },
  { name: 'rewind',    description: 'Restore a session checkpoint by id', input: { hint: '<id>' } },
  { name: 'hooks',     description: 'List installed lifecycle hooks in .codeep/hooks/' },
  { name: 'mcp',       description: 'Manage MCP servers, marketplace, resources, prompts', input: { hint: '[browse | install <id> | add | remove | reload | resources | read <uri> | prompts | prompt <server> <name>]' } },
  { name: 'openrouter', description: 'OpenRouter routing preferences (prefer/ignore/fallbacks/privacy/clear)', input: { hint: '[show | prefer <p,...> | ignore <p,...> | fallbacks on|off | privacy strict|allow | clear]' } },
  { name: 'export',    description: 'Export conversation', input: { hint: 'json | md | txt' } },
  // Plan mode (2.0.2)
  { name: 'plan',      description: 'Generate a numbered plan for a task — review before /go executes', input: { hint: '<task>' } },
  { name: 'go',        description: 'Execute the pending plan from /plan' },
  // Personalities + insights (2.0.3)
  { name: 'personality', description: 'List or switch a personality or structured custom bot', input: { hint: '[name | off]' } },
  { name: 'me',        description: 'Your user profile — adapts the agent to you (reply language, style, stack)', input: { hint: '[init [project] | on | off | learn [on|off|project] | forget | sync]' } },
  { name: 'agents',    description: 'List sub-agents the agent can delegate self-contained tasks to' },
  { name: 'insights',  description: 'Activity summary over the last N days (default 7)', input: { hint: '[--days N]' } },
  // Project intelligence
  { name: 'scan',      description: 'Scan project structure and generate summary' },
  { name: 'review',    description: 'AI review of git changes (--staged), or static analysis (--static / files)', input: { hint: '[--staged | --static | file…]' } },
  { name: 'learn',     description: 'Learn coding preferences from project files' },
  { name: 'memory',    description: 'Project memory notes — add / list / remove / clear', input: { hint: '<note> | list | remove <n> | clear' } },
  { name: 'profile',   description: 'Save / load / delete provider+model presets', input: { hint: 'save | load | delete | list | <name>' } },
  // Privacy toggles
  { name: 'telemetry', description: 'Show or toggle automatic cloud telemetry', input: { hint: '[on|off]' } },
  { name: 'keysync',   description: 'Show or toggle syncing API keys to codeep.dev (off by default)', input: { hint: '[on|off]' } },
  // Skills + custom commands
  { name: 'skills',    description: 'List/create/share skill bundles. Subcommands: bundles, create-bundle, show, publish, install, browse, unpublish', input: { hint: '[query] | bundles | create-bundle <name> | show <name> | publish <slug> [--public] | install <owner>/<slug> | browse [q] | unpublish <owner>/<slug>' } },
  { name: 'commands',  description: 'List user-authored commands from .codeep/commands/*.md' },
  { name: 'commit',    description: 'Generate commit message and commit' },
  { name: 'fix',       description: 'Fix bugs or issues' },
  { name: 'test',      description: 'Write or run tests' },
  { name: 'docs',      description: 'Generate documentation' },
  { name: 'refactor',  description: 'Refactor code' },
  { name: 'explain',   description: 'Explain code' },
  { name: 'optimize',  description: 'Optimize code for performance' },
  { name: 'debug',     description: 'Debug an issue' },
  { name: 'push',      description: 'Git push' },
  { name: 'pr',        description: 'Create a pull request' },
  { name: 'build',     description: 'Build the project' },
  { name: 'deploy',    description: 'Deploy the project' },
];

// ─── Mode definitions ─────────────────────────────────────────────────────────
// Exported for unit testing + reference from serverHandlers modules.

export const AGENT_MODES: SessionModeState = {
  currentModeId: 'auto',
  availableModes: [
    { id: 'auto',   name: 'Auto',   description: 'Agent runs automatically without confirmation' },
    { id: 'manual', name: 'Manual', description: 'Confirm dangerous operations before running' },
  ],
};

// ─── Config options ───────────────────────────────────────────────────────────

const LANGUAGE_OPTIONS = [
  { value: 'auto', name: 'Auto' },
  { value: 'en',   name: 'English' },
  { value: 'zh',   name: 'Chinese' },
  { value: 'es',   name: 'Spanish' },
  { value: 'fr',   name: 'French' },
  { value: 'de',   name: 'German' },
  { value: 'ja',   name: 'Japanese' },
  { value: 'ru',   name: 'Russian' },
  { value: 'pt',   name: 'Portuguese' },
  { value: 'ar',   name: 'Arabic' },
  { value: 'hi',   name: 'Hindi' },
  { value: 'hr',   name: 'Croatian' },
];

/**
 * Format a tool call's parameters into a human-readable object for the
 * permission dialog. Truncates long content fields so the dialog stays readable.
 *
 * Exported for unit testing (see server.test.ts).
 */
export function formatToolInputForPermission(tool: string, params: Record<string, unknown>): Record<string, string> {
  const MAX_LEN = 120;
  // Bigger budget for diff/content fields so clients can render an actual preview
  // before the user clicks Allow. Truncated with a visible marker so users know
  // they're not seeing the full payload.
  const MAX_DIFF_LEN = 4000;
  const MAX_CONTENT_LINES = 200;
  const truncate = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '…' : s;
  };
  const truncateDiff = (s: string): string =>
    s.length > MAX_DIFF_LEN ? s.slice(0, MAX_DIFF_LEN) + `\n… (truncated, ${s.length - MAX_DIFF_LEN} more chars)` : s;

  switch (tool) {
    case 'write_file':
    case 'edit_file': {
      const path = params.path as string ?? '';
      const out: Record<string, string> = { file: pathBasename(path), path };
      if (typeof params.content === 'string') {
        const lines = params.content.split('\n');
        out.changes = `${lines.length} lines`;
        out.new_content = lines.length > MAX_CONTENT_LINES
          ? lines.slice(0, MAX_CONTENT_LINES).join('\n') + `\n… (${lines.length - MAX_CONTENT_LINES} more lines)`
          : params.content;
      }
      // The built-in edit_file tool schema emits old_text / new_text (see
      // utils/tools.ts); accept the old_string/new_string spelling too for
      // robustness. Without this the permission dialog dropped the diff and
      // showed only { file, path } — the user approved edits blind.
      const oldText = typeof params.old_text === 'string' ? params.old_text as string
        : (typeof params.old_string === 'string' ? params.old_string as string : undefined);
      const newText = typeof params.new_text === 'string' ? params.new_text as string
        : (typeof params.new_string === 'string' ? params.new_string as string : undefined);
      if (oldText !== undefined && newText !== undefined) {
        out.changes = `replace ${oldText.split('\n').length} line(s)`;
        out.old_string = truncateDiff(oldText);
        out.new_string = truncateDiff(newText);
      }
      return out;
    }
    case 'delete_file':
      return { file: pathBasename(params.path as string ?? ''), path: params.path as string ?? '' };
    case 'execute_command':
      return {
        command: params.command as string ?? '',
        args: Array.isArray(params.args) ? (params.args as string[]).join(' ') : '',
        cwd: params.cwd as string ?? '',
      };
    case 'create_directory':
      return { path: params.path as string ?? '' };
    default: {
      // Generic: show all keys but truncate values
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) out[k] = truncate(v);
      return out;
    }
  }
}

/**
 * Resolve a `file://` (or absolute path) URI to a local filesystem path.
 * Returns null for unsupported schemes (http/https/git/etc.) — we only embed
 * local content for safety/privacy.
 *
 * Exported for unit testing (see server.test.ts).
 */
export function resolveLocalPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('file://')) {
    try { return fileURLToPath(uri); } catch { return null; }
  }
  // Bare absolute path (some clients drop the scheme)
  if (uri.startsWith('/')) return uri;
  return null;
}

/**
 * Walk the prompt's ContentBlock[] looking for ResourceLink and Resource
 * blocks. ResourceLink → read file from disk. Resource → use embedded text.
 * Returns a markdown-fenced snippet block ready to prepend to the prompt,
 * or empty string if there are no embedded contexts.
 *
 * Exported for unit testing (see server.test.ts).
 */
export async function collectEmbeddedContext(blocks: import('./protocol.js').ContentBlock[]): Promise<string> {
  const MAX_BYTES_PER_FILE = 200_000; // ~200 KB cap per resource
  const snippets: string[] = [];

  for (const block of blocks) {
    if (block.type === 'resource_link') {
      const local = resolveLocalPath(block.uri ?? '');
      const label = block.name || block.uri || 'resource';
      if (!local) {
        snippets.push(`[Resource link: ${label}] (skipped — non-local URI)`);
        continue;
      }
      try {
        const buf = await readFile(local);
        const truncated = buf.byteLength > MAX_BYTES_PER_FILE;
        const text = buf.subarray(0, MAX_BYTES_PER_FILE).toString('utf8');
        const note = truncated ? `\n… (truncated, ${buf.byteLength - MAX_BYTES_PER_FILE} more bytes)` : '';
        snippets.push(`File: ${block.name || pathBasename(local)}\n\`\`\`\n${text}${note}\n\`\`\``);
      } catch (err) {
        snippets.push(`[Resource link: ${label}] (read failed: ${(err as Error).message})`);
      }
    } else if (block.type === 'resource' && block.resource) {
      const r = block.resource;
      const label = r.uri || 'resource';
      if (typeof r.text === 'string' && r.text.length > 0) {
        const truncated = r.text.length > MAX_BYTES_PER_FILE;
        const text = truncated ? r.text.slice(0, MAX_BYTES_PER_FILE) : r.text;
        const note = truncated ? `\n… (truncated, ${r.text.length - MAX_BYTES_PER_FILE} more chars)` : '';
        snippets.push(`Resource: ${label}\n\`\`\`\n${text}${note}\n\`\`\``);
      } else if (r.uri) {
        // Embedded resource without text — try local file fallback
        const local = resolveLocalPath(r.uri);
        if (local) {
          try {
            const buf = await readFile(local);
            const truncated = buf.byteLength > MAX_BYTES_PER_FILE;
            const text = buf.subarray(0, MAX_BYTES_PER_FILE).toString('utf8');
            const note = truncated ? `\n… (truncated, ${buf.byteLength - MAX_BYTES_PER_FILE} more bytes)` : '';
            snippets.push(`Resource: ${pathBasename(local)}\n\`\`\`\n${text}${note}\n\`\`\``);
          } catch (err) {
            snippets.push(`[Resource: ${label}] (read failed: ${(err as Error).message})`);
          }
        }
      }
    }
  }

  return snippets.join('\n\n');
}

/** Check if a provider has an API key stored (synchronous; relies on the cache
 *  loaded at startup via loadAllApiKeys and the non-secret configuredProviderIds
 *  index — never reads plaintext key material).
 *
 *  Exported for unit testing (see server.test.ts).
 */
export function providerHasKey(providerId: string): boolean {
  // Check environment variable first
  const envKey = PROVIDERS[providerId]?.envKey;
  if (envKey && process.env[envKey]) return true;
  // In-memory cache (populated from secure storage at startup)
  if (getApiKey(providerId)) return true;
  // Non-secret index of providers that have a key in secure storage
  return getConfiguredProviders().some(p => p.id === providerId);
}

/**
 * Build the list of session-level config options advertised to the ACP client
 * (provider/model picker, language, per-tool confirmation toggles).
 *
 * Reads the global config + provider table; pure of transport/session state.
 * Exported for unit testing (see server.test.ts).
 */
export function buildConfigOptions(): SessionConfigOption[] {
  const currentModel = config.get('model') ?? '';
  const currentProviderId = config.get('provider') ?? '';
  // Only show providers that have an API key configured
  const modelOptions: { value: string; name: string }[] = [];
  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    if (!providerHasKey(providerId)) continue;
    for (const model of provider.models) {
      modelOptions.push({
        value: `${providerId}/${model.id}`,
        name: model.name,
      });
    }
  }
  // Always include current provider's models even if key is missing (avoids empty list)
  if (modelOptions.length === 0) {
    const fallback = PROVIDERS[currentProviderId];
    if (fallback) {
      for (const model of fallback.models) {
        modelOptions.push({ value: `${currentProviderId}/${model.id}`, name: model.name });
      }
    }
  }
  const compositeValue = `${currentProviderId}/${currentModel}`;
  const currentValue = modelOptions.some(o => o.value === compositeValue)
    ? compositeValue
    : (modelOptions[0]?.value ?? '');
  const currentLanguage = (config.get('language') as string) || 'auto';
  const boolToStr = (v: boolean) => (v ? 'true' : 'false');
  // Zed (and most ACP clients) only show the selected option's name — not the
  // dropdown's `name`. Prefix each option with the action so three different
  // boolean toggles aren't all displayed as just "ON" / "OFF".
  const makeBoolOptions = (label: string) => [
    { value: 'true',  name: `${label}: ON` },
    { value: 'false', name: `${label}: OFF` },
  ];
  return [
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model' as const,
      type: 'select' as const,
      currentValue,
      options: modelOptions,
    },
    {
      id: 'language',
      name: 'Language',
      description: 'Response language',
      category: null,
      type: 'select' as const,
      currentValue: currentLanguage,
      options: LANGUAGE_OPTIONS,
    },
    {
      id: 'agentConfirmDeleteFile',
      name: 'Confirm: delete_file',
      description: 'Require permission before deleting files',
      category: null,
      type: 'select' as const,
      currentValue: boolToStr(config.get('agentConfirmDeleteFile') !== false),
      options: makeBoolOptions('Confirm delete'),
    },
    {
      id: 'agentConfirmExecuteCommand',
      name: 'Confirm: execute_command',
      description: 'Require permission before running shell commands',
      category: null,
      type: 'select' as const,
      currentValue: boolToStr(config.get('agentConfirmExecuteCommand') !== false),
      options: makeBoolOptions('Confirm exec'),
    },
    {
      id: 'agentConfirmWriteFile',
      name: 'Confirm: write_file / edit_file',
      description: 'Require permission before writing or editing files',
      category: null,
      type: 'select' as const,
      currentValue: boolToStr(config.get('agentConfirmWriteFile') === true),
      options: makeBoolOptions('Confirm write'),
    },
  ];
}

/** Build the stable Codeep ACP personality extension payload for a workspace. */
export function buildPersonalityListResult(workspaceRoot: string): ListPersonalitiesResult {
  const personalities = loadAllPersonalities(workspaceRoot).map(personality => ({
    name: personality.name,
    displayName: personality.displayName,
    description: personality.description,
    structured: personality.structured === true,
    restrictTools: personality.restrictTools === true,
    scope: personality.scope,
    model: personality.structured ? (personality.modelPreference ?? 'automatic') : 'automatic',
    tools: personality.structured ? (personality.tools ?? []) : [],
    projectScope: personality.projectScope ?? 'unspecified',
    projects: personality.projects ?? [],
    available: isPersonalityAvailable(personality, workspaceRoot),
  }));
  const configuredActive = (config.get('activePersonality') as string | null | undefined) ?? null;
  const activePersonality = configuredActive && personalities.some(personality => personality.name === configuredActive && personality.available)
    ? configuredActive
    : null;
  return { personalities, activePersonality };
}

/** Resolve an ACP selection using the same scope/model availability gate as list. */
export function resolvePersonalitySelection(personalityId: unknown, workspaceRoot: string): Personality | null {
  if (typeof personalityId !== 'string') return null;
  const personality = findPersonality(personalityId, workspaceRoot);
  return personality && isPersonalityAvailable(personality, workspaceRoot) ? personality : null;
}

// ─── execute_command ─────────────────────────────────────────────────────────

export interface AcpCommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Per-command budget, the same one a local run gets. */
export const ACP_COMMAND_TIMEOUT_MS = 120_000;

export interface AcpCommandContext {
  transport: Pick<StdioTransport, 'request'>;
  sessionId: string;
  clientSupportsTerminal: boolean;
  /** The prompt's signal: firing it kills a command in the client terminal. */
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * Read the exit code from a terminal/wait_for_exit answer. ACP sends
 * `{ exitCode, signal }`; older clients nest `{ type, code }` under
 * `exitStatus`. Returns null when the answer carries no exit status.
 *
 * Exported for unit testing (see server.command.test.ts).
 */
export function exitCodeFromWaitResult(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const outer = result as Record<string, unknown>;
  const status = (outer.exitStatus && typeof outer.exitStatus === 'object' ? outer.exitStatus : outer) as Record<string, unknown>;
  if (typeof status.exitCode === 'number') return status.exitCode;
  if (status.type === 'exited' && typeof status.code === 'number') return status.code;
  // Ended by a signal
  if (status.type === 'killed' || (typeof status.signal === 'string' && status.signal)) return 1;
  return null;
}

/**
 * `GIT_CONFIG_COUNT` and the `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * pairs it counts — the numbered half of what hardenedGitEnv() produces.
 */
const GIT_CONFIG_ENV_NAME = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

/**
 * The rest of what the terminal has to be given by name — see acpEnvList().
 *
 * `GIT_PAGER` and `GIT_TERMINAL_PROMPT` are hardenedGitEnv()'s two
 * non-numbered outputs. `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` /
 * `GIT_CONFIG_NOSYSTEM` are the variables the SCAN itself read the config
 * through: leaving them behind would let the terminal's git resolve a
 * different global config than the one Codeep just decided was safe.
 *
 * Everything after them is there for a client that REPLACES its environment
 * with this list rather than extending it, and it is the half the first cut
 * of this hotfix got wrong: the list was `PATH` and `HOME` — enough for the
 * hardened `git status` it was written for — while acpEnvList() is applied
 * to EVERY command handed to terminal/create. Against a replacing client
 * that cost an ordinary command things that are not secrets and that it had
 * in the user's own shell: `git push` over SSH had no agent socket to sign
 * with and fell back to asking for a password on a terminal whose
 * GIT_TERMINAL_PROMPT is `0`, which fails it outright; a test that sorts
 * strings or formats a date ran under the C locale instead of the user's; a
 * build had nowhere but the default /tmp to put its temporaries; anything
 * behind a corporate proxy could not reach the network at all; and a
 * toolchain installed under a version manager lost the variable its shim
 * reads to pick a version.
 *
 * It stays an ALLOWLIST rather than becoming "process.env minus the names
 * that look like credentials", because what made the change necessary is
 * that `env` is not a private channel (see acpEnvList) and a name-shaped
 * denylist does not recognise `DATABASE_URL`, a company's own `ACME_CREDS`,
 * or anything else whose name does not say what it holds. A name gets in
 * here only when it is known not to hold one.
 *
 * The one value below that CAN carry a credential is a proxy URL
 * (`https_proxy=http://user:pass@proxy`), which is why redactCredentials()
 * in src/acp/transport.ts has a rule for that exact shape. A command behind
 * a proxy cannot reach the network without it.
 */
const ACP_TERMINAL_ENV_NAMES: ReadonlySet<string> = new Set([
  // hardenedGitEnv()'s own, and what the scan read the config through.
  'GIT_PAGER',
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  // Where programs are found, and whose account runs them. No `PWD`: the
  // terminal's working directory is the `cwd` of the terminal/create, and
  // this process's would tell a shell script it is somewhere it is not.
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  // The agent socket `git push` and `git fetch` over SSH sign with.
  'SSH_AUTH_SOCK',
  // Where a build puts its temporaries.
  'TMPDIR',
  'TMP',
  'TEMP',
  // The locale a test that sorts strings or formats a date asserts against.
  'LANG',
  'LANGUAGE',
  // What the command may draw with, and what it thinks the time is.
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'TZ',
  // Toolchains under a version manager: the shim is on PATH, but the shim
  // reads one of these to find the version to run.
  'ASDF_DIR',
  'ASDF_DATA_DIR',
  'NVM_DIR',
  'NVM_BIN',
  'PYENV_ROOT',
  'RBENV_ROOT',
  'SDKMAN_DIR',
  'VOLTA_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'JAVA_HOME',
]);

/**
 * The same allowlist for the two families whose members cannot be listed:
 * the locale categories (`LC_ALL`, `LC_TIME`, `LC_COLLATE`, …), and the
 * proxy variables, which every tool spells in whichever case it was written
 * in — curl and most of Unix read the lowercase ones, Windows-born tools the
 * uppercase, and a machine behind a proxy usually sets both.
 */
const ACP_TERMINAL_ENV_FAMILY = /^(?:LC_[A-Z]+|(?:HTTP|HTTPS|FTP|ALL|NO)_PROXY|(?:http|https|ftp|all|no)_proxy)$/;

/**
 * An environment in the shape `terminal/create` takes it: ACP spells it as a
 * list of `{ name, value }`, not as the map Node keeps in `process.env`.
 *
 * An allowlist goes in it — the hardening's own variables and the shell
 * essentials above — and not the WHOLE of `process.env`, which is what this
 * used to serialise. `env` is not a private channel: src/acp/transport.ts
 * mirrors every outbound frame verbatim into ~/.cache/codeep/acp-debug.log
 * when CODEEP_ACP_DEBUG is set, so every `ANTHROPIC_API_KEY`,
 * `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and session cookie in the user's
 * shell was written to a plaintext file on disk — and handed to the editor,
 * which is free to log the protocol traffic itself. None of them makes the
 * hardening work; the numbered GIT_CONFIG_* pairs do.
 *
 * What else the terminal inherits is the CLIENT's decision, not ours: ACP
 * does not say whether `env` extends the client's environment or replaces it.
 * A client that extends gives the command the user's shell environment
 * anyway; a client that replaces gives it only this list — which is why the
 * list has to cover what an ORDINARY command needs to run at all and not
 * only what a hardened git spawn does. A terminal that got `GIT_CONFIG_COUNT`
 * and nothing else would be running without a PATH.
 *
 * Unset variables are dropped rather than sent as `value: undefined` — that
 * is what `process.env` holds for a variable that is not set, and JSON has no
 * way to carry it.
 *
 * `hardened` says whether commandEnv() actually hardened this spawn, which it
 * does for `git` and for nothing else. It only decides the last entry below:
 * a command that cannot reach git is left with the environment it would have
 * had, which is the same line the refusal path draws.
 */
function acpEnvList(env: NodeJS.ProcessEnv, hardened: boolean): { name: string; value: string }[] {
  const list = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([name]) => ACP_TERMINAL_ENV_NAMES.has(name)
      || ACP_TERMINAL_ENV_FAMILY.test(name)
      || GIT_CONFIG_ENV_NAME.test(name))
    .map(([name, value]) => ({ name, value }));

  // The one thing this list cannot express is a REMOVAL — an absent name is
  // not a request to unset one — and hardenedGitEnv() removes exactly one
  // variable, so it is sent EMPTY instead.
  //
  // `GIT_CONFIG_PARAMETERS` is read after the numbered `GIT_CONFIG_*` pairs
  // and beats them: with `GIT_CONFIG_KEY_0=core.fsmonitor` and an empty value
  // right there, a `GIT_CONFIG_PARAMETERS='core.fsmonitor=<program>'` still
  // ran the program on `git status` (verified, git 2.54). So against a client
  // that EXTENDS its own environment rather than replacing it, one variable
  // the editor happened to inherit switched this whole hardening off. Git
  // parses an empty value as no parameters at all (verified, same version),
  // which is the unset this list has no other way to ask for.
  if (hardened) list.push({ name: 'GIT_CONFIG_PARAMETERS', value: '' });
  return list;
}

/**
 * Run an execute_command tool call for an ACP session, in the client's
 * terminal when it offers one, otherwise locally.
 *
 * Never throws: the agent loop reports a throw to the model as a failed
 * command, which hides whether the client terminal already ran it. A
 * failure comes back as exitCode -1 with the reason instead.
 *
 * Exported for unit testing (see server.command.test.ts).
 */
export async function executeAcpCommand(
  command: string,
  args: string[],
  cwd: string,
  ctx: AcpCommandContext,
): Promise<AcpCommandOutcome> {
  const fail = (stderr: string, stdout = ''): AcpCommandOutcome => ({ stdout, stderr, exitCode: -1 });
  const timeoutMs = ctx.timeoutMs ?? ACP_COMMAND_TIMEOUT_MS;

  // A cancelled prompt runs nothing more, wherever it would run, and a
  // command that never ran is neither recorded nor counted.
  if (ctx.signal.aborted) return fail('Command cancelled');

  // The same checks and bookkeeping as a local execute_command. They come
  // before the terminal branch: the client's terminal is another place to
  // run the command, not a way around the whitelist, the blocked patterns
  // or the SSRF guard.
  const validation = await validateCommandAsync(command, args, { cwd, projectRoot: cwd });
  if (!validation.valid) return fail(validation.reason || 'Command validation failed');
  const cmdRate = checkCommandRateLimit();
  if (!cmdRate.allowed) return fail(cmdRate.message || 'Command rate limit exceeded');
  recordCommand(command, args);

  // Cancelling the prompt kills a local command too, and reports it as the
  // client terminal branch does.
  const runLocally = async (): Promise<AcpCommandOutcome> => {
    const r = await executeCommandAsync(command, args, { cwd, projectRoot: cwd, timeout: timeoutMs, signal: ctx.signal });
    if (r.cancelled) return fail('Command cancelled', r.stdout ?? '');
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };

  // Per ACP spec, only call terminal/* if the client advertised the
  // capability in initialize. Otherwise execute locally.
  if (!ctx.clientSupportsTerminal) return runLocally();

  // The client's terminal is a spawn like any other, and it inherits none of
  // the hardening executeCommandAsync puts on the local one — so over ACP,
  // which is how Zed runs Codeep, a `git status` in a hostile repository ran
  // that repository's `core.fsmonitor` and `filter.<d>.clean` exactly as it
  // did before this hotfix. The validation above stops the argv forms that
  // redirect git, but nothing was stopping its config.
  //
  // Same helper as the local runner, so there is one answer to "what does a
  // spawn that may reach git run with" — see commandEnv(). A refusal fails
  // the command with git's own wording rather than handing it to a terminal
  // this process cannot harden.
  //
  // commandEnv() and NOT shellCommandEnv(): this call site has the argv, and
  // shellCommandEnv() can only scan the spawn's `cwd`. That made one argument
  // the whole difference between the two runners — `git -C vendor/lib status`
  // over ACP got the outer project scanned, so the nested checkout was left
  // with only the always-on GIT_EXECUTING_CONFIG pairs behind it and its
  // `filter.<driver>.clean` still ran (proven, git 2.54), while the same
  // command locally reads `-C` out of the argv and scans where git will
  // actually run.
  let env: NodeJS.ProcessEnv;
  try {
    env = commandEnv(command, args, cwd);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const { transport, sessionId, signal } = ctx;
  let terminalId: string;
  try {
    const created = await transport.request('terminal/create', {
      sessionId,
      command,
      args,
      cwd,
      env: acpEnvList(env, command === 'git'),
      outputByteLimit: 1_000_000,
    }) as TerminalCreateResult | null;
    if (!created || typeof created.terminalId !== 'string') {
      return fail('terminal/create returned no terminalId');
    }
    terminalId = created.terminalId;
  } catch (err) {
    // The client refused to create the terminal, so nothing ran there and
    // running the command here cannot run it twice. Without an answer that
    // is unknown, so report the failure instead.
    if (err instanceof AcpRequestError) return runLocally();
    return fail(`Client terminal unavailable: ${(err as Error).message}`);
  }

  const ref = { sessionId, terminalId };
  // Stop waiting when the prompt is cancelled or the command outlives its
  // budget. The transport's own timeout does not apply here: the command,
  // not the client, decides how long wait_for_exit takes.
  const stopWait = new AbortController();
  let stopped: 'cancelled' | 'timeout' | null = null;
  const stop = (why: 'cancelled' | 'timeout') => {
    stopped ??= why;
    stopWait.abort();
  };
  const onAbort = () => stop('cancelled');
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);

  try {
    let exitCode: number | null = null;
    let waitError = '';
    try {
      // Spec method is snake_case `terminal/wait_for_exit` and takes
      // only { sessionId, terminalId } — no timeoutMs.
      const waitResult = await transport.request('terminal/wait_for_exit', ref, { timeoutMs: 0, signal: stopWait.signal });
      exitCode = exitCodeFromWaitResult(waitResult);
      if (exitCode === null) waitError = 'terminal/wait_for_exit returned no exit status';
    } catch (err) {
      if (!stopped) waitError = (err as Error).message;
    }

    if (stopped === 'cancelled') {
      transport.request('terminal/kill', ref).catch(() => null);
      return fail('Command cancelled');
    }
    if (stopped === 'timeout') {
      await transport.request('terminal/kill', ref).catch(() => null);
    }

    const outputResult = await transport.request('terminal/output', ref).catch(() => null) as TerminalOutputResult | null;
    const output = typeof outputResult?.output === 'string' ? outputResult.output : '';
    if (stopped === 'timeout') return fail(`Command timed out after ${timeoutMs}ms`, output);
    if (exitCode === null) return fail(`Client terminal failed: ${waitError}`, output);
    return { stdout: output, stderr: '', exitCode };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    transport.request('terminal/release', ref).catch(() => null);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

type AcpServerSessionState = AcpSession & {
  // One controller per prompt still running. A client can start a second
  // prompt before the first ends, and session/cancel must stop both.
  activePrompts: Set<AbortController>;
  currentModeId: string;
  titleSent: boolean;
  hadHistory: boolean;
  tokenRecords?: TokenScope;
};

/**
 * Save a session's history under its own id. The id travels with the ACP
 * session (a reopened thread, a second thread in the same editor), so the
 * global current-session id may name another conversation. Written right
 * away: the editor may stop the agent at any moment after a turn.
 */
function persistSessionHistory(session: AcpSession): void {
  if (!config.get('autoSave') || session.history.length === 0) return;
  saveSession(session.codeepSessionId, session.history, session.workspaceRoot);
}

export function startAcpServer(transport: StdioTransport = new StdioTransport()): Promise<void> {
  // ACP sessionId → full AcpSession (includes history + codeep session tracking)
  const sessions = new Map<string, AcpServerSessionState>();

  // Shared deps object for the extracted handlers in serverHandlers.ts.
  // Handlers read transport + sessions off this; stubbing both in a test
  // (see serverHandlers.test.ts) is what makes them unit-testable.
  const handlerDeps: AcpHandlerDeps = { transport, sessions };

  // Tear down all MCP child processes when the CLI dies. Without this,
  // killing `codeep acp` with Ctrl+C orphans any servers we spawned —
  // they keep running until the user hunts them down with `ps`.
  // Register only once per process; if the user starts multiple ACP servers
  // in the same process (we don't but be defensive) the second listener
  // would double-fire.
  const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let shuttingDown = false;
  const onShutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    disposeAllMcpSessions().finally(() => {
      // Mimic default Node exit behaviour after our cleanup runs.
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  for (const sig of shutdownSignals) {
    // Only attach if nothing else has claimed the signal — Node prints
    // a warning when listener count > 10 per signal.
    if (process.listenerCount(sig) === 0) process.on(sig, onShutdown);
  }

  // A handler that throws, or an async one that rejects, is answered with a
  // JSON-RPC error by the transport — so async handlers return their promise.
  transport.start((msg: JsonRpcRequest | JsonRpcNotification): Promise<void> | undefined => {
    // Notifications have no id — handle separately
    if (!('id' in msg)) {
      handleNotification(msg as JsonRpcNotification);
      return undefined;
    }
    const req = msg as JsonRpcRequest;
    switch (req.method) {
      case 'initialize':           handleInitialize(req);           break;
      case 'initialized':          /* no-op acknowledgment */        break;
      case 'authenticate':         handleAuthenticate(req);         break;
      case 'session/new':          handleSessionNew(req);           break;
      case 'session/load':         handleSessionLoad(req);          break;
      case 'session/resume':       handleSessionResume(req);        break;
      case 'session/prompt':       return handleSessionPrompt(req);
      case 'session/set_mode':     handleSetMode(req);              break;
      case 'session/set_config_option': handleSetConfigOption(req); break;
      case 'session/list':             handleSessionList(req);          break;
      case 'session/delete':           handleSessionDelete(req);        break;
      case 'session/list_providers':   handleListProviders(req);        break;
      case 'session/list_personalities': handleListPersonalities(req);  break;
      case 'session/set_personality':    handleSetPersonality(req);     break;
      case 'session/sync_personalities': return handleSyncPersonalities(req);
      default:
        process.stderr.write(`[codeep-acp] Unknown method: ${req.method}\n`);
        transport.error(req.id, -32601, `Method not found: ${req.method}`);
    }
    return undefined;
  });

  // ── Notification handler (no id, no response) ──────────────────────────────

  function handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === 'session/cancel') {
      const { sessionId } = (msg.params ?? {}) as SessionCancelParams;
      const session = sessions.get(sessionId);
      if (session) for (const controller of session.activePrompts) controller.abort();
    }
  }

  // ── initialize ──────────────────────────────────────────────────────────────

  // Tracks what the connected client supports — populated from initialize params.
  // Per ACP spec, `terminal` and `fs` are CLIENT capabilities (the agent calls
  // these methods on the client), so we must read them from the client, not
  // advertise them ourselves.
  let clientSupportsTerminal = false;
  let clientSupportsFsRead = false;
  let clientSupportsFsWrite = false;

  function handleInitialize(msg: JsonRpcRequest): void {
    const params = msg.params as InitializeParams;
    clientSupportsTerminal = params.clientCapabilities?.terminal === true;
    clientSupportsFsRead = params.clientCapabilities?.fs?.readTextFile === true;
    clientSupportsFsWrite = params.clientCapabilities?.fs?.writeTextFile === true;

    const result: InitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          // Codeep parses ContentBlock::Resource and ::ResourceLink in
          // session/prompt — see handleSessionPrompt below.
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          // Lightweight reconnect — see handleSessionResume below.
          resume: {},
        },
      },
      agentInfo: {
        name: 'codeep',
        version: getCurrentVersion(),
      },
      // We advertise a single "agent"-typed auth method even though Codeep
      // authenticates out-of-band (env var, `codeep` CLI `/login`, or the
      // VS Code "Codeep: Set API Key" command). The acp-registry CI check
      // requires at least one method with type `agent` or `terminal` — and
      // having an entry here also gives Zed something to render in its
      // "agent settings" surface so users discover where to put their key.
      authMethods: [
        {
          id: 'codeep-cli',
          name: 'Codeep CLI',
          description:
            'Authenticate via the codeep CLI: run `codeep` and use `/login <provider> <key>`, ' +
            'set the provider\'s env var (e.g. ZAI_API_KEY), or use "Codeep: Set API Key" in VS Code.',
        },
      ],
    };
    transport.respond(msg.id, result);
  }

  // ── authenticate ────────────────────────────────────────────────────────────
  // We don't actually run anything here — auth is handled out-of-band (env
  // var, CLI /login, VS Code command). But per ACP spec the client may still
  // dispatch authenticate after reading our advertised methods. Reply with
  // empty success so the client unblocks and proceeds to session/new.

  function handleAuthenticate(msg: JsonRpcRequest): void {
    transport.respond(msg.id, {});
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  // Title hint to the client. The ACP spec does NOT define a
  // `session_info_update` variant — sending it caused Zed's internally-tagged
  // SessionUpdate deserializer to reject the notification, which (depending
  // on client recovery logic) could swallow following valid notifications
  // like `available_commands_update`. We now no-op here and rely on
  // session/list (which has a proper `title` field per spec) for any
  // client-side session naming. Kept as a function with no body so callers
  // don't need to be touched — easy to wire back up via `_meta` extension if
  // a future client needs an explicit hint.
  function sendSessionTitle(_sessionId: string, _history: { role: string; content: string }[], _fallback?: string): void {
    // intentionally empty — see comment above
  }

  /**
   * Background-spawn MCP servers for a session, merging two sources:
   *
   *   1. On-disk config (`.codeep/mcp_servers.json` project + global) —
   *      so a user who just runs `codeep acp` (no Zed-style settings UI)
   *      can still drive MCP setup by editing a file.
   *   2. `mcpServers` passed in the session/* params — clients that have
   *      their own config (Zed, Claude Desktop) keep using that. ACP-
   *      provided servers override file entries with the same name.
   *
   * Don't block the session/* response on process startup (a hung MCP
   * server would otherwise keep the chat from opening). Errors are logged
   * + cached for /mcp display. `mcpRegistry.callSessionTool` awaits the
   * in-flight registration so tool calls don't race the startup.
   */
  function spawnMcpServersForSession(acpSessionId: string, cwd: string, acpServers: McpServer[] | undefined, label: string): void {
    // Workspace-sourced servers (.codeep/mcp_servers.json, .mcp.json) travel
    // with the repo, so they spawn only for workspaces the user has trusted
    // (same gate the TUI prompts for at startup). ACP-provided servers are
    // the editor's own config and global ~/.codeep entries are the user's —
    // both spawn unconditionally. /mcp in commands.ts selects the same way.
    const { servers: merged, skipped } = selectSessionMcpServers(cwd, { fromClient: acpServers });
    if (skipped.length > 0) {
      process.stderr.write(
        `[codeep-acp] MCP (${label}): skipped ${skipped.length} workspace server(s) — untrusted workspace. ` +
        `Run /mcp trust (or \`codeep\` in the repo once) to enable.\n`,
      );
    }
    // Registered even when empty: on a reload that stops the servers the
    // session no longer has.
    registerSessionServers(acpSessionId, merged, {
      workspaceRoot: cwd,
      // Servers that opted into the `sampling` capability can ask us to
      // run a completion on their behalf. We bridge to chat() through
      // mcpSamplingBridge — using the user's currently active provider
      // and key. The bridge enforces a per-server rate limit + budget cap
      // so a misbehaving server can't drain the user's API credits.
      onSamplingRequest: (params, serverName) => handleMcpSamplingRequest(params, serverName),
    })
      .then(({ registered, errors }) => {
        if (registered.length > 0) {
          process.stderr.write(`[codeep-acp] MCP (${label}): registered ${registered.length} tool(s) from ${merged.length} server(s)\n`);
        }
        for (const e of errors) {
          process.stderr.write(`[codeep-acp] MCP server "${e.server}" failed (${label}): ${e.error}\n`);
        }
      })
      .catch(err => process.stderr.write(`[codeep-acp] MCP registration crashed (${label}): ${err.message}\n`));
  }

  // ── session/new ─────────────────────────────────────────────────────────────

  /**
   * Check the fields a session request cannot do without, answering
   * -32602 for the first one missing. Without this a missing cwd surfaced
   * as a raw Node error, and a missing sessionId registered a session
   * under `undefined`.
   */
  function hasSessionParams(msg: JsonRpcRequest, needSessionId: boolean): boolean {
    const p = (msg.params ?? {}) as { cwd?: unknown; sessionId?: unknown };
    if (needSessionId && (typeof p.sessionId !== 'string' || !p.sessionId)) {
      transport.error(msg.id, -32602, 'sessionId is required');
      return false;
    }
    if (typeof p.cwd !== 'string' || !p.cwd) {
      transport.error(msg.id, -32602, 'cwd is required');
      return false;
    }
    return true;
  }

  function handleSessionNew(msg: JsonRpcRequest): void {
    if (!hasSessionParams(msg, false)) return;
    const params = msg.params as SessionNewParams;
    const acpSessionId = randomUUID();

    const workspace = initWorkspace(params.cwd, params.fresh);
    const { history } = workspace;
    let { codeepSessionId, welcomeText } = workspace;
    // Two threads bound to one saved conversation would overwrite each
    // other's file on every turn: a resume of a conversation that another
    // thread already has open continues under a new name.
    const inUse = [...sessions.values()].some(
      (s) => s.codeepSessionId === codeepSessionId && s.workspaceRoot === params.cwd,
    );
    if (inUse) {
      codeepSessionId = startNewSession();
      welcomeText += `\n\n_That conversation is open in another thread, so this one continues as \`${codeepSessionId}\`._`;
    }

    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      clientMcpServers: params.mcpServers,
      activePrompts: new Set(),
      currentModeId: 'auto',
      titleSent: false,
      hadHistory: history.length > 0,
    });

    const result: SessionNewResult = {
      sessionId: acpSessionId,
      // On a resume (fresh=false) `history` holds the prior transcript;
      // return it (user/assistant only) so a reconnected client can repaint
      // the chat. Empty on a fresh session, so this is harmless there.
      history: history.filter(m => m.role === 'user' || m.role === 'assistant'),
      modes: AGENT_MODES,
      configOptions: buildConfigOptions(),
    };

    // Spin up MCP servers in the background. Errors surface via /mcp.
    // Started only now: if setting up the session throws, the client gets
    // an error and no session id, so nothing could ever dispose them.
    spawnMcpServersForSession(acpSessionId, params.cwd, params.mcpServers, 'session/new');

    transport.respond(msg.id, result);

    // Advertise slash commands AFTER a short delay. Zed processes
    // `AvailableCommandsUpdated` events synchronously and silently drops them
    // if `thread_view(&session_id)` returns None — which is the case for ~tens
    // of ms after session/new response is sent (Zed needs to spin up the view
    // in a separate task). Without the delay the notification arrives ~1 ms
    // after the response and gets lost, which manifests as
    // "Available commands: none" in the slash menu.
    sendCommandsDelayed(acpSessionId, params.cwd);

    // Send title immediately so Zed "Recent" panel shows something useful
    sendSessionTitle(acpSessionId, history, pathBasename(params.cwd));

    // Send welcome message
    transport.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: welcomeText },
      },
    });
  }

  // Delay configurable via env so we can experimentally tune in production.
  // 200 ms is comfortably above the observed ~1 ms race window without
  // making the slash menu feel laggy on first paint.
  const COMMANDS_DELAY_MS = Number(process.env.CODEEP_ACP_COMMANDS_DELAY_MS ?? 200);

  /**
   * Build the autocomplete catalog for a session: built-in commands plus any
   * user-authored Markdown templates under `.codeep/commands/`. Custom ones
   * are tagged in the description so the user can tell them apart from
   * built-ins in Zed / VS Code dropdowns.
   */
  function getAvailableCommandsForSession(workspaceRoot: string): typeof AVAILABLE_COMMANDS {
    try {
      const custom = loadCustomCommands(workspaceRoot).map(c => ({
        name: c.name,
        description: `[${c.scope === 'project' ? 'project' : 'global'}] ${c.description}`,
        input: { hint: '[args]' as string },
      }));
      // Custom commands can't override built-ins (would break /help, /status etc.)
      const builtinNames = new Set(AVAILABLE_COMMANDS.map(c => c.name));
      const safeCustom = custom.filter(c => !builtinNames.has(c.name));
      return [...AVAILABLE_COMMANDS, ...safeCustom];
    } catch {
      // Custom-command loading must never block the autocomplete catalog.
      return AVAILABLE_COMMANDS;
    }
  }

  function sendCommandsDelayed(sessionId: string, workspaceRoot: string): void {
    setTimeout(() => {
      transport.notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: getAvailableCommandsForSession(workspaceRoot),
        },
      });
    }, COMMANDS_DELAY_MS);
  }

  // ── session/load ────────────────────────────────────────────────────────────

  function handleSessionLoad(msg: JsonRpcRequest): void {
    if (!hasSessionParams(msg, true)) return;
    const params = msg.params as SessionLoadParams;

    // Try to restore existing Codeep session or fall back to fresh workspace
    const existing = sessions.get(params.sessionId);
    if (existing) {
      // Session already in memory — update cwd if changed
      existing.workspaceRoot = params.cwd;
      // Re-spawn any MCP servers the client passed in (they may have changed
      // since session/new; old ones get disposed by registerSessionServers).
      existing.clientMcpServers = params.mcpServers ?? existing.clientMcpServers;
      spawnMcpServersForSession(params.sessionId, params.cwd, existing.clientMcpServers, 'session/load (warm)');
      // A load replays the conversation, warm or cold: clients such as the
      // VS Code extension clear the chat and show what this returns.
      const result: SessionLoadResult = {
        sessionId: params.sessionId,
        history: existing.history.filter(m => m.role === 'user' || m.role === 'assistant'),
        modes: AGENT_MODES,
        configOptions: buildConfigOptions(),
      };
      transport.respond(msg.id, result);
      return;
    }

    // Session not in memory — try to load from disk. It is registered under
    // the id the client asked for: ACP clients keep using that id for
    // prompts and route updates by it.
    const { codeepSessionId, history, welcomeText } = loadWorkspace(params.cwd, params.sessionId);
    const acpSessionId = params.sessionId;
    spawnMcpServersForSession(acpSessionId, params.cwd, params.mcpServers, 'session/load (cold)');

    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      clientMcpServers: params.mcpServers,
      activePrompts: new Set(),
      titleSent: true,
      hadHistory: history.length > 0,
      currentModeId: 'auto',
    });

    const result: SessionLoadResult = {
      sessionId: acpSessionId,
      history: history.filter(m => m.role === 'user' || m.role === 'assistant'),
      modes: AGENT_MODES,
      configOptions: buildConfigOptions(),
    };
    transport.respond(msg.id, result);

    // Re-advertise commands (delayed for the same race-condition reason as
    // session/new — see sendCommandsDelayed comment).
    sendCommandsDelayed(acpSessionId, params.cwd);

    // Send title immediately so Zed "Recent" panel shows something useful
    sendSessionTitle(acpSessionId, history, pathBasename(params.cwd));

    // Send restored session welcome
    transport.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: welcomeText },
      },
    });
  }

  // ── session/resume ──────────────────────────────────────────────────────────
  // Lightweight reconnect path. Unlike `session/load`, the client keeps history
  // locally and only needs to be wired back up to the in-memory session
  // (modes + config). No history replay → instant reconnect on UI reload.
  // Falls back to `session/load` semantics if the session isn't in memory yet.

  function handleSessionResume(msg: JsonRpcRequest): void {
    if (!hasSessionParams(msg, true)) return;
    const params = msg.params as SessionResumeParams;

    const existing = sessions.get(params.sessionId);
    if (existing) {
      existing.workspaceRoot = params.cwd;
      // Resume can carry an updated mcpServers list (e.g. workspace switched
      // config) — re-register so old servers are torn down and new ones spawn.
      existing.clientMcpServers = params.mcpServers ?? existing.clientMcpServers;
      spawnMcpServersForSession(params.sessionId, params.cwd, existing.clientMcpServers, 'session/resume (warm)');
      const result: SessionResumeResult = {
        sessionId: params.sessionId,
        modes: AGENT_MODES,
        configOptions: buildConfigOptions(),
      };
      transport.respond(msg.id, result);
      // Delayed — see sendCommandsDelayed comment for the race-condition rationale.
      sendCommandsDelayed(params.sessionId, params.cwd);
      return;
    }

    // Session not in memory — load from disk but skip the welcome banner and
    // the history echo (resume contract: client already has history).
    // Registered under the requested id, as in session/load.
    const { codeepSessionId, history } = loadWorkspace(params.cwd, params.sessionId);
    const acpSessionId = params.sessionId;
    spawnMcpServersForSession(acpSessionId, params.cwd, params.mcpServers, 'session/resume (cold)');
    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      clientMcpServers: params.mcpServers,
      activePrompts: new Set(),
      titleSent: true,
      hadHistory: history.length > 0,
      currentModeId: 'auto',
    });
    const result: SessionResumeResult = {
      sessionId: acpSessionId,
      modes: AGENT_MODES,
      configOptions: buildConfigOptions(),
    };
    transport.respond(msg.id, result);
    sendCommandsDelayed(acpSessionId, params.cwd);
  }

  // ── session/set_mode ────────────────────────────────────────────────────────

  function handleSetMode(msg: JsonRpcRequest): void {
    handleSetModeExternal(msg, handlerDeps);
  }

  // ── session/set_config_option ───────────────────────────────────────────────

  function handleSetConfigOption(msg: JsonRpcRequest): void {
    handleSetConfigOptionExternal(msg, handlerDeps);
  }

  // ── session/list ─────────────────────────────────────────────────────────────

  function handleSessionList(msg: JsonRpcRequest): void {
    handleSessionListExternal(msg, handlerDeps);
  }

  // ── session/delete ───────────────────────────────────────────────────────────

  function handleSessionDelete(msg: JsonRpcRequest): void {
    handleSessionDeleteExternal(msg, handlerDeps);
  }

  // ── session/list_providers ──────────────────────────────────────────────────
  // Canonical provider list for ACP clients (Codeep VS Code extension etc.).
  // Lets the client populate its API-key dropdowns and group labels from one
  // source instead of carrying its own hardcoded copy. Keep this stable —
  // adding new fields is fine, removing/renaming would break existing clients.
  function handleListProviders(msg: JsonRpcRequest): void {
    handleListProvidersExternal(msg, handlerDeps);
  }

  // ── Codeep personality extensions ─────────────────────────────────────────
  // These methods are intentionally additive to ACP v1. VS Code can render a
  // native picker without scraping markdown from `/personality`; clients that
  // do not know the extension continue using the slash command unchanged.

  function personalityListResult(sessionId: string): ListPersonalitiesResult | null {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return buildPersonalityListResult(session.workspaceRoot);
  }

  function handleListPersonalities(msg: JsonRpcRequest): void {
    const params = (msg.params ?? {}) as ListPersonalitiesParams;
    const result = personalityListResult(params.sessionId);
    if (!result) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }
    transport.respond(msg.id, result);
  }

  function handleSetPersonality(msg: JsonRpcRequest): void {
    const params = (msg.params ?? {}) as SetPersonalityParams;
    const session = sessions.get(params.sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }
    if (params.personalityId === null) {
      config.set('activePersonality', null);
      const result: SetPersonalityResult = { activePersonality: null };
      transport.respond(msg.id, result);
      return;
    }
    const selected = resolvePersonalitySelection(params.personalityId, session.workspaceRoot);
    if (!selected) {
      transport.error(msg.id, -32602, `Personality is unknown or unavailable here: ${String(params.personalityId)}`);
      return;
    }
    const personalityId = params.personalityId.toLowerCase();
    config.set('activePersonality', personalityId);
    const result: SetPersonalityResult = { activePersonality: personalityId };
    transport.respond(msg.id, result);
  }

  async function handleSyncPersonalities(msg: JsonRpcRequest): Promise<void> {
    const params = (msg.params ?? {}) as SyncPersonalitiesParams;
    if (!sessions.has(params.sessionId)) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }
    const { describeSyncFailure } = await import('../utils/codeepCloud.js');
    const sync = await pullPersonalities();
    if (!sync.ok) {
      // The old contract collapsed every failure into one message that also
      // covered "not linked", so a client could not tell an expired session
      // from an unreachable server. Say which.
      transport.error(msg.id, -32001, `Personality sync failed — ${describeSyncFailure(sync.reason)}.`);
      return;
    }
    const list = personalityListResult(params.sessionId)!;
    const result: SyncPersonalitiesResult = { updated: sync.count, ...list };
    transport.respond(msg.id, result);
  }

  // ── session/prompt ──────────────────────────────────────────────────────────

  async function handleSessionPrompt(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as SessionPromptParams;
    const session = sessions.get(params.sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }

    // Re-advertise commands on every prompt — Zed sometimes drops the initial
    // `available_commands_update` from session/new because the thread_view
    // isn't registered yet on Zed's side (race against the session/new
    // response). Re-sending here guarantees `/` autocomplete works by the
    // time the user could plausibly type the next prompt. Also picks up any
    // custom command Markdown files the user added since session start.
    transport.notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: getAvailableCommandsForSession(session.workspaceRoot),
      },
    });

    // Extract text from ContentBlock[]
    let prompt = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');

    // Inject embedded context (Resource + ResourceLink blocks).
    // Zed sends these when the user drags a file into the chat or pins a
    // selection — we advertise `embeddedContext: true` so the client uses
    // these block types instead of dropping the context silently.
    const contextSnippets = await collectEmbeddedContext(params.prompt);
    if (contextSnippets) {
      prompt = prompt
        ? `${contextSnippets}\n\n${prompt}`
        : contextSnippets;
    }

    // Handle image blocks via vision API
    const imageBlocks = params.prompt.filter((b) => b.type === 'image' && b.data);
    if (imageBlocks.length > 0) {
      const block = imageBlocks[0];
      const mimeType = block.mimeType || 'image/png';
      const imageDataUrl = `data:${mimeType};base64,${block.data}`;
      transport.respond(msg.id, { stopReason: 'end_turn' });
      const { getZaiVisionConfig, callZaiVisionApi, getMinimaxMcpConfig, callMinimaxApi } = await import('../utils/mcpIntegration.js');
      const zaiConfig = getZaiVisionConfig();
      const mmConfig = getMinimaxMcpConfig();
      if (!zaiConfig && !mmConfig) {
        transport.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Image paste requires a Z.AI or MiniMax API key.' } },
        });
        return;
      }
      transport.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '_Analyzing image…_\n\n' } },
      });
      try {
        const visionPrompt = prompt || 'Describe this image in detail.';
        let description: string;
        if (zaiConfig) {
          description = await callZaiVisionApi(zaiConfig.baseUrl, zaiConfig.apiKey, visionPrompt, imageDataUrl);
        } else {
          description = await callMinimaxApi(mmConfig!.host, '/v1/coding_plan/vlm', { prompt: visionPrompt, image_url: imageDataUrl }, mmConfig!.apiKey);
        }
        transport.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: description } },
        });
        session.history.push({ role: 'user', content: prompt ? `[Image] ${prompt}` : '[Image pasted from clipboard]' });
        session.history.push({ role: 'assistant', content: description });
        persistSessionHistory(session);
      } catch (err) {
        transport.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Image analysis failed: ${(err as Error).message}` } },
        });
      }
      return;
    }

    const abortController = new AbortController();
    session.activePrompts.add(abortController);

    // Plan tracking: build a live plan from tool calls as the agent works
    // ACP spec: send complete list on every update, client replaces current plan
    const planEntries = new Map<string, import('./protocol.js').PlanEntry>();
    const sendPlan = () => {
      transport.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [...planEntries.values()],
        },
      });
    };

    const agentResponseChunks: string[] = [];
    const sendChunk = (text: string) => {
      agentResponseChunks.push(text);
      transport.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    };

    // Ask the user through the client. A person answers this: wait as long
    // as the dialog is open. Only cancelling the prompt stops the wait. No
    // answer (error, cancelled prompt, a reply without an outcome) is null,
    // which callers must treat as a refusal.
    const askUser = (toolCall: RequestPermissionParams['toolCall'], options: PermissionOption[]) =>
      transport.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall,
        options,
      }, {
        timeoutMs: 0,
        signal: abortController.signal,
      }).then(
        (reply) => {
          const outcome = (reply as Partial<RequestPermissionResult> | null)?.outcome;
          return outcome && typeof outcome === 'object' ? reply as RequestPermissionResult : null;
        },
        () => null,
      );

    // How the agent runs for this prompt. Built once so slash commands that
    // run the agent (/go, custom commands, skill agent steps) run it exactly
    // like a plain prompt.
    const manualMode = session.currentModeId === 'manual';

    // The one permission dialog this session puts in front of the user.
    const askAboutToolCall = async (
      toolCall: ToolCall,
      // What the agent gate already worked out about this call. Passed rather
      // than worked out again: trustBearingWrite() stats the path, resolves a
      // symlinked ancestor and may ask git where this repository keeps its
      // hooks. `null` is an answer ("writes no such file"); undefined means
      // the question came from somewhere that has not looked, which is the
      // only case that pays for the lookup here.
      known?: TrustBearingWrite | null,
    ): Promise<PermissionOutcome> => {
      // A write to a file that decides what runs later says so in the
      // dialog — the editor shows `toolInput`, and "this file controls what
      // commands git runs" is the part that makes the answer an informed one.
      const trustBearing = known !== undefined ? known : trustBearingWrite(toolCall, session.workspaceRoot);
      const result = await askUser({
        toolCallId: `perm_${randomUUID()}`,
        toolName: toolCall.tool,
        toolInput: {
          ...formatToolInputForPermission(toolCall.tool, toolCall.parameters as Record<string, unknown>),
          ...(trustBearing ? { warning: trustBearing.reason } : {}),
        },
        status: 'pending',
        content: [],
      }, [
        { optionId: 'allow_once',    name: 'Allow once',    kind: 'allow_once' as const },
        // No "always" for one of those files: the agent answers about this
        // file only and would not remember the answer anyway.
        ...(trustBearing ? [] : [{ optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' as const }]),
        { optionId: 'reject_once',   name: 'Reject once',   kind: 'reject_once' as const },
        { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' as const },
      ]);

      // Map ACP outcome back to PermissionOutcome. No answer
      // (error, cancelled prompt) denies.
      if (!result || result.outcome.type === 'cancelled') return 'reject_once';
      return result.outcome.optionId as PermissionOutcome;
    };

    // Auto mode's answer to the agent's permission gate: yes to everything
    // except a write to a file that decides what runs later, which is asked
    // about in every mode. Without it the agent would have to refuse those
    // writes outright, having nobody to ask. It travels under its own key on
    // `agentRun` and never as `onRequestPermission`: a slash command reads
    // that key being set as "this session asks the user" (see
    // acp/commands.ts), and auto mode still runs a skill's shell lines
    // without asking, as it promises.
    const autoModeAnswer = async (
      toolCall: ToolCall,
      known?: TrustBearingWrite | null,
    ): Promise<PermissionOutcome> => {
      const trustBearing = known !== undefined ? known : trustBearingWrite(toolCall, session.workspaceRoot);
      // Handed on, so the dialog does not look the same file up a third time.
      return trustBearing ? askAboutToolCall(toolCall, trustBearing) : 'allow_once';
    };

    const agentRun: AcpAgentRunOptions = {
      // Manual mode gates write_file/edit_file for this run only, per call —
      // NOT by mutating the global `agentConfirmWriteFile` config, which
      // leaked the session's mode into the TUI/other processes and raced on
      // a non-atomic restore.
      extraDangerousTools: manualMode ? ['write_file', 'edit_file'] : undefined,
      // Only request permission in Manual mode
      onRequestPermission: manualMode ? askAboutToolCall : undefined,
      // …and in auto mode, the answer a command that runs the agent uses in
      // its place, so /go and a skill's agent step get the same one prompt a
      // plain prompt gets instead of a refusal.
      onAutoModePermission: manualMode ? undefined : autoModeAnswer,
      // A skill's confirm step ("Deploy to production?") — a one-off
      // question, so no "always" answers.
      confirm: manualMode
        ? async (message: string): Promise<boolean> => {
            const result = await askUser({
              toolCallId: `confirm_${randomUUID()}`,
              toolName: 'confirm',
              toolInput: { question: message },
              status: 'pending',
              content: [],
            }, [
              { optionId: 'allow_once',  name: 'Yes', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'No',  kind: 'reject_once' },
            ]);
            return result?.outcome.type === 'selected' && result.outcome.optionId === 'allow_once';
          }
        : undefined,
      // Per ACP spec, `fs/read_text_file` and `fs/write_text_file` are
      // CLIENT methods — only safe to call when the client advertised
      // the capability in `initialize`. Routing through the client
      // means the editor's dirty buffers + undo history stay correct
      // (otherwise an in-editor unsaved change would be invisible to
      // the agent, or worse, silently overwritten).
      fs: {
        readTextFile: clientSupportsFsRead
          ? async (absolutePath: string): Promise<string> => {
              const result = await transport.request('fs/read_text_file', {
                sessionId: params.sessionId,
                path: absolutePath,
              }) as { content: string } | null;
              if (!result || typeof result.content !== 'string') {
                throw new Error('fs/read_text_file returned no content');
              }
              return result.content;
            }
          : undefined,
        writeTextFile: clientSupportsFsWrite
          ? async (absolutePath: string, content: string): Promise<void> => {
              // Rejects when the client refuses the write, so the tool
              // never reports a file it did not write.
              await transport.request('fs/write_text_file', {
                sessionId: params.sessionId,
                path: absolutePath,
                content,
              });
            }
          : undefined,
      },
      onExecuteCommand: (command: string, args: string[], cwd: string) =>
        executeAcpCommand(command, args, cwd, {
          transport,
          sessionId: params.sessionId,
          clientSupportsTerminal,
          signal: abortController.signal,
        }),
    };

    // Try slash commands first.
    // Run the whole prompt lifecycle inside THIS ACP session's token scope so
    // (a) concurrent sessions on one process can't mix usage totals, and
    // (b) usage accumulates into the session's own buffer across prompts, so
    // `/cost` stays session-cumulative. `tokenReportStart` marks the pre-prompt
    // count so we report only this prompt's delta to cloud telemetry.
    session.tokenRecords ??= createTokenScope();
    runWithTokenScope(session.tokenRecords, () => {
    const tokenReportStart = getRecordCount();
    return handleCommand(prompt, session, sendChunk, abortController.signal, agentRun)
      .then((cmd) => {
        if (cmd.handled) {
          if (cmd.response) sendChunk(cmd.response);
          // If provider or model changed, push updated config options to Zed
          if (cmd.configOptionsChanged) {
            transport.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: buildConfigOptions(),
              },
            });
          }
          // Update title with first real prompt if session had no history
          if (!session.titleSent && !session.hadHistory) {
            session.titleSent = true;
            sendSessionTitle(params.sessionId, [{ role: 'user', content: prompt }]);
          }
          session.activePrompts.delete(abortController);
          // A command that runs the agent (/go, skills) or the model (/diff,
          // /compact) can be cancelled part way; the client must hear so.
          transport.respond(msg.id, { stopReason: abortController.signal.aborted ? 'cancelled' : 'end_turn' });
          return;
        }

        // Not a command — run agent loop
        let enrichedPrompt = prompt;
        if (session.addedFiles.size > 0) {
          const parts = ['[Attached files]'];
          for (const [, f] of session.addedFiles) {
            parts.push(`\nFile: ${f.relativePath}\n\`\`\`\n${f.content}\n\`\`\``);
          }
          enrichedPrompt = parts.join('\n') + '\n\n' + prompt;
        }

        // Captured now: the user may move to another conversation before this ends.
        const recordTurn = beginTurn(session);
        runAgentSession({
          prompt: enrichedPrompt,
          workspaceRoot: session.workspaceRoot,
          conversationId: params.sessionId,
          abortSignal: abortController.signal,
          onChunk: sendChunk,
          onThought: (text: string) => {
            transport.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text },
              },
            });
          },
          onToolCall: (toolCallId, toolName, kind, title, status, locations, rawOutput) => {
            if (status === 'running') {
              // Initial tool_call notification: spec ToolCall shape
              transport.notify('session/update', {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId,
                  title: title || toolName,
                  kind: kind || 'other',
                  status: 'in_progress',
                  ...(locations && locations.length > 0
                    ? { locations: locations.map(path => ({ path })) }
                    : {}),
                },
              });
              // Add to plan as in_progress — only meaningful actions (not reads)
              if (kind === 'edit' || kind === 'execute' || kind === 'delete') {
                planEntries.set(toolCallId, {
                  id: toolCallId,
                  content: title || toolName,
                  priority: kind === 'execute' ? 'high' : 'medium',
                  status: 'in_progress',
                });
                sendPlan();
              }
            } else {
              // tool_call_update: update status to completed/failed, with optional content
              transport.notify('session/update', {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId,
                  status: status === 'finished' ? 'completed' : 'failed',
                  ...(rawOutput !== undefined ? { rawOutput } : {}),
                },
              });
              // Mark plan entry as completed
              const entry = planEntries.get(toolCallId);
              if (entry) {
                entry.status = 'completed';
                sendPlan();
              }
            }
          },
          onRequestPermission: agentRun.onRequestPermission ?? agentRun.onAutoModePermission,
          extraDangerousTools: agentRun.extraDangerousTools,
          fs: agentRun.fs,
          onExecuteCommand: agentRun.onExecuteCommand,
          // Earlier turns only: the prompt joins the history once it ran.
          chatHistory: [...session.history],
        }).then(() => {
          const agentResponse = agentResponseChunks.join('');
          recordTurn(agentResponse
            ? [{ role: 'user', content: prompt }, { role: 'assistant', content: agentResponse }]
            : [{ role: 'user', content: prompt }]);

          // Report token usage to dashboard
          const projectCtx = getProjectContext(session.workspaceRoot);
          const sharedFields = {
            sessionId: session.codeepSessionId,
            sessionName: session.codeepSessionId,
            messageCount: session.history.length,
            cliVersion: getCurrentVersion(),
            projectName: projectCtx?.name,
            projectId: generateProjectId(session.workspaceRoot),
            language: projectCtx?.type,
            isGit: isGitRepository(session.workspaceRoot),
          };
          const costBreakdown = getCostBreakdown(tokenReportStart);
          if (costBreakdown.length > 0) {
            for (const entry of costBreakdown) {
              reportStats({
                ...sharedFields,
                model: entry.model,
                provider: entry.provider,
                inputTokens: entry.promptTokens || undefined,
                outputTokens: entry.completionTokens || undefined,
                cacheCreationTokens: entry.cacheCreationTokens || undefined,
                cacheReadTokens: entry.cacheReadTokens || undefined,
                estimatedCost: entry.estimatedCost || undefined,
              });
            }
          } else {
            reportStats({ ...sharedFields, model: config.get('model'), provider: config.get('provider') });
          }

          // Sync session history to dashboard
          syncSession({
            sessionId: session.codeepSessionId,
            projectName: projectCtx?.name,
            projectId: generateProjectId(session.workspaceRoot),
            messages: session.history,
          });

          // Update title with first real prompt if session had no history
          if (!session.titleSent && !session.hadHistory) {
            session.titleSent = true;
            sendSessionTitle(params.sessionId, [{ role: 'user', content: prompt }]);
          }

          transport.respond(msg.id, { stopReason: abortController.signal.aborted ? 'cancelled' : 'end_turn' });
        }).catch((err: Error) => {
          // Once the user cancelled, the answer is "cancelled", whatever the
          // run failed with on the way out.
          if (err.name === 'AbortError' || abortController.signal.aborted) {
            // Clear plan UI on the client side when session is cancelled
            if (planEntries.size > 0) {
              planEntries.clear();
              sendPlan();
            }
            transport.respond(msg.id, { stopReason: 'cancelled' });
          } else if (err.message?.includes('API key not configured') || err.message?.includes('API key') || (err instanceof ApiError && err.status === 401)) {
            sendChunk(`❌ No API key configured. Use /login <provider> <key> or set the environment variable (e.g. ZAI_API_KEY, ANTHROPIC_API_KEY).`);
            transport.respond(msg.id, { stopReason: 'end_turn' });
          } else if (err instanceof ApiError && err.status >= 500) {
            sendChunk(`⚠️ API server error (${err.status}). Please try again.`);
            transport.respond(msg.id, { stopReason: 'end_turn' });
          } else {
            transport.error(msg.id, -32000, err.message);
          }
        }).finally(() => {
          session.activePrompts.delete(abortController);
          planEntries.clear();
        });
      })
      .catch((err: Error) => {
        // A command that streams (/review, /diff) stops with an AbortError
        // when cancelled. The client asked for that, so it is not an error.
        if (err.name === 'AbortError' || abortController.signal.aborted) {
          transport.respond(msg.id, { stopReason: 'cancelled' });
        } else if (err.message?.includes('API key not configured') || err.message?.includes('API key') || (err instanceof ApiError && err.status === 401)) {
          sendChunk(`❌ No API key configured. Use /login <provider> <key> or set the environment variable (e.g. ZAI_API_KEY, ANTHROPIC_API_KEY).`);
          transport.respond(msg.id, { stopReason: 'end_turn' });
        } else if (err instanceof ApiError && err.status >= 500) {
          sendChunk(`⚠️ API server error (${err.status}). Please try again.`);
          transport.respond(msg.id, { stopReason: 'end_turn' });
        } else {
          transport.error(msg.id, -32000, err.message);
        }
        session.activePrompts.delete(abortController);
      });
    });
  }

  // Keep process alive until stdin closes (Zed terminates us)
  return new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
  });
}
