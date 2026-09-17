import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// executeAgentTask end to end, with the agent loop, the cloud and Telegram
// replaced: what is left is the renderer's own handling of a run.
vi.mock('../utils/agent', () => ({ runAgent: vi.fn() }));
vi.mock('../utils/telegramCredentials', () => ({ loadTelegramCredentials: vi.fn(async () => null) }));
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
import { syncSession } from '../utils/codeepCloud';
import { autoSaveSession, config } from '../config/index';
import type { App } from './App';
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-agent-run-'));
  messages = [];
  config.set('agentConfirmation', 'never');
  config.set('agentAutoCommit', false);
  vi.mocked(runAgent).mockReset();
  vi.mocked(autoSaveSession).mockClear();
  vi.mocked(syncSession).mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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

describe('a skill whose agent step does not succeed', () => {
  it('stops before the steps after it', async () => {
    const { homedir } = await import('node:os');
    const { mkdirSync, existsSync } = await import('node:fs');
    mkdirSync(join(homedir(), '.codeep', 'skills'), { recursive: true });
    const marker = join(root, 'deployed.txt');
    writeFileSync(join(homedir(), '.codeep', 'skills', 'ship-it.json'), JSON.stringify({
      name: 'ship-it',
      description: 'fix, then deploy',
      steps: [
        { type: 'agent', content: 'fix the build' },
        { type: 'command', content: `touch ${marker}` },
      ],
    }));
    try {
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
    } finally {
      rmSync(join(homedir(), '.codeep', 'skills', 'ship-it.json'), { force: true });
    }
  });
});
