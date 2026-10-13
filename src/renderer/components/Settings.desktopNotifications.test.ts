/**
 * The "Desktop notifications" row, wherever the suite runs.
 *
 * It is offered on Linux with notify-send on PATH, which this machine may be
 * neither, and its current value depends on whether Omarchy is here — so
 * both are put in the test's hands. What is under test is the row: that it
 * shows what is in force while nothing is set, and that choosing writes an
 * explicit boolean.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const machine = vi.hoisted(() => ({ auto: true }));

vi.mock('../desktopAttention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktopAttention')>();
  const { config } = await import('../../config/index');
  return {
    ...actual,
    desktopNotificationsOffered: () => true,
    // What the real one does on Linux, with Omarchy a thing a test can say.
    desktopNotificationsEnabled: () => {
      const setting = config.get('desktopNotifications');
      return typeof setting === 'boolean' ? setting : machine.auto;
    },
  };
});

import { config } from '../../config/index';
import { SETTINGS, handleSettingsKey } from './Settings';

const row = () => SETTINGS.findIndex(s => s.key === 'desktopNotifications');
const state = () => ({ selectedIndex: row(), editing: false, editValue: '' });

beforeEach(() => {
  config.delete('desktopNotifications');
  machine.auto = true;
});

afterEach(() => {
  config.delete('desktopNotifications');
});

describe('Desktop notifications', () => {
  it('is offered, and shows what is in force while nothing is set', () => {
    const setting = SETTINGS[row()];
    expect(setting.label).toBe('Desktop notifications');
    expect(setting.options).toEqual([{ value: true, label: 'On' }, { value: false, label: 'Off' }]);
    expect(config.get('desktopNotifications')).toBeUndefined();
    machine.auto = true;
    expect(setting.getValue()).toBe(true);
    machine.auto = false;
    expect(setting.getValue()).toBe(false);
  });

  it('offers its own current value, in one type', () => {
    const setting = SETTINGS[row()];
    const values = (setting.options ?? []).map(o => o.value);
    expect(values).toContain(setting.getValue());
    expect(new Set(values.map(v => typeof v))).toEqual(new Set(['boolean']));
  });

  it('turns an unset On into an explicit Off, with Enter and with the arrow keys', () => {
    machine.auto = true;
    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe('Desktop notifications: Off');
    expect(config.get('desktopNotifications')).toBe(false);

    config.delete('desktopNotifications');
    handleSettingsKey('right', false, state());
    expect(config.get('desktopNotifications')).toBe(false);

    config.delete('desktopNotifications');
    handleSettingsKey('left', false, state());
    expect(config.get('desktopNotifications')).toBe(false);
  });

  it('turns an unset Off into an explicit On', () => {
    machine.auto = false;
    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe('Desktop notifications: On');
    expect(config.get('desktopNotifications')).toBe(true);
  });

  it('goes back and forth between the two once set', () => {
    config.set('desktopNotifications', true);
    handleSettingsKey('enter', false, state());
    expect(config.get('desktopNotifications')).toBe(false);
    handleSettingsKey('enter', false, state());
    expect(config.get('desktopNotifications')).toBe(true);
  });
});
