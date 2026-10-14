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
import { REASONING_TIERS } from '../config/providers';
import { getSessionStats, resetTokenTracking } from './tokenTracker';

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

describe('GPT-6.1 Sol agent turns on Chat Completions', () => {
  // "Use the Responses API for tool calling. Chat Completions is supported
  // without tool calling", and "The none and minimal reasoning efforts are not
  // supported" (models/gpt-6.1-sol). Through a proxy the tools request is
  // refused and the text-tool fallback answers — neither may carry "none",
  // which is a 400 of its own. (The refusal's wording is assumed; the
  // fallback keys on the 400.)
  function refuseToolsThenAnswer(): void {
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.tools) {
        return new Response(JSON.stringify({ error: {
          message: 'Function calling is not supported with gpt-6.1-sol on Chat Completions. Use the Responses API.',
          type: 'invalid_request_error',
        } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
    }) as typeof fetch;
  }

  it('never sends GPT-6.1 Sol "none" — the tools request keeps the tier, and so does the fallback', async () => {
    refuseToolsThenAnswer();
    for (const tier of REASONING_TIERS) {
      bodies = [];
      useModel('openai', 'gpt-6.1-sol', 'openai', { reasoningEffort: tier });
      await agentChat(messages, 'system');
      expect(bodies, tier).toHaveLength(2);
      expect(Array.isArray(bodies[0].tools) && (bodies[0].tools as unknown[]).length, tier).toBeTruthy();
      expect(bodies[1].tools, tier).toBeUndefined();
      const expected = tier === 'auto' ? undefined : tier;
      expect(bodies.map(b => b.reasoning_effort), tier).toEqual([expected, expected]);
      for (const b of bodies) expect(b, tier).not.toHaveProperty('temperature');
    }
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

describe('Gemini 4 Argon on the wire', () => {
  // Thinking counts inside max_output_tokens, a hard limit: Google says to raise
  // a limit below 32,768 to at least that, since Argon can spend more of it on
  // thinking. maxTokens 4096 is below even the 16K floor every turn has.
  it('never sends it less than 32K — native, fallback, and via OpenRouter — and 3.8 Flash keeps 16K', async () => {
    useModel('google', 'gemini-4-argon', 'openai', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    useModel('google', 'gemini-4-argon', 'openai', { maxTokens: 4096, reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    useModel('google', 'gemini-4-argon', 'openai', { maxTokens: 4096 });
    await agentChatFallback(messages, 'system');
    useModel('openrouter', 'google/gemini-4-argon', 'openai', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    useModel('google', 'gemini-3.8-flash', 'openai', { maxTokens: 4096 });
    await agentChat(messages, 'system');
    // Max sends `high`, the same request as High, so it gets the same 32K.
    expect(bodies.map(b => b.max_tokens)).toEqual([32_768, 32_768, 32_768, 32_768, 16_384]);
  });

  // 65,536 is Google's own default max_output_tokens; nothing here shows that a
  // plain request is accepted above it (that is the long-decode path).
  it('keeps a larger configured maxTokens', async () => {
    useModel('google', 'gemini-4-argon', 'openai', { maxTokens: 65_536 });
    await agentChat(messages, 'system');
    expect(bodies[0].max_tokens).toBe(65_536);
  });

  // "Remove temperature, top_p, and top_k from your requests. If provided, they
  // are ignored." Every tier goes as a thinking level Argon accepts.
  it('sends no sampling parameters, with the tools, and each tier as low|medium|high', async () => {
    for (const tier of REASONING_TIERS) {
      useModel('google', 'gemini-4-argon', 'openai', { reasoningEffort: tier });
      await agentChat(messages, 'system');
    }
    expect(bodies).toHaveLength(REASONING_TIERS.length);
    for (const b of bodies) {
      expect(b.model).toBe('gemini-4-argon');
      expect(b).not.toHaveProperty('temperature');
      expect(b).not.toHaveProperty('top_p');
      expect(b).not.toHaveProperty('top_k');
      expect(Array.isArray(b.tools) && (b.tools as unknown[]).length).toBeTruthy();
    }
    // auto, low, medium, high, max
    expect(bodies.map(b => b.reasoning_effort)).toEqual([undefined, 'low', 'medium', 'high', 'high']);
  });

  it('sends the tier as reasoning.effort through OpenRouter, Max as high', async () => {
    useModel('openrouter', 'google/gemini-4-argon', 'openai', { reasoningEffort: 'max' });
    await agentChat(messages, 'system');
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0].reasoning).toEqual({ effort: 'high' });
  });

  // Gemini 3.6 Flash still takes a temperature (it is not in the list) — the
  // new entry must not have widened the rule.
  it('still sends a temperature to Gemini 3.6 Flash', async () => {
    useModel('google', 'gemini-3.6-flash', 'openai');
    await agentChat(messages, 'system');
    expect(bodies[0].temperature).toBe(0.7);
  });
});

// The real token tracker, behind the real call sites. agentChat.test.ts and
// agentStream.test.ts mock `extractOpenAIUsage`, so they cannot see whether a
// call site hands it the provider. The figures are the owner's own run of
// Gemini 4 Argon on 2026-10-14: Google's compat usage leaves thinking out of
// completion_tokens, so 7 reported + 153 thinking = 160 billed as output.
describe('Gemini 4 Argon usage: thinking tokens reach the tracker', () => {
  const LIVE = { completion_tokens: 7, prompt_tokens: 47, total_tokens: 207 };

  beforeEach(() => resetTokenTracking());

  function streamedReply(usage: Record<string, unknown>): void {
    const sse = [
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [], usage },
    ].map(chunk => `data: ${JSON.stringify(chunk)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(sse, { status: 200 });
    }) as typeof fetch;
  }

  it('counts them on a non-streamed agent turn', async () => {
    useModel('google', 'gemini-4-argon', 'openai');
    reply = { choices: [{ message: { content: 'done', tool_calls: [] } }], usage: LIVE };
    await agentChat(messages, 'system');
    expect(getSessionStats().totalCompletionTokens).toBe(160);
  });

  it('counts them on a streamed agent turn, from the final chunk', async () => {
    useModel('google', 'gemini-4-argon', 'openai');
    streamedReply(LIVE);
    const result = await agentChat(messages, 'system', () => {});
    expect(result.content).toBe('done');
    expect(getSessionStats().totalCompletionTokens).toBe(160);
  });

  it('counts them on the text-tool fallback', async () => {
    useModel('google', 'gemini-4-argon', 'openai');
    reply = { choices: [{ message: { content: 'done' } }], usage: LIVE };
    await agentChatFallback(messages, 'system');
    expect(getSessionStats().totalCompletionTokens).toBe(160);
  });

  it('does not add a gap on OpenRouter or any other provider', async () => {
    reply = { choices: [{ message: { content: 'done', tool_calls: [] } }], usage: LIVE };
    for (const [provider, model] of [['openrouter', 'google/gemini-4-argon'], ['z.ai', 'glm-5.3']] as const) {
      resetTokenTracking();
      useModel(provider, model, 'openai');
      await agentChat(messages, 'system');
      expect(getSessionStats().totalCompletionTokens, provider).toBe(7);
    }
    resetTokenTracking();
    useModel('openrouter', 'google/gemini-4-argon', 'openai');
    streamedReply(LIVE);
    await agentChat(messages, 'system', () => {});
    expect(getSessionStats().totalCompletionTokens).toBe(7);
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
