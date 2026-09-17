import { describe, it, expect, vi } from 'vitest';

// On Windows a backslash separates paths as much as a slash does. The rule
// reads path.sep, so this file runs it as Windows sees it on any machine.
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual, sep: '\\' };
});

import { sessionNameProblem } from './index';

describe('session names on Windows', () => {
  it('refuses a backslash as well as a slash', () => {
    expect(sessionNameProblem('..\\..\\x')).toBe('Session name "..\\..\\x" cannot contain "/" or "\\".');
    expect(sessionNameProblem('a\\b')).toContain('cannot contain');
    expect(sessionNameProblem('feature/auth')).toContain('cannot contain');
    expect(sessionNameProblem('my-feature-work')).toBeNull();
  });
});
