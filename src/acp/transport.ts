// acp/transport.ts
// Newline-delimited JSON-RPC over stdio

import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Debug log destination — when CODEEP_ACP_DEBUG is set we mirror every
// inbound and outbound JSON-RPC frame here. Using a file (not stderr) because
// most ACP clients (Zed included) do not pipe agent stderr to anywhere the
// user can easily read; a known on-disk path is reliable everywhere.
const ACP_DEBUG_PATH = process.env.CODEEP_ACP_DEBUG_FILE
  || join(homedir(), '.cache', 'codeep', 'acp-debug.log');
const ACP_DEBUG = !!process.env.CODEEP_ACP_DEBUG;
if (ACP_DEBUG) {
  try { mkdirSync(dirname(ACP_DEBUG_PATH), { recursive: true }); } catch { /* ignore */ }
}
function debugLog(direction: '→' | '←', payload: string): void {
  if (!ACP_DEBUG) return;
  try {
    appendFileSync(ACP_DEBUG_PATH, `${new Date().toISOString()} [ACP${direction}client] ${payload}\n`);
  } catch { /* swallow — never break the protocol over a logging failure */ }
}

// A handler may be async; a rejection is answered like a synchronous throw.
type MessageHandler = (msg: JsonRpcRequest | JsonRpcNotification) => void | Promise<unknown>;

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT_MS = 30_000; // 30s

export interface RequestOptions {
  /**
   * How long to wait for the client's answer. Defaults to 30s; 0 waits
   * indefinitely, for calls that wait on a person (permission dialogs) or
   * on a running process (terminal/wait_for_exit).
   */
  timeoutMs?: number;
  /** Stop waiting when this fires (e.g. the prompt was cancelled). */
  signal?: AbortSignal;
}

/** The client answered one of our requests with a JSON-RPC error. */
export class AcpRequestError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(`${method} failed: ${message}`);
    this.name = 'AcpRequestError';
  }
}

/** The client did not answer one of our requests in time. */
export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} got no response within ${timeoutMs}ms`);
    this.name = 'AcpRequestTimeoutError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class StdioTransport {
  private buffer = '';
  protected handler: MessageHandler | null = null;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private requestIdCounter = 1000;
  // Ids of inbound requests we have not answered yet. A handler that fails
  // before answering gets an error reply; one that fails after answering
  // must not produce a second response for the same id.
  private unanswered = new Set<number | string>();

  start(handler: MessageHandler): void {
    this.handler = handler;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  protected onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer = '';
      return;
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      debugLog('←', trimmed);
      let msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // ignore malformed messages
      }
      if (!msg || typeof msg !== 'object') continue;

      // A frame without a method answers one of our outbound requests.
      if (!('method' in msg) && ('result' in msg || 'error' in msg)) {
        const response = msg as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new AcpRequestError(pending.method, response.error.code, response.error.message));
          } else {
            pending.resolve(response.result ?? null);
          }
        }
        // Nobody is waiting for it any more (timed out or cancelled). It is
        // a response, so answering it would break JSON-RPC: drop it.
        continue;
      }

      this.dispatch(msg as JsonRpcRequest | JsonRpcNotification);
    }
  }

  private dispatch(msg: JsonRpcRequest | JsonRpcNotification): void {
    const id = 'id' in msg ? msg.id : undefined;
    if (id !== undefined) this.unanswered.add(id);
    const fail = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // stderr only: stdout carries nothing but JSON-RPC frames.
      process.stderr.write(`[codeep-acp] ${msg.method} failed: ${message}\n`);
      if (id !== undefined && this.unanswered.has(id)) {
        this.error(id, -32603, message);
      }
    };
    try {
      const out = this.handler?.(msg);
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).then(undefined, fail);
      }
    } catch (err) {
      fail(err);
    }
  }

  protected write(line: string): void {
    debugLog('→', line);
    process.stdout.write(line + '\n');
  }

  send(msg: JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in msg) this.unanswered.delete(msg.id);
    this.write(JSON.stringify(msg));
  }

  respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  error(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * Send a JSON-RPC request to the client and wait for the response.
   * Used for agent-initiated requests like session/request_permission.
   *
   * Rejects with AcpRequestError when the client answers with an error,
   * with AcpRequestTimeoutError when it does not answer in time, and with
   * an AbortError when `signal` fires. A result is never invented: callers
   * that treat a missing answer as "no" must say so with their own catch.
   */
  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    const id = ++this.requestIdCounter;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const { signal } = options;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(method));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (this.pendingRequests.delete(id)) {
          settle();
          reject(abortError(method));
        }
      };
      this.pendingRequests.set(id, {
        method,
        resolve: (result) => { settle(); resolve(result); },
        reject: (err) => { settle(); reject(err); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pendingRequests.delete(id)) {
            settle();
            reject(new AcpRequestTimeoutError(method, timeoutMs));
          }
        }, timeoutMs);
      }
      this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
}

function abortError(method: string): Error {
  const err = new Error(`${method} was cancelled`);
  err.name = 'AbortError';
  return err;
}
