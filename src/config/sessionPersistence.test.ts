import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real fs, with renameSync open to a one-off failure.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, renameSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import {
  autoSaveSession,
  config,
  deleteSession,
  flushAutoSave,
  getSessionInfo,
  listSessions,
  listSessionsWithInfo,
  loadSession,
  renameSession,
  saveSession,
  sessionNameProblem,
  startNewSession,
  type Message,
} from './index';

// A project directory, so sessions land in <root>/.codeep/sessions and every
// test starts from an empty store.
let root: string;

const said = (content: string): Message[] => [{ role: 'user', content }];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-sessions-'));
  writeFileSync(join(root, 'package.json'), '{}');
  config.set('autoSave', true);
  // Saves must stay local: no background title or profile calls.
  config.set('autoSessionTitle', false);
  config.set('autoLearnProfile', false);
});

afterEach(() => {
  // The debounce state is module-level; never let one test's save leak into the next.
  flushAutoSave();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('autoSaveSession', () => {
  it('saves into the conversation it was given, not the global current one', () => {
    // Day 2 started a new session; day 3 loaded the day-1 one back.
    config.set('currentSessionId', 'day2');
    saveSession('day2', said('DAY2 conversation'), root);
    saveSession('day1', said('DAY1 conversation'), root);

    vi.useFakeTimers();
    const resumed = [...said('DAY1 conversation'), ...said('day3 follow-up')];
    autoSaveSession(resumed, root, 'day1');
    vi.advanceTimersByTime(5000);

    expect(loadSession('day1', root)).toEqual(resumed);
    expect(loadSession('day2', root)).toEqual(said('DAY2 conversation'));
  });

  it('keeps the target it was asked for when the current session changes before the timer fires', () => {
    config.set('currentSessionId', 'before');
    vi.useFakeTimers();
    autoSaveSession(said('old turn'), root);
    const fresh = startNewSession();
    vi.advanceTimersByTime(5000);

    expect(loadSession('before', root)).toEqual(said('old turn'));
    expect(loadSession(fresh, root)).toBeNull();
  });

  it('writes a queued save for another conversation instead of dropping it', () => {
    vi.useFakeTimers();
    autoSaveSession(said('thread A'), root, 'thread-a');
    autoSaveSession(said('thread B'), root, 'thread-b');
    vi.advanceTimersByTime(5000);

    expect(loadSession('thread-a', root)).toEqual(said('thread A'));
    expect(loadSession('thread-b', root)).toEqual(said('thread B'));
  });

  it('flushAutoSave writes the pending save at once', () => {
    vi.useFakeTimers();
    autoSaveSession(said('last turn before quitting'), root, 'quitting');
    expect(loadSession('quitting', root)).toBeNull();

    expect(flushAutoSave()).toBe(true);
    expect(loadSession('quitting', root)).toEqual(said('last turn before quitting'));
    // Nothing left to write.
    expect(flushAutoSave()).toBe(false);
  });
});

describe('renameSession', () => {
  it('refuses to overwrite another saved session', () => {
    saveSession('auth-work', said('IMPORTANT old auth conversation'), root);
    saveSession('today', said('today'), root);

    expect(renameSession('today', 'auth-work', root)).toBe(false);

    expect(loadSession('auth-work', root)).toEqual(said('IMPORTANT old auth conversation'));
    expect(loadSession('today', root)).toEqual(said('today'));
  });

  it('keeps the session when renamed to its own name', () => {
    saveSession('mine', said('keep me'), root);

    expect(renameSession('mine', 'mine', root)).toBe(true);
    expect(loadSession('mine', root)).toEqual(said('keep me'));
  });

  it('keeps the session when only the case of the name changes', () => {
    // On a case-insensitive disk both names are one file.
    saveSession('auth-work', said('keep me'), root);

    expect(renameSession('auth-work', 'Auth-Work', root)).toBe(true);
    expect(listSessions(root)).toEqual(['Auth-Work']);
    expect(loadSession('Auth-Work', root)).toEqual(said('keep me'));
    // Listed under the name it loads by.
    expect(listSessionsWithInfo(root).map(s => s.name)).toEqual(['Auth-Work']);
  });

  it('keeps a save still waiting on its timer with the renamed session', () => {
    // /rename saves, renames, and the turn's debounced save fires afterwards.
    vi.useFakeTimers();
    autoSaveSession(said('latest turn'), root, 'old');
    saveSession('old', said('latest turn'), root);

    expect(renameSession('old', 'new', root)).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(listSessions(root)).toEqual(['new']);
    expect(loadSession('new', root)).toEqual(said('latest turn'));
  });

  it('keeps a waiting save that named no session with the renamed one', () => {
    config.set('currentSessionId', 'old2');
    vi.useFakeTimers();
    autoSaveSession(said('latest turn'), root);
    saveSession('old2', said('latest turn'), root);

    expect(renameSession('old2', 'new2', root)).toBe(true);
    // The next turn's save must not first write the old name back.
    autoSaveSession(said('next turn'), root, 'new2');
    expect(listSessions(root)).toEqual(['new2']);
    vi.advanceTimersByTime(5000);

    expect(listSessions(root)).toEqual(['new2']);
    expect(loadSession('new2', root)).toEqual(said('next turn'));
  });

  it('leaves a waiting save for another session alone', () => {
    vi.useFakeTimers();
    saveSession('other', said('other'), root);
    autoSaveSession(said('other, later'), root, 'other');
    saveSession('mine', said('mine'), root);

    expect(renameSession('mine', 'renamed', root)).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(listSessions(root)).toEqual(['other', 'renamed']);
    expect(loadSession('other', root)).toEqual(said('other, later'));
  });

  it('leaves the session as it was when the move fails', () => {
    saveSession('s-1', said('keep me'), root);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('EACCES'); });

    expect(renameSession('s-1', 'feature-auth', root)).toBe(false);

    expect(listSessionsWithInfo(root).map(s => s.name)).toEqual(['s-1']);
    expect(loadSession('s-1', root)).toEqual(said('keep me'));
    // No staged copy left behind either.
    expect(readdirSync(join(root, '.codeep', 'sessions'))).toEqual(['s-1.json']);
  });

  it('moves the session and the current id to the new name', () => {
    saveSession('draft', said('work'), root);
    config.set('currentSessionId', 'draft');

    expect(renameSession('draft', 'final', root)).toBe(true);
    expect(listSessions(root)).toEqual(['final']);
    expect(loadSession('final', root)).toEqual(said('work'));
    // Listed under the name it loads by.
    expect(listSessionsWithInfo(root).map(s => s.name)).toEqual(['final']);
    expect(config.get('currentSessionId')).toBe('final');
  });
});

describe('session names', () => {
  it('accepts the names Codeep creates and users type', () => {
    for (const name of [
      startNewSession(),
      '3f1c9a2e-5d4b-4c1a-9e7f-2b6d8c0a1e34',
      'context-session-2026-09-16-abcd1234',
      'my-feature-work',
      'Auth-Work',
      'v1.2 notes',
    ]) {
      expect(sessionNameProblem(name), name).toBeNull();
    }
  });

  it('explains why a name that would leave the sessions directory is refused', () => {
    expect(sessionNameProblem('../../x')).toMatch(/^Session name "\.\.\/\.\.\/x" cannot contain "\/"/);
    expect(sessionNameProblem('feature/auth')).toContain('cannot contain "/"');
    if (sep === '\\') expect(sessionNameProblem('..\\x')).toContain('cannot contain');
    expect(sessionNameProblem('..')).toBe('Session name ".." is not allowed.');
    expect(sessionNameProblem('')).toBe('Session name cannot be empty.');
    expect(sessionNameProblem('a\u0000b')).toContain('control characters');
  });

  it('does not save outside the sessions directory', () => {
    expect(saveSession('../../escaped', said('x'), root)).toBe(false);
    expect(saveSession('../escaped', said('x'), root)).toBe(false);

    expect(existsSync(join(root, 'escaped.json'))).toBe(false);
    expect(existsSync(join(root, '.codeep', 'escaped.json'))).toBe(false);
  });

  it('does not load, describe or delete a file outside the sessions directory', () => {
    mkdirSync(join(root, '.codeep', 'sessions'), { recursive: true });
    const outside = join(root, '.codeep', 'outside.json');
    writeFileSync(outside, JSON.stringify({ name: 'outside', history: said('not a session'), createdAt: '' }));

    expect(loadSession('../outside', root)).toBeNull();
    expect(getSessionInfo('../outside', root)).toBeNull();
    expect(deleteSession('../outside', root)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  // HEAD's `/rename a\b` made `a\b.json`: a backslash is an ordinary
  // filename character outside Windows.
  it.skipIf(sep === '\\')('can still open, rename and delete a session named with a backslash', () => {
    expect(sessionNameProblem('a\\b')).toBeNull();
    expect(sessionNameProblem('..\\x')).toBeNull();
    const dir = join(root, '.codeep', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a\\b.json'), JSON.stringify({ name: 'a\\b', history: said('legacy'), createdAt: '' }));

    expect(listSessionsWithInfo(root).map(s => s.name)).toEqual(['a\\b']);
    expect(loadSession('a\\b', root)).toEqual(said('legacy'));
    expect(getSessionInfo('a\\b', root)?.name).toBe('a\\b');
    expect(renameSession('a\\b', 'c\\d', root)).toBe(true);
    expect(readdirSync(dir)).toEqual(['c\\d.json']);
    expect(loadSession('c\\d', root)).toEqual(said('legacy'));
    expect(deleteSession('c\\d', root)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not rename to or from a name outside the sessions directory', () => {
    saveSession('s-1', said('keep me'), root);
    mkdirSync(join(root, 'feature'), { recursive: true });

    expect(renameSession('s-1', '../../feature/auth', root)).toBe(false);
    expect(renameSession('s-1', 'feature/auth', root)).toBe(false);
    expect(renameSession('../sessions/s-1', 'moved', root)).toBe(false);

    expect(listSessionsWithInfo(root).map(s => s.name)).toEqual(['s-1']);
    expect(loadSession('s-1', root)).toEqual(said('keep me'));
    expect(readdirSync(join(root, 'feature'))).toEqual([]);
  });
});
