import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordTokenUsage,
  extractOpenAIUsage,
  extractAnthropicUsage,
  getSessionStats,
  getCostBreakdown,
  getLastUsage,
  getPricingTable,
  getModelContextWindow,
  canonicalContextKey,
  formatTokenCount,
  formatCostReport,
  resetTokenTracking,
  getRecordCount,
  createTokenScope,
  runWithTokenScope,
  getCacheStats,
  cacheReadRateFor,
  cacheWriteRateFor,
  formatCacheReadRates,
  formatTokenThreshold,
} from './tokenTracker';
import { canonicalModelId } from '../config/providers';

beforeEach(() => {
  // Each test gets a fresh in-memory record set — the module's `records`
  // array is process-wide otherwise and leaks between tests.
  resetTokenTracking();
});

describe('extractOpenAIUsage', () => {
  it('maps OpenAI fields to canonical TokenUsage shape', () => {
    expect(extractOpenAIUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      .toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('returns null when usage block is missing', () => {
    expect(extractOpenAIUsage({})).toBeNull();
    expect(extractOpenAIUsage(null)).toBeNull();
  });

  it('defaults missing fields to zero', () => {
    expect(extractOpenAIUsage({ usage: {} })).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});

describe('extractAnthropicUsage', () => {
  it('maps Anthropic input/output_tokens', () => {
    expect(extractAnthropicUsage({ usage: { input_tokens: 100, output_tokens: 50 } }))
      .toMatchObject({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it('returns null when usage block is missing', () => {
    expect(extractAnthropicUsage({})).toBeNull();
  });

  it('rolls cache_creation + cache_read into promptTokens and surfaces them separately', () => {
    const usage = extractAnthropicUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      },
    });
    // Anthropic reports input_tokens EXCLUSIVE of cache fields — sum for total.
    expect(usage?.promptTokens).toBe(1100);
    expect(usage?.completionTokens).toBe(50);
    expect(usage?.totalTokens).toBe(1150);
    expect(usage?.cacheCreationTokens).toBe(200);
    expect(usage?.cacheReadTokens).toBe(800);
  });

  it('omits cache fields when they are zero', () => {
    const usage = extractAnthropicUsage({
      usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    expect(usage?.cacheCreationTokens).toBeUndefined();
    expect(usage?.cacheReadTokens).toBeUndefined();
  });
});

describe('getModelContextWindow', () => {
  it('returns a known window for a listed model', () => {
    expect(getModelContextWindow('glm-5.2')).toBe(1_000_000);
    expect(getModelContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(getModelContextWindow('MiniMax-M3')).toBe(1_000_000);
    expect(getModelContextWindow('gemini-3.5-flash')).toBe(1_048_576);
    expect(getModelContextWindow('k3-256k')).toBe(262_144);
    expect(getModelContextWindow('qwen3.8-max-preview')).toBe(1_000_000);
    expect(getModelContextWindow('glm-5.3')).toBe(1_000_000);
    expect(getModelContextWindow('gemini-3.7-flash')).toBe(1_048_576);
    expect(getModelContextWindow('gemini-3.8-flash')).toBe(1_048_576);
    expect(getModelContextWindow('gpt-6-astra')).toBe(1_050_000);
    expect(getModelContextWindow('deepseek-flash')).toBe(1_000_000);
    expect(getModelContextWindow('qwen3.8-max')).toBe(1_000_000);
    expect(getModelContextWindow('qwen3.8-flash')).toBe(1_000_000);
    // Moonshot lists K3 at 1,048,576, not a round million.
    expect(getModelContextWindow('kimi-k3')).toBe(1_048_576);
    expect(getModelContextWindow('grok-4.6')).toBe(500_000);
  });

  // Each of these fell to the 128K fallback before its row existed — a context
  // meter four to eight times too small.
  it('sizes the models added on 2026-09-23', () => {
    expect(getModelContextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(getModelContextWindow('gpt-6-sol')).toBe(1_050_000);
    expect(getModelContextWindow('gpt-6-luna')).toBe(1_050_000);
    expect(getModelContextWindow('grok-4.7')).toBe(500_000);
    expect(getModelContextWindow('glm-5.3-flashx')).toBe(1_000_000);
    // K2.8 Preview since 2026-09-11 — it was sized as K2.7 Code's 256K.
    expect(getModelContextWindow('kimi-for-coding')).toBe(1_048_576);
    expect(getModelContextWindow('kimi-for-coding-highspeed')).toBe(262_144);
    // Kimi's own figure, on Pro/Allegretto (Plus/Moderato: 256K).
    expect(getModelContextWindow('k3')).toBe(1_048_576);
    expect(getModelContextWindow('gemini-3-flash-preview')).toBe(1_048_576);
  });

  it('falls back to 128K for unknown models', () => {
    expect(getModelContextWindow('nonsense-model')).toBe(128_000);
  });

  // OpenRouter sends `vendor/model`, often dotted. The exact lookup alone sized
  // every one at the 128K default, so a run on anthropic/claude-sonnet-5.5 warned
  // "Context at 80% of 128k window" at ~100K of its 1M — where macOS, which
  // canonicalizes, gives 1M. Figures match OpenRouter's /api/v1/models
  // context_length (read 2026-09-29), or sit just under it.
  it('sizes OpenRouter ids by their canonical id', () => {
    expect(getModelContextWindow('anthropic/claude-sonnet-5.5')).toBe(1_000_000);
    expect(getModelContextWindow('anthropic/claude-opus-5.5')).toBe(1_000_000);
    expect(getModelContextWindow('anthropic/claude-fable-5.1')).toBe(1_000_000);
    expect(getModelContextWindow('openai/gpt-6-astra')).toBe(1_050_000);
    expect(getModelContextWindow('google/gemini-3.8-flash')).toBe(1_048_576);
    expect(getModelContextWindow('moonshotai/kimi-k3')).toBe(1_048_576);
    expect(getModelContextWindow('x-ai/grok-4.7')).toBe(500_000);
    expect(getModelContextWindow('z-ai/glm-5.3')).toBe(1_000_000);
    expect(getModelContextWindow('minimax/minimax-m3')).toBe(1_000_000);
    expect(getModelContextWindow('qwen/qwen3.5-397b-a17b')).toBe(262_144);
    // Still the exact rows first.
    expect(getModelContextWindow('glm-5.3')).toBe(1_000_000);
    expect(getModelContextWindow('MiniMax-M3')).toBe(1_000_000);
  });

  // OpenRouter serves GPT-5.5 at 1,050,000, not OpenAI's 1.2M: the canonical
  // match alone would overstate it and hold the warning back past the limit.
  it("uses OpenRouter's own window where it serves less than the vendor", () => {
    expect(getModelContextWindow('openai/gpt-5.5')).toBe(1_050_000);
    expect(getModelContextWindow('gpt-5.5')).toBe(1_200_000);
  });

  it('leaves dated snapshots and ids with no row at the default', () => {
    expect(getModelContextWindow('openrouter/auto')).toBe(128_000);
    expect(getModelContextWindow('deepseek/deepseek-v4-pro-0813')).toBe(128_000);
    expect(getModelContextWindow('qwen/qwen3.8-max-0902')).toBe(128_000);
  });

  // The rule is inlined (tests mock config/providers wholesale); it must stay
  // canonicalModelId's.
  it('canonicalizes exactly as canonicalModelId does', () => {
    for (const id of [
      'anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5', 'Qwen/Qwen3.5-397B-A17B', 'MiniMax-M3',
      'z-ai/glm-5.3', 'glm-5.3-flashx', 'openrouter/auto', 'a/b/c.d', 'gpt-5.4-mini', 'kimi-k2.7-code',
    ]) {
      expect(canonicalContextKey(id)).toBe(canonicalModelId(id));
    }
  });
});

describe('formatTokenCount', () => {
  it('formats under 1K as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });
  it('formats thousands with K suffix and one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(12_345)).toBe('12.3K');
  });
  it('formats millions with M suffix and two decimals', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.00M');
    expect(formatTokenCount(2_345_678)).toBe('2.35M');
  });
});

describe('recordTokenUsage + getSessionStats', () => {
  it('returns zeroed stats on empty session', () => {
    const stats = getSessionStats();
    expect(stats).toEqual({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      estimatedCost: 0,
      billableCost: 0,
      hasFlatFeeUsage: false,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    });
  });

  it('aggregates across multiple records', () => {
    recordTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'glm-5.2', 'z.ai');
    recordTokenUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'glm-5.2', 'z.ai');
    const stats = getSessionStats();
    expect(stats.totalPromptTokens).toBe(300);
    expect(stats.totalCompletionTokens).toBe(150);
    expect(stats.totalTokens).toBe(450);
    expect(stats.requestCount).toBe(2);
    // glm-5.2: 1.40 input, 4.40 output per 1M tokens
    // (300/1M * 1.4) + (150/1M * 4.4) = 0.00042 + 0.00066 = 0.00108
    expect(stats.estimatedCost).toBeCloseTo(0.00108, 6);
  });

  it('aggregates Anthropic cache tokens into session totals', () => {
    // The cloud-stats payload sends totalCacheCreationTokens / totalCacheReadTokens
    // for the dashboard's "saved $X with caching" view. getSessionStats must
    // sum them across all records.
    recordTokenUsage(
      { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheCreationTokens: 500, cacheReadTokens: 300 },
      'claude-sonnet-4-6', 'anthropic',
    );
    recordTokenUsage(
      { promptTokens: 800, completionTokens: 30, totalTokens: 830, cacheCreationTokens: 0, cacheReadTokens: 700 },
      'claude-sonnet-4-6', 'anthropic',
    );
    const stats = getSessionStats();
    expect(stats.totalCacheCreationTokens).toBe(500);
    expect(stats.totalCacheReadTokens).toBe(1000);
  });
});

describe('getCostBreakdown', () => {
  it('groups by provider/model', () => {
    recordTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'glm-5.2', 'z.ai');
    recordTokenUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'claude-opus-5', 'anthropic');
    const breakdown = getCostBreakdown();
    expect(breakdown).toHaveLength(2);
    const glm = breakdown.find(b => b.model === 'glm-5.2');
    expect(glm?.promptTokens).toBe(100);
    expect(glm?.completionTokens).toBe(50);
    expect(glm?.provider).toBe('z.ai');
    // Non-caching providers report 0 in the cache buckets.
    expect(glm?.cacheCreationTokens).toBe(0);
    expect(glm?.cacheReadTokens).toBe(0);
  });

  it('aggregates cache tokens into the cost-breakdown buckets', () => {
    // The cloud-stats call sites send entry.cacheCreationTokens / cacheReadTokens
    // per provider+model group. getCostBreakdown must accumulate them.
    recordTokenUsage(
      { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheCreationTokens: 400, cacheReadTokens: 300 },
      'claude-opus-5', 'anthropic',
    );
    recordTokenUsage(
      { promptTokens: 500, completionTokens: 20, totalTokens: 520, cacheCreationTokens: 100, cacheReadTokens: 600 },
      'claude-opus-5', 'anthropic',
    );
    const breakdown = getCostBreakdown();
    expect(breakdown).toHaveLength(1);
    const b = breakdown[0];
    expect(b.cacheCreationTokens).toBe(500);
    expect(b.cacheReadTokens).toBe(900);
  });

  it('returns cost of 0 for models without pricing entry', () => {
    recordTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'phantom-model', 'phantom');
    const breakdown = getCostBreakdown();
    expect(breakdown[0].estimatedCost).toBe(0);
    expect(breakdown[0].promptTokens).toBe(100);
  });

  it('uses provider-reported actualCostUsd when given (OpenRouter case)', () => {
    // Same model logged twice — once with reported cost, once without.
    // Reported value wins for that record, hardcoded pricing for the other.
    // For a model NOT in our pricing table, the missing record contributes 0.
    recordTokenUsage(
      { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      'meta-llama/llama-3.1-405b-instruct',
      'openrouter',
      0.012,   // explicit USD from OpenRouter
    );
    recordTokenUsage(
      { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 },
      'meta-llama/llama-3.1-405b-instruct',
      'openrouter',
      0.024,
    );
    const breakdown = getCostBreakdown();
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].estimatedCost).toBeCloseTo(0.036, 6);
  });

  it('falls back to local pricing when actualCostUsd is missing', () => {
    recordTokenUsage(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      'glm-5.2',
      'z.ai',
    );
    const breakdown = getCostBreakdown();
    // glm-5.2 pricing: 1.40 USD per 1M input tokens.
    expect(breakdown[0].estimatedCost).toBeCloseTo(1.4, 6);
  });

  it('reads Kimi cache hits, which arrive at the top level and not nested', () => {
    // Kimi returns usage.cached_tokens directly; only reading
    // prompt_tokens_details silently zeroed every one of them.
    const usage = extractOpenAIUsage({
      usage: { prompt_tokens: 10_000, completion_tokens: 200, total_tokens: 10_200, cached_tokens: 8_000 },
    });
    expect(usage?.cacheReadTokens).toBe(8_000);
  });

  it('still prefers the nested field where a provider sends both', () => {
    const usage = extractOpenAIUsage({
      usage: {
        prompt_tokens: 10_000,
        completion_tokens: 200,
        total_tokens: 10_200,
        cached_tokens: 1,
        prompt_tokens_details: { cached_tokens: 8_000 },
      },
    });
    expect(usage?.cacheReadTokens).toBe(8_000);
  });

  it('treats a nested zero as an answer, not as a missing field', () => {
    // A provider reporting "nothing was cached" must not fall through to the
    // top-level key and pick up a stale or unrelated value.
    const usage = extractOpenAIUsage({
      usage: {
        prompt_tokens: 10_000,
        completion_tokens: 200,
        total_tokens: 10_200,
        cached_tokens: 8_000,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    expect(usage?.cacheReadTokens).toBeUndefined();
  });

  /// The exact usage shape DeepSeek's API reference documents: the hit count
  /// appears twice, nested and top-level. It must be read once, not summed.
  it('reads a DeepSeek cache hit once, though DeepSeek reports it twice', () => {
    const usage = extractOpenAIUsage({
      usage: {
        prompt_tokens: 10_000,
        completion_tokens: 200,
        total_tokens: 10_200,
        prompt_tokens_details: { cached_tokens: 9_000 },
        prompt_cache_hit_tokens: 9_000,
        prompt_cache_miss_tokens: 1_000,
      },
    });
    expect(usage?.cacheReadTokens).toBe(9_000);
    expect(usage?.promptTokens).toBe(10_000);
  });

  it('falls back to DeepSeek\'s top-level hit field when the nested one is absent', () => {
    const usage = extractOpenAIUsage({
      usage: { prompt_tokens: 10_000, completion_tokens: 0, total_tokens: 10_000, prompt_cache_hit_tokens: 6_000 },
    });
    expect(usage?.cacheReadTokens).toBe(6_000);
  });

  /// With no DeepSeek entry the 0.1 default applied, and every cached token
  /// billed at five times its price.
  it('bills a DeepSeek V4.1 Flash cache read at 0.02×, not 0.1×', () => {
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheReadTokens: 90_000 },
      'deepseek-flash',
      'deepseek',
    );
    // Uncached 10000 at $0.30/1M = 0.003; cached 90000 at $0.30 * 0.02 = 0.00054
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.00354, 8);
  });

  it('bills a DeepSeek V4 Pro cache read at its own 1/30 ratio', () => {
    expect(cacheReadRateFor('deepseek-v4-pro', 'deepseek')).toBeCloseTo(0.044 / 1.32, 10);
    expect(cacheReadRateFor('deepseek-flash', 'deepseek')).toBe(0.02);
  });

  /// Cost used the per-model rate; savings hardcoded 0.9. So for any provider
  /// not priced like Anthropic, cost and "saved" disagreed with each other.
  it('computes savings at the same rate the cost was billed at', () => {
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheReadTokens: 100_000 },
      'kimi-k2.7-code',
      'kimi-api',
    );
    // Kimi reads at 0.2: saved = 100000/1M * $0.95 * (1 - 0.2) = 0.076, not 0.9's 0.0855.
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.076, 8);

    resetTokenTracking();
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheReadTokens: 100_000 },
      'deepseek-flash',
      'deepseek',
    );
    // DeepSeek reads at 0.02: saved = 100000/1M * $0.30 * 0.98 = 0.0294
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.0294, 8);
  });

  it('states the rate that applied instead of assuming 0.1×', () => {
    recordTokenUsage(
      { promptTokens: 50_000, completionTokens: 0, totalTokens: 50_000, cacheReadTokens: 40_000 },
      'deepseek-flash',
      'deepseek',
    );
    const report = formatCostReport();
    expect(report).toContain('billed at 0.02× input rate');
    expect(report).not.toContain('0.1×');
  });

  it('shows a range when a session mixes cache rates, because one number would be wrong', () => {
    expect(formatCacheReadRates([0.02, 0.2, 0.02])).toBe(' (billed at 0.02×–0.2× input rate, by model)');
    expect(formatCacheReadRates([0.1])).toBe(' (billed at 0.1× input rate)');
    expect(formatCacheReadRates([0.044 / 1.32])).toBe(' (billed at 0.033× input rate)');
    expect(formatCacheReadRates([])).toBe('');
  });

  it('bills a Kimi cache read at its own rate, not Anthropic\'s', () => {
    // kimi-k2.7-code lists $0.19 cache-hit against $0.95 cache-miss — 0.2×,
    // where the hardcoded 0.1× charged half of what the read actually costs.
    recordTokenUsage(
      {
        promptTokens: 10_000,
        completionTokens: 0,
        totalTokens: 10_000,
        cacheReadTokens: 8_000,
      },
      'kimi-k2.7-code',
      'kimi-api',
    );
    const breakdown = getCostBreakdown();
    // Uncached = 2000 at 1.0× = (2000/1M) * 0.95 = 0.0019
    // Cache read = 8000 at 0.2× = (8000/1M) * 0.95 * 0.2 = 0.00152
    expect(breakdown[0].estimatedCost).toBeCloseTo(0.00342, 6);
  });

  it('bills a Qwen cache read at the 20% Alibaba documents', () => {
    recordTokenUsage(
      { promptTokens: 10_000, completionTokens: 0, totalTokens: 10_000, cacheReadTokens: 10_000 },
      'qwen3.7-max',
      'qwen-api',
    );
    // qwen3.7-max input rate is $2.50/1M; every prompt token here was a cache
    // hit, so the whole bill is 10000 * 2.50/1M * 0.2.
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.005, 8);
  });

  it('prices Sonnet 5 at the rate that became permanent, not the one it nearly rose to', () => {
    // The $2/$10 launch rate was billed as introductory through 2026-08-31 and
    // the scheduled rise to $3/$15 was cancelled. Nothing failed when the table
    // still said $3 — the number was simply 50% high with no test to notice.
    const sonnet = getPricingTable().find(m => m.model === 'claude-sonnet-5');
    expect(sonnet).toMatchObject({ inputPer1M: 2, outputPer1M: 10 });
  });

  it('knows Claude Fable 5.1, and does not fall back to Fable 5', () => {
    expect(getPricingTable().find(m => m.model === 'claude-fable-5-1'))
      .toMatchObject({ inputPer1M: 10, outputPer1M: 50 });
    expect(getModelContextWindow('claude-fable-5-1')).toBe(1_000_000);
  });

  it('bills a Fable 5.1 cache read at 0.025×, which is its own and not Anthropic\'s', () => {
    // Every other Anthropic model reads a cached token at 0.1×; this one is a
    // quarter of that, so the provider-level rate would overcharge fourfold.
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheReadTokens: 100_000 },
      'claude-fable-5-1',
      'anthropic',
    );
    // 100000/1M * $10 * 0.025 = 0.025
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.025, 8);
  });

  it('applies Anthropic cache pricing (read 0.1×, write 1.25×)', () => {
    // Claude Opus 4.7 input rate is $5/1M. Verify the multipliers land.
    recordTokenUsage(
      {
        promptTokens: 11_000,                  // input + cache_create + cache_read
        completionTokens: 0,
        totalTokens: 11_000,
        cacheCreationTokens: 1_000,
        cacheReadTokens: 9_000,
      },
      'claude-opus-5',
      'anthropic',
    );
    const breakdown = getCostBreakdown();
    // Uncached prompt = 11000 - 1000 - 9000 = 1000 tokens at 1.0× ($5/1M = 0.005)
    // Cache write = 1000 at 1.25× = (1000/1M) * 5 * 1.25 = 0.00625
    // Cache read  = 9000 at 0.1×  = (9000/1M) * 5 * 0.1  = 0.0045
    // Total ≈ 0.005 + 0.00625 + 0.0045 = 0.01575
    expect(breakdown[0].estimatedCost).toBeCloseTo(0.01575, 6);
  });

  // "On Claude Opus 5.5, a cache hit costs 5% of the standard input price".
  it('prices Opus 5.5 at $4/$20 and reads its cache at 0.05×', () => {
    expect(getPricingTable().find(m => m.model === 'claude-opus-5-5'))
      .toMatchObject({ inputPer1M: 4, outputPer1M: 20 });
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheReadTokens: 100_000 },
      'claude-opus-5-5',
      'anthropic',
    );
    // 100000/1M * $4 * 0.05 = 0.02
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.02, 8);
  });

  it('mixes reported + computed costs in the same session', () => {
    recordTokenUsage(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      'glm-5.2',
      'z.ai',
    );
    recordTokenUsage(
      { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      'anthropic/claude-opus-4',
      'openrouter',
      0.025,
    );
    const breakdown = getCostBreakdown();
    expect(breakdown).toHaveLength(2);
    const total = breakdown.reduce((s, b) => s + b.estimatedCost, 0);
    // glm-5.2: (100/1M * 1.4) + (50/1M * 4.4) = 0.00014 + 0.00022 = 0.00036
    // openrouter: 0.025 (reported)
    // total ≈ 0.02536
    expect(total).toBeCloseTo(0.02536, 5);
  });
});

describe('getLastUsage', () => {
  it('returns null when no records exist', () => {
    expect(getLastUsage()).toBeNull();
  });
  it('returns the most recent record', () => {
    recordTokenUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, 'a', 'p');
    recordTokenUsage({ promptTokens: 10, completionTokens: 10, totalTokens: 20 }, 'b', 'p');
    expect(getLastUsage()?.model).toBe('b');
  });
});

describe('getPricingTable', () => {
  it('lists every priced model', () => {
    const table = getPricingTable();
    const ids = table.map(e => e.model);
    expect(ids).toContain('glm-5.2');
    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('uses current OpenAI and Gemini list prices', () => {
    const byModel = new Map(getPricingTable().map(entry => [entry.model, entry]));
    expect(byModel.get('gpt-5.6-terra')).toMatchObject({ inputPer1M: 2, outputPer1M: 12 });
    expect(byModel.get('gpt-5.6-luna')).toMatchObject({ inputPer1M: 0.2, outputPer1M: 1.2 });
    expect(byModel.get('gemini-3.5-flash')).toMatchObject({ inputPer1M: 1.5, outputPer1M: 9 });
    // Gemini 3.6/3.7 Flash bill the promotional rate that runs to 2026-12-31 —
    // storing the post-promotional 1.50/7.50 doubled every Gemini estimate.
    expect(byModel.get('gemini-3.7-flash')).toMatchObject({ inputPer1M: 0.75, outputPer1M: 3.75 });
    expect(byModel.get('gemini-3.6-flash')).toMatchObject({ inputPer1M: 0.75, outputPer1M: 3.75 });
    // 3.8 Flash ships at the same promotional rate as 3.7, not at the 1.50/7.50
    // it is scheduled to move to — that date has not arrived and such a rise has
    // been cancelled before.
    expect(byModel.get('gemini-3.8-flash')).toMatchObject({ inputPer1M: 0.75, outputPer1M: 3.75 });
    // GPT-6 Astra is twice 5.6 Sol; a run priced at Sol's rate reads half true.
    // No longer offered, but restored sessions still price.
    expect(byModel.get('gpt-6-astra')).toMatchObject({ inputPer1M: 10, outputPer1M: 50 });
    expect(byModel.get('gpt-6-sol')).toMatchObject({ inputPer1M: 2, outputPer1M: 10 });
    expect(byModel.get('gpt-6-luna')).toMatchObject({ inputPer1M: 0.1, outputPer1M: 0.5 });
    // DeepSeek carries PEAK. The old rows were 2–4.6x below it — under-reporting,
    // the one direction this table must never err in.
    expect(byModel.get('deepseek-flash')).toMatchObject({ inputPer1M: 0.30, outputPer1M: 1.20 });
    expect(byModel.get('deepseek-v4-flash')).toMatchObject({ inputPer1M: 0.30, outputPer1M: 1.20 });
    expect(byModel.get('deepseek-v4-pro')).toMatchObject({ inputPer1M: 1.32, outputPer1M: 3.96 });
    // Sol's promotional rate, billed now; no end date written ahead of time.
    expect(byModel.get('gpt-5.6-sol')).toMatchObject({ inputPer1M: 4, outputPer1M: 20 });
    // M3 up to 512K prompt tokens — the 0.60/2.40 tier doubled nearly every estimate.
    expect(byModel.get('MiniMax-M3')).toMatchObject({ inputPer1M: 0.30, outputPer1M: 1.20 });
    expect(byModel.get('qwen3.8-max')).toMatchObject({ inputPer1M: 2, outputPer1M: 6 });
    expect(byModel.get('qwen3.8-flash')).toMatchObject({ inputPer1M: 0.15, outputPer1M: 0.47 });
    // Grok 4.6 inherits 4.5's base-tier rate, and 4.7 keeps it.
    expect(byModel.get('grok-4.6')).toMatchObject({ inputPer1M: 2, outputPer1M: 6 });
    expect(byModel.get('grok-4.7')).toMatchObject({ inputPer1M: 2, outputPer1M: 6 });
    // Alibaba lists 3.6 Plus at $0.5/$3 up to 256K; the row carried 3.5 Plus's.
    expect(byModel.get('qwen3.6-plus')).toMatchObject({ inputPer1M: 0.5, outputPer1M: 3 });
    expect(byModel.get('glm-5.3-flashx')).toMatchObject({ inputPer1M: 0.37, outputPer1M: 1.25 });
  });

  it('prices GLM-5.3 at the rate Z.AI publishes', () => {
    // It was deliberately unpriced while the standalone API was "coming soon";
    // the rate below is the one on docs.z.ai, not GLM-5.2's borrowed.
    const byModel = new Map(getPricingTable().map(e => [e.model, e]));
    expect(byModel.get('glm-5.3')).toMatchObject({ inputPer1M: 1.40, outputPer1M: 4.40 });
  });

  it('only contains models that also have context-window entries', () => {
    // Cleanup invariant: pricing and context-window tables must stay in lockstep
    // (we burned that lesson in 1.3.42 / 1.4.0 — see CHANGELOG).
    for (const entry of getPricingTable()) {
      expect(getModelContextWindow(entry.model)).not.toBe(128_000); // 128_000 is the unknown-fallback
    }
  });
});

describe('formatCostReport', () => {
  it('returns the empty-session message when no requests have been recorded', () => {
    const report = formatCostReport();
    expect(report).toMatch(/no API requests/i);
  });

  it('renders requests, tokens, and total cost', () => {
    recordTokenUsage({ promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 }, 'claude-opus-5', 'anthropic');
    const report = formatCostReport();
    expect(report).toMatch(/## Session Cost/);
    expect(report).toMatch(/\*\*Requests:\*\* 1/);
    expect(report).toMatch(/1\.0K/);  // prompt 1000 → "1.0K"
    expect(report).toMatch(/\*\*Estimated cost:\*\* \$0\./);
  });

  it('never prices a flat-fee provider — tokens stay, dollars do not', () => {
    recordTokenUsage({ promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 }, 'glm-5.2', 'z.ai');
    const report = formatCostReport();
    expect(report).toContain('**Estimated cost:** included in plan');
    expect(report).not.toMatch(/\$\d/);
    expect(report).toMatch(/1\.0K/);  // token counts are measured, not priced
  });

  it('totals only the pay-per-use entries in a mixed session, and says so', () => {
    // Flat-fee (Kimi Code subscription) + pay-per-use (Anthropic) in one session.
    recordTokenUsage({ promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 }, 'kimi-for-coding', 'kimi');
    recordTokenUsage({ promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 }, 'claude-opus-5', 'anthropic');
    const report = formatCostReport();
    // Anthropic only: (1000/1M * 5) + (500/1M * 25) = 0.0175 — the Kimi tokens
    // would have added ~0.0029 at its notional rate.
    expect(report).toContain('**Estimated cost:** $0.0175 + usage included in plan');
    expect(report).toMatch(/`kimi` \/ `kimi-for-coding` \|.*\| included in plan \|/);
    expect(report).toMatch(/`anthropic` \/ `claude-opus-5` \|.*\| \$0\.0175 \|/);
  });

  it('includes a per-model table when multiple providers/models are used', () => {
    recordTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'glm-5.2', 'z.ai');
    recordTokenUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'claude-opus-5', 'anthropic');
    const report = formatCostReport();
    expect(report).toMatch(/\| Provider \/ Model \| Input \| Output \| Cost \|/);
    expect(report).toMatch(/`z\.ai` \/ `glm-5\.2`/);
    expect(report).toMatch(/`anthropic` \/ `claude-opus-5`/);
  });

  it('flags models that produced tokens but no priced cost', () => {
    recordTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'phantom-x1', 'phantom');
    const report = formatCostReport();
    expect(report).toMatch(/no pricing entry/i);
    expect(report).toMatch(/phantom-x1/);
  });
});

describe('per-run reporting delta (finding cli-6)', () => {
  it('prices only records after the marker while cumulative totals survive', () => {
    // A prior chat turn.
    recordTokenUsage({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, 'claude-opus-5', 'anthropic');
    // Marker captured at the start of an agent run/prompt (was a destructive
    // resetTokenTracking() before the fix — which wiped the 1500 above).
    const marker = getRecordCount();
    recordTokenUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'claude-opus-5', 'anthropic');

    // Cloud telemetry gets ONLY this run's delta.
    const delta = getCostBreakdown(marker);
    expect(delta).toHaveLength(1);
    expect(delta[0].promptTokens).toBe(200);
    expect(delta[0].completionTokens).toBe(100);

    // Status bar + /cost still see BOTH turns — the cumulative store is not wiped.
    const full = getCostBreakdown();
    expect(full[0].promptTokens).toBe(1200);
    expect(full[0].completionTokens).toBe(600);
    expect(getSessionStats().totalTokens).toBe(1800);
    expect(getSessionStats().requestCount).toBe(2);
  });
});

describe('runWithTokenScope isolation (finding cli-11 — concurrent ACP sessions)', () => {
  it('keeps each scope\'s records independent even when interleaved', async () => {
    // Two ACP sessions whose prompt lifecycles overlap on one process. Each
    // records into its own scope buffer; neither should see the other, and the
    // default (out-of-scope) buffer must stay untouched. Manual gates force the
    // interleave A → B(record+reset) → A so we exercise the exact clobber the
    // old shared-array design suffered.
    const scopeA = createTokenScope();
    const scopeB = createTokenScope();

    let releaseA!: () => void;
    let releaseB!: () => void;
    const aStarted = new Promise<void>((r) => { releaseA = r; });
    const bRecorded = new Promise<void>((r) => { releaseB = r; });

    const sessionA = runWithTokenScope(scopeA, async () => {
      recordTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'claude-opus-5', 'anthropic');
      releaseA();
      await bRecorded;      // let B record (and reset its own scope) in between
      recordTokenUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'claude-opus-5', 'anthropic');
      return getCostBreakdown();
    });

    const sessionB = runWithTokenScope(scopeB, async () => {
      await aStarted;
      resetTokenTracking(); // clears only scope B — must NOT wipe session A's records
      recordTokenUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }, 'glm-5.2', 'z.ai');
      releaseB();
      return getCostBreakdown();
    });

    const [a, b] = await Promise.all([sessionA, sessionB]);

    // A sees only its two opus records (110/55), never B's glm usage.
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', promptTokens: 110, completionTokens: 55 });

    // B sees only its glm record.
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ provider: 'z.ai', model: 'glm-5.2', promptTokens: 200, completionTokens: 100 });

    // The default (out-of-scope) buffer is untouched by either session.
    expect(getCostBreakdown()).toHaveLength(0);
  });
});

describe('prompt-caching savings vs flat-fee plans', () => {
  // A plan bills a flat fee, so cached tokens save latency but not money.
  // Pricing them would invent a dollar figure — the same class of bug the
  // per-model cost lines were fixed for.
  const cached = { promptTokens: 1_000_000, completionTokens: 1_000, totalTokens: 1_001_000,
                   cacheCreationTokens: 100_000, cacheReadTokens: 900_000 };

  it('counts plan cache tokens but prices none of them', () => {
    recordTokenUsage(cached, 'glm-5.2', 'z.ai');       // Coding Plan → flat fee
    const cache = getCacheStats();
    expect(cache.cacheReadTokens).toBe(900_000);       // measured, still reported
    expect(cache.cacheCreationTokens).toBe(100_000);
    expect(cache.estimatedSavingsUsd).toBe(0);         // no invented dollars
    expect(cache.isEntirelyFlatFeeCache).toBe(true);

    const report = formatCostReport();
    expect(report).toContain('caching saves latency, not money');
    expect(report).not.toMatch(/Estimated savings vs no caching:\s*\$[1-9]/);
    // The billing multipliers describe a metered account and must not appear.
    expect(report).not.toContain('billed at 0.1');
  });

  it('prices only the pay-per-use half of a mixed session, and says so', () => {
    recordTokenUsage(cached, 'glm-5.2', 'z.ai');        // plan
    recordTokenUsage(cached, 'claude-opus-5', 'anthropic'); // metered
    const cache = getCacheStats();
    expect(cache.cacheReadTokens).toBe(1_800_000);      // both sides counted
    expect(cache.hasFlatFeeCacheUsage).toBe(true);
    expect(cache.isEntirelyFlatFeeCache).toBe(false);
    // Anthropic alone: 0.9M read x $5/1M x 0.9 - 0.1M write x $5 x 0.25 = 3.925
    expect(cache.estimatedSavingsUsd).toBeCloseTo(3.925, 3);

    const report = formatCostReport();
    expect(report).toContain('(pay-per-use models only)');
    expect(report).toContain('billed at 0.1');          // metered usage exists
  });

  it('leaves an all-metered session exactly as it was', () => {
    recordTokenUsage(cached, 'claude-opus-5', 'anthropic');
    const cache = getCacheStats();
    expect(cache.hasFlatFeeCacheUsage).toBe(false);
    expect(cache.estimatedSavingsUsd).toBeCloseTo(3.925, 3);
    const report = formatCostReport();
    expect(report).toContain('Estimated savings vs no caching:');
    expect(report).not.toContain('pay-per-use models only');
  });
});

describe('cache writes on the OpenAI protocol (GPT-5.6+, Kimi K3)', () => {
  // "For GPT-5.6 and later, cache writes cost 1.25× the standard, uncached
  // input-token rate", reported as prompt_tokens_details.cache_write_tokens and
  // included in prompt_tokens. Unread, they billed at 1.0× and estimates erred low.
  it('reads cache_write_tokens as cache creation', () => {
    expect(extractOpenAIUsage({
      usage: {
        prompt_tokens: 10_000, completion_tokens: 100, total_tokens: 10_100,
        prompt_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 3_000 },
      },
    })).toEqual({
      promptTokens: 10_000, completionTokens: 100, totalTokens: 10_100,
      cacheCreationTokens: 3_000, cacheReadTokens: 6_000,
    });
    // Zero or missing leaves the field out, as for reads.
    expect(extractOpenAIUsage({ usage: { prompt_tokens: 5, prompt_tokens_details: { cache_write_tokens: 0 } } })!
      .cacheCreationTokens).toBeUndefined();
  });

  it('bills a GPT-5.6 cache write at 1.25× and subtracts it from the uncached part once', () => {
    const usage = extractOpenAIUsage({
      usage: {
        prompt_tokens: 100_000, completion_tokens: 0, total_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 },
      },
    })!;
    recordTokenUsage(usage, 'gpt-5.6-sol', 'openai');
    // 100000/1M * $4 * 1.25 = 0.5 — not 0.4 (writes as plain input), and not
    // 0.9 (writes counted again on top of prompt_tokens).
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.5, 8);
  });

  it('bills a Kimi K3 write at the plain input rate, which is what its 5-minute write costs', () => {
    expect(cacheWriteRateFor('kimi-k3', 'kimi-api')).toBe(1);
    expect(cacheWriteRateFor('kimi-k3', 'kimi-cn')).toBe(1);
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheCreationTokens: 100_000 },
      'kimi-k3',
      'kimi-api',
    );
    // 100000/1M * $3 * 1.0 = 0.3
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.3, 8);
  });

  it('charges no write premium before GPT-5.6, and 1.25× on Anthropic and GPT-6', () => {
    expect(cacheWriteRateFor('gpt-5.5', 'openai')).toBe(1);
    expect(cacheWriteRateFor('gpt-5.4-mini', 'openai')).toBe(1);
    expect(cacheWriteRateFor('gpt-6-sol', 'openai')).toBe(1.25);
    expect(cacheWriteRateFor('claude-opus-5-5', 'anthropic')).toBe(1.25);
  });

  it('nets the write premium it actually charged into savings, and states it', () => {
    recordTokenUsage(
      {
        promptTokens: 200_000, completionTokens: 0, totalTokens: 200_000,
        cacheCreationTokens: 100_000, cacheReadTokens: 100_000,
      },
      'kimi-k3',
      'kimi-api',
    );
    // Reads save 100000/1M * $3 * (1 - 0.1) = 0.27. A Kimi write costs nothing
    // extra, so it takes nothing off that; a 1.25× premium would take 0.075.
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.27, 8);
    expect(getCacheStats().cacheWriteRates).toEqual([1]);
    const report = formatCostReport();
    expect(report).toContain('**Cache writes:** 100.0K tokens (billed at 1× input rate)');
    expect(report).not.toContain('1.25×');
  });
});

describe('cache-read rates from the 2026-09-23 sweep', () => {
  it('reads Kimi K3 at a tenth, and China K2.x at a fifth', () => {
    // $0.30 against $3.00 — the provider's 0.2 billed every K3 hit twice.
    expect(cacheReadRateFor('kimi-k3', 'kimi-api')).toBe(0.1);
    expect(cacheReadRateFor('kimi-k3', 'kimi-cn')).toBe(0.1);
    expect(cacheReadRateFor('k3', 'kimi')).toBe(0.1);
    expect(cacheReadRateFor('k3-256k', 'kimi')).toBe(0.1);
    // ¥1.30 against ¥6.50; kimi-cn had no entry and fell to 0.1.
    expect(cacheReadRateFor('kimi-k2.7-code', 'kimi-cn')).toBe(0.2);
    expect(cacheReadRateFor('kimi-k2.7-code', 'kimi-api')).toBe(0.2);
  });

  it('reads each Grok model at its own cached-input ratio, none of them 0.1', () => {
    expect(cacheReadRateFor('grok-4.7', 'grok')).toBeCloseTo(0.25, 10);
    expect(cacheReadRateFor('grok-4.6', 'grok')).toBeCloseTo(0.25, 10);
    expect(cacheReadRateFor('grok-4.5', 'grok')).toBeCloseTo(0.15, 10);
    expect(cacheReadRateFor('grok-build-0.1', 'grok')).toBeCloseTo(0.2, 10);
    expect(cacheReadRateFor('grok-4.3', 'grok')).toBeCloseTo(0.16, 10);
  });

  // The same GLM id caches at a different ratio on each platform, so the rate
  // is looked up per surface first.
  it('reads GLM at the ratio of the platform it ran on', () => {
    expect(cacheReadRateFor('glm-5.3', 'z.ai-api')).toBeCloseTo(0.26 / 1.4, 10);
    expect(cacheReadRateFor('glm-5.3', 'z.ai-cn-api')).toBeCloseTo(0.25, 10);
    expect(cacheReadRateFor('glm-5.3-flash', 'z.ai-api')).toBeCloseTo(0.2, 10);
    expect(cacheReadRateFor('glm-5.3-flash', 'z.ai-cn-api')).toBeCloseTo(0.2875, 10);
    expect(cacheReadRateFor('glm-5.3-flashx', 'z.ai-api')).toBeCloseTo(0.075 / 0.37, 10);
    expect(cacheReadRateFor('glm-5.3-flashx', 'z.ai-cn-api')).toBeCloseTo(0.285, 10);
    // A surface with no row keeps its old lookup.
    expect(cacheReadRateFor('qwen3.7-max', 'qwen-api')).toBe(0.2);
  });

  it('bills a China GLM-5.3 cache read at China\'s ratio', () => {
    recordTokenUsage(
      { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000, cacheReadTokens: 100_000 },
      'glm-5.3',
      'z.ai-cn-api',
    );
    // 100000/1M * $1.40 * 0.25 = 0.035
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.035, 8);
  });
});

// Claude Sonnet 5.5 (2026-09-28): "the same prices as Claude Sonnet 5,
// including prompt caching" — $2 / $10, 5-minute write $2.50, cache read $0.20,
// 1M context. Each asserted against its own row, not Sonnet 5's.
describe('Claude Sonnet 5.5', () => {
  it('sizes its context at 1M', () => {
    expect(getModelContextWindow('claude-sonnet-5-5')).toBe(1_000_000);
  });

  it('prices it at $2 in / $10 out per MTok', () => {
    expect(getPricingTable().find(m => m.model === 'claude-sonnet-5-5'))
      .toEqual({ model: 'claude-sonnet-5-5', inputPer1M: 2, outputPer1M: 10 });
    recordTokenUsage(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      'claude-sonnet-5-5',
      'anthropic',
    );
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(12, 8);
  });

  // $0.20 / $2 = 0.1 and $2.50 / $2 = 1.25: Anthropic's defaults. Opus 5.5 reads
  // at the same $0.20, but against $4 — its 0.05 row must not apply here.
  it('reads the cache at 0.1× ($0.20) and writes it at 1.25× ($2.50)', () => {
    expect(cacheReadRateFor('claude-sonnet-5-5', 'anthropic')).toBe(0.1);
    expect(cacheWriteRateFor('claude-sonnet-5-5', 'anthropic')).toBe(1.25);
    recordTokenUsage(
      {
        promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000,
        cacheCreationTokens: 500_000, cacheReadTokens: 500_000,
      },
      'claude-sonnet-5-5',
      'anthropic',
    );
    // 0.5M written at $2.50 + 0.5M read at $0.20 = 1.25 + 0.10
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(1.35, 8);
    // Reads save 0.5M * ($2 - $0.20) = 0.90; the write premium costs 0.5M * $0.50 = 0.25.
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.65, 8);
  });

  // On OpenRouter the table is not consulted: the call's own `usage.cost` is.
  it('bills OpenRouter\'s anthropic/claude-sonnet-5.5 at the cost OpenRouter reports', () => {
    recordTokenUsage(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      'anthropic/claude-sonnet-5.5',
      'openrouter',
      0.0421,
    );
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(0.0421, 8);
  });
});

// GPT-6.1 Sol (2026-09-30, models/gpt-6.1-sol): $2 / $10 like GPT-6 Sol, but
// "Cached input tokens are priced at 5% of the uncached input token rate"
// ($0.10; GPT-6 Sol's is 10%), cache writes $2.50 (1.25×), and a 1,050,000
// context. Each asserted against its own row: `gpt-6.1-sol` canonicalizes to
// `gpt-6-1-sol`, which no `gpt-6-sol` row or prefix reaches.
describe('GPT-6.1 Sol', () => {
  it('sizes GPT-6.1 Sol at 1,050,000, by its OpenRouter id too', () => {
    expect(getModelContextWindow('gpt-6.1-sol')).toBe(1_050_000);
    expect(getModelContextWindow('openai/gpt-6.1-sol')).toBe(1_050_000);
  });

  it('prices GPT-6.1 Sol at $2 in / $10 out per MTok', () => {
    expect(getPricingTable().find(m => m.model === 'gpt-6.1-sol'))
      .toEqual({ model: 'gpt-6.1-sol', inputPer1M: 2, outputPer1M: 10 });
    recordTokenUsage(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      'gpt-6.1-sol',
      'openai',
    );
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(12, 8);
  });

  it('reads the GPT-6.1 Sol cache at 0.05× ($0.10) and writes it at 1.25× ($2.50)', () => {
    expect(cacheReadRateFor('gpt-6.1-sol', 'openai')).toBe(0.05);
    expect(cacheWriteRateFor('gpt-6.1-sol', 'openai')).toBe(1.25);
    // The previous Sol keeps its 10%.
    expect(cacheReadRateFor('gpt-6-sol', 'openai')).toBe(0.1);
    recordTokenUsage(
      {
        promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000,
        cacheCreationTokens: 500_000, cacheReadTokens: 500_000,
      },
      'gpt-6.1-sol',
      'openai',
    );
    // 0.5M written at $2.50 + 0.5M read at $0.10 = 1.25 + 0.05
    expect(getCostBreakdown()[0].estimatedCost).toBeCloseTo(1.30, 8);
    // Reads save 0.5M * ($2 - $0.10) = 0.95; the write premium costs 0.5M * $0.50 = 0.25.
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.70, 8);
    expect(getCacheStats().cacheReadRates).toEqual([0.05]);
  });
});

// Claude Haiku 5.5 (2026-10-07): the one Claude model here priced by prompt length. A
// request whose prompt is OVER 100,000 tokens pays $0.50 in / $2.50 out for the
// whole request; up to 100,000 it is $0.10 / $0.50. "A request's prompt length
// counts all of its input tokens, including cache reads and cache writes. Each
// request is priced on its own: a request over the threshold pays the higher
// prices even when part of its prompt is a cache hit." The cache multiples are
// the usual ones in both tiers: read $0.01 / $0.05, 5-minute write $0.125 /
// $0.625 (platform.claude.com pricing, read 2026-10-09).
describe('Claude Haiku 5.5 (priced by prompt length)', () => {
  const HAIKU = 'claude-haiku-5-5';
  const cost = () => getCostBreakdown()[0].estimatedCost;
  const record = (
    promptTokens: number,
    completionTokens: number,
    cache: { read?: number; write?: number } = {},
    model = HAIKU,
    provider = 'anthropic',
    reportedUsd?: number,
  ) => recordTokenUsage(
    {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheReadTokens: cache.read,
      cacheCreationTokens: cache.write,
    },
    model,
    provider,
    reportedUsd,
  );

  it('sizes its context at 1M, by its OpenRouter id too, where Haiku 4.5 keeps 200K', () => {
    expect(getModelContextWindow(HAIKU)).toBe(1_000_000);
    expect(getModelContextWindow('anthropic/claude-haiku-5.5')).toBe(1_000_000);
    expect(getModelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('carries the tier in the pricing table, and only on the model that has one', () => {
    const rows = getPricingTable();
    expect(rows.find(m => m.model === HAIKU)).toEqual({
      model: HAIKU, inputPer1M: 0.1, outputPer1M: 0.5,
      longPrompt: { overTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5 },
    });
    // Every other row is what it was before the tier existed: no key at all.
    expect(rows.filter(m => 'longPrompt' in m).map(m => m.model)).toEqual([HAIKU]);
    // A caller cannot edit the table through a row it was handed.
    rows.find(m => m.model === HAIKU)!.longPrompt!.inputPer1M = 999;
    expect(getPricingTable().find(m => m.model === HAIKU)!.longPrompt!.inputPer1M).toBe(0.5);
  });

  it('prices a prompt of exactly 100,000 tokens at the lower tier and 100,001 at the higher', () => {
    record(100_000, 10_000);
    // 100,000 * $0.10/M + 10,000 * $0.50/M = 0.010 + 0.005
    expect(cost()).toBeCloseTo(0.015, 8);
    resetTokenTracking();
    record(100_001, 10_000);
    // 100,001 * $0.50/M + 10,000 * $2.50/M = 0.0500005 + 0.025
    expect(cost()).toBeCloseTo(0.0750005, 8);
    resetTokenTracking();
    record(99_999, 10_000);
    expect(cost()).toBeCloseTo(0.0149999, 8);
  });

  it('bills EVERY token of a long request at the higher rate, not only those past the line', () => {
    record(150_000, 20_000);
    // 150,000 * $0.50/M + 20,000 * $2.50/M = 0.075 + 0.05. Marginal pricing
    // would give 0.01 + 0.025 + 0.01.
    expect(cost()).toBeCloseTo(0.125, 8);
    expect(getSessionStats().estimatedCost).toBeCloseTo(0.125, 8);
  });

  // The threshold is measured on the prompt as Anthropic counts it: input_tokens
  // plus cache creation plus cache reads. extractAnthropicUsage already hands over
  // that sum as promptTokens.
  it('counts cache reads toward the prompt length: a long prompt with a cache hit is still long', () => {
    // 10,000 uncached + 100,000 read = 110,000: over the line.
    record(110_000, 0, { read: 100_000 });
    // 10,000 * $0.50/M + 100,000 * $0.05/M = 0.005 + 0.005. Judged on the 10,000
    // uncached tokens alone it would be 0.001 + 0.001.
    expect(cost()).toBeCloseTo(0.01, 8);
  });

  it('counts cache writes toward the prompt length too', () => {
    // 20,000 uncached + 100,000 written = 120,000: over the line.
    record(120_000, 0, { write: 100_000 });
    // 20,000 * $0.50/M + 100,000 * $0.625/M = 0.01 + 0.0625
    expect(cost()).toBeCloseTo(0.0725, 8);
  });

  it('reads the prompt length off what Anthropic reports, cache fields included', () => {
    const usage = extractAnthropicUsage({
      usage: { input_tokens: 10_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000 },
    })!;
    recordTokenUsage(usage, HAIKU, 'anthropic');
    expect(getLastUsage()!.promptTokens).toBe(110_000);
    expect(cost()).toBeCloseTo(0.01, 8);
  });

  it('keeps the cache multiples of the usual 0.1× read and 1.25× write in both tiers', () => {
    // No row in the rate tables: they are the defaults for Anthropic.
    expect(cacheReadRateFor(HAIKU, 'anthropic')).toBe(0.1);
    expect(cacheWriteRateFor(HAIKU, 'anthropic')).toBe(1.25);
    // Lower tier, a prompt of exactly 100,000: $0.01 read and $0.125 write.
    record(100_000, 0, { read: 50_000, write: 50_000 });
    expect(cost()).toBeCloseTo(50_000 * 0.01 / 1e6 + 50_000 * 0.125 / 1e6, 8);
    resetTokenTracking();
    // Higher tier: $0.05 read and $0.625 write.
    record(200_000, 0, { read: 100_000, write: 100_000 });
    expect(cost()).toBeCloseTo(100_000 * 0.05 / 1e6 + 100_000 * 0.625 / 1e6, 8);
    expect(cost()).toBeCloseTo(0.0675, 8);
  });

  it('prices each request on its own, never on the sum of a session', () => {
    record(60_000, 1_000);    // 0.006 + 0.0005
    record(160_000, 1_000);   // 0.08 + 0.0025
    const [entry] = getCostBreakdown();
    // The two together are 220,000 tokens, but neither request is: only the
    // second pays the higher rate.
    expect(entry.estimatedCost).toBeCloseTo(0.089, 8);
    expect(entry.longPromptRequests).toBe(1);
    expect(getSessionStats().estimatedCost).toBeCloseTo(0.089, 8);
  });

  it('prices the same model per request across a delta too', () => {
    record(160_000, 1_000);
    const mark = getRecordCount();
    record(60_000, 1_000);
    expect(getCostBreakdown(mark)[0].estimatedCost).toBeCloseTo(0.0065, 8);
    expect(getCostBreakdown(mark)[0].longPromptRequests).toBeUndefined();
  });

  it('lets a cost the provider reported win over the table, tier or not', () => {
    // OpenRouter's usage.cost for an anthropic/claude-haiku-5.5 call.
    record(150_000, 1_000, {}, 'anthropic/claude-haiku-5.5', 'openrouter', 0.0123);
    expect(cost()).toBeCloseTo(0.0123, 8);
    resetTokenTracking();
    // Even on the model the table prices: the reported figure is what was billed.
    record(150_000, 1_000, {}, HAIKU, 'anthropic', 0.0456);
    const [entry] = getCostBreakdown();
    expect(entry.estimatedCost).toBeCloseTo(0.0456, 8);
    // It was not priced here, so it is not counted as priced at the higher rate.
    expect(entry.longPromptRequests).toBeUndefined();
  });

  it('leaves a model with a single rate exactly as it was, whatever the prompt length', () => {
    record(150_000, 10_000, {}, 'claude-sonnet-5-5');
    const [entry] = getCostBreakdown();
    // 150,000 * $2/M + 10,000 * $10/M
    expect(entry.estimatedCost).toBeCloseTo(0.4, 8);
    expect('longPromptRequests' in entry).toBe(false);
    resetTokenTracking();
    record(150_000, 10_000, {}, 'claude-haiku-4-5-20251001');
    // Haiku 4.5 is flat: 150,000 * $1/M + 10,000 * $5/M
    expect(cost()).toBeCloseTo(0.2, 8);
  });

  it('nets cache savings at the rate of the tier each request was in', () => {
    // Over the line: reads save 100,000 * $0.50/M * (1 - 0.1).
    record(110_000, 0, { read: 100_000 });
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.045, 8);
    resetTokenTracking();
    // Under it: 50,000 * $0.10/M * 0.9.
    record(50_000, 0, { read: 50_000 });
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.0045, 8);
    resetTokenTracking();
    // Over the line with a write: the reads save 0.045, the write premium costs
    // 100,000 * $0.50/M * 0.25 = 0.0125.
    record(200_000, 0, { read: 100_000, write: 100_000 });
    expect(getCacheStats().estimatedSavingsUsd).toBeCloseTo(0.0325, 8);
  });

  it('formats a token threshold the way people say it', () => {
    expect(formatTokenThreshold(100_000)).toBe('100K');
    expect(formatTokenThreshold(272_000)).toBe('272K');
    expect(formatTokenThreshold(1_000_000)).toBe('1M');
    expect(formatTokenThreshold(1_500)).toBe('1500');
    expect(formatTokenThreshold(999)).toBe('999');
  });

  describe('/cost', () => {
    it('totals a session of one short and one long request, and says why the long one costs more', () => {
      record(60_000, 1_000);
      record(160_000, 1_000);
      const report = formatCostReport();
      expect(report).toContain('**Estimated cost:** $0.0890');
      expect(report).toMatch(/`anthropic` \/ `claude-haiku-5-5` \|.*\| \$0\.0890 \|/);
      expect(report).toContain(
        '_Note: 1 request on `claude-haiku-5-5` had a prompt over 100K tokens, so it was priced at that model\'s long-prompt rate for every token — $0.50 in / $2.50 out per 1M._',
      );
    });

    it('counts the long requests, and words the plural', () => {
      record(150_000, 0);
      record(200_000, 0);
      record(10_000, 0);
      expect(formatCostReport()).toContain(
        '_Note: 2 requests on `claude-haiku-5-5` had a prompt over 100K tokens, so they were priced at',
      );
    });

    it('says nothing when no request was over the line, or when the cost was the provider\'s own', () => {
      record(100_000, 5_000);
      expect(formatCostReport()).toContain('**Estimated cost:** $0.0125');
      expect(formatCostReport()).not.toMatch(/long-prompt/);
      resetTokenTracking();
      record(150_000, 1_000, {}, 'anthropic/claude-haiku-5.5', 'openrouter', 0.0123);
      expect(formatCostReport()).not.toMatch(/long-prompt/);
    });

    it('does not put a dollar rate in a plan\'s report', () => {
      record(150_000, 1_000, {}, HAIKU, 'z.ai');
      const report = formatCostReport();
      expect(report).toContain('**Estimated cost:** included in plan');
      expect(report).not.toMatch(/long-prompt/);
    });
  });
});
