// src/acp/serverHandlers.ts
//
// Session-lifecycle handlers for the ACP server, extracted from the
// `startAcpServer()` closure in `server.ts` into a factory so they can be
// unit-tested with a stub transport + sessions map.
//
// Each handler is a pure function of (msg, deps) → side-effect on deps.
// `deps` carries the transport (for respond/error/notify), the sessions map,
// and a handful of module-scope helpers (buildConfigOptions, AGENT_MODES).
// No handler reads process-level singletons directly — everything comes in
// through deps, which is what makes them testable.
//
// Not all handlers from server.ts live here yet. The big async ones
// (`handleSessionPrompt`) reach into MCP spawning, vision APIs, and the agent
// loop — those stay inside the closure until their dependencies are also
// lifted. The handlers in this file are the synchronous ones whose contract
// is "look up the session, mutate config or session state, acknowledge".

import type {
  JsonRpcRequest,
  SetSessionModeParams,
  SetSessionConfigOptionParams,
  ListSessionsParams, ListSessionsResult, AcpSessionInfo,
  DeleteSessionParams,
} from './protocol.js';
import { AGENT_MODES, buildConfigOptions } from './server.js';
import type { AcpSession } from './commands.js';
import {
  config, setProvider, setApiKey,
  listSessionsWithInfo, deleteSession as deleteSessionFile,
  type LanguageCode,
} from '../config/index.js';
import { disposeSession as disposeMcpSession } from '../utils/mcpRegistry.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Session record held by the running server. Lives in server.ts; re-exposed
 *  here so handler signatures can name it without re-declaring the shape. */
export interface AcpServerSession extends AcpSession {
  abortController: AbortController | null;
  currentModeId: string;
  titleSent: boolean;
  hadHistory: boolean;
}

/** Sessions map the server owns. */
export type SessionMap = Map<string, AcpServerSession>;

/** The transport surface handlers actually use. Mirrors `StdioTransport`'s
 *  public methods — stub this in tests. */
export interface AcpTransport {
  respond(id: string | number, result: unknown): void;
  error(id: string | number, code: number, message: string): void;
  notify(method: string, params: unknown): void;
}

/** Everything a handler needs. Constructed once in `startAcpServer()` and
 *  passed to every handler call. */
export interface AcpHandlerDeps {
  transport: AcpTransport;
  sessions: SessionMap;
}

// ─── session/set_mode ─────────────────────────────────────────────────────────

/**
 * Switch the agent confirmation mode for a session (auto = no prompts,
 * manual = prompt before destructive tools). Per-session only — the global
 * `agentConfirmation` config is deliberately NOT mutated, see the comment
 * in the body.
 */
export function handleSetMode(
  msg: JsonRpcRequest,
  deps: AcpHandlerDeps,
): void {
  const { transport, sessions } = deps;
  const { sessionId, modeId } = msg.params as SetSessionModeParams;
  const session = sessions.get(sessionId);
  if (!session) {
    transport.error(msg.id, -32602, `Unknown sessionId: ${sessionId}`);
    return;
  }

  const validMode = AGENT_MODES.availableModes.find(m => m.id === modeId);
  if (!validMode) {
    transport.error(msg.id, -32602, `Unknown modeId: ${modeId}`);
    return;
  }

  session.currentModeId = modeId;
  // Do NOT persist the global `agentConfirmation` config here. The ACP
  // permission gate is driven per-session by `session.currentModeId` (see the
  // onRequestPermission wiring in handleSessionPrompt). Writing it globally
  // would leak this session's mode into other processes — e.g. switching ACP
  // to 'auto' would silently disarm the TUI's confirmation gate. Mode stays
  // on the in-memory session object only.

  transport.respond(msg.id, {});

  // Notify Zed of the mode change
  transport.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'current_mode_update',
      currentModeId: modeId,
    },
  });
}

// ─── session/set_config_option ────────────────────────────────────────────────

/**
 * Apply a session-level config change coming from the ACP client (model picker,
 * language dropdown, confirmation toggles, login field). Mutates the global
 * config (these ARE meant to persist across sessions, unlike mode) and pushes
 * the refreshed config-option list back to the client.
 */
export function handleSetConfigOption(
  msg: JsonRpcRequest,
  deps: AcpHandlerDeps,
): void {
  const { transport, sessions } = deps;
  const { sessionId, configId, value } = msg.params as SetSessionConfigOptionParams;
  const session = sessions.get(sessionId);
  if (!session) {
    transport.error(msg.id, -32602, `Unknown sessionId: ${sessionId}`);
    return;
  }

  applyConfigOption(configId, value);

  transport.respond(msg.id, {});

  // Confirm the new value back to Zed so its UI state stays in sync
  transport.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: buildConfigOptions(),
    },
  });
}

/**
 * Pure-ish: apply a single config-option update to the global config.
 * Split out from the handler so it can be tested without a transport.
 *
 * - `model` / `provider`: switch the active provider + model.
 * - `customBaseUrl`: point the `custom` OpenAI-compatible provider at a
 *   self-hosted endpoint.
 * - `language`: response language code.
 * - `agentConfirm*` / `userProfile` / `autoLearnProfile`: boolean toggles,
 *   accept `true`/`false` or the strings `"true"`/`"false"` (Zed sends strings).
 * - `login`: special-case `"providerId:apiKey"` — sets the provider and writes
 *   the key to the keychain. The keychain write is async and fire-and-forget;
 *   a persistence failure only means the key isn't durable, it's still usable
 *   in-process via the cache.
 */
export function applyConfigOption(
  configId: string,
  value: unknown,
): void {
  if (configId === 'model' && typeof value === 'string') {
    // value is "providerId/modelId" — split and switch both
    const slashIdx = value.indexOf('/');
    if (slashIdx !== -1) {
      const providerId = value.slice(0, slashIdx);
      const modelId = value.slice(slashIdx + 1);
      setProvider(providerId);   // sets provider + defaultModel + protocol
      config.set('model', modelId);
    } else {
      config.set('model', value);
    }
  } else if (configId === 'provider' && typeof value === 'string') {
    // Switch provider without specifying a model — picks the provider's
    // default model + protocol. Used by editor clients that pin a provider
    // in their settings (e.g. the VS Code `codeep.provider` setting).
    setProvider(value);
  } else if (configId === 'customBaseUrl' && typeof value === 'string') {
    // Base URL for the `custom` (OpenAI-compatible) provider — lets editor
    // clients point Codeep at a self-hosted endpoint (vLLM/LiteLLM/LM Studio)
    // without hand-editing ~/.codeep/config.json.
    config.set('customBaseUrl', value);
  } else if (configId === 'language' && typeof value === 'string') {
    config.set('language', value as LanguageCode);
  } else if (
    configId === 'agentConfirmDeleteFile' ||
    configId === 'agentConfirmExecuteCommand' ||
    configId === 'agentConfirmWriteFile' ||
    configId === 'userProfile' ||
    configId === 'autoLearnProfile'
  ) {
    // Accept boolean or "true"/"false" string from Zed/VSCode
    const bool = value === true || value === 'true';
    config.set(configId, bool);
  } else if (configId === 'login' && typeof value === 'string') {
    // value is "providerId:apiKey"
    const colonIdx = value.indexOf(':');
    if (colonIdx !== -1) {
      const providerId = value.slice(0, colonIdx);
      const apiKey = value.slice(colonIdx + 1);
      if (providerId && apiKey) {
        setProvider(providerId);
        // Cache is updated synchronously inside setApiKey; the keychain write
        // resolves while the long-lived server runs. Swallow a persistence
        // failure here (secondary path) so it can't become an unhandled
        // rejection — the key still works for this session via the cache.
        setApiKey(apiKey, providerId).catch(() => { /* persistence failed; cached for session */ });
      }
    }
  }
}

// ─── session/list ─────────────────────────────────────────────────────────────

/**
 * List saved sessions (project-scoped first, then global fallback), deduped
 * by name and sorted newest-first.
 */
export function handleSessionList(
  msg: JsonRpcRequest,
  deps: AcpHandlerDeps,
): void {
  const { transport } = deps;
  const params = (msg.params ?? {}) as ListSessionsParams;

  // Collect local (project-scoped) sessions and global sessions, deduplicated by name
  const seen = new Set<string>();
  const merged = [
    ...listSessionsWithInfo(params.cwd),   // project-local first
    ...listSessionsWithInfo(),              // global fallback
  ].filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  // Sort newest first
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const acpSessions: AcpSessionInfo[] = merged.map(s => ({
    sessionId: s.name,
    cwd: params.cwd ?? '',
    title: s.title,
    updatedAt: s.createdAt,
  }));
  const result: ListSessionsResult = { sessions: acpSessions };
  transport.respond(msg.id, result);
}

// ─── session/delete ───────────────────────────────────────────────────────────

/**
 * Remove a session: drop it from the in-memory map, tear down any MCP child
 * processes attached to it, then delete the on-disk session file (project dir
 * first, global fallback).
 */
export function handleSessionDelete(
  msg: JsonRpcRequest,
  deps: AcpHandlerDeps,
): void {
  const { transport, sessions } = deps;
  const { sessionId, cwd } = (msg.params ?? {}) as DeleteSessionParams;
  // Remove from in-memory sessions map if present
  sessions.delete(sessionId);
  // Tear down any MCP server processes attached to this session — leaks
  // children otherwise. Fire-and-forget; client doesn't wait on stop().
  disposeMcpSession(sessionId).catch(() => { /* logged inside */ });
  // Try project dir first, then global
  const deleted = deleteSessionFile(sessionId, cwd || undefined);
  if (!deleted && cwd) deleteSessionFile(sessionId);
  transport.respond(msg.id, {});
}

// ─── session/list_providers ───────────────────────────────────────────────────
// Canonical provider list for ACP clients (Codeep VS Code extension etc.).
// Lets the client populate its API-key dropdowns and group labels from one
// source instead of carrying its own hardcoded copy. Keep this stable —
// adding new fields is fine, removing/renaming would break existing clients.

import { PROVIDERS } from '../config/providers.js';

/**
 * Pure shape: map the PROVIDERS table into the serialisable form ACP clients
 * expect (id/name/groupLabel/models/dynamicModels/…). No transport side-effect.
 * Exported so the handler is a one-liner and the shape can be unit-tested.
 */
export function buildProviderList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    description: p.description,
    groupLabel: p.groupLabel ?? p.name,
    hint: p.hint ?? p.description,
    requiresKey: !p.noApiKey,
    subscribeUrl: p.subscribeUrl,
    // Model metadata so ACP clients (e.g. the VS Code model picker) can
    // offer a provider → model selector without hardcoding a catalog.
    // `dynamicModels` flags providers whose model list is open-ended
    // (OpenRouter, ModelScope, Ollama, custom endpoints) — clients should let the
    // user type a model id rather than only pick from `models`.
    models: p.models.map((m) => ({ id: m.id, name: m.name })),
    defaultModel: p.defaultModel,
    dynamicModels: p.dynamicModels ?? false,
  }));
}

/** session/list_providers handler — delegate to the pure builder + respond. */
export function handleListProviders(
  msg: JsonRpcRequest,
  deps: AcpHandlerDeps,
): void {
  deps.transport.respond(msg.id, { providers: buildProviderList() });
}
