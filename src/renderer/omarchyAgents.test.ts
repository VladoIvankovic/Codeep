import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The record's two writes, so a test can read the temporary name it goes
// through. Both still reach the disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

import { renameSync, writeFileSync } from 'fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOmarchyAgentsPanel,
  keepOmarchyAgentRecord,
  omarchyAgentsUsageDir,
  omarchyModelKey,
  removeOmarchyAgentRecord,
  writeOmarchyAgentRecord,
  type OmarchyAgentRecordWatch,
} from './omarchyAgents';
import { recordTokenUsage } from '../utils/tokenTracker';
import { recordPromptInLedger } from '../utils/usageLedger';
import { PROVIDERS } from '../config/providers';

const savedHome = process.env.HOME;
const savedState = process.env.XDG_STATE_HOME;
let root: string;
let home: string;
/** Omarchy's theme state, which is what says this is Omarchy at all. */
let stateDir: string;
/** On Omarchy, whatever this machine is. */
let onOmarchy: { platform: NodeJS.Platform; stateDir: string };
let watch: OmarchyAgentRecordWatch | null = null;

/** Where the panel reads records, with no XDG_STATE_HOME. */
const usageDir = () => join(home, '.local', 'state', 'omarchy', 'agents', 'usage');
const recordFile = () => join(usageDir(), 'codeep.json');
const readRecord = () => JSON.parse(readFileSync(recordFile(), 'utf8')) as Record<string, unknown>;
const usage = { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheReadTokens: 600 };
/** How many times the record has been put in place so far. */
const recordWrites = () => vi.mocked(renameSync).mock.calls.filter(([, to]) => String(to) === recordFile()).length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-omarchy-agents-'));
  home = join(root, 'home');
  stateDir = join(home, '.local', 'state', 'omarchy', 'current');
  mkdirSync(stateDir, { recursive: true });
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  onOmarchy = { platform: 'linux', stateDir };
  vi.mocked(writeFileSync).mockClear();
  vi.mocked(renameSync).mockClear();
});

afterEach(() => {
  watch?.stop();
  watch = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.HOME = savedHome;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
  rmSync(root, { recursive: true, force: true });
});

describe('where the record goes', () => {
  it('is under XDG_STATE_HOME when that is set', () => {
    expect(omarchyAgentsUsageDir({ XDG_STATE_HOME: '/x/state' }, '/home/u'))
      .toBe(join('/x/state', 'omarchy', 'agents', 'usage'));
  });

  it('is under ~/.local/state when XDG_STATE_HOME is unset or empty, as Omarchy reads it', () => {
    expect(omarchyAgentsUsageDir({}, '/home/u')).toBe(join('/home/u', '.local', 'state', 'omarchy', 'agents', 'usage'));
    expect(omarchyAgentsUsageDir({ XDG_STATE_HOME: '' }, '/home/u')).toBe(join('/home/u', '.local', 'state', 'omarchy', 'agents', 'usage'));
  });

  it('follows XDG_STATE_HOME when the record is written', () => {
    recordPromptInLedger('s1', 'tui');
    process.env.XDG_STATE_HOME = join(root, 'xdg-state');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    expect(existsSync(join(root, 'xdg-state', 'omarchy', 'agents', 'usage', 'codeep.json'))).toBe(true);
    expect(existsSync(recordFile())).toBe(false);

    delete process.env.XDG_STATE_HOME;
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    expect(existsSync(recordFile())).toBe(true);
  });
});

describe('writing the record', () => {
  it('writes it on Omarchy, switched on, once the ledger holds a line', () => {
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord({ ...onOmarchy, enabled: () => true })).toBe(true);
    expect(readRecord().id).toBe('codeep');
  });

  it('writes nothing anywhere but Omarchy', () => {
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord({ platform: 'darwin', stateDir })).toBe(false);
    expect(writeOmarchyAgentRecord({ platform: 'linux', stateDir: join(root, 'no-omarchy-here') })).toBe(false);
    expect(existsSync(usageDir())).toBe(false);
  });

  it('writes nothing with the setting off', () => {
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord({ ...onOmarchy, enabled: () => false })).toBe(false);
    expect(existsSync(usageDir())).toBe(false);
  });

  it('writes nothing while the ledger has no line in it', () => {
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(false);
    // A ledger of lines that are not events is just as empty.
    const ledger = join(home, '.codeep', 'usage');
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, '2026-10.jsonl'), 'not an event\n{"t":"soon","k":"p","s":"x"}\n');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(false);
    expect(existsSync(usageDir())).toBe(false);
  });

  it('writes a ledger of prompts alone, with no plan to name', () => {
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    expect(readRecord()).toMatchObject({ totalPrompts: 1, totalSessions: 1, activeDays: 1, tierLabel: '', modelUsage: {} });
  });

  it('holds exactly the keys of Omarchy\'s records, with the day and the week left at zero', () => {
    recordPromptInLedger('session-a', 'tui');
    recordPromptInLedger('session-a', 'tui');
    recordPromptInLedger('acp-b', 'acp');
    recordTokenUsage(usage, 'anthropic/claude-sonnet-5.5', 'openrouter');
    recordTokenUsage({ promptTokens: 100, completionTokens: 10, totalTokens: 110 }, 'glm-5.3', 'z.ai');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);

    const text = readFileSync(recordFile(), 'utf8');
    // One compact line, as `omarchy-agent-usage-update` writes its own.
    expect(text).toMatch(/^\{[^\n]*\}\n$/);
    const record = readRecord();
    expect(Object.keys(record)).toEqual([
      'schemaVersion', 'id', 'name', 'updatedAt', 'ready', 'tierLabel', 'usageStatusText', 'authHelpText',
      'limits', 'hasLocalStats', 'hasPromptStats', 'todayPrompts', 'todaySessions', 'todayTotalTokens',
      'todayTokensByModel', 'recentDays', 'totalPrompts', 'totalSessions', 'activeDays', 'activeDates', 'modelUsage',
    ]);
    const today = new Date();
    const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(record).toEqual({
      schemaVersion: 1,
      id: 'codeep',
      name: 'Codeep',
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      ready: true,
      // The provider of the latest model call, by its display name.
      tierLabel: PROVIDERS['z.ai'].name,
      usageStatusText: '',
      authHelpText: '',
      limits: [],
      hasLocalStats: true,
      hasPromptStats: true,
      // Today happened — three prompts and two models' worth of tokens — and
      // still none of it is written: it would go stale on a day Codeep sleeps.
      todayPrompts: 0,
      todaySessions: 0,
      todayTotalTokens: 0,
      todayTokensByModel: {},
      recentDays: [],
      totalPrompts: 3,
      totalSessions: 2,
      activeDays: 1,
      activeDates: [localToday],
      modelUsage: {
        'claude-sonnet-5.5': { inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 600, cacheCreationInputTokens: 0 },
        'GLM-5.3': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    });
    expect(PROVIDERS['z.ai'].name).not.toBe('');
  });

  it('spells GLM and MiniMax as the brands do, which the panel cannot', () => {
    // The panel upper-cases only the first letter of each word: glm-5.3 would
    // be "Glm 5.3". Under GLM-5.3 it reads "GLM 5.3".
    recordTokenUsage({ promptTokens: 100, completionTokens: 10, totalTokens: 110 }, 'glm-5.3', 'z.ai');
    recordTokenUsage({ promptTokens: 20, completionTokens: 2, totalTokens: 22 }, 'glm-5.3-flash', 'z.ai');
    // MiniMax direct and through OpenRouter are one model in the panel.
    recordTokenUsage({ promptTokens: 30, completionTokens: 3, totalTokens: 33 }, 'MiniMax-M3', 'minimax');
    recordTokenUsage({ promptTokens: 40, completionTokens: 4, totalTokens: 44 }, 'minimax/minimax-m3', 'openrouter');
    recordTokenUsage({ promptTokens: 50, completionTokens: 5, totalTokens: 55 }, 'gpt-6.1-sol', 'openai');
    recordTokenUsage({ promptTokens: 60, completionTokens: 6, totalTokens: 66 }, 'glmx-1', 'custom');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);

    const tokens = (input: number, output: number) =>
      ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(readRecord().modelUsage).toEqual({
      'GLM-5.3': tokens(100, 10),
      'GLM-5.3-flash': tokens(20, 2),
      // One key, which the panel shows as "MiniMax M3".
      'MiniMax-m3': tokens(70, 7),
      // Everything else in lower case: the panel spells GPT itself, and a word
      // that only starts like a brand is not that brand.
      'gpt-6.1-sol': tokens(50, 5),
      'glmx-1': tokens(60, 6),
    });

    // The ledger itself keeps the ids as they were sent.
    const ledger = readFileSync(join(home, '.codeep', 'usage', readdirSync(join(home, '.codeep', 'usage')).find((f) => f.endsWith('.jsonl'))!), 'utf8');
    expect(ledger).toContain('"m":"glm-5.3"');
    expect(ledger).toContain('"m":"MiniMax-M3"');
    expect(ledger).toContain('"m":"minimax-m3"');
    expect(omarchyModelKey('GLM-5.3')).toBe('GLM-5.3');
    expect(omarchyModelKey('Claude-Sonnet-5.5')).toBe('claude-sonnet-5.5');
  });

  it('leaves a record alone that would change only in its updatedAt', () => {
    vi.useFakeTimers();
    recordPromptInLedger('s1', 'tui');
    recordTokenUsage(usage, 'glm-5.3', 'z.ai');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    const first = readFileSync(recordFile(), 'utf8');
    // Minutes later, so a rewrite would carry another updatedAt.
    vi.advanceTimersByTime(5 * 60_000);
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(false);
    // A call that reported no tokens changes nothing the record shows either.
    recordTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 'glm-5.3', 'z.ai');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(false);
    expect(readFileSync(recordFile(), 'utf8')).toBe(first);
    expect(recordWrites()).toBe(1);

    // Anything new is written.
    recordPromptInLedger('s2', 'tui');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    expect(readRecord().totalPrompts).toBe(2);
  });

  it('takes the record away when it finds the setting off', () => {
    // Off in config.json by hand, or by another Codeep process: nothing took
    // the record away then, so the next write does.
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    expect(writeOmarchyAgentRecord({ ...onOmarchy, enabled: () => false })).toBe(false);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('leaves a codeep.json that is not Codeep\'s when it finds the setting off', () => {
    const theirs = JSON.stringify({ schemaVersion: 1, id: 'someone-else' });
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(recordFile(), theirs);
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord({ ...onOmarchy, enabled: () => false })).toBe(false);
    expect(readFileSync(recordFile(), 'utf8')).toBe(theirs);
  });

  it('names no plan for a provider the catalogue does not know', () => {
    recordTokenUsage(usage, 'my-model', 'my-gateway');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
    expect(readRecord().tierLabel).toBe('');
  });

  it('goes through a temporary name the panel will never list, then replaces codeep.json', () => {
    recordPromptInLedger('s1', 'tui');
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);

    const writes = vi.mocked(writeFileSync).mock.calls.map(([path]) => String(path)).filter(path => dirname(path) === usageDir());
    expect(writes).toHaveLength(1);
    const [tmp] = writes;
    expect(tmp.split(/[/\\]/).pop()).toMatch(/^\.codeep\.[0-9a-f]{12}$/);
    // The panel finds agents with `find -name '*.json'`.
    expect(tmp.endsWith('.json')).toBe(false);
    expect(vi.mocked(renameSync).mock.calls.map(([from, to]) => [String(from), String(to)])).toContainEqual([tmp, recordFile()]);
    expect(readdirSync(usageDir())).toEqual(['codeep.json']);
  });

  // POSIX modes; Windows has none of these bits to check.
  it.skipIf(process.platform === 'win32')('is readable by its owner only, as Omarchy\'s own records are', () => {
    // Under a umask of 022, a file made without a mode of its own would be
    // readable by everyone — so the 0600 below is Codeep's doing.
    const umaskBefore = process.umask(0o022);
    try {
      recordPromptInLedger('s1', 'tui');
      expect(writeOmarchyAgentRecord(onOmarchy)).toBe(true);
      expect(statSync(recordFile()).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(umaskBefore);
    }
  });

  it('leaves nothing behind, and throws nothing, when the record cannot be replaced', () => {
    recordPromptInLedger('s1', 'tui');
    // A directory with something in it where the record would go.
    mkdirSync(join(recordFile(), 'in-the-way'), { recursive: true });
    expect(() => writeOmarchyAgentRecord(onOmarchy)).not.toThrow();
    expect(writeOmarchyAgentRecord(onOmarchy)).toBe(false);
    expect(readdirSync(usageDir())).toEqual(['codeep.json']);
  });
});

describe('removing the record', () => {
  it('deletes Codeep\'s own record', () => {
    recordPromptInLedger('s1', 'tui');
    writeOmarchyAgentRecord(onOmarchy);
    expect(removeOmarchyAgentRecord()).toBe(true);
    expect(existsSync(recordFile())).toBe(false);
  });

  it.each([
    ['names another agent', JSON.stringify({ schemaVersion: 1, id: 'someone-else', name: 'Someone' })],
    ['has no id', JSON.stringify({ name: 'Codeep' })],
    ['is not JSON', 'codeep'],
  ])('leaves a codeep.json alone that %s', (_what, content) => {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(recordFile(), content);
    expect(removeOmarchyAgentRecord()).toBe(false);
    expect(readFileSync(recordFile(), 'utf8')).toBe(content);
  });

  it('is quietly done when there is no record', () => {
    expect(removeOmarchyAgentRecord()).toBe(false);
  });
});

describe('the /settings switch', () => {
  it('puts the record in place at once when switched on', () => {
    recordPromptInLedger('s1', 'tui');
    applyOmarchyAgentsPanel(true, onOmarchy);
    expect(readRecord().totalPrompts).toBe(1);
  });

  it('takes the record away at once when switched off', () => {
    recordPromptInLedger('s1', 'tui');
    writeOmarchyAgentRecord(onOmarchy);
    applyOmarchyAgentsPanel(false, onOmarchy);
    expect(existsSync(recordFile())).toBe(false);
  });
});

describe('keeping the record current', () => {
  it('does nothing anywhere but Omarchy', () => {
    const before = process.listeners('exit');
    expect(keepOmarchyAgentRecord({ platform: 'darwin', stateDir })).toBeNull();
    expect(process.listeners('exit')).toEqual(before);
  });

  it('writes the first record two seconds after the ledger takes a line, and not before', () => {
    vi.useFakeTimers();
    watch = keepOmarchyAgentRecord(onOmarchy);
    recordPromptInLedger('s1', 'tui');
    vi.advanceTimersByTime(1999);
    expect(existsSync(recordFile())).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readRecord()).toMatchObject({ totalPrompts: 1 });
  });

  it('then writes at most once a minute while lines keep coming, and once more after the last', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const writtenAt: number[] = [];
    const advance = (ms: number) => {
      const before = recordWrites();
      vi.advanceTimersByTime(ms);
      if (recordWrites() > before) writtenAt.push(Date.now() - start);
    };
    watch = keepOmarchyAgentRecord(onOmarchy);

    // An agent run: the prompt, then a model call every three seconds for a
    // minute and a half.
    recordPromptInLedger('s1', 'tui');
    advance(2000);
    for (let call = 0; call < 30; call++) {
      advance(3000);
      recordTokenUsage(usage, 'glm-5.3', 'z.ai');
    }
    expect(writtenAt).toEqual([2000, 62_000]);

    // The calls after the last write are written a minute after it, and
    // nothing more after that.
    advance(30_000);
    advance(5 * 60_000);
    expect(writtenAt).toEqual([2000, 62_000, 122_000]);
    expect(readRecord()).toMatchObject({ totalPrompts: 1, modelUsage: { 'GLM-5.3': { outputTokens: 30 * 50 } } });
  });

  it('writes again two seconds after a line that comes once things have been quiet', () => {
    vi.useFakeTimers();
    watch = keepOmarchyAgentRecord(onOmarchy);
    recordPromptInLedger('s1', 'tui');
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(10 * 60_000);
    recordPromptInLedger('s2', 'tui');
    vi.advanceTimersByTime(2000);
    expect(recordWrites()).toBe(2);
    expect(readRecord().totalPrompts).toBe(2);
  });

  it('never keeps the process alive for a write that is waiting', () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000 });
    recordPromptInLedger('s1', 'tui');
    const timer = setTimer.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('writes a waiting record when the process exits', () => {
    const before = process.listeners('exit');
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000 });
    const added = process.listeners('exit').filter(listener => !before.includes(listener));
    expect(added).toHaveLength(1);
    recordPromptInLedger('s1', 'tui');
    expect(existsSync(recordFile())).toBe(false);
    (added[0] as () => void)();
    expect(readRecord().totalPrompts).toBe(1);
  });

  it('writes nothing at exit when no write is waiting', () => {
    recordPromptInLedger('s1', 'tui');
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000 });
    watch!.flush();
    expect(existsSync(recordFile())).toBe(false);
  });

  it('takes the record away when the setting is off by the time it writes', () => {
    let on = true;
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000, enabled: () => on });
    recordPromptInLedger('s1', 'tui');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(true);
    on = false;
    recordPromptInLedger('s2', 'tui');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(false);
  });

  it('replaces a watch started before it: one exit hook, one write', () => {
    const before = process.listeners('exit');
    const first = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000 });
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000 });
    try {
      expect(process.listeners('exit').filter(listener => !before.includes(listener))).toHaveLength(1);
      recordPromptInLedger('s1', 'tui');
      // The first one stopped listening when the second started.
      first!.flush();
      expect(recordWrites()).toBe(0);
      watch!.flush();
      expect(recordWrites()).toBe(1);
    } finally {
      first?.stop();
    }
  });

  it('asks the setting again when the write happens', () => {
    let on = true;
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000, enabled: () => on });
    recordPromptInLedger('s1', 'tui');
    // Switched off while the write was waiting: it must not put back what
    // the switch took away.
    on = false;
    watch!.flush();
    expect(existsSync(recordFile())).toBe(false);
  });

  it('stops listening, and leaves no exit hook, once stopped', () => {
    const before = process.listeners('exit');
    watch = keepOmarchyAgentRecord({ ...onOmarchy, delayMs: 60_000 });
    watch!.stop();
    expect(process.listeners('exit')).toEqual(before);
    recordPromptInLedger('s1', 'tui');
    watch!.flush();
    expect(existsSync(recordFile())).toBe(false);
  });
});
