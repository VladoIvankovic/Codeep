/**
 * Session lifecycle through the running ACP server: `startAcpServer()` is
 * given a transport whose stdio is replaced by an in-memory client, and the
 * agent loop, workspace setup, MCP spawning and cloud reporting are mocked.
 * What is real: the server's dispatch, its session map, and the transport's
 * request/response handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { StdioTransport } from './transport';
import { startAcpServer, executeAcpCommand } from './server';
import { runAgentSession, type AgentSessionOptions } from './session';
import { initWorkspace, loadWorkspace, handleCommand } from './commands';
import { registerSessionServers } from '../utils/mcpRegistry';
import { config, saveSession } from '../config/index';
import { selectSessionMcpServers } from '../utils/mcpConfig';
import { handleMcpSamplingRequest } from '../utils/mcpSamplingBridge';
import type { ToolCall } from '../utils/tools';
import type { PermissionOutcome } from '../utils/agent';
import type { TrustBearingWrite } from '../utils/toolExecution';
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

  it('carries the auto-mode answer under its own key, so /go can still be asked about one file', async () => {
    client.answers['session/request_permission'] = () => ({ result: { outcome: { type: 'selected', optionId: 'allow_once' } } });
    const sessionId = await newSession();
    await client.waitForResponse(prompt(sessionId, '/go'));
    const run = lastRunOptions();

    // NOT on onRequestPermission: acp/commands.ts reads that key being set as
    // "this session asks the user" and would start gating a skill's shell
    // lines in the mode that promises not to.
    expect(run.onRequestPermission).toBeUndefined();
    expect(run.onAutoModePermission).toBeTypeOf('function');

    // And it is the same one prompt a plain prompt gets: without it, /go
    // could only refuse the write.
    const answer = await run.onAutoModePermission!({ tool: 'write_file', parameters: { path: '.git/config', content: '[core]' } });
    expect(answer).toBe('allow_once');
    expect(client.requests('session/request_permission')).toHaveLength(1);
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

// ─── Writes that decide what runs later ─────────────────────────────────────

describe('the permission prompt for a file that decides what runs later', () => {
  const gitConfig: ToolCall = { tool: 'write_file', parameters: { path: '.git/config', content: '[core]\n\tfsmonitor = "touch MARK; false"\n' } };
  const ordinary: ToolCall = { tool: 'write_file', parameters: { path: 'src/app.ts', content: 'export const x = 1;' } };

  /**
   * Put a tool call to the callback the agent runs with in this mode.
   *
   * Every call starts its own session, so it reads the LAST run's options and
   * only the dialogs its own call put up — a test that drives two sessions
   * would otherwise answer with the first session's callback and count the
   * first session's prompts.
   */
  async function askAbout(modeId: 'auto' | 'manual', toolCall: ToolCall) {
    client.answers['session/request_permission'] = () => ({ result: { outcome: { type: 'selected', optionId: 'allow_once' } } });
    const before = client.requests('session/request_permission').length;
    const sessionId = await newSession();
    if (modeId === 'manual') {
      const id = nextId++;
      client.send_({ id, method: 'session/set_mode', params: { sessionId, modeId } });
      await client.waitForResponse(id);
    }
    await client.waitForResponse(prompt(sessionId, 'do it'));
    const agentOpts = vi.mocked(runAgentSession).mock.lastCall![0];
    const answer = await agentOpts.onRequestPermission!(toolCall);
    return { answer, asked: client.requests('session/request_permission').slice(before) };
  }

  it('asks in auto mode, which asks about nothing else', async () => {
    const git = await askAbout('auto', gitConfig);
    expect(git.asked).toHaveLength(1);
    expect(git.asked[0].params!.toolCall.toolInput.warning).toMatch(/what commands git runs/);
    expect(git.answer).toBe('allow_once');
  });

  it('answers for auto mode without asking about anything else', async () => {
    const plain = await askAbout('auto', ordinary);
    expect(plain.asked).toHaveLength(0);
    expect(plain.answer).toBe('allow_once');
  });

  it('offers no "Allow always" for one of those files', async () => {
    const git = await askAbout('manual', gitConfig);
    expect(git.asked[0].params!.options.map((o: { optionId: string }) => o.optionId))
      .toEqual(['allow_once', 'reject_once', 'reject_always']);
  });

  it('words itself from what the agent gate already worked out', async () => {
    // The gate has already stat'd the path, resolved a symlinked ancestor and
    // possibly asked git where this repository keeps its hooks. It hands that
    // answer over; looking it up again here is that work a second time per
    // dialog, and — because the two lookups are separate — a chance for the
    // dialog to describe a different file than the one being confirmed.
    client.answers['session/request_permission'] = () => ({ result: { outcome: { type: 'selected', optionId: 'allow_once' } } });
    const before = client.requests('session/request_permission').length;
    const sessionId = await newSession();
    const id = nextId++;
    client.send_({ id, method: 'session/set_mode', params: { sessionId, modeId: 'manual' } });
    await client.waitForResponse(id);
    await client.waitForResponse(prompt(sessionId, 'do it'));
    const agentOpts = vi.mocked(runAgentSession).mock.lastCall![0];

    // An ordinary path that the gate says IS trust-bearing — which is what a
    // repository's own `core.hooksPath` makes of `ci/hooks/pre-commit`.
    //
    // Called through the agent's own signature, with no cast: runAgent passes
    // the gate's answer as a second argument and session.ts hands this
    // callback straight to it, and AgentSessionOptions now says so.
    const trustBearing: TrustBearingWrite = {
      path: 'src/app.ts', file: '/elsewhere/src/app.ts', reason: 'This is a git hook.',
    };
    const answer: PermissionOutcome = await agentOpts.onRequestPermission!(ordinary, trustBearing);
    expect(answer).toBe('allow_once');
    const asked = client.requests('session/request_permission').slice(before);
    expect(asked[0].params!.toolCall.toolInput.warning).toBe('This is a git hook.');
    expect(asked[0].params!.options.map((o: { optionId: string }) => o.optionId))
      .toEqual(['allow_once', 'reject_once', 'reject_always']);
  });

  it('offers every answer for an ordinary file', async () => {
    // Two sessions, the auto one first: reading the first run's callback
    // rather than this one's would answer the manual prompt with auto mode's
    // answer, which says yes to an ordinary file without asking anyone.
    await askAbout('auto', ordinary);
    const plain = await askAbout('manual', ordinary);
    expect(plain.asked[0].params!.options.map((o: { optionId: string }) => o.optionId))
      .toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
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

// ─── The environment a command gets in the client's terminal ────────────────

describe('execute_command in the client terminal', () => {
  /**
   * A client that creates a terminal, runs it to completion and hands back no
   * output. Only `request` is reached, so that is all this is.
   */
  function terminalClient() {
    const sent: { method: string; params: Record<string, any> }[] = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      sent.push({ method, params: (params ?? {}) as Record<string, any> });
      if (method === 'terminal/create') return { terminalId: 'term-1' };
      if (method === 'terminal/wait_for_exit') return { exitCode: 0, signal: null };
      if (method === 'terminal/output') return { output: '', truncated: false };
      return {};
    });
    const params = (method: string) => sent.find((f) => f.method === method)?.params;
    return {
      ctx: {
        transport: { request } as unknown as Pick<StdioTransport, 'request'>,
        sessionId: 'sess-term',
        clientSupportsTerminal: true,
        signal: new AbortController().signal,
      },
      methods: () => sent.map((f) => f.method),
      params,
      /** The `env` of the terminal that was created, back in Node's shape. */
      terminalEnv: (): NodeJS.ProcessEnv | undefined => {
        const list = params('terminal/create')?.env as { name: string; value: string }[] | undefined;
        return list && Object.fromEntries(list.map((e) => [e.name, e.value]));
      },
    };
  }

  let repo: string;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codeep-acp-term-'));
    // The fixtures run real git, and git reads whoever's machine this is on.
    // Point it at a file that is not there, for the fixture's own commands and
    // for the scan inside commandEnv, which inherits this process's env.
    process.env.GIT_CONFIG_GLOBAL = join(repo, 'no-such-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = join(repo, 'no-such-gitconfig');
    git('init', '-q');
  });

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    rmSync(repo, { recursive: true, force: true });
  });

  /** A repository whose `core.fsmonitor` is a program that leaves a mark. */
  function repoThatRunsAProgramOnStatus(): string {
    const spy = join(repo, 'spy.sh');
    const mark = join(repo, 'MARK');
    // A real executable, not `touch MARK; false`: git spawns core.fsmonitor
    // directly, with no shell to read that as two commands.
    writeFileSync(spy, `#!/bin/sh\n: > "${mark}"\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(repo, 'a.txt'), 'hi\n');
    git('add', 'a.txt');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    git('config', 'core.fsmonitor', spy);
    return mark;
  }

  const statusRanTheProgram = (
    mark: string,
    env: NodeJS.ProcessEnv,
    args: string[] = ['status', '--porcelain'],
  ): boolean => {
    rmSync(mark, { force: true });
    try {
      execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
    } catch {
      // A hostile fsmonitor makes git exit non-zero; the mark is the answer.
    }
    return existsSync(mark);
  };

  it('hands the terminal an environment the repository cannot run a program through', async () => {
    // `terminal/create` used to carry no environment at all, so the client
    // spawned git with its own — and over ACP, which is how Zed runs Codeep,
    // a `git status` in a hostile repository ran that repository's
    // `core.fsmonitor` exactly as it did before this hotfix.
    const mark = repoThatRunsAProgramOnStatus();
    const client = terminalClient();

    const result = await executeAcpCommand('git', ['status'], repo, client.ctx);
    expect(result.exitCode).toBe(0);

    const env = client.terminalEnv();
    expect(env).toBeDefined();
    // Real git, the real fixture: the control proves the trap is live, and
    // the environment we hand the client is what disarms it.
    expect(statusRanTheProgram(mark, process.env)).toBe(true);
    expect(statusRanTheProgram(mark, env!)).toBe(false);
  });

  it('scans the repository `-C` aims git at, not the one it was spawned in', async () => {
    // shellCommandEnv() can only scan the SPAWN's cwd, so `git -C vendor/lib
    // status` over ACP was hardened against the OUTER project — whose config
    // is spotless — and reached the nested checkout with only the always-on
    // GIT_EXECUTING_CONFIG pairs behind it. `filter.*` is the half those
    // pairs cannot wildcard, so the nested clean filter ran (git 2.54). One
    // argument was the whole difference between this path and the local
    // runner, which has always read `-C` out of the argv.
    const nested = join(repo, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    const inNested = (...a: string[]) => execFileSync('git', a, { cwd: nested, stdio: 'ignore' });
    // A plain nested clone, not a submodule: nothing in `repo/.git` mentions
    // it, so the outer scan has no way to reach it.
    inNested('init', '-q');
    const spy = join(repo, 'spy.sh');
    const mark = join(repo, 'MARK');
    writeFileSync(spy, `#!/bin/sh\n: > "${mark}"\nexit 1\n`, { mode: 0o755 });
    // ARMED, and not only declared. `.gitattributes` is what routes a path at
    // a filter driver, and git runs a `filter.<d>.clean` for the files it
    // routes and for nothing else — so a fixture that set the config key and
    // no attributes file was asserting a refusal without putting the thing
    // that causes one in the repository. It passed only while an unrouted
    // driver was refused as well, which is a decision in utils/git.ts and not
    // one this test gets to rest on.
    //
    // Committed BEFORE the filter is configured, because `git add` runs the
    // clean filter too and would fire the spy while the fixture was still
    // being built. Rewriting the file afterwards is what leaves the index
    // stale, so the `git status` below has to re-clean it.
    writeFileSync(join(nested, '.gitattributes'), '* filter=spy\n');
    writeFileSync(join(nested, 'a.txt'), 'hi\n');
    inNested('add', '.');
    inNested('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    inNested('config', 'filter.spy.clean', spy);
    // Rewritten at the SAME BYTE LENGTH as `hi\n`. git compares stat data
    // before it compares content, and when the size differs it can answer
    // "modified" from the stat alone and never read the file — no read, no
    // clean filter, and the control below then reports a live trap as dead
    // and fails this test as if the hardening had regressed. Whether it takes
    // that shortcut is decided by a second boundary nothing in the fixture
    // can see: git distrusts its own stat data only while the file's mtime is
    // not older than the index's, and the two writes here are milliseconds
    // apart. Measured on git 2.54 — an 8-byte replacement left the filter
    // unrun in 10 of 300 fixtures, and in 15 of 15 once the index is touched
    // a second after the file, which is what those 10 hit. At this length
    // there is no shortcut to take: git has to read the content to answer at
    // all, and the filter ran in 300 of 300 and in 15 of 15.
    writeFileSync(join(nested, 'a.txt'), 'oh\n');

    // Real git, the real fixture: unhardened, `git -C vendor/lib status`
    // really does run the nested repository's clean filter.
    expect(statusRanTheProgram(mark, process.env, ['-C', 'vendor/lib', 'status', '--porcelain'])).toBe(true);
    // And the control on the other side: the same command WITHOUT `-C` is
    // allowed through, because `repo` itself sets nothing to refuse over. So
    // the refusal below is proof of WHICH repository was scanned, rather than
    // of anything ambient in the fixture.
    const outer = terminalClient();
    expect((await executeAcpCommand('git', ['status'], repo, outer.ctx)).exitCode).toBe(0);

    const client = terminalClient();
    const result = await executeAcpCommand('git', ['-C', 'vendor/lib', 'status'], repo, client.ctx);

    expect(result.exitCode).toBe(-1);
    // The refusal names the NESTED path and the NESTED key.
    expect(result.stderr).toContain(nested);
    expect(result.stderr).toContain('filter.spy.clean');
    expect(client.methods()).not.toContain('terminal/create');
  });

  it('sends the hardening\'s own variables and not the shell it inherited', async () => {
    // `env` is not a private channel. It used to be the whole of process.env,
    // and src/acp/transport.ts mirrors every outbound frame verbatim into
    // ~/.cache/codeep/acp-debug.log under CODEEP_ACP_DEBUG — so every API key
    // and session token in the user's shell was written to a plaintext file
    // on disk, and handed to an editor free to log the traffic itself.
    process.env.CODEEP_TEST_FAKE_TOKEN = 'sk-ant-api03-notarealkeyatall0000000000';
    try {
      const client = terminalClient();
      await executeAcpCommand('git', ['status'], repo, client.ctx);

      const created = client.params('terminal/create')!;
      const list = created.env as { name: string; value: string }[];
      expect(list.some((e) => e.name === 'CODEEP_TEST_FAKE_TOKEN')).toBe(false);
      expect(list.every((e) => !e.value.includes('notarealkeyatall'))).toBe(true);
      // And not in the frame at all, under any other name or in any other
      // field: this object is what the transport serialises, so it is also
      // exactly what the debug log mirrors. (What the log does with a frame
      // that DOES carry a secret — one that came out of a command's own
      // output, say — is transport.test.ts's half.)
      expect(JSON.stringify(created)).not.toContain('notarealkeyatall');

      // Nothing beyond the allowlist rides along at all, whatever it is
      // called: an allowlist that grew a wildcard would be no allowlist.
      // Spelled out here rather than imported, because a guard that reads the
      // list it is guarding passes whatever that list becomes.
      const allowed = new RegExp(`^(?:${[
        'GIT_CONFIG_(?:COUNT|KEY_\\d+|VALUE_\\d+|GLOBAL|SYSTEM|NOSYSTEM|PARAMETERS)',
        'GIT_PAGER|GIT_TERMINAL_PROMPT',
        'PATH|HOME|SHELL|USER|LOGNAME',
        'SSH_AUTH_SOCK',
        'TMPDIR|TMP|TEMP',
        'LANG|LANGUAGE|LC_[A-Z]+',
        'TERM|COLORTERM|TERM_PROGRAM|TZ',
        '(?:HTTP|HTTPS|FTP|ALL|NO)_PROXY|(?:http|https|ftp|all|no)_proxy',
        'ASDF_DIR|ASDF_DATA_DIR|NVM_DIR|NVM_BIN|PYENV_ROOT|RBENV_ROOT',
        'SDKMAN_DIR|VOLTA_HOME|PNPM_HOME|BUN_INSTALL',
        'VIRTUAL_ENV|CONDA_PREFIX|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|JAVA_HOME',
      ].join('|')})$`);
      const names = list.map((e) => e.name);
      expect(names.filter((n) => !allowed.test(n))).toEqual([]);
      // Each name once. The list is built from a filter over `env` plus one
      // entry appended by hand, and a duplicate would leave which value the
      // client uses up to the client.
      expect(new Set(names).size).toBe(names.length);

      const env = client.terminalEnv()!;
      // What the terminal does get: the numbered pairs that disarm the repo,
      // all of them — a COUNT that outruns the pairs behind it is a git that
      // fails outright ("missing environment variable"), so the count and the
      // pairs have to arrive together.
      const count = Number(env.GIT_CONFIG_COUNT);
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        expect(env[`GIT_CONFIG_KEY_${i}`], `GIT_CONFIG_KEY_${i}`).toBeDefined();
        expect(env[`GIT_CONFIG_VALUE_${i}`], `GIT_CONFIG_VALUE_${i}`).toBeDefined();
      }
      expect(env.GIT_PAGER).toBe('cat');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      // …the GIT_CONFIG_GLOBAL the scan itself read the config through, so
      // the terminal's git cannot resolve a different global config than the
      // one Codeep just decided was safe…
      expect(env.GIT_CONFIG_GLOBAL).toBe(process.env.GIT_CONFIG_GLOBAL);
      // …a PATH, because a client is free to read `env` as THE environment
      // rather than as additions to its own, and a terminal that got only
      // GIT_CONFIG_* would then be running without one…
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      // …and the empty GIT_CONFIG_PARAMETERS that stands in for the removal
      // this list cannot spell (see the test below for what it is for).
      expect(env.GIT_CONFIG_PARAMETERS).toBe('');
      // And nothing is sent as an unreadable `value: undefined`.
      expect(list.every((e) => typeof e.value === 'string')).toBe(true);
    } finally {
      delete process.env.CODEEP_TEST_FAKE_TOKEN;
    }
  });

  /**
   * The user's shell, for one test.
   *
   * Put back afterwards and not merely deleted: `process.env` is the whole
   * worker's, so an SSH_AUTH_SOCK or a TMPDIR left behind here follows every
   * test after this one — and into the next file the worker picks up.
   */
  function withShellEnv(vars: Record<string, string>): () => void {
    const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
    Object.assign(process.env, vars);
    return () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  }

  it('gives an ordinary command what the user\'s shell gives it', async () => {
    // acpEnvList() filters the environment of EVERY terminal/create and not
    // only of a hardened git spawn, and a client is free to read `env` as THE
    // environment rather than as additions to its own. The first cut of this
    // hotfix sent PATH and HOME and nothing else, so against such a client an
    // `npm test` ran with no agent socket, no locale, no TMPDIR and no proxy
    // — none of them a secret, and all of them things it had in the shell the
    // user started Codeep from.
    const shell = {
      SSH_AUTH_SOCK: join(repo, 'agent.sock'),
      LANG: 'en_US.UTF-8',
      LC_TIME: 'en_US.UTF-8',
      TMPDIR: repo,
      TERM: 'xterm-256color',
      https_proxy: 'http://proxy.test:8080',
      NO_PROXY: 'localhost',
      NVM_DIR: join(repo, '.nvm'),
    };
    const restore = withShellEnv(shell);
    try {
      const client = terminalClient();
      const result = await executeAcpCommand('npm', ['test'], repo, client.ctx);

      expect(result.exitCode).toBe(0);
      const env = client.terminalEnv()!;
      for (const [name, value] of Object.entries(shell)) expect(env[name], name).toBe(value);
    } finally {
      restore();
    }
  });

  it('gives a git terminal those too, and the hardening with them', async () => {
    // The allowlist is not "whatever a hardened `git status` needs": the
    // command that needs SSH_AUTH_SOCK most is a push over SSH, and that is a
    // git command. Without the agent socket git falls back to asking for a
    // password on a terminal whose GIT_TERMINAL_PROMPT the hardening set to
    // `0`, so it fails outright rather than prompting.
    const restore = withShellEnv({ SSH_AUTH_SOCK: join(repo, 'agent.sock'), LANG: 'en_US.UTF-8' });
    try {
      const client = terminalClient();
      await executeAcpCommand('git', ['status'], repo, client.ctx);

      const env = client.terminalEnv()!;
      expect(env.SSH_AUTH_SOCK).toBe(join(repo, 'agent.sock'));
      expect(env.LANG).toBe('en_US.UTF-8');
      // And widening the list cost the hardening nothing: the numbered pairs
      // that do the actual work are still all there, with the count that
      // reaches them.
      const count = Number(env.GIT_CONFIG_COUNT);
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        expect(env[`GIT_CONFIG_KEY_${i}`], `GIT_CONFIG_KEY_${i}`).toBeDefined();
        expect(env[`GIT_CONFIG_VALUE_${i}`], `GIT_CONFIG_VALUE_${i}`).toBeDefined();
      }
      expect(env.GIT_CONFIG_PARAMETERS).toBe('');
    } finally {
      restore();
    }
  });

  it.each<[string, string[]]>([['git', ['status']], ['npm', ['test']]])(
    'keeps the shell\'s credentials out of the %s terminal',
    async (command, args) => {
      // The property the whole list exists for, on BOTH branches — the
      // hardened one and the one that is left alone. It is also why this is
      // an allowlist and not a denylist over names that look like secrets:
      // the last variable below is a password, and nothing in its name says
      // so. Every one of them would otherwise be mirrored verbatim into
      // ~/.cache/codeep/acp-debug.log under CODEEP_ACP_DEBUG and handed to an
      // editor that is free to log the traffic itself.
      const restore = withShellEnv({
        ANTHROPIC_API_KEY: 'sk-ant-api03-notarealkeyatall0000000000',
        GITHUB_TOKEN: 'ghp_notarealtokenatall000000000000000',
        AWS_SECRET_ACCESS_KEY: 'notarealsecretatall00000000000000',
        CODEEP_TEST_DATABASE_URL: 'postgres://u:notarealpasswordatall@db/x',
      });
      try {
        const client = terminalClient();
        await executeAcpCommand(command, args, repo, client.ctx);

        const created = client.params('terminal/create')!;
        const names = (created.env as { name: string }[]).map((e) => e.name);
        expect(names).not.toContain('ANTHROPIC_API_KEY');
        expect(names).not.toContain('CODEEP_TEST_DATABASE_URL');
        // And no value of any of them, under any other name or in any other
        // field: this object is what the transport serialises.
        expect(JSON.stringify(created)).not.toContain('notareal');
      } finally {
        restore();
      }
    },
  );

  it('cannot be switched back off by a GIT_CONFIG_PARAMETERS the client already had', async () => {
    // hardenedGitEnv() DELETES this variable, because git reads it after the
    // numbered GIT_CONFIG_* pairs and it beats them. A `terminal/create` env
    // has no way to ask for a removal — an absent name is not an unset — so
    // against a client that extends its own environment with `env` rather
    // than replacing it, one variable the editor happened to inherit turned
    // the whole hardening off. It is sent empty instead, which git reads as
    // no parameters at all.
    const mark = repoThatRunsAProgramOnStatus();
    // The repository's own core.fsmonitor goes back out again, so the only
    // thing left that can run the spy is the environment variable. Otherwise
    // the numbered pair that neutralises the config key would be doing the
    // work below and this would pass without proving anything.
    git('config', '--unset', 'core.fsmonitor');
    const client = terminalClient();

    await executeAcpCommand('git', ['status'], repo, client.ctx);

    // The client's own environment, with the variable already in it. Real
    // git, and the control first: this is a live trap, not a shape.
    const inherited = { ...process.env, GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${join(repo, 'spy.sh')}'` };
    expect(statusRanTheProgram(mark, inherited)).toBe(true);
    // And the reading this has to survive: the client's environment with
    // `env` laid over it. Nothing in that list neutralises this but the empty
    // GIT_CONFIG_PARAMETERS — the always-on `core.fsmonitor=false` pair is
    // sitting right there and loses to it (git 2.54).
    expect(statusRanTheProgram(mark, { ...inherited, ...client.terminalEnv() })).toBe(false);
  });

  it('fails the command with git\'s own refusal rather than running it unhardened', async () => {
    // `remote.<name>.uploadpack` names a program git runs on fetch and push,
    // and git keeps the FIRST value it sees — no override reaches it, so
    // hardenedGitEnv can only refuse. Running the command anyway would hand
    // it to a terminal this process has no way to protect.
    git('config', 'remote.origin.uploadpack', 'anything');
    const client = terminalClient();

    const result = await executeAcpCommand('git', ['status'], repo, client.ctx);

    expect(result.exitCode).toBe(-1);
    // Passed through verbatim: it names the key and the `--unset` that clears
    // it, and this message is all the user gets.
    expect(result.stderr).toContain('remote.origin.uploadpack');
    expect(result.stderr).toContain('git config --unset');
    expect(client.methods()).not.toContain('terminal/create');
  });

  it('leaves a command that cannot reach git alone in that same repository', async () => {
    // The refusal is git's, not the repository's: an `npm test` must not stop
    // working because some checkout sets remote.origin.uploadpack.
    git('config', 'remote.origin.uploadpack', 'anything');
    const client = terminalClient();

    const result = await executeAcpCommand('npm', ['test'], repo, client.ctx);

    expect(result.exitCode).toBe(0);
    expect(client.methods()).toContain('terminal/create');
    // And left alone in the environment too: the empty GIT_CONFIG_PARAMETERS
    // stands in for a removal hardenedGitEnv() makes, and hardenedGitEnv()
    // does not run for a command that is not git. Sending it anyway would
    // take a variable off a command Codeep deliberately does not harden.
    expect(client.terminalEnv()).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
  });
});
