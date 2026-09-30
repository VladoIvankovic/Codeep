import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// What the agent screen says while a run is under way, end to end: a real App
// driven by executeAgentTask, with only the agent loop replaced by a script
// that calls the run's callbacks in the order runAgent calls them. The screen
// is read back from the App's own buffer, so a label computed at render time
// is checked as the user sees it.
vi.mock('../utils/agent', () => ({ runAgent: vi.fn() }));
vi.mock('../utils/telegramCredentials', () => ({ loadTelegramCredentials: vi.fn(async () => null) }));
vi.mock('../utils/telegramInbox', () => ({ takeRunFromPhone: vi.fn(() => false) }));
vi.mock('../utils/codeepCloud', () => ({
  reportStats: vi.fn(),
  syncSession: vi.fn(),
  generateProjectId: vi.fn(() => 'project-id'),
}));
vi.mock('../utils/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git')>()),
  isGitRepository: vi.fn(() => false),
}));
vi.mock('../config/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/index')>()),
  autoSaveSession: vi.fn(() => true),
  getCurrentSessionId: vi.fn(() => 'current-session'),
}));

import { executeAgentTask, type AppExecutionContext } from './agentExecution';
import { runAgent, type AgentOptions, type AgentResult } from '../utils/agent';
import { config } from '../config/index';
import { App } from './App';
import type { ProjectContext } from '../utils/project';
import type { ToolCall, ToolResult } from '../utils/tools';

let root: string;
let clock: { offset: number };

function makeApp(): App {
  const app = new App({
    onSubmit: async () => {},
    onCommand: () => {},
    onExit: () => {},
    getStatus: () => ({
      version: '3.8.0',
      provider: 'Z.AI',
      model: 'glm-5.3',
      agentMode: 'on',
      projectPath: root,
      hasWriteAccess: true,
      sessionId: 'current-session',
      messageCount: 0,
    }),
  });
  // Nothing may reach the real terminal: the spinner and scheduleRender call
  // render(), and the screen's own render() writes escape codes to stdout.
  // Plain overrides rather than spies: afterEach undoes spies, and a render
  // scheduled with setImmediate can still fire after it has.
  app.render = () => {};
  const screen = (app as unknown as { screen: { render: () => void } }).screen;
  screen.render = () => {};
  return app;
}

interface ScreenBuffer { width: number; height: number; buffer: Array<Array<{ char: string }>> }

function rows(app: App): string[] {
  const screen = (app as unknown as { screen: ScreenBuffer }).screen;
  return screen.buffer.map(row => row.map(cell => cell.char).join('').trimEnd());
}

/** The wide agent screen (timeline + context rail), as text. */
function timeline(app: App, width = 140, height = 40): string[] {
  const screen = (app as unknown as { screen: ScreenBuffer }).screen;
  screen.width = width;
  screen.height = height;
  (app as unknown as { renderAgentTimelineScreen: (w: number, h: number) => void })
    .renderAgentTimelineScreen(width, height);
  return rows(app);
}

/** The narrow terminal's agent panel under the status bar, as text. */
function inlinePanel(app: App, width = 100): string[] {
  const screen = (app as unknown as { screen: ScreenBuffer; clear: () => void }).screen as ScreenBuffer & { clear: () => void };
  screen.width = width;
  screen.height = 12;
  screen.clear();
  (app as unknown as { renderInlineAgentProgress: (y: number, w: number) => void })
    .renderInlineAgentProgress(0, width);
  return rows(app).slice(0, 8);
}

/** A stage row's state label: the stage name sits at column 4, the label at
 *  the right edge of the timeline pane, before the rail's divider. */
/** Whether the narrow panel draws its newest log line (the fifth under the
 *  title) as the call in progress: bold, where older lines are grey. */
function newestLogHighlighted(app: App): boolean {
  const screen = (app as unknown as { screen: { buffer: Array<Array<{ style: string }>> } }).screen;
  return screen.buffer[5][3].style.includes('\x1b[1m');
}

function stageState(screen: string[], id: string): string {
  const row = screen.find(r => r.slice(4, 13).trim() === id);
  const match = row?.match(/\b(done|active|pending)(?=\s*(│|$))/);
  return match ? match[1] : `(no ${id} row)`;
}

function step(screen: string[]): string {
  const match = screen.join('\n').match(/step (\d+)\/\d+/);
  return match ? match[1] : '(no step)';
}

function line(screen: string[], text: string): string {
  return screen.find(row => row.includes(text)) ?? '';
}

function makeCtx(app: App): AppExecutionContext {
  let running = false;
  return {
    app,
    projectPath: root,
    projectContext: { root, name: 'demo', type: 'node' } as unknown as ProjectContext,
    hasWriteAccess: true,
    addedFiles: new Map(),
    isAgentRunning: () => running,
    setAgentRunning: (v) => { running = v; },
    abortController: null,
    setAbortController: () => {},
    formatAddedFilesContext: () => '',
    handleCommand: async () => {},
    sessionDisplayName: 'demo run',
  };
}

const done: AgentResult = { success: true, iterations: 1, actions: [], finalResponse: 'Done.' };

function call(tool: string, parameters: Record<string, unknown>): ToolCall {
  return { tool, parameters } as ToolCall;
}

function ok(toolCall: ToolCall): ToolResult {
  return { success: true, output: 'ok', tool: toolCall.tool, parameters: toolCall.parameters } as ToolResult;
}

/** One tool call, run to completion, as runAgent reports it. */
function runTool(opts: Partial<AgentOptions> | undefined, toolCall: ToolCall, whileRunning?: () => void): void {
  opts?.onToolCall?.(toolCall);
  whileRunning?.();
  opts?.onToolResult?.(ok(toolCall), toolCall);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-agent-progress-'));
  config.set('agentConfirmation', 'never');
  config.set('agentAutoCommit', false);
  config.set('agentMaxIterations', 50);
  vi.mocked(runAgent).mockReset();
  clock = { offset: 0 };
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock.offset);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('the agent screen while the model is working', () => {
  it('says it is waiting for the model, not the tool that already finished', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('list_files', { path: 'plugins' }), () => { seen.running = timeline(app); });
      // list_files returned at once; the model then thought for 16 minutes.
      opts?.onIteration?.(2, 'Iteration 2/50');
      seen.waiting = timeline(app);
      return done;
    });

    await executeAgentTask('tidy the plugins', false, makeCtx(app));

    // While the tool runs, its label is the current action.
    expect(line(seen.running, 'Listing:')).toContain('plugins');
    // Once it has finished, nothing is being listed.
    expect(seen.waiting.join('\n')).not.toContain('Listing:');
    expect(line(seen.waiting, 'Waiting for the model')).not.toBe('');
    // The stage the run is in stays where it was: the model is between two
    // steps of reading, not back at planning.
    expect(stageState(seen.waiting, 'READ')).toBe('active');
  });

  it('counts the wait from when the model was asked, through a retry', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('list_files', { path: 'plugins' }), () => { clock.offset += 30_000; });
      opts?.onIteration?.(2, 'Iteration 2/50');
      clock.offset += 10 * 60_000;
      // A retry notice is still the same wait for the same answer.
      opts?.onIteration?.(2, 'API 503: overloaded — retrying in 5s (1/3)');
      clock.offset += 6 * 60_000 + 2_000;
      seen.waiting = timeline(app);
      return done;
    });

    await executeAgentTask('tidy the plugins', false, makeCtx(app));

    // 16:02 of waiting; the run itself is 16:32 old, which the footer shows.
    expect(line(seen.waiting, 'Waiting for the model')).toContain('16:02');
  });

  it('keeps the step count while the second tool of one reply runs', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('read_file', { path: 'a.ts' }));
      opts?.onIteration?.(2, 'Iteration 2/50');
      runTool(opts, call('read_file', { path: 'b.ts' }));
      runTool(opts, call('execute_command', { command: 'npm test' }), () => { seen.second = timeline(app); });
      return done;
    });

    await executeAgentTask('check the tests', false, makeCtx(app));

    expect(step(seen.second)).toBe('2');
    expect(line(seen.second, 'Running:')).toContain('npm test');
  });

  it('says so in the narrow panel too, and does not show the finished tool as current', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    const highlighted: Record<string, boolean> = {};
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('list_files', { path: 'plugins' }), () => {
        seen.running = inlinePanel(app);
        highlighted.running = newestLogHighlighted(app);
      });
      opts?.onIteration?.(2, 'Iteration 2/50');
      clock.offset += 65_000;
      seen.waiting = inlinePanel(app);
      highlighted.waiting = newestLogHighlighted(app);
      return done;
    });

    await executeAgentTask('tidy the plugins', false, makeCtx(app));

    expect(seen.running.join('\n')).not.toContain('Waiting for the model');
    expect(line(seen.waiting, 'Waiting for the model')).toContain('01:05');
    // The finished call stays in the log, as history, no longer drawn as the
    // one in progress.
    expect(line(seen.waiting, 'plugins')).toContain('List');
    expect(highlighted).toEqual({ running: true, waiting: false });
  });
});

describe('the agent screen while auto-verify runs the checks', () => {
  it('says the checks are running, then that the model is fixing what they found', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('edit_file', { path: 'src/auth.ts', old_text: 'a', new_text: 'b' }));
      opts?.onIteration?.(2, 'Iteration 2/50');
      // The model answered without tools; runAgent now verifies.
      opts?.onIteration?.(2, 'Verification attempt 1/3');
      opts?.onVerificationStart?.(1, 3);
      clock.offset += 90_000;
      seen.checks = timeline(app);
      opts?.onVerification?.([]);
      seen.fixing = timeline(app);
      return done;
    });

    await executeAgentTask('fix the login', false, makeCtx(app));

    expect(line(seen.checks, 'Running checks ·')).toContain('01:30');
    expect(seen.checks.join('\n')).not.toContain('Editing:');
    expect(seen.checks.join('\n')).not.toContain('Waiting for the model');
    expect(stageState(seen.checks, 'VERIFY')).toBe('active');
    expect(stageState(seen.checks, 'EDIT')).toBe('done');

    expect(line(seen.fixing, 'Waiting for the model')).not.toBe('');
    expect(seen.fixing.join('\n')).not.toContain('Running checks');
    expect(seen.fixing.join('\n')).not.toContain('Verifying the changes');
  });
});

describe('the stages of a second request', () => {
  it('start again at PLAN, with none of the first request\'s files', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    vi.mocked(runAgent).mockImplementationOnce(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('read_file', { path: 'src/auth.ts' }));
      runTool(opts, call('edit_file', { path: 'src/auth.ts', old_text: 'a', new_text: 'b' }));
      runTool(opts, call('execute_command', { command: 'npm test' }));
      opts?.onIteration?.(2, 'Iteration 2/50');
      seen.first = timeline(app);
      return done;
    });
    vi.mocked(runAgent).mockImplementationOnce(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      seen.second = timeline(app);
      return done;
    });
    const ctx = makeCtx(app);

    await executeAgentTask('fix the login', false, ctx);
    await executeAgentTask('now add a logout button', false, ctx);

    expect(line(seen.first, 'FILES (1)')).not.toBe('');
    expect(stageState(seen.second, 'PLAN')).toBe('active');
    for (const id of ['READ', 'EDIT', 'VERIFY', 'SUMMARY']) {
      expect(stageState(seen.second, id)).toBe('pending');
    }
    expect(line(seen.second, 'FILES (0)')).not.toBe('');
    expect(seen.second.join('\n')).not.toContain('src/auth.ts');
    expect(seen.second.join('\n')).not.toContain('npm test');
    expect(line(seen.second, 'Task:')).toContain('now add a logout button');
  });

  it('do not restart for auto-verify\'s fix round, which is the same request', async () => {
    const app = makeApp();
    const seen: Record<string, string[]> = {};
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onIteration?.(1, 'Iteration 1/50');
      runTool(opts, call('read_file', { path: 'src/auth.ts' }));
      runTool(opts, call('edit_file', { path: 'src/auth.ts', old_text: 'a', new_text: 'b' }));
      opts?.onIteration?.(2, 'Iteration 2/50');
      opts?.onIteration?.(2, 'Verification attempt 1/3');
      opts?.onVerificationStart?.(1, 3);
      opts?.onVerification?.([]);
      // The fix the model sends back after a failing check.
      runTool(opts, call('edit_file', { path: 'src/session.ts', old_text: 'c', new_text: 'd' }), () => {
        seen.fix = timeline(app);
      });
      return done;
    });

    await executeAgentTask('fix the login', false, makeCtx(app));

    expect(stageState(seen.fix, 'PLAN')).toBe('done');
    expect(stageState(seen.fix, 'READ')).toBe('done');
    expect(stageState(seen.fix, 'EDIT')).toBe('active');
    expect(line(seen.fix, 'Editing:')).toContain('src/session.ts');
    // The verification notice went to the chat as a system line; the task on
    // screen is still the one the user typed.
    expect(line(seen.fix, 'Task:')).toContain('fix the login');
  });
});
