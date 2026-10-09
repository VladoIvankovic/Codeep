import { describe, it, expect, vi, afterEach } from 'vitest';
import { installShutdownHandlers, SHUTDOWN_EXIT_CODES } from './shutdown';

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

describe('installShutdownHandlers', () => {
  let remove: (() => void) | undefined;
  let strangers: Array<[NodeJS.Signals, () => void]> = [];

  /** The listeners on `signal` that were not there before `before` was taken. */
  const addedSince = (signal: NodeJS.Signals, before: Function[]) =>
    process.listeners(signal).filter((l) => !before.includes(l)) as Array<() => void>;

  /** Install, and hand back the listener it put on `signal` — called directly,
   *  since process.emit would run every other listener on the test worker too. */
  function install(signal: NodeJS.Signals, dispose: () => Promise<void>, exit: (code: number) => void, graceMs?: number) {
    const before = process.listeners(signal);
    remove = installShutdownHandlers(dispose, exit, graceMs);
    const [listener, ...rest] = addedSince(signal, before);
    expect(rest, 'one listener per signal').toHaveLength(0);
    expect(listener, 'a listener was attached').toBeTypeOf('function');
    return listener;
  }

  afterEach(() => {
    remove?.();
    remove = undefined;
    for (const [signal, listener] of strangers) process.removeListener(signal, listener);
    strangers = [];
    vi.useRealTimers();
  });

  it('exits with the status a shell reports for the signal: 128 plus its number', () => {
    expect(SHUTDOWN_EXIT_CODES).toEqual({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
  });

  it.each(SIGNALS)('attaches on %s although another listener — conf\'s one-shot — already holds it', (signal) => {
    // What when-exit does the moment the config module is imported.
    const stranger = () => {};
    process.once(signal, stranger);
    strangers.push([signal, stranger]);
    const count = process.listenerCount(signal);
    install(signal, async () => {}, () => {});
    expect(process.listenerCount(signal)).toBe(count + 1);
  });

  it.each(SIGNALS)('on %s disposes first and exits with its code only after that has finished', async (signal) => {
    const exit = vi.fn();
    let finish!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const listener = install(signal, dispose, exit);

    listener();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(SHUTDOWN_EXIT_CODES[signal]));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('starts disposing in the tick the signal arrives, not a microtask later', () => {
    const dispose = vi.fn(async () => {});
    const listener = install('SIGTERM', dispose, () => {});
    listener();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores every signal after the first, whichever it is', async () => {
    const exit = vi.fn();
    let finish!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const before = SIGNALS.map((signal) => [signal, process.listeners(signal)] as const);
    remove = installShutdownHandlers(dispose, exit);
    const [hup, int, term] = before.map(([signal, was]) => addedSince(signal, was)[0]);

    term();
    int();   // an editor's second signal
    term();  // when-exit raising the first one again
    hup();
    expect(dispose).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    // The status of the signal that started it.
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('still exits when disposing fails, whether it rejects or throws', async () => {
    const rejected = vi.fn();
    install('SIGINT', async () => { throw new Error('stop failed'); }, rejected)();
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(130));
    remove?.();

    const thrown = vi.fn();
    install('SIGINT', (() => { throw new Error('threw before returning a promise'); }) as () => Promise<void>, thrown)();
    await vi.waitFor(() => expect(thrown).toHaveBeenCalledWith(130));
  });

  it('exits anyway when disposing never finishes, so the signal can still end the process', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const listener = install('SIGTERM', () => new Promise<void>(() => {}), exit, 250);
    listener();
    await vi.advanceTimersByTimeAsync(249);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('exits once, and clears the deadline, when disposing finishes in time', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const listener = install('SIGTERM', async () => {}, exit, 250);
    listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('takes its listeners off again', () => {
    const counts = SIGNALS.map((signal) => process.listenerCount(signal));
    const off = installShutdownHandlers(async () => {}, () => {});
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(counts.map((n) => n + 1));
    off();
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(counts);
  });
});
