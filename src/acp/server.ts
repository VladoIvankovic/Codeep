// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
import { basename as pathBasename } from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { StdioTransport } from './transport.js';
import {
  InitializeParams, InitializeResult,
  SessionNewParams, SessionNewResult,
  SessionLoadParams, SessionLoadResult,
  SessionResumeParams, SessionResumeResult,
  SessionPromptParams,
  SessionCancelParams,
  SetSessionModeParams,
  SetSessionConfigOptionParams,
  SessionModeState, SessionConfigOption,
  ListSessionsParams, ListSessionsResult, AcpSessionInfo,
  DeleteSessionParams,
  JsonRpcRequest, JsonRpcNotification,
  RequestPermissionResult,
  TerminalCreateResult, TerminalOutputResult, TerminalWaitForExitResult,
  McpServer,
} from './protocol.js';
import { runAgentSession } from './session.js';
import { loadCustomCommands } from '../utils/customCommands.js';
import { registerSessionServers, disposeSession as disposeMcpSession, disposeAllSessions as disposeAllMcpSessions } from '../utils/mcpRegistry.js';
import { loadMcpServerConfig, mergeMcpServers } from '../utils/mcpConfig.js';
import { handleMcpSamplingRequest } from '../utils/mcpSamplingBridge.js';
import { executeCommandAsync } from '../utils/shell.js';
import { PermissionOutcome } from '../utils/agent.js';
import { ToolCall } from '../utils/tools.js';
import { initWorkspace, loadWorkspace, handleCommand, AcpSession } from './commands.js';
import { autoSaveSession, config, setProvider, setApiKey, getApiKey, getConfiguredProviders, listSessionsWithInfo, deleteSession as deleteSessionFile, type LanguageCode } from '../config/index.js';
import { ApiError } from '../api/index.js';
import { PROVIDERS } from '../config/providers.js';
import { getCurrentVersion } from '../utils/update.js';
import { reportStats, syncSession, generateProjectId } from '../utils/codeepCloud.js';
import { getCostBreakdown, resetTokenTracking } from '../utils/tokenTracker.js';
import { isGitRepository } from '../utils/git.js';
import { getProjectContext } from '../utils/project.js';

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
  { name: 'personality', description: 'List or switch agent tone preset', input: { hint: '[name | off]' } },
  { name: 'me',        description: 'Your user profile — adapts the agent to you (reply language, style, stack)', input: { hint: '[init [project] | on | off | learn [on|off|project] | forget | sync]' } },
  { name: 'agents',    description: 'List sub-agents the agent can delegate self-contained tasks to' },
  { name: 'insights',  description: 'Activity summary over the last N days (default 7)', input: { hint: '[--days N]' } },
  // Project intelligence
  { name: 'scan',      description: 'Scan project structure and generate summary' },
  { name: 'review',    description: 'Run code review on project or specific files', input: { hint: '[file…]' } },
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

const AGENT_MODES: SessionModeState = {
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
 */
function formatToolInputForPermission(tool: string, params: Record<string, unknown>): Record<string, string> {
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
      if (typeof params.old_string === 'string' && typeof params.new_string === 'string') {
        out.changes = `replace ${(params.old_string as string).split('\n').length} line(s)`;
        out.old_string = truncateDiff(params.old_string as string);
        out.new_string = truncateDiff(params.new_string as string);
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
 */
function resolveLocalPath(uri: string): string | null {
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
 */
async function collectEmbeddedContext(blocks: import('./protocol.js').ContentBlock[]): Promise<string> {
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
 *  index — never reads plaintext key material). */
function providerHasKey(providerId: string): boolean {
  // Check environment variable first
  const envKey = PROVIDERS[providerId]?.envKey;
  if (envKey && process.env[envKey]) return true;
  // In-memory cache (populated from secure storage at startup)
  if (getApiKey(providerId)) return true;
  // Non-secret index of providers that have a key in secure storage
  return getConfiguredProviders().some(p => p.id === providerId);
}

function buildConfigOptions(): SessionConfigOption[] {
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

// ─── Server ───────────────────────────────────────────────────────────────────

export function startAcpServer(): Promise<void> {
  const transport = new StdioTransport();

  // ACP sessionId → full AcpSession (includes history + codeep session tracking)
  const sessions = new Map<string, AcpSession & { abortController: AbortController | null; currentModeId: string; titleSent: boolean; hadHistory: boolean }>();

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

  transport.start((msg: JsonRpcRequest | JsonRpcNotification) => {
    // Notifications have no id — handle separately
    if (!('id' in msg)) {
      handleNotification(msg as JsonRpcNotification);
      return;
    }
    const req = msg as JsonRpcRequest;
    switch (req.method) {
      case 'initialize':           handleInitialize(req);           break;
      case 'initialized':          /* no-op acknowledgment */        break;
      case 'authenticate':         handleAuthenticate(req);         break;
      case 'session/new':          handleSessionNew(req);           break;
      case 'session/load':         handleSessionLoad(req);          break;
      case 'session/resume':       handleSessionResume(req);        break;
      case 'session/prompt':       handleSessionPrompt(req);        break;
      case 'session/set_mode':     handleSetMode(req);              break;
      case 'session/set_config_option': handleSetConfigOption(req); break;
      case 'session/list':             handleSessionList(req);          break;
      case 'session/delete':           handleSessionDelete(req);        break;
      case 'session/list_providers':   handleListProviders(req);        break;
      default:
        process.stderr.write(`[codeep-acp] Unknown method: ${req.method}\n`);
        transport.error(req.id, -32601, `Method not found: ${req.method}`);
    }
  });

  // ── Notification handler (no id, no response) ──────────────────────────────

  function handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === 'session/cancel') {
      const { sessionId } = (msg.params ?? {}) as SessionCancelParams;
      sessions.get(sessionId)?.abortController?.abort();
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
    const fromConfig = loadMcpServerConfig(cwd);
    const merged = mergeMcpServers(fromConfig, acpServers);
    if (merged.length === 0) return;
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

  function handleSessionNew(msg: JsonRpcRequest): void {
    const params = msg.params as SessionNewParams;
    const acpSessionId = randomUUID();

    // Spin up MCP servers in the background. Errors surface via /mcp.
    spawnMcpServersForSession(acpSessionId, params.cwd, params.mcpServers, 'session/new');

    const { codeepSessionId, history, welcomeText } = initWorkspace(params.cwd, params.fresh);

    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      abortController: null,
      currentModeId: 'auto',
      titleSent: false,
      hadHistory: history.length > 0,
    });

    const result: SessionNewResult = {
      sessionId: acpSessionId,
      modes: AGENT_MODES,
      configOptions: buildConfigOptions(),
    };
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
    const params = msg.params as SessionLoadParams;

    // Try to restore existing Codeep session or fall back to fresh workspace
    const existing = sessions.get(params.sessionId);
    if (existing) {
      // Session already in memory — update cwd if changed
      existing.workspaceRoot = params.cwd;
      // Re-spawn any MCP servers the client passed in (they may have changed
      // since session/new; old ones get disposed by registerSessionServers).
      spawnMcpServersForSession(params.sessionId, params.cwd, params.mcpServers, 'session/load (warm)');
      const result: SessionLoadResult = {
        modes: AGENT_MODES,
        configOptions: buildConfigOptions(),
      };
      transport.respond(msg.id, result);
      return;
    }

    // Session not in memory — try to load from disk
    const { codeepSessionId, history, welcomeText } = loadWorkspace(params.cwd, params.sessionId);
    const acpSessionId = randomUUID();
    spawnMcpServersForSession(acpSessionId, params.cwd, params.mcpServers, 'session/load (cold)');

    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      abortController: null,
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
    sendSessionTitle(params.sessionId, history, pathBasename(params.cwd));

    // Send restored session welcome
    transport.notify('session/update', {
      sessionId: params.sessionId,
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
    const params = msg.params as SessionResumeParams;

    const existing = sessions.get(params.sessionId);
    if (existing) {
      existing.workspaceRoot = params.cwd;
      // Resume can carry an updated mcpServers list (e.g. workspace switched
      // config) — re-register so old servers are torn down and new ones spawn.
      spawnMcpServersForSession(params.sessionId, params.cwd, params.mcpServers, 'session/resume (warm)');
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
    const { codeepSessionId, history } = loadWorkspace(params.cwd, params.sessionId);
    const acpSessionId = randomUUID();
    spawnMcpServersForSession(acpSessionId, params.cwd, params.mcpServers, 'session/resume (cold)');
    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      abortController: null,
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
    const { sessionId, modeId } = msg.params as SetSessionModeParams;
    const session = sessions.get(sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${sessionId}`);
      return;
    }

    const validMode = AGENT_MODES.availableModes.find(m => m.id === modeId);
    if (!validMode) {
      transport.error(msg.id, -32602, `Unknown modeId: ${modeId}`);
      return;
    }

    session.currentModeId = modeId;
    // Do NOT persist the global `agentConfirmation` config here. The ACP
    // permission gate is driven per-session by `session.currentModeId` (see the
    // onRequestPermission wiring in handleSessionPrompt). Writing it globally
    // would leak this session's mode into other processes — e.g. switching ACP
    // to 'auto' would silently disarm the TUI's confirmation gate. Mode stays
    // on the in-memory session object only.

    transport.respond(msg.id, {});

    // Notify Zed of the mode change
    transport.notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: modeId,
      },
    });
  }

  // ── session/set_config_option ───────────────────────────────────────────────

  function handleSetConfigOption(msg: JsonRpcRequest): void {
    const { sessionId, configId, value } = msg.params as SetSessionConfigOptionParams;
    const session = sessions.get(sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${sessionId}`);
      return;
    }

    if (configId === 'model' && typeof value === 'string') {
      // value is "providerId/modelId" — split and switch both
      const slashIdx = value.indexOf('/');
      if (slashIdx !== -1) {
        const providerId = value.slice(0, slashIdx);
        const modelId = value.slice(slashIdx + 1);
        setProvider(providerId);   // sets provider + defaultModel + protocol
        config.set('model', modelId);
      } else {
        config.set('model', value);
      }
    } else if (configId === 'provider' && typeof value === 'string') {
      // Switch provider without specifying a model — picks the provider's
      // default model + protocol. Used by editor clients that pin a provider
      // in their settings (e.g. the VS Code `codeep.provider` setting).
      setProvider(value);
    } else if (configId === 'customBaseUrl' && typeof value === 'string') {
      // Base URL for the `custom` (OpenAI-compatible) provider — lets editor
      // clients point Codeep at a self-hosted endpoint (vLLM/LiteLLM/LM Studio)
      // without hand-editing ~/.codeep/config.json.
      config.set('customBaseUrl', value);
    } else if (configId === 'language' && typeof value === 'string') {
      config.set('language', value as LanguageCode);
    } else if (
      configId === 'agentConfirmDeleteFile' ||
      configId === 'agentConfirmExecuteCommand' ||
      configId === 'agentConfirmWriteFile' ||
      configId === 'userProfile' ||
      configId === 'autoLearnProfile'
    ) {
      // Accept boolean or "true"/"false" string from Zed/VSCode
      const bool = value === true || value === 'true';
      config.set(configId, bool);
    } else if (configId === 'login' && typeof value === 'string') {
      // value is "providerId:apiKey"
      const colonIdx = value.indexOf(':');
      if (colonIdx !== -1) {
        const providerId = value.slice(0, colonIdx);
        const apiKey = value.slice(colonIdx + 1);
        if (providerId && apiKey) {
          setProvider(providerId);
          // Cache is updated synchronously inside setApiKey; the keychain write
          // resolves while the long-lived server runs. Swallow a persistence
          // failure here (secondary path) so it can't become an unhandled
          // rejection — the key still works for this session via the cache.
          setApiKey(apiKey, providerId).catch(() => { /* persistence failed; cached for session */ });
        }
      }
    }

    transport.respond(msg.id, {});

    // Confirm the new value back to Zed so its UI state stays in sync
    transport.notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: buildConfigOptions(),
      },
    });
  }

  // ── session/list ─────────────────────────────────────────────────────────────

  function handleSessionList(msg: JsonRpcRequest): void {
    const params = (msg.params ?? {}) as ListSessionsParams;

    // Collect local (project-scoped) sessions and global sessions, deduplicated by name
    const seen = new Set<string>();
    const merged = [
      ...listSessionsWithInfo(params.cwd),   // project-local first
      ...listSessionsWithInfo(),              // global fallback
    ].filter(s => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });

    // Sort newest first
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const acpSessions: AcpSessionInfo[] = merged.map(s => ({
      sessionId: s.name,
      cwd: params.cwd ?? '',
      title: s.title,
      updatedAt: s.createdAt,
    }));
    const result: ListSessionsResult = { sessions: acpSessions };
    transport.respond(msg.id, result);
  }

  // ── session/delete ───────────────────────────────────────────────────────────

  function handleSessionDelete(msg: JsonRpcRequest): void {
    const { sessionId, cwd } = (msg.params ?? {}) as DeleteSessionParams;
    // Remove from in-memory sessions map if present
    sessions.delete(sessionId);
    // Tear down any MCP server processes attached to this session — leaks
    // children otherwise. Fire-and-forget; client doesn't wait on stop().
    disposeMcpSession(sessionId).catch(() => { /* logged inside */ });
    // Try project dir first, then global
    const deleted = deleteSessionFile(sessionId, cwd || undefined);
    if (!deleted && cwd) deleteSessionFile(sessionId);
    transport.respond(msg.id, {});
  }

  // ── session/list_providers ──────────────────────────────────────────────────
  // Canonical provider list for ACP clients (Codeep VS Code extension etc.).
  // Lets the client populate its API-key dropdowns and group labels from one
  // source instead of carrying its own hardcoded copy. Keep this stable —
  // adding new fields is fine, removing/renaming would break existing clients.
  function handleListProviders(msg: JsonRpcRequest): void {
    const providers = Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
      groupLabel: p.groupLabel ?? p.name,
      hint: p.hint ?? p.description,
      requiresKey: !p.noApiKey,
      subscribeUrl: p.subscribeUrl,
      // Model metadata so ACP clients (e.g. the VS Code model picker) can
      // offer a provider → model selector without hardcoding a catalog.
      // `dynamicModels` flags providers whose model list is open-ended
      // (OpenRouter, Ollama, custom endpoints) — clients should let the
      // user type a model id rather than only pick from `models`.
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
      defaultModel: p.defaultModel,
      dynamicModels: p.dynamicModels ?? false,
    }));
    transport.respond(msg.id, { providers });
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
        autoSaveSession(session.history, session.workspaceRoot);
      } catch (err) {
        transport.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Image analysis failed: ${(err as Error).message}` } },
        });
      }
      return;
    }

    const abortController = new AbortController();
    session.abortController = abortController;

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

    resetTokenTracking();

    // Manual mode gates write/edit for THIS run via a per-call option passed to
    // runAgentSession (extraDangerousTools, below) — NOT by mutating the global
    // `agentConfirmWriteFile` config, which leaked the session's mode into the
    // TUI/other processes and raced on a non-atomic restore.

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

    // Try slash commands first
    handleCommand(prompt, session, sendChunk, abortController.signal)
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
          transport.respond(msg.id, { stopReason: 'end_turn' });
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
          // Manual mode gates write_file/edit_file for this run only (per-call,
          // no global config mutation).
          extraDangerousTools: session.currentModeId === 'manual' ? ['write_file', 'edit_file'] : undefined,
          // Only request permission in Manual mode
          onRequestPermission: session.currentModeId === 'manual'
            ? async (toolCall: ToolCall): Promise<PermissionOutcome> => {
                const permToolCallId = `perm_${randomUUID()}`;
                const result = await transport.request('session/request_permission', {
                  sessionId: params.sessionId,
                  toolCall: {
                    toolCallId: permToolCallId,
                    toolName: toolCall.tool,
                    toolInput: formatToolInputForPermission(toolCall.tool, toolCall.parameters as Record<string, unknown>),
                    status: 'pending',
                    content: [],
                  },
                  options: [
                    { optionId: 'allow_once',    name: 'Allow once',    kind: 'allow_once' },
                    { optionId: 'allow_always',  name: 'Allow always',  kind: 'allow_always' },
                    { optionId: 'reject_once',   name: 'Reject once',   kind: 'reject_once' },
                    { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
                  ],
                }) as RequestPermissionResult | null;

                // Map ACP outcome back to PermissionOutcome
                if (!result || result.outcome.type === 'cancelled') return 'reject_once';
                return result.outcome.optionId as PermissionOutcome;
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
                  await transport.request('fs/write_text_file', {
                    sessionId: params.sessionId,
                    path: absolutePath,
                    content,
                  });
                }
              : undefined,
          },
          onExecuteCommand: async (command: string, args: string[], cwd: string) => {
            // Per ACP spec, only call terminal/* if the client advertised the
            // capability in initialize. Otherwise execute locally.
            if (!clientSupportsTerminal) {
              const r = await executeCommandAsync(command, args, { cwd, projectRoot: cwd, timeout: 120000 });
              return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
            }
            try {
              const createResult = await transport.request('terminal/create', {
                sessionId: params.sessionId,
                command,
                args,
                cwd,
                outputByteLimit: 1_000_000,
              }) as TerminalCreateResult;

              const { terminalId } = createResult;

              // Spec method is snake_case `terminal/wait_for_exit` and takes
              // only { sessionId, terminalId } — no timeoutMs.
              const waitResult = await transport.request('terminal/wait_for_exit', {
                sessionId: params.sessionId,
                terminalId,
              }) as TerminalWaitForExitResult;

              const outputResult = await transport.request('terminal/output', {
                sessionId: params.sessionId,
                terminalId,
              }) as TerminalOutputResult;

              await transport.request('terminal/release', {
                sessionId: params.sessionId,
                terminalId,
              });

              const exitCode = waitResult.exitStatus.type === 'exited' ? waitResult.exitStatus.code : 1;
              return { stdout: outputResult.output ?? '', stderr: '', exitCode };
            } catch (err) {
              // Client terminal failed — fall back to local execution
              const r = await executeCommandAsync(command, args, { cwd, projectRoot: cwd, timeout: 120000 });
              return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
            }
          },
        }).then(() => {
          session.history.push({ role: 'user', content: prompt });
          const agentResponse = agentResponseChunks.join('');
          if (agentResponse) {
            session.history.push({ role: 'assistant', content: agentResponse });
          }
          autoSaveSession(session.history, session.workspaceRoot);

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
          const costBreakdown = getCostBreakdown();
          if (costBreakdown.length > 0) {
            for (const entry of costBreakdown) {
              reportStats({
                ...sharedFields,
                model: entry.model,
                provider: entry.provider,
                inputTokens: entry.promptTokens || undefined,
                outputTokens: entry.completionTokens || undefined,
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

          transport.respond(msg.id, { stopReason: 'end_turn' });
        }).catch((err: Error) => {
          if (err.name === 'AbortError') {
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
          if (session) session.abortController = null;
          planEntries.clear();
        });
      })
      .catch((err: Error) => {
        if (err.message?.includes('API key not configured') || err.message?.includes('API key') || (err instanceof ApiError && err.status === 401)) {
          sendChunk(`❌ No API key configured. Use /login <provider> <key> or set the environment variable (e.g. ZAI_API_KEY, ANTHROPIC_API_KEY).`);
          transport.respond(msg.id, { stopReason: 'end_turn' });
        } else if (err instanceof ApiError && err.status >= 500) {
          sendChunk(`⚠️ API server error (${err.status}). Please try again.`);
          transport.respond(msg.id, { stopReason: 'end_turn' });
        } else {
          transport.error(msg.id, -32000, err.message);
        }
        if (session) session.abortController = null;
      });
  }

  // Keep process alive until stdin closes (Zed terminates us)
  return new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
  });
}
