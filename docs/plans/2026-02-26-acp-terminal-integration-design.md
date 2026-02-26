# ACP Terminal Integration Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route `execute_command` tool calls through Zed's terminal API when running in ACP mode, so users see live command output in a real Zed terminal panel instead of a hidden internal buffer.

**Architecture:** Add an optional `onExecuteCommand` callback to `AgentOptions`. In ACP mode, `server.ts` implements this callback by delegating to Zed via `terminal/create` → `terminal/waitForExit` → `terminal/output` → `terminal/release`. In CLI mode the callback is absent and execution falls through to the existing local shell path unchanged.

**Tech Stack:** TypeScript, JSON-RPC 2.0 over stdio, existing `StdioTransport.request()`, ACP terminal methods.

---

## Design

### New types in `protocol.ts`

```typescript
// terminal/create (agent → client)
interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  outputByteLimit?: number;
}
interface TerminalCreateResult { terminalId: string }

// terminal/waitForExit (agent → client)
interface TerminalWaitForExitParams { sessionId: string; terminalId: string }
interface TerminalWaitForExitResult {
  exitStatus: { type: 'exited'; code: number } | { type: 'killed' }
}

// terminal/output (agent → client)
interface TerminalOutputParams { sessionId: string; terminalId: string }
interface TerminalOutputResult { output: string; exitStatus?: TerminalWaitForExitResult['exitStatus'] }

// terminal/release (agent → client)
interface TerminalReleaseParams { sessionId: string; terminalId: string }
```

### `AgentOptions` extension in `agent.ts`

```typescript
onExecuteCommand?: (
  command: string,
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>
```

Called in the `execute_command` case before falling back to `executeCommandAsync`. If the callback throws, fall back to local execution.

### `AgentSessionOptions` extension in `session.ts`

```typescript
onExecuteCommand?: (command: string, args: string[], cwd: string)
  => Promise<{ stdout: string; stderr: string; exitCode: number }>
```

Passed through directly to `runAgent()`.

### `server.ts` callback implementation

```typescript
onExecuteCommand: async (command, args, cwd) => {
  try {
    const { terminalId } = await transport.request('terminal/create', {
      sessionId: params.sessionId, command, args, cwd, outputByteLimit: 1_000_000,
    }) as TerminalCreateResult;
    await transport.request('terminal/waitForExit', { sessionId: params.sessionId, terminalId });
    const { output } = await transport.request('terminal/output', {
      sessionId: params.sessionId, terminalId,
    }) as TerminalOutputResult;
    await transport.request('terminal/release', { sessionId: params.sessionId, terminalId });
    const exitStatus = (await transport.request('terminal/waitForExit', {
      sessionId: params.sessionId, terminalId,
    }) as TerminalWaitForExitResult).exitStatus;
    const exitCode = exitStatus.type === 'exited' ? exitStatus.code : 1;
    return { stdout: output, stderr: '', exitCode };
  } catch {
    // Zed terminal not available — fall back to local execution
    return executeCommandAsync(command, args, { cwd, projectRoot: cwd, timeout: 120000 })
      .then(r => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 0 }));
  }
}
```

### `InitializeResult` capability advertisement

```typescript
agentCapabilities: {
  terminal: true,
  loadSession: true,
  sessionCapabilities: { list: {} },
}
```

### What does NOT change

- `toolExecution.ts` — no changes
- `shell.ts` — no changes
- CLI mode — `execute_command` identical to today
- All other tools — unchanged
