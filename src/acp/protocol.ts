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
  sessionCapabilities?: Record<string, unknown>;
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
  command: string;
  args: string[];
  env?: Record<string, string>;
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
}

export interface SessionNewResult {
  sessionId: string;
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
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

// ─── session/prompt ──────────────────────────────────────────────────────────

export interface ContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource';
  text?: string;       // type === 'text'
  data?: string;       // type === 'image' | 'audio' (base64)
  mimeType?: string;
  uri?: string;
  name?: string;
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

export type AcpMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
