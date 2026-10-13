/**
 * The "Share live status with Omarchy plugins" row, wherever the suite runs.
 *
 * As Settings.agentsPanel.test.ts: isOmarchy() says yes on any machine here,
 * so what the switch does is checked on every run. The file goes to a
 * throwaway directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../omarchyTheme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../omarchyTheme')>()),
  isOmarchy: () => true,
}));

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../../config/index';
import { startOmarchyLiveStatus, type LiveStatusHandle } from '../omarchyStatus';
import { SETTINGS, handleSettingsKey } from './Settings';

let root: string;
let status: LiveStatusHandle | null = null;

const row = () => SETTINGS.findIndex(s => s.key === 'omarchyLiveStatus');
const state = () => ({ selectedIndex: row(), editing: false, editValue: '' });
const file = () => join(root, 'sessions', '31337.json');

beforeEach(() => {
  // The file is written at most once a second: a switch turned back On within
  // it comes with the second, which the test lets pass.
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'codeep-live-status-row-'));
  config.set('omarchyLiveStatus', true);
  // As main.ts starts it.
  status = startOmarchyLiveStatus({
    kind: 'tui', dir: join(root, 'sessions'), pid: 31337,
    enabled: () => config.get('omarchyLiveStatus') !== false,
    isAlive: () => true, startedAtOf: () => null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  status?.stop();
  status = null;
  config.set('omarchyLiveStatus', true);
  rmSync(root, { recursive: true, force: true });
});

describe('Share live status with Omarchy plugins', () => {
  it('is offered after the Agents panel row, On by default', () => {
    // As a config that has never had it set has it.
    config.reset('omarchyLiveStatus');
    expect(row()).toBe(SETTINGS.findIndex(s => s.key === 'omarchyAgentsPanel') + 1);
    const setting = SETTINGS[row()];
    expect(setting.label).toBe('Share live status with Omarchy plugins');
    expect(setting.getValue()).toBe(true);
    expect(setting.options).toEqual([{ value: true, label: 'On' }, { value: false, label: 'Off' }]);
    expect(config.get('omarchyLiveStatus')).toBe(true);
  });

  it('switched Off, takes the file away at once', () => {
    expect(JSON.parse(readFileSync(file(), 'utf8')).state).toBe('idle');
    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe('Share live status with Omarchy plugins: Off');
    expect(config.get('omarchyLiveStatus')).toBe(false);
    expect(existsSync(file())).toBe(false);
  });

  it('switched On, writes it again, as soon as the second is up', () => {
    handleSettingsKey('enter', false, state());
    expect(existsSync(file())).toBe(false);
    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe('Share live status with Omarchy plugins: On');
    expect(config.get('omarchyLiveStatus')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ pid: 31337, state: 'idle' });
  });

  it('switched with the arrow keys as well', () => {
    handleSettingsKey('right', false, state());
    expect(config.get('omarchyLiveStatus')).toBe(false);
    expect(existsSync(file())).toBe(false);
    handleSettingsKey('left', false, state());
    expect(config.get('omarchyLiveStatus')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(existsSync(file())).toBe(true);
  });
});
