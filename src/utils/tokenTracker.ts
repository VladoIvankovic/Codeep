/**
 * Token and cost tracking for API usage
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
  model: string;
  provider: string;
}

// Pricing table — USD per 1M tokens
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Z.AI / ZhipuAI
  'glm-5.1':           { inputPer1M: 0.07,  outputPer1M: 0.28 },
  'glm-5':             { inputPer1M: 0.14,  outputPer1M: 0.56 },
  'glm-5-turbo':       { inputPer1M: 0.07,  outputPer1M: 0.28 },
  'glm-4.5-air':       { inputPer1M: 0.014, outputPer1M: 0.056 },
  'glm-4.7-flash':     { inputPer1M: 0.035, outputPer1M: 0.14 },
  // Anthropic
  'claude-opus-4-6':              { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-sonnet-4-6':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-sonnet-4-5-20250929':   { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001':    { inputPer1M: 0.80,  outputPer1M: 4.00 },
  // DeepSeek
  'deepseek-chat':     { inputPer1M: 0.27,  outputPer1M: 1.10 },
  'deepseek-reasoner': { inputPer1M: 0.55,  outputPer1M: 2.19 },
  // Google
  'gemini-2.5-pro':         { inputPer1M: 1.25, outputPer1M: 10.00 },
  'gemini-2.5-flash':       { inputPer1M: 0.15, outputPer1M: 0.60 },
  'gemini-2.5-flash-lite':  { inputPer1M: 0.10, outputPer1M: 0.40 },
  // MiniMax
  'MiniMax-M2.7':           { inputPer1M: 0.80, outputPer1M: 2.20 },
  'MiniMax-M2.5':           { inputPer1M: 0.80, outputPer1M: 2.20 },
  'MiniMax-M2.5-highspeed': { inputPer1M: 0.80, outputPer1M: 2.20 },
  'MiniMax-M2.1':           { inputPer1M: 0.40, outputPer1M: 1.10 },
  'MiniMax-M2.1-highspeed': { inputPer1M: 0.40, outputPer1M: 1.10 },
  'MiniMax-M2':             { inputPer1M: 0.20, outputPer1M: 0.55 },
};

export function getPricingTable(): { model: string; inputPer1M: number; outputPer1M: number }[] {
  return Object.entries(MODEL_PRICING).map(([model, p]) => ({ model, ...p }));
}

// Session-level accumulator
const records: TokenRecord[] = [];

/**
 * Record token usage from an API response
 */
export function recordTokenUsage(
  usage: TokenUsage,
  model: string,
  provider: string
): void {
  records.push({
    timestamp: Date.now(),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    model,
    provider,
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
    return {
      promptTokens: data.usage.input_tokens || 0,
      completionTokens: data.usage.output_tokens || 0,
      totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
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
    const pricing = MODEL_PRICING[record.model];
    existing.promptTokens += record.promptTokens;
    existing.completionTokens += record.completionTokens;
    if (pricing) {
      existing.estimatedCost += (record.promptTokens / 1_000_000) * pricing.inputPer1M + (record.completionTokens / 1_000_000) * pricing.outputPer1M;
    }
    grouped.set(key, existing);
  }
  return Array.from(grouped.values());
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
