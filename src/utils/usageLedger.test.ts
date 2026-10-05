import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The append itself, so a test can see how each line is written — and that
// it is one O_APPEND write — while every call still reaches the disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

import { appendFileSync } from 'fs';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  recordTokenUsage,
  extractOpenAIUsage,
  extractAnthropicUsage,
  extractResponsesUsage,
  getLastUsage,
  resetTokenTracking,
  type TokenUsage,
} from './tokenTracker';
import {
  ledgerFileName,
  onLedgerAppend,
  readUsageSummary,
  recordPromptInLedger,
  usageLedgerDir,
} from './usageLedger';

const savedHome = process.env.HOME;
const savedTZ = process.env.TZ;
let home: string;

/** The ledger's directory under this test's home. */
const ledger = () => join(home, '.codeep', 'usage');

/** Every line of every month file, parsed, in file order. */
function lines(): Array<Record<string, unknown>> {
  if (!existsSync(ledger())) return [];
  return readdirSync(ledger())
    .filter(name => name.endsWith('.jsonl'))
    .sort()
    .flatMap(name => readFileSync(join(ledger(), name), 'utf8').split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

const usageLines = () => lines().filter(line => line.k === 'u');

/** A session id as the ledger is to keep it: the first 16 hex digits of its SHA-256. */
const hashOf = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex').slice(0, 16);

/** Everything in the ledger's directory, month files and cache alike, as text. */
const everythingOnDisk = () => readdirSync(ledger()).map(name => readFileSync(join(ledger(), name), 'utf8')).join('\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codeep-ledger-home-'));
  process.env.HOME = home;
  resetTokenTracking();
  vi.mocked(appendFileSync).mockClear();
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedTZ === undefined) delete process.env.TZ;
  else process.env.TZ = savedTZ;
  rmSync(home, { recursive: true, force: true });
});

describe('a model call', () => {
  // Each extractor hands recordTokenUsage a promptTokens that already holds
  // the cached tokens, and Omarchy's panel adds input + output + cache reads
  // + cache writes. `in` has to be what is left, or every cached token
  // reaches the panel twice.
  const cases: Array<[string, TokenUsage | null, { in: number; out: number; cr: number; cw: number }]> = [
    ['OpenAI, cache reads nested under prompt_tokens_details',
      extractOpenAIUsage({ usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 600 } } }),
      { in: 400, out: 50, cr: 600, cw: 0 }],
    ['Kimi, cache reads at the top level',
      extractOpenAIUsage({ usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cached_tokens: 600 } }),
      { in: 400, out: 50, cr: 600, cw: 0 }],
    ['DeepSeek, the same cache reads reported twice',
      extractOpenAIUsage({ usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 600 }, prompt_cache_hit_tokens: 600 } }),
      { in: 400, out: 50, cr: 600, cw: 0 }],
    ['GPT-5.6+, cache writes in cache_write_tokens',
      extractOpenAIUsage({ usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } } }),
      { in: 500, out: 50, cr: 300, cw: 200 }],
    ['the Responses API',
      extractResponsesUsage({ usage: { input_tokens: 1000, output_tokens: 80, total_tokens: 1080, input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 }, output_tokens_details: { reasoning_tokens: 30 } } }),
      { in: 200, out: 80, cr: 700, cw: 100 }],
    ['Anthropic, whose input_tokens leaves the cache out',
      extractAnthropicUsage({ usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 300, cache_read_input_tokens: 600 } }),
      { in: 100, out: 40, cr: 600, cw: 300 }],
    ['no cache at all',
      extractOpenAIUsage({ usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } }),
      { in: 1000, out: 50, cr: 0, cw: 0 }],
  ];

  it.each(cases)('stores the uncached input on its own: %s', (_shape, usage, expected) => {
    recordTokenUsage(usage!, 'some-model', 'some-provider');
    const [line] = usageLines();
    expect(usageLines()).toHaveLength(1);
    expect({ in: line.in, out: line.out, cr: line.cr, cw: line.cw }).toEqual(expected);
    // Each prompt token is in exactly one of the three.
    expect(expected.in + expected.cr + expected.cw).toBe(usage!.promptTokens);
  });

  it('keeps a call whose cache reads are more than its prompt, with no input left over', () => {
    // A provider can report more cached tokens than prompt tokens. There is no
    // uncached input then, and the rest of the call still counts.
    recordTokenUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheReadTokens: 300, cacheCreationTokens: 50 }, 'glm-5.3', 'z.ai');
    expect(usageLines()).toEqual([{ t: expect.any(Number), k: 'u', p: 'z.ai', m: 'glm-5.3', in: 0, out: 20, cr: 300, cw: 50 }]);
    expect(readUsageSummary().modelUsage['glm-5.3']).toEqual({
      inputTokens: 0, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 50,
    });
  });

  it('is one line in the documented shape, and nothing else', () => {
    recordTokenUsage({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheReadTokens: 600 }, 'glm-5.3', 'z.ai');
    const [line] = usageLines();
    expect(Object.keys(line)).toEqual(['t', 'k', 'p', 'm', 'in', 'out', 'cr', 'cw']);
    expect(line).toEqual({ t: expect.any(Number), k: 'u', p: 'z.ai', m: 'glm-5.3', in: 400, out: 50, cr: 600, cw: 0 });
  });

  it('keys the model without its vendor prefix, and changes nothing else about it', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    recordTokenUsage(usage, 'anthropic/claude-sonnet-5.5', 'openrouter');
    recordTokenUsage(usage, 'Qwen/Qwen3.5-397B-A17B', 'modelscope');
    recordTokenUsage(usage, 'claude-opus-5-5', 'anthropic');
    expect(usageLines().map(line => line.m)).toEqual(['claude-sonnet-5.5', 'Qwen3.5-397B-A17B', 'claude-opus-5-5']);
    // Only the ledger's key: the session's own record keeps the id it was sent.
    expect(getLastUsage()?.model).toBe('claude-opus-5-5');
    expect(readUsageSummary().modelUsage).toHaveProperty(['claude-sonnet-5.5']);
  });
});

describe('a prompt', () => {
  it('is one line with a hash of its session and where it came from', () => {
    recordPromptInLedger('session-2026-10-05-1a2b3c4d', 'tui');
    recordPromptInLedger('5b0e-acp', 'acp');
    const recorded = lines();
    expect(recorded.map(line => Object.keys(line))).toEqual([['t', 'k', 's', 'src'], ['t', 'k', 's', 'src']]);
    expect(recorded).toEqual([
      { t: expect.any(Number), k: 'p', s: 'b523af5fb0bdffb2', src: 'tui' },
      { t: expect.any(Number), k: 'p', s: hashOf('5b0e-acp'), src: 'acp' },
    ]);
  });

  it('keeps a session\'s name out of the ledger and its cache, and still counts it as one session', () => {
    // After /rename a TUI session's id is the name typed for it.
    const lastMonth = new Date(2026, 8, 30, 12).getTime();
    const now = new Date(2026, 9, 5, 12).getTime();
    recordPromptInLedger('auth-refactor', 'tui', lastMonth);
    recordPromptInLedger('auth-refactor', 'tui', now);
    const summary = readUsageSummary({ now });
    expect(summary.totalPrompts).toBe(2);
    expect(summary.totalSessions).toBe(1);
    // September is closed, so its sessions are in cache.json now — as hashes.
    expect(readFileSync(join(ledger(), 'cache.json'), 'utf8')).toContain(hashOf('auth-refactor'));
    expect(everythingOnDisk()).not.toContain('auth-refactor');
  });
});

describe('the month file', () => {
  it('is the LOCAL month of the event, not its UTC month', () => {
    process.env.TZ = 'Pacific/Auckland';
    // 30 September 12:00 UTC is already 1 October in Auckland.
    const auckland = Date.UTC(2026, 8, 30, 12, 0);
    // The zone has to have taken, or this would pass on a UTC machine for
    // the wrong reason.
    expect(new Date(auckland).getMonth()).toBe(9);
    recordPromptInLedger('nz', 'tui', auckland);
    expect(readdirSync(ledger())).toEqual(['2026-10.jsonl']);

    process.env.TZ = 'America/Los_Angeles';
    // 1 October 03:00 UTC is still 30 September in Los Angeles.
    const losAngeles = Date.UTC(2026, 9, 1, 3, 0);
    expect(new Date(losAngeles).getMonth()).toBe(8);
    expect(ledgerFileName(losAngeles)).toBe('2026-09.jsonl');
    recordPromptInLedger('la', 'tui', losAngeles);
    expect(readFileSync(join(ledger(), '2026-09.jsonl'), 'utf8')).toContain(`"s":"${hashOf('la')}"`);
    // And a day is the local day too: in Los Angeles both happened on 30
    // September, though by UTC the second was on 1 October.
    expect(readUsageSummary({ now: losAngeles }).activeDates).toEqual(['2026-09-30']);
  });

  it('lives in ~/.codeep/usage', () => {
    expect(usageLedgerDir()).toBe(join(home, '.codeep', 'usage'));
    recordPromptInLedger('s', 'tui', Date.UTC(2026, 9, 5, 12));
    expect(existsSync(join(home, '.codeep', 'usage', ledgerFileName(Date.UTC(2026, 9, 5, 12))))).toBe(true);
  });
});

describe('appending', () => {
  it('writes each event as one whole line through O_APPEND', () => {
    recordPromptInLedger('s1', 'tui', Date.UTC(2026, 9, 5, 12));
    recordTokenUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'glm-5.3', 'z.ai');
    const calls = vi.mocked(appendFileSync).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [file, data, options] of calls) {
      expect(String(file)).toMatch(/[/\\]\.codeep[/\\]usage[/\\]\d{4}-\d{2}\.jsonl$/);
      expect(String(data)).toMatch(/^\{[^\n]*\}\n$/);
      expect(options).toEqual({ flag: 'a', mode: 0o600 });
    }
  });

  it('keeps every line of two processes appending at once whole', async () => {
    // The TUI and an ACP server, each appending as fast as it can to the
    // same month file at the same moment. Each child says it is ready once
    // the module has loaded, then waits for the word to go, so neither has
    // started while the other is still loading; each also notes when its
    // first append began and its last one ended, which shows they overlapped.
    const barrier = join(home, 'barrier');
    mkdirSync(barrier);
    const script = join(home, 'writer.mjs');
    const ledgerModule = pathToFileURL(join(process.cwd(), 'src', 'utils', 'usageLedger.ts')).href;
    writeFileSync(script, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const { recordPromptInLedger } = await import(${JSON.stringify(ledgerModule)});`,
      'const [who, count, barrier] = process.argv.slice(2);',
      "const now = () => performance.timeOrigin + performance.now();",
      "writeFileSync(join(barrier, 'ready-' + who), '');",
      "while (!existsSync(join(barrier, 'go'))) { /* wait for the other one */ }",
      'const start = now();',
      `for (let i = 0; i < Number(count); i++) recordPromptInLedger(who + '-' + i, who === 'tui' ? 'tui' : 'acp', ${Date.UTC(2026, 9, 5, 12)});`,
      "writeFileSync(join(barrier, 'span-' + who), JSON.stringify([start, now()]));",
    ].join('\n'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.XDG_STATE_HOME;
    delete env.CODEEP_DEBUG;
    const count = 1000;
    const run = (who: string) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, who, String(count), barrier], {
        cwd: process.cwd(), env, stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', resolve);
    });
    const exits = Promise.all([run('tui'), run('acp')]);
    await vi.waitFor(() => {
      expect(existsSync(join(barrier, 'ready-tui')) && existsSync(join(barrier, 'ready-acp'))).toBe(true);
    }, { timeout: 20_000, interval: 10 });
    writeFileSync(join(barrier, 'go'), '');
    expect(await exits).toEqual([0, 0]);

    const [tui, acp] = ['tui', 'acp'].map(who => JSON.parse(readFileSync(join(barrier, `span-${who}`), 'utf8')) as [number, number]);
    expect(tui[0] < acp[1] && acp[0] < tui[1], 'the two runs of appends overlapped').toBe(true);
    const text = readFileSync(join(ledger(), '2026-10.jsonl'), 'utf8');
    const written = text.split('\n').filter(Boolean);
    expect(written).toHaveLength(2 * count);
    const sessions = written.map(line => (JSON.parse(line) as { s: string }).s);
    expect(new Set(sessions).size).toBe(2 * count);
    expect(readUsageSummary({ now: Date.UTC(2026, 9, 5, 12) }).totalPrompts).toBe(2 * count);
  }, 40_000);

  it('tells each listener about each line, until it stops listening', () => {
    const heard = vi.fn();
    const stop = onLedgerAppend(heard);
    recordPromptInLedger('s1', 'tui');
    recordTokenUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'glm-5.3', 'z.ai');
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    recordPromptInLedger('s2', 'tui');
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

// POSIX modes; Windows has none of these bits to check.
describe.skipIf(process.platform === 'win32')('who may read it', () => {
  // A umask of 022, under which a file made without a mode of its own would
  // be readable by everyone — so the modes below are Codeep's doing.
  let umaskBefore: number;
  beforeEach(() => { umaskBefore = process.umask(0o022); });
  afterEach(() => { process.umask(umaskBefore); });
  const mode = (path: string) => statSync(path).mode & 0o777;

  it('makes the ledger\'s directory, its month files and its cache readable by their owner only', () => {
    const lastMonth = new Date(2026, 8, 30, 12).getTime();
    const now = new Date(2026, 9, 5, 12).getTime();
    recordPromptInLedger('s1', 'tui', lastMonth);
    recordTokenUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'glm-5.3', 'z.ai');
    recordPromptInLedger('s1', 'tui', now);
    // September is over, so this writes cache.json.
    readUsageSummary({ now });
    expect(mode(ledger())).toBe(0o700);
    expect(mode(join(ledger(), '2026-09.jsonl'))).toBe(0o600);
    expect(mode(join(ledger(), '2026-10.jsonl'))).toBe(0o600);
    expect(mode(join(ledger(), ledgerFileName(Date.now())))).toBe(0o600);
    expect(mode(join(ledger(), 'cache.json'))).toBe(0o600);
    // ~/.codeep itself is made the way the rest of Codeep makes it.
    expect(mode(join(home, '.codeep'))).toBe(0o755);
  });

  it('changes the mode of nothing that was there before', () => {
    mkdirSync(ledger(), { recursive: true, mode: 0o755 });
    const file = join(ledger(), ledgerFileName(Date.now()));
    writeFileSync(file, '', { mode: 0o644 });
    recordPromptInLedger('s1', 'tui');
    expect(readFileSync(file, 'utf8')).toContain('"k":"p"');
    expect(mode(ledger())).toBe(0o755);
    expect(mode(file)).toBe(0o644);
  });
});

describe('a ledger that cannot be written', () => {
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

  it('never throws into recordTokenUsage when ~/.codeep cannot be made', () => {
    writeFileSync(join(home, '.codeep'), 'a file where the directory would go');
    const heard = vi.fn();
    const stop = onLedgerAppend(heard);
    try {
      expect(() => recordTokenUsage(usage, 'glm-5.3', 'z.ai')).not.toThrow();
      expect(() => recordPromptInLedger('s', 'tui')).not.toThrow();
    } finally {
      stop();
    }
    // The session's own count is untouched, and nobody is told of a line
    // that was never written.
    expect(getLastUsage()?.model).toBe('glm-5.3');
    expect(heard).not.toHaveBeenCalled();
  });

  it('never throws into recordTokenUsage when the month file cannot be appended to', () => {
    // A directory where this month's file would be.
    mkdirSync(join(ledger(), ledgerFileName(Date.now())), { recursive: true });
    expect(() => recordTokenUsage(usage, 'glm-5.3', 'z.ai')).not.toThrow();
    expect(getLastUsage()?.model).toBe('glm-5.3');
  });

  it('never throws into recordTokenUsage when a listener does, and still tells the others', () => {
    const before = vi.fn();
    const after = vi.fn();
    const stops = [
      onLedgerAppend(before),
      onLedgerAppend(() => { throw new Error('listener broke'); }),
      onLedgerAppend(after),
    ];
    try {
      expect(() => recordTokenUsage(usage, 'glm-5.3', 'z.ai')).not.toThrow();
    } finally {
      for (const stop of stops) stop();
    }
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(usageLines()).toHaveLength(1);
  });
});

// ─── Reading it back ─────────────────────────────────────────────────────────

describe('readUsageSummary', () => {
  // Fixed months and a fixed "now" in October 2026: August and September are
  // closed, October is the month being written.
  const NOW = new Date(2026, 9, 5, 12).getTime();
  const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
  const p = (t: number, s: string) => JSON.stringify({ t, k: 'p', s, src: 'tui' });
  const u = (t: number, provider: string, m: string, tokens: [number, number, number, number]) =>
    JSON.stringify({ t, k: 'u', p: provider, m, in: tokens[0], out: tokens[1], cr: tokens[2], cw: tokens[3] });
  const file = (name: string) => join(ledger(), name);
  const writeMonth = (name: string, rows: string[]) => {
    mkdirSync(ledger(), { recursive: true });
    writeFileSync(file(name), rows.map(row => row + '\n').join(''));
  };
  const readCache = () => JSON.parse(readFileSync(file('cache.json'), 'utf8')) as {
    version: number;
    months: Record<string, { size: number; mtimeMs: number; prompts: number; sessions: string[] }>;
  };
  const writeCache = (cache: unknown) => writeFileSync(file('cache.json'), JSON.stringify(cache));

  beforeEach(() => {
    writeMonth('2026-09.jsonl', [
      p(at(9, 29), 'a'),
      p(at(9, 30), 'b'),
      u(at(9, 30), 'z.ai', 'glm-5.3', [100, 10, 1000, 0]),
    ]);
    writeMonth('2026-10.jsonl', [
      p(at(10, 1), 'b'),
      p(at(10, 2), 'c'),
      u(at(10, 2), 'anthropic', 'claude-opus-5-5', [5, 50, 500, 200]),
      u(at(10, 2, 9), 'z.ai', 'glm-5.3', [1, 1, 1, 1]),
    ]);
  });

  it('adds up every month', () => {
    expect(readUsageSummary({ now: NOW })).toEqual({
      totalPrompts: 4,
      totalSessions: 3,
      activeDates: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
      activeDays: 4,
      modelUsage: {
        'glm-5.3': { inputTokens: 101, outputTokens: 11, cacheReadInputTokens: 1001, cacheCreationInputTokens: 1 },
        'claude-opus-5-5': { inputTokens: 5, outputTokens: 50, cacheReadInputTokens: 500, cacheCreationInputTokens: 200 },
      },
      // The latest by time, not the last in the file: two processes append
      // in whatever order they finish.
      lastProvider: 'anthropic',
    });
  });

  it('counts a session that runs into the next month once, also from the cache', () => {
    // `b` is in both months.
    expect(readUsageSummary({ now: NOW }).totalSessions).toBe(3);
    expect(readCache().months['2026-09.jsonl'].sessions).toEqual(['a', 'b']);
    expect(readUsageSummary({ now: NOW }).totalSessions).toBe(3);
  });

  it('is empty, and writes nothing, with no ledger at all', () => {
    rmSync(ledger(), { recursive: true, force: true });
    expect(readUsageSummary({ now: NOW })).toEqual({
      totalPrompts: 0, totalSessions: 0, activeDates: [], activeDays: 0, modelUsage: {}, lastProvider: null,
    });
    expect(existsSync(ledger())).toBe(false);
  });

  describe('the closed-month cache', () => {
    it('caches the months that are over, and only those', () => {
      readUsageSummary({ now: NOW });
      const cache = readCache();
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.months)).toEqual(['2026-09.jsonl']);
      const { size, mtimeMs } = statSync(file('2026-09.jsonl'));
      expect(cache.months['2026-09.jsonl']).toMatchObject({ size, mtimeMs, prompts: 2 });
    });

    it('takes a closed month from the cache while its size and mtime are unchanged', () => {
      readUsageSummary({ now: NOW });
      const cache = readCache();
      cache.months['2026-09.jsonl'].prompts = 99;
      writeCache(cache);
      expect(readUsageSummary({ now: NOW }).totalPrompts).toBe(99 + 2);
    });

    // Whole seconds, which a file's mtime holds exactly, so one of the two
    // keys can be changed while the other is put back as it was.
    const lastSeptember = new Date(2026, 8, 30, 23, 0, 0);
    const firstOctober = new Date(2026, 9, 1, 0, 0, 7);

    it('reads a closed month again once its size changes, at the same mtime', () => {
      utimesSync(file('2026-09.jsonl'), lastSeptember, lastSeptember);
      readUsageSummary({ now: NOW });
      const cache = readCache();
      cache.months['2026-09.jsonl'].prompts = 99;
      writeCache(cache);
      writeFileSync(file('2026-09.jsonl'), p(at(9, 30, 22), 'a') + '\n', { flag: 'a' });
      utimesSync(file('2026-09.jsonl'), lastSeptember, lastSeptember);
      expect(statSync(file('2026-09.jsonl')).mtimeMs).toBe(cache.months['2026-09.jsonl'].mtimeMs);
      expect(readUsageSummary({ now: NOW }).totalPrompts).toBe(3 + 2);
      expect(readCache().months['2026-09.jsonl'].prompts).toBe(3);
    });

    it('reads a closed month again once its mtime changes, at the same size', () => {
      utimesSync(file('2026-09.jsonl'), lastSeptember, lastSeptember);
      readUsageSummary({ now: NOW });
      const cache = readCache();
      cache.months['2026-09.jsonl'].prompts = 99;
      writeCache(cache);
      const { size } = statSync(file('2026-09.jsonl'));
      utimesSync(file('2026-09.jsonl'), firstOctober, firstOctober);
      expect(statSync(file('2026-09.jsonl')).size).toBe(size);
      expect(readUsageSummary({ now: NOW }).totalPrompts).toBe(2 + 2);
    });

    it('always reads the current month, whatever the cache says of it', () => {
      const { size, mtimeMs } = statSync(file('2026-10.jsonl'));
      writeCache({
        version: 1,
        months: { '2026-10.jsonl': { size, mtimeMs, prompts: 99, sessions: [], dates: [], models: {}, last: null } },
      });
      expect(readUsageSummary({ now: NOW }).totalPrompts).toBe(2 + 2);
    });

    it('drops a month whose file is gone', () => {
      readUsageSummary({ now: NOW });
      rmSync(file('2026-09.jsonl'));
      expect(readUsageSummary({ now: NOW }).totalPrompts).toBe(2);
      expect(readCache().months).toEqual({});
    });

    it.each([
      ['not JSON', '{"version":1,"months":'],
      ['another version', JSON.stringify({ version: 2, months: {} })],
      ['a month that makes no sense', JSON.stringify({ version: 1, months: { '2026-09.jsonl': { size: 'big' } } })],
    ])('ignores a cache that is %s, and writes a good one', (_what, content) => {
      writeFileSync(file('cache.json'), content);
      expect(readUsageSummary({ now: NOW }).totalPrompts).toBe(4);
      expect(readCache().months['2026-09.jsonl'].prompts).toBe(2);
    });

    it('leaves no temporary file behind', () => {
      readUsageSummary({ now: NOW });
      expect(readdirSync(ledger()).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl', 'cache.json']);
    });
  });

  it('skips lines that are not whole, well-formed events', () => {
    writeMonth('2026-10.jsonl', [
      p(at(10, 1), 'b'),
      'not json at all',
      '{"t":1759650000000,"k":"u","p":"z.ai","m":"glm-5', // cut off by a crash
      JSON.stringify({ t: 'yesterday', k: 'p', s: 'x' }),
      JSON.stringify({ t: at(10, 3), k: 'p', s: '' }),
      JSON.stringify({ t: at(10, 3), k: 'x' }),
      JSON.stringify({ t: at(10, 3), k: 'u', p: 'z.ai', m: 'glm-5.3', in: -1, out: 1, cr: 1, cw: 1 }),
      JSON.stringify({ t: at(10, 3), k: 'u', p: 'z.ai', m: 'glm-5.3', in: '5', out: 1, cr: 1, cw: 1 }),
      JSON.stringify({ t: at(10, 3), k: 'u', p: 'z.ai', in: 1, out: 1, cr: 1, cw: 1 }),
      '[1,2,3]',
      'null',
      '',
      u(at(10, 2), 'anthropic', 'claude-opus-5-5', [5, 50, 500, 200]),
    ]);
    const summary = readUsageSummary({ now: NOW });
    expect(summary.totalPrompts).toBe(2 + 1);
    expect(summary.modelUsage['claude-opus-5-5']).toEqual({ inputTokens: 5, outputTokens: 50, cacheReadInputTokens: 500, cacheCreationInputTokens: 200 });
    expect(summary.modelUsage['glm-5.3']).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 });
    // None of the October 3 lines was an event.
    expect(summary.activeDates).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('keeps a model named like an Object property a model', () => {
    writeMonth('2026-10.jsonl', [u(at(10, 2), 'custom', 'constructor', [1, 2, 3, 4]), u(at(10, 2), 'custom', '__proto__', [1, 1, 1, 1])]);
    const { modelUsage } = readUsageSummary({ now: NOW });
    expect(modelUsage.constructor).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 });
    expect(Object.keys(modelUsage).sort()).toEqual(['__proto__', 'constructor', 'glm-5.3'].sort());
  });
});

// ─── Who records a prompt ────────────────────────────────────────────────────

describe('where prompts are counted', () => {
  // Comment-stripped source, as main.test.ts reads it: a comment that names
  // the call must not count as one.
  function calls(file: string): string[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .filter(line => /\brecordPromptInLedger\(/.test(line))
      .map(line => line.trim());
  }

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sourceFiles(path, found);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path);
    }
    return found;
  }

  it('is where a user prompt goes to a model, once each, and nowhere else', () => {
    // The terminal's chat message and agent run; ACP's image prompt, plain
    // prompt, the commands that run the agent and a custom command's chat.
    // So no helper — titles, commit messages, summaries, recall, a fix after
    // a failed check, `codeep review` — can add a prompt by calling chat() or
    // runAgent(): neither records one.
    const found = Object.fromEntries(
      sourceFiles('src')
        .map(path => [path.split(/[/\\]/).slice(1).join('/'), calls(path)] as const)
        .filter(([, list]) => list.length > 0),
    );
    expect(found).toEqual({
      'utils/usageLedger.ts': [expect.stringMatching(/^export function recordPromptInLedger\(/)],
      'renderer/main.ts': ["recordPromptInLedger(sessionId, 'tui');"],
      'renderer/agentExecution.ts': ["recordPromptInLedger(sessionId, 'tui');"],
      'acp/server.ts': ["recordPromptInLedger(params.sessionId, 'acp');", "recordPromptInLedger(params.sessionId, 'acp');"],
      'acp/commands.ts': ["recordPromptInLedger(session.sessionId, 'acp');", "recordPromptInLedger(session.sessionId, 'acp');"],
    });
  });
});
