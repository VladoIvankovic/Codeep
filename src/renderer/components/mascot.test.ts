import { describe, it, expect } from 'vitest';
import {
  MASCOT_WIDTH,
  MASCOT_HEIGHT,
  MASCOT_GAP,
  MASCOT_FRAMES,
  layoutLogoWithMascot,
  introMascotFrame,
} from './mascot';
import { LOGO_LINES, LOGO_HEIGHT } from './uiConstants';
import { visibleLength } from '../ansi';

const LOGO_WIDTH = LOGO_LINES[0].length;
const PAIR_WIDTH = MASCOT_WIDTH + MASCOT_GAP + LOGO_WIDTH;

describe('MASCOT_FRAMES', () => {
  it('is 16 columns × 7 lines', () => {
    expect(MASCOT_WIDTH).toBe(16);
    expect(MASCOT_HEIGHT).toBe(7);
  });

  it.each(Object.entries(MASCOT_FRAMES))('%s has 7 lines of exactly 16 columns', (_name, frame) => {
    expect(frame).toHaveLength(MASCOT_HEIGHT);
    for (const line of frame) {
      // Code units AND display columns: callers use `.length` as the width.
      expect(line.length).toBe(MASCOT_WIDTH);
      expect(visibleLength(line)).toBe(MASCOT_WIDTH);
    }
  });

  it.each(['lookLeft', 'lookRight', 'blink'] as const)('%s differs from idle only on line 1 (the pupils)', (name) => {
    const frame = MASCOT_FRAMES[name];
    for (let i = 0; i < MASCOT_HEIGHT; i++) {
      if (i === 1) expect(frame[i]).not.toBe(MASCOT_FRAMES.idle[i]);
      else expect(frame[i]).toBe(MASCOT_FRAMES.idle[i]);
    }
  });

  it('has four distinct pupil rows', () => {
    const pupils = Object.values(MASCOT_FRAMES).map(f => f[1]);
    expect(new Set(pupils).size).toBe(4);
  });
});

describe('layoutLogoWithMascot', () => {
  it('puts the mascot left of the wordmark with a 3-column gap, centred as a pair', () => {
    const layout = layoutLogoWithMascot(120);
    expect(layout.mascotX).toBe(Math.floor((120 - PAIR_WIDTH) / 2));
    expect(layout.logoX - layout.mascotX!).toBe(MASCOT_WIDTH + 3);
    // Equal margins either side (± 1 for odd leftovers).
    const right = 120 - (layout.logoX + LOGO_WIDTH);
    expect(Math.abs(right - layout.mascotX!)).toBeLessThanOrEqual(1);
  });

  it('sits the wordmark on mascot lines 1..6', () => {
    const layout = layoutLogoWithMascot(120);
    expect(layout.logoDy).toBe(1);
    expect(layout.logoDy + LOGO_HEIGHT).toBe(MASCOT_HEIGHT);
    expect(layout.height).toBe(MASCOT_HEIGHT);
  });

  it('keeps the mascot at exactly mascot + gap + wordmark + 4 columns', () => {
    const layout = layoutLogoWithMascot(PAIR_WIDTH + 4);
    expect(layout.mascotX).toBe(2);
    expect(layout.logoX).toBe(2 + MASCOT_WIDTH + MASCOT_GAP);
  });

  it('drops the mascot one column narrower and centres the wordmark alone', () => {
    const width = PAIR_WIDTH + 3;
    expect(layoutLogoWithMascot(width)).toEqual({
      mascotX: null,
      logoX: Math.floor((width - LOGO_WIDTH) / 2),
      logoDy: 0,
      height: LOGO_HEIGHT,
    });
  });

  it('never places the wordmark at a negative column', () => {
    expect(layoutLogoWithMascot(30).logoX).toBe(0);
  });
});

describe('introMascotFrame', () => {
  const DECRYPT_MS = 1500;

  it('steps the pupils centre → left → centre → right about every 250 ms', () => {
    expect(introMascotFrame(0, DECRYPT_MS)).toBe(MASCOT_FRAMES.idle);
    expect(introMascotFrame(300, DECRYPT_MS)).toBe(MASCOT_FRAMES.lookLeft);
    expect(introMascotFrame(600, DECRYPT_MS)).toBe(MASCOT_FRAMES.idle);
    expect(introMascotFrame(800, DECRYPT_MS)).toBe(MASCOT_FRAMES.lookRight);
    expect(introMascotFrame(1100, DECRYPT_MS)).toBe(MASCOT_FRAMES.idle);
  });

  it('blinks just before the decrypt completes, then opens its eyes', () => {
    expect(introMascotFrame(DECRYPT_MS - 50, DECRYPT_MS)).toBe(MASCOT_FRAMES.blink);
    expect(introMascotFrame(DECRYPT_MS, DECRYPT_MS)).toBe(MASCOT_FRAMES.idle);
  });

  // 1000 ms is Intro.ts's default decrypt: the steps scale, so it still holds
  // centre between the right glance and the blink.
  it.each([1000, DECRYPT_MS])('plays the whole sequence once, with a single blink, over a ~60 FPS %i ms run', (decryptMs) => {
    const seq: Array<readonly string[]> = [];
    for (let t = 0; t < decryptMs; t += 16) {
      const frame = introMascotFrame(t, decryptMs);
      if (seq[seq.length - 1] !== frame) seq.push(frame);
    }
    const { idle, lookLeft, lookRight, blink } = MASCOT_FRAMES;
    expect(seq).toEqual([idle, lookLeft, idle, lookRight, idle, blink]);
  });

  it('is idle outside the decrypt phase', () => {
    expect(introMascotFrame(-1, DECRYPT_MS)).toBe(MASCOT_FRAMES.idle);
    expect(introMascotFrame(DECRYPT_MS + 500, DECRYPT_MS)).toBe(MASCOT_FRAMES.idle);
  });
});
