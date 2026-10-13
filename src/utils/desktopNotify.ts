/**
 * A desktop toast when Codeep needs you, or has finished, while you are
 * somewhere else.
 *
 * Telegram's notice (telegramNotify.ts) reaches a phone. This one reaches the
 * desktop you are already at, through `notify-send`: on Omarchy the shell IS
 * the notification daemon, and on any other Linux desktop it is whatever
 * answers org.freedesktop.Notifications. Nothing here is Omarchy-specific.
 *
 * What a toast may say. The desktop keeps what it shows — Omarchy writes
 * every notification to a file under ~/.local/state/omarchy/notifications/ —
 * and a toast is read over a shoulder. So a toast is built from a fixed
 * phrase, a short label of the task, a duration and a tool NAME, and from
 * nothing else: never the answer, a command line, a path or a file name.
 * The label is the user's own prompt words, so it is cleaned first: control
 * characters, ANSI and bidi marks out, words that look like a path, a URL or a
 * file name out, five words, 48 characters.
 *
 * It is told about three things: a run that ended after 30 seconds, an
 * approval that has waited 10, and a question that has. It decides nothing
 * about whether the setting is on — the caller says (`enabled`) — and it never
 * blocks or throws into the run: every failure is a debug line.
 */
import { execFile } from 'child_process';
import { accessSync, constants, readFileSync, statSync } from 'fs';
import { delimiter, join } from 'path';
import { logger } from './logger';
import { formatDuration, shortLabel } from './telegramNotify';

// Debug logging helper - writes to log file when CODEEP_DEBUG=1
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

/**
 * A run shorter than this is not worth a toast: you watched it end. Half the
 * phone's minute, because the desktop is where you were a moment ago and a
 * toast for a run you have to come back to is worth it sooner.
 */
export const DESKTOP_NOTIFY_AFTER_MS = 30_000;

/** How long an approval or a question waits before it says so. Long enough
 *  that answering it at the keyboard never makes a toast. */
export const DESKTOP_WAIT_AFTER_MS = 10_000;

/** The longest word a label keeps. Longer is not a word anyone said: a token, a hash, a pasted blob. */
const MAX_WORD_CHARS = 32;

// ─── What a toast may say ────────────────────────────────────────────────────

// Escape sequences whole, so `[31m` is not left behind a removed ESC: CSI, OSC
// (to its terminator, or to the end if it has none), the two-character forms,
// and the 8-bit CSI.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|\u009b[0-?]*[ -/]*[@-~]/g;

/**
 * One line of plain text: escapes, control characters, line and paragraph
 * separators, format characters (zero-width, bidi overrides), lone surrogates
 * and private-use characters gone, runs of white space one space.
 */
export function plainText(text: string): string {
  return String(text)
    .replace(ESCAPES, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a word of a prompt can stay in a toast: not a path, a URL, a file
 * name, a dotfile or something too long to be a word. Punctuation round it
 * does not count — `(src/app.ts),` is a path.
 */
function isPlainWord(word: string): boolean {
  const bare = word.replace(/^[("'`[{<]+/, '').replace(/[)"'`\]}>.,;:!?]+$/, '');
  if (bare === '' || [...bare].length > MAX_WORD_CHARS) return false;
  // `/` and `\`: a path or a URL, in any of its spellings (the fullwidth and
  // division slashes fold to one under NFKC).
  if (/[\\/]/.test(bare.normalize('NFKC'))) return false;
  if (bare.startsWith('~') || /^[A-Za-z]:/.test(bare)) return false;
  if (/^\.[^.]/.test(bare)) return false;
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(bare);
  // `login.ts`, `Next.js`, `example.com`; not `3.10.2` or `v2.0`, whose
  // "extension" has no letter in it.
  if (extension && /[A-Za-z]/.test(extension[1]) && bare.length > extension[0].length) return false;
  return true;
}

/**
 * A task as the toast names it: "" when nothing of it may be said. The same
 * five words the phone's head names a run by (shortLabel — which also makes
 * it at most 48 characters), taken after the words that may not be said are
 * gone and not before. Cleaned once more at the end, because that cut counts
 * UTF-16 units and can leave half of an emoji, which plainText takes out.
 *
 * `<`, `>` and `&` are not said either: Omarchy's notification server renders
 * a body as markup (Qt StyledText), where `<b>` vanishes into a tag and a lone
 * `<a` swallows the rest of the line; other servers differ, and none of the
 * three is needed to name a task.
 */
export function noticeLabel(task: string): string {
  return plainText(shortLabel(plainText(String(task).replace(/[<>&]/g, ' ')), isPlainWord));
}

/**
 * A tool as the toast names it. Tool names are the agent's and its MCP
 * servers': letters, digits and `_ . : -`. Anything else — which a hostile
 * server can put in a name — is not said at all, rather than said as what is
 * left of it once it has been cleaned.
 */
export function noticeToolName(name: string): string {
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(name) ? name : 'a tool';
}

export interface Notice {
  summary: string;
  /** Omitted when there is nothing to add to the summary. */
  body?: string;
}

/** `Codeep finished — <label>` / `Codeep stopped — <label>`, and how long it took. */
export function runEndNotice(task: string, finished: boolean, elapsedMs: number): Notice {
  const label = noticeLabel(task);
  const head = finished ? 'Codeep finished' : 'Codeep stopped';
  return {
    summary: label ? `${head} — ${label}` : head,
    body: `took ${formatDuration(elapsedMs)}`,
  };
}

export function approvalNotice(tool: string): Notice {
  return { summary: 'Codeep is waiting for your approval', body: noticeToolName(tool) };
}

export function questionNotice(task: string): Notice {
  const label = noticeLabel(task);
  return { summary: 'Codeep has a question', ...(label ? { body: label } : {}) };
}

/**
 * The arguments `notify-send` is run with. `--` ends its option parsing, so
 * no word of the summary or body can ever be read as an option, whatever a
 * prompt said. No shell sees them: they are an argv.
 */
export function notifySendArgs(notice: Notice): string[] {
  return [
    '--app-name=Codeep',
    '--urgency=normal',
    '--',
    notice.summary,
    ...(notice.body ? [notice.body] : []),
  ];
}

// ─── Running things ──────────────────────────────────────────────────────────

export type ExecFn = (file: string, args: string[], options: { timeoutMs: number }) => Promise<string>;

/**
 * `execFile`, as a promise of stdout: no shell, a time limit, and a child that
 * cannot keep Codeep from ending. Rejects on a non-zero exit, on the time
 * limit and on a program that is not there.
 *
 * The limit is a timer of its own and not execFile's `timeout`, which is a
 * timer that keeps the process alive until it fires. The child and its two
 * pipes are unref'd for the same reason: a notification daemon that never
 * answers must not be why `codeep` does not return to the prompt.
 */
export const execFileText: ExecFn = (file, args, options) => new Promise((resolve, reject) => {
  try {
    let limit: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      file,
      args,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (limit) clearTimeout(limit);
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
    limit = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, options.timeoutMs);
    limit.unref?.();
    child.stdin?.end();
    child.unref();
    // Sockets, which the stream types of ChildProcess do not say.
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  } catch (error) {
    reject(error);
  }
});

/** Whether an executable called `name` is on PATH. */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

function readProcFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The parent of `pid`, from /proc/<pid>/stat: its fourth field, which comes
 *  after a `(name)` that may itself hold spaces and parentheses. */
function parentOf(pid: number, readProc: (path: string) => string | null): number | null {
  const stat = readProc(`/proc/${pid}/stat`);
  if (!stat) return null;
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const parent = Number(stat.slice(close + 2).split(' ')[1]);
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

/** `pid` and every process above it, nearest first. */
export function processAncestry(pid: number, readProc: (path: string) => string | null = readProcFile): number[] {
  const seen: number[] = [];
  for (let at: number | null = pid; at !== null && !seen.includes(at) && seen.length < 64; at = parentOf(at, readProc)) {
    seen.push(at);
  }
  return seen;
}

// ─── The notifier ────────────────────────────────────────────────────────────

export interface DesktopNotifierDeps {
  /** Whether toasts are wanted now — asked at every decision, so the setting
   *  takes effect without a restart. */
  enabled: () => boolean;
  exec?: ExecFn;
  /** Reads a /proc file; null when it cannot be read. */
  readProc?: (path: string) => string | null;
  /** This process. */
  pid?: number;
}

export interface DesktopNotifier {
  /** A run has ended. A toast if it took 30 seconds or more; either way the
   *  waits still open are over. Never throws. */
  runEnded(run: { task: string; finished: boolean; elapsedMs: number }): void;
  /**
   * An approval or a question is open. A toast if it is still open after 10
   * seconds. Returns what ends the wait — call it when the dialog is answered
   * or closed; calling it again does nothing. Never throws.
   */
  waiting(kind: 'approval' | 'question', what: { task: string; tool?: string }): () => void;
}

/**
 * Whether a program's absence is the reason it failed. Remembered, so a
 * desktop without `hyprctl` or `notify-send` is asked once and not on every
 * toast.
 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function createDesktopNotifier(deps: DesktopNotifierDeps): DesktopNotifier {
  const exec = deps.exec ?? execFileText;
  const readProc = deps.readProc ?? readProcFile;
  const pid = deps.pid ?? process.pid;
  let noNotifySend = false;
  let noHyprctl = false;
  /** The ends of the waits that are open. */
  const open = new Set<() => void>();

  const wanted = (): boolean => {
    try {
      return deps.enabled();
    } catch (error) {
      debug('Desktop notice: could not read the setting:', error);
      return false;
    }
  };

  /**
   * Whether the terminal Codeep runs in has the keyboard focus. Only
   * answerable on Hyprland, through `hyprctl`: the focused window's process
   * is one of Codeep's ancestors. Anything that cannot be worked out is "no":
   * a toast that was not needed costs a glance, a missing one costs a run
   * left waiting.
   */
  const userIsLooking = async (): Promise<boolean> => {
    if (noHyprctl) return false;
    try {
      const out = await exec('hyprctl', ['-j', 'activewindow'], { timeoutMs: 1500 });
      const focused = Number((JSON.parse(out) as { pid?: unknown } | null)?.pid);
      if (!Number.isInteger(focused) || focused <= 0) return false;
      return processAncestry(pid, readProc).includes(focused);
    } catch (error) {
      if (isMissing(error)) noHyprctl = true;
      return false;
    }
  };

  const show = async (notice: Notice): Promise<void> => {
    try {
      if (noNotifySend || (await userIsLooking())) return;
      await exec('notify-send', notifySendArgs(notice), { timeoutMs: 5000 });
    } catch (error) {
      if (isMissing(error)) noNotifySend = true;
      debug('Desktop notice: could not show it:', error);
    }
  };

  const cancelWaits = () => {
    for (const end of [...open]) end();
  };

  return {
    runEnded(run) {
      try {
        cancelWaits();
        if (run.elapsedMs < DESKTOP_NOTIFY_AFTER_MS || !wanted()) return;
        void show(runEndNotice(run.task, run.finished, run.elapsedMs));
      } catch (error) {
        debug('Desktop notice: run end:', error);
      }
    },

    waiting(kind, what) {
      try {
        if (!wanted()) return () => {};
        const timer = setTimeout(() => {
          open.delete(end);
          if (!wanted()) return;
          void show(kind === 'approval' ? approvalNotice(what.tool ?? '') : questionNotice(what.task));
        }, DESKTOP_WAIT_AFTER_MS);
        // A toast never keeps Codeep from ending.
        timer.unref?.();
        const end = () => {
          clearTimeout(timer);
          open.delete(end);
        };
        open.add(end);
        return end;
      } catch (error) {
        debug('Desktop notice: waiting:', error);
        return () => {};
      }
    },
  };
}
