import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `getSyncToken` and `getGithubId` are read by the cloud helpers to decide
// whether to hit the network at all. We mock the config module so the tests
// never touch the real keychain or disk config.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    syncToken: 'tok-123',
    githubId: 'gh-42',
    telemetry: true,
  },
}));

vi.mock('../config/index.js', () => ({
  getSyncToken: () => mockConfig.syncToken,
  getGithubId: () => mockConfig.githubId,
  setGithubAccount: vi.fn(),
  setSyncToken: vi.fn(),
  getDeviceId: () => 'dev-test',
  isTelemetryEnabled: () => mockConfig.telemetry,
}));

import { listCloudSessions, pullCloudSession } from './codeepCloud';

// ─── fetch helpers ────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
  } as unknown as Response;
}

describe('listCloudSessions', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    mockConfig.syncToken = 'tok-123';
    mockConfig.githubId = 'gh-42';
    mockConfig.telemetry = true;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns null when not linked (no sync token)', async () => {
    mockConfig.syncToken = '';
    expect(await listCloudSessions()).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does NOT consult telemetry — reading your own data is not telemetry', async () => {
    mockConfig.telemetry = false;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, sessions: [] }),
    );
    // Even with telemetry off, listing your cloud sessions must work —
    // the push was gated, but reading back is the user explicitly asking.
    const result = await listCloudSessions();
    expect(result).toEqual([]);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('returns summaries on a successful 200', async () => {
    const sessions = [
      {
        sessionId: 'sess-a',
        sessionName: 'OAuth migration',
        projectName: 'codeep',
        projectId: 'abc123',
        messageCount: 12,
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
    ];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, sessions }),
    );
    const result = await listCloudSessions();
    expect(result).toEqual(sessions);
    // The request must carry the sync token header.
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'x-sync-token': 'tok-123' });
    expect(String(url)).toContain('/api/sessions');
  });

  it('scopes by projectId when provided', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, sessions: [] }),
    );
    await listCloudSessions('proj-xyz');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('projectId=proj-xyz');
  });

  it('returns null on a non-ok response (e.g. 401 expired token)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: false }, false),
    );
    expect(await listCloudSessions()).toBeNull();
  });

  it('returns null on a network error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    expect(await listCloudSessions()).toBeNull();
  });

  it('returns null when the server says ok:false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: false, sessions: [] }),
    );
    expect(await listCloudSessions()).toBeNull();
  });
});

describe('pullCloudSession', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    mockConfig.syncToken = 'tok-123';
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns null when not linked', async () => {
    mockConfig.syncToken = '';
    expect(await pullCloudSession('sess-a')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns the full session (with messages) on a 200', async () => {
    const session = {
      sessionId: 'sess-a',
      sessionName: 'OAuth migration',
      projectName: 'codeep',
      projectId: 'abc123',
      messageCount: 2,
      updatedAt: '2026-07-07T10:00:00.000Z',
      messages: [
        { role: 'user', content: 'help with OAuth' },
        { role: 'assistant', content: 'sure, here is…' },
      ],
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, session }),
    );
    const result = await pullCloudSession('sess-a');
    expect(result).toEqual(session);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('id=sess-a');
    expect((init as RequestInit).headers).toMatchObject({ 'x-sync-token': 'tok-123' });
  });

  it('returns null on 404 (session not found / belongs to another user)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: false }, false),
    );
    expect(await pullCloudSession('missing')).toBeNull();
  });

  it('returns null on network error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    expect(await pullCloudSession('sess-a')).toBeNull();
  });
});
