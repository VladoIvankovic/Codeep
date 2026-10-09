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

// The plaintext fallback is a plain object keyed by provider id, and a plain
// object answers for more names than it holds: `constructor`, `toString` and
// `__proto__` come back as members of Object.prototype. Provider ids are not
// all ours — a synced entry from codeep.dev or a typed `/login <name>` can be
// any string — so a lookup must see only what was stored.
describe('plaintext fallback — provider names that Object.prototype also has', () => {
  const PROTOTYPE_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__'];

  // Like conf: the value goes to "disk" as JSON, and every get parses a fresh
  // copy — which is also how an own `__proto__` entry arrives from a real file.
  function makeDiskLikeConfig(initialJson = '{"apiKeys":{}}') {
    let disk = initialJson;
    return {
      get: (key: string) => (JSON.parse(disk) as Record<string, unknown>)[key],
      set: (key: string, value: unknown) => {
        const all = JSON.parse(disk) as Record<string, unknown>;
        all[key] = value;
        disk = JSON.stringify(all);
      },
      disk: () => disk,
    };
  }

  function expectPrototypeUntouched() {
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.constructor).toBe(Object);
    expect(typeof Object.prototype.toString).toBe('function');
    expect(String({})).toBe('[object Object]');
  }

  describe.each([
    ['the keychain is available', () => undefined],
    ['the keychain is unavailable', () => mockEntryFactory.overrides.set('__codeep_test__', {
      setPassword: () => { throw new Error('no keychain'); },
    })],
  ])('when %s', (_label, arrange) => {
    beforeEach(() => {
      vi.clearAllMocks();
      arrange();
    });

    it.each(PROTOTYPE_NAMES)('finds no key for %s when none was stored', async (name) => {
      const storage = createSecureStorage(makeDiskLikeConfig());
      expect(await storage.getApiKey(name)).toBeNull();
      expect(await storage.hasApiKey(name)).toBe(false);
    });

    it.each(PROTOTYPE_NAMES)('stores a key under %s and reads back exactly that', async (name) => {
      const config = makeDiskLikeConfig();
      const storage = createSecureStorage(config);
      // The keychain probe decides where it lands; force the plaintext map.
      mockEntryFactory.overrides.set(`api-key-${name}`, {
        setPassword: () => { throw new Error('write failed'); },
      });
      await storage.setApiKey(name, 'sk-stored');
      expect(await storage.getApiKey(name)).toBe('sk-stored');
      expect(await storage.hasApiKey(name)).toBe(true);
      // And nothing leaked to the names that were not stored.
      for (const other of PROTOTYPE_NAMES.filter(n => n !== name)) {
        expect(await storage.getApiKey(other), other).toBeNull();
      }
      expectPrototypeUntouched();
    });
  });

  it('cannot be made to swap a map\'s prototype by a value that is an object', async () => {
    mockEntryFactory.overrides.set('__codeep_test__', {
      setPassword: () => { throw new Error('no keychain'); },
    });
    const config = makeDiskLikeConfig();
    const storage = createSecureStorage(config);
    // Assigning an object to keys['__proto__'] replaces the prototype of keys,
    // so `polluted` would be readable off every key map afterwards.
    await storage.setApiKey('__proto__', { polluted: true } as unknown as string);
    const keys = config.get('apiKeys') as Record<string, unknown>;
    expect(Object.getPrototypeOf(keys)).toBe(Object.prototype);
    expect(keys.polluted).toBeUndefined();
    // The object is stored as a value, not a key: no string, so no key.
    expect(await storage.getApiKey('__proto__')).toBeNull();
    expect(await storage.getApiKey('polluted')).toBeNull();
    expectPrototypeUntouched();
  });

  it('still returns an entry that really is named like a prototype member', async () => {
    const config = makeDiskLikeConfig('{"apiKeys":{"constructor":"sk-ctor","toString":"sk-ts","openai":"sk-oa"}}');
    const storage = createSecureStorage(config);
    expect(await storage.getApiKey('constructor')).toBe('sk-ctor');
    expect(await storage.getApiKey('toString')).toBe('sk-ts');
    expect(await storage.getApiKey('openai')).toBe('sk-oa');
    // An own `__proto__` entry arrives from JSON.parse as exactly that.
    const withProto = createSecureStorage(makeDiskLikeConfig('{"apiKeys":{"__proto__":"sk-proto"}}'));
    expect(await withProto.getApiKey('__proto__')).toBe('sk-proto');
    expect(await withProto.hasApiKey('__proto__')).toBe(true);
  });

  // The typeof check alone turns away every Object.prototype member, which is a
  // function or an object. What only the own-property check stops is a STRING
  // the map inherits — the map's prototype carrying a member named like a
  // provider, as a polluted Object.prototype would.
  it('does not take a key the map merely inherits, a string included', async () => {
    const inherited = Object.create({ openai: 'sk-from-the-prototype' }) as Record<string, string>;
    inherited.anthropic = 'sk-own';
    const storage = createSecureStorage({ get: () => inherited, set: () => {} });
    expect(await storage.getApiKey('openai')).toBeNull();
    expect(await storage.hasApiKey('openai')).toBe(false);
    expect(await storage.getApiKey('anthropic')).toBe('sk-own');
  });

  it('deletes only the entry that was stored, whatever it is named', async () => {
    const config = makeDiskLikeConfig('{"apiKeys":{"constructor":"sk-ctor","__proto__":"sk-proto","openai":"sk-oa"}}');
    const storage = createSecureStorage(config);
    await storage.deleteApiKey('constructor');
    await storage.deleteApiKey('__proto__');
    await storage.deleteApiKey('toString'); // never stored: nothing to remove, nothing to break
    expect(JSON.parse(config.disk())).toEqual({ apiKeys: { openai: 'sk-oa' } });
    expectPrototypeUntouched();
  });

  it('does not take a stored value that is not a string for a key', async () => {
    const storage = createSecureStorage(makeDiskLikeConfig('{"apiKeys":{"a":1,"b":{"x":1},"c":true,"d":""}}'));
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(await storage.getApiKey(name), name).toBeNull();
      expect(await storage.hasApiKey(name), name).toBe(false);
    }
  });
});
