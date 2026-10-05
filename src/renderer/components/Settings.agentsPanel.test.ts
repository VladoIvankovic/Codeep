/**
 * The "Show in Omarchy's Agents panel" row, wherever the suite runs.
 *
 * Settings decides when it is imported whether to offer the Omarchy rows,
 * and isOmarchy() is true on Linux alone — so Settings.omarchy.test.ts, which
 * makes the real state directory, runs only there. Here isOmarchy() says yes
 * on any machine, so what the switch does is checked on every run. The
 * record goes to a throwaway XDG_STATE_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../omarchyTheme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../omarchyTheme')>()),
  isOmarchy: () => true,
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../../config/index';
import { recordTokenUsage } from '../../utils/tokenTracker';
import { recordPromptInLedger } from '../../utils/usageLedger';
import { keepOmarchyAgentRecord, type OmarchyAgentRecordWatch } from '../omarchyAgents';
import { SETTINGS, handleSettingsKey } from './Settings';

const savedHome = process.env.HOME;
const savedState = process.env.XDG_STATE_HOME;
let root: string;
let watch: OmarchyAgentRecordWatch | null = null;

const row = () => SETTINGS.findIndex(s => s.key === 'omarchyAgentsPanel');
const state = () => ({ selectedIndex: row(), editing: false, editValue: '' });
const recordFile = () => join(root, 'state', 'omarchy', 'agents', 'usage', 'codeep.json');
const readRecord = () => JSON.parse(readFileSync(recordFile(), 'utf8')) as Record<string, unknown>;
const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-agents-panel-'));
  process.env.HOME = join(root, 'home');
  process.env.XDG_STATE_HOME = join(root, 'state');
  config.set('omarchyAgentsPanel', true);
});

afterEach(() => {
  watch?.stop();
  watch = null;
  config.set('omarchyAgentsPanel', true);
  process.env.HOME = savedHome;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
  rmSync(root, { recursive: true, force: true });
});

describe("Show in Omarchy's Agents panel", () => {
  it('is offered beside the theme row, On by default', () => {
    // As a config that has never had it set has it.
    config.reset('omarchyAgentsPanel');
    expect(row()).toBe(SETTINGS.findIndex(s => s.key === 'followOmarchyTheme') + 1);
    const setting = SETTINGS[row()];
    expect(setting.label).toBe("Show in Omarchy's Agents panel");
    expect(setting.getValue()).toBe(true);
    expect(setting.options).toEqual([{ value: true, label: 'On' }, { value: false, label: 'Off' }]);
  });

  it('switched Off, takes Codeep out of the panel at once', () => {
    recordPromptInLedger('s1', 'tui');
    // Off and back On with ←, which puts a record there to take away.
    handleSettingsKey('left', false, state());
    handleSettingsKey('left', false, state());
    expect(config.get('omarchyAgentsPanel')).toBe(true);
    expect(existsSync(recordFile())).toBe(true);

    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe("Show in Omarchy's Agents panel: Off");
    expect(config.get('omarchyAgentsPanel')).toBe(false);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('switched Off, leaves a codeep.json that is not Codeep\'s', () => {
    const theirs = JSON.stringify({ schemaVersion: 1, id: 'someone-else' });
    mkdirSync(join(recordFile(), '..'), { recursive: true });
    writeFileSync(recordFile(), theirs);
    handleSettingsKey('enter', false, state());
    expect(config.get('omarchyAgentsPanel')).toBe(false);
    expect(readFileSync(recordFile(), 'utf8')).toBe(theirs);
  });

  it('switched On, puts the record in place at once, before Codeep next uses a model', () => {
    config.set('omarchyAgentsPanel', false);
    recordPromptInLedger('s1', 'tui');
    recordTokenUsage(usage, 'glm-5.3', 'z.ai');
    expect(existsSync(recordFile())).toBe(false);

    const result = handleSettingsKey('enter', false, state());
    expect(result.notify).toBe("Show in Omarchy's Agents panel: On");
    expect(readRecord()).toMatchObject({ id: 'codeep', totalPrompts: 1 });
  });

  it('switched On with nothing in the ledger, writes nothing', () => {
    config.set('omarchyAgentsPanel', false);
    handleSettingsKey('enter', false, state());
    expect(config.get('omarchyAgentsPanel')).toBe(true);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('turned off in config.json by hand, goes from the panel at the next write', () => {
    // As main.ts keeps the record.
    watch = keepOmarchyAgentRecord({ enabled: () => config.get('omarchyAgentsPanel') !== false, delayMs: 60_000 });
    recordPromptInLedger('s1', 'tui');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(true);

    // Not through /settings, so nothing takes the record away at the time.
    config.set('omarchyAgentsPanel', false);
    expect(existsSync(recordFile())).toBe(true);
    recordTokenUsage(usage, 'glm-5.3', 'z.ai');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(false);
  });

  it('switched Off, stays off while Codeep goes on working', () => {
    // As main.ts keeps the record.
    watch = keepOmarchyAgentRecord({ enabled: () => config.get('omarchyAgentsPanel') !== false, delayMs: 60_000 });
    recordPromptInLedger('s1', 'tui');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(true);

    handleSettingsKey('enter', false, state());
    expect(existsSync(recordFile())).toBe(false);
    recordTokenUsage(usage, 'glm-5.3', 'z.ai');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(false);
  });
});
