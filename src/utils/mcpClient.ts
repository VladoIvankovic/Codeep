/**
 * Minimal MCP (Model Context Protocol) stdio client.
 *
 * Each `McpClient` instance owns one child process running an MCP server
 * (e.g. `npx @modelcontextprotocol/server-filesystem /some/path`). It speaks
 * JSON-RPC 2.0 over stdio per the MCP spec, performs the
 * initialize → tools/list handshake, and exposes a `callTool` method that
 * agent tool dispatch routes through.
 *
 * Scope of this MVP:
 *   - initialize + tools/list discovery
 *   - tools/call forwarding
 *   - stop() kills the process and rejects in-flight requests
 *
 * NOT covered yet (defer to a future iteration):
 *   - resources / prompts / sampling MCP primitives
 *   - capability negotiation beyond "we want tools"
 *   - server-initiated requests (we ignore them)
 *   - reconnect on crash (process exit is fatal for that client)
 */

import { spawn, ChildProcess } from 'child_process';
import type { McpServer } from '../acp/protocol.js';
import { StreamableHttpClient } from './mcpStreamableHttp.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  /** Text payload — set when the server returns a text resource. */
  text?: string;
  /** Base64 blob payload — set when the server returns binary. */
  blob?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  /** Argument metadata if the prompt is parameterised. */
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpPromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: { type: string; text?: string; [k: string]: unknown };
}

/**
 * Server-initiated `sampling/createMessage` request payload. MCP servers
 * that opt into the `sampling` capability send this to ask the host LLM
 * (Codeep, in our case) to generate a completion on their behalf.
 */
export interface SamplingCreateMessageParams {
  messages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } }[];
  modelPreferences?: {
    hints?: { name?: string }[];
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface SamplingCreateMessageResult {
  role: 'assistant';
  content: { type: 'text'; text: string };
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  // For diagnostics / timeout messages — `tools/list`, `tools/call`, etc.
  method: string;
}

/** JSON-RPC request id sequence. Module-level so ids stay unique across clients
 * (helps when scanning logs from multiple servers in the same session). */
let nextRequestId = 1;

export class McpClient {
  /** Stdio transport state. Null when running over HTTP (or before start). */
  private child: ChildProcess | null = null;
  /** HTTP transport state. Null when running over stdio. */
  private http: StreamableHttpClient | null = null;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private stopped = false;
  private toolsCache: McpTool[] | null = null;

  /** True when this client is configured for the Streamable HTTP transport. */
  private get isHttp(): boolean {
    return Boolean(this.server.url);
  }
  /**
   * Rolling-window record of recent crash times (ms epoch). Used by the
   * auto-reconnect logic: too many crashes in a short window → give up
   * instead of spinning indefinitely on a broken server.
   */
  private crashTimestamps: number[] = [];
  /** Reconnect tuning — generous defaults, configurable via env if needed. */
  private readonly MAX_RESTARTS = 3;
  private readonly RESTART_WINDOW_MS = 60_000;
  /** Has the agent loop been notified that this server is fully gone? */
  private gaveUp = false;
  /**
   * Optional callback fired after a successful auto-restart. The registry
   * uses this to drop its tools cache so the next `listTools()` re-queries
   * (the server may expose a different tool set after restart).
   */
  onRestart?: () => void;
  /**
   * Optional callback fired when the client gives up after exceeding the
   * restart budget. The registry uses this to surface a visible "MCP
   * server died" error in /mcp.
   */
  onGaveUp?: (reason: string) => void;
  /**
   * Optional callback fired when the server sends a `notifications/*`
   * indicating its catalog changed (tools, resources, prompts). The
   * registry forwards this up so the agent loop can re-fetch on the next
   * iteration.
   */
  onCatalogChanged?: (kind: 'tools' | 'resources' | 'prompts') => void;

  /**
   * @param server  MCP server config (command, args, env, name).
   * @param opts    Optional client metadata.
   *                - `workspaceRoot` exposed to the server as a root via
   *                  the `roots` capability so filesystem-style servers
   *                  can scope their reads.
   *                - `onSamplingRequest` makes the client advertise the
   *                  `sampling` capability and routes server-initiated
   *                  `sampling/createMessage` to the host LLM.
   */
  constructor(
    public readonly server: McpServer,
    public readonly clientOpts: {
      workspaceRoot?: string;
      onSamplingRequest?: (params: SamplingCreateMessageParams) => Promise<SamplingCreateMessageResult>;
    } = {},
  ) {}

  /** Open the transport and perform the MCP handshake. */
  async start(opts: { initTimeoutMs?: number } = {}): Promise<void> {
    if (this.child || this.http) throw new Error(`MCP server "${this.server.name}" already started`);
    const initTimeoutMs = opts.initTimeoutMs ?? 15_000;

    if (this.isHttp) {
      // HTTP transport: no child process. Frames arrive via onFrame
      // callback wired into the StreamableHttpClient.
      this.http = new StreamableHttpClient({
        url: this.server.url!,
        headers: this.server.headers,
        onFrame: (msg) => this.dispatchFrame(msg as Record<string, unknown>),
        onError: (err) => {
          // Surface transport-level failures the same way a stdio crash
          // does — reject pending requests and let the registry decide
          // whether to retry.
          for (const [, req] of this.pending) req.reject(err);
          this.pending.clear();
        },
      });
    } else {
      if (!this.server.command) {
        throw new Error(`MCP server "${this.server.name}" has neither command nor url`);
      }
      this.child = spawn(this.server.command, this.server.args ?? [], {
        env: { ...process.env, ...this.server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.attachChildHandlers();
    }

    // Initialize handshake per MCP spec. protocolVersion is required.
    // We advertise `roots` so filesystem-shaped MCP servers can scope to
    // the user's workspace. Sampling is advertised when the client passed
    // a sampling callback into the constructor — otherwise we omit it so
    // the server doesn't try (and fail) to use a capability we can't
    // back. `listChanged` is true everywhere so the server knows we
    // listen for catalog updates.
    const capabilities: Record<string, unknown> = {
      roots: { listChanged: true },
    };
    if (this.clientOpts.onSamplingRequest) {
      capabilities.sampling = {};
    }
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities,
      clientInfo: { name: 'codeep', version: '2.0.0' },
    }, { timeoutMs: initTimeoutMs });

    // Spec: after `initialize` reply, send `notifications/initialized` so the
    // server knows we're done with the boot sequence.
    this.notify('notifications/initialized', {});
  }

  /** Discover tools the server exposes. Cached on first call. */
  async listTools(): Promise<McpTool[]> {
    if (this.toolsCache) return this.toolsCache;
    if (!this.child) throw new Error(`MCP server "${this.server.name}" not started`);
    const result = await this.request('tools/list', {}) as { tools?: McpTool[] };
    this.toolsCache = result.tools ?? [];
    return this.toolsCache;
  }

  /**
   * Discover resources the server exposes. Not all servers implement
   * resources/list — those return a `-32601 Method not found`, which we
   * surface as an empty array (callers can treat absence and emptiness
   * the same way).
   */
  async listResources(): Promise<McpResource[]> {
    if (!this.child) throw new Error(`MCP server "${this.server.name}" not started`);
    try {
      const result = await this.request('resources/list', {}) as { resources?: McpResource[] };
      return result.resources ?? [];
    } catch (err) {
      // -32601 (method not found) on resources/list means the server
      // doesn't expose any. Other errors propagate.
      if (/Method not found/.test((err as Error).message)) return [];
      throw err;
    }
  }

  /** Read one resource by URI. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    if (!this.child) throw new Error(`MCP server "${this.server.name}" not started`);
    const result = await this.request('resources/read', { uri }) as { contents?: McpResourceContent[] };
    return result.contents ?? [];
  }

  /** Discover prompt templates the server exposes (optional capability). */
  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.child) throw new Error(`MCP server "${this.server.name}" not started`);
    try {
      const result = await this.request('prompts/list', {}) as { prompts?: McpPrompt[] };
      return result.prompts ?? [];
    } catch (err) {
      if (/Method not found/.test((err as Error).message)) return [];
      throw err;
    }
  }

  /** Materialise a prompt template into its message sequence. */
  async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<{ description?: string; messages: McpPromptMessage[] }> {
    if (!this.child) throw new Error(`MCP server "${this.server.name}" not started`);
    const result = await this.request('prompts/get', { name, arguments: args }) as { description?: string; messages?: McpPromptMessage[] };
    return { description: result.description, messages: result.messages ?? [] };
  }

  /** Invoke a tool on this server. */
  async callTool(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<string> {
    if (!this.child) throw new Error(`MCP server "${this.server.name}" not started`);
    const result = await this.request('tools/call', { name, arguments: args }, opts) as
      { content?: { type: string; text?: string }[]; isError?: boolean };

    // Per spec the tool result is a content array. We flatten text parts —
    // images and embedded resources would need more work, deferred.
    const text = (result.content ?? [])
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n');

    if (result.isError) throw new Error(text || `MCP tool ${name} returned an error`);
    return text;
  }

  /**
   * Attempt to spawn a fresh child process after a crash. Tries up to
   * MAX_RESTARTS times within RESTART_WINDOW_MS, then gives up. After a
   * successful restart, `toolsCache` is cleared so the next listTools()
   * re-queries — the server may legitimately expose different tools after
   * a code reload.
   */
  private async attemptRestart(): Promise<void> {
    const now = Date.now();
    // Trim crash entries outside the window.
    this.crashTimestamps = this.crashTimestamps.filter(t => now - t < this.RESTART_WINDOW_MS);
    this.crashTimestamps.push(now);
    if (this.crashTimestamps.length > this.MAX_RESTARTS) {
      this.gaveUp = true;
      const reason = `crashed ${this.crashTimestamps.length} times in ${Math.round(this.RESTART_WINDOW_MS / 1000)}s`;
      try { this.onGaveUp?.(reason); } catch { /* never let a callback throw kill us */ }
      return;
    }

    // Small backoff so we don't hot-loop if the server crashes on startup.
    const attempt = this.crashTimestamps.length;
    const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 5000);
    await new Promise(r => setTimeout(r, backoffMs));
    if (this.stopped) return;

    try {
      // Need to allow `start()` to proceed even though `child` was already
      // set previously — clear the toolsCache to force a re-list and let
      // start() reset state.
      this.toolsCache = null;
      // Direct private re-spawn: can't call start() because it throws when
      // child was previously set. Inline the spawn + handshake here.
      // Restart only handles stdio — HTTP transport doesn't crash in the
      // same sense (no child to die); transient HTTP errors reject pending
      // requests and the next user prompt will retry naturally.
      if (this.isHttp) return;
      if (!this.server.command) return;
      this.child = spawn(this.server.command, this.server.args ?? [], {
        env: { ...process.env, ...this.server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.attachChildHandlers();
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codeep', version: '1.4.0' },
      }, { timeoutMs: 15_000 });
      this.notify('notifications/initialized', {});
      try { this.onRestart?.(); } catch { /* swallow */ }
    } catch {
      // Restart attempt itself failed — let the next 'exit' (if any) try
      // again, or just sit idle if the spawn never reached 'exit'.
    }
  }

  /** Wire up data/exit/error listeners on the current child. Used by start() and attemptRestart(). */
  private attachChildHandlers(): void {
    if (!this.child) return;
    this.child.on('exit', (code) => {
      const err = new Error(`MCP server "${this.server.name}" exited (code ${code})`);
      for (const [, req] of this.pending) req.reject(err);
      this.pending.clear();
      this.child = null;
      if (!this.stopped && !this.gaveUp) {
        void this.attemptRestart();
      }
    });
    this.child.on('error', (err) => {
      for (const [, req] of this.pending) req.reject(err);
      this.pending.clear();
    });
    this.child.stdout?.setEncoding('utf-8');
    this.child.stdout?.on('data', (chunk: string) => this.handleStdout(chunk));
  }

  /** Tear down the transport (stdio child or HTTP stream) and reject pending requests. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const err = new Error(`MCP server "${this.server.name}" stopped`);
    for (const [, req] of this.pending) req.reject(err);
    this.pending.clear();
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
      // Give the server a moment to exit cleanly before forcing it. We
      // don't await the exit — callers shouldn't block on cleanup.
      setTimeout(() => {
        if (this.child) {
          try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 1000);
      this.child = null;
    }
    if (this.http) {
      await this.http.stop().catch(() => { /* swallow */ });
      this.http = null;
    }
  }

  // ── JSON-RPC plumbing ───────────────────────────────────────────────────────

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    // MCP uses newline-delimited JSON-RPC. Iterate every complete line.
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.dispatchFrame(msg);
      } catch {
        // Malformed line — skip rather than crash the agent.
      }
    }
  }

  /**
   * Handle a request from the MCP server (server-initiated JSON-RPC).
   * Currently handled methods:
   *   - `roots/list` — return the workspace folder if provided
   *   - `sampling/createMessage` — delegate to the host LLM callback if
   *     one was wired into the constructor; otherwise -32601 (so a
   *     server that asks without us advertising the capability gets a
   *     clear "no" instead of a hang).
   *
   * Anything else replies with `-32601 Method not found` per JSON-RPC spec.
   */
  private handleServerRequest(id: number, method: string, params?: Record<string, unknown>): void {
    if (method === 'roots/list') {
      const roots = this.clientOpts.workspaceRoot
        ? [{
            uri: `file://${this.clientOpts.workspaceRoot}`,
            name: this.clientOpts.workspaceRoot.split('/').pop() || 'workspace',
          }]
        : [];
      this.writeResponse({ id, result: { roots } });
      return;
    }

    if (method === 'sampling/createMessage' && this.clientOpts.onSamplingRequest) {
      // Async — handled out-of-band so server doesn't see a sync error.
      void (async () => {
        try {
          const result = await this.clientOpts.onSamplingRequest!(params as unknown as SamplingCreateMessageParams);
          this.writeResponse({ id, result });
        } catch (err) {
          this.writeResponse({ id, error: { code: -32603, message: `sampling failed: ${(err as Error).message}` } });
        }
      })();
      return;
    }

    this.writeResponse({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  /** Serialise and send a JSON-RPC response over whichever transport is active. */
  private writeResponse(payload: { id: number; result?: unknown; error?: { code: number; message: string } }): void {
    const frame = { jsonrpc: '2.0', ...payload };
    this.writeFrame(frame);
  }

  /**
   * Single send path used by request/notify/writeResponse. Stdio just
   * pipes the serialised frame + newline. HTTP POSTs the JSON body; the
   * response (or any later SSE event) re-enters via `dispatchFrame`.
   * Errors on the HTTP path reject pending request promises so the
   * agent doesn't hang waiting on a frame that'll never come.
   */
  private writeFrame(frame: object): void {
    const json = JSON.stringify(frame);
    if (this.http) {
      void this.http.send(frame).catch((err) => {
        // If the POST itself fails (network, 5xx) we need to fail
        // anything we were waiting on so the caller sees the error
        // instead of timing out.
        const e = err as Error;
        // Best-effort: if this frame had an id and is still pending,
        // reject just that one. Otherwise reject everything.
        const f = frame as { id?: number };
        if (typeof f.id === 'number' && this.pending.has(f.id)) {
          this.pending.get(f.id)!.reject(e);
          this.pending.delete(f.id);
        } else {
          for (const [, req] of this.pending) req.reject(e);
          this.pending.clear();
        }
      });
      return;
    }
    if (this.child?.stdin) {
      this.child.stdin.write(json + '\n');
    }
  }

  /**
   * Common entry point for every incoming JSON-RPC frame, regardless of
   * transport. Stdio's `handleStdout` parses lines and forwards each
   * here; the HTTP transport calls this directly from its `onFrame`.
   */
  private dispatchFrame(msg: Record<string, unknown>): void {
    // Server-initiated request — has method AND id.
    if (typeof msg.method === 'string' && typeof msg.id === 'number') {
      this.handleServerRequest(msg.id, msg.method, msg.params as Record<string, unknown> | undefined);
      return;
    }
    // Server notification — method, no id. Track catalog-change ones.
    if (typeof msg.method === 'string' && msg.id === undefined) {
      const method = msg.method;
      if (method === 'notifications/tools/list_changed') {
        this.toolsCache = null;
        try { this.onCatalogChanged?.('tools'); } catch { /* swallow */ }
      } else if (method === 'notifications/resources/list_changed') {
        try { this.onCatalogChanged?.('resources'); } catch { /* swallow */ }
      } else if (method === 'notifications/prompts/list_changed') {
        try { this.onCatalogChanged?.('prompts'); } catch { /* swallow */ }
      }
      return;
    }
    // Otherwise: response to one of our requests.
    if (typeof msg.id !== 'number') return;
    const req = this.pending.get(msg.id);
    if (!req) return;
    this.pending.delete(msg.id);
    const err = msg.error as { code: number; message: string } | undefined;
    if (err) req.reject(new Error(`${req.method}: ${err.message} (code ${err.code})`));
    else req.resolve(msg.result);
  }

  private request(method: string, params: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.child && !this.http) return Promise.reject(new Error(`MCP server "${this.server.name}" transport closed`));
    const id = nextRequestId++;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child && !this.http) return;
    this.writeFrame({ jsonrpc: '2.0', method, params });
  }
}
