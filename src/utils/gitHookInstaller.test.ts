import { describe, it, expect } from 'vitest';
import {
  parseHookArgs,
  buildHookScript,
  isCodeepHook,
  runHookCommand,
  HOOK_HELP,
  type HookDeps,
} from './gitHookInstaller';

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
