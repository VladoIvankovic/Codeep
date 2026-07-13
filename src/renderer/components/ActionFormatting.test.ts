import { describe, it, expect } from 'vitest';
import { getActionColor, formatActionTarget, getActionLabel } from './ActionFormatting';
import { fg } from '../ansi';

describe('getActionColor', () => {
  it('returns a known colour for each action kind', () => {
    expect(getActionColor('read')).toBe(fg.blue);
    expect(getActionColor('write')).toBe(fg.green);
    expect(getActionColor('edit')).toBe(fg.yellow);
    expect(getActionColor('delete')).toBe(fg.red);
    expect(getActionColor('command')).toBe(fg.magenta);
    expect(getActionColor('search')).toBe(fg.cyan);
    expect(getActionColor('mkdir')).toBe(fg.blue);
    expect(getActionColor('fetch')).toBe(fg.cyan);
  });

  it('falls back to fg.white for an unknown kind', () => {
    expect(getActionColor('unknown')).toBe(fg.white);
    expect(getActionColor('')).toBe(fg.white);
  });
});

describe('getActionLabel', () => {
  it('returns a present-tense label for each known action kind', () => {
    expect(getActionLabel('read')).toBe('Reading');
    expect(getActionLabel('write')).toBe('Creating');
    expect(getActionLabel('edit')).toBe('Editing');
    expect(getActionLabel('delete')).toBe('Deleting');
    expect(getActionLabel('command')).toBe('Running');
    expect(getActionLabel('search')).toBe('Searching');
    expect(getActionLabel('list')).toBe('Listing');
    expect(getActionLabel('mkdir')).toBe('Creating dir');
    expect(getActionLabel('fetch')).toBe('Fetching');
  });

  it('returns the raw type string for an unknown kind', () => {
    expect(getActionLabel('transmogrify')).toBe('transmogrify');
    expect(getActionLabel('')).toBe('');
  });
});

describe('formatActionTarget', () => {
  it('returns a short path unchanged', () => {
    expect(formatActionTarget('foo.ts', 40)).toBe('foo.ts');
    expect(formatActionTarget('src/foo.ts', 40)).toBe('src/foo.ts');
  });

  it('collapses a 3+ segment path to its last two segments', () => {
    expect(formatActionTarget('a/b/c.ts', 40)).toBe('.../b/c.ts');
    expect(formatActionTarget('a/b/c/d.ts', 40)).toBe('.../c/d.ts');
  });

  it('truncates from the left when the path exceeds maxLen', () => {
    const long = 'a/b/verylongfilenamethatexceedsthemax.ts';
    const out = formatActionTarget(long, 20);
    // The result is capped to maxLen exactly.
    expect(out).toHaveLength(20);
    // The tail is preserved (file extension survives) — that's the
    // useful part for the user to recognise.
    expect(out.endsWith('.ts')).toBe(true);
  });

  it('truncates a long non-path string from the left', () => {
    const out = formatActionTarget('this-is-a-very-long-filename-without-slashes', 15);
    expect(out).toHaveLength(15);
    expect(out.startsWith('...')).toBe(true);
  });

  it('returns the input verbatim when under maxLen', () => {
    const s = 'short';
    expect(formatActionTarget(s, 10)).toBe(s);
  });

  it('handles a path with only two segments (no collapse)', () => {
    // Two-segment paths are kept as-is — the `.../x/y` form needs at
    // least three segments to be shorter than the original.
    expect(formatActionTarget('pkg/file.ts', 40)).toBe('pkg/file.ts');
  });

  it('respects maxLen exactly when the collapsed path fits', () => {
    // `.../b/c.ts` is 10 chars; with maxLen 10 it should be returned as-is.
    expect(formatActionTarget('a/b/c.ts', 10)).toBe('.../b/c.ts');
  });
});
