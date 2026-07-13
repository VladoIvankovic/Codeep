import { describe, it, expect } from 'vitest';
import {
  buildSearchSnippets,
  parseKeepRecent,
  joinSessionName,
  parseTaskAddArgs,
  formatTaskList,
  TASK_TYPES,
} from './helpers';

// ─── buildSearchSnippets ──────────────────────────────────────────────────────
describe('buildSearchSnippets', () => {
  const messages = [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'The quick brown fox jumps' },
    { role: 'user', content: 'HELLO again' },
  ];

  it('returns matches case-insensitively', () => {
    const out = buildSearchSnippets(messages, 'hello');
    expect(out).toHaveLength(2);
    expect(out[0].messageIndex).toBe(0);
    expect(out[1].messageIndex).toBe(2);
  });

  it('returns an empty array when nothing matches', () => {
    expect(buildSearchSnippets(messages, 'nope')).toEqual([]);
  });

  it('includes the role and message index in each result', () => {
    const out = buildSearchSnippets(messages, 'fox');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].messageIndex).toBe(1);
  });

  it('collapses newlines in the snippet to spaces', () => {
    const msgs = [{ role: 'user', content: 'line one\nCODE\nline three' }];
    const out = buildSearchSnippets(msgs, 'code');
    expect(out[0].matchedText.includes('\n')).toBe(false);
  });

  it('adds a leading ellipsis when the match is not at the start', () => {
    const long = 'x'.repeat(60) + 'TARGET' + 'y'.repeat(60);
    const out = buildSearchSnippets([{ role: 'user', content: long }], 'target');
    expect(out[0].matchedText.startsWith('...')).toBe(true);
  });

  it('adds a trailing ellipsis when there is content after the window', () => {
    const long = 'TARGET' + 'y'.repeat(60);
    const out = buildSearchSnippets([{ role: 'user', content: long }], 'target');
    expect(out[0].matchedText.endsWith('...')).toBe(true);
  });

  it('omits the leading ellipsis when the match starts at index 0', () => {
    const out = buildSearchSnippets([{ role: 'user', content: 'target here' }], 'target');
    expect(out[0].matchedText.startsWith('...')).toBe(false);
  });

  it('matches only the first occurrence in a message', () => {
    const out = buildSearchSnippets([{ role: 'user', content: 'a a a' }], 'a');
    expect(out).toHaveLength(1);
  });

  it('handles an empty message list', () => {
    expect(buildSearchSnippets([], 'x')).toEqual([]);
  });

  it('handles an empty search term (matches everything at index 0)', () => {
    const out = buildSearchSnippets([{ role: 'user', content: 'hi' }], '');
    expect(out).toHaveLength(1);
  });
});

// ─── parseKeepRecent ──────────────────────────────────────────────────────────
describe('parseKeepRecent', () => {
  it('returns the fallback when the arg is undefined', () => {
    expect(parseKeepRecent(undefined)).toBe(4);
  });

  it('returns the parsed integer for a valid numeric arg', () => {
    expect(parseKeepRecent('10')).toBe(10);
  });

  it('clamps to a minimum of 2', () => {
    expect(parseKeepRecent('0')).toBe(2);
    expect(parseKeepRecent('1')).toBe(2);
    expect(parseKeepRecent('-5')).toBe(2);
  });

  it('returns the fallback when the arg is not a number', () => {
    expect(parseKeepRecent('abc')).toBe(4);
  });

  it('respects a custom fallback', () => {
    expect(parseKeepRecent(undefined, 8)).toBe(8);
    expect(parseKeepRecent('abc', 8)).toBe(8);
  });

  it('parses a string that starts with a number', () => {
    // parseInt('5xyz', 10) === 5 — documented behaviour.
    expect(parseKeepRecent('5xyz')).toBe(5);
  });

  it('handles the explicit "2" boundary', () => {
    expect(parseKeepRecent('2')).toBe(2);
  });
});

// ─── joinSessionName ──────────────────────────────────────────────────────────
describe('joinSessionName', () => {
  it('joins args with hyphens', () => {
    expect(joinSessionName(['my', 'session'])).toBe('my-session');
  });

  it('drops empty args', () => {
    expect(joinSessionName(['my', '', 'session', ''])).toBe('my-session');
  });

  it('returns an empty string for no args', () => {
    expect(joinSessionName([])).toBe('');
  });

  it('returns an empty string when all args are empty', () => {
    expect(joinSessionName(['', ''])).toBe('');
  });

  it('preserves a single arg', () => {
    expect(joinSessionName(['solo'])).toBe('solo');
  });

  it('does not collapse hyphens already in the args', () => {
    expect(joinSessionName(['a-b', 'c'])).toBe('a-b-c');
  });
});

// ─── parseTaskAddArgs ─────────────────────────────────────────────────────────
describe('parseTaskAddArgs', () => {
  it('parses a bare title with default type', () => {
    expect(parseTaskAddArgs(['fix', 'login'])).toEqual({
      title: 'fix login',
      description: '',
      type: 'task',
    });
  });

  it('sets the type via --bug', () => {
    expect(parseTaskAddArgs(['--bug', 'crash']).type).toBe('bug');
  });

  it('sets the type via --feature', () => {
    expect(parseTaskAddArgs(['--feature', 'dark mode']).type).toBe('feature');
  });

  it('sets the type via --task explicitly', () => {
    expect(parseTaskAddArgs(['--task', 'thing']).type).toBe('task');
  });

  it('captures --desc as the description', () => {
    const out = parseTaskAddArgs(['title', '--desc', 'a long description here']);
    expect(out.title).toBe('title');
    expect(out.description).toBe('a long description here');
  });

  it('captures --description as the description (alias)', () => {
    const out = parseTaskAddArgs(['title', '--description', 'details']);
    expect(out.description).toBe('details');
  });

  it('ends description capture at the next flag', () => {
    const out = parseTaskAddArgs(['title', '--desc', 'words', '--bug', 'more']);
    expect(out.description).toBe('words');
    expect(out.title).toBe('title more');
    expect(out.type).toBe('bug');
  });

  it('last --type flag wins', () => {
    expect(parseTaskAddArgs(['--bug', '--feature', 'x']).type).toBe('feature');
  });

  it('returns an empty title when only flags are given', () => {
    expect(parseTaskAddArgs(['--bug']).title).toBe('');
  });

  it('returns an empty title and description for no args', () => {
    expect(parseTaskAddArgs([])).toEqual({ title: '', description: '', type: 'task' });
  });

  it('lower-cases flag names', () => {
    expect(parseTaskAddArgs(['--BUG', 'x']).type).toBe('bug');
    expect(parseTaskAddArgs(['--Desc', 'text']).description).toBe('text');
  });

  it('ignores unknown flags but ends description capture', () => {
    const out = parseTaskAddArgs(['title', '--unknown', 'word', '--desc', 'd']);
    expect(out.title).toBe('title word');
    expect(out.description).toBe('d');
  });

  it('TASK_TYPES is task/bug/feature', () => {
    expect(TASK_TYPES).toEqual(['task', 'bug', 'feature']);
  });
});

// ─── formatTaskList ───────────────────────────────────────────────────────────
describe('formatTaskList', () => {
  it('renders a header with the scoped project name', () => {
    const out = formatTaskList([{ title: 't' }], 'myproj');
    expect(out.startsWith('## Tasks — myproj')).toBe(true);
  });

  it('renders a bare header when no project name is given', () => {
    const out = formatTaskList([{ title: 't' }]);
    expect(out.startsWith('## Tasks\n')).toBe(true);
  });

  it('numbers tasks starting at 1', () => {
    const out = formatTaskList([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    expect(out).toContain('1. [task] a');
    expect(out).toContain('2. [task] b');
    expect(out).toContain('3. [task] c');
  });

  it('uses the type icon when set', () => {
    const out = formatTaskList([
      { title: 'a', type: 'bug' },
      { title: 'b', type: 'feature' },
      { title: 'c', type: 'task' },
    ]);
    expect(out).toContain('[bug] a');
    expect(out).toContain('[feature] b');
    expect(out).toContain('[task] c');
  });

  it('falls back to [task] for unknown types', () => {
    const out = formatTaskList([{ title: 'a', type: 'weird' }]);
    expect(out).toContain('[task] a');
  });

  it('falls back to [task] when type is missing', () => {
    const out = formatTaskList([{ title: 'a' }]);
    expect(out).toContain('[task] a');
  });

  it('renders the description on a new line when present', () => {
    const out = formatTaskList([{ title: 'a', description: 'details here' }]);
    expect(out).toContain('   details here');
  });

  it('omits the description line when description is null', () => {
    const out = formatTaskList([{ title: 'a', description: null }]);
    expect(out).not.toContain('   ');
  });

  it('tags each row with the project name in a global listing', () => {
    const out = formatTaskList([{ title: 'a', project_name: 'proj-x' }]);
    expect(out).toContain('_(proj-x)_');
  });

  it('does not tag rows when scoped to a single project', () => {
    const out = formatTaskList([{ title: 'a', project_name: 'proj-x' }], 'proj-x');
    expect(out).not.toContain('_(proj-x)_');
  });

  it('uses singular "task" for a single pending task', () => {
    const out = formatTaskList([{ title: 'a' }]);
    expect(out).toContain('1 pending task.');
  });

  it('uses plural "tasks" for multiple pending tasks', () => {
    const out = formatTaskList([{ title: 'a' }, { title: 'b' }]);
    expect(out).toContain('2 pending tasks.');
  });

  it('includes the agent-context footer', () => {
    const out = formatTaskList([{ title: 'a' }]);
    expect(out).toContain('Tasks loaded into agent context');
  });
});
