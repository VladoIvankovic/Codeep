import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// A message typed into the TUI, followed from the input box to the model the
// way the binary runs it: main() goes through the whole startup, and what
// reaches the usage ledger is read back from disk. The App is a recorder; the
// model's side — chat() and the agent loop — is replaced, and everything in
// between is real. Unlike main.launch.test.ts, agentExecution stays real:
// "one prompt, not two" depends on what it does after handleSubmit.
const ui = vi.hoisted(() => ({
  options: null as null | Record<string, unknown>,
  calls: [] as Array<{ method: string; args: unknown[] }>,
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
vi.mock('../api/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/index')>()),
  chat: vi.fn(async () => 'a reply'),
}));
vi.mock('../utils/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/agent')>()),
  runAgent: vi.fn(async () => ({ success: true, iterations: 1, actions: [], finalResponse: 'done' })),
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
  reportStats: vi.fn(),
  syncSession: vi.fn(),
}));
vi.mock('../utils/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/update')>()),
  checkForUpdates: vi.fn(async () => ({ hasUpdate: false })),
}));
vi.mock('../utils/telegramCredentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/telegramCredentials')>()),
  loadTelegramInboxCredentials: vi.fn(async () => null),
  loadTelegramCredentials: vi.fn(async () => null),
}));
vi.mock('../utils/mcpRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/mcpRegistry')>()),
  registerSessionServers: vi.fn(async () => ({ registered: [], errors: [] })),
}));
// The config watch main() starts for the welcome block, kept so each test can
// stop it: fs.watchFile outlives vi.resetModules(), so every launch would
// leave one polling the config file for the rest of the run.
const watches = vi.hoisted(() => [] as Array<{ stop(): void }>);
vi.mock('./configWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./configWatch')>();
  return {
    ...actual,
    watchConfig: (...args: Parameters<typeof actual.watchConfig>) => {
      const watch = actual.watchConfig(...args);
      watches.push(watch);
      return watch;
    },
  };
});
// Whether this machine is Omarchy, as the Agents panel record asks it. Off
// unless a test turns it on; the theme keeps asking the real question.
const omarchy = vi.hoisted(() => ({ here: false }));
vi.mock('./omarchyTheme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./omarchyTheme')>()),
  isOmarchy: () => omarchy.here,
}));

/** A session id as the ledger keeps it. */
const hashOf = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex').slice(0, 16);

const savedArgv = process.argv;
const savedCwd = process.cwd();
let folder: string;

/** The prompt lines in the ledger under this worker's HOME. */
function prompts(): Array<Record<string, unknown>> {
  const dir = join(homedir(), '.codeep', 'usage');
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.k === 'p');
}

/**
 * `codeep --yolo` in a fresh folder: no questions, the folder as the project
 * with write access, a new session. Resolves once that session has started,
 * with the id it started under.
 */
async function launch(agentMode: 'on' | 'off') {
  process.argv = ['node', 'codeep', '--yolo'];
  vi.resetModules();
  const { config } = await import('../config/index');
  config.set('agentMode', agentMode);
  const before = config.get('currentSessionId');
  const { main } = await import('./main');
  const { chat } = await import('../api/index');
  const { runAgent } = await import('../utils/agent');
  vi.mocked(chat).mockClear();
  vi.mocked(runAgent).mockClear();
  await main();
  await vi.waitFor(() => expect(config.get('currentSessionId')).not.toBe(before));
  return {
    sessionId: config.get('currentSessionId'),
    submit: ui.options?.onSubmit as (text: string) => Promise<void>,
    command: ui.options?.onCommand as (command: string, args: string[]) => Promise<void>,
    chat: vi.mocked(chat),
    runAgent: vi.mocked(runAgent),
  };
}

const called = (method: string) => ui.calls.filter(c => c.method === method);

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-usage-launch-')));
  process.chdir(folder);
  ui.options = null;
  ui.calls = [];
  rmSync(join(homedir(), '.codeep', 'usage'), { recursive: true, force: true });
  // The 30-second Ollama health check must not outlive the test.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(async () => {
  for (const watch of watches.splice(0)) watch.stop();
  vi.useRealTimers();
  process.chdir(savedCwd);
  process.argv = savedArgv;
  const { config } = await import('../config/index');
  config.set('agentMode', 'on');
  vi.restoreAllMocks();
  rmSync(folder, { recursive: true, force: true });
});

describe('a prompt typed into the TUI', () => {
  it('is one prompt in the ledger when it goes to the model as a chat message', async () => {
    const { sessionId, submit, chat } = await launch('off');

    await submit('what does this project do?');

    expect(chat).toHaveBeenCalledTimes(1);
    expect(prompts()).toEqual([{ t: expect.any(Number), k: 'p', s: hashOf(sessionId), src: 'tui' }]);

    await submit('and how is it tested?');
    expect(prompts().map(line => line.s)).toEqual([hashOf(sessionId), hashOf(sessionId)]);
  });

  it('is one prompt, not two, when Agent Mode runs it as a task', async () => {
    const { sessionId, submit, runAgent, chat } = await launch('on');

    await submit('add a README');

    await vi.waitFor(() => expect(called('notify').some(c => String(c.args[0]).startsWith('Agent completed'))).toBe(true));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    expect(prompts()).toEqual([{ t: expect.any(Number), k: 'p', s: hashOf(sessionId), src: 'tui' }]);
  });

  it('is no prompt when it is a slash command answered without a model', async () => {
    const { command, chat, runAgent } = await launch('off');

    await command('cost', []);
    await command('status', []);

    expect(chat).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(prompts()).toEqual([]);
  });
});

describe('on Omarchy', () => {
  const savedState = process.env.XDG_STATE_HOME;

  afterEach(() => {
    omarchy.here = false;
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
  });

  it('puts Codeep in the Agents panel a moment after a prompt, from any launch', async () => {
    omarchy.here = true;
    process.env.XDG_STATE_HOME = join(folder, 'state');
    const record = join(folder, 'state', 'omarchy', 'agents', 'usage', 'codeep.json');
    const { submit, sessionId } = await launch('off');
    // The watch's two seconds, on a clock the test moves itself — started
    // once main() is up, which has timers of its own to run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    await submit('what does this project do?');
    vi.advanceTimersByTime(1999);
    expect(existsSync(record)).toBe(false);

    // main() started the watch that writes it, two seconds after the line.
    vi.advanceTimersByTime(1);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ id: 'codeep', totalPrompts: 1, totalSessions: 1 });
    expect(prompts().map(line => line.s)).toEqual([hashOf(sessionId)]);
  });

  it('keeps Codeep out of the panel with the setting off', async () => {
    omarchy.here = true;
    process.env.XDG_STATE_HOME = join(folder, 'state');
    const record = join(folder, 'state', 'omarchy', 'agents', 'usage', 'codeep.json');
    const { config } = await import('../config/index');
    const { submit } = await launch('off');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    config.set('omarchyAgentsPanel', false);
    try {
      await submit('what does this project do?');
      vi.advanceTimersByTime(5 * 60_000);
      expect(prompts()).toHaveLength(1);
      expect(existsSync(record)).toBe(false);
    } finally {
      config.set('omarchyAgentsPanel', true);
    }
  });
});
