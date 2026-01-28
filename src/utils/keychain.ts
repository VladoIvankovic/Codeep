import keytar from 'keytar';
import { logger } from './logger';

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
}

class KeychainStorage implements SecureStorage {
  private getAccountName(providerId: string): string {
    return `api-key-${providerId}`;
  }

  async getApiKey(providerId: string): Promise<string | null> {
    try {
      const account = this.getAccountName(providerId);
      const password = await keytar.getPassword(SERVICE_NAME, account);
      return password;
    } catch (error) {
      logger.debug(`Failed to get API key from keychain: ${error}`);
      return null;
    }
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    try {
      const account = this.getAccountName(providerId);
      await keytar.setPassword(SERVICE_NAME, account, apiKey);
    } catch (error) {
      throw new Error(`Failed to store API key in keychain: ${error}`);
    }
  }

  async deleteApiKey(providerId: string): Promise<void> {
    try {
      const account = this.getAccountName(providerId);
      await keytar.deletePassword(SERVICE_NAME, account);
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
  private useKeychain: boolean = true;
  private keychainTested: boolean = false;

  constructor(config: any) {
    this.keychain = new KeychainStorage();
    this.fallback = new FallbackStorage(config);
  }

  private async ensureKeychainTested(): Promise<void> {
    if (this.keychainTested) return;
    
    try {
      const testKey = '__codeep_test__';
      await keytar.setPassword(SERVICE_NAME, testKey, 'test');
      await keytar.deletePassword(SERVICE_NAME, testKey);
      this.useKeychain = true;
    } catch {
      this.useKeychain = false;
      // Silently fallback - don't warn user
    }
    
    this.keychainTested = true;
  }

  async getApiKey(providerId: string): Promise<string | null> {
    await this.ensureKeychainTested();
    
    if (this.useKeychain) {
      const key = await this.keychain.getApiKey(providerId);
      if (key) return key;
    }
    return this.fallback.getApiKey(providerId);
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
        // Keychain failed, fall back to config
        this.useKeychain = false;
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
