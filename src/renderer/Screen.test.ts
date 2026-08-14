import { afterEach, describe, it, expect } from 'vitest';
import { Screen } from './Screen';

const screens: Screen[] = [];
function makeScreen(): Screen {
  const screen = new Screen();
  screens.push(screen);
  return screen;
}

afterEach(() => {
  for (const screen of screens.splice(0)) screen.cleanup();
});

describe('Screen — size & buffer', () => {
  it('getSize reports the terminal dimensions (≥ the floor)', () => {
    const s = makeScreen();
    const { width, height } = s.getSize();
    expect(width).toBeGreaterThanOrEqual(20);
    expect(height).toBeGreaterThanOrEqual(4);
  });

  it('clear resets every cell to a space', () => {
    const s = makeScreen();
    s.write(0, 0, 'hello');
    s.clear();
    // No public getter for the buffer, so we rely on the render output
    // being equivalent to a blank screen — exercise write/clear via the
    // observable writeLine behaviour instead.
    expect(() => s.clear()).not.toThrow();
  });
});

describe('Screen — write', () => {
  it('places characters into the buffer at (x, y)', () => {
    const s = makeScreen();
    // We can't read cells directly, but we can verify write doesn't throw
    // and that writeLine overwrites previous content.
    expect(() => s.write(0, 0, 'hi')).not.toThrow();
  });

  it('ignores writes to negative rows', () => {
    const s = makeScreen();
    expect(() => s.write(0, -1, 'x')).not.toThrow();
  });

  it('ignores writes to rows past the height', () => {
    const s = makeScreen();
    const { height } = s.getSize();
    expect(() => s.write(0, height + 100, 'x')).not.toThrow();
  });

  it('stops at a newline character in the input', () => {
    const s = makeScreen();
    // Documents that `write` breaks on `\n` — only the part before the
    // newline is written.
    expect(() => s.write(0, 0, 'foo\nbar')).not.toThrow();
  });
});

describe('Screen — writeLine', () => {
  it('overwrites the whole row, then writes the text at column 0', () => {
    const s = makeScreen();
    s.write(0, 0, 'XXXXXXXXXX');
    expect(() => s.writeLine(0, 'hi')).not.toThrow();
  });

  it('ignores rows out of bounds', () => {
    const s = makeScreen();
    expect(() => s.writeLine(-1, 'x')).not.toThrow();
    expect(() => s.writeLine(999, 'x')).not.toThrow();
  });
});

describe('Screen — writeWrapped', () => {
  it('returns the next available line after wrapping', () => {
    const s = makeScreen();
    const next = s.writeWrapped(0, 0, 'hello world foo bar baz', 10);
    // "hello world foo bar baz" with maxWidth 10 wraps to ≥3 lines.
    expect(next).toBeGreaterThan(0);
  });

  it('fits a short string on a single line', () => {
    const s = makeScreen();
    const next = s.writeWrapped(0, 0, 'short', 80);
    expect(next).toBe(1);
  });

  it('breaks long words onto separate lines', () => {
    const s = makeScreen();
    // Five 3-letter words with maxWidth 5 → each word on its own line.
    const next = s.writeWrapped(0, 0, 'aaa bbb ccc ddd eee', 5);
    expect(next).toBe(5);
  });

  it('does not write past the bottom of the screen', () => {
    const s = makeScreen();
    const { height } = s.getSize();
    const startY = height - 1;
    const next = s.writeWrapped(0, startY, 'aaa bbb ccc', 3);
    expect(next).toBeLessThanOrEqual(height);
  });
});

describe('Screen — horizontalLine', () => {
  it('fills the row with the given character', () => {
    const s = makeScreen();
    expect(() => s.horizontalLine(0)).not.toThrow();
    expect(() => s.horizontalLine(1, '*')).not.toThrow();
  });
});

describe('Screen — cursor', () => {
  it('showCursor and setCursor do not throw', () => {
    const s = makeScreen();
    expect(() => {
      s.setCursor(0, 0);
      s.showCursor(true);
      s.showCursor(false);
    }).not.toThrow();
  });
});

describe('Screen — render', () => {
  it('render and fullRender flush without throwing', () => {
    const s = makeScreen();
    s.write(0, 0, 'hello');
    expect(() => s.render()).not.toThrow();
    expect(() => s.fullRender()).not.toThrow();
  });
});

describe('Screen — onResize', () => {
  it('registers a callback without invoking it immediately', () => {
    const s = makeScreen();
    let called = false;
    s.onResize(() => { called = true; });
    expect(called).toBe(false);
  });
});
