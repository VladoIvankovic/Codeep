import { describe, it, expect, vi, beforeEach } from 'vitest';

// summarizeEarlierHistory asks chat() (dynamically imported) for the recap. Its
// own file: agentChat.test.ts leaves api/index real, and agentChat.ts also takes
// ApiError from it, which the mock keeps.
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock('../api/index.js', () => ({
  chat: mockChat,
  ApiError: class ApiError extends Error { constructor(message: string, public status = 0) { super(message); } },
}));
vi.mock('../config/index', () => ({
  config: { get: vi.fn(() => undefined) },
  getApiKey: vi.fn(() => 'sk-test'),
  resolveBaseUrl: vi.fn(() => 'https://api.example.com'),
  Message: {},
}));

import { summarizeEarlierHistory } from './agentChat';

// Six turns of ~90 chars against a 200-char budget: the older ones overflow and
// are summarized. `tag` keeps each test's dropped prefix (the cache key) its own.
function overflowing(tag: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `${tag} turn ${i} ${'x'.repeat(80)}`,
  }));
}

describe('summarizeEarlierHistory over a decline', () => {
  beforeEach(() => { mockChat.mockReset(); });

  // Cached, the notice would sit in every agent prompt for this prefix as
  // "established background" and never be asked for again.
  it('neither injects nor caches the notice, and asks again next time', async () => {
    const history = overflowing('declined');
    mockChat.mockResolvedValue('Claude declined this request (category: cyber).');
    expect(await summarizeEarlierHistory(history, 200)).toBe('');
    expect(await summarizeEarlierHistory(history, 200)).toBe('');
    expect(mockChat).toHaveBeenCalledTimes(2);

    // Once a real recap comes back it is used and cached as before.
    mockChat.mockResolvedValue('They moved auth to OAuth2 and kept the session table.');
    const block = await summarizeEarlierHistory(history, 200);
    expect(block).toContain('## Earlier Conversation (summarized)');
    expect(block).toContain('They moved auth to OAuth2');
    expect(await summarizeEarlierHistory(history, 200)).toBe(block);
    expect(mockChat).toHaveBeenCalledTimes(3);
  });

  it('still uses a recap that merely mentions a decline', async () => {
    mockChat.mockResolvedValue('Claude declined this request (category: cyber). The user then narrowed the scan to localhost.');
    expect(await summarizeEarlierHistory(overflowing('mentions'), 200)).toContain('narrowed the scan');
  });
});
