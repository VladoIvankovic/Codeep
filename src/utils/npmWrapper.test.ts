/**
 * bin/codeep.js — the wrapper `npm install -g codeep` puts on PATH — run for
 * real against a stub in place of dist/renderer/main.js.
 *
 * The wrapper is copied, byte for byte, next to a stub it launches, and run
 * with a throwaway HOME. Its job is to be invisible: start the real process,
 * hand it any signal it is sent, and end the way the real process did. A stub
 * stands in for the real one so that what reaches it can be counted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the wrapper launches. `exit:N` prints and exits N. `handle:N[:ms]` logs
 * every SIGINT/SIGTERM/SIGHUP it gets and exits N after ms (300 by default) — a
 * delay long enough for a second delivery to be logged too. `die` installs
 * nothing, so a signal ends it as it would end any process.
 */
const STUB = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { isatty } from 'node:tty';

const [mode, logFile, readyFile] = process.argv.slice(2);
const log = (line) => appendFileSync(logFile, line + '\\n');
log('tty ' + [0, 1, 2].map((fd) => isatty(fd)).join(' '));
console.log('stub output');

const [kind, code, delay] = mode.split(':');
if (kind === 'exit') process.exit(Number(code));
if (kind === 'handle') {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      log(signal);
      setTimeout(() => process.exit(Number(code)), Number(delay ?? 300));
    });
  }
}
writeFileSync(readyFile, String(process.pid));
setInterval(() => {}, 1 << 30);
`;

/**
 * Runs the wrapper under a pseudo-terminal, as a shell would: it becomes the
 * foreground process group, so Ctrl+C reaches the wrapper and the stub alike.
 * Then it types Ctrl+C or sends SIGTERM, and says how the wrapper ended.
 */
const PTY_RUNNER = `
import os, pty, select, signal, sys, time

action, ready_file = sys.argv[1], sys.argv[2]
argv = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)

def drain(wait):
    try:
        readable, _, _ = select.select([fd], [], [], wait)
        if readable:
            return os.read(fd, 4096)
    except OSError:
        return b''
    return None

deadline = time.time() + 20
while not os.path.exists(ready_file):
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        print('status: timeout before ready')
        sys.exit(0)
    if drain(0.05) == b'':
        time.sleep(0.01)

if action == 'ctrl-c':
    os.write(fd, b'\\x03')
elif action == 'sigterm':
    os.kill(pid, signal.SIGTERM)

status = None
while time.time() < deadline:
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
    if drain(0.05) == b'':
        time.sleep(0.01)

if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    print('status: timeout')
elif os.WIFEXITED(status):
    print('status: exited %d' % os.WEXITSTATUS(status))
else:
    print('status: signaled %d' % os.WTERMSIG(status))
`;

/**
 * Runs the wrapper with stdout and stderr on a pseudo-terminal and stdin on
 * /dev/null: `codeep review > out.log &` from a shell, or a script that
 * captures only its input. Then sends the wrapper a SIGINT with kill, as
 * nobody's Ctrl+C, and says how it ended.
 */
const PTY_OUTPUT_RUNNER = `
import os, pty, select, signal, subprocess, sys, time

ready_file = sys.argv[1]
argv = sys.argv[2:]
master, slave = pty.openpty()
proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave)
os.close(slave)

def drain(wait):
    try:
        readable, _, _ = select.select([master], [], [], wait)
        if readable:
            return os.read(master, 4096)
    except OSError:
        return b''
    return None

deadline = time.time() + 20
while not os.path.exists(ready_file):
    if time.time() > deadline:
        proc.kill()
        proc.wait()
        print('status: timeout before ready')
        sys.exit(0)
    if drain(0.05) == b'':
        time.sleep(0.01)

proc.send_signal(signal.SIGINT)
while time.time() < deadline and proc.poll() is None:
    if drain(0.05) == b'':
        time.sleep(0.01)

if proc.poll() is None:
    proc.kill()
    proc.wait()
    print('status: timeout')
elif proc.returncode >= 0:
    print('status: exited %d' % proc.returncode)
else:
    print('status: signaled %d' % -proc.returncode)
`;

type Exit = { code: number | null; signal: NodeJS.Signals | null };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function until(what: string, ok: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const hasPty = process.platform !== 'win32'
  && spawnSync('python3', ['-c', 'import os, pty, select'], { stdio: 'ignore' }).status === 0;

describe.skipIf(process.platform === 'win32')('bin/codeep.js (the npm wrapper)', { timeout: 30_000 }, () => {
  let dir: string;
  let wrapper: string;
  let logFile: string;
  let readyFile: string;
  let env: NodeJS.ProcessEnv;
  let spawned: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeep-wrapper-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'dist', 'renderer'), { recursive: true });
    mkdirSync(join(dir, 'home'));
    // The wrapper is an ES module: the package.json beside it says so, as the
    // real one does.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    wrapper = join(dir, 'bin', 'codeep.js');
    copyFileSync(join(process.cwd(), 'bin', 'codeep.js'), wrapper);
    writeFileSync(join(dir, 'dist', 'renderer', 'main.js'), STUB);
    logFile = join(dir, 'stub.log');
    readyFile = join(dir, 'stub.ready');
    env = { ...process.env, HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home') };
  });

  afterEach(() => {
    for (const child of spawned) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
    }
    spawned = [];
    // A stub the wrapper failed to stop must not outlive the test.
    if (existsSync(readyFile)) {
      const pid = Number(readFileSync(readyFile, 'utf8'));
      try { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const stubPid = () => Number(readFileSync(readyFile, 'utf8'));
  const received = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
  const signalsReceived = () => received().filter((line) => /^SIG/.test(line));

  /** The wrapper with the stub in `mode`, over pipes — no terminal anywhere. */
  function startOverPipes(mode: string) {
    const child = spawn(process.execPath, [wrapper, mode, logFile, readyFile], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    spawned.push(child);
    let stdout = '';
    child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
    const exited = new Promise<Exit>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited, stdout: () => stdout };
  }

  it('starts the real process with the arguments it was given, and passes its output and exit code on', async () => {
    const run = startOverPipes('exit:3');
    expect(await run.exited).toEqual({ code: 3, signal: null });
    expect(run.stdout()).toContain('stub output');
  });

  it('exits 0 when the real process does', async () => {
    expect(await startOverPipes('exit:0').exited).toEqual({ code: 0, signal: null });
  });

  describe('a signal sent to the wrapper', () => {
    it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
      '%s reaches the real process once, and the wrapper exits with the code that process chose',
      async (signal) => {
        const run = startOverPipes('handle:42');
        await until('the stub', () => existsSync(readyFile), 15_000);
        const pid = stubPid();

        run.child.kill(signal);
        // The code the stub chose, not a status of the wrapper's own: it waited.
        expect(await run.exited).toEqual({ code: 42, signal: null });
        expect(signalsReceived()).toEqual([signal]);
        expect(alive(pid), 'the real process is gone').toBe(false);
      },
    );

    it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
      '%s that ends a real process which does not handle it ends the wrapper the same way',
      async (signal) => {
        const run = startOverPipes('die');
        await until('the stub', () => existsSync(readyFile), 15_000);
        const pid = stubPid();

        run.child.kill(signal);
        const outcome = await run.exited;
        await until('the stub to be gone', () => !alive(pid), 5_000).catch(() => { /* asserted below */ });
        expect({ outcome, stubGone: !alive(pid) }).toEqual({ outcome: { code: null, signal }, stubGone: true });
      },
    );
  });

  describe('the real process ended by a signal that did not come through the wrapper', () => {
    // Killed from outside — the OOM killer, a `kill -9` on the real pid. The
    // wrapper used to exit 0 here: `code ?? 0`, and the code is null.
    it.each(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP'] as const)('%s ends the wrapper by the same signal', async (signal) => {
      const run = startOverPipes('die');
      await until('the stub', () => existsSync(readyFile), 15_000);
      process.kill(stubPid(), signal);
      expect(await run.exited).toEqual({ code: null, signal });
    });
  });

  describe.skipIf(!hasPty)('in a terminal', () => {
    async function inTerminal(action: 'ctrl-c' | 'sigterm', mode: string): Promise<string> {
      const runner = spawn(
        'python3',
        ['-c', PTY_RUNNER, action, readyFile, process.execPath, wrapper, mode, logFile, readyFile],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      spawned.push(runner);
      let out = '';
      let err = '';
      runner.stdout!.on('data', (chunk) => { out += String(chunk); });
      runner.stderr!.on('data', (chunk) => { err += String(chunk); });
      await new Promise((resolve) => runner.on('exit', resolve));
      const status = /status: (.*)/.exec(out)?.[1];
      if (!status) throw new Error(`the terminal runner said nothing useful: ${out} ${err}`);
      return status;
    }

    it('delivers Ctrl+C to the real process once — the terminal already did — and waits for it to finish', async () => {
      // 400ms between the signal and the exit: a second delivery would land in it.
      const status = await inTerminal('ctrl-c', 'handle:7:400');
      expect(signalsReceived()).toEqual(['SIGINT']);
      // The wrapper stayed until the stub was done, then exited with its code.
      expect(status).toBe('exited 7');
    }, 40_000);

    it('gives the real process the terminal itself: nothing about stdio changes', async () => {
      await inTerminal('ctrl-c', 'handle:7:50');
      expect(received()[0]).toBe('tty true true true');
    }, 40_000);

    it('still passes a SIGTERM on, which no terminal sends by itself', async () => {
      const status = await inTerminal('sigterm', 'handle:42');
      expect(signalsReceived()).toEqual(['SIGTERM']);
      expect(status).toBe('exited 42');
    }, 40_000);

    it('passes a SIGINT on when only the output is a terminal: with stdin elsewhere nothing else will', async () => {
      // `codeep review > out.log &`, then `kill -INT %1`: stdout and stderr
      // here are a terminal, stdin is not, and the chat could not be running.
      const runner = spawn(
        'python3',
        ['-c', PTY_OUTPUT_RUNNER, readyFile, process.execPath, wrapper, 'handle:9', logFile, readyFile],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      spawned.push(runner);
      let out = '';
      runner.stdout!.on('data', (chunk) => { out += String(chunk); });
      await new Promise((resolve) => runner.on('exit', resolve));

      expect(received()[0]).toBe('tty false true true');
      expect(signalsReceived()).toEqual(['SIGINT']);
      expect(/status: (.*)/.exec(out)?.[1]).toBe('exited 9');
    }, 40_000);
  });
});
