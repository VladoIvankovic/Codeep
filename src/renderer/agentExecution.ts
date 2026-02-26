/**
 * Agent task execution, skill dispatch, and command chaining.
 *
 * Extracted from main.ts to keep the entry point lean. All functions
 * receive an AppExecutionContext so they remain decoupled from the
 * global variables in main.ts.
 */

import { App, Message } from './App';
import { chat } from '../api/index';
import { runAgent, AgentResult } from '../utils/agent';
import { ProjectContext } from '../utils/project';
import { config, autoSaveSession } from '../config/index';
import { getGitStatus } from '../utils/git';

function getActionType(toolName: string): string {
  return toolName.includes('write') ? 'write' :
    toolName.includes('edit') ? 'edit' :
    toolName.includes('read') ? 'read' :
    toolName.includes('delete') ? 'delete' :
    toolName.includes('list') ? 'list' :
    toolName.includes('search') || toolName.includes('grep') ? 'search' :
    toolName.includes('mkdir') ? 'mkdir' :
    toolName.includes('fetch') ? 'fetch' : 'command';
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface AppExecutionContext {
  app: App;
  projectPath: string;
  projectContext: ProjectContext | null;
  hasWriteAccess: boolean;
  addedFiles: Map<string, { relativePath: string; content: string }>;
  isAgentRunning: () => boolean;
  setAgentRunning: (v: boolean) => void;
  abortController: AbortController | null;
  setAbortController: (ctrl: AbortController | null) => void;
  formatAddedFilesContext: () => string;
  handleCommand: (command: string, args: string[]) => Promise<void>;
}

// ─── Dangerous tool detection ────────────────────────────────────────────────

const DANGEROUS_TOOLS = ['write', 'edit', 'delete', 'command', 'execute', 'shell', 'rm', 'mv'];

export function isDangerousTool(toolName: string, parameters: Record<string, unknown>): boolean {
  const lowerName = toolName.toLowerCase();
  if (DANGEROUS_TOOLS.some(d => lowerName.includes(d))) return true;
  const command = (parameters.command as string) || '';
  const dangerousCommands = ['rm ', 'rm -', 'rmdir', 'del ', 'delete', 'drop ', 'truncate'];
  return dangerousCommands.some(c => command.toLowerCase().includes(c));
}

export function requestToolConfirmation(
  app: App,
  tool: string,
  parameters: Record<string, unknown>,
  onConfirm: () => void,
  onCancel: () => void,
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

// ─── Interactive mode state ───────────────────────────────────────────────────

export interface PendingInteractiveContext {
  originalTask: string;
  context: import('../utils/interactive').InteractiveContext;
  dryRun: boolean;
}

// ─── Agent task execution ─────────────────────────────────────────────────────

export async function runAgentTask(
  task: string,
  dryRun: boolean,
  ctx: AppExecutionContext,
  getPendingInteractive: () => PendingInteractiveContext | null,
  setPendingInteractive: (v: PendingInteractiveContext | null) => void,
): Promise<void> {
  const { app, projectContext } = ctx;

  if (!projectContext) {
    app.notify('Agent requires project context');
    return;
  }
  if (!ctx.hasWriteAccess && !dryRun) {
    app.notify('Agent requires write access. Use /grant first.');
    return;
  }
  if (ctx.isAgentRunning()) {
    app.notify('Agent already running. Use /stop to cancel.');
    return;
  }

  const interactiveMode = config.get('agentInteractive') !== false;
  if (interactiveMode) {
    const { analyzeForClarification, formatQuestions } = await import('../utils/interactive');
    const interactiveContext = analyzeForClarification(task);
    if (interactiveContext.needsClarification) {
      setPendingInteractive({ originalTask: task, context: interactiveContext, dryRun });
      app.addMessage({ role: 'assistant', content: formatQuestions(interactiveContext) });
      app.notify('Answer questions or type "proceed" to continue');
      return;
    }
  }

  const confirmationMode = config.get('agentConfirmation') || 'dangerous';
  if (confirmationMode === 'never' || dryRun) {
    executeAgentTask(task, dryRun, ctx);
    return;
  }

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
      onConfirm: () => executeAgentTask(task, dryRun, ctx),
      onCancel: () => app.notify('Agent task cancelled'),
    });
    return;
  }

  // 'dangerous' mode — confirm only for risky keywords
  const dangerousKeywords = ['delete', 'remove', 'drop', 'reset', 'force', 'overwrite', 'replace all', 'rm ', 'clear'];
  if (dangerousKeywords.some(k => task.toLowerCase().includes(k))) {
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
      onConfirm: () => executeAgentTask(task, dryRun, ctx),
      onCancel: () => app.notify('Agent task cancelled'),
    });
    return;
  }

  executeAgentTask(task, dryRun, ctx);
}

export async function executeAgentTask(
  task: string,
  dryRun: boolean,
  ctx: AppExecutionContext,
): Promise<void> {
  const { app, projectContext } = ctx;

  if (!projectContext) {
    app.notify('Agent requires project context');
    return;
  }

  // Guard against concurrent execution — set flag immediately before any await
  if (ctx.isAgentRunning()) {
    app.notify('Agent already running. Use /stop to cancel.');
    return;
  }
  ctx.setAgentRunning(true);
  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  const prefix = dryRun ? '[DRY RUN] ' : '[AGENT] ';
  app.addMessage({ role: 'user', content: prefix + task });
  app.setAgentRunning(true);

  const context = projectContext;

  try {
    const fileContext = ctx.formatAddedFilesContext();
    const enrichedTask = fileContext ? fileContext + task : task;

    // Show N/M progress in status bar
    app.setAgentMaxIterations(config.get('agentMaxIterations'));

    const result: AgentResult = await runAgent(enrichedTask, context, {
      dryRun,
      chatHistory: app.getChatHistory(),
      onIteration: (iteration, message) => {
        app.updateAgentProgress(iteration);
        app.setAgentWaitingForAI(true); // Waiting for AI response between tool calls
        // Show special status messages (timeout retries, verification) but not generic iteration messages
        if (message && !message.startsWith('Iteration ')) {
          app.addMessage({ role: 'system', content: `_${message}_` });
        }
      },
      onToolCall: (tool) => {
        app.setAgentWaitingForAI(false); // AI responded, executing tool
        const toolName = tool.tool.toLowerCase();
        const target = (tool.parameters.path as string) ||
          (tool.parameters.command as string) ||
          (tool.parameters.pattern as string) || '';

        const actionType = getActionType(toolName);

        const shortTarget = target.length > 50 ? '...' + target.slice(-47) : target;
        app.setAgentThinking(`${actionType}: ${shortTarget}`);

        if (actionType === 'write' && tool.parameters.content) {
          const filePath = tool.parameters.path as string;
          try {
            const { createFileDiff, formatDiffForDisplay } = require('../utils/diffPreview');
            const diff = createFileDiff(filePath, tool.parameters.content as string, context.root);
            const diffText = formatDiffForDisplay(diff);
            const additions = diff.hunks.reduce((sum: number, h: { lines: Array<{ type: string }> }) => sum + h.lines.filter((l) => l.type === 'add').length, 0);
            const deletions = diff.hunks.reduce((sum: number, h: { lines: Array<{ type: string }> }) => sum + h.lines.filter((l) => l.type === 'remove').length, 0);
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
              const additions = diff.hunks.reduce((sum: number, h: { lines: Array<{ type: string }> }) => sum + h.lines.filter((l) => l.type === 'add').length, 0);
              const deletions = diff.hunks.reduce((sum: number, h: { lines: Array<{ type: string }> }) => sum + h.lines.filter((l) => l.type === 'remove').length, 0);
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
          app.addMessage({ role: 'system', content: `**Delete** \`${filePath}\`` });
        } else if (actionType === 'read') {
          const filePath = tool.parameters.path as string || shortTarget;
          if (filePath) app.addMessage({ role: 'system', content: `**Reading** \`${filePath}\`` });
        } else if (actionType === 'search') {
          const pattern = (tool.parameters.pattern as string) || (tool.parameters.query as string) || shortTarget;
          if (pattern) app.addMessage({ role: 'system', content: `**Searching** for \`${pattern}\`` });
        } else if (actionType === 'list') {
          const dirPath = tool.parameters.path as string || shortTarget;
          if (dirPath) app.addMessage({ role: 'system', content: `**Listing** \`${dirPath}\`` });
        } else if (actionType === 'fetch') {
          const url = (tool.parameters.url as string) || shortTarget;
          if (url) app.addMessage({ role: 'system', content: `**Fetching** \`${url}\`` });
        } else if (actionType === 'command') {
          const cmd = tool.parameters.command as string || shortTarget;
          if (cmd) app.addMessage({ role: 'system', content: `**Running** \`${cmd}\`` });
        }
      },
      onToolResult: (result, toolCall) => {
        const toolName = toolCall.tool.toLowerCase();
        const target = (toolCall.parameters.path as string) || (toolCall.parameters.command as string) || '';

        const actionType = getActionType(toolName);

        app.updateAgentProgress(0, {
          type: actionType,
          target,
          result: result.success ? 'success' : 'error',
        });
      },
      onThinking: (text) => {
        if (text) app.setAgentThinking(text);
      },
      abortSignal: abortController.signal,
    });

    if (result.success) {
      const fileChanges = result.actions.filter(a => a.type === 'write' || a.type === 'edit' || a.type === 'delete');
      const otherActions = result.actions.filter(a => a.type !== 'write' && a.type !== 'edit' && a.type !== 'delete');
      const completionLines: string[] = [];
      if (result.finalResponse) {
        completionLines.push(result.finalResponse);
        completionLines.push('');
      }
      completionLines.push(`**Agent completed** in ${result.iterations} step(s)`);
      if (fileChanges.length > 0) {
        completionLines.push('');
        completionLines.push('**Files changed:**');
        for (const a of fileChanges) {
          const icon = a.type === 'delete' ? '✗' : '✓';
          completionLines.push(`  ${icon} ${a.type}: \`${a.target}\``);
        }
      }
      if (otherActions.length > 0) {
        completionLines.push('');
        completionLines.push(`${otherActions.length} read/search operation(s) performed`);
      }
      const summary = completionLines.join('\n');
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
          // auto-commit is best-effort
        }
      }
    } else if (result.aborted) {
      app.addMessage({ role: 'assistant', content: 'Agent stopped by user.' });
    } else {
      const failLines: string[] = [];
      if (result.finalResponse) failLines.push(result.finalResponse);
      failLines.push(`**Agent stopped**: ${result.error || 'Unknown error'}`);
      app.addMessage({ role: 'assistant', content: failLines.join('\n\n') });
    }

    autoSaveSession(app.getMessages(), ctx.projectPath);

  } catch (error) {
    const err = error as Error;
    app.addMessage({ role: 'assistant', content: `Agent error: ${err.message}` });
    app.notify(`Agent error: ${err.message}`, 5000);
  } finally {
    ctx.setAgentRunning(false);
    ctx.setAbortController(null);
    app.setAgentRunning(false);
  }
}

// ─── Skill execution ──────────────────────────────────────────────────────────

export async function runSkill(
  nameOrShortcut: string,
  args: string[],
  ctx: AppExecutionContext,
): Promise<boolean> {
  const { findSkill, parseSkillArgs, executeSkill, trackSkillUsage } = await import('../utils/skills');
  const skill = findSkill(nameOrShortcut);
  if (!skill) return false;

  if (skill.requiresGit) {
    if (!ctx.projectPath || !getGitStatus(ctx.projectPath).isRepo) {
      ctx.app.notify('This skill requires a git repository');
      return true;
    }
  }
  if (skill.requiresWriteAccess && !ctx.hasWriteAccess) {
    ctx.app.notify('This skill requires write access. Use /grant first.');
    return true;
  }

  const params = parseSkillArgs(args.join(' '), skill);
  ctx.app.addMessage({ role: 'user', content: `/${skill.name}${args.length ? ' ' + args.join(' ') : ''}` });
  trackSkillUsage(skill.name);

  const { spawnSync } = await import('child_process');

  try {
    const result = await executeSkill(skill, params, {
      onCommand: async (cmd: string) => {
        const proc = spawnSync(cmd, {
          cwd: ctx.projectPath || process.cwd(),
          encoding: 'utf-8',
          timeout: 60000,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout = (proc.stdout || '').trim();
        const stderr = (proc.stderr || '').trim();
        const output = stdout || stderr || '';
        if (proc.status === 0) {
          if (output) ctx.app.addMessage({ role: 'system', content: `\`${cmd}\`\n\`\`\`\n${output}\n\`\`\`` });
          return output;
        }
        if (output) ctx.app.addMessage({ role: 'system', content: `\`${cmd}\` failed:\n\`\`\`\n${output}\n\`\`\`` });
        throw new Error(output || `Command exited with code ${proc.status}`);
      },

      onPrompt: async (prompt: string) => {
        try {
          ctx.app.addMessage({ role: 'user', content: prompt });
          ctx.app.startStreaming();
          const history = ctx.app.getChatHistory();
          const response = await chat(prompt, history, (chunk) => {
            ctx.app.addStreamChunk(chunk);
          }, undefined, ctx.projectContext, undefined);
          ctx.app.endStreaming();
          const msgs = ctx.app.getMessages();
          const last = msgs[msgs.length - 1];
          return (last?.role === 'assistant' ? last.content : response || '').trim();
        } catch (err) {
          ctx.app.endStreaming();
          throw err;
        }
      },

      onAgent: (task: string) => {
        return new Promise<string>((resolve, reject) => {
          if (!ctx.projectContext) {
            reject(new Error('Agent requires project context'));
            return;
          }
          executeAgentTask(task, false, ctx).then(() => resolve('Agent completed')).catch(reject);
        });
      },

      onConfirm: (message: string) => {
        return new Promise<boolean>((resolve) => {
          ctx.app.showConfirm({
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
        ctx.app.notify(message);
      },
    });

    if (!result.success && result.output !== 'Cancelled by user') {
      ctx.app.notify(`Skill failed: ${result.output}`);
    }
  } catch (err) {
    ctx.app.notify(`Skill error: ${(err as Error).message}`);
    trackSkillUsage(skill.name, false);
  }

  return true;
}

// ─── Command chaining ─────────────────────────────────────────────────────────

export function runCommandChain(
  commands: string[],
  index: number,
  ctx: AppExecutionContext,
): void {
  if (index >= commands.length) {
    ctx.app.notify(`Completed ${commands.length} commands`);
    return;
  }
  const cmd = commands[index].toLowerCase();
  ctx.app.notify(`Running /${cmd}... (${index + 1}/${commands.length})`);
  ctx.handleCommand(cmd, []);
  setTimeout(() => runCommandChain(commands, index + 1, ctx), 500);
}
