// Unit tests for the extracted PasteDialog component (P2 App.ts refactor).
// Pins the y/Enter → add-to-input, s → send-directly, n/Esc → cancel
// semantics and that unrecognized keys leave the dialog open.

import { describe, it, expect } from 'vitest';
import {
  createPasteDialogState,
  handlePasteDialogKey,
  type PasteDialogState,
} from './PasteDialog';

function openState(text = 'pasted content\nline 2'): PasteDialogState {
  return {
    open: true,
    info: { chars: text.length, lines: text.split('\n').length, preview: text, fullText: text },
  };
}

function key(k: string): { key: string } {
  return { key: k };
}

describe('PasteDialog', () => {
  it('fresh state is closed with no info', () => {
    const s = createPasteDialogState();
    expect(s.open).toBe(false);
    expect(s.info).toBeNull();
  });

  describe('key handling', () => {
    it('enter → add-to-input with the full text, dialog closes', () => {
      const { state, action } = handlePasteDialogKey(openState(), key('enter'));
      expect(action).toEqual({ type: 'add-to-input', text: 'pasted content\nline 2' });
      expect(state.open).toBe(false);
      expect(state.info).toBeNull();
    });

    it('y behaves like enter', () => {
      const { action } = handlePasteDialogKey(openState('x'), key('y'));
      expect(action.type).toBe('add-to-input');
      expect(action.type === 'add-to-input' && action.text).toBe('x');
    });

    it('s → send-directly with the full text', () => {
      const { state, action } = handlePasteDialogKey(openState('hello'), key('s'));
      expect(action).toEqual({ type: 'send-directly', text: 'hello' });
      expect(state.open).toBe(false);
    });

    it('escape → cancel, dialog closes', () => {
      const { state, action } = handlePasteDialogKey(openState(), key('escape'));
      expect(action).toEqual({ type: 'cancel' });
      expect(state.open).toBe(false);
    });

    it('n behaves like escape', () => {
      const { action } = handlePasteDialogKey(openState(), key('n'));
      expect(action.type).toBe('cancel');
    });

    it('unrecognized key → none, dialog stays open with info intact', () => {
      const before = openState('keep me');
      const { state, action } = handlePasteDialogKey(before, key('z'));
      expect(action).toEqual({ type: 'none' });
      expect(state.open).toBe(true);
      expect(state.info?.fullText).toBe('keep me');
    });
  });
});
