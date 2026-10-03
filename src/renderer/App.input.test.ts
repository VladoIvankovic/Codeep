import { describe, expect, it, vi, afterEach } from 'vitest';
import { App } from './App';
import { PASTE_END_WAIT_MS } from './Input';

/**
 * What the chat input does with a read from the terminal, end to end: the
 * App's real Input parses the chunk and the App acts on the keys. Found on
 * the Omarchy box with tmux: `send-keys "/skills bundles" Enter` showed
 * "/skills bundlesm" and sent nothing, and after `send-keys -l "<a long
 * prompt>"` the first Enter did nothing visible — a paste dialog had opened
 * below the status bar and that Enter only took the text into the input.
 */

type Internals = {
  screen: Record<string, (...args: unknown[]) => unknown>;
  input: { feed: (data: string) => void } & Record<string, (...args: unknown[]) => unknown>;
  editor: { getValue: () => string };
  pasteDialog: { open: boolean; info: { fullText: string } | null };
};

let running: App | null = null;

function startApp() {
  const onSubmit = vi.fn(async (_text: string) => {});
  const onCommand = vi.fn();
  const onExit = vi.fn();
  const app = new App({
    onSubmit,
    onCommand,
    onExit,
    getStatus: () => ({
      version: '3.9.1', provider: 'Z.AI', model: 'glm-5.3', agentMode: 'off',
      projectPath: '/tmp/project', hasWriteAccess: false, sessionId: '', messageCount: 0,
    }),
  });
  const internals = app as unknown as Internals;
  // Keep the Screen off stdout and the Input off the real stdin; the Input's
  // own parser (feed) is what is under test.
  process.stdout.removeListener('resize', internals.screen.resizeHandler as () => void);
  for (const method of ['init', 'cleanup', 'render', 'fullRender', 'invalidate']) {
    vi.spyOn(internals.screen, method).mockImplementation(() => {});
  }
  for (const method of ['start', 'stop']) vi.spyOn(internals.input, method).mockImplementation(() => {});
  app.start();
  running = app;
  const send = (chunk: string) => internals.input.feed(chunk);
  return { app, internals, send, onSubmit, onCommand, onExit };
}

afterEach(async () => {
  // Let renders scheduled by the keys run against the stubbed Screen.
  await new Promise(resolve => setImmediate(resolve));
  running?.stop();
  running = null;
  vi.restoreAllMocks();
});

describe('the chat input and one read from the terminal', () => {
  it('sends text that arrives together with its Enter', () => {
    const { internals, send, onSubmit } = startApp();
    send('what is 2 + 2?\r');
    expect(onSubmit).toHaveBeenCalledWith('what is 2 + 2?');
    expect(internals.editor.getValue()).toBe('');
  });

  it('runs a command that arrives together with its Enter', () => {
    const { internals, send, onCommand } = startApp();
    send('/skills bundles\r');
    expect(onCommand).toHaveBeenCalledWith('skills', ['bundles']);
    expect(internals.editor.getValue()).toBe('');
  });

  it('sends a long one-line paste on the first Enter after it', () => {
    const { internals, send, onSubmit } = startApp();
    const prompt = 'Use the omarchy skill: which of its files covers theming, and what is its first heading? Answer in one short line.';
    expect(prompt.length).toBeGreaterThan(100);
    send(prompt);
    expect(internals.pasteDialog.open).toBe(false);
    expect(internals.editor.getValue()).toBe(prompt);
    send('\r');
    expect(onSubmit).toHaveBeenCalledWith(prompt);
  });

  it('sends a long line that arrives together with its Enter', () => {
    const { send, onSubmit } = startApp();
    const prompt = 'x'.repeat(300);
    send(prompt + '\r');
    expect(onSubmit).toHaveBeenCalledWith(prompt);
  });

  it('still asks about a multi-line paste, and sends nothing', () => {
    const { internals, send, onSubmit } = startApp();
    send('\x1b[200~line 1\rline 2\rline 3\rline 4\r\x1b[201~');
    expect(internals.pasteDialog.open).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('takes text and Enter that arrive together as the reply while the agent runs', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const onStopAgent = vi.fn();
      const { app, internals, send, onSubmit } = startApp();
      (app as unknown as { options: { onStopAgent: () => void } }).options.onStopAgent = onStopAgent;
      app.setAgentRunning(true);
      send('f');
      send('ix it\r');
      expect(onStopAgent).toHaveBeenCalledTimes(1);
      expect(internals.editor.getValue()).toBe('fix it');
      app.setAgentRunning(false);
      vi.advanceTimersByTime(100);
      expect(onSubmit).toHaveBeenCalledWith('fix it');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps no carriage return from a clipboard paste in the input', () => {
    const { app, internals } = startApp();
    app.handlePaste('first\r\nsecond');
    expect(internals.editor.getValue()).toBe('first\nsecond');
  });
});

// A bracketed paste that pauses part-way for longer than PASTE_END_WAIT_MS:
// the first part is handed over, the rest comes later. Before, the rest was
// read as typed keys, so its line breaks were Enters and sent a broken part
// of the paste — the review's three cases below.
describe('a paste whose end marker is late', () => {
  function startPausedPaste() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onStopAgent = vi.fn();
    const started = startApp();
    (started.app as unknown as { options: { onStopAgent: () => void } }).options.onStopAgent = onStopAgent;
    const pause = () => vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    return { ...started, onStopAgent, pause };
  }

  afterEach(() => { vi.useRealTimers(); });

  it('(a) goes into the input whole, line breaks and all, and sends nothing', () => {
    const { internals, send, pause, onSubmit } = startPausedPaste();
    send('\x1b[200~line1\rline2\r');
    pause();
    send('line3\rline4\r\x1b[201~');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(internals.pasteDialog.open).toBe(false);
    expect(internals.editor.getValue()).toBe('line1\nline2\nline3\nline4');
  });

  it('(b) joins the paste dialog the first part opened, and Enter adds all of it', () => {
    const { internals, send, pause, onSubmit } = startPausedPaste();
    const first = 'x'.repeat(120);
    send(`\x1b[200~${first}\rline2\r`);
    pause();
    expect(internals.pasteDialog.open).toBe(true);
    // The rest in several reads, as a slow link delivers it.
    send('line3\r');
    pause();
    send('line4\r');
    send('line5\x1b[201~');
    expect(internals.pasteDialog.info?.fullText).toBe(`${first}\nline2\nline3\nline4\nline5`);
    expect(onSubmit).not.toHaveBeenCalled();

    send('\r');
    expect(internals.pasteDialog.open).toBe(false);
    expect(internals.editor.getValue()).toBe(`${first}\nline2\nline3\nline4\nline5`);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('(b) is not taken as the dialog\'s answer when the rest is one letter', () => {
    const { internals, send, pause } = startPausedPaste();
    const first = 'x'.repeat(120);
    send(`\x1b[200~${first}\rline2\r`);
    pause();
    expect(internals.pasteDialog.open).toBe(true);
    send('n\x1b[201~');
    expect(internals.pasteDialog.open).toBe(true);
    expect(internals.pasteDialog.info?.fullText).toBe(`${first}\nline2\nn`);
  });

  it('ends at a Ctrl+C pressed on its own, which quits as it always does', () => {
    const { send, pause, onExit, onSubmit } = startPausedPaste();
    send('\x1b[200~line1\rline2\r');
    pause();
    send('line3');
    send('\x03');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('(c) neither stops the agent nor sends anything while it runs', () => {
    const { app, internals, send, pause, onSubmit, onStopAgent } = startPausedPaste();
    app.setAgentRunning(true);
    send('\x1b[200~line1\rline2\r');
    pause();
    send('line3\rline4\r\x1b[201~');
    expect(onStopAgent).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(internals.editor.getValue()).toBe('line1\nline2\nline3\nline4');
    app.setAgentRunning(false);
  });
});

// /settings text fields took one character per event. A paste, or a value
// typed ahead and read together with its Enter, is one text event: it was
// dropped, and the Enter saved what the field held before.
describe('a /settings field and one read from the terminal', () => {
  async function editCustomBaseUrl() {
    const { config } = await import('../config/index');
    const { SETTINGS } = await import('./components/Settings');
    config.set('customBaseUrl', '');
    const started = startApp();
    started.app.showSettings();
    (started.internals as unknown as { settingsState: { selectedIndex: number } }).settingsState.selectedIndex =
      SETTINGS.findIndex(s => s.key === 'customBaseUrl');
    started.send('\r'); // edit the field
    return { ...started, config };
  }

  it('saves a value that arrives together with its Enter', async () => {
    const { send, config } = await editCustomBaseUrl();
    send('http://localhost:8080/v1\r');
    expect(config.get('customBaseUrl')).toBe('http://localhost:8080/v1');
  });

  it('takes a bracketed paste whole, and saves it on the Enter after it', async () => {
    const { send, config } = await editCustomBaseUrl();
    send('\x1b[200~http://gpu-box:8000/v1\n\x1b[201~');
    expect(config.get('customBaseUrl')).toBe('');
    send('\r');
    expect(config.get('customBaseUrl')).toBe('http://gpu-box:8000/v1');
  });
});

describe('the welcome block', () => {
  it('is rewritten in place, and only when there is one', () => {
    const { app } = startApp();
    const messages = () => (app as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    app.updateWelcome('nothing to update');
    expect(messages()).toEqual([]);

    app.addMessage({ role: 'welcome', content: 'Mode     Chat only' } as never);
    app.addMessage({ role: 'user', content: 'hi' });
    app.updateWelcome('Access   Read & Write');
    expect(messages().map(m => m.content)).toEqual(['Access   Read & Write', 'hi']);
  });
});
