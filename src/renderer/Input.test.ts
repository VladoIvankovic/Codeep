import { describe, it, expect } from 'vitest';
import { LineEditor } from './Input';
import type { KeyEvent } from './Input';

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { key: 'x', ctrl: false, alt: false, shift: false, raw: '', ...overrides };
}

describe('LineEditor — value & cursor basics', () => {
  it('starts empty with cursor at 0', () => {
    const e = new LineEditor();
    expect(e.getValue()).toBe('');
    expect(e.getCursorPos()).toBe(0);
  });

  it('setValue moves the cursor to the end', () => {
    const e = new LineEditor();
    e.setValue('hello');
    expect(e.getValue()).toBe('hello');
    expect(e.getCursorPos()).toBe(5);
  });

  it('clear resets value, cursor, and history navigation', () => {
    const e = new LineEditor();
    e.setValue('x');
    e.clear();
    expect(e.getValue()).toBe('');
    expect(e.getCursorPos()).toBe(0);
  });
});

describe('LineEditor — insert', () => {
  it('inserts at the cursor and advances it', () => {
    const e = new LineEditor();
    e.insert('foo');
    expect(e.getValue()).toBe('foo');
    expect(e.getCursorPos()).toBe(3);
  });

  it('inserts in the middle, splitting the existing text', () => {
    const e = new LineEditor();
    e.setValue('hello');
    e.setCursorPos(2);
    e.insert('XX');
    expect(e.getValue()).toBe('heXXllo');
    expect(e.getCursorPos()).toBe(4);
  });
});

describe('LineEditor — setCursorPos', () => {
  it('clamps to [0, length]', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.setCursorPos(-5);
    expect(e.getCursorPos()).toBe(0);
    e.setCursorPos(99);
    expect(e.getCursorPos()).toBe(3);
  });
});

describe('LineEditor — word movement', () => {
  it('wordLeft stops at the previous word boundary', () => {
    const e = new LineEditor();
    e.setValue('foo bar baz');
    e.setCursorPos(11);
    e.wordLeft();
    expect(e.getCursorPos()).toBe(8); // start of "baz"
  });

  it('wordLeft skips preceding boundary chars', () => {
    const e = new LineEditor();
    e.setValue('foo   bar');
    e.setCursorPos(9);
    e.wordLeft();
    expect(e.getCursorPos()).toBe(6); // start of "bar" (after 3 spaces)
  });

  it('wordLeft stops at 0 when there is nowhere to go', () => {
    const e = new LineEditor();
    e.setValue('hello');
    e.setCursorPos(5);
    e.wordLeft();
    expect(e.getCursorPos()).toBe(0);
  });

  it('wordLeft treats path separators as boundaries', () => {
    const e = new LineEditor();
    e.setValue('src/foo/bar.ts');
    e.setCursorPos(14);
    e.wordLeft();
    // '.' is also a boundary, so wordLeft stops at the start of "ts"
    // (after the dot), not at the start of "bar.ts".
    expect(e.getCursorPos()).toBe(12);
  });

  it('wordRight advances past the current word and its trailing space', () => {
    const e = new LineEditor();
    e.setValue('foo bar');
    e.setCursorPos(0);
    e.wordRight();
    // wordRight also skips the boundary chars after the word, so the
    // cursor lands at the start of the next word (4), not right after
    // "foo" (3).
    expect(e.getCursorPos()).toBe(4);
  });

  it('wordRight skips boundary chars after the word', () => {
    const e = new LineEditor();
    e.setValue('foo   bar');
    e.setCursorPos(0);
    e.wordRight();
    expect(e.getCursorPos()).toBe(6); // start of "bar"
  });

  it('wordRight stops at the end of the line', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.setCursorPos(0);
    e.wordRight();
    expect(e.getCursorPos()).toBe(3);
  });
});

describe('LineEditor — deleteWordBackward', () => {
  it('deletes the word before the cursor', () => {
    const e = new LineEditor();
    e.setValue('foo bar baz');
    e.setCursorPos(11);
    e.deleteWordBackward();
    expect(e.getValue()).toBe('foo bar ');
    expect(e.getCursorPos()).toBe(8);
  });

  it('deletes trailing spaces first, then the word', () => {
    const e = new LineEditor();
    e.setValue('foo   ');
    e.setCursorPos(6);
    e.deleteWordBackward();
    expect(e.getValue()).toBe('');
  });

  it('does nothing at position 0', () => {
    const e = new LineEditor();
    e.setValue('hello');
    e.setCursorPos(0);
    e.deleteWordBackward();
    expect(e.getValue()).toBe('hello');
  });

  it('stops at a path separator', () => {
    const e = new LineEditor();
    e.setValue('src/foo/bar');
    e.setCursorPos(11);
    e.deleteWordBackward();
    expect(e.getValue()).toBe('src/foo/');
  });
});

describe('LineEditor — deleteToEnd', () => {
  it('removes everything from the cursor onwards', () => {
    const e = new LineEditor();
    e.setValue('hello world');
    e.setCursorPos(5);
    e.deleteToEnd();
    expect(e.getValue()).toBe('hello');
  });

  it('does nothing when the cursor is at the end', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.deleteToEnd();
    expect(e.getValue()).toBe('abc');
  });
});

describe('LineEditor — handleKey', () => {
  it('backspace deletes the char before the cursor', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.setCursorPos(2);
    expect(e.handleKey(key({ key: 'backspace' }))).toBe(true);
    expect(e.getValue()).toBe('ac');
    expect(e.getCursorPos()).toBe(1);
  });

  it('backspace does nothing at position 0', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.setCursorPos(0);
    expect(e.handleKey(key({ key: 'backspace' }))).toBe(false);
    expect(e.getValue()).toBe('abc');
  });

  it('delete removes the char at the cursor', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.setCursorPos(0);
    expect(e.handleKey(key({ key: 'delete' }))).toBe(true);
    expect(e.getValue()).toBe('bc');
  });

  it('left / right move the cursor within bounds', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.setCursorPos(3);
    e.handleKey(key({ key: 'left' }));
    expect(e.getCursorPos()).toBe(2);
    e.setCursorPos(0);
    e.handleKey(key({ key: 'left' }));
    expect(e.getCursorPos()).toBe(0);
    e.handleKey(key({ key: 'right' }));
    expect(e.getCursorPos()).toBe(1);
  });

  it('home / end jump to the line edges', () => {
    const e = new LineEditor();
    e.setValue('hello');
    e.handleKey(key({ key: 'home' }));
    expect(e.getCursorPos()).toBe(0);
    e.handleKey(key({ key: 'end' }));
    expect(e.getCursorPos()).toBe(5);
  });

  it('ctrl-left / ctrl-right invoke wordLeft / wordRight', () => {
    const e = new LineEditor();
    e.setValue('foo bar');
    e.setCursorPos(7);
    e.handleKey(key({ key: 'ctrl-left' }));
    expect(e.getCursorPos()).toBe(4);
    e.handleKey(key({ key: 'ctrl-right' }));
    expect(e.getCursorPos()).toBe(7);
  });

  it('a regular printable char is inserted at the cursor', () => {
    const e = new LineEditor();
    e.setValue('ab');
    e.setCursorPos(1);
    expect(e.handleKey(key({ key: 'X' }))).toBe(true);
    expect(e.getValue()).toBe('aXb');
    expect(e.getCursorPos()).toBe(2);
  });

  it('alt+b / alt+f move by word', () => {
    const e = new LineEditor();
    e.setValue('foo bar');
    e.setCursorPos(7);
    e.handleKey(key({ key: 'b', alt: true }));
    expect(e.getCursorPos()).toBe(4);
    e.handleKey(key({ key: 'f', alt: true }));
    expect(e.getCursorPos()).toBe(7);
  });

  it('control-modified printable chars are not inserted', () => {
    const e = new LineEditor();
    e.setValue('');
    expect(e.handleKey(key({ key: 'c', ctrl: true }))).toBe(false);
    expect(e.getValue()).toBe('');
  });
});

describe('LineEditor — history', () => {
  it('arrow up walks backward through history', () => {
    const e = new LineEditor();
    e.addToHistory('first');
    e.addToHistory('second');
    e.handleKey(key({ key: 'up' }));
    expect(e.getValue()).toBe('second');
    e.handleKey(key({ key: 'up' }));
    expect(e.getValue()).toBe('first');
  });

  it('arrow down walks forward and restores the draft at the end', () => {
    const e = new LineEditor();
    e.addToHistory('first');
    e.setValue('draft');
    e.handleKey(key({ key: 'up' }));
    expect(e.getValue()).toBe('first');
    e.handleKey(key({ key: 'down' }));
    expect(e.getValue()).toBe('draft');
  });

  it('arrow up does nothing when history is empty', () => {
    const e = new LineEditor();
    e.handleKey(key({ key: 'up' }));
    expect(e.getValue()).toBe('');
  });

  it('arrow down does nothing when not browsing history', () => {
    const e = new LineEditor();
    e.setValue('abc');
    e.handleKey(key({ key: 'down' }));
    expect(e.getValue()).toBe('abc');
  });

  it('ignores empty / whitespace-only entries when adding to history', () => {
    const e = new LineEditor();
    e.addToHistory('   ');
    e.addToHistory('');
    e.handleKey(key({ key: 'up' }));
    expect(e.getValue()).toBe('');
  });

  it('caps the history at 100 entries', () => {
    const e = new LineEditor();
    for (let i = 0; i < 105; i++) e.addToHistory(`entry-${i}`);
    // Walk back to the oldest reachable entry.
    for (let i = 0; i < 100; i++) e.handleKey(key({ key: 'up' }));
    expect(e.getValue()).toBe('entry-5');
  });

  it('does not grow beyond 100 entries', () => {
    const e = new LineEditor();
    for (let i = 0; i < 105; i++) e.addToHistory(`entry-${i}`);
    // Walk all the way back; if the cap works we can walk 100 steps.
    let steps = 0;
    while (true) {
      const before = e.getValue();
      e.handleKey(key({ key: 'up' }));
      if (e.getValue() === before) break;
      steps++;
      if (steps > 200) throw new Error('runaway loop');
    }
    expect(steps).toBeLessThanOrEqual(100);
  });
});
