import { describe, it, expect } from 'vitest';
import { filterCommands, detectMentionQuery } from './Autocomplete';

const COMMANDS = [
  'help',
  'clear',
  'exit',
  'login',
  'logout',
  'status',
  'multiline',
  'session',
  'settings',
  'share',
  'search',
];

describe('filterCommands', () => {
  it('returns null for a non-command input (no leading slash)', () => {
    expect(filterCommands('hello', COMMANDS)).toBeNull();
    expect(filterCommands('help', COMMANDS)).toBeNull();
  });

  it('returns null once the user starts typing an argument', () => {
    // `/help world` — space present, the user has moved past the command
    // name so the dropdown should close.
    expect(filterCommands('/help world', COMMANDS)).toBeNull();
    expect(filterCommands('/status ', COMMANDS)).toBeNull();
  });

  it('returns an empty list for a bare slash (no query yet)', () => {
    const out = filterCommands('/', COMMANDS);
    expect(out).not.toBeNull();
    expect(out!.items).toEqual([]);
  });

  it('prefix-matches case-insensitively', () => {
    const out = filterCommands('/HEL', COMMANDS);
    expect(out!.items).toEqual(['help']);
  });

  it('returns every command sharing the prefix', () => {
    // `/lo` matches login + logout.
    const out = filterCommands('/lo', COMMANDS);
    expect(out!.items).toEqual(['login', 'logout']);
  });

  it('resets the selection index to 0 on a fresh filter', () => {
    const out = filterCommands('/s', COMMANDS);
    expect(out!.index).toBe(0);
  });

  it('caps the result list at 8 items', () => {
    // Build a command list where every entry shares a prefix so the cap
    // actually binds. The filter must keep the first 8 in source order.
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const out = filterCommands('/s', many);
    expect(out!.items).toHaveLength(8);
    expect(out!.items).toEqual(many.slice(0, 8));
  });

  it('returns an empty list when nothing matches', () => {
    const out = filterCommands('/xyzzy', COMMANDS);
    expect(out).not.toBeNull();
    expect(out!.items).toEqual([]);
  });

  it('matches the longest unambiguous prefix exactly', () => {
    expect(filterCommands('/help', COMMANDS)!.items).toEqual(['help']);
    expect(filterCommands('/exit', COMMANDS)!.items).toEqual(['exit']);
  });

  it('treats /se as the "settings/session/search" branch', () => {
    const out = filterCommands('/se', COMMANDS);
    // session / settings / search — all start with "se".
    expect(out!.items).toEqual(['session', 'settings', 'search']);
  });
});

describe('detectMentionQuery', () => {
  it('detects an empty @ at the cursor', () => {
    const text = 'review @';
    expect(detectMentionQuery(text, text.length)).toEqual({ atStart: 7, query: '' });
  });

  it('detects a partial query after @', () => {
    const text = 'review @src/in';
    expect(detectMentionQuery(text, text.length)).toEqual({ atStart: 7, query: 'src/in' });
  });

  it('detects @ at the start of the string', () => {
    const text = '@sr';
    expect(detectMentionQuery(text, text.length)).toEqual({ atStart: 0, query: 'sr' });
  });

  it('detects @ after a space boundary', () => {
    const text = 'fix @a.ts';
    expect(detectMentionQuery(text, text.length)).toEqual({ atStart: 4, query: 'a.ts' });
  });

  it('detects @ after a [ boundary', () => {
    const text = '[fix]@a';
    expect(detectMentionQuery(text, text.length)).toEqual({ atStart: 5, query: 'a' });
  });

  it('returns null when @ is not at a boundary (email)', () => {
    const text = 'contact user@hos';
    expect(detectMentionQuery(text, text.length)).toBeNull();
  });

  it('returns null when a space breaks the mention', () => {
    const text = 'fix @src and more';
    // cursor at the end — the space after @src breaks the scan.
    expect(detectMentionQuery(text, text.length)).toBeNull();
  });

  it('returns null when there is no @ before the cursor', () => {
    const text = 'no mention here';
    expect(detectMentionQuery(text, text.length)).toBeNull();
  });

  it('returns null for an out-of-range cursor', () => {
    expect(detectMentionQuery('text', 0)).toBeNull();
    expect(detectMentionQuery('text', 99)).toBeNull();
  });

  it('tracks the cursor mid-mention', () => {
    const text = 'fix @src/index.ts and more';
    // cursor right after "src/in" — should return query "src/in".
    const cursor = 'fix @src/in'.length;
    expect(detectMentionQuery(text, cursor)).toEqual({ atStart: 4, query: 'src/in' });
  });

  it('accepts backslash path separators', () => {
    const text = 'fix @src\\sub';
    expect(detectMentionQuery(text, text.length)).toEqual({ atStart: 4, query: 'src\\sub' });
  });
});
