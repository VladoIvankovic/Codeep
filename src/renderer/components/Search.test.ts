import { describe, it, expect, vi } from 'vitest';
import { handleSearchKey, type SearchState, type SearchCallbacks } from './Search';
import type { KeyEvent } from '../Input';

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { key: 'escape', ctrl: false, alt: false, shift: false, raw: '', ...overrides };
}

function state(overrides: Partial<SearchState> = {}): SearchState {
  return {
    searchOpen: true,
    searchQuery: '',
    searchResults: [{ role: "user", messageIndex: 0, matchedText: "hit" }],
    searchIndex: 0,
    searchCallback: null,
    ...overrides,
  };
}

function callbacks(): SearchCallbacks {
  return {
    onClose: vi.fn(),
    onRender: vi.fn(),
    onResult: vi.fn(),
  };
}

describe('handleSearchKey', () => {
  it('closes and renders on escape', () => {
    const cbs = callbacks();
    handleSearchKey(key({ key: 'escape' }), state(), cbs);
    expect(cbs.onClose).toHaveBeenCalledTimes(1);
    expect(cbs.onRender).toHaveBeenCalledTimes(1);
    expect(cbs.onResult).not.toHaveBeenCalled();
  });

  it('moves the cursor up, floored at 0', () => {
    const s = state({ searchIndex: 0 });
    handleSearchKey(key({ key: 'up' }), s, callbacks());
    expect(s.searchIndex).toBe(0);

    s.searchIndex = 3;
    handleSearchKey(key({ key: 'up' }), s, callbacks());
    expect(s.searchIndex).toBe(2);
  });

  it('moves the cursor down, capped at results length - 1', () => {
    const s = state({
      searchIndex: 0,
      searchResults: [
        { role: "user", messageIndex: 0, matchedText: "a" },
        { role: "assistant", messageIndex: 1, matchedText: "b" },
        { role: "user", messageIndex: 2, matchedText: "c" },
      ],
    });
    handleSearchKey(key({ key: 'down' }), s, callbacks());
    expect(s.searchIndex).toBe(1);

    handleSearchKey(key({ key: 'down' }), s, callbacks());
    expect(s.searchIndex).toBe(2);

    handleSearchKey(key({ key: 'down' }), s, callbacks());
    expect(s.searchIndex).toBe(2); // capped
  });

  it('enter closes, renders, and reports the selected result', () => {
    const cbs = callbacks();
    const s = state({ searchIndex: 0 });
    handleSearchKey(key({ key: 'enter' }), s, cbs);
    expect(cbs.onClose).toHaveBeenCalledTimes(1);
    expect(cbs.onRender).toHaveBeenCalledTimes(1);
    expect(cbs.onResult).toHaveBeenCalledWith(0);
  });

  it('enter does nothing when there are no results', () => {
    const cbs = callbacks();
    const s = state({ searchResults: [] });
    handleSearchKey(key({ key: 'enter' }), s, cbs);
    expect(cbs.onClose).not.toHaveBeenCalled();
    expect(cbs.onResult).not.toHaveBeenCalled();
  });

  it('reports the messageIndex of the selected result, not the list position', () => {
    const cbs = callbacks();
    const s = state({
      searchIndex: 1,
      searchResults: [
        { role: "user", messageIndex: 5, matchedText: "a" },
        { role: "user", messageIndex: 9, matchedText: "b" },
      ],
    });
    handleSearchKey(key({ key: 'enter' }), s, cbs);
    expect(cbs.onResult).toHaveBeenCalledWith(9);
  });

  it('ignores unrecognised keys', () => {
    const cbs = callbacks();
    const s = state({ searchIndex: 2 });
    handleSearchKey(key({ key: 'x' }), s, cbs);
    expect(cbs.onClose).not.toHaveBeenCalled();
    expect(cbs.onRender).not.toHaveBeenCalled();
    expect(cbs.onResult).not.toHaveBeenCalled();
    expect(s.searchIndex).toBe(2);
  });
});
