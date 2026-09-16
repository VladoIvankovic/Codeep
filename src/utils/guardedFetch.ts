/**
 * `fetch_url`'s transport: curl, with redirects followed here rather than by
 * curl, so every hop passes the SSRF guard.
 *
 * `curl -L` only let us check the URL the model asked for. A public page that
 * answers `302 Location: http://169.254.169.254/…` (or any LAN/localhost
 * service) was followed silently and its body handed back to the model —
 * and `fetch_url` runs without a confirmation prompt. So each hop is resolved,
 * checked, and the connection pinned to the checked address with `--resolve`,
 * which also stops a second DNS answer (rebinding) from swapping in a private
 * address between the check and curl's own lookup.
 */

import { resolveFetchTarget } from './ssrfGuard';

export type CurlRunner = (args: string[]) => Promise<{ success: boolean; stdout: string; stderr: string }>;

export type GuardedFetchResult =
  | { ok: true; body: string; finalUrl: string }
  | { ok: false; error: string };

export const MAX_FETCH_REDIRECTS = 5;
/** One budget for the whole chain — per hop, six slow 302s would hold a tool call for minutes. */
export const FETCH_BUDGET_MS = 30_000;

// Appended by curl after the body; the LAST occurrence is always curl's own,
// so a page that happens to contain the marker can't forge a redirect.
const META_MARKER = '\n__CODEEP_FETCH_META__';

export async function fetchUrlGuarded(
  rawUrl: string,
  runCurl: CurlRunner,
  maxRedirects = MAX_FETCH_REDIRECTS,
): Promise<GuardedFetchResult> {
  let current = rawUrl;
  const deadline = Date.now() + FETCH_BUDGET_MS;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const secondsLeft = Math.ceil((deadline - Date.now()) / 1000);
    if (secondsLeft <= 0) return { ok: false, error: `Timed out after ${FETCH_BUDGET_MS / 1000}s following redirects` };
    const check = await resolveFetchTarget(current);
    if (!check.ok) {
      return { ok: false, error: hop === 0 ? check.reason : `Refused redirect to ${current} — ${check.reason}` };
    }
    if (check.unresolved) {
      // An unpinned request would let curl's own lookup decide the address.
      return { ok: false, error: `Could not resolve host: ${check.url.hostname}` };
    }

    const { url, addresses } = check;
    const args = [
      '-s',
      '--proto', '=http,https',
      '-m', String(secondsLeft),
      '-A', 'Codeep/1.0',
      '--max-filesize', '1000000',
      '-w', `${META_MARKER}%{http_code} %{redirect_url}`,
    ];
    if (addresses?.length) {
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      const pinned = addresses.map((a) => (a.includes(':') ? `[${a}]` : a)).join(',');
      args.push('--resolve', `${url.hostname}:${port}:${pinned}`);
    }
    args.push(url.href);

    const res = await runCurl(args);
    const at = res.stdout.lastIndexOf(META_MARKER);
    if (!res.success || at === -1) {
      return { ok: false, error: res.stderr || 'Failed to fetch URL' };
    }
    const body = res.stdout.slice(0, at);
    const meta = res.stdout.slice(at + META_MARKER.length).trim();
    const space = meta.indexOf(' ');
    const status = Number(space === -1 ? meta : meta.slice(0, space));
    const location = space === -1 ? '' : meta.slice(space + 1).trim();

    if (status >= 300 && status < 400 && location) {
      current = location;
      continue;
    }
    return { ok: true, body, finalUrl: url.href };
  }
  return { ok: false, error: `Too many redirects (more than ${maxRedirects})` };
}
