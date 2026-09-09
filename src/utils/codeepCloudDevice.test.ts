import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module keeps a once-per-process flag, so each test gets a fresh copy.
const { mockGetSyncToken, mockGetDeviceId } = vi.hoisted(() => ({
  mockGetSyncToken: vi.fn(),
  mockGetDeviceId: vi.fn(() => 'dev-abc'),
}));
vi.mock('../config/index.js', () => ({
  getSyncToken: mockGetSyncToken,
  getDeviceId: mockGetDeviceId,
  getGithubId: vi.fn(() => 'gh-1'),
  setGithubAccount: vi.fn(),
  setSyncToken: vi.fn(),
  isTelemetryEnabled: vi.fn(() => true),
}));

async function freshModule() {
  vi.resetModules();
  return await import('./codeepCloud');
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSyncToken.mockReturnValue('tok-123');
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

/**
 * Registration used to run once, at link time, inside a `catch {}` that
 * swallowed failures — leaving a machine with a working token and no device
 * row: syncing, absent from Connected devices, and impossible to revoke,
 * because Revoke deletes a row that was never written.
 */
describe('ensureDeviceRegistered', () => {
  it('announces the device with its token, id and hostname', async () => {
    const { ensureDeviceRegistered } = await freshModule();
    ensureDeviceRegistered();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/auth/cli/device');
    expect(init.method).toBe('POST');
    expect(init.headers['x-sync-token']).toBe('tok-123');
    const body = JSON.parse(init.body);
    expect(body.deviceId).toBe('dev-abc');
    expect(typeof body.hostname).toBe('string');
  });

  it('does nothing when the machine is not linked', async () => {
    mockGetSyncToken.mockReturnValue(undefined);
    const { ensureDeviceRegistered } = await freshModule();
    ensureDeviceRegistered();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a heartbeat, not a hot path — once per process', async () => {
    const { ensureDeviceRegistered } = await freshModule();
    ensureDeviceRegistered();
    ensureDeviceRegistered();
    ensureDeviceRegistered();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /// The whole point: a start that could not reach the server must not mark
  /// the device registered for good, or the state it was meant to repair
  /// becomes permanent again.
  it('retries after a failure instead of latching', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { ensureDeviceRegistered } = await freshModule();
    ensureDeviceRegistered();
    await new Promise(r => setTimeout(r, 0));   // let the rejection settle
    ensureDeviceRegistered();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws, whatever the network does', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const { ensureDeviceRegistered } = await freshModule();
    expect(() => ensureDeviceRegistered()).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
  });
});
