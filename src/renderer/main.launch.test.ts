import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeForClarification } from '../utils/interactive';

// `codeep --yolo` and the launch prompt, run the way the binary runs them:
// main() reads process.argv and goes through the whole startup. The App is a
// recorder, so what the startup asked the user — and in what order the
// prompt went in — can be read back. Nothing here reaches the network, the
// keychain or a model.
const ui = vi.hoisted(() => ({
  options: null as null | Record<string, unknown>,
  calls: [] as Array<{ method: string; args: unknown[] }>,
  /** What runAgentTask does beyond being recorded; see the mock below. */
  onRun: null as null | ((...args: unknown[]) => unknown),
}));
vi.mock('./App', () => ({
  App: class {
    constructor(options: Record<string, unknown>) {
      ui.options = options;
      return new Proxy({}, {
        get: (_target, key) => {
          // Not a thenable: something awaiting the app must not hang on it.
          if (key === 'then') return undefined;
          return (...args: unknown[]) => {
            ui.calls.push({ method: String(key), args });
            return key === 'getMessages' || key === 'getChatHistory' ? [] : undefined;
          };
        },
      });
    }
  },
}));
vi.mock('../utils/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git')>()),
  getGitStatus: vi.fn(() => ({ isRepo: false })),
}));
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  logAppError: vi.fn(),
}));
vi.mock('../config/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/index')>()),
  loadAllApiKeys: vi.fn(async () => {}),
  loadApiKey: vi.fn(async () => 'test-key'),
  fetchOllamaModels: vi.fn(async () => null),
  setProjectPermission: vi.fn(),
  initializeAsProject: vi.fn(),
}));
vi.mock('../utils/codeepCloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/codeepCloud')>()),
  ensureDeviceRegistered: vi.fn(),
}));
vi.mock('../utils/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/update')>()),
  checkForUpdates: vi.fn(async () => ({ hasUpdate: false })),
}));
vi.mock('../utils/telegramCredentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/telegramCredentials')>()),
  loadTelegramInboxCredentials: vi.fn(async () => null),
}));
vi.mock('../utils/mcpRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/mcpRegistry')>()),
  registerSessionServers: vi.fn(async () => ({ registered: [], errors: [] })),
}));
// Where a submitted prompt lands with Agent Mode on (the default). `ui.onRun`
// lets a test hold the run for clarifying questions the way the real one
// does, and executeAgentTask is where the answer to them goes.
vi.mock('./agentExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentExecution')>()),
  runAgentTask: vi.fn(async (...args: unknown[]) => { await ui.onRun?.(...args); }),
  executeAgentTask: vi.fn(async () => 'success'),
}));
// Recorded, so a test can tell when startup has read the MCP config.
vi.mock('../utils/mcpConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/mcpConfig')>();
  return { ...actual, selectSessionMcpServers: vi.fn(actual.selectSessionMcpServers) };
});

const savedArgv = process.argv;
const savedCwd = process.cwd();
let folder: string;

/** Start main.ts as `codeep <args…>` in a fresh folder that is not a repository. */
async function launch(...args: string[]) {
  process.argv = ['node', 'codeep', ...args];
  vi.resetModules();
  const config = await import('../config/index');
  const pins = await import('./agentConfirmation');
  const { runAgentTask, executeAgentTask } = await import('./agentExecution');
  const { selectSessionMcpServers } = await import('../utils/mcpConfig');
  vi.mocked(config.setProjectPermission).mockClear();
  vi.mocked(config.initializeAsProject).mockClear();
  vi.mocked(runAgentTask).mockClear();
  vi.mocked(executeAgentTask).mockClear();
  const set = vi.spyOn(config.config, 'set');
  const { main } = await import('./main');
  await main();
  return {
    config,
    set,
    pins,
    agentConfirmationMode: pins.agentConfirmationMode,
    runAgentTask: vi.mocked(runAgentTask),
    executeAgentTask: vi.mocked(executeAgentTask),
    selectSessionMcpServers: vi.mocked(selectSessionMcpServers),
  };
}

const called = (method: string) => ui.calls.filter(c => c.method === method);
const titles = () => called('showConfirm').map(c => (c.args[0] as { title: string }).title);
const userMessages = () => called('addMessage')
  .map(c => c.args[0] as { role: string; content: string })
  .filter(m => m.role === 'user')
  .map(m => m.content);

beforeEach(() => {
  // realpath: main.ts reads process.cwd(), which resolves a symlinked TMPDIR.
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-launch-')));
  process.chdir(folder);
  ui.options = null;
  ui.calls = [];
  ui.onRun = null;
  // The 30-second Ollama health check must not outlive the test.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  process.chdir(savedCwd);
  process.argv = savedArgv;
  vi.restoreAllMocks();
  rmSync(folder, { recursive: true, force: true });
});

describe('codeep --yolo', () => {
  it('starts without asking anything, and saves none of the answers it gave', async () => {
    const { config: stored, saveSession } = await import('../config/index');
    const before = stored.get('agentConfirmation');
    // A session to offer, so skipping the picker is a decision and not an
    // empty list.
    saveSession('yesterday', [{ role: 'user', content: 'hello' }], folder);
    const { config, set, agentConfirmationMode, pins } = await launch('--yolo');

    // No "Set as Project?", no access dialog, no session picker.
    expect(titles()).toEqual([]);
    expect(called('showPermission')).toEqual([]);
    expect(called('showSessionPicker')).toEqual([]);

    // Read & write for this process — and none of it written anywhere.
    expect(ui.options?.hasWriteAccess).toBeTypeOf('function');
    expect((ui.options?.hasWriteAccess as () => boolean)()).toBe(true);
    expect((ui.options?.hasProjectContext as () => boolean)()).toBe(true);
    expect(config.setProjectPermission).not.toHaveBeenCalled();
    expect(config.initializeAsProject).not.toHaveBeenCalled();
    expect(existsSync(join(folder, '.codeep', 'project.json'))).toBe(false);

    // Never mode and no clarifying questions for this process; the config
    // still says what it said.
    expect(agentConfirmationMode()).toBe('never');
    expect(pins.agentInteractiveMode()).toBe(false);
    // (Conf's overloads type the key as an object; it is the string here.)
    expect(set.mock.calls.map(([key]) => key as unknown)).not.toContain('agentConfirmation');
    expect(set.mock.calls.map(([key]) => key as unknown)).not.toContain('agentInteractive');
    expect(config.config.get('agentConfirmation')).toBe(before);

    // And the status bar is told, so it can say so — for as long as it holds.
    expect((ui.options?.yolo as () => boolean)()).toBe(true);
    pins.pinAgentConfirmation(null);
    expect((ui.options?.yolo as () => boolean)()).toBe(false);
  });

  it('sends a prompt after -- into a new session, as if it had been typed', async () => {
    const { runAgentTask } = await launch('--yolo', '--', 'add', 'a', 'README');

    await vi.waitFor(() => expect(runAgentTask).toHaveBeenCalledTimes(1));
    expect(userMessages()).toEqual(['add a README']);
    expect(called('setLoading').map(c => c.args[0])).toEqual([true]);
    expect(runAgentTask).toHaveBeenCalledTimes(1);
    expect(runAgentTask.mock.calls[0][0]).toBe('add a README');
    expect(titles()).toEqual([]);
  });

  it('keeps a prompt that names a subcommand a prompt', async () => {
    const { runAgentTask } = await launch('--yolo', '--', 'review');
    await vi.waitFor(() => expect(runAgentTask).toHaveBeenCalledTimes(1));
    expect(runAgentTask.mock.calls[0][0]).toBe('review');
  });
});

describe('a launch prompt without --yolo', () => {
  it('waits for the usual questions, then sends the prompt instead of offering a session', async () => {
    const { config, agentConfirmationMode, runAgentTask } = await launch('-p', 'add a README');

    // Nothing has been sent while the first question is still open.
    expect(titles()).toEqual(['Set as Project?']);
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(userMessages()).toEqual([]);

    (called('showConfirm')[0].args[0] as { onConfirm: () => void }).onConfirm();
    expect(config.initializeAsProject).toHaveBeenCalledWith(folder);
    expect(runAgentTask).not.toHaveBeenCalled();

    // The access dialog is answered the ordinary way, and saved as before.
    const [, , answer] = called('showPermission')[0].args as [string, boolean, (level: string) => void];
    answer('write');
    expect(config.setProjectPermission).toHaveBeenCalledWith(folder, true, true);

    await vi.waitFor(() => expect(runAgentTask).toHaveBeenCalledTimes(1));
    expect(userMessages()).toEqual(['add a README']);
    expect(runAgentTask.mock.calls[0][0]).toBe('add a README');
    expect(called('showSessionPicker')).toEqual([]);
    // Without --yolo the run asks as configured.
    expect(agentConfirmationMode()).toBe(config.config.get('agentConfirmation') || 'dangerous');
    expect((ui.options?.yolo as () => boolean)()).toBe(false);
  });

  it('still offers the saved sessions to a plain `codeep`', async () => {
    const { saveSession } = await import('../config/index');
    saveSession('yesterday', [{ role: 'user', content: 'hello' }], folder);
    const { runAgentTask } = await launch();

    (called('showConfirm')[0].args[0] as { onConfirm: () => void }).onConfirm();
    (called('showPermission')[0].args[2] as (level: string) => void)('write');

    expect(called('showSessionPicker')).toHaveLength(1);
    expect(runAgentTask).not.toHaveBeenCalled();
  });
});

describe('a launch prompt in a workspace with its own MCP servers', () => {
  const writeWorkspaceServers = () => writeFileSync(join(folder, '.mcp.json'),
    JSON.stringify({ mcpServers: { tools: { command: 'tools-cmd' } } }));

  // App.showConfirm replaces an open confirm without answering it. Sent beside
  // the trust question, the run's own "Potentially Dangerous Task" took its
  // place or lost its own, and the prompt never ran.
  for (const args of [['-p', 'remove the unused files'], ['--yolo', '--', 'remove the unused files']]) {
    it(`is sent once the trust question is answered: codeep ${args.join(' ')}`, async () => {
      const { config: stored } = await import('../config/index');
      writeWorkspaceServers();
      // Access already granted, so the trust question is the only one asked.
      stored.set('projectPermissions', [
        { path: folder, readPermission: true, writePermission: true, grantedAt: new Date().toISOString() },
      ]);
      const { runAgentTask } = await launch(...args);

      await vi.waitFor(() => expect(titles()).toEqual(['Trust workspace MCP servers?']));
      expect(runAgentTask).not.toHaveBeenCalled();
      expect(userMessages()).toEqual([]);

      (called('showConfirm')[0].args[0] as { onCancel: () => void }).onCancel();
      await vi.waitFor(() => expect(runAgentTask).toHaveBeenCalledTimes(1));
      expect(userMessages()).toEqual(['remove the unused files']);
    });
  }

  it('asks the trust question after the startup questions, not over them', async () => {
    // Raised while "Set as Project?" was up, it took that question's place,
    // and the startup waiting on that answer never went on.
    writeWorkspaceServers();
    const { runAgentTask, selectSessionMcpServers } = await launch('-p', 'add a README');

    // The MCP config is read and the trust question is ready to ask.
    await vi.waitFor(() => expect(selectSessionMcpServers).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(titles()).toEqual(['Set as Project?']);

    (called('showConfirm')[0].args[0] as { onConfirm: () => void }).onConfirm();
    (called('showPermission')[0].args[2] as (level: string) => void)('write');
    await vi.waitFor(() => expect(titles()).toEqual(['Set as Project?', 'Trust workspace MCP servers?']));
    expect(runAgentTask).not.toHaveBeenCalled();

    // Trusted: sent once their servers are started, so the run has their tools.
    (called('showConfirm')[1].args[0] as { onConfirm: () => void }).onConfirm();
    await vi.waitFor(() => expect(runAgentTask).toHaveBeenCalledTimes(1));
    expect(userMessages()).toEqual(['add a README']);
  });
});

describe('the answer to clarifying questions', () => {
  it('runs without "Confirm Agent Task" under --yolo, as the run itself would', async () => {
    // Held for questions the way runAgentTask holds a vague task. Under --yolo
    // that takes Agent Interactive Mode switched back on in /settings, which
    // ends that pin and leaves the confirmation one in force.
    ui.onRun = (task, _dryRun, _ctx, _getPending, setPending) => {
      (setPending as (v: unknown) => void)({
        originalTask: task, context: analyzeForClarification(task as string), dryRun: false,
      });
    };
    const { config, pins, runAgentTask, executeAgentTask } = await launch('--yolo');
    const before = config.config.get('agentConfirmation');
    config.config.set('agentConfirmation', 'always');
    const submit = ui.options?.onSubmit as (text: string) => Promise<void>;

    try {
      await submit('refactor my waybar config');
      expect(runAgentTask).toHaveBeenCalledTimes(1);
      await submit('proceed');
      expect(executeAgentTask).toHaveBeenCalledTimes(1);
      expect(titles()).toEqual([]);

      // The stored 'always' once nothing is pinned, as a control.
      pins.pinAgentConfirmation(null);
      await submit('refactor my waybar config');
      await submit('proceed');
      expect(titles()).toEqual(['⚠️  Confirm Agent Task']);
      expect(executeAgentTask).toHaveBeenCalledTimes(1);
    } finally {
      config.config.set('agentConfirmation', before);
    }
  });
});

describe('a command line that cannot mean what it says', () => {
  it('exits with the reason instead of starting without the prompt', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);

    await expect(launch('--yolo', '-p')).rejects.toThrow('exit 1');
    expect(errors.join('\n')).toContain('-p needs a value');
    expect(ui.options).toBeNull(); // the TUI never started
  });
});
