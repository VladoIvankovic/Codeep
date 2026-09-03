import { describe, it, expect } from 'vitest';
import {
  composeRunSummary,
  formatDuration,
  shouldNotify,
  NOTIFY_AFTER_MS,
  MAX_ANSWER_LENGTH,
} from './telegramNotify';

describe('shouldNotify', () => {
  it('stays quiet for a run you never stopped watching', () => {
    // A phone that buzzes for every `git status` gets muted within a day,
    // taking the notices that mattered with it.
    expect(shouldNotify(2_000, true)).toBe(false);
    expect(shouldNotify(NOTIFY_AFTER_MS - 1, true)).toBe(false);
  });

  it('fires once a run outlasts the coffee it was started for', () => {
    expect(shouldNotify(NOTIFY_AFTER_MS, true)).toBe(true);
    expect(shouldNotify(20 * 60_000, true)).toBe(true);
  });

  it('never fires when the feature is off, however long the run', () => {
    expect(shouldNotify(60 * 60_000, false)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('reads at a glance on a lock screen', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(4 * 60_000 + 12_000)).toBe('4m 12s');
    expect(formatDuration(63 * 60_000)).toBe('1h 03m');
  });
});

describe('composeRunSummary', () => {
  it('says what finished and how long it took', () => {
    const text = composeRunSummary({ task: 'Refactor auth flow', elapsedMs: 5 * 60_000 });
    expect(text).toContain('Refactor auth flow');
    expect(text).toContain('5m 00s');
    expect(text).toMatch(/finished/i);
  });

  it('marks a failed run rather than reporting it as done', () => {
    const text = composeRunSummary({
      task: 'Bump deps', elapsedMs: 90_000, failure: 'API error: 401',
    });
    expect(text).toMatch(/stopped/i);
    expect(text).toContain('API error: 401');
    expect(text).not.toMatch(/finished/i);
  });

  it('omits a cost line rather than printing a zero on a flat-fee plan', () => {
    const text = composeRunSummary({ task: 'Update docs', elapsedMs: 70_000, costUsd: 0, tokens: 0 });
    expect(text).not.toContain('$');
    expect(text).not.toMatch(/tokens/);
  });

  it('gives sub-cent amounts enough decimals to not read as free', () => {
    expect(composeRunSummary({ task: 'x', elapsedMs: 70_000, costUsd: 0.0042 })).toContain('$0.0042');
    expect(composeRunSummary({ task: 'x', elapsedMs: 70_000, costUsd: 1.5 })).toContain('$1.50');
  });

  it('carries no agent output for a run started at the terminal', () => {
    // The chat syncs to Telegram's servers, and a finished run can end with a
    // file it read or a secret inside an error. The answer travels only where
    // it was asked for, and at the terminal it is already on screen.
    const text = composeRunSummary({ task: 'Deploy', elapsedMs: 120_000, tokens: 128_000 });
    expect(text.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('carries the answer when the phone is the one that asked', () => {
    // "finished, 33K tokens" answers nothing you asked from a phone.
    const text = composeRunSummary({
      task: 'koliko datoteka', elapsedMs: 20_000, answer: 'U src/utils ima 140 datoteka.',
    });
    expect(text).toContain('U src/utils ima 140 datoteka.');
  });

  it('cuts an answer that would not fit, and says it cut it', () => {
    // Telegram refuses anything over 4096 characters outright, so an uncut
    // answer would arrive as no message at all.
    const text = composeRunSummary({
      task: 'x', elapsedMs: 20_000, answer: 'y'.repeat(MAX_ANSWER_LENGTH + 500),
    });
    expect(text.length).toBeLessThan(4096);
    expect(text).toMatch(/cut/i);
  });

  it('ignores an answer that is only whitespace', () => {
    const text = composeRunSummary({ task: 'x', elapsedMs: 20_000, answer: '   \n  ' });
    expect(text.split('\n').filter(Boolean).length).toBe(2);
  });
});
