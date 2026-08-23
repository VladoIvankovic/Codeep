import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// pullBundle reaches the network through the module-level `fetch` and reads the
// token from config, so both are stubbed here rather than threaded through the
// signature. What is under test is the mapping from "what came back" to a
// SyncResult — the distinction that did not exist when every path returned null.
vi.mock('../config/index.js', async (orig) => ({
  ...(await orig<typeof import('../config/index.js')>()),
  getSyncToken: () => mockToken,
}));

let mockToken = 'token-abc';
let fetchImpl: (() => Promise<unknown>) | null = null;

beforeEach(() => {
  mockToken = 'token-abc';
  fetchImpl = null;
  vi.stubGlobal('fetch', () => (fetchImpl ? fetchImpl() : Promise.reject(new Error('no stub'))));
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function pull() {
  const mod = await import('./codeepCloud.js');
  return mod.pullPersonalities();
}

describe('pullBundle failure discrimination', () => {
  it('reports not-linked when no token is stored', async () => {
    mockToken = '';
    expect(await pull()).toEqual({ ok: false, reason: 'not-linked' });
  });

  it('reports unreachable when the request never succeeds', async () => {
    fetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await pull()).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports unreachable on a non-2xx answer', async () => {
    fetchImpl = () => Promise.resolve({ ok: false, status: 503 } as Response);
    expect(await pull()).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports rejected when the server answers ok:false', async () => {
    fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false }) } as Response);
    expect(await pull()).toEqual({ ok: false, reason: 'rejected' });
  });

  it('reports malformed when the body is not JSON', async () => {
    fetchImpl = () => Promise.resolve({
      ok: true, status: 200, json: async () => { throw new SyntaxError('unexpected <'); },
    } as unknown as Response);
    expect(await pull()).toEqual({ ok: false, reason: 'malformed' });
  });

  it('succeeds with count 0 — the case that used to look like a failure', async () => {
    fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, items: {} }) } as Response);
    const res = await pull();
    expect(res.ok).toBe(true);
    expect(res).toEqual({ ok: true, count: 0, removed: 0 });
  });
});

describe('describeSyncFailure', () => {
  it('gives every reason a distinct, actionable sentence', async () => {
    const { describeSyncFailure } = await import('./codeepCloud.js');
    const reasons = ['not-linked', 'unreachable', 'rejected', 'malformed'] as const;
    const texts = reasons.map(describeSyncFailure);
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(10);
    expect(describeSyncFailure('not-linked')).toContain('codeep account');
  });
});
