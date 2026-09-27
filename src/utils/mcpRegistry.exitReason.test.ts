/**
 * An MCP server's exit reason, end to end: the real McpClient and the real
 * registry, with only `spawn` replaced by a fake process. What the user sees
 * is `/mcp`'s "Failed servers" list, built from getSessionRegistrationErrors,
 * so that is what these read — a reason the client knows but the list drops
 * is still "exited (code 1)" to the user.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
}));

import { registerSessionServers, getSessionRegistrationErrors, disposeSession } from './mcpRegistry';
import { formatMcpServerList } from '../renderer/commands/helpers';

/**
 * A fake server process. `answers` makes it reply to `initialize` and
 * `tools/list` like a healthy server; `crashWith` makes it write that to
 * stderr and exit with code 1 right after it is spawned.
 */
function fakeChild(opts: { answers?: boolean; crashWith?: string }) {
  const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const child: any = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.crash = (text: string) => {
    stderr.emit('data', text);
    stderr.emit('end');
    child.emit('exit', 1, null);
  };
  child.stdin = {
    write(raw: string) {
      const frame = JSON.parse(raw);
      if (!opts.answers || typeof frame.id !== 'number') return true;
      const result = frame.method === 'tools/list' ? { tools: [{ name: 'ping' }] } : {};
      queueMicrotask(() => stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n'));
      return true;
    },
  };
  if (opts.crashWith !== undefined) setTimeout(() => child.crash(opts.crashWith), 0);
  return child;
}

// A block, not `() => spawnMock.mockReset()`: that returns the mock, and
// Vitest calls a function returned from beforeEach as the test's teardown —
// "spawning" one more fake process after every test.
beforeEach(() => { spawnMock.mockReset(); });
afterEach(async () => {
  await disposeSession('exit-reason');
  vi.useRealTimers();
});

describe('a server that exits while starting', () => {
  it('is listed under "Failed servers" with the end of its stderr, its env values masked', async () => {
    spawnMock.mockImplementation(() => fakeChild({ crashWith: 'npm error code E404\nError: bad token sk-abcdef123456\nnpm error A complete log of this run can be found in: /x.log\n' }));

    const { errors } = await registerSessionServers('exit-reason', [
      { name: 'gh', command: 'npx', args: ['-y', 'gh-mcp'], env: { GH_TOKEN: 'sk-abcdef123456' } },
    ]);

    const reason = 'MCP server "gh" exited (code 1): npm error code E404 · Error: bad token •••';
    expect(errors).toEqual([{ server: 'gh', error: reason }]);
    expect(getSessionRegistrationErrors('exit-reason')).toEqual([{ server: 'gh', error: reason }]);
    const list = formatMcpServerList([], getSessionRegistrationErrors('exit-reason'));
    expect(list).toContain('### Failed servers');
    expect(list).toContain(`- **gh** — \`${reason}\``);
  });

  it('is listed as a missing command when the command is not there at all', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild({});
      setTimeout(() => child.emit('error', Object.assign(new Error('spawn uvx ENOENT'), { code: 'ENOENT', syscall: 'spawn uvx' })), 0);
      return child;
    });

    await registerSessionServers('exit-reason', [{ name: 'git', command: 'uvx', args: ['mcp-server-git'] }]);

    expect(getSessionRegistrationErrors('exit-reason')).toEqual([{
      server: 'git',
      error: 'MCP server "git" could not start: "uvx" was not found on PATH. Install uv, which provides uvx (https://docs.astral.sh/uv/getting-started/installation/), then run /mcp reload.',
    }]);
  });
});

describe('a server that keeps crashing after it started', () => {
  it('is listed with the reason it last exited, not only how often it crashed', async () => {
    vi.useFakeTimers();
    // First a healthy server; every restart after its crash dies at once.
    // Only the LAST one writes "last-crash": a reason that also carried the
    // earlier processes' stderr would name the wrong failure.
    let spawned = 0;
    let first: any;
    spawnMock.mockImplementation(() => {
      spawned += 1;
      if (spawned === 1) return (first = fakeChild({ answers: true }));
      return fakeChild({ crashWith: spawned === 4 ? 'Error: last-crash\n' : 'Error: earlier-crash\n' });
    });

    const { errors } = await registerSessionServers('exit-reason', [{ name: 'flaky', command: 'flaky-mcp', args: [] }]);
    expect(errors).toEqual([]);

    first.crash('Error: first-crash\n');
    // Backoff 0.5s + 1s + 2s between the restarts, then it gives up.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawned).toBe(4);
    expect(getSessionRegistrationErrors('exit-reason')).toEqual([{
      server: 'flaky',
      error: 'MCP server "flaky" exited (code 1): Error: last-crash — gave up auto-restart (crashed 4 times in 60s)',
    }]);
  });
});
