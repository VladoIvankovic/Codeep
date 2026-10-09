import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Conf from 'conf';
import { analyzeForClarification } from '../utils/interactive';
import { PROVIDERS } from '../config/providers';
import { handleInlineConfirmKey, confirmFooter } from './handlers';
import type { ConfirmOptions } from './App';

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
  // Startup pulls the learning preferences of a linked machine, and the
  // welcome tests below link it: unmocked, that was a real request to
  // codeep.dev with a test token.
  pullLearning: vi.fn(async () => null),
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
// The config watch main() starts for the welcome block, kept so each test can
// stop it: fs.watchFile outlives vi.resetModules(), and a watch left over from
// an earlier launch would rewrite the welcome from that launch's state. It
// polls every 50 ms rather than every two seconds, so a write by another
// process shows within a test's wait.
const watches = vi.hoisted(() => [] as Array<{ stop(): void }>);
vi.mock('./configWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./configWatch')>();
  return {
    ...actual,
    watchConfig: (...[target, onChange, options]: Parameters<typeof actual.watchConfig>) => {
      const watch = actual.watchConfig(target, onChange, { ...options, pollMs: 50 });
      watches.push(watch);
      return watch;
    },
  };
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

/** Every request a launch tried to send. A failed one is swallowed — the
 *  startup syncs are best-effort — so it is counted here and fails the test.
 *  Refused for the whole file, between tests too: codeepCloud retries after
 *  1 s and 2 s, and a retry that lands after its test must not find the real
 *  fetch. It counts against the test that is running then. */
const requests: string[] = [];
const refuse = async (url: unknown) => {
  requests.push(String(url));
  throw new Error(`test tried to reach ${String(url)}`);
};

afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.stubGlobal('fetch', refuse);
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
  for (const watch of watches.splice(0)) watch.stop();
  vi.useRealTimers();
  vi.stubGlobal('fetch', refuse);
  process.chdir(savedCwd);
  process.argv = savedArgv;
  vi.restoreAllMocks();
  rmSync(folder, { recursive: true, force: true });
  expect(requests.splice(0), 'requests sent from a launch').toEqual([]);
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

// One key answers only a question that approves no agent action and grants
// no trust. Each question main.ts asks, fed the key "y" the way the App feeds
// it, either answers or only moves the selection; its hint says which.
describe('which of the startup and follow-up questions one key answers', () => {
  /** What "y" does to a confirmation built with these options. */
  function pressY(options: ConfirmOptions): 'answers' | 'selects' {
    let answered = false;
    handleInlineConfirmKey({ key: 'y', ctrl: false, alt: false, shift: false, raw: 'y' }, {
      options,
      selection: 'no',
      setSelection: () => {},
      close: () => { answered = true; },
      render: () => {},
    });
    expect(confirmFooter(options).includes('y/n quick'), `the hint of "${options.title}"`).toBe(answered);
    return answered ? 'answers' : 'selects';
  }
  const dialog = (index: number) => called('showConfirm')[index].args[0] as ConfirmOptions;

  it('"Set as Project?" answers on one key', async () => {
    await launch();
    expect(titles()).toEqual(['Set as Project?']);
    expect(pressY(dialog(0))).toBe('answers');
  });

  it('"Trust workspace MCP servers?" waits for Enter', async () => {
    const { config: stored } = await import('../config/index');
    writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'tools-cmd' } } }));
    stored.set('projectPermissions', [
      { path: folder, readPermission: true, writePermission: true, grantedAt: new Date().toISOString() },
    ]);
    await launch();
    await vi.waitFor(() => expect(titles()).toEqual(['Trust workspace MCP servers?']));
    expect(pressY(dialog(0))).toBe('selects');
    dialog(0).onCancel?.();
  });

  // The task as enhanced with the answers to clarifying questions, which
  // main.ts confirms itself.
  async function followUpDialog(mode: 'always' | 'dangerous', task: string): Promise<ConfirmOptions> {
    ui.onRun = (t, _dryRun, _ctx, _getPending, setPending) => {
      (setPending as (v: unknown) => void)({
        originalTask: t, context: analyzeForClarification(t as string), dryRun: false,
      });
    };
    const { config, pins } = await launch('--yolo');
    pins.pinAgentConfirmation(null);
    const before = config.config.get('agentConfirmation');
    config.config.set('agentConfirmation', mode);
    try {
      const submit = ui.options?.onSubmit as (text: string) => Promise<void>;
      await submit(task);
      await submit('proceed');
      expect(titles()).toHaveLength(1);
      return dialog(0);
    } finally {
      config.config.set('agentConfirmation', before);
    }
  }

  it('"Confirm Agent Task" starts a task on one key, but not one that reads as dangerous', async () => {
    const plain = await followUpDialog('always', 'refactor my waybar config');
    expect(plain.title).toBe('⚠️  Confirm Agent Task');
    expect(pressY(plain)).toBe('answers');

    ui.calls = [];
    const risky = await followUpDialog('always', 'remove my waybar config');
    expect(risky.title).toBe('⚠️  Confirm Agent Task');
    expect(pressY(risky)).toBe('selects');
  });

  it('"Potentially Dangerous Task" waits for Enter', async () => {
    const risky = await followUpDialog('dangerous', 'remove my waybar config');
    expect(risky.title).toBe('⚠️  Potentially Dangerous Task');
    expect(pressY(risky)).toBe('selects');
  });
});

// The welcome block is written before the startup questions are answered.
// On the Omarchy box it still said "Chat only · no project context" after
// "Set as Project? → Yes" and "Folder Access → Read & Write".
describe('the welcome block', () => {
  /** The welcome as it reads now: the first one added, or its latest update. */
  const welcome = () => {
    const updates = called('updateWelcome');
    if (updates.length > 0) return updates[updates.length - 1].args[0] as string;
    const added = called('addMessage').map(c => c.args[0] as { role: string; content: string })
      .find(m => m.role === 'welcome');
    return added?.content ?? '';
  };

  it('shows the access granted at startup once it is granted', async () => {
    await launch();
    // Asked, not yet answered: it does not claim a mode it cannot know.
    expect(welcome()).not.toContain('Chat only');
    expect(welcome()).not.toContain('Access');

    (called('showConfirm')[0].args[0] as { onConfirm: () => void }).onConfirm();
    (called('showPermission')[0].args[2] as (level: string) => void)('write');

    expect(welcome()).toContain(`Project  ${folder}`);
    expect(welcome()).toContain('Access   Read & Write');
    expect(welcome()).not.toContain('Chat only');
  });

  it('shows read-only access, and chat only when that was the answer', async () => {
    await launch();
    (called('showConfirm')[0].args[0] as { onConfirm: () => void }).onConfirm();
    (called('showPermission')[0].args[2] as (level: string) => void)('read');
    expect(welcome()).toContain('Access   Read Only');

    ui.calls = [];
    await launch();
    (called('showConfirm')[0].args[0] as { onCancel: () => void }).onCancel();
    expect(welcome()).toContain('Mode     Chat only');
  });

  it('follows /grant', async () => {
    await launch();
    (called('showConfirm')[0].args[0] as { onConfirm: () => void }).onConfirm();
    (called('showPermission')[0].args[2] as (level: string) => void)('read');
    expect(welcome()).toContain('Access   Read Only');

    await (ui.options?.onCommand as (command: string, args: string[]) => Promise<void>)('grant', []);
    expect(welcome()).toContain('Access   Read & Write');
  });

  it('shows read & write from the start under --yolo, which asks nothing', async () => {
    await launch('--yolo');
    expect(welcome()).toContain('Access   Read & Write');
    expect(welcome()).not.toContain('Chat only');
  });

  // Until 3.10.1 everything but the access stayed as it was at startup:
  // /provider, /model, /agent, or `codeep account` in another terminal,
  // showed only after a restart.
  describe('follows the config', () => {
    /** The config as a test found it, put back however the test ends. */
    async function keep(...keys: string[]): Promise<() => void> {
      const { config } = await import('../config/index');
      const store = config as unknown as { get(key: string): unknown; set(key: string, value: unknown): void };
      const saved = keys.map(key => [key, store.get(key)] as const);
      return () => { for (const [key, value] of saved) store.set(key, value); };
    }
    const refreshes = () => called('updateWelcome').length;

    it('changed by /provider and /model', async () => {
      const restore = await keep('provider', 'model', 'protocol');
      try {
        const { config } = await launch('--yolo');
        config.setProvider('openai');
        await vi.waitFor(() => expect(welcome().split('\n')[0])
          .toContain(`  ·  ${PROVIDERS.openai.name}  ·  ${PROVIDERS.openai.defaultModel}`));

        config.config.set('model', 'a-model-picked-by-hand');
        await vi.waitFor(() => expect(welcome().split('\n')[0])
          .toContain(`  ·  ${PROVIDERS.openai.name}  ·  a-model-picked-by-hand`));
      } finally {
        restore();
      }
    });

    it('changed by /agent', async () => {
      const restore = await keep('agentMode');
      try {
        const { config: stored } = await import('../config/index');
        stored.set('agentMode', 'off');
        const { config } = await launch('--yolo');
        expect(welcome()).not.toContain('Agent Mode ON');

        config.config.set('agentMode', 'on');
        await vi.waitFor(() => expect(welcome()).toContain('Agent Mode ON'));
        config.config.set('agentMode', 'off');
        await vi.waitFor(() => expect(welcome()).not.toContain('Agent Mode ON'));
      } finally {
        restore();
      }
    });

    it('in its account line, which a sync token decides and not a GitHub id', async () => {
      const restore = await keep('githubId', 'syncToken');
      try {
        const { config } = await launch('--yolo');
        expect(welcome()).toContain('Account  not linked');

        // An older link, which never got its token: `account sync` says "Not
        // linked", so the welcome must too.
        const before = refreshes();
        config.config.set('githubId', '4242');
        await vi.waitFor(() => expect(refreshes()).toBeGreaterThan(before));
        expect(welcome()).toContain('Account  not linked');

        config.config.set('syncToken', 'sync-token');
        await vi.waitFor(() => expect(welcome()).toContain('Account  codeep.dev linked'));
      } finally {
        restore();
      }
    });

    it('written by another process: `codeep account` in another terminal', async () => {
      const restore = await keep('syncToken');
      try {
        await launch('--yolo');
        expect(welcome()).toContain('Account  not linked');

        // A Conf of its own on the same file, as another `codeep` has: a real
        // atomic write, and no event in this process.
        const other = new Conf<Record<string, unknown>>({ projectName: 'codeep', cwd: process.env.CODEEP_CONFIG_DIR });
        other.set('syncToken', 'linked-in-another-terminal');
        await vi.waitFor(() => expect(welcome()).toContain('Account  codeep.dev linked'), { timeout: 3000 });
      } finally {
        restore();
      }
    });

    it('with reads alone, so a refresh never writes and never sets off another', async () => {
      const restore = await keep('provider', 'model', 'protocol');
      try {
        const { config, set } = await launch('--yolo');
        set.mockClear();

        // A provider this version does not have, as another version can leave it.
        config.config.set('provider', 'retired-provider');
        await vi.waitFor(() => expect(welcome().split('\n')[0]).toContain('  ·  retired-provider  ·  '));
        // getCurrentProvider() would have put the catalogue's first in its
        // place: a write, from inside the refresh, that starts the next one.
        expect(config.config.get('provider')).toBe('retired-provider');

        // The status bar does make that repair, on its next frame. That is one
        // more refresh, which writes nothing either.
        (ui.options?.getStatus as () => unknown)();
        await vi.waitFor(() => expect(welcome()).not.toContain('retired-provider'));
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(set.mock.calls.map(([key]) => key as unknown)).toEqual(['provider', 'provider']);
      } finally {
        restore();
      }
    });
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
