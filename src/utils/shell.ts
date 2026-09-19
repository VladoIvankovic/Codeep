/**
 * Shell command execution utilities with safety checks
 */

import { spawnSync, spawn, SpawnSyncOptions } from 'child_process';
import { resolve, relative, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { isIP } from 'net';
import { assertFetchUrlAllowed, isBlockedIp } from './ssrfGuard';
import { hardenedGitEnv, GitHardeningError } from './git';

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  command: string;
  args: string[];
  /** Set when the command was stopped through `CommandOptions.signal`. */
  cancelled?: boolean;
  /** Set when the command was killed at `CommandOptions.timeout`. Its partial
   *  stdout and stderr are kept; the timeout note follows the stderr. */
  timedOut?: boolean;
}

function timedOutStderr(stderr: string, timeout: number): string {
  const note = `Command timed out after ${timeout}ms`;
  return stderr.trim() ? `${stderr.replace(/\s+$/, '')}\n${note}` : note;
}

export interface CommandOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  projectRoot?: string; // For path validation
  /**
   * Stops the command when it fires: the child is killed and the result
   * comes back at once with `cancelled: true`. Honoured by
   * executeCommandAsync only — the sync runner cannot be interrupted.
   */
  signal?: AbortSignal;
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

// curl options that consume the next argument as their value — generated
// from `curl --help all` (every entry with a <value>), plus the proxy flags
// whose value is shown without brackets. Knowing them is what lets a bare
// number be read as a host: `curl 2130706433:8080` connects to 127.0.0.1,
// while the `30` in `curl -m 30 …` is a timeout.
const CURL_VALUE_OPTIONS = new Set((
  '--abstract-unix-socket --alt-svc --aws-sigv4 --cacert --capath --cert --cert-type --ciphers --config ' +
  '--connect-timeout --connect-to --continue-at --cookie --cookie-jar --create-file-mode --crlfile --curves ' +
  '--data --data-ascii --data-binary --data-raw --data-urlencode --delegation --dns-interface --dns-ipv4-addr ' +
  '--dns-ipv6-addr --dns-servers --doh-url --dump-header --egd-file --engine --etag-compare --etag-save ' +
  '--expect100-timeout --form --form-string --ftp-account --ftp-alternative-to-user --ftp-method --ftp-port ' +
  '--ftp-ssl-ccc-mode --happy-eyeballs-timeout-ms --haproxy-clientip --header --hostpubmd5 --hostpubsha256 ' +
  '--hsts --interface --ipfs-gateway --json --keepalive-time --key --key-type --krb --libcurl --limit-rate ' +
  '--local-port --login-options --mail-auth --mail-from --mail-rcpt --max-filesize --max-redirs --max-time ' +
  '--netrc-file --noproxy --oauth2-bearer --output --output-dir --parallel-max --pass --pinnedpubkey --proto ' +
  '--proto-default --proto-redir --proxy-cacert --proxy-capath --proxy-cert --proxy-cert-type --proxy-ciphers ' +
  '--proxy-crlfile --proxy-header --proxy-key --proxy-key-type --proxy-pass --proxy-pinnedpubkey ' +
  '--proxy-service-name --proxy-tls13-ciphers --proxy-tlsauthtype --proxy-tlspassword --proxy-tlsuser ' +
  '--proxy-user --proxy1.0 --pubkey --quote --random-file --range --rate --referer --request --request-target ' +
  '--resolve --retry --retry-delay --retry-max-time --sasl-authzid --service-name --socks4 --socks4a --socks5 ' +
  '--socks5-gssapi-service --socks5-hostname --speed-limit --speed-time --stderr --telnet-option --tftp-blksize ' +
  '--time-cond --tls-max --tls13-ciphers --tlsauthtype --tlspassword --tlsuser --trace --trace-ascii ' +
  '--trace-config --unix-socket --upload-file --url --url-query --user --user-agent --variable --write-out ' +
  '--proxy --preproxy'
).split(' '));
const CURL_VALUE_SHORT = new Set('ACDEFHKPQTUXYbcdemortuwxyz'.split(''));
// wget spells most values `--opt=value`; these are the ones commonly split.
const WGET_VALUE_OPTIONS = new Set(['-O', '-o', '-a', '-t', '-T', '-w', '-e', '-P', '-U', '-Q', '-l', '-A', '-R', '-D', '-X', '-I', '-i', '-B',
  '--output-document', '--output-file', '--tries', '--timeout', '--wait', '--execute', '--directory-prefix',
  '--user-agent', '--header', '--user', '--password', '--input-file', '--base', '--limit-rate', '--max-redirect']);

/** True when `arg` (an option) makes the NEXT argument its value. */
function optionTakesNextArg(command: string, arg: string): boolean {
  if (arg.includes('=')) return false;
  if (command === 'curl') {
    if (arg.startsWith('--')) return CURL_VALUE_OPTIONS.has(arg);
    // Short cluster: `-sm 30` — only the last letter may take the next arg;
    // an earlier value-taking letter swallows the rest of the cluster (`-m30`).
    for (let i = 1; i < arg.length; i++) {
      if (CURL_VALUE_SHORT.has(arg[i])) return i === arg.length - 1;
    }
    return false;
  }
  if (command === 'wget') return WGET_VALUE_OPTIONS.has(arg);
  return false;
}

const PORT_PATH = String.raw`(:\d+)?([\/?#].*)?`;
// Scheme-less host forms the tools accept: localhost, dotted/bracketed IP
// literals, named hosts, and the numeric spellings libc resolves —
// `2130706433`, `0x7f000001`, `017700000001`, `0` are all 127.0.0.1/0.0.0.0.
const SCHEMELESS_HOST = new RegExp(
  '^(' + [
    `localhost${PORT_PATH}`,
    String.raw`\[[0-9a-f:.%]+\]` + PORT_PATH,
    String.raw`(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}` + PORT_PATH,
    String.raw`[a-z0-9-]+(\.[a-z0-9-]+)+` + PORT_PATH,
    String.raw`[a-z0-9-]+:\d+([\/?#].*)?`,
  ].join('|') + ')$',
  'i',
);

// Heuristic: extract URL-looking arguments. curl/wget accept URLs with or
// without a scheme (curl example.com works), and URLs may also ride in
// option values (`--url …`). Scheme-less hosts are normalized so the guard
// sees what the tool will actually connect to; option values are skipped so
// a timeout or a data payload isn't mistaken for a host.
function extractUrlCandidates(command: string, args: string[]): string[] {
  const urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-') && arg.length > 1) {
      const eq = arg.match(/^--url=(.+)$/i);
      if (eq) { urls.push(eq[1]); continue; }
      if (optionTakesNextArg(command, arg)) {
        if (arg === '--url' && args[i + 1]) urls.push(args[i + 1]);
        i++; // the value is not a positional URL
      }
      continue;
    }
    if (/^https?:\/\//i.test(arg)) {
      urls.push(arg);
    } else if ((command === 'http' || command === 'https') && /^:\d*([\/?#].*)?$/.test(arg)) {
      // httpie shorthand: `http :3000/api` is localhost:3000
      urls.push(`http://localhost${arg}`);
    } else if (SCHEMELESS_HOST.test(arg)) {
      urls.push(`http://${arg}`);
    }
  }
  return urls;
}

// curl options that change WHERE the connection goes without changing the
// URL the guard looks at: `--resolve example.com:80:127.0.0.1 http://example.com`
// passes a URL-only check and then talks to loopback. Each one is judged by
// the address it actually points curl at.
const CURL_TARGET_FLAGS = new Set(['--resolve', '--connect-to', '--unix-socket', '--abstract-unix-socket', '-x', '--proxy', '--preproxy', '--socks4', '--socks4a', '--socks5', '--socks5-hostname']);

function curlTargetOverrides(args: string[]): { flag: string; value: string }[] {
  const out: { flag: string; value: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1 && CURL_TARGET_FLAGS.has(arg.slice(0, eq))) {
      out.push({ flag: arg.slice(0, eq), value: arg.slice(eq + 1) });
    } else if (CURL_TARGET_FLAGS.has(arg)) {
      out.push({ flag: arg, value: args[i + 1] ?? '' });
      i++;
    } else if (/^-x./.test(arg)) {
      out.push({ flag: '-x', value: arg.slice(2) });
    }
  }
  return out;
}

async function curlTargetOverrideProblem(args: string[]): Promise<string | null> {
  for (const { flag, value } of curlTargetOverrides(args)) {
    if (flag === '--unix-socket' || flag === '--abstract-unix-socket') {
      return `${flag} is not allowed — it bypasses the network address check`;
    }
    if (flag === '--resolve') {
      // [+]host:port:addr[,addr]… — every address must be public.
      const addrs = value.replace(/^\+/, '').split(':').slice(2).join(':');
      for (const addr of addrs.split(',')) {
        if (!addr || isBlockedIp(addr)) return `--resolve points at a private/internal address (${addr || 'empty'})`;
        if (!isIP(addr.replace(/^\[|\]$/g, ''))) return `--resolve needs a numeric address (got ${addr})`;
      }
      continue;
    }
    let target: string;
    if (flag === '--connect-to') {
      // HOST1:PORT1:HOST2:PORT2 — an empty HOST2 keeps the URL's host.
      const m = value.match(/^(\[[^\]]*\]|[^:]*):[^:]*:(\[[^\]]*\]|[^:]*)(?::.*)?$/);
      if (!m) return `--connect-to value not understood: ${value}`;
      if (!m[2]) continue;
      target = `http://${m[2]}/`;
    } else {
      // Proxy flags: judge the proxy host. Any scheme is rewritten to http so
      // the guard parses the host the same way for socks5:// and friends.
      target = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value.replace(/^[a-z][a-z0-9+.-]*:/i, 'http:') : `http://${value}`;
    }
    const blocked = await assertFetchUrlAllowed(target);
    if (blocked) return `${flag} ${blocked}`;
  }
  return null;
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

// ─── git argv ────────────────────────────────────────────────────────────────

/**
 * git's own options, before the subcommand, that take a separate argument.
 * Needed so the subcommand is found at the right place: in
 * `git -c user.name=x config`, the `config` is the subcommand, and in
 * `git -C sub status` the `sub` is not.
 */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source']);

/**
 * git options that move the call somewhere hardenedGitEnv() did not look, or
 * feed it config from a place the caller cannot see. Refused rather than
 * resolved.
 *
 * `--git-dir` / `--work-tree` point git at another repository's config, which
 * is the one this process never scanned. `--exec-path` makes git load its own
 * subcommands from a directory of the caller's choosing — that is code
 * execution outright, not a config question. `--config-env` names an
 * ENVIRONMENT VARIABLE to read a config value from, so the value that decides
 * whether git runs a program is not in the command the user approved.
 *
 * `-C` is NOT here: it only moves the working directory, so the scan can
 * simply follow it — see gitEffectiveCwd(). `-c` is not here either, and that
 * is a deliberate, narrower judgement: `git -c core.pager=/tmp/x log` does
 * name a program, but it names it IN THE COMMAND, where the user reading the
 * approval prompt sees it, and the agent could equally have run `/tmp/x`
 * directly. `--config-env` is the same power with the value hidden, which is
 * why only that one is refused — and why `-c include.path` is refused too,
 * by GIT_CONFIG_INCLUDE_KEYS below.
 */
const GIT_REDIRECTING_OPTIONS = new Set(['--git-dir', '--work-tree', '--exec-path', '--config-env']);

/**
 * The `-c` keys that make the argument the user approved stop describing what
 * git will do.
 *
 * The whole case for allowing `-c` is that the value is IN THE COMMAND, so
 * the approval prompt shows it. `git -c include.path=<file> status` breaks
 * that: git reads every key in that file — `core.fsmonitor`, a
 * `filter.<d>.clean`, an alias — and the prompt showed a path, not a program.
 * Same power as `--config-env` with the value hidden somewhere else, so it
 * gets the same answer. `includeIf.<condition>.path` is the conditional
 * spelling of the identical thing.
 *
 * Case-insensitive because git's own key lookup is: `-c INCLUDE.PATH=<file>`
 * pulls the file in exactly as the lower-case spelling does (verified, git
 * 2.54), so a case-sensitive test here would be no test at all.
 */
const GIT_CONFIG_INCLUDE_KEYS = /^(include\.path|includeif\..*\.path)$/i;

/**
 * `git config` flags that write somewhere the repo-scope scan deliberately
 * TRUSTS. The scan leaves global and system scope alone so that git-lfs,
 * commit signing and `git push` keep working — which means an agent that can
 * run `git config --global core.pager /tmp/x` has moved its own program into
 * the trusted scope, and the next Codeep git call runs it. Proven with git
 * 2.54 through GIT_CONFIG_GLOBAL.
 *
 * `--file` is the same move against any file the user's config includes;
 * `--config-env` is caught by GIT_REDIRECTING_OPTIONS already and is listed
 * here so the reason a `git config` line was refused is the right one.
 */
const GIT_CONFIG_ESCALATING_FLAGS = new Set(['--global', '--system', '--file', '-f', '--config-env']);

/** The flag part of `--name=value`, or the argument itself. */
function flagName(arg: string): string {
  const eq = arg.indexOf('=');
  return eq === -1 ? arg : arg.slice(0, eq);
}

/**
 * Walk git's global options and report where the subcommand starts. Returns
 * the refusal reason instead when an option redirects the call.
 */
function scanGitArgv(args: string[]): { problem: string } | { subcommandAt: number; chdirs: string[] } {
  const chdirs: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    const name = flagName(arg);
    if (GIT_REDIRECTING_OPTIONS.has(name)) {
      return {
        problem:
          `'git ${name}' points git at a repository or a program this process has not checked, ` +
          'and is not allowed in agent mode. Run git in that directory instead (git -C <dir> …), ' +
          'or run the command yourself.',
      };
    }
    if (arg === '-C') {
      // git rejects `-C<path>` and `-C=<path>`, so the value is always the
      // next argument (verified, git 2.54).
      chdirs.push(args[++i] ?? '');
      continue;
    }
    if (name === '-c' || name === '--config') {
      // git rejects `-ccore.pager=cat` outright ("unknown option"), so a
      // `-c` always takes the NEXT argument (verified, git 2.54). `--config`
      // is not a git option today; it is read here so that the key is
      // checked rather than skipped if that ever changes.
      const pair = arg === name ? (args[++i] ?? '') : arg.slice(name.length + 1);
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (GIT_CONFIG_INCLUDE_KEYS.test(key)) {
        return {
          problem:
            `'git ${name} ${key}=…' pulls in a whole config file, and every key in that file — a ` +
            '`core.fsmonitor`, a `filter.<driver>.clean`, an alias — is a program git may run without ' +
            'the approval prompt ever showing it. That is the same hole as `--config-env`, so it gets ' +
            'the same answer. Set the keys you need with their own -c, or run the command yourself.',
        };
      }
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) i++; // value, not the subcommand
  }
  return { subcommandAt: i, chdirs };
}

/**
 * Why this `git` command may not run, or null.
 *
 * Two different holes, both on the execute_command path: an argv that aims
 * git at a repository hardenedGitEnv() never scanned, and a `git config`
 * that writes into the scope the scan trusts. See the two sets above.
 */
function gitArgvProblem(args: string[]): string | null {
  const scan = scanGitArgv(args);
  if ('problem' in scan) return scan.problem;

  if (args[scan.subcommandAt] !== 'config') return null;
  for (const arg of args.slice(scan.subcommandAt + 1)) {
    const name = flagName(arg);
    if (!GIT_CONFIG_ESCALATING_FLAGS.has(name)) continue;
    return (
      `'git config ${name}' writes the git config outside this repository, which Codeep's hardening ` +
      'deliberately trusts — a program named there runs on the next git call. Change it yourself if ' +
      'you meant to, or use `git config --local` for this repository.'
    );
  }
  return null;
}

/**
 * The directory whose config decides what this `git` call can run.
 *
 * `-C` moves git before it reads any repository config, so hardening the
 * spawn's `cwd` hardens the wrong repository: `git -C vendor/lib status` in a
 * project whose own config is spotless ran the vendored checkout's
 * `core.fsmonitor` AND its `filter.h.clean` (proven, git 2.54). Successive
 * `-C` are relative to each other, exactly as git resolves them.
 */
function gitEffectiveCwd(args: string[], cwd: string): string {
  const scan = scanGitArgv(args);
  if ('problem' in scan) return cwd; // refused before it ever reaches a spawn
  return scan.chdirs.reduce((dir, next) => (next ? resolve(dir, next) : dir), cwd);
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

  // git's own argv can move the call out from under the hardening, or move a
  // program INTO the scope the hardening trusts. See gitArgvProblem().
  if (command === 'git') {
    const problem = gitArgvProblem(args);
    if (problem) return { valid: false, reason: problem };
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
 * The environment a validated command runs in.
 *
 * `git` is on ALLOWED_COMMANDS, so a skill's shell line, a `!` command or the
 * agent's own execute_command reaches git with whatever the repository put in
 * its `.git/config` — and several of those settings make git RUN a program:
 * a `filter.<driver>.clean` fires during the index refresh `git status` does,
 * before anything looks like it executed code. Route git through the same
 * hardening Codeep's own git calls use.
 *
 * Hooks are deliberately left alone here. The command was approved as
 * written, so `git commit` through this path runs the repository's
 * pre-commit hook exactly as it would in the user's terminal.
 *
 * A caller's own `env` goes in as the BASE rather than on top of the result:
 * spread afterwards, their GIT_CONFIG_COUNT would replace ours and silently
 * drop every override above their count.
 *
 * The bare name is the whole test because it has to be: validateCommand()
 * only lets a command through when ALLOWED_COMMANDS holds it, and that set
 * holds `git`, not `/usr/bin/git`. A path-spelled git never reaches here.
 *
 * The directory scanned comes from the ARGV, not from the spawn's cwd: `git
 * -C vendor/lib status` reads the vendored checkout's config, so that is the
 * config that has to be neutralised. The argv forms that redirect git
 * somewhere this cannot follow (`--git-dir`, `--work-tree`, `--exec-path`,
 * `--config-env`) never get here — validateCommand() refuses them.
 *
 * Throws `GitHardeningError` when the repository's config cannot be scanned —
 * both runners below turn that into a failed CommandResult, because a refusal
 * is this command's own failure and the user reads it as such.
 */
function commandEnv(command: string, args: string[], cwd: string, options?: CommandOptions): NodeJS.ProcessEnv {
  const base = { ...process.env, ...options?.env };
  return command === 'git' ? hardenedGitEnv({ cwd: gitEffectiveCwd(args, cwd), base }) : base;
}

/**
 * `git` as a whole word anywhere in a command line. Deliberately loose:
 * hardening a line that never runs git costs one `git config --list`, while
 * missing one that does is the hole this closes. It does not see a git that
 * runs from inside a script the line calls (`npm test`) — the same limit
 * commandEnv() has, for the same reason.
 */
const SHELL_LINE_MENTIONS_GIT = /(^|\W)git(\W|$)/;

/**
 * The environment for a whole SHELL COMMAND LINE that may reach git.
 *
 * commandEnv() above can check a parsed binary name; a line handed to a shell
 * can reach git from anywhere inside it — `cd sub && git status`, `make && git
 * commit`, `foo | git apply` — so it needs its own entry point. This is that
 * entry point for the callers that spawn with `shell: true`: the skill runner
 * in src/acp/commands.ts and the one in src/renderer/agentExecution.ts, both
 * of which used to reach git raw. A hostile `gpg.program` that createCommit
 * neutralises still executed through those two spawns (proven, git 2.54).
 *
 * This is the ONE helper for that job — an earlier cut of this hotfix also
 * had a `hardenedShellEnv()` in utils/toolExecution.ts, which hardened every
 * skill step unconditionally and therefore refused an `echo` in a repository
 * whose config cannot be scanned. Keep it one: two helpers with two different
 * answers to "does a refusal stop this line?" is how one of them ends up
 * wrong and unused.
 *
 * The contract, since those two call sites are not this file's to edit:
 *
 * - Pass the command line, the cwd the shell will get and any env of your
 *   own, and hand the RESULT to the spawn as `env`. Do not spread anything
 *   over it — a later `GIT_CONFIG_COUNT` replaces ours and silently drops
 *   every override above it.
 * - It THROWS `GitHardeningError` when the repository's config cannot be
 *   scanned, or names a program no override can switch off. Catch it and fail
 *   the command with `error.message`, which is written for the user. Letting
 *   it escape a `spawnSync` call site turns a refusal into a crash; letting
 *   it escape inside a promise executor leaves the caller hanging.
 * - Hooks are left alone, as they are for executeCommand(): the line was
 *   approved as written, so `git commit` in it runs the repository's
 *   pre-commit hook exactly as it would in the user's terminal.
 * - A line that cannot reach git comes back unhardened, so a repository with
 *   an unreadable config does not also break `echo`. That is also why a
 *   refusal never reaches a non-git line: an `echo` must not stop working
 *   because some repository in the project sets `remote.origin.uploadpack`.
 *
 * WHAT THIS CAN AND CANNOT PROMISE, because a shell line is not an argv:
 *
 * - Scanned: the repository at `cwd`, AND every initialised submodule of it,
 *   whose config lives in `.git/modules/<name>/config` (see
 *   listSubmoduleConfig in utils/git.ts). Every key in REPO_EXECUTING_RULES
 *   that any of them sets is neutralised, and because the overrides ride in
 *   the ENVIRONMENT rather than in an argv, they apply wherever in the line
 *   git ends up — so `cd vendor/lib && git add` is covered in full when
 *   `vendor/lib` is a submodule, which is the shape a skill step usually has.
 * - Not scanned: a repository that is not `cwd` and not one of its
 *   submodules — an independent checkout under `vendor/`, a sibling clone,
 *   anywhere a `make` target cds to. There is no way to know where a shell
 *   line ends up without running it, so this does not pretend to. What still
 *   covers those is the always-on GIT_EXECUTING_CONFIG layer, which is why
 *   `core.fsmonitor` is blanket there rather than scope-aware. The gap is the
 *   keys GIT_CONFIG_* cannot wildcard — `filter.*` above all — in an
 *   unrelated repository below the one scanned. Proven with git 2.54: `cd
 *   vendor/lib && git status`, with `vendor/lib` a plain nested clone rather
 *   than a submodule, did not run the nested `core.fsmonitor` and did run the
 *   nested `filter.<d>.clean`.
 * - executeCommand()'s argv path has no such gap: it reads `-C` out of the
 *   argv and scans where git will actually run, and refuses `--git-dir` /
 *   `--work-tree` / `--exec-path` / `--config-env` outright.
 */
export function shellCommandEnv(
  commandLine: string,
  cwd: string,
  env?: Record<string, string>
): NodeJS.ProcessEnv {
  const base = { ...process.env, ...env };
  return SHELL_LINE_MENTIONS_GIT.test(commandLine) ? hardenedGitEnv({ cwd, base }) : base;
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
  
  // Built here rather than inline in spawnOptions below: a refusal from
  // hardenedGitEnv() is this command's own failure and has to read as one,
  // not as an exception out of a function whose whole contract is to report
  // failures in its result.
  let env: NodeJS.ProcessEnv;
  try {
    env = commandEnv(command, args, cwd, options);
  } catch (error) {
    return {
      success: false,
      stdout: '',
      stderr: error instanceof GitHardeningError ? error.message : String(error),
      exitCode: -1,
      duration: Date.now() - startTime,
      command,
      args,
    };
  }

  const spawnOptions: SpawnSyncOptions = {
    cwd,
    timeout,
    encoding: 'utf-8',
    env,
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
        stderr: timedOutStderr(result.stderr?.toString() || '', timeout),
        exitCode: -1,
        duration,
        command,
        args,
        timedOut: true,
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
    if (command === 'curl') {
      const problem = await curlTargetOverrideProblem(args);
      if (problem) return { valid: false, reason: `Blocked curl option: ${problem}` };
    }
    for (const url of extractUrlCandidates(command, args)) {
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

      // Cancelled while the checks above ran: never start the process.
      const signal = options?.signal;
      if (signal?.aborted) {
        resolve({
          success: false,
          stdout: '',
          stderr: 'Command cancelled',
          exitCode: -1,
          duration: Date.now() - startTime,
          command,
          args,
          cancelled: true,
        });
        return;
      }

      // Caught rather than thrown: this runs inside the promise executor, so
      // a refusal from hardenedGitEnv() would reject a promise nobody holds
      // and leave the caller waiting forever.
      let env: NodeJS.ProcessEnv;
      try {
        env = commandEnv(command, args, cwd, options);
      } catch (error) {
        resolve({
          success: false,
          stdout: '',
          stderr: error instanceof GitHardeningError ? error.message : String(error),
          exitCode: -1,
          duration: Date.now() - startTime,
          command,
          args,
        });
        return;
      }

      const child = spawn(command, args, {
        cwd,
        env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      let settled = false;

      // A caller's signal usually belongs to a whole prompt and outlives
      // many commands, so the listener comes off as soon as this one ends.
      const finish = (result: Omit<CommandResult, 'duration' | 'command' | 'args'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ ...result, duration: Date.now() - startTime, command, args });
      };

      // Settle before killing: kill() can emit 'error' synchronously, and
      // that must not replace the verdict.
      const onAbort = () => {
        if (settled) return;
        finish({ success: false, stdout, stderr: 'Command cancelled', exitCode: -1, cancelled: true });
        child.kill('SIGTERM');
        // A child that ignores SIGTERM must not keep running after the
        // caller was told it stopped.
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2000);
        force.unref();
        child.once('exit', () => clearTimeout(force));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        // Keep what the command printed: a test runner reports its failures on
        // stderr before it hangs, and a check needs them.
        finish({ success: false, stdout, stderr: timedOutStderr(stderr, timeout), exitCode: -1, timedOut: true });
        child.kill('SIGTERM');
      }, timeout);

      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code: number | null) => {
        finish({ success: code === 0, stdout, stderr, exitCode: code ?? -1 });
      });

      child.on('error', (err: Error) => {
        finish({ success: false, stdout: '', stderr: err.message, exitCode: -1 });
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
