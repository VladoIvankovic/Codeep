/**
 * Codeep Cloud — CLI authentication and stats reporting.
 *
 * Handles:
 *  - `codeep account` login flow (device-code style, browser + poll)
 *  - Sending usage stats to codeep.dev/api/stats after each agent run
 */

import { randomBytes, createHash } from 'crypto';
import { spawn } from 'child_process';
import { getGithubId, getSyncToken, setGithubAccount, setSyncToken, setApiKey, getDeviceId } from '../config/index.js';
import { hostname } from 'os';

const API_BASE = 'https://codeep.dev';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Browser helper ───────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // ignore — user can open manually
  }
}

// ─── Account login flow ───────────────────────────────────────────────────────

/**
 * Full `codeep account` flow.
 * Registers a code, opens browser, polls until authorized.
 * Saves github_id + username to config on success.
 */
export async function runAccountFlow(): Promise<void> {
  const code = randomBytes(24).toString('hex');
  const deviceId = getDeviceId();
  const deviceHostname = hostname();

  // Register the code on the server
  let registerOk = false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/cli`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    registerOk = res.ok;
  } catch {
    // fall through, will show manual URL anyway
  }

  if (!registerOk) {
    console.error('\n  Could not reach codeep.dev. Check your internet connection.\n');
    return;
  }

  const url = `${API_BASE}/auth/cli?code=${code}`;
  console.log('\n  Opening browser...');
  console.log(`  ${url}\n`);
  console.log('  If the browser did not open, paste the URL above manually.\n');
  openBrowser(url);

  // Poll for authorization
  process.stdout.write('  Waiting for GitHub login');
  const start = Date.now();
  let authorized = false;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    process.stdout.write('.');

    try {
      const res = await fetch(`${API_BASE}/api/auth/cli?code=${code}`);
      if (!res.ok) continue;

      const data = await res.json() as { status: string; github_id?: string; username?: string; sync_token?: string };

      if (data.status === 'authorized' && data.github_id) {
        setGithubAccount(data.github_id, data.username ?? '');
        if (data.sync_token) setSyncToken(data.sync_token);
        // Register device info
        try {
          await fetch(`${API_BASE}/api/auth/cli/device`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sync-token': data.sync_token ?? '' },
            body: JSON.stringify({ deviceId, hostname: deviceHostname }),
          });
        } catch { /* ignore */ }
        console.log(`\n\n  Connected as @${data.username ?? data.github_id}\n`);
        authorized = true;
        break;
      }
    } catch {
      // network hiccup — keep polling
    }
  }

  if (!authorized) {
    console.log('\n\n  Timed out. Please run \'codeep account\' again.\n');
  }
}

// ─── Stats reporting ──────────────────────────────────────────────────────────

export interface StatsPayload {
  model: string;
  provider: string;
  command?: string;
  sessionId: string;
  sessionName?: string;
  messageCount?: number;
  cliVersion: string;
  projectName?: string;
  projectId?: string;
  language?: string;
  isGit?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

/**
 * Generate a stable project ID from the project root path.
 */
export function generateProjectId(projectRoot: string): string {
  // Normalize: remove trailing slash, resolve to real path format
  const normalized = projectRoot.replace(/\/+$/, '').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Fire-and-forget stats report. Only sends if github_id is configured.
 * Retries up to 2 times on network errors or 5xx responses.
 */
export function reportStats(payload: StatsPayload): void {
  const githubId = getGithubId();
  if (!githubId) return; // not linked, skip silently

  fetchWithRetry(`${API_BASE}/api/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, githubId, isGit: payload.isGit ?? false }),
  }).catch(() => {});
}

export async function reportStatsAsync(payload: StatsPayload): Promise<void> {
  const githubId = getGithubId();
  if (!githubId) return;

  await fetchWithRetry(`${API_BASE}/api/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, githubId, isGit: payload.isGit ?? false }),
  });
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface CloudTask {
  id: number;
  project_name: string;
  title: string;
  description: string | null;
  type: 'bug' | 'feature' | 'task';
  status: 'pending' | 'done';
}

/**
 * Fetch pending tasks from codeep.dev for the current user.
 * Returns null if not linked or network error.
 */
export async function fetchTasks(projectName?: string, projectId?: string): Promise<CloudTask[] | null> {
  const syncToken = getSyncToken();
  if (!syncToken) return null;

  const url = new URL(`${API_BASE}/api/tasks`);
  if (projectId) url.searchParams.set('projectId', projectId);
  else if (projectName) url.searchParams.set('project', projectName);

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-sync-token': syncToken },
    });
    if (!res.ok) return null;
    const data = await res.json() as { ok: boolean; tasks: CloudTask[] };
    return data.ok ? data.tasks : null;
  } catch {
    return null;
  }
}

/**
 * Mark a task as done by ID.
 * Returns true on success, false if not linked or network error.
 */
export async function markTaskDone(taskId: number): Promise<boolean> {
  const syncToken = getSyncToken();
  if (!syncToken) return false;

  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
      body: JSON.stringify({ id: taskId, status: 'done' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── API key sync ─────────────────────────────────────────────────────────────

/**
 * Pull API keys from codeep.dev and save them to local config.
 * Returns the number of keys synced, or null on error.
 */
export async function pullKeys(): Promise<Record<string, string> | null> {
  const syncToken = getSyncToken();
  if (!syncToken) return null;

  const res = await fetchWithRetry(`${API_BASE}/api/keys`, {
    headers: { 'x-sync-token': syncToken },
  });
  if (!res?.ok) return null;
  try {
    const data = await res.json() as { ok: boolean; keys: Record<string, string> };
    return data.ok ? data.keys : null;
  } catch {
    return null;
  }
}

/**
 * Push local API keys to codeep.dev.
 * Returns true on success.
 */
export async function pushKeys(keys: Record<string, string>): Promise<boolean> {
  const syncToken = getSyncToken();
  if (!syncToken) return false;

  const res = await fetchWithRetry(`${API_BASE}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ keys }),
  });
  return res?.ok ?? false;
}

// ─── Portable personal config sync (personalities + commands) ──────────────────
//
// Both are name → raw-.md-body bundles stored in a global dir
// (~/.codeep/personalities, ~/.codeep/commands). The sync is bidirectional
// and merge-based: pull writes any remote file not present locally; push
// sends every local file. Last-write-wins on the server via upsert. We
// never delete locally on pull — additive only, so a sync can't nuke
// work you haven't pushed.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function globalDir(kind: 'personalities' | 'commands'): string {
  return join(homedir(), '.codeep', kind);
}

/** Read every <name>.md in a global config dir into a { name → body } map. */
function readFileBundle(kind: 'personalities' | 'commands'): Record<string, string> {
  const dir = globalDir(kind);
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64) continue;
      try {
        const body = readFileSync(join(dir, f), 'utf8');
        if (body.length <= 64 * 1024) out[name] = body;
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir read failed */ }
  return out;
}

/** Write a { name → body } map into a global config dir as <name>.md
 *  files. Only writes files that don't already exist (additive merge —
 *  never clobber local edits). Returns the count of newly written files. */
function writeFileBundle(kind: 'personalities' | 'commands', items: Record<string, string>): number {
  const dir = globalDir(kind);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [name, body] of Object.entries(items)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64 || typeof body !== 'string' || !body) continue;
    const filePath = join(dir, `${name}.md`);
    if (existsSync(filePath)) continue; // don't clobber local
    try { writeFileSync(filePath, body); written++; } catch { /* skip */ }
  }
  return written;
}

async function pullBundle(kind: 'personalities' | 'commands'): Promise<number | null> {
  const syncToken = getSyncToken();
  if (!syncToken) return null;
  const res = await fetchWithRetry(`${API_BASE}/api/${kind}`, { headers: { 'x-sync-token': syncToken } });
  if (!res?.ok) return null;
  try {
    const data = await res.json() as { ok: boolean; items: Record<string, string> };
    if (!data.ok) return null;
    return writeFileBundle(kind, data.items ?? {});
  } catch {
    return null;
  }
}

async function pushBundle(kind: 'personalities' | 'commands'): Promise<number | null> {
  const syncToken = getSyncToken();
  if (!syncToken) return null;
  const items = readFileBundle(kind);
  const count = Object.keys(items).length;
  if (count === 0) return 0;
  const res = await fetchWithRetry(`${API_BASE}/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ items }),
  });
  return res?.ok ? count : null;
}

export const pullPersonalities = () => pullBundle('personalities');
export const pushPersonalities = () => pushBundle('personalities');
export const pullCommands = () => pullBundle('commands');
export const pushCommands = () => pushBundle('commands');

// ─── Session history sync ─────────────────────────────────────────────────────

/**
 * Sync session conversation history to codeep.dev.
 * Only user/assistant messages are sent — system messages are filtered out.
 * Fire-and-forget. Only sends if linked and sync_token is available.
 */
export function syncSession(payload: {
  sessionId: string;
  sessionName?: string;
  projectName?: string;
  projectId?: string;
  messages: { role: string; content: string }[];
}): void {
  const githubId = getGithubId();
  const syncToken = getSyncToken();
  if (!githubId || !syncToken) return;

  // Filter to only user/assistant messages
  const filtered = payload.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (filtered.length === 0) return;

  fetchWithRetry(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ ...payload, messages: filtered, githubId }),
  }).catch(() => {});
}

export async function syncSessionAsync(payload: {
  sessionId: string;
  sessionName?: string;
  projectName?: string;
  projectId?: string;
  messages: { role: string; content: string }[];
}): Promise<void> {
  const githubId = getGithubId();
  const syncToken = getSyncToken();
  if (!githubId || !syncToken) return;

  const filtered = payload.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (filtered.length === 0) return;

  await fetchWithRetry(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ ...payload, messages: filtered, githubId }),
  });
}

// ─── Progress log sync ────────────────────────────────────────────────────────

/**
 * Sync progress.md content to codeep.dev.
 * Fire-and-forget. Only sends if linked (githubId + syncToken).
 */
export function syncProgress(payload: {
  projectName: string;
  projectId: string;
  content: string;
}): void {
  const githubId = getGithubId();
  const syncToken = getSyncToken();
  if (!githubId || !syncToken) return;

  fetchWithRetry(`${API_BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ ...payload, githubId }),
  }).catch(() => {});
}

// ─── Learning preferences sync ────────────────────────────────────────────────

export async function pushLearning(preferences: object): Promise<boolean> {
  const syncToken = getSyncToken();
  if (!syncToken) return false;

  const res = await fetchWithRetry(`${API_BASE}/api/sync/learning`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ preferences }),
  });
  return res?.ok ?? false;
}

export async function pullLearning(): Promise<{ preferences: object; updatedAt: string } | null> {
  const syncToken = getSyncToken();
  if (!syncToken) return null;

  const res = await fetchWithRetry(`${API_BASE}/api/sync/learning`, {
    headers: { 'x-sync-token': syncToken },
  });
  if (!res?.ok) return null;
  try {
    const data = await res.json() as { ok: boolean; preferences: object | null; updatedAt: string };
    if (!data.ok || !data.preferences) return null;
    return { preferences: data.preferences, updatedAt: data.updatedAt };
  } catch {
    return null;
  }
}

// ─── Profiles sync ────────────────────────────────────────────────────────────

export async function pushProfiles(profiles: Record<string, object>): Promise<boolean> {
  const syncToken = getSyncToken();
  if (!syncToken) return false;

  const res = await fetchWithRetry(`${API_BASE}/api/sync/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ profiles }),
  });
  return res?.ok ?? false;
}

export async function pullProfiles(): Promise<Record<string, object> | null> {
  const syncToken = getSyncToken();
  if (!syncToken) return null;

  const res = await fetchWithRetry(`${API_BASE}/api/sync/profiles`, {
    headers: { 'x-sync-token': syncToken },
  });
  if (!res?.ok) return null;
  try {
    const data = await res.json() as { ok: boolean; profiles: Record<string, object> | null };
    return data.ok ? data.profiles : null;
  } catch {
    return null;
  }
}

export async function syncMemoryNotes(projectName: string, notes: string[]): Promise<void> {
  const syncToken = getSyncToken();
  if (!syncToken) return;
  fetchWithRetry(`${API_BASE}/api/projects/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
    body: JSON.stringify({ projectName, notes }),
  }).catch(() => { /* best effort */ });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff retry.
 * Retries on network errors and 5xx responses. Never retries on 4xx.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res; // success or client error — no retry
      }
      // 5xx — retryable
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt));
      }
    } catch {
      // network error — retryable
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }
  return null;
}
