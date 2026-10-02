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

function makeApp() {
  const app = new App({
    onSubmit: async () => {},
    onCommand: () => {},
    onExit: () => {},
    getStatus: () => ({
      version: '3.8.1', provider: 'OpenAI', model: 'gpt-5.6-terra', agentMode: 'on',
      projectPath: '/tmp/project', hasWriteAccess: true, sessionId: '', messageCount: 0,
    }),
  });
  const internals = app as unknown as {
    screen: Record<string, (...args: unknown[]) => unknown>;
    input: Record<string, (...args: unknown[]) => unknown>;
    getVisibleMessages: (height: number, width: number) => Array<{ text: string }>;
  };
  // Detach the Screen's resize listener so these Apps don't pile up on stdout.
  process.stdout.removeListener('resize', internals.screen.resizeHandler as () => void);
  const transcript = () => internals.getVisibleMessages(40, 80).map(l => l.text).join('\n');
  return { app, internals, transcript };
}

afterEach(() => {
  resetPalette();
  vi.restoreAllMocks();
});

describe('App and the palette', () => {
  it('re-formats the cached transcript in the new colours', () => {
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
  });

  it('repaints on every palette change while started, and stops listening when stopped', async () => {
    const { app, internals } = makeApp();
    for (const method of ['init', 'cleanup', 'render']) vi.spyOn(internals.screen, method).mockImplementation(() => {});
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
});
