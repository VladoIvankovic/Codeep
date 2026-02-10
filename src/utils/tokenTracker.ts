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

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    requestCount: records.length,
    estimatedCost: 0, // Cost estimation requires price-per-token which varies by provider
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
