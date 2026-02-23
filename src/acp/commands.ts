// acp/commands.ts
// Slash command handler for ACP sessions.
// Mirrors CLI commands from renderer/commands.ts but returns plain text
// responses (no TUI) suitable for streaming back via session/update.

import {
  config,
  getCurrentProvider,
  getModelsForCurrentProvider,
  setProvider,
  setApiKey,
  isConfigured,
  listSessionsWithInfo,
  startNewSession,
  loadSession,
  getCurrentSessionId,
  saveSession,
  initializeAsProject,
  isManuallyInitializedProject,
  setProjectPermission,
  hasWritePermission,
  hasReadPermission,
} from '../config/index.js';
import { getProviderList, getProvider } from '../config/providers.js';
import { getProjectContext } from '../utils/project.js';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Message } from '../config/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AcpSession {
  sessionId: string;
  workspaceRoot: string;
  /** In-memory message history for the ACP conversation */
  history: Message[];
  /** Codeep session name (maps to .codeep/sessions/<name>.json) */
  codeepSessionId: string;
}

export interface CommandResult {
  handled: boolean;
  response: string;
}

// ─── Workspace / session init (called on session/new) ─────────────────────────

/**
 * Ensure workspace has a .codeep folder, initialise it as a project if needed,
 * and load the most recent session (or start a new one).
 *
 * Returns the welcome message to stream back to the client.
 */
export function initWorkspace(workspaceRoot: string): {
  codeepSessionId: string;
  history: Message[];
  welcomeText: string;
} {
  // 1. Ensure .codeep directory exists
  const codeepDir = join(workspaceRoot, '.codeep');
  if (!existsSync(codeepDir)) {
    mkdirSync(codeepDir, { recursive: true });
  }

  // 2. Auto-initialize as project if not already (workspace root is always a project in ACP context)
  if (!isManuallyInitializedProject(workspaceRoot)) {
    initializeAsProject(workspaceRoot);
  }

  // 3. Grant read+write permission for this workspace (ACP always has access)
  if (!hasReadPermission(workspaceRoot)) {
    setProjectPermission(workspaceRoot, true, true);
  }

  // 4. Load most recent session, or start fresh
  const sessions = listSessionsWithInfo(workspaceRoot);
  let codeepSessionId: string;
  let history: Message[] = [];

  if (sessions.length > 0) {
    const latest = sessions[0]; // already sorted newest-first
    const loaded = loadSession(latest.name, workspaceRoot);
    if (loaded) {
      codeepSessionId = latest.name;
      history = loaded as Message[];
    } else {
      codeepSessionId = startNewSession();
    }
  } else {
    codeepSessionId = startNewSession();
  }

  // 5. Build welcome text
  const provider = getCurrentProvider();
  const model = config.get('model');
  const projectCtx = getProjectContext(workspaceRoot);
  const hasWrite = hasWritePermission(workspaceRoot);

  const lines: string[] = [
    `**Codeep** • ${provider.name} • \`${model}\``,
    '',
    `**Workspace:** ${workspaceRoot}`,
    projectCtx
      ? `**Project:** ${projectCtx.name} (${projectCtx.type})`
      : '**Project:** detected',
    hasWrite ? '**Access:** Read & Write' : '**Access:** Read only',
    '',
    sessions.length > 0
      ? `**Session:** ${codeepSessionId} (${history.length} messages restored)`
      : '**Session:** new',
    '',
    'Type `/help` to see available commands.',
  ];

  if (history.length > 0) {
    lines.push('', '---', '');
    lines.push(...formatSessionPreviewLines(history));
  }

  return { codeepSessionId, history, welcomeText: lines.join('\n') };
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

export function handleCommand(input: string, session: AcpSession): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false, response: '' };

  const [rawCmd, ...args] = trimmed.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();

  switch (cmd) {
    case 'help':
      return { handled: true, response: buildHelp() };

    case 'status':
      return { handled: true, response: buildStatus(session) };

    case 'version': {
      const provider = getCurrentProvider();
      const model = config.get('model');
      return { handled: true, response: `Codeep • ${provider.name} • \`${model}\`` };
    }

    case 'provider': {
      if (!args.length) return { handled: true, response: buildProviderList() };
      return { handled: true, response: setProviderCmd(args[0]) };
    }

    case 'model': {
      if (!args.length) return { handled: true, response: buildModelList() };
      return { handled: true, response: setModelCmd(args[0]) };
    }

    case 'apikey': {
      if (!args.length) return { handled: true, response: showApiKey() };
      return { handled: true, response: setApiKeyCmd(args[0]) };
    }

    case 'login': {
      // In ACP context login = set API key for a provider
      // Usage: /login <providerId> <apiKey>
      const [providerId, apiKey] = args;
      if (!providerId || !apiKey) {
        return { handled: true, response: 'Usage: `/login <providerId> <apiKey>`\n\n' + buildProviderList() };
      }
      return { handled: true, response: loginCmd(providerId, apiKey) };
    }

    case 'sessions':
    case 'session': {
      const sub = args[0];
      if (!sub) {
        // No argument — show list with usage hint
        return { handled: true, response: buildSessionList(session.workspaceRoot) };
      }
      if (sub === 'new') {
        const id = startNewSession();
        session.codeepSessionId = id;
        session.history = [];
        return { handled: true, response: `New session started: \`${id}\`` };
      }
      if (sub === 'load' && args[1]) {
        const loaded = loadSession(args[1], session.workspaceRoot);
        if (loaded) {
          session.codeepSessionId = args[1];
          session.history = loaded as Message[];
          return { handled: true, response: formatSessionPreview(args[1], session.history) };
        }
        return { handled: true, response: `Session not found: \`${args[1]}\`` };
      }
      return { handled: true, response: 'Usage: `/session` · `/session new` · `/session load <name>`' };
    }

    case 'save': {
      const name = args.length ? args.join('-') : session.codeepSessionId;
      if (saveSession(name, session.history, session.workspaceRoot)) {
        session.codeepSessionId = name;
        return { handled: true, response: `Session saved as: \`${name}\`` };
      }
      return { handled: true, response: 'Failed to save session.' };
    }

    case 'grant': {
      setProjectPermission(session.workspaceRoot, true, true);
      const ctx = getProjectContext(session.workspaceRoot);
      return { handled: true, response: `Write access granted for \`${ctx?.name || session.workspaceRoot}\`` };
    }

    case 'lang': {
      if (!args.length) {
        const current = config.get('language') || 'auto';
        return { handled: true, response: `Current language: \`${current}\`. Usage: \`/lang <code>\` (e.g. \`en\`, \`hr\`, \`auto\`)` };
      }
      config.set('language', args[0] as 'auto' | 'en' | 'zh' | 'es' | 'hi' | 'ar' | 'pt' | 'fr' | 'de' | 'ja' | 'ru' | 'hr');
      return { handled: true, response: `Language set to \`${args[0]}\`` };
    }

    default:
      return {
        handled: true,
        response: `Unknown command: \`/${cmd}\`\n\nType \`/help\` to see available commands.`,
      };
  }
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function buildHelp(): string {
  return [
    '## Codeep Commands',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/help` | Show this help |',
    '| `/status` | Show current configuration and session info |',
    '| `/version` | Show version and current model |',
    '| `/provider` | List available providers |',
    '| `/provider <id>` | Switch provider (e.g. `/provider anthropic`) |',
    '| `/model` | List models for current provider |',
    '| `/model <id>` | Switch model (e.g. `/model claude-opus-4-5`) |',
    '| `/login <providerId> <apiKey>` | Set API key for a provider |',
    '| `/apikey` | Show masked API key for current provider |',
    '| `/apikey <key>` | Set API key for current provider |',
    '| `/session` | List saved sessions |',
    '| `/session new` | Start a new session |',
    '| `/session load <name>` | Load a saved session |',
    '| `/save [name]` | Save current session |',
    '| `/grant` | Grant write access for current workspace |',
    '| `/lang <code>` | Set response language (e.g. `en`, `hr`, `auto`) |',
  ].join('\n');
}

function buildStatus(session: AcpSession): string {
  const provider = getCurrentProvider();
  const model = config.get('model');
  const lang = config.get('language') || 'auto';
  const hasWrite = hasWritePermission(session.workspaceRoot);
  const configured = isConfigured();

  return [
    '## Current Status',
    '',
    `- **Provider:** ${provider.name} (\`${provider.id}\`)`,
    `- **Model:** \`${model}\``,
    `- **API Key:** ${configured ? 'configured' : '_not set_ — use `/login` or `/apikey`_'}`,
    `- **Language:** \`${lang}\``,
    `- **Workspace:** \`${session.workspaceRoot}\``,
    `- **Access:** ${hasWrite ? 'Read & Write' : 'Read only'}`,
    `- **Session:** \`${session.codeepSessionId}\` (${session.history.length} messages)`,
  ].join('\n');
}

function buildProviderList(): string {
  const current = getCurrentProvider();
  const providers = getProviderList();
  const lines = ['## Available Providers', ''];
  for (const p of providers) {
    const marker = p.id === current.id ? ' ✓' : '';
    lines.push(`- \`${p.id}\`${marker} — **${p.name}**: ${p.description || ''}`);
  }
  lines.push('', 'Use `/provider <id>` to switch.');
  return lines.join('\n');
}

function setProviderCmd(id: string): string {
  const provider = getProvider(id);
  if (!provider) return `Provider \`${id}\` not found.\n\n${buildProviderList()}`;
  setProvider(id);
  return `Switched to **${provider.name}** (\`${id}\`). Default model: \`${provider.defaultModel}\`.`;
}

function buildModelList(): string {
  const current = config.get('model');
  const models = getModelsForCurrentProvider();
  const lines = ['## Models for Current Provider', ''];
  for (const [id, label] of Object.entries(models)) {
    const marker = id === current ? ' ✓' : '';
    lines.push(`- \`${id}\`${marker} — ${label}`);
  }
  lines.push('', 'Use `/model <id>` to switch.');
  return lines.join('\n');
}

function setModelCmd(id: string): string {
  const models = getModelsForCurrentProvider();
  if (!models[id]) return `Model \`${id}\` not available.\n\n${buildModelList()}`;
  config.set('model', id);
  return `Model set to \`${id}\`.`;
}

function showApiKey(): string {
  const providerId = getCurrentProvider().id;
  const configured = isConfigured(providerId);
  return configured
    ? `API key for \`${providerId}\`: configured (use \`/apikey <key>\` to update)`
    : `No API key set for \`${providerId}\`. Use \`/apikey <key>\` to set one.`;
}

function setApiKeyCmd(key: string): string {
  const providerId = getCurrentProvider().id;
  // setApiKey is async (keychain) — fire-and-forget, config cache updated synchronously
  setApiKey(key, providerId);
  return `API key for \`${providerId}\` saved.`;
}

function loginCmd(providerId: string, apiKey: string): string {
  const provider = getProvider(providerId);
  if (!provider) return `Provider \`${providerId}\` not found.\n\n${buildProviderList()}`;
  setProvider(providerId);
  setApiKey(apiKey, providerId);
  return `Logged in as **${provider.name}** (\`${providerId}\`). Model: \`${provider.defaultModel}\`.`;
}

const PREVIEW_MESSAGES = 6; // last N messages to show on session restore
const PREVIEW_MAX_CHARS = 300; // truncate long messages

function formatSessionPreviewLines(history: Message[]): string[] {
  const recent = history.slice(-PREVIEW_MESSAGES);
  const lines: string[] = [`*Last ${recent.length} message${recent.length !== 1 ? 's' : ''}:*`, ''];
  for (const msg of recent) {
    const role = msg.role === 'user' ? '**You**' : msg.role === 'assistant' ? '**Codeep**' : '_system_';
    const text = msg.content.length > PREVIEW_MAX_CHARS
      ? msg.content.slice(0, PREVIEW_MAX_CHARS) + '…'
      : msg.content;
    // Collapse newlines to keep preview compact
    lines.push(`${role}: ${text.replace(/\n+/g, ' ')}`);
  }
  return lines;
}

function formatSessionPreview(name: string, history: Message[]): string {
  const lines = [
    `Session loaded: \`${name}\` (${history.length} messages)`,
    '',
    '---',
    '',
    ...formatSessionPreviewLines(history),
  ];
  return lines.join('\n');
}

function buildSessionList(workspaceRoot: string): string {
  const sessions = listSessionsWithInfo(workspaceRoot);
  if (sessions.length === 0) return 'No saved sessions. Start chatting to create one.';
  const lines = ['## Saved Sessions', ''];
  for (const s of sessions) {
    lines.push(`- \`${s.name}\` — ${s.messageCount} messages — ${new Date(s.createdAt).toLocaleString()}`);
  }
  lines.push('', 'Use `/session load <name>` to restore.');
  return lines.join('\n');
}
