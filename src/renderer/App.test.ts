import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { StatusInfo } from './components/Status';
import { stripAnsi } from './ansi';

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
