import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync, type Dirent } from 'fs';
import { join, resolve } from 'path';
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
   * Why there is no branch here, when a repository was found but git would
   * not be run in it — a GitHardeningError, or git itself failing. Declared
   * because getGitStatus was already filling it through an `as GitStatus`
   * cast that the compiler could not check: the field existed at runtime,
   * nothing in the type said so, and the status line in renderer/main.ts
   * reads `.branch` only — so a refusal showed up as the branch silently
   * disappearing. Written for the user; show it where the branch would go.
   */
  error?: string;
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
 * directory can shadow a reserved name. It is NOT verified: nothing in this
 * repository runs git on Windows, so treat it as the best available guess
 * rather than a proven no-hooks path. If it turns out git there resolves
 * `NUL\pre-commit` to something openable, the fix is a real empty directory,
 * not another reserved name.
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
       */
      refuse: (entry: GitConfigEntry, m: RegExpMatchArray) => string | null;
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
 * The value that replaces a repo-chosen `diff.external` / `diff.<d>.command`:
 * it names the key and the `git config --unset` that fixes it, then fails.
 *
 * `false` rather than `exit 1` because git appends the diff's pathnames —
 * `sh -c '<value> "$@"' <value> <path> <old> …` — and `exit` treats them as
 * extra operands, while `false` ignores them and still exits non-zero. Git
 * then stops with `fatal: external diff died`, exit 128, so nothing has
 * silently fallen back to git's own diff either.
 */
function diffDriverRefusalCommand(key: string): string {
  const message =
    `codeep: refusing to run the diff driver this repository configured in ${key}. ` +
    `Remove it (git config --unset ${key}) if you trust this repository.`;
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
function aliasRefusalCommand(name: string, value: string): string {
  // A `!` alias is a shell line; anything else is spliced in front of git's
  // own arguments, so `alias.st = status -sb` means `git status -sb`. Saying
  // which one it is turns "run the plain git command instead" into something
  // the reader can actually act on.
  const defined = value.startsWith('!')
    ? `the shell command ${describeValue(value.slice(1))}`
    : `git ${describeValue(value)}`;
  const message =
    `codeep: refusing to run 'git ${name}', an alias this repository defined in its own git config. ` +
    `Codeep disables repository-defined aliases; run the plain git command instead — this repository ` +
    `defines '${name}' as ${defined}. ` +
    `Remove it (git config --unset alias.${name}) if you trust this repository.`;
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
 * Spellings that are NOT here, deliberately: `"<abs path to python>" -m
 * nbstripout`, which newer nbstripout installers write, and any git-lfs line
 * carrying an absolute path. An absolute path is the machine's, not a string
 * this file can pin, so those repositories get the refusal and its `--unset`
 * — which is the fail-closed half of the policy working as intended, not an
 * oversight.
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
 * Why a repo-scope content filter stops the call, written for the user.
 *
 * It has to say three things, because each one is a step a user takes next:
 * which driver, what the repository asked git to run, and the `--unset` that
 * ends it. The fourth sentence is the one that matters most — `git config
 * filter.<d>.required false` is the first hit for "clean filter failed", and
 * it is precisely the change that makes git accept a filter that did not run
 * and write the file's contents unfiltered.
 */
function contentFilterRefusal(entry: GitConfigEntry, driver: string): string {
  return (
    `this repository's own git config sets ${entry.key}, which git runs as a program for every file ` +
    `.gitattributes routes at the "${driver}" filter — here it runs: ${describeValue(entry.value)}. ` +
    `Remove it (git config --unset ${entry.key}) if you trust this repository. ` +
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
    match: /^filter\.(.+)\.(clean|smudge|process)$/i,
    refuse: (entry, m) =>
      SAFE_CONTENT_FILTER_COMMANDS.has(entry.value) ? null : contentFilterRefusal(entry, m[1]),
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
    neutralise: entry => [[entry.key, diffDriverRefusalCommand(entry.key)]],
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
    neutralise: (entry, m) => [[entry.key, aliasRefusalCommand(m[1], entry.value)]],
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
      `this repository's own git config sets ${entry.key}, which git runs as a program on fetch and push. ` +
      'Git keeps the first value it sees for that key, so no environment override can switch it off. ' +
      `Remove it (git config --unset ${entry.key}) if you trust this repository.`,
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

/**
 * `<scope>\0<key>\n<value>\0` per entry, split on BYTES. A value may itself
 * contain a newline, so the key ends at the FIRST one; a valueless key
 * (`[section] key` with no `=`) has no newline at all.
 */
function parseConfigList(out: Buffer): GitConfigEntry[] {
  const parts = splitOnNul(out);
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const record = parts[i + 1];
    const nl = record.indexOf(0x0a);
    const key = decodeExact(nl === -1 ? record : record.subarray(0, nl));
    const value = decodeExact(nl === -1 ? NO_BYTES : record.subarray(nl + 1));
    entries.push({
      scope: parts[i].toString('utf-8'),
      key: key.text,
      keyExact: key.exact,
      value: value.text,
      valueExact: value.exact,
    });
  }
  return entries;
}

/**
 * How many submodule configs one call will read, and how deep the walk for
 * them goes.
 *
 * Both are bounds on a directory tree the REPOSITORY owns — `.git/modules`
 * can be nested as deeply and be as wide as whoever prepared the checkout
 * liked. Past the cap the call is refused rather than partially scanned:
 * "we looked at 512 of your submodules" is a fail-open dressed as a limit.
 * A superproject with more than 512 initialised submodules is not a thing
 * anyone has; linux/llvm-scale monorepos have none at all.
 */
const MAX_SUBMODULE_CONFIGS = 512;
const MAX_SUBMODULE_DEPTH = 16;

/**
 * The `.git` directory of the repository at `cwd`, or null when there is not
 * one to find.
 *
 * The fast path is a single `statSync`: every caller inside Codeep passes the
 * project ROOT, where `.git` is a directory sitting right there, so the usual
 * case costs no child process at all — measured, a hardened env in a plain
 * repository at its root is 6.9ms with this code and 6.9ms without it.
 *
 * Only the other shapes — a `cwd` below the root, a linked worktree, a
 * submodule, where `.git` is a FILE or is not there at all — have to ask git,
 * and that is one extra child: 13.6ms instead of 6.9ms, measured. Walking up
 * for a `.git` ourselves would save it and would also be a second, worse copy
 * of git's discovery rules (ceiling directories, `GIT_DIR`, worktree links),
 * so git answers instead. The hot callers — the status line, /commit, the
 * review path — all pass the root and never pay it; what does is an
 * `execute_command` whose cwd is a subdirectory, once, on a command the user
 * approved.
 *
 * `--git-common-dir` rather than `--git-dir`: in a linked worktree the
 * per-worktree git dir has no `modules/` of its own, and the submodules hang
 * off the shared one.
 */
function gitCommonDir(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const here = join(cwd, '.git');
  try {
    if (statSync(here).isDirectory()) return here;
  } catch {
    // Not there, or not readable — fall through and let git answer.
  }

  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      env,
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: SCAN_MAX_BUFFER,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // git prints it relative to `cwd` when it can.
    return out ? resolve(cwd, out) : null;
  } catch {
    // git said "not a git repository", or never started. Either way the real
    // call cannot run here either, so there is no submodule of ours to scan
    // — the same reasoning listGitConfig() applies to its own null.
    return null;
  }
}

/**
 * Every `<git dir>/modules/**\/config` under `modulesDir`, which is where git
 * keeps the real git directory of each initialised submodule.
 *
 * Two shapes have to be walked rather than listed. A submodule whose NAME
 * contains a slash (`vendor/lib`, the default when the path does) becomes
 * nested directories, so `modules/vendor` holds no `config` of its own; and a
 * submodule of a submodule lands in `modules/<name>/modules/<inner>`.
 *
 * Symlinks are skipped — `isDirectory()` is false for one — which is both a
 * loop guard and the right answer: a `.git/modules` entry symlinked at some
 * directory is not a submodule git dir git would use.
 */
function collectSubmoduleConfigs(modulesDir: string, found: string[], depth: number): void {
  if (depth > MAX_SUBMODULE_DEPTH || found.length > MAX_SUBMODULE_CONFIGS) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return; // No modules dir, or not readable: nothing here to scan.
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(modulesDir, entry.name);
    if (existsSync(join(dir, 'config'))) {
      found.push(join(dir, 'config'));
      // A submodule's own submodules live one level further in.
      collectSubmoduleConfigs(join(dir, 'modules'), found, depth + 1);
    } else {
      // An intermediate directory from a slashed submodule name.
      collectSubmoduleConfigs(dir, found, depth + 1);
    }
    if (found.length > MAX_SUBMODULE_CONFIGS) return;
  }
}

/**
 * The config of every submodule of the repository at `cwd`, as repo-supplied
 * entries.
 *
 * THE HOLE THIS CLOSES: a submodule's settings live in
 * `.git/modules/<name>/config`, and `git config --list --show-scope` run at
 * the superproject never prints a single one of them. A `filter.<d>.clean`
 * there still runs on the automatic `git status` behind the status line —
 * proven with git 2.54, the superproject's `git status --porcelain` fired the
 * submodule's clean filter while the superproject's own config was spotless.
 * The overrides themselves do reach it: the same `git status` with
 * `GIT_CONFIG_KEY_0=filter.<d>.clean` left the trap cold.
 *
 * WHAT IT COSTS, since this runs on every hardened git call. Measured here
 * against git 2.54, per hardenedGitEnv() call, at the repository root:
 * - No submodules — every repository anyone here has: 6.9ms, which is the
 *   `git config --list` that was already there. `.git/modules` is not on
 *   disk, so this function is two stat calls and a return.
 * - 1 submodule: 14.1ms. 10 submodules: 14.7ms. 50 submodules: 18.3ms.
 *   Flat, because it is the readdir walk above plus ONE `git config --list`
 *   child for ALL of them, whatever the count.
 * - The alternative, a child per submodule, measured on the same
 *   50-submodule fixture: 342ms. On every status refresh. That is what
 *   `-c include.path=<file>` buys — git reads every named file in one
 *   process and reports the entries under scope `command`.
 *
 * `GIT_CONFIG_COUNT=0` on this child is load-bearing: our own overrides ride
 * in the environment as GIT_CONFIG_* pairs and git reports THOSE as scope
 * `command` too, so without it the pass would read back and re-neutralise
 * Codeep's own work.
 */
function listSubmoduleConfig(cwd: string, env: NodeJS.ProcessEnv): GitConfigEntry[] {
  const common = gitCommonDir(cwd, env);
  if (!common) return [];
  const modules = join(common, 'modules');
  if (!existsSync(modules)) return [];

  const configs: string[] = [];
  collectSubmoduleConfigs(modules, configs, 0);
  if (configs.length === 0) return [];
  if (configs.length > MAX_SUBMODULE_CONFIGS) {
    throw refuse(
      cwd,
      `it has more than ${MAX_SUBMODULE_CONFIGS} initialised submodules, and each one carries its own ` +
        'git config that can name a program for git to run. Codeep will not run git here rather than ' +
        'check only some of them.'
    );
  }

  // The `-c` pairs are git's own GLOBAL options and have to come before the
  // subcommand — after it, git 2.54 answers "unknown switch `c'". A missing
  // or unreadable include is silently skipped (verified, 2.54), so a
  // submodule directory that lost its config does not fail the call.
  const args: string[] = [];
  for (const file of configs) args.push('-c', `include.path=${file}`);
  args.push('config', '--list', '-z', '--show-scope', '--includes');

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

  return parseConfigList(out)
    // `command` is what git reports for everything reached through our own
    // `-c include.path`. Any `local` / `global` / `system` entry here belongs
    // to the superproject or the user and is already handled by the main
    // scan, so taking only `command` keeps this pass to the submodules.
    .filter(entry => entry.scope === 'command')
    // The `include.path` pseudo-entries are Codeep's own argv coming back.
    .filter(entry => entry.key.toLowerCase() !== 'include.path')
    .map(entry => ({ ...entry, scope: SUBMODULE_SCOPE }));
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
  const entries = [...scanned, ...listSubmoduleConfig(cwd, env)];

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
        `its git config sets "${entry.key}", whose name is not valid UTF-8. Git runs the program that ` +
          'key names, and no environment override can spell the key back exactly. Remove it from .git/config.'
      );
    }
    if ('refuse' in rule) {
      // null means the entry is safe as it stands — the well-known content
      // filters, which have to keep running for git-lfs, git-crypt and
      // nbstripout repositories to work at all.
      const why = rule.refuse(entry, entry.key.match(rule.match)!);
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
 * It costs one extra `git config --list` per call — measured 6.9ms here in a
 * plain repository at its root, 14ms in one with submodules and 18ms with
 * fifty of them (see listSubmoduleConfig for where the rest goes) — so build
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
    return repo.refusal ? { isRepo: true, error: repo.refusal } : { isRepo: false };
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
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

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
    };
  } catch (error) {
    // No `as GitStatus` any more: the cast was the whole reason this value
    // could claim a field the type did not have, so nothing ever read it back
    // and a refusal looked like a branch that vanished. `error` is declared on
    // GitStatus now, and the compiler checks this object against it.
    return {
      isRepo: true,
      error: error instanceof Error ? error.message : 'Unknown error',
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
  
  // Check for actual git changes. `error` is read FIRST: a refused repository
  // answers `hasChanges: undefined`, so the old order reported "No changes
  // detected by git" for a config Codeep would not run git under — on the
  // hottest path there is, the auto-commit at the end of every agent run.
  // The user then has an agent that silently stops committing and a sentence
  // that says nothing is wrong.
  const status = getGitStatus(cwd);
  if (status.error) {
    return { success: false, error: status.error };
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
