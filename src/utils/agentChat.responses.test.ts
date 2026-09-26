/**
 * agentChat() on the Responses wire, with the REAL providers, parser, tool
 * parsing and token tracker. Only config, the base URL, the network and the
 * side-effecting neighbours are faked; every request body is built by the
 * production code and captured from fetch, and replies are the SSE fixtures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const cfg = vi.hoisted(() => ({ values: {} as Record<string, unknown>, baseUrl: 'https://api.openai.com/v1' }));

vi.mock('../config/index', () => ({
  config: { get: vi.fn((k: string) => cfg.values[k]) },
  getApiKey: vi.fn(() => 'sk-test'),
  resolveBaseUrl: vi.fn(() => cfg.baseUrl),
  Message: {},
}));
vi.mock('./ratelimit', () => ({ checkApiRateLimit: vi.fn(() => ({ allowed: true })) }));
vi.mock('./openrouterPrefs', () => ({ readOpenRouterPreferences: vi.fn(() => null) }));
vi.mock('./projectIntelligence', () => ({
  loadProjectIntelligence: vi.fn(() => null),
  generateContextFromIntelligence: vi.fn(() => ''),
}));
vi.mock('./codeepCloud', () => ({ syncProgress: vi.fn(), generateProjectId: vi.fn(() => 'p') }));

import { agentChat } from './agentChat';
import { ApiError } from '../api/index';
import { PROVIDERS } from '../config/providers';
import { getLastUsage, resetTokenTracking } from './tokenTracker';

const FIXTURES = join(__dirname, '__fixtures__', 'responses');
const sse = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

const originalFetch = global.fetch;
const envBefore = { wire: process.env.CODEEP_OPENAI_WIRE_API, base: process.env.OPENAI_BASE_URL };
let requests: Array<{ url: string; body: Record<string, unknown> }> = [];
/** Replies for /responses, in order; then text-only. */
let responsesQueue: Array<() => Response> = [];

function useModel(provider: string, model: string, protocol: 'openai' | 'anthropic', extra: Record<string, unknown> = {}): void {
  cfg.values = {
    provider, model, protocol,
    apiTimeout: 30_000,
    temperature: 0.7,
    maxTokens: 4096,
    reasoningEffort: 'high',
    ...extra,
  };
}

const sseResponse = (name: string) => () => new Response(sse(name), { status: 200, headers: { 'content-type': 'text/event-stream' } });

beforeEach(() => {
  delete process.env.CODEEP_OPENAI_WIRE_API;
  delete process.env.OPENAI_BASE_URL;
  cfg.baseUrl = 'https://api.openai.com/v1';
  requests = [];
  responsesQueue = [];
  resetTokenTracking();
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body));
    requests.push({ url: u, body });
    if (u.endsWith('/responses')) {
      const res = (responsesQueue.shift() ?? sseResponse('text-only.sse'))();
      // stream:false gets the terminal event's `response` as JSON, as the API does.
      if (body.stream === false && res.headers.get('content-type') === 'text/event-stream') {
        const events = (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
        const terminal = events.find(e => e.type === 'response.completed' || e.type === 'response.incomplete');
        return new Response(JSON.stringify(terminal?.response ?? {}), { status: 200 });
      }
      return res;
    }
    const openai = { choices: [{ message: { content: 'done', tool_calls: [] } }] };
    const anthropic = { content: [{ type: 'text', text: 'done' }] };
    return new Response(JSON.stringify(u.endsWith('/v1/messages') ? anthropic : openai), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (envBefore.wire === undefined) delete process.env.CODEEP_OPENAI_WIRE_API;
  else process.env.CODEEP_OPENAI_WIRE_API = envBefore.wire;
  if (envBefore.base === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = envBefore.base;
});

const messages = [{ role: 'user' as const, content: 'Read a.txt and b.txt.' }];
const onChunk = () => {};

describe('routing', () => {
  // On since the owner's live run of 2026-09-26: no setting at the official
  // URL means /responses, for Astra as for Sol.
  it('ships on the Responses API: no setting, official URL, /responses for GPT-6 Sol and Astra', async () => {
    useModel('openai', 'gpt-6-sol', 'openai');
    await agentChat(messages, 'system', onChunk);
    useModel('openai', 'gpt-6-astra', 'openai');
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
    expect(requests.map(r => r.body.model)).toEqual(['gpt-6-sol', 'gpt-6-astra']);
  });

  it('keeps the kill switch: openaiWireApi "chat" goes to /chat/completions', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'chat' });
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('goes to /responses under auto at the official URL', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('keeps an OPENAI_BASE_URL proxy on Chat Completions under auto, and moves it when forced', async () => {
    cfg.baseUrl = 'https://litellm.internal/v1';
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    await agentChat(messages, 'system', onChunk);
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'responses' });
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.url)).toEqual(['https://litellm.internal/v1/chat/completions', 'https://litellm.internal/v1/responses']);
  });

  it('keeps a model the catalogue does not list (gpt-4.1) on Chat Completions under auto, and moves it when forced', async () => {
    useModel('openai', 'gpt-4.1', 'openai', { openaiWireApi: 'auto' });
    await agentChat(messages, 'system', onChunk);
    useModel('openai', 'gpt-4.1', 'openai', { openaiWireApi: 'responses' });
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/responses']);
  });

  it('lets CODEEP_OPENAI_WIRE_API=chat override a config that asks for Responses', async () => {
    process.env.CODEEP_OPENAI_WIRE_API = 'chat';
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'responses' });
    await agentChat(messages, 'system', onChunk);
    expect(requests[0].url).toMatch(/\/chat\/completions$/);
  });

  it('never sends any other provider to /responses, even forced', async () => {
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      if (id === 'openai') continue;
      cfg.baseUrl = provider.protocols.openai?.baseUrl ?? 'https://api.example.test';
      useModel(id, provider.defaultModel, provider.defaultProtocol, { openaiWireApi: 'responses' });
      requests = [];
      await agentChat(messages, 'system');
      expect(requests[0]?.url ?? '', id).not.toMatch(/\/responses$/);
    }
  });
});

describe('the request on the Responses wire', () => {
  it('is stateless, flat-tooled with strict:false, and carries no Chat Completions fields', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto', reasoningEffort: 'high' });
    await agentChat(messages, 'system prompt', onChunk);
    const body = requests[0].body;
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.instructions).toBe('system prompt');
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: 'Read a.txt and b.txt.' }]);
    const readFile = (body.tools as Array<Record<string, unknown>>).find(t => t.name === 'read_file');
    expect(readFile).toMatchObject({ type: 'function', name: 'read_file', strict: false });
    expect(readFile).not.toHaveProperty('function');
    expect(body.stream).toBe(true);
    for (const key of ['messages', 'max_completion_tokens', 'max_tokens', 'reasoning_effort', 'temperature']) {
      expect(body, key).not.toHaveProperty(key);
    }
  });

  it('sends /thinking to GPT-6 Sol and Luna with tools — not "none"', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto', reasoningEffort: 'high' });
    await agentChat(messages, 'system', onChunk);
    useModel('openai', 'gpt-6-luna', 'openai', { openaiWireApi: 'auto', reasoningEffort: 'max' });
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.body.reasoning)).toEqual([{ effort: 'high' }, { effort: 'max' }]);
  });

  it('leaves reasoning to the model at auto', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto', reasoningEffort: 'auto' });
    await agentChat(messages, 'system', onChunk);
    expect(requests[0].body).not.toHaveProperty('reasoning');
  });

  it('floors max_output_tokens at 32K, 64K at Max', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto', maxTokens: 4096, reasoningEffort: 'high' });
    await agentChat(messages, 'system', onChunk);
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto', maxTokens: 4096, reasoningEffort: 'max' });
    await agentChat(messages, 'system', onChunk);
    expect(requests.map(r => r.body.max_output_tokens)).toEqual([32_768, 65_536]);
  });
});

describe('the reply', () => {
  it('returns the calls by call_id, with the verbatim items for replay', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    responsesQueue.push(sseResponse('tools-parallel.sse'));
    const chunks: string[] = [];
    const res = await agentChat(messages, 'system', c => chunks.push(c));
    expect(res.toolCalls).toEqual([
      { tool: 'read_file', parameters: { path: 'a.txt' }, id: 'call_A' },
      { tool: 'read_file', parameters: { path: 'b.txt' }, id: 'call_B' },
    ]);
    expect(res.usedNativeTools).toBe(true);
    expect(res.content).toBe('Reading both files.');
    expect(chunks.join('')).toBe('Reading both files.');
    expect(res.native?.items.map(i => i.id)).toEqual(['rs_1', 'msg_1', 'fc_1', 'fc_2']);
    expect(res.native).toMatchObject({ providerId: 'openai', model: 'gpt-6-sol', dialect: 'openai', rejectedCalls: [] });
  });

  it('records the turn in the token tracker, cache and reasoning included', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    responsesQueue.push(sseResponse('tools-parallel.sse'));
    await agentChat(messages, 'system', onChunk);
    expect(getLastUsage()).toMatchObject({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
      cacheReadTokens: 1024, cacheCreationTokens: 128, reasoningTokens: 200,
      model: 'gpt-6-sol', provider: 'openai',
    });
  });

  it('returns calls it could not parse, so they can still be answered', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    responsesQueue.push(sseResponse('malformed-args.sse'));
    const res = await agentChat(messages, 'system', onChunk);
    expect(res.toolCalls).toEqual([]);
    expect(res.native?.rejectedCalls).toEqual([{ call_id: 'call_M', name: 'read_file', reason: 'its arguments are not valid JSON' }]);
  });

  it('returns a refusal as the reply, so it is shown rather than read as an empty turn', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    responsesQueue.push(sseResponse('refusal.sse'));
    const res = await agentChat(messages, 'system', onChunk);
    expect(res.content).toBe("I can't help with that.");
    expect(res.toolCalls).toEqual([]);
  });

  it('says why an incomplete reply stopped', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    responsesQueue.push(sseResponse('incomplete-max-output.sse'));
    const res = await agentChat(messages, 'system', onChunk);
    expect(res.incompleteReason).toBe('max_output_tokens');
    expect(res.toolCalls).toEqual([]);
  });

  it('reads a non-streamed reply when nothing streams', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    const { parseResponsesSSE } = await import('../api/responses');
    const raw = (await parseResponsesSSE(sse('tools-parallel.sse'))).rawResponse;
    responsesQueue.push(() => new Response(JSON.stringify(raw), { status: 200 }));
    const res = await agentChat(messages, 'system');
    expect(requests[0].body.stream).toBe(false);
    expect(requests[0].body).not.toHaveProperty('stream_options');
    expect(res.toolCalls.map(t => t.id)).toEqual(['call_A', 'call_B']);
  });
});

describe('errors on the Responses wire', () => {
  it('throws a 400 as ApiError — no text-tool fallback over Chat Completions', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    const body = JSON.stringify({ error: { message: "Invalid schema for function 'read_file'.", type: 'invalid_request_error' } });
    responsesQueue.push(() => new Response(body, { status: 400 }));
    let caught: unknown;
    try { await agentChat(messages, 'system', onChunk); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toContain("Invalid schema for function 'read_file'.");
    expect(requests.map(r => r.url)).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('throws response.failed as ApiError with its status', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { openaiWireApi: 'auto' });
    responsesQueue.push(sseResponse('failed-rate-limit.sse'));
    let caught: unknown;
    try { await agentChat(messages, 'system', onChunk); } catch (err) { caught = err; }
    expect((caught as ApiError).status).toBe(429);
    expect(requests).toHaveLength(1);
  });
});
