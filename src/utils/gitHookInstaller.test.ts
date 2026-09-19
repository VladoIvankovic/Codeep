import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseHookArgs,
  buildHookScript,
  isCodeepHook,
  runHookCommand,
  resolveHooksDirResult,
  HOOK_HELP,
  type HookDeps,
} from './gitHookInstaller';
import { GitHardeningError } from './git';

describe('parseHookArgs', () => {
  it('defaults to help with no action', () => {
    expect(parseHookArgs([]).action).toBe('help');
  });
  it('parses actions, --pre-push, and --fail-on (both forms)', () => {
    expect(parseHookArgs(['install']).action).toBe('install');
    expect(parseHookArgs(['install']).hookType).toBe('pre-commit');
    expect(parseHookArgs(['install', '--pre-push']).hookType).toBe('pre-push');
    expect(parseHookArgs(['install', '--fail-on', 'warning']).failOn).toBe('warning');
    expect(parseHookArgs(['install', '--fail-on=info']).failOn).toBe('info');
    expect(parseHookArgs(['uninstall']).action).toBe('uninstall');
    expect(parseHookArgs(['install', '-h']).help).toBe(true);
  });
  it('keeps the default fail-on on an invalid value', () => {
    expect(parseHookArgs(['install', '--fail-on', 'bogus']).failOn).toBe('error');
  });
});

describe('buildHookScript / isCodeepHook', () => {
  it('pre-commit hook is scoped to staged files (NUL-safe) and is marked', () => {
    const s = buildHookScript('pre-commit', 'error');
    expect(s.startsWith('#!/bin/sh')).toBe(true);
    expect(s).toContain('git diff --cached --name-only -z');     // NUL-delimited
    expect(s).toContain('xargs -0 codeep review --fail-on error'); // survives spaces in paths
    expect(isCodeepHook(s)).toBe(true);
  });
  it('pre-push hook reviews changes without staged scoping', () => {
    const s = buildHookScript('pre-push', 'warning');
    expect(s).toContain('codeep review --fail-on warning');
    expect(s).not.toContain('--cached');
  });
  it('isCodeepHook is false for a foreign hook', () => {
    expect(isCodeepHook('#!/bin/sh\necho hi')).toBe(false);
  });
});

describe('runHookCommand', () => {
  const TARGET = '/repo/.git/hooks/pre-commit';
  function makeDeps(overrides: Partial<HookDeps> = {}) {
    const store = new Map<string, string>();
    const writes: string[] = [];
    const d: HookDeps = {
      resolveHooksDir: () => '/repo/.git/hooks',
      readHook: (p) => (store.has(p) ? store.get(p)! : null),
      writeHook: (p, c) => { store.set(p, c); },
      removeHook: (p) => { store.delete(p); },
      write: (t) => { writes.push(t); },
      ...overrides,
    };
    return { d, writes, store };
  }

  it('prints help with no action', () => {
    const { d, writes } = makeDeps();
    expect(runHookCommand([], d)).toBe(0);
    expect(writes[0]).toBe(HOOK_HELP);
  });

  it('fails outside a git repo', () => {
    const { d, writes } = makeDeps({ resolveHooksDir: () => null });
    expect(runHookCommand(['install'], d)).toBe(1);
    expect(writes[0]).toContain('Not a git repository');
  });

  it('tells the user git was refused instead of claiming this is not a repo', () => {
    // resolveHooksDir throws rather than answer null when hardenedGitEnv
    // refuses the repository, so a refusal can never be read as "there is no
    // hook directory here" — which is what let the write gate in
    // utils/toolExecution.ts stop gating hook writes in exactly that
    // repository. The installer's job is to turn the throw into a sentence:
    // "Not a git repository" would send the user looking for the wrong
    // problem, and an uncaught throw would print a stack trace.
    const { d, writes } = makeDeps({
      resolveHooksDir: () => {
        throw new GitHardeningError("Refusing to run git in /repo: its git config sets remote.origin.uploadpack, …");
      },
    });

    expect(runHookCommand(['install'], d)).toBe(1);
    expect(writes[0]).toContain('Refusing to run git');
    expect(writes[0]).not.toContain('Not a git repository');
  });

  it('installs a pre-commit hook when none exists', () => {
    const { d, store } = makeDeps();
    expect(runHookCommand(['install'], d)).toBe(0);
    expect(isCodeepHook(store.get(TARGET)!)).toBe(true);
  });

  it('refuses to overwrite a foreign hook', () => {
    const { d, store, writes } = makeDeps();
    store.set(TARGET, '#!/bin/sh\necho mine');
    expect(runHookCommand(['install'], d)).toBe(1);
    expect(writes[0]).toContain('not created by Codeep');
    expect(store.get(TARGET)).toBe('#!/bin/sh\necho mine'); // untouched
  });

  it('overwrites/updates an existing Codeep hook', () => {
    const { d, store } = makeDeps();
    store.set(TARGET, buildHookScript('pre-commit', 'error'));
    expect(runHookCommand(['install', '--fail-on', 'warning'], d)).toBe(0);
    expect(store.get(TARGET)).toContain('codeep review --fail-on warning');
  });

  it('uninstall: removes a Codeep hook, no-ops when absent, refuses a foreign one', () => {
    const { d, store } = makeDeps();
    expect(runHookCommand(['uninstall'], d)).toBe(0); // absent → 0
    store.set(TARGET, buildHookScript('pre-commit', 'error'));
    expect(runHookCommand(['uninstall'], d)).toBe(0);
    expect(store.has(TARGET)).toBe(false);
    store.set(TARGET, '#!/bin/sh\necho mine');
    expect(runHookCommand(['uninstall'], d)).toBe(1);
    expect(store.has(TARGET)).toBe(true); // foreign hook left in place
  });
});

/**
 * `resolveHooksDirResult` decides whether the write gate in
 * utils/toolExecution.ts keeps gating. `none` means "this repository has no
 * hook directory" and switches the gate OFF — so anything folded into it that
 * is not actually git saying "no repository here" is a fail-open.
 */
describe('resolveHooksDirResult, on git failing to answer', () => {
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-hooksdir-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.runIf(hasGit)('answers "none" for a directory that is genuinely not a repository', () => {
    // git's own `fatal: not a git repository`. This one really is "there are
    // no hooks here", and the gate is right to stand down.
    expect(resolveHooksDirResult(base)).toEqual({ kind: 'none' });
  });

  it.runIf(hasGit)('answers "unknown" when git fails for any other reason', () => {
    // A repository format git will not serve. Picked because it splits the
    // two calls the way this test needs: `git config --list` still exits 0
    // (it only warns), so hardenedGitEnv builds and the refusal path is NOT
    // what is being exercised — and then `git rev-parse --is-inside-work-tree`
    // exits 128 saying "Expected git repo version <= 1, found 99", which is
    // not "not a git repository". Verified against git 2.54.
    //
    // The bare `catch { kind: "none" }` this replaces reported that as "no
    // hook directory", and `none` is what turns the write gate in
    // utils/toolExecution.ts off — in precisely the repository Codeep
    // understands least.
    execFileSync('git', ['init', '-q', 'repo'], { cwd: base, stdio: 'ignore' });
    const repo = join(base, 'repo');
    execFileSync('git', ['config', 'core.repositoryformatversion', '99'], { cwd: repo, stdio: 'ignore' });

    const result = resolveHooksDirResult(repo);

    expect(result.kind).toBe('unknown');
    expect(result.kind === 'unknown' && result.reason).toMatch(/git failed to answer/);
  });
});
