/**
 * runAgentSession hands the conversation's earlier turns to the agent loop.
 * ACP clients send only the new message, so this is the only way a loaded,
 * rewound or compacted session reaches the model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/agent.js')>();
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from '../utils/agent';
import { runAgentSession, toAgentChatHistory } from './session';
import type { Message } from '../config/index';

const HISTORY: Message[] = [
  { role: 'system', content: '[Conversation compacted — 4 earlier messages summarized below]' },
  { role: 'user', content: 'My secret codeword is ZEBRA-42' },
  { role: 'assistant', content: 'Noted.' },
];

beforeEach(() => {
  vi.mocked(runAgent).mockReset().mockResolvedValue({ success: true, iterations: 1, actions: [], finalResponse: 'ZEBRA-42' });
});

function start(chatHistory?: Message[]) {
  return runAgentSession({
    prompt: 'What is my codeword?',
    workspaceRoot: '/var/empty/codeep-history-test',
    conversationId: 'acp-7',
    abortSignal: new AbortController().signal,
    onChunk: () => {},
    chatHistory,
  });
}

describe('runAgentSession — earlier turns', () => {
  it('passes the user and assistant turns to the agent, as the TUI does', async () => {
    await start(HISTORY);
    const opts = vi.mocked(runAgent).mock.calls[0][2]!;
    expect(opts.chatHistory).toEqual([
      { role: 'user', content: 'My secret codeword is ZEBRA-42' },
      { role: 'assistant', content: 'Noted.' },
    ]);
    expect(vi.mocked(runAgent).mock.calls[0][0]).toBe('What is my codeword?');
  });

  it('passes no history when the session has none', async () => {
    await start();
    expect(vi.mocked(runAgent).mock.calls[0][2]!.chatHistory).toBeUndefined();
  });
});

describe('toAgentChatHistory', () => {
  it('keeps only role and content of user and assistant messages', () => {
    const withExtra = [{ ...HISTORY[1], extra: 'x' } as Message, HISTORY[0], HISTORY[2]];
    expect(toAgentChatHistory(withExtra)).toEqual([
      { role: 'user', content: 'My secret codeword is ZEBRA-42' },
      { role: 'assistant', content: 'Noted.' },
    ]);
  });
});
