import { describe, it, expect } from 'vitest';
import {
  GLITCH_CHARS,
  generateNoiseLine,
  getDecryptedLine,
} from './Intro';

describe('GLITCH_CHARS', () => {
  it('is a non-empty string of glitch characters', () => {
    expect(GLITCH_CHARS.length).toBeGreaterThan(10);
    expect(typeof GLITCH_CHARS).toBe('string');
  });
});

describe('generateNoiseLine', () => {
  it('produces a string of the same length as the input', () => {
    const out = generateNoiseLine('hello world');
    expect(out.length).toBe(11);
  });

  it('returns an empty string for empty input', () => {
    expect(generateNoiseLine('')).toBe('');
  });

  it('preserves spaces in roughly their original positions', () => {
    // The function keeps spaces with ~90% probability, so over a long
    // input we should see most spaces survive.
    const input = 'a b c d e f g h i j k l m n o p q r s t u v w x y z';
    const out = generateNoiseLine(input);
    const spacesIn = (input.match(/ /g) ?? []).length;
    const spacesOut = (out.match(/ /g) ?? []).length;
    expect(spacesOut).toBeGreaterThan(spacesIn * 0.5);
  });

  it('replaces every non-space char with a member of GLITCH_CHARS', () => {
    const input = 'AAAA';
    const out = generateNoiseLine(input);
    for (const ch of out) {
      // Either a space (rare) or a glitch char.
      expect(ch === ' ' || GLITCH_CHARS.includes(ch)).toBe(true);
    }
  });
});

describe('getDecryptedLine', () => {
  it('produces a string of the same length as the input', () => {
    const out = getDecryptedLine('hello world', 0.5);
    expect(out.length).toBe(11);
  });

  it('preserves spaces verbatim', () => {
    const out = getDecryptedLine('a b c', 0.0);
    // Even at progress 0, spaces are kept.
    expect(out[1]).toBe(' ');
    expect(out[3]).toBe(' ');
  });

  it('reveals the whole string when progress > 0.95', () => {
    const input = 'secret message';
    const out = getDecryptedLine(input, 1.0);
    expect(out).toBe(input);
  });

  it('progress > 0.95 reveals everything regardless of randomness', () => {
    const input = 'xxxxxxxxxx';
    const out = getDecryptedLine(input, 0.97);
    expect(out).toBe(input);
  });

  it('at progress 0, may still reveal some characters due to randomness', () => {
    // The decryption logic is probabilistic: `isDecrypted` is true with
    // ~80% probability once `progress >= threshold - 0.1`, and at i=0 the
    // threshold is 0, so `0 >= -0.1` always holds. This test documents
    // that the function does NOT guarantee a fully-glitched output at
    // progress 0 — only that spaces are always preserved.
    const input = 'abcd';
    const out = getDecryptedLine(input, 0.0);
    expect(out.length).toBe(input.length);
    // Spaces (if any) are preserved.
    for (let i = 0; i < input.length; i++) {
      if (input[i] === ' ') expect(out[i]).toBe(' ');
    }
  });

  it('handles empty input', () => {
    expect(getDecryptedLine('', 0.5)).toBe('');
  });

  it('does not throw on a long input', () => {
    const input = 'a'.repeat(1000);
    expect(() => getDecryptedLine(input, 0.5)).not.toThrow();
  });
});
