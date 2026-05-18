import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock McpClient so the registry tests stay hermetic — we don't want to
// spawn real child processes here. The mock keeps a queue of pre-built
// fake clients and the constructor pops them in order, so each test can
// stage its own behaviour.
const { instanceQueue, McpClientMock } = vi.hoisted(() => {
  const instanceQueue: any[] = [];
  // Constructor MUST be `function` (or class) so `new` works — vi.fn()
  // alone trips a vitest warning and breaks instantiation.
  function McpClientMock(this: any, cfg: any) {
    const next = instanceQueue.shift() ?? { server: cfg, start: async () => {}, listTools: async () => [], callTool: async () => '', stop: async () => {} };
    // Mirror fields onto `this` so callers using `new McpClient(...)` get a
    // working instance regardless of whether they treat the return value
    // or `this` as the object.
    Object.assign(this, next);
    return this;
  }
  return { instanceQueue, McpClientMock };
});
vi.mock('./mcpClient.js', () => ({
  McpClient: McpClientMock,
}));

import {
  registerSessionServers,
  getSessionTools,
  callSessionTool,
  isMcpToolName,
  disposeSession,
  sessionCount,
} from './mcpRegistry';

function makeFakeClient(opts: {
  name: string;
  tools: { name: string; description?: string }[];
  startThrows?: string;
  callImpl?: (name: string, args: Record<string, unknown>) => Promise<string>;
}) {
  return {
    server: { name: opts.name, command: 'fake', args: [] },
    start: vi.fn(async () => {
      if (opts.startThrows) throw new Error(opts.startThrows);
    }),
    listTools: vi.fn(async () => opts.tools),
    callTool: opts.callImpl ? vi.fn(opts.callImpl) : vi.fn(async () => 'ok'),
    stop: vi.fn(async () => { /* noop */ }),
  };
}

beforeEach(async () => {
  instanceQueue.length = 0;
  // Clean up any leftover sessions from prior tests in this file.
  for (const id of ['s1', 's2', 'sX']) await disposeSession(id);
});

afterEach(async () => {
  for (const id of ['s1', 's2', 'sX']) await disposeSession(id);
});

describe('registerSessionServers', () => {
  it('returns empty result for no servers', async () => {
    const result = await registerSessionServers('s1', []);
    expect(result.registered).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('spawns clients and registers tools with prefixed names', async () => {
    const client = makeFakeClient({
      name: 'fs',
      tools: [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
      ],
    });
    instanceQueue.push(client);

    const result = await registerSessionServers('s1', [
      { name: 'fs', command: 'npx', args: ['filesystem'] },
    ]);

    expect(client.start).toHaveBeenCalled();
    expect(client.listTools).toHaveBeenCalled();
    expect(result.errors).toEqual([]);
    expect(result.registered.map(t => t.agentName)).toEqual(['fs__read_file', 'fs__write_file']);
    expect(result.registered[0].serverName).toBe('fs');
    expect(result.registered[0].toolName).toBe('read_file');
  });

  it('continues with other servers when one fails to start', async () => {
    const bad = makeFakeClient({ name: 'bad', tools: [], startThrows: 'command not found' });
    const good = makeFakeClient({ name: 'good', tools: [{ name: 'ping' }] });
    instanceQueue.push(bad, good);

    const result = await registerSessionServers('s1', [
      { name: 'bad', command: 'nope', args: [] },
      { name: 'good', command: 'yes', args: [] },
    ]);

    expect(result.errors).toEqual([{ server: 'bad', error: 'command not found' }]);
    expect(result.registered.map(t => t.agentName)).toEqual(['good__ping']);
    expect(bad.stop).toHaveBeenCalled(); // cleanup the failed one
  });

  it('disposes prior set when called twice for same sessionId (idempotent)', async () => {
    const first = makeFakeClient({ name: 'a', tools: [{ name: 't' }] });
    const second = makeFakeClient({ name: 'b', tools: [{ name: 'u' }] });
    instanceQueue.push(first, second);

    await registerSessionServers('s1', [{ name: 'a', command: 'x', args: [] }]);
    await registerSessionServers('s1', [{ name: 'b', command: 'x', args: [] }]);

    expect(first.stop).toHaveBeenCalled();
    const tools = await getSessionTools('s1');
    expect(tools.map(t => t.agentName)).toEqual(['b__u']);
  });
});

describe('callSessionTool', () => {
  it('routes to the right server and returns its output', async () => {
    const client = makeFakeClient({
      name: 'gh',
      tools: [{ name: 'get_pr' }],
      callImpl: async (name, args) => `called ${name} with ${(args as any).id}`,
    });
    instanceQueue.push(client);
    await registerSessionServers('s1', [{ name: 'gh', command: 'x', args: [] }]);

    const out = await callSessionTool('s1', 'gh__get_pr', { id: 42 });
    expect(out).toBe('called get_pr with 42');
    expect(client.callTool).toHaveBeenCalledWith('get_pr', { id: 42 });
  });

  it('throws on unknown session', async () => {
    await expect(callSessionTool('missing', 'fs__read_file', {}))
      .rejects.toThrow(/No MCP servers registered/);
  });

  it('throws on malformed (non-prefixed) tool name', async () => {
    const client = makeFakeClient({ name: 'fs', tools: [{ name: 'x' }] });
    instanceQueue.push(client);
    await registerSessionServers('s1', [{ name: 'fs', command: 'x', args: [] }]);
    await expect(callSessionTool('s1', 'no_delim_here', {}))
      .rejects.toThrow(/not in the expected "server__tool" form/);
  });

  it('throws when the server prefix does not match a registered server', async () => {
    const client = makeFakeClient({ name: 'fs', tools: [{ name: 'x' }] });
    instanceQueue.push(client);
    await registerSessionServers('s1', [{ name: 'fs', command: 'x', args: [] }]);
    await expect(callSessionTool('s1', 'other__x', {}))
      .rejects.toThrow(/No MCP server named "other"/);
  });
});

describe('isMcpToolName', () => {
  it('true for prefixed names', () => {
    expect(isMcpToolName('fs__read_file')).toBe(true);
    expect(isMcpToolName('a__b')).toBe(true);
  });
  it('false for built-in tool names', () => {
    expect(isMcpToolName('read_file')).toBe(false);
    expect(isMcpToolName('write_file')).toBe(false);
    expect(isMcpToolName('execute_command')).toBe(false);
  });
});

describe('disposeSession', () => {
  it('stops all clients and removes the session entry', async () => {
    const client = makeFakeClient({ name: 'fs', tools: [] });
    instanceQueue.push(client);
    await registerSessionServers('s1', [{ name: 'fs', command: 'x', args: [] }]);
    expect(sessionCount()).toBe(1);
    await disposeSession('s1');
    expect(client.stop).toHaveBeenCalled();
    expect(sessionCount()).toBe(0);
  });

  it('is a no-op when the session has no clients', async () => {
    await expect(disposeSession('never-registered')).resolves.toBeUndefined();
  });
});
