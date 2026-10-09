import { describe, it, expect, beforeEach } from 'vitest';
import { alwaysAllowLabel, alwaysAllowScope, forgetSessionPermissions, moveSessionPermissions, permissionMemoryIn, sessionPermissionMemory, type PermissionStore } from './permissionScope';

const command = (program: unknown, args: string[] = []) => ({ tool: 'execute_command', parameters: { command: program, args } });

describe('alwaysAllowScope', () => {
  it('is the program of a command, whatever its arguments', () => {
    expect(alwaysAllowScope(command('php', ['artisan', 'migrate']))).toEqual({ key: 'execute_command:php', name: 'php' });
    expect(alwaysAllowScope(command('php', ['-v'])).key).toBe('execute_command:php');
    expect(alwaysAllowScope(command('php')).key).toBe('execute_command:php');
  });

  it('keeps one program apart from another, and from the tool as a whole', () => {
    const keys = new Set([command('php'), command('npm'), command('git'), { tool: 'execute_command', parameters: {} }].map(c => alwaysAllowScope(c).key));
    expect(keys.size).toBe(4);
    expect(alwaysAllowScope(command('php')).key).not.toBe('execute_command');
  });

  it('is the program as the model wrote it, not a guess at what it means', () => {
    // A path is a different program; a command line packed into `command` is
    // an entry of its own that no plain `php` matches.
    expect(alwaysAllowScope(command('/usr/bin/php')).key).not.toBe(alwaysAllowScope(command('php')).key);
    expect(alwaysAllowScope(command('php -v; ls')).key).not.toBe(alwaysAllowScope(command('php')).key);
    expect(alwaysAllowScope(command('PHP')).key).not.toBe(alwaysAllowScope(command('php')).key);
    // …but the space round it is not part of the name.
    expect(alwaysAllowScope(command('  php\n')).key).toBe('execute_command:php');
  });

  it('matches nothing that can run when there is no program', () => {
    for (const missing of [undefined, null, '', '   ', 42, ['php']]) {
      const scope = alwaysAllowScope(command(missing));
      expect(scope.key, JSON.stringify(missing)).toBe('execute_command:');
      expect(scope.name).toBe('execute_command');
    }
    expect(alwaysAllowScope({ tool: 'execute_command', parameters: undefined as unknown as Record<string, unknown> }).key).toBe('execute_command:');
  });

  it('is the tool for every other tool, whatever it is called on', () => {
    expect(alwaysAllowScope({ tool: 'write_file', parameters: { path: 'a.php', content: 'x' } })).toEqual({ key: 'write_file', name: 'write_file' });
    expect(alwaysAllowScope({ tool: 'write_file', parameters: { path: 'b.php' } }).key).toBe('write_file');
    expect(alwaysAllowScope({ tool: 'mcp__github__create_issue', parameters: {} }).key).toBe('mcp__github__create_issue');
    // A parameter called `command` on a tool that is not execute_command is just a parameter.
    expect(alwaysAllowScope({ tool: 'mcp__shell__run', parameters: { command: 'php' } }).key).toBe('mcp__shell__run');
  });
});

describe('alwaysAllowLabel', () => {
  it('says what it covers and for how long', () => {
    expect(alwaysAllowLabel(command('php', ['artisan']))).toBe('Always Allow php (this session)');
    expect(alwaysAllowLabel({ tool: 'write_file', parameters: { path: 'a.txt' } })).toBe('Always Allow write_file (this session)');
  });

  it('shortens a long name so the other two buttons still fit', () => {
    const label = alwaysAllowLabel({ tool: 'mcp__github__create_pull_request_review_comment', parameters: {} });
    expect(label).toBe('Always Allow mcp__github__create_pull_r… (this session)');
    // The dialog lays its buttons out in one row: "► Allow" (7 columns), four
    // spaces, "  Deny" (6), four spaces, then this one with its two-column
    // marker. It must end inside a standard 80-column terminal.
    expect(2 + 7 + 4 + 6 + 4 + 2 + label.length).toBeLessThanOrEqual(80);
    // A name of exactly the limit is shown whole; one more character is cut.
    const exact = 'x'.repeat(27);
    expect(alwaysAllowLabel(command(exact))).toBe(`Always Allow ${exact} (this session)`);
    expect(alwaysAllowLabel(command(`${exact}y`))).toBe(`Always Allow ${'x'.repeat(26)}… (this session)`);
  });

  it('counts characters, not UTF-16 units, and never cuts one in half', () => {
    const label = alwaysAllowLabel(command('😀'.repeat(30)));
    const shown = label.slice('Always Allow '.length, -' (this session)'.length);
    expect([...shown]).toHaveLength(27);
    expect(shown).toBe(`${'😀'.repeat(26)}…`);
    expect(label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('spells out what would change how the button looks', () => {
    // The program is model-written, and the dialog comes before the allowlist
    // refuses it: an ESC sequence or a newline must not reach the terminal.
    const label = alwaysAllowLabel(command('php\u001b[8m\nrm'));
    expect(label).not.toContain('\u001b');
    expect(label).not.toContain('\n');
    expect(label).toContain('\\x1b');
    expect(label).toContain('\\x0a');
  });
});

describe('sessionPermissionMemory', () => {
  beforeEach(() => forgetSessionPermissions());

  it('shares what a session allowed between its runs', () => {
    const first = sessionPermissionMemory('s1');
    first.alwaysAllowed.add('execute_command:php');

    const second = sessionPermissionMemory('s1');

    expect(second.alwaysAllowed).toBe(first.alwaysAllowed);
    expect(second.alwaysAllowed.has('execute_command:php')).toBe(true);
  });

  it('does not share it with another session', () => {
    sessionPermissionMemory('s1').alwaysAllowed.add('write_file');

    expect(sessionPermissionMemory('s2').alwaysAllowed.has('write_file')).toBe(false);
  });

  it('keeps no refusal beyond the run it was given in', () => {
    const first = sessionPermissionMemory('s1');
    first.alwaysRejected.add('execute_command');
    first.alwaysRejectedPaths.add('/repo/.git/config');

    const second = sessionPermissionMemory('s1');

    expect(second.alwaysRejected.size).toBe(0);
    expect(second.alwaysRejectedPaths.size).toBe(0);
    expect(second.alwaysRejected).not.toBe(first.alwaysRejected);
    expect(second.alwaysRejectedPaths).not.toBe(first.alwaysRejectedPaths);
  });

  it('forgets one session, or all of them', () => {
    sessionPermissionMemory('s1').alwaysAllowed.add('a');
    sessionPermissionMemory('s2').alwaysAllowed.add('b');

    forgetSessionPermissions('s1');
    expect(sessionPermissionMemory('s1').alwaysAllowed.size).toBe(0);
    expect(sessionPermissionMemory('s2').alwaysAllowed.has('b')).toBe(true);

    forgetSessionPermissions();
    expect(sessionPermissionMemory('s2').alwaysAllowed.size).toBe(0);
  });
});

describe('permissionMemoryIn', () => {
  it('keeps one set per chat in the store it is given, and nothing in any other', () => {
    const store: PermissionStore = new Map();
    permissionMemoryIn(store, 'a').alwaysAllowed.add('write_file');

    expect(permissionMemoryIn(store, 'a').alwaysAllowed.has('write_file')).toBe(true);
    expect(permissionMemoryIn(store, 'b').alwaysAllowed.size).toBe(0);
    expect(store.size).toBe(2);
    // The process-wide store is another one.
    expect(sessionPermissionMemory('a').alwaysAllowed.size).toBe(0);
    forgetSessionPermissions();
  });
});

describe('moveSessionPermissions', () => {
  beforeEach(() => forgetSessionPermissions());

  it('takes a renamed chat\'s answers to its new name, and leaves the old name — which another chat may take — with none', () => {
    sessionPermissionMemory('foo').alwaysAllowed.add('execute_command:npm');

    moveSessionPermissions('foo', 'bar');

    expect(sessionPermissionMemory('bar').alwaysAllowed.has('execute_command:npm')).toBe(true);
    expect(sessionPermissionMemory('foo').alwaysAllowed.size).toBe(0);
  });

  it('leaves the new name with none when the chat had none, not with an older chat\'s', () => {
    sessionPermissionMemory('bar').alwaysAllowed.add('write_file');

    moveSessionPermissions('foo', 'bar');

    expect(sessionPermissionMemory('bar').alwaysAllowed.size).toBe(0);
  });

  it('does nothing to a chat renamed to the name it has', () => {
    sessionPermissionMemory('foo').alwaysAllowed.add('write_file');

    moveSessionPermissions('foo', 'foo');

    expect(sessionPermissionMemory('foo').alwaysAllowed.has('write_file')).toBe(true);
  });
});
