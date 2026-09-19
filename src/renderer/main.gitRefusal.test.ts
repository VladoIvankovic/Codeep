/**
 * What the terminal says when git will not run in this project.
 *
 * getGitStatus() answers a refusal from hardenedGitEnv() by returning a repo
 * with no branch and the refusal's text on the result. The header then simply
 * has no branch in it — which looks exactly like "this folder is not a
 * repository", so the one thing the user has to do (remove the key the
 * refusal names) was never said anywhere.
 *
 * The other half of this file is the line between that and an ordinary git
 * failure, which must stay as silent as it always was.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Loading main.ts must not shell out to git, as main.test.ts pins: the branch
// is resolved on first render, not at import.
vi.mock('../utils/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git')>();
  return { ...actual, getGitStatus: vi.fn(actual.getGitStatus) };
});

import { gitRefusalNotice } from './main';
import { getGitStatus } from '../utils/git';

/** A refusal as hardenedGitEnv() words one. */
const REFUSAL =
  "Refusing to run git in /repo: this repository's own git config sets remote.origin.uploadpack, " +
  'which git runs as a program on fetch and push. Git keeps the first value it sees for that key, so no ' +
  'environment override can switch it off. Remove it (git config --unset remote.origin.uploadpack) if you ' +
  'trust this repository.';

describe('the notice for a repository git refuses to run in', () => {
  it('passes the refusal through, so the key and the fix survive', () => {
    // The refusal is written for the user and names both. Summarising it into
    // "git failed here" would throw away the only actionable part.
    const notice = gitRefusalNotice({ isRepo: true, refusal: REFUSAL });

    expect(notice).toContain('remote.origin.uploadpack');
    expect(notice).toContain('git config --unset remote.origin.uploadpack');
    // And says what the missing branch means, since that is the symptom the
    // user actually saw.
    expect(notice).toMatch(/header shows no branch/);
  });

  it('says nothing about a folder that is simply not a repository', () => {
    // The ordinary case, and by far the common one. A message here would put
    // a warning in front of everyone who opens Codeep outside a checkout.
    expect(gitRefusalNotice({ isRepo: false })).toBeNull();
    expect(gitRefusalNotice({ isRepo: true, branch: 'main', hasChanges: false })).toBeNull();
  });

  it('takes it from `refusal` and not from the text, so `error` stays silent', () => {
    // The same sentence, on the field every git failure fills, says nothing.
    // Which field it arrived on is the whole decision — matching on the
    // wording instead would put this back to guessing at git's stderr.
    expect(gitRefusalNotice({ isRepo: true, error: REFUSAL })).toBeNull();
  });
});

describe('a repository where git merely failed', () => {
  let repo: string;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codeep-git-fresh-'));
    // Real git reads whoever's machine this is on: an `init.defaultBranch` or
    // a template directory in the developer's own config would decide what
    // this asserts. Point it at a file that is not there.
    process.env.GIT_CONFIG_GLOBAL = join(repo, 'no-such-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = join(repo, 'no-such-gitconfig');
  });

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    rmSync(repo, { recursive: true, force: true });
  });

  it('says nothing about a brand-new git init', () => {
    // One of the first things anyone does in a new project, and git 2.54
    // answers `git rev-parse --abbrev-ref HEAD` there with `fatal: ambiguous
    // argument 'HEAD'` because there is no commit yet. getGitStatus fills
    // `error` for that exactly as it does for a refusal, so surfacing `error`
    // met the user with a warning made of git internals, telling them to
    // remove a config key that does not exist.
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });

    const status = getGitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBeUndefined();
    expect(status.error).toBeTruthy(); // git really did fail here…
    expect(gitRefusalNotice(status)).toBeNull(); // …and the user hears nothing.
  });
});

// The wiring runs inside getStatus(), which the render loop calls, and
// reaching it would mean standing up the whole App. Guard it at source level
// instead — narrowly: a notice that is built and never shown is exactly the
// bug this was, and tsc says nothing about an unused return value.
describe('the header is what asks for it', () => {
  const source = readFileSync('src/renderer/main.ts', 'utf-8')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

  /**
   * One function's source: from its `function` line to the `}` in the first
   * column that ends it.
   *
   * Bounded, because slicing to the END OF THE FILE is what this did and it
   * made the guard almost vacuous — any call anywhere below counted, so the
   * assertions would have passed on a `gitRefusalNotice(status)` sitting in
   * some unrelated function added later, while the header did nothing.
   */
  function functionSource(name: string): string {
    const start = source.indexOf(`function ${name}`);
    expect(start, `${name} not found in main.ts`).toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start);
    expect(end, `no end of ${name} found`).toBeGreaterThan(start);
    return source.slice(start, end + 2);
  }

  it('builds the notice where the branch is resolved, and reports it', () => {
    const header = functionSource('getHeaderBranch');
    expect(header).toMatch(/gitRefusalNotice\(status\)/);
    expect(header).toMatch(/reportGitRefusal\(projectPath, refusal\)/);
  });

  it('puts it in the transcript rather than a toast that disappears', () => {
    expect(functionSource('reportGitRefusal')).toMatch(/addMessage/);
  });

  it('bounds each function at its own end', () => {
    // The guard above is only worth having if the slice stops. Proven on the
    // two functions it reads: neither may contain the other's body.
    expect(functionSource('getHeaderBranch')).not.toMatch(/addMessage/);
    expect(functionSource('reportGitRefusal')).not.toMatch(/gitRefusalNotice\(status\)/);
  });
});
