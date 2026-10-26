// utils/mcpTypes.ts
// The shape of one configured MCP server. Shared by the config loader, the
// client, the registry and the marketplace.

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
