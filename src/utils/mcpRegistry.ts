/**
 * Per-session registry of MCP servers.
 *
 * `acp/server.ts handleSessionNew/Load/Resume` receives an optional
 * `mcpServers: McpServer[]` from the ACP client. We spawn each one via
 * `McpClient`, list its tools, and surface them under a flat namespace so
 * the agent can call them like any built-in tool.
 *
 * Naming: tools are surfaced as `<serverName>__<toolName>` to avoid
 * collisions across servers and with built-in agent tools. Underscores are
 * legal in MCP tool names; `__` is rare enough in practice to serve as a
 * delimiter without escaping.
 */

import { McpClient, McpTool, SamplingCreateMessageParams, SamplingCreateMessageResult } from './mcpClient.js';
import type { McpServer } from '../acp/protocol.js';

const NAMESPACE_DELIM = '__';

/**
 * Virtual-tool suffixes for the resource/prompt wrappers we generate per
 * server. Keep these in lockstep with the dispatch switch in
 * toolExecution.ts — adding a new wrapper requires both ends.
 */
export const VIRTUAL_TOOL_SUFFIXES = {
  resourceList: 'resource_list',
  resourceRead: 'resource_read',
  promptList:   'prompt_list',
  promptGet:    'prompt_get',
} as const;

/** Map of ACP session id → list of clients started for that session. */
const sessionClients = new Map<string, McpClient[]>();

/**
 * In-progress registration promises. `callSessionTool` awaits these so a
 * tool call that lands between session/new and "all servers spawned" waits
 * for registration to finish instead of erroring with "no servers".
 */
const registrationInProgress = new Map<string, Promise<void>>();

/** Per-session spawn errors, kept around so `/mcp` can surface them. */
const sessionErrors = new Map<string, { server: string; error: string }[]>();

/**
 * Per-session catalog dirty flags. The agent loop polls and clears these
 * between iterations so a `tools/list_changed` notification mid-run causes
 * a fresh re-list before the next tool dispatch.
 */
const sessionCatalogDirty = new Map<string, Set<'tools' | 'resources' | 'prompts'>>();

export interface RegisteredTool {
  /** Prefixed name as exposed to the agent (`server__tool`). */
  agentName: string;
  /** Original tool name on the server. */
  toolName: string;
  serverName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Spawn the given servers and discover their tools. Failures on individual
 * servers are reported in the result but don't abort the whole registration
 * (one broken server shouldn't kill the rest).
 *
 * Idempotent: calling twice for the same sessionId disposes the prior set
 * first.
 */
export async function registerSessionServers(
  sessionId: string,
  servers: McpServer[],
  opts: {
    workspaceRoot?: string;
    /**
     * Host LLM callback wired to the `sampling/createMessage` server request.
     * Receives the originating server name so the host can rate-limit /
     * budget-cap per server.
     */
    onSamplingRequest?: (
      params: SamplingCreateMessageParams,
      serverName: string,
    ) => Promise<SamplingCreateMessageResult>;
  } = {},
): Promise<{ registered: RegisteredTool[]; errors: { server: string; error: string }[] }> {
  await disposeSession(sessionId);
  if (servers.length === 0) {
    sessionClients.set(sessionId, []);
    sessionErrors.set(sessionId, []);
    return { registered: [], errors: [] };
  }

  // Build the registration as a Promise so concurrent `callSessionTool`
  // calls can `awaitSessionReady` instead of seeing an empty registry.
  const registrationPromise = (async () => {
    const clients: McpClient[] = [];
    const registered: RegisteredTool[] = [];
    const errors: { server: string; error: string }[] = [];

    // Start in parallel — server startup tends to dominate session/new
    // latency, and the work is independent per server.
    await Promise.all(servers.map(async (cfg) => {
      const client = new McpClient(cfg, {
        workspaceRoot: opts.workspaceRoot,
        onSamplingRequest: opts.onSamplingRequest
          ? (params) => opts.onSamplingRequest!(params, cfg.name)
          : undefined,
      });
      // Catalog-changed signals from the server flip a dirty bit the agent
      // loop reads between iterations. Plus restart already invalidates
      // tools cache on the client side — we flip the same bit so the agent
      // re-fetches even though the registry doesn't directly know about
      // the restart.
      client.onRestart = () => {
        const dirty = sessionCatalogDirty.get(sessionId) ?? new Set();
        dirty.add('tools'); dirty.add('resources'); dirty.add('prompts');
        sessionCatalogDirty.set(sessionId, dirty);
      };
      client.onCatalogChanged = (kind) => {
        const dirty = sessionCatalogDirty.get(sessionId) ?? new Set();
        dirty.add(kind);
        sessionCatalogDirty.set(sessionId, dirty);
      };
      client.onGaveUp = (reason: string) => {
        const list = sessionErrors.get(sessionId) ?? [];
        list.push({ server: cfg.name, error: `gave up auto-restart (${reason})` });
        sessionErrors.set(sessionId, list);
      };
      try {
        await client.start();
        const tools = await client.listTools();
        for (const t of tools) {
          registered.push(toRegistered(cfg.name, t));
        }
        clients.push(client);
      } catch (err) {
        errors.push({ server: cfg.name, error: (err as Error).message });
        await client.stop().catch(() => { /* ignore */ });
      }
    }));

    sessionClients.set(sessionId, clients);
    sessionErrors.set(sessionId, errors);
    return { registered, errors };
  })();

  registrationInProgress.set(sessionId, registrationPromise.then(() => {}, () => {}));
  try {
    return await registrationPromise;
  } finally {
    registrationInProgress.delete(sessionId);
  }
}

/**
 * Wait for any in-flight `registerSessionServers` for this session to
 * finish. No-op once registration has completed. Lets `callSessionTool`
 * be tolerant of the race between session/new returning and the user
 * sending their first prompt.
 */
export async function awaitSessionReady(sessionId: string): Promise<void> {
  const pending = registrationInProgress.get(sessionId);
  if (pending) await pending;
}

/** Return spawn errors recorded for a session, for the /mcp inspector. */
export function getSessionRegistrationErrors(sessionId: string): { server: string; error: string }[] {
  return sessionErrors.get(sessionId) ?? [];
}

/**
 * Atomically read + clear the catalog-dirty flags for a session.
 * Called by the agent loop between iterations: if any flag is set,
 * the relevant cached lists (tools / resources / prompts) should be
 * re-fetched before the next dispatch. Returns the set of dirty kinds.
 */
export function consumeSessionCatalogChanges(sessionId: string): Set<'tools' | 'resources' | 'prompts'> {
  const dirty = sessionCatalogDirty.get(sessionId);
  if (!dirty || dirty.size === 0) return new Set();
  sessionCatalogDirty.delete(sessionId);
  // Also blow away client-side tool caches so the next listTools() actually
  // re-queries the server (the per-client cache is what
  // `getSessionTools` reads from).
  if (dirty.has('tools')) {
    const clients = sessionClients.get(sessionId);
    if (clients) {
      for (const c of clients) {
        // Reach in to clear the cache — purposely loose typing so we don't
        // export a "clear cache" method that callers might mis-use.
        (c as unknown as { toolsCache: McpTool[] | null }).toolsCache = null;
      }
    }
  }
  return dirty;
}

function toRegistered(serverName: string, tool: McpTool): RegisteredTool {
  return {
    agentName: `${serverName}${NAMESPACE_DELIM}${tool.name}`,
    toolName: tool.name,
    serverName,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Return all tools registered for a session (built from cached server tool lists). */
export async function getSessionTools(sessionId: string): Promise<RegisteredTool[]> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) return [];
  const all: RegisteredTool[] = [];
  for (const client of clients) {
    try {
      const tools = await client.listTools();
      for (const t of tools) all.push(toRegistered(client.server.name, t));
    } catch {
      // Skip a flaky server rather than fail the entire list.
    }
  }
  return all;
}

/**
 * Build the set of virtual tools that wrap the resource/prompt primitives
 * for every server in the session. The agent calls these like normal
 * `<server>__<tool>` entries; toolExecution.ts dispatches them through
 * `callSessionResourceTool` below.
 *
 * We only emit a wrapper when the server actually exposes resources or
 * prompts (probed via `listResources`/`listPrompts`) — no point teaching
 * the model about a `read_resource` tool that always returns "no such
 * resource".
 */
export async function getSessionVirtualTools(sessionId: string): Promise<RegisteredTool[]> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) return [];
  const out: RegisteredTool[] = [];

  for (const client of clients) {
    const serverName = client.server.name;
    // Resources
    try {
      const resources = await client.listResources();
      if (resources.length > 0) {
        out.push({
          agentName: `${serverName}${NAMESPACE_DELIM}${VIRTUAL_TOOL_SUFFIXES.resourceList}`,
          toolName: VIRTUAL_TOOL_SUFFIXES.resourceList,
          serverName,
          description: `List MCP resources exposed by the "${serverName}" server. Returns the URIs you can pass to ${serverName}__${VIRTUAL_TOOL_SUFFIXES.resourceRead}.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        });
        out.push({
          agentName: `${serverName}${NAMESPACE_DELIM}${VIRTUAL_TOOL_SUFFIXES.resourceRead}`,
          toolName: VIRTUAL_TOOL_SUFFIXES.resourceRead,
          serverName,
          description: `Read the contents of an MCP resource from the "${serverName}" server by its URI.`,
          inputSchema: {
            type: 'object',
            properties: { uri: { type: 'string', description: 'Resource URI (use resource_list to discover available URIs).' } },
            required: ['uri'],
          },
        });
      }
    } catch { /* server doesn't support resources — skip */ }

    // Prompts
    try {
      const prompts = await client.listPrompts();
      if (prompts.length > 0) {
        out.push({
          agentName: `${serverName}${NAMESPACE_DELIM}${VIRTUAL_TOOL_SUFFIXES.promptList}`,
          toolName: VIRTUAL_TOOL_SUFFIXES.promptList,
          serverName,
          description: `List prompt templates exposed by the "${serverName}" MCP server.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        });
        out.push({
          agentName: `${serverName}${NAMESPACE_DELIM}${VIRTUAL_TOOL_SUFFIXES.promptGet}`,
          toolName: VIRTUAL_TOOL_SUFFIXES.promptGet,
          serverName,
          description: `Materialise an MCP prompt template from the "${serverName}" server.`,
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Prompt name (use prompt_list to discover).' },
              arguments: { type: 'object', additionalProperties: true, description: 'Key/value arguments per the prompt template.' },
            },
            required: ['name'],
          },
        });
      }
    } catch { /* server doesn't support prompts — skip */ }
  }

  return out;
}

/**
 * Dispatch a virtual MCP tool (resource_list, resource_read, prompt_list,
 * prompt_get) and return a JSON-serialised string the agent can consume.
 * Throws if the tool name doesn't match a virtual wrapper.
 */
export async function callSessionVirtualTool(
  sessionId: string,
  agentName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) throw new Error(`No MCP servers registered for session ${sessionId}`);

  const idx = agentName.indexOf(NAMESPACE_DELIM);
  if (idx < 0) throw new Error(`"${agentName}" is not a namespaced MCP tool`);
  const serverName = agentName.slice(0, idx);
  const suffix = agentName.slice(idx + NAMESPACE_DELIM.length);
  const client = clients.find(c => c.server.name === serverName);
  if (!client) throw new Error(`No MCP server named "${serverName}" in this session`);

  if (suffix === VIRTUAL_TOOL_SUFFIXES.resourceList) {
    const resources = await client.listResources();
    return JSON.stringify(resources, null, 2);
  }
  if (suffix === VIRTUAL_TOOL_SUFFIXES.resourceRead) {
    const uri = String(args.uri ?? '');
    if (!uri) throw new Error('resource_read requires a `uri` argument');
    const contents = await client.readResource(uri);
    // Inline text content directly; surface blob with a placeholder so the
    // model knows there was binary data without us blowing up the context.
    return contents.map(c => c.text ?? `[binary ${c.mimeType ?? 'blob'}, ${c.blob?.length ?? 0} chars]`).join('\n\n');
  }
  if (suffix === VIRTUAL_TOOL_SUFFIXES.promptList) {
    const prompts = await client.listPrompts();
    return JSON.stringify(prompts, null, 2);
  }
  if (suffix === VIRTUAL_TOOL_SUFFIXES.promptGet) {
    const name = String(args.name ?? '');
    if (!name) throw new Error('prompt_get requires a `name` argument');
    const promptArgs = (args.arguments && typeof args.arguments === 'object') ? args.arguments as Record<string, unknown> : {};
    const result = await client.getPrompt(name, promptArgs);
    return JSON.stringify(result, null, 2);
  }
  throw new Error(`Unknown virtual MCP tool suffix: ${suffix}`);
}

/** Return true if a tool name matches one of the four virtual wrappers. */
export function isVirtualMcpToolName(name: string): boolean {
  const idx = name.indexOf(NAMESPACE_DELIM);
  if (idx < 0) return false;
  const suffix = name.slice(idx + NAMESPACE_DELIM.length);
  return (Object.values(VIRTUAL_TOOL_SUFFIXES) as readonly string[]).includes(suffix);
}

/** Return resources advertised by all session servers, grouped by server. */
export async function getSessionResources(sessionId: string): Promise<{ serverName: string; resources: import('./mcpClient.js').McpResource[] }[]> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) return [];
  const out: { serverName: string; resources: import('./mcpClient.js').McpResource[] }[] = [];
  for (const client of clients) {
    try {
      const resources = await client.listResources();
      if (resources.length > 0) out.push({ serverName: client.server.name, resources });
    } catch {
      // Per-server failures should not poison the whole list.
    }
  }
  return out;
}

/** Read a resource URI from any session server that advertises it. */
export async function readSessionResource(sessionId: string, uri: string): Promise<import('./mcpClient.js').McpResourceContent[]> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) throw new Error(`No MCP servers registered for session ${sessionId}`);
  // Try each server in registration order; first success wins. Most URI
  // schemes are server-specific so this rarely needs more than one try.
  let lastError: Error | null = null;
  for (const client of clients) {
    try {
      const contents = await client.readResource(uri);
      if (contents.length > 0) return contents;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error(`No MCP server returned content for ${uri}`);
}

/** Return prompts advertised by all session servers, grouped by server. */
export async function getSessionPrompts(sessionId: string): Promise<{ serverName: string; prompts: import('./mcpClient.js').McpPrompt[] }[]> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) return [];
  const out: { serverName: string; prompts: import('./mcpClient.js').McpPrompt[] }[] = [];
  for (const client of clients) {
    try {
      const prompts = await client.listPrompts();
      if (prompts.length > 0) out.push({ serverName: client.server.name, prompts });
    } catch {
      // Skip servers that don't expose prompts.
    }
  }
  return out;
}

/** Resolve a `<server>__<name>` prompt reference, returning the materialised messages. */
export async function getSessionPrompt(
  sessionId: string,
  serverName: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ description?: string; messages: import('./mcpClient.js').McpPromptMessage[] }> {
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) throw new Error(`No MCP servers registered for session ${sessionId}`);
  const client = clients.find(c => c.server.name === serverName);
  if (!client) throw new Error(`No MCP server named "${serverName}" in this session`);
  return client.getPrompt(name, args);
}

/** Forward a tool call to the right MCP server. Returns the tool's text output. */
export async function callSessionTool(
  sessionId: string,
  agentName: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Wait for any pending session registration before checking the registry.
  // Avoids the "spawn race" where the agent fires a tool call between
  // session/new returning and the MCP server child processes finishing
  // their initialize handshake.
  await awaitSessionReady(sessionId);

  const clients = sessionClients.get(sessionId);
  if (!clients?.length) throw new Error(`No MCP servers registered for session ${sessionId}`);

  const idx = agentName.indexOf(NAMESPACE_DELIM);
  if (idx < 0) throw new Error(`Tool name "${agentName}" is not in the expected "server__tool" form`);
  const serverName = agentName.slice(0, idx);
  const toolName = agentName.slice(idx + NAMESPACE_DELIM.length);

  const client = clients.find(c => c.server.name === serverName);
  if (!client) throw new Error(`No MCP server named "${serverName}" in this session`);
  return client.callTool(toolName, args);
}

/** True when an agent tool name looks like an MCP-prefixed tool. */
export function isMcpToolName(name: string): boolean {
  return name.includes(NAMESPACE_DELIM);
}

/** Stop all MCP clients for a session and drop the registry entry. */
export async function disposeSession(sessionId: string): Promise<void> {
  sessionErrors.delete(sessionId);
  sessionCatalogDirty.delete(sessionId);
  const clients = sessionClients.get(sessionId);
  if (!clients?.length) {
    sessionClients.delete(sessionId);
    return;
  }
  await Promise.all(clients.map(c => c.stop().catch(() => { /* swallow */ })));
  sessionClients.delete(sessionId);
}

/**
 * Tear down every active MCP session. Wired up as a SIGINT/SIGTERM handler
 * in `acp/server.ts` so killing the CLI doesn't leave orphan child processes.
 */
export async function disposeAllSessions(): Promise<void> {
  const ids = [...sessionClients.keys()];
  await Promise.all(ids.map(id => disposeSession(id)));
}

/** For tests / debugging — how many sessions have active MCP clients. */
export function sessionCount(): number {
  return sessionClients.size;
}
