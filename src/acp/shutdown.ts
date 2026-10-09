// acp/shutdown.ts
// Ending a `codeep acp` server on a signal: stop the MCP child processes it
// started, then exit with the status a shell reports for that signal.

/**
 * The signals that end the server, with the status a shell reports for each:
 * 128 plus the signal's number. SIGHUP is the editor's terminal going away.
 */
export const SHUTDOWN_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * How long a shutdown waits for `dispose` before it exits anyway. Disposing
 * signals the children and aborts a fetch; it does not wait for either, so this
 * bounds a bug and is not a wait anyone should see. Once the server answers the
 * signal itself, nothing else will end the process.
 */
const DISPOSE_GRACE_MS = 3000;

/**
 * Run `dispose`, then `exit`, when the process gets SIGHUP, SIGINT or SIGTERM.
 * Returns a function that takes the listeners off again.
 *
 * Attached unconditionally, and that is the point. This used to attach only
 * `if (process.listenerCount(sig) === 0)`, to avoid stepping on someone else's
 * handler — but conf (through atomically, through when-exit) installs a
 * one-shot SIGHUP/SIGINT/SIGTERM listener as soon as the config module is
 * imported, which the server always has, so the guard was never true. The
 * handler never attached, and a SIGTERM or SIGINT ended the process with the
 * MCP servers it had spawned still running.
 *
 * It composes with when-exit instead of replacing it. when-exit's listener was
 * registered first, so it runs first: it purges conf's pending temp files
 * (synchronously — conf writes with atomically.writeFileSync, so no write can
 * be half-done while a listener runs, only a leftover temp file is possible),
 * marks itself done, and raises the signal again. With our listener still
 * attached that second delivery does not kill the process; it reaches us once
 * more and `shuttingDown` ignores it. We then exit ourselves, through
 * process.exit, after `dispose` has signalled the children; the 'exit' event
 * finds when-exit already finished and does nothing. Were the order the other
 * way, we only start `dispose` and exit later, so when-exit's callbacks still
 * run first.
 *
 * Exiting by process.exit also reports as an exit code (128+n, what a shell
 * shows for the signal), where a process the signal itself killed reports as a
 * signal and no code at all — a client reading the code, as Node's `exit` event
 * does, sees `null`.
 */
export function installShutdownHandlers(
  dispose: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  graceMs: number = DISPOSE_GRACE_MS,
): () => void {
  let shuttingDown = false;
  const attached: Array<[NodeJS.Signals, () => void]> = [];

  for (const signal of Object.keys(SHUTDOWN_EXIT_CODES) as Array<keyof typeof SHUTDOWN_EXIT_CODES>) {
    const listener = () => {
      // when-exit raises the signal again after its own cleanup, and an editor
      // may send a second one: the first starts the shutdown, the rest wait.
      if (shuttingDown) return;
      shuttingDown = true;
      const code = SHUTDOWN_EXIT_CODES[signal];

      let finished = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (deadline) clearTimeout(deadline);
        exit(code);
      };
      deadline = setTimeout(finish, graceMs);
      deadline.unref?.();

      // Started in this tick, not a microtask later: dispose signals the
      // children as soon as it is called.
      let disposing: Promise<void>;
      try {
        disposing = Promise.resolve(dispose());
      } catch (err) {
        disposing = Promise.reject(err);
      }
      // A failed dispose still ends the process: the signal asked for that.
      disposing.then(finish, finish);
    };
    try {
      process.on(signal, listener);
      attached.push([signal, listener]);
    } catch {
      // A platform that has no such signal.
    }
  }

  return () => {
    for (const [signal, listener] of attached) process.removeListener(signal, listener);
  };
}
