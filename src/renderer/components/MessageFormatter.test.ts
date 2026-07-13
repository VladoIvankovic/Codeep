import { describe, it, expect } from 'vitest';
import {
  applyInlineMarkdown,
  wordWrap,
  formatTextLines,
  formatCodeBlock,
  formatMessage,
  type BlockCounter,
} from './MessageFormatter';

// Helper: strip ANSI escapes so assertions can compare visible text.
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, '');
const stripLines = (lines: { text: string }[]) => lines.map(l => strip(l.text));

describe('applyInlineMarkdown', () => {
  it('returns input unchanged when no markdown is present', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('plain text');
    expect(strip(formatted)).toBe('plain text');
    expect(hasFormatting).toBe(false);
  });

  it('highlights inline code', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('use `foo` here');
    expect(hasFormatting).toBe(true);
    expect(strip(formatted)).toBe('use foo here');
  });

  it('renders bold via **', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('**bold**');
    expect(hasFormatting).toBe(true);
    expect(strip(formatted)).toBe('bold');
  });

  it('renders italic via *', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('*italic*');
    expect(hasFormatting).toBe(true);
    expect(strip(formatted)).toBe('italic');
  });

  it('renders bold+italic via ***', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('***both***');
    expect(hasFormatting).toBe(true);
    expect(strip(formatted)).toBe('both');
  });

  it('renders strikethrough via ~~', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('~~deleted~~');
    expect(hasFormatting).toBe(true);
    expect(strip(formatted)).toBe('deleted');
  });

  it('leaves an unclosed marker as literal text', () => {
    const { formatted, hasFormatting } = applyInlineMarkdown('foo `bar');
    expect(hasFormatting).toBe(false);
    expect(strip(formatted)).toBe('foo `bar');
  });
});

describe('wordWrap', () => {
  it('returns a single line when text fits', () => {
    expect(wordWrap('hello', 10)).toEqual(['hello']);
  });

  it('wraps at word boundaries', () => {
    expect(wordWrap('hello world foo bar', 11)).toEqual([
      'hello world',
      'foo bar',
    ]);
  });

  it('hard-breaks words wider than maxWidth', () => {
    const long = '/Users/foo/projects/very-long-path-with-no-spaces/file.ts';
    const wrapped = wordWrap(long, 20);
    // Each line must be ≤ 20 visible characters.
    for (const line of wrapped) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
    // And the concatenation equals the original.
    expect(wrapped.join('')).toBe(long);
  });

  it('returns [""] for empty input', () => {
    expect(wordWrap('', 10)).toEqual(['']);
  });
});

describe('formatTextLines', () => {
  it('renders a heading with a level-based colour', () => {
    const lines = formatTextLines('## Title', 80, '', '');
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toBe(true);
    expect(strip(lines[0].text)).toBe('Title');
  });

  it('renders a horizontal rule', () => {
    const lines = formatTextLines('---', 80, '', '');
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toBe(true);
    expect(strip(lines[0].text)).toMatch(/─+/);
  });

  it('renders a blockquote with a body', () => {
    const lines = formatTextLines('> quoted', 80, '', '');
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toBe(true);
    expect(strip(lines[0].text)).toBe('│ quoted');
  });

  it('renders a bullet list item', () => {
    const lines = formatTextLines('- item', 80, '', '');
    expect(strip(lines[0].text)).toBe('▸ item');
  });

  it('renders a numbered list item with the original number', () => {
    const lines = formatTextLines('3. third', 80, '', '');
    expect(strip(lines[0].text)).toBe('3. third');
  });

  it('applies the firstPrefix to the first line only', () => {
    const lines = formatTextLines('line1\nline2', 80, '> ', '');
    expect(strip(lines[0].text)).toBe('> line1');
    expect(strip(lines[1].text)).toBe('  line2');
  });
});

describe('formatCodeBlock', () => {
  it('renders the language label and the source', () => {
    const lines = formatCodeBlock('const x = 1', 'ts', 80, 1);
    // Label line, code line, trailing blank.
    expect(lines).toHaveLength(3);
    expect(strip(lines[0].text)).toBe('  ts [1]');
    expect(strip(lines[1].text)).toBe('    const x = 1');
    expect(lines[1].raw).toBe(true);
    expect(lines[2].text).toBe('');
  });

  it('omits the label when lang is empty and blockNum is absent', () => {
    const lines = formatCodeBlock('x', '', 80);
    // No label line — just code + trailing blank.
    expect(lines).toHaveLength(2);
    expect(strip(lines[0].text)).toBe('    x');
  });

  it('drops a single trailing blank line from the source', () => {
    const lines = formatCodeBlock('foo\n', 'ts', 80, 1);
    // Label + foo + trailing blank (the source's trailing \n was stripped).
    expect(lines).toHaveLength(3);
    expect(strip(lines[1].text)).toBe('    foo');
  });
});

describe('formatMessage', () => {
  it('renders an assistant message with the codeep header', () => {
    const counter: BlockCounter = { current: 0 };
    const lines = formatMessage('assistant', 'hello world', 80, counter);
    expect(counter.current).toBe(0); // no code blocks
    // Header line + body + trailing blank.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(strip(lines[0].text)).toContain('codeep');
  });

  it('renders a user message with the bar prefix', () => {
    const counter: BlockCounter = { current: 0 };
    const lines = formatMessage('user', 'hi there', 80, counter);
    // First line starts with the user bar character (▌).
    expect(strip(lines[0].text).startsWith('▌')).toBe(true);
  });

  it('renders a system message with the diamond prefix', () => {
    const counter: BlockCounter = { current: 0 };
    const lines = formatMessage('system', 'note', 80, counter);
    expect(strip(lines[0].text).startsWith('▸')).toBe(true);
  });

  it('increments the counter once per fenced code block', () => {
    const counter: BlockCounter = { current: 0 };
    const content = 'before\n```ts\nconst x = 1\n```\nbetween\n```js\ny = 2\n```\nafter';
    formatMessage('assistant', content, 80, counter);
    expect(counter.current).toBe(2);
  });

  it('keeps the block number stable across consecutive calls', () => {
    const counter: BlockCounter = { current: 0 };
    const content = '```ts\nconst x = 1\n```';
    const first = formatMessage('assistant', content, 80, counter);
    // First call: block 1. The label line carries the language tag + [1].
    const firstLabel = stripLines(first).find(t => t.includes('ts [1]'));
    expect(firstLabel).toBeDefined();
    const second = formatMessage('assistant', content, 80, counter);
    // Second call: block 2 (counter carried over).
    const secondLabel = stripLines(second).find(t => t.includes('ts [2]'));
    expect(secondLabel).toBeDefined();
  });

  it('renders a code block in the middle of prose', () => {
    const counter: BlockCounter = { current: 0 };
    const content = 'Intro\n```ts\ncode\n```\nOutro';
    const lines = formatMessage('assistant', content, 80, counter);
    const texts = stripLines(lines);
    expect(texts).toContain('  ts [1]');
    expect(texts).toContain('    code');
    // Intro and Outro are both present.
    expect(texts.some(t => t.includes('Intro'))).toBe(true);
    expect(texts.some(t => t.includes('Outro'))).toBe(true);
  });
});
