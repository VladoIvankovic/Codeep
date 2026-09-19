import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StdioTransport, AcpRequestError, AcpRequestTimeoutError, redactCredentials } from './transport';

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

// ─── The debug log ─────────────────────────────────────────────────────────

describe('redactCredentials', () => {
  // A member name is not always there to say "this is a secret": a token
  // reaches the log inside a command line the agent ran, a terminal's own
  // output, or a file it read. These shapes are a credential wherever they
  // turn up, so they are blanked wherever they turn up.
  it.each([
    ['ghp_0123456789abcdefghij0123456789abcd', 'a GitHub token'],
    ['xoxb-1234567890-abcdefghijkl', 'a Slack token'],
    ['AKIAIOSFODNN7EXAMPLE', 'an AWS access key id'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27u', 'a JWT'],
  ])('blanks %s (%s)', (secret) => {
    const out = redactCredentials(`{"output":"export X=${secret}"}`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('keeps the shape of a URL and drops only the password in it', () => {
    expect(redactCredentials('{"remote":"https://vlado:hunter2@example.com/x.git"}'))
      .toBe('{"remote":"https://vlado:[redacted]@example.com/x.git"}');
  });

  it('leaves an ordinary frame alone, because the log is for reading', () => {
    // Blanket redaction would make the log useless for the one job it has.
    const frame = '{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"cwd":"/Users/x/p"}}';
    expect(redactCredentials(frame)).toBe(frame);
  });

  it('is a filter over text and not a guarantee, which is the whole posture', () => {
    // Stated here rather than only in a comment, because everything else
    // about this log follows from it: a secret with neither a member name
    // that says so nor a shape anybody can recognise goes through unchanged,
    // and it reaches the log inside whatever a command printed. That is why
    // the file is 0600 in a 0700 directory and why it is not a thing to
    // attach to a bug report unread — not because the patterns above are
    // expected to catch everything.
    const frame = '{"output":"the deploy passphrase is correct-horse-battery-staple"}';
    expect(redactCredentials(frame)).toBe(frame);
  });
});

describe('the debug log itself', () => {
  let home: string;
  const saved = {
    debug: process.env.CODEEP_ACP_DEBUG,
    file: process.env.CODEEP_ACP_DEBUG_FILE,
    home: process.env.HOME,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeep-acp-log-'));
    // os.homedir() reads $HOME on POSIX and the log hangs off it, so a real
    // HOME here would write these frames into the developer's own
    // ~/.cache/codeep/acp-debug.log — and chmod it while it was at it.
    process.env.HOME = home;
    process.env.CODEEP_ACP_DEBUG = '1';
    delete process.env.CODEEP_ACP_DEBUG_FILE;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (saved.debug === undefined) delete process.env.CODEEP_ACP_DEBUG; else process.env.CODEEP_ACP_DEBUG = saved.debug;
    if (saved.file === undefined) delete process.env.CODEEP_ACP_DEBUG_FILE; else process.env.CODEEP_ACP_DEBUG_FILE = saved.file;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  const logPath = () => join(home, '.cache', 'codeep', 'acp-debug.log');

  /** transport.ts reads CODEEP_ACP_DEBUG and the path at import time, and
   *  remembers the log's size after the first write, so every case here needs
   *  its own copy of the module. */
  async function freshTransport(): Promise<typeof StdioTransport> {
    vi.resetModules();
    return (await import('./transport')).StdioTransport;
  }

  it('blanks credential-shaped values instead of mirroring them verbatim', async () => {
    // Every outbound frame is mirrored here, and terminal/create used to
    // carry the whole of process.env — so an ANTHROPIC_API_KEY in the user's
    // shell was written to a plaintext file on disk on the first git command.
    const Transport = await freshTransport();
    new Transport().notify('terminal/create', {
      command: 'git',
      env: [
        { name: 'PATH', value: '/usr/bin' },
        { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-api03-notarealkeyatall0000000000' },
      ],
      apiKey: 'a-value-no-pattern-would-recognise',
    });

    const log = readFileSync(logPath(), 'utf-8');
    expect(log).not.toContain('notarealkeyatall');
    expect(log).not.toContain('a-value-no-pattern-would-recognise');
    // Narrow and not blanket: the method and the ordinary values are what the
    // file is opened for.
    expect(log).toContain('terminal/create');
    expect(log).toContain('/usr/bin');
  });

  it('redacts the copy on disk and not the frame on the wire', async () => {
    // The log is a mirror hung off the send path, not a filter in it. Blanking
    // `line` before `process.stdout.write` would change what the CLIENT gets:
    // a `GIT_CONFIG_VALUE_<n>`, a file being written through fs/write_text_file
    // or a prompt that merely LOOKS like one of the patterns above would
    // arrive at the editor as `[redacted]`, and the editor would act on that.
    const Transport = await freshTransport();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new Transport().notify('session/update', { text: 'ghp_0123456789abcdefghij0123456789abcd' });

    expect(String(write.mock.calls[0][0])).toContain('ghp_0123456789abcdefghij0123456789abcd');
    expect(readFileSync(logPath(), 'utf-8')).not.toContain('ghp_0123456789abcdefghij0123456789abcd');
  });

  it('creates the log 0600 inside a 0700 directory', async () => {
    // It held the whole session and was created with appendFileSync's default
    // 0666 & umask — 0644 on a normal machine, readable by every account on
    // the box.
    const Transport = await freshTransport();
    new Transport().notify('session/update', {});

    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(logPath())).mode & 0o777).toBe(0o700);
  });

  it('tightens a log an older build left world-readable', async () => {
    mkdirSync(dirname(logPath()), { recursive: true });
    writeFileSync(logPath(), 'from an older run\n');
    chmodSync(logPath(), 0o644); // writeFileSync's `mode` does not touch an existing file
    const Transport = await freshTransport();
    new Transport().notify('session/update', {});

    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
    // Tightened, not replaced: the earlier session is still there to read.
    expect(readFileSync(logPath(), 'utf-8')).toContain('from an older run');
  });

  it('rolls over instead of growing without a limit', async () => {
    mkdirSync(dirname(logPath()), { recursive: true });
    writeFileSync(logPath(), 'the handshake at the top\n');
    // Sparse, so this costs no disk — only the SIZE decides the rollover.
    truncateSync(logPath(), 8 * 1024 * 1024);
    const Transport = await freshTransport();
    new Transport().notify('after the rollover', {});

    expect(statSync(logPath()).size).toBeLessThan(4096);
    expect(readFileSync(logPath(), 'utf-8')).toContain('after the rollover');
    // One previous file rather than a truncate: the frames that explain a
    // broken session are usually the handshake at the top, which is exactly
    // what a truncate throws away.
    expect(readFileSync(`${logPath()}.1`, 'utf-8')).toContain('the handshake at the top');
  });
});
