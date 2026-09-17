import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  config,
  getProjectPermission,
  hasReadPermission,
  hasWritePermission,
  setProjectPermission,
  removeProjectPermission,
  getSessionsDir,
  saveSession,
  initializeAsProject,
} from './index';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-perm-')));
  root = join(base, 'repo');
  outside = join(base, 'home');
  mkdirSync(join(root, '.codeep'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'package.json'), '{"name":"repo"}');
  config.set('projectPermissions', []);
});
afterEach(() => {
  config.set('projectPermissions', []);
  rmSync(base, { recursive: true, force: true });
});

const grant = (path: string, write = true) => ({
  permission: { path, readPermission: true, writePermission: write, grantedAt: '2026-01-01T00:00:00.000Z' },
});

describe('project permissions', () => {
  it('ignores any grant a repo carries in .codeep/config.json', () => {
    // Relative paths resolve against wherever Codeep was started, which is
    // the project itself in the TUI; an absolute one could be guessed.
    const cwd = process.cwd();
    try {
      process.chdir(root);
      for (const path of ['.', '', './', '../repo', root, `${root}/`, '/Users/author/repo']) {
        writeFileSync(join(root, '.codeep', 'config.json'), JSON.stringify(grant(path)));
        expect(getProjectPermission(root), JSON.stringify(path)).toBeNull();
        expect(hasReadPermission(root), JSON.stringify(path)).toBe(false);
        expect(hasWritePermission(root), JSON.stringify(path)).toBe(false);
        expect(hasWritePermission('.'), JSON.stringify(path)).toBe(false);
      }
      writeFileSync(join(root, '.codeep', 'config.json'), JSON.stringify({ permission: { readPermission: true, writePermission: true } }));
      expect(hasWritePermission(root)).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it('ignores a relative path in the user\'s own config too', () => {
    config.set('projectPermissions', [grant('.').permission, grant('repo').permission]);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(hasWritePermission(root)).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it('records grants in the user\'s config, not in the project', () => {
    setProjectPermission(root, true, false);
    expect(existsSync(join(root, '.codeep', 'config.json'))).toBe(false);
    expect(hasReadPermission(root)).toBe(true);
    expect(hasWritePermission(root)).toBe(false);

    setProjectPermission(root, true, true);
    expect(hasWritePermission(root)).toBe(true);
    expect((config.get('projectPermissions') as unknown[]).length).toBe(1);
    // A path spelled differently is the same project.
    expect(hasWritePermission(`${root}/.`)).toBe(true);
  });

  it('removes the grant, and an old grant left in the project for this directory', () => {
    setProjectPermission(root, true, true);
    writeFileSync(join(root, '.codeep', 'config.json'), JSON.stringify({ ...grant(root), other: 1 }));
    expect(removeProjectPermission(root)).toBe(true);
    expect(getProjectPermission(root)).toBeNull();
    expect(JSON.parse(readFileSync(join(root, '.codeep', 'config.json'), 'utf-8'))).toEqual({ other: 1 });
    expect(removeProjectPermission(root)).toBe(false);
  });

  it('never rewrites a config.json that links elsewhere', () => {
    writeFileSync(join(outside, 'docker.json'), JSON.stringify({ ...grant(root), auths: {} }));
    symlinkSync(join(outside, 'docker.json'), join(root, '.codeep', 'config.json'));
    removeProjectPermission(root);
    expect(JSON.parse(readFileSync(join(outside, 'docker.json'), 'utf-8')).permission).toBeDefined();
  });
});

describe('sessions and markers under a .codeep that came with the repo', () => {
  it('keeps sessions out of a symlinked sessions directory', () => {
    symlinkSync(outside, join(root, '.codeep', 'sessions'));
    const dir = getSessionsDir(root);
    expect(dir).not.toBe(join(root, '.codeep', 'sessions'));
    expect(saveSession('probe-session', [{ role: 'user', content: 'hi' }], root)).toBe(true);
    expect(existsSync(join(outside, 'probe-session.json'))).toBe(false);
    rmSync(join(dir, 'probe-session.json'), { force: true });
  });

  it('never saves a session through a symlinked session file', () => {
    mkdirSync(join(root, '.codeep', 'sessions'));
    writeFileSync(join(outside, '.bashrc'), 'export KEEP=1\n');
    symlinkSync(join(outside, '.bashrc'), join(root, '.codeep', 'sessions', 'evil.json'));
    expect(saveSession('evil', [{ role: 'user', content: 'hi' }], root)).toBe(false);
    expect(readFileSync(join(outside, '.bashrc'), 'utf-8')).toBe('export KEEP=1\n');
  });

  it('does not mark a project through a symlinked .codeep', () => {
    rmSync(join(root, '.codeep'), { recursive: true });
    symlinkSync(outside, join(root, '.codeep'));
    expect(initializeAsProject(root)).toBe(false);
    expect(existsSync(join(outside, 'project.json'))).toBe(false);
  });
});
