// acp/transport.ts
// Newline-delimited JSON-RPC over stdio

import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.js';

type MessageHandler = (msg: JsonRpcRequest) => void;

export class StdioTransport {
  private buffer = '';
  private handler: MessageHandler | null = null;

  start(handler: MessageHandler): void {
    this.handler = handler;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcRequest;
        this.handler?.(msg);
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
}
