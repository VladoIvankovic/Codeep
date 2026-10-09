/**
 * Notice when Codeep's config changes, so the welcome block can follow it.
 *
 * The welcome names the provider, the model, Agent Mode and whether this
 * machine is linked to codeep.dev. All four live in the config, and all four
 * change while a session runs: /provider, /model, /agent, /settings and a
 * loaded profile change them in this process, and `codeep account` links the
 * machine from another terminal. The welcome used to say what was true at
 * startup until the next launch.
 *
 * Two sources, because neither sees both. conf announces every set made in
 * this process (onDidAnyChange: conf 13 dispatches 'change' from every
 * write, `watch` or not). A write by another process announces nothing here,
 * so the file is polled as well — by path, with fs.watchFile, because conf
 * writes atomically, renaming a new file over the old one, and a watch on the
 * file itself (fs.watch) would be left on the inode the first write retired.
 * conf's own `watch: true` polls too, but for every Conf in the process —
 * ACP and `codeep review` included — and this runs only where main.ts starts
 * it, once the TUI is up.
 *
 * A change comes as a burst: setProvider writes the provider, the model and
 * the protocol one after another, and the poll sees the same write again a
 * moment later. So onChange runs once, when the burst has gone quiet. The
 * poll and the timer never keep the process alive.
 */
import { unwatchFile, watchFile } from 'fs';

export interface ConfigWatchTarget {
  /** The config file. */
  path: string;
  /** conf's: runs after each set in this process that changed something,
   *  and returns the unsubscribe. */
  onDidAnyChange(callback: () => void): () => void;
}

export interface ConfigWatchOptions {
  /** How long a burst of changes must go quiet before onChange runs. */
  debounceMs?: number;
  /** How often the file is checked for another process's writes. */
  pollMs?: number;
}

export interface ConfigWatch {
  /** Stop both sources, dropping a call that is waiting. */
  stop(): void;
}

/** Call `onChange` after the config changes, here or in another process,
 *  until stop(). */
export function watchConfig(
  target: ConfigWatchTarget,
  onChange: () => void,
  options: ConfigWatchOptions = {},
): ConfigWatch {
  const debounceMs = options.debounceMs ?? 150;
  const pollMs = options.pollMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch {
        // Rewriting the welcome must never take the session down.
      }
    }, debounceMs);
    timer.unref?.();
  };

  // Any change to the file's stat — a write in place, or a new file renamed
  // over it — but not a read: the poll compares mtime, size and inode, and
  // never the access time, so the config's own reads do not set it off.
  const poll = () => schedule();
  let unsubscribe: () => void = () => {};
  try {
    unsubscribe = target.onDidAnyChange(() => schedule());
    watchFile(target.path, { persistent: false, interval: pollMs }, poll);
  } catch {
    // A welcome that does not follow the config is no reason not to start.
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe();
      // This listener only: another watch on the same file keeps its own.
      unwatchFile(target.path, poll);
    },
  };
}
