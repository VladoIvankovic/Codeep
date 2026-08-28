/**
 * Token and cost tracking for API usage
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isFlatFeeProvider } from '../config/providers';
import { formatResourceImpactReport } from './resourceImpact';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Anthropic prompt caching: tokens written to the cache on this call
   *  (billed at ~1.25× input rate). Undefined for providers that don't
   *  support caching or for calls below the cache size threshold. */
  cacheCreationTokens?: number;
  /** Anthropic prompt caching: tokens read from cache on this call
   *  (billed at ~0.1× input rate — the big savings live here). */
  cacheReadTokens?: number;
}

export interface SessionTokenStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCost: number;
  /** `estimatedCost` minus every flat-fee entry — the only figure we may show
   *  as a dollar total, since flat-fee tokens carry no per-token charge. */
  billableCost: number;
  /** True when at least one entry came from a flat-fee provider, so callers can
   *  say "included in plan" instead of silently dropping that usage. */
  hasFlatFeeUsage: boolean;
  /** Anthropic prompt caching: total tokens written to cache this session. */
  totalCacheCreationTokens: number;
  /** Anthropic prompt caching: total tokens read from cache this session. */
  totalCacheReadTokens: number;
}

// Per-message tracking
interface TokenRecord {
  timestamp: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Anthropic prompt caching breakdown — see TokenUsage. */
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model: string;
  provider: string;
  /** Authoritative per-call USD from the provider (OpenRouter), if available. */
  actualCostUsd?: number;
}

// Context window sizes per model (in tokens). Primarily mirrors providers.ts;
// retired aliases remain only where restored historical sessions still need a
// meaningful context/cost display.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Z.AI / ZhipuAI
  'glm-5.3':            1_000_000,
  'glm-5.3-flash':      1_000_000,
  'glm-5.2':            1_000_000,
  'glm-5.1':              200_000,
  'glm-5-turbo':          202_752,
  // OpenAI
  'gpt-5.6-sol':          1_050_000,
  'gpt-5.6-terra':        1_050_000,
  'gpt-5.6-luna':         1_050_000,
  'gpt-5.5':              1_200_000,
  'gpt-5.4':              1_050_000,
  'gpt-5.4-mini':         400_000,
  // Anthropic
  'claude-fable-5':               1_000_000,
  'claude-opus-5':                1_000_000,
  'claude-sonnet-4-6':            1_000_000,
  'claude-sonnet-5':              1_000_000,
  'claude-haiku-4-5-20251001':    200_000,
  // DeepSeek
  'deepseek-v4-pro':      1_000_000,
  'deepseek-v4-flash':    1_000_000,
  // Google
  'gemini-3.1-pro-preview':        1_048_576,
  'gemini-3.7-flash':              1_048_576,
  'gemini-3.6-flash':              1_048_576,
  'gemini-3.5-flash':              1_048_576,
  'gemini-3.5-flash-lite':         1_048_576,
  'gemini-3-flash-preview':        1_000_000,
  // MiniMax
  'MiniMax-M3':           1_000_000,
  // Kimi (Moonshot) — 1M on K3, 256K across K2.x
  'kimi-k3':                   1_000_000,
  'kimi-k2.7-code':            262_144,
  'kimi-k2.7-code-highspeed':  262_144,
  'kimi-k2.6':                 262_144,
  'kimi-for-coding':           262_144,
  'kimi-for-coding-highspeed': 262_144,
  'k3':                      1_000_000,
  'k3-256k':                   262_144,
  // Grok (xAI)
  'grok-4.6':                  500_000,
  'grok-4.5':                  500_000,
  'grok-build-0.1':            256_000,
  'grok-4.3':                  1_000_000,
  'grok-code-fast-1':          256_000,
  'grok-4-fast-reasoning':     2_000_000,
  // Qwen (Alibaba) — current hosted generation
  'qwen3.7-max':               1_000_000,
  'qwen3.8-max-preview':       1_000_000,
  'qwen3.7-plus':              1_000_000,
  'qwen3.6-plus':              1_000_000,
  'qwen3.5-plus':              1_000_000,
  'qwen3.6-flash':             1_000_000,
  'Qwen/Qwen3-Coder-480B-A35B-Instruct': 262_144,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Get context window size for a model (falls back to 128k if unknown)
 */
export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

// Pricing table — USD per 1M tokens. Same rule as MODEL_CONTEXT_WINDOWS:
// Primarily mirrors `providers.ts`. A few retired aliases remain so restored
// historical sessions still show the rate that applied when they were created.
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Z.AI / ZhipuAI
  // Coding Plan is flat-fee; these official rates apply to pay-per-use.
  // GLM-5.3 reached the standalone API on 2026-08-19 and is listed at the same
  // rate as GLM-5.2 (docs.z.ai/guides/overview/pricing). Verified there, not
  // inferred from the match — the two being equal today is a coincidence of the
  // price list, not a rule.
  'glm-5.3':           { inputPer1M: 1.40,  outputPer1M: 4.40 },
  // Flash lists at $0.15/$0.50 with a 50% launch promotion in force at the
  // time of writing. The list price is what belongs here: a promotional rate
  // would quietly understate every session's cost the day it ends.
  'glm-5.3-flash':     { inputPer1M: 0.15,  outputPer1M: 0.50 },
  'glm-5.2':           { inputPer1M: 1.40,  outputPer1M: 4.40 },
  'glm-5.1':           { inputPer1M: 1.40,  outputPer1M: 4.40 },
  'glm-5-turbo':       { inputPer1M: 1.20,  outputPer1M: 4.00 },
  // OpenAI
  'gpt-5.6-sol':   { inputPer1M: 5.00,  outputPer1M: 30.00 },
  'gpt-5.6-terra': { inputPer1M: 2.00,  outputPer1M: 12.00 },
  'gpt-5.6-luna':  { inputPer1M: 0.20,  outputPer1M: 1.20 },
  'gpt-5.5':      { inputPer1M: 5.00,  outputPer1M: 30.00 },
  'gpt-5.4':      { inputPer1M: 2.50,  outputPer1M: 15.00 },
  'gpt-5.4-mini': { inputPer1M: 0.75,  outputPer1M: 4.50 },
  // Anthropic
  'claude-fable-5':               { inputPer1M: 10.00, outputPer1M: 50.00 },
  'claude-opus-5':                { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-sonnet-4-6':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-sonnet-5':              { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001':    { inputPer1M: 1.00,  outputPer1M: 5.00 },
  // DeepSeek (cache-miss input pricing)
  // DeepSeek moved to peak / off-peak billing on 2026-08-16, with off-peak at
  // half these rates. This table holds one rate per model and has no notion of
  // wall-clock time, so it keeps the PEAK figures: an over-estimate is the
  // honest direction for a cost estimate, and rule 5 of the catalogue policy
  // allows a clearly-labelled conservative approximation but never an invented
  // number. Cache-miss input; cache hits are ~1/50th and not modelled here.
  'deepseek-v4-pro':   { inputPer1M: 0.435, outputPer1M: 0.87 },
  'deepseek-v4-flash': { inputPer1M: 0.14,  outputPer1M: 0.28 },
  // Google
  // Gemini 3.6/3.7 Flash carry PROMOTIONAL rates that run through 2026-12-31 and
  // step up to 1.50/7.50 on 2027-01-01 — revisit both rows on that date.
  'gemini-3.1-pro-preview':        { inputPer1M: 2.00, outputPer1M: 12.00 },
  'gemini-3.7-flash':              { inputPer1M: 0.75, outputPer1M: 3.75 },
  'gemini-3.6-flash':              { inputPer1M: 0.75, outputPer1M: 3.75 },
  'gemini-3.5-flash':              { inputPer1M: 1.50, outputPer1M: 9.00 },
  'gemini-3.5-flash-lite':         { inputPer1M: 0.30, outputPer1M: 2.50 },
  'gemini-3-flash-preview':        { inputPer1M: 0.50, outputPer1M: 3.00 },
  // MiniMax
  'MiniMax-M3':             { inputPer1M: 0.60,  outputPer1M: 2.40 },
  // Kimi (Moonshot) — pay-per-use cache-miss rates; `kimi-for-coding` is the
  // subscription alias (flat-fee in reality, priced notionally like K2.7 Code).
  'kimi-k3':                   { inputPer1M: 3.00, outputPer1M: 15.00 },
  'kimi-k2.7-code':            { inputPer1M: 0.95, outputPer1M: 4.00 },
  // Highspeed is the same model served faster, at exactly double the rate
  // across every token category (platform.kimi.ai/docs/pricing/chat-k27-code).
  'kimi-k2.7-code-highspeed':  { inputPer1M: 1.90, outputPer1M: 8.00 },
  // Kimi doesn't publish a distinct high-speed price in its main table.
  // Leave that variant unpriced rather than presenting an invented estimate.
  'kimi-k2.6':                 { inputPer1M: 0.95, outputPer1M: 4.00 },
  'kimi-for-coding':           { inputPer1M: 0.95, outputPer1M: 4.00 },
  'kimi-for-coding-highspeed': { inputPer1M: 0.95, outputPer1M: 4.00 },
  'k3':                        { inputPer1M: 3.00, outputPer1M: 15.00 },
  'k3-256k':                   { inputPer1M: 3.00, outputPer1M: 15.00 },
  // Grok (xAI) — base-tier rates. xAI doubles Grok 4.5/4.6 at prompts ≥200K;
  // this table stores one flat rate per model, so the base tier is what we show.
  'grok-4.6':                  { inputPer1M: 2.00, outputPer1M: 6.00 },
  'grok-4.5':                  { inputPer1M: 2.00, outputPer1M: 6.00 },
  'grok-build-0.1':            { inputPer1M: 1.00, outputPer1M: 2.00 },
  'grok-4.3':                  { inputPer1M: 1.25, outputPer1M: 2.50 },
  'grok-code-fast-1':          { inputPer1M: 0.20, outputPer1M: 1.50 },
  'grok-4-fast-reasoning':     { inputPer1M: 0.20, outputPer1M: 0.50 },
  // Qwen (Alibaba) — list prices for the first context tier. Coding Plan
  // variants are flat-fee; these rates describe pay-per-use calls.
  // `qwen3.8-max-preview` is Token-Plan-only (credit-metered, promotional
  // preview rate); Alibaba publishes no pay-per-use per-token price for it.
  // Leave it unpriced rather than borrowing the GA qwen3.8-max rate.
  'qwen3.7-max':               { inputPer1M: 2.50, outputPer1M: 7.50 },
  'qwen3.7-plus':              { inputPer1M: 0.40, outputPer1M: 1.60 },
  'qwen3.6-plus':              { inputPer1M: 0.40, outputPer1M: 2.40 },
  'qwen3.5-plus':              { inputPer1M: 0.40, outputPer1M: 2.40 },
  'qwen3.6-flash':             { inputPer1M: 0.25, outputPer1M: 1.50 },
  // ModelScope free tier — no per-token charge.
  'Qwen/Qwen3-Coder-480B-A35B-Instruct': { inputPer1M: 0, outputPer1M: 0 },
};

export function getPricingTable(): { model: string; inputPer1M: number; outputPer1M: number }[] {
  return Object.entries(MODEL_PRICING).map(([model, p]) => ({ model, ...p }));
}

// Session-level accumulator.
//
// Usage is recorded deep in the API layer (api/index.ts, agentStream.ts) which
// has no session context, so we can't thread a scope id through every call
// site. Instead we scope the record buffer per async execution flow with
// AsyncLocalStorage: the single-session TUI (and anything that never enters a
// scope) reads/writes `defaultRecords`, exactly as before; the ACP server —
// which multiplexes many sessions on one process — runs each session's prompts
// inside `runWithTokenScope` with that session's own buffer, so concurrent
// sessions can't clobber each other's totals and each session's `/cost` stays
// cumulative across its prompts.

/** An isolated token-record buffer for one scope (e.g. one ACP session). */
export type TokenScope = TokenRecord[];

const defaultRecords: TokenScope = [];
const recordsStore = new AsyncLocalStorage<TokenScope>();

/** The record buffer for the current async flow (a scope's buffer inside
 *  runWithTokenScope, otherwise the process-wide default). */
function currentRecords(): TokenScope {
  return recordsStore.getStore() ?? defaultRecords;
}

/** Create a fresh, empty scope buffer (one per ACP session). */
export function createTokenScope(): TokenScope {
  return [];
}

/**
 * Run `fn` with `scope` as the active token-record buffer. Every
 * recordTokenUsage() call made within `fn`'s async flow (including across
 * awaits) accumulates into `scope`, and reads (getCostBreakdown/…) made in the
 * same flow see only `scope`. Used by the ACP server to isolate per-session
 * usage without threading a session id through the deep API layer.
 */
export function runWithTokenScope<T>(scope: TokenScope, fn: () => T): T {
  return recordsStore.run(scope, fn);
}

/**
 * Record token usage from an API response. The optional `actualCostUsd`
 * argument lets aggregator providers (OpenRouter) pass through the
 * authoritative per-call cost they returned in `usage.cost`, instead of
 * forcing us to look it up in `MODEL_PRICING` (which we don't maintain
 * for every OpenRouter-listed model — there are 100+).
 */
export function recordTokenUsage(
  usage: TokenUsage,
  model: string,
  provider: string,
  actualCostUsd?: number,
): void {
  currentRecords().push({
    timestamp: Date.now(),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    model,
    provider,
    actualCostUsd,
  });
}

/**
 * Extract token usage from OpenAI-format API response
 */
export function extractOpenAIUsage(data: any): TokenUsage | null {
  if (data?.usage) {
    // OpenAI-protocol `prompt_tokens` is INCLUSIVE of cached prompt tokens
    // (DeepSeek/OpenAI report cache hits in prompt_tokens_details.cached_tokens).
    // Surface them so getCostBreakdown bills cache reads at the discounted
    // rate instead of the full cache-miss input rate.
    const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
    return {
      promptTokens: data.usage.prompt_tokens || 0,
      completionTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0,
      cacheReadTokens: cached || undefined,
    };
  }
  return null;
}

/**
 * Extract token usage from Anthropic-format API response
 */
export function extractAnthropicUsage(data: any): TokenUsage | null {
  if (data?.usage) {
    const inputTokens = data.usage.input_tokens || 0;
    const outputTokens = data.usage.output_tokens || 0;
    const cacheCreation = data.usage.cache_creation_input_tokens || 0;
    const cacheRead = data.usage.cache_read_input_tokens || 0;
    // Anthropic returns input_tokens EXCLUSIVE of cache creation and cache
    // read tokens — they're reported separately. Total prompt = sum of all
    // three so our context window math doesn't undercount.
    return {
      promptTokens: inputTokens + cacheCreation + cacheRead,
      completionTokens: outputTokens,
      totalTokens: inputTokens + cacheCreation + cacheRead + outputTokens,
      cacheCreationTokens: cacheCreation || undefined,
      cacheReadTokens: cacheRead || undefined,
    };
  }
  return null;
}

export interface ProviderCostBreakdown {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Anthropic prompt caching: tokens written to cache (billed ~1.25× input).
   *  0 for providers that don't report caching. */
  cacheCreationTokens: number;
  /** Anthropic prompt caching: tokens read from cache (billed ~0.1× input).
   *  0 for providers that don't report caching. */
  cacheReadTokens: number;
  estimatedCost: number;
}

/**
 * Get cost breakdown grouped by provider/model.
 *
 * `startIndex` lets callers price only the records appended since a marker (see
 * getRecordCount) — used to report a single run/prompt's delta to cloud
 * telemetry WITHOUT wiping the session-cumulative store the status bar and
 * `/cost` read. Defaults to 0 (the whole current scope).
 */
export function getCostBreakdown(startIndex = 0): ProviderCostBreakdown[] {
  const grouped = new Map<string, ProviderCostBreakdown>();
  for (const record of currentRecords().slice(startIndex)) {
    const key = `${record.provider}/${record.model}`;
    const existing = grouped.get(key) ?? { provider: record.provider, model: record.model, promptTokens: 0, completionTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
    existing.promptTokens += record.promptTokens;
    existing.completionTokens += record.completionTokens;
    existing.cacheCreationTokens += record.cacheCreationTokens ?? 0;
    existing.cacheReadTokens += record.cacheReadTokens ?? 0;

    // Cost source priority:
    //   1. Provider-reported USD (OpenRouter, MaxiCloud, etc.) — most accurate.
    //   2. Our MODEL_PRICING table — for built-in providers we maintain rates for.
    //   3. Zero — model isn't in our table; flag in formatCostReport.
    if (typeof record.actualCostUsd === 'number' && Number.isFinite(record.actualCostUsd)) {
      existing.estimatedCost += record.actualCostUsd;
    } else {
      const pricing = MODEL_PRICING[record.model];
      if (pricing) {
        // Anthropic prompt caching: cache_creation_input is billed at 1.25×
        // the base input rate, cache_read_input at 0.1×. The remaining
        // (uncached) prompt tokens bill at the standard 1.0× rate.
        const cacheCreate = record.cacheCreationTokens ?? 0;
        const cacheRead = record.cacheReadTokens ?? 0;
        const uncachedPrompt = Math.max(0, record.promptTokens - cacheCreate - cacheRead);
        existing.estimatedCost +=
          (uncachedPrompt / 1_000_000) * pricing.inputPer1M
          + (cacheCreate / 1_000_000) * pricing.inputPer1M * 1.25
          + (cacheRead / 1_000_000) * pricing.inputPer1M * 0.1
          + (record.completionTokens / 1_000_000) * pricing.outputPer1M;
      }
    }
    grouped.set(key, existing);
  }
  return Array.from(grouped.values());
}

/**
 * Aggregate Anthropic prompt-caching stats for the current session.
 * Returns the breakdown plus an estimate of what the input billing would
 * have been *without* caching, so we can surface "you saved $X" to the
 * user.
 */
export interface CacheStats {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Sum of estimatedSavings across pay-per-use records only. */
  estimatedSavingsUsd: number;
  /** True when some cached tokens came from a flat-fee plan, whose "savings"
   *  are not a dollar amount at all. Lets the report say so instead of quoting
   *  a figure that silently covers only part of the session. */
  hasFlatFeeCacheUsage: boolean;
  /** True when EVERY cached token came from a flat-fee plan — there is no
   *  metered spend to have saved against. */
  isEntirelyFlatFeeCache: boolean;
}

export function getCacheStats(): CacheStats {
  let cacheCreate = 0;
  let cacheRead = 0;
  let savings = 0;
  let flatFeeCached = 0;
  let meteredCached = 0;
  for (const record of currentRecords()) {
    const cached = (record.cacheCreationTokens ?? 0) + (record.cacheReadTokens ?? 0);
    cacheCreate += record.cacheCreationTokens ?? 0;
    cacheRead += record.cacheReadTokens ?? 0;
    // A plan bills a flat fee, so caching saves latency but not money — pricing
    // its cached tokens would invent a dollar figure the same way the per-model
    // cost lines used to. Count the tokens (measured), skip the arithmetic.
    if (isFlatFeeProvider(record.provider)) {
      flatFeeCached += cached;
      continue;
    }
    meteredCached += cached;
    // Savings = what cache-read tokens would have cost at full input rate,
    // minus what they actually cost at 0.1×. (Cache creation is a slight
    // *penalty* of 0.25× — netted in for honest reporting.)
    const pricing = MODEL_PRICING[record.model];
    if (pricing) {
      const cReadSaved = ((record.cacheReadTokens ?? 0) / 1_000_000) * pricing.inputPer1M * 0.9;
      const cCreateCost = ((record.cacheCreationTokens ?? 0) / 1_000_000) * pricing.inputPer1M * 0.25;
      savings += cReadSaved - cCreateCost;
    }
  }
  return {
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    estimatedSavingsUsd: Math.max(0, savings),
    hasFlatFeeCacheUsage: flatFeeCached > 0,
    isEntirelyFlatFeeCache: flatFeeCached > 0 && meteredCached === 0,
  };
}

/**
 * Get session stats
 */
export function getSessionStats(): SessionTokenStats {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  for (const record of currentRecords()) {
    totalPromptTokens += record.promptTokens;
    totalCompletionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
    totalCacheCreationTokens += record.cacheCreationTokens ?? 0;
    totalCacheReadTokens += record.cacheReadTokens ?? 0;
  }

  const breakdown = getCostBreakdown();
  const estimatedCost = breakdown.reduce((s, b) => s + b.estimatedCost, 0);
  const billableCost = breakdown
    .filter(b => !isFlatFeeProvider(b.provider))
    .reduce((s, b) => s + b.estimatedCost, 0);
  const hasFlatFeeUsage = breakdown.some(b => isFlatFeeProvider(b.provider));

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    requestCount: currentRecords().length,
    estimatedCost,
    billableCost,
    hasFlatFeeUsage,
    totalCacheCreationTokens,
    totalCacheReadTokens,
  };
}

/**
 * Get last request usage
 */
export function getLastUsage(): TokenRecord | null {
  const records = currentRecords();
  return records.length > 0 ? records[records.length - 1] : null;
}

/**
 * Format token count for display (e.g., 1234 -> "1.2K")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) return (tokens / 1000).toFixed(1) + 'K';
  return (tokens / 1000000).toFixed(2) + 'M';
}

/**
 * Number of records in the current scope. Capture before a run/prompt and pass
 * it to getCostBreakdown(startIndex) to price just that run's delta (for cloud
 * telemetry) without wiping the cumulative store the status bar and `/cost`
 * read.
 */
export function getRecordCount(): number {
  return currentRecords().length;
}

/**
 * Reset the current scope's tracking. Production run/prompt paths no longer
 * call this (they use getRecordCount + getCostBreakdown(startIndex) so the
 * session-cumulative totals survive); retained for the test suite, which uses
 * it to isolate the process-wide default buffer between cases.
 */
export function resetTokenTracking(): void {
  currentRecords().length = 0;
}

/**
 * Format a session cost report as a Markdown block. Used by `/cost` in both
 * the TUI and ACP command handlers. Returns a "no usage yet" message if the
 * session hasn't made any API calls.
 */
export function formatCostReport(): string {
  const stats = getSessionStats();
  if (stats.requestCount === 0) {
    return '_No API requests in this session yet._';
  }

  const breakdown = getCostBreakdown();
  // Flat-fee providers (subscriptions / free tiers) bill nothing per token, so
  // their notional cost is never shown and never folded into the total. A
  // session can mix them with pay-per-use models, so decide per entry.
  const planEntries = breakdown.filter(b => isFlatFeeProvider(b.provider));
  const costLine = planEntries.length === breakdown.length
    ? '**Estimated cost:** included in plan'
    : `**Estimated cost:** $${stats.billableCost.toFixed(4)}${planEntries.length > 0 ? ' + usage included in plan' : ''}`;
  const lines: string[] = [
    '## Session Cost',
    '',
    `**Requests:** ${stats.requestCount}  ·  **Input:** ${formatTokenCount(stats.totalPromptTokens)}  ·  **Output:** ${formatTokenCount(stats.totalCompletionTokens)}  ·  **Total:** ${formatTokenCount(stats.totalTokens)}`,
    costLine,
    '',
  ];

  if (breakdown.length > 1 || (breakdown.length === 1 && (breakdown[0].estimatedCost > 0 || planEntries.length > 0))) {
    lines.push('| Provider / Model | Input | Output | Cost |');
    lines.push('|---|---:|---:|---:|');
    for (const b of breakdown) {
      const cost = isFlatFeeProvider(b.provider) ? 'included in plan' : `$${b.estimatedCost.toFixed(4)}`;
      lines.push(`| \`${b.provider}\` / \`${b.model}\` | ${formatTokenCount(b.promptTokens)} | ${formatTokenCount(b.completionTokens)} | ${cost} |`);
    }
  }

  // Prompt caching summary — only shown if at least one cached call landed.
  const cache = getCacheStats();
  if (cache.cacheReadTokens > 0 || cache.cacheCreationTokens > 0) {
    lines.push('', '### Prompt caching');
    // The billing multipliers only describe a metered account. On a plan
    // nothing is billed per token, so quoting a rate there would be as invented
    // as the per-model prices this report already refuses to show.
    const readNote = cache.isEntirelyFlatFeeCache ? '' : ' (billed at 0.1× input rate)';
    const writeNote = cache.isEntirelyFlatFeeCache ? '' : ' (billed at 1.25× input rate)';
    lines.push(`**Cache reads:** ${formatTokenCount(cache.cacheReadTokens)} tokens${readNote}`);
    if (cache.cacheCreationTokens > 0) {
      lines.push(`**Cache writes:** ${formatTokenCount(cache.cacheCreationTokens)} tokens${writeNote}`);
    }
    if (cache.isEntirelyFlatFeeCache) {
      lines.push('**Savings:** caching saves latency, not money — this session is on a plan');
    } else if (cache.estimatedSavingsUsd > 0) {
      // Name the partial coverage rather than letting one figure look total.
      const scope = cache.hasFlatFeeCacheUsage ? ' (pay-per-use models only)' : '';
      lines.push(`**Estimated savings vs no caching:** $${cache.estimatedSavingsUsd.toFixed(4)}${scope}`);
    }
  }

  lines.push('', ...formatResourceImpactReport(stats.totalTokens));

  // Models with no pricing entry don't contribute to cost — flag so users
  // aren't surprised the total looks low.
  const untracked = breakdown.filter(b => b.estimatedCost === 0 && (b.promptTokens + b.completionTokens) > 0 && !isFlatFeeProvider(b.provider));
  if (untracked.length > 0) {
    lines.push('', `_Note: ${untracked.length} model${untracked.length === 1 ? '' : 's'} (${untracked.map(u => `\`${u.model}\``).join(', ')}) have no pricing entry — token counts are tracked but not priced._`);
  }

  return lines.join('\n');
}
