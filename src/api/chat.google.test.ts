/**
 * chat() with the REAL providers and token tracker, on Google's OpenAI-compatible
 * endpoint: what it records for a thinking model, and what request timer it arms.
 *
 * index.test.ts mocks both modules wholesale (and `extractOpenAIUsage` with
 * them), so it can say that chat() asks the helpers, not that the answers are
 * right. The usage figures here are the owner's own run of Gemini 4 Argon on
 * 2026-10-14, verbatim (scripts/verify-gemini-argon.mjs): thinking is left out
 * of `completion_tokens` and exists only as the gap in `total_tokens`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('../config/index', () => ({
  config: { get: vi.fn((k: string) => cfg.values[k]) },
  getApiKey: vi.fn(() => 'sk-test'),
  resolveBaseUrl: vi.fn(() => 'https://api.example.test'),
  describeUnsendableKey: vi.fn(() => null),
  Message: {},
}));
vi.mock('../utils/ratelimit', () => ({ checkApiRateLimit: vi.fn(() => ({ allowed: true })) }));
vi.mock('../utils/logger', () => ({
  logApiRequest: vi.fn(),
  logApiResponse: vi.fn(),
  logAppError: vi.fn(),
}));
vi.mock('../utils/projectIntelligence', () => ({
  loadProjectIntelligence: vi.fn(() => null),
  generateContextFromIntelligence: vi.fn(() => ''),
}));
vi.mock('../utils/agent', () => ({ loadProjectRules: vi.fn(() => '') }));
vi.mock('../utils/openrouterPrefs', () => ({ readOpenRouterPreferences: vi.fn(() => null) }));

import { chat } from './index';
import { getSessionStats, getCostBreakdown, resetTokenTracking } from '../utils/tokenTracker';

const originalFetch = global.fetch;

/** The usage object of the owner's `effort` request: 7 reported, 153 thinking. */
const LIVE_USAGE = { completion_tokens: 7, prompt_tokens: 47, total_tokens: 207 };

function useModel(provider: string, model: string, extra: Record<string, unknown> = {}): void {
  cfg.values = {
    provider, model, protocol: 'openai', language: 'en',
    apiTimeout: 60_000, temperature: 0.7, maxTokens: 4096, reasoningEffort: 'auto',
    ...extra,
  };
}

function answerWith(usage: Record<string, unknown>): void {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({
    model: 'gemini-4-argon',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '391' } }],
    usage,
  }), { status: 200 })) as typeof fetch;
}

/** A streamed reply whose last chunk carries the usage (stream_options.include_usage). */
function streamWith(usage: Record<string, unknown>): void {
  const lines = [
    `data: ${JSON.stringify({ model: 'gemini-4-argon', choices: [{ delta: { content: '39' } }] })}`,
    `data: ${JSON.stringify({ model: 'gemini-4-argon', choices: [{ delta: { content: '1' } }] })}`,
    `data: ${JSON.stringify({ model: 'gemini-4-argon', choices: [], usage })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
  global.fetch = vi.fn(async () => new Response(lines, { status: 200 })) as typeof fetch;
}

/**
 * Google's compat stream as the owner's run of 2026-10-14 showed it: usage on
 * EVERY chunk (two chunks, two usage objects, the same totals).
 */
function streamWithUsageOnEveryChunk(usage: Record<string, unknown>): void {
  const lines = [
    `data: ${JSON.stringify({ model: 'gemini-4-argon', choices: [{ delta: { role: 'assistant', content: '39' } }], usage })}`,
    `data: ${JSON.stringify({ model: 'gemini-4-argon', choices: [{ delta: { content: '1' }, finish_reason: 'stop' }], usage })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
  global.fetch = vi.fn(async () => new Response(lines, { status: 200 })) as typeof fetch;
}

beforeEach(() => {
  resetTokenTracking();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('chat() on Google: thinking tokens are counted', () => {
  it('a non-streamed reply records completion 160 (7 reported + 153 thinking), and prices it', async () => {
    useModel('google', 'gemini-4-argon');
    answerWith(LIVE_USAGE);
    await chat('What is 17 times 23?');
    expect(getSessionStats().totalCompletionTokens).toBe(160);
    // 47 × $2 + 160 × $10, per 1M.
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.001694, 9);
  });

  it('a streamed reply records it from the final chunk', async () => {
    useModel('google', 'gemini-4-argon');
    streamWith(LIVE_USAGE);
    const seen: string[] = [];
    await chat('What is 17 times 23?', [], c => seen.push(c));
    expect(seen.join('')).toBe('391');
    expect(getSessionStats().totalCompletionTokens).toBe(160);
  });

  it('a streamed reply whose usage rides on every chunk is counted once, not once per chunk', async () => {
    useModel('google', 'gemini-4-argon');
    streamWithUsageOnEveryChunk(LIVE_USAGE);
    await chat('What is 17 times 23?', [], () => {});
    // 7 reported + 153 thinking, once — not 320.
    expect(getSessionStats().totalCompletionTokens).toBe(160);
    expect(getSessionStats().totalPromptTokens).toBe(47);
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.001694, 9);
  });

  it('the same stream with no gap (a plain reply) is counted once too', async () => {
    useModel('google', 'gemini-4-argon');
    streamWithUsageOnEveryChunk({ completion_tokens: 5, prompt_tokens: 38, total_tokens: 43 });
    await chat('hi', [], () => {});
    expect(getSessionStats().totalCompletionTokens).toBe(5);
    expect(getSessionStats().totalPromptTokens).toBe(38);
  });

  it('does the same for any other Google model that reports a gap', async () => {
    useModel('google', 'gemini-3.8-flash');
    answerWith({ completion_tokens: 20, prompt_tokens: 30, total_tokens: 130 });
    await chat('hi');
    expect(getSessionStats().totalCompletionTokens).toBe(100);
  });

  it('leaves OpenRouter\'s google/gemini-4-argon as reported', async () => {
    useModel('openrouter', 'google/gemini-4-argon');
    answerWith(LIVE_USAGE);
    await chat('hi');
    expect(getSessionStats().totalCompletionTokens).toBe(7);
  });

  it('leaves a non-Google provider with a gap as reported', async () => {
    useModel('openai', 'gpt-5.6-sol');
    answerWith(LIVE_USAGE);
    await chat('hi');
    expect(getSessionStats().totalCompletionTokens).toBe(7);
  });

  it('records a Google reply with no gap unchanged', async () => {
    useModel('google', 'gemini-4-argon');
    answerWith({ completion_tokens: 5, prompt_tokens: 38, total_tokens: 43 });
    await chat('hi');
    expect(getSessionStats().totalCompletionTokens).toBe(5);
  });
});

describe('chat() on Gemini 4 Argon: the request timer', () => {
  /** The delays of every timer chat() armed that are request-sized (≥ 10 s). */
  function requestTimers(spy: { mock: { calls: unknown[][] } }): number[] {
    return spy.mock.calls.map((c: unknown[]) => Number(c[1])).filter((ms: number) => ms >= 10_000);
  }

  it('arms 300 s where apiTimeout says 60 s, directly and through OpenRouter', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    useModel('google', 'gemini-4-argon');
    answerWith({ completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 });
    await chat('hi');
    useModel('openrouter', 'google/gemini-4-argon');
    await chat('hi');
    expect(requestTimers(spy)).toEqual([300_000, 300_000]);
  });

  it('keeps apiTimeout for 3.8 Flash and takes a larger one the user set for Argon', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    answerWith({ completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 });
    useModel('google', 'gemini-3.8-flash');
    await chat('hi');
    useModel('google', 'gemini-4-argon', { apiTimeout: 900_000 });
    await chat('hi');
    expect(requestTimers(spy)).toEqual([60_000, 900_000]);
  });
});
