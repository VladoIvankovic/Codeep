import { describe, it, expect } from 'vitest';
import { boxChars, createBox, centerBox, type BoxOptions } from './Box';

describe('boxChars', () => {
  it('defines the four styles', () => {
    expect(Object.keys(boxChars).sort()).toEqual(['double', 'heavy', 'rounded', 'single']);
  });

  it.each(['single', 'double', 'rounded', 'heavy'] as const)(
    'style %s has all six border characters',
    (s) => {
      const c = boxChars[s];
      for (const k of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'horizontal', 'vertical'] as const) {
        expect(typeof c[k]).toBe('string');
        expect(c[k].length).toBeGreaterThan(0);
      }
    },
  );
});

describe('centerBox', () => {
  it('centres a box of the given size on the screen', () => {
    const pos = centerBox(100, 40, 20, 10);
    expect(pos).toEqual({ x: 40, y: 15 });
  });

  it('floors fractional positions', () => {
    const pos = centerBox(101, 41, 20, 10);
    expect(pos).toEqual({ x: 40, y: 15 }); // floor((101-20)/2)=40, floor((41-10)/2)=15
  });

  it('returns negative coords when the box is bigger than the screen', () => {
    const pos = centerBox(10, 10, 20, 20);
    expect(pos.x).toBe(-5);
    expect(pos.y).toBe(-5);
  });
});

describe('createBox', () => {
  function opts(overrides: Partial<BoxOptions> = {}): BoxOptions {
    return { x: 0, y: 0, width: 10, height: 4, ...overrides };
  }

  it('returns exactly height lines', () => {
    const lines = createBox(opts({ height: 5 }));
    expect(lines.length).toBe(5);
  });

  it('places the first line at y and the last at y + height - 1', () => {
    const lines = createBox(opts({ y: 7, height: 3 }));
    expect(lines[0].y).toBe(7);
    expect(lines[2].y).toBe(9);
  });

  it('uses the single-line chars by default for the corners', () => {
    const lines = createBox(opts());
    expect(lines[0].text).toContain('┌');
    expect(lines[0].text).toContain('┐');
    expect(lines[lines.length - 1].text).toContain('└');
    expect(lines[lines.length - 1].text).toContain('┘');
  });

  it('uses the chosen style for the corners', () => {
    const lines = createBox(opts({ style: 'double' }));
    expect(lines[0].text).toContain('╔');
    expect(lines[lines.length - 1].text).toContain('╚');
  });

  it('fills the middle rows with vertical bars and spaces', () => {
    const lines = createBox(opts({ height: 4 }));
    // rows 1 and 2 are middle rows.
    expect(lines[1].text).toMatch(/^│.{8}│$/);
    expect(lines[2].text).toMatch(/^│.{8}│$/);
  });

  it('prefixes every line with x spaces', () => {
    const lines = createBox(opts({ x: 5 }));
    expect(lines.every((l) => l.text.startsWith('     '))).toBe(true);
  });

  it('embeds a centred title in the top border when width permits', () => {
    const lines = createBox(opts({ width: 20, title: 'Hi' }));
    // The title "Hi" (with surrounding spaces) sits roughly in the middle.
    expect(lines[0].text).toContain('Hi');
  });

  it('left-aligns the title when titleAlign is "left"', () => {
    const lines = createBox(opts({ width: 20, title: 'Hi', titleAlign: 'left' }));
    // The title appears near the start of the top border.
    expect(lines[0].text.indexOf('Hi')).toBeLessThan(8);
  });

  it('right-aligns the title when titleAlign is "right"', () => {
    const lines = createBox(opts({ width: 20, title: 'Hi', titleAlign: 'right' }));
    // The title appears near the end of the top border.
    expect(lines[0].text.lastIndexOf('Hi')).toBeGreaterThan(10);
  });

  it('truncates long titles with an ellipsis', () => {
    const long = 'x'.repeat(50);
    const lines = createBox(opts({ width: 12, title: long }));
    expect(lines[0].text).toContain('…');
    // The ellipsis appears within the top border.
    expect(lines[0].text.length).toBeLessThan(long.length);
  });

  it('omits the title entirely when the box is too narrow', () => {
    // width 4 is the threshold below which titles are suppressed.
    const lines = createBox(opts({ width: 4, title: 'Hi' }));
    expect(lines[0].text).not.toContain('Hi');
  });

  it('omits the title when no title is provided', () => {
    const lines = createBox(opts());
    expect(lines[0].text).not.toContain('…');
  });
});
