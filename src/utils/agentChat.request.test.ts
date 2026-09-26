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
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const openai = { choices: [{ message: { content: 'done', tool_calls: [] } }] };
    const anthropic = { content: [{ type: 'text', text: 'done' }] };
    return new Response(JSON.stringify(cfg.values.protocol === 'anthropic' ? anthropic : openai), { status: 200 });
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
