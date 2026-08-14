#!/usr/bin/env node
/**
 * Codeep — entry point.
 *
 * This file contains only startup/init logic. Command dispatch lives in
 * commands.ts and agent execution in agentExecution.ts.
 */

import { App, Message } from './App';
import { Screen } from './Screen';
import { Input, KeyEvent } from './Input';
import { StatusInfo } from './components/Status';
import { LoginScreen, renderProviderSelect } from './components/Login';
import { renderPermissionScreen, getPermissionOptions, PermissionLevel } from './components/Permission';
import { chat, setProjectContext } from '../api/index';
import { getZaiVisionConfig, getMinimaxMcpConfig, callZaiVisionApi, callMinimaxApi } from '../utils/mcpIntegration';
import {
  config,
  isConfigured,
  loadApiKey,
  loadAllApiKeys,
  getCurrentProvider,
  PROVIDERS,
  autoSaveSession,
  startNewSession,
  getCurrentSessionId,
  loadSession,
  listSessionsWithInfo,
  deleteSession,
  hasReadPermission,
  hasWritePermission,
  setProjectPermission,
  initializeAsProject,
  isManuallyInitializedProject,
  setApiKey,
  setProvider,
  getGithubId,
} from '../config/index';
import {
  isProjectDirectory,
  getProjectContext,
  ProjectContext,
} from '../utils/project';
import { getCurrentVersion, checkForUpdates, getUpdateInstructions } from '../utils/update';
import { getProviderList, isNoApiKeyProvider, resolveReasoningTier } from '../config/providers';
import { getSessionStats, getCostBreakdown, getRecordCount } from '../utils/tokenTracker';
import { getGitStatus, isGitRepository } from '../utils/git';
import { reportStats, syncSession, generateProjectId } from '../utils/codeepCloud';
import { checkApiRateLimit } from '../utils/ratelimit';
import { expandFileAndFolderMentions, expandGitMentions } from '../utils/mentions';
import { expandWebMentions } from '../utils/webFetch';
import { handleCommand as dispatchCommand, AppCommandContext } from './commands';
import { logger, logAppError } from '../utils/logger';
import {
  executeAgentTask,
  runAgentTask,
  PendingInteractiveContext,
} from './agentExecution';

// ─── Global state ─────────────────────────────────────────────────────────────

let projectPath = process.cwd();
/** Cached header branch. Resolved on first use so `--version`/`--help` never
 *  shell out to git, and cached because getStatus runs on every render frame. */
let gitBranchCache: { path: string; branch?: string } | null = null;
let projectContext: ProjectContext | null = null;
let hasWriteAccess = false;
let sessionId = getCurrentSessionId();
let app: App;
/** Human-readable session name derived from the first user message */
let sessionDisplayName: string | null = null;

const addedFiles: Map<string, { relativePath: string; content: string }> = new Map();

/** Branch shown in the persistent header, re-read whenever the project moved
 *  or an agent run finished (an agent can check out a different branch). */
function getHeaderBranch(): string | undefined {
  if (!gitBranchCache || gitBranchCache.path !== projectPath) {
    gitBranchCache = { path: projectPath, branch: getGitStatus(projectPath).branch };
  }
  return gitBranchCache.branch;
}

/** Derive a short display name from a user message (first ~5 words, max 48 chars). */
export function deriveSessionName(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').slice(0, 5).join(' ');
  return words.length > 48 ? words.slice(0, 45) + '…' : words;
}

let isAgentRunningFlag = false;
let agentAbortController: AbortController | null = null;
let pendingInteractiveContext: PendingInteractiveContext | null = null;

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(): AppCommandContext {
  return {
    app,
    projectPath,
    projectContext,
    hasWriteAccess,
    addedFiles,
    sessionId,
    sessionDisplayName: sessionDisplayName ?? undefined,
    abortController: agentAbortController,
    isAgentRunning: () => isAgentRunningFlag,
    // A finished run may have switched branches — drop the cache so the next
    // header render re-reads it.
    setAgentRunning: (v) => { isAgentRunningFlag = v; if (!v) gitBranchCache = null; },
    setAbortController: (ctrl) => { agentAbortController = ctrl; },
    formatAddedFilesContext,
    handleCommand: (cmd, args) => dispatchCommand(cmd, args, makeCtx()),
    setSessionId: (id) => { sessionId = id; },
    setSessionDisplayName: (name) => { sessionDisplayName = name; },
    setProjectContext: (ctx) => {
      projectContext = ctx;
      if (ctx) setProjectContext(ctx);
    },
    setHasWriteAccess: (v) => { hasWriteAccess = v; },
  };
}

// ─── Status ───────────────────────────────────────────────────────────────────

function getStatus(): StatusInfo {
  const provider = getCurrentProvider();
  const providers = getProviderList();
  const providerInfo = providers.find(p => p.id === provider.id);
  const stats = getSessionStats();
  // Show the thinking-effort tier beside the model. Resolve the (global) tier
  // to what THIS model actually runs — e.g. a global 'low' shows as 'high' on
  // Kimi K3, where the global medium tier resolves to high. 'auto'/unsupported → hidden.
  const resolved = resolveReasoningTier(provider.id, config.get('model'), config.get('reasoningEffort'));
  const reasoningEffort = resolved !== 'auto' ? resolved : undefined;
  return {
    version: getCurrentVersion(),
    provider: providerInfo?.name || 'Unknown',
    model: config.get('model'),
    agentMode: config.get('agentMode') || 'off',
    reasoningEffort,
    projectPath,
    branch: getHeaderBranch(),
    hasWriteAccess,
    sessionId,
    messageCount: app ? app.getMessages().length : 0,
    tokenStats: {
      totalTokens: stats.totalTokens,
      promptTokens: stats.totalPromptTokens,
      completionTokens: stats.totalCompletionTokens,
      requestCount: stats.requestCount,
      estimatedCost: stats.estimatedCost,
    },
  };
}

// ─── Added-files context ──────────────────────────────────────────────────────

function formatAddedFilesContext(): string {
  if (addedFiles.size === 0) return '';
  const parts: string[] = ['[Attached files]'];
  for (const [, file] of addedFiles) {
    parts.push(`\nFile: ${file.relativePath}\n\`\`\`\n${file.content}\n\`\`\``);
  }
  return parts.join('\n') + '\n\n';
}

// ─── Message submission ───────────────────────────────────────────────────────

async function handleSubmit(message: string): Promise<void> {
  const ctx = makeCtx();

  // Handle interactive mode follow-up answers
  if (pendingInteractiveContext) {
    const { parseAnswers, enhancePromptWithAnswers } = await import('../utils/interactive');
    const answers = parseAnswers(message, pendingInteractiveContext.context);
    const enhancedTask = enhancePromptWithAnswers(pendingInteractiveContext.context, answers);
    const dryRun = pendingInteractiveContext.dryRun;
    pendingInteractiveContext = null;

    const confirmationMode = config.get('agentConfirmation') || 'dangerous';
    if (confirmationMode === 'never' || dryRun) {
      executeAgentTask(enhancedTask, dryRun, ctx);
      return;
    }
    if (confirmationMode === 'always') {
      const shortTask = enhancedTask.length > 60 ? enhancedTask.slice(0, 57) + '...' : enhancedTask;
      app.showConfirm({
        title: '⚠️  Confirm Agent Task',
        message: ['Run agent with enhanced task?', '', `  "${shortTask}"`],
        confirmLabel: 'Run Agent',
        cancelLabel: 'Cancel',
        onConfirm: () => executeAgentTask(enhancedTask, dryRun, ctx),
        onCancel: () => app.notify('Agent task cancelled'),
      });
      return;
    }
    const dangerousKeywords = ['delete', 'remove', 'drop', 'reset', 'force', 'overwrite', 'replace all', 'rm ', 'clear'];
    if (dangerousKeywords.some(k => enhancedTask.toLowerCase().includes(k))) {
      const shortTask = enhancedTask.length > 60 ? enhancedTask.slice(0, 57) + '...' : enhancedTask;
      app.showConfirm({
        title: '⚠️  Potentially Dangerous Task',
        message: ['This task contains potentially dangerous operations:', '', `  "${shortTask}"`],
        confirmLabel: 'Proceed',
        cancelLabel: 'Cancel',
        onConfirm: () => executeAgentTask(enhancedTask, dryRun, ctx),
        onCancel: () => app.notify('Agent task cancelled'),
      });
      return;
    }
    executeAgentTask(enhancedTask, dryRun, ctx);
    return;
  }

  const rateCheck = checkApiRateLimit();
  if (!rateCheck.allowed) {
    app.notify(rateCheck.message || 'Rate limit exceeded', 5000);
    return;
  }

  // Auto agent mode
  const agentMode = config.get('agentMode') || 'off';
  if (agentMode === 'on' && projectContext && hasWriteAccess && !isAgentRunningFlag) {
    runAgentTask(message, false, ctx,
      () => pendingInteractiveContext,
      (v) => { pendingInteractiveContext = v; },
    );
    return;
  }

  // Captured before the turn starts so the delta can be reported from both the
  // success path and the catch. An aborted or failed turn has still burned
  // tokens, and gracefulShutdown no longer sends a cumulative catch-all that
  // would have swept them up later.
  const tokenReportStart = getRecordCount();

  // Cloud stats are append-only events, so report only this prompt's delta.
  // Sending the full session accumulator after every prompt makes totals grow
  // 1× + 2× + 3× and is the source of the inflated dashboard token count.
  // pingWhenEmpty sends a bare session event when nothing was spent — wanted on
  // the success path, not when the turn failed before reaching the model.
  const reportTurnStats = (pingWhenEmpty: boolean) => {
    const sharedFields = {
      sessionId,
      sessionName: sessionDisplayName || sessionId,
      messageCount: app.getMessages().length,
      cliVersion: getCurrentVersion(),
      projectName: projectContext?.name,
      projectId: projectPath ? generateProjectId(projectPath) : undefined,
      language: projectContext?.type,
      isGit: isGitRepository(process.cwd()),
    };
    const costBreakdown = getCostBreakdown(tokenReportStart);
    if (costBreakdown.length === 0) {
      if (pingWhenEmpty) {
        reportStats({ ...sharedFields, model: config.get('model'), provider: config.get('provider') });
      }
      return;
    }
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
  };

  try {
    app.startStreaming();
    const history = app.getChatHistory();

    // Expand inline @-mentions (@src/file.ts) into the prompt's context.
    // Done after history capture (mentions are per-message) but before
    // deriveSessionName so the title reflects what the user typed, not the
    // expanded path.
    const mentionRoot = projectContext?.root || projectPath || process.cwd();
    // Expand @folder and @file mentions in one pass, merged into a single
    // [Attached files] block.
    const { enrichedPrompt: fileExpanded, loaded: loadedMentions, failures: mentionFailures } =
      expandFileAndFolderMentions(message, { root: mentionRoot });
    if (loadedMentions.length > 0) {
      app.notify(`Loaded ${loadedMentions.length} file(s) from @mentions/@folder`);
    }
    for (const f of mentionFailures) {
      app.notify(`${f.mention}: ${f.reason}`);
    }

    // Expand @git <ref> mentions — resolve diffs / file-at-ref / commit
    // patches into a [Git ref] block. Runs between file and web mentions
    // so the prompt flows: [files] [git] [web] <text>.
    const { enrichedPrompt: gitExpanded, failures: gitFailures } =
      await expandGitMentions(fileExpanded, { root: mentionRoot });
    for (const f of gitFailures) {
      app.notify(`${f.mention}: ${f.reason}`);
    }

    // Expand @web <url> mentions — fetch each page and prepend its text.
    // Runs after file mentions so the prompt flows: [files] [web] <text>.
    const { enrichedPrompt: webExpanded, loaded: loadedPages, failures: webFailures } =
      await expandWebMentions(gitExpanded);
    if (loadedPages.length > 0) {
      app.notify(`Fetched ${loadedPages.length} page(s) from @web`);
    }
    for (const f of webFailures) {
      app.notify(`${f.mention}: ${f.reason}`);
    }

    if (!sessionDisplayName && history.filter(m => m.role === 'user').length === 0) {
      sessionDisplayName = deriveSessionName(message);
    }
    const fileContext = formatAddedFilesContext();
    const enrichedMessage = fileContext ? fileContext + webExpanded : webExpanded;
    await chat(enrichedMessage, history, (chunk) => app.addStreamChunk(chunk), undefined, projectContext, undefined);
    app.endStreaming();
    autoSaveSession(app.getMessages(), projectPath);

    // Sync to dashboard after every successful manual chat (not just on shutdown).
    // Mirrors the agent-mode behaviour in agentExecution.ts so dashboard stays
    // in sync regardless of Agent Mode setting.
    const messagesNow = app.getMessages();
    const projectId = projectPath ? generateProjectId(projectPath) : undefined;
    const displayName = sessionDisplayName || sessionId;
    syncSession({
      sessionId,
      sessionName: displayName,
      projectName: projectContext?.name,
      projectId,
      messages: messagesNow,
    });
    const sharedFields = {
      sessionId,
      sessionName: displayName,
      messageCount: messagesNow.length,
      cliVersion: getCurrentVersion(),
      projectName: projectContext?.name,
      projectId,
      language: projectContext?.type,
      isGit: isGitRepository(process.cwd()),
    };
    // Cloud stats are append-only events, so report only this prompt's delta.
    // Sending the full session accumulator after every prompt makes totals grow
    // 1× + 2× + 3× and is the source of the inflated dashboard token count.
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
  } catch (error) {
    app.endStreaming();
    const err = error as Error & { name: string };
    if (err.name === 'AbortError') return;
    app.notify(`Error: ${err.message}`, 5000);
  }
}

// ─── Command bridge ───────────────────────────────────────────────────────────

async function handleCommand(command: string, args: string[]): Promise<void> {
  return dispatchCommand(command, args, makeCtx());
}

// ─── Login flow (full-screen, pre-app) ───────────────────────────────────────

async function showLoginFlow(): Promise<string | null> {
  return new Promise((resolve) => {
    const screen = new Screen();
    const input = new Input();
    const providers = getProviderList();

    let currentStep: 'provider' | 'apikey' = 'provider';
    let selectedProviderIndex = 0;
    let selectedProvider = providers[0];
    let loginScreen: LoginScreen | null = null;
    let loginError = '';

    screen.init();
    input.start();

    const cleanup = () => { input.stop(); screen.cleanup(); };

    const renderCurrentStep = () => {
      if (currentStep === 'provider') {
        renderProviderSelect(screen, providers, selectedProviderIndex);
      } else if (loginScreen) {
        loginScreen.render();
      }
    };

    input.onKey((event: KeyEvent) => {
      if (currentStep === 'provider') {
        if (event.key === 'up') {
          selectedProviderIndex = Math.max(0, selectedProviderIndex - 1);
          renderCurrentStep();
        } else if (event.key === 'down') {
          selectedProviderIndex = Math.min(providers.length - 1, selectedProviderIndex + 1);
          renderCurrentStep();
        } else if (event.key === 'enter') {
          selectedProvider = providers[selectedProviderIndex];
          setProvider(selectedProvider.id);
          // Providers that don't need a key (Ollama, Custom OpenAI-compatible)
          // skip the API-key prompt entirely. Configure their endpoint in
          // /settings (Ollama URL / Custom Base URL) once inside the app.
          if (selectedProvider.noApiKey) {
            cleanup();
            resolve('ollama'); // non-null sentinel so the caller proceeds
            return;
          }
          currentStep = 'apikey';
          loginScreen = new LoginScreen(screen, input, {
            providerName: selectedProvider.name,
            error: loginError,
            subscribeUrl: selectedProvider.subscribeUrl,
            onSubmit: async (key) => {
              if (key.length < 10) {
                loginError = 'API key too short';
                loginScreen = new LoginScreen(screen, input, {
                  providerName: selectedProvider.name,
                  error: loginError,
                  subscribeUrl: selectedProvider.subscribeUrl,
                  onSubmit: () => {},
                  onCancel: () => { cleanup(); resolve(null); },
                });
                renderCurrentStep();
                return;
              }
              try {
                await setApiKey(key);
              } catch {
                loginError = 'Could not save the API key (secure storage unavailable). Please try again.';
                renderCurrentStep();
                return;
              }
              cleanup();
              resolve(key);
            },
            onCancel: () => {
              currentStep = 'provider';
              loginScreen = null;
              loginError = '';
              renderCurrentStep();
            },
          });
          renderCurrentStep();
        } else if (event.key === 'escape') {
          cleanup();
          resolve(null);
        }
      } else if (loginScreen) {
        loginScreen.handleKey(event);
      }
    });

    renderCurrentStep();
  });
}

// ─── Permission flow (full-screen, pre-app) ───────────────────────────────────

async function showPermissionFlow(): Promise<PermissionLevel> {
  return new Promise((resolve) => {
    const screen = new Screen();
    const input = new Input();

    let selectedIndex = 0;
    const options = getPermissionOptions();
    const isProject = isProjectDirectory(projectPath);
    const currentPermission: PermissionLevel = hasWritePermission(projectPath)
      ? 'write'
      : hasReadPermission(projectPath)
        ? 'read'
        : 'none';

    screen.init();
    input.start();

    const cleanup = () => { input.stop(); screen.cleanup(); };
    const render = () => {
      renderPermissionScreen(screen, {
        projectPath, isProject, currentPermission,
        onSelect: () => {}, onCancel: () => {},
      }, selectedIndex);
    };

    input.onKey((event: KeyEvent) => {
      if (event.key === 'up') { selectedIndex = Math.max(0, selectedIndex - 1); render(); }
      else if (event.key === 'down') { selectedIndex = Math.min(options.length - 1, selectedIndex + 1); render(); }
      else if (event.key === 'enter') { cleanup(); resolve(options[selectedIndex]); }
      else if (event.key === 'escape') { cleanup(); resolve('none'); }
    });

    render();
  });
}

// ─── Session picker ───────────────────────────────────────────────────────────

function showSessionPickerInline(): void {
  const sessions = listSessionsWithInfo(projectPath);
  if (sessions.length === 0) {
    sessionId = startNewSession();
    return;
  }
  app.showSessionPicker(
    sessions,
    (selectedName) => {
      if (selectedName === null) {
        sessionId = startNewSession();
        app.notify('New session started');
      } else {
        const messages = loadSession(selectedName, projectPath);
        if (messages) {
          sessionId = selectedName;
          app.setMessages(messages as Message[]);
          app.notify(`Loaded: ${selectedName}`);
        } else {
          sessionId = startNewSession();
          app.notify('Session not found, started new');
        }
      }
    },
    (sessionName) => { deleteSession(sessionName, projectPath); },
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Headless, deterministic code review for CI (no API key, no TUI). Handled
  // before the global --help/--version checks so `codeep review --help` shows
  // the review usage rather than the top-level help.
  if (args[0] === 'review') {
    const { runHeadlessReview } = await import('../utils/headlessReview.js');
    process.exit(await runHeadlessReview(args.slice(1)));
  }

  if (args[0] === 'hook') {
    const { runHookCommand } = await import('../utils/gitHookInstaller.js');
    process.exit(runHookCommand(args.slice(1)));
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`Codeep v${getCurrentVersion()}`);
    process.exit(0);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Codeep - AI-powered coding assistant TUI

Usage:
  codeep              Start interactive chat
  codeep account        Link CLI to your codeep.dev dashboard
  codeep account sync   Pull personalities + commands + profile (+ keys if cloud key sync is on)
  codeep account push   Push personalities + commands + profile (+ keys if cloud key sync is on)
  codeep account purge-keys  Delete all your API keys stored on codeep.dev (cloud only; local keychain untouched)
  codeep acp          Start ACP server (for Zed editor integration)
  codeep review       Offline code review for CI (--json, --fail-on, --rules, --ai)
  codeep hook install   Install a git pre-commit hook running \`codeep review\`
  codeep hook uninstall Remove the Codeep git hook
  codeep --version    Show version
  codeep --help       Show this help

Commands (in chat):
  /help      Show all available commands
  /status    Show current status
  /version   Show version and current model
  /exit      Quit application
    `);
    process.exit(0);
  }

  // Account / dashboard link flow
  if (args[0] === 'account') {
    const sub = args[1];

    if (sub === 'sync' || sub === 'pull') {
      const { getSyncToken, setApiKey, loadAllApiKeys: loadKeys, isKeySyncEnabled } = await import('../config/index.js');
      if (!getSyncToken()) {
        console.log('\n  Not linked to codeep.dev. Run: codeep account\n');
        process.exit(1);
      }
      // Run the one-time plaintext->keychain migration BEFORE storing any pulled
      // key. Otherwise the first setApiKey flips keysSecured=true and any local
      // legacy plaintext keys would never migrate (orphaned, invisible).
      await loadKeys();

      // API keys are opt-in (default OFF). Pull them only when cloud key sync is
      // enabled; the personal config below always syncs (no secrets).
      if (isKeySyncEnabled()) {
        const { pullKeys } = await import('../utils/codeepCloud.js');
        process.stdout.write('  Pulling keys from codeep.dev...');
        const keys = await pullKeys();
        if (!keys) {
          console.log(' failed.\n  Check your connection or re-link with: codeep account\n');
          process.exit(1);
        }
        const count = Object.keys(keys).length;
        if (count === 0) {
          console.log(' no keys found.\n  Add keys at codeep.dev/dashboard');
        } else {
          let synced = 0;
          for (const [provider, key] of Object.entries(keys)) {
            try {
              await setApiKey(key, provider);
              synced++;
            } catch {
              console.log(`\n  Warning: could not securely store the key for ${provider}.`);
            }
          }
          console.log(` synced ${synced} key${synced !== 1 ? 's' : ''}.`);
        }
      } else {
        console.log('  Cloud key sync is off — skipping API keys. Enable with: /keysync on');
      }

      // Also pull portable personal config — personalities + custom commands +
      // the user profile. Additive merge (never clobbers local files).
      const { pullPersonalities, pullCommands, pullUserProfile } = await import('../utils/codeepCloud.js');
      const pCount = await pullPersonalities();
      if (typeof pCount === 'number' && pCount > 0) {
        console.log(`  Pulled ${pCount} personalit${pCount === 1 ? 'y' : 'ies'}.`);
      }
      const cCount = await pullCommands();
      if (typeof cCount === 'number' && cCount > 0) {
        console.log(`  Pulled ${cCount} custom command${cCount === 1 ? '' : 's'}.`);
      }
      const profPulled = await pullUserProfile();
      if (profPulled === 1) {
        console.log('  Pulled your profile (about you).');
      }
      console.log('');
      process.exit(0);
    }

    if (sub === 'push') {
      const { getSyncToken, getApiKey, isKeySyncEnabled } = await import('../config/index.js');
      if (!getSyncToken()) {
        console.log('\n  Not linked to codeep.dev. Run: codeep account\n');
        process.exit(1);
      }

      // API keys are opt-in (default OFF). Push them only when cloud key sync is
      // enabled; the personal config below always pushes (no secrets).
      let keyPushFailed = false;
      if (isKeySyncEnabled()) {
        const { pushKeys } = await import('../utils/codeepCloud.js');
        const { PROVIDERS } = await import('../config/providers.js');
        await loadAllApiKeys();
        const keys: Record<string, string> = {};
        for (const providerId of Object.keys(PROVIDERS)) {
          const key = getApiKey(providerId);
          if (key) keys[providerId] = key;
        }
        const count = Object.keys(keys).length;
        if (count === 0) {
          console.log('  No local API keys to push.');
        } else {
          process.stdout.write(`  Pushing ${count} key${count !== 1 ? 's' : ''} to codeep.dev...`);
          const ok = await pushKeys(keys);
          console.log(ok ? ' done.' : ' failed.');
          keyPushFailed = !ok;
        }
      } else {
        console.log('  Cloud key sync is off — skipping API keys. Enable with: /keysync on');
      }

      // Also push portable personal config — personalities + commands + profile.
      const { pushPersonalities, pushCommands, pushUserProfile } = await import('../utils/codeepCloud.js');
      const pCount = await pushPersonalities();
      if (typeof pCount === 'number' && pCount > 0) {
        console.log(`  Pushed ${pCount} personalit${pCount === 1 ? 'y' : 'ies'}.`);
      }
      const cCount = await pushCommands();
      if (typeof cCount === 'number' && cCount > 0) {
        console.log(`  Pushed ${cCount} custom command${cCount === 1 ? '' : 's'}.`);
      }
      if (await pushUserProfile()) {
        console.log('  Pushed your profile (about you).');
      }
      console.log('');
      process.exit(keyPushFailed ? 1 : 0);
    }

    if (sub === 'purge-keys') {
      const { getSyncToken } = await import('../config/index.js');
      if (!getSyncToken()) {
        console.log('\n  Not linked to codeep.dev. Run: codeep account\n');
        process.exit(1);
      }
      const { purgeKeys } = await import('../utils/codeepCloud.js');
      process.stdout.write('  Deleting all your API keys from codeep.dev...');
      const ok = await purgeKeys();
      console.log(ok ? ' done. (Local keychain keys are untouched.)' : ' failed.');
      console.log('');
      process.exit(ok ? 0 : 1);
    }

    const { runAccountFlow } = await import('../utils/codeepCloud.js');
    await runAccountFlow();
    process.exit(0);
  }

  // ACP server mode — started by Zed via Agent Client Protocol
  if (args[0] === 'acp') {
    await loadAllApiKeys();
    const { startAcpServer } = await import('../acp/server.js');
    await startAcpServer();
    return;
  }

  await loadAllApiKeys();
  let apiKey: string | null = await loadApiKey();

  if (!apiKey && !isNoApiKeyProvider(config.get('provider'))) {
    const newKey = await showLoginFlow();
    if (!newKey) { console.log('\nSetup cancelled.'); process.exit(0); }
    apiKey = newKey;
  }
  // No API key needed for providers like Ollama
  if (!apiKey && isNoApiKeyProvider(config.get('provider'))) {
    apiKey = 'ollama';
  }

  const isProject = isProjectDirectory(projectPath);
  const hasRead = hasReadPermission(projectPath);
  const needsPermissionDialog = !hasRead;

  if (hasRead) {
    hasWriteAccess = hasWritePermission(projectPath);
    projectContext = getProjectContext(projectPath);
    if (projectContext) {
      projectContext.hasWriteAccess = hasWriteAccess;
      setProjectContext(projectContext);
    }
  }

  app = new App({
    onSubmit: handleSubmit,
    onCommand: handleCommand,
    onExit: () => { gracefulShutdown().finally(() => process.exit(0)); },
    onStopAgent: () => {
      if (isAgentRunningFlag && agentAbortController) {
        agentAbortController.abort();
        app.notify('Stopping agent...');
      }
    },
    onImagePaste: async (imageData: string) => {
      const prompt = 'Describe this image in detail.';
      const zaiConfig = getZaiVisionConfig();
      const mmConfig = getMinimaxMcpConfig();
      let result: string;
      if (zaiConfig) {
        result = await callZaiVisionApi(zaiConfig.baseUrl, zaiConfig.apiKey, prompt, imageData);
      } else if (mmConfig) {
        result = await callMinimaxApi(mmConfig.host, '/v1/coding_plan/vlm', { prompt, image_url: imageData }, mmConfig.apiKey);
      } else {
        app.notify('Image paste requires Z.AI or MiniMax API key');
        return;
      }
      app.addMessage({ role: 'user', content: '[Image pasted from clipboard]' } as Message);
      app.addMessage({ role: 'assistant', content: result } as Message);
    },
    getStatus,
    hasWriteAccess: () => hasWriteAccess,
    hasProjectContext: () => projectContext !== null,
    getProjectRoot: () => projectContext?.root || projectPath || process.cwd(),
  });

  const provider = getCurrentProvider();
  const providers = getProviderList();
  const providerInfo = providers.find(p => p.id === provider.id);
  const version = getCurrentVersion();
  const model = config.get('model');
  const agentMode = config.get('agentMode') || 'off';

  const welcomeLines: string[] = [`Codeep v${version}  ·  ${providerInfo?.name}  ·  ${model}`, ''];
  if (projectContext) {
    welcomeLines.push(`  Project  ${projectPath}`);
    welcomeLines.push(hasWriteAccess
      ? '  Access   Read & Write  ·  Agent enabled'
      : '  Access   Read Only  ·  /grant to enable Agent');
  } else {
    welcomeLines.push('  Mode     Chat only  ·  no project context');
  }
  if (agentMode === 'on' && hasWriteAccess) {
    welcomeLines.push('');
    welcomeLines.push('  ⚠  Agent Mode ON  —  messages auto-execute as agent tasks');
  }
  welcomeLines.push('');
  const githubId = getGithubId();
  welcomeLines.push(githubId
    ? `  Account  codeep.dev linked`
    : `  Account  not linked  ·  run: codeep account`);
  // Warn before first use if this workspace defines project-scoped custom
  // slash commands. They run as user prompts — a hostile or unfamiliar repo
  // could ship `.codeep/commands/refactor.md` whose body silently sends
  // something the user didn't intend. The banner is informed-consent;
  // `/commands` shows the full bodies.
  if (projectPath) {
    try {
      const { loadCustomCommands } = await import('../utils/customCommands');
      const projectCustom = loadCustomCommands(projectPath).filter(c => c.scope === 'project');
      if (projectCustom.length > 0) {
        const list = projectCustom.slice(0, 6).map(c => `/${c.name}`).join(', ');
        const more = projectCustom.length > 6 ? ` (+${projectCustom.length - 6} more)` : '';
        welcomeLines.push('');
        welcomeLines.push(`  ⚠  This workspace defines ${projectCustom.length} custom slash command${projectCustom.length === 1 ? '' : 's'}: ${list}${more}`);
        welcomeLines.push('     Type /commands to review before invoking');
      }
    } catch {
      // Loading must never block the welcome banner.
    }

    // Same flag for lifecycle hooks — they're arbitrary shell that fires on
    // tool calls. A surprise post_edit / pre_tool_call from a freshly cloned
    // repo is exactly the kind of thing a user should be told up front.
    try {
      const { summarizeHooks } = await import('../utils/hooks');
      const summary = summarizeHooks(projectPath);
      if (summary) {
        welcomeLines.push('');
        welcomeLines.push(`  ⚠  ${summary} — shell hooks run automatically. Type /hooks to inspect.`);
      }
    } catch {
      // Don't block on hook discovery failure.
    }

    // Skill bundles — less dangerous than hooks but worth surfacing
    // because the agent will invoke them autonomously.
    try {
      const { summarizeBundles } = await import('../utils/skillBundles');
      const summary = summarizeBundles(projectPath);
      if (summary) {
        welcomeLines.push('');
        welcomeLines.push(`  ℹ  This workspace ships ${summary}. Type /skills bundles to inspect.`);
      }
    } catch {
      // Don't block on skill discovery failure.
    }
  }

  welcomeLines.push('');
  welcomeLines.push('  /help  ·  Ctrl+L clear  ·  Esc cancel');
  app.addMessage({ role: 'welcome', content: welcomeLines.join('\n') });

  app.start();

  // Spawn MCP servers in the background. They register against the fixed
  // session id `codeep-tui` that runAgentTask passes into runAgent's
  // `mcpSessionId` — so the agent picks up `.codeep/mcp_servers.json`
  // entries (project + global) the same way an ACP client would.
  if (projectPath) {
    (async () => {
      try {
        const { loadMcpServerConfigSplit, isWorkspaceMcpTrusted, trustWorkspaceMcp } = await import('../utils/mcpConfig');
        const { registerSessionServers } = await import('../utils/mcpRegistry');
        const { global: globalServers, workspace: workspaceServers } = loadMcpServerConfigSplit(projectPath);

        const spawnServers = async (servers: typeof globalServers) => {
          if (servers.length === 0) return;
          const { registered, errors } = await registerSessionServers('codeep-tui', servers, { workspaceRoot: projectPath });
          if (registered.length > 0) {
            app.notify(`MCP: ${registered.length} tool(s) from ${servers.length} server(s) ready. Type /mcp.`);
          }
          for (const e of errors) {
            app.notifyWarn(`MCP server "${e.server}" failed: ${e.error}`);
          }
        };

        // ~/.codeep servers are the user's own machine-wide config — spawn.
        await spawnServers(globalServers);

        // Workspace files (.codeep/mcp_servers.json, .mcp.json) travel WITH
        // the repo — a cloned project could otherwise execute arbitrary
        // commands at startup. One-time per-workspace approval, mirroring
        // the trustedHookProjects gate for hooks.
        if (workspaceServers.length === 0) return;
        if (isWorkspaceMcpTrusted(projectPath)) {
          await spawnServers(workspaceServers);
          return;
        }
        const preview = workspaceServers.slice(0, 5).map(s =>
          `  ${s.name}: ${s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url ?? ''}`);
        if (workspaceServers.length > 5) preview.push(`  …and ${workspaceServers.length - 5} more`);
        app.showConfirm({
          title: 'Trust workspace MCP servers?',
          message: [
            `This workspace defines ${workspaceServers.length} MCP server(s) that run as local processes:`,
            ...preview,
            '',
            'Only start them if you trust this repo — they run with your permissions.',
          ],
          confirmLabel: 'Trust & start',
          cancelLabel: 'Not now',
          onConfirm: () => {
            trustWorkspaceMcp(projectPath);
            void spawnServers(workspaceServers);
          },
          onCancel: () => {
            app.notify('Workspace MCP servers skipped. Run /mcp trust to enable them.');
          },
        });
      } catch {
        // Loading MCP must never block the TUI.
      }
    })();
  }

  // Check for updates in background — show notify if new version available
  checkForUpdates().then(info => {
    if (info.hasUpdate) {
      app.notify(`Update available: v${info.latest} (current: v${info.current})\nRun: ${getUpdateInstructions()}`);
    }
  }).catch(() => { /* ignore update check failures */ });

  // Auto-detect Ollama on startup — suggest switching if it's running and provider isn't ollama
  if (config.get('provider') !== 'ollama') {
    (async () => {
      try {
        const { fetchOllamaModels } = await import('../config/index.js');
        const models = await fetchOllamaModels();
        if (models && models.length > 0) {
          const names = models.slice(0, 3).map(m => m.name).join(', ') + (models.length > 3 ? '…' : '');
          app.notify(`Ollama detected (${models.length} model${models.length > 1 ? 's' : ''}: ${names})\nRun /provider to switch to Ollama`);
        }
      } catch { /* ignore */ }
    })();
  }

  // Ollama health check — ping every 30s while Ollama is the active provider
  let ollamaWasDown = false;
  const ollamaHealthInterval = setInterval(async () => {
    if (config.get('provider') !== 'ollama') return;
    try {
      const { fetchOllamaModels } = await import('../config/index.js');
      const result = await fetchOllamaModels();
      if (!result) {
        if (!ollamaWasDown) {
          ollamaWasDown = true;
          app.notify('⚠ Ollama is not responding. Check if it is still running.');
        }
      } else if (ollamaWasDown) {
        ollamaWasDown = false;
        app.notify('✓ Ollama is back online.');
      }
    } catch { /* ignore */ }
  }, 30_000);
  // Clean up on exit
  process.on('exit', () => clearInterval(ollamaHealthInterval));

  // Auto-sync learning preferences from cloud if newer — fire-and-forget
  (async () => {
    try {
      const { getSyncToken } = await import('../config/index.js');
      if (!getSyncToken()) return;
      const { pullLearning } = await import('../utils/codeepCloud.js');
      const { loadGlobalPreferences, saveGlobalPreferences } = await import('../utils/learning.js');
      const remote = await pullLearning();
      if (!remote) return;
      const local = loadGlobalPreferences();
      const remoteTs = new Date(remote.updatedAt).getTime();
      if (remoteTs > (local.lastUpdated || 0)) {
        saveGlobalPreferences(remote.preferences as any);
      }
    } catch { /* ignore — best effort */ }
  })();

  const showIntroAnimation = process.stdout.rows >= 20;

  const showPermissionAndContinue = () => {
    app.showPermission(projectPath, isProject, (permission) => {
      if (permission === 'read') {
        setProjectPermission(projectPath, true, false);
        hasWriteAccess = false;
        projectContext = getProjectContext(projectPath);
        if (projectContext) { projectContext.hasWriteAccess = false; setProjectContext(projectContext); }
        app.notify('Read-only access granted');
      } else if (permission === 'write') {
        setProjectPermission(projectPath, true, true);
        hasWriteAccess = true;
        projectContext = getProjectContext(projectPath);
        if (projectContext) { projectContext.hasWriteAccess = true; setProjectContext(projectContext); }
        app.notify('Read & Write access granted');
      } else {
        app.notify('No project access - chat only mode');
      }
      showSessionPickerInline();
    });
  };

  const continueStartup = () => {
    const isManualProject = isManuallyInitializedProject(projectPath);
    if (needsPermissionDialog && !isProject && !isManualProject) {
      app.showConfirm({
        title: 'Set as Project?',
        message: [
          `Current folder: ${projectPath}`,
          '',
          'This folder is not a Git repository.',
          'Would you like to use it as a Codeep project?',
        ],
        confirmLabel: 'Yes, set as project',
        cancelLabel: 'No, chat only',
        onConfirm: () => { initializeAsProject(projectPath); app.notify('Folder initialized as project'); showPermissionAndContinue(); },
        onCancel: () => { app.notify('Chat only mode - no project context'); showSessionPickerInline(); },
      });
    } else if (needsPermissionDialog) {
      showPermissionAndContinue();
    } else {
      showSessionPickerInline();
    }
  };

  if (showIntroAnimation) {
    app.startIntro(continueStartup);
  } else {
    continueStartup();
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown() {
  // Abort any running agent and wait for it to finish (max 5s)
  if (isAgentRunningFlag) {
    agentAbortController?.abort();
    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (!isAgentRunningFlag) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
  }

  // Now restore terminal after agent has fully stopped
  if (app) app.stop();
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log('Goodbye!');

  if (!app) return;

  const messages = app.getMessages();
  autoSaveSession(messages, projectPath);

  const { syncSessionAsync, generateProjectId } = require('../utils/codeepCloud.js');
  const projectId = projectPath ? generateProjectId(projectPath) : undefined;
  // Successful manual and agent turns report their token deltas immediately.
  // Re-sending the cumulative session total here would count every token a
  // second time when the append-only dashboard endpoint stores this event.
  await syncSessionAsync({
    sessionId,
    sessionName: sessionDisplayName || sessionId,
    projectName: projectContext?.name,
    projectId,
    messages,
  });
}

// ─── Last-resort crash handlers ───────────────────────────────────────────────
// Without these, a stray throw or rejected promise (deep in the agent loop or a
// background cloud sync) crashes Node with the terminal still in raw mode +
// alternate screen — leaving the user's shell garbled — or vanishes silently.

process.on('uncaughtException', (error) => {
  logAppError(error instanceof Error ? error : new Error(String(error)), 'uncaughtException');
  // After an uncaught exception the process state is undefined; Node's guidance
  // is to clean up synchronously and exit rather than limp on. Restore the
  // terminal and best-effort save the conversation so the crash doesn't lose it.
  try { if (app) app.stop(); } catch { /* ignore */ }
  try { process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); } catch { /* ignore */ }
  console.error('Fatal error:', error);
  try { if (app) autoSaveSession(app.getMessages(), projectPath); } catch { /* ignore */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logAppError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
  // A rejected promise is usually recoverable (failed background sync, network
  // blip), so surface it and keep the TUI alive instead of tearing it down.
  // Fall back to stderr if the app isn't up yet.
  const message = reason instanceof Error ? reason.message : String(reason);
  if (app) app.notifyWarn(`Background error: ${message}`);
  else console.error('Unhandled rejection:', reason);
});

process.on('SIGINT', () => {
  gracefulShutdown().finally(() => process.exit(0));
});

main().catch((error) => {
  logAppError(error instanceof Error ? error : new Error(String(error)), 'main');
  console.error('Fatal error:', error);
  process.exit(1);
});
