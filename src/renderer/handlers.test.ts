import { describe, it, expect, vi } from 'vitest';
import {
  handleInlineStatusKey,
  handleInlineHelpKey,
  handleInlinePermissionKey,
  handleInlineSessionPickerKey,
  handleInlineConfirmKey,
  type SessionItem,
} from './handlers';
import type { KeyEvent } from './Input';

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { key: 'enter', ctrl: false, alt: false, shift: false, raw: '', isPaste: false, ...overrides };
}

function mockCtx<T extends object>(overrides: T): T & { render: () => void } {
  return { render: vi.fn(), ...overrides } as unknown as T & { render: () => void };
}

describe('handleInlineStatusKey', () => {
  it('closes on escape', () => {
    const close = vi.fn();
    const ctx = mockCtx({ close });
    handleInlineStatusKey(key({ key: 'escape' }), ctx);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ctx.render).toHaveBeenCalledTimes(1);
  });

  it('closes on "q"', () => {
    const close = vi.fn();
    const ctx = mockCtx({ close });
    handleInlineStatusKey(key({ key: 'q' }), ctx);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys (no close, no render)', () => {
    const close = vi.fn();
    const ctx = mockCtx({ close });
    handleInlineStatusKey(key({ key: 'enter' }), ctx);
    expect(close).not.toHaveBeenCalled();
    expect(ctx.render).not.toHaveBeenCalled();
  });
});

describe('handleInlineHelpKey', () => {
  function helpCtx(scrollIndex = 0) {
    const state = { scrollIndex };
    return mockCtx({
      get scrollIndex() { return state.scrollIndex; },
      set scrollIndex(v: number) { state.scrollIndex = v; },
      setScrollIndex: vi.fn((v: number) => { state.scrollIndex = v; }),
      close: vi.fn(),
    });
  }

  it('closes on escape', () => {
    const ctx = helpCtx();
    handleInlineHelpKey(key({ key: 'escape' }), ctx);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('scrolls down by 1 on "down"', () => {
    const ctx = helpCtx();
    handleInlineHelpKey(key({ key: 'down' }), ctx);
    expect(ctx.setScrollIndex).toHaveBeenCalledWith(1);
  });

  it('scrolls up by 1 on "up", floored at 0', () => {
    const ctx = helpCtx(0);
    handleInlineHelpKey(key({ key: 'up' }), ctx);
    expect(ctx.setScrollIndex).toHaveBeenCalledWith(0);
  });

  it('scrolls down by 5 on "pagedown"', () => {
    const ctx = helpCtx();
    handleInlineHelpKey(key({ key: 'pagedown' }), ctx);
    expect(ctx.setScrollIndex).toHaveBeenCalledWith(5);
  });

  it('scrolls up by 5 on "pageup", floored at 0', () => {
    const ctx = helpCtx(2);
    handleInlineHelpKey(key({ key: 'pageup' }), ctx);
    expect(ctx.setScrollIndex).toHaveBeenCalledWith(0);
  });
});

describe('handleInlinePermissionKey', () => {
  function permCtx(index = 0) {
    return mockCtx({
      index,
      setIndex: vi.fn(),
      close: vi.fn(),
    });
  }

  it('closes with "none" on escape', () => {
    const ctx = permCtx(1);
    handleInlinePermissionKey(key({ key: 'escape' }), ctx);
    expect(ctx.close).toHaveBeenCalledWith('none');
  });

  it('moves the cursor up on "up", floored at 0', () => {
    const ctx = permCtx(0);
    handleInlinePermissionKey(key({ key: 'up' }), ctx);
    expect(ctx.setIndex).toHaveBeenCalledWith(0);
  });

  it('moves the cursor down on "down"', () => {
    const ctx = permCtx(0);
    handleInlinePermissionKey(key({ key: 'down' }), ctx);
    expect(ctx.setIndex).toHaveBeenCalledWith(1);
  });

  it('caps the cursor at the last option on "down"', () => {
    const ctx = permCtx(2); // PERMISSION_OPTIONS has 3 entries (0..2)
    handleInlinePermissionKey(key({ key: 'down' }), ctx);
    expect(ctx.setIndex).toHaveBeenCalledWith(2);
  });

  it('"left" behaves like "up"', () => {
    const ctx = permCtx(1);
    handleInlinePermissionKey(key({ key: 'left' }), ctx);
    expect(ctx.setIndex).toHaveBeenCalledWith(0);
  });

  it('"right" behaves like "down"', () => {
    const ctx = permCtx(0);
    handleInlinePermissionKey(key({ key: 'right' }), ctx);
    expect(ctx.setIndex).toHaveBeenCalledWith(1);
  });

  it('closes with the selected permission on enter', () => {
    const ctx = permCtx(1); // index 1 → "write"
    handleInlinePermissionKey(key({ key: 'enter' }), ctx);
    expect(ctx.close).toHaveBeenCalledWith('write');
  });
});

describe('handleInlineSessionPickerKey', () => {
  const items: SessionItem[] = [
    { name: 'a', messageCount: 1, createdAt: '2025-01-01' },
    { name: 'b', messageCount: 2, createdAt: '2025-01-02' },
  ];

  function ctx(overrides: Record<string, unknown> = {}) {
    return mockCtx({
      index: 0,
      items,
      deleteMode: false,
      hasDeleteCallback: true,
      setIndex: vi.fn(),
      setItems: vi.fn(),
      setDeleteMode: vi.fn(),
      close: vi.fn(),
      onDelete: vi.fn(),
      notify: vi.fn(),
      ...overrides,
    });
  }

  it('"n" closes with null (new session)', () => {
    const c = ctx();
    handleInlineSessionPickerKey(key({ key: 'n' }), c);
    expect(c.close).toHaveBeenCalledWith(null);
  });

  it('"d" toggles delete mode', () => {
    const c = ctx();
    handleInlineSessionPickerKey(key({ key: 'd' }), c);
    expect(c.setDeleteMode).toHaveBeenCalledWith(true);
  });

  it('"d" does nothing when hasDeleteCallback is false', () => {
    const c = ctx({ hasDeleteCallback: false });
    handleInlineSessionPickerKey(key({ key: 'd' }), c);
    expect(c.setDeleteMode).not.toHaveBeenCalled();
  });

  it('escape closes when not in delete mode', () => {
    const c = ctx({ deleteMode: false });
    handleInlineSessionPickerKey(key({ key: 'escape' }), c);
    expect(c.close).toHaveBeenCalledWith(null);
  });

  it('escape exits delete mode (without closing) when in delete mode', () => {
    const c = ctx({ deleteMode: true });
    handleInlineSessionPickerKey(key({ key: 'escape' }), c);
    expect(c.setDeleteMode).toHaveBeenCalledWith(false);
    expect(c.close).not.toHaveBeenCalled();
  });

  it('enter loads the selected session', () => {
    const c = ctx({ index: 1 });
    handleInlineSessionPickerKey(key({ key: 'enter' }), c);
    expect(c.close).toHaveBeenCalledWith('b');
  });

  it('enter in delete mode deletes the selected session', () => {
    const c = ctx({ index: 0, deleteMode: true });
    handleInlineSessionPickerKey(key({ key: 'enter' }), c);
    expect(c.onDelete).toHaveBeenCalledWith('a');
    expect(c.setItems).toHaveBeenCalledWith([items[1]]);
    expect(c.notify).toHaveBeenCalledWith('Deleted: a');
  });

  it('enter in delete mode clears delete mode when the list becomes empty', () => {
    const single = [{ name: 'only', messageCount: 1, createdAt: '2025-01-01' }];
    const c = ctx({ index: 0, deleteMode: true, items: single });
    handleInlineSessionPickerKey(key({ key: 'enter' }), c);
    expect(c.setItems).toHaveBeenCalledWith([]);
    expect(c.setDeleteMode).toHaveBeenCalledWith(false);
  });
});

describe('handleInlineConfirmKey', () => {
  function ctx(selection: 'yes' | 'no' | 'extra' = 'yes', hasExtra = false) {
    return mockCtx({
      options: {
        title: 't',
        message: ['m'],
        onConfirm: () => {},
        extraOption: hasExtra ? { label: 'Apply to all', onSelect: () => {} } : undefined,
      },
      selection,
      setSelection: vi.fn(),
      close: vi.fn(),
    });
  }

  it('closes with "no" on escape', () => {
    const c = ctx('yes');
    handleInlineConfirmKey(key({ key: 'escape' }), c);
    expect(c.close).toHaveBeenCalledWith('no');
  });

  it('"y" selects yes', () => {
    const c = ctx('no');
    handleInlineConfirmKey(key({ key: 'y' }), c);
    expect(c.setSelection).toHaveBeenCalledWith('yes');
  });

  it('"n" selects no', () => {
    const c = ctx('yes');
    handleInlineConfirmKey(key({ key: 'n' }), c);
    expect(c.setSelection).toHaveBeenCalledWith('no');
  });

  it('"a" selects extra only when an extra option is present', () => {
    const withExtra = ctx('yes', true);
    handleInlineConfirmKey(key({ key: 'a' }), withExtra);
    expect(withExtra.setSelection).toHaveBeenCalledWith('extra');

    const withoutExtra = ctx('yes', false);
    handleInlineConfirmKey(key({ key: 'a' }), withoutExtra);
    expect(withoutExtra.setSelection).not.toHaveBeenCalled();
  });

  it('right cycles yes → no → extra → yes', () => {
    const c = ctx('yes', true);
    handleInlineConfirmKey(key({ key: 'right' }), c);
    expect(c.setSelection).toHaveBeenLastCalledWith('no');

    c.selection = 'no';
    handleInlineConfirmKey(key({ key: 'right' }), c);
    expect(c.setSelection).toHaveBeenLastCalledWith('extra');

    c.selection = 'extra';
    handleInlineConfirmKey(key({ key: 'right' }), c);
    expect(c.setSelection).toHaveBeenLastCalledWith('yes');
  });

  it('left cycles yes → extra → no → yes', () => {
    const c = ctx('yes', true);
    handleInlineConfirmKey(key({ key: 'left' }), c);
    expect(c.setSelection).toHaveBeenLastCalledWith('extra');

    c.selection = 'extra';
    handleInlineConfirmKey(key({ key: 'left' }), c);
    expect(c.setSelection).toHaveBeenLastCalledWith('no');

    c.selection = 'no';
    handleInlineConfirmKey(key({ key: 'left' }), c);
    expect(c.setSelection).toHaveBeenLastCalledWith('yes');
  });

  it('enter closes with the current selection', () => {
    const c = ctx('yes');
    handleInlineConfirmKey(key({ key: 'enter' }), c);
    expect(c.close).toHaveBeenCalledWith('yes');
  });
});
