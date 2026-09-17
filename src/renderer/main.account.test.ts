import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `codeep account push` and `codeep account sync`, run the way the binary
// runs them: main() reads process.argv. (Under vitest the module does not
// start main() on import, so the test calls it.)
// Nothing here reaches the network or the keychain.
vi.mock('../utils/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git')>()),
  getGitStatus: vi.fn(() => ({ isRepo: false })),
}));
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  logAppError: vi.fn(),
}));
vi.mock('../config/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/index')>()),
  getSyncToken: vi.fn(() => 'sync-token'),
  isKeySyncEnabled: vi.fn(() => false),
  loadAllApiKeys: vi.fn(async () => {}),
}));
vi.mock('../utils/codeepCloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/codeepCloud')>()),
  pushPersonalities: vi.fn(),
  pushCommands: vi.fn(),
  pushUserProfileResult: vi.fn(),
  pullPersonalities: vi.fn(),
  pullCommands: vi.fn(),
  pullUserProfileResult: vi.fn(),
  runAccountFlow: vi.fn(async () => { throw new Error('the interactive account flow must not run'); }),
}));

import {
  pushPersonalities, pushCommands, pushUserProfileResult,
  pullPersonalities, pullCommands, pullUserProfileResult,
} from '../utils/codeepCloud';

class Exited extends Error {}

let output: string[];
const savedArgv = process.argv;

/** Load main.ts as `codeep account <sub>` and return the exit code. */
async function account(sub: 'push' | 'sync'): Promise<number | undefined> {
  const codes: Array<number | undefined> = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    codes.push(code);
    // Stop main() where the real exit would. The catch around main() exits
    // again; that one must not throw.
    if (codes.length === 1) throw new Exited();
  }) as never);
  process.argv = ['node', 'codeep', 'account', sub];
  vi.resetModules();
  const { main } = await import('./main');
  await main().catch((err) => { if (!(err instanceof Exited)) throw err; });
  await vi.waitFor(() => expect(codes.length).toBeGreaterThan(0));
  return codes[0];
}

const accountPush = () => account('push');
const nothing = { ok: true, count: 0, removed: 0 } as const;
const moved = { ok: true, count: 1, removed: 0 } as const;

beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(pushPersonalities).mockResolvedValue(nothing);
  vi.mocked(pushCommands).mockResolvedValue(nothing);
  vi.mocked(pullPersonalities).mockResolvedValue(nothing);
  vi.mocked(pullCommands).mockResolvedValue(nothing);
});

afterEach(() => {
  process.argv = savedArgv;
  vi.restoreAllMocks();
});

describe('codeep account push', () => {
  it('reports a profile that could not be pushed, and why, and exits non-zero', async () => {
    vi.mocked(pushUserProfileResult).mockResolvedValue({ ok: false, reason: 'rejected' });

    expect(await accountPush()).toBe(1);
    expect(output.join('\n')).toContain('Could not push your profile (about you) — codeep.dev refused the request');
  });

  it('says nothing about a profile that does not exist', async () => {
    vi.mocked(pushUserProfileResult).mockResolvedValue(nothing);

    expect(await accountPush()).toBe(0);
    expect(output.join('\n')).not.toContain('profile');
  });

  it('reports a pushed profile and exits zero', async () => {
    vi.mocked(pushUserProfileResult).mockResolvedValue(moved);

    expect(await accountPush()).toBe(0);
    expect(output.join('\n')).toContain('Pushed your profile');
  });

  it('exits non-zero when the commands could not be pushed', async () => {
    vi.mocked(pushUserProfileResult).mockResolvedValue(nothing);
    vi.mocked(pushCommands).mockResolvedValue({ ok: false, reason: 'unreachable' });

    expect(await accountPush()).toBe(1);
    expect(output.join('\n')).toContain('Could not push custom commands');
  });

  it('exits non-zero when the agents could not be pushed', async () => {
    vi.mocked(pushUserProfileResult).mockResolvedValue(nothing);
    vi.mocked(pushPersonalities).mockResolvedValue({ ok: false, reason: 'unreachable' });

    expect(await accountPush()).toBe(1);
    expect(output.join('\n')).toContain("Could not push agents — couldn't reach codeep.dev");
  });
});

describe('codeep account sync', () => {
  it('reports a profile that could not be pulled, and why', async () => {
    vi.mocked(pullUserProfileResult).mockResolvedValue({ ok: false, reason: 'unreachable' });

    await account('sync');
    expect(output.join('\n')).toContain("Could not pull your profile (about you) — couldn't reach codeep.dev");
  });

  it('reports a pulled profile', async () => {
    vi.mocked(pullUserProfileResult).mockResolvedValue(moved);

    await account('sync');
    expect(output.join('\n')).toContain('Pulled your profile (about you).');
  });

  it('says nothing about a profile when there was nothing to pull', async () => {
    vi.mocked(pullUserProfileResult).mockResolvedValue(nothing);

    expect(await account('sync')).toBe(0);
    expect(output.join('\n')).not.toContain('profile');
  });
});
