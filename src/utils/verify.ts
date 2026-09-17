/**
 * Self-verification module for agent
 * Runs build/test and analyzes errors for auto-fixing
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'fs';
import { delimiter, dirname, join, resolve } from 'path';
import { executeCommandAsync, validateCommandAsync, type CommandResult } from './shell';

export interface VerifyResult {
  success: boolean;
  /**
   * Set when the check never reached a verdict: its command was refused by the
   * shell guard, could not be started, timed out, or the project's
   * dependencies are not installed. `success` is false, but nothing about the
   * code was learned, so it is neither a pass nor a failure to fix.
   */
  notRun?: string;
  type: 'build' | 'test' | 'lint' | 'typecheck';
  command: string;
  output: string;
  errors: ParsedError[];
  duration: number;
}

export interface ParsedError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  code?: string;
  severity: 'error' | 'warning';
}

export interface VerifyOptions {
  runBuild: boolean;
  runTest: boolean;
  runLint: boolean;
  runTypecheck: boolean;
  timeout: number;
  /**
   * Stops the checks when it fires (the run was stopped): a running command
   * is killed and its check is reported as not run.
   */
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: VerifyOptions = {
  runBuild: true,
  runTest: true,
  runLint: false,
  runTypecheck: true,
  timeout: 120000, // 2 minutes
};

/**
 * Detect project type and available scripts
 */
export function detectProjectScripts(projectRoot: string): {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun';
} {
  const result: ReturnType<typeof detectProjectScripts> = {
    packageManager: 'npm',
  };
  
  // Detect package manager
  if (existsSync(join(projectRoot, 'bun.lockb'))) {
    result.packageManager = 'bun';
  } else if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) {
    result.packageManager = 'pnpm';
  } else if (existsSync(join(projectRoot, 'yarn.lock'))) {
    result.packageManager = 'yarn';
  }
  
  // Check package.json for scripts
  const packageJsonPath = join(projectRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      
      // Build command
      if (scripts.build) {
        result.build = 'build';
      } else if (scripts.compile) {
        result.build = 'compile';
      }
      
      // Test command
      if (scripts.test) {
        result.test = 'test';
      } else if (scripts.spec) {
        result.test = 'spec';
      }
      
      // Lint command
      if (scripts.lint) {
        result.lint = 'lint';
      } else if (scripts.eslint) {
        result.lint = 'eslint';
      }
      
      // Typecheck command
      if (scripts.typecheck) {
        result.typecheck = 'typecheck';
      } else if (scripts['type-check']) {
        result.typecheck = 'type-check';
      } else if (scripts.tsc) {
        result.typecheck = 'tsc';
      } else if (existsSync(join(projectRoot, 'tsconfig.json'))) {
        // TypeScript project without explicit typecheck script
        result.typecheck = '__tsc_direct__';
      }
    } catch {
      // Ignore parse errors
    }
  }
  
  // Python project
  const requirementsPath = join(projectRoot, 'requirements.txt');
  const pyprojectPath = join(projectRoot, 'pyproject.toml');
  if (existsSync(requirementsPath) || existsSync(pyprojectPath)) {
    if (existsSync(join(projectRoot, 'pytest.ini')) || existsSync(join(projectRoot, 'tests'))) {
      result.test = '__pytest__';
    }
  }
  
  // Go project
  if (existsSync(join(projectRoot, 'go.mod'))) {
    result.build = '__go_build__';
    result.test = '__go_test__';
  }
  
  // Rust project
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    result.build = '__cargo_build__';
    result.test = '__cargo_test__';
  }
  
  // PHP project (Composer)
  if (existsSync(join(projectRoot, 'composer.json'))) {
    try {
      const composer = JSON.parse(readFileSync(join(projectRoot, 'composer.json'), 'utf-8'));
      const scripts = composer.scripts || {};
      
      if (scripts.test) {
        result.test = '__composer_test__';
      } else if (existsSync(join(projectRoot, 'phpunit.xml')) || existsSync(join(projectRoot, 'phpunit.xml.dist'))) {
        result.test = '__phpunit__';
      }
      
      if (scripts.build) {
        result.build = '__composer_build__';
      }
      
      // PHP syntax check
      result.typecheck = '__php_lint__';
    } catch {
      // Ignore parse errors
    }
  }
  
  // Laravel project
  if (existsSync(join(projectRoot, 'artisan'))) {
    result.test = '__artisan_test__';
  }
  
  return result;
}

/** A check that could not be carried out, with the reason. */
function notRunResult(
  type: VerifyResult['type'],
  command: string,
  reason: string,
  output = '',
  duration = 0,
): VerifyResult {
  return { success: false, notRun: reason, type, command, output: output || reason, errors: [], duration };
}

const STOPPED_REASON = 'Stopped by the user.';

function timedOutReason(ms: number): string {
  return `Timed out after ${Math.round(ms / 1000)}s. This tool may be too slow for verification.`;
}

/** Whether executeCommandAsync stopped the command at its timeout. */
function commandTimedOut(result: CommandResult): boolean {
  return result.timedOut === true && !result.cancelled;
}

/**
 * Why a command that was started produced no exit status of its own, or null
 * when it did. executeCommandAsync reports these cases with exit code -1 and a
 * message of its own in place of the command's stderr.
 */
function whyCommandDidNotFinish(result: CommandResult, command: string, duration: number): string | null {
  if (result.cancelled) return STOPPED_REASON;
  if (result.exitCode !== -1) return null;
  const stderr = (result.stderr ?? '').trim();
  if (commandTimedOut(result)) return timedOutReason(duration);
  // Node's own spawn failure, e.g. "spawn php ENOENT" when php is not installed.
  if (/^spawn \S+ E[A-Z]+$/.test(stderr)) return `Could not start ${command} (${stderr}).`;
  if (stderr.startsWith('Working directory does not exist')) return stderr;
  return null;
}

/**
 * Run one command for a check. `notRun` is set when the command never ran to
 * completion, in which case its output says nothing about the code.
 */
async function runCheckCommand(
  command: string,
  args: string[],
  projectRoot: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ result?: CommandResult; notRun?: string; duration: number }> {
  // Checks run under the same shell guard as the agent's own commands. A
  // command the guard refuses fails every time, whatever the code looks like,
  // so it is reported as not run instead of as a failing check.
  const validation = await validateCommandAsync(command, args, { cwd: projectRoot, projectRoot });
  if (!validation.valid) {
    return { notRun: `The shell guard refused \`${command}\`: ${validation.reason ?? 'not allowed'}`, duration: 0 };
  }
  const startTime = Date.now();
  const result = await executeCommandAsync(command, args, {
    cwd: projectRoot,
    projectRoot,
    timeout,
    signal,
  });
  const duration = Date.now() - startTime;
  const notRun = whyCommandDidNotFinish(result, command, duration) ?? undefined;
  return { result, notRun, duration };
}

/**
 * Build the result of a check that ran, from its combined output. `reason` is
 * the part of the output that best explains a failure nothing could be parsed
 * from.
 */
function checkResult(
  type: VerifyResult['type'],
  command: string,
  success: boolean,
  output: string,
  duration: number,
  reason = output,
  note?: string,
): VerifyResult {
  const errors = parseErrors(output, type);

  // A failed check whose output could not be parsed still failed. Its output
  // is the only account of why, so it goes along as a warning (the failure may
  // predate the agent's change).
  if (!success && errors.length === 0) {
    errors.push({ severity: 'warning', message: reason.trim() || 'Command failed with no output' });
  }
  if (note) errors.push({ severity: 'warning', message: note });

  return { success, type, command, output: output.trim(), errors, duration };
}

/** The warning on a failed check whose command did not finish. */
function incompleteNote(notRun: string): string {
  return `Output incomplete: ${notRun.replace(/ This tool may be too slow for verification\.$/, '')} Other errors may be missing.`;
}

/**
 * Run a verification command
 */
async function runVerifyCommand(
  type: VerifyResult['type'],
  command: string,
  args: string[],
  projectRoot: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const display = `${command} ${args.join(' ')}`;
  const { result, notRun, duration } = await runCheckCommand(command, args, projectRoot, timeout, signal);
  const output = result ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : '';
  // A check that timed out after printing failures did fail: those failures
  // are real even though the run never finished (a suite that hangs after a
  // FAIL, `jest --watch`).
  if (notRun && result && commandTimedOut(result) && parseErrors(output, type).some(e => e.severity === 'error')) {
    return checkResult(type, display, false, output, duration, output, incompleteNote(notRun));
  }
  if (notRun || !result) return notRunResult(type, display, notRun ?? 'The command did not run.', output.trim(), duration);
  return checkResult(type, display, result.success, output, duration, result.stderr?.trim() || result.stdout?.trim() || '');
}

/**
 * Whether `name` is installed in a node_modules/.bin directory at or above
 * the project, which is where npx looks for it (a workspace package usually
 * finds its tools hoisted to the repository root).
 */
function hasLocalBin(projectRoot: string, name: string): boolean {
  let dir = resolve(projectRoot);
  for (;;) {
    if (existsSync(join(dir, 'node_modules', '.bin', name))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Whether `name` is an executable found on PATH. */
function isOnPath(name: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some(dir => dir !== '' && existsSync(join(dir, name)));
}

const PHP_LINT_SKIPPED_DIRS = new Set(['vendor', 'node_modules']);
const PHP_LINT_CONCURRENCY = 8;

/** Project PHP files, relative to the root, outside dependency and dot directories. */
function listPhpFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const walk = (rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(rel ? join(projectRoot, rel) : projectRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !PHP_LINT_SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        files.push(path);
      }
    }
  };
  walk('');
  return files.sort();
}

/**
 * PHP syntax check, one `php -l` per file. `find -exec` would hand the file
 * list to php in one command, but the shell guard refuses exec flags, and
 * before PHP 8.3 `php -l` reads only its first file.
 */
async function runPhpLint(projectRoot: string, timeout: number, signal?: AbortSignal): Promise<VerifyResult | null> {
  const files = listPhpFiles(projectRoot);
  if (files.length === 0) return null;

  const display = `php -l (${files.length} file${files.length === 1 ? '' : 's'})`;
  const startTime = Date.now();
  const deadline = startTime + timeout;
  const failures: string[] = [];
  let notRun: string | undefined;
  let next = 0;

  const worker = async () => {
    while (notRun === undefined && next < files.length) {
      const file = files[next++];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        notRun = timedOutReason(timeout);
        return;
      }
      // "./" keeps a file named like an option from being read as one.
      const run = await runCheckCommand('php', ['-l', `./${file}`], projectRoot, remaining, signal);
      if (run.notRun || !run.result) {
        // A call cut short by the deadline stands for the whole lint, which
        // ran for the full timeout, not just this call's share of it.
        notRun ??= run.result && commandTimedOut(run.result)
          ? timedOutReason(timeout)
          : run.notRun ?? 'The command did not run.';
        return;
      }
      if (!run.result.success) failures.push(`${run.result.stdout ?? ''}\n${run.result.stderr ?? ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PHP_LINT_CONCURRENCY, files.length) }, worker));

  const duration = Date.now() - startTime;
  // A file that failed to parse is a failure even if the lint ran out of
  // time before every file was checked. A lint the user stopped is not run,
  // as any other stopped check.
  if (failures.length > 0 && notRun !== STOPPED_REASON) {
    return checkResult('typecheck', display, false, failures.join('\n'), duration, failures.join('\n'), notRun && incompleteNote(notRun));
  }
  if (notRun) return notRunResult('typecheck', display, notRun, '', duration);
  return checkResult('typecheck', display, true, '', duration);
}

/**
 * Parse errors from command output
 */
function parseErrors(output: string, type: string): ParsedError[] {
  const errors: ParsedError[] = [];
  // Tools that are told to keep their colours (FORCE_COLOR) wrap words in
  // escape codes, which no pattern below would match.
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  
  for (const line of lines) {
    // TypeScript/TSC errors: src/file.ts(10,5): error TS2345: ...
    const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/);
    if (tsMatch) {
      errors.push({
        file: tsMatch[1],
        line: parseInt(tsMatch[2]),
        column: parseInt(tsMatch[3]),
        severity: tsMatch[4] as 'error' | 'warning',
        code: tsMatch[5],
        message: tsMatch[6],
      });
      continue;
    }
    
    // ESLint/Prettier: /path/to/file.ts:10:5: error ...
    const eslintMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+)$/);
    if (eslintMatch) {
      errors.push({
        file: eslintMatch[1],
        line: parseInt(eslintMatch[2]),
        column: parseInt(eslintMatch[3]),
        severity: eslintMatch[4] as 'error' | 'warning',
        message: eslintMatch[5],
      });
      continue;
    }
    
    // Jest/Vitest: "FAIL src/file.test.ts", with Jest's "(5.1 s)", Vitest's
    // "|project|" label or "[ src/file.test.ts ]" suffix, or Vitest's
    // "FAIL src/file.test.ts > suite > test name" for a single test.
    const jestFailMatch = line.match(/^\s*FAIL\s+(.+)$/);
    if (jestFailMatch) {
      const rest = jestFailMatch[1].trim().replace(/^\|[^|]*\|\s+/, '');
      const nameAt = rest.search(/\s+[>›]\s+/);
      const file = (nameAt < 0 ? rest : rest.slice(0, nameAt))
        .replace(/\s+\[.*\]$/, '')
        .replace(/\s+\([\d.]+\s*m?s\)$/, '')
        .trim();
      const testName = nameAt < 0 ? '' : rest.slice(nameAt).replace(/^\s+[>›]\s+/, '').trim();
      errors.push({
        file,
        severity: 'error',
        message: testName ? `Test failed: ${testName}` : 'Test file failed',
      });
      continue;
    }
    
    // Generic error with file:line
    const genericMatch = line.match(/^(.+?):(\d+):\s*(.+error.+)$/i);
    if (genericMatch) {
      errors.push({
        file: genericMatch[1],
        line: parseInt(genericMatch[2]),
        severity: 'error',
        message: genericMatch[3],
      });
      continue;
    }
    
    // Go errors: file.go:10:5: ...
    const goMatch = line.match(/^(.+\.go):(\d+):(\d+):\s*(.+)$/);
    if (goMatch) {
      errors.push({
        file: goMatch[1],
        line: parseInt(goMatch[2]),
        column: parseInt(goMatch[3]),
        severity: 'error',
        message: goMatch[4],
      });
      continue;
    }
    
    // Rust errors: error[E0001]: ... --> src/main.rs:10:5
    const rustMatch = line.match(/^\s*-->\s*(.+?):(\d+):(\d+)$/);
    if (rustMatch) {
      errors.push({
        file: rustMatch[1],
        line: parseInt(rustMatch[2]),
        column: parseInt(rustMatch[3]),
        severity: 'error',
        message: 'Rust compilation error',
      });
      continue;
    }
    
    // PHP errors: "PHP Parse error: ... in /path/file.php on line 10" in the
    // error log, "Parse error: ... in ... on line 10" on stdout. php -l often
    // prints both for the same error, so a repeat is dropped.
    const phpMatch = line.match(/^\s*(?:PHP\s+)?(Parse error|Fatal error|Warning):\s*(.+?)\s+in\s+(.+?)\s+on line\s+(\d+)/i);
    if (phpMatch) {
      const error: ParsedError = {
        file: phpMatch[3].replace(/^\.\//, ''),
        line: parseInt(phpMatch[4]),
        severity: phpMatch[1].toLowerCase().includes('warning') ? 'warning' : 'error',
        message: phpMatch[2],
      };
      const seen = errors.some(e => e.file === error.file && e.line === error.line && e.message === error.message);
      if (!seen) errors.push(error);
      continue;
    }
    
    // PHPUnit errors: 1) TestClass::testMethod
    const phpunitMatch = line.match(/^\d+\)\s+(.+)::(.+)$/);
    if (phpunitMatch) {
      errors.push({
        severity: 'error',
        message: `Test failed: ${phpunitMatch[1]}::${phpunitMatch[2]}`,
      });
      continue;
    }
  }
  
  return errors;
}

/**
 * Run build verification
 */
export async function runBuildVerification(
  projectRoot: string,
  timeout: number = 120000,
  signal?: AbortSignal,
): Promise<VerifyResult | null> {
  const scripts = detectProjectScripts(projectRoot);

  if (!scripts.build) {
    return null;
  }

  let command: string;
  let args: string[];

  if (scripts.build === '__go_build__') {
    command = 'go';
    args = ['build', './...'];
  } else if (scripts.build === '__cargo_build__') {
    command = 'cargo';
    args = ['build'];
  } else if (scripts.build === '__composer_build__') {
    command = 'composer';
    args = ['run', 'build'];
  } else {
    if (!existsSync(join(projectRoot, 'node_modules'))) {
      return notRunResult('build', `${scripts.packageManager} run ${scripts.build}`, 'node_modules not found. Run npm install first.');
    }
    command = scripts.packageManager;
    args = ['run', scripts.build];
  }

  return runVerifyCommand('build', command, args, projectRoot, timeout, signal);
}

/**
 * Run test verification
 */
export async function runTestVerification(
  projectRoot: string,
  timeout: number = 120000,
  signal?: AbortSignal,
): Promise<VerifyResult | null> {
  const scripts = detectProjectScripts(projectRoot);
  
  if (!scripts.test) {
    return null;
  }
  
  let command: string;
  let args: string[];
  
  if (scripts.test === '__pytest__') {
    command = 'pytest';
    args = ['-v'];
  } else if (scripts.test === '__go_test__') {
    command = 'go';
    args = ['test', './...'];
  } else if (scripts.test === '__cargo_test__') {
    command = 'cargo';
    args = ['test'];
  } else if (scripts.test === '__phpunit__') {
    // Through php: the shell guard runs named commands only, not a path.
    // Composer's vendor/bin/phpunit is a PHP script either way.
    command = 'php';
    args = ['vendor/bin/phpunit'];
    if (!existsSync(join(projectRoot, 'vendor', 'bin', 'phpunit'))) {
      return notRunResult('test', `${command} ${args.join(' ')}`, 'vendor/bin/phpunit not found. Run composer install first.');
    }
  } else if (scripts.test === '__composer_test__') {
    command = 'composer';
    args = ['run', 'test'];
  } else if (scripts.test === '__artisan_test__') {
    command = 'php';
    args = ['artisan', 'test'];
  } else {
    if (!existsSync(join(projectRoot, 'node_modules'))) {
      return notRunResult('test', `${scripts.packageManager} run ${scripts.test}`, 'node_modules not found. Run npm install first.');
    }
    command = scripts.packageManager;
    args = ['run', scripts.test];
  }

  return runVerifyCommand('test', command, args, projectRoot, timeout, signal);
}

/**
 * Run TypeScript type checking
 */
export async function runTypecheckVerification(
  projectRoot: string,
  timeout: number = 60000,
  signal?: AbortSignal,
): Promise<VerifyResult | null> {
  const scripts = detectProjectScripts(projectRoot);
  
  if (!scripts.typecheck) {
    return null;
  }
  
  let command: string;
  let args: string[];
  
  if (scripts.typecheck === '__tsc_direct__') {
    // The shell guard runs named commands only, so a project's own tsc goes
    // through npx, which finds it in node_modules/.bin. --no-install keeps npx
    // from fetching the unrelated "tsc" package from the registry instead.
    if (hasLocalBin(projectRoot, 'tsc')) {
      command = 'npx';
      args = ['--no-install', 'tsc', '--noEmit'];
    } else if (isOnPath('tsc')) {
      command = 'tsc';
      args = ['--noEmit'];
    } else {
      return notRunResult('typecheck', 'tsc --noEmit', 'TypeScript is not installed (no tsc in node_modules/.bin or on PATH). Run npm install first.');
    }
  } else if (scripts.typecheck === '__php_lint__') {
    return runPhpLint(projectRoot, timeout, signal);
  } else {
    command = scripts.packageManager;
    args = ['run', scripts.typecheck];
  }
  
  return runVerifyCommand('typecheck', command, args, projectRoot, timeout, signal);
}

/**
 * Run lint verification
 */
export async function runLintVerification(
  projectRoot: string,
  timeout: number = 60000,
  signal?: AbortSignal,
): Promise<VerifyResult | null> {
  const scripts = detectProjectScripts(projectRoot);
  
  if (!scripts.lint) {
    return null;
  }
  
  const command = scripts.packageManager;
  const args = ['run', scripts.lint];
  
  return runVerifyCommand('lint', command, args, projectRoot, timeout, signal);
}

/**
 * Run all verifications
 */
export async function runAllVerifications(
  projectRoot: string,
  options: Partial<VerifyOptions> = {}
): Promise<VerifyResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const results: VerifyResult[] = [];

  // Run typecheck and lint in parallel (independent checks)
  const parallel: Promise<VerifyResult | null>[] = [];
  if (opts.runTypecheck) parallel.push(runTypecheckVerification(projectRoot, opts.timeout, opts.signal));
  if (opts.runLint) parallel.push(runLintVerification(projectRoot, opts.timeout, opts.signal));

  if (parallel.length > 0) {
    const parallelResults = await Promise.all(parallel);
    for (const r of parallelResults) { if (r) results.push(r); }
  }

  // Run build after typecheck/lint (may depend on them)
  if (opts.runBuild) {
    const result = await runBuildVerification(projectRoot, opts.timeout, opts.signal);
    if (result) results.push(result);
  }

  // Run tests last (slowest, depends on build)
  if (opts.runTest) {
    const result = await runTestVerification(projectRoot, opts.timeout, opts.signal);
    if (result) results.push(result);
  }

  return results;
}

/**
 * Format verification results for display
 */
export function formatVerifyResults(results: VerifyResult[]): string {
  const lines: string[] = [];
  
  for (const result of results) {
    const status = result.success ? '✓' : result.notRun ? '⚠' : '✗';
    const duration = `${(result.duration / 1000).toFixed(1)}s`;
    
    lines.push(`${status} ${result.type}: ${result.command} (${duration})`);
    if (result.notRun) {
      lines.push(`  not run: ${result.notRun}`);
      continue;
    }
    
    if (!result.success && result.errors.length > 0) {
      const errorCount = result.errors.filter(e => e.severity === 'error').length;
      const warnCount = result.errors.filter(e => e.severity === 'warning').length;
      lines.push(`  ${errorCount} error(s), ${warnCount} warning(s)`);
      
      // Show first few errors
      for (const error of result.errors.slice(0, 5)) {
        const loc = error.file ? `${error.file}:${error.line || '?'}` : '';
        lines.push(`  - ${loc}: ${error.message}`);
      }
      
      if (result.errors.length > 5) {
        lines.push(`  ... and ${result.errors.length - 5} more`);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Format errors for agent to fix
 */
export function formatErrorsForAgent(results: VerifyResult[]): string {
  // A check that did not run has nothing in it to fix.
  const failedResults = failedChecks(results);
  
  if (failedResults.length === 0) {
    return '';
  }
  
  const lines: string[] = ['## Verification Errors - Please Fix:', ''];
  
  for (const result of failedResults) {
    lines.push(`### ${result.type.toUpperCase()} Failed`);
    lines.push(`Command: ${result.command}`);
    lines.push('');
    
    if (result.errors.length > 0) {
      lines.push('Errors:');
      for (const error of result.errors) {
        const loc = error.file 
          ? `${error.file}${error.line ? `:${error.line}` : ''}${error.column ? `:${error.column}` : ''}`
          : 'unknown';
        lines.push(`- [${loc}] ${error.message}${error.code ? ` (${error.code})` : ''}`);
      }
    } else {
      // No parsed errors, show raw output
      lines.push('Output:');
      lines.push('```');
      lines.push(result.output.slice(0, 2000));
      if (result.output.length > 2000) {
        lines.push('... (truncated)');
      }
      lines.push('```');
    }
    
    lines.push('');
  }
  
  lines.push('Please fix these errors and try again.');
  
  return lines.join('\n');
}

/**
 * Checks that ran and failed. A check that could not run is not among them.
 */
export function failedChecks(results: VerifyResult[]): VerifyResult[] {
  return results.filter(r => !r.success && !r.notRun);
}

/**
 * Checks that could not be carried out (see VerifyResult.notRun).
 */
export function checksNotRun(results: VerifyResult[]): VerifyResult[] {
  return results.filter(r => !r.success && r.notRun);
}

/**
 * Check if any verification failed
 */
export function hasVerificationErrors(results: VerifyResult[]): boolean {
  return failedChecks(results).length > 0;
}

/**
 * Get summary of verification
 */
export function getVerificationSummary(results: VerifyResult[]): {
  passed: number;
  failed: number;
  notRun: number;
  total: number;
  errors: number;
} {
  const passed = results.filter(r => r.success).length;
  const failed = failedChecks(results).length;
  const notRun = checksNotRun(results).length;
  const errors = results.reduce((sum, r) => sum + r.errors.filter(e => e.severity === 'error').length, 0);
  
  return {
    passed,
    failed,
    notRun,
    total: results.length,
    errors,
  };
}
