/**
 * On-disk MCP server config — the `mcpServers` array that ACP clients
 * usually pass over the wire, but loaded straight from JSON so direct CLI
 * users (and our VS Code extension) don't have to roll their own config UI.
 *
 * Lookup precedence:
 *   1. `<workspace>/.codeep/mcp_servers.json` (project — committed with repo)
 *   2. `~/.codeep/mcp_servers.json`           (global — user's machine)
 * Project entries shadow global entries with the same server name.
 *
 * File format mirrors what Claude Code accepts so existing user configs can
 * be reused verbatim:
 *
 *   {
 *     "mcpServers": {
 *       "fs": {
 *         "command": "npx",
 *         "args": ["@modelcontextprotocol/server-filesystem", "/some/path"],
 *         "env": { "READ_ONLY": "1" }
 *       },
 *       "gh": { ... }
 *     }
 *   }
 *
 * A flat array form (`{"mcpServers": [{...}, ...]}`) is also accepted because
 * that's the shape ACP passes over JSON-RPC.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { config } from '../config/index.js';
import type { McpServer } from '../acp/protocol.js';

const PROJECT_CONFIG_PATH = '.codeep/mcp_servers.json';
const PROJECT_DOTMCP_PATH = '.mcp.json';
const GLOBAL_CONFIG_PATH = '.codeep/mcp_servers.json';

export interface McpConfigFile {
  /** Either the named-map form (Claude Code style) or a flat array (ACP style). */
  mcpServers?: Record<string, Omit<McpServer, 'name'>> | McpServer[];
}

/**
 * Expand `${VAR}` / `${VAR:-default}` references from the process env —
 * the same substitution Claude Code applies to `.mcp.json`, so a shared
 * config with `"env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}` works verbatim.
 *
 * Unset vars WITHOUT a default keep the literal `${VAR}` text: silently
 * substituting '' would hide the misconfiguration, and the literal at
 * least shows up as-is in error messages / `/mcp` output. (Previously the
 * literal also SHADOWED a real env var of the same name at spawn time —
 * expansion when the var IS set fixes that.)
 */
function expandEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, def?: string) => {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined) return fromEnv;
    if (def !== undefined) return def;
    return match;
  });
}

function expandRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = typeof v === 'string' ? expandEnvRefs(v) : v;
  return out;
}

/** Apply ${VAR} expansion to every string field of a server entry. */
function expandServer(s: McpServer): McpServer {
  return {
    ...s,
    command: typeof s.command === 'string' ? expandEnvRefs(s.command) : s.command,
    args: Array.isArray(s.args) ? s.args.map(a => expandEnvRefs(a)) : s.args,
    env: expandRecord(s.env),
    url: typeof s.url === 'string' ? expandEnvRefs(s.url) : s.url,
    headers: expandRecord(s.headers),
  };
}

function parseEntries(raw: string, source: string): McpServer[] {
  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(raw) as McpConfigFile;
  } catch {
    // A broken config file shouldn't kill the agent startup — just warn
    // and move on. The user will notice via /mcp showing no servers.
    process.stderr.write(`[codeep-mcp] Failed to parse ${source}: invalid JSON\n`);
    return [];
  }
  const servers = parsed.mcpServers;
  if (!servers) return [];

  if (Array.isArray(servers)) {
    // Defensively filter — any entry needs name + either command or url.
    return servers
      .filter(s => s && typeof s.name === 'string' && (typeof s.command === 'string' || typeof s.url === 'string'))
      .map(expandServer);
  }

  return Object.entries(servers).flatMap(([name, cfg]) => {
    if (!cfg) return [];
    // Either `command` (stdio) or `url` (HTTP) — at least one required.
    const hasStdio = typeof cfg.command === 'string';
    const hasHttp = typeof (cfg as { url?: unknown }).url === 'string';
    if (!hasStdio && !hasHttp) return [];
    return [expandServer({
      name,
      command: hasStdio ? cfg.command : undefined,
      args: Array.isArray(cfg.args) ? cfg.args.filter(a => typeof a === 'string') : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env as Record<string, string> : undefined,
      url: hasHttp ? (cfg as { url: string }).url : undefined,
      headers: (cfg as { headers?: unknown }).headers && typeof (cfg as { headers: unknown }).headers === 'object'
        ? (cfg as { headers: Record<string, string> }).headers
        : undefined,
    })];
  });
}

function loadFromFile(path: string): McpServer[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseEntries(raw, path);
  } catch {
    return [];
  }
}

/**
 * Load MCP server definitions for a workspace. Project entries shadow
 * global entries with the same server name. Workspace-less calls
 * (TUI without project) return only the global config.
 *
 * Sources read (highest precedence first on name collisions):
 *   1. <workspace>/.codeep/mcp_servers.json  (Codeep-native project file)
 *   2. <workspace>/.mcp.json                 (cross-tool standard — same
 *      shape Claude Code/Cursor/Kilo Code read, so users can keep one MCP
 *      config for their whole fleet)
 *   3. ~/.codeep/mcp_servers.json            (global — user's machine)
 */
export function loadMcpServerConfig(workspaceRoot?: string): McpServer[] {
  const globalServers = loadFromFile(join(homedir(), GLOBAL_CONFIG_PATH));
  const projectServers = workspaceRoot
    ? loadFromFile(join(workspaceRoot, PROJECT_CONFIG_PATH))
    : [];
  const dotMcpServers = workspaceRoot
    ? loadFromFile(join(workspaceRoot, PROJECT_DOTMCP_PATH))
    : [];

  // Higher-precedence sources win on name collisions: project (Codeep-native)
  // beats .mcp.json beats global.
  const byName = new Map<string, McpServer>();
  for (const s of globalServers) byName.set(s.name, s);
  for (const s of dotMcpServers) byName.set(s.name, s);
  for (const s of projectServers) byName.set(s.name, s);
  return [...byName.values()];
}

/**
 * Same sources as `loadMcpServerConfig`, but split by trust domain:
 * `global` (~/.codeep — the user's own machine-wide file) vs `workspace`
 * (files that arrive WITH a repo: `.codeep/mcp_servers.json` + `.mcp.json`).
 *
 * Workspace entries are attacker-controllable — anyone who clones a repo
 * containing one of these files would otherwise spawn arbitrary commands
 * at startup — so callers must gate them behind `isWorkspaceMcpTrusted`
 * before spawning (mirrors the `trustedHookProjects` gate for hooks).
 * On name collisions a workspace entry shadows a global one, matching
 * the merged loader's precedence.
 */
export function loadMcpServerConfigSplit(workspaceRoot?: string): { global: McpServer[]; workspace: McpServer[] } {
  const globalServers = loadFromFile(join(homedir(), GLOBAL_CONFIG_PATH));
  if (!workspaceRoot) return { global: globalServers, workspace: [] };

  const projectServers = loadFromFile(join(workspaceRoot, PROJECT_CONFIG_PATH));
  const dotMcpServers = loadFromFile(join(workspaceRoot, PROJECT_DOTMCP_PATH));
  const byName = new Map<string, McpServer>();
  for (const s of dotMcpServers) byName.set(s.name, s);
  for (const s of projectServers) byName.set(s.name, s);
  const workspace = [...byName.values()];
  const workspaceNames = new Set(workspace.map(s => s.name));
  return {
    global: globalServers.filter(s => !workspaceNames.has(s.name)),
    workspace,
  };
}

// ── Workspace MCP trust ────────────────────────────────────────────────────────
// Workspace-sourced MCP servers spawn child processes with repo-author-chosen
// command/args/env, so they need a one-time per-workspace approval — the same
// model as `trustedHookProjects` for hooks. Global (~/.codeep) servers are the
// user's own config and never need approval.

export function isWorkspaceMcpTrusted(workspaceRoot: string): boolean {
  const cur = (config.get('trustedMcpProjects') as string[] | undefined) ?? [];
  return cur.includes(workspaceRoot);
}

export function trustWorkspaceMcp(workspaceRoot: string): void {
  const cur = (config.get('trustedMcpProjects') as string[] | undefined) ?? [];
  if (!cur.includes(workspaceRoot)) config.set('trustedMcpProjects', [...cur, workspaceRoot]);
}

export function untrustWorkspaceMcp(workspaceRoot: string): void {
  const cur = (config.get('trustedMcpProjects') as string[] | undefined) ?? [];
  config.set('trustedMcpProjects', cur.filter((p) => p !== workspaceRoot));
}

/**
 * Merge two server lists: ACP-provided + on-disk. ACP wins on collisions
 * — the client knows its own config, so a Zed-passed server overrides a
 * project file entry of the same name (and we never have to teach Zed to
 * "skip" file-based ones).
 */
export function mergeMcpServers(fromConfig: McpServer[], fromAcp: McpServer[] | undefined): McpServer[] {
  const byName = new Map<string, McpServer>();
  for (const s of fromConfig) byName.set(s.name, s);
  for (const s of fromAcp ?? []) byName.set(s.name, s);
  return [...byName.values()];
}

/**
 * Add or replace a server entry in the project config file. Used by the
 * interactive `/mcp add` command. Project file is created if missing.
 */
export function addProjectMcpServer(workspaceRoot: string, server: McpServer): void {
  const path = join(workspaceRoot, PROJECT_CONFIG_PATH);
  let parsed: McpConfigFile = { mcpServers: {} };
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as McpConfigFile;
    } catch {
      // Overwrite a broken file — user can recover from git if they care.
      parsed = { mcpServers: {} };
    }
  }
  // Normalize to map form for the on-disk file. Easier to edit by hand.
  let map: Record<string, Omit<McpServer, 'name'>>;
  if (Array.isArray(parsed.mcpServers)) {
    map = {};
    for (const s of parsed.mcpServers) {
      const { name: n, ...rest } = s;
      map[n] = rest;
    }
  } else {
    map = parsed.mcpServers ?? {};
  }
  const { name, ...rest } = server;
  map[name] = rest;
  parsed.mcpServers = map;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n');
}

/**
 * Remove a server entry from the project config file. Returns true if a
 * server with that name was actually removed.
 */
export function removeProjectMcpServer(workspaceRoot: string, name: string): boolean {
  const path = join(workspaceRoot, PROJECT_CONFIG_PATH);
  if (!existsSync(path)) return false;
  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as McpConfigFile;
  } catch {
    return false;
  }
  if (Array.isArray(parsed.mcpServers)) {
    const before = parsed.mcpServers.length;
    parsed.mcpServers = parsed.mcpServers.filter(s => s.name !== name);
    if (parsed.mcpServers.length === before) return false;
  } else if (parsed.mcpServers && parsed.mcpServers[name]) {
    delete parsed.mcpServers[name];
  } else {
    return false;
  }
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n');
  return true;
}
