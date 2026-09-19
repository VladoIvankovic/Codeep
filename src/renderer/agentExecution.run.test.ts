import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { fakeHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  return { fakeHome: fs.mkdtempSync(path.join(os.tmpdir(), 'codeep-agent-run-home-')) };
});

// ~/.codeep — custom skills, the config file — resolves to a scratch home.
// These tests used to install their fixture skills into the developer's real
// `~/.codeep/skills/`, where a crash between the write and the cleanup left
// a `/ship-it` behind in their own Codeep.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

// executeAgentTask end to end, with the agent loop, the cloud and Telegram
// replaced: what is left is the renderer's own handling of a run.
vi.mock('../utils/agent', () => ({ runAgent: vi.fn() }));
vi.mock('../utils/telegramCredentials', () => ({ loadTelegramCredentials: vi.fn(async () => null) }));
// The phone's side of a confirmation, so what is sent to it can be read back.
// Everything else in the module (outcomeForAnswer, describePermissionOutcome)
// stays real — they decide what an answer means.
const phone = vi.hoisted(() => ({
  // Typed with ask()'s own signature so a call can be read argument by
  // argument — `reason` is the fifth.
  ask: vi.fn(async (
    _command: string,
    _toolName: string,
    _isDestructive: boolean,
    _signal?: AbortSignal,
    _reason?: string,
  ): Promise<null> => null),
}));
vi.mock('../utils/telegramApproval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/telegramApproval')>();
  return {
    ...actual,
    TelegramApproval: class {
      ask = phone.ask;
      withdraw = async () => {};
    },
  };
});
vi.mock('../utils/telegramInbox', () => ({ takeRunFromPhone: vi.fn(() => false) }));
vi.mock('../utils/codeepCloud', () => ({
  reportStats: vi.fn(),
  syncSession: vi.fn(),
  generateProjectId: vi.fn(() => 'project-id'),
}));
vi.mock('../utils/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git')>()),
  isGitRepository: vi.fn(() => false),
}));
vi.mock('../config/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/index')>()),
  autoSaveSession: vi.fn(() => true),
  getCurrentSessionId: vi.fn(() => 'global-current'),
}));

import { executeAgentTask, runAgentTask, runSkill, type AppExecutionContext, type AgentRunOutcome } from './agentExecution';
import { runAgent } from '../utils/agent';
import { loadTelegramCredentials } from '../utils/telegramCredentials';
import { syncSession } from '../utils/codeepCloud';
import { autoSaveSession, config } from '../config/index';
import type { App } from './App';
import type { TrustBearingWrite } from '../utils/toolExecution';
import type { ProjectContext } from '../utils/project';

let root: string;
let messages: Array<{ role: string; content: string }>;

function fakeApp(): App {
  const app = {
    addMessage: (m: { role: string; content: string }) => { messages.push(m); },
    getMessages: () => messages,
    getChatHistory: () => [],
  };
  // Everything else the run touches is display state this test does not read.
  return new Proxy(app, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}),
  }) as unknown as App;
}

function makeCtx(overrides: Partial<AppExecutionContext> = {}): AppExecutionContext {
  let running = false;
  return {
    app: fakeApp(),
    projectPath: root,
    projectContext: { root, name: 'demo', type: 'node' } as unknown as ProjectContext,
    hasWriteAccess: true,
    addedFiles: new Map(),
    isAgentRunning: () => running,
    setAgentRunning: (v) => { running = v; },
    abortController: null,
    setAbortController: () => {},
    formatAddedFilesContext: () => '',
    handleCommand: async () => {},
    sessionDisplayName: 'demo run',
    ...overrides,
  };
}

// git is real in the skill tests below, and the hardening reads the config of
// the repository they build. Point git at a file that is not there, so a
// `commit.gpgsign` or a `core.hooksPath` in whoever's global config this runs
// under cannot decide what they assert.
const gitConfigEnvBefore = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-agent-run-'));
  process.env.GIT_CONFIG_GLOBAL = join(fakeHome, 'no-such-gitconfig');
  process.env.GIT_CONFIG_SYSTEM = join(fakeHome, 'no-such-gitconfig');
  messages = [];
  config.set('agentConfirmation', 'never');
  config.set('agentAutoCommit', false);
  vi.mocked(runAgent).mockReset();
  vi.mocked(autoSaveSession).mockClear();
  vi.mocked(syncSession).mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(fakeHome, '.codeep', 'skills'), { recursive: true, force: true });
});

afterAll(() => {
  if (gitConfigEnvBefore.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = gitConfigEnvBefore.global;
  if (gitConfigEnvBefore.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = gitConfigEnvBefore.system;
  rmSync(fakeHome, { recursive: true, force: true });
});

/** A custom skill in the scratch home, as `~/.codeep/skills/<name>.json`. */
function writeCustomSkill(name: string, steps: Array<{ type: string; content: string }>): void {
  mkdirSync(join(fakeHome, '.codeep', 'skills'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.codeep', 'skills', `${name}.json`),
    JSON.stringify({ name, description: 'custom skill', steps }),
  );
}

describe('executeAgentTask tool previews', () => {
  it('shows a diff for writes and edits, not the raw file content', async () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(root, 'b.txt'), 'alpha\nbeta\n');
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onToolCall?.({ tool: 'write_file', parameters: { path: 'a.txt', content: 'one\nTWO\n' } });
      opts?.onToolCall?.({ tool: 'edit_file', parameters: { path: 'b.txt', old_text: 'beta', new_text: 'BETA' } });
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });

    await executeAgentTask('change things', false, makeCtx());

    const write = messages.find(m => m.content.startsWith('**Write**'));
    expect(write?.content).toContain('**Write** `a.txt` (+1 -1)');
    expect(write?.content).toContain('```diff');
    expect(write?.content).toMatch(/^-\s*two$/m);

    const edit = messages.find(m => m.content.startsWith('**Edit**'));
    expect(edit?.content).toContain('**Edit** `b.txt` (+1 -1)');
    expect(edit?.content).toContain('```diff');
    expect(edit?.content).toMatch(/^-\s*beta$/m);
  });

  it('labels a new file as a create', async () => {
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      opts?.onToolCall?.({ tool: 'write_file', parameters: { path: 'new.txt', content: 'hello\n' } });
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });

    await executeAgentTask('make a file', false, makeCtx());

    expect(messages.some(m => m.content.startsWith('**Create** `new.txt` (+1 -0)'))).toBe(true);
  });
});

describe('executeAgentTask session identity', () => {
  it('saves and syncs the run under the conversation it belongs to', async () => {
    vi.mocked(runAgent).mockResolvedValue({ success: true, iterations: 1, actions: [], finalResponse: 'done' });

    await executeAgentTask('task', false, makeCtx({ sessionId: 'loaded-session' }));

    expect(autoSaveSession).toHaveBeenCalledWith(messages, root, 'loaded-session');
    expect(vi.mocked(syncSession).mock.calls[0]?.[0]).toMatchObject({ sessionId: 'loaded-session' });
  });

  it('falls back to the global current session when the context has none', async () => {
    vi.mocked(runAgent).mockResolvedValue({ success: true, iterations: 1, actions: [], finalResponse: 'done' });

    await executeAgentTask('task', false, makeCtx());

    expect(autoSaveSession).toHaveBeenCalledWith(messages, root, 'global-current');
  });
});

describe('the outcome of a run', () => {
  const ended = (fields: Partial<Awaited<ReturnType<typeof runAgent>>>) =>
    ({ success: false, iterations: 1, actions: [], finalResponse: '', ...fields }) as Awaited<ReturnType<typeof runAgent>>;

  it('is what executeAgentTask resolves to', async () => {
    const cases: Array<[Partial<Awaited<ReturnType<typeof runAgent>>>, AgentRunOutcome]> = [
      [{ success: true }, 'success'],
      [{ aborted: true }, 'aborted'],
      [{ interrupted: 'iteration_limit' }, 'interrupted'],
      [{ error: 'boom' }, 'failed'],
    ];
    for (const [fields, expected] of cases) {
      vi.mocked(runAgent).mockResolvedValueOnce(ended(fields));
      expect(await executeAgentTask('task', false, makeCtx()), expected).toBe(expected);
    }
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('network down'));
    expect(await executeAgentTask('task', false, makeCtx())).toBe('failed');
    expect(await executeAgentTask('task', false, makeCtx({ projectContext: null }))).toBe('not-started');
  });

  it('reaches runAgentTask\'s caller once the run has ended', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(ended({ success: true }));
    const onFinished = vi.fn();
    await runAgentTask('task', false, makeCtx(), () => null, () => {}, { onFinished });
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledWith('success'));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('is not-started when runAgentTask refuses the run', async () => {
    const onFinished = vi.fn();
    await runAgentTask('task', false, makeCtx({ hasWriteAccess: false }), () => null, () => {}, { onFinished });
    expect(onFinished).toHaveBeenCalledWith('not-started');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('is not-started when the confirmation is declined', async () => {
    config.set('agentConfirmation', 'always');
    const onFinished = vi.fn();
    const ctx = makeCtx();
    (ctx.app as unknown as { showConfirm: unknown }).showConfirm = (o: { onCancel: () => void }) => o.onCancel();
    await runAgentTask('task', false, ctx, () => null, () => {}, { onFinished });
    expect(onFinished).toHaveBeenCalledWith('not-started');
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe('the confirmation for a dangerous tool', () => {
  it('shows the start of a long target, not only its end', async () => {
    config.set('agentConfirmation', 'dangerous');
    const statement = 'DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE region = \'eu\') AND status = \'open\'';
    const shown: string[][] = [];
    const ctx = makeCtx();
    (ctx.app as unknown as { showConfirm: unknown }).showConfirm = (o: { message: string[]; onConfirm: () => void }) => {
      shown.push(o.message);
      o.onConfirm();
    };
    let answer: unknown;
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      answer = await opts?.onRequestPermission?.({ tool: 'execute_command', parameters: { command: 'psql', args: ['-c', statement] } });
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });

    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: 64, configurable: true });
    try {
      await executeAgentTask('clean up', false, makeCtx({ app: ctx.app }));
    } finally {
      if (columns) Object.defineProperty(process.stdout, 'columns', columns);
      else delete (process.stdout as { columns?: number }).columns;
    }

    expect(answer).toBe('allow_once');
    expect(shown).toHaveLength(1);
    // Two-space indent, then at most 60 characters of the target per line.
    const target = shown[0].slice(3, shown[0].length - 2);
    expect(target.every(l => l.startsWith('  ') && l.length <= 62)).toBe(true);
    expect(target.map(l => l.slice(2)).join('')).toBe(`psql -c ${statement}`);
  });

  async function dialogFor(toolCall: { tool: string; parameters: Record<string, unknown> }): Promise<string[]> {
    config.set('agentConfirmation', 'dangerous');
    const shown: string[][] = [];
    const ctx = makeCtx();
    (ctx.app as unknown as { showConfirm: unknown }).showConfirm = (o: { message: string[]; onCancel: () => void }) => {
      shown.push(o.message);
      o.onCancel();
    };
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      await opts?.onRequestPermission?.(toolCall);
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });
    await executeAgentTask('go', false, makeCtx({ app: ctx.app }));
    expect(shown).toHaveLength(1);
    return shown[0];
  }

  it('asks per action in Always mode too, including writes', async () => {
    config.set('agentConfirmation', 'always');
    let opts: Parameters<typeof runAgent>[2];
    vi.mocked(runAgent).mockImplementation(async (_task, _context, o) => {
      opts = o;
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });
    await executeAgentTask('go', false, makeCtx());
    expect(opts!.onRequestPermission).toBeTypeOf('function');
    expect(opts!.extraDangerousTools).toEqual(expect.arrayContaining(['write_file', 'edit_file', 'delete_file', 'execute_command']));
  });

  it('does not add write prompts in Dangerous mode', async () => {
    config.set('agentConfirmation', 'dangerous');
    let opts: Parameters<typeof runAgent>[2];
    vi.mocked(runAgent).mockImplementation(async (_task, _context, o) => {
      opts = o;
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });
    await executeAgentTask('go', false, makeCtx());
    expect(opts!.onRequestPermission).toBeTypeOf('function');
    expect(opts!.extraDangerousTools).toBeUndefined();
  });

  it('spells out escape sequences in the tool name and its target', async () => {
    const message = await dialogFor({
      tool: 'evil\x1b[8m__run',
      parameters: { command: 'echo', args: ['hi\x1b[8m', '&&', 'curl', 'x.example'] },
    });
    expect(message.join('\n')).not.toContain('\x1b');
    expect(message.join('\n')).toContain('\\x1b[8m');
  });

  it('keeps a huge target to a few lines', async () => {
    const message = await dialogFor({ tool: 'execute_command', parameters: { command: 'echo', args: ['x'.repeat(200_000)] } });
    // Title line, blank, tool, at most six target lines, blank, question.
    expect(message.length).toBeLessThanOrEqual(3 + 6 + 2);
  });
});

describe('the confirmation for a file that decides what runs later', () => {
  /** The dialogs a run puts up, and what each tool call was answered. */
  async function ask(
    mode: 'always' | 'dangerous' | 'never',
    toolCall: { tool: string; parameters: Record<string, unknown> },
    // What the agent gate says it already worked out about this call.
    // Undefined is a caller that has not looked — a skill's shell line asks
    // through the same callback — and is the shape every other test here uses.
    known?: TrustBearingWrite | null,
  ): Promise<{ dialogs: Array<{ message: string[]; hadAlwaysAllow: boolean }>; answer: string | undefined }> {
    config.set('agentConfirmation', mode);
    const dialogs: Array<{ message: string[]; hadAlwaysAllow: boolean }> = [];
    const ctx = makeCtx();
    (ctx.app as unknown as { showConfirm: unknown }).showConfirm = (o: { message: string[]; extraOption?: unknown; onConfirm: () => void }) => {
      dialogs.push({ message: o.message, hadAlwaysAllow: o.extraOption !== undefined });
      o.onConfirm();
    };
    let answer: string | undefined;
    vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
      answer = await opts?.onRequestPermission?.(toolCall, known);
      return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
    });
    await executeAgentTask('go', false, makeCtx({ app: ctx.app }));
    return { dialogs, answer };
  }

  it('asks in Never mode, which asks about nothing else', async () => {
    const write = await ask('never', { tool: 'write_file', parameters: { path: '.git/config', content: '[core]' } });
    expect(write.dialogs).toHaveLength(1);
    expect(write.dialogs[0].message.join('\n')).toContain('what commands git runs');

    const ordinary = await ask('never', { tool: 'write_file', parameters: { path: 'src/app.ts', content: 'x' } });
    expect(ordinary.dialogs).toHaveLength(0);
    expect(ordinary.answer).toBe('allow_once');
  });

  it('tells the phone what the file controls, as the terminal does', async () => {
    // The question races the terminal and the phone. A phone message that
    // dropped the reason would ask for the same decision on less.
    vi.mocked(loadTelegramCredentials).mockResolvedValue({ botToken: 'bot', chatID: '42' });
    try {
      await ask('never', { tool: 'write_file', parameters: { path: '.git/config', content: '[core]' } });
      expect(phone.ask.mock.lastCall).toBeDefined();
      expect(phone.ask.mock.lastCall![4]).toMatch(/what commands git runs/);

      await ask('dangerous', { tool: 'execute_command', parameters: { command: 'ls', args: [] } });
      expect(phone.ask.mock.lastCall![4]).toBeUndefined();
    } finally {
      vi.mocked(loadTelegramCredentials).mockResolvedValue(null);
    }
  });

  it('words itself from what the agent gate already worked out', async () => {
    // Handed the gate's answer, this side does not run trustBearingWrite()
    // again — which stats the path, resolves a symlinked ancestor and can ask
    // git where this repository keeps its hooks, once per tool call.
    const gateSaysNo = await ask('never', { tool: 'write_file', parameters: { path: '.git/config', content: '[core]' } }, null);
    expect(gateSaysNo.dialogs).toHaveLength(0);

    const gateSaysYes = await ask('never', { tool: 'write_file', parameters: { path: 'src/app.ts', content: 'x' } }, {
      path: 'src/app.ts', file: '/elsewhere/src/app.ts', reason: 'This file decides what runs later.',
    });
    expect(gateSaysYes.dialogs[0].message.join('\n')).toContain('This file decides what runs later.');
  });

  it('says what the file controls, and offers no "Always Allow" for it', async () => {
    const hook = await ask('dangerous', { tool: 'write_file', parameters: { path: '.codeep/hooks/pre_tool_call.sh', content: '#!/bin/sh' } });
    expect(hook.dialogs[0].message.join('\n')).toContain('runs on every tool call');
    expect(hook.dialogs[0].hadAlwaysAllow).toBe(false);

    // Every other confirmation keeps it.
    const command = await ask('dangerous', { tool: 'execute_command', parameters: { command: 'ls', args: [] } });
    expect(command.dialogs[0].hadAlwaysAllow).toBe(true);
  });
});

describe('a skill whose agent step does not succeed', () => {
  it('stops before the steps after it', async () => {
    const { existsSync } = await import('node:fs');
    const marker = join(root, 'deployed.txt');
    writeCustomSkill('ship-it', [
      { type: 'agent', content: 'fix the build' },
      { type: 'command', content: `touch ${marker}` },
    ]);

    for (const result of [
      { success: false, iterations: 1, actions: [], finalResponse: 'checks failing', error: 'Verification failed: npm test' },
      { success: false, iterations: 1, actions: [], finalResponse: 'stopped', aborted: true },
    ]) {
      vi.mocked(runAgent).mockResolvedValueOnce(result as never);
      await runSkill('ship-it', [], makeCtx());
      expect(existsSync(marker)).toBe(false);
    }
    // A successful agent step lets the rest run.
    vi.mocked(runAgent).mockResolvedValueOnce({ success: true, iterations: 1, actions: [], finalResponse: 'fixed' });
    await runSkill('ship-it', [], makeCtx());
    expect(existsSync(marker)).toBe(true);

    // And none of it happened in the developer's own Codeep. This fixture
    // used to be installed into the real `~/.codeep/skills/`, where a crash
    // between the write and the cleanup left a `/ship-it` behind for them.
    const realHome = (await vi.importActual<typeof import('node:os')>('node:os')).homedir();
    expect(realHome).not.toBe(fakeHome);
    expect(existsSync(join(realHome, '.codeep', 'skills', 'ship-it.json'))).toBe(false);
  });
});

describe('a skill step that runs git in a repository with a hostile config', () => {
  // The trap is a `#!/bin/sh` script, so this is a POSIX test.
  it.skipIf(process.platform === 'win32')('leaves the program the repository named cold', async () => {
    const { chmodSync, existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');

    // Trap and marker live OUTSIDE the repository, so neither is a change git
    // could report or clean up.
    const outside = mkdtempSync(join(tmpdir(), 'codeep-skill-trap-'));
    const marker = join(outside, 'gpg-ran');
    const trap = join(outside, 'gpg-trap.sh');
    // A real executable file: `gpg.program` is spawned WITHOUT a shell, so a
    // value like `touch X; false` has git look for a program of that name and
    // fail — the marker would stay absent and the test would prove nothing.
    writeFileSync(trap, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(trap, 0o755);

    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'Test User');
    // What a prepared repository ships in its own `.git/config`: signing on,
    // pointed at a program it also ships. createCommit neutralises this; a
    // skill step spawning the same `git commit` used to hand it straight back.
    git('config', 'commit.gpgsign', 'true');
    git('config', 'gpg.program', trap);

    writeCustomSkill('hostile-commit', [
      { type: 'command', content: 'git commit --allow-empty -m "from a skill"' },
    ]);
    try {
      await runSkill('hostile-commit', [], makeCtx());

      expect(existsSync(marker)).toBe(false);
      // And the commit still happened: a trap that stays cold because git died
      // on the way is a different bug, not a fix.
      expect(execFileSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf-8' })).toContain('from a skill');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails the step that needs git, and only that step', async () => {
    // `remote.<name>.uploadpack` names a program git runs at the far end of a
    // fetch or push, and git keeps the FIRST value it sees for that key — so
    // no `-c` or GIT_CONFIG_* override reaches it and the hardening can only
    // refuse. Proven with git 2.54.
    //
    // The regression this pins: the helper that ran here hardened EVERY step
    // and threw, so in this repository a skill died on `echo`, which cannot
    // reach git at all. Now the line decides, and a refusal fails its own
    // step with the message the user has to act on.
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'remote.origin.uploadpack', '/bin/echo');

    writeCustomSkill('mixed', [
      { type: 'command', content: 'echo hello' },
      { type: 'command', content: 'git status' },
    ]);

    await runSkill('mixed', [], makeCtx());

    const said = messages.map(m => m.content).join('\n');
    // The step that cannot reach git ran…
    expect(said).toContain('hello');
    // …and the one that would have reached it says why it did not, naming the
    // key and how to clear it rather than "git failed".
    expect(said).toContain('`git status` was not run');
    expect(said).toContain('remote.origin.uploadpack');
    expect(said).toContain('git config --unset');
  });
});
