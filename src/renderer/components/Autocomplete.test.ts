import { describe, it, expect } from 'vitest';
import { filterCommands } from './Autocomplete';

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
