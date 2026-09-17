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

describe('pullBundle on a revoked token', () => {
  it('reports rejected, which asks for a new link rather than a connection', async () => {
    fetchImpl = () => Promise.resolve({ ok: false, status: 401 } as Response);
    expect(await pull()).toEqual({ ok: false, reason: 'rejected' });
  });
});

describe('user profile sync results', () => {
  let home: string;
  let originalHome: string | undefined;
  let fs: typeof import('node:fs');
  let path: typeof import('node:path');
  const profileFile = () => path.join(home, '.codeep', 'profile.md');
  const writeLocalProfile = () => {
    fs.mkdirSync(path.join(home, '.codeep'), { recursive: true });
    fs.writeFileSync(profileFile(), '# About me\n');
  };
  const answer = (status: number, body?: unknown) => () => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('unexpected <');
      return body;
    },
  } as unknown as Response);

  beforeEach(async () => {
    fs = await import('node:fs');
    path = await import('node:path');
    const os = await import('node:os');
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeep-profile-sync-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('push: not linked', async () => {
    mockToken = '';
    const mod = await import('./codeepCloud.js');
    expect(await mod.pushUserProfileResult()).toEqual({ ok: false, reason: 'not-linked' });
    expect(await mod.pushUserProfile()).toBe(false);
  });

  it('push: no local profile is nothing to push, not a failure', async () => {
    const mod = await import('./codeepCloud.js');
    expect(await mod.pushUserProfileResult()).toEqual({ ok: true, count: 0, removed: 0 });
    expect(await mod.pushUserProfile()).toBe(false);
  });

  it('push: a revoked token is rejected', async () => {
    writeLocalProfile();
    fetchImpl = answer(401);
    const mod = await import('./codeepCloud.js');
    expect(await mod.pushUserProfileResult()).toEqual({ ok: false, reason: 'rejected' });
    expect(await mod.pushUserProfile()).toBe(false);
  });

  it('push: pushed', async () => {
    writeLocalProfile();
    fetchImpl = answer(200, { ok: true });
    const mod = await import('./codeepCloud.js');
    expect(await mod.pushUserProfileResult()).toEqual({ ok: true, count: 1, removed: 0 });
    expect(await mod.pushUserProfile()).toBe(true);
  });

  it('pull: a revoked token is rejected', async () => {
    fetchImpl = answer(403);
    const mod = await import('./codeepCloud.js');
    expect(await mod.pullUserProfileResult()).toEqual({ ok: false, reason: 'rejected' });
    expect(await mod.pullUserProfile()).toBeNull();
  });

  it('pull: a body that is not JSON is malformed', async () => {
    fetchImpl = answer(200);
    const mod = await import('./codeepCloud.js');
    expect(await mod.pullUserProfileResult()).toEqual({ ok: false, reason: 'malformed' });
    expect(await mod.pullUserProfile()).toBeNull();
  });

  it('pull: writes the dashboard profile when there is none here', async () => {
    fetchImpl = answer(200, { ok: true, content: '# From the web\n' });
    const mod = await import('./codeepCloud.js');
    expect(await mod.pullUserProfileResult()).toEqual({ ok: true, count: 1, removed: 0 });
    expect(fs.readFileSync(profileFile(), 'utf8')).toBe('# From the web\n');
  });

  it('pull: never replaces a local profile', async () => {
    writeLocalProfile();
    fetchImpl = answer(200, { ok: true, content: '# From the web\n' });
    const mod = await import('./codeepCloud.js');
    expect(await mod.pullUserProfile()).toBe(0);
    expect(fs.readFileSync(profileFile(), 'utf8')).toBe('# About me\n');
  });

  it('pull: a server that answers ok:false refused the request', async () => {
    fetchImpl = answer(200, { ok: false });
    const mod = await import('./codeepCloud.js');
    expect(await mod.pullUserProfileResult()).toEqual({ ok: false, reason: 'rejected' });
    expect(await mod.pullUserProfile()).toBeNull();
    expect(fs.existsSync(profileFile())).toBe(false);
  });

  it('pull: nothing on the dashboard is nothing to pull', async () => {
    fetchImpl = answer(200, { ok: true, content: null });
    const mod = await import('./codeepCloud.js');
    expect(await mod.pullUserProfileResult()).toEqual({ ok: true, count: 0, removed: 0 });
  });

  it('every reason has its own sentence', async () => {
    const { describeSyncFailure } = await import('./codeepCloud.js');
    const reasons = ['not-linked', 'unreachable', 'rejected', 'malformed', 'unreadable', 'unwritable'] as const;
    expect(new Set(reasons.map(describeSyncFailure)).size).toBe(reasons.length);
    expect(describeSyncFailure('rejected')).toContain('codeep account');
  });
});
