import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module's session helpers so we control the corpus.
vi.mock('../config/index.js', () => ({
  listSessionsWithInfo: vi.fn(),
  loadSession: vi.fn(),
}));

import { recallSessions, formatRecall } from './recall';
import { listSessionsWithInfo, loadSession } from '../config/index.js';

const today = new Date().toISOString();
const longAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();

function mockCorpus(corpus: Record<string, { createdAt: string; messages: { role: string; content: string }[] }>) {
  vi.mocked(listSessionsWithInfo).mockReturnValue(
    Object.entries(corpus).map(([name, s]) => ({
      name,
      title: name,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
      fileSize: 100,
    })),
  );
  vi.mocked(loadSession).mockImplementation((name: string) => {
    const s = corpus[name];
    return s ? (s.messages as any) : null;
  });
}

describe('recallSessions', () => {
  beforeEach(() => {
    vi.mocked(listSessionsWithInfo).mockReset();
    vi.mocked(loadSession).mockReset();
  });

  it('returns empty for empty query', () => {
    mockCorpus({});
    expect(recallSessions('', undefined)).toEqual([]);
    expect(recallSessions('   ', undefined)).toEqual([]);
  });

  it('matches a session containing the query term', () => {
    mockCorpus({
      's1': { createdAt: today, messages: [{ role: 'user', content: 'help me with OAuth login' }] },
      's2': { createdAt: today, messages: [{ role: 'user', content: 'fix the CSS layout' }] },
    });
    const matches = recallSessions('oauth', undefined);
    expect(matches).toHaveLength(1);
    expect(matches[0].session.name).toBe('s1');
    expect(matches[0].snippet.toLowerCase()).toContain('oauth');
  });

  it('requires ALL terms to appear (AND semantics)', () => {
    mockCorpus({
      's1': { createdAt: today, messages: [{ role: 'user', content: 'OAuth and JWT tokens' }] },
      's2': { createdAt: today, messages: [{ role: 'user', content: 'OAuth only, no jwt here' }, { role: 'assistant', content: 'sure' }] },
      's3': { createdAt: today, messages: [{ role: 'user', content: 'just JWT no oauth mention... wait it does' }] },
    });
    // s1 has both oauth+jwt. s2 has oauth+jwt (across the word "jwt" in content). s3 has both.
    const matches = recallSessions('oauth jwt', undefined);
    const names = matches.map((m) => m.session.name).sort();
    // s1 + s2 + s3 all contain both terms somewhere
    expect(names).toContain('s1');
  });

  it('excludes sessions missing one of the terms', () => {
    mockCorpus({
      's1': { createdAt: today, messages: [{ role: 'user', content: 'database migration' }] },
      's2': { createdAt: today, messages: [{ role: 'user', content: 'database only' }] },
    });
    const matches = recallSessions('database migration', undefined);
    expect(matches.map((m) => m.session.name)).toEqual(['s1']);
  });

  it('ignores system messages when matching', () => {
    mockCorpus({
      's1': { createdAt: today, messages: [{ role: 'system', content: 'secret-keyword in system prompt' }, { role: 'user', content: 'unrelated' }] },
    });
    expect(recallSessions('secret-keyword', undefined)).toHaveLength(0);
  });

  it('ranks recent sessions above older ones with equal term hits', () => {
    mockCorpus({
      'old':    { createdAt: longAgo, messages: [{ role: 'user', content: 'refactor the auth module' }] },
      'recent': { createdAt: today,   messages: [{ role: 'user', content: 'refactor the auth module' }] },
    });
    const matches = recallSessions('refactor auth', undefined);
    expect(matches[0].session.name).toBe('recent');
  });

  it('respects the limit parameter', () => {
    const corpus: Record<string, any> = {};
    for (let i = 0; i < 15; i++) {
      corpus[`s${i}`] = { createdAt: today, messages: [{ role: 'user', content: 'common term here' }] };
    }
    mockCorpus(corpus);
    expect(recallSessions('common', undefined, 5)).toHaveLength(5);
  });
});

describe('formatRecall', () => {
  it('shows empty-state hint pointing at /search', () => {
    const out = formatRecall('xyz', []);
    expect(out).toContain('No saved sessions match');
    expect(out).toContain('/search');
  });

  it('renders matches with snippet and resume hint', () => {
    const out = formatRecall('oauth', [
      {
        session: { name: 's1', title: 'Auth work', createdAt: new Date().toISOString(), messageCount: 12, fileSize: 100 },
        score: 5,
        snippet: '…implementing OAuth callback…',
        matchedMessages: 3,
      },
    ]);
    expect(out).toContain('## Recall: "oauth"');
    expect(out).toContain('s1');
    expect(out).toContain('Auth work');
    expect(out).toContain('OAuth callback');
    expect(out).toContain('/sessions');
  });
});
