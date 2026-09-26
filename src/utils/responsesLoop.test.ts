/**
 * runAgent over the Responses API, end to end: the real loop, the real
 * agentChat, parser and tool execution against a temp project, real config
 * (isolated per worker by vitest.setup.ts). Only the network is scripted —
 * replies are the SSE fixtures, or streams built from the same documented
 * events — and each test checks what the NEXT request carried: the previous
 * turn's items replayed as returned, one output per call, nothing else.
 *
 * agentLoop.test.ts cannot cover this: it replaces agentChat, and with it the
 * whole wire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const verify = vi.hoisted(() => ({ queue: [] as unknown[], runs: 0 }));

vi.mock('./verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify')>();
  return {
    ...actual,
    runAllVerifications: async () => {
      const next = verify.queue[Math.min(verify.runs, verify.queue.length - 1)];
      verify.runs++;
      return JSON.parse(JSON.stringify(next));
    },
  };
});

vi.mock('./codeepCloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codeepCloud')>();
  return { ...actual, syncProgress: () => {} };
});

// The undo history lives under the home directory; keep it out of these runs.
vi.mock('./history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./history')>();
  return {
    ...actual,
    startSession: vi.fn(() => 'session-1'),
    endSession: vi.fn(),
    recordWrite: vi.fn(() => null),
    recordEdit: vi.fn(() => null),
    recordDelete: vi.fn(() => null),
    recordMkdir: vi.fn(() => null),
    recordCommand: vi.fn(() => null),
  };
});

import { runAgent, resetAgentToolsNoticeForTests } from './agent';
import { config } from '../config/index';

type Item = Record<string, unknown>;
type Req = { url: string; body: Record<string, unknown> };

const FIXTURES = join(__dirname, '__fixtures__', 'responses');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

// ─── Streams built from the documented events ───────────────────────────────

function streamOf(output: Item[], usage: Item = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }): string {
  const events: Item[] = [{ type: 'response.created', response: { status: 'in_progress', output: [], usage: null } }];
  output.forEach((item, i) => {
    const added = item.type === 'reasoning' ? { ...item, encrypted_content: 'partial' }
      : item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' }
      : { ...item, content: [], status: 'in_progress' };
    events.push({ type: 'response.output_item.added', output_index: i, item: added });
    if (item.type === 'message') {
      for (const part of item.content as Array<{ text: string }>) {
        events.push({ type: 'response.output_text.delta', output_index: i, item_id: item.id, content_index: 0, delta: part.text });
      }
    }
    events.push({ type: 'response.output_item.done', output_index: i, item });
  });
  events.push({ type: 'response.completed', response: { status: 'completed', output, usage } });
  return events.map((e, n) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: n })}\n\n`).join('');
}

const reasoning = (id: string): Item => ({ id, type: 'reasoning', summary: [], encrypted_content: `ENC-${id}` });
const call = (n: string, name: string, args: Item): Item =>
  ({ id: `fc_${n}`, type: 'function_call', status: 'completed', call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
const answer = (id: string, text: string): Item =>
  ({ id, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });

// ─── Network ──────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;
const envBefore = { wire: process.env.CODEEP_OPENAI_WIRE_API, base: process.env.OPENAI_BASE_URL };
let requests: Req[] = [];
let reply: (req: Req, index: number) => Response;

const sse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const isSub = (req: Req) => String(req.body.instructions ?? '').includes('delegated sub-agent')
  || JSON.stringify(req.body.messages ?? '').includes('delegated sub-agent');
const responsesRequests = () => requests.filter(r => r.url.endsWith('/responses'));

let root: string;
const ctx = () => ({ root, name: 'p', type: 'node', structure: '', keyFiles: [], fileCount: 0, summary: '' }) as never;
const saved: Record<string, unknown> = {};
const KEYS = ['provider', 'model', 'protocol', 'openaiWireApi', 'reasoningEffort', 'maxTokens', 'agentAutoReview'] as const;

beforeEach(() => {
  resetAgentToolsNoticeForTests();
  delete process.env.CODEEP_OPENAI_WIRE_API;
  delete process.env.OPENAI_BASE_URL;
  for (const k of KEYS) saved[k] = config.get(k as never);
  root = mkdtempSync(join(tmpdir(), 'codeep-responses-loop-'));
  writeFileSync(join(root, 'a.txt'), 'hello A\n');
  writeFileSync(join(root, 'b.txt'), 'hello B\n');
  config.set('provider', 'openai');
  config.set('model', 'gpt-6-sol');
  config.set('protocol', 'openai');
  config.set('openaiWireApi', 'auto');
  config.set('reasoningEffort', 'high');
  config.set('maxTokens', 4096);
  config.set('agentAutoReview', false);
  requests = [];
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const req = { url: String(url), body: JSON.parse(String(init?.body)) };
    requests.push(req);
    const res = reply(req, requests.length - 1);
    // A request that did not ask to stream gets the terminal event's
    // `response` object as JSON, the way the API answers stream:false.
    if (req.body.stream === false && res.headers.get('content-type') === 'text/event-stream') {
      const events = (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
      const terminal = events.find(e => e.type === 'response.completed' || e.type === 'response.incomplete');
      return new Response(JSON.stringify(terminal?.response ?? {}), { status: 200 });
    }
    return res;
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) config.delete(k as never);
    else config.set(k as never, saved[k] as never);
  }
  if (envBefore.wire === undefined) delete process.env.CODEEP_OPENAI_WIRE_API;
  else process.env.CODEEP_OPENAI_WIRE_API = envBefore.wire;
  if (envBefore.base === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = envBefore.base;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Every function_call answered exactly once by a function_call_output in its
 * own batch, and no output without its call — checked independently of
 * normalizePairs, which is under test.
 */
function expectPaired(input: Item[]): void {
  let open = new Set<string>();
  let sawOutputs = false;
  const newBatch = () => {
    expect([...open], 'calls left unanswered in their batch').toEqual([]);
    open = new Set();
    sawOutputs = false;
  };
  for (const item of input) {
    if (item.type === 'function_call_output') {
      expect(open.has(String(item.call_id)), `output for ${String(item.call_id)} has no open call`).toBe(true);
      open.delete(String(item.call_id));
      sawOutputs = true;
    } else if (item.type === 'message' && item.role !== 'assistant') {
      newBatch();
    } else {
      if (sawOutputs) newBatch();
      if (item.type === 'function_call') open.add(String(item.call_id));
    }
  }
  newBatch();
}

describe('a tool loop over the Responses API', () => {
  it('replays the turn exactly as returned and answers each call by call_id', async () => {
    reply = (_req, i) => sse(fixture(i === 0 ? 'tools-parallel.sse' : 'final-after-tools.sse'));
    const streamed: string[] = [];

    const result = await runAgent('Read a.txt and b.txt.', ctx(), { autoVerify: false, maxIterations: 5, onChunk: c => streamed.push(c) });

    expect(result.success).toBe(true);
    expect(result.finalResponse).toBe('Both files say hello.');
    expect(streamed.join('')).toBe('Reading both files.Both files say hello.');
    expect(requests.every(r => r.body.stream === true)).toBe(true);
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
    const turn1 = (await import('../api/responses')).parseResponsesSSE(fixture('tools-parallel.sse'));
    const input = requests[1].body.input as Item[];
    expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(input.slice(1)).toEqual([
      ...(await turn1).items,
      { type: 'function_call_output', call_id: 'call_A', output: expect.stringContaining('hello A') },
      { type: 'function_call_output', call_id: 'call_B', output: expect.stringContaining('hello B') },
    ]);
    expect(input.slice(1)[0]).toMatchObject({ type: 'reasoning', encrypted_content: 'ENC-full' });
    expect(JSON.stringify(input)).not.toContain('Continue with the task');
  });

  it('sends every request stateless, with strict:false tools and the /thinking tier, never Chat Completions fields', async () => {
    reply = (_req, i) => sse(fixture(i === 0 ? 'tools-parallel.sse' : 'final-after-tools.sse'));

    await runAgent('Read a.txt and b.txt.', ctx(), { autoVerify: false, maxIterations: 5 });

    for (const { body } of requests) {
      expect(body.store).toBe(false);
      expect(body.include).toEqual(['reasoning.encrypted_content']);
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body.max_output_tokens as number).toBeGreaterThanOrEqual(32_768);
      const tools = body.tools as Item[];
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) expect(tool, String(tool.name)).toMatchObject({ type: 'function', strict: false });
      for (const key of ['messages', 'max_completion_tokens', 'reasoning_effort', 'temperature']) {
        expect(body, key).not.toHaveProperty(key);
      }
    }
  });

  it('answers a call whose arguments did not parse, instead of dropping it', async () => {
    reply = (_req, i) => sse(fixture(i === 0 ? 'malformed-args.sse' : 'final-after-tools.sse'));

    const result = await runAgent('Read a file.', ctx(), { autoVerify: false, maxIterations: 5 });

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    const input = requests[1].body.input as Item[];
    expect(input).toContainEqual({
      type: 'function_call_output', call_id: 'call_M',
      output: 'Error: arguments for read_file could not be parsed (its arguments are not valid JSON). Call it again with valid JSON.',
    });
    expectPaired(input);
  });

  it('stops on a 400 with the provider\'s message — no retry, no Chat Completions fallback', async () => {
    reply = () => new Response(JSON.stringify({ error: { message: "Invalid schema for function 'read_file'.", type: 'invalid_request_error' } }), { status: 400 });

    const result = await runAgent('Read a.txt.', ctx(), { autoVerify: false, maxIterations: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid schema for function 'read_file'.");
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/responses']);
  });
});

describe('replies that stop short', () => {
  it('says a reply was cut off at the output limit, and nudges without the half-finished turn', async () => {
    reply = (_req, i) => sse(fixture(i === 0 ? 'incomplete-max-output.sse' : 'final-after-tools.sse'));
    const notices: string[] = [];

    const result = await runAgent('Write out.txt.', ctx(), { autoVerify: false, maxIterations: 5, onIteration: (_i, m) => notices.push(m) });

    expect(result.success).toBe(true);
    expect(notices.some(n => n.startsWith('⚠ Reply cut off at the output-token limit'))).toBe(true);
    const input = requests[1].body.input as Item[];
    // Its reasoning led to a call that never finished: neither is replayed.
    expect(JSON.stringify(input)).not.toContain('rs_3');
    expect(JSON.stringify(input)).not.toContain('call_X');
    expect(input[input.length - 1]).toEqual({ type: 'message', role: 'user', content: 'Continue. Execute the tool calls now.' });
    expectPaired(input);
  });

  it('answers the calls a Stop skipped as not executed', async () => {
    const { ResponsesRunState } = await import('./responsesRunState');
    const tagged: Array<Array<{ call_id: string; output: string }>> = [];
    const spy = vi.spyOn(ResponsesRunState.prototype, 'tagToolOutputs').mockImplementation(function (this: unknown, _m, outputs) {
      tagged.push(outputs);
    });
    const stop = new AbortController();
    reply = (_req, i) => sse(fixture(i === 0 ? 'tools-parallel.sse' : 'final-after-tools.sse'));
    try {
      await runAgent('Read a.txt and b.txt.', ctx(), {
        autoVerify: false, maxIterations: 5, abortSignal: stop.signal,
        onToolResult: () => stop.abort(),
      });
    } finally {
      spy.mockRestore();
    }
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toEqual([
      { call_id: 'call_A', output: expect.stringContaining('hello A') },
      { call_id: 'call_B', output: '[not executed: run stopped]' },
    ]);
  });
});

describe('the verification fix loop on the Responses wire', () => {
  it('replays a fix turn\'s calls and answers them in the next fix request', async () => {
    const fail = { success: false, type: 'build', command: 'npm run build', output: 'failed', errors: [{ severity: 'error', message: 'build broke' }], duration: 1 };
    const pass = { success: true, type: 'build', command: 'npm run build', output: '', errors: [], duration: 1 };
    verify.queue = [[fail], [fail], [pass]];
    verify.runs = 0;
    reply = (_req, i) => sse([
      streamOf([reasoning('rs_w'), call('W', 'write_file', { path: 'out.txt', content: 'x\n' })]),
      streamOf([answer('msg_done', 'Done.')]),
      streamOf([reasoning('rs_fix'), call('F', 'read_file', { path: 'a.txt' })]),
      streamOf([answer('msg_fixed', 'Fixed.')]),
    ][Math.min(i, 3)]);

    await runAgent('Write out.txt.', ctx(), { autoVerify: 'build', maxFixAttempts: 3, maxIterations: 10 });

    expect(requests.length).toBeGreaterThanOrEqual(4);
    const input = requests[3].body.input as Item[];
    expect(input).toContainEqual(reasoning('rs_fix'));
    expect(input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_F' }));
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call_F', output: expect.stringContaining('hello A') });
    expectPaired(input);
  });
});

describe('context compression on the Responses wire', () => {
  it('keeps the latest turn\'s items after compressing, and every call answered', async () => {
    // One huge task message pushes the history past the 200K-character
    // compression threshold, so compression keeps it, a summary and the last
    // two messages — the latest assistant turn and its results.
    const task = `Read a.txt four times.\n${'x'.repeat(205_000)}`;
    reply = (_req, i) => sse(i < 4
      ? streamOf([reasoning(`rs_${i}`), call(String(i), 'read_file', { path: i % 2 ? 'a.txt' : 'b.txt' })])
      : streamOf([reasoning('rs_final'), answer('msg_final', 'Read them all.')]));
    // The loop throttles 5s per iteration at this size; the waits are not
    // what is under test.
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms !== undefined && ms >= 1000 && ms <= 5000 ? 0 : ms, ...rest)) as typeof setTimeout);
    try {
      const result = await runAgent(task, ctx(), { autoVerify: false, maxIterations: 8 });
      expect(result.success).toBe(true);
    } finally {
      spy.mockRestore();
    }

    expect(requests).toHaveLength(5);
    const last = requests[4].body.input as Item[];
    expect(JSON.stringify(last)).toContain('[Context compressed');
    // The turn before compression is still native: reasoning, call, output.
    expect(last).toContainEqual(reasoning('rs_3'));
    expect(last).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_3' }));
    expect(last).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_3' }));
    // …and what compression dropped is gone whole, not half.
    expect(JSON.stringify(last)).not.toContain('call_1');
    for (const req of requests) expectPaired(req.body.input as Item[]);
  }, 30_000);
});

describe('sub-agents on the Responses wire', () => {
  const agentFile = (model: string) => {
    mkdirSync(join(root, '.codeep', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codeep', 'agents', 'other.md'), `---\nname: other\nmodel: ${model}\n---\nYou are other.\n`);
  };

  it('keeps each run\'s items to itself', async () => {
    agentFile('gpt-6-luna');
    let parentTurns = 0;
    let subTurns = 0;
    reply = (req) => {
      if (isSub(req)) {
        subTurns++;
        return sse(subTurns === 1
          ? streamOf([reasoning('rs_sub'), call('S', 'read_file', { path: 'a.txt' })])
          : streamOf([answer('msg_sub', 'Sub-agent read a.txt.')]));
      }
      parentTurns++;
      return sse(parentTurns === 1
        ? streamOf([reasoning('rs_parent'), call('D', 'delegate', { agent: 'other', task: 'read a.txt' })])
        : streamOf([answer('msg_parent', 'All done.')]));
    };

    const result = await runAgent('Delegate reading a.txt.', ctx(), { autoVerify: false, maxIterations: 5 });

    expect(result.success).toBe(true);
    const parent = responsesRequests().filter(r => !isSub(r));
    const sub = responsesRequests().filter(isSub);
    expect(parent).toHaveLength(2);
    expect(sub).toHaveLength(2);
    expect(sub.every(r => r.body.model === 'gpt-6-luna')).toBe(true);
    const parentInput = JSON.stringify(parent[1].body.input);
    expect(parentInput).toContain('ENC-rs_parent');
    expect(parentInput).not.toContain('rs_sub');
    expect(parentInput).not.toContain('call_S');
    for (const r of sub) expect(JSON.stringify(r.body.input)).not.toContain('rs_parent');
    expect(JSON.stringify(sub[1].body.input)).toContain('ENC-rs_sub');
    expect(parent[1].body.input).toContainEqual(expect.objectContaining({
      type: 'function_call_output', call_id: 'call_D', output: expect.stringContaining('Sub-agent read a.txt.'),
    }));
  });

  it('sends a sub-agent on another provider over its own Chat Completions, even with Responses forced', async () => {
    config.set('openaiWireApi', 'responses');
    agentFile('deepseek/deepseek-chat');
    let parentTurns = 0;
    reply = (req) => {
      if (req.url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Sub-agent done.', tool_calls: [] } }] }), { status: 200 });
      }
      parentTurns++;
      return sse(parentTurns === 1
        ? streamOf([reasoning('rs_parent'), call('D', 'delegate', { agent: 'other', task: 'look around' })])
        : streamOf([answer('msg_parent', 'All done.')]));
    };

    const result = await runAgent('Delegate a look around.', ctx(), { autoVerify: false, maxIterations: 5 });

    expect(result.success).toBe(true);
    const subRequests = requests.filter(r => !r.url.endsWith('/responses'));
    expect(subRequests.map(r => r.url)).toEqual(['https://api.deepseek.com/chat/completions']);
    expect(subRequests[0].body).not.toHaveProperty('input');
    expect(subRequests[0].body).not.toHaveProperty('store');
    expect(responsesRequests().map(r => r.body.model)).toEqual(['gpt-6-sol', 'gpt-6-sol']);
  });
});

// ─── The live recordings ─────────────────────────────────────────────────────

/**
 * The owner's live run of 2026-09-26 (scripts/record-responses-fixture.mjs;
 * utils/__fixtures__/responses/recorded). For each two-step scenario the
 * recorder sent step 2 by the transport's replay rule, and OpenAI accepted it.
 * Here the real loop gets the recorded step-1 stream and builds step 2 itself;
 * what it sends must match the accepted request item for item — type, id,
 * call_id, name, arguments, order and each item's own fields — and its body
 * must carry the same stateless fields. The API accepting this shape is the
 * fact under test; the bytes of `encrypted_content` were truncated when saved,
 * so only its presence is compared here (which serialization the parser keeps
 * is api/responses.recorded.test.ts).
 *
 * The switch is left unset, so these also pin the shipped default routing
 * GPT-6 Astra and Sol (and 5.6 Luna) to /responses.
 */
describe('the live recordings (2026-09-26): step 2 as Codeep builds it', () => {
  const RECORDED = join(FIXTURES, 'recorded');
  const recordedText = (name: string) => readFileSync(join(RECORDED, name), 'utf-8');
  const recordedBody = (name: string) => JSON.parse(recordedText(name)).body as Record<string, unknown>;
  const finalText = (name: string) => {
    const events = recordedText(name).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    const output = events.find(e => e.type === 'response.completed').response.output as Item[];
    return output.filter(i => i.type === 'message').flatMap(i => (i.content as Item[]).map(p => String(p.text ?? ''))).join('');
  };

  const scenarios: Array<{ id: string; model: string; effort: 'auto' | 'high' }> = [
    { id: 'astra-reason', model: 'gpt-6-astra', effort: 'high' },
    { id: 'sol-reason', model: 'gpt-6-sol', effort: 'high' },
    { id: 'sol-high-tools', model: 'gpt-6-sol', effort: 'high' },
    { id: 'astra-auto', model: 'gpt-6-astra', effort: 'auto' },
    { id: 'astra-high', model: 'gpt-6-astra', effort: 'high' },
    { id: 'luna-5.6', model: 'gpt-5.6-luna', effort: 'auto' },
  ];

  for (const { id, model, effort } of scenarios) {
    it(`${id}: replays ${model}'s turn the way OpenAI accepted it`, async () => {
      config.delete('openaiWireApi' as never);
      config.set('model', model);
      config.set('reasoningEffort', effort);
      const step1 = recordedBody(`${id}.1.request.json`);
      const step2 = recordedBody(`${id}.2.request.json`);
      const accepted = step2.input as Item[];
      // The project holds what the recorder's fake read_file returned.
      const callPath = new Map(accepted.filter(i => i.type === 'function_call')
        .map(i => [String(i.call_id), String(JSON.parse(String(i.arguments)).path)]));
      for (const out of accepted.filter(i => i.type === 'function_call_output')) {
        writeFileSync(join(root, callPath.get(String(out.call_id))!), String(out.output));
      }
      reply = (_req, i) => sse(recordedText(`${id}.${i === 0 ? 1 : 2}.sse`));

      const prompt = String((step1.input as Item[])[0].content);
      const result = await runAgent(prompt, ctx(), { autoVerify: false, maxIterations: 5, onChunk: () => {} });

      expect(result.success).toBe(true);
      expect(result.finalResponse).toBe(finalText(`${id}.2.sse`));
      // Step 2 is under test. A one-word answer ("HERON") has no closing
      // punctuation, which the loop reads as a fragment and nudges, replayed
      // here by the same stream — requests after the second are that.
      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const r of requests) expect(r.url).toBe('https://api.openai.com/v1/responses');
      expect((requests[0].body.input as Item[]).map(i => i.type)).toEqual((step1.input as Item[]).map(i => i.type));

      const sent = requests[1].body;
      for (const key of ['model', 'store', 'include', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options']) {
        expect(sent[key], key).toEqual(step2[key]);
      }
      // /thinking auto sends no `reasoning`, as the recorder did for Astra's default.
      expect(sent.reasoning).toEqual(step2.reasoning);
      if (!('reasoning' in step2)) expect(sent).not.toHaveProperty('reasoning');
      expect(typeof sent.max_output_tokens).toBe('number');
      expect(typeof sent.instructions).toBe('string');
      const tool = (sent.tools as Item[]).find(t => t.name === 'read_file')!;
      const recordedTool = (step2.tools as Item[])[0];
      expect(Object.keys(tool).sort()).toEqual(Object.keys(recordedTool).sort());
      expect(tool).toMatchObject({ type: 'function', strict: false });

      const input = sent.input as Item[];
      expect(input.map(i => i.type)).toEqual(accepted.map(i => i.type));
      expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
      for (let n = 1; n < accepted.length; n++) {
        const want = accepted[n];
        const got = input[n];
        if (want.type === 'function_call_output') {
          expect(got.call_id, `input[${n}] call_id`).toBe(want.call_id);
          expect(String(got.output), `input[${n}] output`).toContain(String(want.output));
          continue;
        }
        // An item the model produced goes back with exactly its own fields.
        expect(Object.keys(got).sort(), `input[${n}] fields`).toEqual(Object.keys(want).sort());
        for (const key of Object.keys(want)) {
          if (key === 'encrypted_content') {
            expect(typeof got[key] === 'string' && (got[key] as string).length > 0, `input[${n}] encrypted_content`).toBe(true);
          } else {
            expect(got[key], `input[${n}].${key}`).toEqual(want[key]);
          }
        }
      }
      expect(JSON.stringify(input)).not.toContain('Continue with the task');
      expectPaired(input);
    });
  }
});

// ─── GPT-6 Astra where its agent turns stay on Chat Completions ─────────────

describe('GPT-6 Astra where its agent turns stay on Chat Completions', () => {
  const astraRefusal = () => new Response(JSON.stringify({ error: {
    message: 'Chat Completions does not support function calling with GPT-6 Astra.', type: 'invalid_request_error',
  } }), { status: 400 });
  const chatAnswer = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Done without native tools.', tool_calls: [] } }] }), { status: 200 });
  const toolsNotice = (notices: string[]) => notices.filter(n => n.includes('cannot call tools over Chat Completions'));

  // A proxy stays on Chat Completions under the shipped 'auto'. There the
  // tools request 400s and agentChat falls back to text tools — which used to
  // happen without a word. Once per process: the second run, here under the
  // 'chat' kill switch at OpenAI's own URL, is not told again.
  it('says so once, then runs on the text-tool fallback', async () => {
    config.delete('openaiWireApi' as never);
    config.set('model', 'gpt-6-astra');
    process.env.OPENAI_BASE_URL = 'https://litellm.internal/v1';
    reply = (req) => (req.body.tools ? astraRefusal() : chatAnswer());
    const notices: string[] = [];

    const first = await runAgent('Say hello.', ctx(), { autoVerify: false, maxIterations: 3, onIteration: (_i, m) => notices.push(m) });

    expect(first.success).toBe(true);
    expect(requests.map(r => r.url)).toEqual(['https://litellm.internal/v1/chat/completions', 'https://litellm.internal/v1/chat/completions']);
    expect(requests[0].body).toHaveProperty('tools');
    expect(requests[1].body).not.toHaveProperty('tools');
    expect(toolsNotice(notices)).toHaveLength(1);
    expect(toolsNotice(notices)[0]).toMatch(/^⚠ gpt-6-astra cannot call tools over Chat Completions/);
    expect(toolsNotice(notices)[0]).toContain('text tool format');

    delete process.env.OPENAI_BASE_URL;
    config.set('openaiWireApi', 'chat');
    await runAgent('Say hello again.', ctx(), { autoVerify: false, maxIterations: 3, onIteration: (_i, m) => notices.push(m) });
    expect(toolsNotice(notices)).toHaveLength(1);
  });

  // A run with nowhere to show the notice (a sub-agent, a headless review)
  // must not use it up: the user's next run in the TUI still has to be told.
  it('keeps the notice for a run that can show it', async () => {
    config.delete('openaiWireApi' as never);
    config.set('model', 'gpt-6-astra');
    process.env.OPENAI_BASE_URL = 'https://litellm.internal/v1';
    reply = (req) => (req.body.tools ? astraRefusal() : chatAnswer());

    await runAgent('Say hello.', ctx(), { autoVerify: false, maxIterations: 3 });
    const notices: string[] = [];
    await runAgent('Say hello again.', ctx(), { autoVerify: false, maxIterations: 3, onIteration: (_i, m) => notices.push(m) });

    expect(toolsNotice(notices)).toHaveLength(1);
  });

  it('says nothing over the Responses API, where Astra calls tools', async () => {
    config.delete('openaiWireApi' as never);
    config.set('model', 'gpt-6-astra');
    reply = () => sse(fixture('text-only.sse'));
    const notices: string[] = [];

    await runAgent('Say hello.', ctx(), { autoVerify: false, maxIterations: 3, onIteration: (_i, m) => notices.push(m) });

    expect(responsesRequests()).toHaveLength(1);
    expect(toolsNotice(notices)).toEqual([]);
  });

  it('says nothing for GPT-6 Sol on Chat Completions, which calls tools there', async () => {
    config.set('openaiWireApi', 'chat');
    config.set('model', 'gpt-6-sol');
    reply = () => chatAnswer();
    const notices: string[] = [];

    await runAgent('Say hello.', ctx(), { autoVerify: false, maxIterations: 3, onIteration: (_i, m) => notices.push(m) });

    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/chat/completions']);
    expect(toolsNotice(notices)).toEqual([]);
  });
});
