/**
 * TUI slash-command handlers, driven through handleCommand with a stub app.
 *
 * HOME points at a temp directory before anything is imported: several modules
 * resolve ~/.codeep paths at import time, and the profile, learning and global
 * MCP files these tests write must never land in the real home directory.
 * Nothing here reaches the network or spawns an MCP server — the cloud calls
 * and registerSessionServers are mocked, and fetch refuses anything that
 * slips past them.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const { tempHome, originalHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeep-commands-home-'));
  process.env.HOME = tempHome;
  return { tempHome, originalHome };
});

vi.mock('../utils/mcpRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/mcpRegistry')>()),
  registerSessionServers: vi.fn(async () => ({ registered: [], errors: [] })),
}));

vi.mock('../utils/codeepCloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/codeepCloud')>()),
  pushUserProfileResult: vi.fn(async () => ({ ok: false, reason: 'unreachable' })),
  pullUserProfileResult: vi.fn(async () => ({ ok: false, reason: 'unreachable' })),
  listCloudSessions: vi.fn(async () => null),
  pullCloudSession: vi.fn(async () => null),
}));

vi.mock('./agentExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentExecution')>()),
  runSkill: vi.fn(async () => false),
  runAgentTask: vi.fn(async () => {}),
}));

vi.mock('../utils/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/agent')>()),
  undoAllActions: vi.fn(() => ({ success: false, results: [] })),
  undoLastAction: vi.fn(() => ({ success: false, message: 'No actions to undo' })),
}));

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { handleCommand, type AppCommandContext } from './commands';
import { runSkill, runAgentTask } from './agentExecution';
import { undoAllActions, undoLastAction } from '../utils/agent';
import { setPendingPlan, getPendingPlan, clearPendingPlan } from '../utils/planMode';
import { config, saveSession, loadSession, getSessionsDir } from '../config/index';
import { registerSessionServers } from '../utils/mcpRegistry';
import { pushUserProfileResult, pullUserProfileResult, listCloudSessions, pullCloudSession, type SyncResult } from '../utils/codeepCloud';
import { trustWorkspaceMcp } from '../utils/mcpConfig';
import { loadProjectPreferences } from '../utils/learning';
import { MCP_MARKETPLACE } from '../utils/mcpMarketplace';
import { loadCustomSkills, getSkippedCustomSkills } from '../utils/skills';
import { createCheckpoint } from '../utils/checkpoints';

const mockRegister = registerSessionServers as unknown as ReturnType<typeof vi.fn>;
const mockPush = pushUserProfileResult as unknown as ReturnType<typeof vi.fn>;
const mockPull = pullUserProfileResult as unknown as ReturnType<typeof vi.fn>;
const mockRunSkill = runSkill as unknown as ReturnType<typeof vi.fn>;
const mockRunAgentTask = runAgentTask as unknown as ReturnType<typeof vi.fn>;
const mockUndoAll = undoAllActions as unknown as ReturnType<typeof vi.fn>;
const mockUndoLast = undoLastAction as unknown as ReturnType<typeof vi.fn>;

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});

let projectDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', async (url: unknown) => { throw new Error(`test tried to reach ${String(url)}`); });
  projectDir = mkdtempSync(join(tmpdir(), 'codeep-commands-proj-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(projectPath: string) {
  const messages: { role: string; content: string }[] = [];
  const history = [{ role: 'user', content: 'hello' }];
  const notices: string[] = [];
  const app = {
    notify: vi.fn((m: string) => { notices.push(m); }),
    notifyWarn: vi.fn((m: string) => { notices.push(m); }),
    addMessage: vi.fn((m: { role: string; content: string }) => { messages.push(m); }),
    showConfirm: vi.fn(),
    getMessages: () => history,
    setMessages: vi.fn(),
  };
  const ctx = {
    app,
    projectPath,
    projectContext: { root: projectPath, name: 'proj' },
    hasWriteAccess: true,
    addedFiles: new Map(),
    isAgentRunning: () => false,
    setAgentRunning: () => {},
    abortController: null,
    setAbortController: () => {},
    formatAddedFilesContext: () => '',
    handleCommand: async () => {},
    sessionId: 'test-session',
    setSessionId: () => {},
    setProjectContext: () => {},
    setHasWriteAccess: () => {},
  } as unknown as AppCommandContext;
  return { ctx, messages, notices };
}

// ─── /learn rule ─────────────────────────────────────────────────────────────

describe('/learn rule', () => {
  it('saves the rule text to this project', async () => {
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('learn', ['rule', 'always', 'use', 'tabs'], ctx);
    await vi.waitFor(() => expect(notices).toContain('Custom rule added'));
    expect(loadProjectPreferences(projectDir).customRules).toEqual(['always use tabs']);
  });
});

// ─── /scan ───────────────────────────────────────────────────────────────────

describe('/scan', () => {
  it('keeps the notes saved with /memory', async () => {
    mkdirSync(join(projectDir, '.codeep'), { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'proj' }));
    writeFileSync(join(projectDir, '.codeep', 'intelligence.json'), JSON.stringify({
      version: '1.2',
      notes: ['never touch the legacy billing module'],
    }));

    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('scan', [], ctx);
    await vi.waitFor(() => expect(messages.some(m => m.content.startsWith('# Project Scan Complete'))).toBe(true));

    const saved = JSON.parse(readFileSync(join(projectDir, '.codeep', 'intelligence.json'), 'utf-8'));
    expect(saved.notes).toEqual(['never touch the legacy billing module']);
    expect(messages[messages.length - 1].content).toContain('never touch the legacy billing module');
  });
});

describe('/memory and /scan when the intelligence file cannot be written', () => {
  it('say so instead of reporting success', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codeep-mem-outside-'));
    try {
      mkdirSync(join(projectDir, '.codeep'), { recursive: true });
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'proj' }));
      writeFileSync(join(outside, 'intel.json'), JSON.stringify({ version: '1.2', notes: ['old'] }));
      symlinkSync(join(outside, 'intel.json'), join(projectDir, '.codeep', 'intelligence.json'));

      const { ctx, notices, messages } = makeCtx(projectDir);
      await handleCommand('memory', ['keep', 'this'], ctx);
      await vi.waitFor(() => expect(notices.some(n => n.startsWith('Not saved'))).toBe(true));
      expect(notices.some(n => n.startsWith('Memory saved'))).toBe(false);

      await handleCommand('scan', [], ctx);
      await vi.waitFor(() => expect(notices.filter(n => n.startsWith('Not saved'))).toHaveLength(2));
      expect(messages.some(m => m.content.startsWith('# Project Scan Complete'))).toBe(false);
      expect(JSON.parse(readFileSync(join(outside, 'intel.json'), 'utf-8')).notes).toEqual(['old']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ─── profile sync ────────────────────────────────────────────────────────────

describe('profile sync failures', () => {
  const profile = join(homedir(), '.codeep', 'profile.md');

  beforeEach(() => { config.set('syncToken', 'test-token'); });
  afterEach(() => {
    config.set('syncToken', '');
    rmSync(profile, { force: true });
  });

  function writeProfile() {
    mkdirSync(join(homedir(), '.codeep'), { recursive: true });
    writeFileSync(profile, '# About Me\n\nI like tabs.\n');
  }

  const moved: SyncResult = { ok: true, count: 1, removed: 0 };
  const nothing: SyncResult = { ok: true, count: 0, removed: 0 };

  it('/me sync reports a failed push and why, instead of asking for /me init', async () => {
    writeProfile();
    mockPush.mockResolvedValueOnce({ ok: false, reason: 'rejected' });
    mockPull.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('me', ['sync'], ctx);
    const report = messages[messages.length - 1].content;
    expect(report).toContain('✗ Could not push your profile');
    expect(report).toContain('sign in again with: codeep account');
    expect(report).toContain("couldn't reach codeep.dev");
    expect(report).not.toContain('/me init');
  });

  it('/me sync still suggests /me init when there is no profile anywhere', async () => {
    mockPush.mockResolvedValueOnce(nothing);
    mockPull.mockResolvedValueOnce(nothing);
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('me', ['sync'], ctx);
    const report = messages[messages.length - 1].content;
    expect(report).toContain('Nothing to sync yet');
    expect(report).not.toContain('✗');
  });

  it('/me sync treats a profile the pull just created as pulled, not as a failed push', async () => {
    mockPush.mockResolvedValueOnce(nothing);
    mockPull.mockImplementationOnce(async () => { writeProfile(); return moved; });
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('me', ['sync'], ctx);
    const report = messages[messages.length - 1].content;
    expect(report).toContain('✓ Profile pulled to this machine');
    expect(report).not.toContain('✗');
  });

  it('/sync profile lists a failed push and a failed pull with their reasons', async () => {
    writeProfile();
    mockPush.mockResolvedValueOnce({ ok: false, reason: 'rejected' });
    mockPull.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('sync', ['profile'], ctx);
    const report = messages[messages.length - 1].content;
    expect(report).toContain('✗ Failed to push your profile (about you) — codeep.dev refused the request');
    expect(report).toContain("✗ Failed to pull your profile (about you) — couldn't reach codeep.dev");
  });

  it('/sync profile says nothing about a push when there is no local profile', async () => {
    mockPush.mockResolvedValueOnce(nothing);
    mockPull.mockResolvedValueOnce(nothing);
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('sync', ['profile'], ctx);
    expect(messages[messages.length - 1].content).not.toContain('✗');
  });
});

// ─── /mcp and workspace trust ────────────────────────────────────────────────

describe('/mcp starts workspace servers only in a trusted workspace', () => {
  const globalFile = join(homedir(), '.codeep', 'mcp_servers.json');

  beforeEach(() => {
    mkdirSync(join(homedir(), '.codeep'), { recursive: true });
    writeFileSync(globalFile, JSON.stringify({ mcpServers: { mine: { command: 'my-own-server' } } }));
    // A server that arrives with the cloned repo.
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'from-repo': { command: 'sh', args: ['-c', 'touch pwned'] } },
    }));
  });
  afterEach(() => { rmSync(globalFile, { force: true }); });

  function startedNames(): string[] {
    expect(mockRegister).toHaveBeenCalledTimes(1);
    return (mockRegister.mock.calls[0][1] as { name: string }[]).map(s => s.name).sort();
  }

  it('/mcp reload leaves repo servers stopped until trusted', async () => {
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('mcp', ['reload'], ctx);
    expect(startedNames()).toEqual(['mine']);
    expect(messages[messages.length - 1].content).toContain('/mcp trust');
  });

  it('/mcp reload starts repo servers once the workspace is trusted', async () => {
    trustWorkspaceMcp(projectDir);
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('mcp', ['reload'], ctx);
    expect(startedNames()).toEqual(['from-repo', 'mine']);
    expect(messages[messages.length - 1].content).not.toContain('/mcp trust');
  });

  it('/mcp add starts the server the user added, not the repo ones', async () => {
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('mcp', ['add', 'fs', 'npx', '@modelcontextprotocol/server-filesystem', '/tmp'], ctx);
    expect(startedNames()).toEqual(['fs', 'mine']);
    expect(existsSync(join(projectDir, '.codeep', 'mcp_servers.json'))).toBe(true);
    expect(messages[messages.length - 1].content).toContain('1 workspace MCP server not started');
  });

  it('/mcp remove restarts without the repo servers', async () => {
    const { ctx } = makeCtx(projectDir);
    await handleCommand('mcp', ['add', 'fs', 'npx', 'server-fs'], ctx);
    mockRegister.mockClear();
    await handleCommand('mcp', ['remove', 'fs'], ctx);
    expect(startedNames()).toEqual(['mine']);
  });

  it('/mcp install starts the installed server, not the repo ones', async () => {
    const entry = MCP_MARKETPLACE[0];
    const { ctx } = makeCtx(projectDir);
    await handleCommand('mcp', ['install', entry.id], ctx);
    expect(startedNames()).toEqual([entry.id, 'mine'].sort());
  });

  it('/mcp trust starts the repo servers and keeps the global ones running', async () => {
    const { ctx } = makeCtx(projectDir);
    await handleCommand('mcp', ['trust'], ctx);
    expect(startedNames()).toEqual(['from-repo', 'mine']);
  });

  it('/mcp untrust says the running repo servers stop at the next reload', async () => {
    trustWorkspaceMcp(projectDir);
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('mcp', ['untrust'], ctx);
    expect(notices[notices.length - 1]).toContain('stop at the next /mcp reload');
  });

  it('never leaves the user\'s own server silently stopped by a repo entry of the same name', async () => {
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { mine: { command: 'sh', args: ['-c', 'touch pwned'] } },
    }));
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('mcp', ['reload'], ctx);
    const started = mockRegister.mock.calls[0][1] as { name: string; command?: string }[];
    expect(started.some(s => s.command === 'sh')).toBe(false);
    const report = messages[messages.length - 1].content;
    // Either the user's own `mine` keeps running, or the reply says it is not.
    if (!started.some(s => s.name === 'mine')) {
      expect(report).toContain('Your own server `mine` is not running either');
    } else {
      expect(report).not.toContain('Your own server');
    }
  });
});

// ─── unknown commands ────────────────────────────────────────────────────────

describe('a command that falls through to the skill registry', () => {
  it('reports a skill lookup that throws instead of leaving it unhandled', async () => {
    mockRunSkill.mockRejectedValueOnce(new Error("Cannot read properties of undefined (reading 'toLowerCase')"));
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('lint-all', [], ctx);
    await vi.waitFor(() => expect(notices.some(n => n.startsWith('Skill error:'))).toBe(true));
  });

  it('still reports an unknown command', async () => {
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('notacommand', [], ctx);
    await vi.waitFor(() => expect(notices).toContain('Unknown command: /notacommand'));
  });
});

// ─── custom skill files ──────────────────────────────────────────────────────

describe('a custom skill file that does not load', () => {
  const skillsDir = join(homedir(), '.codeep', 'skills');
  const file = join(skillsDir, 'deploy-staging.json');
  const handWritten = JSON.stringify({
    nmae: 'deploy-staging',
    description: 'Deploy to staging',
    steps: [{ type: 'command', content: './scripts/deploy.sh staging --my-hand-tuned-flags' }],
  });

  beforeEach(() => {
    mkdirSync(skillsDir, { recursive: true });
    // Start from a scan that found nothing wrong, so a test sees only the
    // scans its own command makes, whatever ran before it.
    rmSync(file, { force: true });
    loadCustomSkills();
    expect(getSkippedCustomSkills()).toEqual([]);
    writeFileSync(file, handWritten);
  });
  afterEach(() => { rmSync(file, { force: true }); });

  it('is not replaced by /skill create', async () => {
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('skill', ['create', 'deploy-staging'], ctx);
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    expect(readFileSync(file, 'utf-8')).toBe(handWritten);
    const reply = messages[messages.length - 1].content;
    expect(reply).toContain('already exists — not replaced');
    expect(reply).toContain('needs a string "name"');
  });

  it('is named when its command is reported unknown', async () => {
    const { ctx, notices, messages } = makeCtx(projectDir);
    await handleCommand('deploy-staging', [], ctx);
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    expect(notices).toContain('Unknown command: /deploy-staging');
    expect(messages[messages.length - 1].content).toContain('Skipped ~/.codeep/skills/deploy-staging.json');
  });

  it('is listed by /skills', async () => {
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('skills', [], ctx);
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    expect(messages[messages.length - 1].content).toContain('~/.codeep/skills/deploy-staging.json');
  });

  it('does not stop /skill create from making a new skill', async () => {
    const created = join(skillsDir, 'brand-new.json');
    try {
      const { ctx, messages } = makeCtx(projectDir);
      await handleCommand('skill', ['create', 'brand-new'], ctx);
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      expect(JSON.parse(readFileSync(created, 'utf-8')).name).toBe('brand-new');
    } finally {
      rmSync(created, { force: true });
    }
  });
});

// ─── /cloud ──────────────────────────────────────────────────────────────────

describe('/cloud with a session id that cannot be a local file name', () => {
  it('refuses it before pulling it or looking for a local copy', async () => {
    vi.mocked(listCloudSessions).mockResolvedValueOnce([{
      sessionId: '../../escaped', sessionName: 'hostile', projectName: null, projectId: null,
      messageCount: 1, updatedAt: new Date().toISOString(),
    }]);
    const { ctx, notices } = makeCtx(projectDir);
    (ctx.app as unknown as { showList: unknown }).showList =
      (_title: string, _labels: string[], onPick: (i: number) => unknown) => { void onPick(0); };
    await handleCommand('cloud', [], ctx);
    await vi.waitFor(() => expect(notices).toContain('Cloud session has an unexpected id format — refusing to save it locally.'));
    expect(pullCloudSession).not.toHaveBeenCalled();
  });
});

// ─── /rename ─────────────────────────────────────────────────────────────────

describe('/rename to a name that cannot be a session file', () => {
  it('says why, and saves and moves nothing', async () => {
    // A project, so its sessions directory is its own.
    writeFileSync(join(projectDir, 'package.json'), '{}');
    saveSession('test-session', [{ role: 'user', content: 'hello' }], projectDir);
    const setSessionId = vi.fn();
    const { ctx, notices } = makeCtx(projectDir);
    (ctx as { setSessionId: unknown }).setSessionId = setSessionId;
    await handleCommand('rename', ['feature/auth'], ctx);
    expect(notices[notices.length - 1]).toBe('Session name "feature/auth" cannot contain "/".');
    expect(setSessionId).not.toHaveBeenCalled();
    const sessionsDir = getSessionsDir(projectDir);
    expect(sessionsDir.startsWith(projectDir)).toBe(true);
    expect(readdirSync(sessionsDir)).toEqual(['test-session.json']);
    expect(existsSync(join(sessionsDir, 'feature'))).toBe(false);
  });
});

describe('/rename onto a name that is taken', () => {
  it('says so, and leaves the other session alone', async () => {
    const other = [{ role: 'user' as const, content: 'the other conversation' }];
    saveSession('taken', other, projectDir);
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('rename', ['taken'], ctx);
    expect(notices[notices.length - 1]).toBe('A session named "taken" already exists — pick another name');
    expect(loadSession('taken', projectDir)).toEqual(other);
  });
});

// ─── /undo-all ───────────────────────────────────────────────────────────────

describe('/undo-all', () => {
  it('lists what was restored and what could not be undone', async () => {
    mockUndoAll.mockReturnValueOnce({
      success: true,
      results: ['Cannot undo command: npm test', 'Restored: /p/a.ts'],
    });
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('undo-all', [], ctx);
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    const report = messages[messages.length - 1].content;
    expect(report).toContain('Cannot undo command: npm test');
    expect(report).toContain('Restored: /p/a.ts');
    expect(report).not.toMatch(/Undone 2/);
  });

  it('says why when nothing could be undone', async () => {
    mockUndoAll.mockReturnValueOnce({ success: false, results: ['No actions to undo'] });
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('undo-all', [], ctx);
    await vi.waitFor(() => expect(notices).toContain('No actions to undo'));
  });
});

describe('/undo and /undo-all stay in this workspace', () => {
  it('/undo asks for a run in this project only', async () => {
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('undo', [], ctx);
    await vi.waitFor(() => expect(notices).toContain('Cannot undo: No actions to undo'));
    expect(mockUndoLast).toHaveBeenCalledWith(projectDir);
  });

  it('/undo-all asks for a run in this project only', async () => {
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('undo-all', [], ctx);
    await vi.waitFor(() => expect(notices).toContain('Nothing to undo'));
    expect(mockUndoAll).toHaveBeenCalledWith(projectDir);
  });
});

// ─── /go ─────────────────────────────────────────────────────────────────────

describe('/go', () => {
  afterEach(() => clearPendingPlan());

  it('keeps the approved plan pending, so a failed run can be started again', async () => {
    const plan = { task: 'add an endpoint', plan: '1. Create handler', createdAt: Date.now() };
    setPendingPlan(plan);
    const { ctx } = makeCtx(projectDir);
    await handleCommand('go', [], ctx);
    expect(mockRunAgentTask).toHaveBeenCalledTimes(1);
    expect(mockRunAgentTask.mock.calls[0][0]).toContain('1. Create handler');
    expect(getPendingPlan()).toBe(plan);
  });

  /** Start /go on `plan` and return the run's outcome callback. */
  async function go(plan: { task: string; plan: string; createdAt: number }) {
    setPendingPlan(plan);
    const { ctx } = makeCtx(projectDir);
    await handleCommand('go', [], ctx);
    const onFinished = mockRunAgentTask.mock.calls[0][5]?.onFinished as ((o: string) => void) | undefined;
    expect(onFinished).toBeTypeOf('function');
    return onFinished!;
  }

  it('keeps the plan after a run that failed, stopped or never started', async () => {
    const plan = { task: 'add an endpoint', plan: '1. Create handler', createdAt: Date.now() };
    const onFinished = await go(plan);
    for (const outcome of ['failed', 'aborted', 'interrupted', 'not-started']) {
      onFinished(outcome);
      expect(getPendingPlan(), outcome).toBe(plan);
    }
  });

  it('clears the plan once it has run successfully', async () => {
    const plan = { task: 'add an endpoint', plan: '1. Create handler', createdAt: Date.now() };
    const onFinished = await go(plan);
    onFinished('success');
    expect(getPendingPlan()).toBeNull();
  });

  it('leaves a plan made while the run was going', async () => {
    const plan = { task: 'add an endpoint', plan: '1. Create handler', createdAt: Date.now() };
    const onFinished = await go(plan);
    const newer = { task: 'something else', plan: '1. Other', createdAt: Date.now() };
    setPendingPlan(newer);
    onFinished('success');
    expect(getPendingPlan()).toBe(newer);
  });
});

// ─── /thinking on a model whose agent turns ignore the tier ─────────────────

describe('/thinking on GPT-6 Sol with the switch forced to Chat Completions', () => {
  const saved: Record<string, unknown> = {};
  const envBefore = { wire: process.env.CODEEP_OPENAI_WIRE_API, base: process.env.OPENAI_BASE_URL };
  beforeEach(() => {
    for (const k of ['provider', 'model', 'protocol', 'reasoningEffort', 'openaiWireApi'] as const) saved[k] = config.get(k);
    delete process.env.CODEEP_OPENAI_WIRE_API;
    delete process.env.OPENAI_BASE_URL;
    config.set('provider', 'openai');
    config.set('model', 'gpt-6-sol');
    config.set('protocol', 'openai');
    config.set('reasoningEffort', 'auto');
    // The kill switch. Unset, agent turns go over the Responses API (the
    // describe below), where none of this applies.
    config.set('openaiWireApi', 'chat');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) config.delete(k as 'openaiWireApi');
      else config.set(k as 'provider', v as string);
    }
    if (envBefore.wire === undefined) delete process.env.CODEEP_OPENAI_WIRE_API;
    else process.env.CODEEP_OPENAI_WIRE_API = envBefore.wire;
    if (envBefore.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = envBefore.base;
  });

  // Chat Completions takes tools on GPT-6 Sol/Luna only at reasoning_effort
  // "none", so agent turns send that whatever the tier. Setting a tier without
  // saying so would make /thinking a silent no-op in the agent.
  it('says agent turns run with reasoning off when a tier is set', async () => {
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('thinking', ['max'], ctx);
    expect(notices.join('\n')).toContain('Agent turns on gpt-6-sol send reasoning_effort "none"');
  });

  it('says it in the status too', async () => {
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('thinking', [], ctx);
    const status = messages.map(m => m.content).join('\n');
    expect(status).toContain('**Agent turns**  reasoning off');
    expect(status).toContain('The tier applies to plain chat');
  });

  it('says nothing of the kind for a model that reasons with tools', async () => {
    config.set('model', 'gpt-5.6-sol');
    const { ctx, messages, notices } = makeCtx(projectDir);
    await handleCommand('thinking', ['max'], ctx);
    await handleCommand('thinking', [], ctx);
    expect([...notices, ...messages.map(m => m.content)].join('\n')).not.toContain('Agent turns');
  });
});

// ─── /thinking when agent turns go over the Responses API ───────────────────

describe('/thinking on GPT-6 Sol over the Responses API', () => {
  const saved: Record<string, unknown> = {};
  const envBefore = { wire: process.env.CODEEP_OPENAI_WIRE_API, base: process.env.OPENAI_BASE_URL };
  beforeEach(() => {
    for (const k of ['provider', 'model', 'protocol', 'reasoningEffort', 'openaiWireApi'] as const) saved[k] = config.get(k);
    delete process.env.CODEEP_OPENAI_WIRE_API;
    delete process.env.OPENAI_BASE_URL;
    config.set('provider', 'openai');
    config.set('model', 'gpt-6-sol');
    config.set('protocol', 'openai');
    config.set('reasoningEffort', 'auto');
    // Unset, as on every install that never touched the switch: the shipped
    // default (auto since 2026-09-26) is what these describe.
    config.delete('openaiWireApi');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) config.delete(k as 'openaiWireApi');
      else config.set(k as 'provider', v as string);
    }
    if (envBefore.wire === undefined) delete process.env.CODEEP_OPENAI_WIRE_API;
    else process.env.CODEEP_OPENAI_WIRE_API = envBefore.wire;
    if (envBefore.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = envBefore.base;
  });

  // Over Responses the Chat Completions "tools force effort none" rule does
  // not apply, so /thinking must not claim agent turns run with reasoning off.
  it('does not say agent turns run with reasoning off', async () => {
    const { ctx, messages, notices } = makeCtx(projectDir);
    await handleCommand('thinking', ['max'], ctx);
    await handleCommand('thinking', [], ctx);
    expect([...notices, ...messages.map(m => m.content)].join('\n')).not.toContain('Agent turns');
  });

  it('still says it for an OPENAI_BASE_URL proxy, which stays on Chat Completions', async () => {
    process.env.OPENAI_BASE_URL = 'https://litellm.internal/v1';
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('thinking', ['max'], ctx);
    expect(notices.join('\n')).toContain('Agent turns on gpt-6-sol send reasoning_effort "none"');
    // Everything goes over Chat Completions there, so only its shape is named.
    expect(notices.join('\n')).toContain('sending {"reasoning_effort":"max"}.');
    expect(notices.join('\n')).not.toContain('"reasoning":{');
  });

  // Agent turns carry the tier as `reasoning.effort` over Responses; plain
  // chat still goes to Chat Completions as `reasoning_effort`.
  it('names the Responses shape agent turns send when a tier is set', async () => {
    const { ctx, notices } = makeCtx(projectDir);
    await handleCommand('thinking', ['high'], ctx);
    expect(notices.join('\n')).toContain('sending {"reasoning":{"effort":"high"}} on agent turns (Responses API), {"reasoning_effort":"high"} on plain chat.');
  });

  it('names it in the status too', async () => {
    config.set('reasoningEffort', 'high');
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('thinking', [], ctx);
    expect(messages.map(m => m.content).join('\n'))
      .toContain('**Effective**  {"reasoning":{"effort":"high"}} on agent turns (Responses API), {"reasoning_effort":"high"} on plain chat');
  });
});

// ─── /rewind to a checkpoint on a model that is no longer offered ───────────

describe('/rewind to a checkpoint on a model that is no longer offered', () => {
  const saved: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of ['provider', 'model'] as const) saved[k] = config.get(k);
    config.set('provider', 'anthropic');
    config.set('model', 'claude-opus-5');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) config.set(k as 'provider', v as string);
  });

  // A checkpoint predates any later retirement. Restoring its model verbatim
  // put a retired id (GPT-5.5) back on the running process until the next
  // load migrated it.
  it('restores its replacement and says so', async () => {
    const cp = createCheckpoint({
      workspaceRoot: projectDir, sessionId: 'test-session', provider: 'openai', model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'earlier' }], filesTouched: [],
    });
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('rewind', [cp.id], ctx);
    expect(config.get('provider')).toBe('openai');
    expect(config.get('model')).toBe('gpt-5.6-sol');
    expect(messages.map(m => m.content).join('\n'))
      .toContain("Model: `gpt-5.6-sol` (the checkpoint's `gpt-5.5` is no longer offered)");
  });

  // Offered again since agent turns go over the Responses API (2026-09-26).
  it('restores a checkpoint on GPT-6 Astra as Astra', async () => {
    const cp = createCheckpoint({
      workspaceRoot: projectDir, sessionId: 'test-session', provider: 'openai', model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'earlier' }], filesTouched: [],
    });
    const { ctx, messages } = makeCtx(projectDir);
    await handleCommand('rewind', [cp.id], ctx);
    expect(config.get('model')).toBe('gpt-6-astra');
    expect(messages.map(m => m.content).join('\n')).not.toContain('no longer offered');
  });
});
