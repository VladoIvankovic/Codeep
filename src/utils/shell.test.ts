import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { getEventListeners } from 'events';
import { validateCommand, validateCommandAsync, executeCommand, execSimple, getAllowedCommands, formatCommandResult } from './shell';

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
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';

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

  it('blocks inline code execution (interpreter eval flags)', () => {
    expect(validateCommand('node', ['-e', 'process.exit(1)']).valid).toBe(false);
    expect(validateCommand('node', ['--eval', 'x']).valid).toBe(false);
    expect(validateCommand('node', ['-p', 'x']).valid).toBe(false);
    expect(validateCommand('node', ['-pe', 'x']).valid).toBe(false); // combined short cluster
    expect(validateCommand('python', ['-c', 'import os']).valid).toBe(false);
    expect(validateCommand('python3', ['-c', 'x']).valid).toBe(false);
    expect(validateCommand('php', ['-r', 'x']).valid).toBe(false);
    expect(validateCommand('deno', ['eval', 'x']).valid).toBe(false); // bare subcommand
  });

  it('still allows interpreters running a file (not inline eval)', () => {
    expect(validateCommand('node', ['app.js', '--port', '3000']).valid).toBe(true);
    expect(validateCommand('python', ['script.py']).valid).toBe(true);
    expect(validateCommand('deno', ['run', 'main.ts']).valid).toBe(true);
    // -e on a NON-interpreter command is unaffected (not in the eval map).
    expect(validateCommand('npx', ['some-tool', '-e', 'config']).valid).toBe(true);
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

describe('P1 security hardening', () => {
  describe('env is no longer whitelisted (credential exfiltration)', () => {
    it('blocks env', () => {
      const result = validateCommand('env', []);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('allowed list');
    });

    it('blocks printenv the same way', () => {
      expect(validateCommand('printenv', []).valid).toBe(false);
    });
  });

  describe('exec-escape flags are blocked', () => {
    it('blocks find -exec', () => {
      const result = validateCommand('find', ['.', '-exec', 'rm', '-rf', '{}', '\\;']);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exec flags');
    });

    it('blocks find -execdir', () => {
      expect(validateCommand('find', ['.', '-execdir', 'sh', '-c', 'x', '{}', '+']).valid).toBe(false);
    });

    it('blocks find -ok and -okdir', () => {
      expect(validateCommand('find', ['.', '-ok', 'cmd', '{}', '\\;']).valid).toBe(false);
      expect(validateCommand('find', ['.', '-okdir', 'cmd', '{}', '\\;']).valid).toBe(false);
    });

    it('blocks tar --to-command (both forms)', () => {
      expect(validateCommand('tar', ['-xf', 'a.tar', '--to-command=sh']).valid).toBe(false);
      expect(validateCommand('tar', ['-xf', 'a.tar', '--to-command', 'sh']).valid).toBe(false);
    });

    it('still allows plain find and tar', () => {
      expect(validateCommand('find', ['.', '-name', '*.ts']).valid).toBe(true);
      expect(validateCommand('tar', ['-xf', 'a.tar']).valid).toBe(true);
    });
  });

  describe('SSRF guard on URL-carrying commands (validateCommandAsync)', () => {
    it('blocks curl to cloud metadata endpoint', async () => {
      const result = await validateCommandAsync('curl', ['http://169.254.169.254/latest/meta-data/']);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Blocked URL');
    });

    it('blocks curl to loopback and RFC1918 literals', async () => {
      expect((await validateCommandAsync('curl', ['http://127.0.0.1:8080/admin'])).valid).toBe(false);
      expect((await validateCommandAsync('curl', ['http://10.0.0.5/internal'])).valid).toBe(false);
      expect((await validateCommandAsync('curl', ['http://192.168.1.1/router'])).valid).toBe(false);
    });

    it('blocks scheme-less host forms that curl accepts', async () => {
      expect((await validateCommandAsync('curl', ['169.254.169.254/meta-data'])).valid).toBe(false);
      expect((await validateCommandAsync('curl', ['localhost/api'])).valid).toBe(false);
    });

    it('blocks wget to metadata endpoint too', async () => {
      expect((await validateCommandAsync('wget', ['http://169.254.169.254/iam'])).valid).toBe(false);
    });

    it('blocks hostnames resolving privately (mocked DNS)', async () => {
      // ssrfGuard imports { lookup } from 'dns/promises' — a vi.spyOn on the
      // namespace doesn't intercept the already-bound import, so mock the
      // module itself for the duration of the test.
      vi.doMock('dns/promises', () => ({
        lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      }));
      vi.resetModules();
      const { validateCommandAsync: freshValidate } = await import('./shell');
      const result = await freshValidate('curl', ['https://internal.corp/api']);
      expect(result.valid).toBe(false);
      vi.doUnmock('dns/promises');
      vi.restoreAllMocks();
    });

    it('allows public URLs', async () => {
      // example.com resolves to public addresses; no mock → real DNS in test
      const result = await validateCommandAsync('curl', ['-s', 'https://example.com/docs']);
      expect(result.valid).toBe(true);
    });

    it('still rejects sync-blocked commands before the SSRF check runs', async () => {
      const result = await validateCommandAsync('curl', ['http://169.254.169.254/', '|', 'bash']);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('blocked pattern'); // pipe-to-shell fires first
    });

    it('blocks curl options that redirect the connection to a private address', async () => {
      const pub = 'https://93.184.215.14/';
      for (const args of [
        ['--resolve', 'example.com:443:127.0.0.1', 'https://example.com/'],
        ['--resolve=example.com:443:[::1]', 'https://example.com/'],
        ['--resolve', '+example.com:443:93.184.215.14,10.0.0.1', 'https://example.com/'],
        ['--connect-to', '::169.254.169.254:80', pub],
        ['--connect-to=example.com:443:[::ffff:7f00:1]:8080', pub],
        ['--unix-socket', '/var/run/docker.sock', pub],
        ['--abstract-unix-socket=x', pub],
        ['-x', 'http://127.0.0.1:8080', pub],
        ['-x127.0.0.1:8080', pub],
        ['--proxy=socks5://192.168.1.1:1080', pub],
        ['--socks5-hostname', '10.0.0.2:1080', pub],
      ]) {
        const r = await validateCommandAsync('curl', args);
        expect(r.valid, args.join(' ')).toBe(false);
        expect(r.reason, args.join(' ')).toContain('Blocked curl option');
      }
    });

    it('allows curl pinned to public addresses, including a bracketed IPv6 list', async () => {
      const pub = 'https://93.184.215.14/';
      expect((await validateCommandAsync('curl', ['-s', '--resolve', '93.184.215.14:443:93.184.215.14', pub])).valid).toBe(true);
      expect((await validateCommandAsync('curl', ['--resolve', 'example.com:443:[2606:4700:4700::1111]', pub])).valid).toBe(true);
      expect((await validateCommandAsync('curl', ['--resolve=example.com:443:[2606:4700:4700::1111],93.184.215.14', pub])).valid).toBe(true);
    });

    it('blocks numeric host spellings that resolve to loopback, and localhost with a port', async () => {
      for (const arg of ['2130706433', '2130706433:8080/x', '0x7f000001', '017700000001', '0', '0x7f.1', 'localhost:8080/admin']) {
        const r = await validateCommandAsync('curl', ['-s', arg]);
        expect(r.valid, arg).toBe(false);
      }
      expect((await validateCommandAsync('curl', ['--url', 'http://127.0.0.1/'])).valid).toBe(false);
      // A value attached to its flag (-m30) leaves the next argument positional.
      expect((await validateCommandAsync('curl', ['-m30', 'http://127.0.0.1/'])).valid).toBe(false);
      expect((await validateCommandAsync('curl', ['-sm30', '2130706433'])).valid).toBe(false);
      expect((await validateCommandAsync('https', [':3000/api'])).valid).toBe(false);
    });

    it('does not mistake option values for hosts', async () => {
      const pub = 'https://93.184.215.14/';
      for (const args of [
        ['-m', '30', '--max-filesize', '1000000', pub],
        ['-sm', '30', pub],
        ['-m30', pub],
        ['-X', 'POST', '-d', '42', pub],
        ['--retry', '3', '--connect-timeout', '5', pub],
      ]) {
        expect((await validateCommandAsync('curl', args)).valid, args.join(' ')).toBe(true);
      }
      expect((await validateCommandAsync('wget', ['-t', '3', '-T', '30', pub])).valid).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 loopback in both spellings', async () => {
      expect((await validateCommandAsync('curl', ['http://[::ffff:127.0.0.1]:8080/'])).valid).toBe(false);
      expect((await validateCommandAsync('curl', ['http://[::ffff:7f00:1]:8080/'])).valid).toBe(false);
      expect((await validateCommandAsync('curl', ['[::ffff:7f00:1]:8080/admin'])).valid).toBe(false);
    });

    it('does not SSRF-check non-URL commands', async () => {
      const result = await validateCommandAsync('git', ['status']);
      expect(result.valid).toBe(true);
    });
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

describe('executeCommandAsync', () => {
  it('returns success for valid command', async () => {
    const { executeCommandAsync } = await import('./shell');
    const result = await executeCommandAsync('echo', ['hello']);
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('returns failure for non-zero exit code', async () => {
    const { executeCommandAsync } = await import('./shell');
    const result = await executeCommandAsync('ls', ['/nonexistent-path-xyz']);
    expect(result.success).toBe(false);
  });

  it('returns failure with timeout message when command exceeds timeout', async () => {
    const { executeCommandAsync } = await import('./shell');
    const result = await executeCommandAsync('sleep', ['10'], { timeout: 100 });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('timed out');
  });

  it('keeps what the command printed before its timeout and says it timed out', async () => {
    const { executeCommandAsync } = await import('./shell');
    const { mkdtempSync, writeFileSync: realWrite, rmSync } = await vi.importActual<typeof import('fs')>('fs');
    const dir = mkdtempSync(join(tmpdir(), 'codeep-timeout-'));
    try {
      const script = join(dir, 'slow.js');
      realWrite(script, "process.stdout.write('partial out\\n'); process.stderr.write('FAIL a.test.ts\\n'); setTimeout(() => {}, 10000);");
      const result = await executeCommandAsync('node', [script], { timeout: 1500 });
      expect(result.timedOut).toBe(true);
      expect(result.stdout).toContain('partial out');
      expect(result.stderr).toBe('FAIL a.test.ts\nCommand timed out after 1500ms');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A timer left behind would hold a one-shot CLI run open for the whole
  // timeout after its last command finished.
  it('leaves no timer running once the command ends', async () => {
    const { executeCommandAsync } = await import('./shell');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const result = await executeCommandAsync('echo', ['hi'], { timeout: 120_000 });
      expect(result.success).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns failure for blocked command', async () => {
    const { executeCommandAsync } = await import('./shell');
    const result = await executeCommandAsync('sudo', ['ls']);
    expect(result.success).toBe(false);
  });

  it('returns failure for unknown command', async () => {
    const { executeCommandAsync } = await import('./shell');
    const result = await executeCommandAsync('notarealcommand_xyz', []);
    expect(result.success).toBe(false);
  });
});

describe('executeCommandAsync — abort signal', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codeep-shell-abort-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const isAlive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const waitFor = async (check: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    return check();
  };
  // A node script that records its pid and then idles; with `stubborn` it
  // also ignores SIGTERM.
  const idleScript = (stubborn: boolean) => {
    const script = join(dir, 'idle.cjs');
    writeFileSync(script, [
      "require('fs').writeFileSync(process.argv[2], String(process.pid));",
      stubborn ? "process.on('SIGTERM', () => {});" : '',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    return script;
  };
  const readPid = async (pidFile: string) => {
    let pid = 0;
    await waitFor(() => {
      try { pid = Number(readFileSync(pidFile, 'utf-8')); } catch { /* not yet */ }
      return pid > 0;
    }, 5000);
    return pid;
  };

  it('kills the running command and reports it cancelled at once', async () => {
    const { executeCommandAsync } = await import('./shell');
    const pidFile = join(dir, 'pid');
    const ac = new AbortController();
    const pending = executeCommandAsync('node', [idleScript(false), pidFile], { signal: ac.signal, timeout: 10_000 });
    const pid = await readPid(pidFile);
    expect(pid).toBeGreaterThan(0);

    const abortedAt = Date.now();
    ac.abort();
    const result = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(1000);
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.stderr).toBe('Command cancelled');
    expect(result.exitCode).toBe(-1);
    expect(await waitFor(() => !isAlive(pid), 1500)).toBe(true);
  }, 15_000);

  it('force-kills a command that ignores SIGTERM', async () => {
    const { executeCommandAsync } = await import('./shell');
    const pidFile = join(dir, 'pid');
    const ac = new AbortController();
    const pending = executeCommandAsync('node', [idleScript(true), pidFile], { signal: ac.signal, timeout: 10_000 });
    const pid = await readPid(pidFile);
    try {
      ac.abort();
      expect((await pending).cancelled).toBe(true);
      expect(await waitFor(() => !isAlive(pid), 4000)).toBe(true);
    } finally {
      if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 15_000);

  it('does not start the command when the signal already fired', async () => {
    const { executeCommandAsync } = await import('./shell');
    const marker = join(dir, 'ran');
    const ac = new AbortController();
    ac.abort();
    const result = await executeCommandAsync('touch', [marker], { signal: ac.signal });
    expect(result.cancelled).toBe(true);
    expect(result.stderr).toBe('Command cancelled');
    // Give a stray process time to create the file before checking.
    await new Promise((r) => setTimeout(r, 200));
    expect(readdirSync(dir)).not.toContain('ran');
  });

  it('removes its abort listener once the command ends', async () => {
    const { executeCommandAsync } = await import('./shell');
    const ac = new AbortController();
    for (let i = 0; i < 3; i++) {
      const result = await executeCommandAsync('echo', ['hi'], { signal: ac.signal });
      expect(result.success).toBe(true);
      expect(result.cancelled).toBeUndefined();
    }
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});
