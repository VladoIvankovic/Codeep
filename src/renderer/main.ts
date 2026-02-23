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
} from '../config/index';
import {
  isProjectDirectory,
  getProjectContext,
  ProjectContext,
} from '../utils/project';
import { getCurrentVersion, checkForUpdates, getUpdateInstructions } from '../utils/update';
import { getProviderList } from '../config/providers';
import { getSessionStats } from '../utils/tokenTracker';
import { checkApiRateLimit } from '../utils/ratelimit';
import { handleCommand as dispatchCommand, AppCommandContext } from './commands';
import {
  executeAgentTask,
  runAgentTask,
  PendingInteractiveContext,
} from './agentExecution';

// ─── Global state ─────────────────────────────────────────────────────────────

let projectPath = process.cwd();
let projectContext: ProjectContext | null = null;
let hasWriteAccess = false;
let sessionId = getCurrentSessionId();
let app: App;

const addedFiles: Map<string, { relativePath: string; content: string }> = new Map();

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
    abortController: agentAbortController,
    isAgentRunning: () => isAgentRunningFlag,
    setAgentRunning: (v) => { isAgentRunningFlag = v; },
    setAbortController: (ctrl) => { agentAbortController = ctrl; },
    formatAddedFilesContext,
    handleCommand: (cmd, args) => dispatchCommand(cmd, args, makeCtx()),
    setSessionId: (id) => { sessionId = id; },
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
  return {
    version: getCurrentVersion(),
    provider: providerInfo?.name || 'Unknown',
    model: config.get('model'),
    agentMode: config.get('agentMode') || 'off',
    projectPath,
    hasWriteAccess,
    sessionId,
    messageCount: app ? app.getMessages().length : 0,
    tokenStats: {
      totalTokens: stats.totalTokens,
      promptTokens: stats.totalPromptTokens,
      completionTokens: stats.totalCompletionTokens,
      requestCount: stats.requestCount,
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

  try {
    app.startStreaming();
    const history = app.getChatHistory();
    const fileContext = formatAddedFilesContext();
    const enrichedMessage = fileContext ? fileContext + message : message;
    await chat(enrichedMessage, history, (chunk) => app.addStreamChunk(chunk), undefined, projectContext, undefined);
    app.endStreaming();
    autoSaveSession(app.getMessages(), projectPath);
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
              await setApiKey(key);
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

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`Codeep v${getCurrentVersion()}`);
    process.exit(0);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Codeep - AI-powered coding assistant TUI

Usage:
  codeep              Start interactive chat
  codeep acp          Start ACP server (for Zed editor integration)
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

  // ACP server mode — started by Zed via Agent Client Protocol
  if (args[0] === 'acp') {
    await loadAllApiKeys();
    const { startAcpServer } = await import('../acp/server.js');
    await startAcpServer();
    return;
  }

  await loadAllApiKeys();
  let apiKey: string | null = await loadApiKey();

  if (!apiKey) {
    const newKey = await showLoginFlow();
    if (!newKey) { console.log('\nSetup cancelled.'); process.exit(0); }
    apiKey = newKey;
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
    onExit: () => { console.log('\nGoodbye!'); process.exit(0); },
    onStopAgent: () => {
      if (isAgentRunningFlag && agentAbortController) {
        agentAbortController.abort();
        app.notify('Stopping agent...');
      }
    },
    getStatus,
    hasWriteAccess: () => hasWriteAccess,
    hasProjectContext: () => projectContext !== null,
  });

  const provider = getCurrentProvider();
  const providers = getProviderList();
  const providerInfo = providers.find(p => p.id === provider.id);
  const version = getCurrentVersion();
  const model = config.get('model');
  const agentMode = config.get('agentMode') || 'off';

  const welcomeLines: string[] = [`Codeep v${version} • ${providerInfo?.name} • ${model}`, ''];
  if (projectContext) {
    welcomeLines.push(`Project: ${projectPath}`);
    welcomeLines.push(hasWriteAccess
      ? 'Access: Read & Write (Agent enabled)'
      : 'Access: Read Only (/grant to enable Agent)');
  } else {
    welcomeLines.push('Mode: Chat only (no project context)');
  }
  if (agentMode === 'on' && hasWriteAccess) {
    welcomeLines.push('');
    welcomeLines.push('⚠ Agent Mode ON: Messages will auto-execute as agent tasks');
  }
  welcomeLines.push('');
  welcomeLines.push('Shortcuts: /help commands • Ctrl+L clear • Esc cancel');
  app.addMessage({ role: 'system', content: welcomeLines.join('\n') });

  app.start();

  // Check for updates in background — show notify if new version available
  checkForUpdates().then(info => {
    if (info.hasUpdate) {
      app.notify(`Update available: v${info.latest} (current: v${info.current})\nRun: ${getUpdateInstructions()}`);
    }
  }).catch(() => { /* ignore update check failures */ });

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

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
