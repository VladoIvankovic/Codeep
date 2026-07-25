/**
 * `@web <url>` inline context — fetch a web page and attach its text
 * content to the prompt, the same way `@file` attaches a file.
 *
 * Supported forms (anywhere in the message, like file mentions):
 *   @web https://example.com/docs       → full URL
 *   @web example.com/docs               → https:// is auto-prepended
 *   @web http://localhost:3000/api      → dev servers work too
 *
 * The fetch is best-effort:
 *   - HTML is stripped to readable text (tags, scripts, styles removed).
 *   - Output is capped at `MAX_WEB_BYTES` (default 32 KB) so a single
 *     page can't blow the context window.
 *   - Markdown conversion is lightweight (headings, links, lists) — we
 *     don't run a full HTML→Markdown pipeline; the goal is "agent can
 *     read the page", not "pretty render".
 *   - Failures (network, non-2xx, non-text content type) surface as
 *     inline notifications, same as missing files.
 *
 * The fetcher is async, so `expandWebMentions` is async — unlike the
 * sync `expandMentions` for files. Callers await it.
 */

/** Max bytes of text we'll inline from a fetched page (32 KB). */
export const MAX_WEB_BYTES = 32 * 1024;

/** Fetch timeout — don't hang the chat on a slow server. */
const FETCH_TIMEOUT_MS = 12_000;

/** User-Agent — some sites block the default `node` UA. */
const USER_AGENT = `Codeep/1 (+https://codeep.dev)`;

/** Result of expanding `@web` mentions in a prompt. */
export interface WebExpansionResult {
  /** The prompt with fetched page text prepended. */
  enrichedPrompt: string;
  /** Successfully fetched pages. */
  loaded: Array<{ url: string; title: string; content: string }>;
  /** Mentions that couldn't be fetched, with a human-readable reason. */
  failures: Array<{ mention: string; reason: string }>;
}

// ─── Mention extraction ───────────────────────────────────────────────────────

/** One `@web` mention match. */
interface WebToken {
  /** Full match including `@web `, for display. */
  raw: string;
  /** The URL (normalized: `https://` prepended if missing a scheme). */
  url: string;
  /** Start index of `raw` in the source. */
  start: number;
  /** End index (exclusive). */
  end: number;
}

/**
 * Regex matching a `@web <url>` mention.
 *
 * `@web` must be followed by whitespace, then a URL-like token (no
 * spaces). We accept `http://`, `https://`, or bare host/path. The
 * bare form (`example.com/docs`) gets `https://` auto-prepended.
 */
const WEB_MENTION_RE = /(?:^|[\s([{<,;])@web\s+(https?:\/\/[^\s<>"]+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s<>"]*)/gi;

/**
 * Extract all `@web` mentions from `text`. Pure (no network).
 * Returns them in document order.
 */
export function extractWebMentions(text: string): WebToken[] {
  const tokens: WebToken[] = [];
  WEB_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WEB_MENTION_RE.exec(text)) !== null) {
    let url = m[1];
    if (!url) continue;
    // Auto-prepend https:// for bare hosts (e.g. "example.com/docs").
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    // The match may include a leading boundary char (space, `(`, …);
    // `tok.start` should point at the `@` so stripping leaves the
    // boundary char in place.
    const matchText = m[0];
    const atIdx = matchText.indexOf('@');
    const start = m.index + (atIdx >= 0 ? atIdx : 0);
    tokens.push({ raw: matchText.slice(atIdx).trim(), url, start, end: m.index + m[0].length });
  }
  return tokens;
}

// ─── Expansion ────────────────────────────────────────────────────────────────

export interface WebFetchOptions {
  /**
   * The fetch implementation. Defaults to the global `fetch` (Node 18+).
   * Injected so tests can mock without hitting the network.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Expand all `@web` mentions in `prompt`: fetch each URL, convert the
 * HTML to readable text, and prepend it as a `[Web pages]` block.
 * Failures are collected, not thrown.
 */
export async function expandWebMentions(
  prompt: string,
  opts: WebFetchOptions = {},
): Promise<WebExpansionResult> {
  const tokens = extractWebMentions(prompt);
  if (tokens.length === 0) {
    return { enrichedPrompt: prompt, loaded: [], failures: [] };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const loaded: Array<{ url: string; title: string; content: string }> = [];
  const failures: Array<{ mention: string; reason: string }> = [];
  const seen = new Set<string>();

  // Fetch sequentially — avoids hammering a server and keeps failure
  // order stable (matches the order in the prompt).
  for (const tok of tokens) {
    if (seen.has(tok.url)) continue;
    seen.add(tok.url);

    // Session cache: skip the network if we fetched this URL recently.
    const cached = cacheGet(tok.url);
    if (cached) {
      loaded.push({ url: tok.url, title: cached.title, content: cached.content });
      continue;
    }

    const result = await safeFetch(tok.url, fetchImpl);
    if (!result.ok) {
      failures.push({ mention: tok.raw, reason: result.reason });
      continue;
    }
    // Cache successful fetches for the rest of the session.
    cacheSet(tok.url, result);
    loaded.push({ url: tok.url, title: result.title, content: result.content });
  }

  // Strip the `@web ` and the URL from the visible prompt, leaving a
  // bare URL (readable, and the agent still sees what was referenced).
  let stripped = prompt;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    stripped = stripped.slice(0, tok.start) + tok.url + stripped.slice(tok.end);
  }

  const block = formatWebBlock(loaded);
  return {
    enrichedPrompt: block ? block + stripped.trimStart() : stripped,
    loaded,
    failures,
  };
}

// ─── Session-level fetch cache ───────────────────────────────────────────────
//
// `@web` is often used for stable docs that don't change within a
// session. We cache successful fetches (URL → result) for the rest of
// the session so a second `@web` for the same URL is instant and free.
// Failures are NOT cached (transient network errors should retry).

interface CacheEntry {
  result: FetchSuccess;
  /** `Date.now()` when the entry was written. */
  writtenAt: number;
}

/** Session cache: normalized URL → entry. */
const webCache = new Map<string, CacheEntry>();

/** Cache TTL: 30 minutes. Docs rarely change faster than that. */
const WEB_CACHE_TTL_MS = 30 * 60 * 1000;

/** Max entries — prevents unbounded growth in long sessions. */
const WEB_CACHE_MAX = 50;

/**
 * Normalize a URL for cache keying: lowercase host, strip trailing
 * slash, drop fragments. Query strings are kept (they can change
 * content).
 */
function normalizeUrlForCache(url: string): string {
  try {
    const u = new URL(url);
    // The fragment is deliberately excluded: it never reaches the server, so
    // `#a` and `#b` on the same URL are one cache entry.
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    // Not a parseable URL — fall back to the raw string.
    return url;
  }
}

/** Look up a cached successful fetch. Returns `null` if missing/expired. */
function cacheGet(url: string): FetchSuccess | null {
  const key = normalizeUrlForCache(url);
  const entry = webCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.writtenAt > WEB_CACHE_TTL_MS) {
    webCache.delete(key);
    return null;
  }
  return entry.result;
}

/** Store a successful fetch in the cache (evicting oldest if full). */
function cacheSet(url: string, result: FetchSuccess): void {
  const key = normalizeUrlForCache(url);
  // Evict oldest if at capacity. Map preserves insertion order, so the
  // first key is the oldest.
  if (webCache.size >= WEB_CACHE_MAX && !webCache.has(key)) {
    const oldest = webCache.keys().next().value;
    if (oldest !== undefined) webCache.delete(oldest);
  }
  webCache.set(key, { result, writtenAt: Date.now() });
}

/**
 * Reset the session web cache. Public so callers (e.g. `/web-cache clear`
 * command, or tests) can force a fresh fetch.
 */
export function clearWebCache(): void {
  webCache.clear();
}

/**
 * Stats about the session web cache — for `/web-cache status`.
 */
export function webCacheStats(): { entries: number; maxEntries: number; ttlMinutes: number } {
  return { entries: webCache.size, maxEntries: WEB_CACHE_MAX, ttlMinutes: WEB_CACHE_TTL_MS / 60000 };
}

// ─── Fetch + HTML→text ────────────────────────────────────────────────────────

interface FetchSuccess {
  ok: true;
  title: string;
  content: string;
}
interface FetchFailure {
  ok: false;
  reason: string;
}

/**
 * Hosts that only make sense from *inside* the machine or network: loopback,
 * RFC1918, link-local (which covers the 169.254.169.254 cloud-metadata
 * endpoint), and `.internal`-style names.
 *
 * A user typing `@web http://localhost:3000` is a documented, intended use, so
 * this is NOT a blanket block — it's only applied to where a fetch *ended up*
 * after redirects, so a public URL can't bounce us into the private network.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254);
}

/** Hard ceiling on bytes read from the network, before any text decoding. */
const MAX_WEB_FETCH_BYTES = MAX_WEB_BYTES * 4;

async function safeFetch(
  url: string,
  fetchImpl: typeof fetch,
): Promise<FetchSuccess | FetchFailure> {
  const controller = new AbortController();
  // Kept alive until the BODY is read, not just the headers — clearing it on
  // header arrival let a slow-drip response hang the chat forever. Cleared in
  // `finally` so a throw can't leak the timer either.
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const requestedPrivate = (() => {
      try { return isPrivateHost(new URL(url).hostname); } catch { return false; }
    })();

    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html, text/plain, */*' },
      redirect: 'follow',
    });

    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    // SSRF guard: the user vouched for the host they typed, not for wherever
    // it redirected us. Refuse a public → private hop (cloud metadata, LAN).
    if (!requestedPrivate && res.url) {
      try {
        if (isPrivateHost(new URL(res.url).hostname)) {
          return { ok: false, reason: 'redirected to a private/internal address — refused' };
        }
      } catch { /* unparseable res.url — fall through */ }
    }

    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_WEB_FETCH_BYTES) {
      return { ok: false, reason: `response too large (${Math.round(declared / 1024)}KB)` };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const text = await readCapped(res);

    // Plain text or JSON — keep as-is (capped).
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      const capped = text.length > MAX_WEB_BYTES ? text.slice(0, MAX_WEB_BYTES) + '\n…(truncated)' : text;
      return { ok: true, title: url, content: capped };
    }

    // HTML — strip to readable text.
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const { title, content } = htmlToText(text);
      const capped = content.length > MAX_WEB_BYTES ? content.slice(0, MAX_WEB_BYTES) + '\n…(truncated)' : content;
      return { ok: true, title: title || url, content: capped };
    }

    // Anything else (images, PDFs, …) — we can't usefully inline it.
    return { ok: false, reason: `unsupported content type (${contentType || 'unknown'})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) return { ok: false, reason: `timed out after ${FETCH_TIMEOUT_MS / 1000}s` };
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body, stopping once `MAX_WEB_FETCH_BYTES` have arrived.
 *
 * `res.text()` buffers the whole body first and only then truncates, so a
 * server streaming gigabytes would OOM the CLI before the cap was applied.
 * Falls back to `res.text()` when the body isn't a stream (test doubles).
 */
async function readCapped(res: Response): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    const whole = await res.text();
    return whole.length > MAX_WEB_FETCH_BYTES ? whole.slice(0, MAX_WEB_FETCH_BYTES) : whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_WEB_FETCH_BYTES) break; // stop pulling; cap reached
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.byteLength; }
  return new TextDecoder('utf-8').decode(joined);
}

/**
 * Convert HTML to readable plain text + a title.
 *
 * Lightweight — no full parser dependency. Strips `<script>`, `<style>`,
 * and tags, collapses whitespace, extracts `<title>` and the first
 * `<h1>` as the page title. Good enough for the agent to read docs;
 * not a faithful rendering.
 */
export function htmlToText(html: string): { title: string; content: string } {
  // Title: prefer <title>, fall back to first <h1>.
  let title = '';
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) title = decodeEntities(titleMatch[1].trim());
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
    if (h1) title = decodeEntities(h1[1].trim());
  }

  // Remove script/style/noscript blocks entirely.
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Drop the <head> (we already have the title).
  body = body.replace(/<head[\s\S]*?<\/head>/gi, '');

  // Convert block-level tags to newlines so text doesn't run together.
  body = body.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');

  // Convert links to "text (url)" so the agent keeps the reference.
  body = body.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, (_m, href, text) => {
    const t = text.trim();
    return t ? `${t} (${href})` : '';
  });

  // Strip all remaining tags.
  body = body.replace(/<[^>]+>/g, '');

  // Decode common HTML entities.
  body = decodeEntities(body);

  // Collapse runs of whitespace (but preserve newlines).
  body = body
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return { title, content: body };
}

/** Decode the handful of HTML entities we're likely to see. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Format the `[Web pages]` block prepended to the enriched prompt. */
export function formatWebBlock(pages: Array<{ url: string; title: string; content: string }>): string {
  if (pages.length === 0) return '';
  const parts: string[] = ['[Web pages]'];
  for (const p of pages) {
    const heading = p.title && p.title !== p.url ? `${p.title} — ${p.url}` : p.url;
    parts.push(`\nURL: ${heading}\n${p.content}`);
  }
  return parts.join('\n') + '\n\n';
}
