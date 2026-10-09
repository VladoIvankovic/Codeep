import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A keychain that counts its reads, per account. Replaces the in-memory one
// vitest.setup.ts gives every other file.
const keychain = vi.hoisted(() => ({ items: new Map<string, string>(), reads: new Map<string, number>() }));
vi.mock('@napi-rs/keyring', () => {
  class AsyncEntry {
    constructor(private service: string, private account: string) {}
    async getPassword() {
      keychain.reads.set(this.account, (keychain.reads.get(this.account) ?? 0) + 1);
      return keychain.items.get(`${this.service}::${this.account}`) ?? null;
    }
    async setPassword(value: string) { keychain.items.set(`${this.service}::${this.account}`, value); }
    async deletePassword() { return keychain.items.delete(`${this.service}::${this.account}`); }
    async deleteCredential() { return keychain.items.delete(`${this.service}::${this.account}`); }
  }
  return { AsyncEntry, Entry: AsyncEntry };
});

import { config, setApiKey } from '../config/index';
import { PROVIDERS } from '../config/providers';
import { runAccountPush } from './accountSync';
import type { SyncResult } from './codeepCloud';

/**
 * How often `codeep account push` reads the keychain. It filled the key cache
 * first and then read every stored key again: two reads of each, and on
 * macOS a keychain item whose access list lacks this binary asks for each.
 */

const nothing: SyncResult = { ok: true, count: 0, removed: 0 };

async function push() {
  const pushKeys = vi.fn(async (_keys: Record<string, string>) => true);
  const code = await runAccountPush({
    log: () => {},
    write: () => {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    requests: {
      pushKeys,
      pushPersonalities: async () => nothing,
      pushCommands: async () => nothing,
      pushUserProfileResult: async () => nothing,
    },
  });
  return { code, pushKeys };
}

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: unknown) => { throw new Error(`test tried to reach ${String(url)}`); });
  vi.stubEnv('ZAI_API_KEY', '');
  vi.stubEnv('ZHIPUAI_API_KEY', '');
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.envKey) vi.stubEnv(provider.envKey, '');
  }
  keychain.items.clear();
  config.set('syncToken', 'sync-token');
  config.set('syncKeysToCloud', true);
  config.set('apiKeys', {});
  config.set('configuredProviderIds', []);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('codeep account push and the keychain', () => {
  it('reads each stored key once', async () => {
    await setApiKey('sk-openai-STORED-0123456789', 'openai');
    await setApiKey('sk-ant-STORED-0123456789', 'anthropic');
    keychain.reads.clear();

    const { code, pushKeys } = await push();

    expect(code).toBe(0);
    expect(pushKeys).toHaveBeenCalledWith({ openai: 'sk-openai-STORED-0123456789', anthropic: 'sk-ant-STORED-0123456789' });
    expect(keychain.reads.get('api-key-openai')).toBe(1);
    expect(keychain.reads.get('api-key-anthropic')).toBe(1);
    for (const [account, reads] of keychain.reads) expect(reads, account).toBe(1);
  });

  it('uploads a key kept in the plain-text config, which no keychain read finds', async () => {
    config.set('apiKeys', { anthropic: 'sk-ant-PLAINTEXT-0123456789' });
    config.set('configuredProviderIds', ['anthropic']);

    const { pushKeys } = await push();

    expect(pushKeys).toHaveBeenCalledWith({ anthropic: 'sk-ant-PLAINTEXT-0123456789' });
  });
});
