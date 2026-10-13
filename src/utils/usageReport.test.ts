import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_DAYS,
  MAX_DAYS,
  USAGE_HELP,
  buildUsageReport,
  formatUsageReport,
  parseUsageArgs,
  runUsageCommand,
  sumTokens,
  type UsageReportJson,
} from './usageReport';
import { readUsageReport } from './usageLedger';
import { PROVIDERS } from '../config/providers';

const savedTZ = process.env.TZ;
let root: string;
let ledger: string;

const p = (t: number, s: string) => JSON.stringify({ t, k: 'p', s, src: 'tui' });
const u = (t: number, provider: string, m: string, tokens: [number, number, number, number]) =>
  JSON.stringify({ t, k: 'u', p: provider, m, in: tokens[0], out: tokens[1], cr: tokens[2], cw: tokens[3] });
const writeMonth = (name: string, rows: string[]) => {
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, name), rows.map(row => row + '\n').join(''));
};
/** A local time, in whichever zone TZ names now. */
const at = (y: number, month: number, day: number, hour = 12, minute = 0) => new Date(y, month - 1, day, hour, minute).getTime();

/** The report for the ledger as it stands, built the way `codeep usage --json` builds it. */
const report = (now: number, days?: number): UsageReportJson =>
  buildUsageReport(readUsageReport({ dir: ledger, now }), { now, days });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-usage-report-'));
  ledger = join(root, 'usage');
  process.env.TZ = 'UTC';
});

afterEach(() => {
  if (savedTZ === undefined) delete process.env.TZ;
  else process.env.TZ = savedTZ;
  rmSync(root, { recursive: true, force: true });
});

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

describe('the JSON document', () => {
  it('is valid, all zeros and nulls, for a ledger with nothing in it — in the schema\'s order', () => {
    const now = at(2026, 10, 13, 9, 30);
    const empty = report(now);
    expect(JSON.stringify(empty)).toBe(JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      today: { date: '2026-10-13', prompts: 0, sessions: 0, tokens: 0, byModel: {} },
      days: ['07', '08', '09', '10', '11', '12', '13'].map(d => ({ date: `2026-10-${d}`, prompts: 0, tokens: 0 })),
      week: { prompts: 0, sessions: 0, tokens: 0 },
      total: { prompts: 0, sessions: 0, activeDays: 0, tokens: 0, firstDate: null },
      models: {},
      lastProvider: null,
      lastProviderName: null,
    }));
    // The order is the contract, at every level the schema fixes.
    expect(Object.keys(empty)).toEqual(['schemaVersion', 'generatedAt', 'today', 'days', 'week', 'total', 'models', 'lastProvider', 'lastProviderName']);
    expect(Object.keys(empty.today)).toEqual(['date', 'prompts', 'sessions', 'tokens', 'byModel']);
    expect(Object.keys(empty.days[0])).toEqual(['date', 'prompts', 'tokens']);
    expect(Object.keys(empty.week)).toEqual(['prompts', 'sessions', 'tokens']);
    expect(Object.keys(empty.total)).toEqual(['prompts', 'sessions', 'activeDays', 'tokens', 'firstDate']);
  });

  describe('for a ledger of two months', () => {
    const now = at(2026, 10, 13, 18, 0);

    beforeEach(() => {
      writeMonth('2026-09.jsonl', [
        p(at(2026, 9, 28), 'old'),
        u(at(2026, 9, 28), 'anthropic', 'claude-opus-5-5', [1000, 100, 5000, 400]),
      ]);
      writeMonth('2026-10.jsonl', [
        // Seven days before the 13th: outside the week, inside --days 8.
        p(at(2026, 10, 6), 'w'),
        u(at(2026, 10, 6), 'z.ai', 'glm-5.3', [10, 1, 0, 0]),
        // In the week: the 7th is its first day.
        p(at(2026, 10, 7), 'a'),
        p(at(2026, 10, 9), 'a'),
        p(at(2026, 10, 9, 20), 'b'),
        u(at(2026, 10, 9), 'z.ai', 'glm-5.3', [200, 20, 3000, 0]),
        // Today.
        p(at(2026, 10, 13, 8), 'a'),
        p(at(2026, 10, 13, 9), 'c'),
        p(at(2026, 10, 13, 10), 'c'),
        u(at(2026, 10, 13, 8), 'z.ai', 'glm-5.3', [50, 5, 500, 25]),
        u(at(2026, 10, 13, 9), 'openrouter', 'minimax-m3', [7, 3, 0, 0]),
        u(at(2026, 10, 13, 17), 'z.ai', 'glm-5.3', [1, 1, 1, 1]),
      ]);
    });

    it('says what today holds, by model, busiest first', () => {
      const { today } = report(now);
      expect(today).toEqual({
        date: '2026-10-13',
        prompts: 3,
        // a and c.
        sessions: 2,
        tokens: (51 + 6 + 501 + 26) + 10,
        byModel: {
          'glm-5.3': { inputTokens: 51, outputTokens: 6, cacheReadInputTokens: 501, cacheCreationInputTokens: 26 },
          'minimax-m3': { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        },
      });
      expect(Object.keys(today.byModel)).toEqual(['glm-5.3', 'minimax-m3']);
    });

    it('lists the last seven days by default, oldest first, with the days nothing happened on at zero', () => {
      const { days } = report(now);
      expect(days).toEqual([
        { date: '2026-10-07', prompts: 1, tokens: 0 },
        { date: '2026-10-08', prompts: 0, tokens: 0 },
        { date: '2026-10-09', prompts: 2, tokens: 3220 },
        { date: '2026-10-10', prompts: 0, tokens: 0 },
        { date: '2026-10-11', prompts: 0, tokens: 0 },
        { date: '2026-10-12', prompts: 0, tokens: 0 },
        { date: '2026-10-13', prompts: 3, tokens: 594 },
      ]);
    });

    it('lists as many days as asked, across the month before', () => {
      const listed = report(now, 20).days;
      expect(listed).toHaveLength(20);
      expect(listed[0]).toEqual({ date: '2026-09-24', prompts: 0, tokens: 0 });
      expect(listed[4]).toEqual({ date: '2026-09-28', prompts: 1, tokens: 6500 });
      expect(listed[19].date).toBe('2026-10-13');
      expect(new Set(listed.map(d => d.date)).size).toBe(20);
      expect(report(now, 1).days).toEqual([{ date: '2026-10-13', prompts: 3, tokens: 594 }]);
    });

    it('sums the week over seven days, today included, and counts a session that ran on several once', () => {
      // 7th (a), 9th (a, b), 13th (a, c, c): three sessions over 6 prompts.
      // The 6th, a day outside the week, is left out — and its tokens.
      expect(report(now).week).toEqual({ prompts: 6, sessions: 3, tokens: 3220 + 594 });
      // A longer list does not make a longer week.
      expect(report(now, 30).week).toEqual(report(now, 7).week);
    });

    it('adds up the whole ledger as the total, with the day it began on', () => {
      expect(report(now).total).toEqual({
        prompts: 8,
        // old, w, a, b, c.
        sessions: 5,
        activeDays: 5,
        tokens: 6500 + 11 + 3220 + 594,
        firstDate: '2026-09-28',
      });
    });

    it('sums tokens as input + output + cache reads + cache writes', () => {
      expect(sumTokens({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 4, cacheCreationInputTokens: 8 })).toBe(15);
      expect(report(now).models['claude-opus-5-5']).toEqual({
        inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 5000, cacheCreationInputTokens: 400,
      });
    });

    it('orders the models by tokens, then by name, whatever order the ledger had them in', () => {
      writeMonth('2026-10.jsonl', [
        u(at(2026, 10, 13), 'x', 'zeta', [100, 0, 0, 0]),
        u(at(2026, 10, 13), 'x', 'alpha', [100, 0, 0, 0]),
        u(at(2026, 10, 13), 'x', 'mid', [101, 0, 0, 0]),
        u(at(2026, 10, 13), 'x', 'big', [1000, 0, 0, 0]),
      ]);
      expect(Object.keys(report(now).models)).toEqual(['claude-opus-5-5', 'big', 'mid', 'alpha', 'zeta']);
    });

    it('names the provider of the latest call, and only a provider it knows', () => {
      const latest = report(now);
      expect(latest.lastProvider).toBe('z.ai');
      expect(latest.lastProviderName).toBe(PROVIDERS['z.ai'].name);
      // `PROVIDERS` is a plain object: an id that is one of its properties is no provider.
      writeMonth('2026-10.jsonl', [u(at(2026, 10, 13), 'constructor', 'm', [1, 1, 1, 1])]);
      expect(report(now)).toMatchObject({ lastProvider: 'constructor', lastProviderName: null });
      writeMonth('2026-10.jsonl', [u(at(2026, 10, 13), 'no-such-provider', 'm', [1, 1, 1, 1])]);
      expect(report(now)).toMatchObject({ lastProvider: 'no-such-provider', lastProviderName: null });
    });

    it('keeps a model named like an Object property a model', () => {
      writeMonth('2026-10.jsonl', [u(at(2026, 10, 13), 'x', '__proto__', [4, 0, 0, 0]), u(at(2026, 10, 13), 'x', 'constructor', [2, 0, 0, 0])]);
      const out = report(now);
      expect(Object.keys(out.models)).toEqual(['claude-opus-5-5', '__proto__', 'constructor']);
      expect(Object.keys(out.today.byModel)).toEqual(['__proto__', 'constructor']);
      expect(JSON.parse(JSON.stringify(out)).models['__proto__']).toEqual({ ...ZERO, inputTokens: 4 });
    });
  });

  describe('which day it is', () => {
    it('is the local day, not the UTC one, near midnight', () => {
      process.env.TZ = 'Pacific/Auckland';
      // 00:30 on the 14th in Auckland; 11:30 on the 13th by UTC.
      const now = at(2026, 10, 14, 0, 30);
      expect(new Date(now).toISOString()).toBe('2026-10-13T11:30:00.000Z');
      writeMonth('2026-10.jsonl', [p(now, 'nz')]);
      const out = report(now, 2);
      expect(out.today.date).toBe('2026-10-14');
      expect(out.today.prompts).toBe(1);
      expect(out.days.map(d => d.date)).toEqual(['2026-10-13', '2026-10-14']);
    });

    it('lists every date once on the day a clock goes back, late in the evening', () => {
      process.env.TZ = 'Europe/Zagreb';
      // 25 October 2026 has 25 hours. 23:30 that evening, minus 24 hours of
      // milliseconds, is 00:30 the SAME day — a list built from 86 400 000 ms
      // steps names 25 October twice and never reaches the 23rd.
      const now = at(2026, 10, 25, 23, 30);
      expect(new Date(now - 86_400_000).getDate()).toBe(25);
      writeMonth('2026-10.jsonl', [
        p(at(2026, 10, 23, 12), 'a'),
        p(at(2026, 10, 24, 12), 'b'),
        p(at(2026, 10, 25, 0, 30), 'c'),
        p(at(2026, 10, 25, 23, 0), 'd'),
      ]);
      const out = report(now, 4);
      expect(out.days).toEqual([
        { date: '2026-10-22', prompts: 0, tokens: 0 },
        { date: '2026-10-23', prompts: 1, tokens: 0 },
        { date: '2026-10-24', prompts: 1, tokens: 0 },
        { date: '2026-10-25', prompts: 2, tokens: 0 },
      ]);
      expect(out.today.date).toBe('2026-10-25');
      // The week reaches back the same seven calendar days.
      expect(out.week.prompts).toBe(4);
    });

    it('misses no date on the day a clock goes forward, just after midnight', () => {
      process.env.TZ = 'Europe/Zagreb';
      // 29 March 2026 has 23 hours. 00:30 on the 30th, minus 24 hours of
      // milliseconds, is 23:30 on the 28th: the 29th falls out of the list.
      const now = at(2026, 3, 30, 0, 30);
      expect(new Date(now - 86_400_000).getDate()).toBe(28);
      writeMonth('2026-03.jsonl', [p(at(2026, 3, 29, 12), 'a'), p(at(2026, 3, 30, 0, 10), 'b'), p(at(2026, 3, 28, 12), 'c')]);
      const out = report(now, 3);
      expect(out.days).toEqual([
        { date: '2026-03-28', prompts: 1, tokens: 0 },
        { date: '2026-03-29', prompts: 1, tokens: 0 },
        { date: '2026-03-30', prompts: 1, tokens: 0 },
      ]);
    });

    it('walks across a month, a year and a leap day', () => {
      writeMonth('2026-12.jsonl', [p(at(2026, 12, 31, 23, 59), 'a')]);
      writeMonth('2027-01.jsonl', [p(at(2027, 1, 1, 0, 1), 'b')]);
      expect(report(at(2027, 1, 2, 12), 4).days.map(d => [d.date, d.prompts])).toEqual([
        ['2026-12-30', 0], ['2026-12-31', 1], ['2027-01-01', 1], ['2027-01-02', 0],
      ]);
      expect(report(at(2028, 3, 1, 12), 3).days.map(d => d.date)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
      expect(report(at(2026, 3, 1, 12), 3).days.map(d => d.date)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    });
  });
});

describe('the arguments', () => {
  it('are --json and --days, in either spelling, with 7 days by default', () => {
    expect(parseUsageArgs([])).toEqual({ ok: true, json: false, days: DEFAULT_DAYS, daysGiven: false });
    expect(parseUsageArgs(['--json'])).toEqual({ ok: true, json: true, days: 7, daysGiven: false });
    expect(parseUsageArgs(['--days', '30'])).toEqual({ ok: true, json: false, days: 30, daysGiven: true });
    expect(parseUsageArgs(['--json', '--days=14'])).toEqual({ ok: true, json: true, days: 14, daysGiven: true });
    expect(parseUsageArgs(['--days', '366'])).toMatchObject({ ok: true, days: 366 });
    expect(parseUsageArgs(['--days=1'])).toMatchObject({ ok: true, days: 1 });
    expect(MAX_DAYS).toBe(366);
  });

  it.each([
    ['zero', ['--days', '0']],
    ['more than a year', ['--days', '367']],
    ['negative', ['--days', '-3']],
    ['not a number', ['--days', 'many']],
    ['a number with something after it', ['--days', '7days']],
    ['a fraction', ['--days=2.5']],
    ['an exponent', ['--days', '1e2']],
    ['missing', ['--days']],
    ['empty', ['--days=']],
    ['absurd', ['--days', '99999999999999999999']],
  ])('refuse --days that is %s', (_what, args) => {
    const parsed = parseUsageArgs(args);
    expect(parsed).toMatchObject({ ok: false, help: false });
    expect((parsed as { message: string }).message).toContain('--days needs a whole number from 1 to 366');
  });

  it('refuse a flag or a word they do not know, so a table is never what a typo asked for', () => {
    for (const args of [['--jsno'], ['today'], ['--json', '--format=csv'], ['-d', '3']]) {
      expect(parseUsageArgs(args), args.join(' ')).toMatchObject({ ok: false, help: false });
    }
  });

  it('answer --help and -h', () => {
    expect(parseUsageArgs(['--help'])).toEqual({ ok: false, help: true });
    expect(parseUsageArgs(['--json', '-h'])).toEqual({ ok: false, help: true });
  });
});

describe('the command', () => {
  const NOW = at(2026, 10, 13, 12);
  let out: string[];
  let err: string[];
  const run = (args: string[]) => runUsageCommand(args, {
    stdout: async text => { out.push(text); },
    stderr: async text => { err.push(text); },
    now: () => NOW,
    ledgerDir: ledger,
  });

  beforeEach(() => {
    out = [];
    err = [];
    writeMonth('2026-10.jsonl', [p(at(2026, 10, 13, 9), 'a'), u(at(2026, 10, 13, 9), 'z.ai', 'glm-5.3', [10, 5, 100, 0])]);
  });

  it('prints exactly one JSON document, and nothing else, for --json', async () => {
    expect(await run(['--json'])).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0].endsWith('}\n')).toBe(true);
    expect(out[0].split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({
      schemaVersion: 1,
      generatedAt: new Date(NOW).toISOString(),
      today: { date: '2026-10-13', prompts: 1, sessions: 1, tokens: 115 },
      days: expect.any(Array),
      lastProvider: 'z.ai',
    });
    expect(JSON.parse(out[0]).days).toHaveLength(7);
  });

  it('lists --days days in the JSON', async () => {
    await run(['--json', '--days', '30']);
    expect(JSON.parse(out[0]).days).toHaveLength(30);
  });

  it('prints the table without --json, with no list of days', async () => {
    expect(await run([])).toBe(0);
    expect(out[0]).toContain('Codeep usage — 2026-10-13');
    expect(out[0]).not.toMatch(/^\{/);
    expect(out[0]).not.toMatch(/^Last \d+ days$/m);
  });

  it('lists the days in the table when --days is given', async () => {
    expect(await run(['--days', '3'])).toBe(0);
    expect(out[0]).toMatch(/^Last 3 days$/m);
    expect(out[0]).toContain('2026-10-11       0 prompts');
    expect(out[0]).toContain('2026-10-13       1 prompts');
  });

  it('exits 2 on arguments it does not take, with the reason and the usage on stderr, and nothing on stdout', async () => {
    expect(await run(['--days', '0'])).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toContain('--days needs a whole number');
    expect(err[0]).toContain('Usage: codeep usage');
    expect(await run(['--nope'])).toBe(2);
  });

  it('prints its help on stdout and exits 0', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(out).toEqual([USAGE_HELP]);
    expect(err).toEqual([]);
  });

  it('writes nothing to the ledger directory, not even where there is no ledger', async () => {
    rmSync(ledger, { recursive: true, force: true });
    expect(await run(['--json'])).toBe(0);
    expect(existsSync(ledger)).toBe(false);
    expect(JSON.parse(out[0]).total).toEqual({ prompts: 0, sessions: 0, activeDays: 0, tokens: 0, firstDate: null });
    // And reading a closed month's totals leaves only the cache beside them.
    mkdirSync(ledger, { recursive: true });
    writeMonth('2026-09.jsonl', [p(at(2026, 9, 1), 'a')]);
    await run(['--json']);
    expect(readdirSync(ledger).sort()).toEqual(['2026-09.jsonl', 'cache.json']);
  });
});

describe('the table', () => {
  const now = at(2026, 10, 13, 12);

  it('says today, the week and all time, and tokens by model', () => {
    writeMonth('2026-10.jsonl', [
      p(at(2026, 10, 2), 'a'),
      p(at(2026, 10, 13, 9), 'b'),
      u(at(2026, 10, 13, 9), 'z.ai', 'glm-5.3', [1000, 500, 12_000, 0]),
      u(at(2026, 10, 2), 'z.ai', 'glm-5.3', [1000, 500, 0, 0]),
      u(at(2026, 10, 2), 'anthropic', 'claude-opus-5-5', [50, 50, 0, 0]),
    ]);
    const text = formatUsageReport(report(now));
    expect(text.split('\n')).toEqual([
      'Codeep usage — 2026-10-13',
      '',
      'Period        Prompts  Sessions    Tokens',
      'Today               1         1     13.5K',
      'Last 7 days         1         1     13.5K',
      'All time            2         2     15.1K',
      '',
      'Since 2026-10-02, on 2 days.',
      '',
      'Tokens by model (all time)',
      '  glm-5.3             15.0K   in 2.0K · out 1.0K · cache 12.0K',
      '  claude-opus-5-5       100   in 50 · out 50 · cache 0',
      '',
      `Last used through ${PROVIDERS['z.ai'].name}.`,
    ]);
  });

  it('says so when there is nothing yet, and lists no model', () => {
    const text = formatUsageReport(report(now));
    expect(text).toContain('Nothing recorded yet.');
    expect(text).not.toContain('Tokens by model');
    expect(text).not.toContain('Last used through');
  });

  it('lists the days only when asked to', () => {
    writeMonth('2026-10.jsonl', [p(at(2026, 10, 12), 'a')]);
    const plain = formatUsageReport(report(now, 3));
    expect(plain).not.toContain('2026-10-12 ');
    const listed = formatUsageReport(report(now, 3), { daysListed: true });
    expect(listed).toContain('Last 3 days');
    expect(listed).toContain('2026-10-11       0 prompts');
    expect(listed).toContain('2026-10-12       1 prompts');
  });

  it('holds nothing but counts, model ids and a provider name', () => {
    writeMonth('2026-10.jsonl', [p(now, 'secret-session-name'), u(now, 'z.ai', 'glm-5.3', [1, 1, 1, 1])]);
    const text = formatUsageReport(report(now), { daysListed: true }) + JSON.stringify(report(now));
    expect(text).not.toContain('secret-session-name');
  });
});
