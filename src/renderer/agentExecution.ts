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
import { composeRunMessages, sendTelegramNotice, shouldNotify } from '../utils/telegramNotify';
import { takeRunFromPhone } from '../utils/telegramInbox';
import { isFlatFeeProvider } from '../config/providers';
import { raceApproval, type RaceParticipant } from '../utils/approvalRace';
import { describeAuditTarget } from '../utils/auditLog';
import { trustBearingWrite, forgetHooksDirectory, type TrustBearingWrite } from '../utils/toolExecution';
import { shellCommandEnv } from '../utils/shell';
import { charWidth } from './ansi';
import { ProjectContext } from '../utils/project';
import { config, autoSaveSession, getCurrentSessionId } from '../config/index';
import { reportStats, syncSession, generateProjectId } from '../utils/codeepCloud';
import { getGitStatus, isGitRepository } from '../utils/git';
import { getCostBreakdown, getRecordCount } from '../utils/tokenTracker';
import { createFileDiff, createEditDiff, formatDiffForDisplay } from '../utils/diffPreview';

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
  /** The conversation this run belongs to. Saved under this id; the global
   *  currentSessionId is only a fallback and can name a different one. */
  sessionId?: string;
  /** The conversation on screen now. A run can outlive a switch to another
   *  one (/new, /sessions, /rename), since tools do not stop on abort. */
  getSessionId?: () => string;
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
  const safeTarget = showControls(target);
  const shortTarget = safeTarget.length > 50 ? '...' + safeTarget.slice(-47) : safeTarget;
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

/**
 * Model-written text shown in a permission dialog, with every character that
 * could change how the rest of it looks spelled out: an ESC sequence would be
 * read as a style (conceal, black on black) and a bidi override or zero-width
 * character reorders or hides text, so the user could approve a command they
 * were not shown. Newlines are left for the caller to lay out.
 */
export function showControls(text: string): string {
  return text.replace(
    /[\x00-\x09\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (c) => {
      const code = c.charCodeAt(0);
      return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
    },
  );
}

/**
 * The target of a tool call as dialog lines, each `width` terminal columns at
 * most. Shown whole where it fits: an MCP call's arguments or a long command
 * matter from the first character. Past `maxLines` the middle gives way, and a
 * line says how much of it is not shown.
 */
export function wrapConfirmTarget(target: string, width: number, maxLines = 6): string[] {
  const w = Math.max(20, Math.floor(width));
  const lines: string[] = [];
  for (const part of target.split(/\r?\n/)) {
    const text = showControls(part);
    if (text.length === 0) { lines.push(''); continue; }
    // By columns, not UTF-16 units: the screen drops what passes the edge, so
    // a line of wide characters cut by length would lose its end unmarked.
    // Iterating code points also keeps a surrogate pair whole.
    let line = '';
    let cols = 0;
    for (const ch of text) {
      const cw = charWidth(ch);
      if (cols + cw > w && line) {
        lines.push(line);
        line = '';
        cols = 0;
      }
      line += ch;
      cols += cw;
    }
    lines.push(line);
  }
  const max = Math.max(3, maxLines);
  if (lines.length <= max) return lines;
  const hidden = lines.length - (max - 1);
  return [...lines.slice(0, max - 2), `… ${hidden} more line${hidden === 1 ? '' : 's'} …`, lines[lines.length - 1]];
}

// ─── Interactive mode state ───────────────────────────────────────────────────

export interface PendingInteractiveContext {
  originalTask: string;
  context: import('../utils/interactive').InteractiveContext;
  dryRun: boolean;
}

// ─── Agent task execution ─────────────────────────────────────────────────────

/** How a run ended. 'not-started' covers a run that was refused, declined at
 *  a confirmation, or held for clarifying questions. */
export type AgentRunOutcome = 'success' | 'failed' | 'aborted' | 'interrupted' | 'not-started';

export interface RunAgentTaskOptions {
  /** Called once, when the run has ended or will not start. */
  onFinished?: (outcome: AgentRunOutcome) => void;
}

export async function runAgentTask(
  task: string,
  dryRun: boolean,
  ctx: AppExecutionContext,
  getPendingInteractive: () => PendingInteractiveContext | null,
  setPendingInteractive: (v: PendingInteractiveContext | null) => void,
  opts: RunAgentTaskOptions = {},
): Promise<void> {
  const { app, projectContext } = ctx;
  const notStarted = () => opts.onFinished?.('not-started');
  // executeAgentTask catches its own errors, so this always settles.
  const execute = () => {
    void executeAgentTask(task, dryRun, ctx).then(outcome => opts.onFinished?.(outcome));
  };

  if (!projectContext) {
    app.notify('Agent requires project context');
    notStarted();
    return;
  }
  if (!ctx.hasWriteAccess && !dryRun) {
    app.notify('Agent requires write access. Use /grant first.');
    notStarted();
    return;
  }
  if (ctx.isAgentRunning()) {
    app.notify('Agent already running. Use /stop to cancel.');
    notStarted();
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
      notStarted();
      return;
    }
  }

  const confirmationMode = config.get('agentConfirmation') || 'dangerous';
  if (confirmationMode === 'never' || dryRun) {
    execute();
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
      onConfirm: execute,
      onCancel: () => { app.notify('Agent task cancelled'); notStarted(); },
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
      onConfirm: execute,
      onCancel: () => { app.notify('Agent task cancelled'); notStarted(); },
    });
    return;
  }

  execute();
}

export async function executeAgentTask(
  task: string,
  dryRun: boolean,
  ctx: AppExecutionContext,
): Promise<AgentRunOutcome> {
  const { app, projectContext } = ctx;

  if (!projectContext) {
    app.notify('Agent requires project context');
    return 'not-started';
  }

  // Guard against concurrent execution — set flag immediately before any await
  if (ctx.isAgentRunning()) {
    app.notify('Agent already running. Use /stop to cancel.');
    return 'not-started';
  }
  ctx.setAgentRunning(true);
  const abortController = new AbortController();
  ctx.setAbortController(abortController);
  // Read once, at the start: by the time the run ends the global id may name
  // another conversation.
  const sessionId = ctx.sessionId || getCurrentSessionId();
  // Marker for cloud reporting: report only this run's tokens to the dashboard
  // without wiping the session-cumulative store the status bar and `/cost` read.
  const tokenReportStart = getRecordCount();

  const prefix = dryRun ? '[DRY RUN] ' : '[AGENT] ';
  // Kept by reference: while it is on screen, so is this run's conversation.
  const runMessage = { role: 'user' as const, content: prefix + task };
  app.addMessage(runMessage);
  app.setAgentRunning(true);

  const context = projectContext;
  let outcome: AgentRunOutcome = 'failed';

  try {
    const fileContext = ctx.formatAddedFilesContext();
    const enrichedTask = fileContext ? fileContext + task : task;

    // Show N/M progress in status bar
    const rawIterations = config.get('agentMaxIterations') || 50;
    app.setAgentMaxIterations(Math.max(5, rawIterations));

    const confirmationMode = config.get('agentConfirmation') || 'dangerous';
    // 'always' asks before every action that changes something: at least what
    // 'dangerous' asks about, plus writes, edits and new directories.
    const asksPerTool = confirmationMode === 'dangerous' || confirmationMode === 'always';

    // Read the Telegram credentials once for the whole run rather than per tool
    // call: they come from the OS keychain, and paying that on every dangerous
    // tool would put a keychain round-trip in front of each confirmation. Read
    // in every mode, for the finish notice — and because 'never' now asks
    // about a file that decides what runs later, which is exactly the kind of
    // run someone has walked away from. Null means the feature is off or
    // half-configured, and the terminal is then the only place the question
    // appears — exactly as before.
    const telegramCredentials = await loadTelegramCredentials();
    const runStartedAt = Date.now();

    // 'never' still gets a callback. A write to a file that decides what runs
    // later — `.git/config`, a hook, an MCP server list — is asked about in
    // every mode (the agent gate decides which calls those are), and "never
    // ask" is then answered here for everything else, exactly as before:
    // without a callback the agent would have to refuse those writes instead.
    const onRequestPermission = async (
      toolCall: import('../utils/tools').ToolCall,
      // What the agent gate already worked out about this call, passed rather
      // than worked out twice: trustBearingWrite() stats the path, resolves a
      // symlinked ancestor and may ask git where this repo keeps its hooks.
      // Undefined means the question came from somewhere that has not looked
      // — a skill's shell line asks through this same callback — so it is
      // only then that this side looks for itself. `null` is an answer.
      known?: TrustBearingWrite | null,
    ): Promise<PermissionOutcome> => {
      const trustBearing = known !== undefined ? known : trustBearingWrite(toolCall, context.root || process.cwd());
      if (!asksPerTool && !trustBearing) return 'allow_once';
      // `parameters.command` is the binary alone — `git`, not `git status`.
      // Showing that asks someone to approve a command they have not been
      // shown, which is the one thing this gate must not do. The audit
      // record already joins the binary with its arguments; reuse it rather
      // than writing a second, subtly different answer.
      const target = describeAuditTarget(toolCall);
      // Indented by two in the dialog.
      const targetLines = wrapConfirmTarget(target, (process.stdout.columns || 80) - 4)
        .map(line => `  ${line}`);

      const inTerminal: RaceParticipant<PermissionOutcome> = {
        answer: new Promise<PermissionOutcome | null>((resolve) => {
          app.showConfirm({
            title: '⚠️  Confirm Action',
            message: [
              'The agent wants to execute:',
              '',
              `  ${showControls(toolCall.tool)}`,
              ...targetLines,
              // What the file does, not that it is "sensitive": someone
              // deciding in one second needs the consequence, not a label.
              ...(trustBearing ? ['', ...wrapConfirmTarget(`⚠️  ${trustBearing.reason}`, (process.stdout.columns || 80) - 4)] : []),
              '',
              telegramCredentials ? 'Allow this action? (or answer on Telegram)' : 'Allow this action?',
            ],
            confirmLabel: 'Allow',
            cancelLabel: 'Deny',
            // No "Always Allow" for one of those files: the agent answers
            // about this file only and would not remember it anyway.
            extraOption: trustBearing ? undefined : { label: 'Always Allow', onSelect: () => resolve('allow_always') },
            onConfirm: () => resolve('allow_once'),
            // The one "no" there is, and it answers reject_always. For one of
            // those files the agent remembers that against the FILE rather
            // than the tool, so refusing a `.git/config` prompt does not also
            // switch delete_file off for the rest of the run.
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
            // The reason goes with it: a phone showing less than the terminal
            // asks for a decision on less than the terminal had.
            .ask(target, toolCall.tool, true, undefined, trustBearing?.reason)
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
    };

    const result: AgentResult = await runAgent(enrichedTask, context, {
      dryRun,
      onRequestPermission,
      extraDangerousTools: confirmationMode === 'always' ? ['write_file', 'edit_file', 'delete_file', 'execute_command', 'create_directory'] : undefined,
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

    outcome = result.success ? 'success'
      : result.aborted ? 'aborted'
      : result.interrupted ? 'interrupted'
      : 'failed';

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

    // The messages on screen belong to whatever conversation is on screen.
    // If the user moved to another one while the run was finishing, saving
    // them under this run's id would replace that conversation's file with
    // the new one's contents; the terminal saves the new one itself.
    const switched = ctx.getSessionId !== undefined && ctx.getSessionId() !== sessionId;
    if (!switched) {
      autoSaveSession(app.getMessages(), ctx.projectPath, sessionId);
    } else if (app.getMessages().includes(runMessage)) {
      // /rename: the same conversation, still on screen, under its new id.
      // /new, /sessions and the other loads replace the messages, so a run
      // left behind by one of those never gets here. (Whether the old file
      // is gone says nothing: a case-only rename keeps it on macOS.)
      autoSaveSession(app.getMessages(), ctx.projectPath, ctx.getSessionId!());
    }

    // Report stats to codeep.dev (fire-and-forget, only if github_id is set)
    const { getCurrentVersion } = await import('../utils/update.js');
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
      // Naming the conversation on screen after this run would be wrong
      // once it is a different one.
      if (!switched) ctx.setSessionDisplayName?.(displayName);
    }
    if (!displayName) displayName = sessionId;
    if (!switched) {
      syncSession({
        sessionId,
        sessionName: displayName,
        projectName: ctx.projectContext?.name,
        projectId:   ctx.projectPath ? generateProjectId(ctx.projectPath) : undefined,
        messages: app.getMessages(),
      });
    }
    // Report per-model so tokens are attributed to the correct model/provider
    // even if the user switched model mid-session. Only this run's delta
    // (since tokenReportStart) is reported; the cumulative store is preserved.
    const costBreakdown = getCostBreakdown(tokenReportStart);
    // Consumed exactly once per run, before anything branches on it: the notice
    // path is conditional (no credentials, or a run too short to notify), and
    // reading it inside that branch left the stat blind on every run that did
    // not send a notification.
    const startedFromPhone = takeRunFromPhone();

    // Told once the run is over, and only when it ran long enough that you
    // could plausibly have stopped watching. Awaited so the process does not
    // exit from under the request, but never allowed to fail the run.
    if (telegramCredentials) {
      const elapsedMs = Date.now() - runStartedAt;
      const fromPhone = startedFromPhone;
      // The one-minute threshold exists so a phone is not buzzed about work you
      // watched finish. It has no business gating a run the phone itself asked
      // for: that answer was wanted whether it took ten seconds or ten minutes,
      // and withholding it leaves "Started —" as the last word.
      if (fromPhone || shouldNotify(elapsedMs, true)) {
        const payPerUse = costBreakdown.filter(entry => !isFlatFeeProvider(entry.provider));
        // Usually one message. An answer past Telegram's limit continues into
        // further ones rather than being cut at the first — awaited in turn so
        // they arrive in the order they were written.
        const messages = composeRunMessages({
          task: runLabel,
          elapsedMs,
          answer: fromPhone ? result.finalResponse : undefined,
          tokens: costBreakdown.reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0),
          costUsd: payPerUse.reduce((sum, e) => sum + e.estimatedCost, 0),
        });
        for (const message of messages) {
          await sendTelegramNotice(telegramCredentials, message).catch(() => false);
        }
      }
    }
    const sharedFields = {
      // `fromPhone` is read above, where the notice consumes it. Captured here
      // too because the stats event is the only place it can answer anything
      // later — see docs/ios-decision.md.
      fromPhone: startedFromPhone,
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
    outcome = 'failed';
    app.addMessage({ role: 'assistant', content: `Agent error: ${err.message}` });
    app.notify(`Agent error: ${err.message}`, 5000);
  } finally {
    // Ensure cleanup even if an exception occurs (may already be false from success path)
    ctx.setAgentRunning(false);
    ctx.setAbortController(null);
    app.setAgentRunning(false);
    app.render();
  }
  return outcome;
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
        const cwd = ctx.projectPath || process.cwd();
        // A raw process.env here handed the repository's own `.git/config`
        // back to git: `/commit` runs `git commit`, and a repo-scope
        // `gpg.program` that Codeep's own commit path neutralises executed
        // through this spawn instead.
        //
        // Built before the spawn, and caught: shellCommandEnv() refuses a git
        // line in a repository whose config names a program no override
        // switches off, and a refusal escaping here would abort the whole
        // skill rather than fail the step that asked for git. A step that
        // cannot run is reported the same way a step that failed is.
        let env: NodeJS.ProcessEnv;
        try {
          env = shellCommandEnv(cmd, cwd);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          ctx.app.addMessage({ role: 'system', content: `\`${cmd}\` was not run:\n\`\`\`\n${why}\n\`\`\`` });
          throw new Error(why);
        }
        // A command line is the one thing in a skill that can move this
        // repository's hooks (`git config core.hooksPath .evil`), and the
        // write gate caches where they are for the run.
        forgetHooksDirectory();
        const proc = spawnSync(cmd, {
          cwd,
          encoding: 'utf-8',
          timeout: 60000,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
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
          // A later step (commit, push, deploy) must not run after an agent
          // step that failed, was stopped or left checks failing.
          executeAgentTask(task, false, ctx).then((outcome) => {
            if (outcome === 'success') {
              resolve('Agent completed');
            } else if (outcome === 'aborted') {
              // The wording runSkill already treats as the user's own stop.
              reject(new Error('Cancelled by user'));
            } else {
              reject(new Error(outcome === 'not-started' ? 'Agent step did not run' : 'Agent step did not finish successfully'));
            }
          }).catch(reject);
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
