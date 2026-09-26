/**
 * The Responses API transport's pure layer: the SSE parser, the input builder
 * and pair normaliser, the tool conversion and the request body.
 *
 * The .sse fixtures in utils/__fixtures__/responses/ are hand-built from the
 * documented event stream (response.created → output_item.added/done,
 * output_text.delta, reasoning_summary_text.delta, function_call_arguments.*,
 * response.completed / incomplete / failed, error). The owner's recording run
 * (scripts/record-responses-fixture.mjs) saves real streams next to them under
 * recorded/; where the two differ, the recorded shape wins.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseResponsesSSE,
  parseResponsesJSON,
  buildResponsesInput,
  buildResponsesBody,
  normalizePairs,
  toResponsesTools,
  responsesErrorStatus,
  NOT_EXECUTED_OUTPUT,
  type NativeTurn,
  type ResponsesItem,
} from './responses';
import { ApiError } from './index';
import { ResponsesRunState } from '../utils/responsesRunState';
import { extractResponsesUsage } from '../utils/tokenTracker';
import type { Message } from '../config/index';

const FIXTURES = join(__dirname, '..', 'utils', '__fixtures__', 'responses');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

/** A fetch-like body that delivers `text` in `size`-byte pieces. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function parse(name: string, size?: number) {
  const chunks: string[] = [];
  const body = size ? chunked(fixture(name), size) : fixture(name);
  const turn = await parseResponsesSSE(body, { onChunk: c => chunks.push(c) });
  return { turn, chunks };
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  return expect.unreachable('expected the parse to reject');
}

describe('parseResponsesSSE', () => {
  it('streams text deltas and reads a final message (text-only)', async () => {
    const { turn, chunks } = await parse('text-only.sse');
    expect(chunks).toEqual(['Hello', ', ', 'world.']);
    expect(turn.text).toBe('Hello, world.');
    expect(turn.functionCalls).toEqual([]);
    expect(turn.status).toBe('completed');
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0]).toMatchObject({ type: 'message', phase: 'final_answer' });
  });

  it('records usage without input_tokens_details as uncached', async () => {
    const { turn } = await parse('text-only.sse');
    expect(extractResponsesUsage(turn.rawResponse)).toEqual({
      promptTokens: 50, completionTokens: 10, totalTokens: 60,
      cacheCreationTokens: undefined, cacheReadTokens: undefined, reasoningTokens: undefined,
    });
  });

  it('takes items from output_item.done, in output_index order (tools-parallel)', async () => {
    const { turn } = await parse('tools-parallel.sse');
    expect(turn.items.map(i => i.id)).toEqual(['rs_1', 'msg_1', 'fc_1', 'fc_2']);
    // .added carried "ENC-partial"; only the .done item is complete.
    expect(turn.items[0]).toEqual({
      id: 'rs_1', type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Need both files.' }],
      encrypted_content: 'ENC-full',
    });
    expect(turn.items[1]).toMatchObject({ type: 'message', phase: 'commentary' });
  });

  it('reads each call with its call_id and whole arguments (tools-parallel)', async () => {
    const { turn } = await parse('tools-parallel.sse');
    expect(turn.functionCalls).toEqual([
      { call_id: 'call_A', name: 'read_file', arguments: '{"path":"a.txt"}', itemId: 'fc_1' },
      { call_id: 'call_B', name: 'read_file', arguments: '{"path":"b.txt"}', itemId: 'fc_2' },
    ]);
  });

  it('never shows a reasoning summary as reply text', async () => {
    const { turn, chunks } = await parse('tools-parallel.sse');
    expect(turn.text).toBe('Reading both files.');
    expect(chunks.join('')).not.toContain('Need both files');
  });

  it('reads cached and cache-write tokens out of input_tokens, and reasoning tokens', async () => {
    const { turn } = await parse('tools-parallel.sse');
    expect(extractResponsesUsage(turn.rawResponse)).toEqual({
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
      cacheCreationTokens: 128, cacheReadTokens: 1024, reasoningTokens: 200,
    });
  });

  it('drops a call that never finished and reports why the reply stopped (incomplete)', async () => {
    const { turn } = await parse('incomplete-max-output.sse');
    expect(turn.status).toBe('incomplete');
    expect(turn.incompleteReason).toBe('max_output_tokens');
    expect(turn.items.map(i => i.id)).toEqual(['rs_3']);
    expect(turn.functionCalls).toEqual([]);
  });

  it('keeps an item output_item.done marks unfinished out of the turn and its replay', async () => {
    // The shape a cut-off reply can take when the API does send the item
    // done: [reasoning, commentary, reasoning, call left incomplete]. Nothing
    // unfinished may be replayed — neither the call, nor the reasoning that
    // was only there to lead to it.
    const rs = (id: string) => ({ id, type: 'reasoning', summary: [], encrypted_content: `ENC-${id}` });
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Writing it now.' }] };
    const fc = { id: 'fc_2', type: 'function_call', status: 'incomplete', call_id: 'call_2', name: 'write_file', arguments: '{"path":"out.txt","content":"par' };
    const events = [
      { type: 'response.output_item.done', output_index: 0, item: rs('rs_1') },
      { type: 'response.output_text.delta', output_index: 1, delta: 'Writing it now.' },
      { type: 'response.output_item.done', output_index: 1, item: msg },
      { type: 'response.output_item.done', output_index: 2, item: rs('rs_2') },
      { type: 'response.output_item.done', output_index: 3, item: fc },
      { type: 'response.incomplete', response: { status: 'incomplete', output: [rs('rs_1'), msg, rs('rs_2'), fc], usage: null, incomplete_details: { reason: 'max_output_tokens' } } },
    ];
    const turn = await parseResponsesSSE(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));

    expect(turn.items.map(i => i.id)).toEqual(['rs_1', 'msg_1', 'rs_2']);
    expect(turn.functionCalls).toEqual([]);
    expect(turn.text).toBe('Writing it now.');

    const state = new ResponsesRunState();
    const assistant: Message = { role: 'assistant', content: turn.text };
    state.tagAssistant(assistant, { providerId: 'openai', model: 'gpt-6-sol', dialect: 'openai', items: turn.items, rejectedCalls: [] });
    const input = buildResponsesInput([{ role: 'user', content: 'Write out.txt.' }, assistant, { role: 'user', content: 'Continue.' }], state, target);
    expect(input.map(i => i.id ?? i.role)).toEqual(['user', 'rs_1', 'msg_1', 'user']);
  });

  it('reads the "max_tokens" spelling of the incomplete reason as max_output_tokens', async () => {
    const body = `data: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', output: [], usage: null, incomplete_details: { reason: 'max_tokens' } } })}\n\n`;
    const turn = await parseResponsesSSE(body);
    expect(turn.incompleteReason).toBe('max_output_tokens');
  });

  it('fills items that never came as output_item.done from response.completed (xAI thin stream)', async () => {
    const call = { id: 'fc_x', type: 'function_call', call_id: 'call_x', name: 'read_file', arguments: '{"path":"x"}', status: 'completed' };
    const events = [
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_x', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] } },
      { type: 'response.completed', response: { status: 'completed', output: [
        { id: 'msg_x', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] },
        call,
      ], usage: null } },
    ];
    const turn = await parseResponsesSSE(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    expect(turn.text).toBe('Hi');
    expect(turn.items).toEqual([expect.objectContaining({ id: 'msg_x' }), call]);
    expect(turn.functionCalls.map(c => c.call_id)).toEqual(['call_x']);
  });

  it('shows a refusal as the reply and streams it (refusal)', async () => {
    const { turn, chunks } = await parse('refusal.sse');
    expect(turn.text).toBe('');
    expect(turn.refusal).toBe("I can't help with that.");
    expect(chunks.join('')).toBe("I can't help with that.");
  });

  it('parses CRLF, event: lines, comments, obfuscation, "data:" without a space and [DONE] (framing)', async () => {
    const plain = await parse('text-only.sse');
    const framed = await parse('framing.sse');
    expect(framed.turn.text).toBe(plain.turn.text);
    expect(framed.chunks).toEqual(plain.chunks);
    expect(framed.turn.items).toEqual(plain.turn.items);
    expect(framed.turn.usage).toEqual(plain.turn.usage);
  });

  it('parses the same when the stream arrives split mid-line and mid-CRLF', async () => {
    const whole = await parse('framing.sse');
    for (const size of [1, 7, 64]) {
      const split = await parse('framing.sse', size).then(
        ({ turn }) => ({ text: turn.text, items: turn.items }),
        (err: Error) => ({ error: err.message }),
      );
      expect(split, `chunks of ${size}`).toEqual({ text: whole.turn.text, items: whole.turn.items });
    }
  });

  it('throws a retryable 429 on response.failed rate_limit_exceeded', async () => {
    const err = await rejection(parse('failed-rate-limit.sse'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.message).toContain('Rate limit reached');
  });

  it('throws a retryable 500 on response.failed server_error', async () => {
    const err = await rejection(parse('failed-server-error.sse'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  it('throws a 400 with the message on an error event', async () => {
    const err = await rejection(parse('error-event.sse'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Invalid prompt');
  });

  it('maps failure codes: misalignment is not retried', () => {
    expect(responsesErrorStatus('rate_limit_exceeded')).toBe(429);
    expect(responsesErrorStatus('server_error')).toBe(500);
    expect(responsesErrorStatus('misalignment_policy_violation')).toBe(400);
    expect(responsesErrorStatus('invalid_prompt')).toBe(400);
  });

  // The table macOS mirrors (see responsesErrorStatus). runAgent retries 429
  // and 5xx and stops on any other 4xx, so every transient code must land on
  // one of the first two.
  it('maps every retryable code, a missing one included, to a status runAgent retries', () => {
    const table: Array<[unknown, number]> = [
      ['rate_limit_exceeded', 429], ['slow_down', 429],
      ['server_error', 500], ['server_is_overloaded', 500], ['service_unavailable', 500],
      [null, 500], [undefined, 500], ['', 500],
      ['invalid_prompt', 400], ['misalignment_policy_violation', 400], ['invalid_image', 400], ['some_new_code', 400],
    ];
    for (const [code, status] of table) expect(responsesErrorStatus(code), String(code)).toBe(status);
  });

  it('retries a response.failed that carries no code', async () => {
    const failed = (error: unknown) => `data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', output: [], usage: null, error } })}\n\n`;
    for (const error of [{ code: null, message: 'An error occurred while processing your request.' }, { message: 'no code at all' }, undefined]) {
      const err = await rejection(parseResponsesSSE(failed(error)));
      expect(err, JSON.stringify(error)).toBeInstanceOf(ApiError);
      expect(err.status, JSON.stringify(error)).toBe(500);
    }
  });

  it('retries an error event that carries no code', async () => {
    const body = `data: ${JSON.stringify({ type: 'error', code: null, message: 'The server had an error.', param: null })}\n\n`;
    const err = await rejection(parseResponsesSSE(body));
    expect(err.status).toBe(500);
    expect(err.message).toContain('The server had an error.');
  });

  it('throws a retryable 502 when the stream ends before a terminal event', async () => {
    const cut = fixture('tools-parallel.sse').split('event: response.completed')[0];
    const err = await rejection(parseResponsesSSE(cut));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
  });
});

describe('parseResponsesJSON', () => {
  it('reads a non-streamed reply the same way', async () => {
    const streamed = (await parse('tools-parallel.sse')).turn;
    const turn = parseResponsesJSON(streamed.rawResponse);
    expect(turn.items).toEqual(streamed.items);
    expect(turn.functionCalls).toEqual(streamed.functionCalls);
    expect(turn.text).toBe('Reading both files.');
  });

  it('throws on status "failed"', () => {
    expect(() => parseResponsesJSON({ status: 'failed', output: [], error: { code: 'server_error', message: 'boom' } }))
      .toThrow(ApiError);
  });
});

// ─── Input ────────────────────────────────────────────────────────────────────

const target = { providerId: 'openai', model: 'gpt-6-sol', dialect: 'openai' as const };

async function taggedToolTurn() {
  const { turn } = await parse('tools-parallel.sse');
  const state = new ResponsesRunState();
  const user: Message = { role: 'user', content: 'Read a.txt and b.txt.' };
  const assistant: Message = { role: 'assistant', content: 'Reading both files.' };
  const results: Message = { role: 'user', content: 'Tool results:\n\nA\n\nB\n\nContinue with the task. Keep working until everything is fully done.' };
  const native: NativeTurn = { providerId: 'openai', model: 'gpt-6-sol', dialect: 'openai', items: turn.items, rejectedCalls: [] };
  state.tagAssistant(assistant, native);
  state.tagToolOutputs(results, [{ call_id: 'call_A', output: 'A' }, { call_id: 'call_B', output: 'B' }]);
  return { state, messages: [user, assistant, results], items: turn.items };
}

describe('buildResponsesInput', () => {
  it('replays the turn verbatim and answers each call, with no trailing user nudge', async () => {
    const { state, messages, items } = await taggedToolTurn();
    expect(buildResponsesInput(messages, state, target)).toEqual([
      { type: 'message', role: 'user', content: 'Read a.txt and b.txt.' },
      ...items,
      { type: 'function_call_output', call_id: 'call_A', output: 'A' },
      { type: 'function_call_output', call_id: 'call_B', output: 'B' },
    ]);
  });

  it('keeps the calls but drops reasoning for a different model', async () => {
    const { state, messages } = await taggedToolTurn();
    const input = buildResponsesInput(messages, state, { ...target, model: 'gpt-6-luna' });
    expect(input.some(i => i.type === 'reasoning')).toBe(false);
    expect(input.filter(i => i.type === 'function_call').map(i => i.call_id)).toEqual(['call_A', 'call_B']);
  });

  it('sends flat text to a different provider, with no native items at all', async () => {
    const { state, messages } = await taggedToolTurn();
    const input = buildResponsesInput(messages, state, { providerId: 'grok', model: 'grok-4.7', dialect: 'xai' });
    expect(input.every(i => i.type === 'message')).toBe(true);
    expect(input.some(i => String(i.content).includes('ENC-full'))).toBe(false);
  });

  it('drops reasoning a cut-off turn left with nothing after it', () => {
    const state = new ResponsesRunState();
    const rs = (id: string) => ({ id, type: 'reasoning', summary: [], encrypted_content: `ENC-${id}` });
    const fc = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' };
    const cutOff: Message = { role: 'assistant', content: '(no reply)' };
    const partial: Message = { role: 'assistant', content: 'Using read_file.' };
    state.tagAssistant(cutOff, { providerId: 'openai', model: 'gpt-6-sol', dialect: 'openai', items: [rs('rs_a')], rejectedCalls: [] });
    state.tagAssistant(partial, { providerId: 'openai', model: 'gpt-6-sol', dialect: 'openai', items: [rs('rs_b'), fc, rs('rs_c')], rejectedCalls: [] });
    const input = buildResponsesInput([{ role: 'user', content: 'go' }, cutOff, { role: 'user', content: 'Continue.' }, partial], state, target);
    expect(input.filter(i => i.type === 'reasoning').map(i => i.id)).toEqual(['rs_b']);
    expect(input.filter(i => i.type === 'function_call').map(i => i.call_id)).toEqual(['call_1']);
  });

  it('sends an untagged assistant turn as a final answer with no id, and skips empty messages', () => {
    const input = buildResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: '  ' },
    ], undefined, target);
    expect(input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'Done.', phase: 'final_answer' },
    ]);
  });

  it('sends no phase on the xai dialect', () => {
    const input = buildResponsesInput([{ role: 'assistant', content: 'Done.' }], undefined, { ...target, dialect: 'xai' });
    expect(input).toEqual([{ type: 'message', role: 'assistant', content: 'Done.' }]);
  });
});

describe('normalizePairs', () => {
  const call = (id: string): ResponsesItem => ({ type: 'function_call', call_id: id, name: 'read_file', arguments: '{}' });
  const out = (id: string, output = `out ${id}`): ResponsesItem => ({ type: 'function_call_output', call_id: id, output });
  const user = (content: string): ResponsesItem => ({ type: 'message', role: 'user', content });

  it('turns an output whose call is gone into user text after its batch', () => {
    expect(normalizePairs([user('task'), out('call_gone', 'stale'), user('summary')])).toEqual([
      user('task'),
      { type: 'message', role: 'user', content: 'Tool output (its call is no longer in the conversation):\nstale' },
      user('summary'),
    ]);
  });

  it('answers a call left without an output, right after its batch', () => {
    expect(normalizePairs([user('task'), call('a'), call('b'), out('a'), user('next')])).toEqual([
      user('task'), call('a'), call('b'), out('a'),
      { type: 'function_call_output', call_id: 'b', output: NOT_EXECUTED_OUTPUT },
      user('next'),
    ]);
  });

  it('answers a call before the next turn begins, not at the end of the input', () => {
    const rs = { type: 'reasoning', id: 'rs_2', summary: [] };
    expect(normalizePairs([call('a'), call('b'), out('b'), rs, call('c'), out('c')])).toEqual([
      call('a'), call('b'), out('b'), { type: 'function_call_output', call_id: 'a', output: NOT_EXECUTED_OUTPUT },
      rs, call('c'), out('c'),
    ]);
  });

  it('treats reasoning between two calls of one reply as the same batch', () => {
    const rs1 = { type: 'reasoning', id: 'rs_1', summary: [] };
    const rs2 = { type: 'reasoning', id: 'rs_2', summary: [] };
    const paired = [user('task'), rs1, call('a'), rs2, call('b'), out('a'), out('b')];
    expect(normalizePairs(paired)).toEqual(paired);
  });

  it('keeps one answer per call and moves a second one, or one ahead of its call, to text', () => {
    const input = [out('a', 'early'), call('a'), out('a', 'first'), out('a', 'second')];
    const result = normalizePairs(input);
    expect(result.filter(i => i.type === 'function_call_output')).toEqual([out('a', 'first')]);
    expect(result.filter(i => i.type === 'message').map(i => i.content)).toEqual([
      'Tool output (its call is no longer in the conversation):\nearly',
      'Tool output (its call is no longer in the conversation):\nsecond',
    ]);
  });

  it('leaves a well-paired history exactly as it was', async () => {
    const { state, messages } = await taggedToolTurn();
    const raw = buildResponsesInput(messages, state, target);
    expect(normalizePairs(raw)).toEqual(raw);
  });
});

// ─── Tools and body ───────────────────────────────────────────────────────────

describe('toResponsesTools', () => {
  const chatTool = { type: 'function' as const, function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } } };

  it('flattens the tool and sets strict:false explicitly for openai', () => {
    expect(toResponsesTools([chatTool], 'openai')).toEqual([
      { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {}, required: [] }, strict: false },
    ]);
  });

  it('omits strict for xai, which does not support it', () => {
    expect(toResponsesTools([chatTool], 'xai')[0]).not.toHaveProperty('strict');
  });
});

describe('buildResponsesBody', () => {
  const base = {
    model: 'gpt-6-sol', instructions: 'sys', input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: [{ type: 'function', name: 't', parameters: null, strict: false }],
  };

  it('is stateless, streams without obfuscation, and carries no sampling params (openai)', () => {
    const body = buildResponsesBody({ ...base, dialect: 'openai', reasoning: { effort: 'high' }, maxOutputTokens: 32768, stream: true, temperature: 0.7 });
    expect(body).toEqual({
      model: 'gpt-6-sol', instructions: 'sys', input: base.input,
      tools: base.tools, tool_choice: 'auto', parallel_tool_calls: true,
      store: false, include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' }, max_output_tokens: 32768,
      stream: true, stream_options: { include_obfuscation: false },
    });
  });

  it('sends no tool fields without tools and no stream_options when not streaming', () => {
    const body = buildResponsesBody({ ...base, tools: [], dialect: 'openai', stream: false });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('stream_options');
    expect(body).not.toHaveProperty('reasoning');
    expect(body.store).toBe(false);
  });

  it('xai keeps temperature and a cache key, and has no stream_options', () => {
    const body = buildResponsesBody({ ...base, dialect: 'xai', stream: true, temperature: 0.7, promptCacheKey: 'k' });
    expect(body).toMatchObject({ temperature: 0.7, prompt_cache_key: 'k', store: false, include: ['reasoning.encrypted_content'] });
    expect(body).not.toHaveProperty('stream_options');
  });
});
