import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { stripAnsi } from './ansi';

/**
 * The `--yolo` badge on the status bar. Its whole job is to be there for the
 * whole run, so it is checked in every state the bar can be in — a toast
 * covering it for three seconds is exactly when nobody would think to look.
 */

type Write = { x: number; text: string; style: string };

/** One status-bar render at `width` columns, every write captured. */
function statusBar(width: number, yolo: boolean, state: Record<string, unknown> = {}): Write[] {
  const app = new App({
    onSubmit: async () => {},
    onCommand: () => {},
    onExit: () => {},
    getStatus: () => ({
      version: '3.8.1', provider: 'OpenAI', model: 'gpt-5.6-terra', agentMode: 'on',
      projectPath: '/tmp/project', hasWriteAccess: true, sessionId: 'abcdef1234', messageCount: 2,
      tokenStats: {
        totalTokens: 48_720, promptTokens: 37_140, completionTokens: 11_580, requestCount: 9,
        estimatedCost: 0.2846, billableCost: 0.2846, hasFlatFeeUsage: false,
      },
    }),
    yolo: () => yolo,
  });
  Object.assign(app as unknown as Record<string, unknown>, state);
  const screen = (app as unknown as { screen: Record<string, (...args: unknown[]) => unknown> }).screen;
  // Detach the Screen's resize listener so these Apps don't pile up on stdout.
  process.stdout.removeListener('resize', screen.resizeHandler as () => void);
  const writes: Write[] = [];
  vi.spyOn(screen, 'write').mockImplementation((...args: unknown[]) => {
    writes.push({ x: args[0] as number, text: stripAnsi(String(args[2])), style: String(args[3] ?? '') });
  });
  (app as unknown as { renderStatusBar: (y: number, w: number, s: boolean) => void }).renderStatusBar(0, width, true);
  return writes;
}

const badge = (writes: Write[]) => writes.find(w => w.text === ' YOLO ');

describe('the --yolo badge', () => {
  const states: Array<[string, number, Record<string, unknown>]> = [
    ['the wide footer', 140, {}],
    ['the compact footer', 80, {}],
    ['a notification', 140, { notification: 'MCP: 3 tool(s) from 1 server(s) ready. Type /mcp.' }],
    ['a warning', 80, { notification: 'Telegram: webhook set on the bot', notificationIsWarn: true }],
    ['the "new messages below" badge', 140, { scrollOffset: 4, unseenWhileScrolled: 2 }],
  ];

  for (const [name, width, state] of states) {
    it(`leads the line over ${name}`, () => {
      const writes = statusBar(width, true, state);
      expect(badge(writes)).toMatchObject({ x: 0 });
      // In the warning orange, on its own background so it reads as a badge.
      expect(badge(writes)?.style).toContain('\x1b[48;5;208m');
      // Nothing else is drawn over it. (The empty write is the line being
      // cleared first.)
      for (const w of writes) {
        if (w !== badge(writes) && w.text !== '') expect(w.x).toBeGreaterThanOrEqual(' YOLO '.length);
      }
    });
  }

  it('keeps what the line said, moved over', () => {
    const wide = statusBar(140, true).map(w => w.text).join('');
    expect(wide).toContain('runtime');
    expect(wide).toContain('/help');
    const toast = statusBar(80, true, { notification: 'Read & Write access granted' }).map(w => w.text).join('');
    expect(toast).toContain('Read & Write access granted');
  });

  it('is not there without --yolo', () => {
    for (const [, width, state] of states) {
      expect(badge(statusBar(width, false, state))).toBeUndefined();
    }
  });
});
