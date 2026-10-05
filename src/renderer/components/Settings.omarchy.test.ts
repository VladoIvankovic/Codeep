/**
 * The "Follow Omarchy theme" row, on a machine that looks like Omarchy.
 *
 * Settings decides when it is imported whether to offer the row, so the
 * Omarchy state directory has to exist under this worker's throwaway HOME
 * (vitest.setup.ts) before the import — hence the dynamic import below. The
 * plain Settings.test.ts runs without one and checks the row is absent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../../config/index';
import { followOmarchyTheme, omarchyStateDir, type OmarchyThemeWatch } from '../omarchyTheme';
import { DEFAULT_PALETTE, getPalette, palette, resetPalette } from '../palette';

const stateDir = omarchyStateDir();
mkdirSync(join(stateDir, 'theme'), { recursive: true });
writeFileSync(join(stateDir, 'theme', 'colors.toml'), [
  'accent = "#7aa2f7"',
  'background = "#1a1b26"',
  'foreground = "#a9b1d6"',
].join('\n'));

const { SETTINGS, handleSettingsKey } = await import('./Settings');

const TOKYO_ACCENT = '\x1b[38;2;122;162;247m';
let watch: OmarchyThemeWatch | null = null;

const row = () => SETTINGS.findIndex(s => s.key === 'followOmarchyTheme');
const state = () => ({ selectedIndex: row(), editing: false, editValue: '' });

afterAll(() => {
  rmSync(join(stateDir, '..'), { recursive: true, force: true });
});

// Omarchy is Linux-only, and so is the row: off Linux it is never offered.
describe.skipIf(process.platform !== 'linux')('Follow Omarchy theme', () => {
  beforeAll(() => {
    // As main.ts starts it.
    watch = followOmarchyTheme({ stateDir, enabled: () => config.get('followOmarchyTheme') !== false });
  });

  afterAll(() => {
    watch?.stop();
    resetPalette();
  });

  beforeEach(() => {
    config.set('followOmarchyTheme', true);
    watch?.reload();
  });

  it('is offered on Omarchy, and on by default', () => {
    expect(row()).toBeGreaterThanOrEqual(0);
    expect(SETTINGS[row()].getValue()).toBe(true);
    expect(palette.primary).toBe(TOKYO_ACCENT);
  });

  it('turning it off puts Codeep\'s own colours back at once', () => {
    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe("Follow Omarchy theme: Off (Codeep's own colours)");
    expect(config.get('followOmarchyTheme')).toBe(false);
    expect(getPalette()).toEqual(DEFAULT_PALETTE);
  });

  it('turning it back on applies the theme at once', () => {
    handleSettingsKey('right', false, state());
    expect(getPalette()).toEqual(DEFAULT_PALETTE);
    handleSettingsKey('left', false, state());
    expect(config.get('followOmarchyTheme')).toBe(true);
    expect(palette.primary).toBe(TOKYO_ACCENT);
  });

  it('comes with the Agents panel row, On by default', () => {
    // What that row does is Settings.agentsPanel.test.ts's, which runs on
    // every platform.
    const panel = SETTINGS.findIndex(s => s.key === 'omarchyAgentsPanel');
    expect(panel).toBe(row() + 1);
    expect(SETTINGS[panel].getValue()).toBe(true);
  });

  it('offers its own current value, in one type', () => {
    const setting = SETTINGS[row()];
    const values = (setting.options ?? []).map(o => o.value);
    expect(values).toContain(setting.getValue());
    expect(new Set(values.map(v => typeof v))).toEqual(new Set(['boolean']));
  });
});
