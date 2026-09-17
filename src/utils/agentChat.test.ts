import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  resolveBaseUrl: vi.fn(() => 'https://api.example.com'),
  Message: {},
}));
vi.mock('../config/providers', () => ({
  getProviderBaseUrl: vi.fn(() => 'https://api.example.com'),
  getProviderAuthHeader: vi.fn(() => 'Bearer sk-test'),
  supportsNativeTools: vi.fn(() => true),
  // The rest of what agentChat() itself reaches for. The prompt-building tests
  // never called it, so the mock only had to cover three.
  getEffectiveMaxTokens: vi.fn(() => 4096),
  usesMaxCompletionTokens: vi.fn(() => false),
  requiresDefaultTemperature: vi.fn(() => false),
  modelRejectsSamplingParams: vi.fn(() => false),
  isNoApiKeyProvider: vi.fn(() => false),
  reasoningParamsFor: vi.fn(() => ({})),
  providerNoStreamWithTools: vi.fn(() => true),
}));
vi.mock('./ratelimit', () => ({ checkApiRateLimit: vi.fn() }));
vi.mock('./openrouterPrefs', () => ({ readOpenRouterPreferences: vi.fn(() => ({})) }));
vi.mock('./projectIntelligence', () => ({
  loadProjectIntelligence: vi.fn(() => null),
  generateContextFromIntelligence: vi.fn(() => ''),
}));
vi.mock('./codeepCloud', () => ({ syncProgress: vi.fn(), generateProjectId: vi.fn(() => 'p') }));
vi.mock('./tokenTracker', () => ({ recordTokenUsage: vi.fn(), extractOpenAIUsage: vi.fn(), extractAnthropicUsage: vi.fn() }));
vi.mock('./toolParsing', () => ({ parseOpenAIToolCalls: vi.fn(() => []), parseAnthropicToolCalls: vi.fn(() => []), parseToolCalls: vi.fn(() => []) }));
vi.mock('./tools', () => ({ formatToolDefinitions: vi.fn(() => ''), getOpenAITools: vi.fn(() => []), getAnthropicTools: vi.fn(() => []) }));
vi.mock('./agentStream', () => ({
  handleStream: vi.fn(),
  handleOpenAIAgentStream: vi.fn(),
  handleAnthropicAgentStream: vi.fn(),
  AgentChatResponse: {},
}));

import { loadProjectRules, loadProgressLog, writeProgressLog, formatChatHistoryForAgent, summarizeEarlierHistory, getAgentSystemPrompt, TimeoutError } from './agentChat';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as realFs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// readFileSync and existsSync are mocked in this file; these read the disk.
function actualRead(p: string): string {
  const fd = realFs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(realFs.fstatSync(fd).size);
    realFs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8');
  } finally {
    realFs.closeSync(fd);
  }
}
const existsOnDisk = (p: string) => realFs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

describe('per-run custom-bot runtime', () => {
  it('reports the runtime model/provider without mutating global config', () => {
    mockExistsSync.mockReturnValue(false);
    const prompt = getAgentSystemPrompt({
      root: '/project', name: 'project', type: 'TypeScript', structure: '', keyFiles: [], fileCount: 0, summary: '',
    }, { providerId: 'z.ai', model: 'glm-5.3', protocol: 'openai' });
    expect(prompt).toContain('`glm-5.3` (via z.ai)');
  });
});

describe('summarizeEarlierHistory', () => {
  it('returns empty for missing/empty history', async () => {
    expect(await summarizeEarlierHistory()).toBe('');
    expect(await summarizeEarlierHistory([])).toBe('');
  });

  it('returns empty when nothing overflows the budget (no LLM call)', async () => {
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    // Everything fits → no dropped messages → returns '' without calling chat().
    expect(await summarizeEarlierHistory(history, 16000)).toBe('');
  });
});

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

  it('loads from AGENTS.md as the last-resort fallback', () => {
    // Cross-tool standard (Claude Code, Cursor, Kilo Code). Users coming
    // from those tools shouldn't have to duplicate rules into CODEEP.md.
    mockExistsSync.mockImplementation((p: string) => p.includes('AGENTS.md'));
    mockReadFileSync.mockReturnValue('# No secrets in logs');
    const result = loadProjectRules('/project');
    expect(result).toContain('No secrets in logs');
    expect(result).toContain('Project Rules');
  });

  it('prefers CODEEP.md over AGENTS.md when both exist', () => {
    // Codeep-native beats cross-tool when both are present — the Codeep
    // file is likely richer/Codeep-specific while AGENTS.md is shared.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if ((p as string).includes('CODEEP.md')) return 'from CODEEP.md';
      if ((p as string).includes('AGENTS.md')) return 'from AGENTS.md';
      return '';
    });
    const result = loadProjectRules('/project');
    expect(result).toContain('from CODEEP.md');
    expect(result).not.toContain('from AGENTS.md');
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

  describe('on disk', () => {
    let root: string;
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      mockExistsSync.mockImplementation(actual.existsSync);
      mockReadFileSync.mockImplementation(actual.readFileSync as never);
      root = mkdtempSync(join(tmpdir(), 'codeep-rules-'));
      mkdirSync(join(root, '.codeep'));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      mockExistsSync.mockReset();
      mockReadFileSync.mockReset();
    });

    it('skips a rules file that is not a regular file without reading it', () => {
      // A cloned repo can commit `AGENTS.md -> /dev/zero` (or a FIFO); reading
      // either never returns, and the rules load on every agent run. /dev/null
      // takes the same path but returns at once.
      symlinkSync('/dev/null', join(root, '.codeep', 'rules.md'));
      writeFileSync(join(root, 'CODEEP.md'), 'Use tabs.');
      expect(loadProjectRules(root)).toContain('Use tabs.');
      expect(mockReadFileSync).not.toHaveBeenCalledWith(join(root, '.codeep', 'rules.md'), expect.anything());

      symlinkSync('/dev/null', join(root, '.codeep', 'progress.md'));
      expect(loadProgressLog(root)).toBe('');
      expect(mockReadFileSync).not.toHaveBeenCalledWith(join(root, '.codeep', 'progress.md'), expect.anything());
    });

    it('does not load rules or progress that lead outside the project', () => {
      // A cloned repo can commit `CODEEP.md -> ~/.aws/credentials`; the rules
      // ride every system prompt, so the user's file would go to the provider.
      const outside = mkdtempSync(join(tmpdir(), 'codeep-outside-'));
      try {
        writeFileSync(join(outside, 'credentials'), 'aws_secret_access_key = OUTSIDE_SECRET');
        symlinkSync(join(outside, 'credentials'), join(root, 'CODEEP.md'));
        writeFileSync(join(root, 'AGENTS.md'), 'Use tabs.');
        const rules = loadProjectRules(root);
        expect(rules).toContain('Use tabs.');
        expect(rules).not.toContain('OUTSIDE_SECRET');

        symlinkSync(join(outside, 'credentials'), join(root, '.codeep', 'progress.md'));
        expect(loadProgressLog(root)).toBe('');

        // A link that stays inside the project is still followed.
        writeFileSync(join(root, 'docs-rules.md'), 'Prefer small commits.');
        rmSync(join(root, 'CODEEP.md'));
        symlinkSync(join(root, 'docs-rules.md'), join(root, 'CODEEP.md'));
        expect(loadProjectRules(root)).toContain('Prefer small commits.');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('never writes the progress log through a symlink', () => {
      const outside = mkdtempSync(join(tmpdir(), 'codeep-outside-'));
      const run = { success: true, iterations: 1, actions: [], finalResponse: 'done' };
      try {
        writeFileSync(join(outside, '.zshrc'), 'export KEEP=1\n');
        symlinkSync(join(outside, '.zshrc'), join(root, '.codeep', 'progress.md'));
        writeProgressLog(root, 'task', run);
        expect(actualRead(join(outside, '.zshrc'))).toBe('export KEEP=1\n');

        // A symlinked .codeep directory is refused the same way.
        rmSync(join(root, '.codeep'), { recursive: true });
        symlinkSync(outside, join(root, '.codeep'));
        writeProgressLog(root, 'task', run);
        expect(existsOnDisk(join(outside, 'progress.md'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('reads only the first 64KB of an oversized rules or progress file', () => {
      writeFileSync(join(root, 'AGENTS.md'), 'r'.repeat(64 * 1024) + 'TAIL_NOT_SENT');
      const rules = loadProjectRules(root);
      expect(rules).toContain('[Rules truncated by Codeep');
      expect(rules).not.toContain('TAIL_NOT_SENT');
      expect(mockReadFileSync).not.toHaveBeenCalled();

      writeFileSync(join(root, '.codeep', 'progress.md'), 'p'.repeat(64 * 1024) + 'TAIL_NOT_SENT');
      const progress = loadProgressLog(root);
      expect(progress).toContain('p'.repeat(1000));
      expect(progress).not.toContain('TAIL_NOT_SENT');
      expect(mockReadFileSync).not.toHaveBeenCalled();

      // A file at the limit is read whole.
      writeFileSync(join(root, 'AGENTS.md'), 'r'.repeat(64 * 1024));
      expect(loadProjectRules(root)).not.toContain('truncated');
    });

    it('says when it cut a progress log, and never splits a character', () => {
      writeFileSync(join(root, '.codeep', 'progress.md'), 'p'.repeat(64 * 1024 - 1) + 'é'.repeat(10));
      const progress = loadProgressLog(root);
      expect(progress).toContain('[Progress log truncated by Codeep');
      expect(progress).not.toContain('\uFFFD');

      // The 64KB cut lands between the two bytes of an é.
      writeFileSync(join(root, 'AGENTS.md'), 'r'.repeat(64 * 1024 - 1) + 'é'.repeat(10));
      const rules = loadProjectRules(root);
      expect(rules).toContain('[Rules truncated by Codeep');
      expect(rules).not.toContain('\uFFFD');
    });

    it('keeps the status and summary of a run with a huge task', () => {
      // Both callers pass the prompt with attached files in front of the
      // user's words. Written whole, it filled the 64KB read budget and the
      // sections after it never reached the next session.
      const prompt = '[Attached files]\n' + 'f'.repeat(70 * 1024) + '\n\nplease FIX_THE_LOGIN_BUG 😀';
      writeProgressLog(root, prompt, {
        success: false,
        iterations: 7,
        actions: [{ type: 'write', target: 'src/login.ts' }],
        finalResponse: 'Changed the login form.',
      });
      const progress = loadProgressLog(root);
      expect(progress).not.toContain('[Progress log truncated');
      expect(progress).toContain('please FIX_THE_LOGIN_BUG 😀');
      expect(progress).toContain('[Attached files]');
      expect(progress).toMatch(/\[… \d+ characters of the task omitted …\]/);
      expect(progress).toContain('### Status');
      expect(progress).toContain('- src/login.ts');
      expect(progress).toContain('Changed the login form.');
      expect(progress).toContain('### What Still Needs to Be Done');
      expect(progress).not.toContain('\uFFFD');

      // A short task is written as it is.
      writeProgressLog(root, 'fix the login bug', { success: true, iterations: 1, actions: [], finalResponse: '' });
      expect(loadProgressLog(root)).toContain('### Task\nfix the login bug\n');
    });

    it('does not split an emoji where it cuts a task', () => {
      // The head cut and the tail cut each land mid-pair in one of these.
      for (const [pad, end] of [[1999, ''], [2000, ''], [2000, 'b'], [1999, 'b']] as const) {
        const prompt = 'a'.repeat(pad) + '😀'.repeat(3000) + end;
        writeProgressLog(root, prompt, { success: true, iterations: 1, actions: [], finalResponse: '' });
        const progress = loadProgressLog(root);
        const label = `${pad}${end}`;
        expect(progress, label).toContain('characters of the task omitted');
        expect(progress, label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(progress, label).not.toContain('\uFFFD');
      }
    });
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

describe('HTTP failures carry their status', () => {
  /**
   * A source-level guard, deliberately.
   *
   * The defect was one missing constructor argument: an expired key arrived as
   * a bare `Error`, so runAgent's "never retry a 4xx" branch — which tests
   * `err instanceof ApiError && err.status` — did not apply. Every iteration
   * retried the same rejection until the budget ran out, and the run then
   * blamed the iteration limit, the one explanation unrelated to the cause.
   *
   * Reaching those throws at runtime means standing up the whole provider,
   * rate-limit and streaming graph. The mistake being guarded against is
   * textual — `new Error` where `new ApiError` belongs — so reading the source
   * catches it exactly, and says so rather than implying it proved behaviour.
   */
  it('never throws a status-less Error for an HTTP failure', async () => {
    const { readFileSync: realRead } = await vi.importActual<typeof import('fs')>('fs');
    const src = realRead(new URL('./agentChat.ts', import.meta.url), 'utf8');

    const bare = [...src.matchAll(/throw new Error\(`API error:[^`]*`\)/g)].map(m => m[0]);
    expect(bare).toEqual([]);

    const withStatus = [...src.matchAll(/throw new ApiError\(`API error:[^`]*`,\s*response\.status\)/g)];
    expect(withStatus.length).toBeGreaterThanOrEqual(2);
  });
});
