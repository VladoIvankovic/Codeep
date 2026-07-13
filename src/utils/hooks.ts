/**
 * Project-local lifecycle hooks.
 *
 * User drops executable shell scripts in `.codeep/hooks/<event>.sh` and Codeep
 * runs them at the relevant moment during a session. Generalises what the
 * `agentAutoCommit` and `agentAutoVerify` config flags do — anything those
 * can do, a `post_edit` hook can do too, without a code change in the CLI.
 *
 * Supported events:
 *
 *   `pre_tool_call`   — fires before every tool execution. NON-ZERO exit
 *                       BLOCKS the tool call (the agent gets a clear error
 *                       message). Use for policy enforcement: block writes
 *                       to certain paths, refuse risky commands, etc.
 *
 *   `post_edit`       — fires after a successful write_file or edit_file.
 *                       Exit code is ignored (auto-format / auto-lint:
 *                       failure shouldn't block the agent). Receives the
 *                       file path. Use for prettier/eslint/gofmt.
 *
 *   `on_error`        — fires when a tool call returns success=false.
 *                       Exit code ignored. Use for centralised logging
 *                       or alerting.
 *
 *   `pre_commit`      — fires before the /commit skill stages anything.
 *                       NON-ZERO exit BLOCKS the commit. Use for test
 *                       runs, lint gates, etc.
 *
 * Environment variables every hook receives:
 *   CODEEP_HOOK_EVENT     - one of the event names above
 *   CODEEP_WORKSPACE      - workspace root absolute path
 *   CODEEP_SESSION_ID     - current Codeep session id
 *
 * Event-specific extras:
 *   pre_tool_call / on_error:
 *     CODEEP_HOOK_TOOL    - tool name (read_file, write_file, …)
 *     CODEEP_HOOK_PARAMS  - JSON-encoded tool parameters
 *   post_edit:
 *     CODEEP_HOOK_TOOL    - 'write_file' | 'edit_file'
 *     CODEEP_HOOK_FILE    - absolute path of the file that was edited
 *
 * Security note: hooks run arbitrary shell. They are project-scoped — a
 * cloned repo with hostile hooks would execute its scripts on the user's
 * machine the first time they trigger an agent tool call. The welcome
 * banner warns when hooks exist (see `summarizeHooks`); we do not run
 * hooks from `~/.codeep/hooks/` (global) for that reason.
 *
 * Platform note: hooks are POSIX shell (`.sh`) scripts. On macOS/Linux they
 * run directly; on Windows they run through Git Bash's `sh` if installed.
 * Windows without a POSIX shell → hooks are reported `unsupported` and skipped
 * (never blocking). See `resolveShellMode` and the README "Windows notes".
 */

import { existsSync, readdirSync, statSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { config } from '../config/index.js';

// ─── Trust-on-first-use ──────────────────────────────────────────────────────
// Project-local hooks run arbitrary shell, so a freshly-cloned hostile repo
// must NOT execute its scripts on the first tool call. A workspace's hooks run
// only after the user explicitly trusts it (`/hooks trust`); the approval is
// stored per-workspace-root in config. Mirrors VS Code Workspace Trust /
// `direnv allow`.

export function isHooksTrusted(workspaceRoot: string): boolean {
  try {
    const trusted = config.get('trustedHookProjects') as string[] | undefined;
    return Array.isArray(trusted) && trusted.includes(workspaceRoot);
  } catch {
    return false;
  }
}

export function trustWorkspaceHooks(workspaceRoot: string): void {
  const cur = (config.get('trustedHookProjects') as string[] | undefined) ?? [];
  if (!cur.includes(workspaceRoot)) config.set('trustedHookProjects', [...cur, workspaceRoot]);
}

export function untrustWorkspaceHooks(workspaceRoot: string): void {
  const cur = (config.get('trustedHookProjects') as string[] | undefined) ?? [];
  config.set('trustedHookProjects', cur.filter((p) => p !== workspaceRoot));
}

export type HookEvent = 'pre_tool_call' | 'post_edit' | 'on_error' | 'pre_commit';
export const HOOK_EVENTS: readonly HookEvent[] = ['pre_tool_call', 'post_edit', 'on_error', 'pre_commit'];

/** Events whose non-zero exit aborts the action that triggered them. */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set(['pre_tool_call', 'pre_commit']);

export interface HookContext {
  event: HookEvent;
  workspaceRoot: string;
  sessionId?: string;
  /** For pre_tool_call / on_error / post_edit */
  toolName?: string;
  /** For pre_tool_call / on_error */
  toolParams?: Record<string, unknown>;
  /** For post_edit */
  filePath?: string;
}

export interface HookResult {
  /** True if a hook script existed and was actually invoked. */
  executed: boolean;
  /** Exit code, or 0 if no hook was present. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if this hook event blocks downstream work AND the hook failed. */
  blocked: boolean;
  /** Path that was executed (useful for error messages). */
  scriptPath?: string;
  /** True when a hook script exists but the workspace isn't trusted, so it was
   *  skipped (not run). Lets callers surface "run /hooks trust to enable". */
  untrusted?: boolean;
  /** True when a hook script exists but this OS can't run it — Codeep hooks are
   *  POSIX shell (`.sh`) scripts and no `sh` was found (e.g. Windows without
   *  Git Bash). A non-blocking skip; surfaced by `/hooks` + the welcome banner. */
  unsupported?: boolean;
}

const NOT_EXECUTED: HookResult = { executed: false, exitCode: 0, stdout: '', stderr: '', blocked: false };

function getHooksDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.codeep', 'hooks');
}

/**
 * Locate a POSIX shell able to run `.sh` hooks on Windows. `.sh` scripts can't
 * be `spawn`ed directly there (no shebang support), so we invoke them through
 * `sh`/`bash`. Scans PATH plus the default Git-for-Windows install locations.
 * Returns the shell's path, or null if none is installed.
 */
function findWindowsPosixShell(): string | null {
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir) candidates.push(join(dir, 'sh.exe'), join(dir, 'bash.exe'));
  }
  candidates.push(
    'C:\\Program Files\\Git\\bin\\sh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\bin\\sh.exe',
  );
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* next candidate */ }
  }
  return null;
}

/**
 * Decide how a `.sh` hook runs on this platform. On POSIX it's executed
 * directly (shebang); on Windows it needs a `sh`/`bash` interpreter, and if
 * none is installed hooks are `unsupported` (skipped, never blocking). Pure +
 * injectable so the platform matrix is unit-testable.
 */
export function resolveShellMode(
  platform: NodeJS.Platform = process.platform,
  findShell: () => string | null = findWindowsPosixShell,
): { mode: 'direct' } | { mode: 'shell'; shell: string } | { mode: 'unsupported' } {
  if (platform !== 'win32') return { mode: 'direct' };
  const shell = findShell();
  return shell ? { mode: 'shell', shell } : { mode: 'unsupported' };
}

/** True when this OS can actually run `.sh` hooks. Drives the `/hooks` and
 *  welcome-banner "unsupported" state. */
export function hooksExecutable(
  platform: NodeJS.Platform = process.platform,
  findShell: () => string | null = findWindowsPosixShell,
): boolean {
  return resolveShellMode(platform, findShell).mode !== 'unsupported';
}

function findHookScript(workspaceRoot: string, event: HookEvent): string | null {
  const dir = getHooksDir(workspaceRoot);
  if (!existsSync(dir)) return null;
  // Allow `.sh` and bare (no-extension) executable; users sometimes prefer
  // `.codeep/hooks/post_edit` over `post_edit.sh`. Try both.
  for (const name of [`${event}.sh`, event]) {
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      // Must be executable by the current user — otherwise we'd surprise
      // them with a hook that silently does nothing.
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // Not executable or unreadable — try next candidate.
    }
  }
  return null;
}

/**
 * Execute the configured hook for an event, if any. Returns `executed: false`
 * if no script exists. Caller is responsible for checking `blocked` and
 * aborting the parent action when it's true.
 */
export function runHook(ctx: HookContext, opts: { timeoutMs?: number } = {}): HookResult {
  const script = findHookScript(ctx.workspaceRoot, ctx.event);
  if (!script) return NOT_EXECUTED;

  // Trust gate: never run a project's hooks until the user has approved this
  // workspace. A non-blocking skip — the agent proceeds without the hook
  // rather than being held hostage by an untrusted (or hostile) script.
  if (!isHooksTrusted(ctx.workspaceRoot)) {
    return { executed: false, exitCode: 0, stdout: '', stderr: '', blocked: false, untrusted: true, scriptPath: script };
  }

  // Platform gate: a `.sh` hook needs a POSIX shell. On Windows without one we
  // must NOT spawn the script directly — that fails, and for a blocking event
  // (pre_tool_call / pre_commit) a spawn error would wedge every tool call.
  // Skip cleanly instead and let `/hooks` explain why.
  const shellMode = resolveShellMode();
  if (shellMode.mode === 'unsupported') {
    return { executed: false, exitCode: 0, stdout: '', stderr: '', blocked: false, unsupported: true, scriptPath: script };
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CODEEP_HOOK_EVENT: ctx.event,
    CODEEP_WORKSPACE: ctx.workspaceRoot,
  };
  if (ctx.sessionId) env.CODEEP_SESSION_ID = ctx.sessionId;
  if (ctx.toolName) env.CODEEP_HOOK_TOOL = ctx.toolName;
  if (ctx.toolParams) {
    // Cap env var size — most shells choke at ~128KB total env, and a
    // `write_file` with a 100KB content field would single-handedly blow
    // past that. We truncate the serialised JSON instead and append a
    // marker so hook scripts can detect overflow if they care.
    const PARAMS_CAP = 8192;
    let serialized = JSON.stringify(ctx.toolParams);
    if (serialized.length > PARAMS_CAP) {
      serialized = serialized.slice(0, PARAMS_CAP) + '...[truncated]';
    }
    env.CODEEP_HOOK_PARAMS = serialized;
  }
  if (ctx.filePath) env.CODEEP_HOOK_FILE = ctx.filePath;

  // 30s ceiling so a runaway lint / test command can't wedge the agent
  // loop. Configurable per-call so tests can use a tight timeout.
  const timeout = opts.timeoutMs ?? 30_000;
  // POSIX: run the script directly (shebang). Windows-with-shell: invoke it
  // through the located `sh`/`bash` so the shebang isn't required.
  const [cmd, cmdArgs] = shellMode.mode === 'shell' ? [shellMode.shell, [script]] : [script, []];
  let proc;
  try {
    proc = spawnSync(cmd, cmdArgs, {
      cwd: ctx.workspaceRoot,
      env,
      timeout,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Should be rare — spawnSync usually returns a result rather than throwing.
    return {
      executed: true,
      exitCode: 1,
      stdout: '',
      stderr: `hook spawn failed: ${(err as Error).message}`,
      blocked: BLOCKING_EVENTS.has(ctx.event),
      scriptPath: script,
    };
  }

  const exitCode = proc.status ?? (proc.error ? 1 : 0);
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const blocked = BLOCKING_EVENTS.has(ctx.event) && exitCode !== 0;
  return { executed: true, exitCode, stdout, stderr, blocked, scriptPath: script };
}

/**
 * Inspect a workspace and return which hook scripts are installed.
 * Used by the welcome banner and `/hooks` slash command.
 */
export function listInstalledHooks(workspaceRoot: string): { event: HookEvent; scriptPath: string }[] {
  const dir = getHooksDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  // Build a set of which events have a script — try both `<event>.sh` and
  // bare-name forms, mirroring findHookScript.
  const seen = new Set<HookEvent>();
  const out: { event: HookEvent; scriptPath: string }[] = [];
  for (const event of HOOK_EVENTS) {
    for (const candidate of [`${event}.sh`, event]) {
      if (!entries.includes(candidate)) continue;
      const full = join(dir, candidate);
      try {
        if (!statSync(full).isFile()) continue;
        accessSync(full, constants.X_OK);
        if (seen.has(event)) break;
        seen.add(event);
        out.push({ event, scriptPath: full });
        break;
      } catch {
        // Skip unreadable / non-executable.
      }
    }
  }
  return out;
}

/**
 * Render an installed-hook list as Markdown for `/hooks` output.
 */
export function formatHookList(hooks: ReturnType<typeof listInstalledHooks>): string {
  if (hooks.length === 0) {
    return [
      '_No hooks installed in this workspace._',
      '',
      'Drop an executable script in `.codeep/hooks/<event>.sh` to enable one. Supported events:',
      '',
      ...HOOK_EVENTS.map(e => `- \`${e}\`${BLOCKING_EVENTS.has(e) ? '  *(non-zero exit blocks the action)*' : ''}`),
      '',
      'Example — auto-format on save:',
      '',
      '```bash',
      '#!/bin/bash',
      '# .codeep/hooks/post_edit.sh',
      'prettier --write "$CODEEP_HOOK_FILE" 2>/dev/null',
      '```',
    ].join('\n');
  }
  const lines = ['## Installed hooks', ''];
  for (const h of hooks) {
    const tag = BLOCKING_EVENTS.has(h.event) ? ' *(blocking)*' : '';
    lines.push(`- \`${h.event}\`${tag} — \`${h.scriptPath}\``);
  }
  return lines.join('\n');
}

/**
 * Build the trust banner for `/hooks` and the welcome screen. `workspaceRoot`
 * is needed to read trust state; returns '' if no hooks are installed.
 */
export function formatHookTrust(workspaceRoot: string): string {
  const hooks = listInstalledHooks(workspaceRoot);
  if (hooks.length === 0) return '';
  if (!hooksExecutable()) {
    return [
      '⚠️ These hooks **cannot run on this system.** Codeep hooks are POSIX shell',
      '(`.sh`) scripts, and no `sh` was found — on Windows this means Git Bash',
      "isn't installed or isn't on your PATH.",
      '',
      'Install [Git for Windows](https://git-scm.com/download/win) (it provides',
      '`sh.exe`) or add a POSIX shell to PATH. See the “Windows notes” in the README.',
    ].join('\n');
  }
  if (isHooksTrusted(workspaceRoot)) {
    return '✓ This workspace is **trusted** — its hooks will run. Use `/hooks untrust` to revoke.';
  }
  return [
    '⚠️ This workspace is **not trusted**, so its hooks are **skipped** (they run arbitrary shell).',
    'If you wrote these hooks (or trust this repo), run `/hooks trust` to enable them.',
  ].join('\n');
}

/**
 * Short one-line summary used in the welcome banner when hooks are present.
 * Returns empty string if no hooks installed.
 */
export function summarizeHooks(workspaceRoot: string): string {
  const hooks = listInstalledHooks(workspaceRoot);
  if (hooks.length === 0) return '';
  const list = hooks.map(h => h.event).join(', ');
  if (!hooksExecutable()) {
    return `${hooks.length} hook${hooks.length === 1 ? '' : 's'} present but this system has no POSIX shell — they won't run (see README “Windows notes”) (${list})`;
  }
  if (!isHooksTrusted(workspaceRoot)) {
    return `${hooks.length} hook${hooks.length === 1 ? '' : 's'} present but NOT trusted — run /hooks trust to enable (${list})`;
  }
  return `${hooks.length} hook${hooks.length === 1 ? '' : 's'} active (${list})`;
}
