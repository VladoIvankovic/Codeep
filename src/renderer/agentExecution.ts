/**
 * Agent task execution, skill dispatch, and command chaining.
 *
 * Extracted from main.ts to keep the entry point lean. All functions
 * receive an AppExecutionContext so they remain decoupled from the
 * global variables in main.ts.
 */

import { App } from './App';
import { chat } from '../api/index';
import { runAgent, AgentResult, PermissionOutcome } from '../utils/agent';
import { TelegramApproval, outcomeForAnswer, describePermissionOutcome } from '../utils/telegramApproval';
import { loadTelegramCredentials } from '../utils/telegramCredentials';
import { composeRunSummary, sendTelegramNotice, shouldNotify } from '../utils/telegramNotify';
import { takeRunFromPhone } from '../utils/telegramInbox';
import { isFlatFeeProvider } from '../config/providers';
import { raceApproval, type RaceParticipant } from '../utils/approvalRace';
import { describeAuditTarget } from '../utils/auditLog';
import { ProjectContext } from '../utils/project';
import { config, autoSaveSession, getCurrentSessionId } from '../config/index';
import { reportStats, syncSession, generateProjectId } from '../utils/codeepCloud';
import { getGitStatus, isGitRepository } from '../utils/git';
import { getCostBreakdown, getRecordCount } from '../utils/tokenTracker';

export function getActionType(toolName: string): string {
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
  sessionDisplayName?: string;
  setSessionDisplayName?: (name: string | null) => void;
}

// ─── Dangerous tool detection ────────────────────────────────────────────────

const DANGEROUS_TOOLS = ['write', 'edit', 'delete', 'command', 'execute', 'shell', 'rm', 'mv'];

export function isDangerousTool(toolName: string, parameters: Record<string, unknown>): boolean {
  const lowerName = toolName.toLowerCase();
  if (DANGEROUS_TOOLS.some(d => lowerName.includes(d))) return true;
  const rawCommand = parameters.command;
  const command = typeof rawCommand === 'string' ? rawCommand : '';
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
  // Marker for cloud reporting: report only this run's tokens to the dashboard
  // without wiping the session-cumulative store the status bar and `/cost` read.
  const tokenReportStart = getRecordCount();

  const prefix = dryRun ? '[DRY RUN] ' : '[AGENT] ';
  app.addMessage({ role: 'user', content: prefix + task });
  app.setAgentRunning(true);

  const context = projectContext;

  try {
    const fileContext = ctx.formatAddedFilesContext();
    const enrichedTask = fileContext ? fileContext + task : task;

    // Show N/M progress in status bar
    const rawIterations = config.get('agentMaxIterations') || 50;
    app.setAgentMaxIterations(Math.max(5, rawIterations));

    const confirmationMode = config.get('agentConfirmation') || 'dangerous';

    // Read the Telegram credentials once for the whole run rather than per tool
    // call: they come from the OS keychain, and paying that on every dangerous
    // tool would put a keychain round-trip in front of each confirmation.
    // Null means the feature is off or half-configured, and the terminal is
    // then the only place the question appears — exactly as before.
    const telegramCredentials = confirmationMode === 'dangerous'
      ? await loadTelegramCredentials()
      : null;

    // The finish notice does not depend on the confirmation mode — a run with
    // confirmations off is exactly the one you are most likely to walk away
    // from. Reuse the credentials already read above when there are any, so
    // this costs a second keychain round-trip only when there are not.
    const noticeCredentials = telegramCredentials ?? await loadTelegramCredentials();
    const runStartedAt = Date.now();

    const onRequestPermission = confirmationMode === 'dangerous'
      ? async (toolCall: import('../utils/tools').ToolCall): Promise<PermissionOutcome> => {
          // `parameters.command` is the binary alone — `git`, not `git status`.
          // Showing that asks someone to approve a command they have not been
          // shown, which is the one thing this gate must not do. The audit
          // record already joins the binary with its arguments; reuse it rather
          // than writing a second, subtly different answer.
          const target = describeAuditTarget(toolCall);
          const shortTarget = target.length > 50 ? '...' + target.slice(-47) : target;

          const inTerminal: RaceParticipant<PermissionOutcome> = {
            answer: new Promise<PermissionOutcome | null>((resolve) => {
              app.showConfirm({
                title: '⚠️  Confirm Action',
                message: [
                  'The agent wants to execute:',
                  '',
                  `  ${toolCall.tool}`,
                  `  ${shortTarget}`,
                  '',
                  telegramCredentials ? 'Allow this action? (or answer on Telegram)' : 'Allow this action?',
                ],
                confirmLabel: 'Allow',
                cancelLabel: 'Deny',
                extraOption: { label: 'Always Allow', onSelect: () => resolve('allow_always') },
                onConfirm: () => resolve('allow_once'),
                onCancel: () => resolve('reject_always'),
              });
            }),
            // Answered on the phone: take the dialog down without running either
            // callback, since the decision is already made and taken.
            withdraw: (winner) => app.dismissConfirm(`Answered on Telegram — ${winner}.`),
          };

          let onPhone: RaceParticipant<PermissionOutcome> | null = null;
          if (telegramCredentials) {
            // Report a failure to *ask* once, in the terminal. Without this a
            // wrong chat id looks exactly like a phone nobody picked up.
            const telegram = new TelegramApproval(
              telegramCredentials,
              reason => app.notifyWarn(`Telegram: ${reason}`),
            );
            onPhone = {
              answer: telegram
                .ask(target, toolCall.tool, true)
                .then(answer => (answer ? outcomeForAnswer(answer) : null))
                // A phone that cannot be reached is not a denial. Step aside and
                // let the terminal decide, however long that takes.
                .catch(() => null),
              withdraw: (winner) => telegram.withdraw(winner),
            };
          }

          const { answer } = await raceApproval(
            inTerminal,
            onPhone,
            outcome => describePermissionOutcome(outcome),
          );

          // Nobody answered — neither side could even ask. `classifyPermissionOutcome`
          // fails closed on anything it does not recognise, and this is spelled
          // out rather than left to that: a question that was never put must
          // never read as a yes.
          return answer ?? 'reject_once';
        }
      : undefined;

    const result: AgentResult = await runAgent(enrichedTask, context, {
      dryRun,
      onRequestPermission,
      chatHistory: app.getChatHistory(),
      // Route MCP-prefixed tool calls through the shared TUI session id.
      // Servers were registered against this id at app startup (see
      // renderer/main.ts) so the agent picks up any `.codeep/mcp_servers.json`
      // entries plus global ones at runtime.
      mcpSessionId: 'codeep-tui',
      onIteration: (iteration, message) => {
        app.updateAgentProgress(iteration);
        app.setAgentWaitingForAI(true); // Waiting for AI response between tool calls
        // API errors/retries → toast (replaces itself, auto-dismisses), other messages → chat
        if (message && !message.startsWith('Iteration ')) {
          if (message.startsWith('API ')) {
            app.notifyWarn(message);
          } else {
            app.addMessage({ role: 'system', content: `_${message}_` });
          }
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

        const logSymbol = '▸ ';
        const logLabel = actionType.charAt(0).toUpperCase() + actionType.slice(1);
        const logPad = ' '.repeat(Math.max(0, 8 - logLabel.length));
        app.addAgentLog(`${logSymbol}${logLabel}${logPad} ${shortTarget}`);

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
        }
        // read/search/list/fetch/command — setAgentThinking() above is enough, no chat message needed
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

    // Hide agent progress panel before adding completion message so the full
    // message area is used when rendering (avoids truncated finalResponse)
    ctx.setAgentRunning(false);
    ctx.setAbortController(null);
    app.setAgentRunning(false);

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
    } else if (result.interrupted) {
      // Paused at a step/time safety limit — resumable, not a failure. Show the
      // agent's partial summary and nudge the user to resume.
      if (result.finalResponse) {
        app.addMessage({ role: 'assistant', content: result.finalResponse });
      }
      app.notify('Paused at the safety limit — say "continue" to keep going');
    } else {
      // Show the agent's summary if available, with error details below
      if (result.finalResponse) {
        app.addMessage({ role: 'assistant', content: result.finalResponse });
      } else {
        app.addMessage({ role: 'assistant', content: `Agent could not complete the task: ${result.error || 'Unknown error'}` });
      }
    }

    autoSaveSession(app.getMessages(), ctx.projectPath);

    // Report stats to codeep.dev (fire-and-forget, only if github_id is set)
    const { getCurrentVersion } = await import('../utils/update.js');
    const sessionId = getCurrentSessionId();
    // Auto-name from the task if no display name is set yet.
    //
    // The derived name is kept in a local rather than read back off ctx.
    // makeCtx() copies sessionDisplayName by value, so setSessionDisplayName
    // updates the module's variable while this object keeps the undefined it
    // was built with — and reading it one line after calling the setter always
    // returned nothing. Everything downstream then fell back to the session id,
    // so a run reported itself to the dashboard, and announced itself on
    // Telegram, as "session-2026-09-02-ddc1f13c" instead of its task.
    const shortLabel = (text: string) => {
      const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
      return words.length > 48 ? words.slice(0, 45) + '…' : words;
    };

    // What THIS run was asked to do. The session name below is the first task's
    // and stays put, which is right for a session and wrong for one run inside
    // it: the second task in a session would otherwise announce itself on
    // Telegram under the first one's name.
    const runLabel = shortLabel(task) || sessionId;

    let displayName = ctx.sessionDisplayName;
    if (!displayName) {
      displayName = shortLabel(task);
      ctx.setSessionDisplayName?.(displayName);
    }
    if (!displayName) displayName = sessionId;
    syncSession({
      sessionId,
      sessionName: displayName,
      projectName: ctx.projectContext?.name,
      projectId:   ctx.projectPath ? generateProjectId(ctx.projectPath) : undefined,
      messages: app.getMessages(),
    });
    // Report per-model so tokens are attributed to the correct model/provider
    // even if the user switched model mid-session. Only this run's delta
    // (since tokenReportStart) is reported; the cumulative store is preserved.
    const costBreakdown = getCostBreakdown(tokenReportStart);

    // Told once the run is over, and only when it ran long enough that you
    // could plausibly have stopped watching. Awaited so the process does not
    // exit from under the request, but never allowed to fail the run.
    if (noticeCredentials) {
      const elapsedMs = Date.now() - runStartedAt;
      // Consumed once per run either way, so a phone-started run cannot leave
      // the flag set for whatever the terminal does next.
      const fromPhone = takeRunFromPhone();
      // The one-minute threshold exists so a phone is not buzzed about work you
      // watched finish. It has no business gating a run the phone itself asked
      // for: that answer was wanted whether it took ten seconds or ten minutes,
      // and withholding it leaves "Started —" as the last word.
      if (fromPhone || shouldNotify(elapsedMs, true)) {
        const payPerUse = costBreakdown.filter(entry => !isFlatFeeProvider(entry.provider));
        await sendTelegramNotice(noticeCredentials, composeRunSummary({
          task: runLabel,
          elapsedMs,
          answer: fromPhone ? result.finalResponse : undefined,
          tokens: costBreakdown.reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0),
          costUsd: payPerUse.reduce((sum, e) => sum + e.estimatedCost, 0),
        })).catch(() => false);
      }
    }
    const sharedFields = {
      sessionId,
      sessionName: displayName,
      messageCount: app.getMessages().length,
      cliVersion: getCurrentVersion(),
      projectName: ctx.projectContext?.name,
      projectId:   ctx.projectPath ? generateProjectId(ctx.projectPath) : undefined,
      language: ctx.projectContext?.type,
      isGit: isGitRepository(process.cwd()),
    };
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
      // No token data (e.g. provider doesn't report usage) — fall back to config model
      reportStats({
        ...sharedFields,
        model: config.get('model'),
        provider: config.get('provider'),
      });
    }

  } catch (error) {
    const err = error as Error;
    app.addMessage({ role: 'assistant', content: `Agent error: ${err.message}` });
    app.notify(`Agent error: ${err.message}`, 5000);
  } finally {
    // Ensure cleanup even if an exception occurs (may already be false from success path)
    ctx.setAgentRunning(false);
    ctx.setAbortController(null);
    app.setAgentRunning(false);
    app.render();
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
