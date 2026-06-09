import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// In-memory fake keychain so these tests never touch the real OS keychain.
// SmartStorage probes the keychain (set+delete a test key); backing it with a
// working Map makes it choose the keychain path, so secrets never fall back to
// plaintext config — exactly the production behavior we want to assert.
const { mockKeytar } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const k = (service: string, account: string) => `${service}::${account}`;
  return {
    mockKeytar: {
      _store: store,
      getPassword: vi.fn(async (s: string, a: string) => store.get(k(s, a)) ?? null),
      setPassword: vi.fn(async (s: string, a: string, p: string) => { store.set(k(s, a), p); }),
      deletePassword: vi.fn(async (s: string, a: string) => store.delete(k(s, a))),
    },
  };
});
vi.mock('keytar', () => ({ default: mockKeytar, ...mockKeytar }));

import {
  config,
  setApiKey,
  getApiKey,
  clearApiKey,
  loadAllApiKeys,
  getConfiguredProviders,
  isTelemetryEnabled,
  telemetryForcedOffByEnv,
} from './index';
import { PROVIDERS } from './providers';

// Providers used by these tests — clear any ambient env keys so loadAllApiKeys
// can't override the values we set (loadAllApiKeys honors provider env vars).
const TEST_PROVIDERS = ['minimax', 'openrouter', 'deepseek', 'z.ai'];

describe('config API key storage — secure, no plaintext', () => {
  beforeEach(() => {
    for (const id of TEST_PROVIDERS) {
      const envKey = PROVIDERS[id]?.envKey;
      if (envKey) delete process.env[envKey];
    }
    delete process.env.ZAI_API_KEY;
    delete process.env.ZHIPUAI_API_KEY;
    config.set('providerApiKeys', []);
    config.set('configuredProviderIds', []);
    config.set('apiKey', '');
    config.set('apiKeys', {});
    config.set('keysSecured', true); // skip migration unless a test opts in
    mockKeytar._store.clear();
    vi.clearAllMocks();
  });

  it('setApiKey persists to secure storage, never the plaintext providerApiKeys array', async () => {
    await setApiKey('sk-minimax-123', 'minimax');

    expect(getApiKey('minimax')).toBe('sk-minimax-123');
    // The secret reached the (mock) keychain...
    expect(mockKeytar.setPassword).toHaveBeenCalledWith('codeep', 'api-key-minimax', 'sk-minimax-123');
    // ...and NOT the plaintext config array.
    const plaintext = (config.get('providerApiKeys') || []).find(k => k.providerId === 'minimax');
    expect(plaintext).toBeUndefined();
    // Non-secret index records that the provider has a key.
    expect(config.get('configuredProviderIds')).toContain('minimax');
    expect(config.get('keysSecured')).toBe(true);
  });

  it('clearApiKey removes the key from secure storage and the index', async () => {
    await setApiKey('sk-x', 'deepseek');
    expect(getApiKey('deepseek')).toBe('sk-x');

    await clearApiKey('deepseek');

    expect(getApiKey('deepseek')).toBe('');
    expect(config.get('configuredProviderIds')).not.toContain('deepseek');
    expect(mockKeytar.deletePassword).toHaveBeenCalledWith('codeep', 'api-key-deepseek');
  });

  it('getConfiguredProviders reflects the non-secret index', async () => {
    await setApiKey('sk-a', 'minimax');
    await setApiKey('sk-b', 'openrouter');
    const ids = getConfiguredProviders().map(p => p.id);
    expect(ids).toContain('minimax');
    expect(ids).toContain('openrouter');
  });

  it('migrates legacy plaintext keys into secure storage and wipes the plaintext', async () => {
    // Seed legacy plaintext state and force a migration on next load.
    config.set('keysSecured', false);
    config.set('providerApiKeys', [{ providerId: 'openrouter', apiKey: 'sk-legacy-arr' }]);
    config.set('apiKey', 'sk-legacy-zai'); // very-old single-key field (z.ai)

    await loadAllApiKeys();

    // Keys now readable via the cache (loaded from secure storage).
    expect(getApiKey('openrouter')).toBe('sk-legacy-arr');
    expect(getApiKey('z.ai')).toBe('sk-legacy-zai');
    // Plaintext is wiped and the migration flag is set.
    expect(config.get('providerApiKeys')).toEqual([]);
    expect(config.get('apiKey')).toBe('');
    expect(config.get('keysSecured')).toBe(true);
    // Index records the migrated providers.
    expect(config.get('configuredProviderIds')).toEqual(expect.arrayContaining(['openrouter', 'z.ai']));
    // Secrets live in the (mock) keychain, not the config file.
    expect(mockKeytar._store.get('codeep::api-key-openrouter')).toBe('sk-legacy-arr');
  });

  it('migration is idempotent — does not re-run once secured', async () => {
    config.set('keysSecured', false);
    config.set('providerApiKeys', [{ providerId: 'minimax', apiKey: 'sk-first' }]);
    await loadAllApiKeys();
    expect(config.get('keysSecured')).toBe(true);

    // A stale plaintext write after securing must NOT be migrated again.
    config.set('providerApiKeys', [{ providerId: 'minimax', apiKey: 'sk-should-not-migrate' }]);
    await loadAllApiKeys();
    expect(config.get('providerApiKeys')).toEqual([{ providerId: 'minimax', apiKey: 'sk-should-not-migrate' }]);
  });

  // Placed BEFORE the keychain-write-failure tests below: those flip the shared
  // SmartStorage's useKeychain to false (memoized for the process), which would
  // make a later sweep see the keychain as unavailable.
  it('sweeps plaintext fallback keys into the keychain once it is available', async () => {
    // Simulate a prior keychain-less run that left a key in the plaintext map.
    config.set('apiKeys', { minimax: 'sk-from-fallback' });
    config.set('configuredProviderIds', []);
    await loadAllApiKeys(); // runs the sweep (mock keychain is available)
    // Key moved into the (mock) keychain, indexed, and removed from plaintext.
    expect(mockKeytar._store.get('codeep::api-key-minimax')).toBe('sk-from-fallback');
    expect(config.get('configuredProviderIds')).toContain('minimax');
    expect((config.get('apiKeys') || {}).minimax).toBeUndefined();
    expect(getApiKey('minimax')).toBe('sk-from-fallback');
  });

  it('migration retains keys that fail to persist and stays unsecured for retry (no data loss)', async () => {
    config.set('keysSecured', false);
    config.set('providerApiKeys', [{ providerId: 'minimax', apiKey: 'sk-keepme' }]);
    // Force BOTH the keychain probe/write AND the plaintext fallback write to
    // fail for this key, so secure storage genuinely cannot persist it.
    mockKeytar.setPassword.mockRejectedValue(new Error('keychain down'));
    const realSet = config.set.bind(config);
    const spy = vi.spyOn(config, 'set').mockImplementation((key: any, value?: any) => {
      if (key === 'apiKeys') throw new Error('disk full');
      return realSet(key, value);
    });
    try {
      await loadAllApiKeys();
      // The only copy of the key must be retained, not wiped.
      expect(config.get('providerApiKeys')).toEqual([{ providerId: 'minimax', apiKey: 'sk-keepme' }]);
      // And migration must NOT mark secured, so it retries on the next startup.
      expect(config.get('keysSecured')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('setApiKey propagates a hard persistence failure instead of reporting success', async () => {
    mockKeytar.setPassword.mockRejectedValue(new Error('keychain down'));
    const realSet = config.set.bind(config);
    const spy = vi.spyOn(config, 'set').mockImplementation((key: any, value?: any) => {
      if (key === 'apiKeys') throw new Error('disk full');
      return realSet(key, value);
    });
    try {
      await expect(setApiKey('sk-x', 'deepseek')).rejects.toThrow();
      // Not recorded as configured, since the write was not confirmed.
      expect(config.get('configuredProviderIds')).not.toContain('deepseek');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('telemetry opt-out (isTelemetryEnabled)', () => {
  const SAVED = { no: process.env.CODEEP_NO_TELEMETRY, dnt: process.env.DO_NOT_TRACK };
  beforeEach(() => {
    delete process.env.CODEEP_NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    config.set('telemetry', true);
  });
  afterEach(() => {
    if (SAVED.no === undefined) delete process.env.CODEEP_NO_TELEMETRY; else process.env.CODEEP_NO_TELEMETRY = SAVED.no;
    if (SAVED.dnt === undefined) delete process.env.DO_NOT_TRACK; else process.env.DO_NOT_TRACK = SAVED.dnt;
    config.set('telemetry', true);
  });

  it('is enabled by default', () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('is disabled by the telemetry:false config flag', () => {
    config.set('telemetry', false);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('is disabled by CODEEP_NO_TELEMETRY', () => {
    process.env.CODEEP_NO_TELEMETRY = '1';
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('respects the DO_NOT_TRACK convention', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('treats falsey env values ("0"/"false") as not opting out', () => {
    process.env.CODEEP_NO_TELEMETRY = '0';
    expect(isTelemetryEnabled()).toBe(true);
    process.env.CODEEP_NO_TELEMETRY = 'false';
    expect(isTelemetryEnabled()).toBe(true);
  });

  describe('telemetryForcedOffByEnv', () => {
    it('is false by default and when the flag alone is off', () => {
      expect(telemetryForcedOffByEnv()).toBe(false);
      config.set('telemetry', false); // flag off is NOT an env force
      expect(telemetryForcedOffByEnv()).toBe(false);
    });
    it('is true when an env var forces telemetry off', () => {
      process.env.CODEEP_NO_TELEMETRY = '1';
      expect(telemetryForcedOffByEnv()).toBe(true);
      delete process.env.CODEEP_NO_TELEMETRY;
      process.env.DO_NOT_TRACK = 'yes';
      expect(telemetryForcedOffByEnv()).toBe(true);
    });
    it('is false for falsey env values', () => {
      process.env.DO_NOT_TRACK = '0';
      expect(telemetryForcedOffByEnv()).toBe(false);
    });
  });
});
