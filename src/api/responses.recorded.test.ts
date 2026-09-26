/**
 * The Responses parser against what OpenAI really sent.
 *
 * The streams in utils/__fixtures__/responses/recorded/ are the owner's live
 * run of 2026-09-26 (scripts/record-responses-fixture.mjs, the owner's own key,
 * `store: false`): GPT-6 Astra and Sol calling a read_file tool, Sol making two
 * calls at once, Astra reasoning before its call. They go through the real
 * parser here, byte for byte as saved, and these are the transport's
 * regression tests against reality — the hand-built fixtures next to them are
 * the documented shape, and where the two differ the recording wins.
 *
 * The recorder truncated every `encrypted_content` to its first 32 characters
 * plus a "[truncated N chars]" marker, so no test here can see the bytes that
 * went over the wire — only which serialization of the item was kept. That
 * turned out to matter: OpenAI encrypts reasoning afresh for
 * `output_item.added` (a shorter token), for `output_item.done` and again for
 * `response.completed`, and the live replay that was accepted used the `.done`
 * one (whether the other two would be accepted is untested). The ids and
 * those 32-character heads are literals below, so a re-recording means
 * updating them; the replay pins in utils/responsesLoop.test.ts read the files
 * and survive one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseResponsesSSE, type ResponsesItem } from './responses';
import { extractResponsesUsage } from '../utils/tokenTracker';

const RECORDED = join(__dirname, '..', 'utils', '__fixtures__', 'responses', 'recorded');
const recorded = (name: string) => readFileSync(join(RECORDED, name), 'utf-8');

/** The saved stream's events, parsed independently of the code under test. */
function events(name: string): Array<Record<string, unknown>> {
  return recorded(name).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
}

function terminal(name: string): Record<string, unknown> {
  const done = events(name).find(e => e.type === 'response.completed');
  return done!.response as Record<string, unknown>;
}

async function parse(name: string) {
  const chunks: string[] = [];
  const turn = await parseResponsesSSE(recorded(name), { onChunk: c => chunks.push(c) });
  return { turn, chunks };
}

const encrypted = (item: ResponsesItem | undefined) => String(item?.encrypted_content ?? '');

describe('GPT-6 Astra reasoning, then a call (astra-reason.1)', () => {
  it('keeps the reasoning item and the call, in output order, and reads the call whole', async () => {
    const { turn, chunks } = await parse('astra-reason.1.sse');
    expect(turn.status).toBe('completed');
    expect(turn.text).toBe('');
    expect(chunks).toEqual([]);
    expect(turn.items.map(i => i.type)).toEqual(['reasoning', 'function_call']);
    expect(turn.items[0]).toMatchObject({ id: 'rs_04a30dc100b3803f016ab7bb38971887d2960fd68d7989fb1b', content: [], summary: [] });
    expect(turn.functionCalls).toEqual([{
      call_id: 'call_dSoZY8BR75aoV8dAoujbiykn',
      name: 'read_file',
      arguments: '{"path":"p17.txt"}',
      itemId: 'fc_04a30dc100b3803f016ab7bb3905b087d2b5bd1230500b4ee1',
    }]);
    // 391 = 17 × 23: it worked the number out before calling.
    expect(turn.usage).toMatchObject({ output_tokens_details: { reasoning_tokens: 17 } });
  });

  // The replay that OpenAI accepted (astra-reason.2) carried the `.done`
  // serialization. `.added` carries a shorter token, and response.completed a
  // third encryption of the same reasoning.
  it('replays the reasoning as output_item.done carried it — not .added, not response.completed', async () => {
    const { turn } = await parse('astra-reason.1.sse');
    const all = events('astra-reason.1.sse');
    const reasoningFrom = (type: string) => (all.find(e => e.type === type && (e.item as ResponsesItem).type === 'reasoning')!.item) as ResponsesItem;
    const fromDone = encrypted(reasoningFrom('response.output_item.done'));
    expect(fromDone).not.toBe(encrypted(reasoningFrom('response.output_item.added')));
    expect(fromDone).not.toBe(encrypted((terminal('astra-reason.1.sse').output as ResponsesItem[])[0]));
    expect(encrypted(turn.items[0])).toBe(fromDone);
    const accepted = (JSON.parse(recorded('astra-reason.2.request.json')).body.input as ResponsesItem[]).find(i => i.type === 'reasoning');
    expect(encrypted(turn.items[0])).toBe(encrypted(accepted));
  });
});

describe('GPT-6 Sol at effort high, reasoning then a call (sol-reason.1)', () => {
  it('keeps the reasoning item and the call, the reasoning as .done carried it', async () => {
    const { turn } = await parse('sol-reason.1.sse');
    expect(turn.status).toBe('completed');
    expect(turn.items.map(i => i.type)).toEqual(['reasoning', 'function_call']);
    expect(turn.items[0].id).toBe('rs_01869a298289b959016ab7bb3dbaa487d28d61f7a5fc0c1c02');
    expect(encrypted(turn.items[0])).toMatch(/^gAAAAABqt7s9VKvi41BB6SPL6ZAe-5mN/);
    expect(turn.functionCalls).toEqual([{
      call_id: 'call_2MyZkViEoidpHyIMgEscSvsd',
      name: 'read_file',
      arguments: '{"path":"p17.txt"}',
      itemId: 'fc_01869a298289b959016ab7bb3dff5087d283f3f6d15c40e39b',
    }]);
    expect(turn.usage).toMatchObject({ output_tokens_details: { reasoning_tokens: 24 } });
    expect(turn.rawResponse?.reasoning).toMatchObject({ effort: 'high' });
  });
});

describe('GPT-6 Sol at effort high, two calls at once (sol-high-tools.1)', () => {
  // The interim Chat Completions rule sent Sol "none" whenever tools went out.
  // Over Responses it called both tools, in parallel, at effort high.
  it('returns both calls, in output order, each with its own call_id and item id', async () => {
    const { turn } = await parse('sol-high-tools.1.sse');
    expect(turn.status).toBe('completed');
    expect(turn.rawResponse?.reasoning).toMatchObject({ effort: 'high' });
    expect(turn.items.map(i => i.type)).toEqual(['function_call', 'function_call']);
    expect(turn.functionCalls).toEqual([
      { call_id: 'call_NIG85k8uBizp2b0scokI0HAi', name: 'read_file', arguments: '{"path":"notes.txt"}', itemId: 'fc_025cb3c2c5529141016ab7b41d87bc87d2a4659d2593686c93' },
      { call_id: 'call_bTAMFj4LPZOvFhbTISaiCRDs', name: 'read_file', arguments: '{"path":"todo.txt"}', itemId: 'fc_025cb3c2c5529141016ab7b41d87cc87d282d8e17431b4ed04' },
    ]);
  });

  it('keeps every item exactly as response.completed lists it', async () => {
    const { turn } = await parse('sol-high-tools.1.sse');
    expect(turn.items).toEqual(terminal('sol-high-tools.1.sse').output);
  });
});

describe('GPT-6 Astra on its default effort (astra-auto)', () => {
  it('streams the final answer from its deltas, once, and keeps the message with its phase', async () => {
    const { turn, chunks } = await parse('astra-auto.2.sse');
    expect(turn.status).toBe('completed');
    expect(turn.text).toBe('PELICAN');
    expect(chunks.join('')).toBe('PELICAN');
    expect(turn.functionCalls).toEqual([]);
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0]).toMatchObject({
      id: 'msg_012c705439a0fa89016ab7b417764487d2a1d97b5fab569e45',
      type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
    });
    expect(turn.items).toEqual(terminal('astra-auto.2.sse').output);
  });

  // Question (c) of the live run: the request sent no `reasoning` at all.
  it('ran at medium effort with reasoning context all_turns — what /thinking auto means on Astra', async () => {
    const request = JSON.parse(recorded('astra-auto.1.request.json')).body;
    expect(request).not.toHaveProperty('reasoning');
    for (const name of ['astra-auto.1.sse', 'astra-auto.2.sse']) {
      const { turn } = await parse(name);
      expect(turn.rawResponse?.reasoning, name).toMatchObject({ effort: 'medium', context: 'all_turns' });
    }
  });
});

describe('usage on every recorded model (question d)', () => {
  const streams = readdirSync(RECORDED).filter(f => f.endsWith('.sse')).sort();

  it('has the recordings to cover (13 streams on 2026-09-26)', () => {
    expect(streams.length).toBeGreaterThanOrEqual(13);
  });

  // All three detail fields arrive on every model. Their counts are zero here
  // except reasoning (17 and 24 on the reason scenarios) — these requests were
  // too small for the cache — so the cache-read and cache-write paths are pinned
  // for presence only.
  it('carries cached_tokens, cache_write_tokens and reasoning_tokens, and the tracker reads them', async () => {
    for (const name of streams) {
      const { turn } = await parse(name);
      const usage = turn.usage as Record<string, Record<string, unknown>>;
      expect(usage.input_tokens_details, name).toHaveProperty('cached_tokens');
      expect(usage.input_tokens_details, name).toHaveProperty('cache_write_tokens');
      expect(usage.output_tokens_details, name).toHaveProperty('reasoning_tokens');
      const read = extractResponsesUsage(turn.rawResponse, 'openai')!;
      expect(read.promptTokens, name).toBe(usage.input_tokens);
      expect(read.completionTokens, name).toBe(usage.output_tokens);
      expect(read.totalTokens, name).toBe(usage.total_tokens);
    }
    const { turn } = await parse('astra-reason.1.sse');
    expect(extractResponsesUsage(turn.rawResponse, 'openai')).toMatchObject({ promptTokens: 120, completionTokens: 39, totalTokens: 159, reasoningTokens: 17 });
  });
});

describe('the recordings themselves', () => {
  // They were made with the owner's key; the recorder redacts it. Keep it out.
  it('hold no API key and no auth header', () => {
    for (const name of readdirSync(RECORDED)) {
      const text = recorded(name);
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
      expect(text.toLowerCase(), name).not.toContain('authorization');
      expect(text.toLowerCase(), name).not.toContain('bearer ');
    }
  });
});
