import { logger } from './logger';

// Native keychain access goes through `@napi-rs/keyring` (Rust binary with
// prebuilt artifacts — no node-gyp, no prebuild-install). The previous
// `keytar` addon pulled deprecated `prebuild-install` and frequently broke
// on ARM Linux / new macOS releases. `@napi-rs/keyring` ships per-platform
// binaries as optionalDependencies so npm picks the right one automatically.
//
// The @napi-rs/keyring API differs from keytar's:
//   - keytar: module-level `getPassword(service, account)` etc. (async)
//   - @napi-rs/keyring: `new AsyncEntry(service, account)` instance whose
//     `getPassword()` / `setPassword(pw)` / `deletePassword()` return
//     Promises and run keychain I/O off the JS thread. (The sync `Entry`
//     variant would freeze the TUI event loop while macOS shows its
//     keychain-authorization dialog — first run after a binary change.)
//
// getPassword() resolves null for a missing entry (verified against the
// shipped binding — same contract keytar had), so SmartStorage's fallback
// order is unchanged. Lazy loading keeps a failed/broken native binary from
// blocking module import (and bun build --compile stays happy).
type KeyringEntry = {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
};
type KeyringModule = { AsyncEntry: new (service: string, account: string) => KeyringEntry };

let _keyring: KeyringModule | null = null;
let _keyringTried = false;
async function loadKeyring(): Promise<KeyringModule | null> {
  if (!_keyringTried) {
    _keyringTried = true;
    try {
      _keyring = (await import('@napi-rs/keyring')) as KeyringModule;
    } catch {
      _keyring = null; /* native binary unavailable (headless / minimal install) */
    }
  }
  return _keyring;
}

const SERVICE_NAME = 'codeep';

/**
 * Secure storage for API keys using native keychain
 * - macOS: Keychain
 * - Linux: Secret Service API (libsecret)
 * - Windows: Credential Vault
 */

export interface SecureStorage {
  getApiKey(providerId: string): Promise<string | null>;
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  deleteApiKey(providerId: string): Promise<void>;
  hasApiKey(providerId: string): Promise<boolean>;
  /** Whether the OS keychain is usable (vs the plaintext-config fallback).
   *  Optional — only SmartStorage (what createSecureStorage returns) implements it. */
  isKeychainAvailable?(): Promise<boolean>;
}

class KeychainStorage implements SecureStorage {
  private getAccountName(providerId: string): string {
    return `api-key-${providerId}`;
  }

  async getApiKey(providerId: string): Promise<string | null> {
    try {
      const kr = await loadKeyring();
      if (!kr) return null;
      const account = this.getAccountName(providerId);
      const entry = new kr.AsyncEntry(SERVICE_NAME, account);
      return await entry.getPassword();
    } catch (error) {
      logger.debug(`Failed to get API key from keychain: ${error}`);
      return null;
    }
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    try {
      const kr = await loadKeyring();
      if (!kr) throw new Error('keyring unavailable');
      const account = this.getAccountName(providerId);
      const entry = new kr.AsyncEntry(SERVICE_NAME, account);
      await entry.setPassword(apiKey);
    } catch (error) {
      throw new Error(`Failed to store API key in keychain: ${error}`);
    }
  }

  async deleteApiKey(providerId: string): Promise<void> {
    try {
      const kr = await loadKeyring();
      if (!kr) return;
      const account = this.getAccountName(providerId);
      const entry = new kr.AsyncEntry(SERVICE_NAME, account);
      await entry.deletePassword();
    } catch (error) {
      logger.debug(`Failed to delete API key from keychain: ${error}`);
    }
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    const key = await this.getApiKey(providerId);
    return key !== null && key.length > 0;
  }
}

/**
 * Fallback to plain text storage in config
 * Used when keychain is not available or fails
 */
class FallbackStorage implements SecureStorage {
  private config: any;

  constructor(config: any) {
    this.config = config;
  }

  async getApiKey(providerId: string): Promise<string | null> {
    const keys = this.config.get('apiKeys') || {};
    return keys[providerId] || null;
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const keys = this.config.get('apiKeys') || {};
    keys[providerId] = apiKey;
    this.config.set('apiKeys', keys);
  }

  async deleteApiKey(providerId: string): Promise<void> {
    const keys = this.config.get('apiKeys') || {};
    delete keys[providerId];
    this.config.set('apiKeys', keys);
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    const key = await this.getApiKey(providerId);
    return key !== null && key.length > 0;
  }
}

/**
 * Smart storage that tries keychain first, falls back to config
 */
class SmartStorage implements SecureStorage {
  private keychain: KeychainStorage;
  private fallback: FallbackStorage;
  private config: any;
  private useKeychain: boolean = true;
  private keychainTested: boolean = false;
  private warnedLegacyKeytar: boolean = false;

  constructor(config: any) {
    this.keychain = new KeychainStorage();
    this.fallback = new FallbackStorage(config);
    this.config = config;
  }

  private async ensureKeychainTested(): Promise<void> {
    if (this.keychainTested) return;

    try {
      const testKey = '__codeep_test__';
      const kr = await loadKeyring();
      if (!kr) throw new Error('keyring unavailable');
      const entry = new kr.AsyncEntry(SERVICE_NAME, testKey);
      await entry.setPassword('test');
      await entry.deletePassword();
      this.useKeychain = true;
    } catch {
      this.useKeychain = false;
      logger.warn(
        'System keychain is unavailable. API keys will be stored as plaintext in the config file. ' +
        'Consider installing libsecret (Linux) or ensuring Keychain Access is available (macOS).'
      );
    }

    this.keychainTested = true;
  }

  async isKeychainAvailable(): Promise<boolean> {
    await this.ensureKeychainTested();
    return this.useKeychain;
  }

  async getApiKey(providerId: string): Promise<string | null> {
    await this.ensureKeychainTested();

    if (this.useKeychain) {
      const key = await this.keychain.getApiKey(providerId);
      if (key) return key;
    }
    const fromFallback = await this.fallback.getApiKey(providerId);
    // Migration note (Linux/Windows only): keys stored by the old keytar
    // addon live under a different credential-store naming than keyring-rs
    // uses, so they're invisible here — and the plaintext copies were
    // already purged by the keysSecured migration. Nothing to silently
    // recover; tell the user once so a missing key isn't a mystery.
    // (macOS is unaffected — both libraries share the same Keychain items.)
    if (fromFallback === null && !this.warnedLegacyKeytar
        && process.platform !== 'darwin' && this.useKeychain
        && this.config?.get?.('keysSecured') === true) {
      this.warnedLegacyKeytar = true;
      logger.warn(
        'API keys saved by Codeep ≤ 2.14 (keytar) can\'t be read by the new keychain backend on this OS. ' +
        'Re-add the affected key with /login <provider> <key> — it will be stored under the new backend.'
      );
    }
    return fromFallback;
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.ensureKeychainTested();
    
    if (this.useKeychain) {
      try {
        await this.keychain.setApiKey(providerId, apiKey);
        // Remove from fallback if it was there
        await this.fallback.deleteApiKey(providerId);
        return;
      } catch (error) {
        this.useKeychain = false;
        logger.warn(
          `Keychain write failed for '${providerId}'. API key will be stored as plaintext in config. Error: ${error}`
        );
      }
    }
    await this.fallback.setApiKey(providerId, apiKey);
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await this.ensureKeychainTested();
    
    if (this.useKeychain) {
      await this.keychain.deleteApiKey(providerId);
    }
    await this.fallback.deleteApiKey(providerId);
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    await this.ensureKeychainTested();
    
    if (this.useKeychain) {
      const hasKeychain = await this.keychain.hasApiKey(providerId);
      if (hasKeychain) return true;
    }
    return this.fallback.hasApiKey(providerId);
  }
}

/**
 * Migrate existing plain-text API keys to keychain
 */
export async function migrateApiKeysToKeychain(config: any): Promise<void> {
  const storage = new SmartStorage(config);
  const apiKeys = config.get('apiKeys') || {};
  
  for (const [providerId, apiKey] of Object.entries(apiKeys)) {
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      try {
        await storage.setApiKey(providerId, apiKey);
        logger.info(`Migrated API key for ${providerId} to secure storage`);
      } catch (error) {
        logger.error(`Failed to migrate API key for ${providerId}`);
      }
    }
  }
}

// Export singleton
export function createSecureStorage(config: any): SecureStorage {
  return new SmartStorage(config);
}
