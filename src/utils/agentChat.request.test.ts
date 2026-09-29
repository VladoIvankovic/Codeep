/**
 * What agentChat() actually puts on the wire, with the REAL providers module.
 *
 * agentChat.test.ts mocks providers wholesale, so none of the per-model rules
 * (effort mapping, the GPT-6 tools rule, response floors) is visible there.
 * Here only config, the network and the side-effecting neighbours are faked:
 * every request body is built by the production code path and captured from
 * fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('../config/index', () => ({
  config: { get: vi.fn((k: string) => cfg.values[k]) },
  getApiKey: vi.fn(() => 'sk-test'),
  // Not OpenAI's own URL, so `openai` agent turns stay on Chat Completions
  // under the shipped 'auto' switch — the OPENAI_BASE_URL-proxy case. The
  // Responses wire is agentChat.responses.test.ts.
  resolveBaseUrl: vi.fn(() => 'https://api.example.test'),
  Message: {},
}));
vi.mock('./ratelimit', () => ({ checkApiRateLimit: vi.fn(() => ({ allowed: true })) }));
vi.mock('./openrouterPrefs', () => ({ readOpenRouterPreferences: vi.fn(() => null) }));
vi.mock('./projectIntelligence', () => ({
  loadProjectIntelligence: vi.fn(() => null),
  generateContextFromIntelligence: vi.fn(() => ''),
}));
vi.mock('./codeepCloud', () => ({ syncProgress: vi.fn(), generateProjectId: vi.fn(() => 'p') }));

import { agentChat, agentChatFallback } from './agentChat';

const originalFetch = global.fetch;
let bodies: Record<string, unknown>[] = [];
/** What the next request answers with, when a test needs other than "done". */
let reply: unknown = null;

function useModel(provider: string, model: string, protocol: 'openai' | 'anthropic', extra: Record<string, unknown> = {}): void {
  cfg.values = {
    provider, model, protocol,
    apiTimeout: 30_000,
    temperature: 0.7,
    maxTokens: 4096,
    reasoningEffort: 'auto',
    ...extra,
  };
}

beforeEach(() => {
  bodies = [];
  reply = null;
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const openai = { choices: [{ message: { content: 'done', tool_calls: [] } }] };
    const anthropic = { content: [{ type: 'text', text: 'done' }] };
    return new Response(JSON.stringify(reply ?? (cfg.values.protocol === 'anthropic' ? anthropic : openai)), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

const messages = [{ role: 'user' as const, content: 'hi' }];

describe('GPT-6 Sol/Luna agent turns on Chat Completions', () => {
  // OpenAI: "Chat Completions supports function calling only with
  // `reasoning_effort` set to `none`" for GPT-6 Sol and Luna.
  it('send reasoning_effort "none" with the tools, even when /thinking is auto', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { reasoningEffort: 'auto' });
    await agentChat(messages, 'system');
    expect(Array.isArray(bodies[0].tools) && (bodies[0].tools as unknown[]).length).toBeTruthy();
    expect(bodies[0].reasoning_effort).toBe('none');
  });

  it('send "none" at Max as well, and on Luna', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    useModel('openai', 'gpt-6-luna', 'openai', { reasoningEffort: 'high' });
    await agentChat(messages, 'system');
    expect(bodies.map(b => b.reasoning_effort)).toEqual(['none', 'none']);
  });

  it('keep the tier on the text-tool fallback, which sends no tools array', async () => {
    useModel('openai', 'gpt-6-sol', 'openai', { reasoningEffort: 'max' });
    await agentChatFallback(messages, 'system');
    expect(bodies[0].tools).toBeUndefined();
    expect(bodies[0].reasoning_effort).toBe('max');
  });

  it('leave other GPTs on the tier, with Max sent as "max" from GPT-5.6 on', async () => {
    useModel('openai', 'gpt-5.6-sol', 'openai', { reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    expect(bodies[0].reasoning_effort).toBe('max');
  });
});

describe('response budget', () => {
  // Opus 5.5's always-on thinking spends the same max_tokens as the answer.
  it('never sends Opus 5.5 less than 32K, or 64K at Max', async () => {
    useModel('anthropic', 'claude-opus-5-5', 'anthropic', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    useModel('anthropic', 'claude-opus-5-5', 'anthropic', { maxTokens: 4096, reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    useModel('anthropic', 'claude-opus-5-5', 'anthropic', { maxTokens: 4096 });
    await agentChatFallback(messages, 'system');
    expect(bodies.map(b => b.max_tokens)).toEqual([32_768, 65_536, 32_768]);
  });

  it('reaches Opus 5.5 through OpenRouter too, and leaves other models at the old floor', async () => {
    useModel('openrouter', 'anthropic/claude-opus-5.5', 'openai', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    useModel('anthropic', 'claude-opus-5', 'anthropic', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    expect(bodies.map(b => b.max_tokens)).toEqual([32_768, 16_384]);
  });
});

describe('Claude Sonnet 5.5 on the wire', () => {
  // Thinking on by default at effort high, spending max_tokens with the answer.
  it('never sends it less than 32K, or 64K at Max — native, fallback, and via OpenRouter', async () => {
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic', { maxTokens: 4096, reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic', { maxTokens: 4096 });
    await agentChatFallback(messages, 'system');
    useModel('openrouter', 'anthropic/claude-sonnet-5.5', 'openai', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    // Sonnet 5 keeps the old 16K floor.
    useModel('anthropic', 'claude-sonnet-5', 'anthropic', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    expect(bodies.map(b => b.max_tokens)).toEqual([32_768, 65_536, 32_768, 32_768, 16_384]);
  });

  // Non-default temperature is a 400; effort goes as output_config (Anthropic)
  // or reasoning.effort (OpenRouter, which lists "max" for it).
  it('sends no temperature, and the tier as each surface spells it', async () => {
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic', { reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic', { reasoningEffort: 'auto' });
    await agentChatFallback(messages, 'system');
    useModel('openrouter', 'anthropic/claude-sonnet-5.5', 'openai', { reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    for (const b of bodies) expect(b).not.toHaveProperty('temperature');
    expect(bodies[0].output_config).toEqual({ effort: 'max' });
    expect(bodies[1]).not.toHaveProperty('output_config');
    expect(bodies[2].reasoning).toEqual({ effort: 'max' });
    // Forced tool_choice (any/tool) is a 400 on Sonnet 5.5, and thinking
    // "disabled" too: the Anthropic bodies send neither field, OpenRouter "auto".
    expect(bodies[0]).not.toHaveProperty('tool_choice');
    expect(bodies[1]).not.toHaveProperty('tool_choice');
    expect(bodies[2].tool_choice).toBe('auto');
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[1]).not.toHaveProperty('thinking');
  });
});

describe('Anthropic replies read by block type', () => {
  const thinkingFirst = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Plain answer.' },
    ],
    stop_reason: 'end_turn',
  };

  // The text-tool fallback read content[0].text, which is the thinking block.
  it('finds the text after a thinking block on the text-tool fallback', async () => {
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic');
    reply = thinkingFirst;
    const res = await agentChatFallback(messages, 'system');
    expect(res.content).toBe('Plain answer.');
  });

  it('finds it on the native path too', async () => {
    useModel('anthropic', 'claude-opus-5-5', 'anthropic');
    reply = thinkingFirst;
    const res = await agentChat(messages, 'system');
    expect(res.content).toBe('Plain answer.');
  });
});

describe('an Anthropic decline', () => {
  const refused = {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: null },
  };

  it('ends the turn on a one-line notice and runs none of its tools (native)', async () => {
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic');
    reply = refused;
    const res = await agentChat(messages, 'system');
    expect(res.content).toBe('Claude declined this request (category: cyber).');
    expect(res.toolCalls).toEqual([]);
  });

  it('does the same on the text-tool fallback', async () => {
    useModel('anthropic', 'claude-sonnet-5-5', 'anthropic');
    reply = { content: [], stop_reason: 'refusal', stop_details: null };
    const res = await agentChatFallback(messages, 'system');
    expect(res.content).toBe('Claude declined this request.');
    expect(res.toolCalls).toEqual([]);
  });
});
