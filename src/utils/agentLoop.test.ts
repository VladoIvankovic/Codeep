/**
 * runAgent end to end: the real loop, real tool execution against a temp
 * project, real config (isolated per worker by vitest.setup.ts). Only the model
 * (agentChat), the verification commands, the MCP transport and the keychain
 * are replaced, so each test drives the loop with a scripted conversation and
 * checks what actually happened on disk and in config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type ChatResponse = { content: string; toolCalls: Array<{ tool: string; parameters: Record<string, unknown> }>; usedNativeTools: boolean };
type ChatCall = { messages: Array<{ role: string; content: string }>; system: string; sub: boolean; runtime?: Record<string, unknown> };
type Script = (call: ChatCall) => ChatResponse;

const h = vi.hoisted(() => ({
  script: (() => ({ content: 'Done.', toolCalls: [], usedNativeTools: true })) as (call: unknown) => unknown,
  calls: [] as unknown[],
  verifyQueue: [] as unknown[],
  verifyRuns: 0,
  verifyOptions: [] as Array<Record<string, unknown> | undefined>,
  onVerify: undefined as (() => void) | undefined,
}));

vi.mock('./agentChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentChat')>();
  return {
    ...actual,
    summarizeEarlierHistory: async () => '',
    agentChat: async (
      messages: Array<{ role: string; content: string }>,
      systemPrompt: string,
      _onChunk?: unknown,
      _signal?: unknown,
      _timeout?: unknown,
      _tools?: unknown,
      runtime?: Record<string, unknown>,
    ) => {
      const call = {
        messages: messages.map(m => ({ ...m })),
        system: systemPrompt,
        sub: systemPrompt.includes('delegated sub-agent'),
        runtime: runtime ? { ...runtime } : undefined,
      };
      h.calls.push(call);
      return h.script(call);
    },
  };
});

vi.mock('./verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify')>();
  return {
    ...actual,
    runAllVerifications: async (_root: string, options?: Record<string, unknown>) => {
      h.verifyOptions.push(options);
      h.onVerify?.();
      const next = h.verifyQueue[Math.min(h.verifyRuns, h.verifyQueue.length - 1)];
      h.verifyRuns++;
      return JSON.parse(JSON.stringify(next));
    },
  };
});

vi.mock('./mcpRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcpRegistry')>();
  return {
    ...actual,
    callSessionTool: vi.fn(async () => 'mcp tool ran'),
    callSessionVirtualTool: vi.fn(async () => '[]'),
  };
});

// No test here may reach the OS keychain, including through setProvider.
vi.mock('./keychain', () => {
  const keys = new Map<string, string>();
  return {
    createSecureStorage: () => ({
      getApiKey: async (id: string) => keys.get(id) ?? null,
      setApiKey: async (id: string, key: string) => { keys.set(id, key); },
      deleteApiKey: async (id: string) => { keys.delete(id); },
      hasApiKey: async (id: string) => keys.has(id),
    }),
    migrateApiKeysToKeychain: async () => {},
  };
});

vi.mock('./codeepCloud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codeepCloud')>();
  return { ...actual, syncProgress: () => {} };
});

// The undo history lives under the home directory; keep it out of these runs.
vi.mock('./history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./history')>();
  return {
    ...actual,
    startSession: vi.fn(() => 'session-1'),
    endSession: vi.fn(),
    recordWrite: vi.fn(() => null),
    recordEdit: vi.fn(() => null),
    recordDelete: vi.fn(() => null),
    recordMkdir: vi.fn(() => null),
    recordCommand: vi.fn(() => null),
  };
});

import { runAgent, resolveDelegateModel } from './agent';
import { config, getApiKey } from '../config/index';
import { createSecureStorage } from './keychain';
import { callSessionTool, callSessionVirtualTool } from './mcpRegistry';
import type { VerifyResult } from './verify';

const say = (content: string): ChatResponse => ({ content, toolCalls: [], usedNativeTools: true });
const use = (...toolCalls: Array<[string, Record<string, unknown>]>): ChatResponse => ({
  content: '',
  toolCalls: toolCalls.map(([tool, parameters]) => ({ tool, parameters })),
  usedNativeTools: true,
});
const setScript = (script: Script) => { h.script = script as (call: unknown) => unknown; };
const chatCalls = () => h.calls as ChatCall[];
const lastMessage = (call: ChatCall) => call.messages[call.messages.length - 1].content;

const failing = (type: VerifyResult['type'], errors: VerifyResult['errors']): VerifyResult => ({
  success: false, type, command: `npm run ${type}`, output: 'failed', errors, duration: 1,
});
const passing = (type: VerifyResult['type']): VerifyResult => ({
  success: true, type, command: `npm run ${type}`, output: '', errors: [], duration: 1,
});
const notRun = (type: VerifyResult['type'], reason: string): VerifyResult => ({
  success: false, notRun: reason, type, command: `npm run ${type}`, output: reason, errors: [], duration: 0,
});

let root: string;
const ctx = () => ({ root, name: 'p', type: 'node', structure: '', keyFiles: [], fileCount: 0, summary: '' }) as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-agent-loop-'));
  h.calls = [];
  h.verifyQueue = [];
  h.verifyRuns = 0;
  h.verifyOptions = [];
  h.onVerify = undefined;
  vi.mocked(callSessionTool).mockClear();
  vi.mocked(callSessionVirtualTool).mockClear();
  config.set('agentConfirmDeleteFile', true);
  config.set('agentConfirmExecuteCommand', true);
  config.set('agentConfirmWriteFile', false);
  config.set('agentAutoReview', false);
  config.set('activePersonality', null as never);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('delegation runs under the parent run\'s rules', () => {
  it('a dry run does not start a sub-agent, so nothing is written', async () => {
    setScript(call => {
      if (call.sub) return chatCalls().filter(c => c.sub).length === 1
        ? use(['write_file', { path: 'dry.txt', content: 'x' }])
        : say('Sub-agent done.');
      return chatCalls().length === 1 ? use(['delegate', { task: 'create dry.txt' }]) : say('All done.');
    });
    const onToolResult = vi.fn();

    await runAgent('do it', ctx(), { dryRun: true, autoVerify: false, maxIterations: 5, onToolResult });

    expect(existsSync(join(root, 'dry.txt'))).toBe(false);
    expect(chatCalls().some(c => c.sub)).toBe(false);
    expect(onToolResult.mock.calls[0][0].output).toContain('[DRY RUN]');
  });

  it('a tool gated for this run is gated inside the sub-agent too', async () => {
    setScript(call => {
      if (call.sub) return chatCalls().filter(c => c.sub).length === 1
        ? use(['write_file', { path: 'sub.txt', content: 'x' }])
        : say('Sub-agent done.');
      return chatCalls().filter(c => !c.sub).length === 1
        ? use(['delegate', { task: 'write sub.txt' }])
        : say('All done.');
    });
    const asked: string[] = [];

    await runAgent('do it', ctx(), {
      autoVerify: false,
      maxIterations: 5,
      extraDangerousTools: ['write_file', 'edit_file'],
      onRequestPermission: async t => { asked.push(t.tool); return 'reject_once'; },
    });

    expect(asked).toEqual(['write_file']);
    expect(existsSync(join(root, 'sub.txt'))).toBe(false);
  });

  it('an "always deny" given in the parent holds in the sub-agent', async () => {
    writeFileSync(join(root, 'keep.txt'), 'important');
    setScript(call => {
      if (call.sub) return chatCalls().filter(c => c.sub).length === 1
        ? use(['delete_file', { path: 'keep.txt' }])
        : say('Sub-agent done.');
      const n = chatCalls().filter(c => !c.sub).length;
      if (n === 1) return use(['delete_file', { path: 'keep.txt' }]);
      if (n === 2) return use(['delegate', { task: 'delete keep.txt' }]);
      return say('All done.');
    });
    const asked: string[] = [];

    await runAgent('do it', ctx(), {
      autoVerify: false,
      maxIterations: 5,
      onRequestPermission: async t => { asked.push(t.tool); return 'reject_always'; },
    });

    expect(asked).toEqual(['delete_file']);
    expect(existsSync(join(root, 'keep.txt'))).toBe(true);
  });

  it('an "always allow" given in the parent holds in the sub-agent', async () => {
    writeFileSync(join(root, 'one.txt'), 'x');
    writeFileSync(join(root, 'two.txt'), 'x');
    setScript(call => {
      if (call.sub) return chatCalls().filter(c => c.sub).length === 1
        ? use(['delete_file', { path: 'two.txt' }])
        : say('Sub-agent done.');
      const n = chatCalls().filter(c => !c.sub).length;
      if (n === 1) return use(['delete_file', { path: 'one.txt' }]);
      if (n === 2) return use(['delegate', { task: 'delete two.txt' }]);
      return say('All done.');
    });
    const asked: string[] = [];

    await runAgent('do it', ctx(), {
      autoVerify: false,
      maxIterations: 5,
      onRequestPermission: async t => { asked.push(t.tool); return 'allow_always'; },
    });

    expect(asked).toEqual(['delete_file']);
    expect(existsSync(join(root, 'one.txt'))).toBe(false);
    expect(existsSync(join(root, 'two.txt'))).toBe(false);
  });

  it('tells a sub-agent with an empty tool list that it has no tools', async () => {
    mkdirSync(join(root, '.codeep', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codeep', 'agents', 'thinker.md'), '---\nname: thinker\ntools: []\n---\nYou only think.\n');
    setScript(call => {
      if (call.sub) return say('Thought about it.');
      return chatCalls().filter(c => !c.sub).length === 1
        ? use(['delegate', { agent: 'thinker', task: 'think' }])
        : say('All done.');
    });

    await runAgent('x', ctx(), { autoVerify: false, maxIterations: 5 });

    const sub = chatCalls().find(c => c.sub)!;
    expect(sub.system).toContain('You may not use any tools.');
    expect(sub.system).not.toContain('You may use ONLY these tools: .');
  });
});

describe('resolveDelegateModel', () => {
  const current = { providerId: 'z.ai', model: 'glm-5.2', protocol: 'anthropic' as const };

  it('reads a bare name as a model on the current provider', async () => {
    expect(await resolveDelegateModel('glm-4.6', current)).toEqual({ ...current, model: 'glm-4.6' });
  });

  it('keeps the current provider when the prefix is not a provider', async () => {
    expect(await resolveDelegateModel('no-such-provider/some-model', current))
      .toEqual({ ...current, model: 'some-model' });
  });

  it('uses the provider\'s default protocol when it does not speak the current one', async () => {
    const { getProvider } = await import('../config/providers');
    expect(getProvider('kimi')!.protocols.anthropic).toBeFalsy();

    const onKimi = { providerId: 'kimi', model: 'kimi-k2', protocol: 'anthropic' as const };
    expect(await resolveDelegateModel('kimi/kimi-k2.5', onKimi))
      .toEqual({ providerId: 'kimi', model: 'kimi-k2.5', protocol: getProvider('kimi')!.defaultProtocol });
  });

  it('uses the new provider\'s default protocol when switching provider', async () => {
    const { getProvider } = await import('../config/providers');
    const deepseek = getProvider('deepseek')!;
    expect(deepseek.protocols.anthropic).toBeTruthy();
    expect(deepseek.defaultProtocol).not.toBe('anthropic');

    expect(await resolveDelegateModel('deepseek/deepseek-chat', current))
      .toEqual({ providerId: 'deepseek', model: 'deepseek-chat', protocol: deepseek.defaultProtocol });
  });

  it('loads the API key of a provider the parent has not used', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      await createSecureStorage(config).setApiKey('deepseek', 'sk-sub-agent');
      expect(getApiKey('deepseek')).toBe('');

      await resolveDelegateModel('deepseek/deepseek-chat', current);

      expect(getApiKey('deepseek')).toBe('sk-sub-agent');
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});

describe('sub-agent model override', () => {
  const agentFile = (model: string) => {
    mkdirSync(join(root, '.codeep', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codeep', 'agents', 'other.md'), `---\nname: other\nmodel: ${model}\n---\nYou are other.\n`);
  };
  const snapshot = () => ({ provider: config.get('provider'), model: config.get('model'), protocol: config.get('protocol') });

  beforeEach(() => {
    config.set('provider', 'z.ai');
    config.set('protocol', 'anthropic');
    config.set('model', 'glm-5.2');
  });

  const delegateOnce = async () => {
    const seenInSub: Array<ReturnType<typeof snapshot>> = [];
    setScript(call => {
      if (call.sub) {
        seenInSub.push(snapshot());
        return say('Sub-agent done.');
      }
      return chatCalls().filter(c => !c.sub).length === 1
        ? use(['delegate', { agent: 'other', task: 'look around' }])
        : say('All done.');
    });
    await runAgent('x', ctx(), { autoVerify: false, maxIterations: 5 });
    return { seenInSub, subRuntime: chatCalls().find(c => c.sub)?.runtime };
  };

  // The saved config is shared by every session in the process and by the
  // next launch; one sub-agent must never change it, not even briefly.
  it('runs the sub-agent on its own provider without touching the saved config', async () => {
    agentFile('deepseek/deepseek-chat');
    const before = snapshot();

    const { seenInSub, subRuntime } = await delegateOnce();

    expect(subRuntime).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat', protocol: 'openai' });
    expect(seenInSub).toEqual([before]);
    expect(snapshot()).toEqual(before);
  });

  it('keeps the user\'s protocol when the sub-agent stays on the same provider', async () => {
    agentFile('glm-4.6');

    const { subRuntime } = await delegateOnce();

    expect(subRuntime).toMatchObject({ providerId: 'z.ai', model: 'glm-4.6', protocol: 'anthropic' });
    expect(snapshot()).toEqual({ provider: 'z.ai', model: 'glm-5.2', protocol: 'anthropic' });
  });
});

describe('MCP tools and the permission prompt', () => {
  const runWithMcp = async (tool: string, onRequestPermission?: () => Promise<'allow_once' | 'reject_once'>) => {
    setScript(() => (chatCalls().length === 1 ? use([tool, { sql: 'DROP TABLE users' }]) : say('All done.')));
    const asked: string[] = [];
    await runAgent('x', ctx(), {
      autoVerify: false,
      maxIterations: 5,
      mcpSessionId: 'agent-loop-test',
      onRequestPermission: onRequestPermission
        ? async t => { asked.push(t.tool); return onRequestPermission(); }
        : undefined,
    });
    return asked;
  };

  it('asks before an MCP tool runs, and a denial stops it', async () => {
    const asked = await runWithMcp('postgres__query', async () => 'reject_once');

    expect(asked).toEqual(['postgres__query']);
    expect(callSessionTool).not.toHaveBeenCalled();
  });

  it('runs the MCP tool once the user allows it', async () => {
    const asked = await runWithMcp('postgres__query', async () => 'allow_once');

    expect(asked).toEqual(['postgres__query']);
    expect(callSessionTool).toHaveBeenCalledOnce();
  });

  it('does not ask for the read-only resource and prompt wrappers', async () => {
    const asked = await runWithMcp('postgres__resource_list', async () => 'reject_once');

    expect(asked).toEqual([]);
    expect(callSessionVirtualTool).toHaveBeenCalledOnce();
  });

  it('does not ask when the run has no permission prompt (auto mode)', async () => {
    const asked = await runWithMcp('postgres__query');

    expect(asked).toEqual([]);
    expect(callSessionTool).toHaveBeenCalledOnce();
  });
});

describe('verification fix loop', () => {
  const writeThenFix = (fix: ChatResponse) => {
    setScript(call => {
      if (lastMessage(call).includes('Verification Errors')) return fix;
      return chatCalls().length === 1
        ? use(['write_file', { path: 'a.txt', content: 'x' }])
        : say('Wrote a.txt.');
    });
  };

  it('asks before a dangerous fix and honours the denial', async () => {
    writeFileSync(join(root, 'victim.txt'), 'important');
    h.verifyQueue = [[failing('build', [{ severity: 'error', message: 'build broke' }])], [passing('build')]];
    writeThenFix(use(['delete_file', { path: 'victim.txt' }]));
    const asked: string[] = [];

    await runAgent('x', ctx(), {
      autoVerify: 'build',
      maxFixAttempts: 2,
      maxIterations: 10,
      onRequestPermission: async t => { asked.push(t.tool); return 'reject_once'; },
    });

    expect(asked).toEqual(['delete_file']);
    expect(existsSync(join(root, 'victim.txt'))).toBe(true);
  });

  it('sends fix commands to the editor terminal like any other command', async () => {
    h.verifyQueue = [[failing('build', [{ severity: 'error', message: 'build broke' }])], [passing('build')]];
    writeThenFix(use(['execute_command', { command: 'ls', args: ['-a'] }]));
    const onExecuteCommand = vi.fn(async () => ({ stdout: 'a.txt', stderr: '', exitCode: 0 }));

    await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 2, maxIterations: 10, onExecuteCommand });

    expect(onExecuteCommand).toHaveBeenCalledWith('ls', ['-a'], root);
  });
});

describe('commands sent to the editor terminal', () => {
  it('are not run again here when the terminal callback throws', async () => {
    setScript(() => (chatCalls().length === 1
      ? use(['execute_command', { command: 'touch', args: ['ran-here.txt'] }])
      : say('All done.')));
    const onExecuteCommand = vi.fn(async () => { throw new Error('terminal went away'); });
    const onToolResult = vi.fn();

    await runAgent('x', ctx(), { autoVerify: false, maxIterations: 5, onExecuteCommand, onToolResult });

    expect(onExecuteCommand).toHaveBeenCalledOnce();
    expect(existsSync(join(root, 'ran-here.txt'))).toBe(false);
    expect(onToolResult.mock.calls[0][0]).toMatchObject({ success: false });
    expect(onToolResult.mock.calls[0][0].error).toContain('terminal went away');
  });
});

describe('verification outcome', () => {
  const writeAndFinish = (path: string, text: string) => {
    setScript(call => {
      if (lastMessage(call).includes('Verification Errors')) return say('Tried to fix it.');
      return chatCalls().length === 1 ? use(['write_file', { path, content: 'x' }]) : say(text);
    });
  };

  it('reports a failing check even when its errors are in files the run did not touch', async () => {
    // Renaming an export in a.ts breaks b.ts, which the agent never opened.
    const tsError = { file: 'src/b.ts', line: 3, column: 10, severity: 'error' as const, code: 'TS2305', message: "Module './a' has no exported member 'foo'." };
    h.verifyQueue = [[failing('typecheck', [tsError])]];
    writeAndFinish('src/a.ts', 'Renamed foo to bar.');

    const result = await runAgent('rename foo', ctx(), { autoVerify: 'typecheck', maxFixAttempts: 2, maxIterations: 10 });

    expect(result.success).toBe(false);
    expect(result.finalResponse).not.toContain('Verification passed');
    expect(result.finalResponse).toContain('✗ Verification failed');
    expect(result.finalResponse).toContain('src/b.ts');
    const fixPrompt = chatCalls().map(lastMessage).find(m => m.includes('Verification Errors'));
    expect(fixPrompt).toContain('src/b.ts');
    expect(fixPrompt).toContain('did not change');
  });

  it('reports a failing check whose output could not be parsed', async () => {
    h.verifyQueue = [[failing('build', [{ severity: 'warning', message: "Failed to resolve import './x'" }])]];
    writeAndFinish('src/a.ts', 'Wired main.');

    const result = await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 1, maxIterations: 10 });

    expect(result.success).toBe(false);
    expect(result.finalResponse).not.toContain('Verification passed');
    expect(result.finalResponse).toContain("Failed to resolve import './x'");
  });

  it('fails the run when the only attempt fails, keeping the model\'s summary', async () => {
    h.verifyQueue = [[failing('build', [{ file: 'src/a.ts', line: 1, severity: 'error', message: 'Type error' }])]];
    writeAndFinish('src/a.ts', 'Implemented the feature.');

    const result = await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 1, maxIterations: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('npm run build');
    expect(result.finalResponse).toMatch(/^Implemented the feature\.\n\n✗ Verification failed: 1\/1 checks/);
    expect(result.finalResponse).toContain('src/a.ts:1: Type error');
  });

  it('shows at most five errors per check and shortens long messages', async () => {
    const errors = Array.from({ length: 7 }, (_, i) => ({
      file: 'src/a.ts', line: i + 1, severity: 'error' as const, message: i === 0 ? 'x'.repeat(300) : `error ${i + 1}`,
    }));
    h.verifyQueue = [[failing('typecheck', errors)]];
    writeAndFinish('src/a.ts', 'Done.');

    const result = await runAgent('x', ctx(), { autoVerify: 'typecheck', maxFixAttempts: 1, maxIterations: 10 });

    expect(result.finalResponse).toContain(`src/a.ts:1: ${'x'.repeat(200)}…`);
    expect(result.finalResponse).not.toContain('x'.repeat(201));
    expect(result.finalResponse).toContain('src/a.ts:5: error 5');
    expect(result.finalResponse).not.toContain('error 6');
    expect(result.finalResponse).toContain('…and 2 more');
  });

  it('neither fails the run nor asks for a fix when a check could not run', async () => {
    const reason = "The shell guard refused `/p/node_modules/.bin/tsc`: not in the allowed list";
    h.verifyQueue = [[notRun('typecheck', reason)]];
    writeAndFinish('src/a.ts', 'Added a.');

    const result = await runAgent('x', ctx(), { autoVerify: 'typecheck', maxFixAttempts: 3, maxIterations: 10 });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.finalResponse).toContain('⚠ Verification could not run: 1/1 checks');
    expect(result.finalResponse).toContain(reason);
    expect(result.finalResponse).not.toContain('Verification failed');
    expect(result.finalResponse).not.toContain('Verification passed');
    expect(chatCalls().map(lastMessage).some(m => m.includes('Verification Errors'))).toBe(false);
    expect(h.verifyRuns).toBe(1);
  });

  it('reports the checks that passed next to the ones that could not run', async () => {
    h.verifyQueue = [[passing('build'), notRun('typecheck', 'TypeScript is not installed')]];
    writeAndFinish('src/a.ts', 'Added a.');

    const result = await runAgent('x', ctx(), { autoVerify: 'all', maxFixAttempts: 1, maxIterations: 10 });

    expect(result.success).toBe(true);
    expect(result.finalResponse).toContain('✓ Verification passed: 1/2 checks');
    expect(result.finalResponse).toContain('⚠ Verification could not run: 1/2 checks');
  });

  it('fails on the checks that failed, not on the ones that could not run', async () => {
    h.verifyQueue = [[
      failing('test', [{ file: 'src/a.test.ts', severity: 'error', message: 'Test failed: a > works' }]),
      notRun('typecheck', 'TypeScript is not installed'),
    ]];
    writeAndFinish('src/a.ts', 'Added a.');

    const result = await runAgent('x', ctx(), { autoVerify: 'all', maxFixAttempts: 2, maxIterations: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Verification failed: npm run test');
    expect(result.failedChecks).toEqual(['npm run test']);
    expect(result.finalResponse).toContain('✗ Verification failed: 1/2 checks');
    expect(result.finalResponse).toContain('⚠ Verification could not run: 1/2 checks');
    const fixPrompt = chatCalls().map(lastMessage).find(m => m.includes('Verification Errors'))!;
    expect(fixPrompt).toContain('npm run test');
    expect(fixPrompt).not.toContain('npm run typecheck');
  });

  it('stops when the user stops the run during a fix', async () => {
    const controller = new AbortController();
    h.verifyQueue = [[failing('build', [{ file: 'src/a.ts', severity: 'error', message: 'Type error' }])], [passing('build')]];
    setScript(call => {
      if (lastMessage(call).includes('Verification Errors')) {
        controller.abort();
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
      return chatCalls().length === 1 ? use(['write_file', { path: 'src/a.ts', content: 'x' }]) : say('Implemented.');
    });

    const result = await runAgent('x', ctx(), {
      autoVerify: 'build', maxFixAttempts: 3, maxIterations: 10, abortSignal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.finalResponse).not.toContain('Verification failed');
    expect(h.verifyRuns).toBe(1);
  });

  it('stops the running checks and reports a stopped run when the user stops during them', async () => {
    const controller = new AbortController();
    // Stopping kills the check, which comes back as not run.
    h.verifyQueue = [[notRun('build', 'Stopped by the user.')]];
    h.onVerify = () => controller.abort();
    writeAndFinish('src/a.ts', 'Implemented.');

    const result = await runAgent('x', ctx(), {
      autoVerify: 'build', maxFixAttempts: 3, maxIterations: 10, abortSignal: controller.signal,
    });

    expect(h.verifyOptions[0]?.signal).toBe(controller.signal);
    expect(result.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.finalResponse).not.toContain('Verification could not run');
  });

  it('succeeds when a fix makes the checks pass', async () => {
    h.verifyQueue = [[failing('build', [{ file: 'src/a.ts', severity: 'error', message: 'Type error' }])], [passing('build')]];
    writeAndFinish('src/a.ts', 'Implemented the feature.');

    const result = await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 2, maxIterations: 10 });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.finalResponse).toContain('✓ Verification passed: 1/1 checks');
    expect(result.finalResponse).not.toContain('Verification failed');
  });
});

describe('step limit after a "continue" nudge', () => {
  it('pauses instead of reporting the unfinished fragment as the answer', async () => {
    setScript(() => (chatCalls().length === 1
      ? say('Let me look at the files:')
      : use(['list_files', { path: '.' }])));

    const result = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 4 });

    expect(result.success).toBe(false);
    expect(result.interrupted).toBe('iteration_limit');
    expect(result.finalResponse).not.toBe('Let me look at the files:');
  });

  it('still finishes normally when the model answers after the nudge', async () => {
    setScript(() => (chatCalls().length === 1 ? say('Let me look at the files:') : say('The project has no files yet.')));

    const result = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 4 });

    expect(result.success).toBe(true);
    expect(result.interrupted).toBeUndefined();
    expect(result.finalResponse).toBe('The project has no files yet.');
  });
});

describe('stopping a running command', () => {
  it('kills the command instead of waiting for it to finish', async () => {
    setScript(() => (chatCalls().length === 1
      ? use(['execute_command', { command: 'sleep', args: ['4'] }])
      : say('Done.')));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();

    const result = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 5, abortSignal: controller.signal });

    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.aborted).toBe(true);
  }, 10000);

  it('does not run the tool calls queued behind the stopped one', async () => {
    setScript(() => (chatCalls().length === 1
      ? use(
        ['execute_command', { command: 'sleep', args: ['4'] }],
        ['write_file', { path: 'after-stop.txt', content: 'should not exist' }],
      )
      : say('Done.')));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 5, abortSignal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(existsSync(join(root, 'after-stop.txt'))).toBe(false);
  }, 10000);

  it('does not run the fix calls queued behind a stop during the fix loop', async () => {
    const controller = new AbortController();
    h.verifyQueue = [[failing('build', [{ severity: 'error', message: 'build broke' }])], [passing('build')]];
    setScript(call => {
      if (lastMessage(call).includes('Verification Errors')) {
        return use(
          ['execute_command', { command: 'sleep', args: ['4'] }],
          ['write_file', { path: 'fix-after-stop.txt', content: 'should not exist' }],
        );
      }
      return chatCalls().length === 1 ? use(['write_file', { path: 'a.txt', content: 'x' }]) : say('Wrote a.txt.');
    });
    h.onVerify = () => { setTimeout(() => controller.abort(), 200); h.onVerify = undefined; };

    const result = await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 2, maxIterations: 10, abortSignal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(existsSync(join(root, 'fix-after-stop.txt'))).toBe(false);
  }, 10000);
});

describe('unstreamedText: what the loop added after the model\'s reply', () => {
  const writeThen = (reply: string, fix = 'Tried to fix it.') => {
    setScript(call => {
      if (lastMessage(call).includes('Verification Errors')) return say(fix);
      return chatCalls().length === 1 ? use(['write_file', { path: 'src/a.ts', content: 'x' }]) : say(reply);
    });
  };

  it('is the verification block, not the reply', async () => {
    h.verifyQueue = [[passing('build')]];
    writeThen('Implemented.');

    const result = await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 1, maxIterations: 10 });

    expect(result.unstreamedText).toBe('✓ Verification passed: 1/1 checks');
    expect(result.finalResponse).toBe('Implemented.\n\n✓ Verification passed: 1/1 checks');
  });

  it('holds only the appended blocks when the reply was cleaned up', async () => {
    h.verifyQueue = [[
      failing('test', [{ file: 'src/a.test.ts', severity: 'error', message: 'Test failed: a > works' }]),
      notRun('typecheck', 'TypeScript is not installed'),
    ]];
    // The streamed reply carried a tool-call tag that the response drops.
    writeThen('Implemented.<tool_call>{"x":1}</tool_call>\n\nAll set.');

    const result = await runAgent('x', ctx(), { autoVerify: 'all', maxFixAttempts: 1, maxIterations: 10 });

    expect(result.unstreamedText).toMatch(/^✗ Verification failed: 1\/2 checks\n/);
    expect(result.unstreamedText).toContain('⚠ Verification could not run: 1/2 checks');
    expect(result.unstreamedText).not.toContain('All set.');
    expect(result.finalResponse.endsWith(result.unstreamedText!)).toBe(true);
  });

  it('leaves out a reply the model gave during a fix', async () => {
    h.verifyQueue = [[failing('build', [{ file: 'src/a.ts', severity: 'error', message: 'Type error' }])], [passing('build')]];
    writeThen('Implemented.', 'Fixed the type error.');

    const result = await runAgent('x', ctx(), { autoVerify: 'build', maxFixAttempts: 2, maxIterations: 10 });

    expect(result.finalResponse).toBe('Fixed the type error.\n\n✓ Verification passed: 1/1 checks');
    expect(result.unstreamedText).toBe('✓ Verification passed: 1/1 checks');
  });

  it('includes the auto-review section', async () => {
    config.set('agentAutoReview', true);
    setScript(call => {
      if (call.sub) return say('Looks solid.');
      return chatCalls().length === 1 ? use(['write_file', { path: 'src/a.ts', content: 'x' }]) : say('Implemented.');
    });

    const result = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 10 });

    expect(result.unstreamedText).toBe('---\n### Auto-review (reviewer)\nLooks solid.');
    expect(result.finalResponse).toBe(`Implemented.\n\n${result.unstreamedText}`);
  });

  it('is empty when the response is only the reply', async () => {
    setScript(() => say('The project has no files yet.'));

    const result = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 4 });

    expect(result.unstreamedText).toBe('');
  });

  it('is the whole notice when one replaced the reply', async () => {
    setScript(() => use(['list_files', { path: '.' }]));

    const paused = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 2 });

    expect(paused.interrupted).toBe('iteration_limit');
    expect(paused.unstreamedText).toBe(paused.finalResponse);

    const controller = new AbortController();
    controller.abort();
    const stopped = await runAgent('x', ctx(), { autoVerify: false, maxIterations: 2, abortSignal: controller.signal });

    expect(stopped.unstreamedText).toBe('Agent was stopped by user');
  });

  it('carries the stop notice when the run is stopped during verification', async () => {
    const controller = new AbortController();
    h.verifyQueue = [[notRun('build', 'Stopped by the user.')]];
    h.onVerify = () => controller.abort();
    writeThen('Implemented.');

    const result = await runAgent('x', ctx(), {
      autoVerify: 'build', maxFixAttempts: 1, maxIterations: 10, abortSignal: controller.signal,
    });

    expect(result.finalResponse).toBe('Implemented.\n\nAgent was stopped by user before verification finished');
    expect(result.unstreamedText).toBe('Agent was stopped by user before verification finished');
  });
});
