// acp/transport.ts
// Newline-delimited JSON-RPC over stdio

import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.js';
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Debug log destination — when CODEEP_ACP_DEBUG is set we mirror every
// inbound and outbound JSON-RPC frame here. Using a file (not stderr) because
// most ACP clients (Zed included) do not pipe agent stderr to anywhere the
// user can easily read; a known on-disk path is reliable everywhere.
//
// WHAT IS IN IT, because a user asked for it in a bug report will attach the
// whole file: every frame of the session. That is the prompts, the model's
// replies, the contents of every file read or written through fs/*, the
// commands run in the client's terminal and their output, and the `env` of
// every terminal/create. redactCredentials() blanks the obvious credential
// shapes on the way in, but it is a filter over text and not a guarantee — a
// secret that does not look like one survives it. So: session-private, 0600
// in a 0700 directory, and not something to paste anywhere unread.
const ACP_DEBUG_PATH = process.env.CODEEP_ACP_DEBUG_FILE
  || join(homedir(), '.cache', 'codeep', 'acp-debug.log');
const ACP_DEBUG = !!process.env.CODEEP_ACP_DEBUG;
/**
 * Roll the log over at 8MB, keeping one previous file.
 *
 * It had no limit at all: every frame was appended and nothing ever truncated
 * or removed the file, and a frame carries whole file contents and whole
 * command outputs — so a user who left CODEEP_ACP_DEBUG set grew it until the
 * disk stopped them. One previous file rather than a truncate because the
 * frames that explain a broken session are usually the handshake at the top,
 * which is exactly what a truncate throws away. Bounded at twice this, then.
 */
const ACP_DEBUG_MAX_BYTES = 8 * 1024 * 1024;
if (ACP_DEBUG) {
  // 0700: the directory holds a file with the whole session in it.
  try { mkdirSync(dirname(ACP_DEBUG_PATH), { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
}

/** Bytes written so far, so the size check costs no syscall per frame. Null
 *  until the first write reads what an earlier run left on disk. */
let acpDebugBytes: number | null = null;

function debugLog(direction: '→' | '←', payload: string): void {
  if (!ACP_DEBUG) return;
  const line = `${new Date().toISOString()} [ACP${direction}client] ${redactCredentials(payload)}\n`;
  const bytes = Buffer.byteLength(line);
  try {
    if (acpDebugBytes === null) acpDebugBytes = adoptExistingLog();
    if (acpDebugBytes > 0 && acpDebugBytes + bytes > ACP_DEBUG_MAX_BYTES) {
      renameSync(ACP_DEBUG_PATH, `${ACP_DEBUG_PATH}.1`);
      acpDebugBytes = 0;
    }
    // `mode` applies only when the file is created, which after the rename
    // above is every rollover as well as the first frame of the first run.
    appendFileSync(ACP_DEBUG_PATH, line, { mode: 0o600 });
    acpDebugBytes += bytes;
  } catch { /* swallow — never break the protocol over a logging failure */ }
}

/** The size of the log already on disk, 0 when there is none. */
function adoptExistingLog(): number {
  try {
    const stat = statSync(ACP_DEBUG_PATH);
    // A log this build did not create is one an older Codeep created 0644 —
    // world-readable, with everything listed above in it. Tighten it, but
    // only at our own path: CODEEP_ACP_DEBUG_FILE may name something whose
    // mode is not ours to change (a fifo, a tty, a shared file).
    if (!process.env.CODEEP_ACP_DEBUG_FILE && (stat.mode & 0o077) !== 0) {
      chmodSync(ACP_DEBUG_PATH, 0o600);
    }
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Credential shapes blanked before a frame is mirrored to the debug log.
 *
 * The log exists to debug the protocol, so this is deliberately narrow: it
 * blanks what is unmistakably a secret and leaves everything else readable.
 * Matched on the frame TEXT rather than on a parsed object because an inbound
 * frame is logged before it is parsed and may not be JSON at all.
 *
 * Nothing here changes the frame on the wire — only the copy on disk.
 */
const ACP_DEBUG_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // `"apiKey": "…"`, `"authorization": "…"` — the MEMBER NAME says it is a
  // secret, whatever the value looks like.
  [/("[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|authorization|cookie|private[_-]?key)[A-Za-z0-9_.-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"'],
  // ACP spells an environment as `{"name":…,"value":…}`, so the secret-looking
  // string is the VALUE of `name` and the rule above cannot see it. This is
  // the shape terminal/create used to leak the whole of process.env in.
  [/("name"\s*:\s*"[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)[A-Za-z0-9_.-]*"\s*,\s*"value"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"'],
  // And the shapes that are a credential wherever they turn up — a command
  // line the agent ran, a terminal's own output, a file it read.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],              // OpenAI / Anthropic
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],         // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]'],           // GitLab
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],       // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],                 // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]'],             // Google
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'], // JWT
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, 'Bearer [redacted]'],
  // `https://user:password@host` — keep the structure, drop the password.
  [/((?:https?|ssh|git):\/\/[^\s"'/@]+:)[^\s"'/@]+@/g, '$1[redacted]@'],
];

/**
 * A frame with its obvious credentials blanked.
 *
 * Exported for unit testing (see transport.test.ts).
 */
export function redactCredentials(frame: string): string {
  let out = frame;
  for (const [pattern, replacement] of ACP_DEBUG_REDACTIONS) out = out.replace(pattern, replacement);
  return out;
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
