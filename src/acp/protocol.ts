// acp/protocol.ts
// ACP JSON-RPC message types — Agent Client Protocol spec

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

// ─── initialize ──────────────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion?: number;
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo?: { name: string; version: string };
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { stdio?: boolean; sse?: boolean; http?: boolean };
  // Per spec: { close?, list?, resume? }
  sessionCapabilities?: { close?: Record<string, unknown>; list?: Record<string, unknown>; resume?: Record<string, unknown> };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo: { name: string; version: string };
  authMethods: unknown[];
}

// ─── session/new ─────────────────────────────────────────────────────────────

export interface McpServer {
  name: string;
  /** Spawn command (stdio transport). Mutually exclusive with `url`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * If set, the client uses MCP Streamable HTTP transport against this URL
   * instead of spawning a child process. Per spec, the same endpoint
   * accepts POST (request) and GET (server-side SSE stream).
   */
  url?: string;
  /** Optional headers for the HTTP transport (Authorization etc.). */
  headers?: Record<string, string>;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModeState {
  availableModes: SessionMode[];
  currentModeId: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: 'mode' | 'model' | 'thought_level' | null;
  // Flattened from SessionConfigKind (tag = "type")
  type: 'select';
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface SessionNewParams {
  cwd: string;
  mcpServers?: McpServer[];
  fresh?: boolean;
}

export interface SessionNewResult {
  sessionId: string;
  // On a resume (`fresh: false`) the server loads the workspace's prior
  // session, so it can return that transcript here — letting a client that
  // reconnected (e.g. a VS Code window reload) repaint the chat instead of
  // showing blank while the agent still has the context. Empty/omitted on a
  // fresh session. Mirrors SessionLoadResult.history (user/assistant only).
  history?: { role: string; content: string }[];
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

// ─── session/load ─────────────────────────────────────────────────────────────

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers?: McpServer[];
}

export interface SessionLoadResult {
  sessionId?: string;
  history?: { role: string; content: string }[];
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

// ─── session/resume ──────────────────────────────────────────────────────────
// Lightweight reconnect — client keeps history locally and only needs a fresh
// hookup to the in-memory session (modes, config). No history replay.

export interface SessionResumeParams {
  sessionId: string;
  cwd: string;
  mcpServers?: McpServer[];
}

export interface SessionResumeResult {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

// ─── session/prompt ──────────────────────────────────────────────────────────

export interface ContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource';
  // type === 'text'
  text?: string;
  // type === 'image' | 'audio' (base64-encoded payload)
  data?: string;
  mimeType?: string;
  // type === 'resource_link' — flat fields per MCP spec
  uri?: string;
  name?: string;
  description?: string;
  // type === 'resource' — embedded content nested under .resource per MCP spec
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string; // base64-encoded binary
  };
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface SessionPromptResult {
  stopReason: 'end_turn' | 'cancelled';
}

// ─── session/cancel (notification, no id) ────────────────────────────────────

export interface SessionCancelParams {
  sessionId: string;
}

// ─── session/set_mode ────────────────────────────────────────────────────────

export interface SetSessionModeParams {
  sessionId: string;
  modeId: string;
}

// ─── session/set_config_option ───────────────────────────────────────────────

export interface SetSessionConfigOptionParams {
  sessionId: string;
  configId: string;
  value: unknown;
}

// ─── session/update notification (agent → client) ────────────────────────────
// The outer envelope always has { sessionId, update: <one of the below> }

export interface SessionUpdateAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
}

export interface SessionUpdateAgentThoughtChunk {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

export interface SessionUpdateToolCall {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind?: string;
  status: 'pending' | 'in_progress';
  locations?: { path: string }[];
}

export interface SessionUpdateToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: 'completed' | 'failed';
  rawOutput?: string;
}

export interface SessionUpdateAvailableCommands {
  sessionUpdate: 'available_commands_update';
  availableCommands: { name: string; description: string; input?: { hint: string } | null }[];
}

export interface SessionUpdateCurrentMode {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

export interface SessionUpdateConfigOption {
  sessionUpdate: 'config_option_update';
  configOptions: SessionConfigOption[];
}

export interface SessionUpdateSessionInfo {
  sessionUpdate: 'session_info_update';
  title: string;
  updatedAt?: string;
}

export interface PlanEntry {
  id: string;
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SessionUpdatePlan {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

export type SessionUpdateInner =
  | SessionUpdateAgentMessageChunk
  | SessionUpdateAgentThoughtChunk
  | SessionUpdateToolCall
  | SessionUpdateToolCallUpdate
  | SessionUpdatePlan
  | SessionUpdateAvailableCommands
  | SessionUpdateCurrentMode
  | SessionUpdateConfigOption
  | SessionUpdateSessionInfo;

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdateInner;
}

// ─── session/request_permission (agent → client, as JSON-RPC request) ────────

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
    status: 'pending' | 'completed' | 'failed';
    content: unknown[];
  };
  options: PermissionOption[];
}

export interface RequestPermissionResult {
  outcome: { type: 'cancelled' } | { type: 'selected'; optionId: string };
}

// ─── session/list ─────────────────────────────────────────────────────────────

export interface ListSessionsParams {
  cwd?: string;
  cursor?: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface ListSessionsResult {
  sessions: AcpSessionInfo[];
  nextCursor?: string | null;
}

// ─── session/delete ───────────────────────────────────────────────────────────

export interface DeleteSessionParams {
  sessionId: string;
  cwd?: string;
}

export interface DeleteSessionResult {
  // empty on success
}

// ─── fs methods (agent → client) ─────────────────────────────────────────────

export interface FsReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface FsReadTextFileResult {
  content: string;
}

export interface FsWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

// ─── terminal methods (agent → client) ───────────────────────────────────────

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  outputByteLimit?: number;
}

export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
  timeoutMs?: number;
}

export type TerminalExitStatus =
  | { type: 'exited'; code: number }
  | { type: 'killed'; signal?: string };

export interface TerminalWaitForExitResult {
  exitStatus: TerminalExitStatus;
}

export interface TerminalOutputParams {
  sessionId: string;
  terminalId: string;
  offset?: number;
}

export interface TerminalOutputResult {
  output: string;
  /** Absent while the process is still running; present once the process has exited. */
  exitStatus?: TerminalExitStatus;
}

export interface TerminalReleaseParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalReleaseResult {
  // empty on success
}

export type AcpMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
