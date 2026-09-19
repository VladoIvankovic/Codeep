import { vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The directories this file made, to remove on the way out.
 *
 * Only the ones it made: CODEEP_CONFIG_DIR can be set from outside, and
 * deleting a directory somebody else pointed us at is not ours to do.
 */
const ownTempDirs: string[] = [];

// Give each test worker its own Codeep config directory so parallel workers
// don't race on the shared on-disk config file. Without this, two files that
// mutate config concurrently (e.g. trustWorkspaceHooks → trustedHookProjects)
// can clobber each other's writes, causing order-dependent flakes. Runs before
// the config module (a singleton) is imported by any test file.
if (!process.env.CODEEP_CONFIG_DIR) {
  const configDir = mkdtempSync(join(tmpdir(), 'codeep-test-config-'));
  process.env.CODEEP_CONFIG_DIR = configDir;
  ownTempDirs.push(configDir);
}

// Tests must never read or write the developer's real home directory: the
// agent loop records undo history and logs under ~/.codeep, and profile and
// skill code reads and deletes files there. os.homedir() follows HOME (and
// USERPROFILE on Windows), so point both at a throwaway directory per worker.
const testHome = mkdtempSync(join(tmpdir(), 'codeep-test-home-'));
ownTempDirs.push(testHome);
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

/**
 * Remove them once the test file that got them is done.
 *
 * This setup runs again for every test file, so every `npx vitest run` left
 * one config directory and one home directory per test file behind in TMPDIR,
 * for good. On this machine that had reached 14,518 of them and 276MB before
 * anyone noticed.
 *
 * `afterAll` and not a `process.on('exit')` handler, which was the first
 * attempt and removed nothing: the pool ends a worker rather than letting it
 * exit, so 'exit' never fires. This hook does, and it runs LAST — Vitest
 * unwinds afterAll hooks in reverse registration order and this file is
 * registered before any test's own — so a test that cleans up under HOME
 * still finds HOME there.
 *
 * `CODEEP_CONFIG_DIR` is unset along with its directory, so a worker that
 * goes on to another test file makes itself a fresh one instead of pointing
 * the config singleton at a directory that is no longer there.
 *
 * Each removal in its own try: a leftover temp directory must never be the
 * thing that fails a test run. A test file that replaces the whole `fs`
 * module rather than spreading `importOriginal()` over it gets a stubbed
 * `rmSync` here and keeps its directory — across the 140 files in this suite
 * that is one, against 280 before.
 */
afterAll(() => {
  for (const dir of ownTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    if (dir === process.env.CODEEP_CONFIG_DIR) delete process.env.CODEEP_CONFIG_DIR;
  }
  ownTempDirs.length = 0;
});

// No test may reach the real OS keychain: a stray setApiKey would overwrite
// the developer's own API keys. Files that need specific keychain behaviour
// mock '@napi-rs/keyring' themselves, which replaces this in-memory default.
vi.mock('@napi-rs/keyring', () => {
  const store = new Map<string, string>();
  const key = (service: string, account: string) => `${service}::${account}`;
  class AsyncEntry {
    constructor(private service: string, private account: string) {}
    async getPassword() { return store.get(key(this.service, this.account)) ?? null; }
    async setPassword(value: string) { store.set(key(this.service, this.account), value); }
    async deletePassword() { return store.delete(key(this.service, this.account)); }
    async deleteCredential() { return store.delete(key(this.service, this.account)); }
  }
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { return store.get(key(this.service, this.account)) ?? null; }
    setPassword(value: string) { store.set(key(this.service, this.account), value); }
    deletePassword() { return store.delete(key(this.service, this.account)); }
    deleteCredential() { return store.delete(key(this.service, this.account)); }
  }
  return { AsyncEntry, Entry };
});
