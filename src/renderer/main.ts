#!/usr/bin/env node
/**
 * Codeep with Custom Renderer
 * Main entry point using the new ANSI-based renderer instead of Ink
 */

import { App } from './App';
import { StatusInfo } from './components/Status';
import { chat, setProjectContext } from '../api/index';
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

/**
 * Handle chat submission
 */
async function handleSubmit(message: string): Promise<void> {
  try {
    app.startStreaming();
    
    // Get current messages for history (would need to track this)
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    
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
    
  } catch (error) {
    app.endStreaming();
    const err = error as Error;
    app.notify(`Error: ${err.message}`, 5000);
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
      if (!hasWriteAccess) {
        app.notify('Agent requires write access. Use /grant first.');
        return;
      }
      // TODO: Implement agent mode
      app.notify('Agent mode coming soon...');
      break;
    }
    
    case 'sessions': {
      // TODO: Implement session picker
      app.notify('Session management coming soon...');
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
