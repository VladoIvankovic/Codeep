import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, chmodSync, symlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// resolveHooksDirResult stays REAL: the hook-directory tests below ask real
// git about a real fixture repository, which is the only thing that proves
// the gate matches what git would actually run. It is wrapped so its calls
// can be counted, and so its two non-answers can be told apart on demand —
// `none` is a fixture away, `unknown` needs git to refuse.
vi.mock('./gitHookInstaller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitHookInstaller')>();
  return { ...actual, resolveHooksDirResult: vi.fn(actual.resolveHooksDirResult) };
});

import { executeTool, trustBearingWrite, forgetHooksDirectory, FsCallbacks } from './toolExecution';
import { resolveHooksDirResult } from './gitHookInstaller';
import { ToolCall } from './tools';
import { trustWorkspaceHooks, untrustWorkspaceHooks } from './hooks';
import { AcpRequestError, AcpRequestTimeoutError } from '../acp/transport';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codeep-toolexec-'));
  // Project hooks only run in trusted workspaces; the integration tests below
  // exercise the hook path, so trust the temp workspace.
  trustWorkspaceHooks(tmpRoot);
});

afterEach(() => {
  untrustWorkspaceHooks(tmpRoot);
  rmSync(tmpRoot, { recursive: true, force: true });
});

const makeCall = (tool: string, parameters: Record<string, unknown>): ToolCall => ({
  id: 't1',
  tool,
  parameters,
} as ToolCall);

describe('read_file — disk path', () => {
  it('reads an existing file', async () => {
    writeFileSync(join(tmpRoot, 'hello.txt'), 'hello world');
    const result = await executeTool(makeCall('read_file', { path: 'hello.txt' }), tmpRoot);
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
  });

  it('errors when path is missing', async () => {
    const result = await executeTool(makeCall('read_file', {}), tmpRoot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing required parameter/i);
  });

  it('errors for a nonexistent file', async () => {
    const result = await executeTool(makeCall('read_file', { path: 'missing.txt' }), tmpRoot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file not found/i);
  });

  it('rejects files over 100KB', async () => {
    const big = 'x'.repeat(110 * 1024);
    writeFileSync(join(tmpRoot, 'big.txt'), big);
    const result = await executeTool(makeCall('read_file', { path: 'big.txt' }), tmpRoot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
  });
});

describe('read_file — client delegation', () => {
  it('delegates to client when readTextFile is provided', async () => {
    // File on disk says one thing, client says another — client should win
    // (this is the whole point of delegation: respect dirty editor buffers).
    writeFileSync(join(tmpRoot, 'foo.txt'), 'stale disk content');
    const fs: FsCallbacks = {
      readTextFile: vi.fn().mockResolvedValue('fresh editor buffer'),
    };
    const result = await executeTool(makeCall('read_file', { path: 'foo.txt' }), tmpRoot, fs);
    expect(result.success).toBe(true);
    expect(result.output).toBe('fresh editor buffer');
    expect(fs.readTextFile).toHaveBeenCalledOnce();
  });

  it('falls back to disk when client throws', async () => {
    writeFileSync(join(tmpRoot, 'foo.txt'), 'on disk');
    const fs: FsCallbacks = {
      readTextFile: vi.fn().mockRejectedValue(new Error('client offline')),
    };
    const result = await executeTool(makeCall('read_file', { path: 'foo.txt' }), tmpRoot, fs);
    expect(result.success).toBe(true);
    expect(result.output).toBe('on disk');
  });

  it('rejects oversized client responses (DoS guard)', async () => {
    writeFileSync(join(tmpRoot, 'foo.txt'), 'tiny');
    const big = 'x'.repeat(200 * 1024);
    const fs: FsCallbacks = {
      readTextFile: vi.fn().mockResolvedValue(big),
    };
    const result = await executeTool(makeCall('read_file', { path: 'foo.txt' }), tmpRoot, fs);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large.*via client/i);
  });

  it('enforces path validation even with delegation', async () => {
    const fs: FsCallbacks = {
      readTextFile: vi.fn().mockResolvedValue('content'),
    };
    // Path escape attempt — should be blocked before the delegation runs.
    const result = await executeTool(
      makeCall('read_file', { path: '../../../etc/passwd' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(false);
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });
});

describe('write_file — disk path', () => {
  it('creates a new file', async () => {
    const result = await executeTool(
      makeCall('write_file', { path: 'new.txt', content: 'hello' }),
      tmpRoot,
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Created/);
    expect(readFileSync(join(tmpRoot, 'new.txt'), 'utf-8')).toBe('hello');
  });

  it('updates an existing file', async () => {
    writeFileSync(join(tmpRoot, 'a.txt'), 'old');
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: 'new' }),
      tmpRoot,
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Updated/);
    expect(readFileSync(join(tmpRoot, 'a.txt'), 'utf-8')).toBe('new');
  });

  it('creates parent directories', async () => {
    const result = await executeTool(
      makeCall('write_file', { path: 'nested/deep/x.txt', content: 'x' }),
      tmpRoot,
    );
    expect(result.success).toBe(true);
    expect(existsSync(join(tmpRoot, 'nested/deep/x.txt'))).toBe(true);
  });

  it('rejects a new file beneath a symlinked directory outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codeep-toolexec-outside-'));
    try {
      symlinkSync(outside, join(tmpRoot, 'escape'), 'dir');
      const result = await executeTool(
        makeCall('write_file', { path: 'escape/new.txt', content: 'must not escape' }),
        tmpRoot,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/symlink traversal|could not be resolved/i);
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects writing through a broken symlink leaf', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codeep-toolexec-outside-'));
    try {
      const missingTarget = join(outside, 'created-through-link.txt');
      symlinkSync(missingTarget, join(tmpRoot, 'broken-link.txt'));
      const result = await executeTool(
        makeCall('write_file', { path: 'broken-link.txt', content: 'must not escape' }),
        tmpRoot,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/could not be resolved/i);
      expect(existsSync(missingTarget)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('errors when content is undefined (LLM truncation guard)', async () => {
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: undefined as unknown as string }),
      tmpRoot,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty or truncated/i);
  });
});

describe('write_file — client delegation', () => {
  it('writes via client when writeTextFile is provided', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const fs: FsCallbacks = {
      writeTextFile: vi.fn(async (path: string, content: string) => {
        writes.push({ path, content });
      }),
    };
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: 'hello' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(true);
    expect(writes).toHaveLength(1);
    // Disk should NOT be touched when delegation succeeds.
    expect(existsSync(join(tmpRoot, 'a.txt'))).toBe(false);
  });

  it('falls back to disk when client throws', async () => {
    const fs: FsCallbacks = {
      writeTextFile: vi.fn().mockRejectedValue(new Error('client offline')),
    };
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: 'hello' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpRoot, 'a.txt'), 'utf-8')).toBe('hello');
  });

  it('fails without touching disk when the client refuses the write', async () => {
    const fs: FsCallbacks = {
      writeTextFile: vi.fn().mockRejectedValue(new AcpRequestError('fs/write_text_file', -32603, 'Buffer is read-only')),
    };
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: 'hello' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Buffer is read-only');
    expect(existsSync(join(tmpRoot, 'a.txt'))).toBe(false);
  });

  it('falls back to disk when the client does not implement the method', async () => {
    const fs: FsCallbacks = {
      writeTextFile: vi.fn().mockRejectedValue(new AcpRequestError('fs/write_text_file', -32601, 'Method not found')),
    };
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: 'hello' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpRoot, 'a.txt'), 'utf-8')).toBe('hello');
  });

  it('falls back to disk when the client never answers', async () => {
    const fs: FsCallbacks = {
      writeTextFile: vi.fn().mockRejectedValue(new AcpRequestTimeoutError('fs/write_text_file', 30_000)),
    };
    const result = await executeTool(
      makeCall('write_file', { path: 'a.txt', content: 'hello' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpRoot, 'a.txt'), 'utf-8')).toBe('hello');
  });
});

describe('list_files — symlink boundaries', () => {
  it('does not recurse through a symlinked directory outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codeep-toolexec-outside-'));
    try {
      writeFileSync(join(outside, 'outside-secret.txt'), 'secret');
      symlinkSync(outside, join(tmpRoot, 'external'), 'dir');
      writeFileSync(join(tmpRoot, 'inside.txt'), 'safe');

      const result = await executeTool(
        makeCall('list_files', { path: '.', recursive: true }),
        tmpRoot,
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('inside.txt');
      expect(result.output).not.toContain('outside-secret.txt');
      expect(result.output).not.toContain('external/');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('edit_file — disk path', () => {
  beforeEach(() => {
    writeFileSync(join(tmpRoot, 'f.txt'), 'hello world\nsecond line');
  });

  it('replaces a unique substring', async () => {
    const result = await executeTool(
      makeCall('edit_file', { path: 'f.txt', old_text: 'world', new_text: 'there' }),
      tmpRoot,
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpRoot, 'f.txt'), 'utf-8')).toBe('hello there\nsecond line');
  });

  it('rejects ambiguous matches', async () => {
    writeFileSync(join(tmpRoot, 'dup.txt'), 'foo\nfoo\n');
    const result = await executeTool(
      makeCall('edit_file', { path: 'dup.txt', old_text: 'foo', new_text: 'bar' }),
      tmpRoot,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matches 2 locations/);
  });

  it('errors when old_text is not present', async () => {
    const result = await executeTool(
      makeCall('edit_file', { path: 'f.txt', old_text: 'nonexistent', new_text: 'x' }),
      tmpRoot,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/text not found/i);
  });

  it('inserts new_text literally — $ sequences must not be interpreted', async () => {
    // Regression: String.replace(str, str) reads $&, $$, $1 in the replacement,
    // which would silently corrupt any edit whose new_text contains `$`
    // (template literals, shell vars, regex) — and this path writes the file.
    writeFileSync(join(tmpRoot, 'g.txt'), 'value = MARK');
    const result = await executeTool(
      makeCall('edit_file', { path: 'g.txt', old_text: 'MARK', new_text: '$& and $$ and ${x}' }),
      tmpRoot,
    );
    expect(result.success).toBe(true);
    expect(readFileSync(join(tmpRoot, 'g.txt'), 'utf-8')).toBe('value = $& and $$ and ${x}');
  });
});

describe('edit_file — client delegation', () => {
  it('reads via client and writes via client when both delegated', async () => {
    let storedContent = 'hello editor';
    const fs: FsCallbacks = {
      readTextFile: vi.fn(async () => storedContent),
      writeTextFile: vi.fn(async (_p: string, c: string) => { storedContent = c; }),
    };
    // File doesn't exist on disk — only "in editor"
    const result = await executeTool(
      makeCall('edit_file', { path: 'virtual.txt', old_text: 'hello', new_text: 'goodbye' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(true);
    expect(storedContent).toBe('goodbye editor');
    expect(fs.readTextFile).toHaveBeenCalled();
    expect(fs.writeTextFile).toHaveBeenCalled();
  });

  it('uses client read even if disk has stale content', async () => {
    writeFileSync(join(tmpRoot, 'f.txt'), 'disk version');
    const fs: FsCallbacks = {
      readTextFile: vi.fn().mockResolvedValue('editor version with marker'),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
    };
    const result = await executeTool(
      makeCall('edit_file', { path: 'f.txt', old_text: 'marker', new_text: 'replaced' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(true);
    expect(fs.writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining('f.txt'),
      'editor version with replaced',
    );
  });

  it('fails without touching disk when the client refuses the write', async () => {
    writeFileSync(join(tmpRoot, 'f.txt'), 'hello editor');
    const fs: FsCallbacks = {
      readTextFile: vi.fn().mockResolvedValue('hello editor'),
      writeTextFile: vi.fn().mockRejectedValue(new AcpRequestError('fs/write_text_file', -32603, 'Buffer is read-only')),
    };
    const result = await executeTool(
      makeCall('edit_file', { path: 'f.txt', old_text: 'hello', new_text: 'goodbye' }),
      tmpRoot,
      fs,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Buffer is read-only');
    expect(readFileSync(join(tmpRoot, 'f.txt'), 'utf-8')).toBe('hello editor');
  });
});

describe('execute_command — abort signal', () => {
  it('stops the running command when the signal fires', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const startedAt = Date.now();
    const result = await executeTool(
      makeCall('execute_command', { command: 'sleep', args: ['10'] }),
      tmpRoot,
      undefined,
      undefined,
      ac.signal,
    );
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Command cancelled');
  }, 15_000);
});

describe('hooks + MCP integration', () => {
  function installHook(event: string, body: string): string {
    const dir = join(tmpRoot, '.codeep', 'hooks');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${event}.sh`);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('pre_tool_call hook blocks MCP tool calls (no longer bypasses)', async () => {
    installHook('pre_tool_call', 'echo "policy: no MCP" >&2; exit 1');
    // Use an MCP-prefixed tool name + a fake mcpSessionId. The hook should
    // fire and block BEFORE we ever reach mcpRegistry.callSessionTool —
    // so the absence of a registered session is irrelevant to this assertion.
    const result = await executeTool(
      makeCall('fs__read_file', { path: '/x' }),
      tmpRoot,
      undefined,
      'fake-session',
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Blocked by pre_tool_call hook/);
    expect(result.error).toMatch(/policy: no MCP/);
  });

  it('routes MCP tools by raw name (hyphens in server name survive)', async () => {
    // `normalizeToolName` lowercases and converts hyphens to underscores —
    // fine for built-ins but it'd mangle `my-fs__read_file` into
    // `my_fs__read_file` and miss the registry lookup. The MCP path must
    // dispatch on the raw name. The lookup will throw "no MCP servers
    // registered" since we don't have a real session — that's fine, what
    // we're asserting is that the error mentions the HYPHEN-preserved
    // name, proving normalization didn't run.
    const result = await executeTool(
      makeCall('my-fs__read_file', { path: '/x' }),
      tmpRoot,
      undefined,
      'fake-session',
    );
    expect(result.success).toBe(false);
    expect(result.tool).toBe('my-fs__read_file');           // raw, hyphens intact
  });

  it('on_error hook fires when an MCP tool call fails', async () => {
    const marker = join(tmpRoot, 'error-fired.txt');
    installHook('on_error', `echo "$CODEEP_HOOK_TOOL" > "${marker}"`);
    // No MCP session registered → callSessionTool throws "No MCP servers
    // registered". executeTool should catch, return failure, AND fire on_error.
    const result = await executeTool(
      makeCall('fs__read_file', { path: '/x' }),
      tmpRoot,
      undefined,
      'unregistered-session',
    );
    expect(result.success).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8').trim()).toBe('fs__read_file');
  });
});

describe('trustBearingWrite — the files that decide what runs later', () => {
  const reasonFor = (tool: string, path: unknown) =>
    trustBearingWrite(makeCall(tool, { path }), tmpRoot)?.reason ?? null;

  // These fixtures run real git, and git reads whoever's machine this is on:
  // a `core.hooksPath` or an `init.templateDir` in the developer's own global
  // config would decide what they assert. Point git at a file that is not
  // there instead — for the fixture's own `git init`/`git config`, and for
  // the resolution inside the gate, which inherits this process's env.
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: tmpRoot, stdio: 'ignore' });

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = join(tmpRoot, 'no-such-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = join(tmpRoot, 'no-such-gitconfig');
    // The answer is cached for a run; each test is its own run. mockReset
    // rather than mockClear: it puts the REAL resolveHooksDirResult back, so a
    // test that stubbed it does not leave the next one against a stub.
    forgetHooksDirectory();
    vi.mocked(resolveHooksDirResult).mockReset();
  });

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
  });

  it('names what a git path controls, wherever the checkout sits', () => {
    expect(reasonFor('write_file', '.git/config')).toMatch(/what commands git runs/);
    expect(reasonFor('write_file', '.git/hooks/pre-commit')).toMatch(/what commands git runs/);
    // A worktree's `.git` is a file pointing at the real directory.
    expect(reasonFor('write_file', '.git')).toMatch(/what commands git runs/);
    expect(reasonFor('write_file', 'vendor/lib/.git/config')).toMatch(/what commands git runs/);
    // macOS and Windows hand `.GIT/config` to the same file git reads.
    expect(reasonFor('write_file', '.GIT/config')).toMatch(/what commands git runs/);
    expect(reasonFor('write_file', join(tmpRoot, '.git', 'config'))).toMatch(/what commands git runs/);
  });

  it('names what each Codeep path controls', () => {
    expect(reasonFor('write_file', '.codeep/hooks/pre_tool_call.sh')).toBe('This file runs on every tool call.');
    expect(reasonFor('write_file', '.codeep/mcp_servers.json')).toMatch(/starts MCP servers/);
    expect(reasonFor('write_file', '.mcp.json')).toMatch(/starts MCP servers/);
    expect(reasonFor('write_file', '.codeep/config.json')).toMatch(/Codeep's own configuration/);
    // A skill's steps are commands Codeep runs when the skill is used.
    expect(reasonFor('write_file', '.codeep/skills/deploy/SKILL.md')).toMatch(/steps are commands/);
    // A sub-agent definition: its `tools:` REPLACES the parent's allowlist for
    // the delegated run and its `model:` picks the provider that run's context
    // is sent to, both the next time anything delegates to that name. That is
    // the line `.codeep/commands/` sits on the other side of — see below.
    expect(reasonFor('write_file', '.codeep/agents/reviewer.md')).toMatch(/defines a sub-agent/);
  });

  it('covers the hook directory conventions a repo uses instead of .git/hooks', () => {
    // `core.hooksPath` moves the hooks out of `.git`, so a write here runs on
    // the user's own next commit in their own terminal.
    expect(reasonFor('write_file', '.githooks/pre-commit')).toMatch(/git runs it on your next commit/);
    expect(reasonFor('write_file', '.husky/pre-commit')).toMatch(/git runs it on your next commit/);
    expect(reasonFor('create_directory', '.githooks')).toMatch(/git runs it on your next commit/);
  });

  it('asks the repository where its hooks actually live', () => {
    // Neither name above: only `core.hooksPath` says this directory is where
    // the next `git commit` looks.
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'core.hooksPath', 'ci/hooks'], { cwd: tmpRoot });

    expect(reasonFor('write_file', 'ci/hooks/pre-commit')).toMatch(/git runs it on your next commit/);
    expect(reasonFor('write_file', 'ci/build.sh')).toBeNull();
  });

  it('asks it even when the answer is the project root itself', () => {
    // `core.hooksPath` pointing AT the root makes `<root>/pre-commit` the file
    // git runs on the next commit — verified against git 2.54, which runs it.
    // The hook directory's path relative to the root is '', which read as
    // "not inside the project" and left that file ungated.
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'core.hooksPath', tmpRoot], { cwd: tmpRoot });

    expect(reasonFor('write_file', 'pre-commit')).toMatch(/runs on your next commit/);
    // And the empty prefix does not swallow the project with it: git looks for
    // hooks directly in that directory, so a confirmation in front of every
    // write below the root would be for nothing git would ever run.
    expect(reasonFor('write_file', 'src/app.ts')).toBeNull();
  });

  it('does not tell that repository its package.json is a hook', () => {
    // Every top-level file matches when the hook directory IS the top level,
    // and `package.json` is one of them. Gating it is right — the repository
    // really did declare that directory as where git looks for hooks — but
    // the sentence has to be about the directory, not about the file, or a
    // user is told their package manifest is a git hook.
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'core.hooksPath', tmpRoot], { cwd: tmpRoot });

    const manifest = reasonFor('write_file', 'package.json');
    expect(manifest).toMatch(/core\.hooksPath/);
    expect(manifest).not.toMatch(/This is a git hook/);
    // Same sentence for every file at that level, `pre-commit` included:
    // which of them git will actually run is a question of its name, and
    // this gate is not the place that answers it.
    expect(reasonFor('write_file', 'pre-commit')).toBe(manifest);

    // A hook directory of its OWN keeps the plain wording, because there the
    // file really is one.
    execFileSync('git', ['config', 'core.hooksPath', 'ci/hooks'], { cwd: tmpRoot });
    forgetHooksDirectory();
    expect(reasonFor('write_file', 'ci/hooks/pre-commit')).toMatch(/This is a git hook/);
  });

  it('gates every write when git would not say where the hooks are', () => {
    // `remote.<name>.uploadpack` names a program git runs at the far end of a
    // fetch or push, and git keeps the FIRST value it sees for that key — so
    // no override reaches it and hardenedGitEnv can only refuse. Which means
    // nobody can say where this repository keeps its hooks.
    //
    // Reading that as "it has none" turned this gate OFF in exactly the
    // repository that earned the refusal: a `core.hooksPath` nobody could
    // see, pointed anywhere, written into without a prompt.
    git('init', '-q');
    git('config', 'remote.origin.uploadpack', 'anything');

    const reason = reasonFor('write_file', 'src/app.ts');
    expect(reason).toMatch(/could not ask git where this repository keeps its hooks/);
    // And it carries git's own refusal, because over ACP this prompt is the
    // only place the key and the fix are ever said.
    expect(reason).toContain('remote.origin.uploadpack');
    expect(reason).toContain('git config --unset');
    // Every write, not only the ones that look like a hook.
    expect(reasonFor('write_file', 'build/out.js')).toBe(reason);
  });

  it('says nothing about a folder that is simply not a repository', () => {
    // The other direction of the same collapse: `none` gating everything
    // would put a confirmation in front of every write outside a checkout.
    expect(reasonFor('write_file', 'src/app.ts')).toBeNull();
  });

  it('fails closed when the resolution throws instead of answering', () => {
    // resolveHooksDirResult promises not to throw. This gate does not lean on
    // that promise: ANY throw is "unknown", so a change on the far side of
    // that call cannot quietly reopen the hole.
    vi.mocked(resolveHooksDirResult).mockImplementation(() => { throw new Error('boom'); });
    expect(reasonFor('write_file', 'src/app.ts')).toMatch(/could not ask git where this repository keeps its hooks/);
  });

  it('asks git where the hooks are once per run, and again after a command', async () => {
    // Three git subprocesses per path-writing call at ~25ms each is ~2.5s of
    // spawning across a 100-edit run, blocking the event loop, almost all of
    // it on the common path where nothing matches.
    git('init', '-q');
    git('config', 'core.hooksPath', 'ci/hooks');

    expect(reasonFor('write_file', 'src/app.ts')).toBeNull();
    expect(reasonFor('write_file', 'src/other.ts')).toBeNull();
    expect(reasonFor('write_file', 'ci/hooks/pre-commit')).toMatch(/git runs it on your next commit/);
    expect(resolveHooksDirResult).toHaveBeenCalledTimes(1);

    // The objection the old comment raised against caching, and the answer to
    // it: a command is the one thing in a run that can move the hooks without
    // any write this gate sees, so a command drops the cached answer.
    git('config', 'core.hooksPath', 'later/hooks');
    await executeTool(makeCall('execute_command', { command: 'echo', args: ['moved'] }), tmpRoot);

    expect(reasonFor('write_file', 'later/hooks/pre-commit')).toMatch(/git runs it on your next commit/);
    expect(resolveHooksDirResult).toHaveBeenCalledTimes(2);
  });

  it('leaves ordinary files alone', () => {
    expect(reasonFor('write_file', 'src/config.json')).toBeNull();
    expect(reasonFor('write_file', '.gitignore')).toBeNull();
    expect(reasonFor('write_file', 'README.md')).toBeNull();
    expect(reasonFor('write_file', '.codeep/sessions/today.json')).toBeNull();
    expect(reasonFor('write_file', 'docs/.mcp.json.md')).toBeNull();
    // Deliberately ungated: a custom command is prompt text expanded into a
    // message to the model, and the model's tool calls go through this gate
    // anyway. Pinned so a later "fix" has to argue with a test.
    expect(reasonFor('write_file', '.codeep/commands/deploy.md')).toBeNull();
  });

  it('sees through the trailing dots and spaces Windows drops', () => {
    // Both are literal directories on POSIX. On Windows the trailing dot and
    // the trailing space are stripped by the filesystem, and the write lands
    // in the real `.git`.
    expect(reasonFor('write_file', '.git./config')).toMatch(/what commands git runs/);
    expect(reasonFor('write_file', '.git /config')).toMatch(/what commands git runs/);
    expect(reasonFor('write_file', '.codeep/hooks./x.sh')).toMatch(/every tool call/);
  });

  it('follows a symlink that points at one of them', () => {
    // `ln -s .git tools` and a write to `tools/config` lands in the real one;
    // validatePath allows it because it never leaves the project.
    mkdirSync(join(tmpRoot, '.git'));
    symlinkSync(join(tmpRoot, '.git'), join(tmpRoot, 'tools'));

    expect(reasonFor('write_file', 'tools/config')).toMatch(/what commands git runs/);
  });

  it('covers every tool that writes a path, and only those', () => {
    expect(reasonFor('edit_file', '.git/config')).not.toBeNull();
    expect(reasonFor('delete_file', '.git/config')).not.toBeNull();
    expect(reasonFor('create_directory', '.git/hooks')).not.toBeNull();
    expect(reasonFor('writefile', '.git/config')).not.toBeNull();  // pre-normalized name
    expect(reasonFor('read_file', '.git/config')).toBeNull();      // reading one is not the risk
    expect(reasonFor('list_files', '.git')).toBeNull();
  });

  it('has nothing to say about a call without a path', () => {
    expect(reasonFor('write_file', undefined)).toBeNull();
    expect(reasonFor('write_file', '')).toBeNull();
    expect(reasonFor('write_file', { evil: true })).toBeNull();
    expect(reasonFor('execute_command', '.git/config')).toBeNull();
  });
});

// ─── The harness these tests run under ──────────────────────────────────────
//
// vitest.setup.ts has no test file of its own, and this is the file that
// leans hardest on what it provides: every case above writes into a temp
// project under the throwaway HOME it hands out.

describe("the harness's own temp directories", () => {
  it('removes the config directory and the HOME it made for a run', () => {
    // vitest.setup.ts runs once per test file and mkdtemps both, so every
    // `npx vitest run` used to leave two directories per test file behind in
    // TMPDIR for good — 14,518 of them and 276MB on the machine this was
    // found on.
    //
    // Proven by running the REAL setup file in a child vitest, over a
    // throwaway test that writes down the two paths it was given, and then
    // looking for them: nothing else can observe a teardown that runs after
    // the test file it belongs to.
    const probe = mkdtempSync(join(tmpdir(), 'codeep-setup-probe-'));
    const report = join(probe, 'dirs.txt');
    try {
      writeFileSync(join(probe, 'probe.test.ts'), [
        "import { it } from 'vitest';",
        "import { writeFileSync } from 'node:fs';",
        "it('writes down what the harness gave it', () => {",
        "  writeFileSync(process.env.PROBE_OUT!, [process.env.HOME, process.env.CODEEP_CONFIG_DIR].join('\\n'));",
        '});',
      ].join('\n'));
      // A plain object, not defineConfig(): this config sits outside the
      // project, so an `import ... from 'vitest/config'` in it would resolve
      // from a directory with no node_modules above it.
      writeFileSync(
        join(probe, 'vitest.config.ts'),
        `export default { test: { include: ['probe.test.ts'], setupFiles: [${JSON.stringify(join(process.cwd(), 'vitest.setup.ts'))}] } };\n`,
      );

      // CODEEP_CONFIG_DIR is dropped so the child makes (and so must remove)
      // one of its own instead of inheriting ours, and VITEST_* with it: the
      // child is its own run, not a worker of this one.
      const env: NodeJS.ProcessEnv = { ...process.env, PROBE_OUT: report };
      delete env.CODEEP_CONFIG_DIR;
      for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name];

      execFileSync(
        process.execPath,
        [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', '--root', probe, '--config', join(probe, 'vitest.config.ts')],
        { env, stdio: 'ignore', timeout: 120_000 },
      );

      const [childHome, childConfigDir] = readFileSync(report, 'utf-8').split('\n');
      expect(childHome).toMatch(/codeep-test-home-/);
      expect(childConfigDir).toMatch(/codeep-test-config-/);
      expect(existsSync(childHome)).toBe(false);
      expect(existsSync(childConfigDir)).toBe(false);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });
});

describe("the harness's environment", () => {
  it('runs every test without an exported CODEEP_OPENAI_WIRE_API', () => {
    // The switch overrides config, so a developer who exported it would send
    // every OpenAI agent turn in the suite to /responses and fail the Chat
    // Completions suites for a reason that is not in the code. Only a child
    // run that starts with it exported can show the setup file removes it —
    // the same arrangement as the test above.
    const probe = mkdtempSync(join(tmpdir(), 'codeep-setup-probe-'));
    const report = join(probe, 'wire.txt');
    try {
      writeFileSync(join(probe, 'probe.test.ts'), [
        "import { it } from 'vitest';",
        "import { writeFileSync } from 'node:fs';",
        "it('writes down the wire switch it sees', () => {",
        "  writeFileSync(process.env.PROBE_OUT!, process.env.CODEEP_OPENAI_WIRE_API ?? '<unset>');",
        '});',
      ].join('\n'));
      writeFileSync(
        join(probe, 'vitest.config.ts'),
        `export default { test: { include: ['probe.test.ts'], setupFiles: [${JSON.stringify(join(process.cwd(), 'vitest.setup.ts'))}] } };\n`,
      );

      const env: NodeJS.ProcessEnv = { ...process.env, PROBE_OUT: report, CODEEP_OPENAI_WIRE_API: 'responses' };
      delete env.CODEEP_CONFIG_DIR;
      for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name];

      execFileSync(
        process.execPath,
        [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', '--root', probe, '--config', join(probe, 'vitest.config.ts')],
        { env, stdio: 'ignore', timeout: 120_000 },
      );

      expect(readFileSync(report, 'utf-8')).toBe('<unset>');
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });
});
