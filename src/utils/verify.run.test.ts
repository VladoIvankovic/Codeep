/**
 * Verification against real projects on disk, through the real shell guard
 * and real process spawning. The tools themselves (npx, tsc, php) are small
 * shell scripts on a PATH the test controls, so nothing here depends on what
 * the machine has installed and nothing reaches a registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAllVerifications, hasVerificationErrors, type VerifyOptions } from './verify';

const only = (check: 'typecheck' | 'test' | 'build', extra: Partial<VerifyOptions> = {}): Partial<VerifyOptions> => ({
  runTypecheck: check === 'typecheck',
  runTest: check === 'test',
  runBuild: check === 'build',
  runLint: false,
  ...extra,
});

let root: string;
let bin: string;
let savedPath: string | undefined;

const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};
// A stand-in for a tool on PATH. It records its arguments in <name>.calls.
const tool = (name: string, body = 'exit 0') => script(join(bin, name), `echo "$@" >> "${join(bin, `${name}.calls`)}"\n${body}`);
const callsOf = (name: string) => {
  const file = join(bin, `${name}.calls`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-verify-run-'));
  bin = mkdtempSync(join(tmpdir(), 'codeep-verify-bin-'));
  savedPath = process.env.PATH;
  process.env.PATH = bin;
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('checks run through commands the shell guard allows', () => {
  const typescriptProject = () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: {} }));
    write('tsconfig.json', '{}');
  };

  it('type-checks with the project\'s own tsc', async () => {
    typescriptProject();
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    script(join(root, 'node_modules', '.bin', 'tsc'), 'exit 0');
    tool('npx');

    const [result] = await runAllVerifications(root, only('typecheck'));

    expect(result.notRun).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.command).toBe('npx --no-install tsc --noEmit');
    expect(callsOf('npx')).toEqual(['--no-install tsc --noEmit']);
  });

  it('reports the type errors the project\'s own tsc finds', async () => {
    typescriptProject();
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    script(join(root, 'node_modules', '.bin', 'tsc'), 'exit 0');
    tool('npx', "echo \"src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\"; exit 2");

    const [result] = await runAllVerifications(root, only('typecheck'));

    expect(result.notRun).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.errors).toMatchObject([{ file: 'src/a.ts', line: 3, code: 'TS2322', severity: 'error' }]);
  });

  it('finds a tsc hoisted to a workspace root above the project', async () => {
    write('pkg/package.json', JSON.stringify({ name: 'pkg', scripts: {} }));
    write('pkg/tsconfig.json', '{}');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    script(join(root, 'node_modules', '.bin', 'tsc'), 'exit 0');
    tool('npx');

    const [result] = await runAllVerifications(join(root, 'pkg'), only('typecheck'));

    expect(result.notRun).toBeUndefined();
    expect(result).toMatchObject({ success: true, command: 'npx --no-install tsc --noEmit' });
    expect(callsOf('npx')).toEqual(['--no-install tsc --noEmit']);
  });

  it('uses a tsc from PATH when the project has none', async () => {
    typescriptProject();
    tool('tsc');

    const [result] = await runAllVerifications(root, only('typecheck'));

    expect(result).toMatchObject({ success: true, command: 'tsc --noEmit' });
    expect(result.notRun).toBeUndefined();
  });

  it('says the typecheck could not run when TypeScript is not installed, without asking npx to fetch it', async () => {
    typescriptProject();
    tool('npx');

    const results = await runAllVerifications(root, only('typecheck'));

    expect(results).toHaveLength(1);
    expect(results[0].notRun).toMatch(/TypeScript is not installed/);
    expect(hasVerificationErrors(results)).toBe(false);
    expect(callsOf('npx')).toEqual([]);
  });

  describe('PHP syntax check', () => {
    const phpProject = () => {
      write('composer.json', JSON.stringify({ name: 'p/p', scripts: {} }));
      write('src/good.php', '<?php echo 1;\n');
      write('src/bad.php', '<?php echo 1\nfunction x( {\n');
      write('vendor/lib/bad.php', 'not php at all');
    };
    // What `php -l` prints on stdout for a file whose name says it is broken.
    const fakePhp = () => tool('php', [
      'case "$2" in',
      '  *bad*) echo; echo "Parse error: syntax error, unexpected token \\"function\\" in $2 on line 2"; echo "Errors parsing $2"; exit 255;;',
      '  *) echo "No syntax errors detected in $2";;',
      'esac',
    ].join('\n'));

    it('lints each project file and reports the broken one', async () => {
      phpProject();
      fakePhp();

      const [result] = await runAllVerifications(root, only('typecheck'));

      expect(result.notRun).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.errors).toEqual([
        { file: 'src/bad.php', line: 2, severity: 'error', message: 'syntax error, unexpected token "function"' },
      ]);
      // Dependencies are not the project's code.
      expect(callsOf('php').sort()).toEqual(['-l ./src/bad.php', '-l ./src/good.php']);
    });

    it('passes when every file parses', async () => {
      phpProject();
      rmSync(join(root, 'src', 'bad.php'));
      fakePhp();

      const [result] = await runAllVerifications(root, only('typecheck'));

      expect(result).toMatchObject({ success: true, command: 'php -l (1 file)' });
    });

    it('leaves files in dot directories alone', async () => {
      phpProject();
      write('.git/hooks/bad.php', 'not php at all');
      write('.idea/bad.php', 'not php at all');
      fakePhp();

      await runAllVerifications(root, only('typecheck'));

      expect(callsOf('php').sort()).toEqual(['-l ./src/bad.php', '-l ./src/good.php']);
    });

    it('still fails on a broken file when another file runs out of time', async () => {
      write('composer.json', JSON.stringify({ name: 'p/p', scripts: {} }));
      write('src/a_bad.php', '<?php echo 1\n');
      write('src/b_slow.php', '<?php echo 1;\n');
      tool('php', [
        'case "$2" in',
        '  *bad*) echo "Parse error: syntax error, unexpected end of file in $2 on line 2"; exit 255;;',
        '  *slow*) exec /bin/sleep 5;;',
        'esac',
      ].join('\n'));

      const results = await runAllVerifications(root, only('typecheck', { timeout: 800 }));

      expect(results[0].notRun).toBeUndefined();
      expect(results[0].success).toBe(false);
      expect(results[0].errors[0]).toEqual(
        { file: 'src/a_bad.php', line: 2, severity: 'error', message: 'syntax error, unexpected end of file' },
      );
      expect(results[0].errors[1]).toMatchObject({ severity: 'warning', message: expect.stringMatching(/^Output incomplete: Timed out after \d+s/) });
      expect(hasVerificationErrors(results)).toBe(true);
    });

    it('reports the whole lint\'s time limit when a late file runs out of time', async () => {
      // Eight files fill every worker for a second; the ninth starts with
      // what is left of the budget and runs past it.
      write('composer.json', JSON.stringify({ name: 'p/p', scripts: {} }));
      for (let i = 1; i <= 8; i++) write(`src/a${i}.php`, '<?php echo 1;\n');
      write('src/z_slow.php', '<?php echo 1;\n');
      tool('php', [
        'case "$2" in',
        '  *slow*) exec /bin/sleep 6;;',
        '  *) /bin/sleep 1; echo "No syntax errors detected in $2";;',
        'esac',
      ].join('\n'));

      const results = await runAllVerifications(root, only('typecheck', { timeout: 3400 }));

      expect(results[0].notRun).toBe('Timed out after 3s. This tool may be too slow for verification.');
      expect(hasVerificationErrors(results)).toBe(false);
    }, 15000);

    it('says the check could not run when php is not installed', async () => {
      phpProject();

      const results = await runAllVerifications(root, only('typecheck'));

      expect(results[0].notRun).toMatch(/Could not start php/);
      expect(hasVerificationErrors(results)).toBe(false);
    });
  });

  it('runs PHPUnit from vendor/bin', async () => {
    write('composer.json', JSON.stringify({ name: 'p/p', scripts: {} }));
    write('phpunit.xml', '<phpunit/>');
    write('vendor/bin/phpunit', '<?php // proxy');
    tool('php');

    const [result] = await runAllVerifications(root, only('test'));

    expect(result).toMatchObject({ success: true, command: 'php vendor/bin/phpunit' });
    expect(result.notRun).toBeUndefined();
    expect(callsOf('php')).toEqual(['vendor/bin/phpunit']);
  });

  it('says PHPUnit could not run before composer install', async () => {
    write('composer.json', JSON.stringify({ name: 'p/p', scripts: {} }));
    write('phpunit.xml', '<phpunit/>');
    tool('php');

    const [result] = await runAllVerifications(root, only('test'));

    expect(result.notRun).toMatch(/composer install/);
    expect(callsOf('php')).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('checks that cannot reach a verdict', () => {
  it('reports a check that runs out of time as not run', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { build: 'x' } }));
    mkdirSync(join(root, 'node_modules'));
    tool('npm', 'exec /bin/sleep 5');

    const results = await runAllVerifications(root, only('build', { timeout: 300 }));

    expect(results[0].notRun).toMatch(/Timed out/);
    expect(hasVerificationErrors(results)).toBe(false);
  });

  it('still fails a check that printed failures before it ran out of time', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'x' } }));
    mkdirSync(join(root, 'node_modules'));
    tool('npm', 'echo " FAIL  src/a.test.ts > a > works"; exec /bin/sleep 5');

    const results = await runAllVerifications(root, only('test', { timeout: 800 }));

    expect(results[0].notRun).toBeUndefined();
    expect(results[0].success).toBe(false);
    expect(results[0].errors).toEqual([
      { file: 'src/a.test.ts', severity: 'error', message: 'Test failed: a > works' },
      { severity: 'warning', message: expect.stringMatching(/^Output incomplete: Timed out after \d+s\. Other errors may be missing\.$/) },
    ]);
    expect(hasVerificationErrors(results)).toBe(true);
  });

  it('still fails a check that printed its failures on stderr before it ran out of time', async () => {
    // Jest and cargo report failures on stderr; the timeout must not drop them.
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'x' } }));
    mkdirSync(join(root, 'node_modules'));
    tool('npm', 'echo " FAIL  src/b.test.ts > b > works" 1>&2; exec /bin/sleep 5');

    const results = await runAllVerifications(root, only('test', { timeout: 800 }));

    expect(results[0].notRun).toBeUndefined();
    expect(results[0].success).toBe(false);
    expect(results[0].errors[0]).toEqual({ file: 'src/b.test.ts', severity: 'error', message: 'Test failed: b > works' });
    expect(hasVerificationErrors(results)).toBe(true);
  });

  it('reports a check that timed out after printing only progress on stderr as not run', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'x' } }));
    mkdirSync(join(root, 'node_modules'));
    tool('npm', 'echo "Determining test suites to run..." 1>&2; exec /bin/sleep 5');

    const results = await runAllVerifications(root, only('test', { timeout: 800 }));

    expect(results[0].notRun).toMatch(/^Timed out after \d+s\./);
    expect(hasVerificationErrors(results)).toBe(false);
  });

  it('stops a running check when the run is stopped, and does not count it as failed', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'x' } }));
    mkdirSync(join(root, 'node_modules'));
    tool('npm', 'echo " FAIL  src/a.test.ts > a > works"; exec /bin/sleep 5');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();

    const results = await runAllVerifications(root, only('test', { timeout: 60000, signal: controller.signal }));

    expect(Date.now() - started).toBeLessThan(3000);
    expect(results[0].notRun).toBe('Stopped by the user.');
    expect(hasVerificationErrors(results)).toBe(false);
  });

  it('reports a Node project without node_modules as not run', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'x' } }));
    tool('npm');

    const results = await runAllVerifications(root, only('test'));

    expect(results[0].notRun).toMatch(/npm install/);
    expect(hasVerificationErrors(results)).toBe(false);
    expect(callsOf('npm')).toEqual([]);
  });

  it('still fails a check that ran and exited non-zero', async () => {
    write('package.json', JSON.stringify({ name: 'p', scripts: { build: 'x' } }));
    mkdirSync(join(root, 'node_modules'));
    tool('npm', 'echo "Could not resolve ./x" >&2; exit 1');

    const results = await runAllVerifications(root, only('build'));

    expect(results[0].notRun).toBeUndefined();
    expect(results[0].errors).toEqual([{ severity: 'warning', message: 'Could not resolve ./x' }]);
    expect(hasVerificationErrors(results)).toBe(true);
  });
});
