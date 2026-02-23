// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
import { StdioTransport } from './transport.js';
import { InitializeParams, InitializeResult, SessionNewParams, SessionPromptParams } from './protocol.js';
import { JsonRpcRequest } from './protocol.js';
import { runAgentSession } from './session.js';

export function startAcpServer(): Promise<void> {
  const transport = new StdioTransport();

  // sessionId → { workspaceRoot, abortController }
  const sessions = new Map<string, { workspaceRoot: string; abortController: AbortController | null }>();

  transport.start((msg: JsonRpcRequest) => {
    switch (msg.method) {
      case 'initialize':
        handleInitialize(msg);
        break;
      case 'initialized':
        // no-op acknowledgment
        break;
      case 'session/new':
        handleSessionNew(msg);
        break;
      case 'session/prompt':
        handleSessionPrompt(msg);
        break;
      case 'session/cancel':
        handleSessionCancel(msg);
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

  function handleSessionNew(msg: JsonRpcRequest): void {
    const params = msg.params as SessionNewParams;
    const sessionId = randomUUID();
    sessions.set(sessionId, { workspaceRoot: params.cwd, abortController: null });
    transport.respond(msg.id, { sessionId });
  }

  function handleSessionPrompt(msg: JsonRpcRequest): void {
    const params = msg.params as SessionPromptParams;
    const session = sessions.get(params.sessionId);
    if (!session) {
      transport.error(msg.id, -32602, `Unknown sessionId: ${params.sessionId}`);
      return;
    }

    // Extract text from ContentBlock[]
    const prompt = params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const abortController = new AbortController();
    session.abortController = abortController;

    runAgentSession({
      prompt,
      workspaceRoot: session.workspaceRoot,
      conversationId: params.sessionId,
      abortSignal: abortController.signal,
      onChunk: (text) => {
        transport.notify('session/update', {
          sessionId: params.sessionId,
          type: 'agent_message_chunk',
          text,
        });
      },
      onFileEdit: (_uri, _newText) => {
        // file edits are streamed via onChunk for now
      },
    }).then(() => {
      transport.respond(msg.id, { stopReason: 'end_turn' });
    }).catch((err: Error) => {
      if (err.name === 'AbortError') {
        transport.respond(msg.id, { stopReason: 'cancelled' });
      } else {
        transport.error(msg.id, -32000, err.message);
      }
    }).finally(() => {
      if (session) session.abortController = null;
    });
  }

  function handleSessionCancel(msg: JsonRpcRequest): void {
    const { sessionId } = msg.params as { sessionId: string };
    sessions.get(sessionId)?.abortController?.abort();
    transport.respond(msg.id, {});
  }

  // Keep process alive until stdin closes (Zed terminates us)
  return new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
  });
}
