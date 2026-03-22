/**
 * Codeep Cloud — CLI authentication and stats reporting.
 *
 * Handles:
 *  - `codeep account` login flow (device-code style, browser + poll)
 *  - Sending usage stats to codeep.dev/api/stats after each agent run
 */

import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { getGithubId, setGithubAccount } from '../config/index.js';

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

      const data = await res.json() as { status: string; github_id?: string; username?: string };

      if (data.status === 'authorized' && data.github_id) {
        setGithubAccount(data.github_id, data.username ?? '');
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
    body: JSON.stringify({ ...payload, githubId }),
  }).catch(() => {
    // ignore network errors — stats are best-effort
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
