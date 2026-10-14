/**
 * scripts/verify-gemini-argon.mjs — the owner-run check of Gemini 4 Argon —
 * without the network: argument handling, the request bodies, the y/N gate,
 * key hygiene and the exit codes. The flows run against a fake fetch. No test
 * here may reach generativelanguage.googleapis.com or read a real key.
 *
 * The fake API reproduces what the owner's run of 2026-10-14 found: a replay
 * of a function call without its thoughtSignature is an HTTP 400.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { PassThrough, Writable } from 'stream';

type ReplayMode = 'app-before' | 'dummy' | 'returned';

interface Verifier {
  API_URL: string;
  NATIVE_URL: string;
  MODEL: string;
  MAX_REQUESTS: number;
  streamBody(body: Record<string, any>): Record<string, any>;
  rebuiltLikeTheApp(content: unknown): Record<string, any>;
  thoughtSignaturePaths(value: unknown, base?: string): string[];
  DUMMY_THOUGHT_SIGNATURE: string;
  REPLAY_MODES: ReplayMode[];
  nativeUrl(model?: string): string;
  parseArgs(argv: string[]): { dryRun: boolean; help: boolean; model: string; only: string[]; timeoutSeconds: number };
  planRequests(opts: { only: string[] }): { checks: string[]; requests: number };
  plainBody(model?: string): Record<string, unknown>;
  toolBody(model?: string): Record<string, unknown>;
  toolFollowUpBody(assistant: unknown, toolCallIds: string | string[], model?: string): { messages: Record<string, unknown>[] } & Record<string, unknown>;
  effortBody(model?: string): Record<string, unknown>;
  nativeBody(): Record<string, any>;
  nativeToolBody(): Record<string, any>;
  nativeToolFollowUpBody(content: unknown, opts: { mode: ReplayMode }): { contents: Record<string, any>[] } & Record<string, unknown>;
  withoutThoughtSignatures(value: unknown): unknown;
  withDummyThoughtSignature(content: unknown): { parts: Record<string, any>[] } & Record<string, unknown>;
  redactSecrets(text: string, key?: string): string;
  thoughtSignatureLengths(value: unknown): number[];
  main(argv: string[], io: Record<string, unknown>): Promise<number>;
}

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'verify-gemini-argon.mjs');
const KEY = 'AIzaSyTESTKEY-0123456789abcdefghijklmnop';

let v: Verifier;
beforeAll(async () => {
  // A computed specifier: the script is plain .mjs outside src/, with no types.
  v = await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href) as Verifier;
});

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb(); } });
  return { stream, text: () => text };
}

function stdinWith(answer: string | null) {
  const s = new PassThrough();
  if (answer !== null) s.end(`${answer}\n`);
  else s.end();
  return s;
}

const USAGE = { prompt_tokens: 21, completion_tokens: 9, total_tokens: 300, completion_tokens_details: { reasoning_tokens: 270 }, prompt_tokens_details: { cached_tokens: 0 } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fake API: answers by what the request carries. */
const NATIVE_USAGE = { promptTokenCount: 21, candidatesTokenCount: 9, thoughtsTokenCount: 270, totalTokenCount: 300 };

function fakeApi(opts: {
  toolCall?: boolean; failFollowUp?: string; finishReason?: string; signature?: boolean;
  /** Native API: reject a replay whose model turn carries no thoughtSignature (the live 400). */
  nativeNeedsSignature?: boolean;
  /** Native API: reject the documented dummy, as a model that validates signatures would. */
  nativeRejectsDummy?: boolean;
  /** Native API: reject every replay of the function call. */
  nativeRejectsAllReplays?: boolean;
  /** Native API: reject only the replay that carries the real signature. */
  nativeRejectsRealSignature?: boolean;
  /** Native API: the first request itself is refused. */
  nativeFirstCallFails?: boolean;
  /** OpenAI path: how many parallel tool calls the model makes. */
  openAiCalls?: number;
  /** Native API: the signature sits on a text part before the call, not on the functionCall part. */
  nativeSignatureElsewhere?: boolean;
  /** OpenAI stream: put `usage` on every chunk, not just the last. */
  usageOnEveryChunk?: boolean;
  /** OpenAI stream: send no usage chunk at all. */
  noStreamUsage?: boolean;
  noThoughts?: boolean;
} = {}) {
  const seen: { url: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
    if (String(url).includes(':generateContent')) {
      const usage = opts.noThoughts ? { promptTokenCount: 21, candidatesTokenCount: 9 } : NATIVE_USAGE;
      if (Array.isArray(body.tools)) {
        if (body.contents.length === 1) {
          if (opts.nativeFirstCallFails) return new Response(JSON.stringify({ error: { code: 500, message: 'internal' } }), { status: 500 });
          return json({
            modelVersion: 'gemini-4-argon',
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: opts.nativeSignatureElsewhere
              ? [{ text: '', thoughtSignature: 'c2lnbmF0dXJl' }, { functionCall: { name: 'read_file', args: { path: 'notes.txt' } } }]
              : [{ functionCall: { name: 'read_file', args: { path: 'notes.txt' } }, ...(opts.signature ? { thoughtSignature: 'c2lnbmF0dXJl' } : {}) }] } }],
            usageMetadata: usage,
          });
        }
        const modelParts: any[] = body.contents[1].parts;
        const signatures: string[] = modelParts.map(part => part.thoughtSignature).filter(Boolean);
        const refuse = (message: string) => new Response(JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }), { status: 400 });
        if (opts.nativeRejectsAllReplays) return refuse('replay refused');
        if (opts.nativeNeedsSignature && signatures.length === 0) return refuse('Function call is missing a thought_signature in functionCall parts.');
        if (opts.nativeRejectsDummy && signatures.includes('skip_thought_signature_validator')) return refuse('Corrupted thought signature.');
        if (opts.nativeRejectsRealSignature && signatures.some(sig => sig !== 'skip_thought_signature_validator')) return refuse('Corrupted thought signature.');
        return json({ modelVersion: 'gemini-4-argon', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'PELICAN' }] } }], usageMetadata: usage });
      }
      return json({ modelVersion: 'gemini-4-argon', candidates: [{ finishReason: opts.finishReason ?? 'STOP', content: { role: 'model', parts: [{ text: '391' }] } }], usageMetadata: usage });
    }
    if (body.stream === true) {
      const sse = (objs: unknown[]) => new Response(objs.map(o => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
      const streamUsage = { prompt_tokens: 47, completion_tokens: 7, total_tokens: 207 };
      const tail = opts.noStreamUsage ? [] : [{ model: 'gemini-4-argon', choices: [], usage: streamUsage }];
      const withUsage = (chunk: Record<string, unknown>) => (opts.usageOnEveryChunk ? { ...chunk, usage: streamUsage } : chunk);
      if (Array.isArray(body.tools)) {
        return sse([
          withUsage({ model: 'gemini-4-argon', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'function-call-1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
          withUsage({ model: 'gemini-4-argon', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"notes.txt"}' } }] } }] }),
          withUsage({ model: 'gemini-4-argon', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          ...tail,
        ]);
      }
      return sse([
        withUsage({ model: 'gemini-4-argon', choices: [{ delta: { role: 'assistant', content: 'rea' } }] }),
        withUsage({ model: 'gemini-4-argon', choices: [{ delta: { content: 'dy' } }] }),
        withUsage({ model: 'gemini-4-argon', choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ...tail,
      ]);
    }
    const wantsTools = Array.isArray(body.tools);
    const isFollowUp = body.messages.some((m: { role: string }) => m.role === 'tool');
    if (wantsTools && isFollowUp) {
      if (opts.failFollowUp) return new Response(opts.failFollowUp, { status: 400 });
      return json({ model: 'gemini-4-argon', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'PELICAN' } }], usage: USAGE });
    }
    if (wantsTools) {
      const message: Record<string, unknown> = opts.toolCall === false
        ? { role: 'assistant', content: 'I cannot.' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: Array.from({ length: opts.openAiCalls ?? 1 }, (_, i) => ({
              id: `function-call-${i + 1}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
              ...(opts.signature ? { extra_content: { google: { thought_signature: 'c2lnbmF0dXJl' } } } : {}),
            })),
          };
      return json({ model: 'gemini-4-argon', choices: [{ finish_reason: 'tool_calls', message }], usage: USAGE });
    }
    return json({
      model: 'gemini-4-argon',
      choices: [{ finish_reason: opts.finishReason ?? 'stop', message: { role: 'assistant', content: 'ready' } }],
      usage: USAGE,
    });
  });
  return { fetchImpl, seen };
}

async function run(argv: string[], api: ReturnType<typeof fakeApi>, answer: string | null = 'y', env: Record<string, string> = { GOOGLE_API_KEY: KEY }) {
  const out = sink();
  const err = sink();
  const code = await v.main(argv, { stdout: out.stream, stderr: err.stream, stdin: stdinWith(answer), env, fetch: api.fetchImpl });
  return { code, out: out.text(), err: err.text() };
}

describe('arguments and plan', () => {
  it('defaults to all seven checks, gemini-4-argon and a 240 s timeout', () => {
    expect(v.parseArgs([])).toMatchObject({ dryRun: false, model: 'gemini-4-argon', only: ['plain', 'tools', 'effort', 'stream', 'stream-tools', 'native', 'native-tools'], timeoutSeconds: 240 });
  });

  it('--model takes an id of 3 to 64 letters, digits, dots, dashes and underscores', () => {
    expect(v.parseArgs(['--model', 'gemini-3.8-flash']).model).toBe('gemini-3.8-flash');
    expect(v.parseArgs(['--model', 'gemini-4-argon-2026_10']).model).toBe('gemini-4-argon-2026_10');
    expect(v.parseArgs(['--model', 'a'.repeat(64)]).model).toHaveLength(64);
    for (const bad of ['ab', 'a'.repeat(65), 'models/gemini', 'gemini 4', 'gemini-4:generate', 'x?key=1', 'a#b', 'é-model']) {
      expect(() => v.parseArgs(['--model', bad]), bad).toThrow(/--model must be a model id/);
    }
    expect(() => v.parseArgs(['--model'])).toThrow(/needs a value/);
  });

  // The id pattern also matches a Google key, so a key pasted here by mistake
  // has to be refused by shape — and its value never echoed.
  it('refuses a key-shaped --model without echoing it', () => {
    let message = '';
    try { v.parseArgs(['--model', KEY]); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/--model must be a model id/);
    expect(message).not.toContain(KEY);
  });

  it('refuses unknown options and checks, and a timeout outside 10..900', () => {
    expect(() => v.parseArgs(['--yes'])).toThrow(/unknown option/);
    expect(() => v.parseArgs(['--only', 'nonsense'])).toThrow(/unknown check/);
    expect(() => v.parseArgs(['--timeout', '5'])).toThrow(/10 to 900/);
    expect(() => v.parseArgs(['--timeout', '1e3'])).toThrow(/10 to 900/);
  });

  it('counts tools as two, native-tools as five and each stream as one, and never plans more than 12', () => {
    expect(v.planRequests(v.parseArgs([]))).toMatchObject({ requests: 12 });
    expect(v.planRequests(v.parseArgs(['--only', 'plain']))).toMatchObject({ requests: 1 });
    expect(v.planRequests(v.parseArgs(['--only', 'tools']))).toMatchObject({ requests: 2 });
    expect(v.planRequests(v.parseArgs(['--only', 'stream,stream-tools']))).toMatchObject({ requests: 2 });
    expect(v.planRequests(v.parseArgs(['--only', 'native-tools']))).toMatchObject({ requests: 5 });
    expect(v.MAX_REQUESTS).toBe(12);
  });
});

describe('request bodies', () => {
  it('target gemini-4-argon on the OpenAI-compatible endpoint', () => {
    expect(v.API_URL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    for (const body of [v.plainBody(), v.toolBody(), v.effortBody()]) expect(body.model).toBe('gemini-4-argon');
  });

  it('--model reaches every body and the native URL; the default is unchanged', () => {
    expect(v.MODEL).toBe('gemini-4-argon');
    expect(v.nativeUrl()).toBe(v.NATIVE_URL);
    expect(v.nativeUrl('gemini-3.8-flash')).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    const bodies = [
      v.plainBody('gemini-3.8-flash'), v.toolBody('gemini-3.8-flash'), v.effortBody('gemini-3.8-flash'),
      v.toolFollowUpBody({ role: 'assistant', content: null }, 'x', 'gemini-3.8-flash'),
    ];
    for (const body of bodies) expect(body.model).toBe('gemini-3.8-flash');
  });

  it('send no sampling parameters in any request', () => {
    const follow = v.toolFollowUpBody({ role: 'assistant', content: null }, 'id-1');
    for (const body of [v.plainBody(), v.toolBody(), v.effortBody(), follow]) {
      for (const name of ['temperature', 'top_p', 'top_k']) expect(body, name).not.toHaveProperty(name);
    }
    const content = { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] };
    const nativeFollows = v.REPLAY_MODES.map(mode => v.nativeToolFollowUpBody(content, { mode }));
    for (const body of [v.nativeBody(), v.nativeToolBody(), ...nativeFollows]) {
      const cfg = (body as Record<string, any>).generationConfig ?? {};
      for (const name of ['temperature', 'topP', 'topK', 'top_p', 'top_k']) expect(cfg, name).not.toHaveProperty(name);
    }
  });

  it('rebuiltLikeTheApp keeps the call and its own part-level signature, and drops everything else', () => {
    const content = { role: 'model', parts: [
      { text: 'thinking out loud', thought: true, thoughtSignature: 'on-a-text-part' },
      { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'sig-1', extra: 1 },
      { functionCall: { name: 'read_file', args: { path: 'b' } } },
    ] };
    expect(v.rebuiltLikeTheApp(content)).toEqual({ role: 'model', parts: [
      { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'sig-1' },
      { functionCall: { name: 'read_file', args: { path: 'b' } } },
    ] });
  });

  it('thoughtSignaturePaths gives JSON paths, and streamBody asks for usage in the stream', () => {
    expect(v.thoughtSignaturePaths({ parts: [{ a: 1 }, { thoughtSignature: 'x' }], extra_content: { google: { thought_signature: 'y' } } }, 'c'))
      .toEqual(['c.parts[1].thoughtSignature', 'c.extra_content.google.thought_signature']);
    expect(v.streamBody({ model: 'm', messages: [] })).toEqual({ model: 'm', messages: [], stream: true, stream_options: { include_usage: true } });
  });

  it('answers every tool call of a reply, not just the first', () => {
    const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] };
    const follow = v.toolFollowUpBody(assistant, ['a', 'b']);
    expect(follow.messages.slice(2).map(m => m.tool_call_id)).toEqual(['a', 'b']);
  });

  it('native: the app\'s shape — thinkingLevel high, maxOutputTokens 4096, the native endpoint', () => {
    expect(v.NATIVE_URL).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent');
    expect(v.nativeBody().generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'high' } });
    const tool = v.nativeToolBody().tools[0].functionDeclarations[0];
    expect(tool.name).toBe('read_file');
  });

  it('native replay as the app sent it before the fix: no thoughtSignature anywhere, the response named by the minted id', () => {
    const returned = { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'notes.txt' } }, thoughtSignature: 'c2ln' }] };
    const before = v.nativeToolFollowUpBody(returned, { mode: 'app-before' });
    expect(JSON.stringify(before)).not.toMatch(/thought_?signature/i);
    expect(before.contents[2].parts[0].functionResponse.name).toBe('gemini-call-1');
    expect(before.contents[2].parts[0].functionResponse.response).toEqual({ content: 'The code word is PELICAN.' });
    // …and the input is not mutated: the other replays still have their signature.
    expect(returned.parts[0]).toHaveProperty('thoughtSignature', 'c2ln');
  });

  // What the app sends for history that carries no signature: the dummy on the
  // FIRST functionCall part only, the response named by the function.
  it('native replay with the documented dummy: on the first functionCall only, the real signature replaced, named by the function', () => {
    expect(v.DUMMY_THOUGHT_SIGNATURE).toBe('skip_thought_signature_validator');
    const returned = {
      role: 'model',
      parts: [
        { text: 'reading', thoughtSignature: 'c2ln-text' },
        { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'c2ln' },
        { functionCall: { name: 'list_dir', args: { path: '.' } }, thoughtSignature: 'c2ln-second' },
      ],
    };
    const dummy = v.nativeToolFollowUpBody(returned, { mode: 'dummy' });
    const parts = dummy.contents[1].parts;
    // Every real signature is gone — on the text part and the second call too —
    // and the dummy stands on the first call alone.
    expect(parts[0]).toEqual({ text: 'reading' });
    expect(parts[1].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(parts[2]).not.toHaveProperty('thoughtSignature');
    expect(JSON.stringify(dummy)).not.toContain('c2ln');
    expect(dummy.contents[2].parts.map((p: any) => p.functionResponse.name)).toEqual(['read_file', 'list_dir']);
    expect(dummy.contents[2].parts[0].functionResponse.response).toEqual({ content: 'The code word is PELICAN.' });
    expect(returned.parts[1]).toHaveProperty('thoughtSignature', 'c2ln');
    // withDummyThoughtSignature alone: a turn with no call changes nothing but its signatures.
    expect(v.withDummyThoughtSignature({ role: 'model', parts: [{ text: 'hi' }] }).parts).toEqual([{ text: 'hi' }]);
  });

  it('native replay as returned: the content untouched, the response named by the function', () => {
    const returned = { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'c2ln' }] };
    const asReturned = v.nativeToolFollowUpBody(returned, { mode: 'returned' });
    expect(asReturned.contents[1]).toBe(returned);
    expect(asReturned.contents[2].parts[0].functionResponse.name).toBe('read_file');
    expect(asReturned.contents[2].parts[0].functionResponse.response).toEqual({ content: 'The code word is PELICAN.' });
  });

  it('refuses an unknown replay mode', () => {
    expect(() => v.nativeToolFollowUpBody({ role: 'model', parts: [] }, { mode: 'nope' as ReplayMode })).toThrow(/unknown replay mode/);
  });

  it('(a) sets no cap and no effort; (c) asks for high with max_tokens 4096', () => {
    expect(v.plainBody()).not.toHaveProperty('max_tokens');
    expect(v.plainBody()).not.toHaveProperty('reasoning_effort');
    expect(v.effortBody()).toMatchObject({ reasoning_effort: 'high', max_tokens: 4096 });
  });

  it('(b) carries a read_file function tool, and replays the assistant message as given', () => {
    const body = v.toolBody() as { tools: { function: { name: string } }[] };
    expect(body.tools[0].function.name).toBe('read_file');
    const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'x', extra_content: { google: { thought_signature: 's' } } }] };
    const follow = v.toolFollowUpBody(assistant, 'x');
    expect(follow.messages[1]).toBe(assistant);
    expect(follow.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'x' });
  });
});

describe('key hygiene', () => {
  it('redacts the key, anything shaped like a Google key, and a bearer token', () => {
    expect(v.redactSecrets(`bad key ${KEY}`, KEY)).not.toContain(KEY);
    expect(v.redactSecrets('key=AIzaSyOTHERKEY0123456789abcdefgh was rejected')).toBe('key=AIza[REDACTED] was rejected');
    expect(v.redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('reports a thought signature by its length, never its value', () => {
    expect(v.thoughtSignatureLengths({ tool_calls: [{ extra_content: { google: { thought_signature: 'abcd' } } }] })).toEqual([4]);
    expect(v.thoughtSignatureLengths({ content: 'no signature here' })).toEqual([]);
  });
});

describe('the gate', () => {
  it('--dry-run prints the plan and bodies, needs no key and sends nothing', async () => {
    const api = fakeApi();
    const { code, out } = await run(['--dry-run'], api, null, {});
    expect(code).toBe(0);
    expect(out).toContain('Dry run: nothing was sent.');
    expect(out).toContain('"reasoning_effort": "high"');
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  it('stops before asking when GOOGLE_API_KEY is missing', async () => {
    const api = fakeApi();
    const { code, err } = await run([], api, 'y', {});
    expect(code).toBe(1);
    expect(err).toContain('GOOGLE_API_KEY is not set');
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  // "reads the key ONLY from GOOGLE_API_KEY": a key sitting under another
  // name in the environment is never picked up.
  it('ignores a key held under any other name', async () => {
    const api = fakeApi();
    const { code, err } = await run([], api, 'y', { GEMINI_API_KEY: KEY, GOOGLE_GENERATIVE_AI_API_KEY: KEY, GOOGLE_AI_API_KEY: KEY });
    expect(code).toBe(1);
    expect(err).toContain('GOOGLE_API_KEY is not set');
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  it('is No unless the answer is y or yes — and no answer is No', async () => {
    for (const answer of ['n', '', 'maybe', null]) {
      const api = fakeApi();
      const { code, out } = await run([], api, answer);
      expect(code, String(answer)).toBe(1);
      expect(out).toContain('Aborted — nothing was sent.');
      expect(api.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('prints the count and the model BEFORE asking', async () => {
    const api = fakeApi();
    const { out } = await run([], api, 'n');
    expect(out.indexOf('at most 12 request(s)')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('at most 12 request(s)')).toBeLessThan(out.indexOf('[y/N]'));
    expect(out).toContain('Model: gemini-4-argon');
  });
});

describe('a run', () => {
  it('passes, prints status, model, finish_reason, usage verbatim and elapsed — with the key nowhere', async () => {
    const api = fakeApi({ signature: true });
    const { code, out } = await run([], api);
    expect(code).toBe(0);
    expect(api.seen).toHaveLength(12);
    expect(out).toMatch(/status:\s+200/);
    expect(out).toMatch(/model:\s+gemini-4-argon/);
    expect(out).toMatch(/finish_reason: stop/);
    expect(out).toContain(`usage:         ${JSON.stringify(USAGE)}`);
    expect(out).toMatch(/elapsed:\s+\d+ ms/);
    expect(out).toContain('PASS  plain');
    expect(out).toContain('PASS  tools');
    expect(out).toContain('PASS  effort');
    expect(out).toContain('PASS  stream');
    expect(out).toContain('PASS  stream-tools');
    expect(out).toContain('PASS  native');
    expect(out).toContain('PASS  native-tools');
    expect(out).toMatch(/thought signature in the message: yes \(1; lengths 12; at message\./);
    expect(out).toMatch(/thought signature in the content: yes \(1; lengths 12; at content\./);
    expect(out).not.toContain('c2lnbmF0dXJl');
    expect(out).not.toContain(KEY);
    // The key travels only in a header of the request itself — never in a URL.
    for (const { url, headers } of api.seen) {
      expect(url).not.toContain(KEY);
      if (url.includes(':generateContent')) expect(headers['x-goog-api-key']).toBe(KEY);
      else expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('replays the assistant message exactly as returned, extra_content included', async () => {
    const api = fakeApi({ signature: true });
    await run(['--only', 'tools'], api);
    expect(api.seen).toHaveLength(2);
    const replayed = api.seen[1].body.messages[1];
    expect(replayed.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'c2lnbmF0dXJl' } });
    expect(api.seen[1].body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'function-call-1' });
  });

  it('fails, and says so, when the model does not call the tool', async () => {
    const api = fakeApi({ toolCall: false });
    const { code, out } = await run(['--only', 'tools'], api);
    expect(code).toBe(1);
    expect(out).toContain('FAIL  tools — the model did not call read_file');
    expect(api.seen).toHaveLength(1);
  });

  it('on a non-2xx prints the error body with the key redacted, and exits non-zero', async () => {
    const api = fakeApi({ failFollowUp: JSON.stringify({ error: { code: 400, message: `Function call is missing a thought_signature (key ${KEY}, also AIzaSyOTHERKEY0123456789abcdefgh)` } }) });
    const { code, out } = await run(['--only', 'tools'], api);
    expect(code).toBe(1);
    expect(out).toContain('error body:');
    expect(out).toContain('thought_signature');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('AIzaSyOTHERKEY');
    expect(out).toContain('FAIL  tools — HTTP 400');
  });

  it('treats finish_reason "length" at max_tokens 4096 as a note, not a failure', async () => {
    const api = fakeApi({ finishReason: 'length' });
    const { code, out } = await run(['--only', 'effort'], api);
    expect(code).toBe(0);
    expect(out).toContain('PASS  effort');
    expect(out).toMatch(/NOTE\s+effort: finish_reason "length"/);
  });

  it('native: prints usageMetadata verbatim and says what thoughtsTokenCount means for the macOS count', async () => {
    const api = fakeApi();
    const { code, out } = await run(['--only', 'native'], api);
    expect(code).toBe(0);
    expect(out).toContain(`usageMetadata: ${JSON.stringify(NATIVE_USAGE)}`);
    expect(out).toMatch(/NOTE\s+native: thoughtsTokenCount 270 is reported apart from candidatesTokenCount 9, and Google bills it as output/);
    expect(out).toContain('The macOS app adds it.');
    const none = await run(['--only', 'native'], fakeApi({ noThoughts: true }));
    expect(none.out).toMatch(/NOTE\s+native: usageMetadata has no thoughtsTokenCount/);
  });

  // Which of the three replays is which, in the order they are sent: 1 is what
  // the app sent before the fix, 2 the documented dummy, 3 the content as returned.
  it('native-tools: sends the four replays in order — before the fix, the dummy, as returned, rebuilt like the app', async () => {
    const api = fakeApi({ signature: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    expect(code).toBe(0);
    expect(api.seen).toHaveLength(5);
    const [, before, dummy, returned, appNow] = api.seen;
    expect(JSON.stringify(before.body)).not.toMatch(/thoughtSignature/);
    expect(before.body.contents[2].parts[0].functionResponse.name).toBe('gemini-call-1');
    expect(dummy.body.contents[1].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(dummy.body.contents[2].parts[0].functionResponse.name).toBe('read_file');
    expect(returned.body.contents[1].parts[0].thoughtSignature).toBe('c2lnbmF0dXJl');
    expect(returned.body.contents[2].parts[0].functionResponse.name).toBe('read_file');
    // Rebuilt like the app: the call and the part's own signature, nothing else.
    expect(appNow.body.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'notes.txt' } }, thoughtSignature: 'c2lnbmF0dXJl' }] });
    expect(appNow.body.contents[2].parts[0].functionResponse.name).toBe('read_file');
    expect(out).toContain('as the app sent it before the fix (no signature): answered with the code word');
    expect(out).toContain('with the documented dummy signature:              answered with the code word');
    expect(out).toContain('as returned (real signature kept):                answered with the code word');
    expect(out).toContain('rebuilt the way the app rebuilds it (the fix):    answered with the code word');
    expect(out).toMatch(/NOTE\s+native-tools: real signature accepted; rebuilt like the app accepted; documented dummy accepted; no signature \(the app before the fix\) accepted/);
    expect(out).toContain('PASS  native-tools');
  });

  // The owner's run of 2026-10-14, reproduced: no signature is a 400; the
  // content as returned is answered. The dummy was not part of that run.
  it('native-tools: when only the signature-less replay is refused, it says the app must send signatures — and passes', async () => {
    const api = fakeApi({ signature: true, nativeNeedsSignature: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    // A refused probe is the finding, not a failure of the check.
    expect(code).toBe(0);
    expect(out).toMatch(/as the app sent it before the fix \(no signature\): FAILED \(HTTP 400/);
    expect(out).toContain('with the documented dummy signature:              answered with the code word');
    expect(out).toContain('as returned (real signature kept):                answered with the code word');
    expect(out).toMatch(/NOTE\s+native-tools: real signature accepted; rebuilt like the app accepted; documented dummy accepted; no signature \(the app before the fix\) not accepted/);
    expect(out).toMatch(/NOTE\s+native-tools: cheapest fix that works \(real signature > dummy > none\): send the real signature back/);
    expect(out).toMatch(/NOTE\s+native-tools: the replay without a signature FAILED and the replay as returned passed/);
    expect(out).toContain('PASS  native-tools');
  });

  it('native-tools: a refused dummy is reported as such — the check passes, and says unsigned history still fails', async () => {
    const api = fakeApi({ signature: true, nativeNeedsSignature: true, nativeRejectsDummy: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    expect(code).toBe(0);
    expect(out).toMatch(/with the documented dummy signature:\s+FAILED \(HTTP 400/);
    expect(out).toMatch(/documented dummy not accepted/);
    expect(out).toMatch(/NOTE\s+native-tools: the dummy was NOT accepted, so history that carries no signature/);
  });

  it('native-tools: names the dummy when the real signature replay is the one refused', async () => {
    const api = fakeApi({ signature: true, nativeNeedsSignature: true, nativeRejectsRealSignature: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    // What the app sends when it has the signature failed: red.
    expect(code).toBe(1);
    expect(out).toContain('FAIL  native-tools — HTTP 400');
    expect(out).toMatch(/cheapest fix that works \(real signature > dummy > none\): send the documented dummy/);
  });

  it('native-tools: says none needed when a replay without any signature is answered', async () => {
    const api = fakeApi({ signature: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    expect(code).toBe(0);
    // With every replay accepted the real signature still leads the order.
    expect(out).toMatch(/cheapest fix that works \(real signature > dummy > none\): send the real signature back/);
    const none = await run(['--only', 'native-tools'], fakeApi({ signature: true, nativeRejectsRealSignature: true, nativeRejectsDummy: true }));
    expect(none.out).toMatch(/cheapest fix that works \(real signature > dummy > none\): none needed/);
    expect(none.code).toBe(1);
  });

  it('native-tools: red, with the reason, when every replay is refused', async () => {
    const api = fakeApi({ signature: true, nativeRejectsAllReplays: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    expect(code).toBe(1);
    expect(out).toContain('FAIL  native-tools — HTTP 400');
    expect(out).toMatch(/none of the replays was answered/);
    expect(api.seen).toHaveLength(5);
  });

  it('native-tools: red, and no replay sent, when the first request is refused', async () => {
    const api = fakeApi({ nativeFirstCallFails: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    expect(code).toBe(1);
    expect(out).toContain('FAIL  native-tools — HTTP 500');
    expect(api.seen).toHaveLength(1);
  });

  it('native-tools: says so when the first reply carries no signature at all', async () => {
    const api = fakeApi({ signature: false });
    const { out } = await run(['--only', 'native-tools'], api);
    expect(out).toMatch(/NOTE\s+native-tools: the first reply carried no thought signature/);
  });

  it('--model drives every request: the compat bodies and the native URL', async () => {
    const api = fakeApi({ signature: true });
    const { code, out } = await run(['--model', 'gemini-3.8-flash'], api);
    expect(code).toBe(0);
    expect(api.seen).toHaveLength(12);
    expect(out).toContain('Model: gemini-3.8-flash.');
    for (const { url, body } of api.seen) {
      if (url.includes(':generateContent')) expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
      else expect(body.model).toBe('gemini-3.8-flash');
    }
  });

  it('without --model, nothing about the requests changes: gemini-4-argon everywhere', async () => {
    const api = fakeApi({ signature: true });
    await run([], api);
    for (const { url, body } of api.seen) {
      if (url.includes(':generateContent')) expect(url).toBe(v.NATIVE_URL);
      else expect(body.model).toBe('gemini-4-argon');
    }
  });

  it('stream: sends the CLI\'s shape (stream + include_usage) and reports the usage chunks', async () => {
    const api = fakeApi();
    const { code, out } = await run(['--only', 'stream'], api);
    expect(code).toBe(0);
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(out).toMatch(/chunks:\s+4, of which carrying usage: 1/);
    expect(out).toContain('usage (last):  {"prompt_tokens":47,"completion_tokens":7,"total_tokens":207}');
    expect(out).toMatch(/content:\s+ready/);
    expect(out).toMatch(/NOTE\s+stream: total_tokens exceeds prompt \+ completion by 153/);
    expect(out).toContain('PASS  stream');
  });

  it('stream: says when usage arrives on several chunks, or on none', async () => {
    const many = await run(['--only', 'stream'], fakeApi({ usageOnEveryChunk: true }));
    expect(many.out).toMatch(/NOTE\s+stream: usage arrived on \d+ chunks\. chat\(\) records every chunk/);
    const none = await run(['--only', 'stream'], fakeApi({ noStreamUsage: true }));
    expect(none.out).toMatch(/NOTE\s+stream: the stream carried no usage chunk/);
  });

  it('stream-tools: assembles the streamed tool call and checks its arguments are JSON', async () => {
    const api = fakeApi();
    const { code, out } = await run(['--only', 'stream-tools'], api);
    expect(code).toBe(0);
    expect(api.seen[0].body).toMatchObject({ stream: true, tools: expect.any(Array) });
    expect(out).toContain('tool_calls:    read_file({"path":"notes.txt"})');
    expect(out).toContain('PASS  stream-tools');
  });

  it('prints WHERE a signature sits, as a path, never its value', async () => {
    const { out } = await run(['--only', 'native-tools'], fakeApi({ signature: true }));
    expect(out).toContain('at content.parts[0].thoughtSignature');
    expect(out).not.toContain('c2lnbmF0dXJl');
    const compat = await run(['--only', 'tools'], fakeApi({ signature: true }));
    expect(compat.out).toContain('at message.tool_calls[0].extra_content.google.thought_signature');
  });

  it('native-tools: red, and says why, when the signature does not sit where the app reads it', async () => {
    const api = fakeApi({ nativeSignatureElsewhere: true, nativeNeedsSignature: true });
    const { code, out } = await run(['--only', 'native-tools'], api);
    // The reference replay (as returned) is answered; the app-style rebuild is not.
    expect(code).toBe(1);
    expect(out).toMatch(/NOTE\s+native-tools: the content as returned was answered but the content rebuilt like the app was NOT/);
    expect(out).toContain('at content.parts[0].thoughtSignature');
  });

  it('answers every parallel tool call in the OpenAI follow-up', async () => {
    const api = fakeApi({ openAiCalls: 3 });
    const { code, out } = await run(['--only', 'tools'], api);
    expect(code).toBe(0);
    const toolMessages = api.seen[1].body.messages.filter((m: { role: string }) => m.role === 'tool');
    expect(toolMessages.map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(['function-call-1', 'function-call-2', 'function-call-3']);
    expect(out).toMatch(/NOTE\s+tools: the model made 3 calls/);
  });

  it('never echoes a key given by mistake as an argument', async () => {
    const api = fakeApi();
    const { code, err } = await run([KEY], api, null, { GOOGLE_API_KEY: 'another-key-0123456789' });
    expect(code).toBe(2);
    expect(err).toContain('unknown option');
    expect(err).not.toContain(KEY);
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  // Two layers, each held on its own: parseArgs redacts what it echoes, and
  // main redacts whatever message reaches stderr (`--only <key>` is echoed by
  // a message parseArgs does not redact).
  it('parseArgs itself redacts an echoed option', () => {
    let message = '';
    try { v.parseArgs([KEY]); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('unknown option');
    expect(message).not.toContain(KEY);
  });

  it('main redacts the key from any usage error, including a value it echoes', async () => {
    const api = fakeApi();
    const { code, err } = await run(['--only', KEY], api, null, { GOOGLE_API_KEY: KEY });
    expect(code).toBe(2);
    expect(err).toContain('unknown check');
    expect(err).not.toContain(KEY);
  });

  it('reports a network failure without throwing, key redacted', async () => {
    const api = fakeApi();
    api.fetchImpl.mockRejectedValueOnce(new Error(`connect failed for key=${KEY}`));
    const { code, out } = await run(['--only', 'plain'], api);
    expect(code).toBe(1);
    expect(out).toContain('FAIL  plain');
    expect(out).not.toContain(KEY);
  });
});
