import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkApiRateLimit,
  checkCommandRateLimit,
  resetRateLimits,
  getRateLimitStatus,
} from './ratelimit';

describe('ratelimit utilities', () => {
  beforeEach(() => {
    // Reset rate limiters before each test
    resetRateLimits();
  });

  describe('checkApiRateLimit', () => {
    it('should allow requests under limit', () => {
      const result = checkApiRateLimit();
      expect(result.allowed).toBe(true);
      expect(result.message).toBeUndefined();
    });

    it('should track request count', () => {
      // Make some requests
      checkApiRateLimit();
      checkApiRateLimit();
      checkApiRateLimit();

      const status = getRateLimitStatus();
      expect(status.api.count).toBe(3);
    });

    it('should block requests over limit', () => {
      // Make requests up to the limit (default 30)
      for (let i = 0; i < 30; i++) {
        const result = checkApiRateLimit();
        expect(result.allowed).toBe(true);
      }

      // Next request should be blocked
      const result = checkApiRateLimit();
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Rate limit exceeded');
    });

    it('should include retry message when blocked', () => {
      // Fill up the limit
      for (let i = 0; i < 30; i++) {
        checkApiRateLimit();
      }

      const result = checkApiRateLimit();
      expect(result.message).toContain('Please wait');
    });
  });

  describe('checkCommandRateLimit', () => {
    it('should allow commands under limit', () => {
      const result = checkCommandRateLimit();
      expect(result.allowed).toBe(true);
    });

    it('should track command count', () => {
      checkCommandRateLimit();
      checkCommandRateLimit();

      const status = getRateLimitStatus();
      expect(status.commands.count).toBe(2);
    });

    it('should block commands over limit', () => {
      // Make commands up to the limit (default 100)
      for (let i = 0; i < 100; i++) {
        checkCommandRateLimit();
      }

      const result = checkCommandRateLimit();
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Too many commands');
    });
  });

  describe('resetRateLimits', () => {
    it('should reset all counters', () => {
      // Make some requests
      checkApiRateLimit();
      checkApiRateLimit();
      checkCommandRateLimit();
      checkCommandRateLimit();
      checkCommandRateLimit();

      let status = getRateLimitStatus();
      expect(status.api.count).toBe(2);
      expect(status.commands.count).toBe(3);

      // Reset
      resetRateLimits();

      status = getRateLimitStatus();
      expect(status.api.count).toBe(0);
      expect(status.commands.count).toBe(0);
    });

    it('should allow requests after reset', () => {
      // Fill up the limit
      for (let i = 0; i < 30; i++) {
        checkApiRateLimit();
      }

      // Should be blocked
      expect(checkApiRateLimit().allowed).toBe(false);

      // Reset
      resetRateLimits();

      // Should be allowed again
      expect(checkApiRateLimit().allowed).toBe(true);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return current counts and limits', () => {
      const status = getRateLimitStatus();

      expect(status.api).toHaveProperty('count');
      expect(status.api).toHaveProperty('limit');
      expect(status.commands).toHaveProperty('count');
      expect(status.commands).toHaveProperty('limit');
    });

    it('should return correct limits', () => {
      const status = getRateLimitStatus();

      expect(status.api.limit).toBe(30);
      expect(status.commands.limit).toBe(100);
    });

    it('should update count after requests', () => {
      expect(getRateLimitStatus().api.count).toBe(0);

      checkApiRateLimit();
      expect(getRateLimitStatus().api.count).toBe(1);

      checkApiRateLimit();
      expect(getRateLimitStatus().api.count).toBe(2);
    });
  });

  describe('sliding window behavior', () => {
    it('should expire old requests after window', async () => {
      // This test uses fake timers to simulate time passing
      vi.useFakeTimers();

      // Make some requests
      for (let i = 0; i < 30; i++) {
        checkApiRateLimit();
      }

      // Should be blocked
      expect(checkApiRateLimit().allowed).toBe(false);

      // Advance time past the window (60 seconds)
      vi.advanceTimersByTime(61000);

      // Should be allowed again (old requests expired)
      expect(checkApiRateLimit().allowed).toBe(true);

      vi.useRealTimers();
    });
  });
});
