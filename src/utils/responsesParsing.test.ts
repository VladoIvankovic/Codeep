/**
 * Responses API replies → what the agent and the token tracker use: function
 * calls with their call_id (and the ones that cannot run), and usage in the
 * tracker's terms.
 */

import { describe, it, expect } from 'vitest';
import { parseResponsesFunctionCalls, parseOpenAIToolCalls } from './toolParsing';
import { extractResponsesUsage, responsesReportedCost, extractOpenAIUsage } from './tokenTracker';

describe('parseResponsesFunctionCalls', () => {
  it('uses the call_id as the id — never the fc_ item id', () => {
    const { toolCalls, rejected } = parseResponsesFunctionCalls([
      { call_id: 'call_A', name: 'read_file', arguments: '{"path":"a.txt"}' },
    ]);
    expect(toolCalls).toEqual([{ tool: 'read_file', parameters: { path: 'a.txt' }, id: 'call_A' }]);
    expect(rejected).toEqual([]);
  });

  it('returns a call it cannot run, with the reason, instead of dropping it', () => {
    const { toolCalls, rejected } = parseResponsesFunctionCalls([
      { call_id: 'call_M', name: 'read_file', arguments: '{"path": ' },
      { call_id: 'call_N', name: 'list_files', arguments: 'null' },
      { call_id: 'call_P', name: 'edit_file', arguments: '{"path":"x"}' },
    ]);
    expect(toolCalls).toEqual([]);
    expect(rejected).toEqual([
      { call_id: 'call_M', name: 'read_file', reason: 'its arguments are not valid JSON' },
      { call_id: 'call_N', name: 'list_files', reason: 'its arguments are not a JSON object' },
      { call_id: 'call_P', name: 'edit_file', reason: 'edit_file needs "path", "old_text" and "new_text"' },
    ]);
  });

  it('keeps the Chat Completions parser as it was: unparseable calls are skipped there', () => {
    expect(parseOpenAIToolCalls([
      { id: 'c1', function: { name: 'read_file', arguments: '{"path": ' } },
      { id: 'c2', function: { name: 'read_file', arguments: '{"path":"ok"}' } },
    ])).toEqual([{ tool: 'read_file', parameters: { path: 'ok' }, id: 'c2' }]);
  });
});

describe('extractResponsesUsage', () => {
  it('openai with details: cached and written tokens are part of input_tokens', () => {
    expect(extractResponsesUsage({ usage: {
      input_tokens: 1200, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
      output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 1500,
    } })).toEqual({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
      cacheCreationTokens: 128, cacheReadTokens: 1024, reasoningTokens: 200,
    });
  });

  it('openai without details counts nothing as cached', () => {
    expect(extractResponsesUsage({ usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } })).toEqual({
      promptTokens: 50, completionTokens: 10, totalTokens: 60,
      cacheCreationTokens: undefined, cacheReadTokens: undefined, reasoningTokens: undefined,
    });
  });

  it('returns null for usage: null (created, failed)', () => {
    expect(extractResponsesUsage({ usage: null })).toBeNull();
    expect(extractResponsesUsage(null)).toBeNull();
  });

  it('is not what extractOpenAIUsage reads — that would record a Responses turn as zero', () => {
    const response = { usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } };
    expect(extractOpenAIUsage(response)?.promptTokens).toBe(0);
    expect(extractResponsesUsage(response)?.promptTokens).toBe(50);
  });

  it('xai: adds reasoning when the total shows it was reported separately', () => {
    expect(extractResponsesUsage({ usage: {
      input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 200,
    } }, 'xai')).toMatchObject({ promptTokens: 100, completionTokens: 100, totalTokens: 200, reasoningTokens: 80 });
  });

  it('xai: takes output_tokens whole when it already includes reasoning, and reads Chat-style keys', () => {
    expect(extractResponsesUsage({ usage: {
      input_tokens: 100, output_tokens: 100, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 200,
    } }, 'xai')).toMatchObject({ completionTokens: 100, totalTokens: 200 });
    expect(extractResponsesUsage({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }, 'xai'))
      .toMatchObject({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it('prices an xai call from cost_in_usd_ticks, and never an openai one', () => {
    expect(responsesReportedCost({ usage: { cost_in_usd_ticks: 25_000_000 } }, 'xai')).toBeCloseTo(0.0025, 10);
    expect(responsesReportedCost({ usage: { cost_in_usd_ticks: 25_000_000 } }, 'openai')).toBeUndefined();
    expect(responsesReportedCost({ usage: {} }, 'xai')).toBeUndefined();
  });
});
