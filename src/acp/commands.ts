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
import { chat } from '../api/index.js';
import { runAgent } from '../utils/agent.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AcpSession {
  sessionId: string;
  workspaceRoot: string;
  /** In-memory message history for the ACP conversation */
  history: Message[];
  /** Codeep session name (maps to .codeep/sessions/<name>.json) */
  codeepSessionId: string;
  /** Files added to context via /add */
  addedFiles: Map<string, { relativePath: string; content: string }>;
}

export interface CommandResult {
  /** true if the input was a slash command (even if it failed) */
  handled: boolean;
  /** Markdown text to stream back to the client */
  response: string;
  /** If true, server should stream response chunks as they arrive (skills) */
  streaming?: boolean;
  /** If true, server should re-send configOptions to client (provider/model changed) */
  configOptionsChanged?: boolean;
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

/**
 * Restore a previously saved ACP session by its Zed sessionId.
 * Falls back to initWorkspace if the session cannot be found on disk.
 */
export function loadWorkspace(workspaceRoot: string, acpSessionId: string): {
  codeepSessionId: string;
  history: Message[];
  welcomeText: string;
} {
  // Ensure workspace is set up
  const codeepDir = join(workspaceRoot, '.codeep');
  if (!existsSync(codeepDir)) {
    mkdirSync(codeepDir, { recursive: true });
  }
  if (!isManuallyInitializedProject(workspaceRoot)) {
    initializeAsProject(workspaceRoot);
  }
  if (!hasReadPermission(workspaceRoot)) {
    setProjectPermission(workspaceRoot, true, true);
  }

  // Try to load the session that was saved under this ACP session ID
  const loaded = loadSession(acpSessionId, workspaceRoot);
  if (loaded) {
    const history = loaded as Message[];
    const provider = getCurrentProvider();
    const model = config.get('model');
    const lines: string[] = [
      `**Codeep** • ${provider.name} • \`${model}\``,
      '',
      `**Session restored:** ${acpSessionId} (${history.length} messages)`,
      '',
      ...formatSessionPreviewLines(history),
    ];
    return { codeepSessionId: acpSessionId, history, welcomeText: lines.join('\n') };
  }

  // Session not found — fall back to initWorkspace behaviour
  return initWorkspace(workspaceRoot);
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

/**
 * Try to handle a slash command. Async because skills and diff/review
 * need to call the AI API or run shell commands.
 *
 * onChunk is called for streaming output (skills). For simple commands
 * the full response is returned in CommandResult.response.
 */
export async function handleCommand(
  input: string,
  session: AcpSession,
  onChunk: (text: string) => void,
  abortSignal?: AbortSignal,
): Promise<CommandResult> {
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
      return { handled: true, response: setProviderCmd(args[0]), configOptionsChanged: true };
    }

    case 'model': {
      if (!args.length) return { handled: true, response: buildModelList() };
      return { handled: true, response: setModelCmd(args[0]), configOptionsChanged: true };
    }

    case 'apikey': {
      if (!args.length) return { handled: true, response: showApiKey() };
      return { handled: true, response: setApiKeyCmd(args[0]) };
    }

    case 'login': {
      const [providerId, apiKey] = args;
      if (!providerId || !apiKey) {
        return { handled: true, response: 'Usage: `/login <providerId> <apiKey>`\n\n' + buildProviderList() };
      }
      return { handled: true, response: loginCmd(providerId, apiKey) };
    }

    case 'sessions':
    case 'session': {
      const sub = args[0];
      if (!sub) return { handled: true, response: buildSessionList(session.workspaceRoot) };
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
      const validLangs = ['auto', 'en', 'zh', 'es', 'hi', 'ar', 'pt', 'fr', 'de', 'ja', 'ru', 'hr'] as const;
      if (!args.length) {
        const current = config.get('language') || 'auto';
        return { handled: true, response: `Current language: \`${current}\`. Usage: \`/lang <code>\` (${validLangs.join(', ')})` };
      }
      const lang = args[0].toLowerCase();
      if (!validLangs.includes(lang as typeof validLangs[number])) {
        return { handled: true, response: `Invalid language \`${args[0]}\`. Valid: ${validLangs.join(', ')}` };
      }
      config.set('language', lang as typeof validLangs[number]);
      return { handled: true, response: `Language set to \`${lang}\`` };
    }

    // ─── File context ──────────────────────────────────────────────────────────

    case 'add': {
      if (!args.length) {
        if (session.addedFiles.size === 0) return { handled: true, response: 'No files in context. Usage: `/add <file> [file2...]`' };
        const list = [...session.addedFiles.values()].map(f => `- \`${f.relativePath}\``).join('\n');
        return { handled: true, response: `**Files in context (${session.addedFiles.size}):**\n${list}` };
      }
      const { promises: fs } = await import('fs');
      const pathMod = await import('path');
      const root = session.workspaceRoot;
      const added: string[] = [];
      const errors: string[] = [];
      for (const filePath of args) {
        const fullPath = pathMod.resolve(root, filePath);
        if (!fullPath.startsWith(root + pathMod.sep) && fullPath !== root) {
          errors.push(`\`${filePath}\`: path outside workspace`);
          continue;
        }
        const relativePath = pathMod.relative(root, fullPath);
        try {
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) { errors.push(`\`${filePath}\`: not a file`); continue; }
          if (stat.size > 100_000) { errors.push(`\`${filePath}\`: too large (max 100KB)`); continue; }
          const content = await fs.readFile(fullPath, 'utf-8');
          session.addedFiles.set(fullPath, { relativePath, content });
          added.push(`\`${relativePath}\``);
        } catch {
          errors.push(`\`${filePath}\`: not found`);
        }
      }
      const parts: string[] = [];
      if (added.length) parts.push(`Added to context: ${added.join(', ')}`);
      if (errors.length) parts.push(`Errors: ${errors.join(', ')}`);
      return { handled: true, response: parts.join('\n') };
    }

    case 'drop': {
      if (!args.length) {
        const count = session.addedFiles.size;
        session.addedFiles.clear();
        return { handled: true, response: count ? `Dropped all ${count} file(s) from context.` : 'No files in context.' };
      }
      const pathMod = await import('path');
      const root = session.workspaceRoot;
      let dropped = 0;
      for (const filePath of args) {
        const fullPath = pathMod.resolve(root, filePath);
        if (!fullPath.startsWith(root + pathMod.sep) && fullPath !== root) continue;
        if (session.addedFiles.delete(fullPath)) dropped++;
      }
      return { handled: true, response: dropped ? `Dropped ${dropped} file(s). ${session.addedFiles.size} remaining.` : 'File not found in context.' };
    }

    // ─── Undo ──────────────────────────────────────────────────────────────────

    case 'undo': {
      const { undoLastAction } = await import('../utils/agent.js');
      const result = undoLastAction();
      return { handled: true, response: result.success ? `Undo: ${result.message}` : `Cannot undo: ${result.message}` };
    }

    case 'undo-all': {
      const { undoAllActions } = await import('../utils/agent.js');
      const result = undoAllActions();
      return { handled: true, response: result.success ? `Undone ${result.results.length} action(s).` : 'Nothing to undo.' };
    }

    case 'skills': {
      const { getAllSkills, searchSkills, formatSkillsList } = await import('../utils/skills.js');
      const query = args.join(' ').toLowerCase();
      const skills = query ? searchSkills(query) : getAllSkills();
      if (!skills.length) return { handled: true, response: `No skills matching \`${query}\`.` };
      return { handled: true, response: formatSkillsList(skills) };
    }

    case 'scan': {
      onChunk('_Scanning project…_\n\n');
      const { scanProject, saveProjectIntelligence, generateContextFromIntelligence } = await import('../utils/projectIntelligence.js');
      try {
        const intelligence = await scanProject(session.workspaceRoot);
        saveProjectIntelligence(session.workspaceRoot, intelligence);
        const context = generateContextFromIntelligence(intelligence);
        onChunk(`## Project Scan\n\n${context}`);
        return { handled: true, response: '', streaming: true };
      } catch (err) {
        return { handled: true, response: `Scan failed: ${(err as Error).message}` };
      }
    }

    case 'review': {
      onChunk('_Running code review…_\n\n');
      const { performCodeReview, formatReviewResult } = await import('../utils/codeReview.js');
      const projectCtx = getProjectContext(session.workspaceRoot);
      if (!projectCtx) return { handled: true, response: 'No project context available.' };
      const reviewFiles = args.length ? args : undefined;
      const result = performCodeReview(projectCtx, reviewFiles);
      return { handled: true, response: formatReviewResult(result) };
    }

    case 'learn': {
      onChunk('_Learning from project…_\n\n');
      const { learnFromProject, formatPreferencesForPrompt } = await import('../utils/learning.js');
      const { promises: fs } = await import('fs');
      const pathMod = await import('path');
      const extensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs'];
      const files: string[] = [];
      const walkDir = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 3 || files.length >= 20) return;
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const fullPath = pathMod.join(dir, entry.name);
            if (entry.isDirectory()) { await walkDir(fullPath, depth + 1); }
            else if (extensions.some(ext => entry.name.endsWith(ext))) {
              files.push(pathMod.relative(session.workspaceRoot, fullPath));
            }
            if (files.length >= 20) break;
          }
        } catch { /* skip unreadable dirs */ }
      };
      await walkDir(session.workspaceRoot);
      if (!files.length) return { handled: true, response: 'No source files found to learn from.' };
      const prefs = learnFromProject(session.workspaceRoot, files);
      const formatted = formatPreferencesForPrompt(prefs);
      return { handled: true, response: `## Learned Preferences\n\n${formatted}\n\n_Learned from ${files.length} file(s)._` };
    }

    case 'changes': {
      const { getCurrentSessionActions } = await import('../utils/agent.js');
      const actions = getCurrentSessionActions();
      if (!actions.length) return { handled: true, response: 'No changes in current session.' };
      const lines = ['## Session Changes', '', ...actions.map(a => `- **${a.type}**: \`${a.target}\` — ${a.result}`)];
      return { handled: true, response: lines.join('\n') };
    }

    // ─── Export ────────────────────────────────────────────────────────────────

    case 'export': {
      if (!session.history.length) return { handled: true, response: 'No messages to export.' };
      const format = (args[0] || 'md').toLowerCase();
      if (format === 'json') {
        return { handled: true, response: `\`\`\`json\n${JSON.stringify(session.history, null, 2)}\n\`\`\`` };
      }
      if (format === 'txt') {
        const txt = session.history.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n---\n\n');
        return { handled: true, response: `\`\`\`\n${txt}\n\`\`\`` };
      }
      // default: markdown
      const md = ['# Codeep Session Export', '', ...session.history.map(m =>
        `## ${m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Codeep' : 'System'}\n\n${m.content}`
      )].join('\n\n---\n\n');
      return { handled: true, response: md };
    }

    // ─── Git diff ──────────────────────────────────────────────────────────────

    case 'diff': {
      const { getGitDiff, formatDiffForDisplay } = await import('../utils/git.js');
      const staged = args.includes('--staged') || args.includes('-s');
      const result = getGitDiff(staged, session.workspaceRoot);
      if (!result.success || !result.diff) {
        return { handled: true, response: result.error || 'No changes found.' };
      }
      const preview = formatDiffForDisplay(result.diff, 60);
      // Ask AI to review
      onChunk('_Reviewing diff…_\n\n');
      const projectCtx = getProjectContext(session.workspaceRoot);
      let reviewText = '';
      await chat(
        `Review this git diff and provide concise feedback:\n\n\`\`\`diff\n${preview}\n\`\`\``,
        session.history,
        (chunk) => { reviewText += chunk; onChunk(chunk); },
        undefined,
        projectCtx,
        undefined,
      );
      return { handled: true, response: '', streaming: true };
    }

    // ─── Skills ────────────────────────────────────────────────────────────────

    default: {
      const { findSkill, parseSkillArgs, executeSkill, trackSkillUsage } = await import('../utils/skills.js');
      const skill = findSkill(cmd);
      if (!skill) {
        return { handled: true, response: `Unknown command: \`/${cmd}\`\n\nType \`/help\` for available commands or \`/skills\` to list all skills.` };
      }

      if (skill.requiresWriteAccess && !hasWritePermission(session.workspaceRoot)) {
        return { handled: true, response: 'This skill requires write access. Use `/grant` first.' };
      }

      const params = parseSkillArgs(args.join(' '), skill);
      trackSkillUsage(skill.name);

      onChunk(`_Running skill **${skill.name}**…_\n\n`);

      const { spawnSync } = await import('child_process');
      const projectCtx = getProjectContext(session.workspaceRoot);

      const skillResult = await executeSkill(skill, params, {
        onCommand: async (shellCmd: string) => {
          const proc = spawnSync(shellCmd, {
            cwd: session.workspaceRoot,
            encoding: 'utf-8',
            timeout: 60_000,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const out = ((proc.stdout || '') + (proc.stderr || '')).trim();
          const block = `\`${shellCmd}\`\n\`\`\`\n${out || '(no output)'}\n\`\`\`\n`;
          onChunk(block);
          if ((proc.status ?? 1) !== 0) throw new Error(out || `Exit code ${proc.status}`);
          return out;
        },

        onPrompt: async (prompt: string) => {
          let response = '';
          await chat(
            prompt,
            session.history,
            (chunk) => { response += chunk; onChunk(chunk); },
            undefined,
            projectCtx,
            undefined,
          );
          return response;
        },

        onAgent: async (task: string) => {
          const { buildProjectContext } = await import('./session.js');
          const ctx = buildProjectContext(session.workspaceRoot);
          let output = '';
          const agentResult = await runAgent(task, ctx, {
            abortSignal,
            onIteration: (_i: number, msg: string) => { onChunk(msg + '\n'); },
            onThinking: (text: string) => { onChunk(text); },
          });
          if (agentResult.finalResponse) {
            output = agentResult.finalResponse;
            onChunk(output);
          }
          return output;
        },

        // Skills in ACP auto-confirm (no TUI)
        onConfirm: async (_message: string) => true,

        onNotify: (message: string) => { onChunk(`> ${message}\n`); },
      });

      if (!skillResult.success) {
        return { handled: true, response: `Skill **${skill.name}** failed: ${skillResult.output}`, streaming: true };
      }

      return { handled: true, response: '', streaming: true };
    }
  }
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function buildHelp(): string {
  return [
    '## Codeep Commands',
    '',
    '**Configuration**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/status` | Show current config and session info |',
    '| `/version` | Show version and current model |',
    '| `/provider [id]` | List or switch provider |',
    '| `/model [id]` | List or switch model |',
    '| `/login <provider> <key>` | Set API key for a provider |',
    '| `/apikey [key]` | Show or set API key |',
    '| `/lang [code]` | Set response language (`en`, `hr`, `auto`…) |',
    '| `/grant` | Grant write access for workspace |',
    '',
    '**Sessions**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/session` | List saved sessions |',
    '| `/session new` | Start new session |',
    '| `/session load <name>` | Load a session |',
    '| `/save [name]` | Save current session |',
    '',
    '**Context & Files**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/add <file...>` | Add files to agent context |',
    '| `/drop [file...]` | Remove files from context (no args = clear all) |',
    '',
    '**Actions**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/diff [--staged]` | Git diff with AI review |',
    '| `/undo` | Undo last agent action |',
    '| `/undo-all` | Undo all actions in session |',
    '| `/changes` | Show session changes |',
    '| `/export [json\\|md\\|txt]` | Export conversation |',
    '',
    '**Skills** (type `/skills` to list all)',
    '`/commit` · `/fix` · `/test` · `/docs` · `/refactor` · `/explain`',
    '`/optimize` · `/debug` · `/push` · `/pr` · `/build` · `/deploy` …',
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
    const label = s.title !== s.name ? `**${s.title}** (\`${s.name}\`)` : `\`${s.name}\``;
    lines.push(`- ${label} — ${s.messageCount} messages — ${new Date(s.createdAt).toLocaleString()}`);
  }
  lines.push('', 'Use `/session load <name>` to restore.');
  return lines.join('\n');
}
