import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// `codeep --yolo` pins the confirmation mode, and turns clarifying questions
// off, for its own process. What is pinned here is that the pins win over the
// config in agentExecution's readers, and that they never reach the config
// itself. (main.ts has the third confirmation reader, for the answer to
// clarifying questions; main.launch.test.ts covers it.) The agent loop, the
// cloud and Telegram are replaced: what is left is the renderer's gate.
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

import { agentConfirmationMode, pinAgentConfirmation, agentInteractiveMode, pinAgentInteractive } from './agentConfirmation';
import { executeAgentTask, runAgentTask, type AppExecutionContext } from './agentExecution';
import { runAgent } from '../utils/agent';
import { config } from '../config/index';
import type { App } from './App';
import type { ProjectContext } from '../utils/project';

let root: string;
/** Titles of the dialogs the run put up, each answered yes. */
let dialogs: string[];

function fakeApp(): App {
  const app = {
    getMessages: () => [],
    getChatHistory: () => [],
    showConfirm: (o: { title: string; onConfirm: () => void }) => { dialogs.push(o.title); o.onConfirm(); },
  };
  // Everything else the run touches is display state this test does not read.
  return new Proxy(app, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}),
  }) as unknown as App;
}

function makeCtx(): AppExecutionContext {
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
  };
}

/** Run one task whose agent makes `toolCall`, and return what it was answered. */
async function answerFor(toolCall: { tool: string; parameters: Record<string, unknown> }): Promise<{ answer: unknown; extraDangerousTools: unknown }> {
  let answer: unknown;
  let extraDangerousTools: unknown;
  vi.mocked(runAgent).mockImplementation(async (_task, _context, opts) => {
    extraDangerousTools = opts?.extraDangerousTools;
    answer = await opts?.onRequestPermission?.(toolCall);
    return { success: true, iterations: 1, actions: [], finalResponse: 'done' };
  });
  await executeAgentTask('go', false, makeCtx());
  return { answer, extraDangerousTools };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-confirmation-'));
  dialogs = [];
  config.set('agentConfirmation', 'always');
  config.set('agentInteractive', false);
  config.set('agentAutoCommit', false);
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  pinAgentConfirmation(null);
  pinAgentInteractive(null);
  rmSync(root, { recursive: true, force: true });
});

describe('agentConfirmationMode', () => {
  it('is the config while nothing is pinned', () => {
    expect(agentConfirmationMode()).toBe('always');
    config.set('agentConfirmation', 'never');
    expect(agentConfirmationMode()).toBe('never');
  });

  it('falls back to dangerous, the default, when the config has no value', () => {
    config.delete('agentConfirmation');
    // Conf hands back its default; either way, nothing reads as 'never'.
    expect(agentConfirmationMode()).toBe('dangerous');
  });

  it('is the pin once there is one, whatever the config says', () => {
    pinAgentConfirmation('never');
    expect(agentConfirmationMode()).toBe('never');
    config.set('agentConfirmation', 'dangerous');
    expect(agentConfirmationMode()).toBe('never');
  });

  it('never writes the pin to the config', () => {
    // The config file is shared with the next plain `codeep` and with the
    // ACP server; a saved 'never' would switch their confirmations off too.
    const set = vi.spyOn(config, 'set');
    pinAgentConfirmation('never');
    agentConfirmationMode();
    expect(set).not.toHaveBeenCalled();
    expect(config.get('agentConfirmation')).toBe('always');
    set.mockRestore();
  });

  it('goes back to the config when the pin is cleared', () => {
    pinAgentConfirmation('never');
    pinAgentConfirmation(null);
    expect(agentConfirmationMode()).toBe('always');
  });
});

describe('agentInteractiveMode', () => {
  it('is the config while nothing is pinned, and the pin once there is one', () => {
    expect(agentInteractiveMode()).toBe(false);
    config.set('agentInteractive', true);
    expect(agentInteractiveMode()).toBe(true);

    pinAgentInteractive(false);
    expect(agentInteractiveMode()).toBe(false);
    expect(config.get('agentInteractive')).toBe(true);

    pinAgentInteractive(null);
    expect(agentInteractiveMode()).toBe(true);
  });
});

describe('the terminal\'s readers honour the pin', () => {
  it('starts the run without the "Confirm Agent Task" dialog', async () => {
    vi.mocked(runAgent).mockResolvedValue({ success: true, iterations: 1, actions: [], finalResponse: 'done' });

    await runAgentTask('go', false, makeCtx(), () => null, () => {});
    expect(dialogs).toEqual(['⚠️  Confirm Agent Task']); // the config's 'always', as a control

    dialogs = [];
    pinAgentConfirmation('never');
    await runAgentTask('go', false, makeCtx(), () => null, () => {});
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    expect(dialogs).toEqual([]);
  });

  it('answers an ordinary tool call itself, and asks the agent to add none to its list', async () => {
    const write = { tool: 'write_file', parameters: { path: 'src/app.ts', content: 'x' } };

    expect((await answerFor(write)).extraDangerousTools).toContain('write_file'); // control
    expect(dialogs).toEqual(['⚠️  Confirm Action']);

    dialogs = [];
    pinAgentConfirmation('never');
    const pinned = await answerFor(write);
    expect(pinned.answer).toBe('allow_once');
    expect(pinned.extraDangerousTools).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  it('starts a vague task without stopping for clarifying questions', async () => {
    // A launcher's prompt is often vague by this measure, and a run waiting
    // for "proceed" waits for someone who is not there.
    config.set('agentInteractive', true);
    config.set('agentConfirmation', 'never');
    vi.mocked(runAgent).mockResolvedValue({ success: true, iterations: 1, actions: [], finalResponse: 'done' });
    const held: unknown[] = [];
    const run = () => runAgentTask('refactor my waybar config', false, makeCtx(), () => null, v => { held.push(v); });

    await run();
    expect(held).toHaveLength(1); // the config's questions, as a control
    expect(runAgent).not.toHaveBeenCalled();

    pinAgentInteractive(false);
    await run();
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    expect(held).toHaveLength(1);
  });

  it('still asks about a file that decides what runs later', async () => {
    // Never mode asks about these too; --yolo is Never mode, not less.
    pinAgentConfirmation('never');
    await answerFor({ tool: 'write_file', parameters: { path: '.git/config', content: '[core]' } });
    expect(dialogs).toEqual(['⚠️  Confirm Action']);
  });
});
