// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
import { StdioTransport } from './transport.js';
import { InitializeParams, InitializeResult, SessionNewParams, SessionPromptParams } from './protocol.js';
import { JsonRpcRequest } from './protocol.js';
import { runAgentSession } from './session.js';
import { initWorkspace, handleCommand, AcpSession } from './commands.js';
import { autoSaveSession } from '../config/index.js';

export function startAcpServer(): Promise<void> {
  const transport = new StdioTransport();

  // ACP sessionId → full AcpSession (includes history + codeep session tracking)
  const sessions = new Map<string, AcpSession & { abortController: AbortController | null }>();

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
    const acpSessionId = randomUUID();

    // Initialise workspace: create .codeep folder, load/create codeep session
    const { codeepSessionId, history, welcomeText } = initWorkspace(params.cwd);

    sessions.set(acpSessionId, {
      sessionId: acpSessionId,
      workspaceRoot: params.cwd,
      history,
      codeepSessionId,
      abortController: null,
    });

    transport.respond(msg.id, { sessionId: acpSessionId });

    // Stream welcome message so the client sees it immediately after session/new
    transport.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: welcomeText },
      },
    });
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

    // Handle slash commands — no agent loop needed
    const cmd = handleCommand(prompt, session);
    if (cmd.handled) {
      transport.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: cmd.response },
        },
      });
      transport.respond(msg.id, { stopReason: 'end_turn' });
      return;
    }

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
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
      },
      onFileEdit: (_uri, _newText) => {
        // file edits are streamed via onChunk for now
      },
    }).then(() => {
      // Persist conversation history after each agent turn
      session.history.push({ role: 'user', content: prompt });
      autoSaveSession(session.history, session.workspaceRoot);
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
