// Unit tests for the extracted MentionPicker component (P2 App.ts refactor).
// Pins the navigation/selection semantics and the `@`-sigil-preserving
// buffer math (the sigil re-add is load-bearing: without it the completed
// path is no longer a mention and the file never gets attached).

import { describe, it, expect } from 'vitest';
import {
  createMentionPickerState,
  openMentionPicker,
  closeMentionPicker,
  handleMentionPickerKey,
  applyMentionToBuffer,
  type MentionPickerState,
} from './MentionPicker';
import type { MentionSuggestion } from '../../utils/mentions';

function items(n: number): MentionSuggestion[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `file${i}.ts`,
    detail: `src/dir${i}`,
    insertPath: `src/dir${i}/file${i}.ts`,
  }));
}

function open(n = 3, atStart = 5): MentionPickerState {
  return openMentionPicker(createMentionPickerState(), items(n), atStart, '/proj');
}

function key(k: string): { key: string } {
  return { key: k };
}

describe('MentionPicker', () => {
  it('fresh state is closed with no items', () => {
    const s = createMentionPickerState();
    expect(s.open).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.index).toBe(0);
  });

  it('openMentionPicker opens iff there are items, resetting the index', () => {
    const s = open(3);
    expect(s.open).toBe(true);
    expect(s.index).toBe(0);
    expect(s.atStart).toBe(5);
    expect(s.items.length).toBe(3);

    const empty = openMentionPicker(createMentionPickerState(), [], 0, '/x');
    expect(empty.open).toBe(false);
  });

  it('closeMentionPicker clears items but keeps root/atStart', () => {
    const s = closeMentionPicker(open(3, 7));
    expect(s.open).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.atStart).toBe(7);
  });

  describe('key handling', () => {
    it('up/down navigate with clamping', () => {
      let s = open(3);
      s = handleMentionPickerKey(s, key('up')).state;   // clamp at 0
      expect(s.index).toBe(0);
      s = handleMentionPickerKey(s, key('down')).state; // → 1
      s = handleMentionPickerKey(s, key('down')).state; // → 2
      expect(s.index).toBe(2);
      s = handleMentionPickerKey(s, key('down')).state; // clamp at last
      expect(s.index).toBe(2);
    });

    it('tab with items selects the current one and closes', () => {
      const s0 = open(3, 4);
      const { state, action } = handleMentionPickerKey(s0, key('tab'));
      expect(action.type).toBe('select');
      if (action.type === 'select') {
        expect(action.suggestion).toBe(s0.items[0]);
        expect(action.atStart).toBe(4);
      }
      expect(state.open).toBe(false);
    });

    it('tab with no items falls through (none)', () => {
      const s0 = { ...open(3), items: [] as MentionSuggestion[], open: true };
      const { action } = handleMentionPickerKey(s0, key('tab'));
      expect(action.type).toBe('none');
    });

    it('other keys fall through so the editor still sees them', () => {
      const { state, action } = handleMentionPickerKey(open(3), key('a'));
      expect(action.type).toBe('none');
      expect(state).toEqual(open(3));
    });
  });

  describe('applyMentionToBuffer', () => {
    it('replaces @query with @path, keeps sigil, spaces, restores tail', () => {
      // buffer: "see @src/in and more" — @ at index 4, cursor at 11
      const value = 'see @src/in and more';
      const result = applyMentionToBuffer(value, 11, 4, {
        label: 'index.ts',
        detail: 'src',
        insertPath: 'src/index.ts',
      });
      expect(result.value).toBe('see @src/index.ts  and more');
      //   before = "see @" (5) + "src/index.ts " (13) → cursor 18
      expect(result.cursor).toBe(18);
    });

    it('works at the very start of the buffer', () => {
      const result = applyMentionToBuffer('@he', 3, 0, {
        label: 'hello.ts',
        detail: '',
        insertPath: 'hello.ts',
      });
      expect(result.value).toBe('@hello.ts ');
      expect(result.cursor).toBe(10);
    });
  });
});
