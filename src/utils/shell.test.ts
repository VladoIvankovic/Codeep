import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateCommand, executeCommand, execSimple, getAllowedCommands, formatCommandResult } from './shell';

// ─── Mock child_process ───────────────────────────────────────────────────────
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

// ─── Mock fs.existsSync ───────────────────────────────────────────────────────
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

const mockSpawnSync = spawnSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;

function makeSpawnResult(overrides: Partial<ReturnType<typeof spawnSync>> = {}): ReturnType<typeof spawnSync> {
  return {
    pid: 1,
    output: [null, Buffer.from(''), Buffer.from('')],
    stdout: 'output',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as ReturnType<typeof spawnSync>;
}

describe('validateCommand', () => {
  it('blocks commands in the blocked list', () => {
    const result = validateCommand('sudo', ['ls']);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('sudo');
  });

  it('blocks chmod', () => {
    expect(validateCommand('chmod', ['755', 'file.txt']).valid).toBe(false);
  });

  it('blocks commands not in the allowed list', () => {
    const result = validateCommand('bash', ['-c', 'echo hi']);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('allowed list');
  });

  it('allows whitelisted commands', () => {
    expect(validateCommand('git', ['status']).valid).toBe(true);
    expect(validateCommand('npm', ['install']).valid).toBe(true);
    expect(validateCommand('node', ['index.js']).valid).toBe(true);
  });

  it('blocks rm -rf / pattern', () => {
    const result = validateCommand('rm', ['-rf', '/']);
    expect(result.valid).toBe(false);
  });

  it('blocks curl piped to shell', () => {
    const result = validateCommand('curl', ['http://example.com', '|', 'bash']);
    expect(result.valid).toBe(false);
  });

  it('blocks command substitution $(...)', () => {
    const result = validateCommand('echo', ['$(whoami)']);
    expect(result.valid).toBe(false);
  });

  it('blocks eval commands', () => {
    const result = validateCommand('echo', ['eval something']);
    expect(result.valid).toBe(false);
  });

  it('allows rm without -rf', () => {
    expect(validateCommand('rm', ['file.txt']).valid).toBe(true);
  });

  it('blocks rm -rf without specific paths', () => {
    // Just flags, no path
    const result = validateCommand('rm', ['-rf']);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('rm -rf without specific paths');
  });

  it('allows rm -rf with a specific path', () => {
    expect(validateCommand('rm', ['-rf', 'dist']).valid).toBe(true);
  });

  it('validates path stays in project root when projectRoot given', () => {
    const result = validateCommand('cat', ['../../etc/passwd'], {
      projectRoot: '/home/user/project',
      cwd: '/home/user/project',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('outside project directory');
  });

  it('allows path within project root', () => {
    const result = validateCommand('cat', ['src/index.ts'], {
      projectRoot: '/home/user/project',
      cwd: '/home/user/project',
    });
    expect(result.valid).toBe(true);
  });

  it('ignores flag arguments for path validation', () => {
    const result = validateCommand('grep', ['-r', 'pattern'], {
      projectRoot: '/home/user/project',
    });
    expect(result.valid).toBe(true);
  });
});

describe('executeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockReturnValue(makeSpawnResult());
  });

  it('returns success result on exit code 0', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ status: 0, stdout: 'hello', stderr: '' }));
    const result = executeCommand('git', ['status']);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('git');
    expect(result.args).toEqual(['status']);
  });

  it('returns failure result on non-zero exit code', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ status: 1, stdout: '', stderr: 'error' }));
    const result = executeCommand('git', ['status']);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error');
  });

  it('returns validation error without calling spawnSync for blocked command', () => {
    const result = executeCommand('sudo', ['rm', '-rf', '/']);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('sudo');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('returns error when cwd does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = executeCommand('git', ['status'], { cwd: '/nonexistent' });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('does not exist');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('returns timeout error when signal is SIGTERM', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ signal: 'SIGTERM' as NodeJS.Signals }));
    const result = executeCommand('npm', ['install'], { timeout: 100 });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('timed out');
  });

  it('handles spawnSync throwing an exception', () => {
    mockSpawnSync.mockImplementation(() => { throw new Error('spawn error'); });
    const result = executeCommand('git', ['status']);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('spawn error');
  });

  it('includes duration in result', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult());
    const result = executeCommand('git', ['status']);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('passes env override to spawn', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult());
    executeCommand('git', ['status'], { env: { MY_VAR: 'hello' } });
    const spawnOpts = mockSpawnSync.mock.calls[0][2];
    expect(spawnOpts.env.MY_VAR).toBe('hello');
  });
});

describe('execSimple', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns trimmed stdout on success', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ status: 0, stdout: '  main\n  ' }));
    const result = execSimple('git', ['branch', '--show-current']);
    expect(result).toBe('main');
  });

  it('returns null on failure', () => {
    mockSpawnSync.mockReturnValue(makeSpawnResult({ status: 1, stdout: '', stderr: 'error' }));
    const result = execSimple('git', ['status']);
    expect(result).toBeNull();
  });
});

describe('getAllowedCommands', () => {
  it('returns sorted array', () => {
    const commands = getAllowedCommands();
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(10);
    expect(commands).toContain('git');
    expect(commands).toContain('npm');
  });

  it('is sorted alphabetically', () => {
    const commands = getAllowedCommands();
    const sorted = [...commands].sort();
    expect(commands).toEqual(sorted);
  });
});

describe('formatCommandResult', () => {
  it('formats successful command', () => {
    const result = formatCommandResult({
      success: true,
      command: 'git',
      args: ['status'],
      stdout: 'On branch main',
      stderr: '',
      exitCode: 0,
      duration: 42,
    });
    expect(result).toContain('✓');
    expect(result).toContain('git status');
    expect(result).toContain('42ms');
    expect(result).toContain('On branch main');
  });

  it('formats failed command', () => {
    const result = formatCommandResult({
      success: false,
      command: 'npm',
      args: ['build'],
      stdout: '',
      stderr: 'Build failed',
      exitCode: 1,
      duration: 100,
    });
    expect(result).toContain('✗');
    expect(result).toContain('npm build');
    expect(result).toContain('Build failed');
  });

  it('truncates long stdout', () => {
    const longOutput = 'x'.repeat(1000);
    const result = formatCommandResult({
      success: true,
      command: 'cat',
      args: ['file.txt'],
      stdout: longOutput,
      stderr: '',
      exitCode: 0,
      duration: 5,
    });
    expect(result).toContain('...');
  });

  it('omits stderr section on success', () => {
    const result = formatCommandResult({
      success: true,
      command: 'git',
      args: [],
      stdout: 'ok',
      stderr: 'warning: something',
      exitCode: 0,
      duration: 10,
    });
    expect(result).not.toContain('stderr');
  });
});
