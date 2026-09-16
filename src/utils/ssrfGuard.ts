/**
 * SSRF (Server-Side Request Forgery) guard, shared by the agent's network-
 * touching surfaces.
 *
 * Used by:
 *   - toolExecution.ts  → the `fetch_url` tool (every redirect hop, pinned)
 *   - shell.ts          → curl/wget/http(s) arguments in execute_command
 *   - webFetch.ts       → redirect hops of a user's `@web` mention
 *
 * The URLs in the agent cases originate from model output / page content
 * (untrusted, prompt-injectable), so the agent must not be able to reach
 * internal services or the cloud metadata endpoint (169.254.169.254).
 * NOTE: this deliberately does NOT apply to user-configured provider base
 * URLs (Ollama localhost, custom vLLM/Tailscale endpoints) — those are
 * trusted config and never routed through agent tools.
 */

import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';

/** Strict dotted-quad → 4 octets, or null. */
function parseIPv4(s: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const octets = s.split('.').map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/**
 * IPv6 literal → 16 bytes, or null. Handles `::` compression, a trailing
 * dotted quad (`::ffff:1.2.3.4`) and a zone id (`fe80::1%en0`).
 *
 * Classifying bytes rather than the string is the point: the WHATWG URL
 * parser rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a guard that
 * pattern-matches the dotted spelling never sees the address it has to block.
 */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;

  let tail: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    tail = parseIPv4(s.slice(lastColon + 1));
    if (!tail) return null;
    s = s.slice(0, lastColon + 1) + '0:0'; // two placeholder groups
  }

  let groups: string[];
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    groups = [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;

  const bytes = groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
  return a === 0                                // 0.0.0.0/8 "this network"
    || a === 10                                 // RFC1918
    || a === 127                                // loopback
    || (a === 100 && b >= 64 && b <= 127)       // 100.64.0.0/10 CGNAT — Tailscale lives here
    || (a === 169 && b === 254)                 // link-local incl. metadata 169.254.169.254
    || (a === 172 && b >= 16 && b <= 31)        // RFC1918
    || (a === 192 && b === 0 && c === 0)        // 192.0.0.0/24 IETF protocol assignments
    || (a === 192 && b === 168)                 // RFC1918
    || (a === 198 && (b === 18 || b === 19))    // 198.18.0.0/15 benchmarking
    || a >= 224;                                // multicast, reserved, broadcast
}

function isBlockedIPv6(b: number[]): boolean {
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  // Forms that carry an IPv4 address — judge the embedded address.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIPv4(b.slice(12)); // ::ffff:0:0/96 mapped
  if (zeroUpTo(12)) return isBlockedIPv4(b.slice(12));  // ::/96 compatible — also covers :: and ::1
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b.slice(4, 12).every((x) => x === 0)) return isBlockedIPv4(b.slice(12)); // 64:ff9b::/96 NAT64
    if (b[4] === 0x00 && b[5] === 0x01) return true;                              // 64:ff9b:1::/48 local-use NAT64
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(b.slice(2, 6)); // 2002::/16 6to4
  if ((b[0] & 0xfe) === 0xfc) return true;                    // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;   // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;   // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true;                             // ff00::/8 multicast
  return false;
}

/**
 * Whether an IP literal points somewhere the agent must not reach. Brackets
 * are accepted (`[::1]`); anything that isn't an IP literal returns false —
 * hostnames are resolved by `resolveFetchTarget`, not judged by spelling.
 */
export function isBlockedIp(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(s);
  if (v4) return isBlockedIPv4(v4);
  const v6 = parseIPv6(s);
  return v6 ? isBlockedIPv6(v6) : false;
}

export type FetchTargetCheck =
  | {
      ok: true;
      url: URL;
      /** Every checked address, to pin the connection to, so a second DNS
       *  answer can't swap in a private one (rebinding). All of them, not
       *  the first: a dual-stack host whose AAAA sorts first would otherwise
       *  be unreachable on a machine without a working IPv6 route. Undefined
       *  for IP literals — nothing to resolve — and when DNS failed. */
      addresses?: string[];
      /** True when the host was a name that did not resolve. */
      unresolved?: boolean;
    }
  | { ok: false; reason: string };

/** Validate a URL and resolve its host, returning the verified address. */
export async function resolveFetchTarget(rawUrl: string): Promise<FetchTargetCheck> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'Invalid URL format' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Blocked: only http/https URLs can be fetched (got "${u.protocol}")` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'Blocked: localhost is not fetchable by the agent' };
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) return { ok: false, reason: `Blocked: ${host} is a private/loopback/link-local address` };
    return { ok: true, url: u };
  }
  // Resolve and check every address (catches internal hostnames + single-record rebinding).
  let addrs: { address: string }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    // DNS failure — not an SSRF risk by itself; callers decide whether an
    // unpinned request is acceptable.
    return { ok: true, url: u, unresolved: true };
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      return { ok: false, reason: `Blocked: ${host} resolves to a private/internal address (${a.address})` };
    }
  }
  return { ok: true, url: u, addresses: addrs.map((a) => a.address) };
}

/** Returns an error string if the URL must not be fetched, else null. */
export async function assertFetchUrlAllowed(rawUrl: string): Promise<string | null> {
  const check = await resolveFetchTarget(rawUrl);
  return check.ok ? null : check.reason;
}
