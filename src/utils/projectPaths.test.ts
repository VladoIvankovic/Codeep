import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isSafeProjectWriteTarget, leadsOutsideProject } from './projectPaths';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  // Resolved: on macOS tmpdir() sits under the /var symlink, which would make
  // every outside path fail the directory walk for the wrong reason.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-paths-')));
  root = join(base, 'proj');
  outside = join(base, 'home');
  mkdirSync(join(root, '.codeep'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, '.zshrc'), 'export KEEP=1');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('isSafeProjectWriteTarget', () => {
  it('allows a new or existing plain file inside the project', () => {
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', 'progress.md'))).toBe(true);
    writeFileSync(join(root, '.codeep', 'progress.md'), 'x');
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', 'progress.md'))).toBe(true);
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', 'sessions', 'a.json'))).toBe(true);
  });

  it('refuses a symlinked target file, even one pointing inside the project', () => {
    symlinkSync(join(outside, '.zshrc'), join(root, '.codeep', 'progress.md'));
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', 'progress.md'))).toBe(false);
    writeFileSync(join(root, 'notes.md'), 'n');
    symlinkSync(join(root, 'notes.md'), join(root, '.codeep', 'intelligence.json'));
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', 'intelligence.json'))).toBe(false);
  });

  it('refuses a dangling symlink, which writeFileSync would follow to create a file', () => {
    symlinkSync(join(outside, 'new-file'), join(root, '.codeep', 'config.json'));
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', 'config.json'))).toBe(false);
  });

  it('refuses a path under a symlinked directory', () => {
    rmSync(join(root, '.codeep'), { recursive: true });
    symlinkSync(outside, join(root, '.codeep'));
    expect(isSafeProjectWriteTarget(root, join(root, '.codeep', '.zshrc'))).toBe(false);
    mkdirSync(join(root, 'real'));
    symlinkSync(outside, join(root, 'real', 'sessions'));
    expect(isSafeProjectWriteTarget(root, join(root, 'real', 'sessions', 'a.json'))).toBe(false);
  });

  it('refuses paths outside the project by name, and the root itself', () => {
    expect(isSafeProjectWriteTarget(root, join(outside, '.zshrc'))).toBe(false);
    expect(isSafeProjectWriteTarget(root, join(root, '..', 'home', '.zshrc'))).toBe(false);
    expect(isSafeProjectWriteTarget(root, root)).toBe(false);
  });

  it('accepts a project opened through a symlink', () => {
    const link = join(base, 'link-to-proj');
    symlinkSync(root, link);
    expect(isSafeProjectWriteTarget(link, join(link, '.codeep', 'progress.md'))).toBe(true);
  });
});

describe('leadsOutsideProject', () => {
  it('is true only for an existing path that resolves outside', () => {
    symlinkSync(join(outside, '.zshrc'), join(root, 'CODEEP.md'));
    expect(leadsOutsideProject(join(root, 'CODEEP.md'), root)).toBe(true);
    writeFileSync(join(root, 'docs.md'), 'd');
    symlinkSync(join(root, 'docs.md'), join(root, 'AGENTS.md'));
    expect(leadsOutsideProject(join(root, 'AGENTS.md'), root)).toBe(false);
    expect(leadsOutsideProject(join(root, 'missing.md'), root)).toBe(false);
  });
});

describe('symlinkedCodeepNotice', () => {
  it('names a symlinked .codeep or sessions directory, and nothing else', async () => {
    const { symlinkedCodeepNotice } = await import('./projectPaths');
    expect(symlinkedCodeepNotice(root)).toBeNull();
    symlinkSync(outside, join(root, '.codeep', 'sessions'));
    expect(symlinkedCodeepNotice(root)).toMatch(/sessions in this project is a symlink/);
    rmSync(join(root, '.codeep'), { recursive: true });
    symlinkSync(outside, join(root, '.codeep'));
    expect(symlinkedCodeepNotice(root)).toMatch(/^\.codeep in this project is a symlink/);
  });
});
