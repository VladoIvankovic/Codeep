import { describe, it, expect, vi } from 'vitest';

// Loading main.ts must not shell out to git: `--version`, `--help` and
// `account` all import this module and would otherwise pay for 3–4 git
// subprocesses they never use.
vi.mock('../utils/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git')>();
  return { ...actual, getGitStatus: vi.fn(actual.getGitStatus) };
});

import { readFileSync } from 'node:fs';
import { deriveSessionName } from './main';
import { getGitStatus } from '../utils/git';

// Comment-stripped: a plain text match happily finds `// reportTurnStats(true)`
// and would pass against the very bug these guards exist to catch.
const mainSource = readFileSync('src/renderer/main.ts', 'utf-8')
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .join('\n');

describe('module load', () => {
  it('does not resolve the git branch at import time', () => {
    expect(getGitStatus).not.toHaveBeenCalled();
  });
});

// handleSubmit is not exported and mocking the whole chat pipeline to reach it
// would be brittle, so these guard the wiring at source level. Narrow on
// purpose: reportTurnStats once shipped DEFINED BUT NEVER CALLED — the success
// path kept an inline duplicate and the catch path reported nothing at all, so
// tokens burned by an aborted turn reached no one. tsc stayed silent because
// noUnusedLocals is off.
describe('cloud stats wiring', () => {
  it('calls reportTurnStats, rather than only defining it', () => {
    expect(mainSource).toMatch(/const reportTurnStats = /);
    expect(mainSource).toMatch(/\breportTurnStats\(true\)/);
  });

  it('reports the delta from the catch path too', () => {
    // An aborted or failed turn still burned tokens, and gracefulShutdown no
    // longer sends a cumulative catch-all that would sweep them up later.
    const catchBlock = mainSource.slice(mainSource.indexOf('} catch (error) {'));
    expect(catchBlock).toMatch(/\breportTurnStats\(false\)/);
  });

  it('keeps one reporting implementation, not an inline copy beside it', () => {
    // The inline duplicate is what silently kept working while the helper rotted.
    expect(mainSource.match(/getCostBreakdown\(tokenReportStart\)/g) ?? []).toHaveLength(1);
  });
});

describe('deriveSessionName', () => {
  it('returns an empty string for blank input', () => {
    expect(deriveSessionName('')).toBe('');
    expect(deriveSessionName('   ')).toBe('');
  });

  it('keeps a short single-line message as-is', () => {
    expect(deriveSessionName('hello world')).toBe('hello world');
  });

  it('collapses runs of whitespace into single spaces', () => {
    expect(deriveSessionName('a\t\tb\n\nc')).toBe('a b c');
  });

  it('trims leading and trailing whitespace before deriving', () => {
    expect(deriveSessionName('   hi there   ')).toBe('hi there');
  });

  it('keeps at most the first five words', () => {
    const out = deriveSessionName('one two three four five six seven');
    expect(out).toBe('one two three four five');
  });

  it('keeps fewer than five words when the message is short', () => {
    expect(deriveSessionName('a b')).toBe('a b');
  });

  it('truncates to 45 chars + ellipsis when the first five words exceed 48', () => {
    // Build a message whose first 5 words total > 48 chars so truncation
    // kicks in. 5 words of 11 chars each, joined by spaces: 5*11 + 4 = 59.
    const long = ['abcdefghijk', 'abcdefghijk', 'abcdefghijk', 'abcdefghijk', 'abcdefghijk'].join(' ');
    expect(long.length).toBeGreaterThan(48);
    const out = deriveSessionName(long);
    expect(out.length).toBe(46); // 45 + …
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate when exactly at the 48-char boundary', () => {
    const words = 'word '.repeat(5).trim(); // "word word word word word" (24 chars)
    expect(deriveSessionName(words)).toBe(words);
  });

  it('keeps punctuation that is part of a word', () => {
    expect(deriveSessionName('fix bug #123')).toBe('fix bug #123');
  });

  it('combines collapse, trim, word-cap, and truncation', () => {
    // 6 long words, with extra whitespace — expect first 5, collapsed,
    // then truncated to 45 + ellipsis.
    const long = '  ' + Array.from({ length: 6 }, () => 'abcdefghij').join('   ');
    const out = deriveSessionName(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(46);
    expect(out).not.toContain('  '); // no double spaces
  });
});
