/**
 * Rate limiting utility to prevent API abuse
 */

import { config } from '../config/index';

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

class RateLimiter {
  private requests: number[] = [];
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /**
   * Get configuration
   */
  getConfig(): RateLimitConfig {
    return this.config;
  }

  /**
   * Check if request is allowed
   */
  isAllowed(): boolean {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Remove old requests outside the window
    this.requests = this.requests.filter(timestamp => timestamp > windowStart);

    // Check if we're under the limit
    if (this.requests.length >= this.config.maxRequests) {
      return false;
    }

    // Add current request
    this.requests.push(now);
    return true;
  }

  /**
   * Get time until next request is allowed (in ms)
   */
  getRetryAfter(): number {
    if (this.requests.length === 0) return 0;

    const now = Date.now();
    const oldestRequest = this.requests[0];
    const windowStart = now - this.config.windowMs;

    if (oldestRequest > windowStart) {
      // Still in window, calculate wait time
      return oldestRequest + this.config.windowMs - now;
    }

    return 0;
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.requests = [];
  }

  /**
   * Get current request count in window
   */
  getRequestCount(): number {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    return this.requests.filter(timestamp => timestamp > windowStart).length;
  }

  /**
   * Get formatted retry message
   */
  getRetryMessage(): string {
    const retryAfter = this.getRetryAfter();
    if (retryAfter === 0) return '';

    const seconds = Math.ceil(retryAfter / 1000);
    if (seconds < 60) {
      return `Please wait ${seconds} second${seconds > 1 ? 's' : ''}`;
    }

    const minutes = Math.ceil(seconds / 60);
    return `Please wait ${minutes} minute${minutes > 1 ? 's' : ''}`;
  }
}

// Default rate limiters - configs are loaded from user settings
let apiRateLimiter = new RateLimiter({
  maxRequests: config.get('rateLimitApi') || 30,
  windowMs: 60 * 1000, // per minute
});

let commandRateLimiter = new RateLimiter({
  maxRequests: config.get('rateLimitCommands') || 100,
  windowMs: 60 * 1000, // per minute
});

/**
 * Update rate limiters with new config values
 */
export function updateRateLimits(): void {
  apiRateLimiter = new RateLimiter({
    maxRequests: config.get('rateLimitApi') || 30,
    windowMs: 60 * 1000,
  });
  
  commandRateLimiter = new RateLimiter({
    maxRequests: config.get('rateLimitCommands') || 100,
    windowMs: 60 * 1000,
  });
}

export function checkApiRateLimit(): { allowed: boolean; message?: string } {
  if (apiRateLimiter.isAllowed()) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message: `Rate limit exceeded (${apiRateLimiter.getConfig().maxRequests}/min). ${apiRateLimiter.getRetryMessage()}.`,
  };
}

export function checkCommandRateLimit(): { allowed: boolean; message?: string } {
  if (commandRateLimiter.isAllowed()) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message: `Too many commands. ${commandRateLimiter.getRetryMessage()}.`,
  };
}

export function resetRateLimits(): void {
  apiRateLimiter.reset();
  commandRateLimiter.reset();
}

export function getRateLimitStatus(): {
  api: { count: number; limit: number };
  commands: { count: number; limit: number };
} {
  return {
    api: {
      count: apiRateLimiter.getRequestCount(),
      limit: apiRateLimiter.getConfig().maxRequests,
    },
    commands: {
      count: commandRateLimiter.getRequestCount(),
      limit: commandRateLimiter.getConfig().maxRequests,
    },
  };
}
