import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTool, FsCallbacks } from './toolExecution';
import { ToolCall } from './tools';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codeep-toolexec-'));
});

afterEach(() => {
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
