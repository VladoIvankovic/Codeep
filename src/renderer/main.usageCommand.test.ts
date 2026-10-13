import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `codeep usage`, run the way the binary runs it: main() reads process.argv.
// It is a read of the ledger, so no part of the startup that asks for a key,
// draws a screen or goes to the network may run for it — each is a mock that
// fails the test if it is touched.
vi.mock('./App', () => ({
  App: class {
    constructor() { throw new Error('the TUI must not start for `codeep usage`'); }
  },
}));
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  logAppError: vi.fn(),
}));
vi.mock('../config/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/index')>()),
  loadAllApiKeys: vi.fn(async () => { throw new Error('keys must not be loaded for `codeep usage`'); }),
  loadApiKey: vi.fn(async () => { throw new Error('keys must not be loaded for `codeep usage`'); }),
}));
vi.mock('../utils/codeepCloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/codeepCloud')>()),
  ensureDeviceRegistered: vi.fn(() => { throw new Error('the cloud must not be reached for `codeep usage`'); }),
}));
vi.mock('./configWatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./configWatch')>()),
  watchConfig: vi.fn(() => { throw new Error('the TUI\'s config watch must not start for `codeep usage`'); }),
}));

import { rmSync } from 'node:fs';
import { recordPromptInLedger, recordUsageInLedger, usageLedgerDir } from '../utils/usageLedger';

class Exited extends Error {}

let stdout: string[];
let stderr: string[];
const savedArgv = process.argv;
const savedTZ = process.env.TZ;

/** Load main.ts as `codeep <args…>` and return the exit code. */
async function codeep(...args: string[]): Promise<number | undefined> {
  const codes: Array<number | undefined> = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    codes.push(code);
    if (codes.length === 1) throw new Exited();
  }) as never);
  process.argv = ['node', 'codeep', ...args];
  vi.resetModules();
  const { main } = await import('./main');
  await main().catch((err) => { if (!(err instanceof Exited)) throw err; });
  await vi.waitFor(() => expect(codes.length).toBeGreaterThan(0));
  return codes[0];
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    stdout.push(String(text));
    callback?.();
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((text: string, callback?: () => void) => {
    stderr.push(String(text));
    callback?.();
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout.push(args.join(' ') + '\n'); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ') + '\n'); });
  process.env.TZ = 'UTC';
  // This worker's throwaway home is shared by the tests of the file.
  rmSync(usageLedgerDir(), { recursive: true, force: true });
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedTZ === undefined) delete process.env.TZ;
  else process.env.TZ = savedTZ;
  vi.restoreAllMocks();
});

describe('codeep usage', () => {
  it('prints the JSON document of the ledger and exits 0, touching nothing else', async () => {
    recordPromptInLedger('session-a', 'tui');
    recordUsageInLedger({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheReadTokens: 600 }, 'glm-5.3', 'z.ai');
    expect(await codeep('usage', '--json')).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const report = JSON.parse(stdout[0]);
    expect(Object.keys(report)).toEqual(['schemaVersion', 'generatedAt', 'today', 'days', 'week', 'total', 'models', 'lastProvider', 'lastProviderName']);
    expect(report.today.prompts).toBe(1);
    expect(report.today.sessions).toBe(1);
    expect(report.today.tokens).toBe(1050);
    expect(report.models['glm-5.3']).toEqual({ inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 600, cacheCreationInputTokens: 0 });
    expect(report.lastProvider).toBe('z.ai');
    expect(report.days).toHaveLength(7);
  });

  it('is valid, zeros and nulls, with nothing in the ledger', async () => {
    expect(await codeep('usage', '--json')).toBe(0);
    const report = JSON.parse(stdout[0]);
    expect(report.total).toEqual({ prompts: 0, sessions: 0, activeDays: 0, tokens: 0, firstDate: null });
    expect(report.lastProvider).toBeNull();
    expect(report.lastProviderName).toBeNull();
  });

  it('prints a table without --json', async () => {
    recordPromptInLedger('session-a', 'tui');
    expect(await codeep('usage')).toBe(0);
    expect(stdout.join('')).toContain('Today');
    expect(stdout.join('')).toContain('All time');
  });

  it('lists as many days as --days says', async () => {
    expect(await codeep('usage', '--json', '--days=3')).toBe(0);
    expect(JSON.parse(stdout[0]).days).toHaveLength(3);
  });

  it('exits 2 for arguments it does not take, and says why on stderr', async () => {
    expect(await codeep('usage', '--days', '0')).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('--days needs a whole number');
  });

  it('answers its own --help, not the top-level one', async () => {
    expect(await codeep('usage', '--help')).toBe(0);
    expect(stdout.join('')).toContain('Usage: codeep usage [--json] [--days N]');
  });

  it('is in codeep --help', async () => {
    expect(await codeep('--help')).toBe(0);
    expect(stdout.join('')).toMatch(/codeep usage\s+What Codeep used/);
  });
});
