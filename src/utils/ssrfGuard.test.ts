import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable DNS: host → addresses. Unknown hosts fail to resolve.
const dns = vi.hoisted(() => ({ table: new Map<string, string[]>() }));
vi.mock('dns/promises', () => ({
  lookup: async (host: string) => {
    const addrs = dns.table.get(host);
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

import { isBlockedIp, resolveFetchTarget, assertFetchUrlAllowed } from './ssrfGuard';

beforeEach(() => dns.table.clear());

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1', '127.8.9.10', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '100.100.100.100', '100.127.255.255',
    '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.255.255.250', '255.255.255.255',
  ])('blocks IPv4 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '::1', '::', '[::1]', 'fe80::1', 'fe80::1%en0', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    // IPv4-mapped, in both spellings. The WHATWG URL parser turns
    // [::ffff:127.0.0.1] into [::ffff:7f00:1] — the hex form is what a URL
    // guard actually receives, and the one the old string match let through.
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1',
    '::7f00:1', '::127.0.0.1',            // IPv4-compatible
    '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '64:ff9b:1::1', // NAT64
    '2002:7f00:1::1', '2002:c0a8:101::1', // 6to4 wrapping loopback / RFC1918
  ])('blocks IPv6 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.215.14', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1',
    '192.0.1.1', '198.17.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '::ffff:808:808',
    '64:ff9b::808:808', '2002:808:808::1',
  ])('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it.each(['example.com', '', '1.2.3', '256.1.1.1', 'fe80', 'fcdn.example', ':::1'])('does not treat %j as a blocked IP', (s) => {
    expect(isBlockedIp(s)).toBe(false);
  });
});

describe('resolveFetchTarget', () => {
  it.each([
    'http://[::ffff:127.0.0.1]:8080/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://2130706433/',          // integer spelling of 127.0.0.1
    'http://0x7f.1/',              // hex/short spelling of 127.0.0.1
    'http://100.100.100.100/',
    'http://localhost:3000/',
    'http://api.localhost/',
  ])('refuses %s without touching DNS', async (url) => {
    const r = await resolveFetchTarget(url);
    expect(r.ok).toBe(false);
  });

  it('refuses a name that resolves to any private address', async () => {
    dns.table.set('rebind.example', ['93.184.215.14', '127.0.0.1']);
    const r = await resolveFetchTarget('https://rebind.example/x');
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? '' : r.reason).toContain('127.0.0.1');
  });

  it('returns the checked address for pinning', async () => {
    dns.table.set('docs.example', ['2606:2800:21f:cb07:6820:80da:af6b:8b2c', '93.184.215.14']);
    const r = await resolveFetchTarget('https://docs.example/page');
    expect(r).toMatchObject({ ok: true, addresses: ['2606:2800:21f:cb07:6820:80da:af6b:8b2c', '93.184.215.14'] });
  });

  it('marks an unresolvable name instead of refusing it', async () => {
    const r = await resolveFetchTarget('https://nowhere.example/');
    expect(r).toMatchObject({ ok: true, unresolved: true });
  });

  it('refuses non-http schemes and garbage', async () => {
    expect(await assertFetchUrlAllowed('file:///etc/passwd')).toContain('only http/https');
    expect(await assertFetchUrlAllowed('gopher://example.com/')).toContain('only http/https');
    expect(await assertFetchUrlAllowed('not a url')).toBe('Invalid URL format');
  });
});
