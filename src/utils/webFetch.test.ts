import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractWebMentions,
  expandWebMentions,
  htmlToText,
  formatWebBlock,
  MAX_WEB_BYTES,
  clearWebCache,
  webCacheStats,
} from './webFetch';

// ─── extractWebMentions (pure) ────────────────────────────────────────────────

describe('extractWebMentions', () => {
  it('extracts a full https URL', () => {
    const tokens = extractWebMentions('see @web https://example.com/docs');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].url).toBe('https://example.com/docs');
  });

  it('extracts a http URL', () => {
    const tokens = extractWebMentions('@web http://localhost:3000/api');
    expect(tokens[0].url).toBe('http://localhost:3000/api');
  });

  it('auto-prepends https:// for a bare host', () => {
    const tokens = extractWebMentions('@web example.com/docs');
    expect(tokens[0].url).toBe('https://example.com/docs');
  });

  it('auto-prepends https:// for a host with subdomain', () => {
    const tokens = extractWebMentions('@web docs.example.com/api/v2');
    expect(tokens[0].url).toBe('https://docs.example.com/api/v2');
  });

  it('extracts multiple mentions in order', () => {
    const tokens = extractWebMentions('@web a.com and @web b.org/page');
    expect(tokens.map((t) => t.url)).toEqual(['https://a.com', 'https://b.org/page']);
  });

  it('does not match a bare @ (no web keyword)', () => {
    expect(extractWebMentions('check @src/file.ts')).toEqual([]);
  });

  it('does not match @web without a following URL', () => {
    expect(extractWebMentions('@web is cool')).toEqual([]);
  });

  it('does not match @website (word boundary)', () => {
    expect(extractWebMentions('visit @website now')).toEqual([]);
  });

  it('matches @web at the start of the string', () => {
    const tokens = extractWebMentions('@web example.com');
    expect(tokens).toHaveLength(1);
  });

  it('matches @web after punctuation', () => {
    for (const sep of [' ', '(', '[', '{', '<', ',', ';']) {
      const tokens = extractWebMentions(`${sep}@web example.com`);
      expect(tokens, `separator ${JSON.stringify(sep)}`).toHaveLength(1);
    }
  });

  it('requires a TLD for bare hosts (rejects localhost without scheme)', () => {
    // `localhost` has no dot → not matched as a bare host.
    expect(extractWebMentions('@web localhost:3000')).toEqual([]);
  });
});

// ─── htmlToText (pure) ────────────────────────────────────────────────────────

describe('htmlToText', () => {
  it('extracts the <title>', () => {
    const { title } = htmlToText('<html><head><title>My Page</title></head><body>x</body></html>');
    expect(title).toBe('My Page');
  });

  it('falls back to <h1> when no <title>', () => {
    const { title } = htmlToText('<body><h1>Heading</h1><p>x</p></body>');
    expect(title).toBe('Heading');
  });

  it('strips script and style blocks', () => {
    const { content } = htmlToText(
      '<script>alert(1)</script><style>.x{}</style><p>visible</p>',
    );
    expect(content).toBe('visible');
    expect(content).not.toContain('alert');
    expect(content).not.toContain('.x');
  });

  it('converts block tags to newlines', () => {
    const { content } = htmlToText('<p>one</p><p>two</p>');
    expect(content).toBe('one\ntwo');
  });

  it('preserves link text and href', () => {
    const { content } = htmlToText('<a href="https://x.com">click</a>');
    expect(content).toBe('click (https://x.com)');
  });

  it('decodes common entities', () => {
    const { content } = htmlToText('<p>foo &amp; bar &lt;baz&gt;</p>');
    expect(content).toBe('foo & bar <baz>');
  });

  it('decodes numeric entities', () => {
    const { content } = htmlToText('<p>&#65;&#x42;</p>');
    expect(content).toBe('AB');
  });

  it('collapses whitespace runs', () => {
    const { content } = htmlToText('<p>  lots   of   spaces  </p>');
    expect(content).toBe('lots of spaces');
  });

  it('removes HTML comments', () => {
    const { content } = htmlToText('<!-- note --><p>visible</p>');
    expect(content).toBe('visible');
  });

  it('drops the <head> from the body', () => {
    const { content } = htmlToText('<head><meta charset="utf-8"></head><body><p>x</p></body>');
    expect(content).toBe('x');
  });
});

// ─── formatWebBlock ───────────────────────────────────────────────────────────

describe('formatWebBlock', () => {
  it('returns an empty string for no pages', () => {
    expect(formatWebBlock([])).toBe('');
  });

  it('formats a page with a distinct title', () => {
    const out = formatWebBlock([{ url: 'https://x.com', title: 'Home', content: 'hello' }]);
    expect(out).toContain('[Web pages]');
    expect(out).toContain('URL: Home — https://x.com');
    expect(out).toContain('hello');
  });

  it('uses just the URL when title matches', () => {
    const out = formatWebBlock([{ url: 'https://x.com', title: 'https://x.com', content: 'x' }]);
    expect(out).toContain('URL: https://x.com');
    expect(out).not.toContain('— https://x.com');
  });

  it('formats multiple pages in order', () => {
    const out = formatWebBlock([
      { url: 'https://a.com', title: 'a', content: 'A' },
      { url: 'https://b.com', title: 'b', content: 'B' },
    ]);
    expect(out.indexOf('a.com')).toBeLessThan(out.indexOf('b.com'));
  });
});

// ─── expandWebMentions (with mocked fetch) ────────────────────────────────────

/** Build a fake `fetch` returning a fixed HTML/text payload. */
function mockFetch(responses: Record<string, { status?: number; body: string; contentType?: string }>): typeof fetch {
  return vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const entry = responses[url];
    if (!entry) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(entry.body, {
      status: entry.status ?? 200,
      headers: { 'content-type': entry.contentType ?? 'text/html; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
}

describe('expandWebMentions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The session web cache is module-level; clear it between tests so
    // earlier fetches don't satisfy later expectations.
    clearWebCache();
  });

  it('returns the prompt unchanged when there are no @web mentions', async () => {
    const r = await expandWebMentions('hello world', { fetchImpl: mockFetch({}) });
    expect(r.enrichedPrompt).toBe('hello world');
    expect(r.loaded).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  it('fetches an HTML page and prepends its text', async () => {
    const fetchImpl = mockFetch({
      'https://example.com': {
        body: '<html><head><title>Docs</title></head><body><h1>Hi</h1><p>Hello world</p></body></html>',
      },
    });
    const r = await expandWebMentions('check @web example.com', { fetchImpl });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0].url).toBe('https://example.com');
    expect(r.loaded[0].title).toBe('Docs');
    expect(r.loaded[0].content).toContain('Hi');
    expect(r.loaded[0].content).toContain('Hello world');
    expect(r.enrichedPrompt).toContain('[Web pages]');
    // The `@web ` prefix is stripped, leaving the bare URL.
    expect(r.enrichedPrompt).toContain('check https://example.com');
    expect(r.enrichedPrompt).not.toContain('@web');
  });

  it('dedupes repeated mentions of the same URL', async () => {
    const fetchImpl = mockFetch({
      'https://x.com': { body: '<p>x</p>' },
    });
    const r = await expandWebMentions('@web x.com and @web x.com again', { fetchImpl });
    expect(r.loaded).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a failure for HTTP error status', async () => {
    const fetchImpl = mockFetch({
      'https://x.com': { body: 'nope', status: 404 },
    });
    const r = await expandWebMentions('@web x.com', { fetchImpl });
    expect(r.loaded).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toBe('HTTP 404');
  });

  it('reports a failure for unsupported content type', async () => {
    const fetchImpl = mockFetch({
      'https://x.com': { body: 'binary', contentType: 'image/png' },
    });
    const r = await expandWebMentions('@web x.com', { fetchImpl });
    expect(r.loaded).toEqual([]);
    expect(r.failures[0].reason).toContain('unsupported content type');
  });

  it('handles plain-text responses as-is', async () => {
    const fetchImpl = mockFetch({
      'https://api.com/data': { body: '{"key":"value"}', contentType: 'application/json' },
    });
    const r = await expandWebMentions('@web https://api.com/data', { fetchImpl });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0].content).toBe('{"key":"value"}');
  });

  it('handles a mix of valid and failed fetches', async () => {
    const fetchImpl = mockFetch({
      'https://ok.com': { body: '<p>ok</p>' },
    });
    const r = await expandWebMentions('@web ok.com @web missing.com', { fetchImpl });
    expect(r.loaded).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toBe('HTTP 404');
  });

  it('truncates pages larger than MAX_WEB_BYTES', async () => {
    const big = 'x'.repeat(MAX_WEB_BYTES + 5000);
    const fetchImpl = mockFetch({
      'https://x.com': { body: `<p>${big}</p>`, contentType: 'text/plain' },
    });
    const r = await expandWebMentions('@web x.com', { fetchImpl });
    expect(r.loaded[0].content.length).toBeLessThanOrEqual(MAX_WEB_BYTES + 20);
    expect(r.loaded[0].content).toContain('truncated');
  });

  // ── Session cache ──────────────────────────────────────────────────────────

  it('caches a successful fetch — second mention skips the network', async () => {
    const fetchImpl = mockFetch({
      'https://docs.example.com': { body: '<p>cached page</p>' },
    });
    // First fetch — hits the network.
    await expandWebMentions('@web docs.example.com', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Second mention of the same URL — should be served from cache.
    const r2 = await expandWebMentions('@web docs.example.com again', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1
    expect(r2.loaded).toHaveLength(1);
    expect(r2.loaded[0].content).toContain('cached page');
  });

  it('does NOT cache failures — a retry hits the network again', async () => {
    const fetchImpl = mockFetch({
      'https://fail.example.com': { body: 'nope', status: 500 },
    });
    await expandWebMentions('@web fail.example.com', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expandWebMentions('@web fail.example.com', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats trailing-slash and bare URLs as the same cache key', async () => {
    const fetchImpl = mockFetch({
      'https://example.com/path/': { body: '<p>page</p>' },
    });
    await expandWebMentions('@web example.com/path/', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Same resource, different URL form — cache hit.
    const r2 = await expandWebMentions('@web example.com/path', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r2.loaded).toHaveLength(1);
  });

  it('webCacheStats reports the entry count', async () => {
    clearWebCache();
    expect(webCacheStats().entries).toBe(0);
    const fetchImpl = mockFetch({
      'https://a.example.com': { body: '<p>a</p>' },
      'https://b.example.com': { body: '<p>b</p>' },
    });
    await expandWebMentions('@web a.example.com @web b.example.com', { fetchImpl });
    expect(webCacheStats().entries).toBe(2);
  });

  it('clearWebCache empties the cache', async () => {
    const fetchImpl = mockFetch({
      'https://c.example.com': { body: '<p>c</p>' },
    });
    await expandWebMentions('@web c.example.com', { fetchImpl });
    expect(webCacheStats().entries).toBe(1);
    clearWebCache();
    expect(webCacheStats().entries).toBe(0);
    // After clearing, the next fetch hits the network again.
    await expandWebMentions('@web c.example.com', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
