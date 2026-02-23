// src/acp/server.ts
// Codeep ACP adapter — started via `codeep acp` CLI subcommand

import { randomUUID } from 'crypto';
import { StdioTransport } from './transport.js';
import { InitializeParams, InitializeResult, SessionNewParams, SessionPromptParams } from './protocol.js';
import { JsonRpcRequest } from './protocol.js';
import { runAgentSession } from './session.js';
import { initWorkspace, handleCommand, AcpSession } from './commands.js';
import { autoSaveSession } from '../config/index.js';
import { getCurrentVersion } from '../utils/update.js';

// All advertised slash commands (shown in Zed autocomplete)
const AVAILABLE_COMMANDS = [
  // Configuration
  { name: 'help',      description: 'Show available commands' },
  { name: 'status',    description: 'Show current config and session info' },
  { name: 'version',   description: 'Show version and current model' },
  { name: 'provider',  description: 'List or switch AI provider', input: { hint: '<provider-id>' } },
  { name: 'model',     description: 'List or switch model', input: { hint: '<model-id>' } },
  { name: 'login',     description: 'Set API key for a provider', input: { hint: '<providerId> <apiKey>' } },
  { name: 'apikey',    description: 'Show or set API key for current provider', input: { hint: '<key>' } },
  { name: 'lang',      description: 'Set response language', input: { hint: '<code> (en, hr, auto…)' } },
  { name: 'grant',     description: 'Grant write access for workspace' },
  // Sessions
  { name: 'session',   description: 'List sessions, or: new / load <name>', input: { hint: 'new | load <name>' } },
  { name: 'save',      description: 'Save current session', input: { hint: '[name]' } },
  // Context
  { name: 'add',       description: 'Add files to agent context', input: { hint: '<file> [file2…]' } },
  { name: 'drop',      description: 'Remove files from context (no args = clear all)', input: { hint: '[file…]' } },
  // Actions
  { name: 'diff',      description: 'Git diff with AI review', input: { hint: '[--staged]' } },
  { name: 'undo',      description: 'Undo last agent action' },
  { name: 'undo-all',  description: 'Undo all agent actions in session' },
  { name: 'changes',   description: 'Show all changes made in session' },
  { name: 'export',    description: 'Export conversation', input: { hint: 'json | md | txt' } },
  // Project intelligence
  { name: 'scan',      description: 'Scan project structure and generate summary' },
  { name: 'review',    description: 'Run code review on project or specific files', input: { hint: '[file…]' } },
  { name: 'learn',     description: 'Learn coding preferences from project files' },
  // Skills
  { name: 'skills',    description: 'List all available skills', input: { hint: '[query]' } },
  { name: 'commit',    description: 'Generate commit message and commit' },
  { name: 'fix',       description: 'Fix bugs or issues' },
  { name: 'test',      description: 'Write or run tests' },
  { name: 'docs',      description: 'Generate documentation' },
  { name: 'refactor',  description: 'Refactor code' },
  { name: 'explain',   description: 'Explain code' },
  { name: 'optimize',  description: 'Optimize code for performance' },
  { name: 'debug',     description: 'Debug an issue' },
  { name: 'push',      description: 'Git push' },
  { name: 'pr',        description: 'Create a pull request' },
  { name: 'build',     description: 'Build the project' },
  { name: 'deploy',    description: 'Deploy the project' },
];

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
        version: getCurrentVersion(),
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
      addedFiles: new Map(),
      abortController: null,
    });

    transport.respond(msg.id, { sessionId: acpSessionId });

    // Advertise all available slash commands to Zed
    transport.notify('session/update', {
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: AVAILABLE_COMMANDS,
      },
    });

    // Stream welcome message
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

    const abortController = new AbortController();
    session.abortController = abortController;

    const agentResponseChunks: string[] = [];
    const sendChunk = (text: string) => {
      agentResponseChunks.push(text);
      transport.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    };

    // Try slash commands first (async — skills, diff, scan, etc.)
    handleCommand(prompt, session, sendChunk, abortController.signal)
      .then((cmd) => {
        if (cmd.handled) {
          // For streaming commands (skills, diff), chunks were already sent via onChunk.
          // For simple commands, send the response now.
          if (cmd.response) sendChunk(cmd.response);
          transport.respond(msg.id, { stopReason: 'end_turn' });
          return;
        }

        // Not a command — run agent loop
        // Prepend any added-files context to the prompt
        let enrichedPrompt = prompt;
        if (session.addedFiles.size > 0) {
          const parts = ['[Attached files]'];
          for (const [, f] of session.addedFiles) {
            parts.push(`\nFile: ${f.relativePath}\n\`\`\`\n${f.content}\n\`\`\``);
          }
          enrichedPrompt = parts.join('\n') + '\n\n' + prompt;
        }

        runAgentSession({
          prompt: enrichedPrompt,
          workspaceRoot: session.workspaceRoot,
          conversationId: params.sessionId,
          abortSignal: abortController.signal,
          onChunk: sendChunk,
          onThought: (text: string) => {
            transport.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text },
              },
            });
          },
          onToolCall: (toolCallId, _toolName, kind, title, status, locations) => {
            transport.notify('session/update', {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId,
                title,
                kind,
                status,
                ...(locations?.length ? { locations: locations.map(uri => ({ uri })) } : {}),
              },
            });
          },
          onFileEdit: (uri, newText) => {
            // ACP structured file/edit notification — lets the editor apply changes
            transport.notify('file/edit', {
              uri,
              textChanges: newText
                ? [{ range: { start: { line: 0, character: 0 }, end: { line: 999999, character: 0 } }, text: newText }]
                : [],
            });
          },
        }).then(() => {
          session.history.push({ role: 'user', content: prompt });
          const agentResponse = agentResponseChunks.join('');
          if (agentResponse) {
            session.history.push({ role: 'assistant', content: agentResponse });
          }
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
      })
      .catch((err: Error) => {
        transport.error(msg.id, -32000, err.message);
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
