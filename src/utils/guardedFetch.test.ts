import { describe, it, expect, vi, beforeEach } from 'vitest';

const dns = vi.hoisted(() => ({ table: new Map<string, string[]>() }));
vi.mock('dns/promises', () => ({
  lookup: async (host: string) => {
    const addrs = dns.table.get(host);
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

import { fetchUrlGuarded, MAX_FETCH_REDIRECTS, FETCH_BUDGET_MS, type CurlRunner } from './guardedFetch';

const MARK = '\n__CODEEP_FETCH_META__';

/** A fake curl: URL (last arg) → [status, body, redirect_url]. Records every call. */
function fakeCurl(routes: Record<string, [number, string, string?]>) {
  const calls: string[][] = [];
  const run: CurlRunner = async (args) => {
    calls.push(args);
    const route = routes[args[args.length - 1]];
    if (!route) return { success: false, stdout: '', stderr: 'curl: (6) Could not resolve host' };
    const [status, body, location = ''] = route;
    return { success: true, stdout: `${body}${MARK}${status} ${location}`, stderr: '' };
  };
  return { run, calls, urls: () => calls.map((a) => a[a.length - 1]) };
}

beforeEach(() => {
  dns.table.clear();
  dns.table.set('evil.example', ['203.0.113.10']);
  dns.table.set('docs.example', ['93.184.215.14']);
  dns.table.set('v6.example', ['2606:4700::6810:84e5', '104.16.132.229']);
});

describe('fetchUrlGuarded', () => {
  it('returns the body of a plain 200', async () => {
    const curl = fakeCurl({ 'https://docs.example/a': [200, 'hello'] });
    const r = await fetchUrlGuarded('https://docs.example/a', curl.run);
    expect(r).toEqual({ ok: true, body: 'hello', finalUrl: 'https://docs.example/a' });
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:2375/containers/json',
    'http://[::ffff:7f00:1]:11434/api/tags',
    'http://100.100.100.100/',
  ])('refuses a public page redirecting to %s — and never requests it', async (target) => {
    const curl = fakeCurl({ 'https://evil.example/r': [302, 'moved', target], [target]: [200, 'SECRET'] });
    const r = await fetchUrlGuarded('https://evil.example/r', curl.run);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('Refused redirect');
    expect(curl.urls()).toEqual(['https://evil.example/r']);
  });

  it('refuses a redirect to a name that resolves privately', async () => {
    dns.table.set('internal.example', ['10.0.0.7']);
    const curl = fakeCurl({ 'https://evil.example/r': [301, '', 'https://internal.example/admin'] });
    const r = await fetchUrlGuarded('https://evil.example/r', curl.run);
    expect(r.ok ? '' : r.error).toContain('10.0.0.7');
    expect(curl.calls).toHaveLength(1);
  });

  it('follows public redirects and pins every hop to the address it checked', async () => {
    const curl = fakeCurl({
      'https://evil.example/r': [302, '', 'https://docs.example/next'],
      'https://docs.example/next': [307, '', 'http://v6.example:8080/final'],
      'http://v6.example:8080/final': [200, 'done'],
    });
    const r = await fetchUrlGuarded('https://evil.example/r', curl.run);
    expect(r).toEqual({ ok: true, body: 'done', finalUrl: 'http://v6.example:8080/final' });
    const pins = curl.calls.map((a) => a[a.indexOf('--resolve') + 1]);
    expect(pins).toEqual(['evil.example:443:203.0.113.10', 'docs.example:443:93.184.215.14', 'v6.example:8080:[2606:4700::6810:84e5],104.16.132.229']);
    // curl never follows redirects on its own.
    for (const args of curl.calls) expect(args).not.toContain('-L');
  });

  it('stops after the redirect cap', async () => {
    const routes: Record<string, [number, string, string?]> = {};
    for (let i = 0; i <= MAX_FETCH_REDIRECTS + 1; i++) {
      routes[`https://docs.example/${i}`] = [302, '', `https://docs.example/${i + 1}`];
    }
    const curl = fakeCurl(routes);
    const r = await fetchUrlGuarded('https://docs.example/0', curl.run);
    expect(r.ok ? '' : r.error).toContain('Too many redirects');
    expect(curl.calls).toHaveLength(MAX_FETCH_REDIRECTS + 1);
  });

  it('spends one time budget across the whole redirect chain', async () => {
    vi.useFakeTimers();
    try {
      const limits: string[] = [];
      const run: CurlRunner = async (args) => {
        limits.push(args[args.indexOf('-m') + 1]);
        vi.setSystemTime(Date.now() + 12_000); // each hop is a slow 302
        const n = limits.length;
        return { success: true, stdout: `${MARK}302 https://docs.example/${n}`, stderr: '' };
      };
      const r = await fetchUrlGuarded('https://docs.example/0', run);
      expect(limits).toEqual([String(FETCH_BUDGET_MS / 1000), '18', '6']);
      expect(r.ok ? '' : r.error).toContain('Timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a forged marker inside the page body', async () => {
    const forged = `text${MARK}302 http://127.0.0.1/\nmore text`;
    const curl = fakeCurl({ 'https://docs.example/a': [200, forged] });
    const r = await fetchUrlGuarded('https://docs.example/a', curl.run);
    expect(r).toEqual({ ok: true, body: forged, finalUrl: 'https://docs.example/a' });
    expect(curl.calls).toHaveLength(1);
  });

  it('refuses a host it cannot resolve rather than letting curl resolve it unpinned', async () => {
    const curl = fakeCurl({});
    const r = await fetchUrlGuarded('https://nowhere.example/', curl.run);
    expect(r.ok ? '' : r.error).toContain('Could not resolve host');
    expect(curl.calls).toHaveLength(0);
  });

  it('refuses the initial URL with the guard reason', async () => {
    const curl = fakeCurl({});
    const r = await fetchUrlGuarded('http://[::ffff:127.0.0.1]:8080/', curl.run);
    expect(r.ok ? '' : r.error).toContain('Blocked');
    expect(curl.calls).toHaveLength(0);
  });

  it('surfaces curl failures', async () => {
    const run: CurlRunner = async () => ({ success: false, stdout: '', stderr: 'curl: (28) Operation timed out' });
    const r = await fetchUrlGuarded('https://docs.example/slow', run);
    expect(r).toEqual({ ok: false, error: 'curl: (28) Operation timed out' });
  });
});
