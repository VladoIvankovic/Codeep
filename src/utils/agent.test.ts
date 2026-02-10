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
import { loadProjectRules, formatAgentResult, AgentResult } from './agent';

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
