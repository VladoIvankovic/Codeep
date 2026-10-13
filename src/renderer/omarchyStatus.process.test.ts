/**
 * The live status file when the terminal UI ends on a signal, for real.
 *
 * The in-memory tests call the 'exit' hook by hand. What they cannot show is
 * the case that matters on Hyprland: closing the terminal window sends SIGHUP,
 * the config store's exit hook (when-exit) takes it, runs its callbacks and
 * raises the signal again, and Node then dies WITHOUT an 'exit' event — so a
 * file removed only on 'exit' stays behind. Here the module runs in a real
 * process beside the real config module, and the process is signalled.
 *
 * Nothing real is touched: the process gets a throwaway HOME, config
 * directory and state directory, and refuses to start on anything else.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HARNESS = `
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = join(realpathSync(tmpdir()), 'codeep-live-status-');
for (const name of ['HOME', 'CODEEP_CONFIG_DIR', 'XDG_STATE_HOME']) {
  let real = '';
  try { real = realpathSync(process.env[name] ?? ''); } catch { /* refused below */ }
  if (!real.startsWith(marker) || !real.includes(sep, marker.length)) {
    console.error('harness: refusing to run, ' + name + ' is not inside a temp directory made for it: ' + process.env[name]);
    process.exit(2);
  }
}

// node -e has no script name in argv: the arguments start at 1.
const [repo, statusDir] = process.argv.slice(1);
const load = (path) => import(pathToFileURL(join(repo, path)).href);
// The config module first: importing it is what makes conf install when-exit,
// as in the real TUI.
await load('src/config/index.ts');
const { startOmarchyLiveStatus } = await load('src/renderer/omarchyStatus.ts');
const handle = startOmarchyLiveStatus({ kind: 'tui', platform: 'linux', stateDir: process.env.HOME, dir: statusDir, intervalMs: 10 });
if (!handle) { console.error('harness: no handle'); process.exit(3); }
handle.set('approval', 'ship it');
handle.flush();
console.log('ready');
setInterval(() => {}, 1 << 30);
`;

type Exit = { code: number | null; signal: NodeJS.Signals | null };

describe.skipIf(process.platform === 'win32')('the live status file when the process is signalled', { timeout: 60_000 }, () => {
  let dir: string;
  let children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
    }
    children = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function run(signal: NodeJS.Signals): Promise<{ exit: Exit; leftover: string[]; hadFile: boolean }> {
    dir = mkdtempSync(join(tmpdir(), 'codeep-live-status-'));
    const home = join(dir, 'home');
    const config = join(dir, 'config');
    const state = join(dir, 'state');
    const statusDir = join(state, 'codeep', 'sessions');
    for (const d of [home, config, state]) mkdirSync(d);
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', HARNESS, process.cwd(), statusDir], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEEP_CONFIG_DIR: config, XDG_STATE_HOME: state },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout!.on('data', (chunk) => { out += String(chunk); });
    child.stderr!.on('data', (chunk) => { err += String(chunk); });
    const exited = new Promise<Exit>((resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })));
    const deadline = Date.now() + 40_000;
    while (!out.includes('ready')) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the harness did not get ready: ${out} ${err}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const hadFile = existsSync(statusDir) && readdirSync(statusDir).some((name) => /^\d+\.json$/.test(name));
    child.kill(signal);
    const exit = await exited;
    const leftover = existsSync(statusDir) ? readdirSync(statusDir) : [];
    return { exit, leftover, hadFile };
  }

  it.each(['SIGHUP', 'SIGTERM'] as const)(
    '%s ends the process as it always did, and takes the file away first',
    async (signal) => {
      const { exit, leftover, hadFile } = await run(signal);

      expect(hadFile, 'the file was there while the process ran').toBe(true);
      // The process still dies BY the signal: nothing here may hold it up.
      expect(exit).toEqual({ code: null, signal });
      expect(leftover).toEqual([]);
    },
  );

  it('SIGKILL, which nothing can catch, leaves it for the next Codeep to clear', async () => {
    const { exit, leftover } = await run('SIGKILL');

    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(leftover.filter((name) => /^\d+\.json$/.test(name))).toHaveLength(1);
  });
});
