import { describe, it, expect } from 'vitest';
import { getPermissionOptions, truncatePath } from './Permission';

describe('getPermissionOptions', () => {
  it('returns the three permission levels in order', () => {
    expect(getPermissionOptions()).toEqual(['read', 'write', 'none']);
  });
});

describe('truncatePath', () => {
  it('returns the input unchanged when it fits within maxLen', () => {
    expect(truncatePath('/a/b', 100)).toBe('/a/b');
  });

  it('returns the input unchanged at the exact boundary', () => {
    expect(truncatePath('/a/b', 4)).toBe('/a/b');
  });

  it('truncates to the basename with a .../ prefix when the path is too long', () => {
    const out = truncatePath('/a/very/long/path/file.txt', 12);
    expect(out.startsWith('.../')).toBe(true);
    expect(out).toContain('file.txt');
  });

  it('keeps as many trailing segments as fit within maxLen', () => {
    // maxLen 20 — '/b/c' (4) + 3 for '.../' = 7 fits, try adding 'a': 'a/b/c' (5) + 3 = 8 fits.
    const out = truncatePath('/a/b/c', 20);
    expect(out).toBe('/a/b/c'); // whole path fits
  });

  it('drops leading segments that would overflow', () => {
    const out = truncatePath('/very/deep/nested/dir/file.txt', 18);
    // Should keep "nested/dir/file.txt" (20) or fewer, prefixing with ".../".
    expect(out.startsWith('.../') || out === 'nested/dir/file.txt').toBe(true);
    expect(out.length).toBeLessThanOrEqual(18 + 4); // body + prefix
  });

  it('returns the basename when the path is a single segment', () => {
    expect(truncatePath('file.txt', 4)).toBe('file.txt');
  });

  it('handles an empty path', () => {
    expect(truncatePath('', 10)).toBe('');
  });

  it('prefixes with .../ even for a one-slash path when it overflows', () => {
    // /file.txt splits to ['', 'file.txt']; the leading '' segment
    // reattaches as '/file.txt' (9 chars) which still overflows maxLen 5,
    // so we fall back to '.../file.txt'.
    expect(truncatePath('/file.txt', 5)).toBe('.../file.txt');
  });
});
