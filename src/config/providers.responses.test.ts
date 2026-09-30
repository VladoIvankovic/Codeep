/**
 * Which endpoint an OpenAI-protocol agent turn goes to, and what the thinking
 * tier becomes there. The Responses API is ON as shipped (the default is
 * 'auto' since the owner's live verification run of 2026-09-26); these pin
 * that default, the routing table behind the switch, and the wire-keyed rules
 * that still hold on Chat Completions (proxies, the 'chat' kill switch) for
 * GPT-6 Sol/Luna and Astra.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PROVIDERS,
  REASONING_TIERS,
  DEFAULT_OPENAI_WIRE_API,
  openAIWireApi,
  openAIWireSetting,
  responsesDialectFor,
  responsesMaxOutputTokens,
  reasoningParamsFor,
  toolsForceReasoningOff,
  agentTurnReasoningNote,
  chatCompletionsCannotCallTools,
  agentToolsNote,
} from './providers';

const OFFICIAL = 'https://api.openai.com/v1';
const envBefore = process.env.CODEEP_OPENAI_WIRE_API;

beforeEach(() => { delete process.env.CODEEP_OPENAI_WIRE_API; });
afterEach(() => {
  if (envBefore === undefined) delete process.env.CODEEP_OPENAI_WIRE_API;
  else process.env.CODEEP_OPENAI_WIRE_API = envBefore;
});

describe('the shipped switch', () => {
  // The owner's live run (2026-09-26, utils/__fixtures__/responses/recorded):
  // Astra called tools over Responses, Sol at effort high called two at once,
  // and replayed reasoning was accepted under store:false. So an unset switch
  // now sends both GPT-6 models there — and nothing else changes: a proxy and
  // the 'chat' kill switch stay on Chat Completions.
  it('is auto: GPT-6.1 Sol, GPT-6 Sol and Astra go over Responses with nothing set', () => {
    expect(DEFAULT_OPENAI_WIRE_API).toBe('auto');
    expect(openAIWireSetting(undefined)).toBe('auto');
    for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']) {
      expect(openAIWireApi('openai', model, OFFICIAL, openAIWireSetting(undefined)), model).toBe('responses');
      // The default parameter is the shipped default too.
      expect(openAIWireApi('openai', model, OFFICIAL), model).toBe('responses');
      expect(openAIWireApi('openai', model, 'https://litellm.internal/v1', openAIWireSetting(undefined)), model).toBe('chat');
      expect(openAIWireApi('openai', model, OFFICIAL, openAIWireSetting('chat')), model).toBe('chat');
    }
  });

  // 'auto' sends only catalogue models over Responses, and GPT-6.1 Sol calls
  // no tools on Chat Completions: the default must be listed, or its agent
  // turns would quietly lose native tool calls.
  it('sends the OpenAI default, GPT-6.1 Sol, over Responses at the official URL and a proxy to Chat Completions', () => {
    const model = PROVIDERS.openai.defaultModel;
    expect(model).toBe('gpt-6.1-sol');
    expect(openAIWireApi('openai', model, OFFICIAL)).toBe('responses');
    expect(openAIWireApi('openai', model, `${OFFICIAL}/`, 'auto')).toBe('responses');
    expect(openAIWireApi('openai', model, 'https://litellm.internal/v1')).toBe('chat');
    expect(openAIWireApi('openai', model, 'https://litellm.internal/v1', 'responses')).toBe('responses');
    expect(openAIWireApi('openai', model, OFFICIAL, 'chat')).toBe('chat');
  });

  it('takes the config value, lets CODEEP_OPENAI_WIRE_API override it, and ignores nonsense', () => {
    expect(openAIWireSetting('auto')).toBe('auto');
    expect(openAIWireSetting(' Responses ')).toBe('responses');
    expect(openAIWireSetting('yes please')).toBe(DEFAULT_OPENAI_WIRE_API);
    process.env.CODEEP_OPENAI_WIRE_API = 'chat';
    expect(openAIWireSetting('responses')).toBe('chat');
    process.env.CODEEP_OPENAI_WIRE_API = 'bogus';
    expect(openAIWireSetting('auto')).toBe('auto');
  });
});

describe('openAIWireApi', () => {
  it('sends openai at its official URL over Responses under auto, trailing slash or not', () => {
    expect(openAIWireApi('openai', 'gpt-6-sol', OFFICIAL, 'auto')).toBe('responses');
    expect(openAIWireApi('openai', 'gpt-5.6-luna', `${OFFICIAL}/`, 'auto')).toBe('responses');
  });

  it('keeps an OPENAI_BASE_URL proxy on Chat Completions unless Responses is forced', () => {
    const proxy = 'https://my-resource.openai.azure.com/openai/v1';
    expect(openAIWireApi('openai', 'gpt-6-sol', proxy, 'auto')).toBe('chat');
    expect(openAIWireApi('openai', 'gpt-6-sol', proxy, 'responses')).toBe('responses');
  });

  it('stays on Chat Completions everywhere when the switch says chat', () => {
    expect(openAIWireApi('openai', 'gpt-6-sol', OFFICIAL, 'chat')).toBe('chat');
  });

  it('sends every model in the OpenAI catalogue over Responses under auto', () => {
    for (const { id } of PROVIDERS.openai.models) {
      expect(openAIWireApi('openai', id, OFFICIAL, 'auto'), id).toBe('responses');
    }
  });

  // An old config, a saved profile or an ACP client can still name a model
  // Codeep does not offer. GPT-4.1/4o are not reasoning models (the 32K
  // Responses floor is above GPT-4o's output limit), and Chat Completions is
  // where they work today.
  it('keeps a model id the catalogue does not list on Chat Completions under auto, unless Responses is forced', () => {
    for (const id of ['gpt-4.1', 'gpt-4o', 'gpt-6-sol-2026-08-01', 'my-finetune']) {
      expect(openAIWireApi('openai', id, OFFICIAL, 'auto'), id).toBe('chat');
      expect(openAIWireApi('openai', id, OFFICIAL, 'responses'), id).toBe('responses');
    }
  });

  it('never moves any other provider, even forced — grok included, until its own verification', () => {
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      if (id === 'openai') continue;
      const url = provider.protocols.openai?.baseUrl ?? '';
      for (const setting of ['auto', 'responses'] as const) {
        expect(openAIWireApi(id, provider.defaultModel, url, setting), `${id} ${setting}`).toBe('chat');
      }
    }
    expect(responsesDialectFor('grok')).toBeNull();
    expect(responsesDialectFor('openai')).toBe('openai');
  });
});

describe('the thinking tier over Responses', () => {
  it('sends reasoning.effort from the same ladder', () => {
    expect(reasoningParamsFor('openai', 'gpt-6-sol', 'high', { wire: 'responses' })).toEqual({ reasoning: { effort: 'high' } });
    expect(reasoningParamsFor('openai', 'gpt-6-sol', 'max', { wire: 'responses' })).toEqual({ reasoning: { effort: 'max' } });
    expect(reasoningParamsFor('openai', 'gpt-5.5', 'max', { wire: 'responses' })).toEqual({ reasoning: { effort: 'xhigh' } });
    expect(reasoningParamsFor('openai', 'gpt-6-sol', 'auto', { wire: 'responses' })).toEqual({});
  });

  it('applies to GPT-6 Sol/Luna agent turns with tools — the "none" rule is Chat Completions only', () => {
    for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
      expect(reasoningParamsFor('openai', model, 'high', { tools: true, wire: 'responses' }), model)
        .toEqual({ reasoning: { effort: 'high' } });
      expect(toolsForceReasoningOff('openai', model, 'responses'), model).toBe(false);
      expect(agentTurnReasoningNote('openai', model, 'responses'), model).toBeNull();
    }
  });

  it('still forces "none" with tools on the chat wire (kill switch, proxies)', () => {
    expect(reasoningParamsFor('openai', 'gpt-6-sol', 'high', { tools: true, wire: 'chat' })).toEqual({ reasoning_effort: 'none' });
    expect(toolsForceReasoningOff('openai', 'gpt-6-luna', 'chat')).toBe(true);
    expect(agentTurnReasoningNote('openai', 'gpt-6-sol', 'chat')).toMatch(/reasoning_effort "none"/);
  });

  it('says Astra cannot call tools only where its agent turns really go over Chat Completions', () => {
    expect(chatCompletionsCannotCallTools('openai', 'gpt-6-astra', 'chat')).toBe(true);
    expect(agentToolsNote('openai', 'gpt-6-astra', 'chat')).toMatch(/cannot call tools over Chat Completions/);
    expect(agentToolsNote('openai', 'gpt-6-astra', 'chat')).toMatch(/text tool format/);
    // Over Responses it calls tools (live run, 2026-09-26).
    expect(chatCompletionsCannotCallTools('openai', 'gpt-6-astra', 'responses')).toBe(false);
    expect(agentToolsNote('openai', 'gpt-6-astra', 'responses')).toBeNull();
    // Sol and Luna call tools on Chat Completions (with effort "none"); other
    // GPTs call them anywhere; OpenRouter may reach Responses upstream.
    for (const [provider, model] of [['openai', 'gpt-6-sol'], ['openai', 'gpt-6-luna'], ['openai', 'gpt-5.6-sol'], ['openrouter', 'openai/gpt-6-astra']]) {
      expect(agentToolsNote(provider, model, 'chat'), `${provider} ${model}`).toBeNull();
    }
  });

  // "Use the Responses API for tool calling. Chat Completions is supported
  // without tool calling." (models/gpt-6.1-sol) — Astra's case, so Astra's notice.
  it('says GPT-6.1 Sol cannot call tools only where its agent turns go over Chat Completions, and names gpt-6-sol as the way out', () => {
    expect(chatCompletionsCannotCallTools('openai', 'gpt-6.1-sol', 'chat')).toBe(true);
    expect(chatCompletionsCannotCallTools('openai', 'gpt-6.1-sol')).toBe(true);
    const note = agentToolsNote('openai', 'gpt-6.1-sol', 'chat')!;
    expect(note).toMatch(/^gpt-6\.1-sol cannot call tools over Chat Completions/);
    expect(note).toContain('text tool format');
    expect(note).toContain('pick GPT-6 Sol (gpt-6-sol), which calls tools there with reasoning off.');
    expect(chatCompletionsCannotCallTools('openai', 'gpt-6.1-sol', 'responses')).toBe(false);
    expect(agentToolsNote('openai', 'gpt-6.1-sol', 'responses')).toBeNull();
    // OpenRouter may reach Responses upstream; the pinned GPT-6 Sol calls
    // tools on Chat Completions (with effort "none").
    expect(chatCompletionsCannotCallTools('openrouter', 'openai/gpt-6.1-sol', 'chat')).toBe(false);
    expect(chatCompletionsCannotCallTools('openai', 'gpt-6-sol', 'chat')).toBe(false);
  });

  it('never sends GPT-6.1 Sol "none" with tools, on either wire, at any tier', () => {
    for (const wire of ['chat', 'responses'] as const) {
      for (const tier of REASONING_TIERS) {
        expect(JSON.stringify(reasoningParamsFor('openai', 'gpt-6.1-sol', tier, { tools: true, wire })), `${wire} ${tier}`)
          .not.toContain('none');
      }
    }
  });

  it('never sends Astra "none", on either wire, at any tier', () => {
    for (const wire of ['chat', 'responses'] as const) {
      for (const tier of REASONING_TIERS) {
        expect(JSON.stringify(reasoningParamsFor('openai', 'gpt-6-astra', tier, { tools: true, wire })), `${wire} ${tier}`)
          .not.toContain('none');
      }
    }
  });
});

describe('responsesMaxOutputTokens', () => {
  it('floors at 32K, 64K at Max, and keeps a larger configured budget', () => {
    expect(responsesMaxOutputTokens(4096, 'high')).toBe(32_768);
    expect(responsesMaxOutputTokens(4096, 'auto')).toBe(32_768);
    expect(responsesMaxOutputTokens(4096, 'max')).toBe(65_536);
    expect(responsesMaxOutputTokens(100_000, 'medium')).toBe(100_000);
  });
});
