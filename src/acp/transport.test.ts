import { describe, it, expect, vi, afterEach } from 'vitest';
import { StdioTransport } from './transport';

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
    (t as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.set(5, resolve);
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

  it('resolves to null when the request times out', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const p = new StdioTransport().request('m', {});
      vi.advanceTimersByTime(30_000);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
