/**
 * Shell command execution utilities with safety checks
 */

import { spawnSync, spawn, SpawnSyncOptions } from 'child_process';
import { resolve, relative, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { assertFetchUrlAllowed } from './ssrfGuard';

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  command: string;
  args: string[];
}

export interface CommandOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  projectRoot?: string; // For path validation
}

// Dangerous command patterns that should never be executed
const BLOCKED_COMMANDS = new Set([
  'sudo',
  'su',
  'chmod',
  'chown',
  'mkfs',
  'fdisk',
  'dd',
  'mount',
  'umount',
  'systemctl',
  'service',
  'shutdown',
  'reboot',
  'init',
  'kill',
  'killall',
  'pkill',
]);

// Dangerous argument patterns
const BLOCKED_PATTERNS = [
  /rm\s+(-[rf]+\s+)*\/(?![\w])/, // rm -rf / (root)
  /rm\s+(-[rf]+\s+)*~/, // rm home directory
  />\s*\/etc\//, // redirect to /etc
  />\s*\/usr\//, // redirect to /usr
  />\s*\/var\//, // redirect to /var
  />\s*\/bin\//, // redirect to /bin
  />\s*\/sbin\//, // redirect to /sbin
  /curl.*\|\s*(ba)?sh/, // curl pipe to shell
  /wget.*\|\s*(ba)?sh/, // wget pipe to shell
  /eval\s+/, // eval command
  /`.*`/, // command substitution in backticks
  /\$\(.*\)/, // command substitution
];

// Allowed commands for agent mode (whitelist approach for extra safety)
const ALLOWED_COMMANDS = new Set([
  // Package managers
  'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'pip', 'pip3', 'poetry', 'pipenv',
  'cargo', 'rustup',
  'go',
  'composer',
  'gem', 'bundle',
  'brew',
  
  // Build tools
  'make', 'cmake', 'gradle', 'mvn',
  'tsc', 'esbuild', 'vite', 'webpack', 'rollup',
  
  // Version control
  'git',
  
  // File operations (safe ones)
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir',
  
  // Node.js
  'node', 'deno',
  
  // Python
  'python', 'python3',
  
  // PHP
  'php', 'composer', 'phpunit', 'artisan',
  
  // Testing
  'jest', 'vitest', 'pytest', 'mocha',
  
  // Linting/Formatting
  'eslint', 'prettier', 'black', 'rustfmt',
  
  // Other common tools
  // NOTE: `env` deliberately NOT whitelisted — it dumps process.env to
  // stdout, which lands in the model's context. Provider API keys ride in
  // env vars, so a single `env` call would exfiltrate every credential the
  // CLI holds. `printenv` is excluded for the same reason. Run these
  // yourself outside the agent if you need environment info.
  'echo', 'pwd', 'which', 'date', 'sleep',
  'curl', 'wget', // allowed but patterns + SSRF-checked
  'tar', 'unzip', 'zip',
  
  // HTTP tools
  'http', 'https',
]);

// Interpreter flags that execute inline code straight from the command line.
// Without this check, a whitelisted runtime (`node`, `python`, …) becomes
// arbitrary code execution — `node -e "<anything>"`, `python -c "<anything>"` —
// bypassing the command whitelist entirely. File execution (`node app.js`)
// stays allowed; only the eval flags are blocked.
const INLINE_EVAL_SHORT: Record<string, string[]> = {
  node: ['e', 'p'], bun: ['e'], python: ['c'], python3: ['c'], php: ['r'], ruby: ['e'], perl: ['e', 'E'],
};
const INLINE_EVAL_LONG: Record<string, string[]> = {
  node: ['--eval', '--print'], deno: ['eval'], bun: ['--eval'],
};

function hasInlineEval(command: string, args: string[]): boolean {
  const short = INLINE_EVAL_SHORT[command] ?? [];
  const long = INLINE_EVAL_LONG[command] ?? [];
  if (short.length === 0 && long.length === 0) return false;
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (long.includes(arg.split('=')[0])) return true;            // --eval / --print(=...)
    } else if (arg.length > 1 && arg.startsWith('-')) {
      if (arg.slice(1).split('').some((l) => short.includes(l))) return true; // -e, -c, -pe …
    } else if (long.includes(arg)) {
      return true;                                                   // bare subcommand, e.g. `deno eval`
    }
  }
  return false;
}

// Commands whose arguments carry URLs that must pass the SSRF guard
// (private/loopback/metadata IP check) before execution. `fetch_url` already
// routes through assertFetchUrlAllowed; without this list the same model-
// controlled URL could just be passed to curl instead.
const URL_CARRYING_COMMANDS = new Set(['curl', 'wget', 'http', 'https']);

// Heuristic: extract URL-looking arguments. curl/wget accept URLs with or
// without a scheme (curl example.com works), and URLs may also ride in
// option values (`--url=…`, `-d @url`, header values like
// `Host: internal.corp`). We normalize scheme-less hosts so the guard sees
// what curl will actually connect to.
function extractUrlCandidates(args: string[]): string[] {
  const urls: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) {
      // Option values: --url=x, --output=y are paths not URLs, but
      // --header="Host: x" can smuggle a host. Keep it simple: only check
      // --url= style options that plausibly carry a URL.
      const m = arg.match(/^--url=(.+)$/i);
      if (m) urls.push(m[1]);
      continue;
    }
    if (/^https?:\/\//i.test(arg)) {
      urls.push(arg);
    } else if (
      // scheme-less host forms curl accepts: literal IPs (with optional
      // port/path), 'localhost', and named hosts (example.com, internal.corp).
      // Anything else (plain filenames, package names) is left alone.
      /^(localhost([\/?#].*)?|\d{1,3}(\.\d{1,3}){3}(:\d+)?([\/?#].*)?|[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([\/?#].*)?)$/i.test(arg)
    ) {
      // scheme-less host or host/path — what curl will connect to
      urls.push(`http://${arg}`);
    }
  }
  return urls;
}

// Exec-escapes: whitelisted utilities that can run ARBITRARY other commands
// as part of their arguments, silently bypassing the whitelist above.
//   find . -exec <anything> \;        → runs <anything>
//   find . -execdir <anything> \;
//   tar --to-command=<anything>       → pipes each extracted file into it
//   xargs <anything>                  → not whitelisted itself, but listed
//                                       here for documentation; see note.
const EXEC_ESCAPE_SHORT: Record<string, string[]> = {
  find: ['-exec', '-execdir', '-ok', '-okdir'],
  tar: ['--to-command'],
};

function hasExecEscape(command: string, args: string[]): boolean {
  const flags = EXEC_ESCAPE_SHORT[command] ?? [];
  if (flags.length === 0) return false;
  return args.some((a) => flags.includes(a) || flags.some((f) => a.startsWith(f + '=')));
}

/**
 * Validate if a command is safe to execute (synchronous checks).
 * See validateCommandAsync for the DNS-resolving SSRF checks.
 */
export function validateCommand(
  command: string,
  args: string[],
  options?: CommandOptions
): { valid: boolean; reason?: string } {
  // Check if command is in blocked list
  if (BLOCKED_COMMANDS.has(command)) {
    return { valid: false, reason: `Command '${command}' is not allowed for security reasons` };
  }
  
  // Check if command is in allowed list (whitelist mode)
  if (!ALLOWED_COMMANDS.has(command)) {
    return { valid: false, reason: `Command '${command}' is not in the allowed list` };
  }

  // Block inline-code execution that would turn a whitelisted interpreter into
  // arbitrary code execution (the whitelist alone doesn't stop `node -e "…"`).
  if (hasInlineEval(command, args)) {
    return { valid: false, reason: `Inline code execution via '${command}' (e.g. -e/-c/--eval) is not allowed in agent mode — put the code in a file and run that, or run it yourself.` };
  }

  // Block whitelisted utilities whose flags spawn OTHER commands — that
  // would bypass the whitelist entirely (find . -exec rm -rf / \;).
  if (hasExecEscape(command, args)) {
    return { valid: false, reason: `'${command}' with exec flags (-exec/-execdir/--to-command…) runs arbitrary commands and is not allowed in agent mode.` };
  }

  // Check full command string against dangerous patterns
  const fullCommand = `${command} ${args.join(' ')}`;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(fullCommand)) {
      return { valid: false, reason: `Command contains blocked pattern: ${pattern}` };
    }
  }
  
  // Validate paths in arguments stay within project
  if (options?.projectRoot) {
    for (const arg of args) {
      // Skip flags
      if (arg.startsWith('-')) continue;
      
      // Check if argument looks like a path
      if (arg.includes('/') || arg.includes('\\')) {
        const absolutePath = isAbsolute(arg) ? arg : resolve(options.cwd || options.projectRoot, arg);
        const relativePath = relative(options.projectRoot, absolutePath);
        
        // Path escapes project root
        if (relativePath.startsWith('..')) {
          return { valid: false, reason: `Path '${arg}' is outside project directory` };
        }
      }
    }
  }
  
  // Special validation for rm command
  if (command === 'rm') {
    const hasRecursive = args.some(a => a.startsWith('-') && a.includes('r'));
    const hasForce = args.some(a => a.startsWith('-') && a.includes('f'));
    
    if (hasRecursive && hasForce) {
      // rm -rf requires extra validation
      const paths = args.filter(a => !a.startsWith('-'));
      if (paths.length === 0) {
        return { valid: false, reason: 'rm -rf without specific paths is not allowed' };
      }
    }
  }
  
  return { valid: true };
}

/**
 * Execute a shell command with safety checks
 */
export function executeCommand(
  command: string,
  args: string[] = [],
  options?: CommandOptions
): CommandResult {
  const startTime = Date.now();
  const cwd = options?.cwd || process.cwd();
  const timeout = options?.timeout || 60000; // Default 1 minute
  
  // Validate command first
  const validation = validateCommand(command, args, options);
  if (!validation.valid) {
    return {
      success: false,
      stdout: '',
      stderr: validation.reason || 'Command validation failed',
      exitCode: -1,
      duration: 0,
      command,
      args,
    };
  }
  
  // Ensure cwd exists
  if (!existsSync(cwd)) {
    return {
      success: false,
      stdout: '',
      stderr: `Working directory does not exist: ${cwd}`,
      exitCode: -1,
      duration: 0,
      command,
      args,
    };
  }
  
  const spawnOptions: SpawnSyncOptions = {
    cwd,
    timeout,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...options?.env,
    },
    maxBuffer: 10 * 1024 * 1024, // 10MB
  };
  
  try {
    const result = spawnSync(command, args, spawnOptions);
    const duration = Date.now() - startTime;
    
    // Handle timeout
    if (result.signal === 'SIGTERM') {
      return {
        success: false,
        stdout: result.stdout?.toString() || '',
        stderr: `Command timed out after ${timeout}ms`,
        exitCode: -1,
        duration,
        command,
        args,
      };
    }
    
    return {
      success: result.status === 0,
      stdout: result.stdout?.toString() || '',
      stderr: result.stderr?.toString() || '',
      exitCode: result.status ?? -1,
      duration,
      command,
      args,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as Error;
    
    return {
      success: false,
      stdout: '',
      stderr: err.message || 'Unknown error executing command',
      exitCode: -1,
      duration,
      command,
      args,
    };
  }
}

/**
 * Async validation: everything in validateCommand plus the DNS-resolving
 * SSRF check for URL-carrying commands (curl/wget/http/https). Split from
 * the sync part because DNS lookups can't block the event loop.
 */
export async function validateCommandAsync(
  command: string,
  args: string[],
  options?: CommandOptions
): Promise<{ valid: boolean; reason?: string }> {
  const sync = validateCommand(command, args, options);
  if (!sync.valid) return sync;

  if (URL_CARRYING_COMMANDS.has(command)) {
    for (const url of extractUrlCandidates(args)) {
      const blocked = await assertFetchUrlAllowed(url);
      if (blocked) {
        return { valid: false, reason: `Blocked URL in ${command} arguments: ${blocked}` };
      }
    }
  }
  return { valid: true };
}

/**
 * Execute a shell command asynchronously (non-blocking)
 */
export function executeCommandAsync(
  command: string,
  args: string[] = [],
  options?: CommandOptions
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const cwd = options?.cwd || process.cwd();
    const timeout = options?.timeout || 60000;

    // Validate command first — async because URL-carrying commands get a
    // DNS-resolving SSRF check (private/loopback/metadata IP guard) that
    // matches the one on the fetch_url tool.
    validateCommandAsync(command, args, options).then((validation) => {
      if (!validation.valid) {
        resolve({
          success: false,
          stdout: '',
          stderr: validation.reason || 'Command validation failed',
          exitCode: -1,
          duration: 0,
          command,
          args,
        });
        return;
      }

      // Ensure cwd exists
      if (!existsSync(cwd)) {
        resolve({
          success: false,
          stdout: '',
          stderr: `Working directory does not exist: ${cwd}`,
          exitCode: -1,
          duration: 0,
          command,
          args,
        });
        return;
      }

      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...options?.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        const duration = Date.now() - startTime;
        resolve({
          success: false,
          stdout,
          stderr: `Command timed out after ${timeout}ms`,
          exitCode: -1,
          duration,
          command,
          args,
        });
      }, timeout);

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code ?? -1,
          duration,
          command,
          args,
        });
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: -1,
          duration,
          command,
          args,
        });
      });
    });
  });
}

/**
 * Execute a command and return only stdout if successful
 */
export function execSimple(
  command: string,
  args: string[] = [],
  options?: CommandOptions
): string | null {
  const result = executeCommand(command, args, options);
  return result.success ? result.stdout.trim() : null;
}

/**
 * Execute a command asynchronously and return only stdout if successful
 */
export async function execSimpleAsync(
  command: string,
  args: string[] = [],
  options?: CommandOptions
): Promise<string | null> {
  const result = await executeCommandAsync(command, args, options);
  return result.success ? result.stdout.trim() : null;
}

/**
 * Check if a command exists in PATH
 */
export function commandExists(command: string): boolean {
  const result = spawnSync('which', [command], { encoding: 'utf-8' });
  return result.status === 0;
}

/**
 * Get list of allowed commands
 */
export function getAllowedCommands(): string[] {
  return Array.from(ALLOWED_COMMANDS).sort();
}

/**
 * Format command result for display
 */
export function formatCommandResult(result: CommandResult): string {
  const status = result.success ? '✓' : '✗';
  const cmd = `${result.command} ${result.args.join(' ')}`.trim();
  
  let output = `${status} ${cmd} (${result.duration}ms, exit ${result.exitCode})`;
  
  if (result.stdout) {
    output += `\n  stdout: ${result.stdout.slice(0, 500)}${result.stdout.length > 500 ? '...' : ''}`;
  }
  
  if (result.stderr && !result.success) {
    output += `\n  stderr: ${result.stderr.slice(0, 500)}${result.stderr.length > 500 ? '...' : ''}`;
  }
  
  return output;
}
