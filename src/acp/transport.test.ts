import { describe, it, expect, vi, afterEach } from 'vitest';
import { StdioTransport, AcpRequestError, AcpRequestTimeoutError } from './transport';

// StdioTransport is the ACP wire layer: newline-delimited JSON-RPC over stdio.
// We exercise its framing/routing by driving the private onData() directly (so
// we never touch the real process.stdin) and spying on process.stdout for the
// outbound side.

function makeTransport(handler = vi.fn()) {
  const t = new StdioTransport();
  (t as unknown as { handler: unknown }).handler = handler;
  return { t, handler };
}
function feed(t: StdioTransport, chunk: string) {
  (t as unknown as { onData(c: string): void }).onData(chunk);
}

afterEach(() => vi.restoreAllMocks());

describe('StdioTransport — inbound framing', () => {
  it('parses a complete line and forwards it to the handler', () => {
    const { t, handler } = makeTransport();
    feed(t, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ id: 1, method: 'initialize' });
  });

  it('buffers a partial message until the newline arrives', () => {
    const { t, handler } = makeTransport();
    feed(t, '{"jsonrpc":"2.0",');
    expect(handler).not.toHaveBeenCalled();
    feed(t, '"method":"x"}\n');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ method: 'x' });
  });

  it('splits multiple messages in one chunk, in order', () => {
    const { t, handler } = makeTransport();
    feed(t, '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n');
    expect(handler.mock.calls.map((c) => (c[0] as { method: string }).method)).toEqual(['a', 'b']);
  });

  it('ignores malformed JSON and blank lines without throwing', () => {
    const { t, handler } = makeTransport();
    expect(() => feed(t, 'not json\n\n   \n')).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('routes a response to the matching pending request, not the handler', () => {
    const { t, handler } = makeTransport();
    const resolve = vi.fn();
    (t as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.set(5, { method: 'm', resolve, reject: vi.fn() });
    feed(t, '{"jsonrpc":"2.0","id":5,"result":{"ok":true}}\n');
    expect(resolve).toHaveBeenCalledWith({ ok: true });
    expect(handler).not.toHaveBeenCalled();
    expect((t as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.has(5)).toBe(false);
  });

  it('resets the buffer instead of growing past the 10MB cap', () => {
    const { t, handler } = makeTransport();
    feed(t, 'x'.repeat(10 * 1024 * 1024 + 1)); // no newline — would otherwise buffer forever
    expect(handler).not.toHaveBeenCalled();
    expect((t as unknown as { buffer: string }).buffer).toBe('');
  });
});

describe('StdioTransport — outbound frames', () => {
  it('respond() writes a JSON-RPC result line', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new StdioTransport().respond(1, { x: 1 });
    expect(write).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1,"result":{"x":1}}\n');
  });

  it('error() writes a JSON-RPC error line', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new StdioTransport().error(2, -32601, 'Method not found');
    const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
    expect(sent).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } });
  });

  it('notify() writes a JSON-RPC notification (no id)', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new StdioTransport().notify('session/update', { a: 1 });
    const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
    expect(sent).toEqual({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } });
    expect('id' in sent).toBe(false);
  });
});

describe('StdioTransport — outbound request round-trip', () => {
  it('sends a request with an incrementing id and resolves on the matching response', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const t = new StdioTransport();
    const p = t.request('session/request_permission', { foo: 1 });

    const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'session/request_permission', params: { foo: 1 } });
    expect(typeof sent.id).toBe('number');

    feed(t, JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }) + '\n');
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects when the request times out', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const p = new StdioTransport().request('m', {});
      vi.advanceTimersByTime(30_000);
      await expect(p).rejects.toBeInstanceOf(AcpRequestTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  // A client that refuses a request (read-only buffer, unknown terminal…)
  // answers with an error. Resolving that as an empty result made a refused
  // fs/write_text_file look like a successful write.
  it('rejects with the client error when the response carries one', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const t = new StdioTransport();
    const p = t.request('fs/write_text_file', { path: '/x' });
    const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
    feed(t, JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'Buffer is read-only' } }) + '\n');
    await expect(p).rejects.toBeInstanceOf(AcpRequestError);
    await expect(p).rejects.toThrow('Buffer is read-only');
  });

  it('still resolves a null result as null', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const t = new StdioTransport();
    const p = t.request('fs/write_text_file', {});
    const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
    feed(t, JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: null }) + '\n');
    await expect(p).resolves.toBeNull();
  });

  it('waits indefinitely when timeoutMs is 0 (a person is answering)', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const t = new StdioTransport();
      const p = t.request('session/request_permission', {}, { timeoutMs: 0 });
      const settled = vi.fn();
      p.then(settled, settled);
      vi.advanceTimersByTime(10 * 60_000);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
      const allow = { outcome: { type: 'selected', optionId: 'allow_once' } };
      feed(t, JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: allow }) + '\n');
      await expect(p).resolves.toEqual(allow);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with an AbortError when the signal fires, and drops the late answer', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const handler = vi.fn();
    const { t } = makeTransport(handler);
    const ac = new AbortController();
    const p = t.request('session/request_permission', {}, { timeoutMs: 0, signal: ac.signal });
    const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    feed(t, JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { outcome: { type: 'cancelled' } } }) + '\n');
    expect(handler).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('rejects at once when the signal has already fired, without sending', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ac = new AbortController();
    ac.abort();
    await expect(new StdioTransport().request('m', {}, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('StdioTransport — responses nobody is waiting for', () => {
  // A late answer (after a timeout) must not be treated as a request: that
  // replied to a response with "Method not found: undefined".
  it('drops a late response instead of dispatching it', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const handler = vi.fn();
      const { t } = makeTransport(handler);
      const p = t.request('m', {});
      p.catch(() => {});
      const sent = JSON.parse((write.mock.calls[0][0] as string).trim());
      vi.advanceTimersByTime(30_000);
      await expect(p).rejects.toBeInstanceOf(AcpRequestTimeoutError);
      feed(t, JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }) + '\n');
      expect(handler).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1); // only the original request
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a stray error response too', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { t, handler } = makeTransport();
    feed(t, '{"jsonrpc":"2.0","id":4242,"error":{"code":-1,"message":"x"}}\n');
    expect(handler).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('StdioTransport — failing handlers', () => {
  function sentFrames(write: { mock: { calls: unknown[][] } }) {
    return write.mock.calls.map((c) => JSON.parse((c[0] as string).trim()));
  }

  // A throw used to be swallowed as a "malformed message": the client never
  // got an answer and waited forever (e.g. session/new in a read-only cwd).
  it('answers a request whose handler throws with a JSON-RPC error', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { t } = makeTransport(vi.fn(() => { throw new Error("EACCES: permission denied, mkdir '/ro/.codeep'"); }));
    feed(t, '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/ro"}}\n');
    expect(sentFrames(write)).toEqual([
      { jsonrpc: '2.0', id: 2, error: { code: -32603, message: "EACCES: permission denied, mkdir '/ro/.codeep'" } },
    ]);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('session/new failed');
  });

  it('answers a request whose async handler rejects', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { t } = makeTransport(vi.fn(async () => { throw new Error('boom'); }));
    feed(t, '{"jsonrpc":"2.0","id":"p1","method":"session/prompt","params":{}}\n');
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(sentFrames(write)[0]).toEqual({ jsonrpc: '2.0', id: 'p1', error: { code: -32603, message: 'boom' } });
  });

  it('does not answer twice when the handler throws after responding', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const t = new StdioTransport();
    (t as unknown as { handler: unknown }).handler = (msg: { id: number }) => {
      t.respond(msg.id, { ok: true });
      throw new Error('after the answer');
    };
    feed(t, '{"jsonrpc":"2.0","id":3,"method":"x"}\n');
    expect(sentFrames(write)).toEqual([{ jsonrpc: '2.0', id: 3, result: { ok: true } }]);
  });

  it('keeps processing later lines after a handler throws', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const handler = vi.fn((msg: { method: string }) => { if (msg.method === 'a') throw new Error('a failed'); });
    const { t } = makeTransport(handler);
    feed(t, '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('never answers a notification, even when its handler throws', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { t } = makeTransport(vi.fn(() => { throw new Error('x'); }));
    feed(t, '{"jsonrpc":"2.0","method":"session/cancel","params":{}}\n');
    expect(write).not.toHaveBeenCalled();
  });
});
