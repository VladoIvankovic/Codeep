import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config to use small, predictable limits so tests run fast and don't
// depend on the production defaults (which are now effectively unlimited).
vi.mock('../config/index', () => ({
  config: {
    get: vi.fn((k: string) => {
      if (k === 'rateLimitApi') return 5;
      if (k === 'rateLimitCommands') return 5;
      return undefined;
    }),
  },
}));

import {
  checkApiRateLimit,
  checkCommandRateLimit,
  resetRateLimits,
  getRateLimitStatus,
  updateRateLimits,
} from './ratelimit';

const API_LIMIT = 5;
const CMD_LIMIT = 5;

describe('ratelimit utilities', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  describe('checkApiRateLimit', () => {
    it('should allow requests under limit', () => {
      const result = checkApiRateLimit();
      expect(result.allowed).toBe(true);
      expect(result.message).toBeUndefined();
    });

    it('should track request count', () => {
      checkApiRateLimit();
      checkApiRateLimit();
      checkApiRateLimit();

      const status = getRateLimitStatus();
      expect(status.api.count).toBe(3);
    });

    it('should block requests over limit', () => {
      for (let i = 0; i < API_LIMIT; i++) {
        const result = checkApiRateLimit();
        expect(result.allowed).toBe(true);
      }

      const result = checkApiRateLimit();
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Rate limit exceeded');
    });

    it('should include retry message when blocked', () => {
      for (let i = 0; i < API_LIMIT; i++) {
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
      for (let i = 0; i < CMD_LIMIT; i++) {
        checkCommandRateLimit();
      }

      const result = checkCommandRateLimit();
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Too many commands');
    });
  });

  describe('resetRateLimits', () => {
    it('should reset all counters', () => {
      checkApiRateLimit();
      checkApiRateLimit();
      checkCommandRateLimit();
      checkCommandRateLimit();
      checkCommandRateLimit();

      let status = getRateLimitStatus();
      expect(status.api.count).toBe(2);
      expect(status.commands.count).toBe(3);

      resetRateLimits();

      status = getRateLimitStatus();
      expect(status.api.count).toBe(0);
      expect(status.commands.count).toBe(0);
    });

    it('should allow requests after reset', () => {
      for (let i = 0; i < API_LIMIT; i++) {
        checkApiRateLimit();
      }

      expect(checkApiRateLimit().allowed).toBe(false);

      resetRateLimits();

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

    it('should return correct limits from config', () => {
      const status = getRateLimitStatus();

      expect(status.api.limit).toBe(API_LIMIT);
      expect(status.commands.limit).toBe(CMD_LIMIT);
    });

    it('should update count after requests', () => {
      expect(getRateLimitStatus().api.count).toBe(0);

      checkApiRateLimit();
      expect(getRateLimitStatus().api.count).toBe(1);

      checkApiRateLimit();
      expect(getRateLimitStatus().api.count).toBe(2);
    });
  });

  describe('updateRateLimits', () => {
    it('should re-read limits from config', () => {
      // updateRateLimits re-creates the limiters from config (mocked to 5)
      updateRateLimits();
      const status = getRateLimitStatus();
      expect(status.api.limit).toBe(API_LIMIT);
      expect(status.commands.limit).toBe(CMD_LIMIT);
    });
  });

  describe('sliding window behavior', () => {
    it('should expire old requests after window', async () => {
      vi.useFakeTimers();

      for (let i = 0; i < API_LIMIT; i++) {
        checkApiRateLimit();
      }

      expect(checkApiRateLimit().allowed).toBe(false);

      // Advance time past the window (60 seconds)
      vi.advanceTimersByTime(61000);

      expect(checkApiRateLimit().allowed).toBe(true);

      vi.useRealTimers();
    });
  });
});
