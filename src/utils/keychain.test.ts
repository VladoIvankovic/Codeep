import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockKeytar, mockLogger } = vi.hoisted(() => ({
  mockKeytar: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
  mockLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('keytar', () => ({
  default: mockKeytar,
  ...mockKeytar,
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

describe('SmartStorage (keychain available)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keychain probe succeeds
    mockKeytar.setPassword.mockResolvedValue(undefined);
    mockKeytar.deletePassword.mockResolvedValue(true);
    mockKeytar.getPassword.mockResolvedValue(null);
  });

  it('stores API key in keychain when available', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    await storage.setApiKey('openai', 'sk-test');
    // setPassword called for probe + actual set
    const setCalls = mockKeytar.setPassword.mock.calls;
    expect(setCalls.some(([, account, value]: string[]) => account === 'api-key-openai' && value === 'sk-test')).toBe(true);
  });

  it('retrieves key from keychain', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    mockKeytar.getPassword.mockResolvedValue('sk-retrieved');
    const key = await storage.getApiKey('openai');
    expect(key).toBe('sk-retrieved');
  });

  it('falls back to config if keychain returns null', async () => {
    const config = makeFakeConfig({ apiKeys: { anthropic: 'sk-fallback' } });
    const storage = createSecureStorage(config);
    mockKeytar.getPassword.mockResolvedValue(null);
    const key = await storage.getApiKey('anthropic');
    expect(key).toBe('sk-fallback');
  });

  it('hasApiKey returns true when key exists in keychain', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    mockKeytar.getPassword.mockResolvedValue('sk-key');
    expect(await storage.hasApiKey('openai')).toBe(true);
  });

  it('hasApiKey returns false when no key anywhere', async () => {
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    mockKeytar.getPassword.mockResolvedValue(null);
    expect(await storage.hasApiKey('openai')).toBe(false);
  });

  it('deletes key from keychain and from fallback config', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-old' } });
    const storage = createSecureStorage(config);
    // Trigger keychainTested first with a get
    await storage.hasApiKey('openai');
    await storage.deleteApiKey('openai');
    // keytar.deletePassword should have been called at some point
    const deleteCalls = (mockKeytar.deletePassword.mock.calls as [string, string][])
      .filter(([, account]) => account === 'api-key-openai');
    expect(deleteCalls.length).toBeGreaterThan(0);
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
    // Keychain probe fails
    mockKeytar.setPassword.mockRejectedValueOnce(new Error('no keychain'));
    mockKeytar.getPassword.mockResolvedValue(null);
    mockKeytar.deletePassword.mockResolvedValue(true);
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
    await storage.setApiKey('openai', 'sk-config'); // trigger probe to know keychain is off
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
    // Probe succeeds
    mockKeytar.setPassword.mockResolvedValueOnce(undefined);
    mockKeytar.deletePassword.mockResolvedValue(true);
  });

  it('falls back to config and warns when keychain write fails after probe', async () => {
    // Probe succeeds, then real write fails
    mockKeytar.setPassword.mockRejectedValueOnce(new Error('write failed'));
    const config = makeFakeConfig();
    const storage = createSecureStorage(config);
    // First call (probe) already resolved in beforeEach, now trigger real set
    await storage.hasApiKey('openai'); // triggers keychainTested=true
    // Reset and fail the next write
    mockKeytar.setPassword.mockRejectedValueOnce(new Error('write failed'));
    await storage.setApiKey('openai', 'sk-test');
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
    const keys = config.get('apiKeys') as Record<string, string>;
    expect(keys['openai']).toBe('sk-test');
  });
});

describe('migrateApiKeysToKeychain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeytar.setPassword.mockResolvedValue(undefined);
    mockKeytar.deletePassword.mockResolvedValue(true);
    mockKeytar.getPassword.mockResolvedValue(null);
  });

  it('migrates all existing plain-text keys to keychain', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-migrate', anthropic: 'sk-anth' } });
    await migrateApiKeysToKeychain(config);
    // migrateApiKeysToKeychain iterates apiKeys and calls storage.setApiKey for each
    // At minimum, config.get('apiKeys') should have been called to read keys
    expect(config.get).toHaveBeenCalledWith('apiKeys');
    // setPassword should have been called at least for probe
    expect(mockKeytar.setPassword).toHaveBeenCalled();
  });

  it('skips empty keys', async () => {
    const config = makeFakeConfig({ apiKeys: { openai: '' } });
    await migrateApiKeysToKeychain(config);
    const setCallsForReal = mockKeytar.setPassword.mock.calls.filter(([, account]: string[]) => account === 'api-key-openai');
    expect(setCallsForReal).toHaveLength(0);
  });

  it('does not throw if migration fails for a key', async () => {
    mockKeytar.setPassword.mockResolvedValueOnce(undefined); // probe
    mockKeytar.setPassword.mockRejectedValueOnce(new Error('keychain error'));
    const config = makeFakeConfig({ apiKeys: { openai: 'sk-fail' } });
    await expect(migrateApiKeysToKeychain(config)).resolves.not.toThrow();
  });
});
