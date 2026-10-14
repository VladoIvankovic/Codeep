#!/usr/bin/env node
/**
 * Owner-run check of Gemini 4 Argon (`gemini-4-argon`) over the two paths
 * Codeep uses: Google's OpenAI-compatible Chat Completions endpoint (the CLI)
 * and the native `generateContent` API (the macOS app). NOT part of the build
 * or the test suite, and never run by CI: it spends money on the owner's key.
 *
 *   GOOGLE_API_KEY=… node scripts/verify-gemini-argon.mjs [--dry-run] [--model <id>]
 *
 * First run: the owner's, 2026-10-14 (CHANGELOG 3.12.0, docs/MODEL_MAINTENANCE.md
 * "Gemini 4 Argon"). It established that the compat path works, that the compat
 * `usage` leaves thinking out of `completion_tokens`, that native
 * `usageMetadata` reports `thoughtsTokenCount` apart, and that replaying a
 * function call WITHOUT its thoughtSignature is an HTTP 400. What is left, and
 * what this version of `native-tools` asks, is which replay the macOS app may
 * rely on: the real signature, the documented dummy, or none at all. `--model`
 * points every check at another model id (e.g. gemini-3.8-flash) to find out
 * whether Gemini 3.x behaves the same.
 *
 *   (a) plain     one chat completion, no sampling parameters, no cap set.
 *   (b) tools     a read_file-style function tool the model should call, then
 *                 the follow-up turn carrying the tool result. The assistant
 *                 message goes back EXACTLY as the API returned it — including
 *                 any `extra_content` — so a 400 on a missing or replayed
 *                 thought signature shows here. Whether a thought signature
 *                 came back at all is printed (its presence and length, never
 *                 its value).
 *   (c) effort    `reasoning_effort: "high"` with `max_tokens: 4096`. Argon
 *                 thinks inside max_tokens; `finish_reason: "length"` here is
 *                 not a failure, it is the reason Codeep floors Argon at 32,768.
 *                 The same prompt took 59.7 s here and 9.7 s natively on
 *                 2026-10-14; the elapsed time is the datum.
 *   (c2) stream   the same plain request STREAMED with `stream_options:
 *                 {include_usage: true}` — how the CLI sends every agent turn
 *                 and chat() reply, which no earlier run exercised. Prints how
 *                 many chunks carry `usage` (chat() records each one that has
 *                 it; the agent stream keeps the last) and the last verbatim.
 *   (c3) stream-tools
 *                 a streamed reply that should call read_file: the tool call
 *                 arrives as deltas and must assemble into valid JSON.
 *   (d) native    the macOS app's path: `models/<id>:generateContent` with
 *                 `thinkingConfig.thinkingLevel: "high"` and
 *                 `maxOutputTokens: 4096`. Prints `usageMetadata` verbatim, so
 *                 `thoughtsTokenCount` (reported apart from
 *                 `candidatesTokenCount`; billed as output) is visible.
 *   (e) native-tools
 *                 a function call, then FOUR follow-ups for the same call:
 *                   1. as the macOS app sent it before the signature fix: the
 *                      functionCall without any thoughtSignature, the
 *                      functionResponse named by the app's minted call id
 *                      "gemini-call-1";
 *                   2. with the documented dummy: the same content with
 *                      `thoughtSignature: "skip_thought_signature_validator"`
 *                      on the FIRST functionCall part, the functionResponse
 *                      named by the function — exactly what the app now sends
 *                      for history that carries no signature;
 *                   3. as returned: the content untouched (real signature
 *                      kept), the functionResponse named by the function —
 *                      Google's own shape, the reference;
 *                   4. rebuilt like the app: one part per call with
 *                      `{functionCall: {name, args}}` and the part's own
 *                      `thoughtSignature` beside it, nothing else — what the
 *                      app now sends when it has the signature. A signature
 *                      that sits anywhere but on that part is lost here as it
 *                      would be in the app, so this leg proves the placement.
 *                 Every leg uses `response: {content: …}`, the app's shape, so
 *                 they differ only in the signature and the response name.
 *                 It prints which replays were accepted, and where each
 *                 signature sits (a JSON path), and names the fix that works,
 *                 in the order real signature > dummy > none.
 *                 PASS means the first call produced a function call AND leg 4
 *                 (what the app sends) was answered with the code word. Legs
 *                 1–3 are probes: a refusal there is the expected result for
 *                 leg 1 and the finding for leg 2, so it is reported and never
 *                 turns the check — or the exit code — red.
 * For each request it prints the HTTP status, the `model` the API reports, the
 * `finish_reason`, the `usage` object exactly as returned (so cached and
 * reasoning token fields are visible, or visibly absent), and the elapsed
 * milliseconds; on a non-2xx it prints the error body. Exit code 0 when every
 * check passed, 1 when any failed, 2 on a usage error.
 *
 * At most 12 requests, all with one-line prompts, so the response comes back in
 * seconds and Node's own 300 s fetch timeouts never come into it. Google says a
 * hard prompt "can take several minutes" and to use client timeouts of at least
 * 15 minutes — this script's --timeout defaults to 240 s, below that on
 * purpose: a trivial prompt that needs longer is itself the finding.
 *
 * The key: read from GOOGLE_API_KEY only. It is never printed, never written,
 * and request headers are never logged. Every printed string — error bodies and
 * option errors included — has the key and anything shaped like a Google API
 * key (AIza…) replaced first.
 *
 * Before sending anything it prints the request count and the model and asks
 * y/N (default No; no answer is No). --dry-run prints the plan and the request
 * bodies and sends nothing — no key needed.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
export const MODEL = 'gemini-4-argon';
/** The native generateContent URL of a model id (the key goes in a header, never here). */
export function nativeUrl(model = MODEL) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
/** The native URL of the default model. */
export const NATIVE_URL = nativeUrl(MODEL);
export const MAX_REQUESTS = 12;
/** What Google documents for Gemini 3 as the stand-in for a signature you do not have. */
export const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
export const MODEL_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
export const DEFAULT_TIMEOUT_SECONDS = 240;
export const EFFORT_MAX_TOKENS = 4096;
export const CODE_WORD = 'PELICAN';

export const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file. Use this to examine existing files.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file relative to project root' } },
      required: ['path'],
    },
  },
};

const USAGE = `Usage: node scripts/verify-gemini-argon.mjs [options]

  --dry-run          print the plan and the request bodies; send nothing
  --model <id>       the model id to check (default ${MODEL}); 3-64 of A-Z a-z 0-9 . _ -
  --only <a,b,c>     run only these checks (plain, tools, effort, stream, stream-tools, native, native-tools); default all
  --timeout <sec>    per request, 10..900 (default ${DEFAULT_TIMEOUT_SECONDS})
  --help             this text

Reads GOOGLE_API_KEY from the environment. Asks y/N before sending.`;

const CHECKS = ['plain', 'tools', 'effort', 'stream', 'stream-tools', 'native', 'native-tools'];
// Requests each check sends: tools is a call and a follow-up; native-tools a call and four replays.
const REQUESTS = { plain: 1, tools: 2, effort: 1, stream: 1, 'stream-tools': 1, native: 1, 'native-tools': 5 };

// ─── Arguments and plan ──────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { dryRun: false, help: false, model: MODEL, only: [...CHECKS], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--model') {
      const id = value();
      // The value is never echoed: a key pasted here by mistake matches the
      // id pattern, so anything shaped like one is refused by name too.
      if (!MODEL_PATTERN.test(id) || /^AIza/.test(id)) throw new Error('--model must be a model id of 3 to 64 letters, digits, dots, dashes or underscores');
      opts.model = id;
    } else if (arg === '--only') {
      const ids = value().split(',').map(s => s.trim()).filter(Boolean);
      const unknown = ids.filter(id => !CHECKS.includes(id));
      if (unknown.length || ids.length === 0) throw new Error(`unknown check: ${unknown.join(', ') || '(none)'}`);
      opts.only = CHECKS.filter(id => ids.includes(id));
    } else if (arg === '--timeout') {
      const raw = value();
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 10 || n > 900) throw new Error('--timeout must be a whole number of seconds from 10 to 900');
      opts.timeoutSeconds = n;
    } else throw new Error(`unknown option: ${redactSecrets(arg)}`);
  }
  return opts;
}

/** The requests the selected checks can send (see REQUESTS). */
export function planRequests(opts) {
  const requests = opts.only.reduce((n, id) => n + REQUESTS[id], 0);
  if (requests > MAX_REQUESTS) throw new Error(`plan has ${requests} requests; the cap is ${MAX_REQUESTS}`);
  return { checks: opts.only, requests };
}

// ─── Request bodies ──────────────────────────────────────────────────────────
// No temperature, top_p or top_k anywhere: Argon ignores them, and Codeep omits
// them for it.

export function plainBody(model = MODEL) {
  return { model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] };
}

const TOOL_PROMPT = 'Use the read_file tool to read notes.txt, then reply with the code word only.';

export function toolBody(model = MODEL) {
  return {
    model,
    messages: [{ role: 'user', content: TOOL_PROMPT }],
    tools: [READ_FILE_TOOL],
    tool_choice: 'auto',
  };
}

/**
 * The follow-up turn: the user prompt, the assistant message exactly as the API
 * returned it (never rebuilt — a thought signature or any other extra field
 * rides along), and the tool's result for its call.
 */
export function toolFollowUpBody(assistantMessage, toolCallIds, model = MODEL) {
  // Every call the model made gets an answer: an unanswered one is a 400 that
  // would read as a thought-signature problem.
  const ids = Array.isArray(toolCallIds) ? toolCallIds : [toolCallIds];
  return {
    model,
    messages: [
      { role: 'user', content: TOOL_PROMPT },
      assistantMessage,
      ...ids.map(id => ({ role: 'tool', tool_call_id: id, content: `The code word is ${CODE_WORD}.` })),
    ],
    tools: [READ_FILE_TOOL],
    tool_choice: 'auto',
  };
}

export function effortBody(model = MODEL) {
  return {
    model,
    messages: [{ role: 'user', content: 'What is 17 times 23? Answer with the number only.' }],
    reasoning_effort: 'high',
    max_tokens: EFFORT_MAX_TOKENS,
  };
}

/** A streamed variant of a body: what the CLI's agent and chat() send. */
export function streamBody(body) {
  return { ...body, stream: true, stream_options: { include_usage: true } };
}

// The native API, as the macOS app builds it (GoogleProtocolClient): roles
// user/model, `generationConfig.maxOutputTokens`, `thinkingConfig.thinkingLevel`,
// no temperature/topP/topK.

const NATIVE_READ_FILE = {
  functionDeclarations: [{
    name: 'read_file',
    description: 'Read the contents of a file. Use this to examine existing files.',
    parameters: {
      type: 'OBJECT',
      properties: { path: { type: 'STRING', description: 'Path to the file relative to project root' } },
      required: ['path'],
    },
  }],
};

export function nativeBody() {
  return {
    contents: [{ role: 'user', parts: [{ text: 'What is 17 times 23? Answer with the number only.' }] }],
    generationConfig: { maxOutputTokens: EFFORT_MAX_TOKENS, thinkingConfig: { thinkingLevel: 'high' } },
  };
}

export function nativeToolBody() {
  return {
    contents: [{ role: 'user', parts: [{ text: TOOL_PROMPT }] }],
    tools: [NATIVE_READ_FILE],
  };
}

/** A copy of `value` with every thoughtSignature key removed (what the app replayed). */
export function withoutThoughtSignatures(value) {
  if (Array.isArray(value)) return value.map(withoutThoughtSignatures);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^thought_?signature$/i.test(k)) continue;
      out[k] = withoutThoughtSignatures(v);
    }
    return out;
  }
  return value;
}

/**
 * `content` with no signature anywhere except the dummy, set on the FIRST
 * functionCall part only (Google ships a real signature on the first of a
 * turn's parallel calls only, and validates that one).
 */
export function withDummyThoughtSignature(content) {
  const bare = withoutThoughtSignatures(content);
  let done = false;
  return {
    ...bare,
    parts: (bare.parts ?? []).map(part => {
      if (done || !part.functionCall) return part;
      done = true;
      return { ...part, thoughtSignature: DUMMY_THOUGHT_SIGNATURE };
    }),
  };
}

/**
 * The model turn the way the macOS app rebuilds it (GoogleProtocolClient): one
 * part per call, `{functionCall: {name, args}}`, with the part's own
 * `thoughtSignature` beside it when there is one. Text and thought parts are
 * not carried over.
 */
export function rebuiltLikeTheApp(content) {
  return {
    role: 'model',
    parts: (content?.parts ?? []).filter(part => part.functionCall).map(part => ({
      functionCall: { name: part.functionCall.name, args: part.functionCall.args ?? {} },
      ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
    })),
  };
}

/** The four ways the follow-up of a function call can be replayed. */
export const REPLAY_MODES = ['app-before', 'dummy', 'returned', 'app-now'];

/**
 * The follow-up turn on the native API. `modelContent` is the candidate's
 * `content` as returned.
 *
 *   'app-before'  what the macOS app sent before the fix: the functionCall
 *                 parts without any thoughtSignature, the functionResponse
 *                 named by the app's minted call id (gemini-call-N).
 *   'dummy'       the same content with the documented dummy on the first
 *                 functionCall part; the functionResponse named by the function.
 *   'returned'    the content untouched, signature kept; the functionResponse
 *                 named by the function, as Google's documentation shows.
 *   'app-now'     what the macOS app sends after the fix: the content REBUILT
 *                 from the functionCall (name, args) and the `thoughtSignature`
 *                 read from the same part — the one place the app looks — and
 *                 nothing else. A signature that sits anywhere else is lost
 *                 here exactly as it would be in the app, so this leg, not
 *                 'returned', is the one that proves the placement.
 *
 * `response` is `{content: …}` in all three — the app's own shape (the
 * owner's first run passed with `{result: …}`; the response is a free-form
 * struct) — so the replays differ only in the signature and the name.
 */
export function nativeToolFollowUpBody(modelContent, { mode }) {
  if (!REPLAY_MODES.includes(mode)) throw new Error(`unknown replay mode: ${mode}`);
  const calls = (modelContent?.parts ?? []).filter(part => part.functionCall);
  const model = mode === 'app-before'
    ? withoutThoughtSignatures(modelContent)
    : mode === 'dummy' ? withDummyThoughtSignature(modelContent)
    : mode === 'app-now' ? rebuiltLikeTheApp(modelContent)
    : modelContent;
  return {
    contents: [
      { role: 'user', parts: [{ text: TOOL_PROMPT }] },
      model,
      {
        role: 'user',
        parts: calls.map((part, i) => ({
          functionResponse: {
            name: mode === 'app-before' ? `gemini-call-${i + 1}` : part.functionCall.name,
            response: { content: `The code word is ${CODE_WORD}.` },
          },
        })),
      },
    ],
    tools: [NATIVE_READ_FILE],
  };
}

// ─── Keeping secrets out ─────────────────────────────────────────────────────

/** Replace the key itself and anything shaped like a Google API key or a bearer token. */
export function redactSecrets(text, key) {
  let out = String(text ?? '');
  if (key) out = out.split(key).join('[REDACTED]');
  return out
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1[REDACTED]');
}

// ─── Reading a reply ─────────────────────────────────────────────────────────

/** Where a thought signature sits in a value, as lengths only — never the text. */
export function thoughtSignatureLengths(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) thoughtSignatureLengths(item, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^thought_?signature$/i.test(k) && typeof v === 'string') found.push(v.length);
      else thoughtSignatureLengths(v, found);
    }
  }
  return found;
}

/**
 * Where thought signatures sit in a value, as JSON paths — never the text. The
 * macOS app reads `parts[i].thoughtSignature` only, so WHERE one sits matters.
 */
export function thoughtSignaturePaths(value, base = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => thoughtSignaturePaths(item, `${base}[${i}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = base ? `${base}.${k}` : k;
      if (/^thought_?signature$/i.test(k) && typeof v === 'string') found.push(path);
      else thoughtSignaturePaths(v, path, found);
    }
  }
  return found;
}

function excerpt(text, max = 120) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function errorMessage(text) {
  try {
    const j = JSON.parse(text);
    const first = Array.isArray(j) ? j[0] : j;
    return String(first?.error?.message ?? first?.message ?? text).slice(0, 400);
  } catch {
    return String(text).slice(0, 400);
  }
}

// ─── Running ─────────────────────────────────────────────────────────────────

/** y/N on the given streams. Anything but y/yes — including no answer — is No. */
export function confirm(question, input, output) {
  return new Promise(resolvePromise => {
    const rl = createInterface({ input, output, terminal: false });
    let answered = false;
    output.write(`${question} [y/N] `);
    rl.once('line', line => {
      answered = true;
      rl.close();
      resolvePromise(/^(y|yes)$/i.test(line.trim()));
    });
    rl.once('close', () => { if (!answered) resolvePromise(false); });
  });
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const key = env.GOOGLE_API_KEY;
  const say = (text) => stdout.write(`${redactSecrets(text, key)}\n`);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`${redactSecrets(err.message, key)}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) { say(USAGE); return 0; }
  // A key under --model passes the id pattern when it is not shaped like a
  // Google key; it must not become a URL path or a request body.
  if (key && opts.model.includes(key)) {
    stderr.write(`--model must be a model id, not a key\n\n${USAGE}\n`);
    return 2;
  }
  const model = opts.model;
  const nativeEndpoint = nativeUrl(model);

  const plan = planRequests(opts);
  say(`Plan: at most ${plan.requests} request(s) to ${plan.checks.some(id => id.startsWith('native')) ? `${API_URL} and ${nativeEndpoint}` : API_URL}`);
  say(`Model: ${model}. Checks: ${plan.checks.join(', ')}. No sampling parameters are sent. Timeout ${opts.timeoutSeconds} s each.`);

  if (opts.dryRun) {
    const bodies = { plain: plainBody(model), tools: toolBody(model), effort: effortBody(model), stream: streamBody(plainBody(model)), 'stream-tools': streamBody(toolBody(model)), native: nativeBody(), 'native-tools': nativeToolBody() };
    const notes = {
      tools: ' (1 of 2; the follow-up replays the reply as returned)',
      stream: ' (the CLI\'s own shape: streamed, usage requested in the stream)',
      'native-tools': ' (1 of 5; four follow-ups replay the reply — as the macOS app sent it before the fix, with the documented dummy signature, as returned, and rebuilt the way the app rebuilds it; shapes below)',
    };
    for (const id of plan.checks) {
      say(`\n# ${id} — request body${notes[id] ?? ''}${id.startsWith('native') ? `\n# POST ${nativeEndpoint}` : ''}`);
      say(JSON.stringify(bodies[id], null, 2));
      if (id === 'native-tools') {
        // Stand-in for the reply of request 1, to show the shape of each replay.
        const standIn = { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'notes.txt' } }, thoughtSignature: '<as returned>' }] };
        for (const mode of REPLAY_MODES) {
          say(`\n# native-tools — follow-up, replay '${mode}'`);
          say(JSON.stringify(nativeToolFollowUpBody(standIn, { mode }), null, 2));
        }
      }
    }
    say('\nDry run: nothing was sent.');
    return 0;
  }

  if (!key) {
    stderr.write('GOOGLE_API_KEY is not set. Nothing was sent.\n');
    return 1;
  }
  const yes = await confirm(`Send up to ${plan.requests} request(s) to Google?`, io.stdin ?? process.stdin, stdout);
  if (!yes) {
    say('Aborted — nothing was sent.');
    return 1;
  }

  let sent = 0;
  /**
   * One request. Returns what the checks need; prints what the owner needs.
   * `native` posts to the native generateContent API (key in a header, never in
   * the URL); otherwise to the OpenAI-compatible endpoint.
   */
  const send = async (label, body, native = false) => {
    if (sent >= MAX_REQUESTS) throw new Error('request cap reached');
    sent++;
    say(`\n→ ${label}`);
    const started = Date.now();
    let status = 0;
    let text = '';
    let networkError = null;
    try {
      const res = await fetchImpl(native ? nativeEndpoint : API_URL, {
        method: 'POST',
        headers: native
          ? { 'Content-Type': 'application/json', 'x-goog-api-key': key }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutSeconds * 1000),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      networkError = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `no answer within ${opts.timeoutSeconds} s`
        : `network: ${err?.message ?? String(err)}`;
    }
    const elapsedMs = Date.now() - started;
    say(`  status:        ${status || '(none)'}`);
    say(`  elapsed:       ${elapsedMs} ms`);
    if (networkError) {
      say(`  error:         ${networkError}`);
      return { label, ok: false, status, elapsedMs, message: null, json: null, failure: networkError };
    }
    const ok = status >= 200 && status < 300;
    if (!ok) {
      say(`  error body:    ${text.slice(0, 2000)}`);
      return { label, ok: false, status, elapsedMs, message: null, json: null, failure: `HTTP ${status} — ${errorMessage(text)}` };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* reported below */ }
    if (!json) {
      say(`  body:          ${text.slice(0, 500)}`);
      return { label, ok: false, status, elapsedMs, message: null, json: null, failure: 'the reply was not JSON' };
    }
    if (native) {
      const candidate = json.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      say(`  modelVersion:  ${json.modelVersion ?? '(not reported)'}`);
      say(`  finishReason:  ${candidate?.finishReason ?? '(none)'}`);
      say(`  usageMetadata: ${json.usageMetadata === undefined ? '(none)' : JSON.stringify(json.usageMetadata)}`);
      if (!candidate) return { label, ok: false, status, elapsedMs, message: null, json, failure: 'the reply had no candidates' };
      const calls = parts.filter(part => part.functionCall);
      const answer = parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
      say(`  text:          ${excerpt(answer) || '(empty)'}`);
      if (calls.length) say(`  functionCalls: ${calls.map(c => `${c.functionCall.name}(${JSON.stringify(c.functionCall.args ?? {})})`).join('; ')}`);
      const signatures = thoughtSignatureLengths(candidate.content);
      say(`  thought signature in the content: ${signatures.length ? `yes (${signatures.length}; lengths ${signatures.join(', ')}; at ${thoughtSignaturePaths(candidate.content, 'content').join(', ')})` : 'no'}`);
      return { label, ok: true, status, elapsedMs, message: candidate.content, calls, text: answer, json, finishReason: candidate.finishReason, failure: null };
    }
    const choice = json.choices?.[0];
    say(`  model:         ${json.model ?? '(not reported)'}`);
    say(`  finish_reason: ${choice?.finish_reason ?? '(none)'}`);
    say(`  usage:         ${json.usage === undefined ? '(none)' : JSON.stringify(json.usage)}`);
    if (!choice) return { label, ok: false, status, elapsedMs, message: null, json, failure: 'the reply had no choices' };
    const toolCalls = choice.message?.tool_calls ?? [];
    say(`  content:       ${excerpt(choice.message?.content) || '(empty)'}`);
    if (toolCalls.length) say(`  tool_calls:    ${toolCalls.map(c => `${c.function?.name}(${c.function?.arguments ?? ''})`).join('; ')}`);
    const signatures = thoughtSignatureLengths(choice.message);
    say(`  thought signature in the message: ${signatures.length ? `yes (${signatures.length}; lengths ${signatures.join(', ')}; at ${thoughtSignaturePaths(choice.message, 'message').join(', ')})` : 'no'}`);
    return { label, ok: true, status, elapsedMs, message: choice.message, json, finishReason: choice.finish_reason, failure: null };
  };

  const results = [];
  const notes = [];
  const record = (check, failure) => results.push({ check, failure });

  /**
   * A STREAMED request on the compat endpoint, the way the CLI sends every
   * agent turn and chat() reply: `stream: true` with the usage requested in
   * the stream. Prints how many chunks carried `usage` (chat() records each
   * chunk that has it; the agent stream keeps the last), the last one verbatim,
   * the assembled content and tool calls, and where signatures sit.
   */
  const sendStream = async (label, body) => {
    if (sent >= MAX_REQUESTS) throw new Error('request cap reached');
    sent++;
    say(`\n→ ${label}`);
    const started = Date.now();
    let status = 0;
    let text = '';
    let firstChunkMs = null;
    let networkError = null;
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutSeconds * 1000),
      });
      status = res.status;
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;
          text += decoder.decode(value, { stream: true });
        }
      } else {
        text = await res.text();
      }
    } catch (err) {
      networkError = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `no answer within ${opts.timeoutSeconds} s`
        : `network: ${err?.message ?? String(err)}`;
    }
    const elapsedMs = Date.now() - started;
    say(`  status:        ${status || '(none)'}`);
    say(`  elapsed:       ${elapsedMs} ms${firstChunkMs === null ? '' : ` (first bytes after ${firstChunkMs} ms)`}`);
    if (networkError) { say(`  error:         ${networkError}`); return { failure: networkError }; }
    if (status < 200 || status >= 300) {
      say(`  error body:    ${text.slice(0, 2000)}`);
      return { failure: `HTTP ${status} — ${errorMessage(text)}` };
    }
    const chunks = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      try { chunks.push(JSON.parse(payload)); } catch { /* a partial line is not a chunk */ }
    }
    if (chunks.length === 0) { say(`  body:          ${excerpt(text, 300)}`); return { failure: 'the stream had no data chunks' }; }
    const usageChunks = chunks.filter(c => c.usage !== undefined && c.usage !== null);
    const lastUsage = usageChunks.length ? usageChunks[usageChunks.length - 1].usage : null;
    const finish = [...chunks].reverse().map(c => c.choices?.[0]?.finish_reason).find(Boolean);
    const content = chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
    const toolCalls = [];
    for (const c of chunks) {
      for (const d of c.choices?.[0]?.delta?.tool_calls ?? []) {
        const i = d.index ?? 0;
        toolCalls[i] ??= { name: '', args: '' };
        if (d.function?.name) toolCalls[i].name += d.function.name;
        if (d.function?.arguments) toolCalls[i].args += d.function.arguments;
      }
    }
    say(`  chunks:        ${chunks.length}, of which carrying usage: ${usageChunks.length}`);
    say(`  usage (last):  ${lastUsage === null ? '(none)' : JSON.stringify(lastUsage)}`);
    say(`  finish_reason: ${finish ?? '(none)'}`);
    say(`  content:       ${excerpt(content) || '(empty)'}`);
    const calls = toolCalls.filter(Boolean);
    if (calls.length) say(`  tool_calls:    ${calls.map(c => `${c.name}(${c.args})`).join('; ')}`);
    const paths = thoughtSignaturePaths(chunks.map(c => c.choices?.[0]?.delta ?? {}), 'delta');
    say(`  thought signature in the stream: ${paths.length ? `yes (${paths.length}; at ${paths.join(', ')})` : 'no'}`);
    if (usageChunks.length === 0) {
      notes.push(`${label.split(':')[0]}: the stream carried no usage chunk — the CLI would record no tokens for this reply.`);
    } else {
      if (usageChunks.length > 1) {
        notes.push(`${label.split(':')[0]}: usage arrived on ${usageChunks.length} chunks. chat() records every chunk that carries it, so it would add them up; the agent stream keeps the last.`);
      }
      const gap = (lastUsage.total_tokens ?? 0) - (lastUsage.prompt_tokens ?? 0) - (lastUsage.completion_tokens ?? 0);
      if (gap > 0) notes.push(`${label.split(':')[0]}: total_tokens exceeds prompt + completion by ${gap} — thinking tokens, left out of completion_tokens; the CLI adds them for Google.`);
    }
    return { failure: null, chunks, calls, content, usageChunks, lastUsage, finish };
  };

  if (plan.checks.includes('plain')) {
    const r = await send('plain: one chat completion, no sampling parameters', plainBody(model));
    record('plain', r.failure);
  }

  if (plan.checks.includes('tools')) {
    const first = await send('tools 1/2: a function tool the model should call', toolBody(model));
    let failure = first.failure;
    if (!failure) {
      const calls = first.message?.tool_calls ?? [];
      const call = calls[0];
      if (!call) failure = 'the model did not call read_file';
      else if (call.function?.name !== 'read_file') failure = `the model called ${call.function?.name}, not read_file`;
      else {
        if (calls.length > 1) notes.push(`tools: the model made ${calls.length} calls in one reply; every one is answered in the follow-up.`);
        const second = await send('tools 2/2: the follow-up turn, the reply replayed as returned', toolFollowUpBody(first.message, calls.map(c => c.id), model));
        failure = second.failure;
        if (!failure && !String(second.message?.content ?? '').includes(CODE_WORD)) {
          failure = `the answer does not contain the code word from the tool result (${CODE_WORD})`;
        }
      }
    }
    record('tools', failure);
  }

  if (plan.checks.includes('effort')) {
    const r = await send(`effort: reasoning_effort "high", max_tokens ${EFFORT_MAX_TOKENS}`, effortBody(model));
    record('effort', r.failure);
    if (!r.failure && r.finishReason === 'length') {
      notes.push(`effort: finish_reason "length" at max_tokens ${EFFORT_MAX_TOKENS} — thinking used the cap. Not a failure; it is why Codeep sends Argon at least 32,768.`);
    }
  }

  if (plan.checks.includes('stream')) {
    const r = await sendStream('stream: one streamed chat completion, usage requested in the stream', streamBody(plainBody(model)));
    record('stream', r.failure ?? (r.content.trim() === '' ? 'the stream had no content' : null));
  }

  if (plan.checks.includes('stream-tools')) {
    const r = await sendStream('stream-tools: a streamed reply that should call read_file', streamBody(toolBody(model)));
    let failure = r.failure;
    if (!failure) {
      if (r.calls.length === 0) failure = 'the stream carried no tool call';
      else if (r.calls[0].name !== 'read_file') failure = `the model called ${r.calls[0].name}, not read_file`;
      else {
        try { JSON.parse(r.calls[0].args); } catch { failure = 'the streamed tool-call arguments are not valid JSON once assembled'; }
      }
    }
    record('stream-tools', failure);
  }

  if (plan.checks.includes('native')) {
    const r = await send(`native: generateContent, thinkingLevel "high", maxOutputTokens ${EFFORT_MAX_TOKENS}`, nativeBody(), true);
    record('native', r.failure);
    if (!r.failure) {
      const u = r.json.usageMetadata ?? {};
      if (u.thoughtsTokenCount === undefined) {
        notes.push('native: usageMetadata has no thoughtsTokenCount — this reply reported no thinking tokens apart from candidatesTokenCount (Argon did on 2026-10-14: 132 beside 7).');
      } else {
        notes.push(`native: thoughtsTokenCount ${u.thoughtsTokenCount} is reported apart from candidatesTokenCount ${u.candidatesTokenCount ?? '(none)'}, and Google bills it as output; a client that reads candidatesTokenCount alone under-counts output by that much. The macOS app adds it.`);
      }
      if (r.finishReason === 'MAX_TOKENS') {
        notes.push(`native: finishReason MAX_TOKENS at maxOutputTokens ${EFFORT_MAX_TOKENS} — thinking used the cap; not a failure.`);
      }
    }
  }

  if (plan.checks.includes('native-tools')) {
    const first = await send('native-tools 1/5: a function call', nativeToolBody(), true);
    let failure = first.failure;
    if (!failure) {
      const call = (first.calls ?? [])[0];
      if (!call) failure = 'the model did not call read_file';
      else if (call.functionCall.name !== 'read_file') failure = `the model called ${call.functionCall.name}, not read_file`;
      else {
        const replay = (n, label, mode) => send(`native-tools ${n}/5: ${label}`, nativeToolFollowUpBody(first.message, { mode }), true);
        // 1. What the macOS app sent before the fix: no signature, the response
        //    named by its minted call id. Refused with a 400 on 2026-10-14.
        const before = await replay(2, 'the follow-up as the macOS app sent it before the fix (no thoughtSignature, response named gemini-call-1)', 'app-before');
        // 2. What the app now sends for history that carries no signature.
        const dummy = await replay(3, `the follow-up with the documented dummy ("${DUMMY_THOUGHT_SIGNATURE}") on the first functionCall`, 'dummy');
        // 3. Google's content, untouched: the reference that must work.
        const returned = await replay(4, 'the follow-up as returned (real signature kept)', 'returned');
        // 4. What the app now sends when it has the signature: rebuilt from the
        //    functionCall and `part.thoughtSignature` only — the proof of placement.
        const appNow = await replay(5, 'the follow-up rebuilt the way the macOS app rebuilds it (functionCall + part.thoughtSignature only)', 'app-now');

        const answered = (r) => !r.failure && String(r.text ?? '').includes(CODE_WORD);
        const worded = (r) => (r.failure ? `FAILED (${r.failure})` : (answered(r) ? 'answered with the code word' : 'answered without the code word'));
        say('  follow-up replays:');
        say(`    as the app sent it before the fix (no signature): ${worded(before)}`);
        say(`    with the documented dummy signature:              ${worded(dummy)}`);
        say(`    as returned (real signature kept):                ${worded(returned)}`);
        say(`    rebuilt the way the app rebuilds it (the fix):    ${worded(appNow)}`);

        const yn = (r) => (answered(r) ? 'accepted' : 'not accepted');
        notes.push(`native-tools: real signature ${yn(returned)}; rebuilt like the app ${yn(appNow)}; documented dummy ${yn(dummy)}; no signature (the app before the fix) ${yn(before)}.`);
        if (answered(returned) && !answered(appNow)) {
          notes.push('native-tools: the content as returned was answered but the content rebuilt like the app was NOT — the signature does not sit where the app reads it (part.thoughtSignature), or something else the rebuild drops matters. The macOS fix is not enough.');
        }
        const fix = answered(returned) ? 'send the real signature back (the app now does)'
          : answered(dummy) ? 'send the documented dummy (the real signature replay failed — see its error)'
          : answered(before) ? 'none needed: the replay without any signature was answered'
          : null;
        notes.push(fix
          ? `native-tools: cheapest fix that works (real signature > dummy > none): ${fix}.`
          : 'native-tools: none of the replays was answered — not a signature problem alone; see the error bodies above.');
        if (answered(returned) && !answered(dummy)) {
          notes.push('native-tools: the dummy was NOT accepted, so history that carries no signature (a conversation from before the fix, or from another provider) still fails on a replayed call.');
        }
        if (answered(returned) && !answered(before)) {
          notes.push('native-tools: the replay without a signature FAILED and the replay as returned passed — the app must send thought signatures back.');
        }
        if (thoughtSignatureLengths(first.message).length === 0) {
          notes.push('native-tools: the first reply carried no thought signature at all, so "as returned" replays none and the three legs are not distinct.');
        }
        // PASS is what the app now sends. Legs 1 and 2 are probes (leg 1 is
        // expected to be refused, leg 2 is the finding) and leg 3 is the
        // reference: only the rebuilt-like-the-app leg decides.
        failure = appNow.failure ?? (answered(appNow) ? null : `the answer to the app-style rebuilt replay does not contain the code word (${CODE_WORD})`);
      }
    }
    record('native-tools', failure);
  }

  say('\n── Result ──');
  for (const r of results) say(`${r.failure ? 'FAIL' : 'PASS'}  ${r.check}${r.failure ? ` — ${r.failure}` : ''}`);
  for (const n of notes) say(`NOTE  ${n}`);
  say(`Requests sent: ${sent}`);
  return results.every(r => !r.failure) ? 0 : 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(code => { process.exitCode = code; }, err => {
    process.stderr.write(`${redactSecrets(err?.stack ?? String(err), process.env.GOOGLE_API_KEY)}\n`);
    process.exitCode = 1;
  });
}
