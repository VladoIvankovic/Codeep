/**
 * Codeep Cloud — CLI authentication and stats reporting.
 *
 * Handles:
 *  - `codeep account` login flow (device-code style, browser + poll)
 *  - Sending usage stats to codeep.dev/api/stats after each agent run
 */

import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { getGithubId, getSyncToken, setGithubAccount, setSyncToken, setApiKey } from '../config/index.js';

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
  language?: string;
  isGit?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

/**
 * Fire-and-forget stats report. Only sends if github_id is configured.
 */
export function reportStats(payload: StatsPayload): void {
  const githubId = getGithubId();
  if (!githubId) return; // not linked, skip silently

  fetch(`${API_BASE}/api/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, githubId, isGit: payload.isGit ?? false }),
  }).catch(() => {
    // ignore network errors — stats are best-effort
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
export async function fetchTasks(projectName?: string): Promise<CloudTask[] | null> {
  const githubId = getGithubId();
  if (!githubId) return null;

  const url = new URL(`${API_BASE}/api/tasks`);
  url.searchParams.set('githubId', githubId);
  if (projectName) url.searchParams.set('project', projectName);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json() as { ok: boolean; tasks: CloudTask[] };
    return data.ok ? data.tasks : null;
  } catch {
    return null;
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

  try {
    const res = await fetch(`${API_BASE}/api/keys`, {
      headers: { 'x-sync-token': syncToken },
    });
    if (!res.ok) return null;
    const data = await res.json() as { ok: boolean; keys: Record<string, string> };
    if (!data.ok) return null;
    return data.keys;
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

  try {
    const res = await fetch(`${API_BASE}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
      body: JSON.stringify({ keys }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
