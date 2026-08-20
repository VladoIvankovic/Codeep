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
  formatTokenCount,
  formatCostReport,
  resetTokenTracking,
  getRecordCount,
  createTokenScope,
  runWithTokenScope,
  getCacheStats,
} from './tokenTracker';

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
    expect(getModelContextWindow('grok-4.6')).toBe(500_000);
  });

  it('falls back to 128K for unknown models', () => {
    expect(getModelContextWindow('nonsense-model')).toBe(128_000);
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
    // Grok 4.6 inherits 4.5's base-tier rate.
    expect(byModel.get('grok-4.6')).toMatchObject({ inputPer1M: 2, outputPer1M: 6 });
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
