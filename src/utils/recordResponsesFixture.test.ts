/**
 * scripts/record-responses-fixture.mjs — the owner-run recorder — without the
 * network: argument handling, the plan and its cap, the y/N gate, header and
 * key hygiene, encrypted_content truncation, and the fixture writer. The full
 * flow runs against a fake fetch that serves the hand-built fixtures, which is
 * also how the summary's answers are checked. No test here may reach
 * api.openai.com or read a real key.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { PassThrough, Writable } from 'stream';

interface Scenario { id: string; model: string; effort?: string; probe?: boolean; optIn?: boolean }
interface Recorder {
  API_URL: string;
  MAX_REQUESTS: number;
  SCENARIOS: Scenario[];
  FAKE_FILES: Record<string, string>;
  parseArgs(argv: string[]): { dryRun: boolean; help: boolean; only: string[]; outDir: string; maxOutputTokens: number };
  planRequests(opts: { only: string[] }): { scenarios: Scenario[]; requests: number; models: string[] };
  buildRequestBody(o: { model: string; effort?: string; input: unknown[]; maxOutputTokens: number }): Record<string, unknown>;
  sanitizeRequestHeaders(h: unknown): Record<string, string>;
  sanitizeResponseHeaders(h: unknown): Record<string, string>;
  redactSecrets(text: string, key?: string): string;
  truncateEncrypted(text: string, keep?: number): string;
  writeRecording(outDir: string, name: string, r: Record<string, unknown>): string[];
  confirm(question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<boolean>;
  main(argv: string[], io: Record<string, unknown>): Promise<number>;
}

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'record-responses-fixture.mjs');
const FIXTURES = join(__dirname, '__fixtures__', 'responses');
const KEY = 'sk-proj-TESTKEY-0123456789abcdefghij';

let rec: Recorder;
beforeAll(async () => {
  // A computed specifier: the script is plain .mjs outside src/, with no types.
  const url = pathToFileURL(SCRIPT).href;
  rec = await import(/* @vite-ignore */ url) as Recorder;
});

let out: string;
beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'codeep-recorder-')); });
afterEach(() => { rmSync(out, { recursive: true, force: true }); });

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb(); } });
  return { stream, text: () => text };
}

function stdinWith(answer: string | null) {
  const s = new PassThrough();
  if (answer !== null) s.end(`${answer}\n`);
  else s.end();
  return s;
}

describe('arguments and plan', () => {
  it('defaults to every scenario, the recorded/ directory and a small output cap', () => {
    const opts = rec.parseArgs([]);
    expect(opts.dryRun).toBe(false);
    expect(opts.only).toEqual(['astra-auto', 'astra-high', 'sol-high-tools', 'luna-5.6']);
    expect(opts.outDir.endsWith(join('src', 'utils', '__fixtures__', 'responses', 'recorded'))).toBe(true);
    expect(opts.maxOutputTokens).toBe(2048);
  });

  it('reads --dry-run, --only, --out and --max-output-tokens', () => {
    const opts = rec.parseArgs(['--dry-run', '--only', 'luna-5.6,astra-high', '--out', out, '--max-output-tokens', '4096']);
    expect(opts).toMatchObject({ dryRun: true, only: ['luna-5.6', 'astra-high'], outDir: out, maxOutputTokens: 4096 });
  });

  it('refuses unknown options, unknown scenarios and bad numbers', () => {
    expect(() => rec.parseArgs(['--yes'])).toThrow(/unknown option/);
    expect(() => rec.parseArgs(['--only', 'gpt-7'])).toThrow(/unknown scenario/);
    expect(() => rec.parseArgs(['--max-output-tokens', '1e6'])).toThrow(/16 to 32768/);
    expect(() => rec.parseArgs(['--max-output-tokens', '8'])).toThrow(/16 to 32768/);
    expect(() => rec.parseArgs(['--out'])).toThrow(/needs a value/);
  });

  it('covers Astra at auto and high, Sol at high with tools and 5.6 Luna in 9 requests', () => {
    const plan = rec.planRequests(rec.parseArgs([]));
    expect(plan.requests).toBe(9);
    expect(plan.scenarios.map(s => [s.model, s.effort ?? 'auto'])).toEqual([
      ['gpt-6-astra', 'auto'], ['gpt-6-astra', 'high'], ['gpt-6-sol', 'high'], ['gpt-5.6-luna', 'auto'],
    ]);
  });

  it('never plans more than 10 requests, whatever is selected', () => {
    expect(rec.MAX_REQUESTS).toBe(10);
    const ids = rec.SCENARIOS.map(s => s.id);
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const only = ids.filter((_, i) => mask & (1 << i));
      let requests: number | null = null;
      try { requests = rec.planRequests({ only }).requests; } catch (e) { expect(String(e)).toMatch(/the cap is 10/); }
      if (requests !== null) expect(requests).toBeLessThanOrEqual(10);
    }
  });

  it('runs the reasoning scenarios only when they are named', () => {
    const ids = (argv: string[]) => rec.planRequests(rec.parseArgs(argv)).scenarios.map(s => s.id);
    expect(ids([])).not.toContain('astra-reason');
    expect(ids([])).not.toContain('sol-reason');
    const plan = rec.planRequests(rec.parseArgs(['--only', 'astra-reason,sol-reason']));
    expect(plan.requests).toBe(5); // Astra: call, answer, answer without reasoning; Sol: call, answer
    expect(rec.FAKE_FILES['p17.txt']).toMatch(/HERON/);
  });

  it('sends the transport\'s shape: stateless, strict:false, no sampling params', () => {
    const body = rec.buildRequestBody({ model: 'gpt-6-sol', effort: 'high', input: [], maxOutputTokens: 2048 });
    expect(body).toMatchObject({
      store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'high' },
      max_output_tokens: 2048, stream: true, tool_choice: 'auto',
    });
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', name: 'read_file', strict: false });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(rec.buildRequestBody({ model: 'gpt-6-astra', input: [], maxOutputTokens: 2048 })).not.toHaveProperty('reasoning');
  });
});

describe('keeping the key out', () => {
  it('saves request headers from an allowlist — never Authorization', () => {
    expect(rec.sanitizeRequestHeaders({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'OpenAI-Organization': 'org-x', Cookie: 'a=b' }))
      .toEqual({ 'content-type': 'application/json' });
    expect(rec.sanitizeRequestHeaders({ authorization: `Bearer ${KEY}` })).toEqual({});
  });

  it('saves response headers from an allowlist', () => {
    const headers = new Headers({ 'x-request-id': 'req_1', 'openai-organization': 'my-org', 'set-cookie': 'a=b', 'content-type': 'text/event-stream' });
    expect(rec.sanitizeResponseHeaders(headers)).toEqual({ 'x-request-id': 'req_1', 'content-type': 'text/event-stream' });
  });

  it('redacts the key and anything shaped like an sk- key', () => {
    expect(rec.redactSecrets(`bad key ${KEY} and sk-abcdefghijklmnop`, KEY)).toBe('bad key [REDACTED] and sk-[REDACTED]');
    expect(rec.redactSecrets('Incorrect API key provided: sk-proj-****abcd1234.')).not.toContain('abcd1234');
  });

  it('truncates encrypted_content and leaves valid JSON behind', () => {
    const long = 'A'.repeat(500);
    const json = JSON.stringify({ item: { type: 'reasoning', encrypted_content: long, id: 'rs_1' } });
    const cut = rec.truncateEncrypted(json, 32);
    expect(cut.length).toBeLessThan(json.length);
    expect(JSON.parse(cut).item.encrypted_content).toMatch(/^A{32}…\[truncated 468 chars\]$/);
    expect(JSON.parse(cut).item.id).toBe('rs_1');
    const escaped = JSON.stringify({ encrypted_content: `${'B'.repeat(31)}\\${'C'.repeat(40)}` });
    expect(() => JSON.parse(rec.truncateEncrypted(escaped, 32))).not.toThrow();
    expect(rec.truncateEncrypted(JSON.stringify({ encrypted_content: 'short' }))).toBe('{"encrypted_content":"short"}');
  });

  it('writes a recording with no Authorization, no key and truncated reasoning', () => {
    const text = readFileSync(join(FIXTURES, 'tools-parallel.sse'), 'utf-8').replace(/ENC-full/g, 'E'.repeat(400));
    const files = rec.writeRecording(out, 'sol.1', {
      body: { model: 'gpt-6-sol', input: [{ type: 'reasoning', encrypted_content: 'Z'.repeat(400) }] },
      requestHeaders: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      status: 200, responseHeaders: new Headers({ 'x-request-id': 'req_9' }), text, key: KEY,
    });
    expect(files).toEqual(['sol.1.request.json', 'sol.1.sse', 'sol.1.response.json']);
    const request = JSON.parse(readFileSync(join(out, 'sol.1.request.json'), 'utf-8'));
    expect(request.headers).toEqual({ 'content-type': 'application/json' });
    expect(request.body.input[0].encrypted_content).toContain('…[truncated');
    const saved = readFileSync(join(out, 'sol.1.sse'), 'utf-8');
    expect(saved).not.toContain('E'.repeat(100));
    expect(saved).toContain('event: response.completed');
    for (const f of readdirSync(out)) expect(readFileSync(join(out, f), 'utf-8'), f).not.toContain(KEY);
  });
});

describe('the y/N gate', () => {
  it('is No unless the answer is y or yes — and no answer is No', async () => {
    const o = sink();
    expect(await rec.confirm('Send?', stdinWith('y'), o.stream)).toBe(true);
    expect(await rec.confirm('Send?', stdinWith('YES'), o.stream)).toBe(true);
    expect(await rec.confirm('Send?', stdinWith(''), o.stream)).toBe(false);
    expect(await rec.confirm('Send?', stdinWith('n'), o.stream)).toBe(false);
    expect(await rec.confirm('Send?', stdinWith(null), o.stream)).toBe(false);
    expect(o.text()).toContain('[y/N]');
  });
});

describe('main', () => {
  it('--dry-run prints the plan and bodies, needs no key and sends nothing', async () => {
    const fetchSpy = vi.fn();
    const o = sink();
    const code = await rec.main(['--dry-run', '--out', out], { stdout: o.stream, stderr: sink().stream, env: {}, fetch: fetchSpy });
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(o.text()).toContain('at most 9 request(s)');
    expect(o.text()).toContain('gpt-6-astra (auto)');
    expect(o.text()).toContain('Dry run: nothing was sent.');
    expect(readdirSync(out)).toEqual([]);
  });

  it('prints the count and models BEFORE asking, and sends nothing on No', async () => {
    const fetchSpy = vi.fn();
    const o = sink();
    const code = await rec.main(['--out', out], { stdin: stdinWith('n'), stdout: o.stream, stderr: sink().stream, env: { OPENAI_API_KEY: KEY }, fetch: fetchSpy });
    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = o.text();
    const askAt = text.indexOf('[y/N]');
    expect(askAt).toBeGreaterThan(-1);
    expect(text.slice(0, askAt)).toContain('at most 9 request(s)');
    expect(text.slice(0, askAt)).toContain('Models: gpt-6-astra (auto); gpt-6-astra (high); gpt-6-sol (high, with tools, parallel); gpt-5.6-luna (auto).');
    expect(text).toContain('Aborted — nothing was sent.');
    expect(text).not.toContain(KEY);
  });

  it('stops before asking when OPENAI_API_KEY is missing', async () => {
    const fetchSpy = vi.fn();
    const err = sink();
    const code = await rec.main(['--out', out], { stdin: stdinWith('y'), stdout: sink().stream, stderr: err.stream, env: {}, fetch: fetchSpy });
    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(err.text()).toContain('OPENAI_API_KEY is not set');
  });

  it('on yes, runs the loop, saves every request, and answers the questions — with the key nowhere', async () => {
    const fixture = (n: string) => readFileSync(join(FIXTURES, n), 'utf-8').replace(/ENC-full/g, 'E'.repeat(300));
    const seen: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body });
      const hasOutputs = (body.input as Array<{ type: string }>).some(i => i.type === 'function_call_output');
      const hasReasoning = (body.input as Array<{ type: string }>).some(i => i.type === 'reasoning');
      if (hasOutputs && !hasReasoning) {
        return new Response(JSON.stringify({ error: { message: `Reasoning items are required. Your key ${KEY} …` } }), { status: 400, headers: { 'x-request-id': 'req_probe' } });
      }
      return new Response(fixture(hasOutputs ? 'final-after-tools.sse' : 'tools-parallel.sse'), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_ok', 'openai-organization': 'secret-org' } });
    });
    const o = sink();
    const code = await rec.main(['--out', out], { stdin: stdinWith('y'), stdout: o.stream, stderr: sink().stream, env: { OPENAI_API_KEY: KEY }, fetch: fakeFetch });

    expect(code).toBe(0);
    expect(seen).toHaveLength(9);
    expect(seen.every(s => s.url === 'https://api.openai.com/v1/responses' && s.auth === `Bearer ${KEY}`)).toBe(true);
    // Step 2 replays step 1's items verbatim and answers each call.
    const step2 = seen[1].body.input as Array<Record<string, unknown>>;
    expect(step2.filter(i => i.type === 'function_call_output').map(i => i.call_id)).toEqual(['call_A', 'call_B']);
    expect(step2.find(i => i.type === 'reasoning')).toMatchObject({ encrypted_content: 'E'.repeat(300) });

    const files = readdirSync(out);
    expect(files).toContain('summary.json');
    expect(files).toContain('astra-high.probe.response.json');
    for (const f of files) {
      const text = readFileSync(join(out, f), 'utf-8');
      expect(text, f).not.toContain(KEY);
      expect(text, f).not.toContain('secret-org');
      expect(text, f).not.toMatch(/authorization/i);
    }
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf-8'));
    expect(summary.requestsSent).toBe(9);
    expect(summary.a_replayed_reasoning_under_store_false).toEqual([
      { request: 'astra-auto.2', outcome: 'accepted (completed)' },
      { request: 'astra-high.2', outcome: 'accepted (completed)' },
      { request: 'sol-high-tools.2', outcome: 'accepted (completed)' },
      { request: 'luna-5.6.2', outcome: 'accepted (completed)' },
    ]);
    expect(summary.b_followup_without_reasoning.outcome).toMatch(/^rejected: HTTP 400 — Reasoning items are required/);
    expect(summary.c_astra_default_effort).toEqual({ effort: 'high', context: null });
    expect(summary.d_usage_details[0]).toEqual({ request: 'astra-auto.1', input_tokens_details: true, cached_tokens: true, cache_write_tokens: true, reasoning_tokens: true });
    expect(summary.parallel_calls_in_one_response).toBe(2);
    expect(o.text()).toContain('(b) GPT-6 follow-up without its reasoning: rejected: HTTP 400');
    expect(o.text()).not.toContain(KEY);
  });
});
