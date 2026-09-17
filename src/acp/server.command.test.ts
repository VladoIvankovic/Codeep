/**
 * execute_command for ACP sessions (`executeAcpCommand` in acp/server.ts).
 *
 * The client side is a real StdioTransport whose outbound frames are
 * answered by a script, so the transport's own timeout and cancellation
 * behaviour is part of what is tested. Local execution is a spy: nothing is
 * ever spawned here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StdioTransport } from './transport';
import { executeAcpCommand, exitCodeFromWaitResult, type AcpCommandContext } from './server';
import { executeCommandAsync } from '../utils/shell';
import { checkCommandRateLimit } from '../utils/ratelimit';
import { recordCommand } from '../utils/history';

vi.mock('../utils/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/shell.js')>();
  return {
    ...actual,
    executeCommandAsync: vi.fn(async (command: string, args: string[] = []) => ({
      success: true, stdout: 'ran locally', stderr: '', exitCode: 0, duration: 0, command, args,
    })),
  };
});
vi.mock('../utils/ratelimit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/ratelimit.js')>();
  return { ...actual, checkCommandRateLimit: vi.fn(() => ({ allowed: true })) };
});
vi.mock('../utils/history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/history.js')>();
  return { ...actual, recordCommand: vi.fn(() => null) };
});

type Reply = { result: unknown } | { error: { code: number; message: string } } | 'hang';
type Frame = { id?: number; method?: string; params?: Record<string, unknown> };

/** A client that answers the agent's requests from a script. Unscripted
 *  methods, and those scripted as 'hang', are never answered. */
class ScriptedClient extends StdioTransport {
  frames: Frame[] = [];
  constructor(private script: Record<string, (params: Record<string, unknown>) => Reply>) {
    super();
  }
  protected override write(line: string): void {
    const msg = JSON.parse(line) as Frame;
    this.frames.push(msg);
    const answer = msg.method ? this.script[msg.method] : undefined;
    if (msg.id === undefined || !answer) return;
    const reply = answer(msg.params ?? {});
    if (reply === 'hang') return;
    queueMicrotask(() => this.onData(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n'));
  }
  methods(): (string | undefined)[] {
    return this.frames.map((f) => f.method);
  }
}

const CWD = '/tmp/acp-command-test';

function ctx(client: ScriptedClient, overrides: Partial<AcpCommandContext> = {}): AcpCommandContext {
  return {
    transport: client,
    sessionId: 'sess-1',
    clientSupportsTerminal: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const created = () => ({ result: { terminalId: 'term-1' } });
const output = (text: string) => () => ({ result: { output: text, truncated: false } });
const released = () => ({ result: {} });
// A client that would run anything it is sent to completion.
const runsToCompletion = {
  'terminal/create': created,
  'terminal/wait_for_exit': () => ({ result: { exitCode: 0, signal: null } }),
  'terminal/output': output(''),
  'terminal/release': released,
};

beforeEach(() => {
  vi.mocked(executeCommandAsync).mockClear();
  vi.mocked(recordCommand).mockClear();
  vi.mocked(checkCommandRateLimit).mockReset().mockReturnValue({ allowed: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Validation before the client terminal ────────────────────────────────────

describe('executeAcpCommand — command policy', () => {
  it.each([
    ['bash', ['-c', 'printenv > leaked.txt']],
    ['printenv', []],
    ['sudo', ['rm', '-rf', '/']],
  ])('refuses %s before anything reaches the client terminal', async (command, args) => {
    const client = new ScriptedClient(runsToCompletion);
    const r = await executeAcpCommand(command, args, CWD, ctx(client));
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toMatch(/not in the allowed list|not allowed|blocked/i);
    expect(client.frames).toEqual([]);
    expect(executeCommandAsync).not.toHaveBeenCalled();
    expect(recordCommand).not.toHaveBeenCalled();
  });

  it('refuses a blocked pattern even for a whitelisted command', async () => {
    const client = new ScriptedClient(runsToCompletion);
    const r = await executeAcpCommand('git', ['log', '$(cat ~/.ssh/id_rsa)'], CWD, ctx(client));
    expect(r.exitCode).toBe(-1);
    expect(client.frames).toEqual([]);
  });

  it('applies the command rate limit to the client terminal', async () => {
    vi.mocked(checkCommandRateLimit).mockReturnValue({ allowed: false, message: 'Too many commands. Please wait 5 seconds.' });
    const client = new ScriptedClient(runsToCompletion);
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client));
    expect(r).toEqual({ stdout: '', stderr: 'Too many commands. Please wait 5 seconds.', exitCode: -1 });
    expect(client.frames).toEqual([]);
    expect(recordCommand).not.toHaveBeenCalled();
  });

  it('applies the command rate limit to local runs too', async () => {
    vi.mocked(checkCommandRateLimit).mockReturnValue({ allowed: false, message: 'Too many commands.' });
    const client = new ScriptedClient({});
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client, { clientSupportsTerminal: false }));
    expect(r.exitCode).toBe(-1);
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('records an allowed command and sends it to the client terminal', async () => {
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => ({ result: { exitCode: 0, signal: null } }),
      'terminal/output': output('ok'),
      'terminal/release': released,
    });
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client));
    expect(r).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(checkCommandRateLimit).toHaveBeenCalledTimes(1);
    expect(recordCommand).toHaveBeenCalledWith('npm', ['test']);
    expect(client.frames[0]).toMatchObject({
      method: 'terminal/create',
      params: { sessionId: 'sess-1', command: 'npm', args: ['test'], cwd: CWD },
    });
  });
});

// ─── A client terminal that exists is never re-run locally ───────────────────

describe('executeAcpCommand — client terminal lifecycle', () => {
  it('reads the spec exit status and releases after reading the output', async () => {
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => ({ result: { exitCode: 3, signal: null } }),
      'terminal/output': output('3 failing'),
      'terminal/release': released,
    });
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client));
    expect(r).toEqual({ stdout: '3 failing', stderr: '', exitCode: 3 });
    await vi.waitFor(() => expect(client.methods()).toContain('terminal/release'));
    expect(client.methods()).toEqual(['terminal/create', 'terminal/wait_for_exit', 'terminal/output', 'terminal/release']);
    expect(client.frames[1].params).toEqual({ sessionId: 'sess-1', terminalId: 'term-1' });
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('still accepts the nested exitStatus shape', async () => {
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => ({ result: { exitStatus: { type: 'exited', code: 2 } } }),
      'terminal/output': output(''),
      'terminal/release': released,
    });
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client));
    expect(r.exitCode).toBe(2);
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('keeps waiting past 30s for a long command, then kills it at the command budget', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => 'hang',
      'terminal/kill': released,
      'terminal/output': output('added 1200 packages'),
      'terminal/release': released,
    });
    let result: Awaited<ReturnType<typeof executeAcpCommand>> | undefined;
    void executeAcpCommand('npm', ['install'], CWD, ctx(client)).then((r) => { result = r; });

    await vi.advanceTimersByTimeAsync(31_000);
    expect(result).toBeUndefined();
    expect(client.methods()).toEqual(['terminal/create', 'terminal/wait_for_exit']);
    expect(executeCommandAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(90_000);
    expect(result).toEqual({ stdout: 'added 1200 packages', stderr: 'Command timed out after 120000ms', exitCode: -1 });
    expect(client.methods()).toEqual([
      'terminal/create', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/output', 'terminal/release',
    ]);
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('kills the client command when the prompt is cancelled', async () => {
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => 'hang',
      'terminal/kill': released,
      'terminal/release': released,
    });
    const ac = new AbortController();
    const pending = executeAcpCommand('sleep', ['12'], CWD, ctx(client, { signal: ac.signal }));
    await vi.waitFor(() => expect(client.methods()).toContain('terminal/wait_for_exit'));
    ac.abort();
    await expect(pending).resolves.toEqual({ stdout: '', stderr: 'Command cancelled', exitCode: -1 });
    expect(client.methods()).toEqual(['terminal/create', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']);
    expect(client.frames[2].params).toEqual({ sessionId: 'sess-1', terminalId: 'term-1' });
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('reports a failed wait instead of running the command again', async () => {
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => ({ error: { code: -32603, message: 'terminal gone' } }),
      'terminal/output': output('half'),
      'terminal/release': released,
    });
    const r = await executeAcpCommand('npm', ['run', 'migrate'], CWD, ctx(client));
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('terminal gone');
    expect(r.stdout).toBe('half');
    expect(executeCommandAsync).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(client.methods()).toContain('terminal/release'));
  });

  it('reports a wait answer without an exit status instead of running the command again', async () => {
    const client = new ScriptedClient({
      'terminal/create': created,
      'terminal/wait_for_exit': () => ({ result: {} }),
      'terminal/output': output(''),
      'terminal/release': released,
    });
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client));
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('no exit status');
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('runs locally when the client refuses to create a terminal', async () => {
    const client = new ScriptedClient({
      'terminal/create': () => ({ error: { code: -32601, message: 'Method not found' } }),
    });
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client));
    expect(r).toEqual({ stdout: 'ran locally', stderr: '', exitCode: 0 });
    expect(executeCommandAsync).toHaveBeenCalledTimes(1);
    expect(client.methods()).toEqual(['terminal/create']);
  });

  it('does not run locally when terminal/create gets no answer (the client may still run it)', async () => {
    vi.useFakeTimers();
    const client = new ScriptedClient({ 'terminal/create': () => 'hang' });
    const pending = executeAcpCommand('npm', ['test'], CWD, ctx(client));
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await pending;
    expect(r.exitCode).toBe(-1);
    expect(executeCommandAsync).not.toHaveBeenCalled();
  });

  it('does not touch the client terminal once the prompt is already cancelled', async () => {
    const client = new ScriptedClient({ 'terminal/create': created });
    const ac = new AbortController();
    ac.abort();
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(client, { signal: ac.signal }));
    expect(r.stderr).toBe('Command cancelled');
    expect(client.frames).toEqual([]);
    expect(recordCommand).not.toHaveBeenCalled();
    expect(checkCommandRateLimit).not.toHaveBeenCalled();
  });
});

// ─── Local runs ──────────────────────────────────────────────────────────────

describe('executeAcpCommand — without a client terminal', () => {
  it('runs nothing once the prompt is already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(new ScriptedClient({}), { clientSupportsTerminal: false, signal: ac.signal }));
    expect(r).toEqual({ stdout: '', stderr: 'Command cancelled', exitCode: -1 });
    expect(executeCommandAsync).not.toHaveBeenCalled();
    expect(recordCommand).not.toHaveBeenCalled();
    expect(checkCommandRateLimit).not.toHaveBeenCalled();
  });

  it('hands the prompt\'s signal to the local run', async () => {
    const ac = new AbortController();
    const r = await executeAcpCommand('npm', ['test'], CWD, ctx(new ScriptedClient({}), { clientSupportsTerminal: false, signal: ac.signal }));
    expect(r).toEqual({ stdout: 'ran locally', stderr: '', exitCode: 0 });
    expect(executeCommandAsync).toHaveBeenCalledWith('npm', ['test'], expect.objectContaining({ cwd: CWD, projectRoot: CWD, signal: ac.signal }));
  });

  it('reports a local run stopped by the cancel as cancelled, whatever the process wrote', async () => {
    vi.mocked(executeCommandAsync).mockResolvedValueOnce({
      success: false, stdout: 'partial', stderr: 'npm ERR! signal SIGTERM', exitCode: 143, duration: 5, command: 'sleep', args: ['12'], cancelled: true,
    });
    const r = await executeAcpCommand('sleep', ['12'], CWD, ctx(new ScriptedClient({}), { clientSupportsTerminal: false }));
    expect(r).toEqual({ stdout: 'partial', stderr: 'Command cancelled', exitCode: -1 });
  });
});

describe('exitCodeFromWaitResult', () => {
  it.each<[unknown, number | null]>([
    [{ exitCode: 0, signal: null }, 0],
    [{ exitCode: 127 }, 127],
    [{ exitCode: null, signal: 'SIGTERM' }, 1],
    [{ exitStatus: { type: 'exited', code: 4 } }, 4],
    [{ exitStatus: { type: 'killed', signal: 'SIGKILL' } }, 1],
    [{ exitStatus: { exitCode: 5, signal: null } }, 5],
    [{}, null],
    [{ exitCode: null, signal: null }, null],
    [null, null],
    ['exited', null],
  ])('%j → %s', (input, expected) => {
    expect(exitCodeFromWaitResult(input)).toBe(expected);
  });
});
