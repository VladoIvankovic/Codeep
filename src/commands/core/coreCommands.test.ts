// Unit tests for the shared command core (P2 refactor step: TUI/ACP dedup).
// telemetryCommand and keysyncCommand are now single-source — these tests
// pin the semantics both surfaces inherit: env-var hard-off, config
// toggling, status facts, and usage handling.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const configGet = vi.fn();
const configSet = vi.fn();
vi.mock('../../config/index', () => ({
  config: { get: (k: string) => configGet(k), set: (k: string, v: unknown) => configSet(k, v) },
  isTelemetryEnabled: () => configGet('__telEnabled'),
  telemetryForcedOffByEnv: () => configGet('__telEnvOff') === true,
  isKeySyncEnabled: () => configGet('__ksEnabled'),
  keySyncForcedOffByEnv: () => configGet('__ksEnvOff') === true,
}));

import { telemetryCommand } from './telemetry';
import { keysyncCommand } from './keysync';

describe('core /telemetry', () => {
  beforeEach(() => {
    configGet.mockReset();
    configSet.mockReset();
    configGet.mockImplementation((k: string) => {
      if (k === 'telemetry') return true;
      return undefined;
    });
  });

  it('turns telemetry on', () => {
    const r = telemetryCommand(['on']);
    expect(r.kind).toBe('ok');
    expect(r.message).toMatch(/Telemetry on/);
    expect(configSet).toHaveBeenCalledWith('telemetry', true);
  });

  it('turns telemetry off', () => {
    const r = telemetryCommand(['off']);
    expect(configSet).toHaveBeenCalledWith('telemetry', false);
    expect(r.message).toMatch(/Telemetry off/);
  });

  it('env var blocks the toggle even when asked on', () => {
    configGet.mockImplementation((k: string) => (k === '__telEnvOff' ? true : undefined));
    const r = telemetryCommand(['on']);
    expect(r.kind).toBe('warn');
    expect(r.message).toMatch(/CODEEP_NO_TELEMETRY/);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('unknown subcommand → usage', () => {
    const r = telemetryCommand(['bogus']);
    expect(r.kind).toBe('info');
    expect(r.message).toMatch(/Usage:/);
  });

  it('no args (or status) → status report with flag and state', () => {
    configGet.mockImplementation((k: string) => {
      if (k === 'telemetry') return false;
      if (k === '__telEnabled') return true;
      return undefined;
    });
    const r = telemetryCommand([]);
    expect(r.kind).toBe('info');
    expect(r.message).toMatch(/Telemetry: on/);
    expect(r.message).toMatch(/telemetry\`: false/);
  });

  it('status mentions env override when forced off', () => {
    configGet.mockImplementation((k: string) => {
      if (k === '__telEnvOff') return true;
      return undefined;
    });
    const r = telemetryCommand(['status']);
    expect(r.message).toMatch(/DO_NOT_TRACK/);
  });
});

describe('core /keysync', () => {
  beforeEach(() => {
    configGet.mockReset();
    configSet.mockReset();
    configGet.mockImplementation(() => undefined);
  });

  it('turns sync on with the server-readable disclosure', () => {
    const r = keysyncCommand(['on']);
    expect(configSet).toHaveBeenCalledWith('syncKeysToCloud', true);
    expect(r.message).toMatch(/server-readable/); // disclosure must always ride along
  });

  it('turns sync off and mentions purge-keys', () => {
    const r = keysyncCommand(['off']);
    expect(configSet).toHaveBeenCalledWith('syncKeysToCloud', false);
    expect(r.message).toMatch(/purge-keys/);
  });

  it('env var (CODEEP_NO_KEY_SYNC) blocks the toggle — org-policy hard switch', () => {
    configGet.mockImplementation((k: string) => (k === '__ksEnvOff' ? true : undefined));
    const r = keysyncCommand(['on']);
    expect(r.kind).toBe('warn');
    expect(configSet).not.toHaveBeenCalled();
  });

  it('no args → status; default is off', () => {
    const r = keysyncCommand([]);
    expect(r.kind).toBe('info');
    expect(r.message).toMatch(/Cloud key sync: off/);
    expect(r.message).toMatch(/OFF by default/);
  });

  it('usage on unknown subcommand', () => {
    const r = keysyncCommand(['xyz']);
    expect(r.message).toMatch(/Usage:/);
  });
});
