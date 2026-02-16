import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  getProvider,
  getProviderList,
  getProviderModels,
  getProviderBaseUrl,
  getProviderAuthHeader,
  getProviderMcpEndpoints,
} from './providers';

describe('providers', () => {
  describe('PROVIDERS constant', () => {
    it('should have z.ai provider', () => {
      expect(PROVIDERS['z.ai']).toBeDefined();
      expect(PROVIDERS['z.ai'].name).toBe('Z.AI (ZhipuAI)');
    });

    it('should have z.ai-cn provider', () => {
      expect(PROVIDERS['z.ai-cn']).toBeDefined();
      expect(PROVIDERS['z.ai-cn'].name).toBe('Z.AI China (ZhipuAI)');
    });

    it('should have minimax provider', () => {
      expect(PROVIDERS['minimax']).toBeDefined();
      expect(PROVIDERS['minimax'].name).toBe('MiniMax');
    });

    it('should have valid structure for all providers', () => {
      for (const [id, provider] of Object.entries(PROVIDERS)) {
        expect(provider.name).toBeDefined();
        expect(typeof provider.name).toBe('string');
        expect(provider.description).toBeDefined();
        expect(provider.protocols).toBeDefined();
        expect(provider.models).toBeDefined();
        expect(Array.isArray(provider.models)).toBe(true);
        expect(provider.models.length).toBeGreaterThan(0);
        expect(provider.defaultModel).toBeDefined();
        expect(provider.defaultProtocol).toBeDefined();
        expect(['openai', 'anthropic']).toContain(provider.defaultProtocol);
      }
    });

    it('should have valid model structure', () => {
      for (const provider of Object.values(PROVIDERS)) {
        for (const model of provider.models) {
          expect(model.id).toBeDefined();
          expect(typeof model.id).toBe('string');
          expect(model.name).toBeDefined();
          expect(typeof model.name).toBe('string');
          expect(model.description).toBeDefined();
          expect(typeof model.description).toBe('string');
        }
      }
    });

    it('should have default model in models list', () => {
      for (const provider of Object.values(PROVIDERS)) {
        const modelIds = provider.models.map(m => m.id);
        expect(modelIds).toContain(provider.defaultModel);
      }
    });
  });

  describe('getProvider', () => {
    it('should return provider config for valid id', () => {
      const provider = getProvider('z.ai');
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe('Z.AI (ZhipuAI)');
    });

    it('should return null for invalid id', () => {
      expect(getProvider('nonexistent')).toBeNull();
      expect(getProvider('')).toBeNull();
    });
  });

  describe('getProviderList', () => {
    it('should return list of providers', () => {
      const list = getProviderList();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    });

    it('should include id, name, and description', () => {
      const list = getProviderList();
      for (const item of list) {
        expect(item.id).toBeDefined();
        expect(item.name).toBeDefined();
        expect(item.description).toBeDefined();
      }
    });

    it('should include z.ai, z.ai-cn, and minimax', () => {
      const list = getProviderList();
      const ids = list.map(p => p.id);
      expect(ids).toContain('z.ai');
      expect(ids).toContain('z.ai-cn');
      expect(ids).toContain('minimax');
    });
  });

  describe('getProviderModels', () => {
    it('should return models for valid provider', () => {
      const models = getProviderModels('z.ai');
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should return empty array for invalid provider', () => {
      const models = getProviderModels('nonexistent');
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(0);
    });

    it('should include glm-4.7 for z.ai', () => {
      const models = getProviderModels('z.ai');
      const ids = models.map(m => m.id);
      expect(ids).toContain('glm-4.7');
    });
  });

  describe('getProviderBaseUrl', () => {
    it('should return base URL for valid provider and protocol', () => {
      const url = getProviderBaseUrl('z.ai', 'openai');
      expect(url).not.toBeNull();
      expect(url).toContain('api.z.ai');
    });

    it('should return different URLs for different protocols', () => {
      const openaiUrl = getProviderBaseUrl('z.ai', 'openai');
      const anthropicUrl = getProviderBaseUrl('z.ai', 'anthropic');
      expect(openaiUrl).not.toBe(anthropicUrl);
    });

    it('should return null for invalid provider', () => {
      expect(getProviderBaseUrl('nonexistent', 'openai')).toBeNull();
    });
  });

  describe('getProviderAuthHeader', () => {
    it('should return auth header for valid provider', () => {
      const header = getProviderAuthHeader('z.ai', 'openai');
      expect(['Bearer', 'x-api-key']).toContain(header);
    });

    it('should return Bearer as default for invalid provider', () => {
      expect(getProviderAuthHeader('nonexistent', 'openai')).toBe('Bearer');
    });

    it('should return correct header for each protocol', () => {
      // z.ai uses Bearer for openai and x-api-key for anthropic
      expect(getProviderAuthHeader('z.ai', 'openai')).toBe('Bearer');
      expect(getProviderAuthHeader('z.ai', 'anthropic')).toBe('x-api-key');
    });
  });

  describe('environment variable keys', () => {
    it('should have env key for z.ai', () => {
      expect(PROVIDERS['z.ai'].envKey).toBe('ZAI_API_KEY');
    });

    it('should have env key for z.ai-cn', () => {
      expect(PROVIDERS['z.ai-cn'].envKey).toBe('ZAI_CN_API_KEY');
    });

    it('should have env key for minimax', () => {
      expect(PROVIDERS['minimax'].envKey).toBe('MINIMAX_API_KEY');
    });
  });

  describe('MCP endpoints', () => {
    it('should have MCP endpoints for z.ai', () => {
      const endpoints = getProviderMcpEndpoints('z.ai');
      expect(endpoints).not.toBeNull();
      expect(endpoints!.webSearch).toContain('api.z.ai');
      expect(endpoints!.webReader).toContain('api.z.ai');
      expect(endpoints!.zread).toContain('api.z.ai');
    });

    it('should have MCP endpoints for z.ai-cn', () => {
      const endpoints = getProviderMcpEndpoints('z.ai-cn');
      expect(endpoints).not.toBeNull();
      expect(endpoints!.webSearch).toContain('open.bigmodel.cn');
      expect(endpoints!.webReader).toContain('open.bigmodel.cn');
      expect(endpoints!.zread).toContain('open.bigmodel.cn');
    });

    it('should return null for providers without MCP endpoints', () => {
      expect(getProviderMcpEndpoints('minimax')).toBeNull();
      expect(getProviderMcpEndpoints('deepseek')).toBeNull();
      expect(getProviderMcpEndpoints('nonexistent')).toBeNull();
    });
  });
});
