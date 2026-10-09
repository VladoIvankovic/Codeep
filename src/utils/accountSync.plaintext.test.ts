import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No system keychain: the native module loads, and every write to it fails —
// a Linux box without a Secret Service. Replaces the in-memory keychain that
// vitest.setup.ts gives every other file, so Codeep falls back to the
// plain-text config, as it does there.
vi.mock('@napi-rs/keyring', () => {
  class AsyncEntry {
    async getPassword() { return null; }
    async setPassword() { throw new Error('Platform secure storage failure: no secret service'); }
    async deletePassword() { return false; }
    async deleteCredential() { return false; }
  }
  return { AsyncEntry, Entry: AsyncEntry };
});

import { config, loadApiKey } from '../config/index';
import { runAccountSync } from './accountSync';
import type { SyncResult } from './codeepCloud';

/**
 * Pulled keys that land in plain text. `codeep account sync` said "synced 2
 * keys." either way, and the user had no way to know their keys were now
 * readable in the config file.
 */

const nothing: SyncResult = { ok: true, count: 0, removed: 0 };

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: unknown) => { throw new Error(`test tried to reach ${String(url)}`); });
  config.set('syncToken', 'sync-token');
  config.set('syncKeysToCloud', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codeep account sync without a system keychain', () => {
  it('says the keys went to plain text, and where', async () => {
    let transcript = '';
    const code = await runAccountSync({
      log: (line) => { transcript += `${line}\n`; },
      write: (text) => { transcript += text; },
      stdinIsTTY: false,
      stdoutIsTTY: false,
      requests: {
        pullKeys: async () => ({ openai: 'sk-openai-PLAIN-0123456789', anthropic: 'sk-ant-PLAIN-0123456789' }),
        pullPersonalities: async () => nothing,
        pullCommands: async () => nothing,
        pullUserProfileResult: async () => nothing,
      },
    });

    expect(code).toBe(0);
    expect(transcript).toContain(
      `  Pulling keys from codeep.dev... synced 2 keys — stored in plain text in ${config.path}: no system keychain is available.\n`,
    );
    // Where it says they are, and nowhere in the output.
    expect(config.get('apiKeys')).toMatchObject({ openai: 'sk-openai-PLAIN-0123456789', anthropic: 'sk-ant-PLAIN-0123456789' });
    expect(await loadApiKey('openai')).toBe('sk-openai-PLAIN-0123456789');
    expect(transcript).not.toContain('PLAIN-0123456789');
  });
});
