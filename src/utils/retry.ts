/**
 * Retry utility with exponential backoff
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (attempt: number, error: any, delay: number) => void;
}

const defaultOptions: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  shouldRetry: (error: any) => {
    // Retry on network errors
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return true;
    }
    // Retry on 5xx server errors
    if (error.status && error.status >= 500) {
      return true;
    }
    // Don't retry on 4xx client errors
    if (error.status && error.status >= 400 && error.status < 500) {
      return false;
    }
    // Retry on generic network errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      return true;
    }
    return true; // Default to retry for unknown errors
  },
  onRetry: () => {},
};

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is a network error (no internet connection)
 */
export function isNetworkError(error: any): boolean {
  if (error instanceof TypeError) {
    const msg = error.message.toLowerCase();
    return msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch');
  }
  if (error.code) {
    return ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET'].includes(error.code);
  }
  return false;
}

/**
 * Check if error is a timeout error
 */
export function isTimeoutError(error: any): boolean {
  return error.name === 'AbortError' || error.code === 'ETIMEDOUT';
}

/**
 * Wrap an async function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: any;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const err = error as Error;

      // Don't retry on abort (user cancelled)
      if (err.name === 'AbortError') {
        throw error;
      }

      // Check if we should retry
      if (attempt < opts.maxAttempts && opts.shouldRetry(error)) {
        const delay = calculateDelay(attempt, opts.baseDelay, opts.maxDelay);
        opts.onRetry(attempt, error, delay);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Create a fetch with timeout
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = 30000, ...fetchOptions } = options;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Merge abort signals if one was provided
  if (fetchOptions.signal) {
    fetchOptions.signal.addEventListener('abort', () => controller.abort());
  }

  return fetch(url, {
    ...fetchOptions,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeoutId);
  });
}
