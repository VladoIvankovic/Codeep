import { describe, it, expect, vi } from 'vitest';
import {
  handleLogoutKey,
  type LogoutState,
  type LogoutProvider,
} from './Logout';
import type { KeyEvent } from '../Input';

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { key: 'escape', ctrl: false, alt: false, shift: false, raw: '', ...overrides };
}

function providers(): LogoutProvider[] {
  return [
    { id: 'openai', name: 'OpenAI', isCurrent: true },
    { id: 'anthropic', name: 'Anthropic', isCurrent: false },
  ];
}

function state(overrides: Partial<LogoutState> = {}): LogoutState {
  return {
    logoutOpen: true,
    logoutIndex: 0,
    logoutProviders: providers(),
    logoutCallback: null,
    ...overrides,
  };
}

describe('handleLogoutKey', () => {
  it('escape closes the panel and clears the callback', () => {
    const onRender = vi.fn();
    const s = state({ logoutCallback: vi.fn() });
    handleLogoutKey(key({ key: 'escape' }), s, { onClose: vi.fn(), onRender, onSelect: vi.fn() });
    expect(s.logoutOpen).toBe(false);
    expect(s.logoutCallback).toBeNull();
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it('up decrements the index, floored at 0', () => {
    const s = state({ logoutIndex: 0 });
    handleLogoutKey(key({ key: 'up' }), s, { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() });
    expect(s.logoutIndex).toBe(0);

    s.logoutIndex = 2;
    handleLogoutKey(key({ key: 'up' }), s, { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() });
    expect(s.logoutIndex).toBe(1);
  });

  it('down increments the index, capped at providers + 2 (all + cancel)', () => {
    // 2 providers + "all" + "cancel" = 4 options, max index 3.
    const s = state({ logoutIndex: 0 });
    const cbs = { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() };
    handleLogoutKey(key({ key: 'down' }), s, cbs); expect(s.logoutIndex).toBe(1);
    handleLogoutKey(key({ key: 'down' }), s, cbs); expect(s.logoutIndex).toBe(2);
    handleLogoutKey(key({ key: 'down' }), s, cbs); expect(s.logoutIndex).toBe(3);
    handleLogoutKey(key({ key: 'down' }), s, cbs); expect(s.logoutIndex).toBe(3); // capped
  });

  it('enter on a provider invokes the callback with that provider id', () => {
    const cb = vi.fn();
    const s = state({ logoutIndex: 1, logoutCallback: cb });
    handleLogoutKey(key({ key: 'enter' }), s, { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() });
    expect(cb).toHaveBeenCalledWith('anthropic');
    expect(s.logoutOpen).toBe(false);
  });

  it('enter on the "all" position invokes the callback with "all"', () => {
    const cb = vi.fn();
    // logoutProviders.length (2) === the "all" slot.
    const s = state({ logoutIndex: 2, logoutCallback: cb });
    handleLogoutKey(key({ key: 'enter' }), s, { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() });
    expect(cb).toHaveBeenCalledWith('all');
  });

  it('enter on the cancel position invokes the callback with null', () => {
    const cb = vi.fn();
    // logoutProviders.length + 1 === the "cancel" slot.
    const s = state({ logoutIndex: 3, logoutCallback: cb });
    handleLogoutKey(key({ key: 'enter' }), s, { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() });
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('enter does nothing when no callback is set', () => {
    const s = state({ logoutIndex: 0, logoutCallback: null });
    expect(() =>
      handleLogoutKey(key({ key: 'enter' }), s, { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() }),
    ).not.toThrow();
    expect(s.logoutOpen).toBe(false);
  });

  it('ignores unrecognised keys', () => {
    const onRender = vi.fn();
    const s = state({ logoutIndex: 1 });
    handleLogoutKey(key({ key: 'x' }), s, { onClose: vi.fn(), onRender, onSelect: vi.fn() });
    expect(s.logoutIndex).toBe(1);
    expect(s.logoutOpen).toBe(true);
    expect(onRender).not.toHaveBeenCalled();
  });

  it('caps down navigation when there are no providers', () => {
    // 0 providers + all + cancel = 2 options.
    const s = state({ logoutProviders: [], logoutIndex: 0 });
    const cbs = { onClose: vi.fn(), onRender: vi.fn(), onSelect: vi.fn() };
    handleLogoutKey(key({ key: 'down' }), s, cbs); expect(s.logoutIndex).toBe(1);
    handleLogoutKey(key({ key: 'down' }), s, cbs); expect(s.logoutIndex).toBe(1);
  });
});
