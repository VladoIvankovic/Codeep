// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
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
} from './protocol.js';
import { JsonRpcRequest, JsonRpcNotification } from './protocol.js';
import { runAgentSession } from './session.js';
import { initWorkspace, loadWorkspace, handleCommand, AcpSession } from './commands.js';
import { autoSaveSession, config, setProvider, listSessionsWithInfo, deleteSession as deleteSessionFile } from '../config/index.js';
import { PROVIDERS } from '../config/providers.js';
import { getCurrentVersion } from '../utils/update.js';

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
  return [
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select',
      currentValue,
      options: modelOptions,
    },
  ];
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function startAcpServer(): Promise<void> {
  const transport = new StdioTransport();

  // ACP sessionId → full AcpSession (includes history + codeep session tracking)
  const sessions = new Map<string, AcpSession & { abortController: AbortController | null; currentModeId: string }>();

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

  // ── session/new ─────────────────────────────────────────────────────────────

  function handleSessionNew(msg: JsonRpcRequest): void {
    const params = msg.params as SessionNewParams;
    const acpSessionId = randomUUID();

    const { codeepSessionId, history, welcomeText } = initWorkspace(params.cwd);

    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      abortController: null,
      currentModeId: 'auto',
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

    sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      addedFiles: new Map(),
      abortController: null,
      currentModeId: 'auto',
    });

    const result: SessionLoadResult = {
      modes: AGENT_MODES,
      configOptions: buildConfigOptions(),
    };
    transport.respond(msg.id, result);

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
    const sessionInfos = listSessionsWithInfo(params.cwd);
    const acpSessions: AcpSessionInfo[] = sessionInfos.map(s => ({
      sessionId: s.name,
      cwd: params.cwd ?? '',
      title: s.name,
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

  function handleSessionPrompt(msg: JsonRpcRequest): void {
    const params = msg.params as SessionPromptParams;
    const session = sessions.get(params.sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }

    // Extract text from ContentBlock[]
    const prompt = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');

    const abortController = new AbortController();
    session.abortController = abortController;

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
          onToolCall: (toolCallId, toolName, kind, title, status, locations) => {
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
            } else {
              // tool_call_update: update status to completed/failed
              transport.notify('session/update', {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId,
                  status: status === 'finished' ? 'completed' : 'failed',
                },
              });
            }
          },
        }).then(() => {
          session.history.push({ role: 'user', content: prompt });
          const agentResponse = agentResponseChunks.join('');
          if (agentResponse) {
            session.history.push({ role: 'assistant', content: agentResponse });
          }
          autoSaveSession(session.history, session.workspaceRoot);
          transport.respond(msg.id, { stopReason: 'end_turn' });
        }).catch((err: Error) => {
          if (err.name === 'AbortError') {
            transport.respond(msg.id, { stopReason: 'cancelled' });
          } else {
            transport.error(msg.id, -32000, err.message);
          }
        }).finally(() => {
          if (session) session.abortController = null;
        });
      })
      .catch((err: Error) => {
        transport.error(msg.id, -32000, err.message);
        if (session) session.abortController = null;
      });
  }

  // Keep process alive until stdin closes (Zed terminates us)
  return new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
  });
}
