/**
 * Native Ollama `/api/chat` transport.
 *
 * Why this exists: Codeep normally talks to Ollama through its OpenAI-compatible
 * `/v1/chat/completions` shim, which silently IGNORES Ollama-native options like
 * `num_ctx` (context window) and `keep_alive` (model residency). The shim also
 * defaults to a small context (~2-4k) regardless of the model's real window, so
 * long sessions get silently truncated server-side.
 *
 * The native `/api/chat` endpoint accepts those options and streams
 * newline-delimited JSON (NOT SSE). Each line is a full JSON object:
 *   {"message":{"role":"assistant","content":"…"},"done":false}
 *   …
 *   {"message":{"content":""},"done":true,"prompt_eval_count":N,"eval_count":M}
 *
 * This module keeps the line-parsing as PURE functions so they can be unit
 * tested without a live server. The networking wrapper lives at the bottom.
 */

import http from 'http';
import https from 'https';

/** A tool call as Ollama's native /api/chat returns it: `function.arguments`
 *  is a JSON OBJECT (unlike OpenAI's JSON-string form). */
export interface OllamaToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface OllamaStreamDelta {
  /** Text chunk from this line (may be empty). */
  content: string;
  /** True on the terminating line. */
  done: boolean;
  /** Tool calls present on this line (Ollama emits them on one message). */
  toolCalls?: OllamaToolCall[];
  /** Prompt (input) tokens — only present on the final line. */
  promptTokens?: number;
  /** Completion (output) tokens — only present on the final line. */
  completionTokens?: number;
}

/** Extract + normalize `message.tool_calls` from a parsed message. Returns
 *  undefined when none. Tolerates missing/malformed entries (never throws). */
export function extractOllamaToolCalls(msg: unknown): OllamaToolCall[] | undefined {
  const raw = (msg as { tool_calls?: unknown })?.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: OllamaToolCall[] = [];
  for (const tc of raw) {
    const fn = (tc as { function?: { name?: unknown; arguments?: unknown } })?.function;
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const a = fn?.arguments;
    if (a && typeof a === 'object') args = a as Record<string, unknown>;
    else if (typeof a === 'string') { try { args = JSON.parse(a); } catch { args = {}; } }
    out.push({ name, arguments: args });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a single newline-delimited JSON line from `/api/chat`. Returns null for
 * blank lines or unparseable keepalives (never throws). Tolerates both the
 * streaming shape (`message.content`) and the non-stream shape.
 */
export function parseOllamaChatLine(line: string): OllamaStreamDelta | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const msg = json.message as { content?: unknown } | undefined;
  const content = typeof msg?.content === 'string' ? msg.content : '';
  const done = json.done === true;
  const out: OllamaStreamDelta = { content, done };
  const toolCalls = extractOllamaToolCalls(msg);
  if (toolCalls) out.toolCalls = toolCalls;
  if (typeof json.prompt_eval_count === 'number') out.promptTokens = json.prompt_eval_count;
  if (typeof json.eval_count === 'number') out.completionTokens = json.eval_count;
  return out;
}

export interface OllamaAccumulator {
  text: string;
  toolCalls: OllamaToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  done: boolean;
}

/**
 * Fold a parsed delta into a running accumulator. Pure — no I/O. The caller
 * feeds each line's parse result here and reads `text` / token counts at the end.
 */
export function foldOllamaDelta(acc: OllamaAccumulator, delta: OllamaStreamDelta | null): OllamaAccumulator {
  if (!delta) return acc;
  return {
    text: acc.text + delta.content,
    toolCalls: delta.toolCalls ? [...acc.toolCalls, ...delta.toolCalls] : acc.toolCalls,
    promptTokens: delta.promptTokens ?? acc.promptTokens,
    completionTokens: delta.completionTokens ?? acc.completionTokens,
    done: acc.done || delta.done,
  };
}

/**
 * Split a buffer into complete lines + a trailing remainder. Pure helper so the
 * stream reader can carry partial lines across chunk boundaries correctly.
 * Returns { lines, rest } where `rest` is the unfinished tail (no newline yet).
 */
export function splitOllamaLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

export const initialOllamaAccumulator = (): OllamaAccumulator => ({ text: '', toolCalls: [], done: false });

/**
 * Pull the real context_length out of an `/api/show` response's `model_info`.
 * The key is architecture-prefixed (e.g. `llama.context_length`,
 * `qwen2.context_length`), so we scan for any key ending in `.context_length`
 * (or the bare `context_length`). Pure + tolerant — returns null when absent.
 */
export function extractContextLength(showResponse: unknown): number | null {
  const info = (showResponse as { model_info?: Record<string, unknown> })?.model_info;
  if (!info || typeof info !== 'object') return null;
  for (const [key, value] of Object.entries(info)) {
    if ((key === 'context_length' || key.endsWith('.context_length')) && typeof value === 'number' && value > 0) {
      return value;
    }
  }
  return null;
}

// Per-model context-length cache so we hit /api/show at most once per model.
const contextLengthCache = new Map<string, number | null>();

/**
 * Fetch a model's real maximum context window via `/api/show`. Cached per model;
 * returns null on any error (caller falls back to its default). Never throws.
 */
export async function getOllamaContextLength(model: string, ollamaBaseUrl: string): Promise<number | null> {
  if (contextLengthCache.has(model)) return contextLengthCache.get(model) ?? null;
  const base = ollamaBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { contextLengthCache.set(model, null); return null; }
    const data = await res.json();
    const ctx = extractContextLength(data);
    contextLengthCache.set(model, ctx);
    return ctx;
  } catch {
    contextLengthCache.set(model, null);
    return null;
  }
}

/** Test seam — reset the per-model context cache. */
export function _clearOllamaContextCache(): void {
  contextLengthCache.clear();
}

export interface OllamaChatOptions {
  /** Ollama base URL (without /v1), e.g. http://localhost:11434 */
  baseUrl: string;
  model: string;
  /** Messages in OpenAI shape {role, content} — Ollama /api/chat accepts these. */
  messages: { role: string; content: string }[];
  /** num_ctx — the context window to allocate. 0/undefined = let Ollama decide. */
  numCtx?: number;
  /** keep_alive — how long to keep the model resident, e.g. "30m". */
  keepAlive?: string;
  temperature?: number;
  timeoutMs?: number;
  onChunk?: (text: string) => void;
  /** Tool definitions in OpenAI function format. Ollama's /api/chat accepts the
   *  same `{type:'function',function:{...}}` shape and returns `tool_calls`. */
  tools?: unknown[];
  /** Pass-through for non-string message parts (tool results carry tool_call_id
   *  etc.). When set, used verbatim instead of `messages`. */
  rawMessages?: unknown[];
}

export interface OllamaChatResult {
  text: string;
  toolCalls: OllamaToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Stream a chat completion from Ollama's native `/api/chat`. Uses node:http to
 * sidestep undici's connection pooling (which throws AggregateError against
 * localhost Ollama on Node 24). Parses the newline-JSON stream via the pure
 * helpers above. Resolves with the full text + token usage.
 */
export function streamOllamaNativeChat(opts: OllamaChatOptions): Promise<OllamaChatResult> {
  const base = opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = `${base}/api/chat`;
  const options: Record<string, unknown> = {};
  if (opts.numCtx && opts.numCtx > 0) options.num_ctx = opts.numCtx;
  if (typeof opts.temperature === 'number') options.temperature = opts.temperature;
  // When tools are present, Ollama only emits tool_calls in non-streaming mode
  // reliably; streaming tool_calls support varies by version. We stream when
  // there are no tools (plain chat) and fall to non-stream when tools are sent.
  const useStream = !opts.tools || opts.tools.length === 0;
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.rawMessages ?? opts.messages,
    stream: useStream,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
  });

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: opts.timeoutMs ?? 120_000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString(); });
        res.on('end', () => reject(new Error(`Ollama /api/chat ${res.statusCode}: ${errBody.slice(0, 300)}`)));
        return;
      }
      let buffer = '';
      let acc = initialOllamaAccumulator();
      const decoder = new TextDecoder();
      res.on('data', (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        const { lines, rest } = splitOllamaLines(buffer);
        buffer = rest;
        for (const line of lines) {
          const delta = parseOllamaChatLine(line);
          if (delta?.content) opts.onChunk?.(delta.content);
          acc = foldOllamaDelta(acc, delta);
        }
      });
      res.on('end', () => {
        // Flush any trailing line (final object often arrives without a newline).
        const delta = parseOllamaChatLine(buffer);
        if (delta?.content) opts.onChunk?.(delta.content);
        acc = foldOllamaDelta(acc, delta);
        resolve({ text: acc.text, toolCalls: acc.toolCalls, promptTokens: acc.promptTokens, completionTokens: acc.completionTokens });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Ollama request timed out')); });
    req.write(body);
    req.end();
  });
}
