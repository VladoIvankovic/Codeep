/**
 * SSRF (Server-Side Request Forgery) guard, shared by the agent's network-
 * touching surfaces.
 *
 * Used by:
 *   - toolExecution.ts  → the `fetch_url` tool
 *   - shell.ts          → curl/wget/http(s) arguments in execute_command
 *
 * The URLs in both cases originate from model output / page content
 * (untrusted, prompt-injectable), so the agent must not be able to reach
 * internal services or the cloud metadata endpoint (169.254.169.254).
 * NOTE: this deliberately does NOT apply to user-configured provider base
 * URLs (Ollama localhost, custom vLLM/Tailscale endpoints) — those are
 * trusted config and never routed through agent tools.
 */

import { lookup as dnsLookup } from 'dns/promises';

export function isBlockedIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s.includes(':')) {
    // IPv6
    if (s === '::1' || s === '::') return true;                       // loopback / unspecified
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // link-local / ULA
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);            // IPv4-mapped
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  const parts = s.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true;                        // loopback
  if (a === 10) return true;                         // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 169 && b === 254) return true;           // link-local incl. metadata 169.254.169.254
  if (a === 0) return true;                          // 0.0.0.0/8
  return false;
}

/** Returns an error string if the URL must not be fetched, else null. */
export async function assertFetchUrlAllowed(rawUrl: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return 'Invalid URL format'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `Blocked: only http/https URLs can be fetched (got "${u.protocol}")`;
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'Blocked: localhost is not fetchable by the agent';
  }
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    // Literal IP — check directly.
    if (isBlockedIp(host)) return `Blocked: ${host} is a private/loopback/link-local address`;
    return null;
  }
  // Resolve and check every address (catches internal hostnames + single-record rebinding).
  try {
    const addrs = await dnsLookup(host, { all: true });
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        return `Blocked: ${host} resolves to a private/internal address (${a.address})`;
      }
    }
  } catch {
    // DNS failure — let curl attempt and fail naturally; not an SSRF risk.
  }
  return null;
}
