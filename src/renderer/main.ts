#!/usr/bin/env node
/**
 * Codeep with Custom Renderer
 * Main entry point using the new ANSI-based renderer instead of Ink
 */

import { App, Message } from './App';
import { Screen } from './Screen';
import { Input, KeyEvent } from './Input';
import { StatusInfo } from './components/Status';
import { LoginScreen, renderProviderSelect } from './components/Login';
import { renderPermissionScreen, getPermissionOptions, PermissionLevel } from './components/Permission';
import { showIntro } from './components/Intro';
import { chat, setProjectContext } from '../api/index';
import { runAgent, AgentResult } from '../utils/agent';
import { ActionLog } from '../utils/tools';
import { 
  config, 
  isConfigured,
  loadApiKey,
  loadAllApiKeys,
  getCurrentProvider,
  getModelsForCurrentProvider,
  PROVIDERS,
  setProvider,
  setApiKey,
  autoSaveSession,
  startNewSession,
  getCurrentSessionId,
  loadSession,
  listSessionsWithInfo,
  hasReadPermission,
  hasWritePermission,
  setProjectPermission,
} from '../config/index';
import { 
  isProjectDirectory, 
  getProjectContext, 
  ProjectContext 
} from '../utils/project';
import { getCurrentVersion } from '../utils/update';
import { getProviderList } from '../config/providers';

// State
let projectPath = process.cwd();
let projectContext: ProjectContext | null = null;
let hasWriteAccess = false;
let sessionId = getCurrentSessionId();
let app: App;

/**
 * Get current status
 */
function getStatus(): StatusInfo {
  const provider = getCurrentProvider();
  const providers = getProviderList();
  const providerInfo = providers.find(p => p.id === provider.id);
  
  return {
    version: getCurrentVersion(),
    provider: providerInfo?.name || 'Unknown',
    model: config.get('model'),
    agentMode: config.get('agentMode') || 'off',
    projectPath,
    hasWriteAccess,
    sessionId,
    messageCount: 0, // Will be updated
  };
}

// Agent state
let isAgentRunning = false;
let agentAbortController: AbortController | null = null;

/**
 * Handle chat submission
 */
async function handleSubmit(message: string): Promise<void> {
  try {
    app.startStreaming();
    
    // Get conversation history for context
    const history = app.getChatHistory();
    
    const response = await chat(
      message,
      history,
      (chunk) => {
        app.addStreamChunk(chunk);
      },
      undefined,
      projectContext,
      undefined
    );
    
    app.endStreaming();
    
    // Auto-save session
    autoSaveSession(app.getMessages(), projectPath);
    
  } catch (error) {
    app.endStreaming();
    const err = error as Error;
    app.notify(`Error: ${err.message}`, 5000);
  }
}

/**
 * Run agent with task
 */
async function runAgentTask(task: string, dryRun: boolean = false): Promise<void> {
  if (!projectContext) {
    app.notify('Agent requires project context');
    return;
  }
  
  if (!hasWriteAccess && !dryRun) {
    app.notify('Agent requires write access. Use /grant first.');
    return;
  }
  
  isAgentRunning = true;
  agentAbortController = new AbortController();
  
  // Add user message
  const prefix = dryRun ? '[DRY RUN] ' : '[AGENT] ';
  app.addMessage({ role: 'user', content: prefix + task });
  
  app.setLoading(true);
  app.notify('Agent starting...', 2000);
  
  let currentStep = 0;
  const actions: ActionLog[] = [];
  
  try {
    const result = await runAgent(task, projectContext, {
      dryRun,
      onIteration: (iteration) => {
        currentStep = iteration;
        app.notify(`Agent step ${iteration}...`, 1000);
      },
      onToolCall: (tool) => {
        const toolName = tool.tool.toLowerCase();
        const target = (tool.parameters.path as string) || 
                      (tool.parameters.command as string) || 
                      (tool.parameters.pattern as string) || '';
        app.notify(`${toolName}: ${target.split('/').pop() || target}`, 1500);
      },
      onToolResult: (result, toolCall) => {
        // Track action
        const action: ActionLog = {
          type: toolCall.tool.toLowerCase().includes('write') ? 'write' :
                toolCall.tool.toLowerCase().includes('edit') ? 'edit' :
                toolCall.tool.toLowerCase().includes('read') ? 'read' :
                toolCall.tool.toLowerCase().includes('delete') ? 'delete' :
                toolCall.tool.toLowerCase().includes('command') ? 'command' : 'command',
          target: (toolCall.parameters.path as string) || (toolCall.parameters.command as string) || '',
          result: result.success ? 'success' : 'error',
          timestamp: Date.now(),
        };
        actions.push(action);
      },
      onThinking: () => {
        // Could show thinking indicator
      },
      abortSignal: agentAbortController.signal,
    });
    
    // Show result
    if (result.success) {
      const summary = result.finalResponse || `Completed ${result.actions.length} actions in ${result.iterations} steps.`;
      app.addMessage({ role: 'assistant', content: summary });
      app.notify(`Agent completed: ${result.actions.length} actions`);
    } else if (result.aborted) {
      app.addMessage({ role: 'assistant', content: 'Agent stopped by user.' });
      app.notify('Agent stopped');
    } else {
      app.addMessage({ role: 'assistant', content: `Agent failed: ${result.error}` });
      app.notify(`Agent failed: ${result.error}`);
    }
    
    // Auto-save
    autoSaveSession(app.getMessages(), projectPath);
    
  } catch (error) {
    const err = error as Error;
    app.addMessage({ role: 'assistant', content: `Agent error: ${err.message}` });
    app.notify(`Agent error: ${err.message}`, 5000);
  } finally {
    isAgentRunning = false;
    agentAbortController = null;
    app.setLoading(false);
  }
}

/**
 * Handle commands
 */
function handleCommand(command: string, args: string[]): void {
  switch (command) {
    case 'version': {
      const version = getCurrentVersion();
      const provider = getCurrentProvider();
      const providers = getProviderList();
      const providerInfo = providers.find(p => p.id === provider.id);
      app.notify(`Codeep v${version} • ${providerInfo?.name} • ${config.get('model')}`);
      break;
    }
    
    case 'provider': {
      const providers = getProviderList();
      const providerNames = providers.map(p => p.name);
      app.showList('Select Provider', providerNames, (index) => {
        const selected = providers[index];
        if (setProvider(selected.id)) {
          app.notify(`Provider: ${selected.name}`);
        }
      });
      break;
    }
    
    case 'model': {
      const models = getModelsForCurrentProvider();
      const modelNames = Object.keys(models);
      app.showList('Select Model', modelNames, (index) => {
        const selected = modelNames[index];
        config.set('model', selected);
        app.notify(`Model: ${selected}`);
      });
      break;
    }
    
    case 'grant': {
      // Grant write permission
      setProjectPermission(projectPath, true, true);
      hasWriteAccess = true;
      projectContext = getProjectContext(projectPath);
      if (projectContext) {
        projectContext.hasWriteAccess = true;
        setProjectContext(projectContext);
      }
      app.notify('Write access granted');
      break;
    }
    
    case 'agent': {
      if (!args.length) {
        app.notify('Usage: /agent <task>');
        return;
      }
      if (isAgentRunning) {
        app.notify('Agent already running. Use /stop to cancel.');
        return;
      }
      runAgentTask(args.join(' '), false);
      break;
    }
    
    case 'agent-dry': {
      if (!args.length) {
        app.notify('Usage: /agent-dry <task>');
        return;
      }
      if (isAgentRunning) {
        app.notify('Agent already running. Use /stop to cancel.');
        return;
      }
      runAgentTask(args.join(' '), true);
      break;
    }
    
    case 'stop': {
      if (isAgentRunning && agentAbortController) {
        agentAbortController.abort();
        app.notify('Stopping agent...');
      } else {
        app.notify('No agent running');
      }
      break;
    }
    
    case 'sessions': {
      // List recent sessions
      const sessions = listSessionsWithInfo(projectPath);
      if (sessions.length === 0) {
        app.notify('No saved sessions');
        return;
      }
      app.showList('Load Session', sessions.map(s => s.name), (index) => {
        const selected = sessions[index];
        const loaded = loadSession(selected.name, projectPath);
        if (loaded) {
          app.setMessages(loaded as Message[]);
          sessionId = selected.name;
          app.notify(`Loaded: ${selected.name}`);
        } else {
          app.notify('Failed to load session');
        }
      });
      break;
    }
    
    case 'new': {
      app.clearMessages();
      sessionId = startNewSession();
      app.notify('New session started');
      break;
    }
    
    case 'settings': {
      app.notify('Settings: /provider, /model, /grant');
      break;
    }
    
    case 'diff': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      const staged = args.includes('--staged') || args.includes('-s');
      app.notify(staged ? 'Getting staged diff...' : 'Getting diff...');
      
      // Import dynamically to avoid circular deps
      import('../utils/git').then(({ getGitDiff, formatDiffForDisplay }) => {
        const result = getGitDiff(staged, projectPath);
        if (!result.success || !result.diff) {
          app.notify(result.error || 'No changes');
          return;
        }
        
        const preview = formatDiffForDisplay(result.diff, 50);
        app.addMessage({ role: 'user', content: `/diff ${staged ? '--staged' : ''}` });
        
        // Send to AI for review
        handleSubmit(`Review this git diff and provide feedback:\n\n\`\`\`diff\n${preview}\n\`\`\``);
      });
      break;
    }
    
    case 'commit': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      
      import('../utils/git').then(({ getGitDiff, getGitStatus, suggestCommitMessage }) => {
        const status = getGitStatus(projectPath);
        if (!status.isRepo) {
          app.notify('Not a git repository');
          return;
        }
        
        const diff = getGitDiff(true, projectPath);
        if (!diff.success || !diff.diff) {
          app.notify('No staged changes. Use git add first.');
          return;
        }
        
        const suggestion = suggestCommitMessage(diff.diff);
        app.addMessage({ role: 'user', content: '/commit' });
        handleSubmit(`Generate a commit message for these staged changes. Suggestion: "${suggestion}"\n\nDiff:\n\`\`\`diff\n${diff.diff.slice(0, 2000)}\n\`\`\``);
      });
      break;
    }
    
    case 'undo': {
      import('../utils/agent').then(({ undoLastAction }) => {
        const result = undoLastAction();
        app.notify(result.success ? `Undo: ${result.message}` : `Cannot undo: ${result.message}`);
      });
      break;
    }
    
    case 'undo-all': {
      import('../utils/agent').then(({ undoAllActions }) => {
        const result = undoAllActions();
        app.notify(result.success ? `Undone ${result.results.length} action(s)` : 'Nothing to undo');
      });
      break;
    }
    
    case 'scan': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      
      app.notify('Scanning project...');
      import('../utils/projectIntelligence').then(({ scanProject, saveProjectIntelligence, generateContextFromIntelligence }) => {
        scanProject(projectContext!.root).then(intelligence => {
          saveProjectIntelligence(projectContext!.root, intelligence);
          const context = generateContextFromIntelligence(intelligence);
          app.addMessage({
            role: 'assistant',
            content: `# Project Scan Complete\n\n${context}`,
          });
          app.notify(`Scanned: ${intelligence.structure.totalFiles} files`);
        }).catch(err => {
          app.notify(`Scan failed: ${err.message}`);
        });
      });
      break;
    }
    
    case 'review': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      
      import('../utils/codeReview').then(({ performCodeReview, formatReviewResult }) => {
        const reviewFiles = args.length > 0 ? args : undefined;
        const result = performCodeReview(projectContext!, reviewFiles);
        app.addMessage({
          role: 'assistant',
          content: formatReviewResult(result),
        });
      });
      break;
    }
    
    case 'update': {
      app.notify('Checking for updates...');
      import('../utils/update').then(({ checkForUpdates, formatVersionInfo }) => {
        checkForUpdates().then(info => {
          const message = formatVersionInfo(info);
          app.notify(message.split('\n')[0], 5000);
        }).catch(() => {
          app.notify('Failed to check for updates');
        });
      });
      break;
    }
    
    default:
      app.notify(`Unknown command: /${command}`);
  }
}

/**
 * Show login flow for API key setup
 */
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
    
    const cleanup = () => {
      input.stop();
      screen.cleanup();
    };
    
    const renderCurrentStep = () => {
      if (currentStep === 'provider') {
        renderProviderSelect(screen, providers, selectedProviderIndex);
      } else if (loginScreen) {
        loginScreen.render();
      }
    };
    
    input.onKey((event: KeyEvent) => {
      if (currentStep === 'provider') {
        // Provider selection
        if (event.key === 'up') {
          selectedProviderIndex = Math.max(0, selectedProviderIndex - 1);
          renderCurrentStep();
        } else if (event.key === 'down') {
          selectedProviderIndex = Math.min(providers.length - 1, selectedProviderIndex + 1);
          renderCurrentStep();
        } else if (event.key === 'enter') {
          selectedProvider = providers[selectedProviderIndex];
          setProvider(selectedProvider.id);
          
          // Move to API key entry
          currentStep = 'apikey';
          loginScreen = new LoginScreen(screen, input, {
            providerName: selectedProvider.name,
            error: loginError,
            onSubmit: async (key) => {
              // Validate and save key
              if (key.length < 10) {
                loginError = 'API key too short';
                loginScreen = new LoginScreen(screen, input, {
                  providerName: selectedProvider.name,
                  error: loginError,
                  onSubmit: () => {},
                  onCancel: () => {
                    cleanup();
                    resolve(null);
                  },
                });
                renderCurrentStep();
                return;
              }
              
              // Save the key
              await setApiKey(key);
              cleanup();
              resolve(key);
            },
            onCancel: () => {
              // Go back to provider selection
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
    
    // Initial render
    renderCurrentStep();
  });
}

/**
 * Show permission screen
 */
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
    
    const cleanup = () => {
      input.stop();
      screen.cleanup();
    };
    
    const render = () => {
      renderPermissionScreen(screen, {
        projectPath,
        isProject,
        currentPermission,
        onSelect: () => {},
        onCancel: () => {},
      }, selectedIndex);
    };
    
    input.onKey((event: KeyEvent) => {
      if (event.key === 'up') {
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
      } else if (event.key === 'down') {
        selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
        render();
      } else if (event.key === 'enter') {
        const selected = options[selectedIndex];
        cleanup();
        resolve(selected);
      } else if (event.key === 'escape') {
        cleanup();
        resolve('none');
      }
    });
    
    render();
  });
}

/**
 * Initialize and start
 */
async function main(): Promise<void> {
  // Handle CLI flags
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
  
  // Load API keys
  await loadAllApiKeys();
  let apiKey: string | null = await loadApiKey();
  
  // If no API key, show login screen
  if (!apiKey) {
    const newKey = await showLoginFlow();
    if (!newKey) {
      console.log('\nSetup cancelled.');
      process.exit(0);
    }
    apiKey = newKey;
  }
  
  // Check project permissions
  const isProject = isProjectDirectory(projectPath);
  let hasRead = hasReadPermission(projectPath);
  
  // If no permission yet, show permission screen
  if (!hasRead && isProject) {
    const permission = await showPermissionFlow();
    
    if (permission === 'read') {
      setProjectPermission(projectPath, true, false);
      hasRead = true;
      hasWriteAccess = false;
    } else if (permission === 'write') {
      setProjectPermission(projectPath, true, true);
      hasRead = true;
      hasWriteAccess = true;
    }
    // 'none' - continue without access
    
    console.clear();
  }
  
  if (hasRead) {
    hasWriteAccess = hasWritePermission(projectPath);
    projectContext = getProjectContext(projectPath);
    if (projectContext) {
      projectContext.hasWriteAccess = hasWriteAccess;
      setProjectContext(projectContext);
    }
  }
  
  // Show intro animation
  const introScreen = new Screen();
  introScreen.init();
  await showIntro(introScreen, 1200);
  introScreen.cleanup();
  
  // Create and start app
  app = new App({
    onSubmit: handleSubmit,
    onCommand: handleCommand,
    onExit: () => {
      console.log('\nGoodbye!');
      process.exit(0);
    },
    getStatus,
  });
  
  // Welcome message
  const provider = getCurrentProvider();
  const providers = getProviderList();
  const providerInfo = providers.find(p => p.id === provider.id);
  
  app.addMessage({
    role: 'system',
    content: `Codeep v${getCurrentVersion()} • ${providerInfo?.name} • ${config.get('model')}\n\nType a message or /help for commands.${!hasWriteAccess ? '\n\n⚠️  Read-only mode. Use /grant for write access.' : ''}`,
  });
  
  app.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
