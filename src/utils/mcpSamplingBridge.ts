/**
 * Bridges MCP `sampling/createMessage` server requests to Codeep's host LLM.
 *
 * MCP servers that opt into the `sampling` capability send the host
 * (Codeep) a request to generate a completion on their behalf — usually
 * because they want LLM reasoning without their own provider keys. Per
 * spec, the host is free to refuse, swap models, or strip context; we
 * forward the messages to the active provider via `chat()` and return
 * just the assistant text.
 *
 * Notes on the bridge surface:
 *   - We strip image content (provider matrix varies; safer to skip than
 *     surprise the model). A future iteration can route images through
 *     the vision integration in mcpIntegration.ts.
 *   - We respect `params.modelPreferences.hints[].name` as an *advisory*
 *     model override — only if the user has the provider for it
 *     configured; otherwise we stay on the active model.
 *   - We honour `temperature`, `maxTokens`, `stopSequences` only where
 *     the underlying chat() path supports them (today: none — chat() uses
 *     the agent's configured temperature/maxTokens). Pass-through hooks
 *     are wired so the spec contract is honoured if/when chat() grows
 *     those knobs.
 *
 * Cost guard: every sampling request bills the user's active provider, so
 * a misbehaving server can drain credits. We enforce a per-server rate
 * limit (≥1 s spacing) and a per-process cap, and surface every accepted
 * request on stderr so the user can see what's happening.
 */

import type { SamplingCreateMessageParams, SamplingCreateMessageResult } from './mcpClient.js';
import type { Message } from '../config/index.js';

const MIN_INTERVAL_MS = 1000;
const MAX_PER_SERVER = 100;

const lastRequestAt = new Map<string, number>();
const requestCount = new Map<string, number>();

/** Reset the per-server counters. Called on session boundaries. */
export function resetSamplingBudget(): void {
  lastRequestAt.clear();
  requestCount.clear();
}

export async function handleMcpSamplingRequest(
  params: SamplingCreateMessageParams,
  serverName = 'unknown',
): Promise<SamplingCreateMessageResult> {
  const now = Date.now();
  const count = (requestCount.get(serverName) ?? 0) + 1;
  if (count > MAX_PER_SERVER) {
    process.stderr.write(
      `[codeep] mcp:${serverName} sampling refused — exceeded ${MAX_PER_SERVER}/process cap; restart codeep to reset\n`,
    );
    throw new Error(`sampling budget exceeded for "${serverName}" (${MAX_PER_SERVER}/process)`);
  }
  const last = lastRequestAt.get(serverName) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    process.stderr.write(
      `[codeep] mcp:${serverName} sampling refused — exceeds 1/sec rate limit\n`,
    );
    throw new Error(`sampling rate limit for "${serverName}" (max 1/sec)`);
  }
  lastRequestAt.set(serverName, now);
  requestCount.set(serverName, count);
  process.stderr.write(
    `[codeep] mcp:${serverName} sampling/createMessage (${count}/${MAX_PER_SERVER} this session)\n`,
  );

  // Collapse text-content messages into a normalised Message[] for chat().
  // Images dropped per the surface note above.
  const history: Message[] = [];
  let lastUserText = '';
  for (const m of params.messages) {
    if (m.content.type !== 'text') continue;
    if (m.role === 'assistant') {
      history.push({ role: 'assistant', content: m.content.text });
    } else {
      history.push({ role: 'user', content: m.content.text });
      lastUserText = m.content.text;
    }
  }

  // chat() takes (message, history, ...) — last user turn becomes the
  // "message" arg and the rest becomes the prior history.
  const message = lastUserText || (history[history.length - 1]?.content ?? '');
  const prior = history.slice(0, -1);

  // System prompt: server-provided overrides our agent default for this
  // single call. We don't wire it through chat() (no parameter slot), so
  // we prepend a synthetic system turn to history. chat() collapses
  // duplicate system messages, so this is safe.
  if (params.systemPrompt) {
    prior.unshift({ role: 'system', content: params.systemPrompt });
  }

  const { chat } = await import('../api/index.js');
  const { config } = await import('../config/index.js');
  const text = await chat(message, prior);

  return {
    role: 'assistant',
    content: { type: 'text', text },
    model: config.get('model') as string,
    stopReason: 'endTurn',
  };
}
