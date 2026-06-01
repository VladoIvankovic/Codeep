/**
 * Token and cost tracking for API usage
 */

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

// Context window sizes per model (in tokens).
// Keep this table in lockstep with `providers.ts` — entries for models that
// aren't in the provider catalogue only show up if a user types an id by hand
// and produce phantom estimates against the wrong context size.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Z.AI / ZhipuAI
  'glm-5.1':              131_072,
  'glm-5':                80_000,
  'glm-5-turbo':          202_752,
  // OpenAI
  'gpt-5.5':              1_200_000,
  'gpt-5.4':              1_050_000,
  'gpt-5.4-mini':         400_000,
  'gpt-5.4-nano':         400_000,
  // Anthropic
  'claude-opus-4-8':              1_000_000,
  'claude-opus-4-7':              1_000_000,
  'claude-opus-4-6':              1_000_000,
  'claude-sonnet-4-6':            1_000_000,
  'claude-haiku-4-5-20251001':    200_000,
  // DeepSeek
  'deepseek-v4-pro':      1_000_000,
  'deepseek-v4-flash':    1_000_000,
  // Google
  'gemini-3.1-pro-preview':        1_048_576,
  'gemini-3.5-flash':              1_000_000,
  'gemini-3-flash-preview':        1_000_000,
  // MiniMax
  'MiniMax-M3':             524_288,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Get context window size for a model (falls back to 128k if unknown)
 */
export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

// Pricing table — USD per 1M tokens. Same rule as MODEL_CONTEXT_WINDOWS:
// only list model ids that exist in `providers.ts`, otherwise typing an id
// by hand can produce phantom cost estimates against stale rates.
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Z.AI / ZhipuAI
  'glm-5.1':           { inputPer1M: 1.00,  outputPer1M: 3.20 },
  'glm-5':             { inputPer1M: 0.72,  outputPer1M: 2.30 },
  'glm-5-turbo':       { inputPer1M: 1.20,  outputPer1M: 4.00 },
  // OpenAI
  'gpt-5.5':      { inputPer1M: 5.00,  outputPer1M: 30.00 },
  'gpt-5.4':      { inputPer1M: 2.50,  outputPer1M: 15.00 },
  'gpt-5.4-mini': { inputPer1M: 0.75,  outputPer1M: 4.50 },
  'gpt-5.4-nano': { inputPer1M: 0.20,  outputPer1M: 1.25 },
  // Anthropic
  'claude-opus-4-8':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-opus-4-7':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-opus-4-6':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-sonnet-4-6':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001':    { inputPer1M: 1.00,  outputPer1M: 5.00 },
  // DeepSeek (cache-miss input pricing)
  'deepseek-v4-pro':   { inputPer1M: 1.74,  outputPer1M: 3.48 },
  'deepseek-v4-flash': { inputPer1M: 0.14,  outputPer1M: 0.28 },
  // Google
  'gemini-3.1-pro-preview':        { inputPer1M: 2.00, outputPer1M: 12.00 },
  'gemini-3.5-flash':              { inputPer1M: 1.50, outputPer1M: 9.00 },
  'gemini-3-flash-preview':        { inputPer1M: 0.50, outputPer1M: 3.00 },
  // MiniMax
  'MiniMax-M3':             { inputPer1M: 0.60,  outputPer1M: 2.40 },
};

export function getPricingTable(): { model: string; inputPer1M: number; outputPer1M: number }[] {
  return Object.entries(MODEL_PRICING).map(([model, p]) => ({ model, ...p }));
}

// Session-level accumulator
const records: TokenRecord[] = [];

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
  records.push({
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
    return {
      promptTokens: data.usage.prompt_tokens || 0,
      completionTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0,
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
  estimatedCost: number;
}

/**
 * Get cost breakdown grouped by provider/model
 */
export function getCostBreakdown(): ProviderCostBreakdown[] {
  const grouped = new Map<string, ProviderCostBreakdown>();
  for (const record of records) {
    const key = `${record.provider}/${record.model}`;
    const existing = grouped.get(key) ?? { provider: record.provider, model: record.model, promptTokens: 0, completionTokens: 0, estimatedCost: 0 };
    existing.promptTokens += record.promptTokens;
    existing.completionTokens += record.completionTokens;

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
  /** Sum of estimatedSavings across all Anthropic-priced records. */
  estimatedSavingsUsd: number;
}

export function getCacheStats(): CacheStats {
  let cacheCreate = 0;
  let cacheRead = 0;
  let savings = 0;
  for (const record of records) {
    cacheCreate += record.cacheCreationTokens ?? 0;
    cacheRead += record.cacheReadTokens ?? 0;
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
  return { cacheCreationTokens: cacheCreate, cacheReadTokens: cacheRead, estimatedSavingsUsd: Math.max(0, savings) };
}

/**
 * Get session stats
 */
export function getSessionStats(): SessionTokenStats {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (const record of records) {
    totalPromptTokens += record.promptTokens;
    totalCompletionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
  }

  const estimatedCost = getCostBreakdown().reduce((s, b) => s + b.estimatedCost, 0);

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    requestCount: records.length,
    estimatedCost,
  };
}

/**
 * Get last request usage
 */
export function getLastUsage(): TokenRecord | null {
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
 * Reset session tracking
 */
export function resetTokenTracking(): void {
  records.length = 0;
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
  const lines: string[] = [
    '## Session Cost',
    '',
    `**Requests:** ${stats.requestCount}  ·  **Input:** ${formatTokenCount(stats.totalPromptTokens)}  ·  **Output:** ${formatTokenCount(stats.totalCompletionTokens)}  ·  **Total:** ${formatTokenCount(stats.totalTokens)}`,
    `**Estimated cost:** $${stats.estimatedCost.toFixed(4)}`,
    '',
  ];

  if (breakdown.length > 1 || (breakdown.length === 1 && breakdown[0].estimatedCost > 0)) {
    lines.push('| Provider / Model | Input | Output | Cost |');
    lines.push('|---|---:|---:|---:|');
    for (const b of breakdown) {
      lines.push(`| \`${b.provider}\` / \`${b.model}\` | ${formatTokenCount(b.promptTokens)} | ${formatTokenCount(b.completionTokens)} | $${b.estimatedCost.toFixed(4)} |`);
    }
  }

  // Prompt caching summary — only shown if at least one cached call landed.
  const cache = getCacheStats();
  if (cache.cacheReadTokens > 0 || cache.cacheCreationTokens > 0) {
    lines.push('', '### Prompt caching');
    lines.push(`**Cache reads:** ${formatTokenCount(cache.cacheReadTokens)} tokens (billed at 0.1× input rate)`);
    if (cache.cacheCreationTokens > 0) {
      lines.push(`**Cache writes:** ${formatTokenCount(cache.cacheCreationTokens)} tokens (billed at 1.25× input rate)`);
    }
    if (cache.estimatedSavingsUsd > 0) {
      lines.push(`**Estimated savings vs no caching:** $${cache.estimatedSavingsUsd.toFixed(4)}`);
    }
  }

  // Models with no pricing entry don't contribute to cost — flag so users
  // aren't surprised the total looks low.
  const untracked = breakdown.filter(b => b.estimatedCost === 0 && (b.promptTokens + b.completionTokens) > 0);
  if (untracked.length > 0) {
    lines.push('', `_Note: ${untracked.length} model${untracked.length === 1 ? '' : 's'} (${untracked.map(u => `\`${u.model}\``).join(', ')}) have no pricing entry — token counts are tracked but not priced._`);
  }

  return lines.join('\n');
}
