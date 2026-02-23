// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { StdioTransport } from './transport.js';
import { InitializeParams, InitializeResult, AgentRunParams } from './protocol.js';
import { JsonRpcRequest } from './protocol.js';
import { runAgentSession } from './session.js';

export function startAcpServer(): Promise<void> {
  const transport = new StdioTransport();
  const activeSessions = new Map<string, AbortController>();

  transport.start((msg: JsonRpcRequest) => {
    switch (msg.method) {
      case 'initialize':
        handleInitialize(msg);
        break;
      case 'initialized':
        // no-op acknowledgment
        break;
      case 'agent/run':
        handleAgentRun(msg);
        break;
      case 'agent/cancel':
        handleAgentCancel(msg);
        break;
      default:
        transport.error(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  });

  function handleInitialize(msg: JsonRpcRequest): void {
    const _params = msg.params as InitializeParams;
    const result: InitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {
        streaming: true,
        fileEditing: true,
      },
      agentInfo: {
        name: 'codeep',
        version: '1.0.0',
      },
      authMethods: [],
    };
    transport.respond(msg.id, result);
  }

  function handleAgentRun(msg: JsonRpcRequest): void {
    const params = msg.params as AgentRunParams;
    const conversationId = params.conversationId ?? String(msg.id);
    const abortController = new AbortController();
    activeSessions.set(conversationId, abortController);

    runAgentSession({
      prompt: params.prompt,
      workspaceRoot: params.workspaceRoot ?? process.cwd(),
      conversationId,
      abortSignal: abortController.signal,
      onChunk: (text) => {
        transport.notify('agent/stream', { conversationId, text });
      },
      onFileEdit: (uri, newText) => {
        transport.notify('workspace/applyEdit', {
          changes: [{ uri, newText }],
        });
      },
    }).then(() => {
      transport.respond(msg.id, { done: true });
    }).catch((err: Error) => {
      if (err.name === 'AbortError') {
        transport.respond(msg.id, { cancelled: true });
      } else {
        transport.error(msg.id, -32000, err.message);
      }
    }).finally(() => {
      activeSessions.delete(conversationId);
    });
  }

  function handleAgentCancel(msg: JsonRpcRequest): void {
    const { conversationId } = msg.params as { conversationId: string };
    activeSessions.get(conversationId)?.abort();
    activeSessions.delete(conversationId);
    transport.respond(msg.id, { cancelled: true });
  }

  // Keep process alive until stdin closes (Zed terminates us)
  return new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
  });
}
