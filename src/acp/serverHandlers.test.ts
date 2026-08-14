/**
 * Unit tests for the extracted ACP handlers in `acp/serverHandlers.ts`.
 *
 * These pin the contract of the synchronous session-lifecycle handlers
 * (`set_mode`, `set_config_option`, `session/list`, `session/delete`) that
 * were lifted out of the `startAcpServer()` closure. Each handler takes a
 * `(msg, deps)` pair; the tests build a stub transport that records every
 * call, and a real `sessions` Map seeded with a known session.
 *
 * The transport stub is intentionally minimal — just an array of recorded
 * calls — so assertions read like a transcript of what the handler told the
 * client. No real stdio, no real MCP, no real keychain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  handleSetMode,
  handleSetConfigOption,
  applyConfigOption,
  handleSessionList,
  handleSessionDelete,
  handleListProviders,
  buildProviderList,
  type AcpHandlerDeps,
  type AcpTransport,
  type AcpServerSession,
  type SessionMap,
} from './serverHandlers';
import { config } from '../config/index';
import type { JsonRpcRequest } from './protocol';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** A transport stub that records every call as a tuple. Lets tests assert
 *  "the handler responded with X, then notified Y" without mocking stdio. */
interface RecordedCall {
  kind: 'respond' | 'error' | 'notify';
  id?: string | number;
  result?: unknown;
  code?: number;
  message?: string;
  method?: string;
  params?: unknown;
}

function makeTransport(): { transport: AcpTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: AcpTransport = {
    respond: (id, result) => calls.push({ kind: 'respond', id, result }),
    error: (id, code, message) => calls.push({ kind: 'error', id, code, message }),
    notify: (method, params) => calls.push({ kind: 'notify', method, params }),
  };
  return { transport, calls };
}

/** Build a minimal in-memory session for tests. */
function makeSession(overrides: Partial<AcpServerSession> = {}): AcpServerSession {
  return {
    sessionId: 'test-session-id',
    workspaceRoot: '/tmp/repo',
    history: [],
    codeepSessionId: 'codeep-session-id',
    addedFiles: new Map(),
    abortController: null,
    currentModeId: 'auto',
    titleSent: true,
    hadHistory: false,
    ...overrides,
  };
}

/** Build deps with a seeded sessions map. */
function makeDeps(sessionEntries: [string, AcpServerSession][] = []): {
  deps: AcpHandlerDeps;
  calls: RecordedCall[];
  sessions: SessionMap;
} {
  const { transport, calls } = makeTransport();
  const sessions: SessionMap = new Map(sessionEntries);
  return { deps: { transport, sessions }, calls, sessions };
}

function makeRequest(id: string | number, method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params } as JsonRpcRequest;
}

// ─── handleSetMode ────────────────────────────────────────────────────────────

describe('handleSetMode', () => {
  it('switches the session mode and notifies the client', () => {
    const session = makeSession({ currentModeId: 'auto' });
    const { deps, calls, sessions } = makeDeps([['s1', session]]);
    const msg = makeRequest(1, 'session/set_mode', { sessionId: 's1', modeId: 'manual' });

    handleSetMode(msg, deps);

    expect(sessions.get('s1')!.currentModeId).toBe('manual');
    expect(calls).toEqual([
      { kind: 'respond', id: 1, result: {} },
      {
        kind: 'notify',
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'manual' },
        },
      },
    ]);
  });

  it('errors on unknown sessionId', () => {
    const { deps, calls } = makeDeps([]);
    const msg = makeRequest(2, 'session/set_mode', { sessionId: 'nope', modeId: 'manual' });

    handleSetMode(msg, deps);

    expect(calls).toEqual([
      { kind: 'error', id: 2, code: -32602, message: 'Unknown sessionId: nope' },
    ]);
  });

  it('errors on unknown modeId', () => {
    const session = makeSession();
    const { deps, calls } = makeDeps([['s1', session]]);
    const msg = makeRequest(3, 'session/set_mode', { sessionId: 's1', modeId: 'bogus' });

    handleSetMode(msg, deps);

    expect(calls).toEqual([
      { kind: 'error', id: 3, code: -32602, message: 'Unknown modeId: bogus' },
    ]);
    // Session's mode is unchanged
    expect(deps.sessions.get('s1')!.currentModeId).toBe('auto');
  });

  it('does NOT mutate the global agentConfirmation config', () => {
    config.set('agentConfirmation', 'dangerous');
    const session = makeSession();
    const { deps } = makeDeps([['s1', session]]);
    const msg = makeRequest(1, 'session/set_mode', { sessionId: 's1', modeId: 'manual' });

    handleSetMode(msg, deps);

    // Mode is on the session only — global config stays as it was.
    expect(config.get('agentConfirmation')).toBe('dangerous');
  });
});

// ─── applyConfigOption ────────────────────────────────────────────────────────

describe('applyConfigOption', () => {
  beforeEach(() => {
    config.set('provider', 'z.ai');
    config.set('model', 'glm-5.1');
  });

  it('switches provider + model when value is "providerId/modelId"', () => {
    applyConfigOption('model', 'anthropic/claude-sonnet-4-5');
    expect(config.get('provider')).toBe('anthropic');
    expect(config.get('model')).toBe('claude-sonnet-4-5');
  });

  it('sets only model when value has no slash', () => {
    applyConfigOption('model', 'custom-model');
    expect(config.get('model')).toBe('custom-model');
  });

  it('switches provider via the "provider" configId', () => {
    applyConfigOption('provider', 'anthropic');
    expect(config.get('provider')).toBe('anthropic');
  });

  it('sets customBaseUrl', () => {
    applyConfigOption('customBaseUrl', 'http://localhost:8000/v1');
    expect(config.get('customBaseUrl')).toBe('http://localhost:8000/v1');
  });

  it('sets language', () => {
    applyConfigOption('language', 'hr');
    expect(config.get('language')).toBe('hr');
  });

  it.each([
    'agentConfirmDeleteFile',
    'agentConfirmExecuteCommand',
    'agentConfirmWriteFile',
    'userProfile',
    'autoLearnProfile',
  ] as const)('treats "%s" as a boolean toggle accepting true / "true" / "false"', (id) => {
    applyConfigOption(id, true);
    expect(config.get(id)).toBe(true);
    applyConfigOption(id, 'true');
    expect(config.get(id)).toBe(true);
    applyConfigOption(id, 'false');
    expect(config.get(id)).toBe(false);
    applyConfigOption(id, false);
    expect(config.get(id)).toBe(false);
  });

  it('ignores an unknown configId (no-op, no throw)', () => {
    expect(() => applyConfigOption('nonexistent', 'value')).not.toThrow();
  });
});

// ─── handleSetConfigOption ────────────────────────────────────────────────────

describe('handleSetConfigOption', () => {
  it('errors on unknown sessionId', () => {
    const { deps, calls } = makeDeps([]);
    const msg = makeRequest(1, 'session/set_config_option', {
      sessionId: 'nope',
      configId: 'language',
      value: 'en',
    });

    handleSetConfigOption(msg, deps);

    expect(calls).toEqual([
      { kind: 'error', id: 1, code: -32602, message: 'Unknown sessionId: nope' },
    ]);
  });

  it('applies the change, responds, and pushes refreshed config options', () => {
    const session = makeSession();
    const { deps, calls } = makeDeps([['s1', session]]);
    const msg = makeRequest(7, 'session/set_config_option', {
      sessionId: 's1',
      configId: 'language',
      value: 'de',
    });

    handleSetConfigOption(msg, deps);

    expect(config.get('language')).toBe('de');
    expect(calls[0]).toMatchObject({ kind: 'respond', id: 7, result: {} });
    expect(calls[1]).toMatchObject({
      kind: 'notify',
      method: 'session/update',
      params: { sessionId: 's1' },
    });
    // The notification payload includes the refreshed config-option list
    const notifyParams = calls[1].params as { update: { configOptions: { id: string }[] } };
    expect(notifyParams.update.configOptions.some(o => o.id === 'language')).toBe(true);
  });
});

// ─── handleSessionList ────────────────────────────────────────────────────────

describe('handleSessionList', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeep-acp-list-'));
    config.set('currentSessionId', '');
  });

  it('responds with a (possibly empty) sessions array', () => {
    const { deps, calls } = makeDeps();
    const msg = makeRequest(1, 'session/list', { cwd: tmpDir });

    handleSessionList(msg, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'respond', id: 1 });
    const result = calls[0].result as { sessions: unknown[] };
    expect(Array.isArray(result.sessions)).toBe(true);
  });

  it('includes a session saved to the project-local dir', () => {
    // listSessionsWithInfo only treats a directory as "project-local" if
    // isProjectDirectory() recognises it — which needs a project marker
    // (.codeep/project.json or one of the well-known files). Drop a marker
    // so the handler routes the list query at our tmpDir.
    const { mkdirSync, writeFileSync: wf } = require('fs');
    mkdirSync(join(tmpDir, '.codeep'), { recursive: true });
    wf(join(tmpDir, '.codeep', 'project.json'), '{}');

    const sessionsDir = join(tmpDir, '.codeep', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    wf(
      join(sessionsDir, 'test-session.json'),
      JSON.stringify({
        id: 'test-session',
        title: 'Test session',
        createdAt: new Date().toISOString(),
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    const { deps, calls } = makeDeps();
    const msg = makeRequest(2, 'session/list', { cwd: tmpDir });

    handleSessionList(msg, deps);

    const result = calls[0].result as { sessions: { sessionId: string; title: string }[] };
    const found = result.sessions.find(s => s.sessionId === 'test-session');
    expect(found).toBeDefined();
    expect(found!.title).toBe('Test session');
  });
});

// ─── handleSessionDelete ──────────────────────────────────────────────────────

describe('handleSessionDelete', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeep-acp-delete-'));
  });

  it('drops the session from the in-memory map and responds', () => {
    const session = makeSession();
    const { deps, calls, sessions } = makeDeps([['s1', session]]);
    expect(sessions.size).toBe(1);

    const msg = makeRequest(1, 'session/delete', { sessionId: 's1', cwd: tmpDir });
    handleSessionDelete(msg, deps);

    expect(sessions.size).toBe(0);
    expect(calls).toEqual([{ kind: 'respond', id: 1, result: {} }]);
  });

  it('still responds OK when the session was never in memory', () => {
    const { deps, calls } = makeDeps([]);
    const msg = makeRequest(2, 'session/delete', { sessionId: 'ghost', cwd: tmpDir });

    handleSessionDelete(msg, deps);

    expect(calls).toEqual([{ kind: 'respond', id: 2, result: {} }]);
  });

  it('deletes a project-local session file when present', () => {
    // Same project-marker dance as the list test — deleteSession() routes
    // by isProjectDirectory() too.
    const { mkdirSync, writeFileSync: wf, existsSync: ef } = require('fs');
    mkdirSync(join(tmpDir, '.codeep'), { recursive: true });
    wf(join(tmpDir, '.codeep', 'project.json'), '{}');

    const sessionsDir = join(tmpDir, '.codeep', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionPath = join(sessionsDir, 'doomed.json');
    wf(
      sessionPath,
      JSON.stringify({
        id: 'doomed',
        title: 'will be deleted',
        createdAt: new Date().toISOString(),
        messages: [],
      }),
    );

    const { deps } = makeDeps();
    const msg = makeRequest(3, 'session/delete', { sessionId: 'doomed', cwd: tmpDir });
    handleSessionDelete(msg, deps);

    expect(ef(sessionPath)).toBe(false);
  });
});

// ─── handleListProviders / buildProviderList ──────────────────────────────────

describe('buildProviderList', () => {
  it('returns a non-empty array of provider descriptors', () => {
    const list = buildProviderList();
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('models');
      expect(p).toHaveProperty('defaultModel');
    }
  });

  it('each provider entry carries id/name/groupLabel/models/defaultModel', () => {
    const list = buildProviderList();
    for (const p of list) {
      // groupLabel falls back to name when unset
      expect(typeof p.groupLabel).toBe('string');
      expect(p.groupLabel.length).toBeGreaterThan(0);
      // models is an array of { id, name }
      expect(Array.isArray(p.models)).toBe(true);
      for (const m of p.models) {
        expect(m).toHaveProperty('id');
        expect(m).toHaveProperty('name');
      }
    }
  });

  it('includes a known provider (z.ai) with the expected shape', () => {
    const list = buildProviderList();
    const zai = list.find(p => p.id === 'z.ai');
    expect(zai).toBeDefined();
    expect(zai!.name).toMatch(/Z\.AI/);
    expect(zai!.defaultModel).toBeTruthy();
    expect(zai!.models.length).toBeGreaterThan(0);
    // GLM models are present
    expect(zai!.models.some(m => m.id.startsWith('glm'))).toBe(true);
  });

  it('flags dynamicModels for open-ended providers (OpenRouter, ModelScope, Ollama, custom)', () => {
    const list = buildProviderList();
    // These providers expose dynamicModels: true so clients
    // offer free-text model entry instead of a fixed dropdown.
    const openEnded = list.filter(p => p.dynamicModels);
    const ids = openEnded.map(p => p.id);
    // The exact set may evolve, but at least the well-known ones should be present.
    expect(ids).toContain('openrouter');
    expect(ids).toContain('modelscope');
    expect(ids).toContain('ollama');
    expect(ids).toContain('custom');
  });
});

describe('handleListProviders', () => {
  it('responds with the full provider list', () => {
    const { deps, calls } = makeDeps();
    const msg = makeRequest(1, 'session/list_providers', {});

    handleListProviders(msg, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'respond', id: 1 });
    const result = calls[0].result as { providers: { id: string }[] };
    expect(result.providers.length).toBeGreaterThan(0);
    expect(result.providers.some(p => p.id === 'z.ai')).toBe(true);
  });
});
