import { describe, it, expect, vi } from 'vitest';
import {
  withRetry,
  isNetworkError,
  isTimeoutError,
  fetchWithTimeout,
} from './retry';

describe('retry utilities', () => {
  describe('isNetworkError', () => {
    it('should detect fetch TypeError', () => {
      const error = new TypeError('Failed to fetch');
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect network TypeError', () => {
      const error = new TypeError('Network request failed');
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect ECONNREFUSED', () => {
      const error = { code: 'ECONNREFUSED' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect ENOTFOUND', () => {
      const error = { code: 'ENOTFOUND' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect ETIMEDOUT', () => {
      const error = { code: 'ETIMEDOUT' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect ENETUNREACH', () => {
      const error = { code: 'ENETUNREACH' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect ECONNRESET', () => {
      const error = { code: 'ECONNRESET' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should return false for non-network errors', () => {
      expect(isNetworkError(new Error('Some other error'))).toBe(false);
      expect(isNetworkError({ status: 400 })).toBe(false);
      expect(isNetworkError({ code: 'EPERM' })).toBe(false);
    });
  });

  describe('isTimeoutError', () => {
    it('should detect AbortError', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      expect(isTimeoutError(error)).toBe(true);
    });

    it('should detect ETIMEDOUT', () => {
      const error = { code: 'ETIMEDOUT' };
      expect(isTimeoutError(error)).toBe(true);
    });

    it('should return false for non-timeout errors', () => {
      expect(isTimeoutError(new Error('Some error'))).toBe(false);
      expect(isTimeoutError({ code: 'ECONNREFUSED' })).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      
      const result = await withRetry(fn);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');
      
      const result = await withRetry(fn, { baseDelay: 10 });
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max attempts', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('always fails'));
      
      await expect(withRetry(fn, { maxAttempts: 3, baseDelay: 10 }))
        .rejects.toThrow('always fails');
      
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry on AbortError', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      const fn = vi.fn().mockRejectedValue(abortError);
      
      await expect(withRetry(fn, { maxAttempts: 3, baseDelay: 10 }))
        .rejects.toThrow('Aborted');
      
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should call onRetry callback', async () => {
      const onRetry = vi.fn();
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');
      
      await withRetry(fn, { baseDelay: 10, onRetry });
      
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
    });

    it('should respect shouldRetry option', async () => {
      const shouldRetry = vi.fn().mockReturnValue(false);
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      
      await expect(withRetry(fn, { shouldRetry, maxAttempts: 3, baseDelay: 10 }))
        .rejects.toThrow('fail');
      
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 4xx errors by default', async () => {
      const error = { status: 400, message: 'Bad Request' };
      const fn = vi.fn().mockRejectedValue(error);
      
      await expect(withRetry(fn, { maxAttempts: 3, baseDelay: 10 }))
        .rejects.toEqual(error);
      
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on 5xx errors by default', async () => {
      const error = { status: 500, message: 'Server Error' };
      const fn = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');
      
      const result = await withRetry(fn, { baseDelay: 10 });
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should respect maxDelay', async () => {
      const onRetry = vi.fn();
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');
      
      await withRetry(fn, { baseDelay: 1000, maxDelay: 100, onRetry });
      
      // All delays should be capped at maxDelay
      for (const call of onRetry.mock.calls) {
        expect(call[2]).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('fetchWithTimeout', () => {
    it('should make fetch request', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);
      
      const response = await fetchWithTimeout('https://example.com');
      
      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should abort on timeout', async () => {
      global.fetch = vi.fn().mockImplementation(() => 
        new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          }, 100);
        })
      );
      
      await expect(fetchWithTimeout('https://example.com', { timeout: 50 }))
        .rejects.toThrow();
    });

    it('should pass through fetch options', async () => {
      const mockResponse = new Response('ok');
      global.fetch = vi.fn().mockResolvedValue(mockResponse);
      
      await fetchWithTimeout('https://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      });
      
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ test: true }),
        })
      );
    });
  });
});
