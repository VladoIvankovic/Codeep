import { describe, expect, it, vi, afterEach } from 'vitest';
import { App, QUESTION_ARM_MS } from './App';

/**
 * The startup questions answered from the keyboard, through the App's real
 * Input. "Set as Project?" says "y/n quick • Enter confirm"; on the Omarchy
 * box "y" only moved the selection. Answered at once, "y" also hands the
 * next key to the next question — the Folder Access list it opens — so a
 * "y" followed by a habitual Enter, or "y\r" in one read, must not pick that
 * list's first entry unseen.
 *
 * Only a question that opts in answers on one key. One that approves an
 * agent's action keeps y/n as a selection that Enter confirms, and says so.
 */

type Internals = {
  screen: Record<string, (...args: unknown[]) => unknown>;
  input: { feed: (data: string) => void } & Record<string, (...args: unknown[]) => unknown>;
  editor: { getValue: () => string };
  confirmOpen: boolean;
  confirmSelection: 'yes' | 'no' | 'extra';
  permissionOpen: boolean;
};

let running: App | null = null;
let now = 1_000_000;

function startApp() {
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const app = new App({
    onSubmit: async () => {},
    onCommand: () => {},
    onExit: () => {},
    getStatus: () => ({
      version: '3.9.1', provider: 'Z.AI', model: 'glm-5.3', agentMode: 'off',
      projectPath: '/tmp/project', hasWriteAccess: false, sessionId: '', messageCount: 0,
    }),
  });
  const internals = app as unknown as Internals;
  process.stdout.removeListener('resize', internals.screen.resizeHandler as () => void);
  for (const method of ['init', 'cleanup', 'render', 'fullRender', 'invalidate']) {
    vi.spyOn(internals.screen, method).mockImplementation(() => {});
  }
  for (const method of ['start', 'stop']) vi.spyOn(internals.input, method).mockImplementation(() => {});
  // Every line drawn, so a test can read the key hint under a question.
  const lines: string[] = [];
  const writeLine = internals.screen.writeLine.bind(internals.screen);
  vi.spyOn(internals.screen, 'writeLine').mockImplementation((...args: unknown[]) => {
    lines.push(String(args[1]));
    return writeLine(...args);
  });
  app.start();
  running = app;
  const send = (chunk: string) => internals.input.feed(chunk);
  const later = (ms = QUESTION_ARM_MS) => { now += ms; };
  /** Each character in its own read, `ms` apart: someone typing. */
  const type = (text: string, ms = 80) => { for (const ch of text) { send(ch); later(ms); } };
  const drawn = async () => {
    lines.length = 0;
    await new Promise(resolve => setImmediate(resolve));
    return lines;
  };
  return { app, internals, send, later, type, drawn };
}

/** "Set as Project?" whose Yes opens Folder Access, as startup does. */
function askSetAsProject(app: App) {
  const access = vi.fn();
  const onConfirm = vi.fn(() => app.showPermission('/tmp/project', false, access));
  const onCancel = vi.fn();
  app.showConfirm({
    title: 'Set as Project?',
    message: ['Would you like to use it as a Codeep project?'],
    confirmLabel: 'Yes, set as project',
    cancelLabel: 'No, chat only',
    quickAnswer: true, // as main.ts asks it
    onConfirm,
    onCancel,
  });
  return { onConfirm, onCancel, access };
}

/** The agent's "Allow this action?", as agentExecution.ts asks it. */
function askAllowAction(app: App) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  app.showConfirm({
    title: '⚠️  Confirm Action',
    message: ['The agent wants to execute:', '', '  execute_command', '  rm -rf build', '', 'Allow this action?'],
    confirmLabel: 'Allow',
    cancelLabel: 'Deny',
    extraOption: { label: 'Always Allow', onSelect: vi.fn() },
    onConfirm,
    onCancel,
  });
  return { onConfirm, onCancel };
}

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  running?.stop();
  running = null;
  vi.restoreAllMocks();
});

describe('y/n quick', () => {
  it('"y" answers "Set as Project?" without an Enter', () => {
    const { app, internals, send, later } = startApp();
    const { onConfirm } = askSetAsProject(app);
    later();
    send('y');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(internals.confirmOpen).toBe(false);
    expect(internals.permissionOpen).toBe(true);
  });

  it('"n" answers it without an Enter', () => {
    const { app, internals, send, later } = startApp();
    const { onConfirm, onCancel } = askSetAsProject(app);
    later();
    send('n');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(internals.confirmOpen).toBe(false);
  });
});

describe('a question that approves an agent action', () => {
  it('takes y and n as a selection, and Enter as the answer', () => {
    const { app, internals, send, later } = startApp();
    const { onConfirm, onCancel } = askAllowAction(app);
    later();
    send('y');
    expect(internals.confirmOpen).toBe(true);
    expect(internals.confirmSelection).toBe('yes');
    send('n');
    expect(internals.confirmSelection).toBe('no');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    send('y');
    send('\r');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(internals.confirmOpen).toBe(false);
  });

  it('"n" then Enter denies', () => {
    const { app, send, later } = startApp();
    const { onConfirm, onCancel } = askAllowAction(app);
    later();
    send('n');
    expect(onCancel).not.toHaveBeenCalled();
    send('\r');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('the key hint under a question', () => {
  it('says "y/n quick" where one key answers', async () => {
    const { app, drawn } = startApp();
    askSetAsProject(app);
    expect(await drawn()).toContain('←/→ select • y/n quick • Enter confirm • Esc cancel');
  });

  it('does not where y and n only select', async () => {
    const { app, drawn } = startApp();
    askAllowAction(app);
    const lines = await drawn();
    expect(lines).toContain('←/→ or y/n select • Enter confirm • Esc cancel');
    expect(lines.join('\n')).not.toContain('y/n quick');
  });
});

// The wait is a quiet period: every key that arrives during it starts it
// again. Counted only from the moment the question appeared, a "y" in text
// still being typed answered it 300 ms later.
describe('someone still typing as a question appears', () => {
  it('never answers a quick question, and a key after a pause does', () => {
    const { app, internals, type, send, later } = startApp();
    type('plea');
    const { onConfirm, onCancel } = askSetAsProject(app);
    type('se deploy now and say yes');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(internals.confirmOpen).toBe(true);
    // What was typed before it appeared is still in the input.
    expect(internals.editor.getValue()).toBe('plea');

    later();
    send('y');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('never selects or confirms an agent action, and Enter after a pause does', () => {
    const { app, internals, type, send, later } = startApp();
    type('plea');
    const { onConfirm, onCancel } = askAllowAction(app);
    type('se say yes\r');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(internals.confirmSelection).toBe('no');

    later();
    send('\r');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('a key meant for the question before', () => {
  it('"y" and Enter in one read do not also answer Folder Access', () => {
    const { app, internals, send, later } = startApp();
    const { onConfirm, access } = askSetAsProject(app);
    later();
    send('y\r');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(access).not.toHaveBeenCalled();
    expect(internals.permissionOpen).toBe(true);
  });

  it('a habitual Enter right after "y" is not taken as the next answer', () => {
    const { app, internals, send, later } = startApp();
    const { access } = askSetAsProject(app);
    later();
    send('y');
    later(QUESTION_ARM_MS / 2);
    send('\r');
    expect(access).not.toHaveBeenCalled();
    expect(internals.permissionOpen).toBe(true);

    // Once the question has been up a moment, Enter answers it.
    later();
    send('\r');
    expect(access).toHaveBeenCalledWith('read');
  });

  it('a key typed as the question appears is not its answer', () => {
    const { app, internals, send, later } = startApp();
    const { onConfirm } = askSetAsProject(app);
    send('y');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(internals.confirmOpen).toBe(true);
    later();
    send('y');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
