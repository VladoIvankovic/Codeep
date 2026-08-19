// Unit tests for the extracted CommandAutocomplete component (P2 App.ts
// refactor). Pins navigation/selection semantics and the buffer rewrite.

import { describe, it, expect } from 'vitest';
import {
  createCommandAutocompleteState,
  setCommandAutocomplete,
  closeCommandAutocomplete,
  handleCommandAutocompleteKey,
  commandToBuffer,
  type CommandAutocompleteState,
} from './CommandAutocomplete';

function open(items: string[], index = 0): CommandAutocompleteState {
  return setCommandAutocomplete(createCommandAutocompleteState(), items, index);
}

function key(k: string): { key: string } {
  return { key: k };
}

describe('CommandAutocomplete', () => {
  it('fresh state is closed with no items', () => {
    const s = createCommandAutocompleteState();
    expect(s.open).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.index).toBe(0);
  });

  it('setCommandAutocomplete opens iff there are items, honoring the filter index', () => {
    const s = setCommandAutocomplete(createCommandAutocompleteState(), ['help', 'model'], 1);
    expect(s.open).toBe(true);
    expect(s.index).toBe(1);
    expect(setCommandAutocomplete(s, [], 0).open).toBe(false);
  });

  it('closeCommandAutocomplete clears items', () => {
    const s = closeCommandAutocomplete(open(['help']));
    expect(s.open).toBe(false);
    expect(s.items).toEqual([]);
  });

  describe('key handling', () => {
    it('up/down navigate with clamping', () => {
      let s = open(['a', 'b', 'c']);
      s = handleCommandAutocompleteKey(s, key('up')).state;   // clamp at 0
      expect(s.index).toBe(0);
      s = handleCommandAutocompleteKey(s, key('down')).state; // → 1
      s = handleCommandAutocompleteKey(s, key('down')).state; // → 2
      expect(s.index).toBe(2);
      s = handleCommandAutocompleteKey(s, key('down')).state; // clamp at last
      expect(s.index).toBe(2);
    });

    it('tab selects the current command and closes', () => {
      const { state, action } = handleCommandAutocompleteKey(open(['help', 'model'], 1), key('tab'));
      expect(action).toMatchObject({ type: 'select', command: 'model' });
      expect(state.open).toBe(false);
    });

    it('enter behaves like tab', () => {
      const { action } = handleCommandAutocompleteKey(open(['help']), key('enter'));
      expect(action).toMatchObject({ type: 'select', command: 'help' });
    });

    it('tab with no items falls through (none)', () => {
      const s0 = { ...open(['a']), items: [] as string[], open: true };
      const { action } = handleCommandAutocompleteKey(s0, key('tab'));
      expect(action.type).toBe('none');
    });

    it('other keys fall through so the editor still sees them', () => {
      const s0 = open(['help']);
      const { state, action } = handleCommandAutocompleteKey(s0, key('x'));
      expect(action.type).toBe('none');
      expect(state).toEqual(s0);
    });
  });

  describe('commandToBuffer', () => {
    it('rewrites the buffer as /<command> with a trailing space', () => {
      expect(commandToBuffer('model')).toBe('/model ');
      expect(commandToBuffer('checkpoint')).toBe('/checkpoint ');
    });
  });
});
