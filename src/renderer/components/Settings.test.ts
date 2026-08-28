/**
 * Tests for the settings screen's key handler.
 *
 * `handleSettingsKey` is a pure function over (key, state) → (effect, newState)
 * that also writes to the on-disk config. The test setup uses the same
 * isolated per-worker CODEEP_CONFIG_DIR as the rest of the suite, so the
 * writes here don't leak into other test files.
 *
 * Coverage goals:
 *  - Navigation (up/down clamps to the SETTINGS bounds)
 *  - Editing flow (enter → type → enter commits a value; escape aborts)
 *  - Select cycling (left/right/enter rotate through `options`)
 *  - Rate-limit settings trigger `updateRateLimits()` after a write
 *
 * These pin the post-`as any` refactor: every write now goes through the
 * typed `writeSetting` helper, so if someone reintroduces an untyped cast
 * the value-shape contract asserted here will fail.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSettingsKey, SETTINGS, type SettingsState } from './Settings';
import { config } from '../../config/index';

const initialState = (overrides: Partial<SettingsState> = {}): SettingsState => ({
  selectedIndex: 0,
  editing: false,
  editValue: '',
  ...overrides,
});

// Find a setting by key so the tests don't depend on array ordering.
const indexOf = (key: string): number => {
  const idx = SETTINGS.findIndex(s => s.key === key);
  if (idx < 0) throw new Error(`test setup: setting "${key}" not found`);
  return idx;
};

describe('handleSettingsKey — navigation', () => {
  it('up at the top stays at 0', () => {
    const r = handleSettingsKey('up', false, initialState({ selectedIndex: 0 }));
    expect(r.newState.selectedIndex).toBe(0);
    expect(r.handled).toBe(true);
    expect(r.close).toBe(false);
  });

  it('down advances the index', () => {
    const r = handleSettingsKey('down', false, initialState({ selectedIndex: 0 }));
    expect(r.newState.selectedIndex).toBe(1);
  });

  it('down at the bottom clamps to the last index', () => {
    const last = SETTINGS.length - 1;
    const r = handleSettingsKey('down', false, initialState({ selectedIndex: last }));
    expect(r.newState.selectedIndex).toBe(last);
  });

  it('escape in navigation mode closes the panel', () => {
    const r = handleSettingsKey('escape', false, initialState());
    expect(r.handled).toBe(true);
    expect(r.close).toBe(true);
  });
});

describe('handleSettingsKey — number editing', () => {
  beforeEach(() => {
    // Pick a known number setting; reset it to a baseline value.
    config.set('temperature', 1);
  });

  it('enter on a number setting enters editing mode with the current value prefilled', () => {
    const idx = indexOf('temperature');
    const r = handleSettingsKey('enter', false, initialState({ selectedIndex: idx }));
    expect(r.newState.editing).toBe(true);
    expect(r.newState.editValue).toBe('1');
  });

  it('typing digits then enter commits the clamped value and exits editing', () => {
    const idx = indexOf('temperature');
    let state = initialState({ selectedIndex: idx });

    // Open the editor
    state = handleSettingsKey('enter', false, state).newState;
    // Reset editValue (it was prefilled with "1") then type "0.5"
    state.editValue = '';
    state = handleSettingsKey('0', false, state).newState;
    state = handleSettingsKey('.', false, state).newState;
    state = handleSettingsKey('5', false, state).newState;
    expect(state.editValue).toBe('0.5');

    const r = handleSettingsKey('enter', false, state);
    expect(r.newState.editing).toBe(false);
    expect(r.newState.editValue).toBe('');
    expect(r.notify).toContain('Temperature');
    expect(config.get('temperature')).toBe(0.5);
  });

  it('clamps values above max down to max', () => {
    const idx = indexOf('temperature'); // max: 2
    const state = initialState({ selectedIndex: idx, editing: true, editValue: '99' });
    const r = handleSettingsKey('enter', false, state);
    expect(config.get('temperature')).toBe(2);
    expect(r.notify).toContain('2');
  });

  it('escape during editing aborts without writing', () => {
    const idx = indexOf('temperature');
    const before = config.get('temperature');
    const state = initialState({ selectedIndex: idx, editing: true, editValue: '99' });
    const r = handleSettingsKey('escape', false, state);
    expect(r.newState.editing).toBe(false);
    expect(r.close).toBe(false);
    expect(config.get('temperature')).toBe(before);
  });
});

describe('handleSettingsKey — select cycling', () => {
  beforeEach(() => {
    config.set('agentMode', 'on');
  });

  it('right cycles forward through options and writes each', () => {
    const idx = indexOf('agentMode'); // options: on → manual → off
    let state = initialState({ selectedIndex: idx });
    expect(config.get('agentMode')).toBe('on');

    state = handleSettingsKey('right', false, state).newState;
    expect(config.get('agentMode')).toBe('manual');

    state = handleSettingsKey('right', false, state).newState;
    expect(config.get('agentMode')).toBe('off');

    // Wraps back to the first option.
    state = handleSettingsKey('right', false, state).newState;
    expect(config.get('agentMode')).toBe('on');
  });

  it('left cycles backward and wraps', () => {
    const idx = indexOf('agentMode'); // starts at 'on'
    let state = initialState({ selectedIndex: idx });

    state = handleSettingsKey('left', false, state).newState;
    // on → off (wrap backward)
    expect(config.get('agentMode')).toBe('off');
  });

  it('enter on a select setting cycles forward and emits a notify with the new label', () => {
    const idx = indexOf('agentMode');
    const r = handleSettingsKey('enter', false, initialState({ selectedIndex: idx }));
    expect(config.get('agentMode')).toBe('manual');
    expect(r.notify).toContain('Manual');
  });
});

describe('handleSettingsKey — rate-limit side effect', () => {
  // The handler calls `updateRateLimits()` after writing to rateLimitApi or
  // rateLimitCommands. We don't assert on the rate limiter state (that's
  // covered by ratelimit.test.ts), only that the write itself succeeds and
  // the handler returns cleanly — i.e. the typed write path didn't throw.

  it('writing rateLimitApi via left/right succeeds and returns handled', () => {
    const idx = indexOf('rateLimitApi');
    config.set('rateLimitApi', 100);
    const r = handleSettingsKey('right', false, initialState({ selectedIndex: idx }));
    expect(r.handled).toBe(true);
    expect(config.get('rateLimitApi')).toBeGreaterThan(100);
  });

  it('writing rateLimitCommands via enter-edit-enter succeeds', () => {
    const idx = indexOf('rateLimitCommands');
    config.set('rateLimitCommands', 100);

    let state = initialState({ selectedIndex: idx });
    state = handleSettingsKey('enter', false, state).newState;
    state.editValue = '500';
    const r = handleSettingsKey('enter', false, state);
    expect(r.handled).toBe(true);
    expect(config.get('rateLimitCommands')).toBe(500);
  });
});

describe('select options match the values they read back', () => {
  /**
   * A select whose current value is not among its own options is broken, and
   * broken in a way that looks like it works: the row renders the raw value,
   * the toggle writes something the getter cannot recognise, and the setting
   * reads Off forever while reporting that it was turned On.
   *
   * That is exactly what shipped for `telegramApproval`, whose options were the
   * strings 'true' and 'false' while its getter returned a boolean. Nothing in
   * the type system objects: `SettingItem.getValue` returns
   * `string | number | boolean`, and `options[].value` is the same union, so
   * the two sides are free to disagree.
   */
  it.each(SETTINGS.filter(s => s.type === 'select').map(s => [s.key, s] as const))(
    '%s offers its own current value',
    (_key, setting) => {
      const current = setting.getValue();
      const values = (setting.options ?? []).map(o => o.value);

      expect(values.length).toBeGreaterThan(1);
      // Strict membership. `includes` uses SameValueZero, so 'true' does not
      // match true — which is the whole point of the check.
      expect(values).toContain(current);
    },
  );

  it.each(SETTINGS.filter(s => s.type === 'select').map(s => [s.key, s] as const))(
    '%s keeps one type across all its options',
    (_key, setting) => {
      const types = new Set((setting.options ?? []).map(o => typeof o.value));
      expect([...types]).toHaveLength(1);
      expect(types.has(typeof setting.getValue())).toBe(true);
    },
  );
});
