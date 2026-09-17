/**
 * What runAgentSession sends the client once the run ends. The model's text
 * is streamed while it arrives; whatever the loop adds afterwards (the
 * verification result, a reviewer's notes) or puts in its place (a notice
 * that the API kept failing) must still reach the editor, once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/agent.js')>();
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, type AgentResult, type AgentOptions } from '../utils/agent';
import { runAgentSession } from './session';

const SUMMARY = 'I updated `src/auth.ts` to check the token expiry.';
const FAILED_BLOCK = '✗ Verification failed: 1/2 checks\n- build: `npm run build`\n  - src/auth.ts:12: Type error';

let chunks: string[];

/** runAgent that streams `streamedChunks`, then resolves with `result`. */
function agentReturns(streamedChunks: string[], result: AgentResult) {
  vi.mocked(runAgent).mockImplementation(async (_prompt, _ctx, opts?: Partial<AgentOptions>) => {
    for (const c of streamedChunks) opts?.onChunk?.(c);
    return result;
  });
}

function start() {
  return runAgentSession({
    prompt: 'fix the auth bug',
    workspaceRoot: '/var/empty/codeep-final-response-test',
    conversationId: 'acp-final',
    abortSignal: new AbortController().signal,
    onChunk: (text) => { chunks.push(text); },
  });
}

beforeEach(() => {
  chunks = [];
  vi.mocked(runAgent).mockReset();
});

describe('runAgentSession — the end of the response', () => {
  it('sends a verification failure that was added after the model streamed its summary', async () => {
    agentReturns(['I updated `src/auth.ts` ', 'to check the token expiry.'], {
      success: false,
      iterations: 3,
      actions: [],
      finalResponse: `${SUMMARY}\n\n${FAILED_BLOCK}`,
      error: 'Verification failed: npm run build',
      failedChecks: ['npm run build'],
      unstreamedText: FAILED_BLOCK,
    });
    await expect(start()).resolves.toBeUndefined();
    expect(chunks).toEqual(['I updated `src/auth.ts` ', 'to check the token expiry.', `\n\n${FAILED_BLOCK}`]);
  });

  it('sends a passed verification and a reviewer section without repeating the summary', async () => {
    const review = '---\n### Auto-review (reviewer)\nNo issues.\n\nLooks solid.';
    agentReturns([SUMMARY], {
      success: true,
      iterations: 2,
      actions: [],
      finalResponse: `${SUMMARY}\n\n✓ Verification passed: 2/2 checks\n\n${review}`,
      unstreamedText: `✓ Verification passed: 2/2 checks\n\n${review}`,
    });
    await start();
    expect(chunks).toEqual([SUMMARY, `\n\n✓ Verification passed: 2/2 checks\n\n${review}`]);
  });

  it('sends a closing notice that replaced the answer', async () => {
    const notice = 'Agent made progress (2 actions) but API errors prevented completion. You can continue by running the agent again.';
    agentReturns(['Reading the files first.'], {
      success: false,
      iterations: 4,
      actions: [],
      finalResponse: notice,
      error: 'API failed after 3 retries: 503',
      unstreamedText: notice,
    });
    await expect(start()).resolves.toBeUndefined();
    expect(chunks).toEqual(['Reading the files first.', `\n\n${notice}`]);
  });

  it('sends nothing more when everything was streamed', async () => {
    agentReturns([SUMMARY], { success: true, iterations: 1, actions: [], finalResponse: SUMMARY, unstreamedText: '' });
    await start();
    expect(chunks).toEqual([SUMMARY]);
  });

  it('still reports a cancelled run as cancelled, without a closing notice', async () => {
    agentReturns([SUMMARY], {
      success: false, iterations: 1, actions: [], aborted: true,
      finalResponse: `${SUMMARY}\n\nAgent was stopped by user before verification finished`,
      unstreamedText: 'Agent was stopped by user before verification finished',
    });
    await expect(start()).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunks).toEqual([SUMMARY]);
  });

  // The block's last paragraph is the tool's own short output, which the
  // model had already quoted. What was added is known, so it is sent whole.
  it('sends a verification failure whose last lines the model had already quoted', async () => {
    const block = '✗ Verification failed: 1/1 checks\n- build: `npm run build`\n  - > app@1.0.0 build\n> next build\n\nFailed to compile.';
    const answer = 'Done — the build error is fixed.';
    agentReturns(['The build output says: Failed to compile. Let me fix it.', `\n\n${answer}`], {
      success: false,
      iterations: 3,
      actions: [],
      finalResponse: `${answer}\n\n${block}`,
      error: 'Verification failed: npm run build',
      failedChecks: ['npm run build'],
      unstreamedText: block,
    });
    await expect(start()).resolves.toBeUndefined();
    expect(chunks.at(-1)).toBe(`\n\n${block}`);
    expect(chunks.join('').match(/Done — the build error is fixed\./g)).toHaveLength(1);
  });

  it('repeats nothing the model wrote, even text the loop reworded', async () => {
    agentReturns(['one\n\ntwo <tool_call>x</tool_call> now'], {
      success: true, iterations: 1, actions: [],
      finalResponse: 'one\n\ntwo  now\n\n✓ Verification passed: 1/1 checks',
      unstreamedText: '✓ Verification passed: 1/1 checks',
    });
    await start();
    expect(chunks).toEqual(['one\n\ntwo <tool_call>x</tool_call> now', '\n\n✓ Verification passed: 1/1 checks']);
  });
});
