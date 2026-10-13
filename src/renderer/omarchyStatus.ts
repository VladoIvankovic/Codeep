/**
 * Codeep's live state, for desktop integrations on Omarchy.
 *
 * A plugin in Omarchy's bar (a widget that dims when no Codeep runs and calls
 * for you when one waits) has no way to ask Codeep what it is doing, and
 * should not have: nothing of Codeep listens. So each Codeep process says it
 * itself, in one small file it owns while it runs:
 *
 *   $XDG_STATE_HOME/codeep/sessions/<pid>.json     (default ~/.local/state)
 *
 *   {"schemaVersion":1,"pid":1234,"kind":"tui","startedAt":"…","updatedAt":"…",
 *    "cwd":"/home/u/Work/x","project":"x","state":"idle","task":null,
 *    "provider":"z.ai","model":"glm-5.3"}
 *
 * `state` is idle, working, approval (a dialog waits for you) or question (a
 * clarifying question does); `task` is the run's short label while it is
 * anything but idle, cleaned as a toast's is (desktopNotify.ts noticeLabel);
 * `kind` is `tui` or `acp`. Counts and names, never prompt text, an answer or
 * a command line — only the working directory and its name are paths, and
 * they are Codeep's own.
 *
 * The file is replaced whole — written to `.<pid>.<random>.tmp`, which a
 * reader scanning for `*.json` never lists, and renamed over `<pid>.json` — at
 * 0600 in a 0700 directory, and at most once a second: a run that asks six
 * questions in a breath is one write with the last of them, not six. It is
 * removed when the process ends — on 'exit', and on the SIGHUP (the terminal
 * window closed, how a TUI usually ends on Hyprland) or SIGTERM that the config
 * store's exit hook (when-exit) takes and re-raises without an 'exit' event:
 * the removal is also registered in when-exit's own callback list, which runs
 * before the signal is raised again and adds no listener of ours, so how the
 * process ends does not change. A process that is killed (SIGKILL) or crashes
 * leaves its file behind; a reader treats a file whose pid is not alive as
 * stale, and the next Codeep to start removes it.
 *
 * Omarchy only, and only with the setting on (`omarchyLiveStatus`), decided at
 * every write like the Agents panel record (omarchyAgents.ts): anywhere else
 * nothing is written, and switching it off takes this process's file away at
 * once.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import whenExit from 'when-exit';
import { logger } from '../utils/logger';
import { noticeLabel, plainText } from '../utils/desktopNotify';
import { isOmarchy } from './omarchyTheme';

// Debug logging helper - writes to log file when CODEEP_DEBUG=1
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

export type LiveState = 'idle' | 'working' | 'approval' | 'question';
export type LiveKind = 'tui' | 'acp';

/**
 * `$XDG_STATE_HOME/codeep/sessions`, or `~/.local/state/…` when it is unset,
 * empty or not an absolute path — the XDG Base Directory specification says a
 * relative value is invalid and must be ignored. Used as given, it would put a
 * `state/` folder in whatever directory Codeep was started in: the project.
 */
export function omarchyStatusDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const base = env.XDG_STATE_HOME;
  return join(base && isAbsolute(base) ? base : join(home, '.local', 'state'), 'codeep', 'sessions');
}

/** Linux's USER_HZ: what the start times in /proc/<pid>/stat are counted in. Fixed by the ABI. */
const CLOCK_TICKS_PER_SECOND = 100;

/** How far apart a process's start and its file's `startedAt` may be before the pid is a different process's. */
const START_SLACK_MS = 2000;

const OWN_MODE = 0o600;
const DIR_MODE = 0o700;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there, and not ours to signal. Only ESRCH says it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The command line of process `pid` from /proc (NULs as spaces); null where it cannot be read. */
function processCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
}

/** When process `pid` started, in ms since the epoch, from /proc; null where that cannot be told. */
function processStartedAt(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 22 of the line, which is the 20th after the `(name)` that may
    // itself hold spaces.
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    if (!Number.isFinite(ticks) || !boot) return null;
    return (Number(boot[1]) + ticks / CLOCK_TICKS_PER_SECOND) * 1000;
  } catch {
    return null;
  }
}

export interface StaleCleanupDeps {
  /** This process: its own file is never "stale". */
  pid: number;
  isAlive: (pid: number) => boolean;
  /** When a process started, or null when unknown. */
  startedAtOf: (pid: number) => number | null;
  /** A process's command line, or null when unknown. Without it a live pid's
   *  file is never taken for a reused pid's. */
  cmdlineOf?: (pid: number) => string | null;
}

/**
 * Remove the files of processes that are gone — and only those: a file whose
 * pid is alive is another Codeep's, or something else's that happens to share
 * the directory, and stays. A pid that is alive but started after the file
 * says its owner did is a different process that was handed the number; the
 * file is stale all the same — when that process is also plainly not a Codeep.
 * The start is measured against the wall clock the file was written under, and
 * a clock that was stepped since (NTP after an offline boot) makes a live
 * Codeep look newer than its own file: its command line decides, and where that
 * cannot be read the file stays. Where the start cannot be read, "alive" is all
 * there is. Only regular files, by their names; a symlink is never followed.
 * Returns how many it removed. Never throws.
 */
export function removeStaleStatusFiles(dir: string, deps: StaleCleanupDeps): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const status = /^(\d+)\.json$/.exec(name);
    // What a write that was cut short leaves: see write() below.
    const leftover = /^\.(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name);
    const match = status ?? leftover;
    if (!match) continue;
    const owner = Number(match[1]);
    if (!Number.isSafeInteger(owner) || owner <= 0 || owner === deps.pid) continue;
    const file = join(dir, name);
    try {
      if (deps.isAlive(owner) && !(status && wasReused(file, owner, deps))) continue;
      if (!lstatSync(file).isFile()) continue;
      unlinkSync(file);
      removed++;
    } catch (error) {
      debug('Omarchy status: could not look at', name, error);
    }
  }
  return removed;
}

/** Whether `file`'s pid is now another process: one that started after the file was begun. */
function wasReused(file: string, pid: number, deps: StaleCleanupDeps): boolean {
  try {
    const startedAt = Date.parse(String((JSON.parse(readFileSync(file, 'utf8')) as { startedAt?: unknown }).startedAt));
    const processStarted = deps.startedAtOf(pid);
    if (!Number.isFinite(startedAt) || processStarted === null || processStarted <= startedAt + START_SLACK_MS) return false;
    // Late by more than the slack: another process's, or a Codeep whose clock
    // moved. Only a process that is plainly something else is not this file's.
    const cmdline = deps.cmdlineOf?.(pid) ?? null;
    return cmdline !== null && !/codeep/i.test(cmdline);
  } catch {
    return false;
  }
}

export interface LiveStatusOptions {
  kind: LiveKind;
  /** Whether the file should exist now — the /settings switch. Asked at every
   *  write; a write that finds it off takes the file away. Default: always. */
  enabled?: () => boolean;
  /** Where Codeep is working and with what; read at every write, since the
   *  provider and the model change under /provider and /model. */
  info?: () => { cwd?: string; provider?: string; model?: string };
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Omarchy's theme state directory, which says this is Omarchy at all. */
  stateDir?: string;
  /** Where the file goes. Defaults to omarchyStatusDir(). */
  dir?: string;
  /** Defaults to this process. */
  pid?: number;
  /** The least time between two writes. Default one second. */
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
  startedAtOf?: (pid: number) => number | null;
  cmdlineOf?: (pid: number) => string | null;
}

export interface LiveStatusHandle {
  /**
   * Say what Codeep is doing. `onlyFrom` makes it conditional: nothing
   * happens unless the state is that one now — what ends an approval's wait
   * must not put "working" over a run that has ended since.
   */
  set(state: LiveState, task: string | null, extra?: { onlyFrom?: LiveState; cwd?: string }): void;
  /** The /settings switch: off removes the file now, on writes it. */
  apply(on: boolean): void;
  /** Write now if a write is waiting. */
  flush(): void;
  /** Remove the file and stop. */
  stop(): void;
  /** What the file would say, for a caller that wants to know. */
  current(): { state: LiveState; task: string | null };
}

/** The running one. One per process. */
let active: LiveStatusHandle | null = null;

/**
 * Start keeping this process's file. Returns null — doing nothing at all —
 * anywhere but Omarchy. The first write removes the files of processes that
 * are gone and then says `idle`.
 */
export function startOmarchyLiveStatus(options: LiveStatusOptions): LiveStatusHandle | null {
  if (!isOmarchy(options.platform, options.stateDir)) return null;
  const pid = options.pid ?? process.pid;
  const dir = options.dir ?? omarchyStatusDir();
  const file = join(dir, `${pid}.json`);
  const intervalMs = options.intervalMs ?? 1000;
  const startedAt = new Date().toISOString();

  let state: LiveState = 'idle';
  let task: string | null = null;
  let cwd: string | undefined;
  let lastWrite = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Whether the files of processes that are gone have been cleared. */
  let cleared = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const remove = () => {
    try {
      unlinkSync(file);
    } catch {
      // Not there: nothing of Codeep's to remove.
    }
  };

  const render = (): string => {
    let info: ReturnType<NonNullable<LiveStatusOptions['info']>> = {};
    try {
      info = options.info?.() ?? {};
    } catch (error) {
      debug('Omarchy status: could not read the working directory:', error);
    }
    const where = cwd ?? info.cwd ?? process.cwd();
    // The key order is the contract: `schemaVersion` first, as every record
    // Omarchy's panels read starts.
    return JSON.stringify({
      schemaVersion: 1,
      pid,
      kind: options.kind,
      startedAt,
      updatedAt: new Date().toISOString(),
      cwd: where,
      project: plainText(basename(where)) || plainText(where),
      state,
      task,
      provider: plainText(info.provider ?? ''),
      model: plainText(info.model ?? ''),
    }) + '\n';
  };

  const write = () => {
    timer = null;
    lastWrite = Date.now();
    try {
      if (stopped || !isOmarchy(options.platform, options.stateDir)) return;
      if (options.enabled && !options.enabled()) {
        remove();
        return;
      }
      // Once, at the first write that is allowed: a Codeep with the setting
      // off leaves the directory alone.
      if (!cleared) {
        cleared = true;
        removeStaleStatusFiles(dir, {
          pid,
          isAlive: options.isAlive ?? pidIsAlive,
          startedAtOf: options.startedAtOf ?? processStartedAt,
          cmdlineOf: options.cmdlineOf ?? processCmdline,
        });
      }
      // The directory the way the ledger's is made: what is above it as
      // anything else makes it, and only this one owner-only. A recursive
      // mkdir with a mode would make a missing ~/.local/state 0700 too.
      mkdirSync(dirname(dir), { recursive: true });
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      const tmp = join(dir, `.${pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        // 0600 whatever the umask; the rename keeps it.
        writeFileSync(tmp, render(), { mode: OWN_MODE });
        renameSync(tmp, file);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* never written, or already renamed */ }
        throw error;
      }
    } catch (error) {
      debug('Omarchy status: could not write the file:', error);
    }
  };

  /** Write now, or when the second is up. A write that is already waiting
   *  renders the state as it is then, so this one is in it. */
  const request = () => {
    if (stopped || timer) return;
    const wait = lastWrite + intervalMs - Date.now();
    if (wait <= 0) {
      write();
      return;
    }
    // Capped at the interval, which also keeps a clock set back from holding it up.
    timer = setTimeout(write, Math.min(wait, intervalMs));
    timer.unref?.();
  };

  // Synchronous, as an exit handler has to be.
  const onExit = () => {
    stopped = true;
    clearTimer();
    remove();
  };
  process.on('exit', onExit);
  // The signals that end a terminal UI — SIGHUP when its window closes, SIGTERM
  // — are taken by when-exit (the config store installs it), which runs its
  // callbacks and raises the signal again: the process then dies without an
  // 'exit' event, and the listener above never runs. Its own callback list runs
  // first and, unlike a listener of ours, leaves how the process ends alone.
  const offWhenExit = whenExit(onExit);

  const handle: LiveStatusHandle = {
    set(next, nextTask, extra) {
      if (stopped) return;
      if (extra?.onlyFrom !== undefined && state !== extra.onlyFrom) return;
      // Only a state that is doing something has a task.
      const label = next === 'idle' || nextTask === null ? null : (noticeLabel(nextTask) || null);
      const where = extra?.cwd ?? cwd;
      if (next === state && label === task && where === cwd) return;
      state = next;
      task = label;
      cwd = where;
      request();
    },
    apply(on) {
      if (stopped) return;
      if (on) {
        request();
      } else {
        clearTimer();
        remove();
      }
    },
    flush() {
      if (!timer) return;
      clearTimer();
      write();
    },
    stop() {
      stopped = true;
      clearTimer();
      remove();
      process.removeListener('exit', onExit);
      offWhenExit();
      if (active === handle) active = null;
    },
    current: () => ({ state, task }),
  };
  active?.stop();
  active = handle;
  request();
  return handle;
}

/** Say what Codeep is doing, to the running writer. Nothing when there is none. */
export function setLiveState(
  state: LiveState,
  task: string | null,
  extra?: { onlyFrom?: LiveState; cwd?: string },
): void {
  active?.set(state, task, extra);
}

/** The /settings switch, applied at once. */
export function applyOmarchyLiveStatus(on: boolean): void {
  active?.apply(on);
}

/** Prompts running at once in an ACP server, which can have several sessions. */
let working = 0;

/**
 * An ACP prompt is running: "working" until the last of them has ended.
 * Returns what ends it; calling it again does nothing.
 */
export function trackLiveWork(task: string | null, cwd?: string): () => void {
  working++;
  setLiveState('working', task, { cwd });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    working--;
    if (working === 0) setLiveState('idle', null);
  };
}
