// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
import { basename as pathBasename } from 'path';
import { StdioTransport } from './transport.js';
import {
  InitializeParams, InitializeResult,
  SessionNewParams, SessionNewResult,
  SessionLoadParams, SessionLoadResult,
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
} from './protocol.js';
import { runAgentSession } from './session.js';
import { executeCommandAsync } from '../utils/shell.js';
import { PermissionOutcome } from '../utils/agent.js';
import { ToolCall } from '../utils/tools.js';
import { initWorkspace, loadWorkspace, handleCommand, AcpSession } from './commands.js';
import { autoSaveSession, config, setProvider, listSessionsWithInfo, deleteSession as deleteSessionFile, type LanguageCode } from '../config/index.js';
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
  { name: 'model',     description: 'List or switch model', input: { hint: '<model-id>' } },
  { name: 'login',     description: 'Set API key for a provider', input: { hint: '<providerId> <apiKey>' } },
  { name: 'apikey',    description: 'Show or set API key for current provider', input: { hint: '<key>' } },
  { name: 'lang',      description: 'Set response language', input: { hint: '<code> (en, hr, auto…)' } },
  { name: 'grant',     description: 'Grant write access for workspace' },
  // Sessions
  { name: 'session',   description: 'List sessions, or: new / load <name>', input: { hint: 'new | load <name>' } },
  { name: 'save',      description: 'Save current session', input: { hint: '[name]' } },
  // Context
  { name: 'add',       description: 'Add files to agent context', input: { hint: '<file> [file2…]' } },
  { name: 'drop',      description: 'Remove files from context (no args = clear all)', input: { hint: '[file…]' } },
  // Actions
  { name: 'diff',      description: 'Git diff with AI review', input: { hint: '[--staged]' } },
  { name: 'undo',      description: 'Undo last agent action' },
  { name: 'undo-all',  description: 'Undo all agent actions in session' },
  { name: 'changes',   description: 'Show all changes made in session' },
  { name: 'export',    description: 'Export conversation', input: { hint: 'json | md | txt' } },
  // Project intelligence
  { name: 'scan',      description: 'Scan project structure and generate summary' },
  { name: 'review',    description: 'Run code review on project or specific files', input: { hint: '[file…]' } },
  { name: 'learn',     description: 'Learn coding preferences from project files' },
  // Skills
  { name: 'skills',    description: 'List all available skills', input: { hint: '[query]' } },
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
  const truncate = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '…' : s;
  };

  switch (tool) {
    case 'write_file':
    case 'edit_file': {
      const path = params.path as string ?? '';
      const lines = typeof params.content === 'string'
        ? params.content.split('\n').length + ' lines'
        : typeof params.old_string === 'string'
          ? `replace ${(params.old_string as string).split('\n').length} line(s)`
          : '';
      return { file: pathBasename(path), path, changes: lines };
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

/** Check if a provider has an API key stored (reads config directly, no async) */
function providerHasKey(providerId: string): boolean {
  // Check environment variable first
  const envKey = PROVIDERS[providerId]?.envKey;
  if (envKey && process.env[envKey]) return true;
  // Check stored providerApiKeys
  const stored = (config.get('providerApiKeys') || []) as { providerId: string; apiKey: string }[];
  return stored.some(k => k.providerId === providerId && !!k.apiKey);
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
  ];
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function startAcpServer(): Promise<void> {
  const transport = new StdioTransport();

  // ACP sessionId → full AcpSession (includes history + codeep session tracking)
  const sessions = new Map<string, AcpSession & { abortController: AbortController | null; currentModeId: string; titleSent: boolean; hadHistory: boolean }>();

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
      case 'session/new':          handleSessionNew(req);           break;
      case 'session/load':         handleSessionLoad(req);          break;
      case 'session/prompt':       handleSessionPrompt(req);        break;
      case 'session/set_mode':     handleSetMode(req);              break;
      case 'session/set_config_option': handleSetConfigOption(req); break;
      case 'session/list':             handleSessionList(req);          break;
      case 'session/delete':           handleSessionDelete(req);        break;
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

  function handleInitialize(msg: JsonRpcRequest): void {
    const _params = msg.params as InitializeParams;
    const result: InitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        terminal: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      },
      agentInfo: {
        name: 'codeep',
        version: getCurrentVersion(),
      },
      authMethods: [],
    };
    transport.respond(msg.id, result);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  function sendSessionTitle(sessionId: string, history: { role: string; content: string }[], fallback?: string): void {
    const firstUserMsg = history.find(m => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.replace(/\n/g, ' ').trim().slice(0, 60)
      : (fallback ?? 'Codeep session');
    transport.notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        title,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  // ── session/new ─────────────────────────────────────────────────────────────

  function handleSessionNew(msg: JsonRpcRequest): void {
    const params = msg.params as SessionNewParams;
    const acpSessionId = randomUUID();

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

    // Advertise slash commands
    transport.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: AVAILABLE_COMMANDS,
      },
    });

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

  // ── session/load ────────────────────────────────────────────────────────────

  function handleSessionLoad(msg: JsonRpcRequest): void {
    const params = msg.params as SessionLoadParams;

    // Try to restore existing Codeep session or fall back to fresh workspace
    const existing = sessions.get(params.sessionId);
    if (existing) {
      // Session already in memory — update cwd if changed
      existing.workspaceRoot = params.cwd;
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
      modes: AGENT_MODES,
      configOptions: buildConfigOptions(),
    };
    transport.respond(msg.id, result);

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
    // Map ACP mode to Codeep agentConfirmation setting
    config.set('agentConfirmation', modeId === 'manual' ? 'dangerous' : 'never');

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
    } else if (configId === 'language' && typeof value === 'string') {
      config.set('language', value as LanguageCode);
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
    const { sessionId } = (msg.params ?? {}) as DeleteSessionParams;
    // Remove from in-memory sessions map if present
    sessions.delete(sessionId);
    // Delete from disk — sessionId is used as the session file name
    deleteSessionFile(sessionId);
    transport.respond(msg.id, {});
  }

  // ── session/prompt ──────────────────────────────────────────────────────────

  async function handleSessionPrompt(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as SessionPromptParams;
    const session = sessions.get(params.sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }

    // Extract text from ContentBlock[]
    let prompt = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');

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

    // In manual mode, confirm write/edit operations
    const prevConfirmWrite = config.get('agentConfirmWriteFile');
    if (session.currentModeId === 'manual') {
      config.set('agentConfirmWriteFile', true);
    }

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
          onExecuteCommand: async (command: string, args: string[], cwd: string) => {
            try {
              const createResult = await transport.request('terminal/create', {
                sessionId: params.sessionId,
                command,
                args,
                cwd,
                outputByteLimit: 1_000_000,
              }) as TerminalCreateResult;

              const { terminalId } = createResult;

              const waitResult = await transport.request('terminal/waitForExit', {
                sessionId: params.sessionId,
                terminalId,
                timeoutMs: 120_000,
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
              // Zed terminal unavailable — fall back to local execution
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
          config.set('agentConfirmWriteFile', prevConfirmWrite);
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
          config.set('agentConfirmWriteFile', prevConfirmWrite);
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
