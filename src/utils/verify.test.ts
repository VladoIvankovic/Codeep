import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs before importing the module under test
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock shell module so we don't run real commands. verify.run.test.ts runs
// the real shell guard.
vi.mock('./shell', () => ({
  executeCommandAsync: vi.fn(),
  validateCommandAsync: vi.fn(async () => ({ valid: true })),
}));

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { executeCommandAsync, validateCommandAsync } from './shell';
import {
  detectProjectScripts,
  formatVerifyResults,
  formatErrorsForAgent,
  hasVerificationErrors,
  getVerificationSummary,
  runAllVerifications,
  VerifyResult,
  ParsedError,
} from './verify';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockExecuteCommandAsync = executeCommandAsync as ReturnType<typeof vi.fn>;

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    success: true,
    type: 'build',
    command: 'npm run build',
    output: '',
    errors: [],
    duration: 1000,
    ...overrides,
  };
}

function makeError(overrides: Partial<ParsedError> = {}): ParsedError {
  return {
    message: 'some error',
    severity: 'error',
    ...overrides,
  };
}

// ─── detectProjectScripts ────────────────────────────────────────────────────

describe('detectProjectScripts', () => {
  const root = '/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // By default nothing exists
    mockExistsSync.mockReturnValue(false);
  });

  it('defaults to npm when no lockfile found', () => {
    const result = detectProjectScripts(root);
    expect(result.packageManager).toBe('npm');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'pnpm-lock.yaml'));
    const result = detectProjectScripts(root);
    expect(result.packageManager).toBe('pnpm');
  });

  it('detects yarn from yarn.lock', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'yarn.lock'));
    const result = detectProjectScripts(root);
    expect(result.packageManager).toBe('yarn');
  });

  it('detects bun from bun.lockb (highest priority)', () => {
    mockExistsSync.mockReturnValue(true); // everything "exists"
    const result = detectProjectScripts(root);
    expect(result.packageManager).toBe('bun');
  });

  it('reads build/test/lint/typecheck scripts from package.json', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join(root, 'package.json')
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        scripts: {
          build: 'tsc',
          test: 'vitest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      })
    );

    const result = detectProjectScripts(root);
    expect(result.build).toBe('build');
    expect(result.test).toBe('test');
    expect(result.lint).toBe('lint');
    expect(result.typecheck).toBe('typecheck');
  });

  it('falls back to compile when no build script', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'package.json'));
    mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { compile: 'tsc' } }));
    expect(detectProjectScripts(root).build).toBe('compile');
  });

  it('falls back to spec when no test script', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'package.json'));
    mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { spec: 'rspec' } }));
    expect(detectProjectScripts(root).test).toBe('spec');
  });

  it('uses type-check script when no typecheck script', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'package.json'));
    mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { 'type-check': 'tsc' } }));
    expect(detectProjectScripts(root).typecheck).toBe('type-check');
  });

  it('sets typecheck to __tsc_direct__ when tsconfig.json present but no script', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join(root, 'package.json') || p === join(root, 'tsconfig.json')
    );
    mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: {} }));
    expect(detectProjectScripts(root).typecheck).toBe('__tsc_direct__');
  });

  it('detects Go project from go.mod', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'go.mod'));
    const result = detectProjectScripts(root);
    expect(result.build).toBe('__go_build__');
    expect(result.test).toBe('__go_test__');
  });

  it('detects Rust project from Cargo.toml', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'Cargo.toml'));
    const result = detectProjectScripts(root);
    expect(result.build).toBe('__cargo_build__');
    expect(result.test).toBe('__cargo_test__');
  });

  it('detects Python pytest from requirements.txt + tests dir', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join(root, 'requirements.txt') || p === join(root, 'tests')
    );
    const result = detectProjectScripts(root);
    expect(result.test).toBe('__pytest__');
  });

  it('detects PHP composer test', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'composer.json'));
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === join(root, 'composer.json')) {
        return JSON.stringify({ scripts: { test: 'phpunit' } });
      }
      return '';
    });
    const result = detectProjectScripts(root);
    expect(result.test).toBe('__composer_test__');
    expect(result.typecheck).toBe('__php_lint__');
  });

  it('detects Laravel artisan test', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'artisan'));
    const result = detectProjectScripts(root);
    expect(result.test).toBe('__artisan_test__');
  });

  it('handles invalid package.json gracefully', () => {
    mockExistsSync.mockImplementation((p: string) => p === join(root, 'package.json'));
    mockReadFileSync.mockReturnValue('not valid json');
    expect(() => detectProjectScripts(root)).not.toThrow();
  });
});

// ─── hasVerificationErrors ───────────────────────────────────────────────────

describe('checks that could not run', () => {
  const notRun = makeResult({ success: false, type: 'typecheck', command: 'tsc --noEmit', notRun: 'TypeScript is not installed' });
  const failed = makeResult({ success: false, type: 'test', command: 'npm run test', errors: [makeError()] });

  it('are not verification errors', () => {
    expect(hasVerificationErrors([notRun, makeResult()])).toBe(false);
    expect(hasVerificationErrors([notRun, failed])).toBe(true);
  });

  it('are counted apart from passes and failures', () => {
    expect(getVerificationSummary([makeResult(), notRun, failed])).toMatchObject({ passed: 1, failed: 1, notRun: 1, total: 3 });
  });

  it('are not handed to the agent to fix', () => {
    const text = formatErrorsForAgent([notRun, failed]);
    expect(text).toContain('npm run test');
    expect(text).not.toContain('tsc --noEmit');
    expect(formatErrorsForAgent([notRun])).toBe('');
  });

  it('are shown with the reason', () => {
    expect(formatVerifyResults([notRun])).toContain('⚠ typecheck: tsc --noEmit');
    expect(formatVerifyResults([notRun])).toContain('not run: TypeScript is not installed');
  });
});

describe('hasVerificationErrors', () => {
  it('returns false when all results are successful', () => {
    const results = [makeResult({ success: true }), makeResult({ success: true })];
    expect(hasVerificationErrors(results)).toBe(false);
  });

  it('returns true when any result fails', () => {
    const results = [makeResult({ success: true }), makeResult({ success: false })];
    expect(hasVerificationErrors(results)).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(hasVerificationErrors([])).toBe(false);
  });
});

// ─── getVerificationSummary ──────────────────────────────────────────────────

describe('getVerificationSummary', () => {
  it('returns correct counts for mixed results', () => {
    const results = [
      makeResult({ success: true, errors: [] }),
      makeResult({
        success: false,
        errors: [makeError({ severity: 'error' }), makeError({ severity: 'warning' })],
      }),
      makeResult({
        success: false,
        errors: [makeError({ severity: 'error' })],
      }),
    ];

    const summary = getVerificationSummary(results);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.errors).toBe(2); // Only error-severity errors counted
  });

  it('returns zero counts for empty array', () => {
    const summary = getVerificationSummary([]);
    expect(summary).toEqual({ passed: 0, failed: 0, notRun: 0, total: 0, errors: 0 });
  });
});

// ─── formatVerifyResults ─────────────────────────────────────────────────────

describe('formatVerifyResults', () => {
  it('shows ✓ for passing results', () => {
    const results = [makeResult({ success: true, type: 'build', command: 'npm run build' })];
    const output = formatVerifyResults(results);
    expect(output).toContain('✓ build: npm run build');
  });

  it('shows ✗ for failing results', () => {
    const results = [makeResult({ success: false, type: 'test', command: 'npm test' })];
    const output = formatVerifyResults(results);
    expect(output).toContain('✗ test: npm test');
  });

  it('shows error and warning counts for failures', () => {
    const results = [
      makeResult({
        success: false,
        errors: [
          makeError({ severity: 'error' }),
          makeError({ severity: 'error' }),
          makeError({ severity: 'warning' }),
        ],
      }),
    ];
    const output = formatVerifyResults(results);
    expect(output).toContain('2 error(s)');
    expect(output).toContain('1 warning(s)');
  });

  it('shows first 5 errors and truncation message', () => {
    const errors = Array.from({ length: 7 }, (_, i) =>
      makeError({ file: `file${i}.ts`, message: `error ${i}` })
    );
    const results = [makeResult({ success: false, errors })];
    const output = formatVerifyResults(results);
    expect(output).toContain('... and 2 more');
    expect(output).toContain('file0.ts');
    expect(output).toContain('file4.ts');
    expect(output).not.toContain('file5.ts'); // 6th+ not shown
  });

  it('includes duration in seconds', () => {
    const results = [makeResult({ success: true, duration: 2500 })];
    expect(formatVerifyResults(results)).toContain('2.5s');
  });

  it('returns empty string for empty array', () => {
    expect(formatVerifyResults([])).toBe('');
  });
});

// ─── formatErrorsForAgent ────────────────────────────────────────────────────

describe('formatErrorsForAgent', () => {
  it('returns empty string when all results pass', () => {
    expect(formatErrorsForAgent([makeResult({ success: true })])).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(formatErrorsForAgent([])).toBe('');
  });

  it('formats failed results with errors', () => {
    const results = [
      makeResult({
        success: false,
        type: 'typecheck',
        command: 'npx tsc --noEmit',
        errors: [
          makeError({ file: 'src/foo.ts', line: 42, column: 5, message: 'Type mismatch', code: 'TS2345' }),
        ],
      }),
    ];
    const output = formatErrorsForAgent(results);
    expect(output).toContain('TYPECHECK Failed');
    expect(output).toContain('npx tsc --noEmit');
    expect(output).toContain('src/foo.ts:42:5');
    expect(output).toContain('Type mismatch');
    expect(output).toContain('TS2345');
    expect(output).toContain('Please fix these errors');
  });

  it('shows raw output when no structured errors', () => {
    const results = [
      makeResult({
        success: false,
        output: 'Something went very wrong\ncheck the logs',
        errors: [],
      }),
    ];
    const output = formatErrorsForAgent(results);
    expect(output).toContain('Something went very wrong');
    expect(output).toContain('```');
  });

  it('truncates raw output beyond 2000 chars', () => {
    const longOutput = 'x'.repeat(2100);
    const results = [makeResult({ success: false, output: longOutput, errors: [] })];
    const output = formatErrorsForAgent(results);
    expect(output).toContain('... (truncated)');
  });

  it('includes only failed results', () => {
    const results = [
      makeResult({ success: true, type: 'build' }),
      makeResult({ success: false, type: 'test', errors: [makeError()] }),
    ];
    const output = formatErrorsForAgent(results);
    expect(output).toContain('TEST Failed');
    expect(output).not.toContain('BUILD Failed');
  });
});

// ─── error parsing (via runAllVerifications with mocked executeCommandAsync) ──

describe('error parsing via runAllVerifications', () => {
  const root = '/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up a Node.js project with typecheck script
    mockExistsSync.mockImplementation((p: string) =>
      p === join(root, 'package.json') || p === join(root, 'tsconfig.json')
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ scripts: { typecheck: 'tsc' } })
    );
  });

  it('parses TypeScript errors (file(line,col): error TSxxxx: msg)', async () => {
    mockExecuteCommandAsync.mockResolvedValue({
      success: false,
      stdout: 'src/foo.ts(10,5): error TS2345: Argument of type "x" is not assignable to parameter of type "y".',
      stderr: '',
    });

    const results = await runAllVerifications(root, { runBuild: false, runTest: false, runLint: false, runTypecheck: true });
    expect(results).toHaveLength(1);

    const [result] = results;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('src/foo.ts');
    expect(result.errors[0].line).toBe(10);
    expect(result.errors[0].column).toBe(5);
    expect(result.errors[0].severity).toBe('error');
    expect(result.errors[0].code).toBe('TS2345');
  });

  it('parses ESLint errors (file:line:col: error msg)', async () => {
    mockExecuteCommandAsync.mockResolvedValue({
      success: false,
      stdout: '/project/src/bar.ts:15:3: error no-unused-vars: "x" is defined but never used.',
      stderr: '',
    });

    const results = await runAllVerifications(root, { runBuild: false, runTest: false, runLint: false, runTypecheck: true });
    const [result] = results;

    expect(result.errors[0].file).toBe('/project/src/bar.ts');
    expect(result.errors[0].line).toBe(15);
    expect(result.errors[0].column).toBe(3);
    expect(result.errors[0].severity).toBe('error');
  });

  const parse = async (stdout: string) => {
    mockExecuteCommandAsync.mockResolvedValue({ success: false, stdout, stderr: '', exitCode: 1 });
    const [result] = await runAllVerifications(root, { runBuild: false, runTest: false, runLint: false, runTypecheck: true });
    return result.errors;
  };

  it('reads the file and test name from a Vitest failure line', async () => {
    const errors = await parse(' FAIL  src/utils/x.test.ts > parser > keeps the name');
    expect(errors).toEqual([
      { file: 'src/utils/x.test.ts', severity: 'error', message: 'Test failed: parser > keeps the name' },
    ]);
  });

  it('reads the file from Vitest and Jest file-level failure lines', async () => {
    const errors = await parse([
      ' FAIL  src/a.test.ts [ src/a.test.ts ]',
      ' FAIL  |unit| src/b.test.ts > b > works',
      ' FAIL  src/c.test.ts (5.123 s)',
    ].join('\n'));
    expect(errors.map(e => e.file)).toEqual(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts']);
    expect(errors.map(e => e.message)).toEqual(['Test file failed', 'Test failed: b > works', 'Test file failed']);
  });

  it('reads failure lines from coloured output', async () => {
    const errors = await parse('\x1b[31m FAIL \x1b[39m src/a.test.ts\x1b[2m > \x1b[22ma > works');
    expect(errors).toEqual([{ file: 'src/a.test.ts', severity: 'error', message: 'Test failed: a > works' }]);
  });

  it('reads PHP errors printed with and without the log prefix, once each', async () => {
    const errors = await parse([
      'PHP Parse error:  syntax error, unexpected end of file in ./src/a.php on line 7',
      '',
      'Parse error: syntax error, unexpected end of file in ./src/a.php on line 7',
      'Errors parsing ./src/a.php',
    ].join('\n'));
    expect(errors).toEqual([
      { file: 'src/a.php', line: 7, severity: 'error', message: 'syntax error, unexpected end of file' },
    ]);
  });

  it('reports a command the shell guard refuses as not run, without starting it', async () => {
    vi.mocked(validateCommandAsync).mockResolvedValueOnce({ valid: false, reason: "Command 'x' is not in the allowed list" });

    const results = await runAllVerifications(root, { runBuild: false, runTest: false, runLint: false, runTypecheck: true });

    expect(results[0].notRun).toContain('not in the allowed list');
    expect(hasVerificationErrors(results)).toBe(false);
    expect(mockExecuteCommandAsync).not.toHaveBeenCalled();
  });

  it('parses Jest FAIL lines', async () => {
    mockExecuteCommandAsync.mockResolvedValue({
      success: false,
      stdout: ' FAIL src/foo.test.ts',
      stderr: '',
    });

    const results = await runAllVerifications(root, { runBuild: false, runTest: false, runLint: false, runTypecheck: true });
    const [result] = results;

    expect(result.errors[0].file).toBe('src/foo.test.ts');
    expect(result.errors[0].message).toBe('Test file failed');
    expect(result.errors[0].severity).toBe('error');
  });

  it('returns empty errors array for successful command output', async () => {
    mockExecuteCommandAsync.mockResolvedValue({
      success: true,
      stdout: 'Build succeeded',
      stderr: '',
    });

    const results = await runAllVerifications(root, { runBuild: false, runTest: false, runLint: false, runTypecheck: true });
    expect(results[0].success).toBe(true);
    expect(results[0].errors).toHaveLength(0);
  });

  it('returns no results when no scripts available', async () => {
    // No package.json, no go.mod, nothing
    mockExistsSync.mockReturnValue(false);

    const results = await runAllVerifications(root, { runBuild: true, runTest: true, runLint: true, runTypecheck: true });
    expect(results).toHaveLength(0);
  });
});

// ─── runAllVerifications (async) ─────────────────────────────────────────────

describe('runAllVerifications (async)', () => {
  it('returns array of results', async () => {
    const results = await runAllVerifications(process.cwd());
    expect(Array.isArray(results)).toBe(true);
  });

  it('each result has required fields', async () => {
    mockExecuteCommandAsync.mockResolvedValue({
      success: true,
      stdout: 'ok',
      stderr: '',
    });

    const results = await runAllVerifications(process.cwd());
    for (const r of results) {
      expect(r).toHaveProperty('success');
      expect(r).toHaveProperty('type');
      expect(r).toHaveProperty('errors');
      expect(r).toHaveProperty('duration');
    }
  });

  it('hasVerificationErrors returns boolean', async () => {
    mockExecuteCommandAsync.mockResolvedValue({
      success: true,
      stdout: 'ok',
      stderr: '',
    });

    const results = await runAllVerifications(process.cwd(), {
      runBuild: false,
      runTest: false,
      runLint: false,
      runTypecheck: true,
    });
    expect(typeof hasVerificationErrors(results)).toBe('boolean');
  });
});
