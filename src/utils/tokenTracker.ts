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

// Context window sizes per model (in tokens)
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Z.AI / ZhipuAI
  'glm-5.1':              131_072,
  'glm-5':                80_000,
  'glm-5-turbo':          202_752,
  'glm-4.5-air':          131_072,
  'glm-4.7-flash':        202_752,
  // OpenAI
  'gpt-5.4':              1_050_000,
  'gpt-5.4-mini':         400_000,
  'gpt-5.4-nano':         400_000,
  'gpt-4.1':              1_000_000,
  'gpt-4.1-mini':         1_000_000,
  'gpt-4.1-nano':         1_000_000,
  'o3':                   200_000,
  'o4-mini':              200_000,
  'gpt-4o':               128_000,
  // Anthropic
  'claude-opus-4-7':              1_000_000,
  'claude-opus-4-6':              1_000_000,
  'claude-sonnet-4-6':            1_000_000,
  'claude-sonnet-4-5-20250929':   200_000,
  'claude-haiku-4-5-20251001':    200_000,
  // DeepSeek
  'deepseek-chat':        128_000,
  'deepseek-reasoner':    128_000,
  // Google
  'gemini-3.1-pro-preview':        1_048_576,
  'gemini-3-flash-preview':        1_000_000,
  'gemini-3.1-flash-lite-preview': 1_000_000,
  'gemini-2.5-pro':                1_000_000,
  'gemini-2.5-flash':              1_000_000,
  'gemini-2.5-flash-lite':         1_000_000,
  // MiniMax
  'MiniMax-M2.7':           204_800,
  'MiniMax-M2.5':           196_608,
  'MiniMax-M2.5-highspeed': 196_608,
  'MiniMax-M2.1':           196_608,
  'MiniMax-M2.1-highspeed': 196_608,
  'MiniMax-M2':             196_608,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Get context window size for a model (falls back to 128k if unknown)
 */
export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

// Pricing table — USD per 1M tokens
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Z.AI / ZhipuAI
  'glm-5.1':           { inputPer1M: 1.00,  outputPer1M: 3.20 },
  'glm-5':             { inputPer1M: 0.72,  outputPer1M: 2.30 },
  'glm-5-turbo':       { inputPer1M: 1.20,  outputPer1M: 4.00 },
  'glm-4.5-air':       { inputPer1M: 0.20,  outputPer1M: 1.10 },
  'glm-4.7-flash':     { inputPer1M: 0.06,  outputPer1M: 0.40 },
  // OpenAI
  'gpt-5.4':      { inputPer1M: 2.50,  outputPer1M: 15.00 },
  'gpt-5.4-mini': { inputPer1M: 0.75,  outputPer1M: 4.50 },
  'gpt-5.4-nano': { inputPer1M: 0.20,  outputPer1M: 1.25 },
  'gpt-4.1':      { inputPer1M: 2.00,  outputPer1M: 8.00 },
  'gpt-4.1-mini': { inputPer1M: 0.40,  outputPer1M: 1.60 },
  'gpt-4.1-nano': { inputPer1M: 0.10,  outputPer1M: 0.40 },
  'o3':           { inputPer1M: 2.00,  outputPer1M: 8.00 },
  'o4-mini':      { inputPer1M: 0.55,  outputPer1M: 2.20 },
  'gpt-4o':       { inputPer1M: 2.50,  outputPer1M: 10.00 },
  // Anthropic
  'claude-opus-4-7':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-opus-4-6':              { inputPer1M: 5.00,  outputPer1M: 25.00 },
  'claude-sonnet-4-6':            { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-sonnet-4-5-20250929':   { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001':    { inputPer1M: 1.00,  outputPer1M: 5.00 },
  // DeepSeek
  'deepseek-chat':     { inputPer1M: 0.28,  outputPer1M: 0.42 },
  'deepseek-reasoner': { inputPer1M: 0.28,  outputPer1M: 0.42 },
  // Google
  'gemini-3.1-pro-preview':        { inputPer1M: 2.00, outputPer1M: 12.00 },
  'gemini-3-flash-preview':        { inputPer1M: 0.50, outputPer1M: 3.00 },
  'gemini-3.1-flash-lite-preview': { inputPer1M: 0.25, outputPer1M: 1.50 },
  'gemini-2.5-pro':                { inputPer1M: 1.00, outputPer1M: 10.00 },
  'gemini-2.5-flash':              { inputPer1M: 0.30, outputPer1M: 2.50 },
  'gemini-2.5-flash-lite':         { inputPer1M: 0.10, outputPer1M: 0.40 },
  // MiniMax
  'MiniMax-M2.7':           { inputPer1M: 0.30,  outputPer1M: 1.20 },
  'MiniMax-M2.5':           { inputPer1M: 0.118, outputPer1M: 0.99 },
  'MiniMax-M2.5-highspeed': { inputPer1M: 0.30,  outputPer1M: 2.40 },
  'MiniMax-M2.1':           { inputPer1M: 0.27,  outputPer1M: 0.95 },
  'MiniMax-M2.1-highspeed': { inputPer1M: 0.27,  outputPer1M: 0.95 },
  'MiniMax-M2':             { inputPer1M: 0.30,  outputPer1M: 1.20 },
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
