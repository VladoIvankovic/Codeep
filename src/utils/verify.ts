/**
 * Self-verification module for agent
 * Runs build/test and analyzes errors for auto-fixing
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { executeCommandAsync } from './shell';
import { ProjectContext } from './project';

export interface VerifyResult {
  success: boolean;
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

/**
 * Run a verification command
 */
async function runVerifyCommand(
  type: VerifyResult['type'],
  command: string,
  args: string[],
  projectRoot: string,
  timeout: number
): Promise<VerifyResult> {
  const startTime = Date.now();

  const result = await executeCommandAsync(command, args, {
    cwd: projectRoot,
    projectRoot,
    timeout,
  });

  const duration = Date.now() - startTime;
  const output = result.stdout + '\n' + result.stderr;

  // Parse errors from output
  const errors = parseErrors(output, type);

  // If command failed but no errors were parsed, surface the failure reason as warning
  // (not error — could be pre-existing build issue unrelated to agent's changes)
  if (!result.success && errors.length === 0) {
    const reason = result.stderr?.includes('timed out')
      ? `Command timed out after ${Math.round(duration / 1000)}s. This build tool may be too slow for verification.`
      : result.stderr?.includes('not in the allowed list') || result.stderr?.includes('not allowed')
        ? `Command '${command}' is not allowed. Check shell.ts ALLOWED_COMMANDS.`
        : result.stderr?.trim() || result.stdout?.trim() || 'Command failed with no output';
    errors.push({ severity: 'warning', message: reason });
  }

  return {
    success: result.success,
    type,
    command: `${command} ${args.join(' ')}`,
    output: output.trim(),
    errors,
    duration,
  };
}

/**
 * Parse errors from command output
 */
function parseErrors(output: string, type: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = output.split('\n');
  
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
    
    // Jest/Vitest: FAIL src/file.test.ts
    const jestFailMatch = line.match(/^\s*FAIL\s+(.+)$/);
    if (jestFailMatch) {
      errors.push({
        file: jestFailMatch[1],
        severity: 'error',
        message: 'Test file failed',
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
    
    // PHP errors: PHP Parse error: ... in /path/file.php on line 10
    const phpMatch = line.match(/PHP\s+(Parse error|Fatal error|Warning):\s*(.+?)\s+in\s+(.+?)\s+on line\s+(\d+)/i);
    if (phpMatch) {
      errors.push({
        file: phpMatch[3],
        line: parseInt(phpMatch[4]),
        severity: phpMatch[1].toLowerCase().includes('warning') ? 'warning' : 'error',
        message: phpMatch[2],
      });
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
  timeout: number = 120000
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
      return {
        success: false,
        type: 'build',
        command: `${scripts.packageManager} run ${scripts.build}`,
        output: 'node_modules not found. Run npm install first.',
        errors: [{ severity: 'error', message: 'node_modules not found. Run npm install first.' }],
        duration: 0,
      };
    }
    command = scripts.packageManager;
    args = ['run', scripts.build];
  }

  return runVerifyCommand('build', command, args, projectRoot, timeout);
}

/**
 * Run test verification
 */
export async function runTestVerification(
  projectRoot: string,
  timeout: number = 120000
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
    command = './vendor/bin/phpunit';
    args = [];
  } else if (scripts.test === '__composer_test__') {
    command = 'composer';
    args = ['run', 'test'];
  } else if (scripts.test === '__artisan_test__') {
    command = 'php';
    args = ['artisan', 'test'];
  } else {
    if (!existsSync(join(projectRoot, 'node_modules'))) {
      return {
        success: false,
        type: 'test',
        command: `${scripts.packageManager} run ${scripts.test}`,
        output: 'node_modules not found. Run npm install first.',
        errors: [{ severity: 'error', message: 'node_modules not found. Run npm install first.' }],
        duration: 0,
      };
    }
    command = scripts.packageManager;
    args = ['run', scripts.test];
  }

  return runVerifyCommand('test', command, args, projectRoot, timeout);
}

/**
 * Run TypeScript type checking
 */
export async function runTypecheckVerification(
  projectRoot: string,
  timeout: number = 60000
): Promise<VerifyResult | null> {
  const scripts = detectProjectScripts(projectRoot);
  
  if (!scripts.typecheck) {
    return null;
  }
  
  let command: string;
  let args: string[];
  
  if (scripts.typecheck === '__tsc_direct__') {
    const localTsc = join(projectRoot, 'node_modules', '.bin', 'tsc');
    if (existsSync(localTsc)) {
      command = localTsc;
      args = ['--noEmit'];
    } else {
      command = 'npx';
      args = ['tsc', '--noEmit'];
    }
  } else if (scripts.typecheck === '__php_lint__') {
    // PHP syntax check on all PHP files
    command = 'find';
    args = ['.', '-name', '*.php', '-not', '-path', './vendor/*', '-exec', 'php', '-l', '{}', ';'];
  } else {
    command = scripts.packageManager;
    args = ['run', scripts.typecheck];
  }
  
  return runVerifyCommand('typecheck', command, args, projectRoot, timeout);
}

/**
 * Run lint verification
 */
export async function runLintVerification(
  projectRoot: string,
  timeout: number = 60000
): Promise<VerifyResult | null> {
  const scripts = detectProjectScripts(projectRoot);
  
  if (!scripts.lint) {
    return null;
  }
  
  const command = scripts.packageManager;
  const args = ['run', scripts.lint];
  
  return runVerifyCommand('lint', command, args, projectRoot, timeout);
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
  if (opts.runTypecheck) parallel.push(runTypecheckVerification(projectRoot, opts.timeout));
  if (opts.runLint) parallel.push(runLintVerification(projectRoot, opts.timeout));

  if (parallel.length > 0) {
    const parallelResults = await Promise.all(parallel);
    for (const r of parallelResults) { if (r) results.push(r); }
  }

  // Run build after typecheck/lint (may depend on them)
  if (opts.runBuild) {
    const result = await runBuildVerification(projectRoot, opts.timeout);
    if (result) results.push(result);
  }

  // Run tests last (slowest, depends on build)
  if (opts.runTest) {
    const result = await runTestVerification(projectRoot, opts.timeout);
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
    const status = result.success ? '✓' : '✗';
    const duration = `${(result.duration / 1000).toFixed(1)}s`;
    
    lines.push(`${status} ${result.type}: ${result.command} (${duration})`);
    
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
  const failedResults = results.filter(r => !r.success);
  
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
 * Check if any verification failed
 */
export function hasVerificationErrors(results: VerifyResult[]): boolean {
  return results.some(r => !r.success);
}

/**
 * Get summary of verification
 */
export function getVerificationSummary(results: VerifyResult[]): {
  passed: number;
  failed: number;
  total: number;
  errors: number;
} {
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const errors = results.reduce((sum, r) => sum + r.errors.filter(e => e.severity === 'error').length, 0);
  
  return {
    passed,
    failed,
    total: results.length,
    errors,
  };
}
