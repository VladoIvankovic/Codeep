#!/usr/bin/env node
/**
 * Codeep with Custom Renderer
 * Main entry point using the new ANSI-based renderer instead of Ink
 */

import { App, Message } from './App';
import { StatusInfo } from './components/Status';
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
    
    default:
      app.notify(`Unknown command: /${command}`);
  }
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
  const apiKey = await loadApiKey();
  
  if (!apiKey) {
    console.error('No API key configured. Run: codeep (with Ink UI) to set up.');
    process.exit(1);
  }
  
  // Check project permissions
  const isProject = isProjectDirectory(projectPath);
  const hasRead = hasReadPermission(projectPath);
  
  if (hasRead) {
    hasWriteAccess = hasWritePermission(projectPath);
    projectContext = getProjectContext(projectPath);
    if (projectContext) {
      projectContext.hasWriteAccess = hasWriteAccess;
      setProjectContext(projectContext);
    }
  }
  
  // Clear screen
  console.clear();
  
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
