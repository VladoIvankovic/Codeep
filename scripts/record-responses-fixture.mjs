#!/usr/bin/env node
/**
 * Owner-run recording of real OpenAI Responses API streams, for Codeep's
 * Responses transport (src/api/responses.ts). NOT part of the build or the
 * test suite, and never run by CI: it spends money on the owner's key.
 *
 *   OPENAI_API_KEY=… node scripts/record-responses-fixture.mjs [--dry-run]
 *
 * What it does
 *   Runs a two-step tool loop (a read_file-style tool, then the answer) the way
 *   the transport does — store:false, include:["reasoning.encrypted_content"],
 *   function tools with strict:false, the previous turn's output items replayed
 *   verbatim followed by one function_call_output per call — on:
 *     gpt-6-astra  at auto (no effort sent) and at high
 *     gpt-6-sol    at high, asked to read two files at once (parallel calls)
 *     gpt-5.6-luna at auto
 *   plus one probe: Astra's follow-up sent WITHOUT its reasoning items.
 *   That is 9 requests; the script refuses to plan more than 10. Prompts are a
 *   line long and max_output_tokens is small (default 2048).
 *
 * Before sending anything it prints the request count and the models and asks
 * y/N (default No; no answer is No). --dry-run prints the plan and the first
 * request bodies and sends nothing — no key needed.
 *
 * The key: read from OPENAI_API_KEY only. It is never printed, never written,
 * and request headers are never logged. Saved request files carry an
 * allowlisted Content-Type header only; saved response headers are an
 * allowlist too (x-request-id, content-type, openai-processing-ms,
 * openai-version). Anything shaped like an sk- key is redacted from every
 * printed or saved error body. encrypted_content is truncated in saved files —
 * tests never decrypt it.
 *
 * Output: src/utils/__fixtures__/responses/recorded/ — per request
 * <scenario>.<n>.request.json, <scenario>.<n>.sse (raw stream) and
 * <scenario>.<n>.response.json (status + allowlisted headers, error body if
 * any), and summary.json. A re-run overwrites them.
 *
 * The summary answers the design's open live questions:
 *   (a) is replayed reasoning accepted under store:false?
 *   (b) what does a GPT-6 follow-up WITHOUT its reasoning items get?
 *   (c) Astra's default effort (and the reasoning.context echoed);
 *   (d) are usage details present (cached_tokens, cache_write_tokens,
 *       reasoning_tokens)?
 * plus whether the model made parallel calls and whether any output item
 * carried `created_by` (replayed verbatim by the transport).
 */

import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_URL = 'https://api.openai.com/v1/responses';
export const MAX_REQUESTS = 10;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'utils', '__fixtures__', 'responses', 'recorded');

const INSTRUCTIONS = 'You are a test harness. Use the read_file tool when asked to read a file. Reply in one short line.';

/** The files the fake read_file tool serves. */
export const FAKE_FILES = {
  'notes.txt': 'The code word is PELICAN.',
  'todo.txt': '1. Water the plants.',
};

export const READ_FILE_TOOL = {
  type: 'function',
  name: 'read_file',
  description: 'Read the contents of a file. Use this to examine existing files.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to the file relative to project root' } },
    required: ['path'],
  },
  strict: false,
};

/**
 * Each scenario is two requests: the tool call, then the answer. `probe`
 * adds one more: the follow-up without the reasoning items.
 */
export const SCENARIOS = [
  { id: 'astra-auto', model: 'gpt-6-astra', effort: undefined, prompt: 'Use read_file to read notes.txt, then reply with the code word only.' },
  { id: 'astra-high', model: 'gpt-6-astra', effort: 'high', prompt: 'Use read_file to read notes.txt, then reply with the code word only.', probe: true },
  { id: 'sol-high-tools', model: 'gpt-6-sol', effort: 'high', prompt: 'Use read_file on notes.txt and on todo.txt — call both at once — then reply with the code word and the first todo, in one line.' },
  { id: 'luna-5.6', model: 'gpt-5.6-luna', effort: undefined, prompt: 'Use read_file to read notes.txt, then reply with the code word only.' },
];

const USAGE = `Usage: node scripts/record-responses-fixture.mjs [options]

  --dry-run                 print the plan and the first request bodies; send nothing
  --only <id,id>            run only these scenarios (${SCENARIOS.map(s => s.id).join(', ')})
  --out <dir>               where to save (default: src/utils/__fixtures__/responses/recorded)
  --max-output-tokens <n>   per request, 16..32768 (default ${DEFAULT_MAX_OUTPUT_TOKENS})
  --help                    this text

Reads OPENAI_API_KEY from the environment. Asks y/N before sending.`;

// ─── Arguments and plan ──────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { dryRun: false, help: false, only: SCENARIOS.map(s => s.id), outDir: DEFAULT_OUT_DIR, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--only') {
      const ids = value().split(',').map(s => s.trim()).filter(Boolean);
      const unknown = ids.filter(id => !SCENARIOS.some(s => s.id === id));
      if (unknown.length || ids.length === 0) throw new Error(`unknown scenario: ${unknown.join(', ') || '(none)'}`);
      opts.only = ids;
    } else if (arg === '--out') opts.outDir = resolve(value());
    else if (arg === '--max-output-tokens') {
      const raw = value();
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 16 || n > 32768) throw new Error('--max-output-tokens must be a whole number from 16 to 32768');
      opts.maxOutputTokens = n;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

/** The scenarios to run and the most requests they can send. */
export function planRequests(opts) {
  const scenarios = SCENARIOS.filter(s => opts.only.includes(s.id));
  const requests = scenarios.reduce((n, s) => n + 2 + (s.probe ? 1 : 0), 0);
  if (requests > MAX_REQUESTS) throw new Error(`plan has ${requests} requests; the cap is ${MAX_REQUESTS}`);
  const models = scenarios.map(s => `${s.model} (${s.effort ?? 'auto'}${s.id === 'sol-high-tools' ? ', with tools, parallel' : ''})`);
  return { scenarios, requests, models };
}

export function describePlan(plan, opts) {
  return [
    `Plan: at most ${plan.requests} request(s) to ${API_URL}, max_output_tokens=${opts.maxOutputTokens} each.`,
    `Models: ${plan.models.join('; ')}.`,
    `Saving to: ${opts.outDir}`,
  ].join('\n');
}

// ─── Request bodies (the transport's shape) ──────────────────────────────────

export function buildRequestBody({ model, effort, input, maxOutputTokens }) {
  const body = {
    model,
    instructions: INSTRUCTIONS,
    input,
    tools: [READ_FILE_TOOL],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (effort) body.reasoning = { effort };
  body.max_output_tokens = maxOutputTokens;
  body.stream = true;
  body.stream_options = { include_obfuscation: false };
  return body;
}

export function firstInput(scenario) {
  return [{ type: 'message', role: 'user', content: scenario.prompt }];
}

/** The fake tool: one function_call_output per call, with the call's call_id. */
export function toolOutputs(items) {
  return items.filter(i => i.type === 'function_call').map(call => {
    let path = '';
    try { path = String(JSON.parse(call.arguments || '{}').path ?? ''); } catch { /* reported below */ }
    const content = FAKE_FILES[path.replace(/^\.\//, '')];
    return { type: 'function_call_output', call_id: call.call_id, output: content ?? `Error: no such file: ${path || '(no path)'}` };
  });
}

// ─── Keeping secrets out ─────────────────────────────────────────────────────

const REQUEST_HEADER_ALLOWLIST = ['content-type'];
const RESPONSE_HEADER_ALLOWLIST = ['x-request-id', 'content-type', 'openai-processing-ms', 'openai-version'];

function allowlisted(headers, allow) {
  const out = {};
  const entries = typeof headers?.entries === 'function' ? [...headers.entries()] : Object.entries(headers ?? {});
  for (const [name, value] of entries) {
    if (allow.includes(String(name).toLowerCase())) out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

/** Request headers as saved: Content-Type only — never Authorization. */
export function sanitizeRequestHeaders(headers) {
  return allowlisted(headers, REQUEST_HEADER_ALLOWLIST);
}

/** Response headers as saved: an allowlist (no org or project names, no cookies). */
export function sanitizeResponseHeaders(headers) {
  return allowlisted(headers, RESPONSE_HEADER_ALLOWLIST);
}

/** Replace the key itself and anything shaped like an sk- key. */
export function redactSecrets(text, key) {
  let out = String(text ?? '');
  if (key) out = out.split(key).join('[REDACTED]');
  return out.replace(/sk-[A-Za-z0-9_*\-]{8,}/g, 'sk-[REDACTED]');
}

/**
 * Shorten every "encrypted_content" string in raw JSON or SSE text, leaving
 * the rest byte-for-byte. The cut never leaves a dangling backslash, so the
 * text stays valid JSON.
 */
export function truncateEncrypted(text, keep = 32) {
  return String(text).replace(/("encrypted_content"\s*:\s*")((?:[^"\\]|\\.)*)(")/g, (whole, open, value, close) => {
    if (value.length <= keep) return whole;
    let head = value.slice(0, keep);
    const trailing = head.match(/\\+$/);
    if (trailing && trailing[0].length % 2 === 1) head = head.slice(0, -1);
    return `${open}${head}…[truncated ${value.length - head.length} chars]${close}`;
  });
}

// ─── Stream reading ──────────────────────────────────────────────────────────

/** The events of a raw SSE text, parsed; [DONE] and unparseable lines skipped. */
export function sseEvents(text) {
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { events.push(JSON.parse(payload)); } catch { /* not an event */ }
  }
  return events;
}

/** Items (from output_item.done, by output_index) and the terminal event. */
export function readStream(text) {
  const events = sseEvents(text);
  const byIndex = new Map();
  let terminal = null;
  let error = null;
  for (const e of events) {
    if (e.type === 'response.output_item.done' && typeof e.output_index === 'number') byIndex.set(e.output_index, e.item);
    else if (e.type === 'response.completed' || e.type === 'response.incomplete' || e.type === 'response.failed') terminal = e;
    else if (e.type === 'error') error = e;
  }
  const items = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  return { items, terminal, error, response: terminal?.response ?? null };
}

// ─── Saving ──────────────────────────────────────────────────────────────────

/** Write one request's files. Nothing written can carry the key. */
export function writeRecording(outDir, name, { body, requestHeaders, status, responseHeaders, text, key }) {
  mkdirSync(outDir, { recursive: true });
  const request = { url: API_URL, method: 'POST', headers: sanitizeRequestHeaders(requestHeaders), body };
  const save = (file, content) => writeFileSync(join(outDir, file), redactSecrets(truncateEncrypted(content), key));
  save(`${name}.request.json`, JSON.stringify(request, null, 2) + '\n');
  const ok = status >= 200 && status < 300;
  if (ok) save(`${name}.sse`, text);
  save(`${name}.response.json`, JSON.stringify({ status, headers: sanitizeResponseHeaders(responseHeaders), ...(ok ? {} : { errorBody: text }) }, null, 2) + '\n');
  return [`${name}.request.json`, ...(ok ? [`${name}.sse`] : []), `${name}.response.json`];
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function outcome(r) {
  if (!r) return 'not sent';
  if (r.status < 200 || r.status >= 300) return `rejected: HTTP ${r.status} — ${errorMessage(r.text)}`;
  if (r.stream.error) return `stream error: ${r.stream.error.code ?? ''} ${r.stream.error.message ?? ''}`.trim();
  const t = r.stream.terminal?.type;
  if (t === 'response.completed') return 'accepted (completed)';
  if (t === 'response.incomplete') return `accepted but incomplete (${r.stream.response?.incomplete_details?.reason ?? 'unknown'})`;
  if (t === 'response.failed') return `failed: ${r.stream.response?.error?.code ?? ''} ${r.stream.response?.error?.message ?? ''}`.trim();
  return 'no terminal event';
}

function errorMessage(text) {
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message ?? j?.message ?? text).slice(0, 300);
  } catch {
    return String(text).slice(0, 300);
  }
}

/** Answers to the open questions, from what the run recorded. */
export function summarize(results) {
  const byScenario = (id) => results.filter(r => r.scenario === id);
  const replays = results.filter(r => r.step === 2 && r.body.input.some(i => i.type === 'reasoning'));
  const probe = results.find(r => r.step === 'probe');
  const full = results.find(r => r.scenario === probe?.scenario && r.step === 2);
  const echoed = (id) => {
    const first = byScenario(id).find(r => r.step === 1)?.stream.response;
    return first ? { effort: first.reasoning?.effort ?? null, context: first.reasoning?.context ?? null } : null;
  };
  const usage = results.filter(r => r.stream.response?.usage).map(r => {
    const u = r.stream.response.usage;
    return {
      request: r.name,
      input_tokens_details: u.input_tokens_details !== undefined,
      cached_tokens: typeof u.input_tokens_details?.cached_tokens === 'number',
      cache_write_tokens: typeof u.input_tokens_details?.cache_write_tokens === 'number',
      reasoning_tokens: typeof u.output_tokens_details?.reasoning_tokens === 'number',
    };
  });
  const maxCalls = Math.max(0, ...results.map(r => r.stream.items.filter(i => i.type === 'function_call').length));
  const createdBy = results.some(r => r.stream.items.some(i => i && Object.prototype.hasOwnProperty.call(i, 'created_by')));
  return {
    requestsSent: results.length,
    a_replayed_reasoning_under_store_false: replays.length
      ? replays.map(r => ({ request: r.name, outcome: outcome(r) }))
      : 'not tested — no step-1 reply carried reasoning items with a call',
    b_followup_without_reasoning: probe
      ? {
          outcome: outcome(probe),
          input_tokens_without: probe.stream.response?.usage?.input_tokens ?? null,
          input_tokens_with: full?.stream.response?.usage?.input_tokens ?? null,
        }
      : 'not tested — astra-high did not produce reasoning plus a call, or was not run',
    c_astra_default_effort: echoed('astra-auto') ?? 'astra-auto not run',
    c_echoed_by_sol: echoed('sol-high-tools') ?? 'sol-high-tools not run',
    d_usage_details: usage.length ? usage : 'no response carried usage',
    parallel_calls_in_one_response: maxCalls,
    output_items_with_created_by: createdBy,
    incomplete: results.filter(r => r.stream.terminal?.type === 'response.incomplete').map(r => r.name),
  };
}

export function formatSummary(s) {
  const lines = ['', '── Live questions ──'];
  const a = s.a_replayed_reasoning_under_store_false;
  lines.push(`(a) replayed reasoning under store:false: ${Array.isArray(a) ? a.map(x => `${x.request}: ${x.outcome}`).join('; ') : a}`);
  const b = s.b_followup_without_reasoning;
  lines.push(`(b) GPT-6 follow-up without its reasoning: ${typeof b === 'string' ? b : `${b.outcome}; input_tokens ${b.input_tokens_without} without vs ${b.input_tokens_with} with`}`);
  const c = s.c_astra_default_effort;
  lines.push(`(c) Astra default effort: ${typeof c === 'string' ? c : `effort=${c.effort}, reasoning.context=${c.context}`}`);
  const d = s.d_usage_details;
  lines.push(`(d) usage details: ${typeof d === 'string' ? d : d.map(u => `${u.request}: cached=${u.cached_tokens} cache_write=${u.cache_write_tokens} reasoning=${u.reasoning_tokens}`).join('; ')}`);
  lines.push(`    parallel calls in one response: ${s.parallel_calls_in_one_response}; output items with created_by: ${s.output_items_with_created_by}`);
  if (s.incomplete.length) lines.push(`    incomplete (raise --max-output-tokens and re-run): ${s.incomplete.join(', ')}`);
  lines.push(`Requests sent: ${s.requestsSent}`);
  return lines.join('\n');
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
  const say = (text) => stdout.write(`${text}\n`);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) { say(USAGE); return 0; }

  const plan = planRequests(opts);
  say(describePlan(plan, opts));

  if (opts.dryRun) {
    for (const s of plan.scenarios) {
      say(`\n# ${s.id} — request 1 body`);
      say(JSON.stringify(buildRequestBody({ model: s.model, effort: s.effort, input: firstInput(s), maxOutputTokens: opts.maxOutputTokens }), null, 2));
    }
    say('\nDry run: nothing was sent.');
    return 0;
  }

  const key = env.OPENAI_API_KEY;
  if (!key) {
    stderr.write('OPENAI_API_KEY is not set. Nothing was sent.\n');
    return 1;
  }
  const yes = await confirm(`Send up to ${plan.requests} request(s) to ${API_URL}?`, io.stdin ?? process.stdin, stdout);
  if (!yes) {
    say('Aborted — nothing was sent.');
    return 1;
  }

  const results = [];
  let sent = 0;
  const send = async (scenario, step, input) => {
    if (sent >= Math.min(plan.requests, MAX_REQUESTS)) throw new Error('request cap reached');
    sent++;
    const name = `${scenario.id}.${step}`;
    const body = buildRequestBody({ model: scenario.model, effort: scenario.effort, input, maxOutputTokens: opts.maxOutputTokens });
    const requestHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    say(`→ ${name}: ${scenario.model}${scenario.effort ? ` (${scenario.effort})` : ''}`);
    let status = 0;
    let responseHeaders = {};
    let text = '';
    try {
      const res = await fetchImpl(API_URL, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
      status = res.status;
      responseHeaders = res.headers;
      text = await res.text();
    } catch (err) {
      text = JSON.stringify({ error: { message: `network: ${err?.message ?? String(err)}` } });
    }
    const files = writeRecording(opts.outDir, name, { body, requestHeaders, status, responseHeaders, text, key });
    const result = { scenario: scenario.id, step, name, body, status, text, stream: status >= 200 && status < 300 ? readStream(text) : readStream('') };
    results.push(result);
    say(`  ${redactSecrets(outcome(result), key)} → ${files.join(', ')}`);
    return result;
  };

  for (const scenario of plan.scenarios) {
    const input1 = firstInput(scenario);
    const first = await send(scenario, 1, input1);
    const calls = first.stream.items.filter(i => i.type === 'function_call');
    if (calls.length === 0) {
      say(`  ${scenario.id}: no function call in the first reply — skipping the follow-up.`);
      continue;
    }
    // The transport's replay: every output item verbatim, then the outputs.
    const outputs = toolOutputs(first.stream.items);
    await send(scenario, 2, [...input1, ...first.stream.items, ...outputs]);
    if (scenario.probe && first.stream.items.some(i => i.type === 'reasoning')) {
      await send(scenario, 'probe', [...input1, ...first.stream.items.filter(i => i.type !== 'reasoning'), ...outputs]);
    }
  }

  const summary = summarize(results);
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, 'summary.json'), redactSecrets(JSON.stringify(summary, null, 2), key) + '\n');
  say(redactSecrets(formatSummary(summary), key));
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(code => { process.exitCode = code; }, err => {
    process.stderr.write(`${redactSecrets(err?.stack ?? String(err), process.env.OPENAI_API_KEY)}\n`);
    process.exitCode = 1;
  });
}
