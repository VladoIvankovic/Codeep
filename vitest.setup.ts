import { vi, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The directories this file made, to remove on the way out.
 *
 * Only the ones it made: CODEEP_CONFIG_DIR can be set from outside, and
 * deleting a directory somebody else pointed us at is not ours to do.
 */
const ownTempDirs: string[] = [];

/**
 * The pid of the Vitest process this run belongs to, which goes in the NAME
 * of every directory below.
 *
 * It is there because the `afterAll` at the bottom cannot be the only way
 * these get removed: Vitest runs no hooks at all for a test file whose tests
 * are ALL skipped, and `npx vitest run -t <name>` makes that every collected
 * file but one. Measured: `-t` against two files left two config directories
 * and two home directories in TMPDIR with nothing to remove them — the same
 * unbounded growth the hook was added for, through a door it does not cover.
 * (`process.on('exit')` does not help either; the pool ends a worker rather
 * than letting it exit, so it never fires. Re-checked here.)
 *
 * A later run can only tell a directory an abandoned run left from one a run
 * in progress is still using by who made it. In the default forks pool every
 * worker is a child of the Vitest process, so `process.ppid` is the same
 * number in all of them and identifies the run.
 */
const RUN_PID = process.ppid;

/**
 * `codeep-test-<kind>-<pid>-<random>`, as mkdtempSync leaves it — and the
 * same name without a pid, which is what every build before this one made.
 * The second half is here because the `afterAll` below stopped that pile
 * growing but nothing ever collected the pile: 14,558 of them, 276MB, were
 * still sitting in TMPDIR on this machine when this was written.
 */
const OWN_TEMP_DIR = /^codeep-test-(?:config|home)-(?:(\d+)-)?[A-Za-z0-9]{6}$/;

/** How old a directory with no owner in its name has to be before it is
 *  swept — see sweepAbandonedTempDirs(). The whole suite runs in ~35s. */
const UNOWNED_TEMP_DIR_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove what runs that are over left behind.
 *
 * Once per worker PROCESS, which is why the marker is an environment
 * variable: this file is evaluated again for every test file, while the
 * worker process is reused across them and its environment is not reset — so
 * a module-level flag would reset too and a 140-file run would scan TMPDIR
 * 140 times.
 */
function sweepAbandonedTempDirs(): void {
  if (process.env.CODEEP_TEST_TMP_SWEPT) return;
  process.env.CODEEP_TEST_TMP_SWEPT = '1';
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return; // Best effort: a sweep must never be why a test run fails.
  }
  for (const name of names) {
    const match = OWN_TEMP_DIR.exec(name);
    if (!match) continue;
    const dir = join(tmpdir(), name);
    if (!isAbandoned(match[1], dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

/** Whether the run that made this directory is over. */
function isAbandoned(owner: string | undefined, dir: string): boolean {
  if (owner === undefined) {
    // No pid in the name, so there is nobody to ask and age is the only
    // signal left. An hour is orders of magnitude longer than a run, and the
    // only thing it can get wrong is an older build of Codeep running its
    // tests in another checkout at this very moment.
    try {
      return Date.now() - statSync(dir).mtimeMs > UNOWNED_TEMP_DIR_MAX_AGE_MS;
    } catch {
      return false;
    }
  }
  const pid = Number(owner);
  // `!pid` also throws out 0 and NaN — `process.kill(0, …)` signals the whole
  // process group.
  if (!pid || pid === RUN_PID) return false;
  try {
    process.kill(pid, 0);
    return false; // Still running; its directories are in use.
  } catch (err) {
    // Only ESRCH means gone: `process.kill(pid, 0)` throws EPERM for a live
    // process this user does not own, and reading that as "dead" would delete
    // the config directory out from under a Vitest run in progress.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

sweepAbandonedTempDirs();

// Give each test worker its own Codeep config directory so parallel workers
// don't race on the shared on-disk config file. Without this, two files that
// mutate config concurrently (e.g. trustWorkspaceHooks → trustedHookProjects)
// can clobber each other's writes, causing order-dependent flakes. Runs before
// the config module (a singleton) is imported by any test file.
if (!process.env.CODEEP_CONFIG_DIR) {
  const configDir = mkdtempSync(join(tmpdir(), `codeep-test-config-${RUN_PID}-`));
  process.env.CODEEP_CONFIG_DIR = configDir;
  ownTempDirs.push(configDir);
}

// Tests must never read or write the developer's real home directory: the
// agent loop records undo history and logs under ~/.codeep, and profile and
// skill code reads and deletes files there. os.homedir() follows HOME (and
// USERPROFILE on Windows), so point both at a throwaway directory per worker.
const testHome = mkdtempSync(join(tmpdir(), `codeep-test-home-${RUN_PID}-`));
ownTempDirs.push(testHome);
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

// Several suites run real git against fixture repositories, and some of them
// reach a code path that wants credentials (`git credential fill`, a remote
// that does not exist). GIT_TERMINAL_PROMPT=0 only stops git asking the
// TERMINAL; an askpass helper still opens a window. VS Code exports
// GIT_ASKPASS in its integrated terminal, so `npm test` there popped a
// "Username for https://example.invalid" dialog and the run sat waiting for it
// — which is how a release stalled. Nothing in the suite should ever ask a
// human for anything, so remove every askpass route and refuse terminal
// prompts outright.
process.env.GIT_TERMINAL_PROMPT = '0';
for (const key of [
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY',
  'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS', 'VSCODE_GIT_IPC_HANDLE',
]) delete process.env[key];

// CODEEP_OPENAI_WIRE_API overrides the config's `openaiWireApi` switch, so a
// developer who exported it (to try the Responses transport, say) would send
// every OpenAI agent turn in the suite to /responses — and the Chat Completions
// suites (agentChat.request.test.ts and the rest) would fail for a reason that
// is not in the code. Tests that exercise the switch set it themselves.
delete process.env.CODEEP_OPENAI_WIRE_API;

/**
 * Remove them once the test file that got them is done.
 *
 * This setup runs again for every test file, so every `npx vitest run` left
 * one config directory and one home directory per test file behind in TMPDIR,
 * for good. On this machine that had reached 14,518 of them and 276MB before
 * anyone noticed. The files this hook does not run for — the ones whose tests
 * are all skipped — are sweepAbandonedTempDirs()'s half.
 *
 * `afterAll` and not a `process.on('exit')` handler, which was the first
 * attempt and removed nothing: the pool ends a worker rather than letting it
 * exit, so 'exit' never fires. This hook does, and it runs LAST — Vitest
 * unwinds afterAll hooks in reverse registration order and this file is
 * registered before any test's own — so a test that cleans up under HOME
 * still finds HOME there.
 *
 * `CODEEP_CONFIG_DIR` is unset along with its directory, so a worker that
 * goes on to another test file makes itself a fresh one instead of pointing
 * the config singleton at a directory that is no longer there.
 *
 * Each removal in its own try: a leftover temp directory must never be the
 * thing that fails a test run. A test file that replaces the whole `fs`
 * module rather than spreading `importOriginal()` over it gets a stubbed
 * `rmSync` here and keeps its directory — across the 140 files in this suite
 * that is one, against 280 before.
 */
afterAll(() => {
  for (const dir of ownTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    if (dir === process.env.CODEEP_CONFIG_DIR) delete process.env.CODEEP_CONFIG_DIR;
  }
  ownTempDirs.length = 0;
});

// No test may reach the real OS keychain: a stray setApiKey would overwrite
// the developer's own API keys. Files that need specific keychain behaviour
// mock '@napi-rs/keyring' themselves, which replaces this in-memory default.
vi.mock('@napi-rs/keyring', () => {
  const store = new Map<string, string>();
  const key = (service: string, account: string) => `${service}::${account}`;
  class AsyncEntry {
    constructor(private service: string, private account: string) {}
    async getPassword() { return store.get(key(this.service, this.account)) ?? null; }
    async setPassword(value: string) { store.set(key(this.service, this.account), value); }
    async deletePassword() { return store.delete(key(this.service, this.account)); }
    async deleteCredential() { return store.delete(key(this.service, this.account)); }
  }
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { return store.get(key(this.service, this.account)) ?? null; }
    setPassword(value: string) { store.set(key(this.service, this.account), value); }
    deletePassword() { return store.delete(key(this.service, this.account)); }
    deleteCredential() { return store.delete(key(this.service, this.account)); }
  }
  return { AsyncEntry, Entry };
});
