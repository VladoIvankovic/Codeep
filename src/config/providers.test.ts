import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  getProvider,
  getProviderList,
  getProviderModels,
  getProviderBaseUrl,
  getProviderAuthHeader,
  getProviderMcpEndpoints,
  modelRejectsSamplingParams,
  canonicalModelId,
  modelSupportsReasoningEffort,
  reasoningParamsFor,
  availableReasoningTiers,
  resolveReasoningTier,
  providerNoStreamWithTools,
  REASONING_TIERS,
} from './providers';
import { getModelContextWindow } from '../utils/tokenTracker';

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
        // Dynamic providers (e.g. Custom OpenAI-compatible) fetch their
        // catalog at runtime and may ship no static models.
        if (!(provider.dynamicModels && provider.models.length === 0)) {
          expect(provider.models.length).toBeGreaterThan(0);
        }
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
        // Dynamic providers with no static catalog (Custom OpenAI-compatible)
        // resolve the model at runtime, so an empty list + blank default is valid.
        if (provider.dynamicModels && provider.models.length === 0) continue;
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

    it('should include z.ai, z.ai-cn, minimax, minimax-cn, and anthropic', () => {
      const list = getProviderList();
      const ids = list.map(p => p.id);
      expect(ids).toContain('z.ai');
      expect(ids).toContain('z.ai-cn');
      expect(ids).toContain('minimax');
      expect(ids).toContain('minimax-cn');
      expect(ids).toContain('anthropic');
      expect(ids).toContain('google');
    });

    // Lock in DISPLAY_ORDER so OpenRouter (a 2.0.0 headline feature) doesn't
    // silently drift down the list during a future refactor.
    it('should put the headline providers at the top in display order', () => {
      const ids = getProviderList().map(p => p.id);
      expect(ids[0]).toBe('anthropic');
      expect(ids[1]).toBe('openai');
      expect(ids[2]).toBe('openrouter');
      expect(ids[3]).toBe('z.ai');
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

    it('should include glm-5.2 for z.ai', () => {
      const models = getProviderModels('z.ai');
      const ids = models.map(m => m.id);
      expect(ids).toContain('glm-5.2');
      expect(ids).toContain('glm-5-turbo');
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

    it('should have env key for minimax-cn', () => {
      expect(PROVIDERS['minimax-cn'].envKey).toBe('MINIMAX_CN_API_KEY');
    });

    it('should have env key for anthropic', () => {
      expect(PROVIDERS['anthropic'].envKey).toBe('ANTHROPIC_API_KEY');
    });

    it('should have env key for google', () => {
      const provider = getProvider('google');
      expect(provider!.envKey).toBe('GOOGLE_API_KEY');
    });
  });

  describe('minimax-cn provider', () => {
    it('should have correct name and endpoints', () => {
      expect(PROVIDERS['minimax-cn']).toBeDefined();
      expect(PROVIDERS['minimax-cn'].name).toBe('MiniMax China');
      expect(getProviderBaseUrl('minimax-cn', 'openai')).toContain('api.minimaxi.com');
      expect(getProviderBaseUrl('minimax-cn', 'anthropic')).toContain('api.minimaxi.com');
    });
  });

  describe('anthropic provider', () => {
    it('should include Claude Opus 4.8 as default model', () => {
      expect(PROVIDERS['anthropic'].defaultModel).toBe('claude-opus-4-8');
      const modelIds = PROVIDERS['anthropic'].models.map(m => m.id);
      expect(modelIds).toContain('claude-opus-4-8');
      expect(modelIds).toContain('claude-sonnet-5');
      expect(modelIds).toContain('claude-haiku-4-5-20251001');
      // Fable 5 is re-listed (available again) — Anthropic's most capable model.
      expect(modelIds).toContain('claude-fable-5');
      expect(modelIds).not.toContain('claude-opus-4-7');
      expect(modelIds).not.toContain('claude-opus-4-6');
    });

    it('flags models that reject sampling params (Fable 5 / Opus 4.7+)', () => {
      expect(modelRejectsSamplingParams('claude-fable-5')).toBe(true);
      expect(modelRejectsSamplingParams('claude-opus-4-8')).toBe(true);
      expect(modelRejectsSamplingParams('claude-opus-4-7')).toBe(true);
      // Dated variants of a flagged family are covered too
      expect(modelRejectsSamplingParams('claude-opus-4-8-20260601')).toBe(true);
      // Older/other Claude models still accept temperature
      expect(modelRejectsSamplingParams('claude-opus-4-6')).toBe(false);
      expect(modelRejectsSamplingParams('claude-sonnet-4-6')).toBe(false);
      expect(modelRejectsSamplingParams('claude-haiku-4-5-20251001')).toBe(false);
      // Non-Anthropic ids never match
      expect(modelRejectsSamplingParams('gpt-5.5')).toBe(false);
      expect(modelRejectsSamplingParams('glm-5.1')).toBe(false);
    });
  });

  describe('deepseek provider', () => {
    it('should include DeepSeek V4 models and not include legacy ones', () => {
      const provider = getProvider('deepseek');
      expect(provider).not.toBeNull();
      expect(provider!.defaultModel).toBe('deepseek-v4-pro');
      const modelIds = provider!.models.map(m => m.id);
      expect(modelIds).toContain('deepseek-v4-pro');
      expect(modelIds).toContain('deepseek-v4-flash');
      expect(modelIds).not.toContain('deepseek-chat');
      expect(modelIds).not.toContain('deepseek-reasoner');
    });
  });

  describe('openai provider', () => {
    it('should include the GPT-5.6 family with gpt-5.6-sol as default', () => {
      const provider = getProvider('openai');
      expect(provider).not.toBeNull();
      expect(provider!.defaultModel).toBe('gpt-5.6-sol');
      const modelIds = provider!.models.map(m => m.id);
      expect(modelIds).toContain('gpt-5.6-sol');
      expect(modelIds).toContain('gpt-5.6-terra');
      expect(modelIds).toContain('gpt-5.6-luna');
      // Previous generation stays available in the picker.
      expect(modelIds).toContain('gpt-5.5');
      expect(modelIds).toContain('gpt-5.4');
    });
  });

  describe('newly added models (this release)', () => {
    it('lists Grok 4.5 (flagship reasoning) under grok', () => {
      expect(getProvider('grok')!.models.map(m => m.id)).toContain('grok-4.5');
      // Grok 4.5 is a reasoning model → graded effort supported.
      expect(modelSupportsReasoningEffort('grok', 'grok-4.5')).toBe(true);
    });
    it('lists Gemini 3.1 Flash-Lite under google', () => {
      expect(getProvider('google')!.models.map(m => m.id)).toContain('gemini-3.1-flash-lite');
      expect(modelSupportsReasoningEffort('google', 'gemini-3.1-flash-lite')).toBe(true);
    });
    it('replaces qwen3-max with qwen3.7-max across every Qwen variant', () => {
      for (const id of ['qwen', 'qwen-api', 'qwen-cn', 'qwen-cn-api']) {
        const ids = getProvider(id)!.models.map(m => m.id);
        expect(ids).toContain('qwen3.7-max');
        expect(ids).not.toContain('qwen3-max');
      }
    });
    it('prices and sizes the new models (pricing/context lockstep holds)', () => {
      for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'grok-4.5', 'gemini-3.1-flash-lite', 'qwen3.7-max']) {
        expect(getModelContextWindow(id)).not.toBe(128_000); // 128k is the unknown-fallback
      }
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

  describe('google provider', () => {
    it('should include google provider with correct config', () => {
      const provider = getProvider('google');
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe('Google AI');
      expect(provider!.description).toBe('Gemini models');
      expect(provider!.defaultProtocol).toBe('openai');
      expect(provider!.defaultModel).toBe('gemini-3.1-pro-preview');
      expect(provider!.protocols.openai?.baseUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai'
      );
      expect(provider!.protocols.openai?.authHeader).toBe('Bearer');
      expect(provider!.protocols.openai?.supportsNativeTools).toBe(true);
      expect(provider!.protocols.anthropic).toBeUndefined();
      expect(provider!.envKey).toBe('GOOGLE_API_KEY');
      expect(provider!.subscribeUrl).toBe('https://aistudio.google.com/apikey');
      const modelIds = provider!.models.map(m => m.id);
      expect(modelIds).toContain('gemini-3.1-pro-preview');
      expect(modelIds).toContain('gemini-3.5-flash');
    });
  });

  describe('canonicalModelId', () => {
    it('lowercases, strips vendor/ prefix, and normalizes dots to dashes', () => {
      expect(canonicalModelId('Claude-Opus-4.8')).toBe('claude-opus-4-8');
      expect(canonicalModelId('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8');
      expect(canonicalModelId('glm-5.2')).toBe('glm-5-2');
      expect(canonicalModelId('GPT-5.5')).toBe('gpt-5-5');
    });
  });

  describe('modelSupportsReasoningEffort', () => {
    it('supports capable Anthropic models, not Haiku or Sonnet 4.5', () => {
      expect(modelSupportsReasoningEffort('anthropic', 'claude-opus-4-8')).toBe(true);
      expect(modelSupportsReasoningEffort('anthropic', 'claude-sonnet-4-6')).toBe(true);
      expect(modelSupportsReasoningEffort('anthropic', 'claude-haiku-4-5-20251001')).toBe(false);
      expect(modelSupportsReasoningEffort('anthropic', 'claude-sonnet-4-5')).toBe(false);
    });
    it('supports GPT-5.x, Gemini 3, DeepSeek V4', () => {
      expect(modelSupportsReasoningEffort('openai', 'gpt-5.5')).toBe(true);
      expect(modelSupportsReasoningEffort('openai', 'gpt-5.4-mini')).toBe(true);
      expect(modelSupportsReasoningEffort('google', 'gemini-3.1-pro-preview')).toBe(true);
      expect(modelSupportsReasoningEffort('deepseek', 'deepseek-v4-pro')).toBe(true);
    });
    it('supports GLM-5.2 but not glm-5-turbo (toggle only)', () => {
      expect(modelSupportsReasoningEffort('z.ai', 'glm-5.2')).toBe(true);
      expect(modelSupportsReasoningEffort('z.ai-cn', 'glm-5.2')).toBe(true);
      expect(modelSupportsReasoningEffort('z.ai', 'glm-5-turbo')).toBe(false);
    });
    it('treats OpenRouter as always supported (unified, silently ignored)', () => {
      expect(modelSupportsReasoningEffort('openrouter', 'anthropic/claude-opus-4')).toBe(true);
    });
    it('returns false for minimax, ollama, custom', () => {
      expect(modelSupportsReasoningEffort('minimax', 'MiniMax-M3')).toBe(false);
      expect(modelSupportsReasoningEffort('ollama', 'llama3.2')).toBe(false);
      expect(modelSupportsReasoningEffort('custom', 'anything')).toBe(false);
    });
  });

  describe('reasoningParamsFor', () => {
    it('returns {} for auto or unsupported models', () => {
      expect(reasoningParamsFor('anthropic', 'claude-opus-4-8', 'auto')).toEqual({});
      expect(reasoningParamsFor('anthropic', 'claude-haiku-4-5-20251001', 'high')).toEqual({});
      expect(reasoningParamsFor('ollama', 'llama3.2', 'max')).toEqual({});
    });
    it('returns {} (never effort:undefined) for a garbage/legacy tier value', () => {
      // Simulates an old config string that isn't one of the 5 tiers.
      expect(reasoningParamsFor('anthropic', 'claude-opus-4-8', 'ultra' as never)).toEqual({});
      expect(reasoningParamsFor('openai', 'gpt-5.5', undefined as never)).toEqual({});
    });
    it('Anthropic → output_config.effort, passed through 1:1', () => {
      expect(reasoningParamsFor('anthropic', 'claude-opus-4-8', 'low')).toEqual({ output_config: { effort: 'low' } });
      expect(reasoningParamsFor('anthropic', 'claude-opus-4-8', 'max')).toEqual({ output_config: { effort: 'max' } });
    });
    it('OpenAI → reasoning_effort, max maps to xhigh (no native max)', () => {
      expect(reasoningParamsFor('openai', 'gpt-5.5', 'medium')).toEqual({ reasoning_effort: 'medium' });
      expect(reasoningParamsFor('openai', 'gpt-5.5', 'max')).toEqual({ reasoning_effort: 'xhigh' });
    });
    it('Gemini → reasoning_effort clamped to low/high (never medium → would 400)', () => {
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'medium')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'max')).toEqual({ reasoning_effort: 'high' });
    });
    it('DeepSeek / GLM-5.2 → reasoning_effort high|max', () => {
      expect(reasoningParamsFor('deepseek', 'deepseek-v4-pro', 'low')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('deepseek', 'deepseek-v4-pro', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('z.ai', 'glm-5.2', 'high')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('z.ai', 'glm-5.2', 'max')).toEqual({ reasoning_effort: 'max' });
    });
    it('OpenRouter → reasoning.effort, max capped at high', () => {
      expect(reasoningParamsFor('openrouter', 'openai/gpt-5.5', 'medium')).toEqual({ reasoning: { effort: 'medium' } });
      expect(reasoningParamsFor('openrouter', 'openai/gpt-5.5', 'max')).toEqual({ reasoning: { effort: 'high' } });
    });
    it('never emits a value Gemini/OpenAI reject across all tiers', () => {
      for (const tier of REASONING_TIERS) {
        const g = reasoningParamsFor('google', 'gemini-3.5-flash', tier) as { reasoning_effort?: string };
        if (g.reasoning_effort) expect(['low', 'high']).toContain(g.reasoning_effort);
        const o = reasoningParamsFor('openai', 'gpt-5.5', tier) as { reasoning_effort?: string };
        if (o.reasoning_effort) expect(['none', 'low', 'medium', 'high', 'xhigh']).toContain(o.reasoning_effort);
      }
    });
  });

  describe('availableReasoningTiers', () => {
    it('lists only the levels each model distinguishes', () => {
      expect(availableReasoningTiers('anthropic', 'claude-opus-4-8')).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      expect(availableReasoningTiers('openai', 'gpt-5.5')).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      expect(availableReasoningTiers('google', 'gemini-3.1-pro-preview')).toEqual(['auto', 'low', 'high']);
      expect(availableReasoningTiers('z.ai', 'glm-5.2')).toEqual(['auto', 'high', 'max']);
      expect(availableReasoningTiers('deepseek', 'deepseek-v4-pro')).toEqual(['auto', 'high', 'max']);
      expect(availableReasoningTiers('openrouter', 'openai/gpt-5.5')).toEqual(['auto', 'low', 'medium', 'high']);
    });
    it('returns [] for unsupported models', () => {
      expect(availableReasoningTiers('anthropic', 'claude-haiku-4-5-20251001')).toEqual([]);
      expect(availableReasoningTiers('ollama', 'llama3.2')).toEqual([]);
    });
    it('drift guard — every listed non-auto tier yields a DISTINCT param', () => {
      const cases = [
        ['anthropic', 'claude-opus-4-8'], ['openai', 'gpt-5.5'],
        ['google', 'gemini-3.1-pro-preview'], ['z.ai', 'glm-5.2'],
        ['deepseek', 'deepseek-v4-pro'], ['openrouter', 'openai/gpt-5.5'],
        ['grok', 'grok-4.3'],
      ];
      for (const [pid, model] of cases) {
        const tiers = availableReasoningTiers(pid, model).filter(t => t !== 'auto');
        const params = tiers.map(t => JSON.stringify(reasoningParamsFor(pid, model, t)));
        expect(new Set(params).size).toBe(params.length); // all distinct
        for (const p of params) expect(p).not.toBe('{}'); // and none a no-op
      }
    });
  });

  describe('new providers — Kimi / Grok / Qwen', () => {
    it('registers the subscription + pay-per-use + CN variants', () => {
      for (const id of ['kimi', 'kimi-api', 'kimi-cn', 'grok', 'qwen', 'qwen-api', 'qwen-cn', 'qwen-cn-api', 'modelscope']) {
        expect(PROVIDERS[id], id).toBeDefined();
      }
    });
    it('Kimi Code subscription uses the coding base URL + kimi-for-coding alias', () => {
      expect(PROVIDERS['kimi'].protocols.openai?.baseUrl).toBe('https://api.kimi.com/coding/v1');
      expect(PROVIDERS['kimi'].defaultModel).toBe('kimi-for-coding');
      expect(PROVIDERS['kimi-api'].protocols.openai?.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(PROVIDERS['kimi-api'].defaultModel).toBe('kimi-k2.7-code');
    });
    it('Qwen Coding Plan vs pay-per-use base URLs (mirrors z.ai pattern)', () => {
      expect(PROVIDERS['qwen'].protocols.openai?.baseUrl).toBe('https://coding-intl.dashscope.aliyuncs.com/v1');
      expect(PROVIDERS['qwen-api'].protocols.openai?.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
      expect(PROVIDERS['qwen'].defaultModel).toBe('qwen3-coder-plus');
    });
    it('Grok uses api.x.ai + max_completion_tokens (reasoning models)', () => {
      expect(PROVIDERS['grok'].protocols.openai?.baseUrl).toBe('https://api.x.ai/v1');
      expect(PROVIDERS['grok'].defaultModel).toBe('grok-build-0.1');
      expect(PROVIDERS['grok'].useMaxCompletionTokens).toBe(true);
    });
    it('Qwen + ModelScope set noStreamWithTools; others do not', () => {
      expect(providerNoStreamWithTools('qwen')).toBe(true);
      expect(providerNoStreamWithTools('qwen-api')).toBe(true);
      expect(providerNoStreamWithTools('modelscope')).toBe(true);
      expect(providerNoStreamWithTools('grok')).toBe(false);
      expect(providerNoStreamWithTools('kimi')).toBe(false);
      expect(providerNoStreamWithTools('openai')).toBe(false);
    });
    it('Kimi coding models reject custom sampling params (fixed temperature)', () => {
      expect(modelRejectsSamplingParams('kimi-k2.7-code')).toBe(true);
      expect(modelRejectsSamplingParams('kimi-for-coding')).toBe(true);
      expect(modelRejectsSamplingParams('kimi-k2.5')).toBe(false);
    });
    it('Grok supports graded reasoning_effort; Kimi/Qwen-coders do not', () => {
      expect(modelSupportsReasoningEffort('grok', 'grok-4.3')).toBe(true);
      // Coders (grok-build, grok-code-fast) are non-reasoning — reasoning_effort
      // 400s on them, which would silently drop the turn into the text-tool fallback.
      expect(modelSupportsReasoningEffort('grok', 'grok-build-0.1')).toBe(false);
      expect(modelSupportsReasoningEffort('grok', 'grok-code-fast-1')).toBe(false);
      expect(modelSupportsReasoningEffort('grok', 'grok-4-fast-non-reasoning')).toBe(false);
      expect(modelSupportsReasoningEffort('kimi', 'kimi-for-coding')).toBe(false);
      expect(modelSupportsReasoningEffort('qwen', 'qwen3-coder-plus')).toBe(false);
    });
    it('Grok reasoning_effort: none/low/medium/high, Max → high', () => {
      expect(reasoningParamsFor('grok', 'grok-4.3', 'medium')).toEqual({ reasoning_effort: 'medium' });
      expect(reasoningParamsFor('grok', 'grok-4.3', 'max')).toEqual({ reasoning_effort: 'high' });
      expect(availableReasoningTiers('grok', 'grok-4.3')).toEqual(['auto', 'low', 'medium', 'high']);
    });
  });

  describe('resolveReasoningTier', () => {
    it('passes through tiers the model distinguishes', () => {
      expect(resolveReasoningTier('anthropic', 'claude-opus-4-8', 'low')).toBe('low');
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'max')).toBe('max');
    });
    it('collapses out-of-range tiers to the level the model actually runs', () => {
      // GLM-5.2 grades only high|max — low/medium run as high.
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'low')).toBe('high');
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'medium')).toBe('high');
      // Gemini (OpenAI-compat) has only low|high — medium/max run as high.
      expect(resolveReasoningTier('google', 'gemini-3.1-pro-preview', 'medium')).toBe('high');
      expect(resolveReasoningTier('google', 'gemini-3.1-pro-preview', 'max')).toBe('high');
    });
    it('returns auto for auto or unsupported models', () => {
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'auto')).toBe('auto');
      expect(resolveReasoningTier('ollama', 'llama3.2', 'max')).toBe('auto');
    });
  });
});

