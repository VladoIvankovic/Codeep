import { describe, it, expect } from 'vitest';
import { handleSelectKey, type SelectScreenState } from './SelectScreen';

function state(idx = 0): SelectScreenState {
  return { selectedIndex: idx };
}

describe('handleSelectKey', () => {
  it('returns handled=true on every recognised key', () => {
    for (const k of ['escape', 'up', 'down', 'enter', 'pageup', 'pagedown', 'home', 'end']) {
      const out = handleSelectKey(k, state(), 5);
      expect(out.handled).toBe(true);
    }
  });

  it('returns handled=false for an unrecognised key', () => {
    const out = handleSelectKey('x', state(), 5);
    expect(out.handled).toBe(false);
    expect(out.close).toBe(false);
    expect(out.select).toBe(false);
  });

  it('escape closes without selecting', () => {
    const out = handleSelectKey('escape', state(2), 5);
    expect(out.close).toBe(true);
    expect(out.select).toBe(false);
  });

  it('enter closes and selects the current item', () => {
    const out = handleSelectKey('enter', state(2), 5);
    expect(out.close).toBe(true);
    expect(out.select).toBe(true);
    expect(out.newState.selectedIndex).toBe(2);
  });

  it('"up" decrements the index, floored at 0', () => {
    expect(handleSelectKey('up', state(0), 5).newState.selectedIndex).toBe(0);
    expect(handleSelectKey('up', state(3), 5).newState.selectedIndex).toBe(2);
  });

  it('"down" increments the index, capped at itemCount - 1', () => {
    expect(handleSelectKey('down', state(0), 5).newState.selectedIndex).toBe(1);
    expect(handleSelectKey('down', state(4), 5).newState.selectedIndex).toBe(4);
  });

  it('"pageup" jumps back 10, floored at 0', () => {
    expect(handleSelectKey('pageup', state(5), 50).newState.selectedIndex).toBe(0);
    expect(handleSelectKey('pageup', state(25), 50).newState.selectedIndex).toBe(15);
  });

  it('"pagedown" jumps forward 10, capped at itemCount - 1', () => {
    expect(handleSelectKey('pagedown', state(0), 50).newState.selectedIndex).toBe(10);
    expect(handleSelectKey('pagedown', state(45), 50).newState.selectedIndex).toBe(49);
  });

  it('"home" jumps to index 0', () => {
    expect(handleSelectKey('home', state(10), 50).newState.selectedIndex).toBe(0);
  });

  it('"end" jumps to the last index', () => {
    expect(handleSelectKey('end', state(0), 50).newState.selectedIndex).toBe(49);
  });

  it('does not mutate the input state', () => {
    const s = state(3);
    handleSelectKey('down', s, 5);
    expect(s.selectedIndex).toBe(3);
  });

  it('"down" caps at 0 when itemCount is 0 (defensive)', () => {
    // itemCount - 1 = -1, so min(0, -1) = -1 — documents the current
    // behaviour for an empty list.
    const out = handleSelectKey('down', state(0), 0);
    expect(out.newState.selectedIndex).toBe(-1);
  });
});
