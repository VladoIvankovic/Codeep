import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A run that is still finishing when the user moves to another conversation.
// Enter during a run stops the agent and submits the typed command 100 ms
// later, but a tool already running does not stop, so /new, /sessions or
// /rename can all land before the run ends. The sessions here are real files.
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

import { executeAgentTask, type AppExecutionContext } from './agentExecution';
import { runAgent } from '../utils/agent';
import { reportStats, syncSession } from '../utils/codeepCloud';
import {
  config,
  flushAutoSave,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  startNewSession,
  type Message,
} from '../config/index';
import type { App } from './App';
import type { ProjectContext } from '../utils/project';

let root: string;
let messages: Message[];
/** The conversation on screen, as main.ts tracks it. */
let liveId: string;

const S1: Message[] = [
  { role: 'user', content: 'IMPORTANT S1 history' },
  { role: 'assistant', content: 'S1 answer' },
];

function fakeApp(): App {
  const app = {
    addMessage: (m: Message) => { messages.push(m); },
    // A fresh array of the same message objects, as App.getMessages returns.
    getMessages: () => messages.filter(() => true),
    setMessages: (m: Message[]) => { messages = m; },
    getChatHistory: () => [],
  };
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
    // Copied when the run was submitted, like main.ts makeCtx().
    sessionId: 'S1',
    getSessionId: () => liveId,
    ...overrides,
  };
}

/** The run ends as a stopped run after `whileRunning` has done its switch. */
function runThatOutlives(whileRunning: () => void): void {
  vi.mocked(runAgent).mockImplementation(async () => {
    whileRunning();
    return { success: false, aborted: true, iterations: 1, actions: [], finalResponse: '' };
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-agent-switch-'));
  writeFileSync(join(root, 'package.json'), '{}');
  config.set('autoSave', true);
  config.set('autoSessionTitle', false);
  config.set('autoLearnProfile', false);
  config.set('agentConfirmation', 'never');
  config.set('agentAutoCommit', false);
  config.set('currentSessionId', 'S1');
  liveId = 'S1';
  messages = [...S1];
  saveSession('S1', S1, root);
  vi.mocked(runAgent).mockReset();
  vi.mocked(syncSession).mockClear();
  vi.mocked(reportStats).mockClear();
});

afterEach(() => {
  flushAutoSave();
  rmSync(root, { recursive: true, force: true });
});

describe('a run that ends after the user switched conversations', () => {
  it('leaves the conversation the user left alone after /new', async () => {
    const setSessionDisplayName = vi.fn();
    runThatOutlives(() => {
      // commands.ts /new: clear the screen, then switch.
      messages.length = 0;
      liveId = startNewSession();
    });

    await executeAgentTask('long task', false, makeCtx({ setSessionDisplayName }));
    flushAutoSave();

    expect(loadSession('S1', root)).toEqual(S1);
    expect(syncSession).not.toHaveBeenCalled();
    // The new conversation must not be named after the old run's task.
    expect(setSessionDisplayName).not.toHaveBeenCalled();
    // The tokens were still spent, on the run's own conversation.
    expect(vi.mocked(reportStats).mock.calls[0]?.[0]).toMatchObject({ sessionId: 'S1' });
  });

  it('leaves both conversations alone after /sessions loads another', async () => {
    const other: Message[] = [{ role: 'user', content: 'conversation B' }];
    saveSession('B', other, root);
    runThatOutlives(() => {
      messages = [...other];
      liveId = 'B';
    });

    await executeAgentTask('long task', false, makeCtx());
    flushAutoSave();

    expect(loadSession('S1', root)).toEqual(S1);
    expect(loadSession('B', root)).toEqual(other);
  });

  /** commands.ts /rename: save what is on screen, rename, switch. */
  function renameTo(name: string): void {
    saveSession(liveId, messages, root);
    renameSession(liveId, name, root);
    liveId = name;
  }

  const S1_AFTER_RUN: Message[] = [
    ...S1,
    { role: 'user', content: '[AGENT] long task' },
    { role: 'assistant', content: 'Agent stopped by user.' },
  ];

  it('saves the end of the run into the renamed conversation, and not under the old name', async () => {
    runThatOutlives(() => renameTo('renamed'));

    await executeAgentTask('long task', false, makeCtx());
    flushAutoSave();

    expect(listSessions(root)).toEqual(['renamed']);
    expect(loadSession('renamed', root)).toEqual(S1_AFTER_RUN);
  });

  it('saves the end of the run after a /rename that only changes the case', async () => {
    runThatOutlives(() => renameTo('s1'));

    await executeAgentTask('long task', false, makeCtx());
    flushAutoSave();

    expect(listSessions(root)).toEqual(['s1']);
    expect(loadSession('s1', root)).toEqual(S1_AFTER_RUN);
  });

  it('keeps the end of the run after /rename when /new follows the run', async () => {
    runThatOutlives(() => renameTo('renamed'));

    await executeAgentTask('long task', false, makeCtx());
    flushAutoSave();
    // commands.ts /new: /new does not save what it clears.
    messages = [];
    liveId = startNewSession();
    flushAutoSave();

    expect(listSessions(root)).toEqual(['renamed']);
    expect(loadSession('renamed', root)).toEqual(S1_AFTER_RUN);
  });

  it('leaves the renamed conversation alone when /new came before the run ended', async () => {
    let renamedWith: Message[] = [];
    runThatOutlives(() => {
      renameTo('renamed');
      renamedWith = [...messages];
      messages = [];
      liveId = startNewSession();
    });

    await executeAgentTask('long task', false, makeCtx());
    flushAutoSave();

    expect(listSessions(root)).toEqual(['renamed']);
    expect(loadSession('renamed', root)).toEqual(renamedWith);
  });

  it('writes nothing for a first run whose conversation was never saved, after /new', async () => {
    liveId = 'fresh';
    messages = [];
    runThatOutlives(() => {
      messages = [];
      liveId = startNewSession();
    });

    await executeAgentTask('long task', false, makeCtx({ sessionId: 'fresh' }));
    flushAutoSave();

    expect(listSessions(root)).toEqual(['S1']);
  });

  it('leaves the loaded conversation alone after a first run that was never saved', async () => {
    const other: Message[] = [{ role: 'user', content: 'conversation B' }];
    saveSession('B', other, root);
    liveId = 'fresh';
    messages = [];
    runThatOutlives(() => {
      messages = loadSession('B', root)!;
      liveId = 'B';
    });

    await executeAgentTask('long task', false, makeCtx({ sessionId: 'fresh' }));
    flushAutoSave();

    expect(listSessions(root)).toEqual(['B', 'S1']);
    expect(loadSession('B', root)).toEqual(other);
  });

  it('still saves and syncs a run whose conversation stayed on screen', async () => {
    runThatOutlives(() => {});

    await executeAgentTask('long task', false, makeCtx());
    flushAutoSave();

    expect(loadSession('S1', root)).toEqual([
      ...S1,
      { role: 'user', content: '[AGENT] long task' },
      { role: 'assistant', content: 'Agent stopped by user.' },
    ]);
    expect(vi.mocked(syncSession).mock.calls[0]?.[0]).toMatchObject({ sessionId: 'S1' });
  });
});
