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
// Intro animation is now handled by App.startIntro()
import { chat, setProjectContext } from '../api/index';
import { runAgent, AgentResult } from '../utils/agent';
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
  getApiKey,
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
  initializeAsProject,
  isManuallyInitializedProject,
} from '../config/index';
import { 
  isProjectDirectory, 
  getProjectContext, 
  ProjectContext 
} from '../utils/project';
import { getCurrentVersion } from '../utils/update';
import { getProviderList, getProvider } from '../config/providers';
import { getSessionStats } from '../utils/tokenTracker';
import { checkApiRateLimit } from '../utils/ratelimit';

// State
let projectPath = process.cwd();
let projectContext: ProjectContext | null = null;
let hasWriteAccess = false;
let sessionId = getCurrentSessionId();
let app: App;

// Added file context (/add, /drop)
const addedFiles: Map<string, { relativePath: string; content: string }> = new Map();

/**
 * Get current status
 */
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

// Agent state
let isAgentRunning = false;
let agentAbortController: AbortController | null = null;

/**
 * Format added files as context to prepend to user messages
 */
function formatAddedFilesContext(): string {
  if (addedFiles.size === 0) return '';
  const parts: string[] = ['[Attached files]'];
  for (const [, file] of addedFiles) {
    parts.push(`\nFile: ${file.relativePath}\n\`\`\`\n${file.content}\n\`\`\``);
  }
  return parts.join('\n') + '\n\n';
}

async function handleSubmit(message: string): Promise<void> {
  // Check if we're waiting for interactive mode answers
  if (pendingInteractiveContext) {
    const { parseAnswers, enhancePromptWithAnswers } = await import('../utils/interactive');
    const answers = parseAnswers(message, pendingInteractiveContext.context);
    
    // Enhance the original prompt with user's answers
    const enhancedTask = enhancePromptWithAnswers(
      pendingInteractiveContext.context,
      answers
    );
    
    const dryRun = pendingInteractiveContext.dryRun;
    pendingInteractiveContext = null;
    
    // Now run the agent with the enhanced task
    // Skip interactive analysis this time by going straight to confirmation check
    const confirmationMode = config.get('agentConfirmation') || 'dangerous';
    
    if (confirmationMode === 'never' || dryRun) {
      executeAgentTask(enhancedTask, dryRun);
      return;
    }
    
    // For 'always' or 'dangerous', show confirmation if needed
    if (confirmationMode === 'always') {
      const shortTask = enhancedTask.length > 60 ? enhancedTask.slice(0, 57) + '...' : enhancedTask;
      app.showConfirm({
        title: '⚠️  Confirm Agent Task',
        message: [
          'Run agent with enhanced task?',
          '',
          `  "${shortTask}"`,
        ],
        confirmLabel: 'Run Agent',
        cancelLabel: 'Cancel',
        onConfirm: () => executeAgentTask(enhancedTask, dryRun),
        onCancel: () => app.notify('Agent task cancelled'),
      });
      return;
    }
    
    // 'dangerous' mode - check for dangerous keywords
    const dangerousKeywords = ['delete', 'remove', 'drop', 'reset', 'force', 'overwrite', 'replace all', 'rm ', 'clear'];
    const taskLower = enhancedTask.toLowerCase();
    const hasDangerousKeyword = dangerousKeywords.some(k => taskLower.includes(k));
    
    if (hasDangerousKeyword) {
      const shortTask = enhancedTask.length > 60 ? enhancedTask.slice(0, 57) + '...' : enhancedTask;
      app.showConfirm({
        title: '⚠️  Potentially Dangerous Task',
        message: [
          'This task contains potentially dangerous operations:',
          '',
          `  "${shortTask}"`,
        ],
        confirmLabel: 'Proceed',
        cancelLabel: 'Cancel',
        onConfirm: () => executeAgentTask(enhancedTask, dryRun),
        onCancel: () => app.notify('Agent task cancelled'),
      });
      return;
    }
    
    executeAgentTask(enhancedTask, dryRun);
    return;
  }
  
  // Check if Agent Mode is ON - auto run agent for every message
  const agentMode = config.get('agentMode') || 'off';
  
  if (agentMode === 'on' && projectContext && hasWriteAccess && !isAgentRunning) {
    // Auto-run agent mode
    runAgentTask(message, false);
    return;
  }
  
  // Check API rate limit
  const rateCheck = checkApiRateLimit();
  if (!rateCheck.allowed) {
    app.notify(rateCheck.message || 'Rate limit exceeded', 5000);
    return;
  }

  try {
    app.startStreaming();
    
    // Get conversation history for context
    const history = app.getChatHistory();
    
    // Prepend added file context if any
    const fileContext = formatAddedFilesContext();
    const enrichedMessage = fileContext ? fileContext + message : message;
    
    const response = await chat(
      enrichedMessage,
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
    const err = error as any;
    // Don't show error for user-cancelled requests
    if (err.name === 'AbortError') return;
    app.notify(`Error: ${err.message}`, 5000);
  }
}

// Dangerous tool patterns that require confirmation
const DANGEROUS_TOOLS = ['write', 'edit', 'delete', 'command', 'execute', 'shell', 'rm', 'mv'];

/**
 * Check if a tool call is considered dangerous
 */
function isDangerousTool(toolName: string, parameters: Record<string, unknown>): boolean {
  const lowerName = toolName.toLowerCase();
  
  // Check for dangerous tool names
  if (DANGEROUS_TOOLS.some(d => lowerName.includes(d))) {
    return true;
  }
  
  // Check for dangerous commands
  const command = (parameters.command as string) || '';
  const dangerousCommands = ['rm ', 'rm -', 'rmdir', 'del ', 'delete', 'drop ', 'truncate'];
  if (dangerousCommands.some(c => command.toLowerCase().includes(c))) {
    return true;
  }
  
  return false;
}

/**
 * Request confirmation for a tool call
 */
function requestToolConfirmation(
  tool: string, 
  parameters: Record<string, unknown>,
  onConfirm: () => void,
  onCancel: () => void
): void {
  const target = (parameters.path as string) || 
                (parameters.command as string) || 
                (parameters.pattern as string) || 
                'unknown';
  
  const shortTarget = target.length > 50 ? '...' + target.slice(-47) : target;
  
  app.showConfirm({
    title: '⚠️  Confirm Action',
    message: [
      `The agent wants to execute:`,
      '',
      `  ${tool}`,
      `  ${shortTarget}`,
      '',
      'Allow this action?',
    ],
    confirmLabel: 'Allow',
    cancelLabel: 'Deny',
    onConfirm,
    onCancel,
  });
}

// Store context for interactive mode follow-up
let pendingInteractiveContext: {
  originalTask: string;
  context: import('../utils/interactive').InteractiveContext;
  dryRun: boolean;
} | null = null;

/**
 * Run agent with task - handles confirmation dialogs based on settings
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
  
  if (isAgentRunning) {
    app.notify('Agent already running. Use /stop to cancel.');
    return;
  }
  
  // Check interactive mode setting
  const interactiveMode = config.get('agentInteractive') !== false;
  
  if (interactiveMode) {
    // Analyze task for ambiguity
    const { analyzeForClarification, formatQuestions } = await import('../utils/interactive');
    const interactiveContext = analyzeForClarification(task);
    
    if (interactiveContext.needsClarification) {
      // Store context for follow-up
      pendingInteractiveContext = {
        originalTask: task,
        context: interactiveContext,
        dryRun,
      };
      
      // Show questions to user
      const questionsText = formatQuestions(interactiveContext);
      app.addMessage({
        role: 'assistant',
        content: questionsText,
      });
      app.notify('Answer questions or type "proceed" to continue');
      return;
    }
  }
  
  // Check agentConfirmation setting
  const confirmationMode = config.get('agentConfirmation') || 'dangerous';
  
  // 'never' - no confirmation needed
  if (confirmationMode === 'never' || dryRun) {
    executeAgentTask(task, dryRun);
    return;
  }
  
  // 'always' - confirm before running any agent task
  if (confirmationMode === 'always') {
    const shortTask = task.length > 60 ? task.slice(0, 57) + '...' : task;
    app.showConfirm({
      title: '⚠️  Confirm Agent Task',
      message: [
        'The agent will execute the following task:',
        '',
        `  "${shortTask}"`,
        '',
        'This may modify files in your project.',
        'Do you want to proceed?',
      ],
      confirmLabel: 'Run Agent',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        executeAgentTask(task, dryRun);
      },
      onCancel: () => {
        app.notify('Agent task cancelled');
      },
    });
    return;
  }
  
  // 'dangerous' - confirm only for tasks with dangerous keywords
  const dangerousKeywords = ['delete', 'remove', 'drop', 'reset', 'force', 'overwrite', 'replace all', 'rm ', 'clear'];
  const taskLower = task.toLowerCase();
  const hasDangerousKeyword = dangerousKeywords.some(k => taskLower.includes(k));
  
  if (hasDangerousKeyword) {
    const shortTask = task.length > 60 ? task.slice(0, 57) + '...' : task;
    app.showConfirm({
      title: '⚠️  Potentially Dangerous Task',
      message: [
        'This task contains potentially dangerous operations:',
        '',
        `  "${shortTask}"`,
        '',
        'Files may be deleted or overwritten.',
        'Do you want to proceed?',
      ],
      confirmLabel: 'Proceed',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        executeAgentTask(task, dryRun);
      },
      onCancel: () => {
        app.notify('Agent task cancelled');
      },
    });
    return;
  }
  
  // No dangerous keywords detected, run directly
  executeAgentTask(task, dryRun);
}

/**
 * Run agent with task (internal - called after confirmation if needed)
 */
async function executeAgentTask(task: string, dryRun: boolean = false): Promise<void> {
  if (!projectContext) {
    app.notify('Agent requires project context');
    return;
  }

  // Guard against concurrent execution — set flag immediately before any await
  if (isAgentRunning) {
    app.notify('Agent already running. Use /stop to cancel.');
    return;
  }
  isAgentRunning = true;
  agentAbortController = new AbortController();
  
  // Add user message
  const prefix = dryRun ? '[DRY RUN] ' : '[AGENT] ';
  app.addMessage({ role: 'user', content: prefix + task });
  
  // Start agent progress UI
  app.setAgentRunning(true);
  
  // Store context in local variable for TypeScript narrowing
  const context = projectContext;
  
  try {
    // Enrich task with added file context if any
    const fileContext = formatAddedFilesContext();
    const enrichedTask = fileContext ? fileContext + task : task;
    
    const result = await runAgent(enrichedTask, context, {
      dryRun,
      chatHistory: app.getChatHistory(),
      onIteration: (iteration) => {
        app.updateAgentProgress(iteration);
      },
      onToolCall: (tool) => {
        const toolName = tool.tool.toLowerCase();
        const target = (tool.parameters.path as string) || 
                      (tool.parameters.command as string) || 
                      (tool.parameters.pattern as string) || '';
        
        // Determine action type
        const actionType = toolName.includes('write') ? 'write' :
                          toolName.includes('edit') ? 'edit' :
                          toolName.includes('read') ? 'read' :
                          toolName.includes('delete') ? 'delete' :
                          toolName.includes('list') ? 'list' :
                          toolName.includes('search') || toolName.includes('grep') ? 'search' :
                          toolName.includes('mkdir') ? 'mkdir' :
                          toolName.includes('fetch') ? 'fetch' : 'command';
        
        // Update agent thinking
        const shortTarget = target.length > 50 ? '...' + target.slice(-47) : target;
        app.setAgentThinking(`${actionType}: ${shortTarget}`);
        
        // Add chat message with diff preview for write/edit operations
        if (actionType === 'write' && tool.parameters.content) {
          const filePath = tool.parameters.path as string;
          try {
            const { createFileDiff, formatDiffForDisplay } = require('../utils/diffPreview');
            const diff = createFileDiff(filePath, tool.parameters.content as string, context.root);
            const diffText = formatDiffForDisplay(diff);
            const additions = diff.hunks.reduce((sum: number, h: any) => sum + h.lines.filter((l: any) => l.type === 'add').length, 0);
            const deletions = diff.hunks.reduce((sum: number, h: any) => sum + h.lines.filter((l: any) => l.type === 'remove').length, 0);
            app.addMessage({
              role: 'system',
              content: `**${diff.type === 'create' ? 'Create' : 'Write'}** \`${filePath}\` (+${additions} -${deletions})\n\n\`\`\`diff\n${diffText}\n\`\`\``,
            });
          } catch {
            const ext = filePath.split('.').pop() || '';
            app.addMessage({
              role: 'system',
              content: `**Write** \`${filePath}\`\n\n\`\`\`${ext}\n${tool.parameters.content as string}\n\`\`\``,
            });
          }
        } else if (actionType === 'edit' && tool.parameters.new_text) {
          const filePath = tool.parameters.path as string;
          try {
            const { createEditDiff, formatDiffForDisplay } = require('../utils/diffPreview');
            const diff = createEditDiff(filePath, tool.parameters.old_text as string, tool.parameters.new_text as string, context.root);
            if (diff) {
              const additions = diff.hunks.reduce((sum: number, h: any) => sum + h.lines.filter((l: any) => l.type === 'add').length, 0);
              const deletions = diff.hunks.reduce((sum: number, h: any) => sum + h.lines.filter((l: any) => l.type === 'remove').length, 0);
              app.addMessage({
                role: 'system',
                content: `**Edit** \`${filePath}\` (+${additions} -${deletions})\n\n\`\`\`diff\n${formatDiffForDisplay(diff)}\n\`\`\``,
              });
            } else {
              const ext = filePath.split('.').pop() || '';
              app.addMessage({
                role: 'system',
                content: `**Edit** \`${filePath}\`\n\n\`\`\`${ext}\n${tool.parameters.new_text as string}\n\`\`\``,
              });
            }
          } catch {
            const ext = filePath.split('.').pop() || '';
            app.addMessage({
              role: 'system',
              content: `**Edit** \`${filePath}\`\n\n\`\`\`${ext}\n${tool.parameters.new_text as string}\n\`\`\``,
            });
          }
        } else if (actionType === 'delete') {
          const filePath = tool.parameters.path as string;
          app.addMessage({
            role: 'system',
            content: `**Delete** \`${filePath}\``,
          });
        }
      },
      onToolResult: (result, toolCall) => {
        const toolName = toolCall.tool.toLowerCase();
        const target = (toolCall.parameters.path as string) || (toolCall.parameters.command as string) || '';
        
        // Track action with result
        const actionType = toolName.includes('write') ? 'write' :
                          toolName.includes('edit') ? 'edit' :
                          toolName.includes('read') ? 'read' :
                          toolName.includes('delete') ? 'delete' :
                          toolName.includes('list') ? 'list' :
                          toolName.includes('search') || toolName.includes('grep') ? 'search' :
                          toolName.includes('mkdir') ? 'mkdir' :
                          toolName.includes('fetch') ? 'fetch' : 'command';
        
        app.updateAgentProgress(0, {
          type: actionType,
          target: target,
          result: result.success ? 'success' : 'error',
        });
      },
      onThinking: (text) => {
        if (text) {
          app.setAgentThinking(text);
        }
      },
      abortSignal: agentAbortController.signal,
    });
    
    // Show result
    if (result.success) {
      const summary = result.finalResponse || `Completed ${result.actions.length} actions in ${result.iterations} steps.`;
      app.addMessage({ role: 'assistant', content: summary });
      app.notify(`Agent completed: ${result.actions.length} actions`);
      
      // Auto-commit if enabled and there were file changes
      if (!dryRun && config.get('agentAutoCommit') && result.actions.length > 0) {
        try {
          const { autoCommitAgentChanges, createBranchAndCommit } = await import('../utils/git');
          const useBranch = config.get('agentAutoCommitBranch');
          
          if (useBranch) {
            const commitResult = createBranchAndCommit(task, result.actions, context.root);
            if (commitResult.success) {
              app.addMessage({ role: 'system', content: `Auto-committed on branch \`${commitResult.branch}\` (${commitResult.hash?.slice(0, 7)})` });
            } else if (commitResult.error !== 'No changes detected by git') {
              app.addMessage({ role: 'system', content: `Auto-commit failed: ${commitResult.error}` });
            }
          } else {
            const commitResult = autoCommitAgentChanges(task, result.actions, context.root);
            if (commitResult.success) {
              app.addMessage({ role: 'system', content: `Auto-committed: ${commitResult.hash?.slice(0, 7)}` });
            } else if (commitResult.error !== 'No changes detected by git') {
              app.addMessage({ role: 'system', content: `Auto-commit failed: ${commitResult.error}` });
            }
          }
        } catch {
          // Silently ignore commit errors
        }
      }
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
    app.setAgentRunning(false);
  }
}

/**
 * Run a skill by name or shortcut with the given args.
 * Wires the skill execution engine to App's UI.
 */
async function runSkill(nameOrShortcut: string, args: string[]): Promise<boolean> {
  const { findSkill, parseSkillArgs, executeSkill, trackSkillUsage } = await import('../utils/skills');
  const skill = findSkill(nameOrShortcut);
  if (!skill) return false;

  // Pre-flight checks
  if (skill.requiresGit) {
    const { getGitStatus } = await import('../utils/git');
    if (!projectPath || !getGitStatus(projectPath).isRepo) {
      app.notify('This skill requires a git repository');
      return true;
    }
  }
  if (skill.requiresWriteAccess && !hasWriteAccess) {
    app.notify('This skill requires write access. Use /grant first.');
    return true;
  }

  const params = parseSkillArgs(args.join(' '), skill);
  app.addMessage({ role: 'user', content: `/${skill.name}${args.length ? ' ' + args.join(' ') : ''}` });

  trackSkillUsage(skill.name);

  const { spawnSync } = await import('child_process');

  try {
    const result = await executeSkill(skill, params, {
      onCommand: async (cmd: string) => {
        // Use spawnSync via shell for reliable stdout+stderr capture
        const proc = spawnSync(cmd, {
          cwd: projectPath || process.cwd(),
          encoding: 'utf-8',
          timeout: 60000,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        
        const stdout = (proc.stdout || '').trim();
        const stderr = (proc.stderr || '').trim();
        const output = stdout || stderr || '';
        
        if (proc.status === 0) {
          if (output) {
            app.addMessage({ role: 'system', content: `\`${cmd}\`\n\`\`\`\n${output}\n\`\`\`` });
          }
          return output;
        }
        
        // Non-zero exit
        if (output) {
          app.addMessage({ role: 'system', content: `\`${cmd}\` failed:\n\`\`\`\n${output}\n\`\`\`` });
        }
        throw new Error(output || `Command exited with code ${proc.status}`);
      },

      onPrompt: async (prompt: string) => {
        try {
          app.addMessage({ role: 'user', content: prompt });
          app.startStreaming();
          const history = app.getChatHistory();
          const response = await chat(prompt, history, (chunk) => {
            app.addStreamChunk(chunk);
          }, undefined, projectContext, undefined);
          app.endStreaming();
          // Return the AI response text for use in subsequent steps
          const lastMsg = app.getMessages();
          const assistantMsg = lastMsg[lastMsg.length - 1];
          return (assistantMsg?.role === 'assistant' ? assistantMsg.content : response || '').trim();
        } catch (err) {
          app.endStreaming();
          throw err;
        }
      },

      onAgent: (task: string) => {
        return new Promise<string>((resolve, reject) => {
          if (!projectContext) {
            reject(new Error('Agent requires project context'));
            return;
          }
          runAgentTask(task).then(() => resolve('Agent completed')).catch(reject);
        });
      },

      onConfirm: (message: string) => {
        return new Promise<boolean>((resolve) => {
          app.showConfirm({
            title: 'Confirm',
            message: [message],
            confirmLabel: 'Yes',
            cancelLabel: 'No',
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
      },

      onNotify: (message: string) => {
        app.notify(message);
      },
    });

    if (!result.success && result.output !== 'Cancelled by user') {
      app.notify(`Skill failed: ${result.output}`);
    }
  } catch (err) {
    app.notify(`Skill error: ${(err as Error).message}`);
    trackSkillUsage(skill.name, false);
  }

  return true;
}

/**
 * Run a chain of commands sequentially
 */
function runCommandChain(commands: string[], index: number): void {
  if (index >= commands.length) {
    app.notify(`Completed ${commands.length} commands`);
    return;
  }
  
  const cmd = commands[index].toLowerCase();
  app.notify(`Running /${cmd}... (${index + 1}/${commands.length})`);
  
  // Run the command
  handleCommand(cmd, []);
  
  // Schedule next command with a delay to allow current to complete
  setTimeout(() => {
    runCommandChain(commands, index + 1);
  }, 500);
}

/**
 * Handle commands
 */
function handleCommand(command: string, args: string[]): void {
  // Handle skill chaining (e.g., /commit+push)
  if (command.includes('+')) {
    const commands = command.split('+').filter(c => c.trim());
    runCommandChain(commands, 0);
    return;
  }
  
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
      const providerItems = providers.map(p => ({
        key: p.id,
        label: p.name,
        description: p.description || '',
      }));
      const currentProvider = getCurrentProvider();
      app.showSelect('Select Provider', providerItems, currentProvider.id, (item) => {
        if (setProvider(item.key)) {
          app.notify(`Provider: ${item.label}`);
        }
      });
      break;
    }
    
    case 'model': {
      const models = getModelsForCurrentProvider();
      const modelItems = Object.entries(models).map(([name, info]) => ({
        key: name,
        label: name,
        description: typeof info === 'object' && info !== null ? (info as any).description || '' : '',
      }));
      const currentModel = config.get('model');
      app.showSelect('Select Model', modelItems, currentModel, (item) => {
        config.set('model', item.key);
        app.notify(`Model: ${item.label}`);
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
      app.showSettings();
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
      // Save current session first so there's a file to rename
      const messages = app.getMessages();
      if (messages.length === 0) {
        app.notify('No messages to save. Start a conversation first.');
        return;
      }
      saveSession(sessionId, messages, projectPath);
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
      const searchResults: Array<{ role: string; messageIndex: number; matchedText: string }> = [];
      
      messages.forEach((m, index) => {
        if (m.content.toLowerCase().includes(searchTerm)) {
          // Find the matched text with some context
          const lowerContent = m.content.toLowerCase();
          const matchStart = Math.max(0, lowerContent.indexOf(searchTerm) - 30);
          const matchEnd = Math.min(m.content.length, lowerContent.indexOf(searchTerm) + searchTerm.length + 50);
          const matchedText = (matchStart > 0 ? '...' : '') + 
            m.content.slice(matchStart, matchEnd).replace(/\n/g, ' ') + 
            (matchEnd < m.content.length ? '...' : '');
          
          searchResults.push({
            role: m.role,
            messageIndex: index,
            matchedText,
          });
        }
      });
      
      if (searchResults.length === 0) {
        app.notify(`No matches for "${searchTerm}"`);
      } else {
        app.showSearch(searchTerm, searchResults, (messageIndex) => {
          // Scroll to the message
          app.scrollToMessage(messageIndex);
        });
      }
      break;
    }
    
    case 'export': {
      const messages = app.getMessages();
      if (messages.length === 0) {
        app.notify('No messages to export');
        return;
      }
      
      app.showExport((format) => {
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
      });
      break;
    }
    
    // Protocol and language
    case 'protocol': {
      const currentProvider = getCurrentProvider();
      const providerConfig = getProvider(currentProvider.id);
      const protocols = Object.entries(PROTOCOLS)
        .filter(([key]) => providerConfig?.protocols[key as 'openai' | 'anthropic'])
        .map(([key, name]) => ({
          key,
          label: name,
        }));
      if (protocols.length <= 1) {
        app.notify(`${currentProvider.name} only supports ${protocols[0]?.label || 'one'} protocol`);
        break;
      }
      const currentProtocol = config.get('protocol') || 'openai';
      app.showSelect('Select Protocol', protocols, currentProtocol, (item) => {
        config.set('protocol', item.key as any);
        app.notify(`Protocol: ${item.label}`);
      });
      break;
    }
    
    case 'lang': {
      const languages = Object.entries(LANGUAGES).map(([key, name]) => ({
        key,
        label: name,
      }));
      const currentLang = config.get('language') || 'auto';
      app.showSelect('Select Language', languages, currentLang, (item) => {
        config.set('language', item.key as any);
        app.notify(`Language: ${item.label}`);
      });
      break;
    }
    
    // Login/Logout
    case 'login': {
      const providers = getProviderList();
      app.showLogin(providers.map(p => ({ id: p.id, name: p.name, subscribeUrl: p.subscribeUrl })), async (result) => {
        if (result) {
          setProvider(result.providerId);
          await setApiKey(result.apiKey);
          app.notify('Logged in successfully');
        }
      });
      break;
    }
    
    case 'logout': {
      const providers = getProviderList();
      const currentProvider = getCurrentProvider();
      const configuredProviders = providers
        .filter(p => !!getApiKey(p.id))
        .map(p => ({
          id: p.id,
          name: p.name,
          isCurrent: p.id === currentProvider.id,
        }));
      
      if (configuredProviders.length === 0) {
        app.notify('No providers configured');
        return;
      }
      
      app.showLogoutPicker(configuredProviders, (result) => {
        if (result === null) {
          // Cancelled
          return;
        }
        if (result === 'all') {
          for (const p of configuredProviders) {
            clearApiKey(p.id);
          }
          app.notify('Logged out from all providers. Use /login to sign in.');
        } else {
          clearApiKey(result);
          const provider = configuredProviders.find(p => p.id === result);
          app.notify(`Logged out from ${provider?.name || result}`);
          
          // If we logged out from the active provider, switch to another configured one
          if (result === currentProvider.id) {
            const remaining = configuredProviders.filter(p => p.id !== result);
            if (remaining.length > 0) {
              setProvider(remaining[0].id);
              app.notify(`Switched to ${remaining[0].name}`);
            } else {
              app.notify('No providers configured. Use /login to sign in.');
            }
          }
        }
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
      // Same as Ctrl+V - use App's handlePaste
      import('clipboardy').then((clipboardy) => {
        try {
          const content = clipboardy.default.readSync();
          if (content && content.trim()) {
            app.handlePaste(content.trim());
          } else {
            app.notify('Clipboard is empty');
          }
        } catch {
          app.notify('Could not read clipboard');
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
      
      // Find file changes in the response using multiple patterns
      const changes: Array<{ path: string; content: string }> = [];
      
      // Pattern 1: ```lang filepath\n...\n``` (most common AI format)
      const fenceFilePattern = /```\w*\s+([\w./\\-]+(?:\.\w+))\n([\s\S]*?)```/g;
      let match;
      while ((match = fenceFilePattern.exec(lastAssistant.content)) !== null) {
        const path = match[1].trim();
        // Must look like a file path (has extension, no spaces)
        if (path.includes('.') && !path.includes(' ')) {
          changes.push({ path, content: match[2] });
        }
      }
      
      // Pattern 2: // File: or // Path: comment on first line of code block
      if (changes.length === 0) {
        const commentPattern = /```(\w+)?\s*\n(?:\/\/|#|--|\/\*)\s*(?:File|Path|file|path):\s*([^\n*]+)\n([\s\S]*?)```/g;
        while ((match = commentPattern.exec(lastAssistant.content)) !== null) {
          changes.push({ path: match[2].trim(), content: match[3] });
        }
      }
      
      if (changes.length === 0) {
        app.notify('No file changes found in response');
        return;
      }
      
      if (!hasWriteAccess) {
        app.notify('Write access required. Use /grant first.');
        return;
      }
      
      // Show diff preview before applying
      import('fs').then(fs => {
        import('path').then(pathModule => {
          // Generate diff preview
          const diffLines: string[] = [];
          
          for (const change of changes) {
            const fullPath = pathModule.isAbsolute(change.path) 
              ? change.path 
              : pathModule.join(projectPath, change.path);
            
            const shortPath = change.path.length > 40 
              ? '...' + change.path.slice(-37) 
              : change.path;
            
            // Check if file exists (create vs modify)
            let existingContent = '';
            try {
              existingContent = fs.readFileSync(fullPath, 'utf-8');
            } catch {
              // File doesn't exist - will be created
            }
            
            if (!existingContent) {
              diffLines.push(`+ CREATE: ${shortPath}`);
              diffLines.push(`  (${change.content.split('\n').length} lines)`);
            } else {
              // Simple diff: count lines added/removed
              const oldLines = existingContent.split('\n').length;
              const newLines = change.content.split('\n').length;
              const lineDiff = newLines - oldLines;
              
              diffLines.push(`~ MODIFY: ${shortPath}`);
              diffLines.push(`  ${oldLines} → ${newLines} lines (${lineDiff >= 0 ? '+' : ''}${lineDiff})`);
            }
          }
          
          // Show confirmation with diff preview
          app.showConfirm({
            title: '📝 Apply Changes',
            message: [
              `Found ${changes.length} file(s) to apply:`,
              '',
              ...diffLines.slice(0, 10),
              ...(diffLines.length > 10 ? [`  ...and ${diffLines.length - 10} more`] : []),
              '',
              'Apply these changes?',
            ],
            confirmLabel: 'Apply',
            cancelLabel: 'Cancel',
            onConfirm: () => {
              let applied = 0;
              for (const change of changes) {
                try {
                  const fullPath = pathModule.isAbsolute(change.path) 
                    ? change.path 
                    : pathModule.join(projectPath, change.path);
                  fs.mkdirSync(pathModule.dirname(fullPath), { recursive: true });
                  fs.writeFileSync(fullPath, change.content);
                  applied++;
                } catch (err) {
                  // Skip failed writes
                }
              }
              app.notify(`Applied ${applied}/${changes.length} file(s)`);
            },
            onCancel: () => {
              app.notify('Apply cancelled');
            },
          });
        });
      });
      break;
    }
    
    // File context commands
    case 'add': {
      if (!args.length) {
        if (addedFiles.size === 0) {
          app.notify('Usage: /add <file-path> [file2] ... | No files added');
        } else {
          const fileList = Array.from(addedFiles.values()).map(f => f.relativePath).join(', ');
          app.notify(`Added files (${addedFiles.size}): ${fileList}`);
        }
        return;
      }
      
      const path = require('path');
      const fs = require('fs');
      const root = projectContext?.root || projectPath;
      let added = 0;
      const errors: string[] = [];
      
      for (const filePath of args) {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        const relativePath = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
        
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) {
            errors.push(`${filePath}: not a file`);
            continue;
          }
          if (stat.size > 100000) {
            errors.push(`${filePath}: too large (${Math.round(stat.size / 1024)}KB, max 100KB)`);
            continue;
          }
          const content = fs.readFileSync(fullPath, 'utf-8');
          addedFiles.set(fullPath, { relativePath, content });
          added++;
        } catch {
          errors.push(`${filePath}: file not found`);
        }
      }
      
      if (added > 0) {
        app.notify(`Added ${added} file(s) to context (${addedFiles.size} total)`);
      }
      if (errors.length > 0) {
        app.notify(errors.join(', '));
      }
      break;
    }
    
    case 'drop': {
      if (!args.length) {
        if (addedFiles.size === 0) {
          app.notify('No files in context');
        } else {
          const count = addedFiles.size;
          addedFiles.clear();
          app.notify(`Dropped all ${count} file(s) from context`);
        }
        return;
      }
      
      const path = require('path');
      const root = projectContext?.root || projectPath;
      let dropped = 0;
      
      for (const filePath of args) {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        if (addedFiles.delete(fullPath)) {
          dropped++;
        }
      }
      
      if (dropped > 0) {
        app.notify(`Dropped ${dropped} file(s) (${addedFiles.size} remaining)`);
      } else {
        app.notify('File not found in context. Use /add to see added files.');
      }
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
    // Skill shortcuts and full names — delegated to skill execution engine
    case 'c':
    case 'commit':
    case 't':
    case 'test':
    case 'd':
    case 'docs':
    case 'r':
    case 'refactor':
    case 'f':
    case 'fix':
    case 'e':
    case 'explain':
    case 'o':
    case 'optimize':
    case 'b':
    case 'debug':
    case 'p':
    case 'push':
    case 'pull':
    case 'amend':
    case 'pr':
    case 'changelog':
    case 'branch':
    case 'stash':
    case 'unstash':
    case 'build':
    case 'deploy':
    case 'release':
    case 'publish': {
      runSkill(command, args).catch((err: Error) => {
        app.notify(`Skill error: ${err.message}`);
      });
      break;
    }
    
    case 'skills': {
      import('../utils/skills').then(({ getAllSkills, searchSkills, formatSkillsList, getSkillStats }) => {
        const query = args.join(' ').toLowerCase();
        
        // Check for stats subcommand
        if (query === 'stats') {
          const stats = getSkillStats();
          app.addMessage({
            role: 'system',
            content: `# Skill Statistics\n\n- Total usage: ${stats.totalUsage}\n- Unique skills used: ${stats.uniqueSkills}\n- Success rate: ${stats.successRate}%`,
          });
          return;
        }
        
        const skills = query ? searchSkills(query) : getAllSkills();
        
        if (skills.length === 0) {
          app.notify(`No skills matching "${query}"`);
          return;
        }
        
        app.addMessage({
          role: 'system',
          content: formatSkillsList(skills),
        });
      });
      break;
    }
    
    case 'skill': {
      import('../utils/skills').then(({ 
        findSkill, 
        formatSkillHelp, 
        createSkillTemplate, 
        saveCustomSkill, 
        deleteCustomSkill 
      }) => {
        const subCommand = args[0]?.toLowerCase();
        const skillName = args[1];
        
        if (!subCommand) {
          app.notify('Usage: /skill <help|create|delete> <name>');
          return;
        }
        
        switch (subCommand) {
          case 'help': {
            if (!skillName) {
              app.notify('Usage: /skill help <skill-name>');
              return;
            }
            const skill = findSkill(skillName);
            if (!skill) {
              app.notify(`Skill not found: ${skillName}`);
              return;
            }
            app.addMessage({
              role: 'system',
              content: formatSkillHelp(skill),
            });
            break;
          }
          
          case 'create': {
            if (!skillName) {
              app.notify('Usage: /skill create <name>');
              return;
            }
            if (findSkill(skillName)) {
              app.notify(`Skill "${skillName}" already exists`);
              return;
            }
            const template = createSkillTemplate(skillName);
            saveCustomSkill(template);
            app.addMessage({
              role: 'system',
              content: `# Custom Skill Created: ${skillName}\n\nEdit the skill file at:\n~/.codeep/skills/${skillName}.json\n\nTemplate:\n\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\``,
            });
            break;
          }
          
          case 'delete': {
            if (!skillName) {
              app.notify('Usage: /skill delete <name>');
              return;
            }
            if (deleteCustomSkill(skillName)) {
              app.notify(`Deleted skill: ${skillName}`);
            } else {
              app.notify(`Could not delete skill: ${skillName}`);
            }
            break;
          }
          
          default: {
            // Try to run the skill by name
            const skill = findSkill(subCommand);
            if (skill) {
              app.notify(`Running skill: ${skill.name}`);
              // For now just show the description
              app.addMessage({
                role: 'system',
                content: `**/${skill.name}**: ${skill.description}`,
              });
            } else {
              app.notify(`Unknown skill command: ${subCommand}`);
            }
          }
        }
      });
      break;
    }
    
    default:
      // Try to run as a skill (handles custom skills and any built-in not in the switch)
      runSkill(command, args).then(handled => {
        if (!handled) {
          app.notify(`Unknown command: /${command}`);
        }
      });
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
            subscribeUrl: selectedProvider.subscribeUrl,
            onSubmit: async (key) => {
              // Validate and save key
              if (key.length < 10) {
                loginError = 'API key too short';
                loginScreen = new LoginScreen(screen, input, {
                  providerName: selectedProvider.name,
                  error: loginError,
                  subscribeUrl: selectedProvider.subscribeUrl,
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
  // Always ask for permission if not already granted (for both projects and regular folders)
  const needsPermissionDialog = !hasRead;
  
  // If already has permission, load context
  if (hasRead) {
    hasWriteAccess = hasWritePermission(projectPath);
    projectContext = getProjectContext(projectPath);
    if (projectContext) {
      projectContext.hasWriteAccess = hasWriteAccess;
      setProjectContext(projectContext);
    }
  }
  
  // Create and start app
  app = new App({
    onSubmit: handleSubmit,
    onCommand: handleCommand,
    onExit: () => {
      console.log('\nGoodbye!');
      process.exit(0);
    },
    onStopAgent: () => {
      if (isAgentRunning && agentAbortController) {
        agentAbortController.abort();
        app.notify('Stopping agent...');
      }
    },
    getStatus,
    hasWriteAccess: () => hasWriteAccess,
    hasProjectContext: () => projectContext !== null,
  });
  
  // Welcome message with contextual info
  const provider = getCurrentProvider();
  const providers = getProviderList();
  const providerInfo = providers.find(p => p.id === provider.id);
  const version = getCurrentVersion();
  const model = config.get('model');
  const agentMode = config.get('agentMode') || 'off';
  
  // Build welcome message
  let welcomeLines: string[] = [
    `Codeep v${version} • ${providerInfo?.name} • ${model}`,
    '',
  ];
  
  // Add access level info
  if (projectContext) {
    if (hasWriteAccess) {
      welcomeLines.push(`Project: ${projectPath}`);
      welcomeLines.push(`Access: Read & Write (Agent enabled)`);
    } else {
      welcomeLines.push(`Project: ${projectPath}`);
      welcomeLines.push(`Access: Read Only (/grant to enable Agent)`);
    }
  } else {
    welcomeLines.push(`Mode: Chat only (no project context)`);
  }
  
  // Add agent mode warning if enabled
  if (agentMode === 'on' && hasWriteAccess) {
    welcomeLines.push('');
    welcomeLines.push('⚠ Agent Mode ON: Messages will auto-execute as agent tasks');
  }
  
  // Add shortcuts hint
  welcomeLines.push('');
  welcomeLines.push('Shortcuts: /help commands • Ctrl+L clear • Esc cancel');
  
  app.addMessage({
    role: 'system',
    content: welcomeLines.join('\n'),
  });
  
  app.start();
  
  // Show intro animation first (if terminal is large enough)
  const showIntroAnimation = process.stdout.rows >= 20;
  
  const showPermissionAndContinue = () => {
    app.showPermission(projectPath, isProject, (permission) => {
      if (permission === 'read') {
        setProjectPermission(projectPath, true, false);
        hasWriteAccess = false;
        projectContext = getProjectContext(projectPath);
        if (projectContext) {
          projectContext.hasWriteAccess = false;
          setProjectContext(projectContext);
        }
        app.notify('Read-only access granted');
      } else if (permission === 'write') {
        setProjectPermission(projectPath, true, true);
        hasWriteAccess = true;
        projectContext = getProjectContext(projectPath);
        if (projectContext) {
          projectContext.hasWriteAccess = true;
          setProjectContext(projectContext);
        }
        app.notify('Read & Write access granted');
      } else {
        app.notify('No project access - chat only mode');
      }
      
      // After permission, show session picker
      showSessionPickerInline();
    });
  };
  
  const continueStartup = () => {
    // If not a git project and not manually initialized, ask if user wants to set it as project
    const isManualProject = isManuallyInitializedProject(projectPath);
    
    if (needsPermissionDialog && !isProject && !isManualProject) {
      // Ask user if they want to use this folder as a project
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
        onConfirm: () => {
          initializeAsProject(projectPath);
          app.notify('Folder initialized as project');
          showPermissionAndContinue();
        },
        onCancel: () => {
          app.notify('Chat only mode - no project context');
          showSessionPickerInline();
        },
      });
    } else if (needsPermissionDialog) {
      // Is a project (git or manual), just ask for permissions
      showPermissionAndContinue();
    } else {
      // No permission needed, show session picker directly
      showSessionPickerInline();
    }
  };
  
  if (showIntroAnimation) {
    app.startIntro(continueStartup);
  } else {
    continueStartup();
  }
}

/**
 * Show session picker inline
 */
function showSessionPickerInline(): void {
  const sessions = listSessionsWithInfo(projectPath);
  
  if (sessions.length === 0) {
    // No sessions, start new one
    sessionId = startNewSession();
    return;
  }
  
  app.showSessionPicker(
    sessions,
    // Select callback
    (selectedName) => {
      if (selectedName === null) {
        // New session
        sessionId = startNewSession();
        app.notify('New session started');
      } else {
        // Load existing session
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
    // Delete callback
    (sessionName) => {
      deleteSession(sessionName, projectPath);
    }
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
