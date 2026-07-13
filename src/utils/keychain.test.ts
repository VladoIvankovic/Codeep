import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
//
// @napi-rs/keyring exposes `AsyncEntry` — a class instantiated with
// (service, account) whose instance methods return PROMISES (keychain I/O
// runs off the JS thread; getPassword resolves null for a missing entry).
// We fake it with a factory that records the account name and returns
// vi.fn-backed async methods. The in-memory store lets tests pre-seed keys
// and assert what landed.
const { mockStore, mockEntryFactory, mockLogger } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const factory = {
    // Each `new AsyncEntry(service, account)` call lands here. We capture
    // the account so tests can assert which entry was touched.
    make: vi.fn((service: string, account: string) => ({
      account,
      getPassword: vi.fn(async () => store.get(account) ?? null),
      setPassword: vi.fn(async (pw: string) => { store.set(account, pw); }),
      deletePassword: vi.fn(async () => { store.delete(account); return true; }),
    })),
    // Per-entry override hooks — tests can swap a method on a specific
    // account mid-test (e.g. simulate a runtime write failure). The
    // override takes precedence over the default above.
    overrides: new Map<string, Partial<{ getPassword: () => Promise<string | null>; setPassword: (pw: string) => Promise<void>; deletePassword: () => Promise<boolean> }>>(),
  };
  return {
    mockStore: store,
    mockEntryFactory: factory,
    mockLogger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  };
});

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: function (service: string, account: string) {
    // Honour per-account overrides so a test can simulate "write to
    // openai fails at runtime" without affecting the probe entry.
    const override = mockEntryFactory.overrides.get(account);
    const base = mockEntryFactory.make(service, account);
    return override ? { ...base, ...override } : base;
  },
}));
vi.mock('./logger', () => ({ logger: mockLogger }));

import { createSecureStorage, migrateApiKeysToKeychain } from './keychain';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeFakeConfig(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { apiKeys: {}, ...initial };
  return {
    get: vi.fn((key: string) => store[key]),
    set: vi.fn((key: string, value: unknown) => { store[key] = value; }),
    _store: store,
  };
}

beforeEach(() => {
  mockStore.clear();
  mockEntryFactory.make.mockClear();
  mockEntryFactory.overrides.clear();
});

describe('SmartStorage (keychain available)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores API key in keychain when available', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-test');
    // The Entry for 'api-key-openai' should have had setPassword called.
    expect(mockStore.get('api-key-openai')).toBe('sk-test');
  });

  it('retrieves key from keychain', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    mockStore.set('api-key-openai', 'sk-retrieved');
    const key = await storage.getApiKey('openai');
    expect(key).toBe('sk-retrieved');
  });

  it('falls back to config if keychain returns null', async () => {
    const config = makeFakeConfig({ apiKeys: { anthropic: 'sk-fallback' } });
    const storage = createSecureStorage(config);
    // No entry seeded → getPassword returns null → config fallback kicks in.
    const key = await storage.getApiKey('anthropic');
    expect(key).toBe('sk-fallback');
  });

  it('hasApiKey returns true when key exists in keychain', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    mockStore.set('api-key-openai', 'sk-key');
    expect(await storage.hasApiKey('openai')).toBe(true);
  });

  it('hasApiKey returns false when no key anywhere', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    expect(await storage.hasApiKey('openai')).toBe(false);
  });

  it('deletes key from keychain and from fallback config', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-old' } });
    const storage = createSecureStorage(config);
    mockStore.set('api-key-openai', 'sk-from-keychain');
    await storage.deleteApiKey('openai');
    expect(mockStore.has('api-key-openai')).toBe(false);
    // Fallback config entry also cleared.
    expect((config.get('apiKeys') as Record<string, string>).openai).toBeUndefined();
  });

  it('config.set is called when key removed from fallback after keychain write', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-old' } });
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-new');
    expect(config.set).toHaveBeenCalled();
  });
});

describe('SmartStorage (keychain unavailable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force the probe entry to throw — simulates a missing/broken binary.
    mockEntryFactory.overrides.set('__codeep_test__', {
      setPassword: () => { throw new Error('no keychain'); },
    });
  });

  it('emits a warning when keychain is unavailable', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-test'); // triggers probe
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
  });

  it('stores key in config when keychain is unavailable', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-stored');
    const keys = config.get('apiKeys') as Record<string, string>;
    expect(keys['openai']).toBe('sk-stored');
  });

  it('retrieves key from config when keychain unavailable', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-config' } });
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-config'); // trigger probe
    const key = await storage.getApiKey('openai');
    expect(key).toBe('sk-config');
  });

  it('hasApiKey returns true for key in config', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-config' } });
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-config'); // trigger probe
    expect(await storage.hasApiKey('openai')).toBe(true);
  });
});

describe('SmartStorage — keychain write fails at runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Probe succeeds (default mock). Only the openai entry throws on write.
    mockEntryFactory.overrides.set('api-key-openai', {
      setPassword: () => { throw new Error('write failed'); },
    });
  });

  it('falls back to config and warns when keychain write fails after probe', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    await storage.hasApiKey('openai'); // probe passes, keychainTested=true
    await storage.setApiKey('openai', 'sk-test');
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
    const keys = config.get('apiKeys') as Record<string, string>;
    expect(keys['openai']).toBe('sk-test');
  });
});

describe('migrateApiKeysToKeychain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates all existing plain-text keys to keychain', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-migrate', anthropic: 'sk-anth' } });
    await migrateApiKeysToKeychain(config);
    expect(config.get).toHaveBeenCalledWith('apiKeys');
    expect(mockStore.get('api-key-openai')).toBe('sk-migrate');
    expect(mockStore.get('api-key-anthropic')).toBe('sk-anth');
  });

  it('skips empty keys', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: '' } });
    await migrateApiKeysToKeychain(config);
    expect(mockStore.has('api-key-openai')).toBe(false);
  });

  it('does not throw if migration fails for a key', async () => {
    // Force the openai entry to throw on write. SmartStorage catches it,
    // downgrades to plaintext, and warns — so migrateApiKeysToKeychain
    // sees a successful setApiKey and proceeds. The key still lands in
    // config (plaintext fallback), so nothing is lost.
    mockEntryFactory.overrides.set('api-key-openai', {
      setPassword: () => { throw new Error('keychain error'); },
    });
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-fail' } });
    await expect(migrateApiKeysToKeychain(config)).resolves.not.toThrow();
    // SmartStorage should have warned about the keychain failure.
    expect(mockLogger.warn).toHaveBeenCalled();
    // And the key should still have been stored via the plaintext fallback.
    expect((config.get('apiKeys') as Record<string, string>).openai).toBe('sk-fail');
  });
});
