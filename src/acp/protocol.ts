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
  protocolVersion: number;
  agentCapabilities: {
    streaming?: boolean;
    fileEditing?: boolean;
  };
  agentInfo: {
    name: string;
    version: string;
  };
  authMethods: unknown[];
}

// ACP session/new request params
export interface SessionNewParams {
  cwd: string;
  mcpServers?: { name: string; command: string; args: string[]; env?: Record<string, string> }[];
}

// ACP ContentBlock (text only for now)
export interface ContentBlock {
  type: 'text';
  text: string;
}

// ACP session/prompt request params
export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type AcpMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
