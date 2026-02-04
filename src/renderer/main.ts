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
  PROTOCOLS,
  LANGUAGES,
  setProvider,
  setApiKey,
  clearApiKey,
  autoSaveSession,
  saveSession,
  startNewSession,
  getCurrentSessionId,
  loadSession,
  listSessionsWithInfo,
  deleteSession,
  renameSession,
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
    
    // Session management
    case 'rename': {
      if (!args.length) {
        app.notify('Usage: /rename <new-name>');
        return;
      }
      const newName = args.join('-');
      if (renameSession(sessionId, newName, projectPath)) {
        sessionId = newName;
        app.notify(`Session renamed to: ${newName}`);
      } else {
        app.notify('Failed to rename session');
      }
      break;
    }
    
    case 'search': {
      if (!args.length) {
        app.notify('Usage: /search <term>');
        return;
      }
      const searchTerm = args.join(' ').toLowerCase();
      const messages = app.getMessages();
      const matches = messages.filter(m => 
        m.content.toLowerCase().includes(searchTerm)
      );
      if (matches.length === 0) {
        app.notify(`No matches for "${searchTerm}"`);
      } else {
        app.addMessage({
          role: 'system',
          content: `Found ${matches.length} message(s) containing "${searchTerm}":\n\n${matches.slice(0, 5).map((m, i) => 
            `${i + 1}. [${m.role}]: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`
          ).join('\n\n')}${matches.length > 5 ? `\n\n...and ${matches.length - 5} more` : ''}`,
        });
      }
      break;
    }
    
    case 'export': {
      const format = args[0] || 'md';
      const messages = app.getMessages();
      if (messages.length === 0) {
        app.notify('No messages to export');
        return;
      }
      
      import('fs').then(fs => {
        import('path').then(path => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          let filename: string;
          let content: string;
          
          if (format === 'json') {
            filename = `codeep-export-${timestamp}.json`;
            content = JSON.stringify(messages, null, 2);
          } else if (format === 'txt') {
            filename = `codeep-export-${timestamp}.txt`;
            content = messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}\n`).join('\n---\n\n');
          } else {
            filename = `codeep-export-${timestamp}.md`;
            content = `# Codeep Chat Export\n\n${messages.map(m => 
              `## ${m.role === 'user' ? '👤 User' : m.role === 'assistant' ? '🤖 Assistant' : '⚙️ System'}\n\n${m.content}\n`
            ).join('\n---\n\n')}`;
          }
          
          const exportPath = path.join(projectPath, filename);
          fs.writeFileSync(exportPath, content);
          app.notify(`Exported to ${filename}`);
        });
      });
      break;
    }
    
    // Protocol and language
    case 'protocol': {
      const protocols = Object.entries(PROTOCOLS);
      app.showList('Select Protocol', protocols.map(([, name]) => name), (index) => {
        const selected = protocols[index][0];
        config.set('protocol', selected);
        app.notify(`Protocol: ${protocols[index][1]}`);
      });
      break;
    }
    
    case 'lang': {
      const languages = Object.entries(LANGUAGES);
      app.showList('Select Language', languages.map(([, name]) => name), (index) => {
        const selected = languages[index][0];
        config.set('language', selected);
        app.notify(`Language: ${languages[index][1]}`);
      });
      break;
    }
    
    // Login/Logout
    case 'login': {
      showLoginFlow().then(key => {
        if (key) {
          app.notify('Logged in successfully');
        }
      });
      break;
    }
    
    case 'logout': {
      const providers = getProviderList();
      app.showList('Logout from', providers.map(p => p.name), (index) => {
        const selected = providers[index];
        clearApiKey(selected.id);
        app.notify(`Logged out from ${selected.name}`);
      });
      break;
    }
    
    // Git commit
    case 'git-commit': {
      const message = args.join(' ');
      if (!message) {
        app.notify('Usage: /git-commit <message>');
        return;
      }
      
      import('child_process').then(({ execSync }) => {
        try {
          execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { 
            cwd: projectPath,
            encoding: 'utf-8',
          });
          app.notify('Committed successfully');
        } catch (err) {
          app.notify(`Commit failed: ${(err as Error).message}`);
        }
      });
      break;
    }
    
    // Code block operations
    case 'copy': {
      const blockNum = args[0] ? parseInt(args[0], 10) : -1;
      const messages = app.getMessages();
      
      // Find code blocks in messages
      const codeBlocks: string[] = [];
      for (const msg of messages) {
        const matches = msg.content.matchAll(/```[\w]*\n([\s\S]*?)```/g);
        for (const match of matches) {
          codeBlocks.push(match[1]);
        }
      }
      
      if (codeBlocks.length === 0) {
        app.notify('No code blocks found');
        return;
      }
      
      const index = blockNum === -1 ? codeBlocks.length - 1 : blockNum - 1;
      if (index < 0 || index >= codeBlocks.length) {
        app.notify(`Invalid block number. Available: 1-${codeBlocks.length}`);
        return;
      }
      
      import('../utils/clipboard').then(({ copyToClipboard }) => {
        if (copyToClipboard(codeBlocks[index])) {
          app.notify(`Copied block ${index + 1} to clipboard`);
        } else {
          app.notify('Failed to copy to clipboard');
        }
      }).catch(() => {
        app.notify('Clipboard not available');
      });
      break;
    }
    
    case 'paste': {
      import('../utils/clipboard').then(({ readFromClipboard }) => {
        const content = readFromClipboard();
        if (content) {
          const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
          const lines = content.split('\n').length;
          app.addMessage({
            role: 'system',
            content: `📋 Clipboard (${content.length} chars, ${lines} lines):\n\`\`\`\n${preview}\n\`\`\``,
          });
          // Add to user input or directly submit
          app.notify('Paste preview shown. Type message to send with content.');
        } else {
          app.notify('Clipboard is empty');
        }
      }).catch(() => {
        app.notify('Clipboard not available');
      });
      break;
    }
    
    case 'apply': {
      const messages = app.getMessages();
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      
      if (!lastAssistant) {
        app.notify('No assistant response to apply');
        return;
      }
      
      // Find file changes in the response
      const filePattern = /```(\w+)?\s*\n\/\/\s*(?:File:|Path:)\s*([^\n]+)\n([\s\S]*?)```/g;
      const changes: Array<{ path: string; content: string }> = [];
      
      let match;
      while ((match = filePattern.exec(lastAssistant.content)) !== null) {
        changes.push({ path: match[2].trim(), content: match[3] });
      }
      
      if (changes.length === 0) {
        app.notify('No file changes found in response');
        return;
      }
      
      if (!hasWriteAccess) {
        app.notify('Write access required. Use /grant first.');
        return;
      }
      
      import('fs').then(fs => {
        import('path').then(path => {
          let applied = 0;
          for (const change of changes) {
            try {
              const fullPath = path.isAbsolute(change.path) 
                ? change.path 
                : path.join(projectPath, change.path);
              fs.mkdirSync(path.dirname(fullPath), { recursive: true });
              fs.writeFileSync(fullPath, change.content);
              applied++;
            } catch (err) {
              // Skip failed writes
            }
          }
          app.notify(`Applied ${applied}/${changes.length} file(s)`);
        });
      });
      break;
    }
    
    // Agent history and changes
    case 'history': {
      import('../utils/agent').then(({ getAgentHistory }) => {
        const history = getAgentHistory();
        if (history.length === 0) {
          app.notify('No agent history');
          return;
        }
        
        const items = history.slice(0, 10).map(h => 
          `${new Date(h.timestamp).toLocaleString()} - ${h.task.slice(0, 30)}...`
        );
        app.showList('Agent History', items, (index) => {
          const selected = history[index];
          app.addMessage({
            role: 'system',
            content: `# Agent Session\n\n**Task:** ${selected.task}\n**Actions:** ${selected.actions.length}\n**Status:** ${selected.success ? '✓ Success' : '✗ Failed'}`,
          });
        });
      }).catch(() => {
        app.notify('No agent history available');
      });
      break;
    }
    
    case 'changes': {
      import('../utils/agent').then(({ getCurrentSessionActions }) => {
        const actions = getCurrentSessionActions();
        if (actions.length === 0) {
          app.notify('No changes in current session');
          return;
        }
        
        const summary = actions.map(a => 
          `• ${a.type}: ${a.target} (${a.result})`
        ).join('\n');
        
        app.addMessage({
          role: 'system',
          content: `# Session Changes\n\n${summary}`,
        });
      }).catch(() => {
        app.notify('No changes tracked');
      });
      break;
    }
    
    // Context persistence
    case 'context-save': {
      const messages = app.getMessages();
      if (saveSession(`context-${sessionId}`, messages, projectPath)) {
        app.notify('Context saved');
      } else {
        app.notify('Failed to save context');
      }
      break;
    }
    
    case 'context-load': {
      const contextName = `context-${sessionId}`;
      const loaded = loadSession(contextName, projectPath);
      if (loaded) {
        app.setMessages(loaded as Message[]);
        app.notify('Context loaded');
      } else {
        app.notify('No saved context found');
      }
      break;
    }
    
    case 'context-clear': {
      deleteSession(`context-${sessionId}`, projectPath);
      app.notify('Context cleared');
      break;
    }
    
    // Learning mode
    case 'learn': {
      if (args[0] === 'status') {
        import('../utils/learning').then(({ getLearningStatus }) => {
          const status = getLearningStatus(projectPath);
          app.addMessage({
            role: 'system',
            content: `# Learning Status\n\n${status}`,
          });
        }).catch(() => {
          app.notify('Learning module not available');
        });
        return;
      }
      
      if (args[0] === 'rule' && args.length > 1) {
        import('../utils/learning').then(({ addCustomRule }) => {
          addCustomRule(projectPath, args.slice(1).join(' '));
          app.notify('Custom rule added');
        }).catch(() => {
          app.notify('Learning module not available');
        });
        return;
      }
      
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      
      app.notify('Learning from project...');
      import('../utils/learning').then(({ learnFromProject, formatPreferencesForPrompt }) => {
        // Get some source files to learn from
        import('fs').then(fs => {
          import('path').then(path => {
            const files: string[] = [];
            const extensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs'];
            
            const walkDir = (dir: string, depth = 0) => {
              if (depth > 3 || files.length >= 20) return;
              try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                  const fullPath = path.join(dir, entry.name);
                  if (entry.isDirectory()) {
                    walkDir(fullPath, depth + 1);
                  } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                    files.push(path.relative(projectContext!.root, fullPath));
                  }
                  if (files.length >= 20) break;
                }
              } catch {}
            };
            
            walkDir(projectContext!.root);
            
            if (files.length === 0) {
              app.notify('No source files found to learn from');
              return;
            }
            
            const prefs = learnFromProject(projectContext!.root, files);
            const formatted = formatPreferencesForPrompt(prefs);
            app.addMessage({
              role: 'system',
              content: `# Learned Preferences\n\n${formatted}`,
            });
            app.notify(`Learned from ${files.length} files`);
          });
        });
      }).catch(() => {
        app.notify('Learning module not available');
      });
      break;
    }
    
    // Skills shortcuts
    case 'c': {
      handleCommand('commit', []);
      break;
    }
    
    case 't': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      app.addMessage({ role: 'user', content: '/test' });
      handleSubmit('Generate and run tests for the current project. Focus on untested code.');
      break;
    }
    
    case 'd': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      app.addMessage({ role: 'user', content: '/docs' });
      handleSubmit('Add documentation to the code. Focus on functions and classes that lack proper documentation.');
      break;
    }
    
    case 'r': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      app.addMessage({ role: 'user', content: '/refactor' });
      handleSubmit('Refactor the code to improve quality, readability, and maintainability.');
      break;
    }
    
    case 'f': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      app.addMessage({ role: 'user', content: '/fix' });
      handleSubmit('Debug and fix any issues in the current code. Look for bugs, errors, and potential problems.');
      break;
    }
    
    case 'e': {
      if (!args.length) {
        app.notify('Usage: /e <file or code to explain>');
        return;
      }
      app.addMessage({ role: 'user', content: `/explain ${args.join(' ')}` });
      handleSubmit(`Explain this code or concept: ${args.join(' ')}`);
      break;
    }
    
    case 'o': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      app.addMessage({ role: 'user', content: '/optimize' });
      handleSubmit('Optimize the code for better performance. Focus on efficiency and speed improvements.');
      break;
    }
    
    case 'b': {
      if (!projectContext) {
        app.notify('No project context');
        return;
      }
      app.addMessage({ role: 'user', content: '/debug' });
      handleSubmit('Help debug the current issue. Analyze the code and identify the root cause of problems.');
      break;
    }
    
    case 'p': {
      // Push shortcut
      import('child_process').then(({ execSync }) => {
        try {
          execSync('git push', { cwd: projectPath, encoding: 'utf-8' });
          app.notify('Pushed successfully');
        } catch (err) {
          app.notify(`Push failed: ${(err as Error).message}`);
        }
      });
      break;
    }
    
    // Full skill names
    case 'test':
    case 'docs':
    case 'refactor':
    case 'fix':
    case 'explain':
    case 'optimize':
    case 'debug': {
      const skillMap: Record<string, string> = {
        test: 't',
        docs: 'd',
        refactor: 'r',
        fix: 'f',
        explain: 'e',
        optimize: 'o',
        debug: 'b',
      };
      handleCommand(skillMap[command], args);
      break;
    }
    
    case 'push': {
      handleCommand('p', args);
      break;
    }
    
    case 'pull': {
      import('child_process').then(({ execSync }) => {
        try {
          execSync('git pull', { cwd: projectPath, encoding: 'utf-8' });
          app.notify('Pulled successfully');
        } catch (err) {
          app.notify(`Pull failed: ${(err as Error).message}`);
        }
      });
      break;
    }
    
    case 'skills': {
      const query = args.join(' ').toLowerCase();
      const allSkills = [
        { name: 'commit', shortcut: 'c', desc: 'Generate commit message' },
        { name: 'test', shortcut: 't', desc: 'Generate/run tests' },
        { name: 'docs', shortcut: 'd', desc: 'Add documentation' },
        { name: 'refactor', shortcut: 'r', desc: 'Improve code quality' },
        { name: 'fix', shortcut: 'f', desc: 'Debug and fix issues' },
        { name: 'explain', shortcut: 'e', desc: 'Explain code' },
        { name: 'optimize', shortcut: 'o', desc: 'Optimize performance' },
        { name: 'debug', shortcut: 'b', desc: 'Debug problems' },
        { name: 'push', shortcut: 'p', desc: 'Git push' },
        { name: 'pull', shortcut: '-', desc: 'Git pull' },
        { name: 'diff', shortcut: '-', desc: 'Review git diff' },
        { name: 'review', shortcut: '-', desc: 'Code review' },
        { name: 'scan', shortcut: '-', desc: 'Scan project' },
      ];
      
      const filtered = query 
        ? allSkills.filter(s => s.name.includes(query) || s.desc.toLowerCase().includes(query))
        : allSkills;
      
      if (filtered.length === 0) {
        app.notify(`No skills matching "${query}"`);
        return;
      }
      
      app.addMessage({
        role: 'system',
        content: `# Available Skills\n\n${filtered.map(s => 
          `• **/${s.name}**${s.shortcut !== '-' ? ` (/${s.shortcut})` : ''} - ${s.desc}`
        ).join('\n')}`,
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
