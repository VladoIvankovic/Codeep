# Codeep ACP Adapter for Zed — Design

**Date:** 2026-02-21  
**Status:** Approved

## Goal

Build an Agent Client Protocol (ACP) adapter so Codeep can run as an AI coding agent inside Zed editor (and any other ACP-compatible editor). Users get Codeep's full agent capabilities — multi-provider LLM support, tool execution, file editing — directly inside the editor UI with Zed's diff visualization.

## Architecture

```
Zed Editor
    ↕ JSON-RPC over stdio
acp/index.ts  (ACP adapter process)
    ↕ direct TypeScript import
src/utils/agentChat.ts
src/utils/tools.ts
src/utils/taskPlanner.ts
src/config/index.ts
```

The adapter is a single Node.js process started by Zed, communicating via JSON-RPC over stdio. Internally it calls the existing Codeep agent system via direct imports.

## Components

### `acp/index.ts` — Main entry point
- Reads newline-delimited JSON-RPC messages from `stdin`
- Handles ACP lifecycle methods: `initialize`, `agent/run`, `agent/cancel`
- Calls `agentChat()` with streaming `onChunk` callback
- Sends streaming text chunks back to Zed as they arrive

### `acp/protocol.ts` — ACP type definitions
- TypeScript interfaces for ACP JSON-RPC request/response/notification shapes

### `acp/fileSync.ts` — File change → Zed diff
- Intercepts tool calls that write files (from `agentChat` tool execution)
- Sends `workspace/applyEdit` ACP notification to Zed
- Zed renders a diff panel for the user to review before applying

### `acp/package.json` — Minimal config
- No extra dependencies (uses project-level `tsx`)
- Entry: `node --import tsx acp/index.ts`

## Data Flow

```
Zed → adapter:  { id: 1, method: "agent/run", params: { prompt: "refactor this function" } }

adapter → Zed:  { method: "agent/stream", params: { id: 1, text: "I'll start by..." } }
                { method: "agent/stream", params: { id: 1, text: " reading the file..." } }
                { method: "workspace/applyEdit", params: { changes: [{ file, diff }] } }
                { id: 1, result: { done: true } }
```

## User Configuration (Zed settings.json)

```json
{
  "agent_servers": {
    "Codeep": {
      "type": "custom",
      "command": "node",
      "args": ["--import", "tsx", "/path/to/Codeep/acp/index.ts"]
    }
  }
}
```

## Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Mode | Agent (not chat-only) | Leverages existing tools, agentChat, taskPlanner |
| Language | TypeScript | Same as codebase, direct imports, tsx already available |
| Integration | Direct import | No subprocess overhead, no duplication |
| Output | Streaming text + file diffs | Better UX than terminal, uses Zed's diff panel |

## Out of Scope

- Zed extension (WASM/Rust) — not needed for ACP adapter
- Publishing to ACP Registry — future work after adapter is stable
- Remote/HTTP agent mode — stdio is sufficient for local use
