import { describe, expect, it, vi, afterEach } from 'vitest';
import { App } from './App';
import { resetPalette, setPalette } from './palette';

/**
 * What a running App does when the palette changes under it — an Omarchy
 * theme switch, or "Follow Omarchy theme" switched in /settings. The colours
 * themselves are read at render time everywhere (palette.test.ts); the App's
 * part is the transcript, which it formats once and caches with the ANSI
 * baked in.
 */

const TEAL = '\x1b[38;2;0;128;128m';
const RED = '\x1b[38;2;240;42;48m';

function makeApp(options: { yolo?: boolean } = {}) {
  const app = new App({
    onSubmit: async () => {},
    onCommand: () => {},
    onExit: () => {},
    getStatus: () => ({
      version: '3.8.1', provider: 'OpenAI', model: 'gpt-5.6-terra', agentMode: 'on',
      projectPath: '/tmp/project', hasWriteAccess: true, sessionId: '', messageCount: 0,
    }),
    yolo: () => options.yolo ?? false,
  });
  const internals = app as unknown as {
    screen: Record<string, (...args: unknown[]) => unknown>;
    input: Record<string, (...args: unknown[]) => unknown>;
    getVisibleMessages: (height: number, width: number) => Array<{ text: string }>;
  };
  // Detach the Screen's resize listener so these Apps don't pile up on stdout.
  process.stdout.removeListener('resize', internals.screen.resizeHandler as () => void);
  // addMessage() and a repaint schedule a real render; keep its frame off
  // the test runner's stdout.
  for (const method of ['init', 'cleanup', 'render', 'fullRender']) {
    vi.spyOn(internals.screen, method).mockImplementation(() => {});
  }
  const transcript = () => internals.getVisibleMessages(40, 80).map(l => l.text).join('\n');
  return { app, internals, transcript };
}

afterEach(() => {
  resetPalette();
  vi.restoreAllMocks();
});

describe('App and the palette', () => {
  it('re-formats the cached transcript in the new colours', async () => {
    const { app, transcript } = makeApp();
    app.addMessage({ role: 'user', content: 'fix the **build**' });
    expect(transcript()).toContain(RED);

    setPalette({ primary: [0, 128, 128] });
    // The cache still holds the message as it was first formatted…
    expect(transcript()).toContain(RED);
    app.repaintInNewPalette();
    // …until the repaint drops it.
    expect(transcript()).toContain(TEAL);
    expect(transcript()).not.toContain(RED);
    // Let the renders this queued run now, against the stubbed Screen.
    await new Promise(resolve => setImmediate(resolve));
  });

  it('repaints on every palette change while started, and stops listening when stopped', async () => {
    const { app, internals } = makeApp();
    for (const method of ['start', 'stop', 'onKey']) vi.spyOn(internals.input, method).mockImplementation(() => {});
    const repaint = vi.spyOn(app, 'repaintInNewPalette');

    setPalette({ primary: [1, 1, 1] });
    expect(repaint).not.toHaveBeenCalled();

    app.start();
    setPalette({ primary: [0, 128, 128] });
    expect(repaint).toHaveBeenCalledTimes(1);

    // Let the render start() and the repaint scheduled run while the Screen
    // is still stubbed, rather than onto the test runner's stdout.
    await new Promise(resolve => setImmediate(resolve));
    app.stop();
    resetPalette();
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it('paints the status bar in the current brand colour', () => {
    const { app, internals } = makeApp();
    const styles: string[] = [];
    vi.spyOn(internals.screen, 'write').mockImplementation((...args: unknown[]) => {
      styles.push(String(args[2]) + String(args[3] ?? ''));
    });
    setPalette({ primary: [0, 128, 128] });
    (app as unknown as { renderStatusBar: (y: number, w: number, s: boolean) => void }).renderStatusBar(0, 80, true);
    expect(styles.join('')).toContain(TEAL + 'gpt-5.6-terra');
  });

  it('paints the YOLO badge and a warning toast in the current palette, and in 208 orange without a theme', () => {
    const statusBar = () => {
      const { app, internals } = makeApp({ yolo: true });
      const writes: string[] = [];
      vi.spyOn(internals.screen, 'write').mockImplementation((...args: unknown[]) => {
        writes.push(String(args[3] ?? '') + String(args[2]));
      });
      Object.assign(app, { notification: 'Rate limited, retrying in 4s', notificationIsWarn: true });
      (app as unknown as { renderStatusBar: (y: number, w: number, s: boolean) => void }).renderStatusBar(0, 80, true);
      return writes.join('');
    };
    expect(statusBar()).toContain('\x1b[48;5;208m\x1b[30m\x1b[1m YOLO ');
    expect(statusBar()).toContain('\x1b[38;5;208m Rate limited');

    setPalette({ yoloBadge: [223, 142, 29], yoloBadgeText: [0, 0, 0], warningToast: [135, 104, 74] });
    expect(statusBar()).toContain('\x1b[48;2;223;142;29m\x1b[38;2;0;0;0m\x1b[1m YOLO ');
    expect(statusBar()).toContain('\x1b[38;2;135;104;74m Rate limited');
  });

  it('paints the prompt that points at an open picker in the attention colour', () => {
    const { app, internals } = makeApp();
    const writes: string[] = [];
    vi.spyOn(internals.screen, 'write').mockImplementation((...args: unknown[]) => {
      writes.push(String(args[3] ?? '') + String(args[2]));
    });
    const renderInput = () => (app as unknown as { renderInput: (y: number, w: number) => void }).renderInput(0, 80);
    Object.assign(app, { menuOpen: true, menuItemsAll: [] });
    renderInput();
    expect(writes.join('')).toContain('\x1b[33mSelect an option below…');
    setPalette({ attention: [135, 104, 74] });
    renderInput();
    expect(writes.join('')).toContain('\x1b[38;2;135;104;74mSelect an option below…');
  });
});

// The startup questions are drawn by the App's own render pass, so they are
// repainted with the chat on a theme switch and on a resize — unlike the
// first-run provider picker before it (loginFlow.ts), which runs before the
// App and had to be wired up itself.
describe('an open question and the palette or the terminal size changing', () => {
  it('is repainted in the new colours, and after a resize', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    const app = new App({
      onSubmit: async () => {},
      onCommand: () => {},
      onExit: () => {},
      getStatus: () => ({
        version: '3.9.1', provider: 'Z.AI', model: 'glm-5.3', agentMode: 'off',
        projectPath: '/tmp/project', hasWriteAccess: false, sessionId: '', messageCount: 0,
      }),
    });
    const internals = app as unknown as { input: Record<string, (...args: unknown[]) => unknown> };
    for (const method of ['start', 'stop']) vi.spyOn(internals.input, method).mockImplementation(() => {});
    const settle = () => new Promise(resolve => setImmediate(resolve));
    // The diff renderer addresses every cell; the text is what is left
    // without the escapes.
    const text = () => writes.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    try {
      app.start();
      app.showPermission('/tmp/project', false, () => {});
      await settle();
      expect(text()).toContain('Folder Access');

      writes.length = 0;
      setPalette({ primary: [0, 128, 128] });
      await settle();
      expect(writes.join('')).toContain(TEAL + '\x1b[1mF');

      writes.length = 0;
      process.stdout.emit('resize');
      await settle();
      expect(text()).toContain('Folder Access');
    } finally {
      app.stop();
    }
  });
});
