// `codeep hook install|uninstall` — installs a GIT hook (pre-commit / pre-push)
// that runs the offline reviewer on your changes and blocks the commit/push when
// issues at/above the threshold are found. Honors .codeep/review.{yml,json}.
//
// This is a GIT-hook installer — distinct from the lifecycle SHELL hooks in
// utils/hooks.ts (.codeep/hooks/<event>.sh).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { execSync } from 'child_process';
import type { FailOn } from './headlessReview.js';

export type HookType = 'pre-commit' | 'pre-push';
export type HookAction = 'install' | 'uninstall' | 'help';

export interface HookArgs {
  action: HookAction;
  hookType: HookType;
  failOn: FailOn;
  help: boolean;
}

const FAIL_ON_VALUES: readonly FailOn[] = ['error', 'warning', 'info', 'none'];
const MARKER_START = '# >>> codeep hook >>>';
const MARKER_END = '# <<< codeep hook <<<';

export const HOOK_HELP = `Usage: codeep hook <install|uninstall> [options]

Install a git hook that runs \`codeep review\` on your changes, blocking the
commit/push when issues at/above the threshold are found. Honors a project's
.codeep/review.yml (or .json).

Actions:
  install      Install the hook (pre-commit by default)
  uninstall    Remove the Codeep-managed hook

Options:
  --pre-push          Manage the pre-push hook instead of pre-commit
  --fail-on <level>   Severity that blocks: error | warning | info | none (default: error)
  -h, --help          Show this help

The pre-commit hook reviews the working-tree content of staged files, so stage
your changes fully before committing for the most accurate result.
Codeep never overwrites a pre-existing hook it didn't create.`;

/** Parse argv after `hook`. Pure. */
export function parseHookArgs(argv: string[]): HookArgs {
  const out: HookArgs = { action: 'help', hookType: 'pre-commit', failOn: 'error', help: false };
  let i = 0;
  if (argv[0] === 'install' || argv[0] === 'uninstall') {
    out.action = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pre-push') out.hookType = 'pre-push';
    else if (a === '--pre-commit') out.hookType = 'pre-commit';
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--fail-on') {
      const v = argv[++i];
      if (FAIL_ON_VALUES.includes(v as FailOn)) out.failOn = v as FailOn;
    } else if (a.startsWith('--fail-on=')) {
      const v = a.slice('--fail-on='.length);
      if (FAIL_ON_VALUES.includes(v as FailOn)) out.failOn = v as FailOn;
    }
  }
  return out;
}

/** The hook script body. Pure. pre-commit scopes to staged files; pre-push reviews changes. */
export function buildHookScript(hookType: HookType, failOn: FailOn): string {
  const lines = [
    '#!/bin/sh',
    MARKER_START,
    '# Managed by Codeep: `codeep hook install` to update, `codeep hook uninstall` to remove.',
    'command -v codeep >/dev/null 2>&1 || exit 0', // no codeep on PATH → skip, don't block
  ];
  if (hookType === 'pre-commit') {
    // NUL-delimited + xargs -0 so staged paths with spaces/metachars survive as
    // single arguments (an unquoted $files would word-split and silently skip
    // them — a fail-open gate). Temp file keeps it portable: BSD/macOS xargs has
    // no `-r`, so we guard emptiness with `[ -s ]` instead.
    lines.push('tmp=$(mktemp)');
    lines.push('git diff --cached --name-only -z --diff-filter=ACMR > "$tmp"');
    lines.push('if [ -s "$tmp" ]; then');
    lines.push(`  xargs -0 codeep review --fail-on ${failOn} < "$tmp"`);
    lines.push('  status=$?');
    lines.push('else');
    lines.push('  status=0');
    lines.push('fi');
    lines.push('rm -f "$tmp"');
    lines.push('exit $status');
  } else {
    lines.push(`codeep review --fail-on ${failOn}`);
  }
  lines.push(MARKER_END, '');
  return lines.join('\n');
}

/** True when a hook file was created by Codeep (safe to overwrite/remove). */
export function isCodeepHook(content: string): boolean {
  return content.includes(MARKER_START);
}

/** Resolve the git hooks directory (honors worktrees + core.hooksPath). Null if not a repo. */
export function resolveHooksDir(cwd: string): string | null {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore' });
    const hooks = execSync('git rev-parse --git-path hooks', { cwd, encoding: 'utf8' }).trim();
    return isAbsolute(hooks) ? hooks : join(cwd, hooks);
  } catch {
    return null;
  }
}

export interface HookDeps {
  resolveHooksDir: (cwd: string) => string | null;
  readHook: (path: string) => string | null; // null when absent
  writeHook: (path: string, content: string) => void;
  removeHook: (path: string) => void;
  write: (text: string) => void;
}

export function runHookCommand(argv: string[], deps: HookDeps = defaultHookDeps()): number {
  const args = parseHookArgs(argv);
  if (args.help || args.action === 'help') {
    deps.write(HOOK_HELP);
    return 0;
  }
  const hooksDir = deps.resolveHooksDir(process.cwd());
  if (!hooksDir) {
    deps.write('Not a git repository — run `codeep hook` inside a repo.');
    return 1;
  }
  const target = join(hooksDir, args.hookType);
  const existing = deps.readHook(target);

  if (args.action === 'uninstall') {
    if (existing === null) {
      deps.write(`No ${args.hookType} hook to remove.`);
      return 0;
    }
    if (!isCodeepHook(existing)) {
      deps.write(`Refusing to remove ${args.hookType}: it was not created by Codeep.`);
      return 1;
    }
    deps.removeHook(target);
    deps.write(`Removed the Codeep ${args.hookType} hook.`);
    return 0;
  }

  // install
  if (existing !== null && !isCodeepHook(existing)) {
    deps.write(`A ${args.hookType} hook already exists and was not created by Codeep — refusing to overwrite it. Remove it first, or add a \`codeep review\` call manually.`);
    return 1;
  }
  deps.writeHook(target, buildHookScript(args.hookType, args.failOn));
  const when = args.hookType === 'pre-commit' ? 'commit' : 'push';
  deps.write(`Installed the Codeep ${args.hookType} hook → runs \`codeep review --fail-on ${args.failOn}\` on each ${when}.`);
  return 0;
}

function defaultHookDeps(): HookDeps {
  return {
    resolveHooksDir,
    readHook: (p) => {
      try { return readFileSync(p, 'utf8'); } catch { return null; }
    },
    writeHook: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, { mode: 0o755 });
      try { chmodSync(p, 0o755); } catch { /* best effort (e.g. Windows) */ }
    },
    removeHook: (p) => {
      try { rmSync(p); } catch { /* ignore */ }
    },
    write: (t) => process.stdout.write(t + '\n'),
  };
}
