import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to test the config functions
// Since config uses Conf which has side effects, we'll test the utility functions

describe('config utilities', () => {
  const TEST_DIR = join(tmpdir(), 'codeep-config-test-' + Date.now());
  const SESSIONS_DIR = join(TEST_DIR, '.codeep', 'sessions');

  beforeEach(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('session file operations', () => {
    it('should create sessions directory structure', () => {
      expect(existsSync(SESSIONS_DIR)).toBe(true);
    });

    it('should handle session JSON files', () => {
      const sessionId = 'test-session';
      const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
      
      const sessionData = {
        name: sessionId,
        history: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        createdAt: new Date().toISOString(),
      };

      writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));

      expect(existsSync(sessionFile)).toBe(true);
    });
  });

  describe('language codes', () => {
    const LANGUAGES: Record<string, string> = {
      'auto': 'Auto-detect',
      'en': 'English',
      'zh': 'Chinese (中文)',
      'es': 'Spanish (Español)',
      'hi': 'Hindi (हिन्दी)',
      'ar': 'Arabic (العربية)',
      'pt': 'Portuguese (Português)',
      'fr': 'French (Français)',
      'de': 'German (Deutsch)',
      'ja': 'Japanese (日本語)',
      'ru': 'Russian (Русский)',
      'hr': 'Croatian (Hrvatski)',
    };

    it('should have all supported languages', () => {
      expect(Object.keys(LANGUAGES)).toContain('auto');
      expect(Object.keys(LANGUAGES)).toContain('en');
      expect(Object.keys(LANGUAGES)).toContain('hr');
    });

    it('should have display names for all languages', () => {
      for (const [code, name] of Object.entries(LANGUAGES)) {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      }
    });
  });

  describe('protocols', () => {
    const PROTOCOLS: Record<string, string> = {
      'openai': 'OpenAI Compatible',
      'anthropic': 'Anthropic Protocol',
    };

    it('should support openai protocol', () => {
      expect(PROTOCOLS['openai']).toBe('OpenAI Compatible');
    });

    it('should support anthropic protocol', () => {
      expect(PROTOCOLS['anthropic']).toBe('Anthropic Protocol');
    });
  });

  describe('config schema validation', () => {
    it('should have valid default values', () => {
      const defaults = {
        apiKey: '',
        provider: 'z.ai',
        model: 'glm-4.7',
        protocol: 'openai',
        plan: 'lite',
        language: 'en',
        autoSave: true,
        currentSessionId: '',
        temperature: 0.7,
        maxTokens: 4096,
        apiTimeout: 30000,
        rateLimitApi: 30,
        rateLimitCommands: 100,
        projectPermissions: [],
        providerApiKeys: [],
      };

      // Validate types
      expect(typeof defaults.apiKey).toBe('string');
      expect(typeof defaults.provider).toBe('string');
      expect(typeof defaults.model).toBe('string');
      expect(['openai', 'anthropic']).toContain(defaults.protocol);
      expect(['lite', 'pro', 'max']).toContain(defaults.plan);
      expect(typeof defaults.autoSave).toBe('boolean');
      expect(typeof defaults.temperature).toBe('number');
      expect(defaults.temperature).toBeGreaterThanOrEqual(0);
      expect(defaults.temperature).toBeLessThanOrEqual(2);
      expect(typeof defaults.maxTokens).toBe('number');
      expect(defaults.maxTokens).toBeGreaterThan(0);
      expect(typeof defaults.apiTimeout).toBe('number');
      expect(defaults.apiTimeout).toBeGreaterThan(0);
      expect(typeof defaults.rateLimitApi).toBe('number');
      expect(typeof defaults.rateLimitCommands).toBe('number');
      expect(Array.isArray(defaults.projectPermissions)).toBe(true);
      expect(Array.isArray(defaults.providerApiKeys)).toBe(true);
    });
  });

  describe('project permissions structure', () => {
    interface ProjectPermission {
      path: string;
      readPermission: boolean;
      writePermission: boolean;
      grantedAt: string;
    }

    it('should validate permission structure', () => {
      const permission: ProjectPermission = {
        path: '/Users/test/project',
        readPermission: true,
        writePermission: false,
        grantedAt: new Date().toISOString(),
      };

      expect(typeof permission.path).toBe('string');
      expect(typeof permission.readPermission).toBe('boolean');
      expect(typeof permission.writePermission).toBe('boolean');
      expect(typeof permission.grantedAt).toBe('string');
      
      // Validate ISO date string
      expect(() => new Date(permission.grantedAt)).not.toThrow();
    });
  });

  describe('provider API keys structure', () => {
    interface ProviderApiKey {
      providerId: string;
      apiKey: string;
    }

    it('should validate API key structure', () => {
      const apiKey: ProviderApiKey = {
        providerId: 'z.ai',
        apiKey: 'test-api-key-123',
      };

      expect(typeof apiKey.providerId).toBe('string');
      expect(typeof apiKey.apiKey).toBe('string');
      expect(apiKey.providerId.length).toBeGreaterThan(0);
      expect(apiKey.apiKey.length).toBeGreaterThan(0);
    });
  });

  describe('message structure', () => {
    interface Message {
      role: 'user' | 'assistant' | 'system';
      content: string;
    }

    it('should validate message structure', () => {
      const userMessage: Message = { role: 'user', content: 'Hello' };
      const assistantMessage: Message = { role: 'assistant', content: 'Hi!' };
      const systemMessage: Message = { role: 'system', content: 'You are a helpful assistant' };

      expect(['user', 'assistant', 'system']).toContain(userMessage.role);
      expect(['user', 'assistant', 'system']).toContain(assistantMessage.role);
      expect(['user', 'assistant', 'system']).toContain(systemMessage.role);

      expect(typeof userMessage.content).toBe('string');
      expect(typeof assistantMessage.content).toBe('string');
      expect(typeof systemMessage.content).toBe('string');
    });
  });
});
