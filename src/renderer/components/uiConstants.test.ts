import { describe, it, expect } from 'vitest';
import {
  PRIMARY_COLOR,
  SPINNER_FRAMES,
  LOGO_LINES,
  LOGO_HEIGHT,
} from './uiConstants';

describe('uiConstants', () => {
  it('PRIMARY_COLOR is a non-empty ANSI escape string', () => {
    expect(typeof PRIMARY_COLOR).toBe('string');
    expect(PRIMARY_COLOR.length).toBeGreaterThan(0);
    // ANSI escape sequences start with \x1b[.
    expect(PRIMARY_COLOR.startsWith('\x1b[')).toBe(true);
  });

  it('SPINNER_FRAMES has 8 distinct frames', () => {
    expect(SPINNER_FRAMES.length).toBe(8);
    expect(new Set(SPINNER_FRAMES).size).toBe(8);
  });

  it('every spinner frame is a single character', () => {
    for (const f of SPINNER_FRAMES) {
      expect(f.length).toBe(1);
    }
  });

  it('LOGO_LINES has at least 5 rows', () => {
    expect(LOGO_LINES.length).toBeGreaterThanOrEqual(5);
  });

  it('LOGO_HEIGHT equals LOGO_LINES.length', () => {
    expect(LOGO_HEIGHT).toBe(LOGO_LINES.length);
  });

  it('every logo line is a non-empty string', () => {
    for (const line of LOGO_LINES) {
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
    }
  });
});
