import { describe, it, expect } from 'vitest';
import { ollamaModelHint } from './ollamaHint';

describe('ollamaModelHint', () => {
  describe('agent-capable (≥ 7B)', () => {
    it.each([
      '7b', '7B',
      '8b',
      '13b', '14b',
      '32b', '70b', '72b',
    ])('returns the agent-mode hint for %s', (id) => {
      expect(ollamaModelHint(id)).toBe('✓ agent mode');
    });

    it('extracts the size from a namespaced Ollama tag', () => {
      expect(ollamaModelHint('qwen3:14b')).toBe('✓ agent mode');
      expect(ollamaModelHint('llama3.1:70b')).toBe('✓ agent mode');
    });

    it('extracts the size from a hyphenated model id', () => {
      expect(ollamaModelHint('llama2-13b')).toBe('✓ agent mode');
      expect(ollamaModelHint('mistral-7b-instruct')).toBe('✓ agent mode');
    });
  });

  describe('chat-only (< 7B)', () => {
    it.each([
      '1.5b', '1B', '3b', '4b', '6b',
    ])('returns the chat-only hint for %s', (id) => {
      expect(ollamaModelHint(id)).toBe('⚠ chat only (< 7B)');
    });

    it('handles decimal sizes under 7B', () => {
      expect(ollamaModelHint('phi3:3.8b')).toBe('⚠ chat only (< 7B)');
      expect(ollamaModelHint('gemma:2b')).toBe('⚠ chat only (< 7B)');
    });
  });

  describe('no size detected', () => {
    it('returns an empty string when no <n>b token is present', () => {
      expect(ollamaModelHint('custom-model')).toBe('');
      expect(ollamaModelHint('qwen3')).toBe('');
      expect(ollamaModelHint('')).toBe('');
    });

    it('returns empty for names that merely contain a "b"', () => {
      // "baby" contains "b" but no parameter count — should not match.
      expect(ollamaModelHint('baby-llama')).toBe('');
    });
  });

  describe('boundary', () => {
    it('treats exactly 7B as agent-capable', () => {
      expect(ollamaModelHint('7b')).toBe('✓ agent mode');
    });

    it('treats 6.9B as chat-only', () => {
      expect(ollamaModelHint('6.9b')).toBe('⚠ chat only (< 7B)');
    });
  });
});
