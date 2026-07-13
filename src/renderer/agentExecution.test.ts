import { describe, it, expect } from 'vitest';
import { getActionType, isDangerousTool } from './agentExecution';

describe('getActionType', () => {
  it.each([
    ['write_file', 'write'],
    ['writefile', 'write'],
    ['edit_file', 'edit'],
    ['editfile', 'edit'],
    ['read_file', 'read'],
    ['readfile', 'read'],
    ['delete_file', 'delete'],
    ['list_files', 'list'],
    ['search_code', 'search'],
    ['grep', 'search'],
    ['create_directory', 'command'],  // does not contain "mkdir"
    ['mkdir', 'mkdir'],
    ['fetch_url', 'fetch'],
    ['execute_command', 'command'],
    ['shell', 'command'],
    ['unknown_tool', 'command'],
    ['', 'command'],
  ])('classifies %s as %s', (input, expected) => {
    expect(getActionType(input)).toBe(expected);
  });

  it('prefers write over other matches when the name contains multiple keywords', () => {
    // "write" is checked first in the chain.
    expect(getActionType('write_and_read')).toBe('write');
  });

  it('prefers edit over read when both appear', () => {
    // "edit" is checked before "read".
    expect(getActionType('edit_read')).toBe('edit');
  });
});

describe('isDangerousTool', () => {
  describe('dangerous by tool name', () => {
    it.each([
      'write_file',
      'WRITE_FILE',  // case-insensitive
      'edit_file',
      'delete_file',
      'execute_command',
      'shell_exec',
      'rm_tool',
      'mv_file',
    ])('flags %s as dangerous', (name) => {
      expect(isDangerousTool(name, {})).toBe(true);
    });
  });

  describe('safe by tool name', () => {
    it.each([
      'read_file',
      'list_files',
      'search_code',
      'fetch_url',
      'create_directory',
    ])('does not flag %s by name alone', (name) => {
      expect(isDangerousTool(name, {})).toBe(false);
    });
  });

  describe('dangerous by command argument', () => {
    it.each([
      'rm file',
      'rm -rf x',
      'rmdir foo',
      'del bar',
      'delete baz',
      'drop table',
      'truncate table',
    ])('flags execute_command with %s', (cmd) => {
      expect(isDangerousTool('execute_command', { command: cmd })).toBe(true);
    });

    it('is case-insensitive on the command', () => {
      expect(isDangerousTool('execute_command', { command: 'RM -RF /' })).toBe(true);
      expect(isDangerousTool('execute_command', { command: 'DROP TABLE users' })).toBe(true);
    });
  });

  it('does not flag a safe command on a safe-named tool', () => {
    // Use a tool name that isn't in DANGEROUS_TOOLS so only the command
    // matters. `safe_tool` contains no dangerous keyword.
    expect(isDangerousTool('safe_tool', { command: 'ls -la' })).toBe(false);
    expect(isDangerousTool('safe_tool', { command: 'echo hi' })).toBe(false);
  });

  it('returns false when command is missing on a safe-named tool', () => {
    expect(isDangerousTool('safe_tool', {})).toBe(false);
  });

  it('handles a non-string command gracefully on a safe-named tool', () => {
    expect(isDangerousTool('safe_tool', { command: 123 as unknown as string })).toBe(false);
    expect(isDangerousTool('safe_tool', { command: null as unknown as string })).toBe(false);
    expect(isDangerousTool('safe_tool', { command: undefined as unknown as string })).toBe(false);
  });
});
