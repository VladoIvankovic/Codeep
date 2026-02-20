/**
 * MCP (Model Context Protocol) integration for Z.AI and MiniMax.
 *
 * Provides config discovery and API call helpers used by toolExecution.ts.
 */

import { config, getApiKey } from '../config/index';
import { getProviderMcpEndpoints, PROVIDERS } from '../config/providers';

// MCP API response shapes
export interface McpContentItem { text?: string }
export interface MinimaxApiResponse { content?: McpContentItem[] }
export interface ZaiMcpResponse {
  error?: { message?: string };
  result?: { content?: McpContentItem[] } | string;
}

// Z.AI MCP tool names (available when user has any Z.AI API key)
export const ZAI_MCP_TOOLS = ['web_search', 'web_read', 'github_read'];

// Z.AI provider IDs that have MCP endpoints
export const ZAI_PROVIDER_IDS = ['z.ai', 'z.ai-cn'];

// MiniMax MCP tool names (available when user has any MiniMax API key)
export const MINIMAX_MCP_TOOLS = ['minimax_web_search', 'minimax_understand_image'];

// MiniMax provider IDs
export const MINIMAX_PROVIDER_IDS = ['minimax', 'minimax-cn'];

/**
 * Find a Z.AI provider that has an API key configured.
 * Returns the provider ID and API key, or null if none found.
 * Prefers the active provider if it's Z.AI, otherwise checks all Z.AI providers.
 */
export function getZaiMcpConfig(): { providerId: string; apiKey: string; endpoints: { webSearch: string; webReader: string; zread: string } } | null {
  // First check if active provider is Z.AI
  const activeProvider = config.get('provider');
  if (ZAI_PROVIDER_IDS.includes(activeProvider)) {
    const key = getApiKey(activeProvider);
    const endpoints = getProviderMcpEndpoints(activeProvider);
    if (key && endpoints?.webSearch && endpoints?.webReader && endpoints?.zread) {
      return { providerId: activeProvider, apiKey: key, endpoints: endpoints as { webSearch: string; webReader: string; zread: string } };
    }
  }

  // Otherwise check all Z.AI providers for a configured key
  for (const pid of ZAI_PROVIDER_IDS) {
    const key = getApiKey(pid);
    const endpoints = getProviderMcpEndpoints(pid);
    if (key && endpoints?.webSearch && endpoints?.webReader && endpoints?.zread) {
      return { providerId: pid, apiKey: key, endpoints: endpoints as { webSearch: string; webReader: string; zread: string } };
    }
  }

  return null;
}

/**
 * Check if Z.AI MCP tools are available (user has any Z.AI API key)
 */
export function hasZaiMcpAccess(): boolean {
  return getZaiMcpConfig() !== null;
}

/**
 * Find a MiniMax provider that has an API key configured.
 * Returns the base host URL and API key, or null if none found.
 */
export function getMinimaxMcpConfig(): { host: string; apiKey: string } | null {
  // First check if active provider is MiniMax
  const activeProvider = config.get('provider');
  if (MINIMAX_PROVIDER_IDS.includes(activeProvider)) {
    const key = getApiKey(activeProvider);
    if (key) {
      const provider = PROVIDERS[activeProvider];
      const baseUrl = provider?.protocols?.openai?.baseUrl;
      if (baseUrl) {
        const host = baseUrl.replace(/\/v1\/?$/, '');
        return { host, apiKey: key };
      }
    }
  }

  // Otherwise check all MiniMax providers
  for (const pid of MINIMAX_PROVIDER_IDS) {
    const key = getApiKey(pid);
    if (key) {
      const provider = PROVIDERS[pid];
      const baseUrl = provider?.protocols?.openai?.baseUrl;
      if (baseUrl) {
        const host = baseUrl.replace(/\/v1\/?$/, '');
        return { host, apiKey: key };
      }
    }
  }

  return null;
}

/**
 * Check if MiniMax MCP tools are available
 */
export function hasMinimaxMcpAccess(): boolean {
  return getMinimaxMcpConfig() !== null;
}

/**
 * Call a MiniMax MCP REST API endpoint
 */
export async function callMinimaxApi(host: string, path: string, body: Record<string, unknown>, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(`${host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`MiniMax API error ${response.status}: ${errorText || response.statusText}`);
    }

    const data = await response.json() as MinimaxApiResponse;

    if (data.content && Array.isArray(data.content)) {
      return data.content.map((c) => c.text || '').join('\n');
    }
    return JSON.stringify(data);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call a Z.AI MCP endpoint via JSON-RPC 2.0
 */
export async function callZaiMcp(endpoint: string, toolName: string, args: Record<string, unknown>, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now().toString(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`MCP error ${response.status}: ${errorText || response.statusText}`);
    }

    const data = await response.json() as ZaiMcpResponse;
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    const result = data.result;
    if (result && typeof result === 'object' && Array.isArray(result.content)) {
      return result.content.map((c) => c.text || '').join('\n');
    }
    return typeof result === 'string' ? result : JSON.stringify(result);
  } finally {
    clearTimeout(timeout);
  }
}
