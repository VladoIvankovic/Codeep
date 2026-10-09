import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Conf from 'conf';
import { unwatchFile, watchFile } from 'fs';
import { watchConfig, type ConfigWatch } from './configWatch';

// The real ones, watched: a poll that stop() left behind still calls its
// listener, which the stopped flag then ignores — so only fs can tell.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, watchFile: vi.fn(actual.watchFile), unwatchFile: vi.fn(actual.unwatchFile) };
});

/**
 * What tells the welcome block the config changed. It said the provider,
 * model, Agent Mode and account of the moment Codeep started, whatever
 * /provider, /model or /agent changed after — and an account linked with
 * `codeep account` in another terminal stayed "not linked" until a restart.
 */

/** conf's onDidAnyChange, as the watch uses it: one listener, and whether
 *  it was taken back. */
function inProcessSource() {
  const source = {
    path: join(tmpdir(), 'codeep-no-such-config.json'),
    changed: () => {},
    unsubscribed: false,
    onDidAnyChange(callback: () => void) {
      source.changed = callback;
      return () => { source.unsubscribed = true; };
    },
  };
  return source;
}

let dir: string;
const watches: ConfigWatch[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeep-config-watch-'));
});

afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function watch(...args: Parameters<typeof watchConfig>): ConfigWatch {
  const handle = watchConfig(...args);
  watches.push(handle);
  return handle;
}

describe('a change made in this process', () => {
  it('calls back once for a burst, when it has gone quiet for 150 ms', () => {
    vi.useFakeTimers();
    const source = inProcessSource();
    const onChange = vi.fn();
    watch(source, onChange);

    // setProvider: the provider, the model and the protocol, one after another.
    source.changed();
    vi.advanceTimersByTime(100);
    source.changed();
    vi.advanceTimersByTime(100);
    source.changed();
    vi.advanceTimersByTime(149);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    // The next change is a new burst.
    source.changed();
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a call that throws', () => {
    // From a timer, a throw would reach main.ts's uncaughtException handler,
    // which ends the session.
    vi.useFakeTimers();
    const source = inProcessSource();
    const onChange = vi.fn(() => { throw new Error('no welcome'); });
    watch(source, onChange);

    source.changed();
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    source.changed();
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('the poll', () => {
  it('checks the file every two seconds, and keeps no process alive', () => {
    // "Within a couple of seconds" is what the changelog promises for an
    // account linked in another terminal; a slower poll broke it unnoticed.
    const source = inProcessSource();
    vi.mocked(watchFile).mockClear();
    watch(source, () => {});
    expect(watchFile).toHaveBeenCalledTimes(1);
    expect(watchFile).toHaveBeenCalledWith(source.path, { persistent: false, interval: 2000 }, expect.any(Function));
  });
});

describe('a write by another process', () => {
  it('is seen, write after write, although each one replaces the file', async () => {
    // Another `codeep` — `codeep account` linking the machine — writes the
    // file through conf, which writes a new file and renames it over the
    // config. A watch that followed the file's inode would see the first
    // such write at most.
    const other = new Conf<Record<string, unknown>>({ projectName: 'codeep', cwd: dir });
    other.set('syncToken', '');
    const onChange = vi.fn();
    watch({ path: other.path, onDidAnyChange: () => () => {} }, onChange, { pollMs: 20, debounceMs: 10 });

    other.set('syncToken', 'linked-elsewhere');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 3000 });
    other.set('githubId', '123');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2), { timeout: 3000 });
    other.set('syncToken', '');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3), { timeout: 3000 });
  });

  it('is not a read: the config is read on every frame', async () => {
    const other = new Conf<Record<string, unknown>>({ projectName: 'codeep', cwd: dir });
    other.set('provider', 'z.ai');
    const onChange = vi.fn();
    watch({ path: other.path, onDidAnyChange: () => () => {} }, onChange, { pollMs: 20, debounceMs: 10 });

    for (let i = 0; i < 10; i++) {
      other.get('provider');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('stop()', () => {
  it('drops a call that is waiting and gives back the in-process listener', () => {
    vi.useFakeTimers();
    const source = inProcessSource();
    const onChange = vi.fn();
    const handle = watch(source, onChange);

    source.changed();
    handle.stop();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    expect(source.unsubscribed).toBe(true);

    // And it can be called again: process exit and gracefulShutdown both do.
    expect(() => handle.stop()).not.toThrow();
  });

  it('stops its own poll of the file, leaving another watch on it running', async () => {
    const other = new Conf<Record<string, unknown>>({ projectName: 'codeep', cwd: dir });
    other.set('syncToken', '');
    const target = { path: other.path, onDidAnyChange: () => () => {} };
    const stopped = vi.fn();
    const running = vi.fn();
    const first = watch(target, stopped, { pollMs: 20, debounceMs: 10 });
    const ownPoll = (vi.mocked(watchFile).mock.calls.at(-1) as unknown[])[2];
    watch(target, running, { pollMs: 20, debounceMs: 10 });

    first.stop();
    // By its listener: fs.unwatchFile(path) alone ends every poll of the file.
    expect(unwatchFile).toHaveBeenCalledWith(other.path, ownPoll);

    other.set('syncToken', 'linked-elsewhere');
    await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // Several polls later, still nothing for the stopped one.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(stopped).not.toHaveBeenCalled();
  });
});
