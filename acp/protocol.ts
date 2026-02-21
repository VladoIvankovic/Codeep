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
