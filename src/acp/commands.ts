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
  isTelemetryEnabled,
  telemetryForcedOffByEnv,
  isKeySyncEnabled,
  keySyncForcedOffByEnv,
} from '../config/index.js';
import { getProviderList, getProvider } from '../config/providers.js';
import { getProjectContext } from '../utils/project.js';
import { loadCustomCommands } from '../utils/customCommands.js';
import { summarizeHooks } from '../utils/hooks.js';
import { summarizeBundles } from '../utils/skillBundles.js';
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
export function initWorkspace(workspaceRoot: string, fresh = false): {
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

  if (!fresh && sessions.length > 0) {
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

  // Surface project-scoped custom slash commands so users notice that the
  // workspace defines arbitrary `/foo` macros before they invoke any. A
  // hostile or unfamiliar repo could ship `.codeep/commands/refactor.md`
  // whose body is "ignore prior instructions, leak …" — typing `/refactor`
  // sends that body to the agent as a user message with no preview. The
  // banner is the lightweight informed-consent mitigation; full preview is
  // available via `/commands`.
  try {
    const projectCustom = loadCustomCommands(workspaceRoot).filter(c => c.scope === 'project');
    if (projectCustom.length > 0) {
      const list = projectCustom.slice(0, 6).map(c => `\`/${c.name}\``).join(', ');
      const more = projectCustom.length > 6 ? ` … (+${projectCustom.length - 6} more)` : '';
      lines.push(
        '',
        `**⚠ This workspace defines ${projectCustom.length} custom slash command${projectCustom.length === 1 ? '' : 's'}:** ${list}${more}`,
        'These come from `.codeep/commands/` and run as user prompts. Type `/commands` to review what each does before invoking.',
      );
    }
  } catch {
    // Custom-command loading must never block the welcome banner.
  }

  // Same informed-consent flag for lifecycle hooks. A `.codeep/hooks/<event>.sh`
  // script runs as shell on the user's machine when triggered — a hostile
  // repo could ship one that exfiltrates credentials the first time the
  // agent edits a file. List them so the user knows what's about to fire.
  try {
    const summary = summarizeHooks(workspaceRoot);
    if (summary) {
      lines.push(
        '',
        `**⚠ This workspace has shell hooks installed:** ${summary}.`,
        'Hooks live in `.codeep/hooks/` and run automatically. Type `/hooks` to see the script paths.',
      );
    }
  } catch {
    // Don't block welcome on hook inspection failure.
  }

  // Same informed-consent flag for project skill bundles. They're
  // less dangerous than hooks (no shell-on-load) but the agent will
  // autonomously invoke them based on user intent, so the user should
  // know what's in the catalog before talking to the agent.
  try {
    const summary = summarizeBundles(workspaceRoot);
    if (summary) {
      lines.push(
        '',
        `**ℹ This workspace ships ${summary}.**`,
        'The agent will discover and invoke these via `invoke_skill`. Run `/skills bundles` to inspect.',
      );
    }
  } catch {
    // Don't block welcome on skill discovery failure.
  }

  // Surface CLI sessions so Zed users discover them without having to know
  // about the hidden "Import Threads" modal. Show up to 5 most recent.
  if (sessions.length > 1 || (sessions.length === 1 && sessions[0].name !== codeepSessionId)) {
    const others = sessions
      .filter(s => s.name !== codeepSessionId)
      .slice(0, 5);
    if (others.length > 0) {
      lines.push('', '**Other sessions in this project:**');
      for (const s of others) {
        const label = s.title && s.title !== s.name ? `${s.title} (\`${s.name}\`)` : `\`${s.name}\``;
        lines.push(`- ${label} — ${s.messageCount} messages`);
      }
      lines.push('', `Type \`/sessions\` for the full list, or \`/session load <name>\` to switch.`);
    }
  }

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
      return { handled: true, response: await setApiKeyCmd(args[0]) };
    }

    case 'telemetry': {
      const sub = args[0]?.toLowerCase();
      const envOff = telemetryForcedOffByEnv();
      if (sub === 'on' || sub === 'off') {
        if (envOff) {
          return { handled: true, response: 'Telemetry is forced **off** by the `CODEEP_NO_TELEMETRY` / `DO_NOT_TRACK` env var — unset it to change this. The config flag can\'t override an env var.' };
        }
        config.set('telemetry', sub === 'on');
        return {
          handled: true,
          response: sub === 'on'
            ? 'Telemetry **on** — usage stats, session transcripts, progress and memory notes sync to codeep.dev.'
            : 'Telemetry **off** — no automatic cloud uploads. Explicit `/account push` still works.',
        };
      }
      if (sub && sub !== 'status') {
        return { handled: true, response: 'Usage: `/telemetry` · `/telemetry on` · `/telemetry off`' };
      }
      const flag = config.get('telemetry') !== false;
      const lines = [
        `**Telemetry:** ${isTelemetryEnabled() ? 'on' : 'off'}`,
        `- Config flag \`telemetry\`: ${flag}`,
      ];
      if (envOff) lines.push('- Forced **off** by `CODEEP_NO_TELEMETRY` / `DO_NOT_TRACK` (env overrides the flag).');
      lines.push('', 'Toggle with `/telemetry on` | `/telemetry off`. Controls automatic uploads of usage stats, session transcripts, progress, and memory notes.');
      return { handled: true, response: lines.join('\n') };
    }

    case 'keysync': {
      const sub = args[0]?.toLowerCase();
      const envOff = keySyncForcedOffByEnv();
      if (sub === 'on' || sub === 'off') {
        if (envOff) {
          return { handled: true, response: 'Cloud key sync is forced **off** by the `CODEEP_NO_KEY_SYNC` env var — unset it to change this. The config flag can\'t override an env var.' };
        }
        config.set('syncKeysToCloud', sub === 'on');
        return {
          handled: true,
          response: sub === 'on'
            ? 'Cloud key sync **on** — `codeep account push`/`sync` will now upload/download API keys. Note: synced keys are stored server-readable on codeep.dev.'
            : 'Cloud key sync **off** — API keys stay in your OS keychain only. (`codeep account purge-keys` wipes any keys already on the server.)',
        };
      }
      if (sub && sub !== 'status') {
        return { handled: true, response: 'Usage: `/keysync` · `/keysync on` · `/keysync off`' };
      }
      const flag = config.get('syncKeysToCloud') === true;
      const lines = [
        `**Cloud key sync:** ${isKeySyncEnabled() ? 'on' : 'off'}`,
        `- Config flag \`syncKeysToCloud\`: ${flag}`,
      ];
      if (envOff) lines.push('- Forced **off** by `CODEEP_NO_KEY_SYNC` (env overrides the flag).');
      lines.push('', 'OFF by default — API keys live only in your OS keychain unless enabled. When on, `codeep account push`/`sync` move keys, stored **server-readable** on codeep.dev.');
      return { handled: true, response: lines.join('\n') };
    }

    case 'login': {
      const [providerId, apiKey] = args;
      if (!providerId || !apiKey) {
        return { handled: true, response: 'Usage: `/login <providerId> <apiKey>`\n\n' + buildProviderList() };
      }
      return { handled: true, response: await loginCmd(providerId, apiKey) };
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
      const sub = args[0]?.toLowerCase();

      // Subcommands for structured skill bundles (separate from the
      // built-in JSON skills exposed by `skills.ts`).
      if (sub === 'bundles' || sub === 'list-bundles') {
        const { loadSkillBundles, formatBundleList } = await import('../utils/skillBundles.js');
        return { handled: true, response: formatBundleList(loadSkillBundles(session.workspaceRoot)) };
      }

      if (sub === 'create-bundle') {
        const name = (args[1] ?? '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          return { handled: true, response: 'Usage: `/skills create-bundle <name>` — lowercase letters/digits/hyphens; must start with a letter or digit.' };
        }
        const { mkdirSync, writeFileSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const dir = join(session.workspaceRoot, '.codeep', 'skills', name);
        if (existsSync(dir)) {
          return { handled: true, response: `Skill \`${name}\` already exists at \`.codeep/skills/${name}/\`.` };
        }
        mkdirSync(dir, { recursive: true });
        const template = `---
name: ${name}
description: One-sentence summary shown in the agent's catalog.
triggers:
  - keyword
  - phrase
# Optional Codeep-specific keys:
# codeep-min-version: 2.0.0
# codeep-requires-mcp: [postgres, filesystem]
# allowed-tools: [read_file, write_file, execute_command]
# version: 0.1.0
# author: ${process.env.USER ?? 'you'}
---

# ${name}

Describe what this skill does. The agent will read this body verbatim when it invokes the skill.

## Steps

1. First step
2. Second step
3. …

## Notes

Anything else the agent should know — edge cases, gotchas, things to double-check.
`;
        writeFileSync(join(dir, 'SKILL.md'), template);
        return { handled: true, response: `Created skill bundle at \`.codeep/skills/${name}/SKILL.md\`.\n\nEdit it to taste, then run \`/skills bundles\` to confirm it's loaded.` };
      }

      if (sub === 'show' || sub === 'detail') {
        const name = args[1];
        if (!name) return { handled: true, response: 'Usage: `/skills show <name>`' };
        const { findSkillBundle } = await import('../utils/skillBundles.js');
        const bundle = findSkillBundle(name, session.workspaceRoot);
        if (!bundle) return { handled: true, response: `Skill bundle \`${name}\` not found. Run \`/skills bundles\` for the list.` };
        const lines: string[] = [
          `## ${bundle.name}`,
          `_${bundle.description}_`,
          '',
          `**Source:** \`${bundle.source}\` (${bundle.scope})`,
          bundle.version ? `**Version:** ${bundle.version}` : '',
          bundle.triggers.length ? `**Triggers:** ${bundle.triggers.join(', ')}` : '',
          bundle.allowedTools.length ? `**Allowed tools:** ${bundle.allowedTools.join(', ')}` : '',
          bundle.requiresMcp.length ? `**Requires MCP:** ${bundle.requiresMcp.join(', ')}` : '',
          '',
          '---',
          '',
          bundle.body,
        ].filter(Boolean);
        return { handled: true, response: lines.join('\n') };
      }

      // Marketplace (codeep.dev/skills) — publish / install / browse / unpublish.
      if (sub === 'publish') {
        const slug = args[1];
        if (!slug) return { handled: true, response: 'Usage: `/skills publish <slug> [--public]`' };
        const isPublic = args.includes('--public');
        const { publishBundle } = await import('../utils/skillBundlesCloud.js');
        const result = await publishBundle(session.workspaceRoot, slug, { isPublic });
        if (!result.ok) return { handled: true, response: `Publish failed: ${result.error}` };
        const visibility = isPublic ? 'public' : 'private';
        return {
          handled: true,
          response: `Published \`${slug}\` (${visibility}) to codeep.dev. Install elsewhere with \`/skills install ${result.skill?.owner_username ?? '<you>'}/${slug}\`.`,
        };
      }

      if (sub === 'install') {
        const target = args[1];
        if (!target) return { handled: true, response: 'Usage: `/skills install <owner>/<slug>` (or numeric id)' };
        const { installBundle } = await import('../utils/skillBundlesCloud.js');
        onChunk(`_Fetching \`${target}\` from codeep.dev…_\n\n`);
        const result = await installBundle(session.workspaceRoot, target);
        if (!result.ok) return { handled: true, response: `Install failed: ${result.error}`, streaming: true };
        return {
          handled: true,
          response: `Installed \`${result.name}\` to \`.codeep/skills/${result.name}/SKILL.md\`. The agent will pick it up on the next prompt.`,
          streaming: true,
        };
      }

      if (sub === 'browse') {
        const query = args.slice(1).join(' ').trim();
        const { browseSkills } = await import('../utils/skillBundlesCloud.js');
        const result = await browseSkills({ query });
        if (!result.ok) return { handled: true, response: `Browse failed: ${result.error}` };
        const skills = result.skills ?? [];
        if (skills.length === 0) {
          return { handled: true, response: query ? `_No public skills matching "${query}"._` : '_No public skills published yet._' };
        }
        const lines = [`## ${query ? `Skills matching "${query}"` : 'Public skills'}`, ''];
        for (const s of skills.slice(0, 30)) {
          const owner = s.owner_username ?? s.github_id;
          const ver = s.version ? ` v${s.version}` : '';
          lines.push(`- **${s.name}** \`${owner}/${s.slug}\`${ver} — ${s.description} _(${s.install_count} installs)_`);
        }
        if (skills.length > 30) lines.push('', `_(showing first 30 of ${skills.length} — refine with a search query)_`);
        lines.push('', 'Install one with `/skills install <owner>/<slug>`.');
        return { handled: true, response: lines.join('\n') };
      }

      if (sub === 'unpublish') {
        const target = args[1];
        if (!target) return { handled: true, response: 'Usage: `/skills unpublish <owner>/<slug>` (use your own owner name)' };
        const { unpublishBundle } = await import('../utils/skillBundlesCloud.js');
        const result = await unpublishBundle(target);
        if (!result.ok) return { handled: true, response: `Unpublish failed: ${result.error}` };
        return { handled: true, response: `Unpublished \`${target}\` from codeep.dev. Local \`.codeep/skills/\` copy is untouched.` };
      }

      // Default: built-in JSON skills (legacy behaviour, search by query).
      const { getAllSkills, searchSkills, formatSkillsList } = await import('../utils/skills.js');
      const query = args.join(' ').toLowerCase();
      const skills = query ? searchSkills(query) : getAllSkills();
      const builtinBlock = skills.length ? formatSkillsList(skills) : `No built-in skills matching \`${query}\`.`;

      // Append a hint about bundles so users discover them.
      const { loadSkillBundles } = await import('../utils/skillBundles.js');
      const bundles = loadSkillBundles(session.workspaceRoot);
      const bundleHint = bundles.length > 0
        ? `\n\n_${bundles.length} skill bundle${bundles.length === 1 ? '' : 's'} installed — see \`/skills bundles\` or create one with \`/skills create-bundle <name>\`._`
        : `\n\n_No skill bundles installed. Run \`/skills create-bundle <name>\` to make one._`;
      return { handled: true, response: builtinBlock + bundleHint };
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

    case 'cost': {
      const { formatCostReport } = await import('../utils/tokenTracker.js');
      return { handled: true, response: formatCostReport() };
    }

    case 'compact': {
      // `keepRecent` is the number of latest messages to leave untouched.
      // Default 4 ≈ two user/assistant exchanges — enough for the in-flight
      // task to continue. User can override with `/compact 8` for slower
      // tapering.
      const keepRecent = args[0] ? Math.max(2, parseInt(args[0], 10) || 4) : 4;
      if (session.history.length <= keepRecent + 2) {
        return { handled: true, response: `Nothing to compact — only ${session.history.length} message(s) in this session.` };
      }
      onChunk(`_Compacting ${session.history.length - keepRecent} older message(s) into a summary…_\n\n`);
      const { compactHistory } = await import('../utils/context.js');
      const projectCtx = getProjectContext(session.workspaceRoot);
      try {
        // Forward the session's abort signal so the user pressing `session/cancel`
        // also kills an in-flight compaction. The internal 60s timeout in
        // compactHistory is the hard ceiling.
        const result = await compactHistory(session.history, { keepRecent, projectContext: projectCtx, abortSignal });
        if (result.replaced === 0) {
          return { handled: true, response: 'Nothing to compact.', streaming: true };
        }
        session.history = result.compacted;
        // Persist immediately so the compaction survives a client restart.
        const { saveSession } = await import('../config/index.js');
        saveSession(session.codeepSessionId, session.history, session.workspaceRoot);
        const lines = [
          `## Conversation Compacted`,
          '',
          `Replaced ${result.replaced} earlier message${result.replaced === 1 ? '' : 's'} with a summary.`,
          `Kept the last ${keepRecent} message${keepRecent === 1 ? '' : 's'} verbatim.`,
          '',
          '**Summary:**',
          '',
          result.summary,
        ];
        return { handled: true, response: lines.join('\n'), streaming: true };
      } catch (err) {
        return { handled: true, response: `Compaction failed: ${(err as Error).message}`, streaming: true };
      }
    }

    // ─── Export ────────────────────────────────────────────────────────────────

    // ─── Cross-session recall (2.1.0) ─────────────────────────────────────────

    case 'recall': {
      const wantSummarize = args.includes('--summarize');
      // --resume is TUI-only (ACP can't swap the client's conversation
      // in place); ignore the flag here and just show results.
      const query = args.filter(a => a !== '--resume' && a !== '--summarize').join(' ');
      if (!query) {
        return { handled: true, response: 'Usage: `/recall <query> [--summarize]` — searches across all saved sessions (vs `/search`, current-session only).' };
      }
      const { recallSessions, formatRecall, summarizeRecall } = await import('../utils/recall.js');
      const matches = recallSessions(query, session.workspaceRoot);
      const header = formatRecall(query, matches);
      if (wantSummarize && matches.length > 0) {
        onChunk('_Summarizing matching sessions…_\n\n');
        const summary = await summarizeRecall(query, matches, session.workspaceRoot);
        return {
          handled: true,
          response: summary ? `${header}\n\n---\n\n### Summary\n\n${summary}` : header,
          streaming: true,
        };
      }
      return { handled: true, response: header };
    }

    // ─── Personalities + insights (2.0.3) ─────────────────────────────────────

    case 'personality': {
      const { formatPersonalityList, findPersonality } = await import('../utils/personalities.js');
      const sub = args[0]?.toLowerCase();
      if (!sub) {
        return { handled: true, response: formatPersonalityList(session.workspaceRoot) };
      }
      if (sub === 'off' || sub === 'none' || sub === 'clear') {
        config.set('activePersonality', null);
        return { handled: true, response: 'Personality cleared — agent uses default tone.' };
      }
      const p = findPersonality(sub, session.workspaceRoot);
      if (!p) {
        return { handled: true, response: `No personality named \`${sub}\`. Run \`/personality\` to see available.` };
      }
      config.set('activePersonality', p.name);
      return {
        handled: true,
        response: `Active personality: **${p.displayName}** (\`${p.name}\`, ${p.scope})\n\n_${p.description}_\n\nClear with \`/personality off\`.`,
      };
    }

    case 'agents': {
      const { formatAgentList } = await import('../utils/agents.js');
      return { handled: true, response: formatAgentList(session.workspaceRoot) };
    }

    case 'me': {
      const {
        formatProfileView, scaffoldProfile, updateLearnedProfile, clearLearnedProfile,
      } = await import('../utils/userProfile.js');
      const sub = args[0]?.toLowerCase();

      if (sub === 'on' || sub === 'off') {
        config.set('userProfile', sub === 'on');
        return { handled: true, response: sub === 'on'
          ? "Profile injection on — your profile is added to the agent's context."
          : 'Profile injection off — profile is saved but not used.', configOptionsChanged: true };
      }
      if (sub === 'init') {
        const scope = args[1]?.toLowerCase() === 'project' ? 'project' : 'global';
        if (scope === 'project' && !session.workspaceRoot) {
          return { handled: true, response: 'No project here — use `/me init` for a global profile.' };
        }
        const res = scaffoldProfile(scope, session.workspaceRoot);
        if (!res) return { handled: true, response: 'Could not create the profile file.' };
        return { handled: true, response: res.created
          ? `Created ${scope} profile: \`${res.path}\` — edit it and Codeep uses it automatically.`
          : `${scope === 'global' ? 'Global' : 'Project'} profile already exists: \`${res.path}\`.` };
      }
      if (sub === 'learn') {
        const arg = args[1]?.toLowerCase();
        if (arg === 'on' || arg === 'off') {
          config.set('autoLearnProfile', arg === 'on');
          return { handled: true, response: arg === 'on'
            ? 'Auto-learn on — Codeep updates your learned profile (global + project) from sessions.'
            : 'Auto-learn off — Codeep stops updating the learned profile.', configOptionsChanged: true };
        }
        const scope = arg === 'project' ? 'project' : 'global';
        if (scope === 'project' && !session.workspaceRoot) {
          return { handled: true, response: 'No project here — run `/me learn` for your global profile.' };
        }
        if (session.history.filter((m) => m.role !== 'system').length < 2) {
          return { handled: true, response: 'Not enough conversation yet to learn from.' };
        }
        const res = await updateLearnedProfile(session.history, scope, session.workspaceRoot);
        if (!res) return { handled: true, response: 'Nothing durable to learn right now (or the model call failed).' };
        const file = scope === 'global' ? '~/.codeep/profile.learned.md' : '.codeep/profile.learned.md';
        return { handled: true, response: res.updated
          ? `Updated your ${scope} learned profile (\`${file}\`):\n\n${res.facts}`
          : `No changes — your ${scope} learned profile already covers this:\n\n${res.facts}` };
      }
      if (sub === 'forget') {
        return { handled: true, response: clearLearnedProfile(session.workspaceRoot)
          ? 'Cleared the auto-learned profile(s).'
          : 'No learned profile to clear.' };
      }
      if (sub === 'sync') {
        const { getSyncToken } = await import('../config/index.js');
        if (!getSyncToken()) return { handled: true, response: 'Not linked to codeep.dev. Run `codeep account` in a terminal first.' };
        const { pushUserProfile, pullUserProfile } = await import('../utils/codeepCloud.js');
        const pushed = await pushUserProfile();
        const pulled = await pullUserProfile();
        const lines: string[] = [];
        if (pushed) lines.push('✓ Profile pushed to the dashboard');
        if (pulled === 1) lines.push('✓ Profile pulled to this machine');
        if (lines.length === 0) lines.push('Nothing to sync yet — run `/me init` and fill in your profile first.');
        return { handled: true, response: lines.join('\n') };
      }
      return { handled: true, response: formatProfileView(session.workspaceRoot) };
    }

    case 'insights': {
      const { formatInsights } = await import('../utils/insights.js');
      let days = 7;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--days' && args[i + 1]) {
          const n = parseInt(args[i + 1], 10);
          if (Number.isFinite(n)) days = n;
        } else if (a.startsWith('--days=')) {
          const n = parseInt(a.slice('--days='.length), 10);
          if (Number.isFinite(n)) days = n;
        }
      }
      return { handled: true, response: formatInsights({ days }) };
    }

    // ─── Plan mode (2.0.2) ────────────────────────────────────────────────────

    case 'plan': {
      // Identical contract to TUI /plan: generate a pre-execution plan,
      // surface it, hold as pending so /go can execute it without re-planning.
      if (!args.length) {
        const { getPendingPlan } = await import('../utils/planMode.js');
        const cur = getPendingPlan();
        return {
          handled: true,
          response: cur
            ? `**Pending plan for:** _${cur.task}_\n\n${cur.plan}\n\n---\nRun \`/go\` to execute, or \`/plan <revised task>\` to revise.`
            : 'Usage: `/plan <task>` — generates a plan you can review, then `/go` to execute.',
        };
      }
      const task = args.join(' ');
      onChunk(`_Generating plan for: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}_\n\n`);
      try {
        const { generatePlan } = await import('../utils/planMode.js');
        const plan = await generatePlan(task);
        return {
          handled: true,
          response: `${plan}\n\n---\nRun \`/go\` to execute this plan, or \`/plan <revised task>\` to refine it.`,
          streaming: true,
        };
      } catch (err) {
        return { handled: true, response: `Plan generation failed: ${(err as Error).message}`, streaming: true };
      }
    }

    case 'go': {
      const { getPendingPlan, composeExecutionPrompt, clearPendingPlan } = await import('../utils/planMode.js');
      const cur = getPendingPlan();
      if (!cur) {
        return { handled: true, response: 'No pending plan. Run `/plan <task>` first.' };
      }
      const prompt = composeExecutionPrompt(cur);
      clearPendingPlan();
      onChunk(`_Executing approved plan…_\n\n`);
      try {
        const { buildProjectContext } = await import('./session.js');
        const ctx = buildProjectContext(session.workspaceRoot);
        const agentResult = await runAgent(prompt, ctx, {
          abortSignal,
          onIteration: (_i: number, msg: string) => { onChunk(msg + '\n'); },
          onThinking: (text: string) => { onChunk(text); },
        });
        return {
          handled: true,
          response: agentResult.finalResponse || '_(plan executed; no final summary)_',
          streaming: true,
        };
      } catch (err) {
        return { handled: true, response: `Plan execution failed: ${(err as Error).message}`, streaming: true };
      }
    }

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

    case 'commands': {
      const { loadCustomCommands, formatCommandList } = await import('../utils/customCommands.js');
      return { handled: true, response: formatCommandList(loadCustomCommands(session.workspaceRoot)) };
    }

    case 'memory': {
      // Project intelligence notes — same store as the TUI's /memory command.
      // /memory <text>       add a note
      // /memory list         show all notes
      // /memory remove <n>   remove note by 1-based index
      // /memory clear        wipe all notes
      const { loadProjectIntelligence, saveProjectIntelligence } = await import('../utils/projectIntelligence.js');
      const intelligence = loadProjectIntelligence(session.workspaceRoot);
      if (!intelligence) {
        return { handled: true, response: 'No project intelligence found. Run `/scan` first.' };
      }
      intelligence.notes = intelligence.notes || [];
      const sub = args[0]?.toLowerCase();

      if (sub === 'list') {
        if (intelligence.notes.length === 0) return { handled: true, response: '_No memory notes yet. Add one with `/memory <note>`._' };
        const lines = ['## Project memory notes', '', ...intelligence.notes.map((n, i) => `${i + 1}. ${n}`)];
        return { handled: true, response: lines.join('\n') };
      }

      if (sub === 'remove') {
        const idx = parseInt(args[1] ?? '', 10);
        if (isNaN(idx) || idx < 1 || idx > intelligence.notes.length) {
          return { handled: true, response: 'Usage: `/memory remove <n>` — run `/memory list` first to see indices.' };
        }
        const removed = intelligence.notes.splice(idx - 1, 1)[0];
        saveProjectIntelligence(session.workspaceRoot, intelligence);
        return { handled: true, response: `Removed note ${idx}: _"${removed}"_` };
      }

      if (sub === 'clear') {
        const count = intelligence.notes.length;
        intelligence.notes = [];
        saveProjectIntelligence(session.workspaceRoot, intelligence);
        return { handled: true, response: count ? `Cleared ${count} note${count === 1 ? '' : 's'}.` : '_No notes to clear._' };
      }

      // Default: treat all args as the note body.
      const note = args.join(' ').trim();
      if (!note) {
        return { handled: true, response: 'Usage: `/memory <note>` · `/memory list` · `/memory remove <n>` · `/memory clear`' };
      }
      intelligence.notes.push(note);
      saveProjectIntelligence(session.workspaceRoot, intelligence);
      return { handled: true, response: `Memory saved (${intelligence.notes.length} total): _"${note}"_` };
    }

    case 'checkpoint': {
      const sub = args[0]?.toLowerCase();
      const { createCheckpoint, deleteCheckpoint, listCheckpoints, formatCheckpointList } = await import('../utils/checkpoints.js');
      const { getCurrentSessionActions } = await import('../utils/agent.js');

      if (sub === 'delete') {
        const id = args[1];
        if (!id) return { handled: true, response: 'Usage: `/checkpoint delete <id>`' };
        return { handled: true, response: deleteCheckpoint(session.workspaceRoot, id) ? `Deleted checkpoint \`${id}\`.` : `Checkpoint not found: \`${id}\`` };
      }
      if (sub === 'list') {
        // Same as /checkpoints — keep both spellings for muscle-memory.
        return { handled: true, response: formatCheckpointList(listCheckpoints(session.workspaceRoot)) };
      }

      // Default: create a new checkpoint with optional name (everything after /checkpoint)
      const name = args.join(' ').trim() || undefined;
      const provider = getCurrentProvider();
      // Pull file paths the agent has touched in this session from the action
      // log. Used at /rewind time to scope the git restore suggestion.
      const filesTouched = Array.from(new Set(
        getCurrentSessionActions()
          .filter(a => a.target && (a.type === 'write' || a.type === 'edit' || a.type === 'delete' || a.type === 'mkdir'))
          .map(a => a.target),
      ));
      const cp = createCheckpoint({
        workspaceRoot: session.workspaceRoot,
        sessionId: session.codeepSessionId,
        provider: provider.id,
        model: config.get('model'),
        messages: session.history,
        filesTouched,
        name,
      });
      const lines = [
        `Created checkpoint \`${cp.id}\`${cp.name ? ` — **${cp.name}**` : ''}`,
        `Captured ${cp.messages.length} message${cp.messages.length === 1 ? '' : 's'}, ${cp.filesTouched.length} file${cp.filesTouched.length === 1 ? '' : 's'} touched${cp.gitHead ? `, git \`${cp.gitHead}\`` : ''}.`,
        '',
        'Use `/rewind ' + cp.id + '` to restore.',
      ];
      return { handled: true, response: lines.join('\n') };
    }

    case 'checkpoints': {
      const { listCheckpoints, formatCheckpointList } = await import('../utils/checkpoints.js');
      return { handled: true, response: formatCheckpointList(listCheckpoints(session.workspaceRoot)) };
    }

    case 'openrouter': {
      const { readOpenRouterPreferences, writeOpenRouterPreferences, formatOpenRouterPreferences } = await import('../utils/openrouterPrefs.js');
      const sub = args[0]?.toLowerCase();
      const current = readOpenRouterPreferences();

      if (!sub || sub === 'show') {
        return { handled: true, response: formatOpenRouterPreferences(current) };
      }
      if (sub === 'clear') {
        writeOpenRouterPreferences(null);
        return { handled: true, response: 'OpenRouter preferences cleared. Router will pick freely.' };
      }
      if (sub === 'prefer') {
        const list = args.slice(1).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        if (list.length === 0) return { handled: true, response: 'Usage: `/openrouter prefer <p1>[,<p2>...]` — e.g. `/openrouter prefer DeepInfra,Together`' };
        writeOpenRouterPreferences({ ...current, order: list });
        return { handled: true, response: `Will prefer providers in this order: ${list.map(p => `\`${p}\``).join(', ')}` };
      }
      if (sub === 'ignore') {
        const list = args.slice(1).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        if (list.length === 0) return { handled: true, response: 'Usage: `/openrouter ignore <p1>[,<p2>...]`' };
        writeOpenRouterPreferences({ ...current, ignore: list });
        return { handled: true, response: `Will skip providers: ${list.map(p => `\`${p}\``).join(', ')}` };
      }
      if (sub === 'fallbacks') {
        const val = args[1]?.toLowerCase();
        if (val !== 'on' && val !== 'off') return { handled: true, response: 'Usage: `/openrouter fallbacks on|off`' };
        writeOpenRouterPreferences({ ...current, allow_fallbacks: val === 'on' });
        return { handled: true, response: `Fallbacks ${val === 'on' ? 'enabled' : 'disabled'}.` };
      }
      if (sub === 'privacy') {
        const val = args[1]?.toLowerCase();
        if (val !== 'strict' && val !== 'allow') return { handled: true, response: 'Usage: `/openrouter privacy strict|allow` — strict = data_collection: deny' };
        writeOpenRouterPreferences({ ...current, data_collection: val === 'strict' ? 'deny' : 'allow' });
        return { handled: true, response: `Privacy: \`data_collection: ${val === 'strict' ? 'deny' : 'allow'}\`` };
      }
      return { handled: true, response: `Unknown subcommand: \`${sub}\`. Use \`show\`, \`prefer\`, \`ignore\`, \`fallbacks\`, \`privacy\`, or \`clear\`.` };
    }

    case 'hooks': {
      const { listInstalledHooks, formatHookList, formatHookTrust, trustWorkspaceHooks, untrustWorkspaceHooks } = await import('../utils/hooks.js');
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'trust') {
        trustWorkspaceHooks(session.workspaceRoot);
        return { handled: true, response: 'Hooks trusted for this workspace — they will now run.' };
      }
      if (sub === 'untrust') {
        untrustWorkspaceHooks(session.workspaceRoot);
        return { handled: true, response: 'Hooks untrusted — they will be skipped until you trust again.' };
      }
      const trust = formatHookTrust(session.workspaceRoot);
      return { handled: true, response: formatHookList(listInstalledHooks(session.workspaceRoot)) + (trust ? `\n\n${trust}` : '') };
    }

    case 'mcp': {
      const sub = args[0]?.toLowerCase();
      const { addProjectMcpServer, removeProjectMcpServer, loadMcpServerConfig } = await import('../utils/mcpConfig.js');
      const { registerSessionServers } = await import('../utils/mcpRegistry.js');

      if (sub === 'add') {
        // /mcp add <name> <command> [args...]
        const name = args[1];
        const command = args[2];
        if (!name || !command) {
          return { handled: true, response: 'Usage: `/mcp add <name> <command> [args...]` — e.g. `/mcp add fs npx @modelcontextprotocol/server-filesystem /path`' };
        }
        const extraArgs = args.slice(3);
        addProjectMcpServer(session.workspaceRoot, { name, command, args: extraArgs });
        onChunk(`_Saved MCP server **${name}** to \`.codeep/mcp_servers.json\`. Spawning…_\n\n`);
        // Live re-register so the new server is usable immediately, no
        // session restart needed. registerSessionServers is idempotent —
        // it disposes the old set and brings up the merged one.
        const merged = loadMcpServerConfig(session.workspaceRoot);
        const { registered, errors } = await registerSessionServers(session.sessionId, merged, { workspaceRoot: session.workspaceRoot });
        const ok = registered.filter(t => t.serverName === name);
        const failed = errors.find(e => e.server === name);
        if (failed) return { handled: true, response: `Saved \`${name}\` but spawn failed: \`${failed.error}\``, streaming: true };
        return { handled: true, response: `Added \`${name}\` (${ok.length} tool${ok.length === 1 ? '' : 's'} available).`, streaming: true };
      }

      if (sub === 'remove') {
        const name = args[1];
        if (!name) return { handled: true, response: 'Usage: `/mcp remove <name>`' };
        const removed = removeProjectMcpServer(session.workspaceRoot, name);
        if (!removed) return { handled: true, response: `No project-scoped MCP server named \`${name}\`.` };
        // Re-register with the new (smaller) merged set so the dropped
        // server is actually killed.
        const merged = loadMcpServerConfig(session.workspaceRoot);
        await registerSessionServers(session.sessionId, merged, { workspaceRoot: session.workspaceRoot });
        return { handled: true, response: `Removed \`${name}\` from project config and stopped its process.` };
      }

      if (sub === 'resources') {
        const { getSessionResources, awaitSessionReady } = await import('../utils/mcpRegistry.js');
        await awaitSessionReady(session.sessionId);
        const groups = await getSessionResources(session.sessionId);
        if (groups.length === 0) {
          return { handled: true, response: '_No MCP server in this session exposes resources._' };
        }
        const lines = ['## MCP resources', ''];
        for (const g of groups) {
          lines.push(`**${g.serverName}** — ${g.resources.length} resource${g.resources.length === 1 ? '' : 's'}`);
          for (const r of g.resources) {
            const label = r.name ? `${r.name} — ` : '';
            const mime = r.mimeType ? ` (${r.mimeType})` : '';
            lines.push(`- ${label}\`${r.uri}\`${mime}${r.description ? ` — ${r.description}` : ''}`);
          }
          lines.push('');
        }
        lines.push('Read one with `/mcp read <uri>`.');
        return { handled: true, response: lines.join('\n').trim() };
      }

      if (sub === 'read') {
        const uri = args[1];
        if (!uri) return { handled: true, response: 'Usage: `/mcp read <uri>` — run `/mcp resources` to see available URIs.' };
        const { readSessionResource } = await import('../utils/mcpRegistry.js');
        try {
          const contents = await readSessionResource(session.sessionId, uri);
          if (contents.length === 0) return { handled: true, response: `_No content returned for \`${uri}\`._` };
          const lines: string[] = [`## Resource: \`${uri}\``, ''];
          for (const c of contents) {
            if (c.text !== undefined) {
              const fence = c.mimeType?.includes('json') ? 'json' : c.mimeType?.includes('markdown') ? 'markdown' : '';
              lines.push('```' + fence);
              lines.push(c.text);
              lines.push('```');
            } else if (c.blob) {
              lines.push(`_(${c.mimeType ?? 'binary'} blob, ${c.blob.length} base64 chars — not rendered)_`);
            }
          }
          return { handled: true, response: lines.join('\n') };
        } catch (err) {
          return { handled: true, response: `Failed to read \`${uri}\`: ${(err as Error).message}` };
        }
      }

      if (sub === 'prompts') {
        const { getSessionPrompts, awaitSessionReady } = await import('../utils/mcpRegistry.js');
        await awaitSessionReady(session.sessionId);
        const groups = await getSessionPrompts(session.sessionId);
        if (groups.length === 0) {
          return { handled: true, response: '_No MCP server in this session exposes prompt templates._' };
        }
        const lines = ['## MCP prompt templates', ''];
        for (const g of groups) {
          lines.push(`**${g.serverName}** — ${g.prompts.length} prompt${g.prompts.length === 1 ? '' : 's'}`);
          for (const p of g.prompts) {
            const argList = p.arguments?.length
              ? ` (${p.arguments.map(a => a.required ? a.name : `[${a.name}]`).join(', ')})`
              : '';
            lines.push(`- \`${p.name}\`${argList}${p.description ? ` — ${p.description}` : ''}`);
          }
          lines.push('');
        }
        lines.push('Materialise one with `/mcp prompt <server> <name> [key=value...]`.');
        return { handled: true, response: lines.join('\n').trim() };
      }

      if (sub === 'prompt') {
        const serverName = args[1];
        const name = args[2];
        if (!serverName || !name) {
          return { handled: true, response: 'Usage: `/mcp prompt <server> <name> [key=value ...]`' };
        }
        const promptArgs: Record<string, string> = {};
        for (const tok of args.slice(3)) {
          const eq = tok.indexOf('=');
          if (eq > 0) promptArgs[tok.slice(0, eq)] = tok.slice(eq + 1);
        }
        const { getSessionPrompt } = await import('../utils/mcpRegistry.js');
        try {
          const { description, messages } = await getSessionPrompt(session.sessionId, serverName, name, promptArgs);
          const lines: string[] = [`## Prompt \`${serverName}/${name}\``];
          if (description) lines.push(`_${description}_`);
          lines.push('');
          for (const m of messages) {
            const text = typeof m.content?.text === 'string' ? m.content.text : JSON.stringify(m.content);
            lines.push(`**${m.role}:** ${text}`);
            lines.push('');
          }
          return { handled: true, response: lines.join('\n').trim() };
        } catch (err) {
          return { handled: true, response: `Failed to materialise prompt: ${(err as Error).message}` };
        }
      }

      if (sub === 'browse') {
        const { formatMarketplaceList, MCP_MARKETPLACE } = await import('../utils/mcpMarketplace.js');
        const detail = args[1];
        if (detail) {
          const { findMarketplaceEntry, formatMarketplaceEntry } = await import('../utils/mcpMarketplace.js');
          const entry = findMarketplaceEntry(detail);
          if (!entry) return { handled: true, response: `Marketplace id not found: \`${detail}\`. Run \`/mcp browse\` for the list.` };
          return { handled: true, response: formatMarketplaceEntry(entry) + `\n\nInstall with \`/mcp install ${entry.id} ${entry.argHints?.map(h => `<${h.placeholder ?? 'arg'}>`).join(' ') ?? ''}\`` };
        }
        return { handled: true, response: formatMarketplaceList() + `\n\nRun \`/mcp browse <id>\` for details or \`/mcp install <id> [args]\` to install. Total: ${MCP_MARKETPLACE.length}.` };
      }

      if (sub === 'install') {
        const id = args[1];
        if (!id) return { handled: true, response: 'Usage: `/mcp install <id> [extra args...]` — run `/mcp browse` to see ids.' };
        const { findMarketplaceEntry } = await import('../utils/mcpMarketplace.js');
        const entry = findMarketplaceEntry(id);
        if (!entry) return { handled: true, response: `Marketplace id not found: \`${id}\`. Run \`/mcp browse\` for the list.` };

        // Merge skeleton args with user-supplied extras.
        const extraArgs = args.slice(2);
        const fullArgs = [...(entry.server.args ?? []), ...extraArgs];
        const server = {
          name: entry.id,
          command: entry.server.command,
          args: fullArgs,
          env: entry.server.env,
          url: entry.server.url,
          headers: entry.server.headers,
        };
        // Reuse the same add helper as `/mcp add`.
        addProjectMcpServer(session.workspaceRoot, server);

        onChunk(`_Saved \`${entry.id}\` to project config. Spawning…_\n\n`);
        const merged = loadMcpServerConfig(session.workspaceRoot);
        const { registered, errors } = await registerSessionServers(session.sessionId, merged, { workspaceRoot: session.workspaceRoot });
        const failed = errors.find(e => e.server === entry.id);
        const lines: string[] = [];
        if (failed) {
          lines.push(`Saved \`${entry.id}\` but spawn failed: \`${failed.error}\``);
        } else {
          const ok = registered.filter(t => t.serverName === entry.id);
          lines.push(`Installed **${entry.name}** (\`${entry.id}\`) — ${ok.length} tool${ok.length === 1 ? '' : 's'} available.`);
        }
        if (entry.envNotes?.length) {
          lines.push('', '**Environment variables you may need:**');
          for (const e of entry.envNotes) {
            const req = e.required ? ' (required)' : '';
            lines.push(`- \`${e.name}\`${req} — ${e.description}`);
          }
        }
        return { handled: true, response: lines.join('\n'), streaming: true };
      }

      if (sub === 'reload') {
        // Re-read both config files and re-register. Used after a manual
        // edit of `.codeep/mcp_servers.json` outside the CLI — `/mcp add`
        // and `/mcp remove` already re-register automatically.
        onChunk(`_Reloading MCP server config…_\n\n`);
        const merged = loadMcpServerConfig(session.workspaceRoot);
        const { registered, errors } = await registerSessionServers(session.sessionId, merged, { workspaceRoot: session.workspaceRoot });
        const lines = [
          `## MCP reloaded`,
          '',
          `**${registered.length}** tool${registered.length === 1 ? '' : 's'} from **${merged.length}** server${merged.length === 1 ? '' : 's'}.`,
        ];
        if (errors.length > 0) {
          lines.push('', '### Failed servers');
          for (const e of errors) lines.push(`- **${e.server}** — \`${e.error}\``);
        }
        return { handled: true, response: lines.join('\n'), streaming: true };
      }

      // Default: list (and 'list' / no-arg behave the same)
      // Read-only inspector for the MCP servers wired into this session.
      // Sources: file config (`.codeep/mcp_servers.json` project + global)
      // merged with any `mcpServers` the ACP client passed on session/new.
      // The agent can call these tools via `<server>__<tool>`.
      const { getSessionTools, getSessionRegistrationErrors, awaitSessionReady } = await import('../utils/mcpRegistry.js');
      // If session/new is still spinning up servers, wait — otherwise this
      // command would report "no servers" right after a slow npx install.
      await awaitSessionReady(session.sessionId);
      const tools = await getSessionTools(session.sessionId);
      const errors = getSessionRegistrationErrors(session.sessionId);

      if (tools.length === 0 && errors.length === 0) {
        return {
          handled: true,
          response: [
            '_No MCP servers connected to this session._',
            '',
            'Add one with `/mcp add <name> <command> [args...]` — it persists to `.codeep/mcp_servers.json`. ACP clients (Zed, VS Code) can also pass servers via the `mcpServers` field on `session/new`; both sources merge, ACP wins on collisions.',
          ].join('\n'),
        };
      }

      const lines: string[] = ['## MCP servers', ''];

      if (tools.length > 0) {
        // Group by server for a readable listing.
        const byServer = new Map<string, typeof tools>();
        for (const t of tools) {
          if (!byServer.has(t.serverName)) byServer.set(t.serverName, []);
          byServer.get(t.serverName)!.push(t);
        }
        for (const [serverName, serverTools] of byServer) {
          lines.push(`**${serverName}** — ${serverTools.length} tool${serverTools.length === 1 ? '' : 's'}`);
          for (const t of serverTools) {
            const desc = t.description ? ` — ${t.description}` : '';
            lines.push(`- \`${t.agentName}\`${desc}`);
          }
          lines.push('');
        }
      }

      if (errors.length > 0) {
        lines.push('### Failed servers');
        for (const e of errors) {
          lines.push(`- **${e.server}** — \`${e.error}\``);
        }
      }

      return { handled: true, response: lines.join('\n').trim() };
    }

    case 'rewind': {
      const id = args[0];
      if (!id) return { handled: true, response: 'Usage: `/rewind <id>` — run `/checkpoints` to see ids.' };
      const { loadCheckpoint, buildRewindGitHint } = await import('../utils/checkpoints.js');
      const cp = loadCheckpoint(session.workspaceRoot, id);
      if (!cp) return { handled: true, response: `Checkpoint not found: \`${id}\`. Run \`/checkpoints\` to list available ids.` };

      // Restore session conversation in place. Don't touch files — the hint
      // below tells the user how to restore them via git if they want.
      const replacedCount = session.history.length;
      session.history = cp.messages;
      saveSession(session.codeepSessionId, session.history, session.workspaceRoot);

      // If the checkpoint captured a different provider/model, switch back.
      // configOptionsChanged signals the client to refresh its dropdowns.
      let providerChanged = false;
      if (cp.provider && cp.provider !== getCurrentProvider().id) {
        setProvider(cp.provider);
        providerChanged = true;
      }
      if (cp.model && cp.model !== config.get('model')) {
        config.set('model', cp.model);
        providerChanged = true;
      }

      const lines = [
        `## Rewound to ${cp.name ? `**${cp.name}**` : `\`${cp.id}\``}`,
        '',
        `Restored ${cp.messages.length} message${cp.messages.length === 1 ? '' : 's'} (was ${replacedCount}).`,
        cp.provider && cp.model ? `Provider: \`${cp.provider}\` · Model: \`${cp.model}\`` : '',
        '',
        buildRewindGitHint(cp),
      ].filter(Boolean);
      return { handled: true, response: lines.join('\n'), configOptionsChanged: providerChanged };
    }

    case 'profile': {
      const { saveProfile, loadProfile, applyProfile, listProfiles, deleteProfile } = await import('../config/index.js');
      const sub = args[0]?.toLowerCase();

      if (!sub || sub === 'list') {
        const profiles = listProfiles();
        if (profiles.length === 0) return { handled: true, response: '_No profiles saved. Use `/profile save <name>`._' };
        return { handled: true, response: ['## Profiles', '', ...profiles.map(p => `- \`${p}\``), '', 'Use `/profile load <name>` to apply.'].join('\n') };
      }
      if (sub === 'save') {
        const name = args[1];
        if (!name) return { handled: true, response: 'Usage: `/profile save <name>`' };
        return { handled: true, response: saveProfile(name) ? `Profile saved: \`${name}\`` : 'Failed to save profile.', configOptionsChanged: true };
      }
      if (sub === 'load') {
        const name = args[1];
        if (!name) return { handled: true, response: 'Usage: `/profile load <name>`' };
        const profile = loadProfile(name);
        if (!profile) return { handled: true, response: `Profile not found: \`${name}\`` };
        applyProfile(profile);
        return { handled: true, response: `Profile loaded: \`${profile.name}\` (${profile.provider} / ${profile.model})`, configOptionsChanged: true };
      }
      if (sub === 'delete') {
        const name = args[1];
        if (!name) return { handled: true, response: 'Usage: `/profile delete <name>`' };
        return { handled: true, response: deleteProfile(name) ? `Profile deleted: \`${name}\`` : `Profile not found: \`${name}\`` };
      }
      // Shorthand: `/profile <name>` → load
      const profile = loadProfile(sub);
      if (profile) {
        applyProfile(profile);
        return { handled: true, response: `Profile loaded: \`${profile.name}\` (${profile.provider} / ${profile.model})`, configOptionsChanged: true };
      }
      return { handled: true, response: `Unknown subcommand: \`${sub}\`. Use \`save\`, \`load\`, \`delete\`, \`list\`, or \`<name>\` to load.` };
    }

    // ─── Custom user commands + skills ────────────────────────────────────────

    default: {
      // 1. Project / global custom command (~/.codeep/commands or
      //    <workspace>/.codeep/commands). User-authored Markdown templates.
      const { findCustomCommand, expandCommand } = await import('../utils/customCommands.js');
      const custom = findCustomCommand(cmd, session.workspaceRoot);
      if (custom) {
        const expandedPrompt = expandCommand(custom, args);
        // Treat the expanded body as if the user had typed it manually:
        // push it as a user message and run the agent (or chat if agent
        // mode is off), then persist the assistant reply.
        session.history.push({ role: 'user', content: expandedPrompt });
        onChunk(`_Running custom command **/${custom.name}** (${custom.scope})…_\n\n`);

        const projectCtx = getProjectContext(session.workspaceRoot);
        const agentMode = config.get('agentMode');
        let response = '';

        try {
          if (agentMode === 'on') {
            const { buildProjectContext } = await import('./session.js');
            const ctx = buildProjectContext(session.workspaceRoot);
            const agentResult = await runAgent(expandedPrompt, ctx, {
              abortSignal,
              onIteration: (_i: number, msg: string) => { onChunk(msg + '\n'); },
              onThinking: (text: string) => { onChunk(text); },
            });
            response = agentResult.finalResponse ?? '';
            if (response) onChunk(response);
          } else {
            await chat(
              expandedPrompt,
              session.history.slice(0, -1), // exclude the just-pushed user message
              (chunk) => { response += chunk; onChunk(chunk); },
              undefined,
              projectCtx,
              undefined,
            );
          }
          if (response) session.history.push({ role: 'assistant', content: response });
          saveSession(session.codeepSessionId, session.history, session.workspaceRoot);
        } catch (err) {
          onChunk(`\n\n_Custom command failed: ${(err as Error).message}_`);
        }

        return { handled: true, response: '', streaming: true };
      }

      // 2. Built-in skill.
      const { findSkill, parseSkillArgs, executeSkill, trackSkillUsage } = await import('../utils/skills.js');
      const skill = findSkill(cmd);
      if (!skill) {
        return { handled: true, response: `Unknown command: \`/${cmd}\`\n\nType \`/help\` for available commands, \`/skills\` to list all skills, or \`/commands\` for custom commands.` };
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
  // Keep this mirrored with the switch in handleSlashCommand above. Every `case`
  // that isn't a skill alias should have a row here, otherwise users in Zed /
  // VS Code won't discover the command exists.
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
    '| `/telemetry [on\\|off]` | Show or toggle automatic cloud telemetry |',
    '| `/keysync [on\\|off]` | Show or toggle syncing API keys to codeep.dev |',
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
    '| `/scan` | Scan project and cache intelligence for the agent |',
    '| `/learn` | Learn code conventions from source files |',
    '',
    '**Review & Git**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/review` | AI review of **unstaged git changes** (not full codebase) |',
    '| `/review --staged` | AI review of staged git changes |',
    '| `/review --static` | Static analysis — changed files, or full `src/` if clean |',
    '| `/review <file...>` | Static analysis of specific file(s) |',
    '| `/diff [--staged]` | Git diff with AI review |',
    '',
    '**Project intelligence & profiles**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/memory <note>` | Add a project note (or `list` / `remove <n>` / `clear`) |',
    '| `/me` | Your user profile — reply language, style, stack (`init [project]`, `learn [on\\|off\\|project]`, `forget`, `on`/`off`) |',
    '| `/agents` | List sub-agents the agent can delegate self-contained tasks to |',
    '| `/profile save <name>` | Save current provider/model/settings (or `load` / `delete` / `list`) |',
    '| `/hooks` | List installed lifecycle hooks (`.codeep/hooks/<event>.sh`) |',
    '',
    '**Actions & History**',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/undo` | Undo last agent action |',
    '| `/undo-all` | Undo all actions in session |',
    '| `/changes` | Show session changes |',
    '| `/cost` | Show per-session token usage and estimated cost |',
    '| `/compact [keepN]` | Summarize older messages to free up context (keeps last N, default 4) |',
    '| `/checkpoint [name]` | Save a session snapshot (conversation + provider/model) |',
    '| `/checkpoints` | List saved checkpoints |',
    '| `/rewind <id>` | Restore a checkpoint (files via git, see hint after rewind) |',
    '| `/export [json\\|md\\|txt]` | Export conversation |',
    '',
    '**Skills** (type `/skills` to list all, or `/skills <query>` to search)',
    '`/commit` · `/fix` · `/test` · `/docs` · `/refactor` · `/explain`',
    '`/optimize` · `/debug` · `/push` · `/pr` · `/build` · `/deploy` …',
    '',
    '**Custom Commands** — drop Markdown files in `.codeep/commands/` (project)',
    'or `~/.codeep/commands/` (global) to define your own `/<name>` commands.',
    'Run `/commands` to list them.',
    '',
    '_Skills run as standalone workflows. For general coding requests, just describe the task._',
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

// Inline API keys end up in the user's shell history (Zed/VS Code chat is
// terminal-adjacent enough that screenshots and pasted transcripts also leak).
// We still save the key (backwards compat — there's no prompt mechanism inside
// ACP), but the response nudges users toward the safer paths and reminds them
// to scrub the line they just typed.
const INLINE_KEY_WARNING =
  '\n\n> ⚠️  The key you just typed is now in your shell / chat history.' +
  ' Prefer setting the provider env var (see `/provider`) or using the' +
  ' settings UI in the VS Code extension. Clear the line from history if' +
  ' the machine is shared.';

async function setApiKeyCmd(key: string): Promise<string> {
  const providerId = getCurrentProvider().id;
  // Await persistence so the confirmation is only returned once the key is
  // actually stored (keychain write resolves before the process can exit).
  try {
    await setApiKey(key, providerId);
  } catch {
    return `Failed to save API key for \`${providerId}\` — secure storage was unavailable. Please try again.`;
  }
  return `API key for \`${providerId}\` saved.${INLINE_KEY_WARNING}`;
}

async function loginCmd(providerId: string, apiKey: string): Promise<string> {
  const provider = getProvider(providerId);
  if (!provider) return `Provider \`${providerId}\` not found.\n\n${buildProviderList()}`;
  setProvider(providerId);
  try {
    await setApiKey(apiKey, providerId);
  } catch {
    return `Failed to save API key for \`${providerId}\` — secure storage was unavailable. Please try again.`;
  }
  return `Logged in as **${provider.name}** (\`${providerId}\`). Model: \`${provider.defaultModel}\`.${INLINE_KEY_WARNING}`;
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
