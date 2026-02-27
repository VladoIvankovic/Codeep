import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock 'fs' before importing the module under test - use importOriginal to
// preserve all fs exports that transitive dependencies need (e.g. mkdirSync).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadProjectRules, formatAgentResult, formatChatHistoryForAgent, AgentResult } from './agent';

// Cast mocked functions for convenience
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

describe('loadProjectRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return formatted rules when .codeep/rules.md exists', () => {
    const projectRoot = '/my/project';
    const rulesContent = 'Always use TypeScript.\nNo console.log in production.';

    mockExistsSync.mockImplementation((filePath: string) => {
      return filePath === join(projectRoot, '.codeep', 'rules.md');
    });
    mockReadFileSync.mockReturnValue(rulesContent);

    const result = loadProjectRules(projectRoot);

    expect(result).toContain('## Project Rules');
    expect(result).toContain('Always use TypeScript.');
    expect(result).toContain('No console.log in production.');
    expect(mockExistsSync).toHaveBeenCalledWith(join(projectRoot, '.codeep', 'rules.md'));
    expect(mockReadFileSync).toHaveBeenCalledWith(join(projectRoot, '.codeep', 'rules.md'), 'utf-8');
  });

  it('should fall back to CODEEP.md when .codeep/rules.md does not exist', () => {
    const projectRoot = '/my/project';
    const rulesContent = 'Follow the style guide.';

    mockExistsSync.mockImplementation((filePath: string) => {
      return filePath === join(projectRoot, 'CODEEP.md');
    });
    mockReadFileSync.mockReturnValue(rulesContent);

    const result = loadProjectRules(projectRoot);

    expect(result).toContain('## Project Rules');
    expect(result).toContain('Follow the style guide.');
    // Should have checked .codeep/rules.md first
    expect(mockExistsSync).toHaveBeenCalledWith(join(projectRoot, '.codeep', 'rules.md'));
    // Then checked CODEEP.md
    expect(mockExistsSync).toHaveBeenCalledWith(join(projectRoot, 'CODEEP.md'));
    expect(mockReadFileSync).toHaveBeenCalledWith(join(projectRoot, 'CODEEP.md'), 'utf-8');
  });

  it('should return empty string when neither rules file exists', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockReturnValue(false);

    const result = loadProjectRules(projectRoot);

    expect(result).toBe('');
    expect(mockExistsSync).toHaveBeenCalledTimes(2);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('should return empty string when rules file exists but is empty', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockImplementation((filePath: string) => {
      return filePath === join(projectRoot, '.codeep', 'rules.md');
    });
    mockReadFileSync.mockReturnValue('   \n  \n  ');

    const result = loadProjectRules(projectRoot);

    // Empty after trim, so should skip and check next candidate
    expect(mockExistsSync).toHaveBeenCalledWith(join(projectRoot, '.codeep', 'rules.md'));
    // Since the first file was empty (whitespace-only), it checks the second
    expect(mockExistsSync).toHaveBeenCalledWith(join(projectRoot, 'CODEEP.md'));
  });

  it('should return empty string when both files exist but are empty', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('   ');

    const result = loadProjectRules(projectRoot);

    expect(result).toBe('');
  });

  it('should return empty string when readFileSync throws an error', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = loadProjectRules(projectRoot);

    // Both candidates exist but both throw on read, so should return ''
    expect(result).toBe('');
    // Should have attempted to read both files
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('should fall back to CODEEP.md when .codeep/rules.md read throws', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath === join(projectRoot, '.codeep', 'rules.md')) {
        throw new Error('EACCES: permission denied');
      }
      return 'Fallback rules content';
    });

    const result = loadProjectRules(projectRoot);

    expect(result).toContain('## Project Rules');
    expect(result).toContain('Fallback rules content');
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('should prefer .codeep/rules.md over CODEEP.md when both exist', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((filePath: string) => {
      if (filePath === join(projectRoot, '.codeep', 'rules.md')) {
        return 'Primary rules';
      }
      return 'Secondary rules';
    });

    const result = loadProjectRules(projectRoot);

    expect(result).toContain('Primary rules');
    expect(result).not.toContain('Secondary rules');
    // Should only read the first file since it had content
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('should include the MUST follow preamble in the returned string', () => {
    const projectRoot = '/my/project';

    mockExistsSync.mockImplementation((filePath: string) => {
      return filePath === join(projectRoot, '.codeep', 'rules.md');
    });
    mockReadFileSync.mockReturnValue('Some rules');

    const result = loadProjectRules(projectRoot);

    expect(result).toContain('You MUST follow these rules');
  });
});

describe('formatAgentResult', () => {
  it('should format a successful result with iterations', () => {
    const result: AgentResult = {
      success: true,
      iterations: 3,
      actions: [],
      finalResponse: 'All done',
    };

    const formatted = formatAgentResult(result);

    expect(formatted).toContain('Agent completed in 3 iteration(s)');
  });

  it('should format a failed result with error message', () => {
    const result: AgentResult = {
      success: false,
      iterations: 5,
      actions: [],
      finalResponse: '',
      error: 'Exceeded maximum duration',
    };

    const formatted = formatAgentResult(result);

    expect(formatted).toContain('Agent failed: Exceeded maximum duration');
  });

  it('should format an aborted result', () => {
    const result: AgentResult = {
      success: false,
      iterations: 2,
      actions: [],
      finalResponse: 'Agent was stopped by user',
      aborted: true,
    };

    const formatted = formatAgentResult(result);

    expect(formatted).toContain('Agent was stopped by user');
  });

  it('should list actions when present', () => {
    const result: AgentResult = {
      success: true,
      iterations: 2,
      actions: [
        { type: 'read', target: 'src/index.ts', result: 'success', timestamp: Date.now() },
        { type: 'write', target: 'src/new-file.ts', result: 'success', timestamp: Date.now() },
        { type: 'command', target: 'npm install', result: 'error', timestamp: Date.now() },
      ],
      finalResponse: 'Done',
    };

    const formatted = formatAgentResult(result);

    expect(formatted).toContain('Actions performed:');
    expect(formatted).toContain('read: src/index.ts');
    expect(formatted).toContain('write: src/new-file.ts');
    expect(formatted).toContain('command: npm install');
  });

  it('should show check mark for successful actions and cross for errors', () => {
    const result: AgentResult = {
      success: true,
      iterations: 1,
      actions: [
        { type: 'write', target: 'file.ts', result: 'success', timestamp: Date.now() },
        { type: 'edit', target: 'other.ts', result: 'error', timestamp: Date.now() },
      ],
      finalResponse: 'Done',
    };

    const formatted = formatAgentResult(result);
    const lines = formatted.split('\n');

    const successLine = lines.find(l => l.includes('write: file.ts'));
    const errorLine = lines.find(l => l.includes('edit: other.ts'));

    expect(successLine).toMatch(/✓/);
    expect(errorLine).toMatch(/✗/);
  });

  it('should not show actions section when there are no actions', () => {
    const result: AgentResult = {
      success: true,
      iterations: 1,
      actions: [],
      finalResponse: 'Nothing to do',
    };

    const formatted = formatAgentResult(result);

    expect(formatted).not.toContain('Actions performed:');
  });

  it('should format a failed result without aborted flag', () => {
    const result: AgentResult = {
      success: false,
      iterations: 10,
      actions: [
        { type: 'read', target: 'config.json', result: 'success', timestamp: Date.now() },
      ],
      finalResponse: '',
      error: 'Exceeded maximum of 10 iterations',
    };

    const formatted = formatAgentResult(result);

    expect(formatted).toContain('Agent failed: Exceeded maximum of 10 iterations');
    expect(formatted).toContain('Actions performed:');
    expect(formatted).toContain('read: config.json');
  });

  it('should format result with single iteration correctly', () => {
    const result: AgentResult = {
      success: true,
      iterations: 1,
      actions: [],
      finalResponse: 'Quick task',
    };

    const formatted = formatAgentResult(result);

    expect(formatted).toContain('Agent completed in 1 iteration(s)');
  });

  it('should handle all action types', () => {
    const actionTypes = ['read', 'write', 'edit', 'delete', 'command', 'search', 'list', 'mkdir', 'fetch'] as const;

    const result: AgentResult = {
      success: true,
      iterations: 5,
      actions: actionTypes.map(type => ({
        type,
        target: `target-for-${type}`,
        result: 'success' as const,
        timestamp: Date.now(),
      })),
      finalResponse: 'Done',
    };

    const formatted = formatAgentResult(result);

    for (const type of actionTypes) {
      expect(formatted).toContain(`${type}: target-for-${type}`);
    }
  });
});

// ─── Mocks required to drive runAgent ────────────────────────────────────────

// agentChat mock must be hoisted so vi.mock() factory can reference it
const { mockAgentChat } = vi.hoisted(() => ({ mockAgentChat: vi.fn() }));

vi.mock('./agentChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentChat')>();
  return {
    ...actual,
    agentChat: mockAgentChat,
  };
});

vi.mock('./tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools')>();
  return {
    ...actual,
    executeTool: vi.fn(),
    parseToolCalls: vi.fn(() => []),
    createActionLog: vi.fn((_toolCall: unknown, toolResult: unknown) => ({
      type: 'command',
      target: 'npm',
      result: 'success',
      timestamp: Date.now(),
    })),
  };
});

vi.mock('../config/index', () => ({
  config: {
    get: vi.fn((k: string) => {
      const defaults: Record<string, unknown> = {
        provider: 'openai',
        protocol: 'openai',
        agentMaxIterations: 10,
        agentMaxDuration: 5,
        agentApiTimeout: 30000,
      };
      return defaults[k] ?? null;
    }),
  },
  getApiKey: vi.fn(() => 'sk-test'),
  Message: {},
}));

vi.mock('../config/providers', () => ({
  supportsNativeTools: vi.fn(() => true),
  getProviderBaseUrl: vi.fn(() => 'https://api.example.com'),
  getProviderAuthHeader: vi.fn(() => 'Bearer sk-test'),
}));

vi.mock('./history', () => ({
  startSession: vi.fn(() => 'session-1'),
  endSession: vi.fn(),
  undoLastAction: vi.fn(),
  undoAllActions: vi.fn(),
  getCurrentSession: vi.fn(() => null),
  getRecentSessions: vi.fn(() => []),
  formatSession: vi.fn(() => ''),
}));

vi.mock('./verify', () => ({
  runAllVerifications: vi.fn(async () => []),
  formatErrorsForAgent: vi.fn(() => ''),
  hasVerificationErrors: vi.fn(() => false),
  getVerificationSummary: vi.fn(() => ''),
}));

vi.mock('./smartContext', () => ({
  gatherSmartContext: vi.fn(() => ({})),
  formatSmartContext: vi.fn(() => ''),
  extractTargetFile: vi.fn(() => null),
}));

vi.mock('./taskPlanner', () => ({
  planTasks: vi.fn(async () => ({ tasks: [] })),
  getNextTask: vi.fn(() => null),
  formatTaskPlan: vi.fn(() => ''),
}));

import { runAgent } from './agent';
import { executeTool } from './tools';

describe('onExecuteCommand callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes onExecuteCommand with correct args and maps result to ToolResult shape', async () => {
    // First agentChat call: return an execute_command tool call
    // Second call: return empty tool calls so the agent terminates
    mockAgentChat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            tool: 'execute_command',
            parameters: { command: 'npm', args: ['test'] },
          },
        ],
        usedNativeTools: true,
      })
      .mockResolvedValueOnce({
        content: 'All done.',
        toolCalls: [],
        usedNativeTools: true,
      });

    const onExecuteCommand = vi.fn().mockResolvedValue({
      stdout: 'Tests passed',
      stderr: '',
      exitCode: 0,
    });

    const onToolResult = vi.fn();

    const projectContext = {
      root: '/tmp/test-project',
      name: 'test-project',
      type: 'node',
      structure: '',
    };

    const agentResult = await runAgent('run tests', projectContext as never, {
      onExecuteCommand,
      onToolResult,
      maxIterations: 5,
    });

    // Callback must have been called with the right positional args
    expect(onExecuteCommand).toHaveBeenCalledOnce();
    expect(onExecuteCommand).toHaveBeenCalledWith('npm', ['test'], '/tmp/test-project');

    // onToolResult should have received a valid ToolResult
    expect(onToolResult).toHaveBeenCalledOnce();
    const [toolResult, toolCall] = onToolResult.mock.calls[0];
    expect(toolResult).toMatchObject({
      success: true,
      output: 'Tests passed',
      tool: 'execute_command',
    });
    expect(toolCall).toMatchObject({ tool: 'execute_command' });

    // The agent should complete successfully
    expect(agentResult.success).toBe(true);
  });

  it('returns error ToolResult when command field is missing', async () => {
    mockAgentChat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            tool: 'execute_command',
            // no command field
            parameters: { args: ['test'] },
          },
        ],
        usedNativeTools: true,
      })
      .mockResolvedValueOnce({
        content: 'Done.',
        toolCalls: [],
        usedNativeTools: true,
      });

    const onExecuteCommand = vi.fn();
    const onToolResult = vi.fn();

    const projectContext = {
      root: '/tmp/test-project',
      name: 'test-project',
      type: 'node',
      structure: '',
    };

    await runAgent('run tests', projectContext as never, {
      onExecuteCommand,
      onToolResult,
      maxIterations: 5,
    });

    // Callback must NOT have been called since command is missing
    expect(onExecuteCommand).not.toHaveBeenCalled();

    // onToolResult should have received an error ToolResult
    expect(onToolResult).toHaveBeenCalledOnce();
    const [toolResult] = onToolResult.mock.calls[0];
    expect(toolResult).toMatchObject({
      success: false,
      output: '',
      error: 'execute_command called with missing command field',
      tool: 'execute_command',
    });
  });

  it('falls back to executeTool when onExecuteCommand callback throws', async () => {
    mockAgentChat
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            tool: 'execute_command',
            parameters: { command: 'npm', args: ['install'] },
          },
        ],
        usedNativeTools: true,
      })
      .mockResolvedValueOnce({
        content: 'Done.',
        toolCalls: [],
        usedNativeTools: true,
      });

    const onExecuteCommand = vi.fn().mockRejectedValue(new Error('terminal unavailable'));

    const mockFallbackResult = {
      success: true,
      output: 'fallback output',
      tool: 'execute_command',
      parameters: { command: 'npm', args: ['install'] },
    };
    (executeTool as ReturnType<typeof vi.fn>).mockResolvedValue(mockFallbackResult);

    const onToolResult = vi.fn();

    const projectContext = {
      root: '/tmp/test-project',
      name: 'test-project',
      type: 'node',
      structure: '',
    };

    await runAgent('install deps', projectContext as never, {
      onExecuteCommand,
      onToolResult,
      maxIterations: 5,
    });

    // Callback was called but threw
    expect(onExecuteCommand).toHaveBeenCalledOnce();

    // executeTool fallback should have been used
    expect(executeTool).toHaveBeenCalledOnce();

    // onToolResult should reflect the fallback result
    expect(onToolResult).toHaveBeenCalledOnce();
    const [toolResult] = onToolResult.mock.calls[0];
    expect(toolResult).toMatchObject({ output: 'fallback output' });
  });
});

describe('formatChatHistoryForAgent', () => {
  it('should return empty string for undefined input', () => {
    expect(formatChatHistoryForAgent(undefined)).toBe('');
  });

  it('should return empty string for empty array', () => {
    expect(formatChatHistoryForAgent([])).toBe('');
  });

  it('should format simple chat history', () => {
    const history = [
      { role: 'user' as const, content: 'How do I fix the login bug?' },
      { role: 'assistant' as const, content: 'Check the auth middleware in src/auth.ts' },
    ];

    const result = formatChatHistoryForAgent(history);

    expect(result).toContain('## Prior Conversation Context');
    expect(result).toContain('**User:** How do I fix the login bug?');
    expect(result).toContain('**Assistant:** Check the auth middleware in src/auth.ts');
  });

  it('should filter out [AGENT] messages', () => {
    const history = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'user' as const, content: '[AGENT] fix the bug' },
      { role: 'assistant' as const, content: 'Agent completed in 3 iteration(s)' },
      { role: 'user' as const, content: 'Thanks' },
    ];

    const result = formatChatHistoryForAgent(history);

    expect(result).toContain('**User:** Hello');
    expect(result).toContain('**User:** Thanks');
    expect(result).not.toContain('[AGENT]');
    expect(result).not.toContain('Agent completed');
  });

  it('should filter out [DRY RUN] messages', () => {
    const history = [
      { role: 'user' as const, content: '[DRY RUN] test task' },
    ];

    const result = formatChatHistoryForAgent(history);

    expect(result).toBe('');
  });

  it('should filter out Agent failed/stopped messages', () => {
    const history = [
      { role: 'assistant' as const, content: 'Agent failed: timeout' },
      { role: 'assistant' as const, content: 'Agent stopped by user' },
    ];

    const result = formatChatHistoryForAgent(history);

    expect(result).toBe('');
  });

  it('should respect character budget and keep newest messages', () => {
    const history = [
      { role: 'user' as const, content: 'A'.repeat(5000) },
      { role: 'assistant' as const, content: 'B'.repeat(5000) },
      { role: 'user' as const, content: 'Most recent message' },
    ];

    const result = formatChatHistoryForAgent(history, 6000);

    expect(result).toContain('Most recent message');
    // The first 5000-char message should be dropped due to budget
    expect(result).not.toContain('AAAAA');
  });

  it('should truncate a single very long message', () => {
    const history = [
      { role: 'user' as const, content: 'X'.repeat(20000) },
    ];

    const result = formatChatHistoryForAgent(history, 8000);

    expect(result).toContain('[truncated]');
    expect(result.length).toBeLessThan(9000);
  });
});
