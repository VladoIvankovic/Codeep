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
  const stderr = new EventEmitter();
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
import { McpClient } from './mcpClient';
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

    lastChild.current.emit('exit', 137);
    await expect(pending).rejects.toThrow(/exited \(code 137\)/);
  });
});
