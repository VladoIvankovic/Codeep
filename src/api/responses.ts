/**
 * OpenAI Responses API transport: request builders and the stream parser.
 *
 * Why it exists: on Chat Completions GPT-6 Astra cannot call tools at all, and
 * GPT-6 Sol/Luna only with reasoning off. On `POST /v1/responses` they reason
 * and call tools together. Agent turns use it when openAIWireApi() says so —
 * which, as shipped, it does not (DEFAULT_OPENAI_WIRE_API is 'chat' until the
 * owner's live verification run).
 *
 * Stateless by design:
 *   - every request carries `store: false` (omitting it defaults to true) and
 *     `include: ["reasoning.encrypted_content"]`;
 *   - `previous_response_id`, `conversation` and `item_reference` are never
 *     sent — the full input is rebuilt on every request;
 *   - within one agent run, each assistant turn's output items (reasoning with
 *     its encrypted_content, commentary messages with their `phase`, function
 *     calls) are replayed exactly as `response.output_item.done` returned them,
 *     followed by one `function_call_output` per call. The items live in memory
 *     only (utils/responsesRunState.ts) — sessions, exports and cloud sync keep
 *     the flat `{role, content}` history, unchanged.
 *
 * Two dialects share this code: 'openai' now, 'xai' later (no provider
 * declares it yet — see ProviderConfig.protocols.openai.responses).
 *
 * Everything here is pure except the ApiError class it throws; no config, no
 * network. agentChat.ts does the I/O.
 */

import type { Message } from '../config/index';
import { ApiError } from './index';

export type ResponsesDialect = 'openai' | 'xai';

/** One Responses input or output item, kept as the JSON the API sent. */
export type ResponsesItem = Record<string, unknown>;

/** A `function_call` output item, reduced to what the agent needs. */
export interface ResponsesFunctionCall {
  /** The id the matching `function_call_output` must carry. */
  call_id: string;
  name: string;
  /** The raw JSON arguments string, unparsed. */
  arguments: string;
  /** The `fc_…` item id — NOT the call id. */
  itemId?: string;
}

/** A call the agent could not run (its arguments did not parse, …). */
export interface RejectedCall {
  call_id: string;
  name: string;
  reason: string;
}

/**
 * One assistant turn as the provider returned it, for replay within the run.
 * Replayed only to the same provider and dialect; a different model gets the
 * items without their `reasoning`.
 */
export interface NativeTurn {
  providerId: string;
  model: string;
  dialect: ResponsesDialect;
  /** Verbatim output items, in output_index order. */
  items: ResponsesItem[];
  /** Calls that must still be answered, with the reason they were not run. */
  rejectedCalls: RejectedCall[];
}

/** One tool output keyed by the call it answers. */
export interface ToolOutputEntry {
  call_id: string;
  output: string;
}

/** What a flat history message stands for on the Responses wire. */
export type ResponsesReplayTag =
  | { kind: 'assistant'; turn: NativeTurn }
  | { kind: 'toolOutputs'; outputs: ToolOutputEntry[] };

/** Read side of the per-run replay table (utils/responsesRunState.ts). */
export interface ResponsesReplayLookup {
  lookup(message: object): ResponsesReplayTag | undefined;
}

/** A parsed Responses reply. */
export interface ResponsesTurn {
  /** Visible text, as streamed. */
  text: string;
  /** Refusal text, when the model refused instead of answering. */
  refusal: string;
  /** Complete output items, in output_index order — the replay payload. */
  items: ResponsesItem[];
  functionCalls: ResponsesFunctionCall[];
  status: 'completed' | 'incomplete';
  /** `incomplete_details.reason`, with "max_tokens" read as "max_output_tokens". */
  incompleteReason?: string;
  /** The raw `usage` object, or null when the API sent none. */
  usage: Record<string, unknown> | null;
  /** The terminal event's `response` object (or the non-streamed reply). */
  rawResponse: Record<string, unknown> | null;
}

/** The request's target, which decides what native items may be replayed. */
export interface ResponsesTarget {
  providerId: string;
  model: string;
  dialect: ResponsesDialect;
}

/** Output sent for a call that has no answer in the history. */
export const NOT_EXECUTED_OUTPUT = '[not executed]';

// ─── Tools ────────────────────────────────────────────────────────────────────

/** The Chat Completions tool shape getOpenAITools() builds. */
export interface ChatCompletionsFunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

/**
 * Chat Completions tools (`{type, function: {name, description, parameters}}`)
 * → Responses function tools (`{type, name, description, parameters}`).
 *
 * 'openai' sets `strict: false` explicitly on every tool: with `strict`
 * omitted, Responses tries to convert the schema to strict mode, which
 * Codeep's schemas (optional params left out of `required`) and MCP schemas
 * (passed through as the server wrote them) do not satisfy. xAI documents
 * `strict` as not supported, so 'xai' omits it.
 */
export function toResponsesTools(tools: ReadonlyArray<ChatCompletionsFunctionTool>, dialect: ResponsesDialect): ResponsesItem[] {
  return tools.map(t => {
    const tool: ResponsesItem = {
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters ?? null,
    };
    if (dialect === 'openai') tool.strict = false;
    return tool;
  });
}

// ─── Input ────────────────────────────────────────────────────────────────────

function plainMessage(message: Message, dialect: ResponsesDialect): ResponsesItem {
  if (message.role === 'assistant') {
    // A turn with nothing native to replay (another provider's, or one the
    // loop wrote itself). OpenAI says to resend `phase` on assistant messages
    // from gpt-5.3-codex on; a stored turn with no items is Codeep's record
    // of an answer. No `id`: that belongs to items the API produced.
    return dialect === 'openai'
      ? { type: 'message', role: 'assistant', content: message.content, phase: 'final_answer' }
      : { type: 'message', role: 'assistant', content: message.content };
  }
  return { type: 'message', role: message.role, content: message.content };
}

/**
 * The flat agent history → Responses `input`.
 *
 *   - An assistant message tagged with a NativeTurn from the same provider and
 *     dialect is replaced by its output items, verbatim. If the model changed
 *     since, its `reasoning` items are dropped (encrypted reasoning belongs to
 *     the model that produced it); calls and messages stay. Reasoning left at
 *     the end of a cut-off turn, with nothing after it, is dropped too.
 *   - A user message tagged with tool outputs becomes one
 *     `function_call_output` per call. Its text — "Tool results: … Continue
 *     with the task" — is not sent: OpenAI's rule is that everything since the
 *     last user message goes back as it was, so no user nudge sits between the
 *     outputs and the next turn.
 *   - Everything else is a plain `{type: 'message', role, content}`; empty
 *     ones are skipped.
 *
 * normalizePairs() then guarantees every call has exactly one answer.
 */
export function buildResponsesInput(
  messages: ReadonlyArray<Message>,
  state: ResponsesReplayLookup | undefined,
  target: ResponsesTarget,
): ResponsesItem[] {
  const items: ResponsesItem[] = [];
  for (const message of messages) {
    const tag = state?.lookup(message);
    if (message.role === 'assistant' && tag?.kind === 'assistant'
        && tag.turn.providerId === target.providerId && tag.turn.dialect === target.dialect) {
      const sameModel = tag.turn.model === target.model;
      const turnItems: ResponsesItem[] = [];
      for (const item of tag.turn.items) {
        if (!sameModel && item.type === 'reasoning') continue;
        turnItems.push(item);
      }
      items.push(...withoutDanglingReasoning(turnItems));
      continue;
    }
    if (message.role === 'user' && tag?.kind === 'toolOutputs') {
      for (const o of tag.outputs) items.push({ type: 'function_call_output', call_id: o.call_id, output: o.output });
      continue;
    }
    if (!message.content.trim()) continue;
    items.push(plainMessage(message, target.dialect));
  }
  return normalizePairs(items);
}

/**
 * A turn's items without reasoning that nothing follows. A reply cut off by
 * `max_output_tokens` can end on a finished reasoning item whose message or
 * call never finished (and was dropped); replayed alone, such an item is one
 * the API may refuse, while omitting reasoning is always allowed. A completed
 * turn ends on a message or a call, so this never touches one.
 */
function withoutDanglingReasoning(items: ResponsesItem[]): ResponsesItem[] {
  let last = items.length - 1;
  while (last >= 0 && items[last].type === 'reasoning') last--;
  return items.slice(0, last + 1);
}

type ItemKind = 'call' | 'output' | 'model' | 'boundary';

function kindOf(item: ResponsesItem): ItemKind {
  if (item.type === 'function_call') return 'call';
  if (item.type === 'function_call_output') return 'output';
  const role = item.role;
  if ((item.type === 'message' || item.type === undefined) && role !== undefined && role !== 'assistant') return 'boundary';
  // reasoning, assistant messages, and anything else the model produced.
  return 'model';
}

function orphanOutputAsText(item: ResponsesItem): ResponsesItem {
  const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
  return { type: 'message', role: 'user', content: `Tool output (its call is no longer in the conversation):\n${output}` };
}

/**
 * Make every `function_call` answered by exactly one `function_call_output`
 * with the same `call_id`, in the same batch — the API answers anything else
 * with a 400, and a pairing slip must not end the run.
 *
 * A batch is the model's items (reasoning, messages, calls) followed by the
 * outputs that come after them; a user/system message or the next model item
 * ends it. Within a batch:
 *   - an output whose call is not in the batch (dropped by compression, a
 *     second answer to the same call, an output ahead of its call) becomes a
 *     user text message after the batch;
 *   - a call with no output gets NOT_EXECUTED_OUTPUT, placed after the batch's
 *     real outputs;
 *   - a call without a usable `call_id`, or repeating one already in the
 *     batch, is dropped — nothing could ever answer it.
 */
export function normalizePairs(items: ReadonlyArray<ResponsesItem>): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  let head: ResponsesItem[] = [];
  let tail: ResponsesItem[] = [];
  let callIds: string[] = [];

  const flush = () => {
    const answered = new Set<string>();
    const outputs: ResponsesItem[] = [];
    const orphans: ResponsesItem[] = [];
    for (const o of tail) {
      const id = o.call_id;
      if (typeof id === 'string' && callIds.includes(id) && !answered.has(id)) {
        answered.add(id);
        outputs.push(o);
      } else {
        orphans.push(orphanOutputAsText(o));
      }
    }
    for (const id of callIds) {
      if (!answered.has(id)) outputs.push({ type: 'function_call_output', call_id: id, output: NOT_EXECUTED_OUTPUT });
    }
    out.push(...head, ...outputs, ...orphans);
    head = [];
    tail = [];
    callIds = [];
  };

  for (const item of items) {
    const kind = kindOf(item);
    if (kind === 'boundary') {
      flush();
      out.push(item);
      continue;
    }
    if (kind === 'output') {
      tail.push(item);
      continue;
    }
    // A model item after outputs starts the next batch.
    if (tail.length > 0) flush();
    if (kind === 'call') {
      const id = item.call_id;
      if (typeof id !== 'string' || id === '' || callIds.includes(id)) continue;
      callIds.push(id);
    }
    head.push(item);
  }
  flush();
  return out;
}

// ─── Body ─────────────────────────────────────────────────────────────────────

export interface ResponsesBodyOptions {
  model: string;
  /** The system prompt. Resent on every request (it is not carried over). */
  instructions: string;
  input: ResponsesItem[];
  /** Responses-shaped tools (toResponsesTools). Empty → no tool fields. */
  tools: ResponsesItem[];
  dialect: ResponsesDialect;
  /** `{ effort }`, or undefined for the model's own default. */
  reasoning?: { effort: string };
  /** Counts reasoning too — see responsesMaxOutputTokens(). */
  maxOutputTokens?: number;
  stream: boolean;
  /** xai only. */
  promptCacheKey?: string;
  /** xai only; OpenAI rejects sampling params whenever effort is not "none". */
  temperature?: number;
}

/**
 * The request body. Always `store: false` and
 * `include: ["reasoning.encrypted_content"]`: the first because the API
 * defaults to storing, the second so reasoning can be replayed statelessly
 * (and, on xAI, so the trace is returned rather than kept server-side).
 */
export function buildResponsesBody(o: ResponsesBodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: o.model,
    instructions: o.instructions,
    input: o.input,
  };
  if (o.tools.length > 0) {
    body.tools = o.tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  body.store = false;
  body.include = ['reasoning.encrypted_content'];
  if (o.reasoning) body.reasoning = { effort: o.reasoning.effort };
  if (o.maxOutputTokens !== undefined) body.max_output_tokens = o.maxOutputTokens;
  body.stream = o.stream;
  if (o.dialect === 'openai') {
    // Obfuscation padding is on by default and only costs bandwidth here.
    if (o.stream) body.stream_options = { include_obfuscation: false };
  } else {
    if (o.promptCacheKey) body.prompt_cache_key = o.promptCacheKey;
    if (o.temperature !== undefined) body.temperature = o.temperature;
  }
  return body;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * An error `code` from `response.failed` (`response.error.code`) or an
 * `error` event (`code`) → the HTTP-like status runAgent's retry logic reads
 * (Codeep's own convention: the stream itself was a 200). The single
 * reference for both clients — macOS ResponsesStreamParser mirrors this table:
 *
 *   code                                   status  runAgent
 *   rate_limit_exceeded, slow_down         429     retried, rate-limit backoff
 *   server_error, server_is_overloaded,    500     retried, short backoff
 *     service_unavailable
 *   null, absent or "" (either event)      500     retried, short backoff
 *   any other code — invalid_prompt,       400     not retried: the run stops
 *     misalignment_policy_violation, the           with the provider's message
 *     image errors, codes not listed here
 *
 * A missing code is an unexplained server-side failure, so it retries; an
 * unknown code does not, since retrying a request the API rejects on its
 * content only fails the same way again.
 */
export function responsesErrorStatus(code: unknown): number {
  if (code === 'rate_limit_exceeded' || code === 'slow_down') return 429;
  if (code === 'server_error' || code === 'server_is_overloaded' || code === 'service_unavailable') return 500;
  if (code === null || code === undefined || code === '') return 500;
  return 400;
}

function streamError(error: unknown, status: number): ApiError {
  const e = (error && typeof error === 'object') ? error as Record<string, unknown> : { message: String(error ?? 'unknown error') };
  // Shaped like an HTTP error body so everything that reads "API error:
  // <status> - <json>" (runAgent, the ACP auth notice) reads this too.
  return new ApiError(`API error: ${status} - ${JSON.stringify({ error: e })}`, status);
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function isCompleteItem(item: unknown): item is ResponsesItem {
  if (!item || typeof item !== 'object') return false;
  const status = (item as ResponsesItem).status;
  return status === undefined || status === null || status === 'completed';
}

function messageParts(item: ResponsesItem): { text: string; refusal: string } {
  let text = '';
  let refusal = '';
  if (item.type !== 'message' || !Array.isArray(item.content)) return { text, refusal };
  for (const part of item.content as Array<Record<string, unknown>>) {
    if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    else if (part?.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
  }
  return { text, refusal };
}

function normalizeIncompleteReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || !reason) return undefined;
  // The reference example says "max_tokens"; the schema enum says
  // "max_output_tokens". Same thing.
  return reason === 'max_tokens' ? 'max_output_tokens' : reason;
}

/**
 * Event-by-event accumulator for one streamed response. Exposed for tests
 * that feed events directly; parseResponsesSSE() is the normal entry point.
 */
export class ResponsesStreamState {
  private text = '';
  private refusal = '';
  private readonly items = new Map<number, ResponsesItem>();
  /** output_index values whose visible text already arrived as deltas. */
  private readonly streamed = new Set<number>();
  private terminal: { status: 'completed' | 'incomplete'; response: Record<string, unknown> } | null = null;

  constructor(private readonly onChunk?: (chunk: string) => void) {}

  /** True once response.completed / response.incomplete has arrived. */
  get done(): boolean {
    return this.terminal !== null;
  }

  private emit(delta: string): void {
    if (delta && this.onChunk) this.onChunk(delta);
  }

  /** Text of a message that arrived whole (no deltas for it). */
  private takeWholeMessage(index: number, item: ResponsesItem): void {
    if (this.streamed.has(index)) return;
    const { text, refusal } = messageParts(item);
    if (text) { this.text += text; this.emit(text); }
    if (refusal) { this.refusal += refusal; this.emit(refusal); }
    this.streamed.add(index);
  }

  /** Handle one parsed event. Throws ApiError on response.failed / error. */
  handle(event: Record<string, unknown>): void {
    if (this.terminal) return;
    const type = event.type;
    const index = typeof event.output_index === 'number' ? event.output_index : -1;
    switch (type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') {
          this.text += event.delta;
          this.streamed.add(index);
          this.emit(event.delta);
        }
        return;
      case 'response.refusal.delta':
        if (typeof event.delta === 'string') {
          this.refusal += event.delta;
          this.streamed.add(index);
          this.emit(event.delta);
        }
        return;
      case 'response.output_item.done': {
        // The complete item — `.added` may carry partial encrypted_content.
        // Same filter as the terminal fill below: an item done with a status
        // other than completed (a call or message cut off by
        // max_output_tokens) is neither replayed nor read for text.
        const item = event.item;
        if (index < 0 || !isCompleteItem(item)) return;
        this.items.set(index, item as ResponsesItem);
        if ((item as ResponsesItem).type === 'message') this.takeWholeMessage(index, item as ResponsesItem);
        return;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = (event.response && typeof event.response === 'object') ? event.response as Record<string, unknown> : {};
        // Fill what never came as output_item.done (xAI documents a thinner
        // event set) — but only from items that finished. An incomplete
        // response's half-written call is dropped, not replayed.
        const output = Array.isArray(response.output) ? response.output : [];
        output.forEach((item, i) => {
          if (this.items.has(i) || !isCompleteItem(item)) return;
          this.items.set(i, item);
          if (item.type === 'message') this.takeWholeMessage(i, item);
        });
        this.terminal = { status: type === 'response.completed' ? 'completed' : 'incomplete', response };
        return;
      }
      case 'response.failed': {
        const response = (event.response && typeof event.response === 'object') ? event.response as Record<string, unknown> : {};
        const error = (response.error && typeof response.error === 'object') ? response.error as Record<string, unknown> : { message: 'response.failed' };
        throw streamError(error, responsesErrorStatus(error.code));
      }
      case 'error':
        throw streamError({ code: event.code ?? null, message: event.message ?? 'stream error', param: event.param ?? null }, responsesErrorStatus(event.code));
      default:
        // created, in_progress, output_item.added, content_part.*, the
        // *.done text events, reasoning summaries, function_call_arguments.*
        // (the call is read whole from output_item.done), hosted-tool events —
        // and unknown fields such as `obfuscation` — are not needed.
        return;
    }
  }

  /** The parsed turn. Throws a retryable ApiError if no terminal event came. */
  finish(): ResponsesTurn {
    if (!this.terminal) {
      throw new ApiError('API error: 502 - Responses stream ended before response.completed', 502);
    }
    const items = [...this.items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    const functionCalls: ResponsesFunctionCall[] = items
      .filter(item => item.type === 'function_call')
      .map(item => ({
        call_id: String(item.call_id ?? ''),
        name: String(item.name ?? ''),
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        itemId: typeof item.id === 'string' ? item.id : undefined,
      }));
    const response = this.terminal.response;
    const details = response.incomplete_details as Record<string, unknown> | undefined;
    const usage = (response.usage && typeof response.usage === 'object') ? response.usage as Record<string, unknown> : null;
    return {
      text: this.text,
      refusal: this.refusal,
      items,
      functionCalls,
      status: this.terminal.status,
      incompleteReason: this.terminal.status === 'incomplete' ? normalizeIncompleteReason(details?.reason) ?? 'unknown' : undefined,
      usage,
      rawResponse: response,
    };
  }
}

/**
 * Splits an SSE byte stream into events and hands each `data:` payload, parsed
 * as JSON, to `onEvent`. Tolerant of what servers actually send: `\n` or
 * `\r\n` line ends, chunks split mid-line, `event:` / `id:` / comment lines
 * (the payload's own `type` is what counts), `data:` with or without the
 * space, a `data: [DONE]` sentinel, and consecutive `data:` lines without the
 * blank line between them. Unparseable payloads are skipped.
 */
export class SSEEventSplitter {
  private buffer = '';
  private data: string[] = [];

  constructor(private readonly onEvent: (event: Record<string, unknown>) => void) {}

  feed(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
  }

  end(): void {
    if (this.buffer) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.line(line);
    }
    this.dispatch();
  }

  private line(line: string): void {
    if (line === '') { this.dispatch(); return; }
    if (!line.startsWith('data:')) return; // event:, id:, retry:, ": comment"
    const payload = line.slice(5).replace(/^ /, '');
    // A server that omits the blank line between events: the pending data is
    // already a whole JSON value, so it is its own event.
    if (this.data.length > 0 && this.parses(this.data.join('\n'))) this.dispatch();
    this.data.push(payload);
  }

  private parses(text: string): boolean {
    try { JSON.parse(text); return true; } catch { return false; }
  }

  private dispatch(): void {
    if (this.data.length === 0) return;
    const payload = this.data.join('\n');
    this.data = [];
    if (payload.trim() === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event && typeof event === 'object' && !Array.isArray(event)) this.onEvent(event as Record<string, unknown>);
  }
}

/**
 * Parse a streamed Responses reply. Text and refusal deltas go to `onChunk`
 * as they arrive; items are taken from `response.output_item.done`.
 *
 * Throws ApiError on `response.failed` and `error` events (see
 * responsesErrorStatus) and, retryably (502), when the stream ends without
 * `response.completed` / `response.incomplete`.
 */
export async function parseResponsesSSE(
  body: ReadableStream<Uint8Array> | string,
  opts: { onChunk?: (chunk: string) => void } = {},
): Promise<ResponsesTurn> {
  const state = new ResponsesStreamState(opts.onChunk);
  const splitter = new SSEEventSplitter(event => state.handle(event));
  if (typeof body === 'string') {
    splitter.feed(body);
    splitter.end();
    return state.finish();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!state.done) {
      const { done, value } = await reader.read();
      if (done) break;
      splitter.feed(decoder.decode(value, { stream: true }));
    }
    if (!state.done) {
      splitter.feed(decoder.decode());
      splitter.end();
    }
  } finally {
    // Past the terminal event (or an error event) nothing else is needed:
    // release the connection instead of leaving the body half-read.
    reader.cancel().catch(() => {});
  }
  return state.finish();
}

/**
 * Parse a non-streamed Responses reply (the Response object itself). Same
 * result shape as parseResponsesSSE; `status: "failed"` throws.
 */
export function parseResponsesJSON(data: unknown): ResponsesTurn {
  const response = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
  const state = new ResponsesStreamState();
  if (response.status === 'failed') {
    state.handle({ type: 'response.failed', response });
  }
  state.handle({ type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response });
  return state.finish();
}
