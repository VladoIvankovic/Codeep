/**
 * What the TUI tells the desktop about a run: a toast when it needs you or has
 * finished (utils/desktopNotify.ts), and the live status file an Omarchy
 * plugin reads (omarchyStatus.ts). One place for the run to say "started",
 * "waiting" and "ended", so the two cannot drift apart.
 *
 * Only the TUI calls this.
 * Every function here is safe to call from the run: none throws, none waits.
 */
import { config } from '../config/index';
import { commandOnPath, createDesktopNotifier, type DesktopNotifier } from '../utils/desktopNotify';
import { isOmarchy } from './omarchyTheme';
import { setLiveState } from './omarchyStatus';

/**
 * Whether toasts are wanted now.
 *
 * Decided at every call, never remembered: the setting is `desktopNotifications`
 * in the config, which is a switch only once someone has set it. Set, either
 * way, it is what was said — an explicit Off wins over everything. Unset, it is
 * "auto": on where Codeep can see it is on Omarchy, whose shell is a
 * notification daemon people expect their tools to use, and off elsewhere.
 * Linux alone: nothing else has `notify-send`.
 */
export function desktopNotificationsEnabled(
  options: { platform?: NodeJS.Platform; stateDir?: string; setting?: unknown } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return false;
  const setting = 'setting' in options ? options.setting : config.get('desktopNotifications');
  if (typeof setting === 'boolean') return setting;
  return isOmarchy(platform, options.stateDir);
}

/**
 * Whether /settings offers the switch: on Linux, with `notify-send` on PATH.
 * Anywhere else it would be a row that does nothing.
 */
export function desktopNotificationsOffered(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): boolean {
  return (options.platform ?? process.platform) === 'linux' && commandOnPath('notify-send', options.env);
}

let notifier: DesktopNotifier | null = null;

function theNotifier(): DesktopNotifier {
  notifier ??= createDesktopNotifier({ enabled: () => desktopNotificationsEnabled() });
  return notifier;
}

/** Replace the notifier — what a test does to see toasts without a desktop. */
export function setDesktopNotifier(replacement: DesktopNotifier | null): void {
  notifier = replacement;
}

/** A run has started. `task` is what it was asked to do, as typed. */
export function runStarted(task: string): void {
  try {
    setLiveState('working', task);
  } catch {
    // Never into the run.
  }
}

/** A run has ended: `finished` is false for one that was stopped, paused,
 *  declined by the model or failed. */
export function runEnded(run: { task: string; finished: boolean; elapsedMs: number }): void {
  try {
    theNotifier().runEnded(run);
  } catch {
    // Never into the run.
  }
  try {
    setLiveState('idle', null);
  } catch {
    // Same.
  }
}

/**
 * An approval or a question is open. Returns what ends it: call it when the
 * dialog is answered or closed, and — for an approval — the run is back to
 * working. Calling it twice, or after the run has ended, does nothing.
 */
export function waiting(kind: 'approval' | 'question', what: { task: string; tool?: string }): () => void {
  let end = () => {};
  try {
    end = theNotifier().waiting(kind, what);
    setLiveState(kind, what.task);
  } catch {
    // Never into the run.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      end();
      // `onlyFrom`: a run that ended while the dialog was open has said idle
      // already, and must not be put back to working by a late answer.
      if (kind === 'approval') setLiveState('working', what.task, { onlyFrom: 'approval' });
      else setLiveState('idle', null, { onlyFrom: 'question' });
    } catch {
      // Never into the run.
    }
  };
}
