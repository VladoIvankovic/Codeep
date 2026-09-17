/**
 * Session lifecycle through the running ACP server: `startAcpServer()` is
 * given a transport whose stdio is replaced by an in-memory client, and the
 * agent loop, workspace setup, MCP spawning and cloud reporting are mocked.
 * What is real: the server's dispatch, its session map, and the transport's
 * request/response handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StdioTransport } from './transport';
import { startAcpServer } from './server';
import { runAgentSession, type AgentSessionOptions } from './session';
import { initWorkspace, loadWorkspace, handleCommand } from './commands';
import { registerSessionServers } from '../utils/mcpRegistry';
import { config, saveSession } from '../config/index';
import { selectSessionMcpServers } from '../utils/mcpConfig';
import { handleMcpSamplingRequest } from '../utils/mcpSamplingBridge';
import type { ToolCall } from '../utils/tools';
import type { McpServer } from './protocol';

vi.mock('./session.js', () => ({ runAgentSession: vi.fn() }));
vi.mock('./commands.js', () => ({
  initWorkspace: vi.fn(),
  loadWorkspace: vi.fn(),
  handleCommand: vi.fn(),
}));
vi.mock('../utils/mcpRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/mcpRegistry.js')>();
  return {
    ...actual,
    registerSessionServers: vi.fn(async () => ({ registered: [], errors: [] })),
    disposeAllSessions: vi.fn(async () => {}),
    disposeSession: vi.fn(async () => {}),
  };
});
vi.mock('../utils/mcpConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/mcpConfig.js')>();
  return {
    ...actual,
    selectSessionMcpServers: vi.fn((_root: string, opts: { fromClient?: McpServer[] } = {}) => ({
      servers: [{ name: 'user-server', command: 'true' }, ...(opts.fromClient ?? [])],
      skipped: [],
    })),
  };
});
vi.mock('../utils/codeepCloud.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/codeepCloud.js')>();
  return { ...actual, reportStats: vi.fn(), syncSession: vi.fn(), pullPersonalities: vi.fn() };
});
vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/index.js')>();
  return { ...actual, saveSession: vi.fn(() => true), autoSaveSession: vi.fn(() => true) };
});
vi.mock('../utils/project.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/project.js')>();
  return { ...actual, getProjectContext: vi.fn(() => null) };
});
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, isGitRepository: vi.fn(() => false) };
});

type Frame = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};
type Reply = { result: unknown } | { error: { code: number; message: string } } | 'hang';

/** The editor side of the connection, in memory. */
class FakeClient extends StdioTransport {
  /** Everything the server wrote, in order. */
  out: Frame[] = [];
  answers: Record<string, (params: Record<string, any>) => Reply> = {};
  override start(handler: Parameters<StdioTransport['start']>[0]): void {
    this.handler = handler;
  }
  protected override write(line: string): void {
    const msg = JSON.parse(line) as Frame;
    this.out.push(msg);
    const answer = msg.method && msg.id !== undefined ? this.answers[msg.method] : undefined;
    if (!answer) return;
    const reply = answer(msg.params ?? {});
    if (reply !== 'hang') this.reply(msg.id!, reply);
  }
  /** Client → server frame. */
  send_(msg: Omit<Frame, 'jsonrpc'>): void {
    this.onData(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }
  reply(id: number | string, reply: { result: unknown } | { error: { code: number; message: string } }): void {
    queueMicrotask(() => this.onData(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\n'));
  }
  responseTo(id: number | string): Frame | undefined {
    return this.out.find((f) => f.id === id && f.method === undefined);
  }
  async waitForResponse(id: number | string): Promise<Frame> {
    await vi.waitFor(() => expect(this.responseTo(id)).toBeDefined());
    return this.responseTo(id)!;
  }
  requests(method: string): Frame[] {
    return this.out.filter((f) => f.method === method && f.id !== undefined);
  }
  updates(sessionUpdate: string): Frame[] {
    return this.out.filter((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === sessionUpdate);
  }
}

const OLD_HISTORY = [
  { role: 'user' as const, content: 'OLD question' },
  { role: 'assistant' as const, content: 'OLD answer' },
];

let ws: string;
let client: FakeClient;
let nextId = 1;
const listenersBefore = new Map<string, Function[]>();

function prompt(sessionId: string, text: string): number {
  const id = nextId++;
  client.send_({ id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } });
  return id;
}

async function newSession(): Promise<string> {
  const id = nextId++;
  client.send_({ id, method: 'session/new', params: { cwd: ws } });
  return (await client.waitForResponse(id)).result.sessionId;
}

/** A runAgentSession stand-in that stays open until told to finish. */
function deferredRuns() {
  const runs: { opts: AgentSessionOptions; finish: () => void }[] = [];
  vi.mocked(runAgentSession).mockImplementation((opts) => new Promise<void>((resolve, reject) => {
    runs.push({ opts, finish: resolve });
    opts.abortSignal.addEventListener('abort', () => {
      const err = new Error('Agent session was cancelled');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  return runs;
}

beforeEach(() => {
  process.env.CODEEP_ACP_COMMANDS_DELAY_MS = '0';
  for (const event of ['SIGINT', 'SIGTERM']) listenersBefore.set(event, process.listeners(event as NodeJS.Signals));
  listenersBefore.set('stdin-end', process.stdin.listeners('end') as Function[]);
  ws = mkdtempSync(join(tmpdir(), 'codeep-acp-session-'));
  config.set('autoSave', true);
  config.set('autoSessionTitle', false);
  config.set('currentSessionId', 'someone-elses-session');
  vi.mocked(initWorkspace).mockReset().mockReturnValue({ codeepSessionId: 'new-N1', history: [], welcomeText: 'welcome' });
  vi.mocked(loadWorkspace).mockReset().mockReturnValue({ codeepSessionId: 'old-S0', history: [...OLD_HISTORY], welcomeText: 'Session restored: old-S0' });
  vi.mocked(handleCommand).mockReset().mockResolvedValue({ handled: false, response: '' });
  vi.mocked(runAgentSession).mockReset().mockImplementation(async (opts) => { opts.onChunk('answer'); });
  vi.mocked(saveSession).mockClear();
  vi.mocked(registerSessionServers).mockClear();
  vi.mocked(selectSessionMcpServers).mockClear();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  client = new FakeClient();
  void startAcpServer(client);
  client.send_({ id: nextId++, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const event of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    for (const l of process.listeners(event)) {
      if (!listenersBefore.get(event)!.includes(l)) process.removeListener(event, l);
    }
  }
  for (const l of process.stdin.listeners('end')) {
    if (!listenersBefore.get('stdin-end')!.includes(l as Function)) process.stdin.removeListener('end', l as (...args: unknown[]) => void);
  }
  rmSync(ws, { recursive: true, force: true });
});

// ─── Advertised commands ────────────────────────────────────────────────────

describe('advertised slash commands', () => {
  it('describe /review as it behaves now', async () => {
    await newSession();
    await vi.waitFor(() => expect(client.updates('available_commands_update')).toHaveLength(1));
    const review = client.updates('available_commands_update')[0].params!.update.availableCommands
      .find((c: { name: string }) => c.name === 'review');
    expect(review).toEqual({
      name: 'review',
      description: 'AI review of git changes (--staged), or static analysis (--static / files)',
      input: { hint: '[--staged | --static | file…]' },
    });
  });
});

// ─── Saving history ───────────────────────────────────────────────────────────

describe('saving a session after a turn', () => {
  it('saves a reopened session under its own id, not the current-session id', async () => {
    await newSession();
    const loadId = nextId++;
    client.send_({ id: loadId, method: 'session/load', params: { sessionId: 'old-S0', cwd: ws } });
    const loaded = (await client.waitForResponse(loadId)).result;
    const sessionId = loaded.sessionId ?? 'old-S0';

    const id = prompt(sessionId, 'follow-up in reopened S0');
    expect((await client.waitForResponse(id)).result).toEqual({ stopReason: 'end_turn' });

    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSession).toHaveBeenCalledWith('old-S0', [
      ...OLD_HISTORY,
      { role: 'user', content: 'follow-up in reopened S0' },
      { role: 'assistant', content: 'answer' },
    ], ws);
  });

  it('saves a new session under the id it was started with', async () => {
    const sessionId = await newSession();
    const id = prompt(sessionId, 'hello');
    await client.waitForResponse(id);
    expect(saveSession).toHaveBeenCalledWith('new-N1', expect.any(Array), ws);
  });

  it('continues a conversation another thread already has open under a new name', async () => {
    // Both threads resume the same saved conversation.
    vi.mocked(initWorkspace).mockImplementation(() => ({ codeepSessionId: 'shared-S1', history: [...OLD_HISTORY], welcomeText: 'welcome' }));
    const a = await newSession();
    const b = await newSession();
    await client.waitForResponse(prompt(a, 'from A'));
    await client.waitForResponse(prompt(b, 'from B'));
    const ids = vi.mocked(saveSession).mock.calls.map((c) => c[0]);
    expect(ids[0]).toBe('shared-S1');
    expect(ids[1]).not.toBe('shared-S1');
    expect(vi.mocked(saveSession).mock.calls[1][1]).toContainEqual({ role: 'user', content: 'from B' });
    expect(vi.mocked(saveSession).mock.calls[1][1]).not.toContainEqual({ role: 'user', content: 'from A' });
  });

  it('files a turn that ends after /session new into the conversation it started in', async () => {
    const runs = deferredRuns();
    const sessionId = await newSession();
    const running = prompt(sessionId, 'long task');
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    // The thread moves to a new conversation while the run is still going.
    vi.mocked(handleCommand).mockImplementationOnce(async (_input, session) => {
      session.codeepSessionId = 'new-N2';
      session.history = [];
      session.conversation = (session.conversation ?? 0) + 1;
      return { handled: true, response: 'New session started' };
    });
    await client.waitForResponse(prompt(sessionId, '/session new'));

    runs[0].opts.onChunk('done with the long task');
    runs[0].finish();
    await client.waitForResponse(running);

    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSession).toHaveBeenCalledWith('new-N1', [
      { role: 'user', content: 'long task' },
      { role: 'assistant', content: 'done with the long task' },
    ], ws);

    // The new conversation starts clean.
    const next = prompt(sessionId, 'first in N2');
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1].finish();
    await client.waitForResponse(next);
    expect(vi.mocked(saveSession).mock.calls[1][0]).toBe('new-N2');
    expect(vi.mocked(saveSession).mock.calls[1][1]).not.toContainEqual({ role: 'user', content: 'long task' });
  });

  it('does not save when autosave is off', async () => {
    config.set('autoSave', false);
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, 'hello'));
    expect(saveSession).not.toHaveBeenCalled();
  });
});

// ─── Loading keeps the requested id ──────────────────────────────────────────

describe('cold session/load and session/resume', () => {
  it('registers a loaded session under the id the client asked for', async () => {
    const loadId = nextId++;
    client.send_({ id: loadId, method: 'session/load', params: { sessionId: 'old-S0', cwd: ws } });
    const res = await client.waitForResponse(loadId);
    expect(res.error).toBeUndefined();
    expect(res.result.sessionId ?? 'old-S0').toBe('old-S0');

    // Every update for the loaded session carries that same id.
    await vi.waitFor(() => expect(client.updates('available_commands_update')).toHaveLength(1));
    expect(client.updates('available_commands_update')[0].params!.sessionId).toBe('old-S0');
    expect(client.updates('agent_message_chunk').map((f) => f.params!.sessionId)).toEqual(['old-S0']);
    expect(vi.mocked(registerSessionServers).mock.calls[0][0]).toBe('old-S0');

    // A client that keeps using the id it loaded can prompt with it.
    const id = prompt('old-S0', 'continue');
    expect((await client.waitForResponse(id)).result).toEqual({ stopReason: 'end_turn' });
  });

  it('replays the history again when a session already in memory is loaded again', async () => {
    const first = nextId++;
    client.send_({ id: first, method: 'session/load', params: { sessionId: 'old-S0', cwd: ws } });
    expect((await client.waitForResponse(first)).result.history).toEqual(OLD_HISTORY);
    await client.waitForResponse(prompt('old-S0', 'more'));

    // The VS Code extension clears the chat and shows what a load returns.
    const again = nextId++;
    client.send_({ id: again, method: 'session/load', params: { sessionId: 'old-S0', cwd: ws } });
    const res = (await client.waitForResponse(again)).result;
    expect(res.sessionId).toBe('old-S0');
    expect(res.history).toEqual([
      ...OLD_HISTORY,
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('registers a resumed session under the id the client asked for', async () => {
    const resumeId = nextId++;
    client.send_({ id: resumeId, method: 'session/resume', params: { sessionId: 'old-S0', cwd: ws } });
    const res = await client.waitForResponse(resumeId);
    expect(res.result.sessionId).toBe('old-S0');
    await vi.waitFor(() => expect(client.updates('available_commands_update')).toHaveLength(1));
    expect(client.updates('available_commands_update')[0].params!.sessionId).toBe('old-S0');

    const id = prompt('old-S0', 'continue');
    expect((await client.waitForResponse(id)).result).toEqual({ stopReason: 'end_turn' });
  });
});

// ─── Cancelling ──────────────────────────────────────────────────────────────

describe('session/cancel', () => {
  it('still cancels the running prompt after an earlier overlapping prompt finished', async () => {
    const runs = deferredRuns();
    const sessionId = await newSession();
    const a = prompt(sessionId, 'A');
    const b = prompt(sessionId, 'B');
    await vi.waitFor(() => expect(runs).toHaveLength(2));

    runs[0].finish();
    expect((await client.waitForResponse(a)).result).toEqual({ stopReason: 'end_turn' });

    client.send_({ method: 'session/cancel', params: { sessionId } });
    expect(runs[1].opts.abortSignal.aborted).toBe(true);
    expect((await client.waitForResponse(b)).result).toEqual({ stopReason: 'cancelled' });
  });

  it('cancels every prompt running in the session', async () => {
    const runs = deferredRuns();
    const sessionId = await newSession();
    const a = prompt(sessionId, 'A');
    const b = prompt(sessionId, 'B');
    await vi.waitFor(() => expect(runs).toHaveLength(2));

    client.send_({ method: 'session/cancel', params: { sessionId } });
    expect(runs.map((r) => r.opts.abortSignal.aborted)).toEqual([true, true]);
    expect((await client.waitForResponse(a)).result).toEqual({ stopReason: 'cancelled' });
    expect((await client.waitForResponse(b)).result).toEqual({ stopReason: 'cancelled' });
  });

  it('does not cancel the next prompt when an earlier one already ended', async () => {
    const runs = deferredRuns();
    const sessionId = await newSession();
    const a = prompt(sessionId, 'A');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0].finish();
    await client.waitForResponse(a);

    const b = prompt(sessionId, 'B');
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1].opts.abortSignal.aborted).toBe(false);
    runs[1].finish();
    expect((await client.waitForResponse(b)).result).toEqual({ stopReason: 'end_turn' });
  });

  it('answers a slash command that stops with an AbortError as cancelled, not as an error', async () => {
    vi.mocked(handleCommand).mockImplementation((_input, _session, _onChunk, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const sessionId = await newSession();
    const id = prompt(sessionId, '/review --staged');
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalled());
    client.send_({ method: 'session/cancel', params: { sessionId } });
    const res = await client.waitForResponse(id);
    expect(res.result).toEqual({ stopReason: 'cancelled' });
    expect(res.error).toBeUndefined();
  });

  it('answers a cancelled slash command as cancelled even when it fails another way', async () => {
    vi.mocked(handleCommand).mockImplementation((_input, _session, _onChunk, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('socket hang up')));
    }));
    const sessionId = await newSession();
    const id = prompt(sessionId, '/diff');
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalled());
    client.send_({ method: 'session/cancel', params: { sessionId } });
    const res = await client.waitForResponse(id);
    expect(res.result).toEqual({ stopReason: 'cancelled' });
    expect(res.error).toBeUndefined();
  });

  it('answers a prompt cancelled as its run was finishing as cancelled', async () => {
    let finish!: () => void;
    vi.mocked(runAgentSession).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const sessionId = await newSession();
    const id = prompt(sessionId, 'almost done');
    await vi.waitFor(() => expect(runAgentSession).toHaveBeenCalled());
    client.send_({ method: 'session/cancel', params: { sessionId } });
    finish();
    expect((await client.waitForResponse(id)).result).toEqual({ stopReason: 'cancelled' });
  });

  it('answers a cancelled prompt as cancelled even when the run fails another way', async () => {
    vi.mocked(runAgentSession).mockImplementation((opts) => new Promise((_resolve, reject) => {
      opts.abortSignal.addEventListener('abort', () => reject(new Error('socket hang up')));
    }));
    const sessionId = await newSession();
    const id = prompt(sessionId, 'long task');
    await vi.waitFor(() => expect(runAgentSession).toHaveBeenCalled());
    client.send_({ method: 'session/cancel', params: { sessionId } });
    const res = await client.waitForResponse(id);
    expect(res.result).toEqual({ stopReason: 'cancelled' });
    expect(res.error).toBeUndefined();
  });

  it('kills a command running locally when the client has no terminal', async () => {
    let outcome: unknown;
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcome = await opts.onExecuteCommand!('sleep', ['12'], ws);
    });
    const sessionId = await newSession();
    const started = Date.now();
    const id = prompt(sessionId, 'run it');
    await vi.waitFor(() => expect(runAgentSession).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 150));
    client.send_({ method: 'session/cancel', params: { sessionId } });
    await client.waitForResponse(id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toEqual({ stdout: '', stderr: 'Command cancelled', exitCode: -1 });
  });

  it('kills a command running in the client terminal', async () => {
    const init = nextId++;
    client.send_({ id: init, method: 'initialize', params: { clientCapabilities: { terminal: true } } });
    client.answers['terminal/create'] = () => ({ result: { terminalId: 't-9' } });
    client.answers['terminal/wait_for_exit'] = () => 'hang';
    client.answers['terminal/kill'] = () => ({ result: {} });
    client.answers['terminal/release'] = () => ({ result: {} });
    let outcome: unknown;
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcome = await opts.onExecuteCommand!('sleep', ['12'], ws);
    });
    const sessionId = await newSession();
    const id = prompt(sessionId, 'run it');
    await vi.waitFor(() => expect(client.requests('terminal/wait_for_exit')).toHaveLength(1));

    client.send_({ method: 'session/cancel', params: { sessionId } });
    await client.waitForResponse(id);
    expect(outcome).toEqual({ stdout: '', stderr: 'Command cancelled', exitCode: -1 });
    expect(client.requests('terminal/kill')[0].params).toEqual({ sessionId, terminalId: 't-9' });
  });
});

// ─── Client-side tools wired into the agent ─────────────────────────────────

describe('client capabilities passed to the agent', () => {
  it('validates a command before sending it to the client terminal', async () => {
    client.send_({ id: nextId++, method: 'initialize', params: { clientCapabilities: { terminal: true } } });
    client.answers['terminal/create'] = () => ({ result: { terminalId: 't-1' } });
    let outcome: { exitCode: number; stderr: string } | undefined;
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcome = await opts.onExecuteCommand!('bash', ['-c', 'printenv > leaked.txt'], ws);
    });
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, 'go'));
    expect(outcome!.exitCode).toBe(-1);
    expect(outcome!.stderr).toContain('not in the allowed list');
    expect(client.requests('terminal/create')).toEqual([]);
  });

  it('fails the write when the client refuses fs/write_text_file', async () => {
    client.send_({ id: nextId++, method: 'initialize', params: { clientCapabilities: { fs: { writeTextFile: true } } } });
    client.answers['fs/write_text_file'] = () => ({ error: { code: -32603, message: 'Buffer is read-only' } });
    let writeError: unknown;
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      writeError = await opts.fs!.writeTextFile!(join(ws, 'hello.txt'), 'hi').then(() => 'no error', (err) => err);
    });
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, 'write it'));
    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toContain('Buffer is read-only');
  });
});

// ─── Permission requests ─────────────────────────────────────────────────────

describe('permission requests in manual mode', () => {
  const toolCall: ToolCall = { tool: 'write_file', parameters: { path: 'perm.txt', content: 'x' } };

  async function manualSession(): Promise<string> {
    const sessionId = await newSession();
    const id = nextId++;
    client.send_({ id, method: 'session/set_mode', params: { sessionId, modeId: 'manual' } });
    await client.waitForResponse(id);
    return sessionId;
  }

  it('waits for the user however long they take', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcomes: unknown[] = [];
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcomes.push(await opts.onRequestPermission!(toolCall));
    });
    const sessionId = await manualSession();
    const id = prompt(sessionId, 'write perm.txt');
    await vi.waitFor(() => expect(client.requests('session/request_permission')).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(outcomes).toEqual([]);
    expect(client.responseTo(id)).toBeUndefined();

    const request = client.requests('session/request_permission')[0];
    client.reply(request.id!, { result: { outcome: { type: 'selected', optionId: 'allow_once' } } });
    await client.waitForResponse(id);
    expect(outcomes).toEqual(['allow_once']);
    // The answer was consumed, not treated as a request.
    expect(client.out.filter((f) => f.id === request.id && f.error)).toEqual([]);
  });

  it('denies when the prompt is cancelled while the dialog is open', async () => {
    const outcomes: unknown[] = [];
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcomes.push(await opts.onRequestPermission!(toolCall));
    });
    const sessionId = await manualSession();
    const id = prompt(sessionId, 'write perm.txt');
    await vi.waitFor(() => expect(client.requests('session/request_permission')).toHaveLength(1));

    client.send_({ method: 'session/cancel', params: { sessionId } });
    await client.waitForResponse(id);
    expect(outcomes).toEqual(['reject_once']);
  });

  it('denies when the client answers without an outcome', async () => {
    client.answers['session/request_permission'] = () => ({ result: {} });
    const outcomes: unknown[] = [];
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcomes.push(await opts.onRequestPermission!(toolCall));
    });
    const sessionId = await manualSession();
    const res = await client.waitForResponse(prompt(sessionId, 'write'));
    expect(res.result).toEqual({ stopReason: 'end_turn' });
    expect(outcomes).toEqual(['reject_once']);
  });

  it('says no to a confirm step when the client answers without an outcome', async () => {
    client.answers['session/request_permission'] = () => ({ result: { outcome: null } });
    const answers: boolean[] = [];
    vi.mocked(handleCommand).mockImplementation(async (_input, _session, _onChunk, _signal, run) => {
      answers.push(await run!.confirm!('Deploy to production?'));
      return { handled: true, response: '' };
    });
    const sessionId = await manualSession();
    const res = await client.waitForResponse(prompt(sessionId, '/deploy'));
    expect(res.result).toEqual({ stopReason: 'end_turn' });
    expect(answers).toEqual([false]);
  });

  it('denies when the client answers the request with an error', async () => {
    client.answers['session/request_permission'] = () => ({ error: { code: -32601, message: 'Method not found' } });
    const outcomes: unknown[] = [];
    vi.mocked(runAgentSession).mockImplementation(async (opts) => {
      outcomes.push(await opts.onRequestPermission!(toolCall));
    });
    const sessionId = await manualSession();
    expect((await client.waitForResponse(prompt(sessionId, 'write'))).result).toEqual({ stopReason: 'end_turn' });
    expect(outcomes).toEqual(['reject_once']);
  });
});

// ─── Handler failures ────────────────────────────────────────────────────────

describe('a request whose handler fails', () => {
  it('answers session/new with an error when the workspace cannot be set up', async () => {
    vi.mocked(initWorkspace).mockImplementation(() => {
      throw new Error("EACCES: permission denied, mkdir '/ro/.codeep'");
    });
    const id = nextId++;
    client.send_({ id, method: 'session/new', params: { cwd: ws } });
    const res = await client.waitForResponse(id);
    expect(res.error).toEqual({ code: -32603, message: "EACCES: permission denied, mkdir '/ro/.codeep'" });
    // No session came of it, so no MCP servers were started for one.
    expect(registerSessionServers).not.toHaveBeenCalled();
  });

  it('answers session/new without params with an error', async () => {
    const id = nextId++;
    client.send_({ id, method: 'session/new' });
    const res = await client.waitForResponse(id);
    expect(res.error).toEqual({ code: -32602, message: 'cwd is required' });
    expect(initWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ['session/load', { cwd: '/tmp/x' }, 'sessionId is required'],
    ['session/load', { sessionId: 'old-S0' }, 'cwd is required'],
    ['session/resume', { cwd: '/tmp/x' }, 'sessionId is required'],
    ['session/resume', { sessionId: 'old-S0', cwd: 42 }, 'cwd is required'],
  ])('answers %s %j with an invalid-params error', async (method, params, message) => {
    const id = nextId++;
    client.send_({ id, method, params });
    expect((await client.waitForResponse(id)).error).toEqual({ code: -32602, message });
    expect(loadWorkspace).not.toHaveBeenCalled();
    expect(registerSessionServers).not.toHaveBeenCalled();
  });

  it('does not clear the workspace of a loaded session on a warm load without cwd', async () => {
    const sessionId = await newSession();
    const id = nextId++;
    client.send_({ id, method: 'session/load', params: { sessionId } });
    expect((await client.waitForResponse(id)).error?.code).toBe(-32602);
    await client.waitForResponse(prompt(sessionId, 'still here?'));
    expect(vi.mocked(runAgentSession).mock.calls[0][0].workspaceRoot).toBe(ws);
  });

  it('answers session/load with an error when the session cannot be read', async () => {
    vi.mocked(loadWorkspace).mockImplementation(() => { throw new Error('EACCES'); });
    const id = nextId++;
    client.send_({ id, method: 'session/load', params: { sessionId: 'old-S0', cwd: ws } });
    expect((await client.waitForResponse(id)).error).toEqual({ code: -32603, message: 'EACCES' });
  });

  it('answers session/prompt with an error when the prompt fails before the run starts', async () => {
    const sessionId = await newSession();
    const id = nextId++;
    client.send_({ id, method: 'session/prompt', params: { sessionId } }); // no prompt blocks
    expect((await client.waitForResponse(id)).error?.code).toBe(-32603);
  });

  it('starts MCP servers for a session that was set up', async () => {
    const sessionId = await newSession();
    expect(vi.mocked(registerSessionServers).mock.calls.map((c) => c[0])).toEqual([sessionId]);
  });
});

// ─── Earlier turns reach the agent ───────────────────────────────────────────

describe('conversation history passed to the agent', () => {
  it('gives the agent the turns of a reopened session', async () => {
    const loadId = nextId++;
    client.send_({ id: loadId, method: 'session/load', params: { sessionId: 'old-S0', cwd: ws } });
    await client.waitForResponse(loadId);
    await client.waitForResponse(prompt('old-S0', 'what did I ask before?'));
    expect(vi.mocked(runAgentSession).mock.calls[0][0].chatHistory).toEqual(OLD_HISTORY);
  });

  it('gives the agent the earlier turns only, not the prompt it is answering', async () => {
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, 'first'));
    await client.waitForResponse(prompt(sessionId, 'second'));
    const calls = vi.mocked(runAgentSession).mock.calls;
    expect(calls[0][0].chatHistory).toEqual([]);
    expect(calls[1][0].chatHistory).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ]);
  });
});

// ─── Slash commands run the agent like a prompt ─────────────────────────────

describe('run options handed to slash commands', () => {
  async function setMode(sessionId: string, modeId: string): Promise<void> {
    const id = nextId++;
    client.send_({ id, method: 'session/set_mode', params: { sessionId, modeId } });
    await client.waitForResponse(id);
  }

  function lastRunOptions() {
    const calls = vi.mocked(handleCommand).mock.calls;
    return calls[calls.length - 1][4]!;
  }

  it('carries manual mode\'s permission prompts', async () => {
    const sessionId = await newSession();
    await setMode(sessionId, 'manual');
    await client.waitForResponse(prompt(sessionId, '/go'));
    const run = lastRunOptions();
    expect(run.onRequestPermission).toBeTypeOf('function');
    expect(run.confirm).toBeTypeOf('function');
    expect(run.extraDangerousTools).toEqual(['write_file', 'edit_file']);
    expect(run.onExecuteCommand).toBeTypeOf('function');
    expect(run.fs).toBeDefined();
  });

  it('carries the same options the agent gets for a plain prompt', async () => {
    const sessionId = await newSession();
    await setMode(sessionId, 'manual');
    await client.waitForResponse(prompt(sessionId, 'plain prompt'));
    const run = lastRunOptions();
    const agentOpts = vi.mocked(runAgentSession).mock.calls[0][0];
    expect(agentOpts.onRequestPermission).toBe(run.onRequestPermission);
    expect(agentOpts.extraDangerousTools).toBe(run.extraDangerousTools);
    expect(agentOpts.onExecuteCommand).toBe(run.onExecuteCommand);
    expect(agentOpts.fs).toBe(run.fs);
  });

  it('asks nothing in auto mode', async () => {
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, '/go'));
    const run = lastRunOptions();
    expect(run.onRequestPermission).toBeUndefined();
    expect(run.confirm).toBeUndefined();
    expect(run.extraDangerousTools).toBeUndefined();
    expect(run.onExecuteCommand).toBeTypeOf('function');
  });

  it('asks a skill confirm step through the client and takes the answer', async () => {
    const answers: boolean[] = [];
    vi.mocked(handleCommand).mockImplementation(async (_input, _session, _onChunk, _signal, run) => {
      answers.push(await run!.confirm!('Deploy to production?'));
      answers.push(await run!.confirm!('Deploy to production?'));
      answers.push(await run!.confirm!('Deploy to production?'));
      return { handled: true, response: '' };
    });
    const replies = [
      { result: { outcome: { type: 'selected', optionId: 'allow_once' } } },
      { result: { outcome: { type: 'selected', optionId: 'reject_once' } } },
      { error: { code: -32601, message: 'Method not found' } },
    ];
    client.answers['session/request_permission'] = () => replies.shift()!;
    const sessionId = await newSession();
    await setMode(sessionId, 'manual');
    await client.waitForResponse(prompt(sessionId, '/deploy'));

    expect(answers).toEqual([true, false, false]);
    const asked = client.requests('session/request_permission');
    expect(asked).toHaveLength(3);
    expect(asked[0].params!.toolCall.toolInput).toEqual({ question: 'Deploy to production?' });
    expect(asked[0].params!.options.map((o: { optionId: string }) => o.optionId)).toEqual(['allow_once', 'reject_once']);
  });

  it('reports a command cancelled part way as cancelled', async () => {
    vi.mocked(handleCommand).mockImplementation((_input, _session, _onChunk, signal) => new Promise((resolve) => {
      signal!.addEventListener('abort', () => resolve({ handled: true, response: '_Plan execution cancelled._' }));
    }));
    const sessionId = await newSession();
    const id = prompt(sessionId, '/go');
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalled());
    client.send_({ method: 'session/cancel', params: { sessionId } });
    expect((await client.waitForResponse(id)).result).toEqual({ stopReason: 'cancelled' });
  });

  it('reports a command that finished as end_turn', async () => {
    vi.mocked(handleCommand).mockResolvedValue({ handled: true, response: 'done' });
    const sessionId = await newSession();
    expect((await client.waitForResponse(prompt(sessionId, '/status'))).result).toEqual({ stopReason: 'end_turn' });
  });
});

// ─── Real slash commands against the server's session ───────────────────────

describe('slash commands that change the session', () => {
  const WORK = [
    { role: 'user' as const, content: 'OLD-WORK question' },
    { role: 'assistant' as const, content: 'OLD-WORK answer' },
  ];

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('./commands')>('./commands');
    vi.mocked(handleCommand).mockImplementation(actual.handleCommand);
  });

  it('/session load: later turns are saved to the loaded session and the agent sees it', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ws, 'package.json'), '{}');
    const realConfig = await vi.importActual<typeof import('../config/index')>('../config/index');
    expect(realConfig.saveSession('old-work', WORK, ws)).toBe(true);

    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, '/session load old-work'));
    await client.waitForResponse(prompt(sessionId, 'continue old work'));

    expect(vi.mocked(runAgentSession).mock.calls[0][0].chatHistory).toEqual(WORK);
    expect(saveSession).toHaveBeenLastCalledWith('old-work', [
      ...WORK,
      { role: 'user', content: 'continue old work' },
      { role: 'assistant', content: 'answer' },
    ], ws);
  });

  it('/save <name>: later turns are saved under the new name', async () => {
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, 'hello'));
    await client.waitForResponse(prompt(sessionId, '/save renamed'));
    await client.waitForResponse(prompt(sessionId, 'hello again'));
    expect(vi.mocked(saveSession).mock.calls.map((c) => c[0])).toEqual(['new-N1', 'renamed', 'renamed']);
  });

  it('/mcp reload keeps the servers the client passed and the sampling bridge', async () => {
    const zed = { name: 'zed-server', command: 'zed-mcp', args: [] };
    const id = nextId++;
    client.send_({ id, method: 'session/new', params: { cwd: ws, mcpServers: [zed] } });
    const sessionId = (await client.waitForResponse(id)).result.sessionId;
    await client.waitForResponse(prompt(sessionId, '/mcp reload'));

    const calls = vi.mocked(registerSessionServers).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(sessionId);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[1][1]).toContainEqual(zed);
    expect(calls[1][2]).toEqual({ workspaceRoot: ws, onSamplingRequest: handleMcpSamplingRequest });
    expect(vi.mocked(selectSessionMcpServers).mock.calls[1]).toEqual([ws, { fromClient: [zed], userAdded: undefined }]);
  });

  it.each(['session/load', 'session/resume'])('/mcp reload after a cold %s keeps the servers the client passed', async (method) => {
    const zed = { name: 'zed-cold', command: 'zed-mcp', args: [] };
    const id = nextId++;
    client.send_({ id, method, params: { sessionId: 'old-S0', cwd: ws, mcpServers: [zed] } });
    await client.waitForResponse(id);
    await client.waitForResponse(prompt('old-S0', '/mcp reload'));
    const calls = vi.mocked(registerSessionServers).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[0])).toEqual(['old-S0', 'old-S0']);
    expect(calls[1][1]).toContainEqual(zed);
  });

  it.each(['session/load', 'session/resume'])('a warm %s without servers restarts the ones the client passed before', async (method) => {
    const zed = { name: 'zed-first', command: 'zed-mcp', args: [] };
    const newId = nextId++;
    client.send_({ id: newId, method: 'session/new', params: { cwd: ws, mcpServers: [zed] } });
    const sessionId = (await client.waitForResponse(newId)).result.sessionId;

    const id = nextId++;
    client.send_({ id, method, params: { sessionId, cwd: ws } });
    await client.waitForResponse(id);
    const calls = vi.mocked(registerSessionServers).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(sessionId);
    expect(calls[1][1]).toContainEqual(zed);

    // …and they stay the session's servers.
    await client.waitForResponse(prompt(sessionId, '/mcp reload'));
    expect(calls[2][1]).toContainEqual(zed);
  });

  it.each(['session/load', 'session/resume'])('a warm %s with servers replaces the ones passed before', async (method) => {
    const first = { name: 'zed-first', command: 'zed-mcp', args: [] };
    const second = { name: 'zed-second', command: 'zed-mcp', args: [] };
    const newId = nextId++;
    client.send_({ id: newId, method: 'session/new', params: { cwd: ws, mcpServers: [first] } });
    const sessionId = (await client.waitForResponse(newId)).result.sessionId;

    const id = nextId++;
    client.send_({ id, method, params: { sessionId, cwd: ws, mcpServers: [second] } });
    await client.waitForResponse(id);
    const calls = vi.mocked(registerSessionServers).mock.calls;
    expect(calls[1][1]).toContainEqual(second);
    expect(calls[1][1]).not.toContainEqual(first);
  });

  it('/mcp reload after session/load uses the servers the client passed on load', async () => {
    const sessionId = await newSession();
    const zed = { name: 'zed-on-load', command: 'zed-mcp', args: [] };
    const loadId = nextId++;
    client.send_({ id: loadId, method: 'session/load', params: { sessionId, cwd: ws, mcpServers: [zed] } });
    await client.waitForResponse(loadId);
    await client.waitForResponse(prompt(sessionId, '/mcp reload'));
    const calls = vi.mocked(registerSessionServers).mock.calls;
    expect(calls[calls.length - 1][1]).toContainEqual(zed);
  });
});
