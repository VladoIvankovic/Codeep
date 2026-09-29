import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock('../api/index.js', () => ({ chat: mockChat }));
vi.mock('../config/index.js', () => ({ config: { get: vi.fn(() => 'claude-sonnet-5-5') } }));

import { handleMcpSamplingRequest, resetSamplingBudget } from './mcpSamplingBridge';

const params = {
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Summarize this log.' } }],
};

describe('handleMcpSamplingRequest', () => {
  beforeEach(() => {
    mockChat.mockReset();
    resetSamplingBudget();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('returns the completion as the assistant text', async () => {
    mockChat.mockResolvedValue('Three errors, all timeouts.');
    await expect(handleMcpSamplingRequest(params, 'logs')).resolves.toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'Three errors, all timeouts.' },
      model: 'claude-sonnet-5-5',
      stopReason: 'endTurn',
    });
  });

  // chat() returns the notice on a decline. As a completion with stopReason
  // 'endTurn' the server would take it for the model's answer (before the
  // notice it got an empty one); thrown, the MCP client answers the server
  // with "sampling failed: Claude declined this request (…)", as macOS does.
  it('fails the request when the model declines it', async () => {
    mockChat.mockResolvedValue('Claude declined this request (category: cyber).');
    await expect(handleMcpSamplingRequest(params, 'scanner'))
      .rejects.toThrow('Claude declined this request (category: cyber).');
  });
});
