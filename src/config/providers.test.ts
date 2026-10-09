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
  replacementModelFor,
  retiredModelReplacements,
  toolsForceReasoningOff,
  agentTurnReasoningNote,
  minResponseTokensFor,
  isDynamicModelsProvider,
  isFlatFeeProvider,
  REASONING_TIERS,
} from './providers';
import { getModelContextWindow, getPricingTable } from '../utils/tokenTracker';

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
      for (const [, provider] of Object.entries(PROVIDERS)) {
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

    // The GLM Coding Plan accepts exactly these two; 5.2 is routed to 5.3 and
    // Turbo is off the plan (billed outside the quota, invisible in /cost).
    it('offers exactly the two models the GLM Coding Plan accepts', () => {
      const ids = getProviderModels('z.ai').map(m => m.id);
      expect(ids).toEqual(['glm-5.3', 'glm-5.3-flash']);
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
    it('should include Claude Opus 5.5 as default model, and keep Opus 5', () => {
      // Anthropic: "start with Claude Opus 5.5 for most workloads".
      expect(PROVIDERS['anthropic'].defaultModel).toBe('claude-opus-5-5');
      const modelIds = PROVIDERS['anthropic'].models.map(m => m.id);
      expect(modelIds).toContain('claude-opus-5-5');
      // Legacy, not retired — pinned configs keep it.
      expect(modelIds).toContain('claude-opus-5');
      expect(modelIds).toContain('claude-sonnet-5');
      expect(modelIds).toContain('claude-haiku-4-5-20251001');
      // Fable 5.1 supersedes Fable 5, which Anthropic now lists as legacy.
      // Offering the superseded one would quietly pick a worse model at the
      // same price — both are $10/$50.
      // Fable 5 is re-listed (available again) — Anthropic's most capable model.
      expect(modelIds).toContain('claude-fable-5-1');
      // Kept, not replaced. Dropping an id does not leave a pinned config on
      // the older model — the lookup fails and the user lands on another
      // provider's default, which is how the macOS app moved a pinned Fable 5
      // to gpt-5.6-sol. Ids are added; they are not removed.
      expect(modelIds).toContain('claude-fable-5');
      expect(modelIds).not.toContain('claude-opus-4-7');
      expect(modelIds).not.toContain('claude-opus-4-6');
    });

    it('flags models that reject sampling params (Fable 5 / Opus 4.7+)', () => {
      expect(modelRejectsSamplingParams('claude-fable-5')).toBe(true);
      expect(modelRejectsSamplingParams('claude-opus-5')).toBe(true);
      expect(modelRejectsSamplingParams('claude-opus-5-5')).toBe(true);
      expect(modelRejectsSamplingParams('anthropic/claude-opus-5.5')).toBe(true);
      expect(modelRejectsSamplingParams('claude-opus-4-7')).toBe(true);
      // Dated variants of a flagged family are covered too
      expect(modelRejectsSamplingParams('claude-opus-5-20260601')).toBe(true);
      // Older/other Claude models still accept temperature
      expect(modelRejectsSamplingParams('claude-opus-4-6')).toBe(false);
      expect(modelRejectsSamplingParams('claude-sonnet-4-6')).toBe(false);
      expect(modelRejectsSamplingParams('claude-haiku-4-5-20251001')).toBe(false);
      // Non-Anthropic ids never match
      expect(modelRejectsSamplingParams('gpt-5.5')).toBe(false);
      expect(modelRejectsSamplingParams('glm-5.1')).toBe(false);
    });
  });

  describe('September 2026 models', () => {
    // Agent turns go over the Responses API since the live run of 2026-09-26,
    // where GPT-6 reasons and calls tools together — Astra included, which
    // cannot call tools on Chat Completions at all.
    it('offers every GPT-6 model, with GPT-6.1 Sol the default', () => {
      const provider = getProvider('openai')!;
      const ids = provider.models.map(m => m.id);
      expect(ids).toContain('gpt-6-astra');
      expect(ids).toContain('gpt-6.1-sol');
      expect(ids).toContain('gpt-6-sol');
      expect(ids).toContain('gpt-6-luna');
      expect(provider.defaultModel).toBe('gpt-6.1-sol');
      // "Reasoning off" was the Chat Completions rule; the picker no longer
      // says it of every agent turn (/thinking says it where it still holds).
      for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
        expect(provider.models.find(m => m.id === id)!.description, id).not.toMatch(/reasoning off/);
      }
      // Through a proxy Astra's agent turns stay on Chat Completions, where it
      // has no tool calls; the picker says so.
      expect(provider.models.find(m => m.id === 'gpt-6-astra')!.description).toMatch(/Responses API only/);
    });

    // The migration runs on every load: an entry for an offered id would move
    // anyone who picks Astra straight back to Sol at the next launch.
    it('no longer moves a stored Astra anywhere, on openai or OpenRouter', () => {
      expect(replacementModelFor('openai', 'gpt-6-astra')).toBeUndefined();
      expect(replacementModelFor('openrouter', 'openai/gpt-6-astra')).toBeUndefined();
      expect(getProvider('openrouter')!.models.map(m => m.id)).toContain('openai/gpt-6-astra');
    });

    it('gives GPT-6 the thinking control, which a gpt-5 prefix would have missed', () => {
      expect(modelSupportsReasoningEffort('openai', 'gpt-6-sol')).toBe(true);
      expect(modelSupportsReasoningEffort('openai', 'gpt-6-luna')).toBe(true);
      expect(modelSupportsReasoningEffort('openai', 'gpt-6-astra')).toBe(true);
      expect(modelSupportsReasoningEffort('openai', 'gpt-5.6-sol')).toBe(true);
      // GPT-4 and earlier are not reasoning models and must not be offered it.
      expect(modelSupportsReasoningEffort('openai', 'gpt-4o')).toBe(false);
    });

    it('offers Gemini 3.8 Flash and knows it rejects sampling params', () => {
      const ids = getProvider('google')!.models.map(m => m.id);
      expect(ids).toContain('gemini-3.8-flash');
      expect(ids).toContain('gemini-3.7-flash');
      // Google removed the sampling parameters in the 3.7 generation and 3.8 is
      // built on 3.7 — sending temperature is a 400 on every call.
      expect(modelRejectsSamplingParams('gemini-3.8-flash')).toBe(true);
      // Namespaced the way OpenRouter routes it.
      expect(modelRejectsSamplingParams('google/gemini-3.8-flash')).toBe(true);
      expect(modelRejectsSamplingParams('gemini-3.5-flash')).toBe(false);
    });
  });

  describe('deepseek provider', () => {
    it('offers V4.1 Flash as the default, and V4 Pro again', () => {
      const provider = getProvider('deepseek');
      expect(provider).not.toBeNull();
      expect(provider!.defaultModel).toBe('deepseek-flash');
      const modelIds = provider!.models.map(m => m.id);
      // DeepSeek cancelled the V4 Pro → Flash routing before 2026-09-14; Pro
      // is live and billed separately. V4 Flash is retired and served by V4.1.
      expect(modelIds).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
      expect(modelIds).not.toContain('deepseek-v4-flash');
      expect(modelIds).not.toContain('deepseek-chat');
      expect(modelIds).not.toContain('deepseek-reasoner');
    });

    /// `deepseek-flash` does not start with `deepseek-v4`. The prefix check
    /// alone would ship the default model with /thinking hidden.
    it('gives V4.1 Flash the thinking control, with its low tier', () => {
      expect(modelSupportsReasoningEffort('deepseek', 'deepseek-flash')).toBe(true);
      expect(availableReasoningTiers('deepseek', 'deepseek-flash')).toEqual(['auto', 'low', 'high', 'max']);
      expect(reasoningParamsFor('deepseek', 'deepseek-flash', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('deepseek', 'deepseek-flash', 'medium')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('deepseek', 'deepseek-flash', 'max')).toEqual({ reasoning_effort: 'max' });
    });

    // "The thinking modes of V4-Pro and V4-Flash now support three thinking
    // effort levels: low / high / max" (changelog 2026-08-13). Low used to
    // collapse to high on Pro.
    it('grades V4 Pro low / high / max as well', () => {
      expect(availableReasoningTiers('deepseek', 'deepseek-v4-pro')).toEqual(['auto', 'low', 'high', 'max']);
      expect(reasoningParamsFor('deepseek', 'deepseek-v4-pro', 'low')).toEqual({ reasoning_effort: 'low' });
    });

    it('migrates the retired V4 Flash ids, and no longer V4 Pro', () => {
      expect(replacementModelFor('deepseek', 'deepseek-v4-flash')).toBe('deepseek-flash');
      expect(replacementModelFor('deepseek', 'deepseek-v4-flash-vision-exp')).toBe('deepseek-flash');
      expect(replacementModelFor('deepseek', 'deepseek-v4-pro')).toBeUndefined();
      // A current id has no replacement: the function answers only for retired ones.
      expect(replacementModelFor('deepseek', 'deepseek-flash')).toBeUndefined();
    });
  });

  describe('OpenRouter fallback list', () => {
    const ids = () => getProvider('openrouter')!.models.map(m => m.id);

    /// Picking an id from this list before the live catalogue loads sends it
    /// straight to OpenRouter, so every entry must be one OpenRouter has.
    it('does not offer a Qwen id OpenRouter does not carry', () => {
      expect(ids()).not.toContain('qwen/qwen3.8-max');
      expect(ids()).toContain('qwen/qwen3.8-max-0902');
    });

    it('carries the current DeepSeek, and the models added in 3.2.0', () => {
      expect(ids()).toContain('deepseek/deepseek-v4.1-flash');
      // The GA V4 Pro. The undated id is the April 0423 preview, which only
      // third parties serve.
      expect(ids()).toContain('deepseek/deepseek-v4-pro-0813');
      expect(ids()).not.toContain('deepseek/deepseek-v4-pro');
      expect(ids()).toContain('openai/gpt-6-astra');
      expect(ids()).toContain('google/gemini-3.8-flash');
    });

    it('uses the dotted Anthropic ids OpenRouter lists, and carries the 2026-09-22 models', () => {
      expect(ids()).toContain('anthropic/claude-fable-5.1');
      expect(ids()).not.toContain('anthropic/claude-fable-5-1');
      expect(ids()).toContain('anthropic/claude-opus-5.5');
      expect(ids()).toContain('openai/gpt-6-sol');
      expect(ids()).toContain('openai/gpt-6-luna');
    });
  });

  // GPT-6.1 Sol (2026-09-30, models/gpt-6.1-sol): $2/$10, efforts low, medium
  // (default), high, xhigh and max — "The none and minimal reasoning efforts
  // are not supported" — and "Use the Responses API for tool calling". The
  // owner made it the OpenAI default; GPT-6 Sol stays, un-migrated, for the
  // configs that name it.
  describe('GPT-6.1 Sol', () => {
    it('is the OpenAI default, listed above GPT-6 Sol', () => {
      const provider = getProvider('openai')!;
      const ids = provider.models.map(m => m.id);
      expect(provider.defaultModel).toBe('gpt-6.1-sol');
      expect(ids.indexOf('gpt-6.1-sol')).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf('gpt-6.1-sol')).toBeLessThan(ids.indexOf('gpt-6-sol'));
      const sol61 = provider.models.find(m => m.id === 'gpt-6.1-sol')!;
      expect(sol61.name).toBe('GPT-6.1 Sol');
      expect(sol61.description).toContain('$2/$10');
      // Astra's caveat: through a proxy its agent turns use text tools.
      expect(sol61.description).toMatch(/Responses API only/);
      expect(provider.models.find(m => m.id === 'gpt-6-sol')!.description).toMatch(/^Previous Sol .*pinned configs/);
    });

    it('leaves a config pinned to GPT-6 Sol on it, on openai and OpenRouter', () => {
      expect(replacementModelFor('openai', 'gpt-6-sol')).toBeUndefined();
      expect(replacementModelFor('openrouter', 'openai/gpt-6-sol')).toBeUndefined();
      expect(getProvider('openai')!.models.map(m => m.id)).toContain('gpt-6-sol');
    });

    it('is in the OpenRouter fallback, above the previous Sol', () => {
      const models = getProvider('openrouter')!.models;
      const ids = models.map(m => m.id);
      expect(ids.indexOf('openai/gpt-6.1-sol')).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf('openai/gpt-6.1-sol')).toBeLessThan(ids.indexOf('openai/gpt-6-sol'));
      expect(models.find(m => m.id === 'openai/gpt-6.1-sol')!.name).toBe('GPT-6.1 Sol');
      expect(models.find(m => m.id === 'openai/gpt-6-sol')!.description).toMatch(/previous Sol/);
    });

    it('offers GPT-6.1 Sol /thinking low..max, with Max sent as "max" on openai and OpenRouter', () => {
      for (const [pid, model] of [['openai', 'gpt-6.1-sol'], ['openrouter', 'openai/gpt-6.1-sol']]) {
        expect(modelSupportsReasoningEffort(pid, model), model).toBe(true);
        expect(availableReasoningTiers(pid, model), model).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      }
      expect(reasoningParamsFor('openai', 'gpt-6.1-sol', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('openai', 'gpt-6.1-sol', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('openai', 'gpt-6.1-sol', 'max', { wire: 'responses' })).toEqual({ reasoning: { effort: 'max' } });
      expect(reasoningParamsFor('openrouter', 'openai/gpt-6.1-sol', 'max')).toEqual({ reasoning: { effort: 'max' } });
    });

    // Its id does not match `gpt-6-sol` (canonical `gpt-6-1-sol`), which is
    // what keeps it out of toolsForceReasoningOff. A "none" here would be a 400
    // on every proxied agent turn.
    it('never sends GPT-6.1 Sol "none" or "minimal" — any tier, tools or not, either wire, openai or OpenRouter', () => {
      for (const [pid, model] of [['openai', 'gpt-6.1-sol'], ['openrouter', 'openai/gpt-6.1-sol']]) {
        for (const wire of ['chat', 'responses'] as const) {
          for (const tools of [false, true]) {
            for (const tier of REASONING_TIERS) {
              const sent = JSON.stringify(reasoningParamsFor(pid, model, tier, { tools, wire }));
              expect(sent, `${pid} ${wire} tools=${tools} ${tier}`).not.toMatch(/"none"|"minimal"/);
            }
          }
          expect(toolsForceReasoningOff(pid, model, wire), `${pid} ${wire}`).toBe(false);
          expect(agentTurnReasoningNote(pid, model, wire), `${pid} ${wire}`).toBeNull();
        }
      }
    });

    it('still forces "none" with tools on Chat Completions for the pinned GPT-6 Sol and Luna only', () => {
      expect(toolsForceReasoningOff('openai', 'gpt-6-sol', 'chat')).toBe(true);
      expect(toolsForceReasoningOff('openai', 'gpt-6-luna', 'chat')).toBe(true);
      expect(toolsForceReasoningOff('openai', 'gpt-6-astra', 'chat')).toBe(false);
      expect(reasoningParamsFor('openai', 'gpt-6-sol', 'high', { tools: true })).toEqual({ reasoning_effort: 'none' });
    });

    it('omits sampling params for GPT-6.1 Sol, on OpenRouter too', () => {
      expect(modelRejectsSamplingParams('gpt-6.1-sol')).toBe(true);
      expect(modelRejectsSamplingParams('openai/gpt-6.1-sol')).toBe(true);
    });
  });

  describe('openai provider', () => {
    it('should include the GPT-5.6 family, with gpt-6.1-sol as default', () => {
      const provider = getProvider('openai');
      expect(provider).not.toBeNull();
      expect(provider!.defaultModel).toBe('gpt-6.1-sol');
      const modelIds = provider!.models.map(m => m.id);
      expect(modelIds).toContain('gpt-5.6-sol');
      expect(modelIds).toContain('gpt-5.6-terra');
      expect(modelIds).toContain('gpt-5.6-luna');
      expect(modelIds).not.toContain('gpt-5.5');
      expect(modelIds).not.toContain('gpt-5.4');
      expect(modelIds).not.toContain('gpt-5.4-mini');
    });
  });

  describe('newly added models (this release)', () => {
    it('lists Grok 4.7 first, keeps 4.6/4.5, and keeps the coder as the default', () => {
      const ids = getProvider('grok')!.models.map(m => m.id);
      expect(ids[0]).toBe('grok-4.7');
      expect(ids).toContain('grok-4.6');
      expect(ids).toContain('grok-4.5');
      // xAI recommends 4.7 for code, but it bills 2x input / 3x output against
      // the agentic coder, so it is opt-in rather than a silent upgrade.
      expect(getProvider('grok')!.defaultModel).toBe('grok-build-0.1');
      // All reasoning models → graded effort supported.
      expect(modelSupportsReasoningEffort('grok', 'grok-4.7')).toBe(true);
      expect(modelSupportsReasoningEffort('grok', 'grok-4.6')).toBe(true);
      expect(modelSupportsReasoningEffort('grok', 'grok-4.5')).toBe(true);
    });
    it('lists Gemini 3.7 Flash and rejects its removed sampling params', () => {
      expect(getProvider('google')!.models.map(m => m.id)).toContain('gemini-3.7-flash');
      // Google removed temperature/top_p/top_k in this generation.
      expect(modelRejectsSamplingParams('gemini-3.7-flash')).toBe(true);
      expect(modelRejectsSamplingParams('gemini-3.6-flash')).toBe(false);
      expect(modelSupportsReasoningEffort('google', 'gemini-3.7-flash')).toBe(true);
    });
    it('lists GLM-5.3 on every Z.AI roster; the plans carry exactly 5.3 and 5.3 Flash', () => {
      for (const id of ['z.ai', 'z.ai-api', 'z.ai-cn', 'z.ai-cn-api']) {
        expect(getProvider(id)!.models.map(m => m.id), id).toContain('glm-5.3');
        expect(getProvider(id)!.defaultModel, id).toBe('glm-5.3');
      }
      // Both Coding Plans: "Only the following two models can be called".
      expect(getProvider('z.ai')!.models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash']);
      expect(getProvider('z.ai-cn')!.models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash']);
      // FlashX is pay-per-use only, on both platforms.
      expect(getProvider('z.ai-api')!.models.map(m => m.id)).toContain('glm-5.3-flashx');
      expect(getProvider('z.ai-cn-api')!.models.map(m => m.id)).toContain('glm-5.3-flashx');
      // Turbo left the international price list; China still sells it.
      expect(getProvider('z.ai-api')!.models.map(m => m.id)).not.toContain('glm-5-turbo');
      expect(getProvider('z.ai-cn-api')!.models.map(m => m.id)).toContain('glm-5-turbo');
      // FlashX shares 5.3's effort ladder through the glm-5-3 gate.
      expect(availableReasoningTiers('z.ai-api', 'glm-5.3-flashx')).toEqual(['auto', 'low', 'high', 'max']);
    });
    it('grades GLM-5.3 effort low/high/max and never disables thinking', () => {
      expect(modelSupportsReasoningEffort('z.ai', 'glm-5.3')).toBe(true);
      expect(availableReasoningTiers('z.ai', 'glm-5.3')).toEqual(['auto', 'low', 'high', 'max']);
      expect(reasoningParamsFor('z.ai', 'glm-5.3', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('z.ai', 'glm-5.3', 'medium')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('z.ai', 'glm-5.3', 'max')).toEqual({ reasoning_effort: 'max' });
      // GLM-5.2 keeps its narrower high|max grading.
      expect(availableReasoningTiers('z.ai', 'glm-5.2')).toEqual(['auto', 'high', 'max']);
      expect(reasoningParamsFor('z.ai', 'glm-5.2', 'low')).toEqual({ reasoning_effort: 'high' });
    });
    it('refreshes the OpenRouter fallback with the ids OpenRouter actually carries', () => {
      const ids = getProvider('openrouter')!.models.map(m => m.id);
      // OpenRouter's x-ai/grok-4.6 now says "It is succeeded by Grok 4.7".
      expect(ids).toContain('x-ai/grok-4.7');
      expect(ids).not.toContain('x-ai/grok-4.6');
      expect(ids).toContain('google/gemini-3.7-flash');
      // OpenRouter does not carry GLM-5.3 (Coding-Plan only).
      expect(ids.some(id => id.includes('glm-5.3'))).toBe(false);
    });
    it('lists current Gemini Flash models under google', () => {
      expect(getProvider('google')!.models.map(m => m.id)).toContain('gemini-3.6-flash');
      expect(getProvider('google')!.models.map(m => m.id)).toContain('gemini-3.5-flash');
      expect(getProvider('google')!.models.map(m => m.id)).toContain('gemini-3.5-flash-lite');
      expect(modelSupportsReasoningEffort('google', 'gemini-3.5-flash-lite')).toBe(true);
    });
    it('uses Qwen 3.7 replacements instead of retiring coder aliases', () => {
      for (const id of ['qwen', 'qwen-cn']) {
        const ids = getProvider(id)!.models.map(m => m.id);
        expect(ids).toContain('qwen3.7-plus');
        expect(ids).not.toContain('qwen3-coder-plus');
        expect(ids).not.toContain('qwen3-coder-next');
      }
      for (const id of ['qwen-api', 'qwen-cn-api']) {
        const ids = getProvider(id)!.models.map(m => m.id);
        expect(ids).toContain('qwen3.7-max');
        expect(ids).toContain('qwen3.7-plus');
        expect(ids).not.toContain('qwen3-coder-plus');
      }
    });
    it('prices and sizes every curated model (pricing/context lockstep holds)', () => {
      // Models that deliberately carry a context window but no pricing row.
      // Each needs a matching comment in tokenTracker.ts saying why.
      // Empty since qwen3.8-max-preview left the Token Plan picker.
      const UNPRICED_BY_DESIGN = new Set<string>([]);
      const priced = new Set(getPricingTable().map(entry => entry.model));

      // The exemptions must stay exemptions: if a rate is ever added, delete the
      // entry here rather than leaving a dead suppression that hides the next gap.
      for (const id of UNPRICED_BY_DESIGN) {
        expect(priced.has(id), `${id} is now priced — drop it from UNPRICED_BY_DESIGN`).toBe(false);
      }

      const missingContext: string[] = [];
      const missingPricing: string[] = [];
      for (const [providerId, provider] of Object.entries(PROVIDERS)) {
        // Dynamic catalogues are user-controlled and their ids are namespaced
        // (openrouter), HF-style (modelscope) or local (ollama/custom), so they
        // resolve upstream rather than through our tables. Four providers, not
        // three — modelscope carries a curated fallback id and is exempt too.
        if (isDynamicModelsProvider(providerId)) continue;
        for (const model of provider.models) {
          // 128k is the unknown-fallback, so it doubles as "no entry".
          if (getModelContextWindow(model.id) === 128_000) missingContext.push(`${providerId}/${model.id}`);
          if (!priced.has(model.id) && !UNPRICED_BY_DESIGN.has(model.id)) missingPricing.push(`${providerId}/${model.id}`);
        }
      }
      expect(missingContext).toEqual([]);
      expect(missingPricing).toEqual([]);
    });
  });

  describe('flat-fee providers', () => {
    // The `hint` is what the user reads; `flatFee` is what the cost surfaces
    // read. They describe the same fact, so they must name the same providers —
    // a hint that advertises a subscription / plan / free tier means no
    // per-token charges.
    const FLAT_FEE_HINT = /subscription|coding plan|token plan|free catalog/i;

    it('flags exactly the providers whose hint advertises a plan or free tier', () => {
      const flagged = Object.keys(PROVIDERS).filter(id => isFlatFeeProvider(id)).sort();
      const advertised = Object.entries(PROVIDERS)
        .filter(([, cfg]) => FLAT_FEE_HINT.test(cfg.hint ?? ''))
        .map(([id]) => id)
        .sort();
      expect(flagged).toEqual(advertised);
      expect(flagged).toEqual([
        'kimi', 'minimax', 'minimax-cn', 'modelscope',
        'qwen', 'qwen-cn', 'qwen-token-plan', 'z.ai', 'z.ai-cn',
      ]);
    });

    it('leaves pay-per-use providers unflagged', () => {
      for (const id of ['anthropic', 'openai', 'z.ai-api', 'kimi-api', 'qwen-api', 'openrouter', 'ollama']) {
        expect(isFlatFeeProvider(id), id).toBe(false);
      }
      expect(isFlatFeeProvider('nope')).toBe(false);
    });
  });

  describe('retired model migrations', () => {
    it('maps exact curated aliases to their supported replacements', () => {
      expect(replacementModelFor('z.ai-api', 'glm-5')).toBe('glm-5.2');
      expect(replacementModelFor('z.ai-cn-api', 'glm-5.1')).toBe('glm-5.2');
      expect(replacementModelFor('openai', 'gpt-5.5')).toBe('gpt-5.6-sol');
      expect(replacementModelFor('google', 'gemini-3.5-flash')).toBeUndefined();
      expect(replacementModelFor('grok', 'grok-code-fast-1')).toBe('grok-build-0.1');
      expect(replacementModelFor('grok', 'grok-4-fast-reasoning')).toBe('grok-4.3');
      expect(replacementModelFor('kimi-api', 'kimi-k3-code')).toBe('kimi-k3');
      expect(replacementModelFor('qwen', 'qwen3-coder-plus')).toBe('qwen3.7-plus');
      expect(replacementModelFor('qwen-api', 'qwen3-coder-flash')).toBe('qwen3.6-flash');
    });

    it('never rewrites dynamic or unknown model ids', () => {
      expect(replacementModelFor('openrouter', 'openai/gpt-5.5')).toBeUndefined();
      expect(replacementModelFor('ollama', 'qwen3-coder-plus:latest')).toBeUndefined();
      expect(replacementModelFor('custom', 'company/private-model')).toBeUndefined();
    });

    // A migration target the provider does not offer lands the user on a model
    // the picker cannot show and, on a plan, one the plan may reject. And the
    // lookup is one step, so a target that is itself a key would never finish.
    it('only ever lands on a model the same provider offers, in one step', () => {
      const problems: string[] = [];
      for (const [providerId, map] of Object.entries(retiredModelReplacements())) {
        const offered = new Set((getProvider(providerId)?.models ?? []).map(m => m.id));
        for (const [from, to] of Object.entries(map)) {
          if (!offered.has(to)) problems.push(`${providerId}: ${from} → ${to} is not offered`);
          if (to in map) problems.push(`${providerId}: ${from} → ${to} is itself migrated`);
          if (offered.has(from)) problems.push(`${providerId}: ${from} is still offered`);
        }
      }
      expect(problems).toEqual([]);
    });

    // Both GLM Coding Plans accept exactly GLM-5.3 and 5.3 Flash and route
    // 5.2/5.1 to 5.3 (China also Turbo to Flash); pay-per-use still sells 5.2.
    it('moves GLM plan users onto the two models their plan accepts', () => {
      for (const plan of ['z.ai', 'z.ai-cn']) {
        expect(replacementModelFor(plan, 'glm-5.2'), plan).toBe('glm-5.3');
        expect(replacementModelFor(plan, 'glm-5.1'), plan).toBe('glm-5.3');
        expect(replacementModelFor(plan, 'glm-5'), plan).toBe('glm-5.3');
        expect(replacementModelFor(plan, 'glm-5-turbo'), plan).toBe('glm-5.3-flash');
      }
      expect(replacementModelFor('z.ai-api', 'glm-5.2')).toBeUndefined();
      expect(replacementModelFor('z.ai-cn-api', 'glm-5.2')).toBeUndefined();
      // Turbo left the international list only.
      expect(replacementModelFor('z.ai-api', 'glm-5-turbo')).toBe('glm-5.3-flash');
      expect(replacementModelFor('z.ai-cn-api', 'glm-5-turbo')).toBeUndefined();
    });

    it('moves the Gemini 3 previews to the replacements Google names', () => {
      expect(replacementModelFor('google', 'gemini-3-flash-preview')).toBe('gemini-3.6-flash');
      expect(replacementModelFor('google', 'gemini-3-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    // Alibaba retires qwen3-coder-plus/next and bare qwen3-max on 2026-10-10,
    // naming qwen3.7-plus and qwen3.7-max. 3.7 Max is not on the Coding Plan.
    it('moves the Qwen ids retiring on 2026-10-10 to a model each surface accepts', () => {
      for (const id of ['qwen-api', 'qwen-cn-api', 'qwen-token-plan']) {
        expect(replacementModelFor(id, 'qwen3-max'), id).toBe('qwen3.7-max');
        expect(replacementModelFor(id, 'qwen3-coder-plus'), id).toBe('qwen3.7-plus');
        expect(replacementModelFor(id, 'qwen3-coder-next'), id).toBe('qwen3.7-plus');
      }
      for (const plan of ['qwen', 'qwen-cn']) {
        expect(replacementModelFor(plan, 'qwen3-max'), plan).toBe('qwen3.7-plus');
        expect(replacementModelFor(plan, 'qwen3-coder-plus'), plan).toBe('qwen3.7-plus');
      }
      // Retired on the Token Plan and routed to 3.8 Max by Alibaba.
      expect(replacementModelFor('qwen-token-plan', 'qwen3.8-max-preview')).toBe('qwen3.8-max');
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
      expect(modelIds).toContain('gemini-3.6-flash');
      expect(modelIds).toContain('gemini-3.5-flash');
      expect(modelIds).toContain('gemini-3.5-flash-lite');
    });
  });

  describe('canonicalModelId', () => {
    it('lowercases, strips vendor/ prefix, and normalizes dots to dashes', () => {
      expect(canonicalModelId('Claude-Opus-5')).toBe('claude-opus-5');
      expect(canonicalModelId('anthropic/claude-opus-5')).toBe('claude-opus-5');
      // Dotted ids still normalize — Opus 5 has no dot, so keep a dotted
      // Anthropic id in the matrix or we'd stop covering that branch.
      expect(canonicalModelId('Claude-Opus-4.7')).toBe('claude-opus-4-7');
      expect(canonicalModelId('anthropic/claude-opus-4.7')).toBe('claude-opus-4-7');
      expect(canonicalModelId('glm-5.2')).toBe('glm-5-2');
      expect(canonicalModelId('GPT-5.5')).toBe('gpt-5-5');
    });
  });

  describe('modelSupportsReasoningEffort', () => {
    it('supports capable Anthropic models, not Haiku or Sonnet 4.5', () => {
      expect(modelSupportsReasoningEffort('anthropic', 'claude-opus-5')).toBe(true);
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
      expect(reasoningParamsFor('anthropic', 'claude-opus-5', 'auto')).toEqual({});
      expect(reasoningParamsFor('anthropic', 'claude-haiku-4-5-20251001', 'high')).toEqual({});
      expect(reasoningParamsFor('ollama', 'llama3.2', 'max')).toEqual({});
    });
    it('returns {} (never effort:undefined) for a garbage/legacy tier value', () => {
      // Simulates an old config string that isn't one of the 5 tiers.
      expect(reasoningParamsFor('anthropic', 'claude-opus-5', 'ultra' as never)).toEqual({});
      expect(reasoningParamsFor('openai', 'gpt-5.5', undefined as never)).toEqual({});
    });
    it('Anthropic → output_config.effort, passed through 1:1', () => {
      expect(reasoningParamsFor('anthropic', 'claude-opus-5', 'low')).toEqual({ output_config: { effort: 'low' } });
      expect(reasoningParamsFor('anthropic', 'claude-opus-5', 'max')).toEqual({ output_config: { effort: 'max' } });
    });
    it('OpenAI → reasoning_effort; Max is "max" from GPT-5.6 on, xhigh before it', () => {
      expect(reasoningParamsFor('openai', 'gpt-5.5', 'medium')).toEqual({ reasoning_effort: 'medium' });
      expect(reasoningParamsFor('openai', 'gpt-5.5', 'max')).toEqual({ reasoning_effort: 'xhigh' });
      // "max" arrived with GPT-5.6 and every GPT-6 page lists it.
      expect(reasoningParamsFor('openai', 'gpt-5.6-sol', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('openai', 'gpt-5.6-luna', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('openai', 'gpt-6-sol', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('openai', 'gpt-6-sol', 'high')).toEqual({ reasoning_effort: 'high' });
    });

    // Chat Completions: GPT-6 Sol/Luna call tools only at reasoning_effort
    // "none". Auto sends nothing and the model runs at medium — the exact case
    // the docs rule out — so the override must come before the auto return.
    it('sends reasoning_effort "none" to GPT-6 Sol/Luna on a request with tools, whatever the tier', () => {
      for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
        for (const tier of REASONING_TIERS) {
          expect(reasoningParamsFor('openai', model, tier, { tools: true }), `${model} ${tier}`)
            .toEqual({ reasoning_effort: 'none' });
        }
      }
    });

    it('leaves the tier alone without tools, on Astra, on other GPTs and on OpenRouter', () => {
      // Plain chat carries no tools, so the tier applies there.
      expect(reasoningParamsFor('openai', 'gpt-6-sol', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('openai', 'gpt-6-sol', 'auto')).toEqual({});
      // Astra rejects "none" with a 400.
      expect(reasoningParamsFor('openai', 'gpt-6-astra', 'high', { tools: true })).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('openai', 'gpt-5.6-sol', 'auto', { tools: true })).toEqual({});
      // OpenRouter may reach OpenAI through the Responses API.
      expect(reasoningParamsFor('openrouter', 'openai/gpt-6-sol', 'high', { tools: true })).toEqual({ reasoning: { effort: 'high' } });
      expect(toolsForceReasoningOff('openrouter', 'openai/gpt-6-sol')).toBe(false);
      expect(toolsForceReasoningOff('openai', 'gpt-6-astra')).toBe(false);
    });

    it('says where the user can see it that agent turns run GPT-6 Sol/Luna with reasoning off', () => {
      expect(agentTurnReasoningNote('openai', 'gpt-6-sol')).toMatch(/reasoning_effort "none"/);
      expect(agentTurnReasoningNote('openai', 'gpt-6-luna')).toMatch(/plain chat/);
      expect(agentTurnReasoningNote('openai', 'gpt-5.6-sol')).toBeNull();
      expect(agentTurnReasoningNote('openrouter', 'openai/gpt-6-sol')).toBeNull();
    });
    // Medium used to be collapsed to high because Gemini 3 Preview 400'd on it.
    // That was a preview-era bug; Google's OpenAI-compat mapping table now
    // documents low|medium|high, and medium is 3.7 Flash's own default.
    it('Gemini → reasoning_effort low|medium|high, max capped at high', () => {
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'medium')).toEqual({ reasoning_effort: 'medium' });
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'high')).toEqual({ reasoning_effort: 'high' });
      // Gemini has no tier above high, so 'max' tops out rather than 400ing.
      expect(reasoningParamsFor('google', 'gemini-3.1-pro-preview', 'max')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('google', 'gemini-3.7-flash', 'medium')).toEqual({ reasoning_effort: 'medium' });
    });
    it('DeepSeek V4 Pro → low|high|max; GLM-5.2 → high|max', () => {
      expect(reasoningParamsFor('deepseek', 'deepseek-v4-pro', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('deepseek', 'deepseek-v4-pro', 'max')).toEqual({ reasoning_effort: 'max' });
      expect(reasoningParamsFor('z.ai', 'glm-5.2', 'high')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('z.ai', 'glm-5.2', 'max')).toEqual({ reasoning_effort: 'max' });
    });
    it('Kimi K3 → reasoning_effort low|high|max', () => {
      expect(reasoningParamsFor('kimi-api', 'kimi-k3', 'low')).toEqual({ reasoning_effort: 'low' });
      expect(reasoningParamsFor('kimi-api', 'kimi-k3', 'medium')).toEqual({ reasoning_effort: 'high' });
      expect(reasoningParamsFor('kimi-api', 'kimi-k3', 'max')).toEqual({ reasoning_effort: 'max' });
    });
    // OpenRouter accepts "xhigh" and "max" where the model lists them in
    // /api/v1/models reasoning.supported_efforts (read 2026-09-23).
    it('OpenRouter → reasoning.effort, Max as high as the model lists', () => {
      expect(reasoningParamsFor('openrouter', 'openai/gpt-5.5', 'medium')).toEqual({ reasoning: { effort: 'medium' } });
      expect(reasoningParamsFor('openrouter', 'openai/gpt-5.5', 'max')).toEqual({ reasoning: { effort: 'xhigh' } });
      for (const id of ['openai/gpt-6-sol', 'openai/gpt-5.6-sol', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1',
        'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro-0813', 'moonshotai/kimi-k3']) {
        expect(reasoningParamsFor('openrouter', id, 'max'), id).toEqual({ reasoning: { effort: 'max' } });
      }
      for (const id of ['x-ai/grok-4.7', 'x-ai/grok-4.6', 'qwen/qwen3.8-max-0902']) {
        expect(reasoningParamsFor('openrouter', id, 'max'), id).toEqual({ reasoning: { effort: 'xhigh' } });
      }
      // Lists neither: Gemini tops out at high; grok-4.5 and the 0423 V4 Pro
      // preview list no max, and an unknown id keeps the old cap.
      for (const id of ['google/gemini-3.8-flash', 'x-ai/grok-4.5', 'deepseek/deepseek-v4-pro', 'openrouter/auto']) {
        expect(reasoningParamsFor('openrouter', id, 'max'), id).toEqual({ reasoning: { effort: 'high' } });
      }
    });
    it('never emits a value Gemini/OpenAI reject across all tiers', () => {
      for (const tier of REASONING_TIERS) {
        const g = reasoningParamsFor('google', 'gemini-3.6-flash', tier) as { reasoning_effort?: string };
        // 'minimal' is never emitted — gemini-3.7-flash rejects it outright.
        if (g.reasoning_effort) expect(['low', 'medium', 'high']).toContain(g.reasoning_effort);
        const o = reasoningParamsFor('openai', 'gpt-5.5', tier) as { reasoning_effort?: string };
        if (o.reasoning_effort) expect(['none', 'low', 'medium', 'high', 'xhigh']).toContain(o.reasoning_effort);
        const o6 = reasoningParamsFor('openai', 'gpt-6-sol', tier) as { reasoning_effort?: string };
        if (o6.reasoning_effort) expect(['none', 'low', 'medium', 'high', 'xhigh', 'max']).toContain(o6.reasoning_effort);
      }
    });
  });

  describe('availableReasoningTiers', () => {
    it('lists only the levels each model distinguishes', () => {
      expect(availableReasoningTiers('anthropic', 'claude-opus-5')).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      expect(availableReasoningTiers('openai', 'gpt-5.5')).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      expect(availableReasoningTiers('google', 'gemini-3.1-pro-preview')).toEqual(['auto', 'low', 'medium', 'high']);
      expect(availableReasoningTiers('z.ai', 'glm-5.2')).toEqual(['auto', 'high', 'max']);
      expect(availableReasoningTiers('deepseek', 'deepseek-v4-pro')).toEqual(['auto', 'low', 'high', 'max']);
      expect(availableReasoningTiers('kimi-api', 'kimi-k3')).toEqual(['auto', 'low', 'high', 'max']);
      expect(availableReasoningTiers('openrouter', 'openai/gpt-5.5')).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      expect(availableReasoningTiers('openrouter', 'google/gemini-3.8-flash')).toEqual(['auto', 'low', 'medium', 'high']);
    });
    it('returns [] for unsupported models', () => {
      expect(availableReasoningTiers('anthropic', 'claude-haiku-4-5-20251001')).toEqual([]);
      expect(availableReasoningTiers('ollama', 'llama3.2')).toEqual([]);
    });
    it('drift guard — every listed non-auto tier yields a DISTINCT param', () => {
      const cases = [
        ['anthropic', 'claude-opus-5'], ['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-5.5'],
        ['openai', 'gpt-5.6-sol'], ['openai', 'gpt-6.1-sol'], ['openai', 'gpt-6-sol'], ['openai', 'gpt-6-luna'],
        ['google', 'gemini-3.1-pro-preview'], ['z.ai-api', 'glm-5.2'], ['z.ai', 'glm-5.3'],
        ['kimi-api', 'kimi-k3'], ['kimi', 'kimi-for-coding'],
        ['deepseek', 'deepseek-flash'], ['deepseek', 'deepseek-v4-pro'],
        ['openrouter', 'openai/gpt-5.5'], ['openrouter', 'openai/gpt-6.1-sol'], ['openrouter', 'openai/gpt-6-sol'], ['openrouter', 'x-ai/grok-4.7'],
        ['openrouter', 'google/gemini-3.8-flash'],
        ['grok', 'grok-4.3'], ['grok', 'grok-4.5'], ['grok', 'grok-4.6'], ['grok', 'grok-4.7'],
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
      for (const id of ['kimi', 'kimi-api', 'kimi-cn', 'grok', 'qwen', 'qwen-token-plan', 'qwen-api', 'qwen-cn', 'qwen-cn-api', 'modelscope']) {
        expect(PROVIDERS[id], id).toBeDefined();
      }
    });
    it('Kimi Code subscription uses the coding base URL + kimi-for-coding alias', () => {
      expect(PROVIDERS['kimi'].protocols.openai?.baseUrl).toBe('https://api.kimi.com/coding/v1');
      expect(PROVIDERS['kimi'].defaultModel).toBe('kimi-for-coding');
      expect(PROVIDERS['kimi'].models.map(m => m.id)).toEqual([
        'kimi-for-coding', 'k3', 'k3-256k', 'kimi-for-coding-highspeed',
      ]);
      expect(PROVIDERS['kimi-api'].protocols.openai?.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(PROVIDERS['kimi-api'].defaultModel).toBe('kimi-k3');
    });
    it('Kimi K3 is exposed on pay-per-use providers', () => {
      const apiModels = PROVIDERS['kimi-api'].models.map(m => m.id);
      expect(apiModels).toContain('kimi-k3');
      expect(apiModels).not.toContain('kimi-k2.5');
      expect(PROVIDERS['kimi-api'].maxOutputTokens).toBe(131_072);
      const cnModels = PROVIDERS['kimi-cn'].models.map(m => m.id);
      expect(cnModels).toContain('kimi-k3');
      expect(PROVIDERS['kimi-cn'].defaultModel).toBe('kimi-k3');
    });
    it('Qwen Coding Plan vs pay-per-use base URLs (mirrors z.ai pattern)', () => {
      expect(PROVIDERS['qwen'].protocols.openai?.baseUrl).toBe('https://coding-intl.dashscope.aliyuncs.com/v1');
      expect(PROVIDERS['qwen-api'].protocols.openai?.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
      expect(PROVIDERS['qwen'].defaultModel).toBe('qwen3.7-plus');
      expect(PROVIDERS['qwen'].models.map(m => m.id)).toEqual([
        'qwen3.7-plus',
        'qwen3.6-plus',
        'qwen3.5-plus',
      ]);
      // 3.8 Max and Flash are GA on Model Studio international, and cheaper
      // than the 3.7 Max / 3.6 Flash they sit above.
      expect(PROVIDERS['qwen-api'].defaultModel).toBe('qwen3.8-max');
      expect(PROVIDERS['qwen-api'].models.map(m => m.id)).toEqual(
        expect.arrayContaining(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max']));
      // 3.8 Max and Flash are GA in China (Beijing) too; the default stays put.
      expect(PROVIDERS['qwen-cn-api'].defaultModel).toBe('qwen3.7-max');
      expect(PROVIDERS['qwen-cn-api'].models.map(m => m.id)).toEqual(
        expect.arrayContaining(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max']));
      expect(PROVIDERS['qwen-api'].models.map(m => m.id)).not.toContain('qwen3-coder-plus');
    });
    it('keeps Qwen Token Plan isolated from Coding Plan and pay-per-use', () => {
      const tokenPlan = PROVIDERS['qwen-token-plan'];
      expect(tokenPlan.protocols.openai?.baseUrl).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
      expect(tokenPlan.envKey).toBe('BAILIAN_TOKEN_PLAN_API_KEY');
      // The preview is retired and routed to 3.8 Max; both editions list 3.8 Flash.
      expect(tokenPlan.defaultModel).toBe('qwen3.8-max');
      const ids = tokenPlan.models.map(m => m.id);
      expect(ids).not.toContain('qwen3.8-max-preview');
      expect(ids).toContain('qwen3.8-flash');
      // Team-only: a Personal key gets 403 for it, and the picker says so.
      expect(tokenPlan.models.find(m => m.id === 'qwen3.6-plus')!.description).toMatch(/Team edition only/);
      expect(tokenPlan.noStreamWithTools).toBe(true);
    });
    it('Grok uses api.x.ai + max_completion_tokens (reasoning models)', () => {
      expect(PROVIDERS['grok'].protocols.openai?.baseUrl).toBe('https://api.x.ai/v1');
      expect(PROVIDERS['grok'].defaultModel).toBe('grok-build-0.1');
      expect(PROVIDERS['grok'].useMaxCompletionTokens).toBe(true);
    });
    it('Qwen + ModelScope set noStreamWithTools; others do not', () => {
      expect(providerNoStreamWithTools('qwen')).toBe(true);
      expect(providerNoStreamWithTools('qwen-api')).toBe(true);
      expect(providerNoStreamWithTools('qwen-token-plan')).toBe(true);
      expect(providerNoStreamWithTools('modelscope')).toBe(true);
      expect(providerNoStreamWithTools('grok')).toBe(false);
      expect(providerNoStreamWithTools('kimi')).toBe(false);
      expect(providerNoStreamWithTools('openai')).toBe(false);
    });
    it('Kimi coding models reject custom sampling params (fixed temperature)', () => {
      expect(modelRejectsSamplingParams('kimi-k3')).toBe(true);
      expect(modelRejectsSamplingParams('kimi-k2.7-code')).toBe(true);
      expect(modelRejectsSamplingParams('kimi-for-coding')).toBe(true);
      expect(modelRejectsSamplingParams('kimi-for-coding-highspeed')).toBe(true);
      expect(modelRejectsSamplingParams('k3-256k')).toBe(true);
      expect(modelRejectsSamplingParams('kimi-k2.6')).toBe(false);
    });
    it('Grok and Kimi K3 support graded reasoning_effort; aliases/Qwen do not', () => {
      expect(modelSupportsReasoningEffort('grok', 'grok-4.3')).toBe(true);
      // Coders (grok-build, grok-code-fast) are non-reasoning — reasoning_effort
      // 400s on them, which would silently drop the turn into the text-tool fallback.
      expect(modelSupportsReasoningEffort('grok', 'grok-build-0.1')).toBe(false);
      expect(modelSupportsReasoningEffort('grok', 'grok-code-fast-1')).toBe(false);
      expect(modelSupportsReasoningEffort('grok', 'grok-4-fast-non-reasoning')).toBe(false);
      // K2.8 Preview since 2026-09-11 takes low/high/max; HighSpeed (K2.7 Code
      // HighSpeed) has no ladder, so the match must be exact.
      expect(modelSupportsReasoningEffort('kimi', 'kimi-for-coding')).toBe(true);
      expect(availableReasoningTiers('kimi', 'kimi-for-coding')).toEqual(['auto', 'low', 'high', 'max']);
      expect(modelSupportsReasoningEffort('kimi', 'kimi-for-coding-highspeed')).toBe(false);
      expect(modelSupportsReasoningEffort('kimi', 'k3')).toBe(true);
      expect(modelSupportsReasoningEffort('kimi', 'k3-256k')).toBe(true);
      expect(modelSupportsReasoningEffort('kimi-api', 'kimi-k3')).toBe(true);
      expect(modelSupportsReasoningEffort('qwen', 'qwen3.7-plus')).toBe(false);
    });
    it('Grok reasoning_effort: Max → high where xhigh is disputed (4.3, 4.5)', () => {
      expect(reasoningParamsFor('grok', 'grok-4.3', 'medium')).toEqual({ reasoning_effort: 'medium' });
      expect(reasoningParamsFor('grok', 'grok-4.3', 'max')).toEqual({ reasoning_effort: 'high' });
      expect(availableReasoningTiers('grok', 'grok-4.3')).toEqual(['auto', 'low', 'medium', 'high']);
      expect(reasoningParamsFor('grok', 'grok-4.5', 'max')).toEqual({ reasoning_effort: 'high' });
      expect(availableReasoningTiers('grok', 'grok-4.5')).toEqual(['auto', 'low', 'medium', 'high']);
    });
    // "`xhigh` is available on `grok-4.6` and later" — xAI reasoning guide.
    it('Grok reasoning_effort: Max → xhigh on 4.6 and 4.7', () => {
      for (const model of ['grok-4.7', 'grok-4.6']) {
        expect(reasoningParamsFor('grok', model, 'max'), model).toEqual({ reasoning_effort: 'xhigh' });
        expect(reasoningParamsFor('grok', model, 'high'), model).toEqual({ reasoning_effort: 'high' });
        expect(availableReasoningTiers('grok', model), model).toEqual(['auto', 'low', 'medium', 'high', 'max']);
      }
    });
  });

  describe('2026-09-23 sweep', () => {
    // GPT-6 takes sampling params only at effort "none" (Astra never). The
    // direct openai provider omits them for every model; OpenRouter's
    // openai/gpt-6-* ids reach the model-level check only.
    it('omits sampling params for GPT-6 on OpenRouter', () => {
      expect(modelRejectsSamplingParams('openai/gpt-6-sol')).toBe(true);
      expect(modelRejectsSamplingParams('openai/gpt-6-luna')).toBe(true);
      expect(modelRejectsSamplingParams('gpt-6-astra')).toBe(true);
      expect(modelRejectsSamplingParams('openai/gpt-5.6-sol')).toBe(false);
    });

    // Opus 5.5 thinks on every request and more per turn than Opus 5; the
    // thinking spends the same max_tokens as the answer.
    it('gives Opus 5.5 a response floor, more at Max, and nobody but Sonnet 5.5 one', () => {
      expect(minResponseTokensFor('claude-opus-5-5', 'auto')).toBe(32_768);
      expect(minResponseTokensFor('claude-opus-5-5', undefined)).toBe(32_768);
      expect(minResponseTokensFor('claude-opus-5-5', 'max')).toBe(65_536);
      expect(minResponseTokensFor('anthropic/claude-opus-5.5', 'high')).toBe(32_768);
      expect(minResponseTokensFor('claude-opus-5', 'max')).toBe(0);
      expect(minResponseTokensFor('gpt-6-sol', 'max')).toBe(0);
    });

    // The old fallback is no longer served by ModelScope API-Inference.
    it('falls back to a ModelScope model that is still served', () => {
      expect(PROVIDERS['modelscope'].defaultModel).toBe('Qwen/Qwen3.5-397B-A17B');
      expect(getModelContextWindow('Qwen/Qwen3.5-397B-A17B')).toBe(262_144);
    });

    // A config still on the old fallback held an id ModelScope no longer
    // serves. Only that exact id moves: the rest of the catalogue is live.
    it('moves the old ModelScope fallback, and no other ModelScope id', () => {
      expect(replacementModelFor('modelscope', 'Qwen/Qwen3-Coder-480B-A35B-Instruct')).toBe('Qwen/Qwen3.5-397B-A17B');
      expect(replacementModelFor('modelscope', 'Qwen/Qwen3-Coder-30B-A3B-Instruct')).toBeUndefined();
      expect(replacementModelFor('openrouter', 'Qwen/Qwen3-Coder-480B-A35B-Instruct')).toBeUndefined();
    });
  });

  describe('resolveReasoningTier', () => {
    it('passes through tiers the model distinguishes', () => {
      expect(resolveReasoningTier('anthropic', 'claude-opus-5', 'low')).toBe('low');
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'max')).toBe('max');
      expect(resolveReasoningTier('kimi-api', 'kimi-k3', 'max')).toBe('max');
    });
    it('collapses out-of-range tiers to the level the model actually runs', () => {
      // Kimi K3 has low|high|max — medium runs as high.
      expect(resolveReasoningTier('kimi-api', 'kimi-k3', 'medium')).toBe('high');
      // GLM-5.2 grades only high|max — low/medium run as high.
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'low')).toBe('high');
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'medium')).toBe('high');
      // Gemini grades low|medium|high — medium is its own tier now, and only
      // 'max' (which Gemini has no equivalent for) collapses.
      expect(resolveReasoningTier('google', 'gemini-3.1-pro-preview', 'medium')).toBe('medium');
      expect(resolveReasoningTier('google', 'gemini-3.1-pro-preview', 'max')).toBe('high');
      expect(resolveReasoningTier('google', 'gemini-3.7-flash', 'medium')).toBe('medium');
    });
    it('returns auto for auto or unsupported models', () => {
      expect(resolveReasoningTier('z.ai', 'glm-5.2', 'auto')).toBe('auto');
      expect(resolveReasoningTier('ollama', 'llama3.2', 'max')).toBe('auto');
    });
  });
});

// Claude Sonnet 5.5, released 2026-09-28 (platform.claude.com model page,
// What's new, migration guide). Every value is asserted on its own and through
// OpenRouter's dotted id, rather than trusting the `claude-sonnet-5` rows to
// catch 5.5 by prefix.
describe('Claude Sonnet 5.5', () => {
  const SONNET = 'claude-sonnet-5-5';
  const OR_SONNET = 'anthropic/claude-sonnet-5.5';

  it('is the Sonnet in the Anthropic picker, directly above Sonnet 5, which stays unmigrated', () => {
    const models = PROVIDERS['anthropic'].models;
    const ids = models.map(m => m.id);
    expect(ids.indexOf(SONNET)).toBeGreaterThan(-1);
    expect(ids.indexOf('claude-sonnet-5')).toBe(ids.indexOf(SONNET) + 1);
    const sonnet55 = models.find(m => m.id === SONNET)!;
    expect(sonnet55.name).toBe('Claude Sonnet 5.5');
    expect(sonnet55.description).toMatch(/^Best balance of speed and intelligence/);
    expect(models.find(m => m.id === 'claude-sonnet-5')!.description).toBe('Previous Sonnet — kept for pinned configs');
    // Sonnet 5 is still Active (retiring no sooner than 2027-06-30).
    expect(replacementModelFor('anthropic', 'claude-sonnet-5')).toBeUndefined();
    expect(replacementModelFor('anthropic', SONNET)).toBeUndefined();
    // The overview still says to start with Opus 5.5.
    expect(PROVIDERS['anthropic'].defaultModel).toBe('claude-opus-5-5');
  });

  it('is in the OpenRouter fallback under the dotted id OpenRouter lists, above Sonnet 5', () => {
    const models = getProvider('openrouter')!.models;
    const ids = models.map(m => m.id);
    expect(ids).not.toContain('anthropic/claude-sonnet-5-5');
    expect(ids.indexOf('anthropic/claude-sonnet-5')).toBe(ids.indexOf(OR_SONNET) + 1);
    expect(models.find(m => m.id === OR_SONNET)!.name).toBe('Claude Sonnet 5.5');
    expect(models.find(m => m.id === 'anthropic/claude-sonnet-5')!.description).toBe('Anthropic — previous Sonnet');
  });

  // "Setting temperature, top_p, or top_k to a non-default value returns a 400 error."
  it('gets no sampling params, directly and on OpenRouter', () => {
    expect(canonicalModelId(OR_SONNET)).toBe(SONNET);
    expect(modelRejectsSamplingParams(SONNET)).toBe(true);
    expect(modelRejectsSamplingParams(OR_SONNET)).toBe(true);
  });

  // Effort low / medium / high / xhigh / max, default high; /thinking auto sends nothing.
  it('takes every effort tier on Anthropic, and nothing on Auto', () => {
    expect(modelSupportsReasoningEffort('anthropic', SONNET)).toBe(true);
    expect(availableReasoningTiers('anthropic', SONNET)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
    expect(reasoningParamsFor('anthropic', SONNET, 'auto')).toEqual({});
    for (const tier of ['low', 'medium', 'high', 'max'] as const) {
      expect(reasoningParamsFor('anthropic', SONNET, tier), tier).toEqual({ output_config: { effort: tier } });
    }
  });

  // OpenRouter's /api/v1/models lists supported_efforts max/xhigh/high/medium/low for it.
  it('goes to "max" at the Max tier on OpenRouter', () => {
    expect(reasoningParamsFor('openrouter', OR_SONNET, 'max')).toEqual({ reasoning: { effort: 'max' } });
    expect(reasoningParamsFor('openrouter', OR_SONNET, 'medium')).toEqual({ reasoning: { effort: 'medium' } });
    expect(availableReasoningTiers('openrouter', OR_SONNET)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
  });

  it('keeps every listed tier distinct (drift guard)', () => {
    for (const [pid, model] of [['anthropic', SONNET], ['openrouter', OR_SONNET]]) {
      const tiers = availableReasoningTiers(pid, model).filter(t => t !== 'auto');
      const params = tiers.map(t => JSON.stringify(reasoningParamsFor(pid, model, t)));
      expect(new Set(params).size, `${pid}/${model}`).toBe(tiers.length);
    }
  });

  // Thinking is on by default at effort high and spends max_tokens with the answer.
  it('gets the 32K response floor, 64K at Max, directly and on OpenRouter — and Sonnet 5 does not', () => {
    expect(minResponseTokensFor(SONNET, 'auto')).toBe(32_768);
    expect(minResponseTokensFor(SONNET, undefined)).toBe(32_768);
    expect(minResponseTokensFor(SONNET, 'high')).toBe(32_768);
    expect(minResponseTokensFor(SONNET, 'max')).toBe(65_536);
    expect(minResponseTokensFor(OR_SONNET, 'auto')).toBe(32_768);
    expect(minResponseTokensFor(OR_SONNET, 'max')).toBe(65_536);
    expect(minResponseTokensFor('claude-sonnet-5', 'max')).toBe(0);
    expect(minResponseTokensFor('anthropic/claude-sonnet-5', 'auto')).toBe(0);
    expect(minResponseTokensFor('claude-sonnet-4-6', 'max')).toBe(0);
  });

  it('has its own context and price rows, not the Sonnet 5 fallback by accident', () => {
    expect(getModelContextWindow(SONNET)).toBe(1_000_000);
    expect(getPricingTable().find(m => m.model === SONNET)).toEqual({ model: SONNET, inputPer1M: 2, outputPer1M: 10 });
  });
});

// Claude Haiku 5.5, released 2026-10-07 (platform.claude.com Haiku 5.5
// overview, What's new, migration guide, effort and pricing pages, read
// 2026-10-09). Every value is asserted on its own and through OpenRouter's
// dotted id. The `claude-haiku-4-5` family is the trap: the effort gate is an
// allowlist of families, and none of them matches `claude-haiku-5-5`.
describe('Claude Haiku 5.5', () => {
  const HAIKU = 'claude-haiku-5-5';
  const HAIKU_4 = 'claude-haiku-4-5-20251001';
  const OR_HAIKU = 'anthropic/claude-haiku-5.5';

  it('is the Haiku in the Anthropic picker, directly above Haiku 4.5, which stays unmigrated', () => {
    const models = PROVIDERS['anthropic'].models;
    const ids = models.map(m => m.id);
    expect(ids.indexOf(HAIKU)).toBeGreaterThan(-1);
    expect(ids.indexOf(HAIKU_4)).toBe(ids.indexOf(HAIKU) + 1);
    const haiku55 = models.find(m => m.id === HAIKU)!;
    expect(haiku55.name).toBe('Claude Haiku 5.5');
    // The picker states the tier: no other Claude model here is priced by prompt length.
    expect(haiku55.description).toMatch(/\$0\.10\/\$0\.50/);
    expect(haiku55.description).toMatch(/over 100K tokens \$0\.50\/\$2\.50/);
    const haiku45 = models.find(m => m.id === HAIKU_4)!;
    expect(haiku45.name).toBe('Claude Haiku 4.5');
    expect(haiku45.description).toBe('Previous Haiku — kept for pinned configs');
    // Haiku 4.5 is still Active, so nothing moves a config off it — and a
    // source in the migration map must never be a model the provider offers.
    expect(replacementModelFor('anthropic', HAIKU_4)).toBeUndefined();
    expect(replacementModelFor('anthropic', 'claude-haiku-4-5')).toBeUndefined();
    expect(replacementModelFor('anthropic', HAIKU)).toBeUndefined();
    expect(replacementModelFor('openrouter', 'anthropic/claude-haiku-4.5')).toBeUndefined();
    // Not a default for anyone: the overview still says to start with Opus 5.5.
    expect(PROVIDERS['anthropic'].defaultModel).toBe('claude-opus-5-5');
  });

  it('is in the OpenRouter fallback under the dotted id OpenRouter lists, not the hyphenated one', () => {
    const models = getProvider('openrouter')!.models;
    const ids = models.map(m => m.id);
    expect(ids).toContain(OR_HAIKU);
    expect(ids).not.toContain('anthropic/claude-haiku-5-5');
    // After the Sonnets, with the rest of the Anthropic block.
    expect(ids.indexOf(OR_HAIKU)).toBe(ids.indexOf('anthropic/claude-sonnet-5') + 1);
    expect(models.find(m => m.id === OR_HAIKU)!.name).toBe('Claude Haiku 5.5');
  });

  // "If a request includes temperature, it must be 1 ... top_p ... 0.99 ... Any
  // other value returns a 400 error. So does any top_k value."
  it('gets no sampling params, directly and on OpenRouter — and Haiku 4.5 still does', () => {
    expect(canonicalModelId(OR_HAIKU)).toBe(HAIKU);
    expect(modelRejectsSamplingParams(HAIKU)).toBe(true);
    expect(modelRejectsSamplingParams(OR_HAIKU)).toBe(true);
    expect(modelRejectsSamplingParams(HAIKU_4)).toBe(false);
    expect(modelRejectsSamplingParams('claude-haiku-4-5')).toBe(false);
    expect(modelRejectsSamplingParams('anthropic/claude-haiku-4.5')).toBe(false);
  });

  // The allowlist trap: `claude-haiku-5-5` matches none of opus-5, opus-4-x,
  // sonnet-4-6/5 or fable-5, so without its own entry /thinking is hidden.
  it('takes the thinking control, which the family allowlist would have missed — Haiku 4.5 does not', () => {
    expect(modelSupportsReasoningEffort('anthropic', HAIKU)).toBe(true);
    expect(modelSupportsReasoningEffort('anthropic', OR_HAIKU)).toBe(true);
    expect(modelSupportsReasoningEffort('anthropic', HAIKU_4)).toBe(false);
    expect(modelSupportsReasoningEffort('anthropic', 'claude-haiku-4-5')).toBe(false);
    expect(modelSupportsReasoningEffort('anthropic', 'anthropic/claude-haiku-4.5')).toBe(false);
    // OpenRouter exposes the control for everything.
    expect(modelSupportsReasoningEffort('openrouter', OR_HAIKU)).toBe(true);
  });

  // Effort low / medium / high / xhigh / max, default medium; Auto sends nothing.
  it('takes every effort tier on Anthropic, and nothing on Auto', () => {
    expect(availableReasoningTiers('anthropic', HAIKU)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
    expect(availableReasoningTiers('anthropic', HAIKU_4)).toEqual([]);
    expect(reasoningParamsFor('anthropic', HAIKU, 'auto')).toEqual({});
    for (const tier of ['low', 'medium', 'high', 'max'] as const) {
      expect(reasoningParamsFor('anthropic', HAIKU, tier), tier).toEqual({ output_config: { effort: tier } });
    }
    expect(reasoningParamsFor('anthropic', HAIKU_4, 'high')).toEqual({});
  });

  // OpenRouter's /api/v1/models lists supported_efforts max/xhigh/high/medium/low
  // for it (read 2026-10-09); the Max tier goes as high as the model lists.
  it('goes to "max" at the Max tier on OpenRouter, where Haiku 4.5 stays at "high"', () => {
    expect(reasoningParamsFor('openrouter', OR_HAIKU, 'max')).toEqual({ reasoning: { effort: 'max' } });
    expect(reasoningParamsFor('openrouter', OR_HAIKU, 'medium')).toEqual({ reasoning: { effort: 'medium' } });
    expect(availableReasoningTiers('openrouter', OR_HAIKU)).toEqual(['auto', 'low', 'medium', 'high', 'max']);
    expect(reasoningParamsFor('openrouter', 'anthropic/claude-haiku-4.5', 'max')).toEqual({ reasoning: { effort: 'high' } });
    expect(availableReasoningTiers('openrouter', 'anthropic/claude-haiku-4.5')).toEqual(['auto', 'low', 'medium', 'high']);
  });

  it('keeps every listed tier distinct (drift guard)', () => {
    for (const [pid, model] of [['anthropic', HAIKU], ['openrouter', OR_HAIKU]]) {
      const tiers = availableReasoningTiers(pid, model).filter(t => t !== 'auto');
      const params = tiers.map(t => JSON.stringify(reasoningParamsFor(pid, model, t)));
      expect(new Set(params).size, `${pid}/${model}`).toBe(tiers.length);
    }
  });

  // "Thinking tokens count toward max_tokens, so a small limit can stop after a
  // thinking block and before any text."
  it('gets the 32K response floor, 64K at Max, directly and on OpenRouter — and Haiku 4.5 does not', () => {
    expect(minResponseTokensFor(HAIKU, 'auto')).toBe(32_768);
    expect(minResponseTokensFor(HAIKU, undefined)).toBe(32_768);
    expect(minResponseTokensFor(HAIKU, 'high')).toBe(32_768);
    expect(minResponseTokensFor(HAIKU, 'max')).toBe(65_536);
    expect(minResponseTokensFor(OR_HAIKU, 'auto')).toBe(32_768);
    expect(minResponseTokensFor(OR_HAIKU, 'max')).toBe(65_536);
    expect(minResponseTokensFor(HAIKU_4, 'max')).toBe(0);
    expect(minResponseTokensFor('claude-haiku-4-5', 'auto')).toBe(0);
    expect(minResponseTokensFor('anthropic/claude-haiku-4.5', 'auto')).toBe(0);
    // Exact, like the Sonnet floor: the family name alone does not take it in.
    expect(minResponseTokensFor('claude-haiku-5', 'max')).toBe(0);
  });

  it('has its own context and price rows, the tier included, not a fallback by accident', () => {
    expect(getModelContextWindow(HAIKU)).toBe(1_000_000);
    expect(getModelContextWindow(OR_HAIKU)).toBe(1_000_000);
    expect(getModelContextWindow(HAIKU_4)).toBe(200_000);
    expect(getPricingTable().find(m => m.model === HAIKU)).toEqual({
      model: HAIKU,
      inputPer1M: 0.1,
      outputPer1M: 0.5,
      longPrompt: { overTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5 },
    });
    // Haiku 4.5 keeps its flat $1/$5, with no tier.
    expect(getPricingTable().find(m => m.model === HAIKU_4)).toEqual({ model: HAIKU_4, inputPer1M: 1, outputPer1M: 5 });
  });
});
