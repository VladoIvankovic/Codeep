# Codeep ACP Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Agent Client Protocol (ACP) adapter so Codeep runs as an AI coding agent inside Zed editor via JSON-RPC over stdio.

**Architecture:** Single TypeScript process (`acp/index.ts`) started by Zed, reads JSON-RPC from stdin, calls existing `agentChat()` with streaming callback, sends text chunks and file diffs back to Zed.

**Tech Stack:** TypeScript, tsx (already in devDependencies), Node.js stdio, existing `src/utils/agent.ts` + `agentChat.ts` + `tools.ts`

---

## Task 1: Create `acp/protocol.ts` — ACP type definitions

**Files:**
- Create: `acp/protocol.ts`

**Step 1: Create the file with ACP JSON-RPC types**

```typescript
// acp/protocol.ts
// ACP JSON-RPC message types for Zed Agent Client Protocol

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ACP initialize request params
export interface InitializeParams {
  capabilities?: Record<string, unknown>;
  workspaceFolders?: { uri: string; name: string }[];
}

// ACP initialize result
export interface InitializeResult {
  capabilities: {
    streaming?: boolean;
    fileEditing?: boolean;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// ACP agent/run request params
export interface AgentRunParams {
  prompt: string;
  workspaceRoot?: string;
  conversationId?: string;
}

// ACP agent/stream notification params (adapter → Zed)
export interface AgentStreamParams {
  conversationId: string;
  text: string;
  done?: boolean;
}

// ACP workspace/applyEdit notification params (adapter → Zed)
export interface ApplyEditParams {
  changes: {
    uri: string;        // file:///absolute/path
    newText: string;    // full new content
  }[];
}

export type AcpMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
```

**Step 2: Commit**

```bash
git add acp/protocol.ts
git commit -m "feat(acp): add ACP protocol type definitions"
```

---

## Task 2: Create `acp/transport.ts` — stdio JSON-RPC I/O

**Files:**
- Create: `acp/transport.ts`

**Step 1: Create transport layer**

```typescript
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
```

**Step 2: Commit**

```bash
git add acp/transport.ts
git commit -m "feat(acp): add stdio JSON-RPC transport layer"
```

---

## Task 3: Create `acp/index.ts` — main ACP server entry point

**Files:**
- Create: `acp/index.ts`

**Step 1: Create the main server**

```typescript
// acp/index.ts
// Codeep ACP adapter — entry point for Zed agent integration

import { StdioTransport } from './transport.js';
import { InitializeParams, InitializeResult, AgentRunParams } from './protocol.js';
import { JsonRpcRequest } from './protocol.js';
import { runAgentSession } from './session.js';

const transport = new StdioTransport();

// Active cancellation controllers keyed by conversationId
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
    capabilities: {
      streaming: true,
      fileEditing: true,
    },
    serverInfo: {
      name: 'codeep',
      version: '1.0.0',
    },
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
```

**Step 2: Commit**

```bash
git add acp/index.ts
git commit -m "feat(acp): add ACP server entry point with initialize/run/cancel"
```

---

## Task 4: Create `acp/session.ts` — agent session runner

**Files:**
- Create: `acp/session.ts`
- Reference: `src/utils/agent.ts` (existing agent loop)

**Step 1: Read the existing runAgent function signature**

Open `src/utils/agent.ts` and find the `runAgent` export — note its parameters (projectContext, messages, onChunk, abortSignal, etc.).

**Step 2: Create session.ts that bridges ACP params → runAgent**

```typescript
// acp/session.ts
// Bridges ACP agent/run params to Codeep's existing agent loop

import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { runAgent } from '../src/utils/agent.js';
import { config } from '../src/config/index.js';
import { ProjectContext } from '../src/utils/project.js';

export interface AgentSessionOptions {
  prompt: string;
  workspaceRoot: string;
  conversationId: string;
  abortSignal: AbortSignal;
  onChunk: (text: string) => void;
  onFileEdit: (uri: string, newText: string) => void;
}

export async function runAgentSession(opts: AgentSessionOptions): Promise<void> {
  const { prompt, workspaceRoot, abortSignal, onChunk, onFileEdit } = opts;

  // Build minimal ProjectContext from workspace root
  const projectContext: ProjectContext = {
    root: resolve(workspaceRoot),
    name: resolve(workspaceRoot).split('/').pop() ?? 'project',
    type: 'unknown',
    structure: '',
    keyFiles: [],
    hasWriteAccess: true,
  };

  // Patch onChunk to also intercept file edits via write_file tool result
  // The agent emits tool results as text chunks in a structured format;
  // file edits are captured by hooking into the tool execution layer.
  // For v1, stream all text directly and notify file edits separately.

  await runAgent(
    prompt,
    [],          // fresh conversation per session
    projectContext,
    onChunk,
    abortSignal,
  );
}
```

> **Note:** After creating this file, run it and check for TypeScript errors. The `runAgent` signature may need adjustment — check `src/utils/agent.ts` for the exact export and params.

**Step 3: Commit**

```bash
git add acp/session.ts
git commit -m "feat(acp): add agent session bridge"
```

---

## Task 5: Create `acp/package.json` and verify it runs

**Files:**
- Create: `acp/package.json`

**Step 1: Create package.json**

```json
{
  "name": "codeep-acp",
  "version": "1.0.0",
  "description": "Codeep ACP adapter for Zed editor",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node --import tsx/esm index.ts"
  }
}
```

**Step 2: Test that the adapter starts without crashing**

Run from repo root:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node --import tsx/esm acp/index.ts
```

Expected output (on stdout):
```json
{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"streaming":true,"fileEditing":true},"serverInfo":{"name":"codeep","version":"1.0.0"}}}
```

If there are import errors, fix path aliases (`../src/` vs `../../src/`) until it resolves correctly.

**Step 3: Test agent/run with a simple prompt**

```bash
echo -e '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"agent/run","params":{"prompt":"say hello","workspaceRoot":"/tmp"}}' | CODEEP_API_KEY=your_key node --import tsx/esm acp/index.ts
```

Expected: streaming `agent/stream` notifications followed by `{"id":2,"result":{"done":true}}`.

**Step 4: Commit**

```bash
git add acp/package.json
git commit -m "feat(acp): add package.json and verify adapter runs"
```

---

## Task 6: Update README with Zed setup instructions

**Files:**
- Modify: `README.md` (add new section near end)

**Step 1: Add Zed integration section to README**

Find the end of the README and add:

```markdown
## Zed Editor Integration (ACP)

Codeep supports the [Agent Client Protocol (ACP)](https://agentclientprotocol.com), letting you use it as an AI coding agent directly inside [Zed](https://zed.dev).

### Setup

1. Add to your Zed `settings.json`:

```json
{
  "agent_servers": {
    "Codeep": {
      "type": "custom",
      "command": "node",
      "args": ["--import", "tsx/esm", "/absolute/path/to/Codeep/acp/index.ts"]
    }
  }
}
```

2. Make sure your API key is set in the environment Zed uses:

```bash
export DEEPSEEK_API_KEY=your_key   # or whichever provider
```

3. Open Zed's AI panel and select **Codeep** as the agent.
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Zed ACP integration setup instructions"
```

---

## Task 7: Push all commits

```bash
git push
```

Verify on GitHub that all commits appear under `main`.

---

## Notes for Implementer

- `tsx` is in devDependencies — use `node --import tsx/esm` to run TypeScript directly
- The `src/` imports use ES module paths — add `.js` extension even for `.ts` files (TypeScript ESM convention)
- `runAgent` in `src/utils/agent.ts` is the main loop — check its exact signature before wiring session.ts
- For v1, file edit notifications (`workspace/applyEdit`) are a best-effort — Zed may or may not render a diff depending on its ACP version; streaming text always works
- `CODEEP_DEBUG=1` enables verbose logging to stderr (doesn't pollute stdout JSON-RPC)
