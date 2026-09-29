import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock('../api/index.js', () => ({ chat: mockChat }));

import { generateSessionTitle } from './sessionTitles';

const history = [
  { role: 'user' as const, content: 'scan my network for open ports' },
  { role: 'assistant' as const, content: 'Which subnet?' },
  { role: 'user' as const, content: '10.0.0.0/24' },
];

describe('generateSessionTitle', () => {
  beforeEach(() => { mockChat.mockReset(); });

  it('cleans a title the model returns', async () => {
    mockChat.mockResolvedValue('"Port scan of the home subnet."');
    expect(await generateSessionTitle(history)).toBe('Port scan of the home subnet');
  });

  // chat() returns the notice on a decline. As a title the session would be
  // listed as "Claude declined this request (category: cyber)" in /sessions and
  // /recall; null keeps the first-message fallback, as a pre-output decline's
  // "" did before the notice existed.
  it('gives no title for a declined request', async () => {
    for (const notice of ['Claude declined this request (category: cyber).', 'Claude declined this request.']) {
      mockChat.mockResolvedValue(notice);
      expect(await generateSessionTitle(history)).toBeNull();
    }
  });
});
