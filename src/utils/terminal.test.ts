import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  supportsSynchronizedOutput,
  hideCursor,
  showCursor,
  clearLinesAbove,
  moveCursor,
  getTerminalSize,
  createSyncWriter,
} from './terminal';

function fakeStdout(columns = 80, rows = 24): any {
  const chunks: string[] = [];
  return {
    columns,
    rows,
    write: (s: string) => { chunks.push(s); return true; },
    chunks,
  };
}

describe('supportsSynchronizedOutput', () => {
  const ORIG_TERM_PROGRAM = process.env.TERM_PROGRAM;
  const ORIG_TERM = process.env.TERM;

  beforeEach(() => {
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM;
  });

  afterEach(() => {
    if (ORIG_TERM_PROGRAM !== undefined) process.env.TERM_PROGRAM = ORIG_TERM_PROGRAM;
    if (ORIG_TERM !== undefined) process.env.TERM = ORIG_TERM;
  });

  it('returns false when neither env var is set', () => {
    expect(supportsSynchronizedOutput()).toBe(false);
  });

  it.each(['ghostty', 'iterm.app', 'iterm2', 'kitty', 'wezterm', 'vscode', 'alacritty'])(
    'returns true for known terminal %s',
    (program) => {
      process.env.TERM_PROGRAM = program;
      expect(supportsSynchronizedOutput()).toBe(true);
    },
  );

  it('matches TERM_PROGRAM case-insensitively', () => {
    process.env.TERM_PROGRAM = 'GHOSTTY';
    expect(supportsSynchronizedOutput()).toBe(true);
  });

  it('matches a substring of TERM_PROGRAM (e.g. "VSCode.app")', () => {
    process.env.TERM_PROGRAM = 'something-vscode-other';
    expect(supportsSynchronizedOutput()).toBe(true);
  });

  it('returns true when TERM contains "xterm"', () => {
    process.env.TERM = 'xterm-256color';
    expect(supportsSynchronizedOutput()).toBe(true);
  });

  it('returns true when TERM contains "256color"', () => {
    process.env.TERM = 'screen-256color';
    expect(supportsSynchronizedOutput()).toBe(true);
  });

  it('returns false for an unknown TERM_PROGRAM and a plain TERM', () => {
    process.env.TERM_PROGRAM = 'unknown-term';
    process.env.TERM = 'dumb';
    expect(supportsSynchronizedOutput()).toBe(false);
  });
});

describe('hideCursor / showCursor', () => {
  it('writes the cursor-hide escape sequence', () => {
    const out = fakeStdout();
    hideCursor(out);
    expect(out.chunks).toEqual(['\x1b[?25l']);
  });

  it('writes the cursor-show escape sequence', () => {
    const out = fakeStdout();
    showCursor(out);
    expect(out.chunks).toEqual(['\x1b[?25h']);
  });

  it('is a no-op when stdout is undefined', () => {
    expect(() => hideCursor(undefined)).not.toThrow();
    expect(() => showCursor(undefined)).not.toThrow();
  });
});

describe('clearLinesAbove', () => {
  it('does nothing when lines is 0', () => {
    const out = fakeStdout();
    clearLinesAbove(out, 0);
    expect(out.chunks).toEqual([]);
  });

  it('does nothing when lines is negative', () => {
    const out = fakeStdout();
    clearLinesAbove(out, -3);
    expect(out.chunks).toEqual([]);
  });

  it('is a no-op when stdout is undefined', () => {
    expect(() => clearLinesAbove(undefined, 5)).not.toThrow();
  });

  it('moves up N lines, clears each, then returns to the top', () => {
    const out = fakeStdout();
    clearLinesAbove(out, 3);
    // 3 up + (clear+down)x2 + clear + 2 up
    expect(out.chunks).toEqual(['\x1b[3A\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[2A']);
  });

  it('clears a single line without moving down', () => {
    const out = fakeStdout();
    clearLinesAbove(out, 1);
    // 1 up + clear + 0 up
    expect(out.chunks).toEqual(['\x1b[1A\x1b[2K\x1b[0A']);
  });
});

describe('moveCursor', () => {
  it('is a no-op when lines is 0', () => {
    const out = fakeStdout();
    moveCursor(out, 0);
    expect(out.chunks).toEqual([]);
  });

  it('is a no-op when stdout is undefined', () => {
    expect(() => moveCursor(undefined, 5)).not.toThrow();
  });

  it('moves down with a positive count', () => {
    const out = fakeStdout();
    moveCursor(out, 3);
    expect(out.chunks).toEqual(['\x1b[3B']);
  });

  it('moves up with a negative count', () => {
    const out = fakeStdout();
    moveCursor(out, -2);
    expect(out.chunks).toEqual(['\x1b[2A']);
  });
});

describe('getTerminalSize', () => {
  it('returns the stream dimensions when available', () => {
    expect(getTerminalSize(fakeStdout(120, 40))).toEqual({ columns: 120, rows: 40 });
  });

  it('falls back to 80x24 when the stream is undefined', () => {
    expect(getTerminalSize(undefined)).toEqual({ columns: 80, rows: 24 });
  });
});

describe('createSyncWriter', () => {
  it('emits sync sequences around writes when sync output is supported', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    const out = fakeStdout();
    const writer = createSyncWriter(out);
    writer.startSync();
    writer.write('hello');
    writer.endSync();
    const joined = out.chunks.join('');
    expect(joined).toContain('\x1b[?2026h');
    expect(joined).toContain('\x1b[?2026l');
    expect(joined).toContain('hello');
  });

  it('is a transparent pass-through when sync output is unsupported', () => {
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM;
    const out = fakeStdout();
    const writer = createSyncWriter(out);
    writer.startSync();
    writer.write('hi');
    writer.endSync();
    const joined = out.chunks.join('');
    expect(joined).not.toContain('\x1b[?2026h');
    expect(joined).toBe('hi');
  });

  it('does not nest sync sequences (idempotent startSync)', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    const out = fakeStdout();
    const writer = createSyncWriter(out);
    writer.startSync();
    writer.startSync(); // second call should be a no-op
    writer.endSync();
    const joined = out.chunks.join('');
    expect(joined.match(/\x1b\[\?2026h/g)?.length).toBe(1);
  });

  it('write() still flushes even if startSync was not called', () => {
    const out = fakeStdout();
    const writer = createSyncWriter(out);
    writer.write('unbuffered');
    expect(out.chunks.join('')).toBe('unbuffered');
  });
});
