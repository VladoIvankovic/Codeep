/**
 * `codeep acp` ending on a signal, for real: a server process with a live MCP
 * child, a signal sent to it, and a look at what is left.
 *
 * The in-memory tests (server.session.test.ts, shutdown.test.ts) call the
 * listener by hand. What they cannot show is the one thing that broke: with the
 * real config module imported, conf's exit hook (when-exit) holds SIGHUP,
 * SIGINT and SIGTERM, and a server that waited for a free signal never attached.
 * Here the server is the real startAcpServer() in a real process, over the real
 * registry, with a real child process registered as an MCP server.
 *
 * Nothing real is touched: the process gets a throwaway HOME and config
 * directory, and the harness refuses to start on anything else. It reads no API
 * key, so the keychain is not asked, and it makes no request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A minimal MCP server over stdio: the handshake and an empty tool list, and
 *  then it just stays alive. It stays alive when its stdin closes too, so a
 *  child that is gone afterwards was signalled; it did not notice a pipe end. */
const FAKE_MCP_SERVER = `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv[2], String(process.pid));
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools: [] } });
  } else if (m.id !== undefined) {
    send({ id: m.id, result: {} });
  }
});
setInterval(() => {}, 1 << 30);
`;

/** Starts the real server with one live MCP child. Refuses to run unless HOME
 *  and CODEEP_CONFIG_DIR are both inside a directory this test made. */
const HARNESS = `
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = join(realpathSync(tmpdir()), 'codeep-acp-shutdown-');
for (const name of ['HOME', 'CODEEP_CONFIG_DIR']) {
  let real = '';
  try { real = realpathSync(process.env[name] ?? ''); } catch { /* not there: refused below */ }
  if (!real.startsWith(marker) || !real.includes(sep, marker.length)) {
    console.error('harness: refusing to run, ' + name + ' is not inside a temp directory made for it: ' + process.env[name]);
    process.exit(2);
  }
}

const [repo, mcpServer, mcpPidFile, readyFile, hookFile] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(repo, path)).href);

// The server first: importing it imports the config module, which is what makes
// conf claim the signals. Counted before the server is started.
const { startAcpServer } = await load('src/acp/server.ts');
const { registerSessionServers } = await load('src/utils/mcpRegistry.ts');
const claimedBefore = Object.fromEntries(['SIGHUP', 'SIGINT', 'SIGTERM'].map((s) => [s, process.listenerCount(s)]));

// A callback on conf's own when-exit instance shows whether its exit hook still
// runs when the server ends the process. It is that instance only if the import
// below found the module already loaded: a second copy would add listeners of
// its own, which the counts around it would show.
const claimedBeforeHook = Object.fromEntries(['SIGHUP', 'SIGINT', 'SIGTERM'].map((s) => [s, process.listenerCount(s)]));
const { default: whenExit } = await import(pathToFileURL(join(repo, 'node_modules/when-exit/dist/node/index.js')).href);
const sameInstance = ['SIGHUP', 'SIGINT', 'SIGTERM'].every((s) => process.listenerCount(s) === claimedBeforeHook[s]);
whenExit(() => writeFileSync(hookFile, 'ran'));

await registerSessionServers('harness', [{ name: 'fake', command: process.execPath, args: [mcpServer, mcpPidFile] }]);
void startAcpServer();
writeFileSync(readyFile, JSON.stringify({ claimedBefore, sameInstance }));
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

describe.skipIf(process.platform === 'win32')('codeep acp ending on a signal', () => {
  let dir: string;
  let server: ChildProcess | undefined;
  let mcpPid: number | undefined;

  afterEach(() => {
    // Whatever a failing run leaves behind must not outlive it.
    try { if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); } catch { /* gone */ }
    try { if (mcpPid && alive(mcpPid)) process.kill(mcpPid, 'SIGKILL'); } catch { /* gone */ }
    server = undefined;
    mcpPid = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function startServer() {
    dir = mkdtempSync(join(tmpdir(), 'codeep-acp-shutdown-'));
    const home = join(dir, 'home');
    const config = join(dir, 'config');
    mkdirSync(home);
    mkdirSync(config);
    const files = {
      mcpServer: join(dir, 'mcp.mjs'),
      mcpPid: join(dir, 'mcp.pid'),
      ready: join(dir, 'ready.json'),
      hook: join(dir, 'hook'),
      harness: join(dir, 'harness.mjs'),
    };
    writeFileSync(files.mcpServer, FAKE_MCP_SERVER);
    writeFileSync(files.harness, HARNESS);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEEP_CONFIG_DIR: config };
    for (const name of ['XDG_STATE_HOME', 'CODEEP_DEBUG', 'CODEEP_ACP_DEBUG', 'CODEEP_ACP_DEBUG_FILE']) delete env[name];

    // stdin stays open, as an editor's pipe does; the server ends only on a signal.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', files.harness, process.cwd(), files.mcpServer, files.mcpPid, files.ready, files.hook],
      { cwd: process.cwd(), env, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    server = child;
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const exited = new Promise<Exit>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    await until('the server and its MCP child', () => existsSync(files.ready) && existsSync(files.mcpPid), 30_000)
      .catch((err) => { throw new Error(`${err.message}\nharness stderr:\n${stderr}`); });
    mcpPid = Number(readFileSync(files.mcpPid, 'utf8'));
    const ready = JSON.parse(readFileSync(files.ready, 'utf8')) as { claimedBefore: Record<string, number>; sameInstance: boolean };
    return { child, exited, config, files, claimedBefore: ready.claimedBefore, sameInstance: ready.sameInstance };
  }

  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)(
    '%s stops the MCP server it spawned, and the process exits %i',
    async (signal, exitCode) => {
      const { child, exited, config, files, claimedBefore, sameInstance } = await startServer();

      // The premise: conf's exit hook holds the signal before the server starts.
      // A server that attached only to a free signal would never have attached.
      expect(claimedBefore[signal], `something already listens for ${signal}`).toBeGreaterThan(0);
      // And the hook watched below is conf's own, not a second copy of when-exit.
      expect(sameInstance, 'the when-exit the harness hooks is the one conf loaded').toBe(true);
      expect(alive(mcpPid!), 'the MCP server is running').toBe(true);

      child.kill(signal);
      const outcome = await exited;
      const mcpGone = await until('the MCP server to be gone', () => !alive(mcpPid!), 5_000).then(() => true, () => false);

      // An exit code, not "killed by the signal": the server ended the process,
      // after stopping the child it had spawned. Both are read before either is
      // asserted, so a failure shows both.
      expect({ outcome, mcpGone }).toEqual({ outcome: { code: exitCode, signal: null }, mcpGone: true });

      // And conf's side of the exit still happened: a callback on its when-exit
      // ran, and no half-written temp file is left in the config directory.
      expect(readFileSync(files.hook, 'utf8')).toBe('ran');
      expect(readdirSync(config).filter((name) => /\.tmp-/.test(name))).toEqual([]);
    },
    60_000,
  );

  it('refuses to run unless HOME and CODEEP_CONFIG_DIR both sit in a temp directory made for it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codeep-acp-shutdown-'));
    writeFileSync(join(dir, 'harness.mjs'), HARNESS);
    // The real home, and the real config directory: the harness must exit
    // before it imports the server, which would open both.
    const realHome = process.env.HOME!;
    for (const env of [
      { HOME: realHome, CODEEP_CONFIG_DIR: join(dir, 'config') },
      { HOME: join(dir, 'home'), CODEEP_CONFIG_DIR: join(realHome, '.codeep') },
      { HOME: tmpdir(), CODEEP_CONFIG_DIR: tmpdir() },
    ]) {
      mkdirSync(join(dir, 'config'), { recursive: true });
      mkdirSync(join(dir, 'home'), { recursive: true });
      const exited = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [join(dir, 'harness.mjs'), process.cwd(), 'x', 'x', 'x', 'x'], {
          env: { ...process.env, ...env }, stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('exit', resolve);
      });
      expect(exited, JSON.stringify(env)).toBe(2);
    }
    expect(existsSync(join(dir, 'ready.json'))).toBe(false);
  }, 30_000);
});
