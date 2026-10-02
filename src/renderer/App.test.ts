import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { StatusInfo } from './components/Status';
import { stripAnsi } from './ansi';
import { MASCOT_FRAMES, MASCOT_WIDTH, MASCOT_GAP } from './components/mascot';
import { LOGO_LINES } from './components/uiConstants';

/**
 * Renders one row of the App's own Screen and returns what landed on it.
 *
 * The header and status bar are private render helpers, so we drive them
 * directly and capture every `screen.write` instead of reaching into the
 * Screen's buffer.
 */
function renderRow(
  method: 'renderPersistentHeader' | 'renderStatusBar',
  status: Partial<StatusInfo>,
  width: number,
  mutate: (app: App) => void = () => {},
): string {
  const app = new App({
    onSubmit: async () => {},
    onCommand: () => {},
    onExit: () => {},
    getStatus: () => ({
      version: '2.16.0',
      provider: 'OpenAI',
      model: 'gpt-5.6-terra',
      agentMode: 'on',
      projectPath: '/tmp/project',
      hasWriteAccess: true,
      sessionId: 'abcdef1234',
      messageCount: 2,
      ...status,
    }),
  });
  mutate(app);

  const screen = (app as unknown as { screen: { write: (...args: unknown[]) => void } }).screen;
  const written: string[] = [];
  vi.spyOn(screen, 'write').mockImplementation((...args: unknown[]) => {
    written.push(stripAnsi(String(args[2])));
  });

  const render = (app as unknown as Record<string, (...args: number[]) => void>)[method];
  if (method === 'renderPersistentHeader') render.call(app, width);
  else render.call(app, 0, width);
  return written.join('');
}

describe('renderStatusBar', () => {
  const streaming = (app: App) => {
    (app as unknown as { isStreaming: boolean }).isStreaming = true;
  };
  const stats = {
    totalTokens: 48_720,
    promptTokens: 37_140,
    completionTokens: 11_580,
    requestCount: 9,
    estimatedCost: 0.2846,
    billableCost: 0.2846,
    hasFlatFeeUsage: false,
  };

  it('keeps "Esc to stop" on a wide terminal that also shows resource estimates', () => {
    const row = renderRow('renderStatusBar', { tokenStats: stats }, 140, streaming);
    expect(row).toContain('Esc to stop');
    expect(row).toContain('energy');
  });

  it('drops the resource estimate before the hint when space is tight', () => {
    const row = renderRow('renderStatusBar', { tokenStats: stats }, 120, streaming);
    expect(row).toContain('Esc to stop');
  });

  it('shows "in plan" instead of a price when all usage is flat-fee', () => {
    const row = renderRow(
      'renderStatusBar',
      { tokenStats: { ...stats, estimatedCost: 0.2846, billableCost: 0, hasFlatFeeUsage: true } },
      140,
      streaming,
    );
    expect(row).toContain('cost in plan');
    expect(row).not.toContain('0.28');
    expect(row).toContain('Esc to stop');
  });

  it('keeps the price and flags the plan usage in a mixed session', () => {
    const row = renderRow(
      'renderStatusBar',
      { tokenStats: { ...stats, estimatedCost: 0.2846, billableCost: 0.19, hasFlatFeeUsage: true } },
      140,
      streaming,
    );
    expect(row).toContain('cost $0.19 + in plan');
    expect(row).toContain('Esc to stop');
  });

  it('keeps "Esc to stop" at the narrow end of the wide footer with the longest cost segment', () => {
    // Worst case for the left segment: a sub-cent billable amount (4 decimals)
    // plus the "+ in plan" suffix plus the effort chip, at the 110-column
    // threshold where the wide footer kicks in.
    const row = renderRow(
      'renderStatusBar',
      {
        tokenStats: { ...stats, billableCost: 0.0028, hasFlatFeeUsage: true },
        reasoningEffort: 'max',
      },
      110,
      streaming,
    );
    expect(row).toContain('cost $0.0028 + in plan');
    expect(row).toContain('Esc to stop');
  });

  it('shows the reasoning-effort chip in the wide footer', () => {
    const row = renderRow(
      'renderStatusBar',
      { tokenStats: stats, reasoningEffort: 'max' },
      140,
      streaming,
    );
    expect(row).toContain('effort max');
  });
});

describe('renderPersistentHeader', () => {
  it('still renders the branch segment when the name must be truncated', () => {
    const branch = 'codex/' + 'a'.repeat(200);
    const row = renderRow('renderPersistentHeader', { branch }, 150);
    expect(row).toContain('branch: ');
    expect(row).toContain('codex/');
  });

  it('renders a short branch name in full', () => {
    const row = renderRow('renderPersistentHeader', { branch: 'main' }, 150);
    expect(row).toContain('branch: ');
    expect(row).toContain('main');
  });
});

describe('renderIntro', () => {
  type Write = { x: number; y: number; text: string };

  /** An App on a `width`×30 Screen that captures every write instead of drawing. */
  function introApp(width: number) {
    const app = new App({
      onSubmit: async () => {},
      onCommand: () => {},
      onExit: () => {},
      getStatus: () => ({
        version: '3.8.1', provider: 'OpenAI', model: 'gpt-5.6-terra', agentMode: 'on',
        projectPath: '/tmp/project', hasWriteAccess: true, sessionId: '', messageCount: 0,
      }),
    });
    const screen = (app as unknown as { screen: Record<string, (...args: unknown[]) => unknown> }).screen;
    // Detach the Screen's resize listener so these Apps don't pile up on stdout.
    process.stdout.removeListener('resize', screen.resizeHandler as () => void);
    vi.spyOn(screen, 'getSize').mockReturnValue({ width, height: 30 });
    vi.spyOn(screen, 'fullRender').mockImplementation(() => {});
    const writes: Write[] = [];
    vi.spyOn(screen, 'write').mockImplementation((...args: unknown[]) => {
      writes.push({ x: args[0] as number, y: args[1] as number, text: stripAnsi(String(args[2])) });
    });
    return { app, screen, writes };
  }

  /** Render one intro frame at `width`×30 and capture every write. */
  function renderIntro(width: number, phase: 'init' | 'decrypt' | 'done', progress: number): Write[] {
    const { app, writes } = introApp(width);
    Object.assign(app as unknown as Record<string, unknown>, { introPhase: phase, introProgress: progress });
    (app as unknown as { renderIntro: () => void }).renderIntro.call(app);
    return writes;
  }

  const TAGLINE = 'Deep into Code.';

  it('draws the mascot left of the wordmark, wordmark on mascot lines 1..6', () => {
    // 'done' so the wordmark is fully decrypted and comparable verbatim.
    const writes = renderIntro(120, 'done', 1);
    const mascot = writes.filter(w => (MASCOT_FRAMES.idle as readonly string[]).includes(w.text));
    expect(mascot.map(w => w.text)).toEqual(MASCOT_FRAMES.idle);
    const mascotX = mascot[0].x;
    const mascotTop = mascot[0].y;
    expect(mascotX).toBe(Math.floor((120 - (MASCOT_WIDTH + MASCOT_GAP + LOGO_LINES[0].length)) / 2));

    const logo = writes.filter(w => w.x !== mascotX && w.text !== TAGLINE);
    expect(logo.map(w => w.text)).toEqual(LOGO_LINES);
    expect(logo[0].x).toBe(mascotX + MASCOT_WIDTH + MASCOT_GAP);
    expect(logo[0].y).toBe(mascotTop + 1);
  });

  it('glances left a little way into the decrypt', () => {
    // 0.3 × 1500 ms = 450 ms → second step of centre → left → centre → right.
    const writes = renderIntro(120, 'decrypt', 0.3);
    expect(writes.map(w => w.text)).toContain(MASCOT_FRAMES.lookLeft[1]);
  });

  it('shows the plain idle mascot during the noise phase', () => {
    const writes = renderIntro(120, 'init', 0.5);
    expect(writes.map(w => w.text)).toEqual(expect.arrayContaining([...MASCOT_FRAMES.idle]));
  });

  it('starts the decrypt looking ahead and blinks exactly once over a real startIntro run', () => {
    vi.useFakeTimers();
    // The last noise tick leaves a random introProgress behind; 0.95 would
    // land the first decrypt frame on the blink if it leaked through.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.95);
    try {
      const { app, screen, writes } = introApp(120);
      // The chat screen drawn once the intro hands over.
      vi.spyOn(screen, 'render').mockImplementation(() => {});
      let introWrites = -1;
      app.startIntro(() => { introWrites = writes.length; });
      vi.advanceTimersByTime(3000);
      expect(introWrites).toBeGreaterThan(0);

      // One pupil row per rendered frame; collapse repeats into the sequence.
      const byPupils = new Map(Object.entries(MASCOT_FRAMES).map(([name, frame]) => [frame[1], name]));
      const frames = writes.slice(0, introWrites).map(w => byPupils.get(w.text)).filter(Boolean);
      const seq = frames.filter((name, i) => name !== frames[i - 1]);
      expect(seq).toEqual(['idle', 'lookLeft', 'idle', 'lookRight', 'idle', 'blink']);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('falls back to the wordmark alone when the terminal is too narrow', () => {
    const width = MASCOT_WIDTH + MASCOT_GAP + LOGO_LINES[0].length + 3;
    const writes = renderIntro(width, 'done', 1).filter(w => w.text !== TAGLINE);
    expect(writes.map(w => w.text)).toEqual(LOGO_LINES);
    expect(writes[0].x).toBe(Math.floor((width - LOGO_LINES[0].length) / 2));
    // Same vertical centring as before the mascot: 6 logo lines + gap + tagline.
    expect(writes[0].y).toBe(Math.floor((30 - LOGO_LINES.length - 2) / 2));
  });
});
