// acp/transport.ts
// Newline-delimited JSON-RPC over stdio

import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.js';

type MessageHandler = (msg: JsonRpcRequest | JsonRpcNotification) => void;

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT_MS = 30_000; // 30s

export class StdioTransport {
  private buffer = '';
  private handler: MessageHandler | null = null;
  private pendingRequests = new Map<number | string, (result: unknown) => void>();
  private requestIdCounter = 1000;

  start(handler: MessageHandler): void {
    this.handler = handler;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  private onData(chunk: string): void {
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
      try {
        const msg = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
        // Check if this is a response to one of our outbound requests
        if ('result' in msg || 'error' in msg) {
          const response = msg as JsonRpcResponse;
          const resolve = this.pendingRequests.get(response.id);
          if (resolve) {
            this.pendingRequests.delete(response.id);
            resolve(response.result ?? null);
            continue;
          }
        }
        this.handler?.(msg as JsonRpcRequest | JsonRpcNotification);
      } catch {
        // ignore malformed messages
      }
    }
  }

  send(msg: JsonRpcResponse | JsonRpcNotification): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
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
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestIdCounter;
    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          resolve(null);
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }
}
