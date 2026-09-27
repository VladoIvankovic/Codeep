import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake child_process.spawn — returns a controllable EventEmitter wrapper that
// looks enough like ChildProcess for McpClient to use it. Tests drive the
// "server side" by calling `respond()` on the handle they get back from
// `lastChild`.
const { spawnMock, lastChild } = vi.hoisted(() => {
  const lastChild: { current: any } = { current: null };
  const spawnMock = vi.fn();
  return { spawnMock, lastChild };
});
vi.mock('child_process', () => ({ spawn: spawnMock }));

function makeFakeChild() {
  const stdin = {
    written: [] as string[],
    write(chunk: string) { this.written.push(chunk); return true; },
  };
  const stdout = new EventEmitter() as EventEmitter & { setEncoding(enc: string): void };
  stdout.setEncoding = () => { /* matches McpClient's call */ };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(enc: string): void };
  stderr.setEncoding = () => { /* McpClient reads stderr as text */ };
  const child: any = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  // Pull the next JSON-RPC frame the client sent, parsed.
  child._lastRequest = () => {
    const raw = stdin.written[stdin.written.length - 1];
    if (!raw) return null;
    return JSON.parse(raw.trim());
  };
  // Push a JSON-RPC frame in (newline-terminated as the spec requires).
  child._respond = (payload: object) => {
    stdout.emit('data', JSON.stringify(payload) + '\n');
  };
  // Exit the way a real process does: its stderr reaches end of file, then
  // 'exit'. (A test that needs 'exit' first emits the events itself.)
  child._exit = (code: number | null, signal: string | null = null, stderrText = '') => {
    if (stderrText) stderr.emit('data', stderrText);
    stderr.emit('end');
    child.emit('exit', code, signal);
  };
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = makeFakeChild();
    lastChild.current = child;
    return child;
  });
});

// Import AFTER the mock is set so McpClient picks up the fake spawn.
import { McpClient, stderrSummary, exitReason, missingCommandReason, STDERR_DRAIN_GRACE_MS } from './mcpClient';
import type { McpServer } from '../acp/protocol';

const SERVER: McpServer = { name: 'fs', command: 'npx', args: ['filesystem'] };

describe('McpClient.start', () => {
  it('spawns the child with command + args + env', async () => {
    const client = new McpClient({ ...SERVER, env: { READ_ONLY: '1' } });
    const startPromise = client.start();

    // The first thing start() does is send `initialize`. Reply so it can
    // proceed to send `notifications/initialized`.
    await Promise.resolve();
    const initReq = lastChild.current._lastRequest();
    expect(initReq.method).toBe('initialize');
    expect(initReq.params.clientInfo.name).toBe('codeep');
    lastChild.current._respond({ jsonrpc: '2.0', id: initReq.id, result: { capabilities: {} } });

    await startPromise;

    expect(spawnMock).toHaveBeenCalledWith('npx', ['filesystem'], expect.objectContaining({
      env: expect.objectContaining({ READ_ONLY: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }));

    // After init, the client must send notifications/initialized so the
    // server knows the handshake is done.
    const notification = lastChild.current._lastRequest();
    expect(notification.method).toBe('notifications/initialized');
    expect(notification.id).toBeUndefined();
  });

  it('rejects when initialize times out', async () => {
    const client = new McpClient(SERVER);
    // Don't respond — let the timeout fire.
    await expect(client.start({ initTimeoutMs: 50 })).rejects.toThrow(/initialize timed out/);
  });

  it('refuses to be started twice', async () => {
    const client = new McpClient(SERVER);
    const p = client.start();
    await Promise.resolve();
    const req = lastChild.current._lastRequest();
    lastChild.current._respond({ jsonrpc: '2.0', id: req.id, result: {} });
    await p;
    await expect(client.start()).rejects.toThrow(/already started/);
  });
});

describe('McpClient.listTools', () => {
  async function startedClient() {
    const client = new McpClient(SERVER);
    const startPromise = client.start();
    await Promise.resolve();
    const initReq = lastChild.current._lastRequest();
    lastChild.current._respond({ jsonrpc: '2.0', id: initReq.id, result: {} });
    await startPromise;
    return client;
  }

  it('sends tools/list and returns the parsed tools', async () => {
    const client = await startedClient();
    const promise = client.listTools();
    await Promise.resolve();
    const req = lastChild.current._lastRequest();
    expect(req.method).toBe('tools/list');
    lastChild.current._respond({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          { name: 'read_file', description: 'Read a file' },
          { name: 'write_file' },
        ],
      },
    });
    const tools = await promise;
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('read_file');
    expect(tools[0].description).toBe('Read a file');
  });

  it('caches the result on second call (no second tools/list)', async () => {
    const client = await startedClient();
    const promise1 = client.listTools();
    await Promise.resolve();
    const req = lastChild.current._lastRequest();
    lastChild.current._respond({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'foo' }] } });
    await promise1;

    const stdinLenBefore = lastChild.current.stdin.written.length;
    const tools2 = await client.listTools();
    expect(tools2).toHaveLength(1);
    // No new frame should have been written for the cached call.
    expect(lastChild.current.stdin.written.length).toBe(stdinLenBefore);
  });
});

describe('McpClient.callTool', () => {
  async function startedClient() {
    const client = new McpClient(SERVER);
    const startPromise = client.start();
    await Promise.resolve();
    const initReq = lastChild.current._lastRequest();
    lastChild.current._respond({ jsonrpc: '2.0', id: initReq.id, result: {} });
    await startPromise;
    return client;
  }

  it('sends tools/call and flattens text content blocks', async () => {
    const client = await startedClient();
    const promise = client.callTool('read_file', { path: '/x' });
    await Promise.resolve();
    const req = lastChild.current._lastRequest();
    expect(req.method).toBe('tools/call');
    expect(req.params).toEqual({ name: 'read_file', arguments: { path: '/x' } });
    lastChild.current._respond({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
          { type: 'image', data: 'ignored' },
        ],
      },
    });
    expect(await promise).toBe('line1\nline2');
  });

  it('throws when result has isError: true', async () => {
    const client = await startedClient();
    const promise = client.callTool('read_file', {});
    await Promise.resolve();
    const req = lastChild.current._lastRequest();
    lastChild.current._respond({
      jsonrpc: '2.0',
      id: req.id,
      result: { isError: true, content: [{ type: 'text', text: 'permission denied' }] },
    });
    await expect(promise).rejects.toThrow(/permission denied/);
  });

  it('throws when the server returns a JSON-RPC error', async () => {
    const client = await startedClient();
    const promise = client.callTool('missing_tool', {});
    await Promise.resolve();
    const req = lastChild.current._lastRequest();
    lastChild.current._respond({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: 'Method not found' },
    });
    await expect(promise).rejects.toThrow(/Method not found/);
  });
});

describe('McpClient.stop', () => {
  it('kills the child and rejects in-flight requests', async () => {
    const client = new McpClient(SERVER);
    const startPromise = client.start();
    await Promise.resolve();
    const initReq = lastChild.current._lastRequest();
    lastChild.current._respond({ jsonrpc: '2.0', id: initReq.id, result: {} });
    await startPromise;
    const childRef = lastChild.current;

    // Fire a tool call we'll never answer.
    const pending = client.callTool('slow', {});
    await Promise.resolve();

    await client.stop();

    expect(childRef.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(pending).rejects.toThrow(/stopped/);
  });

  it('is idempotent', async () => {
    const client = new McpClient(SERVER);
    await client.stop();
    await client.stop();          // second call must not throw
  });
});

describe('McpClient process exit', () => {
  it('rejects pending requests when the child dies', async () => {
    const client = new McpClient(SERVER);
    const startPromise = client.start();
    await Promise.resolve();
    const initReq = lastChild.current._lastRequest();
    lastChild.current._respond({ jsonrpc: '2.0', id: initReq.id, result: {} });
    await startPromise;

    const pending = client.callTool('foo', {});
    await Promise.resolve();

    lastChild.current._exit(137);
    await expect(pending).rejects.toThrow(/exited \(code 137\)/);
  });
});

// What `npx -y <package that is not on npm>` writes to stderr (captured
// 2026-09-27, log path replaced).
const NPX_404 = [
  'npm error code E404',
  'npm error 404 Not Found - GET https://registry.npmjs.org/@modelcontextprotocol%2fserver-fetch - Not found',
  'npm error 404',
  "npm error 404  The requested resource '@modelcontextprotocol/server-fetch@*' could not be found or you do not have permission to access it.",
  'npm error 404',
  'npm error 404 Note that you can also install from a',
  'npm error 404 tarball, folder, http url, or git url.',
  'npm error A complete log of this run can be found in: /home/you/.npm/_logs/2026-09-27T09_37_54_557Z-debug-0.log',
  '',
].join('\n');

describe('stderrSummary', () => {
  it('keeps the lines of an npx 404 that name the problem, not npm\'s boilerplate', () => {
    const out = stderrSummary(NPX_404, []);
    expect(out).toBe(
      'npm error code E404 · npm error 404 Not Found - GET https://registry.npmjs.org/@modelcontextprotocol%2fserver-fetch - Not found · '
      + "npm error 404  The requested resource '@modelcontextprotocol/server-fetch@*' could not be found or you do not have permission to access it.",
    );
  });

  it('keeps the last three lines, and the end of them when they are long', () => {
    expect(stderrSummary('one\ntwo\r\nthree\rfour\n', [])).toBe('two · three · four');
    const out = stderrSummary('x'.repeat(1000) + 'THE END', []);
    expect(Array.from(out)).toHaveLength(300);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('THE END')).toBe(true);
  });

  it('masks every env value of 4+ characters, before cutting, so no fragment survives', () => {
    // The secret straddles the 300-character cut: masked after cutting, its
    // tail would still be on screen.
    const secret = 'sk-live-0123456789abcdefghij';
    const stderr = `connect failed for ${secret}` + 'y'.repeat(290);
    const out = stderrSummary(stderr, [secret, 'on']);
    expect(out).toContain('•••');
    expect(out).not.toContain(secret.slice(-6));
    // Short values ("on", "1", "true") are not hidden: they are not secrets
    // and would garble every line they appear in.
    expect(stderrSummary('connection refused', ['on'])).toBe('connection refused');
  });

  it('hides the longer of two overlapping secrets whole', () => {
    expect(stderrSummary('pw=hunter2hunter2', ['hunter2', 'hunter2hunter2'])).toBe('pw=•••');
  });

  it('spells out control characters and turns backticks into quotes', () => {
    const out = stderrSummary('bad \x1b[8mhidden\x1b[0m `rm -rf`', []);
    expect(out).toBe("bad \\x1b[8mhidden\\x1b[0m 'rm -rf'");
  });
});

describe('exitReason', () => {
  it('adds the end of stderr to the exit sentence', () => {
    expect(exitReason('pg', 1, null, 'Error: DATABASE_URL is not set\n', []))
      .toBe('MCP server "pg" exited (code 1): Error: DATABASE_URL is not set');
    expect(exitReason('pg', 0, null, '', [])).toBe('MCP server "pg" exited (code 0)');
  });

  it('says a server killed by a signal was killed, rather than "code null"', () => {
    expect(exitReason('pg', null, 'SIGKILL', '', [])).toBe('MCP server "pg" was killed by signal SIGKILL');
  });

  it('escapes a server name that carries a line break', () => {
    expect(exitReason('a\nb', 1, null, '', [])).toBe('MCP server "a\\x0ab" exited (code 1)');
  });
});

describe('McpClient exit reasons', () => {
  it('rejects a server that dies at start with the end of its stderr, env values masked', async () => {
    const client = new McpClient({ name: 'pg', command: 'npx', args: ['pg-mcp'], env: { DATABASE_URL: 'postgres://me:hunter2secret@db/prod' } });
    const started = client.start();
    await Promise.resolve();
    lastChild.current._exit(1, null, 'Error: could not connect to postgres://me:hunter2secret@db/prod\n');
    const err = await started.then(() => null, (e: Error) => e);
    expect(err?.message).toBe('MCP server "pg" exited (code 1): Error: could not connect to •••');
  });

  it('still reports the exit when the config holds a non-string env value', async () => {
    // The loader passes `null` through; reading it as a secret threw inside
    // the exit handler, and the start waited out its timeout instead.
    const client = new McpClient({ ...SERVER, env: { EMPTY: null as unknown as string, TOKEN: 'secret-value-123' } });
    const outcome = client.start({ initTimeoutMs: 1000 }).then(() => null, (e: Error) => e.message);
    await Promise.resolve();
    lastChild.current._exit(1, null, 'bad token secret-value-123\n');
    expect(await outcome).toBe('MCP server "fs" exited (code 1): bad token •••');
  });

  it('masks the values of an env list in the ACP [{ name, value }] shape', async () => {
    const env = [{ name: 'TOKEN', value: 'acp-secret-456' }] as unknown as Record<string, string>;
    const client = new McpClient({ ...SERVER, env });
    const outcome = client.start({ initTimeoutMs: 1000 }).then(() => null, (e: Error) => e.message);
    await Promise.resolve();
    lastChild.current._exit(1, null, 'bad token acp-secret-456\n');
    expect(await outcome).toBe('MCP server "fs" exited (code 1): bad token •••');
  });

  it('waits for stderr that arrives after the exit event', async () => {
    // Node can deliver 'exit' before the last stderr chunk — here a few
    // milliseconds later, the way a pipe drains on a busy machine.
    const client = new McpClient(SERVER);
    const outcome = client.start().then(() => null, (e: Error) => e.message);
    await Promise.resolve();
    const child = lastChild.current;
    child.emit('exit', 1, null);
    await new Promise(r => setTimeout(r, 20));
    child.stderr.emit('data', 'Error: ENOENT: no such file or directory, stat \'/nope\'\n');
    child.stderr.emit('end');
    expect(await outcome).toBe('MCP server "fs" exited (code 1): Error: ENOENT: no such file or directory, stat \'/nope\'');
  });

  it('reports the exit without stderr once the drain grace runs out', async () => {
    // Something the server started may hold stderr open for good.
    const client = new McpClient(SERVER);
    const started = client.start();
    await Promise.resolve();
    const t0 = Date.now();
    lastChild.current.emit('exit', 3, null);
    await expect(started).rejects.toThrow(/^MCP server "fs" exited \(code 3\)$/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(STDERR_DRAIN_GRACE_MS - 20);
  });

  it('says plainly that uvx is missing, and to install uv', async () => {
    const client = new McpClient({ name: 'git', command: 'uvx', args: ['mcp-server-git'] });
    const started = client.start();
    await Promise.resolve();
    lastChild.current.emit('error', Object.assign(new Error('spawn uvx ENOENT'), { code: 'ENOENT', syscall: 'spawn uvx', path: 'uvx' }));
    const err = await started.then(() => null, (e: Error) => e);
    expect(err?.message).toBe(
      'MCP server "git" could not start: "uvx" was not found on PATH. Install uv, which provides uvx (https://docs.astral.sh/uv/getting-started/installation/), then run /mcp reload.',
    );
  });
});

describe('missingCommandReason', () => {
  it('points npx at Node.js and anything else at the config', () => {
    expect(missingCommandReason('fs', 'npx')).toContain('Install Node.js, which provides npx');
    expect(missingCommandReason('fs', 'C:\\tools\\npx.cmd')).toContain('Install Node.js, which provides npx');
    expect(missingCommandReason('x', '/opt/bin/my-server')).toContain('"/opt/bin/my-server" was not found on PATH. Install it, or fix the command in the server\'s MCP config');
  });

  it('keeps backticks out: the reason is shown inside a code span', () => {
    expect(missingCommandReason('x', 'a`b')).not.toContain('`');
  });
});
