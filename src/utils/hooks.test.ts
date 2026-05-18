import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runHook,
  listInstalledHooks,
  formatHookList,
  summarizeHooks,
  HookEvent,
} from './hooks';

let workspaceRoot: string;
let hooksDir: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codeep-hooks-'));
  hooksDir = join(workspaceRoot, '.codeep', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeHook(event: HookEvent, body: string, opts: { ext?: '.sh' | ''; executable?: boolean } = {}): string {
  const path = join(hooksDir, `${event}${opts.ext ?? '.sh'}`);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  if (opts.executable !== false) chmodSync(path, 0o755);
  return path;
}

describe('runHook — no script present', () => {
  it('returns executed: false', () => {
    const result = runHook({ event: 'post_edit', workspaceRoot });
    expect(result.executed).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('ignores hooks dir entirely when it does not exist', () => {
    rmSync(join(workspaceRoot, '.codeep'), { recursive: true, force: true });
    const result = runHook({ event: 'post_edit', workspaceRoot });
    expect(result.executed).toBe(false);
  });

  it('skips a hook file that is not executable', () => {
    writeHook('post_edit', 'echo hi', { executable: false });
    const result = runHook({ event: 'post_edit', workspaceRoot });
    expect(result.executed).toBe(false);
  });
});

describe('runHook — script present', () => {
  it('runs the script and captures stdout/stderr', () => {
    writeHook('post_edit', 'echo "hello from hook"; echo "err msg" >&2');
    const result = runHook({ event: 'post_edit', workspaceRoot });
    expect(result.executed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/hello from hook/);
    expect(result.stderr).toMatch(/err msg/);
    expect(result.blocked).toBe(false);
  });

  it('passes event-specific env vars to the script', () => {
    writeHook('pre_tool_call', 'env | grep CODEEP_HOOK_ > "$CODEEP_WORKSPACE/captured.txt"');
    runHook({
      event: 'pre_tool_call',
      workspaceRoot,
      sessionId: 'session-xyz',
      toolName: 'write_file',
      toolParams: { path: 'foo.ts', content: 'x' },
    });
    const captured = require('fs').readFileSync(join(workspaceRoot, 'captured.txt'), 'utf-8');
    expect(captured).toMatch(/CODEEP_HOOK_EVENT=pre_tool_call/);
    expect(captured).toMatch(/CODEEP_HOOK_TOOL=write_file/);
    expect(captured).toMatch(/CODEEP_HOOK_PARAMS=.*"path":"foo\.ts"/);
  });

  it('passes CODEEP_HOOK_FILE for post_edit', () => {
    writeHook('post_edit', 'echo "$CODEEP_HOOK_FILE" > "$CODEEP_WORKSPACE/file.txt"');
    runHook({
      event: 'post_edit',
      workspaceRoot,
      toolName: 'write_file',
      filePath: '/abs/path/to/foo.ts',
    });
    const out = require('fs').readFileSync(join(workspaceRoot, 'file.txt'), 'utf-8').trim();
    expect(out).toBe('/abs/path/to/foo.ts');
  });

  it('accepts bare-name script (no .sh extension)', () => {
    writeHook('post_edit', 'echo bare', { ext: '' });
    const result = runHook({ event: 'post_edit', workspaceRoot });
    expect(result.executed).toBe(true);
    expect(result.stdout).toMatch(/bare/);
  });

  it('truncates oversized CODEEP_HOOK_PARAMS to keep env size sane', () => {
    writeHook('pre_tool_call', 'echo -n "$CODEEP_HOOK_PARAMS" > "$CODEEP_WORKSPACE/captured.txt"');
    const big = 'x'.repeat(50_000);
    runHook({
      event: 'pre_tool_call',
      workspaceRoot,
      toolName: 'write_file',
      toolParams: { content: big },
    });
    const captured = require('fs').readFileSync(join(workspaceRoot, 'captured.txt'), 'utf-8');
    // Should be capped at 8KB + truncation marker; never the full 50K input.
    expect(captured.length).toBeLessThan(10_000);
    expect(captured).toMatch(/\[truncated\]$/);
  });
});

describe('runHook — blocking semantics', () => {
  it('non-zero exit on pre_tool_call sets blocked: true', () => {
    writeHook('pre_tool_call', 'echo "denied" >&2; exit 1');
    const result = runHook({ event: 'pre_tool_call', workspaceRoot, toolName: 'delete_file' });
    expect(result.executed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.blocked).toBe(true);
  });

  it('non-zero exit on post_edit does NOT block (advisory only)', () => {
    writeHook('post_edit', 'exit 1');
    const result = runHook({ event: 'post_edit', workspaceRoot });
    expect(result.executed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.blocked).toBe(false);
  });

  it('non-zero exit on pre_commit sets blocked: true', () => {
    writeHook('pre_commit', 'exit 2');
    const result = runHook({ event: 'pre_commit', workspaceRoot });
    expect(result.blocked).toBe(true);
  });

  it('non-zero exit on on_error does NOT block (logging hook)', () => {
    writeHook('on_error', 'exit 1');
    const result = runHook({ event: 'on_error', workspaceRoot });
    expect(result.blocked).toBe(false);
  });
});

describe('runHook — timeout', () => {
  it('respects the timeoutMs option', () => {
    writeHook('pre_tool_call', 'sleep 5');
    const start = Date.now();
    const result = runHook({ event: 'pre_tool_call', workspaceRoot }, { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    // Killed process → exitCode is non-zero (or null mapped to 1) → blocked
    expect(result.executed).toBe(true);
    expect(result.blocked).toBe(true);
  });
});

describe('listInstalledHooks', () => {
  it('returns empty array when no hooks dir', () => {
    rmSync(join(workspaceRoot, '.codeep'), { recursive: true, force: true });
    expect(listInstalledHooks(workspaceRoot)).toEqual([]);
  });

  it('returns empty array when dir exists but has no scripts', () => {
    expect(listInstalledHooks(workspaceRoot)).toEqual([]);
  });

  it('returns installed hook events', () => {
    writeHook('pre_tool_call', 'exit 0');
    writeHook('post_edit', 'exit 0');
    const installed = listInstalledHooks(workspaceRoot);
    expect(installed.map(h => h.event).sort()).toEqual(['post_edit', 'pre_tool_call']);
  });

  it('skips non-executable hook scripts', () => {
    writeHook('pre_tool_call', 'exit 0', { executable: false });
    writeHook('post_edit', 'exit 0');
    const installed = listInstalledHooks(workspaceRoot);
    expect(installed.map(h => h.event)).toEqual(['post_edit']);
  });

  it('does not double-count when both .sh and bare exist for same event', () => {
    writeHook('post_edit', 'exit 0');
    writeHook('post_edit', 'exit 0', { ext: '' });
    const installed = listInstalledHooks(workspaceRoot);
    expect(installed.filter(h => h.event === 'post_edit')).toHaveLength(1);
  });
});

describe('formatHookList', () => {
  it('shows setup guide when no hooks installed', () => {
    const md = formatHookList([]);
    expect(md).toMatch(/No hooks installed/);
    expect(md).toMatch(/pre_tool_call/);
    expect(md).toMatch(/post_edit/);
  });

  it('flags blocking events as such', () => {
    const md = formatHookList([]);
    expect(md).toMatch(/`pre_tool_call`.*non-zero exit blocks/);
    expect(md).toMatch(/`pre_commit`.*non-zero exit blocks/);
  });

  it('lists installed hooks with paths and blocking tag', () => {
    const md = formatHookList([
      { event: 'pre_tool_call', scriptPath: '/x/y/pre_tool_call.sh' },
      { event: 'post_edit', scriptPath: '/x/y/post_edit.sh' },
    ]);
    expect(md).toMatch(/## Installed hooks/);
    expect(md).toMatch(/`pre_tool_call`.*\*\(blocking\)\*.*pre_tool_call\.sh/);
    expect(md).toMatch(/`post_edit`.*post_edit\.sh/);
  });
});

describe('summarizeHooks', () => {
  it('returns empty string when no hooks', () => {
    expect(summarizeHooks(workspaceRoot)).toBe('');
  });

  it('returns a one-line summary with event names', () => {
    writeHook('post_edit', 'exit 0');
    writeHook('pre_commit', 'exit 0');
    const summary = summarizeHooks(workspaceRoot);
    expect(summary).toMatch(/2 hooks active/);
    expect(summary).toMatch(/post_edit/);
    expect(summary).toMatch(/pre_commit/);
  });

  it('pluralises correctly for 1 hook', () => {
    writeHook('post_edit', 'exit 0');
    expect(summarizeHooks(workspaceRoot)).toMatch(/^1 hook active/);
  });
});
