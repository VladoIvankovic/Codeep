import { vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Give each test worker its own Codeep config directory so parallel workers
// don't race on the shared on-disk config file. Without this, two files that
// mutate config concurrently (e.g. trustWorkspaceHooks → trustedHookProjects)
// can clobber each other's writes, causing order-dependent flakes. Runs before
// the config module (a singleton) is imported by any test file.
if (!process.env.CODEEP_CONFIG_DIR) {
  process.env.CODEEP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'codeep-test-config-'));
}

// Tests must never read or write the developer's real home directory: the
// agent loop records undo history and logs under ~/.codeep, and profile and
// skill code reads and deletes files there. os.homedir() follows HOME (and
// USERPROFILE on Windows), so point both at a throwaway directory per worker.
const testHome = mkdtempSync(join(tmpdir(), 'codeep-test-home-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

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
