import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync };
});

vi.mock('../config/index', () => ({
  config: { get: vi.fn((k: string) => ({ language: 'en', apiTimeout: 30000, temperature: 0.7, maxTokens: 4096, provider: 'openai', model: 'gpt-4', protocol: 'openai' }[k])) },
  getApiKey: vi.fn(() => 'sk-test'),
  Message: {},
}));
vi.mock('../config/providers', () => ({
  getProviderBaseUrl: vi.fn(() => 'https://api.example.com'),
  getProviderAuthHeader: vi.fn(() => 'Bearer sk-test'),
  supportsNativeTools: vi.fn(() => true),
}));
vi.mock('./tokenTracker', () => ({ recordTokenUsage: vi.fn(), extractOpenAIUsage: vi.fn(), extractAnthropicUsage: vi.fn() }));
vi.mock('./toolParsing', () => ({ parseOpenAIToolCalls: vi.fn(() => []), parseAnthropicToolCalls: vi.fn(() => []), parseToolCalls: vi.fn(() => []) }));
vi.mock('./tools', () => ({ formatToolDefinitions: vi.fn(() => ''), getOpenAITools: vi.fn(() => []), getAnthropicTools: vi.fn(() => []) }));
vi.mock('./agentStream', () => ({
  handleStream: vi.fn(),
  handleOpenAIAgentStream: vi.fn(),
  handleAnthropicAgentStream: vi.fn(),
  AgentChatResponse: {},
}));

import { loadProjectRules, formatChatHistoryForAgent, TimeoutError } from './agentChat';

describe('loadProjectRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when no rules files exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadProjectRules('/project');
    expect(result).toBe('');
  });

  it('loads from .codeep/rules.md when present', () => {
    mockExistsSync.mockImplementation((p: string) => p.includes('.codeep/rules.md'));
    mockReadFileSync.mockReturnValue('# Rule 1\nBe careful.');
    const result = loadProjectRules('/project');
    expect(result).toContain('Be careful.');
    expect(result).toContain('Project Rules');
  });

  it('loads from CODEEP.md as fallback', () => {
    mockExistsSync.mockImplementation((p: string) => p.includes('CODEEP.md'));
    mockReadFileSync.mockReturnValue('# Use tabs');
    const result = loadProjectRules('/project');
    expect(result).toContain('Use tabs');
  });

  it('prefers .codeep/rules.md over CODEEP.md', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if ((p as string).includes('.codeep/rules.md')) return 'from rules.md';
      return 'from CODEEP.md';
    });
    const result = loadProjectRules('/project');
    expect(result).toContain('from rules.md');
    expect(result).not.toContain('from CODEEP.md');
  });

  it('returns empty string when file exists but is empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('   ');
    const result = loadProjectRules('/project');
    expect(result).toBe('');
  });

  it('handles read errors gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('permission denied'); });
    const result = loadProjectRules('/project');
    expect(result).toBe('');
  });
});

describe('formatChatHistoryForAgent', () => {
  it('returns empty string for undefined history', () => {
    expect(formatChatHistoryForAgent(undefined)).toBe('');
  });

  it('returns empty string for empty history array', () => {
    expect(formatChatHistoryForAgent([])).toBe('');
  });

  it('formats user and assistant messages', () => {
    const history = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    const result = formatChatHistoryForAgent(history);
    expect(result).toContain('**User:**');
    expect(result).toContain('Hello');
    expect(result).toContain('**Assistant:**');
    expect(result).toContain('Hi there');
    expect(result).toContain('Prior Conversation Context');
  });

  it('filters out [AGENT] prefixed messages', () => {
    const history = [
      { role: 'user' as const, content: '[AGENT] some internal message' },
      { role: 'user' as const, content: 'Real question' },
    ];
    const result = formatChatHistoryForAgent(history);
    expect(result).toContain('Real question');
    expect(result).not.toContain('[AGENT]');
  });

  it('filters out [DRY RUN] prefixed messages', () => {
    const history = [
      { role: 'assistant' as const, content: '[DRY RUN] preview output' },
      { role: 'user' as const, content: 'Real message' },
    ];
    const result = formatChatHistoryForAgent(history);
    expect(result).not.toContain('[DRY RUN]');
  });

  it('filters out Agent completed/failed/stopped messages', () => {
    const history = [
      { role: 'assistant' as const, content: 'Agent completed successfully' },
      { role: 'assistant' as const, content: 'Agent failed: error' },
      { role: 'assistant' as const, content: 'Agent stopped by user' },
      { role: 'user' as const, content: 'Keep this one' },
    ];
    const result = formatChatHistoryForAgent(history);
    expect(result).not.toContain('Agent completed');
    expect(result).not.toContain('Agent failed');
    expect(result).not.toContain('Agent stopped');
    expect(result).toContain('Keep this one');
  });

  it('returns empty string when all messages are filtered', () => {
    const history = [
      { role: 'assistant' as const, content: '[AGENT] internal' },
      { role: 'assistant' as const, content: 'Agent completed successfully' },
    ];
    const result = formatChatHistoryForAgent(history);
    expect(result).toBe('');
  });

  it('respects maxChars budget — takes most recent messages', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i + 1} with some content`,
    }));
    // With 100 char limit, only a few messages should fit
    const result = formatChatHistoryForAgent(history, 100);
    // Should not contain very early messages
    expect(result).not.toContain('Message 1 ');
    // Should contain the last message
    expect(result).toContain('Message 20');
  });

  it('truncates a single message that exceeds maxChars', () => {
    const longContent = 'x'.repeat(5000);
    const history = [{ role: 'user' as const, content: longContent }];
    const result = formatChatHistoryForAgent(history, 200);
    expect(result).toContain('[truncated]');
  });
});

describe('TimeoutError', () => {
  it('is an instance of Error', () => {
    const err = new TimeoutError('timed out');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name TimeoutError', () => {
    const err = new TimeoutError('timed out');
    expect(err.name).toBe('TimeoutError');
  });

  it('uses default message when none provided', () => {
    const err = new TimeoutError();
    expect(err.message).toBe('Request timed out');
  });

  it('has a message', () => {
    const err = new TimeoutError('custom message');
    expect(err.message).toBe('custom message');
  });
});
