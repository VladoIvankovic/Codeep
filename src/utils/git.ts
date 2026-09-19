import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'path';
// Type-only: keeps git.ts free of runtime imports, so src/utils/shell.ts
// can pull hardenedGitEnv() in without creating an import cycle.
import type { ActionLog } from './tools';

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  hasChanges?: boolean;
  ahead?: number;
  behind?: number;
  /**
   * Why there is no branch here — a GitHardeningError, or git itself failing.
   * Declared because getGitStatus was already filling it through an
   * `as GitStatus` cast that the compiler could not check: the field existed
   * at runtime, nothing in the type said so, and the status line in
   * renderer/main.ts reads `.branch` only — so a refusal showed up as the
   * branch silently disappearing. Written for the user; show it where the
   * branch would go.
   *
   * Every way git can fail lands here, including the ordinary ones. The
   * commonest is a brand-new `git init` with no commit yet, where `git
   * rev-parse --abbrev-ref HEAD` answers `fatal: ambiguous argument 'HEAD'`
   * (git 2.54) — which is why nothing should put this in front of the user
   * as an instruction. Use `refusal` for that.
   */
  error?: string;
  /**
   * Set ONLY when the hardening refused to run git here, and never for an
   * ordinary git failure. The message names the config key and the
   * `git config --unset` that clears it, so it is the one the TUI shows
   * verbatim (see gitRefusalNotice in renderer/main.ts).
   *
   * This field shipped dead in the first cut of the hotfix: main.ts read
   * `status.refusal`, `GitStatus` never declared it and getGitStatus never
   * set it, so the warning it exists to raise never fired once and the only
   * symptom of a refused repository was the branch quietly vanishing from
   * the header — the exact symptom that notice was written to remove. When
   * this is set, `error` carries the same text, so callers that only know
   * about `error` still say something useful.
   */
  refusal?: string;
}

export interface GitDiffResult {
  success: boolean;
  diff: string;
  error?: string;
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  error?: string;
}

// ─── hardened git invocation ─────────────────────────────────────────────────

/**
 * Config keys that make git RUN a command and that no sane global setup
 * depends on, each paired with the value that neutralises it. These go on
 * EVERY git call regardless of where the setting came from — and, unlike the
 * scope-aware layer below, regardless of WHICH repository the call ends up
 * in, which is what makes them the last line for a `git -C vendor/lib` or a
 * `cd vendor/lib && git …` the scan never read (see `core.fsmonitor`).
 *
 * Every one of them is attacker-controlled, because a repository carries its
 * own `.git/config`: cloning (or being handed) a folder someone else prepared
 * is enough, and so is a prompt injection that gets `write_file` pointed at
 * `.git/config`. Git then executes the command on the next perfectly ordinary
 * call — `git status` for the status line already does it.
 *
 * They are applied through the `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n` environment form, which git treats exactly like
 * `-c key=value`: highest precedence, so it beats the repo's config, and it
 * needs no change to the argv each call site builds.
 *
 * Keys whose value a user legitimately sets globally — `gpg.program`,
 * `credential.helper`, `filter.lfs.*`, `core.sshCommand` — are NOT here.
 * Blanketing those breaks git-lfs, signing and `git push` for everybody to
 * stop a repository nobody has. They are handled by repoSuppliedOverrides(),
 * which neutralises them only where the repository itself set them.
 */
const GIT_EXECUTING_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  // Run on every index refresh — `git status`, `git diff`, `git add`,
  // `git commit`. This is the one that fires at startup, because the status
  // line calls getGitStatus() before the user has typed anything.
  //
  // Blanket rather than scope-aware, and yes, that overrides a user who
  // configured watchman globally — they lose the watchman speed-up on git
  // run through Codeep, nothing else. The reason is NOT that the scan cannot
  // be trusted; it fails closed now (see listGitConfig). It is that the scan
  // is tied to ONE directory, and a git process can be aimed somewhere else:
  // `git -C vendor/lib status`, or a shell line that runs `cd vendor/lib &&
  // git status` — which shellCommandEnv() cannot parse and does not pretend
  // to. In a nested checkout the scan never read, these always-on pairs are
  // the ONLY layer left. Proven with git 2.54: with a hostile `core.fsmonitor`
  // and a hostile `filter.h.clean` in `vendor/lib`, `cd vendor/lib && git
  // status` under this environment ran the filter and did NOT run the
  // fsmonitor. So the highest-frequency executing key stays blanket, and the
  // ones `GIT_CONFIG_*` cannot wildcard (`filter.*`) are the honest gap
  // shellCommandEnv() documents.
  ['core.fsmonitor', 'false'],
  // The pager is spawned whenever git's stdout is a tty. Ours are pipes today,
  // but that is a property of each call site, not something to depend on.
  ['core.pager', 'cat'],
  // Launched when a commit message or a rebase todo needs editing. We always
  // pass `-m`, so `true` (exits 0, writes nothing) costs us nothing — and a
  // git that decided to open an editor on a pipe would hang the UI forever.
  ['core.editor', 'true'],
  ['sequence.editor', 'true'],
  // `git show` on a signed commit verifies the signature by running
  // `gpg.program`, and a hostile repo can both set `log.showSignature=true`
  // and store a commit object carrying a `gpgsig` header. Suppressing the
  // display is enough, and it leaves `gpg.program` itself alone so that users
  // who sign their own commits keep signing them.
  //
  // Blanket for the same reason as `core.fsmonitor` above — a repository the
  // scan never saw is still reached by `git -C sub log` and by `cd sub && git
  // log` — and the cost is only cosmetic: a user who turned
  // `log.showSignature` on GLOBALLY loses the "Good signature from …" lines
  // in a `git log` or `git show` run through Codeep. That is what buys the
  // right to leave `gpg.program` alone, which is the setting that actually
  // has to keep working.
  ['log.showSignature', 'false'],
  // `ext::<command>` URLs run their command as the transport. Nothing in
  // Codeep speaks to a remote, and `ext::` is vanishingly rare in real setups.
  ['protocol.ext.allow', 'never'],
  // Both are read from the repository being served/read and have no global
  // meaning, so there is no user setup to preserve.
  ['uploadpack.packObjectsHook', ''],
  ['core.alternateRefsCommand', ''],
];

/**
 * A `core.hooksPath` that cannot contain a hook file. `/dev/null` is not a
 * directory, so `/dev/null/pre-commit` can never exist — verified on macOS
 * against git 2.54, and it is what the POSIX suites in git.hardening.test.ts
 * assert.
 *
 * The win32 arm is the reserved device name `NUL`, chosen because no
 * directory can shadow a reserved name. It is NOT verified — nothing in this
 * repository runs git on Windows, and the suites below skip there — so it is
 * the best available guess rather than a proven no-hooks path.
 *
 * What that costs if the guess is wrong is worth naming, because it is small:
 * `noHooks` is only ever passed for the commands Codeep runs BY ITSELF
 * (status, diff, rev-parse, show, ls-files, log), none of which git runs a
 * hook for in the first place. A `NUL` that resolved to an openable directory
 * would therefore re-enable nothing that the commands the user triggers do
 * not already run deliberately. Whoever verifies it should replace this with
 * a real empty directory rather than another reserved name.
 */
const NO_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Raised instead of handing git an environment that the config scan below
 * could not finish building. Every caller in this file catches it and reports
 * `error.message`, which is written for the user rather than for a log.
 */
export class GitHardeningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHardeningError';
  }
}

/** One wording for every refusal, so the user learns to recognise one. */
function refuse(cwd: string, detail: string): GitHardeningError {
  return new GitHardeningError(`Refusing to run git in ${cwd}: ${detail}`);
}

/**
 * How much `git config --list` output the scan accepts.
 *
 * The old 4MB was a hole rather than a limit: a repository that padded its
 * own `.git/config` past it made execFileSync throw ENOBUFS, the scan's
 * `catch { return null }` reported that as "this repository set nothing", and
 * `filter.hostile.clean` then ran on the next `git status` (proven, with ~5MB
 * of padding). Two things fix it — the scan now fails the CALL instead of
 * failing open, and the buffer is far past anything an honest config reaches
 * (a real `.git/config` is a few kilobytes). Raising it further would add no
 * safety, only more bytes to read in a repository built to waste them.
 */
const SCAN_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * How much `git ls-files -s` output the index listing accepts — see
 * indexGitlinkPaths(), the one call that uses it.
 *
 * Sharing SCAN_MAX_BUFFER with it was the bug, and an unusually bad one: the
 * config scan's ceiling is about a `.git/config` an attacker PADDED, where
 * 16MB is already absurd, while the index listing's is about how many files
 * a repository has, where 16MB is roughly 100k paths — a real monorepo, not a
 * hostile one. Past it execFileSync threw ENOBUFS and the catch below turned
 * that into a hardening refusal, so the whole git integration switched itself
 * off in the repositories that need it most, and no fixture in the suite was
 * big enough to see it (reproduced: a 22k-entry index, 21.7MB of listing,
 * refused every git call).
 *
 * 256MB is a ceiling no honest index reaches — ~1.7M paths at the ~150 bytes
 * a record costs here, several times the largest repositories git serves
 * without a virtual filesystem — and it is a transient allocation rather than
 * a resident cost: Node only ever holds what the child actually wrote, which
 * for this repository is 14KB and for a 100k-file monorepo 16MB. The listing
 * is read once per hardenedGitEnv() call and dropped.
 *
 * It is still a ceiling rather than Infinity, because the answer above it has
 * to be an error and not an out-of-memory kill of the whole CLI.
 */
const INDEX_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * How long the scan may take.
 *
 * Generous on purpose. The scan costs ~9ms, and the old 2s budget was still
 * blown occasionally by a full test suite running with file parallelism —
 * which used to mean "silently unhardened" and now means "git refuses to
 * run", so a tight budget buys nothing and costs flakes. A budget still has
 * to exist: a config whose `include.path` names a FIFO blocks its reader
 * forever. That config stalls every REAL git call in the repository in
 * exactly the same way, so this bounds our scan, not the problem.
 */
const SCAN_TIMEOUT_MS = 10_000;

/** One `git config --list --show-scope` record. */
interface GitConfigEntry {
  /** `system` | `global` | `local` | `worktree` | `command` | `unknown`. */
  scope: string;
  /** The key exactly as git printed it — see repoSuppliedOverrides(). */
  key: string;
  value: string;
  /**
   * False when the decoded text does NOT re-encode to the bytes git printed.
   * Node builds an environment variable from a JS string and encodes it as
   * UTF-8, so a key or value git printed as invalid UTF-8 can never be handed
   * back to git: false means "no override can be emitted for this entry", not
   * "this entry looks unusual".
   */
  keyExact: boolean;
  valueExact: boolean;
  /**
   * The config FILE the entry came from, as `--show-origin` reports it.
   *
   * Only filled for the submodule pass, and load-bearing there: that pass
   * reads every submodule's config through one `git -c include.path=…` child
   * (see listSubmoduleConfig), so without an origin every entry looks like it
   * came from the superproject. A refusal then named the superproject and
   * printed `git config --unset <key>`, which run there silently does
   * nothing — `--unset` writes the repository it is run in, and the key is in
   * `.git/modules/<name>/config`. The user ran it, saw no error, and met the
   * same refusal on the next call. See unsetCommand().
   */
  file?: string;
  /** The submodule's working tree, when the enumeration reached it through
   *  one. Absent for a submodule that is initialised but not checked out. */
  worktree?: string;
}

/**
 * The scope this file gives entries read out of a submodule's own config.
 * Not one of git's own scope words — git never prints these entries at the
 * superproject at all, which is the whole reason listSubmoduleConfig() exists.
 */
const SUBMODULE_SCOPE = 'codeep-submodule';

/** Scopes that mean "the repository said so", i.e. attacker-controlled. */
function isRepoScope(scope: string): boolean {
  // `worktree` belongs next to `local`: `.git/config.worktree` ships inside
  // `.git` exactly as `.git/config` does, and git starts honouring it the
  // moment the repository sets `extensions.worktreeConfig`. Accepting only
  // `local` left every key written with `git config --worktree` live.
  return scope === 'local' || scope === 'worktree' || scope === SUBMODULE_SCOPE;
}

type RepoExecutingRule =
  | {
      match: RegExp;
      /** The override pairs that neutralise one matching entry. */
      neutralise: (entry: GitConfigEntry, m: RegExpMatchArray) => Array<readonly [string, string]>;
    }
  | {
      match: RegExp;
      /**
       * Stands in for `neutralise` where no override is SAFE — either because
       * none reaches the key at all, or because the neutral value itself
       * changes what git stores (see the content-filter rule). Returns the
       * reason the user is shown, or null to leave the entry running
       * untouched, which is how the well-known content filters keep working.
       *
       * `env` is the environment the real git call will run under. It is
       * here for the content-filter rule, which has to know the PATH the
       * shell git spawns would search — see isSafeContentFilterCommand().
       */
      refuse: (entry: GitConfigEntry, m: RegExpMatchArray, env: NodeJS.ProcessEnv) => string | null;
    };

/**
 * One POSIX shell word. Single quotes make every byte inside literal, and the
 * only escape a single-quoted string needs is for `'` itself. Used for the
 * diff-driver message below, whose text contains a key the REPOSITORY chose.
 */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A value the REPOSITORY chose, rendered for a one-line message.
 *
 * A config value may be megabytes long and may carry newlines (git accepts a
 * `\`-continued value), and these strings end up on the status line and in a
 * `printf` git runs through a shell. Folding the whitespace and capping the
 * length keeps the sentence a sentence; the user has the key and the
 * `--unset` either way, so nothing actionable is lost by truncating.
 */
function describeValue(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

/**
 * The `git config --unset` that actually reaches this entry.
 *
 * A plain `git config --unset <key>` writes the repository it is run in, so
 * for a key that came out of `.git/modules/<name>/config` it clears nothing
 * and exits 5 ("no such section") or 0 — and the user, who was told to run
 * it at the superproject, sees no error and meets the same refusal on the
 * next call. Reproduced against git 2.54. `-C <worktree>` is preferred over
 * `-f <file>` when the submodule is checked out: it is the form a user can
 * read without knowing where git hides a submodule's git directory.
 *
 * `--worktree` for a key in `config.worktree`, for the same reason and with
 * the same symptom: a plain `git config --unset` writes the LOCAL file, so
 * against a key that lives in `config.worktree` it exits 5 ("no such
 * section"), clears nothing, and the user meets the identical refusal on the
 * next call. Reproduced with git 2.54, both scopes. The `-f <file>` form
 * below needs no flag — it names the file outright.
 */
function unsetCommand(entry: GitConfigEntry): string {
  // `worktree` is how git's own `--show-scope` labels the superproject's
  // `.git/config.worktree`; the submodule pass has no scope word of its own
  // for it, so there the file it came from is what says which one it is.
  const worktreeScope =
    entry.scope === 'worktree' || entry.file?.endsWith(`${sep}config.worktree`) === true ? ' --worktree' : '';
  if (entry.scope !== SUBMODULE_SCOPE) return `git config${worktreeScope} --unset ${entry.key}`;
  if (entry.worktree) return `git -C ${entry.worktree} config${worktreeScope} --unset ${entry.key}`;
  return `git config -f ${entry.file} --unset ${entry.key}`;
}

/** Who set this entry, for "… the diff driver <this> configured in <key>". */
function describeSetter(entry: GitConfigEntry): string {
  if (entry.scope !== SUBMODULE_SCOPE) return 'this repository';
  if (entry.worktree) return `the submodule at ${entry.worktree}`;
  return `a submodule of this repository (${entry.file})`;
}

/** Whose config this entry is, for "<this> sets <key>, which git runs …". */
function describeConfig(entry: GitConfigEntry): string {
  if (entry.scope !== SUBMODULE_SCOPE) return "this repository's own git config";
  if (entry.worktree) return `the git config of the submodule at ${entry.worktree}`;
  return `the git config of a submodule of this repository (${entry.file})`;
}

/**
 * The value that replaces a repo-chosen `diff.external` / `diff.<d>.command`:
 * it names the key and the `git config --unset` that fixes it, then fails.
 *
 * `false` rather than `exit 1` because git appends the diff's pathnames —
 * `sh -c '<value> "$@"' <value> <path> <old> …` — and `exit` treats them as
 * extra operands, while `false` ignores them and still exits non-zero. Git
 * then stops with `fatal: external diff died`, exit 128, so nothing has
 * silently fallen back to git's own diff either.
 */
function diffDriverRefusalCommand(entry: GitConfigEntry): string {
  const message =
    `codeep: refusing to run the diff driver ${describeSetter(entry)} configured in ${entry.key}. ` +
    `Remove it (${unsetCommand(entry)}) if you trust this repository.`;
  return `printf '%s\\n' ${shellQuote(message)} >&2; false`;
}

/**
 * The value that replaces a repo-chosen alias: it says which alias, that
 * Codeep does not run repository-defined aliases, and what to run instead.
 *
 * The previous value was a bare `!false`, which exits 1 with nothing on
 * either stream — so an agent following a repository's own README (`git
 * sync`, `git st`) saw a command fail for no stated reason and had no way to
 * work out that Codeep had disabled it. Same shape as
 * diffDriverRefusalCommand() above, for the same reasons: git appends the
 * user's extra arguments to the alias body (`sh -c "<body> 'arg1'"`), and
 * `false` ignores operands while `exit` would choke on them.
 *
 * The leading `!` is what makes git treat the value as a shell command rather
 * than as git arguments. Both the alias NAME and its value are the
 * repository's own text and go through shellQuote() inside one single-quoted
 * message, for the reason the diff-driver rule spells out: otherwise the
 * warning is the injection.
 */
function aliasRefusalCommand(entry: GitConfigEntry, name: string): string {
  const value = entry.value;
  // A `!` alias is a shell line; anything else is spliced in front of git's
  // own arguments, so `alias.st = status -sb` means `git status -sb`. Saying
  // which one it is turns "run the plain git command instead" into something
  // the reader can actually act on.
  const defined = value.startsWith('!')
    ? `the shell command ${describeValue(value.slice(1))}`
    : `git ${describeValue(value)}`;
  const setter = describeSetter(entry);
  const message =
    `codeep: refusing to run 'git ${name}', an alias ${setter} defined in its own git config. ` +
    `Codeep disables repository-defined aliases; run the plain git command instead — ${setter} ` +
    `defines '${name}' as ${defined}. ` +
    `Remove it (${unsetCommand(entry)}) if you trust this repository.`;
  return `!printf '%s\\n' ${shellQuote(message)} >&2; false`;
}

/**
 * The exact `filter.<driver>.{clean,smudge,process}` command lines that the
 * well-known content-filter integrations write into a repository's own
 * config. A repo-scope filter whose value is one of these is left RUNNING;
 * every other one refuses the call (see the filter rule below).
 *
 * These are whole-value comparisons against a frozen list of literals, never
 * a prefix or a substring test, and that is the point rather than a detail.
 * Git runs a filter command through a shell, so `git-lfs clean -- %f; curl
 * https://…|sh` STARTS WITH an allowlisted line and would sail through a
 * `startsWith` check while doing something else entirely; `%f` in the middle
 * of a longer value is the same hole for a substring check. Whole-value
 * equality against literals also means "contains no shell metacharacter" is a
 * property of this list rather than something that has to be re-checked at
 * runtime — and the suite asserts that property so a future entry cannot
 * quietly break it.
 *
 * These are the values with the program named BARE. The same integrations
 * also spell the program as an absolute path, which is the machine's and not
 * a string this file can pin — see isSafeContentFilterCommand(), which takes
 * the basename apart and compares it against this same list.
 *
 * A spelling that is NOT accepted in any form: `"<abs path to python>" -m
 * nbstripout`, which newer nbstripout installers write. Its program is
 * `python`, so there is nothing to recognise in it — the argument tail is
 * what says what it will do, and pinning `-m nbstripout` would pin a
 * mechanism for running any module at all. Those repositories get the
 * refusal and its `--unset`, which is the fail-closed half of the policy
 * working as intended rather than an oversight.
 */
export const SAFE_CONTENT_FILTER_COMMANDS: ReadonlySet<string> = new Set([
  // `git lfs install` / `git lfs install --local`. `filter-process` is what
  // current git-lfs writes; `clean`/`smudge` are still written alongside it
  // for versions of git without the process filter.
  'git-lfs filter-process',
  'git-lfs filter-process --skip',
  'git-lfs clean -- %f',
  'git-lfs smudge -- %f',
  'git-lfs smudge --skip -- %f',
  // The same lines with the program name quoted — what git-lfs writes on
  // Windows, and what older versions wrote everywhere.
  '"git-lfs" filter-process',
  '"git-lfs" filter-process --skip',
  '"git-lfs" clean -- %f',
  '"git-lfs" smudge -- %f',
  '"git-lfs" smudge --skip -- %f',
  // `git-crypt init` writes the quoted spelling; the bare one is what a
  // hand-written or older config has. `diff` belongs to
  // `diff.git-crypt.textconv` rather than to a filter key, and is listed for
  // completeness — note that the textconv rule still replaces it with `cat`,
  // so a git-crypt diff shows ciphertext. That is a worse diff, not a lost
  // commit, and it is the same trade the textconv rule makes for everyone.
  'git-crypt clean',
  'git-crypt smudge',
  'git-crypt diff',
  '"git-crypt" clean',
  '"git-crypt" smudge',
  '"git-crypt" diff',
  // `git annex init` writes both of these into the repository's own config,
  // and an annex repository is refused without them: git-annex routes every
  // path in `.gitattributes` at `filter.annex`, so the refusal lands on the
  // ordinary `git status` behind the status line. `-- %f` is git-annex's own
  // spelling, placeholder included, exactly as git-lfs's lines above are.
  'git-annex smudge -- %f',
  'git-annex clean -- %f',
  // `nbstripout --install`, in the spelling that names the program directly.
  'nbstripout',
  // nbstripout's own smudge side, and git's documented identity filter. Left
  // out, an nbstripout repository would be refused over its `smudge` even
  // though its `clean` is allowlisted, which would make listing `nbstripout`
  // above pointless. `cat` is a program name with no metacharacters in it and
  // is exactly what `--no-textconv` does elsewhere in this file.
  'cat',
]);

/**
 * The bytes one word of an allowlisted command line may be spelled with.
 *
 * A whitelist of characters rather than a blacklist of shell metacharacters,
 * because git runs a filter command THROUGH A SHELL and the blacklist is the
 * one that has to be complete. Everything not named here stops the value
 * dead: `;` `&` `|` `$` a backtick, a quote, a newline, a tab — and also the
 * bytes that only look like the allowlisted ones, a U+00A0 no-break space or
 * a U+2011 non-breaking hyphen, which is what makes this the check that
 * answers homoglyphs rather than a separate one. `%` is here for git's own
 * `%f` placeholder and means nothing to sh. `~` is NOT: sh expands it at the
 * start of a word.
 */
const PLAIN_COMMAND_WORD = /^[A-Za-z0-9._\/%+:=@-]+$/;

/**
 * Whether a repo-scope `filter.<driver>.{clean,smudge,process}` value is one
 * of the well-known integrations — accepting the spelling that names the
 * program by an ABSOLUTE PATH, which the frozen list above cannot hold.
 *
 * `/usr/local/bin/git-lfs filter-process` is what a `git lfs install` writes
 * on a machine where git-lfs is not the one on PATH, and git-annex writes the
 * same shape. Those are ordinary working repositories, and the whole-value
 * list refused every git call in them — the fail-closed policy landing on the
 * integrations it was written to keep running.
 *
 * What is compared is the program's BASENAME plus the argument tail EXACTLY
 * as the literal spells it, so every property of the list survives the
 * relaxation. `/usr/local/bin/git-lfs clean -- %f; curl …|sh` fails on its
 * bytes before anything is compared; `… clean -- %f --extra` and `…
 * FILTER-PROCESS` produce a tail that is not in the list; a leading command
 * puts something other than an absolute path in the first word. There is no
 * prefix matching anywhere in here, in either half.
 *
 * And the path has to name the program PATH ALREADY RESOLVES that basename
 * to, which is the check that keeps this from being a way in. Without it the
 * repository picks the program: it ships an executable called `git-lfs` — or
 * `cat`, which is on the list with no arguments at all — points the filter at
 * its own checkout, and git runs it. That is not a relaxation of the
 * allowlist, it is the end of it. With it, an absolute path can only name the
 * same file the bare spelling on the list would have run anyway, so the
 * repository gains nothing by writing it out.
 *
 * `env` is the environment the REAL git call will run under, so the PATH
 * asked here is the PATH the shell git spawns would search.
 */
export function isSafeContentFilterCommand(value: string, env: NodeJS.ProcessEnv): boolean {
  if (SAFE_CONTENT_FILTER_COMMANDS.has(value)) return true;

  // Split on one ASCII space, never on `\s`: JS counts U+00A0 and the rest of
  // Unicode's spaces as whitespace and a shell does not, so `\s` would read
  // `git-lfs<NBSP>filter-process` as two words and compare a string the shell
  // will never see. Anything but a single plain space between words leaves an
  // empty word, or a word PLAIN_COMMAND_WORD rejects.
  const words = value.split(' ');
  if (!words.every(word => PLAIN_COMMAND_WORD.test(word))) return false;

  // Absolute only, and with no `..` in it — a relative program resolves
  // against the current directory, which in every call site here is the
  // repository's own working tree, and `..` is how an absolute path becomes
  // a relative one again.
  const program = words[0];
  const parts = program.split('/');
  if (parts[0] !== '' || parts.includes('..')) return false;

  const base = parts[parts.length - 1];
  if (!SAFE_CONTENT_FILTER_COMMANDS.has([base, ...words.slice(1)].join(' '))) return false;

  let target: string;
  try {
    target = realpathSync(program);
  } catch {
    // A path that is not there is not the program PATH resolves to either,
    // and git would fail on it anyway. Refusing says so with a sentence.
    return false;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      // realpath on both sides: a package manager's `bin` is usually a
      // symlink into its own store, so the two spellings of one program
      // rarely match as strings.
      if (realpathSync(join(dir, base)) === target) return true;
    } catch {
      // Not in this directory, or not readable through it — the next one
      // answers, and "none of them" is a no.
    }
  }
  return false;
}

/**
 * Why a repo-scope content filter stops the call, written for the user.
 *
 * It has to say four things, because each one is a step a user takes next:
 * which driver, what the repository asked git to run, the `--unset` that ends
 * it, and — for the commonest honest case — why a driver that routes nothing
 * in this checkout today is refused all the same. A leftover
 * `filter.nbstripout.*` from an `nbstripout --install` in a repository that
 * has since lost its notebooks is exactly that user, and without the third
 * sentence they read the refusal, see no `.gitattributes` naming the driver,
 * and conclude Codeep is simply wrong.
 *
 * The last sentence is the one that matters most — `git config
 * filter.<d>.required false` is the first hit for "clean filter failed", and
 * it is precisely the change that makes git accept a filter that did not run
 * and write the file's contents unfiltered.
 */
function contentFilterRefusal(entry: GitConfigEntry, driver: string): string {
  return (
    `${describeConfig(entry)} sets ${entry.key}, which git runs as a program for every file ` +
    `.gitattributes routes at the "${driver}" filter — here it runs: ${describeValue(entry.value)}. ` +
    `Remove it (${unsetCommand(entry)}) if you trust this repository. ` +
    `That is the fix even if nothing routes a path at "${driver}" in this checkout today: which paths ` +
    `git routes is decided by .gitattributes anywhere in the tree, by .git/info/attributes, and by ` +
    `attr.tree or --attr-source on a single command, so "nothing uses it" is not something Codeep can ` +
    `establish without re-implementing git's own attribute lookup — and it will not guess. ` +
    `Do NOT set filter.${driver}.required false to get past this: that makes git accept a filter that ` +
    `never ran and store the file's contents UNFILTERED, which for an encrypting filter means ` +
    `committing the plaintext.`
  );
}

/**
 * Keys a repository's own config can point at a program, and what neutralises
 * one. Matched against the key as `git config --list` prints it: git
 * lower-cases the section and the variable but preserves the subsection (the
 * driver/tool/remote name) verbatim, so the override has to be emitted with
 * git's own spelling rather than a reconstructed one.
 *
 * Every regex carries `i` for the same reason. `--list` prints
 * `core.sshcommand`, `gpg.ssh.defaultkeycommand` and `interactive.difffilter`,
 * so a rule spelled the way the git documentation spells it matches NOTHING —
 * which is how five rules here once shipped dead, with a repo-scope
 * `gpg.ssh.defaultKeyCommand` still running a script through createCommit.
 * `i` covers the subsection too, which is harmless: the capture still carries
 * git's own bytes, and those are what gets emitted.
 *
 * `GIT_CONFIG_*` cannot wildcard `filter.*`, which is why this is a scan and
 * not more entries in GIT_EXECUTING_CONFIG.
 */
const REPO_EXECUTING_RULES: ReadonlyArray<RepoExecutingRule> = [
  {
    // The blocker, and the one content rule that refuses instead of
    // neutralising. `filter.<driver>.clean` runs during the index refresh
    // that `git status` performs, as soon as a tracked `.gitattributes`
    // routes any file at the driver.
    //
    // Emptying the command is NOT a neutral act, because
    // `filter.<driver>.required` defaults to FALSE. With the command emptied
    // and `required` unset — the ordinary case, not an exotic one — git
    // treats the filter as having produced nothing, falls back to the file's
    // own bytes and stores them UNFILTERED. For an encrypting driver that is
    // the plaintext, committed, on the path every repository takes. And
    // emitting `required = false` ourselves to keep a REQUIRED filter from
    // aborting is the same incident on purpose, which is why nothing in this
    // file ever emits it.
    //
    // Leaving `required = true` alone was the previous answer, and it only
    // half-worked: git does abort there (`fatal: <f>: clean filter '<d>'
    // failed`), but with its own bare message, so Codeep's git integration
    // looked broken in exactly the repositories `git lfs install --local`,
    // `git-crypt init` and `nbstripout --install` produce — and the
    // workaround a user googles for that message is `git config
    // filter.<d>.required false`, which walks them into the plaintext commit.
    //
    // So: the well-known integrations are left running (see
    // SAFE_CONTENT_FILTER_COMMANDS), and anything else stops the call with a
    // sentence that names the driver and warns off that workaround. `required`
    // is never read and never written — the answer is the same either way.
    //
    // UNCONDITIONALLY, and that is a decision rather than an oversight. A
    // previous round relaxed this to "refuse only when some attributes file
    // routes a path at the driver", to spare the ordinary repository that
    // still carries a leftover `filter.nbstripout.*` from an `nbstripout
    // --install` and has since lost its notebooks. Answering that question
    // means re-implementing git's attribute resolution, and the copy missed
    // sources git honours: `.git/info/attributes` in a linked worktree,
    // `attr.tree`, `--attr-source`, and a path that is in the index but not
    // on disk. Each miss reads as "inert" and hands the repository arbitrary
    // execution back. A security hotfix is not where that reimplementation
    // gets written, so the check is gone and the refusal is flat: a
    // repo-scope content filter that is not one of the well-known
    // integrations stops the call whether or not anything routes a path at
    // it today. contentFilterRefusal() says so in the message, because the
    // leftover-config user is the one who meets it.
    match: /^filter\.(.+)\.(clean|smudge|process)$/i,
    refuse: (entry, m, env) =>
      isSafeContentFilterCommand(entry.value, env) ? null : contentFilterRefusal(entry, m[1]),
  },
  {
    // `.textconv` renders a file to text before diffing it; `.gitattributes`
    // picks the driver. `cat` is the faithful neutraliser — it is exactly
    // what `--no-textconv` does, the diff comes out as the raw bytes, and it
    // is a program name so no shell metacharacter in it means anything.
    // Emptying it instead broke the whole diff (`error: cannot run :` /
    // `fatal: unable to read files to diff`, exit 128) in every repository
    // that configures a textconv driver at all — a pdf/docx setup is an
    // ordinary thing to have, and `git diff` through execute_command stopped
    // working in it.
    match: /^diff\.(.+)\.textconv$/i,
    neutralise: entry => [[entry.key, 'cat']],
  },
  {
    // `diff.<driver>.command` replaces git's diff engine for the files
    // `.gitattributes` routes at it; `diff.external` does the same for every
    // unclaimed file. Neither has a neutral value — there is no stock program
    // that writes git's own diff — so these FAIL THE CALL CLOSED, which is
    // the right answer for a git command that reached a repo-chosen diff
    // driver at all.
    //
    // Emptying them made git print `error: cannot run :`, which names
    // nothing the user can act on. Git runs these values through a shell
    // (`sh -c '<value> "$@"' …`), so the value can say what happened instead
    // — and `false` swallows the pathnames git appends. The key is spliced
    // in single-quoted, because a `diff."…".command` subsection is the
    // REPOSITORY's text: anything less and the message would be the
    // injection. Git still stops with `fatal: external diff died`, exit 128.
    //
    // Codeep's own diff reads pass `--no-ext-diff --no-textconv` and never
    // get here; this covers `git diff` run through execute_command.
    match: /^diff\.((.+)\.command|external)$/i,
    neutralise: entry => [[entry.key, diffDriverRefusalCommand(entry)]],
  },
  {
    // A custom merge driver runs on every conflicting hunk. Emptying it makes
    // git print `error: cannot run :` and fall back to its built-in merge, so
    // the merge still completes (verified) — noisy, but not destructive.
    match: /^merge\.(.+)\.driver$/i,
    neutralise: entry => [[entry.key, '']],
  },
  {
    // Only reached by `git mergetool` / `git difftool`, which Codeep never
    // runs by itself — but the agent's execute_command can.
    match: /^(mergetool|difftool)\.(.+)\.cmd$/i,
    neutralise: entry => [[entry.key, '']],
  },
  {
    // The gpg cluster. `commit.gpgsign=true` plus a repo-local `gpg.program`
    // runs that program on EVERY commit Codeep makes. Emptying the program
    // alone fails the commit ("gpg failed to sign the data"), so signing is
    // switched off for this call instead: Codeep declines to sign rather than
    // sign through a program the repository chose. A user who signs from
    // their GLOBAL config never matches this rule and keeps signing — that
    // scope check is the whole reason this is safe to do.
    match: /^gpg\.(program|.+\.program|ssh\.defaultKeyCommand)$/i,
    neutralise: entry => [
      [entry.key, ''],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['tag.forceSignAnnotated', 'false'],
      ['merge.verifySignatures', 'false'],
    ],
  },
  {
    // `submodule.<name>.update = !command` runs on a recursing checkout.
    // `checkout` is git's own default, so this restores stock behaviour
    // instead of switching submodule recursion off for everyone (which is
    // what a blanket `submodule.recurse=false` would have done to a user who
    // deliberately turned it on).
    match: /^submodule\.(.+)\.update$/i,
    neutralise: entry => (entry.value.startsWith('!') ? [[entry.key, 'checkout']] : []),
  },
  {
    // EVERY repo-scope alias, not only the `!shell command` ones. An alias
    // runs whenever anything asks git for it by name — and "anything"
    // includes an agent following a README that says `git sync`.
    //
    // The `!` check was the hole: a non-`!` alias is spliced into argv in
    // front of the subcommand, so `alias.sync = -c core.fsmonitor=<program>
    // status` makes `git sync` re-enable a key this whole file switched off.
    // Proven with git 2.54 — under `GIT_CONFIG_KEY_0=core.fsmonitor
    // VALUE_0=false`, `git sync` ran the program anyway, because git's own
    // `-c` is read after the GIT_CONFIG_* pairs and wins. One `-c` undoes any
    // pair here, so scanning the alias VALUE for dangerous shapes would be a
    // guessing game against git's argv parser.
    //
    // A repository alias has no legitimate need to survive a Codeep-mediated
    // call: it is a shorthand its author typed into their own shell, never
    // something Codeep or a model has to invoke, and the user's own global
    // aliases are untouched by the scope check.
    //
    // The replacement SAYS SO rather than just failing. `!false` — what this
    // shipped as — exits 1 with empty stdout and empty stderr, so an agent
    // following a repository's own README (`git sync`, `git st`) saw a git
    // command fail with nothing to read and no way to reach "Codeep turned
    // that alias off, run the real command". Same message-printing shape the
    // diff-driver rule already uses, and it still exits 1, so nothing has
    // quietly succeeded either.
    match: /^alias\.(.+)$/i,
    neutralise: (entry, m) => [[entry.key, aliasRefusalCommand(entry, m[1])]],
  },
  {
    // A credential helper whose value starts with `!` is a shell command, run
    // on any authenticated remote operation. Handled specially below, because
    // helpers form a LIST and the only way to drop one entry is to reset the
    // list and re-add the ones worth keeping.
    match: /^credential\.(.+\.)?helper$/i,
    neutralise: () => [],
  },
  {
    // `core.sshCommand` and `core.gitProxy` are spawned to reach a remote;
    // `core.askPass` is spawned to ask for a password. Global values belong to
    // the user's working `git push` and are left alone.
    match: /^core\.(sshCommand|askPass|gitProxy)$/i,
    neutralise: entry => [[entry.key, '']],
  },
  {
    // `remote.<name>.uploadpack` / `.receivepack` name the program git runs
    // at the far end of a fetch or a push — and for a `file://` remote or a
    // plain path, the far end is this machine. Proven with git 2.54 through
    // the hardened executeCommand path: the uploadpack script ran on `git
    // fetch`, the receivepack script on `git push`.
    //
    // This is the one key here that no override reaches. git's remote.c keeps
    // the FIRST value it sees ("more than one uploadpack given, using the
    // first"), and repository config is read before `-c` / `GIT_CONFIG_*` —
    // verified: with the repo value in place, an environment override, a `-c`
    // override and GIT_CONFIG_PARAMETERS all lost, and only the
    // `--upload-pack` command-line flag won, which is not ours to pass. So
    // the call is refused instead.
    //
    // Refused for every git command, not only the ones that reach a remote:
    // hardenedGitEnv() never sees the argv, and narrowing by the remote's URL
    // (a local path and `file://` are the transports that run it here) is
    // defeated by a `url.<base>.insteadOf` that rewrites an ssh URL into a
    // local path. A setup that genuinely needs a custom upload-pack can say
    // so in the user's global config, where it is not the repository talking.
    //
    // Reviewed alongside these and deliberately absent: `remote.<name>.proxy`
    // and `http.proxy` are URLs rather than programs; `core.gitProxy`,
    // `core.sshCommand` and `credential.helper` have their own rules here;
    // `protocol.ext.allow` and `uploadpack.packObjectsHook` are always-on
    // pairs; and `remote.<name>.vcs` only selects a `git-remote-<vcs>` that
    // must already be on PATH, which a repository cannot put there.
    match: /^remote\..+\.(uploadpack|receivepack)$/i,
    refuse: entry =>
      `${describeConfig(entry)} sets ${entry.key}, which git runs as a program on fetch and push. ` +
      'Git keeps the first value it sees for that key, so no environment override can switch it off. ' +
      `Remove it (${unsetCommand(entry)}) if you trust this repository.`,
  },
  {
    // Piped over the diff that `git add -p` and friends show.
    match: /^interactive\.diffFilter$/i,
    neutralise: entry => [[entry.key, '']],
  },
  {
    // Run by `git interpret-trailers` and by `git commit --trailer`.
    match: /^trailer\.(.+)\.(cmd|command)$/i,
    neutralise: entry => [[entry.key, '']],
  },
];

/** Matches every key the credential-helper rule owns. */
const CREDENTIAL_HELPER_KEY = /^credential\.(.+\.)?helper$/i;

/**
 * Whether `<key>=<value>` is a config key that makes git RUN a program.
 *
 * Exported for utils/shell.ts, which has to answer the same question about a
 * `git -c <key>=<value>` an agent typed. Keeping one answer is the point:
 * these are exactly the keys this file spends its length neutralising, and a
 * second hand-written list in the command validator would drift away from
 * this one the first time a rule is added here.
 *
 * Both halves matter. GIT_EXECUTING_CONFIG is the always-on set, so a `-c
 * core.fsmonitor=<program>` would otherwise WIN — git reads its own `-c`
 * after the GIT_CONFIG_* pairs (verified, git 2.54). REPO_EXECUTING_RULES is
 * the scope-aware set, and `-c` is not a scope the scan can see at all.
 */
export function isExecutingConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (GIT_EXECUTING_CONFIG.some(([name]) => name.toLowerCase() === lower)) return true;
  return REPO_EXECUTING_RULES.some(rule => rule.match.test(key));
}

/** An absent value, kept out of the parse loop below. */
const NO_BYTES = Buffer.alloc(0);

/** Split a NUL-delimited stream at the BYTE level, without decoding first. */
function splitOnNul(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nul = buf.indexOf(0, start);
    if (nul === -1) {
      parts.push(buf.subarray(start));
      return parts;
    }
    parts.push(buf.subarray(start, nul));
    start = nul + 1;
  }
}

/**
 * Decode one config field, and say whether it survives the trip back.
 *
 * Decoding the whole scan as UTF-8 is what let an invalid-UTF-8 subsection
 * through: a filter driver named with raw non-UTF-8 bytes came back as U+FFFD,
 * the override was emitted under the replacement characters, git matched it
 * against nothing, and the clean filter ran (proven with a marker). Since the
 * replacement is lossy and an environment variable is UTF-8 either way, the
 * only honest answers are "emit git's own bytes" and "refuse".
 */
function decodeExact(bytes: Buffer): { text: string; exact: boolean } {
  const text = bytes.toString('utf-8');
  return { text, exact: Buffer.from(text, 'utf-8').equals(bytes) };
}

/**
 * Read the config git will actually use for a call in `cwd`, under the
 * environment that call will run with, so the scan and the call agree on
 * which repository and which files they are talking about.
 *
 * `git config --list` itself runs no filter, no hook and no fsmonitor
 * (verified), so this is safe to do before the hardening is complete.
 *
 * Returns null only when git never started — there is then nothing to
 * neutralise, because the real call cannot start either. Every other failure
 * means the scan began and did not finish, and that one THROWS: the caller
 * must not run git with a half-built environment.
 */
function listGitConfig(cwd: string, env: NodeJS.ProcessEnv): GitConfigEntry[] | null {
  let out: Buffer;
  try {
    out = execFileSync('git', ['config', '--list', '-z', '--show-scope'], {
      cwd,
      env,
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      // stderr is piped rather than inherited so a `fatal: bad config line`
      // reaches the message below instead of the middle of the TUI.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // No git on PATH, no such `cwd`, no permission to enter it: git never
    // ran, and the real call is about to fail in exactly the same way, so
    // there was nothing here for the scan to protect. Everything else —
    // ENOBUFS on an oversized config, ETIMEDOUT, a config file git refuses to
    // parse (exit 128) — means the scan started and did not finish. That was
    // the fail-open hole, and it now stops the call.
    const err = error as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string };
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'ENOTDIR') return null;
    const detail = String(err.stderr ?? '').trim() || err.code || `exit ${err.status ?? '?'}`;
    throw refuse(
      cwd,
      `its git config could not be read (${detail}), so Codeep cannot tell whether that config ` +
        'names a program for git to run.'
    );
  }

  return parseConfigList(out);
}

/** How `--show-origin` spells a config file. Anything else it can print —
 *  `command line:`, `standard input:`, `blob:<sha>` — is not a file we can
 *  point a `git config -f` at, so it is dropped rather than guessed at. */
const ORIGIN_FILE_PREFIX = 'file:';

/**
 * `<scope>\0<key>\n<value>\0` per entry, split on BYTES, or
 * `<scope>\0<origin>\0<key>\n<value>\0` when the call passed `--show-origin`.
 * A value may itself contain a newline, so the key ends at the FIRST one; a
 * valueless key (`[section] key` with no `=`) has no newline at all.
 */
function parseConfigList(out: Buffer, withOrigin: boolean = false): GitConfigEntry[] {
  const parts = splitOnNul(out);
  const stride = withOrigin ? 3 : 2;
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i + stride - 1 < parts.length; i += stride) {
    const record = parts[i + stride - 1];
    const nl = record.indexOf(0x0a);
    const key = decodeExact(nl === -1 ? record : record.subarray(0, nl));
    const value = decodeExact(nl === -1 ? NO_BYTES : record.subarray(nl + 1));
    const origin = withOrigin ? parts[i + 1].toString('utf-8') : '';
    entries.push({
      scope: parts[i].toString('utf-8'),
      key: key.text,
      keyExact: key.exact,
      value: value.text,
      valueExact: value.exact,
      file: origin.startsWith(ORIGIN_FILE_PREFIX) ? origin.slice(ORIGIN_FILE_PREFIX.length) : undefined,
    });
  }
  return entries;
}

/**
 * How many submodule configs one call will read, and how far the enumeration
 * follows submodules of submodules.
 *
 * Both are bounds on a tree the REPOSITORY owns — a checkout can declare as
 * many submodules, nested as deeply, as whoever prepared it liked. Past
 * either one the call is REFUSED rather than partly scanned: "we looked at
 * some of your submodules" is a fail-open dressed as a limit. Every other
 * bound in this pass throws for the same reason, which is the half that used
 * to be missing — the depth guard and the directory-read failure both used
 * to `return`, so a tree nested one level too deep, or a `.git/modules` we
 * had no permission to read, silently became "this repository has no
 * submodules".
 *
 * The count was 512, and that was a wall rather than a backstop: a
 * superproject past it was refused forever, with a message naming nothing
 * the user could change. 2048 is an order of magnitude past the largest real
 * superproject, so only a tree built to reach it does. It is not raised
 * further because every config read is one more `-c include.path=` argument
 * on one command line, and a Windows command line stops at 32KB; and the
 * message now names the two things that get the user moving again.
 */
export const MAX_SUBMODULE_CONFIGS = 2048;
const MAX_SUBMODULE_DEPTH = 16;

/** Where a repository keeps the things this pass has to look at. */
interface GitLayout {
  /**
   * `--git-common-dir`, i.e. the directory that holds `modules/<name>`.
   * Not `--git-dir`: in a linked worktree the per-worktree git dir has no
   * `modules/` of its own and the submodules hang off the shared one.
   */
  commonDir: string;
  /** `--show-toplevel`, or null in a bare repository — where there is no
   *  index of gitlinks to read and no `.gitattributes` on disk. */
  topLevel: string | null;
}

/**
 * The layout of the repository at `cwd`, or null when there is not one.
 *
 * The fast path is two `statSync`s: every caller inside Codeep passes the
 * project ROOT, where `.git` is a directory sitting right there, so the usual
 * case costs no child process at all — measured, it adds nothing to a
 * hardened env in a plain repository at its root.
 *
 * Only the other shapes — a `cwd` below the root, a linked worktree, a
 * submodule, where `.git` is a FILE or is not there at all — have to ask git,
 * and that is one extra child, ~7ms, measured. Walking up
 * for a `.git` ourselves would save it and would also be a second, worse copy
 * of git's discovery rules (ceiling directories, `GIT_DIR`, worktree links),
 * so git answers instead. The hot callers — the status line, /commit, the
 * review path — all pass the root and never pay it; what does is an
 * `execute_command` whose cwd is a subdirectory, once, on a command the user
 * approved.
 *
 * `--show-toplevel` rides along in that same child rather than costing
 * another. It fails outright in a bare repository ("this operation must be
 * run in a work tree") and would take `--git-common-dir` down with it, so
 * that case asks again without it.
 */
function gitLayout(cwd: string, env: NodeJS.ProcessEnv): GitLayout | null {
  const here = join(cwd, '.git');
  try {
    // `isDirectory()` is not proof that there is a repository here, and
    // taking it as proof made the layout name the wrong root. ANY directory
    // can be called `.git` — one `mkdir sub/.git` inside a real checkout is
    // the whole thing — and a half-built or half-deleted git directory has
    // the same shape. The layout then said `cwd` was the top level, so
    // indexGitlinkPaths listed the REAL repository's index (git finds it by
    // walking up from `cwd`) with paths relative to a root that is not this
    // one: every gitlink resolved to a directory that is not there, and
    // gitDirOfWorktree dropped the lot. The submodule enumeration skipped
    // silently while git, run from that same subdirectory, still ran the
    // submodule's `filter.<d>.clean` on a plain `git status` — reproduced,
    // git 2.54. `commonDir` was equally wrong, so `<commonDir>/modules` found
    // nothing either.
    //
    // `HEAD` is git's own cheapest proof: validate_headref() is what setup.c
    // calls before it will treat a directory as a git directory, and one more
    // `statSync` keeps the fast path a fast path. This APPROXIMATES that
    // function — git also wants `objects/` and `refs/`, and reads what HEAD
    // contains — and it does not have to be exact, because being wrong in
    // this direction costs correctness and not safety: everything not
    // accepted here falls through to the `git rev-parse` below, which answers
    // for every shape (a linked worktree, a submodule, a `cwd` below the
    // root, and the fake `.git` above — where it names the real repository).
    if (statSync(here).isDirectory() && statSync(join(here, 'HEAD')).isFile()) {
      return { commonDir: here, topLevel: cwd };
    }
  } catch {
    // Not there, not readable, or no HEAD — fall through and let git answer.
  }

  const ask = (flags: string[]): string[] | null => {
    try {
      return execFileSync('git', ['rev-parse', ...flags], {
        cwd,
        env,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: SCAN_MAX_BUFFER,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .split('\n')
        .map(line => line.trim());
    } catch {
      return null;
    }
  };

  // git prints the common dir relative to `cwd` when it can.
  const both = ask(['--git-common-dir', '--show-toplevel']);
  if (both?.[0]) {
    return { commonDir: resolve(cwd, both[0]), topLevel: both[1] ? resolve(cwd, both[1]) : null };
  }
  const bare = ask(['--git-common-dir']);
  if (bare?.[0]) return { commonDir: resolve(cwd, bare[0]), topLevel: null };

  // git said "not a git repository", or never started. Either way the real
  // call cannot run here either, so there is no submodule of ours to scan —
  // the same reasoning listGitConfig() applies to its own null.
  return null;
}

/**
 * `submodule.<name>.<var>` — what git writes into the CONTAINING repository's
 * own config for every submodule it has initialised (`git submodule add` and
 * `git submodule update --init` both leave `submodule.<name>.url` and
 * `.active` behind). That record is why the enumeration below needs no
 * directory walk to find `<common>/modules/<name>`.
 *
 * The keys with no subsection — `submodule.recurse`, `submodule.active`,
 * `submodule.fetchJobs` — need a second dot to match and do not.
 */
const SUBMODULE_NAME_KEY = /^submodule\.(.+)\.[^.]+$/i;

/**
 * The config files a submodule's git directory can carry, both of which git
 * reads for a call inside that submodule.
 *
 * `config.worktree` was the hole: it sits in the git directory exactly as
 * `config` does, git honours it as scope `worktree` the moment the repository
 * sets `extensions.worktreeConfig`, and the pass below read only `config` —
 * so a `filter.<d>.clean` written with `git config --worktree` inside a
 * submodule survived the whole scan. It is the same file the isRepoScope()
 * note is about, one level down.
 *
 * Read UNCONDITIONALLY rather than only when `extensions.worktreeConfig` is
 * on. Deciding that would mean picking, out of one merged `--show-origin`
 * listing, which repository's `extensions.worktreeConfig` belongs to which
 * `config.worktree` — and getting the pairing wrong fails OPEN, which is the
 * direction this pass never goes. Reading a `config.worktree` that git is
 * currently ignoring can only over-refuse, and the `--unset` in the message
 * still names the file that has the key in it.
 */
const SUBMODULE_CONFIG_FILES = ['config', 'config.worktree'] as const;

/** Every submodule name these entries record, de-duplicated. */
function submoduleNames(entries: readonly GitConfigEntry[], cwd: string): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const m = entry.key.match(SUBMODULE_NAME_KEY);
    if (!m) continue;
    // The name becomes a path component below, and a name whose bytes do not
    // survive the round trip is one we cannot open — so the honest answers
    // are the same two decodeExact() leaves everywhere else, and "skip it"
    // is not one of them.
    if (!entry.keyExact) {
      throw refuse(
        cwd,
        'its git config names a submodule whose name is not valid UTF-8, so Codeep cannot open that ' +
          "submodule to check whether its own config names a program for git to run."
      );
    }
    names.add(m[1]);
  }
  return [...names];
}

/**
 * `root` joined with `parts`, but only when the result stays under `root`.
 *
 * A submodule NAME comes out of a config file the repository wrote and a
 * submodule PATH out of its index, so `../../..` is something either of them
 * can say. git validates both itself — that is what CVE-2018-11235 was — and
 * this is the same check on our side: everything this pass opens has to be
 * under the directory it claims to be under.
 */
function containedPath(root: string, part: string): string | null {
  const full = resolve(root, part);
  const rel = relative(root, full);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
}

/** `gitdir: <path>` — how a submodule's `.git` FILE names its real git dir. */
const GITDIR_POINTER = /^gitdir:\s*(.*?)\s*$/;

/**
 * The git directory of the checkout at `worktree`, resolved the way git
 * resolves it, or null when there is not one there.
 *
 * Both shapes are real and both escaped the `.git/modules` walk this
 * replaced. Reproduced with git 2.54, each with a `filter.<d>.clean` that
 * FIRED on the superproject's own `git status --porcelain`:
 *
 * - `.git` is a DIRECTORY. `git submodule add <url> <path>` over a path that
 *   is already a checkout answers "Adding existing repo at '<path>' to the
 *   index" and leaves the embedded git directory exactly where it is, so
 *   `<common>/modules` is never even created.
 * - `.git` is a FILE naming a git directory elsewhere. Absorbed submodules
 *   point at `<common>/modules/<name>`, and nothing stops a prepared
 *   checkout from pointing one somewhere else.
 */
function gitDirOfWorktree(worktree: string, cwd: string): string | null {
  const dot = join(worktree, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Not checked out is an ordinary state, and `<common>/modules/<name>` is
    // then the only git dir there is. Anything else — EACCES, EIO, a symlink
    // loop — means git can read something we cannot, and answering "no
    // submodule here" to that is the fail-open this whole pass is removing.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw refuse(
      cwd,
      `the submodule at ${worktree} could not be read (${err.code ?? 'unknown error'}), so Codeep ` +
        'cannot tell whether its git config names a program for git to run.'
    );
  }

  if (stat.isDirectory()) return dot;
  if (!stat.isFile()) return null;

  let text: string;
  try {
    text = readFileSync(dot, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw refuse(
      cwd,
      `the .git file of the submodule at ${worktree} could not be read (${err.code ?? 'unknown error'}), ` +
        'so Codeep cannot tell whether its git config names a program for git to run.'
    );
  }
  const pointer = text.split('\n')[0].match(GITDIR_POINTER);
  return pointer?.[1] ? resolve(worktree, pointer[1]) : null;
}

/** The index mode of a gitlink — the entry `git status` descends into. */
const GITLINK_MODE = '160000';

/**
 * Whether git will serve this directory as a working tree at all.
 *
 * Only ever asked once something else has already failed, so it is a child
 * process on the error path and nothing on the ordinary one. It answers the
 * narrow question "can any git command run here?", which is what separates a
 * repository Codeep should refuse from one where there is nothing to refuse
 * over because git itself has walked away.
 */
function gitServesWorkTree(dir: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        env,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: SCAN_MAX_BUFFER,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/**
 * Every path this repository's INDEX records as a submodule.
 *
 * The index is the authoritative list, and the reason this is not driven by
 * `.gitmodules`: git descends into a path — and runs that checkout's
 * `filter.<d>.clean` on the automatic `git status` behind the status line —
 * because the INDEX says the path is a gitlink, not because `.gitmodules`
 * mentions it. Reproduced with git 2.54: a gitlink added with a plain
 * `git add`, with no `.gitmodules` entry and no `submodule.<name>.url`
 * anywhere, still fired the embedded checkout's clean filter. An enumeration
 * built on `.gitmodules` would have been a fix an attacker undoes by
 * deleting one line.
 *
 * `--abbrev=4` because the object names are 40 bytes each and nothing here
 * reads them: on a 100k-entry index that is 2.7MB of output instead of
 * 6.3MB, and this has to fit in INDEX_MAX_BUFFER. `-- :/` with `--full-name`
 * so the answer is the whole repository, root-relative, whatever `cwd` the
 * call came in with.
 *
 * `git ls-files` refreshes nothing, so it runs no filter and no fsmonitor
 * (verified against a marker, git 2.54) — safe to run before the hardening
 * is complete, exactly as `git config --list` is.
 */
function indexGitlinkPaths(top: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  let out: Buffer;
  try {
    out = execFileSync('git', ['ls-files', '-s', '-z', '--full-name', '--abbrev=4', '--', ':/'], {
      cwd: top,
      env,
      timeout: SCAN_TIMEOUT_MS,
      // NOT the scan's buffer: this one is sized by how many files the
      // repository has, not by what an attacker padded. See INDEX_MAX_BUFFER.
      maxBuffer: INDEX_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Two different failures arrive here with the same exit code, and only
    // one of them is ours to refuse over.
    //
    // git may be declining to serve this repository AT ALL — a
    // `core.repositoryformatversion` it does not understand, a `.git` that is
    // a directory but not a git directory, a config file it will not parse.
    // `git config --list` survives some of those (the version case only
    // warns, exit 0), and gitLayout's fast path is a pair of `statSync`s
    // rather than a question to git, so the scan gets this far and then meets
    // a git that will not read an index. The REAL call cannot run in such a
    // repository either, so there is no filter to neutralise and no submodule to find —
    // the same reasoning listGitConfig() applies to its own null. Refusing
    // instead turned every one of them into a hardening refusal about a
    // submodule scan the user has nothing to do with, and replaced the "git
    // failed to answer" that keeps the hook write gate in
    // utils/toolExecution.ts switched ON.
    //
    // So git is asked one more question, on the error path only, where it
    // costs nothing in the ordinary case: does it consider this a working
    // tree? A `no` means nothing runs here. A `yes` means git serves the
    // repository and still would not list its index — ENOBUFS on an oversized
    // one, a timeout — and that is the shape this has to fail closed on,
    // because the real call WILL run.
    if (!gitServesWorkTree(top, env)) return [];
    const err = error as NodeJS.ErrnoException & {
      status?: number;
      stderr?: Buffer | string;
      killed?: boolean;
    };
    const detail = String(err.stderr ?? '').trim() || err.code || `exit ${err.status ?? '?'}`;
    // A read that ran out of room or out of time is OUR limit, and saying so
    // is the difference between a sentence a user can act on and one that
    // accuses their repository of something. The old text did the latter for
    // both: the reader was told Codeep could not tell what its directories
    // are, in the one wording this file uses for a hostile config, over a
    // monorepo whose only crime was having files in it. INDEX_MAX_BUFFER is
    // what makes this unreachable for a real repository; this is what it
    // reads like if it is ever reached anyway.
    //
    // It still stops the call. A gitlink the enumeration never saw is a
    // submodule whose own git config was never checked, and the real git call
    // WILL descend into it — which is the whole reason this pass exists. So
    // the honest answer is "Codeep could not check", not "there was nothing
    // to check", and it names a way forward that does not involve deleting
    // anything.
    const killed = err.killed === true || err.code === 'ETIMEDOUT';
    if (err.code === 'ENOBUFS' || killed) {
      throw refuse(
        cwd,
        `its index is too large for Codeep to list in one read (${detail}). Nothing in this repository ` +
          'is wrong and there is no config key to remove — Codeep enumerates the index to find the ' +
          'submodules git descends into, whose own git config can name a program for git to run, and it ' +
          'will not run git here having read only part of that list. Run git in the directory you meant ' +
          'instead (git -C <path> …).'
      );
    }
    throw refuse(
      cwd,
      `its index could not be listed (${detail}), so Codeep cannot tell which of its directories are ` +
        'submodules whose own git config may name a program for git to run.'
    );
  }

  const paths: string[] = [];
  for (const record of splitOnNul(out)) {
    // `<mode> <object> <stage>\t<path>`. A path may contain anything but NUL,
    // including a tab, so it starts at the FIRST one.
    const tab = record.indexOf(0x09);
    if (tab === -1) continue;
    if (!record.subarray(0, tab).toString('utf-8').startsWith(`${GITLINK_MODE} `)) continue;
    const path = decodeExact(record.subarray(tab + 1));
    if (!path.exact) {
      throw refuse(
        cwd,
        'one of its submodule paths is not valid UTF-8, so Codeep cannot open that submodule to check ' +
          'whether its git config names a program for git to run.'
      );
    }
    paths.push(path.text);
  }
  return paths;
}

/**
 * Read a batch of config FILES in one git child, as `command`-scope entries
 * that carry the file each came from.
 *
 * `-c include.path=<file>` is what makes this ONE child for any number of
 * files: git reads every named file in the same process and reports their
 * entries under scope `command`. The alternative, a child per submodule,
 * measured 342ms on a 50-submodule fixture — on every status refresh.
 *
 * `--show-origin` is not decoration. Without it every entry in the merged
 * output looks like the superproject's, and a refusal then names the
 * superproject and prints a `git config --unset` that silently does nothing
 * there (see unsetCommand).
 *
 * `GIT_CONFIG_COUNT=0` on this child is load-bearing: our own overrides ride
 * in the environment as GIT_CONFIG_* pairs and git reports THOSE as scope
 * `command` too, so without it the pass would read back and re-neutralise
 * Codeep's own work.
 */
function readConfigFiles(cwd: string, env: NodeJS.ProcessEnv, files: string[]): GitConfigEntry[] {
  // The `-c` pairs are git's own GLOBAL options and have to come before the
  // subcommand — after it, git 2.54 answers "unknown switch `c'". A missing
  // or unreadable include is silently skipped (verified, 2.54), so a
  // submodule directory that lost its config between the stat and here does
  // not fail the call.
  const args: string[] = [];
  for (const file of files) args.push('-c', `include.path=${file}`);
  args.push('config', '--list', '-z', '--show-scope', '--show-origin', '--includes');

  let out: Buffer;
  try {
    out = execFileSync('git', args, {
      cwd,
      env: { ...env, GIT_CONFIG_COUNT: '0' },
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // The scan reached the point of knowing there ARE submodule configs and
    // then could not read them, so this fails the call for the same reason
    // listGitConfig() does — a half-read config is how the repo-scope layer
    // silently switched itself off before.
    const err = error as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string };
    const detail = String(err.stderr ?? '').trim() || err.code || `exit ${err.status ?? '?'}`;
    throw refuse(
      cwd,
      `the git config of its submodules could not be read (${detail}), so Codeep cannot tell whether ` +
        'one of them names a program for git to run.'
    );
  }

  return (
    parseConfigList(out, true)
      // `command` is what git reports for everything reached through our own
      // `-c include.path`. Any `local` / `global` / `system` entry here
      // belongs to the superproject or the user and is already handled by the
      // main scan, so taking only `command` keeps this pass to the submodules.
      .filter(entry => entry.scope === 'command')
      // The `include.path` pseudo-entries are Codeep's own argv coming back.
      .filter(entry => entry.key.toLowerCase() !== 'include.path')
  );
}

/**
 * The config of every submodule of the repository at `cwd`, as repo-supplied
 * entries that carry the file — and, where we know it, the working tree —
 * they came from.
 *
 * THE HOLE THIS CLOSES: a submodule's settings live in its own git config,
 * and `git config --list --show-scope` run at the superproject never prints
 * a single one of them. A `filter.<d>.clean` there still runs on the
 * automatic `git status` behind the status line — proven with git 2.54, the
 * superproject's `git status --porcelain` fired the submodule's clean filter
 * while the superproject's own config was spotless. The overrides themselves
 * do reach it: the same `git status` with `GIT_CONFIG_KEY_0=filter.<d>.clean`
 * left the trap cold.
 *
 * HOW THE SUBMODULES ARE FOUND, and why not by walking `.git/modules`, which
 * is what this shipped as. Three real layouts escaped that walk — each
 * reproduced against git 2.54 with a hostile `filter.<d>.clean` that FIRED on
 * the superproject's own `git status --porcelain` while the walk reported
 * nothing to scan:
 *
 * - an EMBEDDED git directory. `git submodule add` over a path that is
 *   already a checkout leaves `<path>/.git` a real directory and never
 *   creates `.git/modules` at all.
 * - a `.git` FILE repointed at a git directory outside `.git/modules`.
 * - a DECOY `config` at an intermediate level of a slashed submodule name:
 *   one `touch .git/modules/vendor/config` hid `.git/modules/vendor/lib/
 *   config` from a walk that stopped descending at the first `config` it
 *   found. Writing one file is the whole attack.
 *
 * So the submodules are enumerated the way git itself records them, and the
 * two records between them cover all three:
 * - the INDEX's gitlinks (mode 160000) are the paths git descends into, and
 *   each path's own `.git` gives its real git directory, wherever that is;
 * - `submodule.<name>.*` in the containing repository's config gives the
 *   names git maps to `<common>/modules/<name>`, which is what covers a
 *   submodule that is initialised but not checked out. A name is a direct
 *   lookup, so nothing planted alongside it can hide it.
 * Nesting is followed by repeating the second source inside each config just
 * read — a submodule of a submodule is recorded in ITS parent's config, and
 * git puts it under `<that git dir>/modules/<name>`.
 *
 * A symlinked `.git/modules/<name>` is no longer a special case: the walk
 * used to SKIP one (`isDirectory()` is false for a symlink) and the
 * submodule behind it ran unscanned — reproduced. A name lookup opens it
 * exactly as git does, which is the right answer rather than a refusal.
 *
 * THE INDEX IS ALWAYS READ, and that is the fix this round makes. There used
 * to be a gate in front of it — run `git ls-files` only when the config named
 * a submodule, or `.git/modules` existed, or the working tree had a
 * `.gitmodules` — which skipped the very enumeration the rest of this
 * function is built on. A gitlink added with a plain `git add`, with no
 * `.gitmodules` and no `submodule.<name>.*` anywhere, leaves none of those
 * three signals, and git still descends into it and still runs that
 * checkout's `filter.<d>.clean` on the superproject's own `git status`
 * (reproduced, git 2.54). The gate was the one place that shape survived, so
 * it is gone: wherever there is a working tree, the index is enumerated.
 *
 * WHAT IS STILL NOT REACHED, named rather than implied: a NESTED submodule
 * that itself uses one of the two non-standard layouts above. Resolving
 * those needs the inner repository's index, and that is one child process
 * per submodule — the cost this pass exists to avoid. The shape git writes
 * by itself, `<common>/modules/<outer>/modules/<inner>`, is covered.
 *
 * WHAT IT COSTS, since this runs on every hardened git call. Measured here
 * against git 2.54, per hardenedGitEnv() call, at the repository root, as
 * the median of 15:
 * - No submodules, 307 files (this repository): 13.6ms, of which 7.0ms is
 *   the `git config --list` that was already there and 6.6ms is the
 *   `git ls-files` the gate used to skip. 10k files: 16.8ms.
 * - 100k files, still no submodules: 47.7ms. That is the honest worst case
 *   and it is the index, not the submodules — `git ls-files -s` writes 3MB
 *   there. `--abbrev=4` already trims it; `--format=%(objectmode) %(path)`
 *   would save 2ms more and was left alone because it needs git ≥ 2.38 and
 *   this is a hotfix.
 * - 1 submodule: 19.7ms. 10: 21.5ms. 50: 28.3ms. Near-flat in the submodule
 *   count, because it is ONE `git ls-files` plus ONE `git config --list` for
 *   ALL of them however many there are. The alternative, a child per
 *   submodule, measured 342ms on the same 50-submodule fixture.
 *
 * So the check is memoised per call and not cached across calls: one
 * `git ls-files` per hardenedGitEnv(), which is why that function's own note
 * says to build the environment ONCE and hand the same object to every spawn
 * inside it. A cache that outlived the call would have to be invalidated on
 * the index changing, and the only cheap signal for that is `.git/index`'s
 * mtime — which is coarse enough to miss a write inside the same tick. Being
 * wrong there means running git against a gitlink this pass never opened,
 * which is the failure the gate above was just deleted for.
 */
function listSubmoduleConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  scanned: readonly GitConfigEntry[],
  layout: GitLayout | null
): GitConfigEntry[] {
  if (!layout) return [];
  const { commonDir, topLevel } = layout;
  const modulesRoot = join(commonDir, 'modules');

  const names = submoduleNames(scanned, cwd);

  /** Each config file's working tree, for the refusal text. */
  const worktrees = new Map<string, string>();
  const roots: string[] = [];
  const addGitDir = (dir: string, worktree?: string): void => {
    roots.push(dir);
    if (worktree) for (const name of SUBMODULE_CONFIG_FILES) worktrees.set(join(dir, name), worktree);
  };

  for (const name of names) {
    const dir = containedPath(modulesRoot, name);
    if (!dir) {
      throw refuse(
        cwd,
        `its git config names a submodule ("${describeValue(name)}") whose git directory would sit ` +
          'outside .git/modules. Codeep will not follow that.'
      );
    }
    addGitDir(dir);
  }
  if (topLevel !== null) {
    for (const path of indexGitlinkPaths(topLevel, cwd, env)) {
      const worktree = containedPath(topLevel, path);
      if (!worktree) {
        throw refuse(
          cwd,
          `its index records a submodule at "${describeValue(path)}", which is outside the repository. ` +
            'Codeep will not follow that.'
        );
      }
      const dir = gitDirOfWorktree(worktree, cwd);
      if (dir) addGitDir(dir, worktree);
    }
  }

  const entries: GitConfigEntry[] = [];
  /** Config files already read, by real path, so a symlink that aliases one
   *  git directory onto another does not send the rounds below in a circle. */
  const read = new Set<string>();
  /** Git directories this call has read a config out of, for the count cap. */
  let scannedDirs = 0;
  let frontier = roots;

  for (let depth = 0; ; depth++) {
    const files: string[] = [];
    const dirs: string[] = [];
    for (const dir of frontier) {
      let any = false;
      for (const name of SUBMODULE_CONFIG_FILES) {
        const file = join(dir, name);
        // Not `existsSync`, which answers false for a file it has no
        // PERMISSION to look at — so one `chmod 000` on a submodule's git
        // directory used to turn its config into "there is no submodule here",
        // silently, while git went on reading it perfectly well.
        try {
          if (!statSync(file).isFile()) continue;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
          throw refuse(
            cwd,
            `the git config of its submodule at ${dir} could not be reached (${err.code ?? 'unknown error'}), ` +
              'so Codeep cannot tell whether it names a program for git to run.'
          );
        }
        let id: string;
        try {
          id = realpathSync(file);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          // Gone between the stat and here is a race, and git's own
          // `include.path` skips a missing file just as silently. Anything else
          // is a file git can open and we cannot, which has to fail the call.
          if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
          throw refuse(
            cwd,
            `the git config of its submodule at ${dir} could not be opened (${err.code ?? 'unknown error'}), ` +
              'so Codeep cannot tell whether it names a program for git to run.'
          );
        }
        if (read.has(id)) continue;
        read.add(id);
        files.push(file);
        any = true;
      }
      // One entry per git DIRECTORY, whichever of its config files existed:
      // `dirs` only feeds the `<dir>/modules/<name>` pairing below, and a
      // directory listed twice would square that cross product.
      if (any) dirs.push(dir);
    }
    if (files.length === 0) break;

    if (depth >= MAX_SUBMODULE_DEPTH) {
      throw refuse(
        cwd,
        `its submodules are nested more than ${MAX_SUBMODULE_DEPTH} levels deep, and every level carries ` +
          'its own git config that can name a program for git to run. Codeep will not run git here rather ' +
          'than check only the levels it reached. Run git in the submodule you meant instead ' +
          '(git -C <path> …).'
      );
    }
    // Counted in git DIRECTORIES, not in `read.size`: since `config.worktree`
    // joined the list a submodule can contribute two files, and counting
    // files would refuse a checkout for having half as many submodules as the
    // message claims.
    scannedDirs += dirs.length;
    if (scannedDirs > MAX_SUBMODULE_CONFIGS) {
      throw refuse(
        cwd,
        `it has more than ${MAX_SUBMODULE_CONFIGS} initialised submodules, and each one carries its own ` +
          'git config that can name a program for git to run. Codeep will not run git here rather than ' +
          'check only some of them. De-initialise the ones this checkout does not need ' +
          '(git submodule deinit <path>), or run git in the one you meant instead (git -C <path> …).'
      );
    }

    const round = readConfigFiles(cwd, env, files);
    for (const entry of round) {
      entries.push({
        ...entry,
        scope: SUBMODULE_SCOPE,
        worktree: entry.file ? worktrees.get(entry.file) : undefined,
      });
    }

    // A submodule's own submodules are recorded in the config just read, and
    // git puts their git directories under `<that git dir>/modules/<name>`.
    // Which parent goes with which name is not in the merged output, so every
    // pairing is offered and the filesystem answers — a stat each, no child.
    //
    // The pairing is a cross product, so it is capped like everything else
    // here and it is capped BEFORE the work rather than by truncating the
    // list afterwards: dropping candidates quietly would be one more bound
    // that fails open, and a superproject that could produce this many is
    // one the count cap is about to refuse anyway.
    const nested = submoduleNames(round, cwd);
    if (dirs.length * nested.length > MAX_SUBMODULE_CONFIGS) {
      throw refuse(
        cwd,
        `its submodules declare more than ${MAX_SUBMODULE_CONFIGS} submodules of their own, and each one ` +
          'carries a git config that can name a program for git to run. Codeep will not run git here ' +
          'rather than check only some of them. De-initialise the ones this checkout does not need ' +
          '(git submodule deinit <path>), or run git in the one you meant instead (git -C <path> …).'
      );
    }
    frontier = [];
    for (const dir of dirs) {
      for (const name of nested) {
        const child = containedPath(join(dir, 'modules'), name);
        if (child) frontier.push(child);
      }
    }
  }

  return entries;
}

/**
 * The override pairs that neutralise every command-executing key the
 * REPOSITORY set, leaving the same keys alone when they came from the user's
 * global or system config. Throws when the repository named something no
 * override can reach — see GitHardeningError.
 */
function repoSuppliedOverrides(cwd: string, env: NodeJS.ProcessEnv): Array<readonly [string, string]> {
  const scanned = listGitConfig(cwd, env);
  if (!scanned) return [];

  // The superproject's own config plus its submodules'. The two lists are
  // joined here rather than scanned together because git cannot print them
  // together: see listSubmoduleConfig() for what `--show-scope` at the
  // superproject leaves out and what that costs.
  //
  // `gitLayout` is called straight through rather than behind a memoised
  // getter. The getter existed for the content-filter rule, which used to ask
  // for the layout again on the refusal path; that rule no longer asks
  // anything, and this call site resolved it eagerly anyway, so the memo
  // never saved a child process.
  const entries = [...scanned, ...listSubmoduleConfig(cwd, env, scanned, gitLayout(cwd, env))];

  const overrides: Array<readonly [string, string]> = [];
  for (const entry of entries) {
    if (!isRepoScope(entry.scope)) continue;
    const rule = REPO_EXECUTING_RULES.find(r => r.match.test(entry.key));
    if (!rule) continue;
    // The key matched a rule, so git runs what it names. If its bytes cannot
    // be spelled back into the environment there is no override to emit, and
    // the only answer left is to not run git here.
    if (!entry.keyExact) {
      throw refuse(
        cwd,
        `${describeConfig(entry)} sets "${entry.key}", whose name is not valid UTF-8. Git runs the ` +
          'program that key names, and no environment override can spell the key back exactly. Remove it ' +
          `from ${entry.file ?? '.git/config'}.`
      );
    }
    if ('refuse' in rule) {
      // null means the entry is safe as it stands — the well-known content
      // filters, which have to keep running for git-lfs, git-crypt and
      // nbstripout repositories to work at all.
      const why = rule.refuse(entry, entry.key.match(rule.match)!, env);
      if (why) throw refuse(cwd, why);
      continue;
    }
    overrides.push(...rule.neutralise(entry, entry.key.match(rule.match)!));
  }

  // Several gpg keys collapse to the same "stop signing" pairs; last one wins
  // anyway, so drop the repeats rather than pad the environment with them.
  const seen = new Set<string>();
  const deduped = overrides.filter(([key]) => {
    const dup = seen.has(key);
    seen.add(key);
    return !dup;
  });

  // Credential helpers are a list built from every `credential.helper` and
  // `credential.<url>.helper` in config order, and there is no way to remove
  // one entry — an empty value RESETS the whole list. So when the repository
  // contributed one, reset and re-add the others, each under ITS OWN key so a
  // URL-scoped helper does not become a global one.
  //
  // This block is appended AFTER the de-duplication on purpose: every entry
  // here shares the key `credential.helper`, and de-duplicating by key would
  // keep the reset and throw away every helper being restored — leaving the
  // user with no credential helper at all.
  const helpers = entries.filter(e => CREDENTIAL_HELPER_KEY.test(e.key));
  if (helpers.some(e => isRepoScope(e.scope))) {
    deduped.push(['credential.helper', '']);
    for (const helper of helpers) {
      if (isRepoScope(helper.scope)) continue;
      // Re-declaring the user's own helper needs its key and its value back
      // byte for byte. Anything less would quietly point git at a different
      // program than the one it had, so refuse instead of guessing.
      if (!helper.keyExact || !helper.valueExact) {
        throw refuse(
          cwd,
          `it sets its own credential.helper, and switching that off means re-declaring the helpers you ` +
            `configured — but "${helper.key}" is not valid UTF-8 and cannot be re-declared exactly.`
        );
      }
      deduped.push([helper.key, helper.value]);
    }
  }

  return deduped;
}

export interface HardenedGitEnvOptions {
  /**
   * The repository the git call will run in — the same `cwd` the spawn gets.
   * Its config is scanned so repo-supplied programs can be neutralised, so a
   * caller that passes the wrong one gets the wrong repository's protection.
   */
  cwd?: string;
  /**
   * Disable the repository's hooks. Only for the commands Codeep runs BY
   * ITSELF — status, diff, rev-parse, show, ls-files, log — where the user
   * never asked for a hook to run. Commands the user triggered (`/commit`,
   * `/git-commit`, the agent auto-commit, a branch switch) leave it false, so
   * lint-staged, commit-signing hooks and Codeep's own review hook run
   * exactly as they would in the user's terminal.
   *
   * What justifies leaving them on is the approval, not a claim that a hook
   * cannot get onto disk. The user asked for this commit or this checkout, so
   * the repository's hooks run for it exactly as they would if they had typed
   * the command themselves — and that is the whole argument. The write gate
   * in utils/toolExecution.ts raises a confirmation for a hook a MODEL writes
   * with write_file; it does not, and does not claim to, cover a shell
   * command the user approved, where `node setup.cjs`, `cp`, `tee` or a
   * redirect writes the same file with nothing to prompt about (reproduced
   * twice against git 2.54). See the comment above that gate, which says the
   * same thing from the other side.
   */
  noHooks?: boolean;
  /**
   * The environment to harden, defaulting to this process's. A caller with
   * its own overrides must pass them HERE rather than spreading them over the
   * result: their `GIT_CONFIG_COUNT` would replace ours and silently drop
   * every override above their count.
   */
  base?: NodeJS.ProcessEnv;
}

/**
 * The environment for a git child process, with every command-executing config
 * key neutralised. Pass it to EVERY git spawn — including the read-only ones:
 * `git status` is the call that runs `core.fsmonitor` and a `filter.<d>.clean`.
 *
 * It costs one `git config --list` plus one `git ls-files` per call —
 * measured 13.6ms here in a plain repository at its root, 19.7ms in one with
 * a submodule, 28.3ms with fifty of them and 47.7ms in a 100k-file checkout
 * with none (see listSubmoduleConfig for where each part goes, and for why
 * the index is read even in a repository that declares no submodules) — so build
 * it ONCE per function and hand the same object to every spawn inside. There is
 * deliberately no cache across calls: the scan's whole job is to notice what
 * the repository's config says RIGHT NOW, and a hostile `.git/config` written
 * after a cache warmed would be the one it failed to neutralise. Nothing needs
 * one either — the only repeated caller, the status-line branch in
 * renderer/main.ts, already caches its own result and re-reads only when the
 * project moved or an agent run finished.
 *
 * Environment variables are the USER's, not the repository's, so this removes
 * exactly one and leaves the rest:
 *
 * - `GIT_CONFIG_PARAMETERS` is deleted. Git reads it AFTER the
 *   `GIT_CONFIG_COUNT` pairs and it wins, which silently disables this whole
 *   function (verified). Nothing sets it but git itself, for its own children.
 * - `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_PROXY_COMMAND`
 *   name programs, but ones the user exported for their own git. Codeep's diff
 *   reads pass `--no-ext-diff`, which beats `GIT_EXTERNAL_DIFF` anyway.
 * - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` are kept
 *   because a hook exports them: the pre-commit hook Codeep installs runs
 *   `codeep review`, and `git diff --cached` there must read the hook's
 *   TEMPORARY index to see what is really being committed.
 * - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_ALTERNATE_OBJECT_DIRECTORIES`
 *   are kept: the scan above runs under this same environment, so it sees
 *   whatever they make git see.
 *
 * Anyone who can set environment variables on this process already owns it.
 *
 * THROWS `GitHardeningError` rather than return a half-built environment when
 * the config scan cannot complete, or when the repository named a program no
 * override can switch off. The scan used to swallow every error and fall back
 * to the always-on pairs alone, so a repository that padded its `.git/config`
 * past the read buffer turned the entire repo-scope layer off in silence and
 * ran its `filter.<d>.clean` on the next `git status`. Every caller in this
 * file catches it and degrades: the status line loses its branch, `/commit`,
 * `@git` and the review path show `error.message`, which is written for the
 * user. A NEW caller has to do the same, or the refusal reaches them as a
 * crash — and a caller inside a promise executor that does not catch it never
 * settles at all.
 */
export function hardenedGitEnv(options: HardenedGitEnvOptions = {}): NodeJS.ProcessEnv {
  const { cwd = process.cwd(), noHooks = false, base = process.env } = options;
  const env: NodeJS.ProcessEnv = { ...base };

  delete env.GIT_CONFIG_PARAMETERS;

  // A git that decides to ask for a password would block the UI forever —
  // there is no terminal behind these pipes for the user to answer on.
  env.GIT_TERMINAL_PROMPT = '0';
  // `pager.<cmd>` overrides core.pager, and GIT_PAGER overrides both.
  env.GIT_PAGER = 'cat';

  // Merge rather than clobber: the caller (or a wrapper around Codeep) may
  // already declare GIT_CONFIG_* pairs, and dropping them would silently
  // change how their git behaves. Ours go AFTER theirs because the last entry
  // wins, so nothing in the environment can re-enable an executing key. A
  // count git itself would reject (anything but digits) is treated as no
  // entries: git fails outright on a bogus count, so there is nothing worth
  // preserving.
  const declared = env.GIT_CONFIG_COUNT ?? '';
  let count = /^\d+$/.test(declared) ? Number(declared) : 0;
  const append = (key: string, value: string): void => {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  };

  for (const [key, value] of GIT_EXECUTING_CONFIG) append(key, value);
  if (noHooks) append('core.hooksPath', NO_HOOKS_PATH);

  // Commit what we have before scanning, so the scan reads the config through
  // the same environment the real call will use.
  env.GIT_CONFIG_COUNT = String(count);
  for (const [key, value] of repoSuppliedOverrides(cwd, env)) append(key, value);
  env.GIT_CONFIG_COUNT = String(count);

  return env;
}

/**
 * "Is there a repository here, and will we run git in it?" — with the two
 * NOs kept apart.
 *
 * Every function below used to open with `if (!isGitRepository(cwd))` and
 * answer a refusal with "Not a git repository", which is a different problem
 * with a different fix: one means "open a project that is under version
 * control", the other means "this repository's config names a program, remove
 * it". `refusal` carries the second one so the caller can print it verbatim;
 * it is already written for the user.
 */
interface RepoCheck {
  isRepo: boolean;
  /** Set only when git was refused — see GitHardeningError. */
  refusal?: string;
}

function checkGitRepository(cwd: string): RepoCheck {
  const gitDir = join(cwd, '.git');
  if (existsSync(gitDir)) return { isRepo: true };

  try {
    // Only reached when `cwd` sits BELOW the repository root: the existsSync
    // above answers the root case without running git, and Codeep's
    // projectPath is the root.
    execSync('git rev-parse --git-dir', {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: hardenedGitEnv({ cwd, noHooks: true }),
    });
    return { isRepo: true };
  } catch (error) {
    // A refusal means we will not run git here, so the answer is still "no"
    // — the difference is that the caller can say WHY. Anything else (no git
    // on PATH, genuinely not a repository) keeps the bare no.
    return error instanceof GitHardeningError
      ? { isRepo: false, refusal: error.message }
      : { isRepo: false };
  }
}

/** A repository whose git Codeep is willing to run. Refusals answer `false`;
 *  callers that can show a reason use the functions below, which carry it. */
export function isGitRepository(cwd: string = process.cwd()): boolean {
  return checkGitRepository(cwd).isRepo;
}

/** The message a caller prints when checkGitRepository() said no. */
function notARepo(check: RepoCheck): string {
  return check.refusal ?? 'Not a git repository';
}

/**
 * Get current git status
 */
export function getGitStatus(cwd: string = process.cwd()): GitStatus {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    // A refusal answers `isRepo: true` on purpose. `false` means "nothing to
    // show here", and the status line draws nothing; a refusal means there is
    // something to show and it is a sentence the user can act on. We only
    // reach this branch below the repository root, where git was asked and
    // said no, so "this is version-controlled" is the safer of the two
    // guesses — and the wrong guess still shows the reason rather than a
    // blank.
    // `refusal` as well as `error`: the TUI's warning reads the narrow field
    // (see gitRefusalNotice in renderer/main.ts) and callers that only know
    // about `error` keep the same text.
    return repo.refusal ? { isRepo: true, error: repo.refusal, refusal: repo.refusal } : { isRepo: false };
  }

  try {
    // One environment for all three reads: building it costs a `git config
    // --list`, and these commands are the status line's, so they run often.
    // Codeep asks for them by itself, so the repository's hooks stay out.
    // Inside the try because it throws when the config cannot be scanned: the
    // status line has to degrade to "no branch", never to a crash.
    const env = hardenedGitEnv({ cwd, noHooks: true });

    // Get current branch. stderr is piped rather than inherited — execSync's
    // default sends it to ours, and a repository with no commit yet answers
    // `fatal: ambiguous argument 'HEAD'` into the middle of the TUI.
    //
    // Caught HERE rather than by the outer catch, which is what it used to
    // do. A brand-new `git init` has no commit for HEAD to name, so this line
    // throws and took the whole function down with it: `hasChanges` came back
    // undefined, and autoCommitAgentChanges() reads exactly that field — so
    // the first agent run in a new project reported "No changes detected by
    // git" over a working tree full of the files it had just written, and the
    // auto-commit the user had switched on never happened once until they
    // committed something by hand. A repository with no commits is an
    // ordinary repository; only the branch is unknown in it. The reason still
    // lands in `error` (never in `refusal` — it is not a hardening refusal),
    // which is the field GitStatus declares for "why there is no branch".
    let branch: string | undefined;
    let branchError: string | undefined;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      branchError = error instanceof Error ? error.message : 'Unknown error';
    }

    // Check for changes
    const status = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hasChanges = status.trim().length > 0;

    // Check ahead/behind
    let ahead = 0;
    let behind = 0;
    try {
      const counts = execSync('git rev-list --left-right --count @{u}...HEAD', {
        cwd,
        encoding: 'utf-8',
        env,
        // The common failure, not an exceptional one: a branch with no
        // upstream fails here on every status refresh, and the inherited
        // stderr put `fatal: no upstream configured for branch 'x'` straight
        // into the TUI once a second.
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const [behindStr, aheadStr] = counts.split('\t');
      behind = parseInt(behindStr) || 0;
      ahead = parseInt(aheadStr) || 0;
    } catch {
      // No upstream branch
    }

    return {
      isRepo: true,
      branch,
      hasChanges,
      ahead,
      behind,
      error: branchError,
    };
  } catch (error) {
    // No `as GitStatus` any more: the cast was the whole reason this value
    // could claim a field the type did not have, so nothing ever read it back
    // and a refusal looked like a branch that vanished. `error` is declared on
    // GitStatus now, and the compiler checks this object against it.
    //
    // `refusal` is filled ONLY for a GitHardeningError, which is what makes
    // it safe for the TUI to print as an instruction. Everything else here is
    // an ordinary git failure, and telling that user to remove a config key
    // they do not have is worse than saying nothing. The brand-new `git init`
    // no longer arrives here at all — its `fatal: ambiguous argument 'HEAD'`
    // is caught at the branch read above so the rest of the status survives —
    // but it still fills `error` from there, on the same terms.
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      isRepo: true,
      error: message,
      refusal: error instanceof GitHardeningError ? message : undefined,
    };
  }
}

/**
 * Get git diff (staged or unstaged)
 */
export function getGitDiff(
  staged: boolean = false, 
  cwd: string = process.cwd()
): GitDiffResult {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return {
      success: false,
      diff: '',
      error: notARepo(repo),
    };
  }

  try {
    // --no-ext-diff disallows external diff drivers (`diff.external` and any
    // `diff.<driver>.command` a `.gitattributes` names) and --no-textconv the
    // `diff.<driver>.textconv` renderers, whatever scope they came from. The
    // repo-scope scan in hardenedGitEnv() covers the same keys, so these
    // flags are the belt to its braces: they still hold if the scan could not
    // run. The cost is that a user's GLOBAL textconv (`*.pdf` through
    // pdftotext) does not apply to the diffs Codeep reads — which is what we
    // want anyway, since these go to a model, and the raw patch is the
    // faithful one.
    const command = staged
      ? 'git diff --no-ext-diff --no-textconv --cached'
      : 'git diff --no-ext-diff --no-textconv';
    const diff = execSync(command, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
      // stderr piped rather than inherited (execSync's default): git's own
      // `fatal:` belongs in the `error` this function returns, not in the
      // middle of the TUI.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: hardenedGitEnv({ cwd, noHooks: true }),
    });

    if (!diff.trim()) {
      return {
        success: true,
        diff: '',
        error: staged ? 'No staged changes' : 'No unstaged changes',
      };
    }

    return {
      success: true,
      diff: diff.trim(),
    };
  } catch (error) {
    return {
      success: false,
      diff: '',
      error: error instanceof Error ? error.message : 'Failed to get diff',
    };
  }
}

export interface GitChangedFilesResult {
  files: string[];
  /**
   * Why the list is empty because git would not run, rather than because
   * nothing changed. The two read the same through getChangedFiles() below,
   * and a caller that gates work on "are there changes?" — the review
   * pipeline in utils/codeReview.ts does — would otherwise quietly review
   * nothing in a repository whose config Codeep refuses to run git in.
   */
  error?: string;
}

/**
 * Get list of changed files, with the reason when there are none.
 */
export function getChangedFilesResult(cwd: string = process.cwd()): GitChangedFilesResult {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return { files: [], error: notARepo(repo) };
  }

  try {
    const output = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      // stderr piped, not inherited: execSync sends it to ours by default,
      // and git's own `fatal:` lines belong in the message below rather than
      // in the middle of the TUI.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: hardenedGitEnv({ cwd, noHooks: true }),
    });

    // Split BEFORE trimming. Porcelain status codes are two columns wide and
    // an unstaged modification leaves the first one blank (" M a.txt"), so
    // trimming the whole output ate two characters off the first entry
    // whenever it was one of those — " M a.txt" came back as ".txt".
    const files = output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        // Format: "XY filename" where XY are status codes
        return line.substring(3).trim();
      });
    return { files };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : 'Failed to list changes' };
  }
}

/**
 * Get list of changed files. Empty on any failure — see
 * getChangedFilesResult() when the difference between "nothing changed" and
 * "git was refused" matters.
 */
export function getChangedFiles(cwd: string = process.cwd()): string[] {
  return getChangedFilesResult(cwd).files;
}

/**
 * Generate commit message suggestion based on diff
 */
export function suggestCommitMessage(diff: string): string {
  // Simple heuristics for commit message suggestions
  const lines = diff.split('\n');
  const additions = lines.filter(l => l.startsWith('+')).length;
  const deletions = lines.filter(l => l.startsWith('-')).length;
  
  // Look for common patterns
  if (diff.includes('new file mode')) {
    return 'feat: add new files';
  }
  if (diff.includes('deleted file mode')) {
    return 'chore: remove files';
  }
  if (diff.includes('package.json') || diff.includes('package-lock.json')) {
    return 'chore: update dependencies';
  }
  if (diff.includes('README') || diff.includes('.md')) {
    return 'docs: update documentation';
  }
  if (diff.includes('test') || diff.includes('spec')) {
    return 'test: update tests';
  }
  
  // Generic based on size
  if (additions > deletions * 2) {
    return 'feat: add functionality';
  }
  if (deletions > additions * 2) {
    return 'refactor: remove code';
  }
  
  return 'chore: update code';
}

/**
 * Create a commit with the given message
 */
export function createCommit(
  message: string,
  cwd: string = process.cwd()
): GitCommitResult {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return {
      success: false,
      error: notARepo(repo),
    };
  }

  try {
    // noHooks stays off: a commit is something the user asked for (/commit,
    // /git-commit, the agent auto-commit they enabled), so the repository's
    // pre-commit, commit-msg and post-commit hooks run exactly as they would
    // in their terminal — lint-staged, their signing hook, Codeep's own review
    // hook. Only the programs a repo can name in its CONFIG are neutralised.
    // Inside the try so a refusal comes back as `error`, which is what
    // /commit prints, instead of escaping as an exception.
    const env = hardenedGitEnv({ cwd });

    // Check if there are staged changes. stderr piped rather than inherited:
    // execSync sends it to ours by default, so a `fatal:` from git landed in
    // the middle of the TUI instead of in the `error` this function returns.
    const staged = execSync('git diff --cached --name-only', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).trim();

    if (!staged) {
      return {
        success: false,
        error: 'No staged changes to commit',
      };
    }

    // Create commit using spawnSync to prevent command injection
    const result = spawnSync('git', ['commit', '-m', message], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      env,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Commit failed');
    }

    // Get commit hash
    const hash = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).trim();

    return {
      success: true,
      hash,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Commit failed',
    };
  }
}

/**
 * Stage all changes, with the reason when it did not happen.
 *
 * The reason matters most in a repository with a REQUIRED content filter —
 * git-crypt, git-lfs, any repo-local `filter.<d>.required = true`. The
 * repo-scope layer empties that driver's `clean` command and deliberately
 * leaves `required` alone, so git aborts with `fatal: <file>: clean filter
 * '<d>' failed` and exit 128 rather than writing the unfiltered content. That
 * is the intended outcome (see the filter rule above: the alternative was
 * plaintext secrets in the object database), and it is only useful if the
 * user gets to read it — `stdio: 'ignore'` here used to throw the sentence
 * away and leave them with "Failed to stage changes".
 */
export function stageAllResult(cwd: string = process.cwd()): { success: boolean; error?: string } {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return { success: false, error: notARepo(repo) };
  }

  try {
    execSync('git add -A', { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: hardenedGitEnv({ cwd }) });
    return { success: true };
  } catch (error) {
    // execSync folds the piped stderr into the thrown error's message, which
    // is how the `fatal: … clean filter … failed` line gets here at all.
    return { success: false, error: error instanceof Error ? error.message : 'Failed to stage changes' };
  }
}

/**
 * Stage all changes. See stageAllResult() when the reason matters.
 */
export function stageAll(cwd: string = process.cwd()): boolean {
  return stageAllResult(cwd).success;
}

/**
 * Format git diff for display
 */
export function formatDiffForDisplay(diff: string, maxLines: number = 50): string {
  const lines = diff.split('\n');
  
  if (lines.length <= maxLines) {
    return diff;
  }
  
  const truncated = lines.slice(0, maxLines).join('\n');
  const remaining = lines.length - maxLines;
  
  return `${truncated}\n\n... (${remaining} more lines, showing first ${maxLines})`;
}

/**
 * Create a new branch
 */
export function createBranch(
  branchName: string,
  cwd: string = process.cwd()
): { success: boolean; error?: string } {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return { success: false, error: notARepo(repo) };
  }

  try {
    // As in createCommit: the checkout is the user's, so its post-checkout
    // hook runs. See HardenedGitEnvOptions.noHooks. Inside the try so a
    // refusal comes back as `error` rather than escaping as an exception.
    const env = hardenedGitEnv({ cwd });

    // Check if branch already exists
    // stderr piped rather than inherited (execSync's default), so git's own
    // `fatal:` reaches the `error` below instead of the middle of the TUI.
    const branches = execSync('git branch --list', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    if (branches.includes(branchName)) {
      return { success: false, error: `Branch '${branchName}' already exists` };
    }

    execSync(`git checkout -b ${branchName}`, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create branch',
    };
  }
}

/**
 * Switch to a branch
 */
export function switchBranch(
  branchName: string,
  cwd: string = process.cwd()
): { success: boolean; error?: string } {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return { success: false, error: notARepo(repo) };
  }

  try {
    execSync(`git checkout ${branchName}`, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: hardenedGitEnv({ cwd }) });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to switch branch',
    };
  }
}

/**
 * Generate a commit message based on agent actions
 */
export function generateCommitMessage(
  prompt: string,
  actions: ActionLog[]
): string {
  // Analyze actions to determine commit type
  const hasWrites = actions.some(a => a.type === 'write');
  const hasEdits = actions.some(a => a.type === 'edit');
  const hasDeletes = actions.some(a => a.type === 'delete');
  
  // Determine prefix
  let prefix = 'chore';
  
  // Check prompt for common patterns
  const promptLower = prompt.toLowerCase();
  if (promptLower.includes('fix') || promptLower.includes('bug')) {
    prefix = 'fix';
  } else if (promptLower.includes('add') || promptLower.includes('create') || promptLower.includes('implement')) {
    prefix = 'feat';
  } else if (promptLower.includes('refactor') || promptLower.includes('clean')) {
    prefix = 'refactor';
  } else if (promptLower.includes('test')) {
    prefix = 'test';
  } else if (promptLower.includes('doc') || promptLower.includes('readme')) {
    prefix = 'docs';
  } else if (hasWrites && !hasEdits) {
    prefix = 'feat';
  } else if (hasDeletes && !hasWrites) {
    prefix = 'refactor';
  }
  
  // Generate message body from prompt
  let body = prompt
    .replace(/^(please\s+)?/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  
  // Truncate if too long
  if (body.length > 50) {
    body = body.substring(0, 47) + '...';
  }
  
  // Make first letter lowercase
  body = body.charAt(0).toLowerCase() + body.slice(1);
  
  return `${prefix}: ${body}`;
}

/**
 * Auto-commit agent changes
 */
export function autoCommitAgentChanges(
  prompt: string,
  actions: ActionLog[],
  cwd: string = process.cwd()
): GitCommitResult {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return { success: false, error: notARepo(repo) };
  }
  
  // Check if there are any file changes
  const fileActions = actions.filter(a => 
    a.type === 'write' || a.type === 'edit' || a.type === 'delete' || a.type === 'mkdir'
  );
  
  if (fileActions.length === 0) {
    return { success: false, error: 'No file changes to commit' };
  }
  
  // Check for actual git changes. A REFUSAL is read first: a refused
  // repository answers `hasChanges: undefined`, so the old order reported
  // "No changes detected by git" for a config Codeep would not run git under
  // — on the hottest path there is, the auto-commit at the end of every agent
  // run. The user then has an agent that silently stops committing and a
  // sentence that says nothing is wrong.
  //
  // `refusal` and NOT `error`, which was the fix's own bug: `error` is filled
  // for ANY git failure, and the commonest one is a brand-new repository with
  // no commit yet (`fatal: ambiguous argument 'HEAD'`, git 2.54). So `git
  // init` plus a first agent run printed raw git plumbing at a user who had
  // done nothing wrong. An ordinary failure keeps the ordinary sentence below.
  const status = getGitStatus(cwd);
  if (status.refusal) {
    return { success: false, error: status.refusal };
  }
  // Reading ONLY `refusal` was the other half of the same mistake, in the
  // other direction: every git failure that is not a refusal came out as "No
  // changes detected by git". `hasChanges` is the field that says which one
  // this is, and it is undefined exactly when getGitStatus could not read the
  // working tree at all — the `git status --porcelain` it comes from threw,
  // so nobody knows whether there are changes. Reproduced with a repository
  // whose config says `core.bare = true`: git answers "fatal: this operation
  // must be run in a work tree", and the auto-commit told the user their
  // agent's work was not a change. Saying git failed, and what it said, is
  // the difference between a user who fixes their repository and one who
  // thinks Codeep wrote nothing.
  //
  // Ordered after the `hasChanges` read and before the `!hasChanges` one on
  // purpose: a brand-new repository fills `error` (there is no HEAD for the
  // branch read to name) while `hasChanges` is perfectly true, and that one
  // has to go on and commit.
  if (status.hasChanges === undefined) {
    return { success: false, error: `Could not read git status: ${status.error ?? 'git failed'}` };
  }
  if (!status.hasChanges) {
    return { success: false, error: 'No changes detected by git' };
  }
  
  // Stage all changes. The reason comes through rather than a fixed sentence:
  // a required content filter that cannot run is the case where "Failed to
  // stage changes" tells the user nothing and git's own line tells them
  // everything (see stageAllResult).
  const staged = stageAllResult(cwd);
  if (!staged.success) {
    return { success: false, error: staged.error ?? 'Failed to stage changes' };
  }
  
  // Generate commit message
  const message = generateCommitMessage(prompt, actions);
  
  // Create commit
  return createCommit(message, cwd);
}

/**
 * Generate branch name from prompt
 */
export function generateBranchName(prompt: string): string {
  // Clean up prompt
  let name = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  
  // Add prefix
  const prefix = 'agent';
  const timestamp = Date.now().toString(36).slice(-4);
  
  return `${prefix}/${name}-${timestamp}`;
}

/**
 * Create branch and commit agent changes
 */
export function createBranchAndCommit(
  prompt: string,
  actions: ActionLog[],
  cwd: string = process.cwd()
): { success: boolean; branch?: string; hash?: string; error?: string } {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    return { success: false, error: notARepo(repo) };
  }
  
  // Generate branch name
  const branchName = generateBranchName(prompt);
  
  // Create branch
  const branchResult = createBranch(branchName, cwd);
  if (!branchResult.success) {
    return { success: false, error: branchResult.error };
  }
  
  // Commit changes
  const commitResult = autoCommitAgentChanges(prompt, actions, cwd);
  if (!commitResult.success) {
    return { 
      success: false, 
      branch: branchName, 
      error: commitResult.error 
    };
  }
  
  return {
    success: true,
    branch: branchName,
    hash: commitResult.hash,
  };
}

// ─── @git mention support ────────────────────────────────────────────────────

/**
 * Result of resolving a `@git <ref>` mention.
 */
export interface GitContentResult {
  success: boolean;
  /** Raw output from git (diff text, file content, or commit metadata). */
  content: string;
  /** A short label for the [Attached files]-style block header. */
  label: string;
  error?: string;
}

/** Max bytes we'll inline from a single `@git` mention. */
export const MAX_GIT_BYTES = 64 * 1024;

/**
 * Characters a git ref/pathspec may contain for `@git` mentions. Deliberately
 * conservative: word chars plus the punctuation real refs use
 * (`main..feature`, `HEAD~3`, `v1.2.0^{}`, `main:src/x.ts`, `origin/main`).
 * A leading `-` is rejected separately so a ref can never be read as a flag.
 */
const SAFE_GIT_REF = /^[A-Za-z0-9._/:~^@{}-]+$/;

export function isSafeGitRef(token: string): boolean {
  return token.length > 0 && !token.startsWith('-') && SAFE_GIT_REF.test(token);
}

/**
 * The only flags `@git diff …` may pass through. An allowlist rather than a
 * deny-list because several git flags write files or run commands
 * (`--output=`, `--ext-diff`), which would turn a mention into a side effect.
 */
const GIT_DIFF_FLAG_ALLOWLIST = new Set([
  '--staged', '--cached', '--stat', '--numstat', '--shortstat',
  '--name-only', '--name-status', '--patch', '-p', '--no-color',
]);

/**
 * Resolve a `@git <ref>` mention to inline content. The `ref` can be:
 *
 * - `diff`           — unstaged changes (`git diff`)
 * - `diff --staged`  — staged changes (`git diff --cached`)
 * - `diff a..b`      — diff between two refs (`git diff a..b`)
 * - `HEAD`           — the latest commit's full diff vs its parent
 * - `<sha>`          — a specific commit's patch (`git show <sha>`)
 * - `<ref>:<path>`   — a file at a ref (`git show main:src/x.ts`)
 * - `<ref>`          — any other git ref → `git show`
 *
 * Sync (spawn-based) so it slots into the mention-expansion pipeline.
 */
export function getGitContent(ref: string, cwd: string = process.cwd()): GitContentResult {
  const repo = checkGitRepository(cwd);
  if (!repo.isRepo) {
    // Lower-cased default, because this one is inlined into a mention
    // failure line rather than shown on its own. A refusal keeps its own
    // capitalisation: it is a whole sentence with a fix in it.
    return { success: false, content: '', label: ref, error: repo.refusal ?? 'not a git repository' };
  }

  const trimmed = ref.trim();
  if (!trimmed) {
    return { success: false, content: '', label: ref, error: 'empty git ref' };
  }

  // Pick the git subcommand based on the ref shape. NOTE: the ref comes from
  // free-form prompt text (`@git <ref>`), which may be pasted from an issue,
  // a log, or model output — so it is UNTRUSTED. We therefore (a) build an
  // argv array and spawn git directly with `execFileSync` (no `/bin/sh`, so
  // `;`, `|`, backticks and friends are inert), and (b) validate every token,
  // because argv alone doesn't stop *argument* injection — a ref that starts
  // with `-` would still be read by git as a flag (e.g. `--output=…` writes a
  // file). Anything unrecognized is rejected rather than guessed at.
  let args: string[];
  let label: string;

  if (trimmed === 'diff') {
    args = ['diff'];
    label = 'diff (unstaged)';
  } else if (trimmed === 'diff --staged' || trimmed === 'diff --cached' || trimmed === 'staged') {
    args = ['diff', '--cached'];
    label = 'diff (staged)';
  } else if (trimmed.startsWith('diff ')) {
    // e.g. `diff main..feature` or `diff HEAD~3` or `diff --stat`
    const rest = trimmed.slice('diff '.length).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);
    const bad = tokens.find(t => !(isSafeGitRef(t) || GIT_DIFF_FLAG_ALLOWLIST.has(t)));
    if (bad) {
      return { success: false, content: '', label: ref, error: `unsupported git argument: ${bad}` };
    }
    args = ['diff', ...tokens];
    label = `diff (${rest})`;
  } else if (trimmed === 'HEAD' || trimmed === '@') {
    // Show the latest commit's patch.
    args = ['show', 'HEAD'];
    label = 'HEAD';
  } else {
    // Any other ref → `git show`. Works for SHAs, tags, branches, and
    // `<ref>:<path>` (file-at-ref) forms.
    if (!isSafeGitRef(trimmed)) {
      return { success: false, content: '', label: ref, error: `unsupported git ref: ${trimmed}` };
    }
    args = ['show', trimmed];
    label = trimmed;
  }

  // Both `diff` and `show` take these, and they belong right after the
  // subcommand so nothing the user wrote can come first: they stop a repo's
  // own diff drivers from running (see getGitDiff for what each one covers
  // and what a global textconv gives up).
  args.splice(1, 0, '--no-ext-diff', '--no-textconv');

  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
      env: hardenedGitEnv({ cwd, noHooks: true }),
    });
    const content = (out ?? '').trimEnd();
    if (!content) {
      return { success: false, content: '', label, error: 'empty result (no changes / unknown ref)' };
    }
    // Truncate to the cap so a massive diff can't blow the context.
    const capped = content.length > MAX_GIT_BYTES
      ? content.slice(0, MAX_GIT_BYTES) + `\n\n… (truncated at ${MAX_GIT_BYTES / 1024}KB)`
      : content;
    return { success: true, content: capped, label };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // git show exits non-zero on unknown refs; surface a friendly reason.
    const reason = /unknown revision|bad revision|ambiguous argument/i.test(msg)
      ? `unknown git ref: ${trimmed}`
      : msg;
    return { success: false, content: '', label, error: reason };
  }
}
