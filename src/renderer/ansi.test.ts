import { describe, it, expect } from 'vitest';
import {
  styled,
  stripAnsi,
  stringWidth,
  charWidth,
  visibleLength,
  truncate,
  wordWrap,
  gradientText,
  style,
  fg,
} from './ansi';

// These pure helpers underpin every bit of TUI layout — width math, wrapping,
// truncation. A subtle bug here misaligns the whole renderer, so pin the
// behaviour down.

describe('charWidth', () => {
  it('counts ASCII as one column', () => {
    expect(charWidth('a')).toBe(1);
    expect(charWidth(' ')).toBe(1);
  });

  it('counts CJK and emoji as two columns', () => {
    expect(charWidth('中')).toBe(2);   // CJK ideograph
    expect(charWidth('あ')).toBe(2);   // hiragana
    expect(charWidth('😀')).toBe(2);   // emoji (astral plane)
  });

  it('counts control characters as zero', () => {
    expect(charWidth('\x00')).toBe(0);
    expect(charWidth('\x1b')).toBe(0);
  });
});

describe('stringWidth', () => {
  it('sums display columns, wide chars included', () => {
    expect(stringWidth('hello')).toBe(5);
    expect(stringWidth('中文')).toBe(4);
    expect(stringWidth('a中')).toBe(3);
    expect(stringWidth('')).toBe(0);
  });
});

describe('stripAnsi', () => {
  it('removes SGR escape sequences, keeps the text', () => {
    expect(stripAnsi(fg.red + 'x' + style.reset)).toBe('x');
    expect(stripAnsi(style.bold + fg.green + 'hi' + style.reset)).toBe('hi');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('visibleLength', () => {
  it('measures display width ignoring ANSI codes', () => {
    expect(visibleLength(fg.green + '中' + style.reset)).toBe(2);
    expect(visibleLength(fg.red + 'abc' + style.reset)).toBe(3);
  });
});

describe('styled', () => {
  it('wraps text in the given codes and a reset', () => {
    expect(styled('x', fg.red)).toBe(fg.red + 'x' + style.reset);
    expect(styled('x', style.bold, fg.red)).toBe(style.bold + fg.red + 'x' + style.reset);
  });

  it('returns the text unchanged when no styles are given', () => {
    expect(styled('x')).toBe('x');
  });
});

describe('truncate', () => {
  it('returns the string unchanged when it already fits', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates to the target width including the suffix', () => {
    const out = truncate('hello world', 8);
    expect(stripAnsi(out)).toBe('hello...');
    expect(visibleLength(out)).toBe(8);
  });

  it('never exceeds the requested width', () => {
    expect(visibleLength(truncate('a'.repeat(20), 10))).toBe(10);
  });
});

describe('wordWrap', () => {
  it('keeps a short string on one line', () => {
    expect(wordWrap('hello', 10)).toEqual(['hello']);
  });

  it('wraps long input across lines without losing or reordering words', () => {
    const lines = wordWrap('hello world foo bar', 11);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('hello world foo bar');
  });

  it('returns an empty array for an empty string', () => {
    expect(wordWrap('', 10)).toEqual([]);
  });
});

describe('gradientText', () => {
  it('returns the text unchanged with no colour stops', () => {
    expect(gradientText('x', [])).toBe('x');
  });

  it('only adds colour — the underlying text is preserved', () => {
    expect(stripAnsi(gradientText('abc', [[255, 0, 0], [0, 0, 255]]))).toBe('abc');
  });
});
