# Changelog

All notable changes to **Codeep CLI** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [Semantic Versioning](https://semver.org/).

For releases before v1.3.35, see [GitHub Releases](https://github.com/VladoIvankovic/Codeep/releases).

> **Authoring convention:** put a one-line `> TL;DR` under each
> `## [version]` heading. It's auto-extracted by `codeep.dev/releases/rss.xml`
> as the social-share summary (IFTTT → X/Bluesky), capped at 220 chars.
> If omitted, the feed falls back to the first paragraph.

## [3.1.0] — 2026-09-02

> Send Codeep an instruction from Telegram and it runs, with the answer coming back to the same chat — plus Claude Fable 5.1, a Sonnet 5 price that was 50% too high, and cache reads on Kimi and Qwen that were billed wrong in opposite directions.

### Added

- **Start a task from your phone.** V3 let Telegram answer a question the agent
  chose to ask. This lets it ask one: send the bot an instruction in plain words
  and it runs, shown in the terminal like any other, with the agent's answer
  coming back to the same chat.

  **Its own switch, off by default** — `/settings` → *Start tasks from
  Telegram*. A chat that can only say Run, Skip or Cancel is bounded by what the
  agent already decided to do; a chat that can send a prompt is a keyboard
  attached to your machine. Both are gated on the same chat ID, but they are not
  the same permission, so turning one on does not turn on the other.

  An instruction sent while a run is in flight waits, and the bot says so. One
  waits at a time and a newer one replaces it: two corrections typed during one
  long run mean the second, not both in order.

  Four refusals, each with something to say back rather than silence. Non-text,
  slash commands, anything over 2000 characters, and **anything older than five
  minutes** — Telegram holds undelivered messages for 24 hours, so without that
  last rule an instruction typed to a machine that was switched off would run
  the moment the CLI next started, hours later, with nobody watching. A message
  from any other chat is ignored with no reply at all: answering confirms the
  bot is live and attached to something worth probing.

  A task started from the phone is **not** exempt from confirmation. It stops at
  a dangerous tool exactly as it would have for someone at the keyboard, and
  that question arrives on the same phone.

- **Telegram says when a run is over.** Past a minute of run time, so a phone is
  not buzzed about work you watched finish. It carries the task, the duration
  and the token or cost line. The agent's answer travels only for a run the
  phone started — at the terminal it is already on the screen you are sitting
  at, and sending it would put file contents or a command line into a chat that
  syncs to Telegram's servers for nothing.

- **Claude Fable 5.1** (`claude-fable-5-1`). Prices like Fable 5, but reads a
  cached token at 0.025× the input rate where every other Anthropic model
  charges 0.1×, so the cache rate is resolved per model before per provider now.
  Fable 5 stays listed: dropping an id does not leave a pinned config on the
  older model, it drops the lookup and lands you on another provider's default.

### Fixed

- **Claude Sonnet 5 was priced 50% high.** The $2/$10 launch rate was billed as
  introductory through 2026-08-31 and the scheduled rise to $3/$15 was
  cancelled. Nothing failed when the table still said $3 — the number was simply
  wrong, with no test to notice.

- **Cache reads on Kimi and Qwen were billed wrong, in opposite directions.**
  Two errors, and the first hid the second. Cache hits were read only from
  `prompt_tokens_details.cached_tokens`; Kimi reports them at the top level of
  `usage`, so every Kimi cache hit came back as zero and the whole prompt billed
  at the cache-miss rate. And where a cache read *was* seen it billed at 0.1× —
  Anthropic's multiplier, hardcoded for everyone — while Kimi lists $0.19
  against $0.95 and Alibaba prices Qwen's implicit cache at 20% of input. Only
  the metered keys were affected; the subscription tiers quote no dollar figure
  at all.

- **`npm run dev` had been dead for two weeks.** Two interfaces were re-exported
  with value syntax. `tsc` erases the types and compiles happily, so the build,
  `dist/` and the published CLI were all fine and CI had nothing to report — but
  `tsx` transpiles file by file, leaves the re-export in, and the loader then
  fails to find an export that never existed at runtime. `isolatedModules` is on
  now, which named all eleven sites of that shape in one pass.

- **A run reported itself by session id, not by its task.** The dashboard, the
  stats report and the Telegram notice all read a name that was copied by value
  before it was set, so `session-2026-09-02-ddc1f13c` went out in place of the
  task. And the notice used the *session's* name, which is the first task's and
  stays put — every task after the first announced itself under the first one's
  name.

- **The agent refused commands it is allowed to run.** `execute_command` was
  described as "Use for npm, git, build tools, tests, etc.", and a few examples
  read as an exhaustive list: it declined `sleep`, which is on the allowlist
  beside `echo`, `pwd`, `date`, `ls`, `cat` and `curl`, explaining that its tool
  was limited to package managers and version control. It believed the
  description over its own capability.

- **The "N new · PgDn" badge offered a key that does nothing mid-run.** While
  the agent runs, the timeline owns the whole screen and returns before the
  transcript is drawn, so scrolling moves an offset nothing reads. The badge
  also replaced the status bar's runtime and token counts to say it.

- **A failing Telegram poll looked like an idle bot.** Errors were caught and
  turned into null with nothing said, so a webhook left configured (409) and a
  revoked token (401) were indistinguishable from a phone nobody had messaged.
  It now says so once when polling starts failing and once when it recovers.

### Changed

- **One Telegram poll, one cursor.** `getUpdates` confirms every update older
  than its `offset` regardless of `allowed_updates` — that parameter only
  filters the response. A second poller would have acknowledged approval taps it
  never delivered, so approvals would have begun failing intermittently with
  nothing to say why. The loop is shared now, asks for both kinds, and dispatches
  locally where losing one is impossible.

## [3.0.0] — 2026-08-28

> Approval on your phone, on every platform — and the version numbers across the CLI, the Mac app and the VS Code extension now line up.

### About the version

Codeep V3 is one release across three surfaces, so the three carry one number.
The CLI moves 2.25.0 → 3.0.0, the VS Code extension 2.9.0 → 3.0.0, and the Mac
app 1.14.0 → 3.0.0. **Nothing here is a breaking change** — the major is the
alignment, said out loud rather than left to look like an accident. The GitHub
Action keeps its own `v1.x` line: it is a separate product with its own
consumers and its own supply-chain pinning.

### Added

- **Answer a confirmation from your phone, over Telegram.** When a run stops on
  a dangerous tool it waits — and if you have walked away, it waits for as long
  as you are gone. Connect a bot with `/telegram` and the same question arrives
  on your phone with the same three answers. Whichever you use first decides;
  answering in the terminal takes the message down rather than leaving buttons
  that no longer do anything, and answering on the phone closes the terminal
  dialog without running either of its callbacks.

  This is where Telegram earns its keep. The Mac app can carry approvals through
  the user's own iCloud; Linux and Windows have nothing of the sort. The bot API
  is polled outbound, so there is no server to host and no inbound port to open,
  and the same code works everywhere the CLI does.

  **Only the chat ID you configure can answer.** A bot's username is
  discoverable, and without that check anyone who found yours could approve a
  destructive command on your machine. A late tap cannot reopen a settled
  question either — each message carries a token matched against the question
  actually in flight.

  **Interactive runs only.** A headless run — `codeep review --fix`, ACP, CI —
  has nobody to ask, and blocking one on an answer that cannot come would hang
  a pipeline. Those paths are untouched and still decide from
  `agentConfirmation`.

  The token goes in your OS keychain; the chat ID is ordinary config. Telegram
  necessarily sees the command, because you cannot judge what you are approving
  otherwise — which is why this is off by default.

### Fixed

- **The confirmation showed the binary, not the command.** It read
  `parameters.command`, which is `git` where the truth is `git status` — asking
  someone to approve a command they had not been shown, which is the one thing
  this gate must not do. The same truncated string went to the phone. The audit
  record already joined the binary with its arguments; that is now what both
  use.

- **A Telegram send that failed said nothing.** A wrong chat ID was
  indistinguishable from a phone nobody picked up. Telegram's own words are now
  surfaced, and the failure people actually hit while setting this up is
  translated into what to do about it.

- **The Telegram toggle wrote a value its own getter could not read.** Its
  options were the strings `'true'` and `'false'` while the getter returned a
  boolean, so the setting reported "On" and read false immediately afterwards,
  forever. Every select in the settings list is now checked against the value it
  reads back.

All three were found by using it, not by testing it.

## [2.25.0] — 2026-08-28

> GLM-5.3-Flash: the same million-token window and tool calling as the flagship, at a twentieth of the price.

### Added

- **GLM-5.3-Flash** on both international Z.AI providers. Same 1M context, same
  tool calling, and it takes the same graded thinking control — Flash also
  refuses a disabled thinking block, so it goes through the same machinery as
  5.3 rather than the on/off path. Listed at $0.15 in / $0.50 out per 1M; the
  50% launch promotion is deliberately *not* what the cost tracker records,
  since a promotional rate understates every session the day it ends. China
  gateways keep 5.2 for the same reason 5.3 is not offered there.

### Fixed

- **`kimi-k2.7-code-highspeed` now has a rate.** It was exempted because Moonshot
  published no distinct high-speed price; they now do — double the standard
  model across every token category. The exemption is removed rather than left
  as a dead suppression that would hide the next gap.

## [2.24.0] — 2026-08-25

> A rejected API key made an agent run look like it had simply run out of steps: every request was retried, the budget drained, and the report blamed the iteration limit.

### Fixed

- **A 4xx from the provider was retried until the iteration budget ran out.**
  `agentChat` threw a bare `Error` for any failed HTTP response, so the retry
  loop's "never retry a 4xx" branch — which tests `err instanceof ApiError &&
  err.status` — never applied. An expired key was retried once per iteration
  and the run then reported `Exceeded maximum of N iterations`: the one
  explanation with nothing to do with the cause. A run that used to burn
  twenty-five requests over six minutes now stops on the first, saying `401`.

- **`review --fix` never loaded the API keys.** `getApiKey` is synchronous and
  reads a cache that only `loadAllApiKeys` fills; it does not consult the
  environment itself. The fix agent started without that call, so every request
  went out with an empty bearer token. In CI this looked exactly like a model
  that would not do the work, with a perfectly valid key sitting in the
  environment the whole time.

- **A fix that changed nothing said nothing about why.** The summary reported
  what did not happen and never what did. It now counts the agent's tool calls,
  separates failures from successes, and quotes the first failure — usually a
  refusal, and usually the entire explanation.

### Changed

- **`src/utils/agentChat.ts` is a text file again.** It contained a literal NUL
  byte — a deliberate separator written as a raw byte rather than `\u0000` —
  which made `grep`, `file` and diff viewers treat the whole file as binary and
  silently skip it. Same behaviour, same separator, now searchable.

## [2.23.0] — 2026-08-25

> Security rules had never once looked at a `.mjs` file, `forEach` + `await` only counted when it wasn't an arrow function, and the CI fix agent ran out of steps before it could finish.

### Fixed

- **`.mjs` and `.cjs` were invisible to thirteen rules.** Every rule that names
  `.js` in its `extensions` list — which is all four security rules, plus the
  performance and best-practice ones — skipped these files entirely. `eval()`,
  `innerHTML` and hardcoded credentials went unreported in any ES-module or
  CommonJS-suffixed file. Found while reviewing `codeep-action`, whose own
  scripts are `.mjs`: its self-review had never applied a single security rule
  to itself.

  The extension is now normalised once, rather than widening thirteen arrays
  that would go stale on the next rule added. The directory walk picks these
  files up too, so a whole-project review no longer steps over them.

- **`foreach-await` never matched an arrow function.** The pattern required the
  `await` to follow forEach's *closing paren*, which only lines up for
  `function (x) {`. Every modern form went unreported, and the rule also only
  fired when `await` was the very first token in the body — so
  `{ out.push(await f(id)) }` was invisible. Both bounds stay explicit and both
  classes negated, so matching is linear.

- **A CI fix run gave up after 12 steps.** `codeep review --fix` capped the
  agent at 12 iterations, under half the product default. Fixing one `innerHTML`
  call and running the test suite exhausted it, and an agent stopped mid-edit
  leaves a worse diff than one that never started. Now 25, the same as
  everywhere else; the plan size and the caller's wall-clock are the real bounds.

## [2.22.0] — 2026-08-25

> Every run now records what it touched, including what the boundary refused — and four bugs that only a real session could surface.

### Added

- **`/audit` — what an agent actually did.** Each run appends to
  `.codeep/audit/` in the project: one JSON line per event, one file per day.
  It records reads and refusals, which `history.ts` does not, because that
  journal exists to undo writes rather than to say what happened. The most
  useful line is the one that never existed — a tool call the boundary
  refused. A capability limit nothing records is one you have to take on faith.

  File contents are deliberately absent. Undo already keeps them; a record you
  might hand to someone else should not carry your source with it. Command
  lines are kept, so treat the directory like shell history. `/audit off` stops
  recording without deleting anything already written.

- **`codeep review --fix`.** After reporting, hand the findings to an agent and
  let it edit the working tree. It runs under a files-and-tests boundary — no
  shell, no network, no git — enforced by the same gate as any custom bot, not
  suggested in a prompt. Suggestions are never eligible: acting on opinion
  produces churn and buries the findings that matter. It never commits,
  branches or pushes, and it never changes the exit code, because a fix that
  turned a red check green would hide the finding rather than resolve it.

### Fixed

- **Stop now stops during a retry.** Three waits in the agent loop used a plain
  timer that ignored the abort signal, so pressing Esc or Ctrl-C during
  "retrying in 10s" did nothing until the wait expired — and then the loop
  retried the request anyway. Found by trying to cancel one.
- **A run that failed is recorded as failed.** Several failure paths — a user
  abort, a 4xx from the provider — return without throwing, and the audit
  record read only the exception. Three runs that died at the provider were all
  logged as successful. A record that says a failed run passed is worse than no
  record.
- **A key with an invisible character now says so.** A non-Latin-1 character in
  an API key produced "Cannot convert argument to a ByteString because the
  character at index 10…", counted across `Bearer <key>` so it pointed seven
  characters left of the real one, never mentioned the key, and retried twice
  more. It now names the position in the key and fails immediately.

### Changed

- **`noUnusedLocals` earns its keep.** Turning it on in 2.21.0 caught a helper
  written for this release and never wired — the same shape as `reportTurnStats`
  shipping dead in 2.18.1, found this time within the hour.

## [2.21.0] — 2026-08-21

> Agents you delete on the dashboard now disappear from your machines, sync says when it failed instead of going quiet, and a dependency advisory is closed.

### Added

- **Deleting an agent on codeep.dev now reaches your machines.** It never did:
  the pull loop only iterated what the server returned, so a bot removed on the
  dashboard stayed on every client forever. The server now sends an explicit
  tombstone list and the CLI applies it — backing each file up to
  `~/.codeep/backups/personalities/` before removing it. Absence from the
  payload still means nothing at all: an expired session, the wrong account or
  a truncated response all produce an empty payload, and deleting on absence
  would wipe every local agent. Project-scoped agents in
  `.codeep/personalities/` are not cloud-owned and are never touched.

### Changed

- **Sync failures no longer look like success.** Every failure path returned
  `null` and the caller printed only when something changed, so a dead network,
  an expired token and "nothing new" were all the same silence. Pulls and pushes
  now report which of the four happened — not linked, unreachable, rejected, or
  a response this version can't read — and say "already up to date" when that is
  the truth.

### Fixed

- **A high-severity advisory in `js-yaml`.** Patch-level bump, one call site.
  The CLI's production dependencies now report zero advisories.

### Removed

- **A dead full-screen permission picker**, superseded by the in-app overlay and
  unreachable since. Its component and tests went with it — 142 lines that
  looked alive and had passing tests. `noUnusedLocals` is now on: it is the
  check that would have caught `reportTurnStats` shipping dead in 2.18.1, and it
  caught an unwired function inside an hour of being enabled.

## [2.20.0] — 2026-08-20

> GLM-5.3 reached Z.AI's pay-per-use API and now carries the rate they publish, instead of no price at all.

### Added

- **GLM-5.3 on the Z.AI pay-per-use API.** It shipped to GLM Coding Plan
  subscribers first; the standalone model API accepts it as of 2026-08-19, so
  it now appears on that roster too and is its default. The China gateway
  (`z.ai-cn`, `z.ai-cn-api`) is a separate listing that Z.AI's page does not
  cover, so it keeps the GLM-5.2 roster — offering an id a gateway rejects
  would be a guaranteed 4xx.

### Changed

- **GLM-5.3 is priced at $1.40 / $4.40 per 1M tokens.** It was carried unpriced
  by design: no per-token rate existed while the model was Coding-Plan only, and
  borrowing GLM-5.2's would have been an invented number. Z.AI now publishes one,
  and it happens to equal GLM-5.2's — a fact about today's price list, not a rule
  linking the two. `/cost` and the dashboard stop showing pay-per-use GLM-5.3
  traffic as free. Coding Plan usage is flat-fee and still reads "Included in
  plan".

## [2.19.0] — 2026-08-19

> Custom bots you can actually trust: pin a model, grant only the capabilities you choose, and scope a bot to the projects it belongs to — enforced at runtime across CLI, Mac, VS Code and the dashboard.

### Added

- **Portable, enforceable custom bots.** `custom-bot/v1` personalities can pin
  an exact `provider/model`, expose only selected Files/Terminal/Tests/Git/Web/
  MCP capabilities, and limit availability to all projects, selected project
  names, or personal mode. Legacy prompt-only personalities remain compatible
  and unrestricted. CLI, ACP, VS Code, macOS, and Dashboard Agent Studio share
  the same Markdown contract. Versioned files fail closed when tool metadata is
  missing or malformed, and invalid model/scope metadata cannot activate.
- **Native ACP custom-bot controls.** Clients can list, activate, and sync bots
  through `session/list_personalities`, `session/set_personality`, and
  `session/sync_personalities` without scraping chat output.

### Changed

- **Capabilities now say what they actually grant.** The builder promised that
  unselected tools are "removed from this agent's runtime", which reads as a
  guarantee that a Git-only bot cannot see file contents. It can:
  `git show HEAD:file` is functionally `cat file`, and history inspection
  (`log -p`, `diff`, `blame`) cannot be separated from the content it inspects.
  Nor is Git read-only: `git rm`, `git commit` and `git push` are on the
  allowlist, so a Git-only bot can rewrite the repo and publish the result.
  Every capability now carries a description, and choosing Git without Files
  spells out both halves — in the builder, in `/personality`, in the Mac persona
  sheet and in the VS Code picker. The enforcement is unchanged; the promise is
  now true.

- **Dashboard personality edits now reach local runtimes safely.** A manual
  cloud pull atomically applies changed personality bodies and backs up every
  divergent local copy under `~/.codeep/backups/personalities/`. Custom command
  pulls remain additive.


- **`App.ts` refactor begins: HunkPicker extracted.** The interactive
  `/apply --interactive` picker (state + key handling + rendering) moved from
  the 3.3k-line `App.ts` monolith into `components/HunkPicker.ts`, following
  the same `{ State, handleKey, render }` convention as Settings/Export/
  Search. App.ts now owns a single state field and wires it in. The picker
  logic is now unit-tested in isolation (12 tests pinning the y/n/a/q/↑/↓
  semantics and the fires-exactly-once `onComplete` contract) — previously
  untestable inline. First of several planned extractions (mention picker,
  paste dialog, autocomplete) to bring App.ts down to a manageable size.
- **PasteDialog extracted from App.ts.** The large-paste confirmation
  ("Paste Detected" with Add/Send/Cancel) moved to
  `components/PasteDialog.ts` in the same shape. The key handler returns
  `{ state, action }` — a discriminated action union (`add-to-input` /
  `send-directly` / `cancel` / `none`) — so App keeps the side effects
  (editor insert, message submit, notification) while the decision logic is
  pure and unit-tested (7 tests).
- **MentionPicker extracted from App.ts.** The mid-sentence `@file`
  autocomplete (5 state fields) moved to `components/MentionPicker.ts`.
  The load-bearing `@`-sigil buffer math (re-adding the `@` after slicing,
  without which a completed path silently stops being a mention and the file
  never gets attached) now lives in a pure `applyMentionToBuffer()` covered
  by tests, including cursor positioning and mid-buffer replacement (9
  tests).
- **CommandAutocomplete extracted from App.ts.** The `/command` picker (3
  state fields) moved to `components/CommandAutocomplete.ts` — same shape
  as MentionPicker (pure key handler + `commandToBuffer()` buffer math,
  9 tests). With this, all four picker-style widgets live outside App.ts as
  testable components.
- **Shared command core established (`commands/core/`).** `/telemetry` and
  `/keysync` are the first commands whose semantics (env-var hard-off
  checks, config toggling, status facts) live in one place used by BOTH the
  TUI and ACP dispatch — previously two hand-maintained copies that could
  (and did) drift in wording and behavior. Surfaces now only render the
  `CommandResult`. The env-var invariants (CODEEP_NO_TELEMETRY,
  CODEEP_NO_KEY_SYNC overriding any config flag) and the
  server-readable-keys disclosure are pinned by 11 unit tests. Remaining
  ~38 shared commands migrate incrementally, same pattern.

- **Default rate limits lowered from effectively-unlimited.** New configs get
  `rateLimitApi: 240`/min and `rateLimitCommands: 120`/min — generous for a
  full 50-iteration agent run, but a runaway loop now stops instead of
  burning quota. Existing configs are untouched; tune via `/settings`.

### Fixed

- **Stray characters no longer survive in the TUI.** The screen paints
  differentially — a cell whose value already matches the shadow copy is
  skipped — which meant a BLANK cell was never emitted at all. Column 0 of the
  header is blank (the wordmark starts at x = 1), so whatever the terminal
  happened to show there before Codeep started stayed for the whole session; the
  session picker and confirm prompt kept it on screen, and only resizing the
  window cleared it. Both overlays now invalidate the shadow on the way in and
  out, and the invalidation fills it with a sentinel no real cell can hold, so
  blanks repaint too.

- **An aborted or failed turn reports its tokens again.** 2.18.1 shipped a
  `reportTurnStats` helper that was defined but never called: the success path
  kept an inline duplicate, so cloud stats kept working there, while the catch
  path reported nothing at all. Tokens burned by a turn you stopped with Esc, or
  that errored, reached no one — and `gracefulShutdown` no longer sends the
  cumulative catch-all that used to sweep them up. Both paths now go through the
  one helper, and the inline copy is gone. `tsc` stayed silent about the dead
  function because `noUnusedLocals` is off.

- **SSRF guard now covers `curl`/`wget`/`http`/`https` in `execute_command`.**
  The `fetch_url` tool already blocked private/loopback/metadata IPs
  (169.254.169.254), but the same model-controlled URL could simply be passed
  to `curl` instead and sail through. URL arguments (including scheme-less
  host forms like `curl 169.254.169.254/latest` and hostnames that resolve
  privately) now go through the identical `assertFetchUrlAllowed` check. The
  guard moved to a shared `utils/ssrfGuard.ts` module so `fetch_url` and the
  shell path can't drift apart.
- **`env` removed from the agent command whitelist.** A single `env` call
  dumped `process.env` into the model's context — including every provider
  API key riding in environment variables. Run `env` yourself outside the
  agent if you need environment info.
- **Exec-escape flags blocked on whitelisted utilities.** `find -exec`,
  `-execdir`, `-ok`, `-okdir` and `tar --to-command` spawn arbitrary commands
  as arguments, silently bypassing the command whitelist
  (`find . -exec rm -rf / \;`). Plain `find`/`tar` usage is unaffected.


- **Rate limiting is now enforced everywhere.** Previously `checkApiRateLimit`
  was called only on the TUI's manual-chat path and `checkCommandRateLimit`
  had no production call sites at all — an autonomous agent run (up to 50
  iterations, each with its own API call and shell commands) was completely
  unthrottled. The guards now live at the transport layer: `chat()` in
  `api/index.ts` and `agentChat()`/`agentChatFallback()` in
  `utils/agentChat.ts` (covering TUI, ACP sessions, sub-agents and session
  titles), plus `execute_command` in `utils/toolExecution.ts`. Local no-key
  providers (Ollama) bypass the API limiter — there's no quota to protect on
  localhost. The duplicate check in the TUI submit path was removed so a
  request isn't counted twice. Source-level regression tests in
  `rateLimitWiring.test.ts` keep the guards from being silently dropped.

### Removed

- **Nothing removed** — the earlier note in this section was wrong: on
  case-insensitive filesystems `readme.md` and `README.md` are the same file,
  so "the duplicate" never existed and deleting it would have deleted the
  README itself. (Caught before release; restored from git.)

## [2.18.1] — 2026-08-15

> The last place `/cost` still priced plan usage: the prompt-caching savings line quoted dollars for subscription providers that bill a flat fee.

### Added

- **`npm run export:catalogue`** writes the shipped model catalogue to
  `Codeep-web/src/data/catalogue.json` straight from `PROVIDERS` and the
  context/pricing tables, so codeep.dev renders what the client actually
  offers instead of a hand-kept list that had drifted to 4 models against a
  catalogue of 72.

### Fixed

- **Prompt-caching "savings" no longer invents money on a plan.** `/cost`
  priced cached tokens at the provider's pay-per-use input rate even on Z.AI's
  Coding Plan, MiniMax, Kimi and Qwen — where caching saves latency, not money,
  because nothing is billed per token. The cache read/write counts stay (they
  are measured); the dollar figure now covers pay-per-use models only and says
  so when a session mixes both, and a plan-only session reads "caching saves
  latency, not money" instead. The `billed at 0.1× / 1.25× input rate` notes are
  likewise dropped where no per-token billing applies.

## [2.18.0] — 2026-08-15

> Subscription plans stop inventing dollar amounts — GLM Coding Plan, MiniMax, Kimi and Qwen now read "included in plan". Adds Grok 4.6, Gemini 3.7 Flash and GLM-5.3, and halves a Gemini rate stored at double.

### Added

- **Grok 4.6** (`grok-4.6`) — xAI's flagship reasoning model, 500K context,
  recommended for code. The xAI default deliberately stays on
  `grok-build-0.1`: 4.6 bills 2× input and 3× output, so it is opt-in via
  `/model` rather than a silent upgrade for everyone.
- **Gemini 3.7 Flash** (`gemini-3.7-flash`) — 1M context, Google's current
  workhorse for coding and agents.
- **GLM-5.3** (`glm-5.3`) — 1M context, on the GLM Coding Plan. Z.AI publishes
  no per-token rate and its standalone API is still "coming soon", so the model
  carries no price at all rather than borrowing GLM-5.2's.
- **Gemini gains its medium thinking tier.** `/thinking` now offers
  low · medium · high on Gemini instead of collapsing medium into high. Medium
  is Gemini 3.7 Flash's own default and the level Google recommends for agentic
  coding; it used to be dropped because Gemini 3 *Preview* rejected it, which
  has since been fixed.

### Changed

- **Subscription providers no longer quote a price.** Z.AI's GLM Coding Plan,
  MiniMax, Kimi's Coding Plan, Qwen's plans and the free ModelScope tier bill a
  flat fee or nothing, yet their tokens were priced at pay-per-use rates.
  `/cost`, `/stats` and the status bar now read "included in plan"; a session
  mixing both shows the metered figure plus a note. Token counts, context and
  the energy/water estimates are unchanged — those are measured.

### Fixed

- **Gemini estimates were double.** `gemini-3.6-flash` was stored at the
  post-promotional 1.50/7.50 rather than the 0.75/3.75 actually charged through
  2026-12-31, so every Gemini cost read 2× high. Both tiers step back up on
  2027-01-01; the table names the date.
- **Gemini 3.7 Flash was sent `temperature`.** That generation removed the
  sampling parameters, and the rule that omits them was only consulted on the
  Anthropic request path — Google is served over the OpenAI-compatible one, so
  the guard never ran. The same fix closes a related gap where namespaced
  OpenRouter ids (`google/gemini-3.7-flash`, `anthropic/claude-opus-4.8`)
  slipped past it entirely.

## [2.17.0] — 2026-08-14

> A redesigned agent view: a live PLAN → READ → EDIT → VERIFY timeline with changed files and checks in a side rail, a persistent header, and energy/water estimates beside cost. Plus a self-migrating model catalogue.

### Added

- **Agent timeline TUI.** While the agent runs, the screen is now a staged
  timeline — `PLAN → READ → EDIT → VERIFY → SUMMARY` — with the active stage
  highlighted, a per-stage one-line summary, the current tool target, and a
  progress bar against the iteration budget. On terminals ≥132 columns a
  context rail on the right lists the files touched (`A`/`M`/`D`), the
  verification commands and their pass/fail state, and the project + branch.
  Terminals below that width get the same timeline without the rail.
- **Persistent header.** Version, session, model, provider, project and git
  branch now sit on a fixed top line instead of only being reachable through
  `/status`. Segments drop out progressively as the terminal narrows, so the
  line never wraps.
- **Resource-impact estimates.** `/cost`, `/stats` and the wide status bar now
  show an estimated energy and water range for the session's token count
  (`src/utils/resourceImpact.ts`). These are explicitly labelled ranges
  derived from published inference benchmarks — 0.3–1.5 J/token and
  0.27–1.08 L/kWh — never presented as provider measurements.
- **Live ModelScope catalogue in `/model`.** Selecting the ModelScope provider
  fetches its free-tier catalogue for your token instead of showing a single
  hardcoded id, falling back to the built-in entry if the fetch fails.
- **Graded reasoning effort on Kimi K3.** `/thinking` now offers
  `low · high · max` on K3; the global `medium` tier collapses to `high`, and
  the status chip shows the level the model will actually run.

### Changed

- **Model catalogue refresh.**
  - New **Qwen Token Plan** provider (`qwen-token-plan`) for `sk-sp-…`
    subscription keys, defaulting to `qwen3.8-max-preview`.
  - Qwen's hosted line moves to **3.5–3.8**: `qwen3.8-max-preview`,
    `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.6-flash`,
    `qwen3.5-plus` — replacing the `qwen3-coder-*` aliases.
  - **Kimi K3 consolidates to a single `kimi-k3` id** on the pay-per-use
    endpoints (the `-code`, `-code-highspeed` and `-thinking` splits are gone);
    the Kimi Code subscription keeps `k3` / `k3-256k`.
  - **Gemini 3.5 / 3.6 Flash** (plus 3.5 Flash Lite) replace the 3.1 Flash
    entries.
  - OpenRouter now defaults to **`openrouter/auto`**.
  - Context-window and pricing tables were refreshed in lockstep, and
    `providers.test.ts` now enforces that every curated model has both a
    context entry and a pricing row (or a documented exemption).
- **Retired model ids migrate automatically.** GPT-5.4 / 5.4-mini / 5.5, the
  Grok `grok-code-fast-1` and `grok-4-fast-reasoning` aliases, the Kimi K3
  variants, GLM-5 / 5.1 and the `qwen3-coder-*` ids are rewritten to their
  supported replacements on first launch — and now also when you load a saved
  profile with `/profile load`. Dynamic OpenRouter, Ollama and custom ids are
  never rewritten.

### Fixed

- **Cloud stats double-counted tokens.** Every prompt reported the *cumulative*
  session totals to the append-only dashboard endpoint, so a three-prompt
  session was stored as 1× + 2× + 3× its real usage; shutdown then reported the
  whole session once more. Each turn now reports only its own delta, and the
  shutdown re-report is gone. Dashboard token counts and costs are accurate
  again.
- The status bar dropped the **`Esc to stop`** hint on wide terminals, because
  the resource-impact estimate and the hint shared one slot and the estimate
  always won. The hint now owns the right edge and the estimate uses whatever
  gap is left. The reasoning-effort chip is shown in the wide footer too.
- The header's `branch:` segment rendered nothing at all whenever the branch
  name was long enough to need truncating — the truncation budget didn't
  account for the separator and label, so the segment always failed its own
  fit check.
- Long CJK / emoji text in the agent timeline overflowed its pane by up to 2×
  and broke the divider: width budgeting measured `String.length` while the
  screen advances by display columns.
- `--version`, `--help` and `account` no longer spawn git subprocesses at
  startup; the header branch is resolved on first use and re-read after an
  agent run, so it no longer goes stale when the agent switches branches.

## [2.16.0] — 2026-07-25

> `@mentions` inline file context — type `@src/file.ts` anywhere in your message and the file's contents are attached to that message. No more `/add` + `/drop` dance for one-off file references.

### Added

- **Kimi K3** (Moonshot) joins the pay-per-use rosters — `kimi-k3-code` (the
  new default), `kimi-k3-code-highspeed`, and `kimi-k3-thinking`, on the
  international and China endpoints. K3 carries a **1M** context window (vs
  256K on K2.x) and the thinking variant returns explicit reasoning traces;
  both K3 code models are in the sampling-params guard since they fix
  temperature internally. The `tokenTracker` context and pricing tables list
  all three, so the context gauge and cost readout are right — without the
  entries they fell back to a 128K window, which would have shown the gauge
  as nearly full at ~1/8 of the real budget and triggered compaction far too
  early. Pricing follows the Kimi family rate ($0.60/$2.50 per MTok); adjust
  if Moonshot publishes a different K3 rate.
- **Claude Opus 5** replaces Claude Opus 4.8 in the Anthropic model list and
  becomes the default. Same $5/$25 per-MTok pricing and 1M context, with the
  full `low`→`max` effort ladder. The reasoning-effort gate, the
  sampling-parameter guard, and the `tokenTracker` context/pricing tables were
  all updated in lockstep, so `/thinking` and the cost readout are correct for
  it. (Opus 4.8 still routes correctly if a saved session pins it.)


- **`@mentions` inline file context (CLI + Mac).** Type `@path/to/file`
  anywhere in your message and its contents are loaded as an
  `[Attached files]` block for that message only — no need to `/add`
  and remember to `/drop` afterwards. Works alongside the existing
  `/add` (persistent) and pinned-files (Mac) mechanisms.
  - Forms: `@src/file.ts` (relative to project root), `@./local.ts`
    (relative to cwd), `@/abs/path` (absolute), `@~/path` (home),
    `@"file with space.ts"` / `@'...'` (quoted).
  - GitHub handles (`@octocat`) and emails (`user@host`) are left
    untouched — only paths containing `/`, `.`, `_`, or `-` are
    treated as mentions.
  - Files over 100 KB are skipped with a warning (same cap as `/add`);
    binaries (NUL-byte detection) are rejected.
  - Failures surface inline (`@missing.ts: file not found`) without
    aborting the message — the agent still sees the rest.
  - **CLI:** `src/utils/mentions.ts` (+36 tests) — pure parser,
    integrated into `handleSubmit` in `main.ts`.
  - **Mac:** `CodeepCore/Agent/MentionExpander.swift` (+14 tests) —
    byte-for-byte parity with the CLI, integrated into
    `ChatView.send(agent:)`.
- **`@mention` autocomplete picker (CLI).** Typing `@` mid-sentence now
  opens a file picker below the input — arrow keys navigate, Tab
  inserts the selected path. Skips `node_modules`, `.git`, binaries.
  Cached per-root (5 s TTL) so keystrokes stay snappy on large repos.
  - `detectMentionQuery` in `components/Autocomplete.ts` (+11 tests)
    tracks the cursor inside an in-progress mention.
  - `suggestMentions` in `utils/mentions.ts` powers the picker; the
    `/command` and `@mention` pickers never compete (one opens at a
    time depending on cursor position).
- **`@web <url>` inline web context (CLI + Mac).** Type
  `@web https://example.com/docs` (or `@web example.com/docs`) and the
  page is fetched, converted to readable text, and attached to the
  message — same `[Web pages]` block shape as file mentions.
  - Forms: full URLs (`@web https://…`, `@web http://…`) and bare hosts
    (`@web docs.example.com/api`, auto-`https://`).
  - HTML is stripped to text (scripts/styles removed, links kept as
    `text (url)`); plain-text and JSON responses pass through as-is.
  - Output capped at 32 KB; 12 s fetch timeout; binary/PDF content
    types rejected with a clear reason.
  - **CLI:** `src/utils/webFetch.ts` (+33 tests), integrated into
    `handleSubmit` in `main.ts`.
  - **Mac:** `CodeepCore/Agent/WebMentionExpander.swift` (+14 tests),
    integrated into `ChatView.send(agent:)` (now `async`).
- **`@folder <path>` inline directory context (CLI + Mac).** Type
  `@folder src/components` (or `@dir …`) and every source file under the
  directory is loaded recursively into a single `[Attached files]` block,
  merged with `@file` mentions. Same ignore rules as the autocomplete
  scanner (`node_modules`, `.git`, binary extensions, dotfiles). 200 KB
  total cap per mention, 6-level depth limit, deduplicated across
  overlapping folders. Quoted paths supported: `@folder "my dir"`.
  - **CLI:** `expandFolderMentions` + `expandFileAndFolderMentions`
    (merged single-block output) in `utils/mentions.ts` (+21 tests);
    `main.ts` now calls the combined expander.
  - **Mac:** `CodeepCore/Agent/FolderMentionExpander.swift` (+13 tests),
    wired into `ChatView.send` ahead of `@file`/`@web`.
- **Selective per-hunk apply (CLI + Mac).** The diff pipeline now
  supports applying a subset of a file diff's hunks, leaving rejected
  hunks' original lines intact (`git add -p`-style granularity).
  - **CLI:** `applyHunks` / `applyHunksToFiles` / `countChangeHunks` in
    `utils/diffPreview.ts` (+17 tests). `/apply` now shows per-file hunk
    counts and accepts `--only file.ts:0,1 other.ts:2` to apply only
    the chosen hunks. Without `--only` the original all-or-nothing
    behavior is unchanged.
  - **Mac:** `CodeepCore/Agent/HunkApplier.swift` (+11 tests) — same
    algorithm, Swift-native `FileDiff`/`DiffHunk`/`DiffLine` types.
    (UI integration — SwiftUI hunk-picker modal — to follow.)
- **`@git <ref>` inline context (CLI + Mac).** New `@git` mention
  injects git diffs, commit patches, and file-at-ref content into the
  prompt as a `[Git ref]` block — same UX family as `@folder`/`@file`/
  `@web`. Supported forms: `@git diff`, `@git diff --staged` (or
  `staged`), `@git HEAD` / `@`, `@git <sha>`, `@git main:src/x.ts`
  (file at ref), `@git diff a..b` (range), or any quoted ref
  (`@git "diff HEAD~3"`). Capped at 64 KB/mention (truncated with a
  marker); unknown refs surface a friendly failure note.
  - **CLI:** `getGitContent` in `utils/git.ts` (+12 tests),
    `expandGitMentions`/`extractGitMentions` in `utils/mentions.ts`
    (+11 tests), wired into `main.ts` between `@file`/`@folder` and
    `@web`.
  - **Mac:** `CodeepCore/Agent/GitMentionExpander.swift` (+10 tests),
    wired into `ChatView.send` in the same order.
- **Interactive hunk picker (`/apply --interactive`).** A `git add -p`-style
  review modal walks you through each change hunk one at a time. Keys:
  `y`/Enter accept, `n` skip, `a` accept all remaining, `q`/Esc quit,
  `↑`/↓ navigate. The chosen hunks are applied via the existing per-hunk
  apply pipeline. Reuses the modal/state plumbing of the inline
  `showConfirm` dialog. CLI only (Mac UI modal to follow).
- **Session web cache (`@web`).** Successful `@web` fetches are now
  cached for 30 minutes (per session, max 50 entries, LRU eviction)
  so a second `@web` for the same URL is instant and free. Failures
  are never cached. New `/web-cache` command (alias `/webcache`) shows
  stats and `/web-cache clear` resets. URL keys are normalized
  (lowercased host, trailing slash stripped, fragment dropped) so
  `example.com/path` and `https://example.com/path/` share an entry.
- **ACP mention parity (VS Code / Zed).** The ACP path
  (`src/acp/session.ts`) now expands `@file`/`@folder`/`@git`/`@web`
  mentions the same way the TUI does — previously ACP sent the raw
  prompt with no inline-context resolution. Failures surface as
  thoughts in the editor. (+2 smoke tests in `session.test.ts`.)
- **Command alias resolution.** `handleCommand` now resolves aliases
  via the registry's `resolveCommand` before dispatching, so e.g.
  `/webcache` reaches the `web-cache` handler without a duplicate
  case label.
- **Mac: SwiftUI hunk picker sheet.** `HunkPickerSheet` (CodeepCore)
  is the Mac counterpart to the CLI's `/apply --interactive`: walks
  the user through each change hunk, toggling accept/skip, with
  keyboard shortcuts (y accept, a accept all, arrows navigate).
  Built on the existing `HunkApplier.FileDiff`. (+6 unit tests for
  the pure `items(from:)` builder + header formatting.)
- **Mac: session web cache (`@web`).** `WebMentionExpander` now
  caches successful fetches for 30 min (per session, max 50 entries,
  LRU) — full parity with the CLI's `webCache`. Failures are not
  cached. URL keys are normalized (lowercased host, trailing slash
  stripped, fragment dropped). New public API: `clearCache()`,
  `cacheStats()`. (+5 Swift tests.)
- **Mac: clipboard image paste.** The composer now accepts Cmd+V
  with an image on the pasteboard (alongside the existing file
  picker attach). Images are downscaled + JPEG-compressed through
  the same `ImageResize` pipeline, gated by `supportsVision`.
- **Mac: hunk picker wired into ConfirmationSheet.** `edit_file` /
  `write_file` confirmation prompts now offer a "Review hunks" button
  that opens `HunkPickerSheet` over the call's diff. New
  `HunkApplier.diffFromEditCall` / `diffFromWriteCall` builders
  derive a `FileDiff` from tool-call arguments. (+5 Swift tests.)
- **Mac: `/web-cache` slash command.** Parity with the CLI —
  `/web-cache` shows session cache stats, `/web-cache clear` wipes
  it. Aliases: `/webcache`, `reset`, `flush`. (+6 Swift tests.)
- **Mac: drag & drop image onto composer.** Dropping an image file
  onto the input bar attaches it (same resize/JPEG pipeline as paste
  and the file picker), with a brand-tinted drop affordance ring.
- **Mac: `/usage` slash command.** Pops the toolbar's token + cost
  breakdown popover from the composer — parity with the CLI's
  `/usage`. Aliases: `/stats`, `/cost`. (+2 Swift tests.)
- **Mac: dock icon unread badge.** When the app is in the background
  and an agent finishes a turn, the conversation's unread counter
  bumps and the dock icon shows the total. Clicking the app to bring
  it frontmost, or selecting the conversation, clears its badge.
  `Conversation.unreadCount` is session-only (never persisted — no
  phantom badges across launches). (+3 Swift tests.)
- **Mac: slash-command autocomplete popover.** Typing `/` in the
  composer opens a filtered list of commands; ↑/↓ navigate, Tab/Return
  accept, Escape closes. New `SlashCommandHandler.catalog` + pure
  `suggestions(for:)` filter (boundary-aware — ignores `/` inside
  URLs, suppresses after a space when the user is in the argument).
  (+10 Swift tests.)
- **Mac: Conversation menu bar group.** Mirrors the slash commands in
  the menu bar (Scan, Plan Mode, Show Usage, Show/Clear Web Cache, New
  Chat) with shortcuts. Wired through a new
  `.codeepRunSlashCommand` notification so menu items reuse the
  composer's dispatch path.
- **Mac: App Intents for Plan / Usage / Web Cache.** Spotlight +
  Shortcuts + Siri phrases for "Codeep Plan Mode", "Show Usage",
  "Clear Web Cache". Reuses a new `.slashCommand(raw:)` case on
  `PendingIntentAction` so intents route through the same slash
  dispatch as typing the command. (+3 CodeepCore tests.)
- **Mac: Settings refactored into tabs.** The 1450-line monolithic
  Form is now four focused tabs — **General** (appearance, accent,
  response language, system prompt, About Me), **Model & Agent**
  (confirmation, self-verify, model parameters, limits, hooks),
  **Providers** (API keys, endpoints, Ollama, OpenRouter), and
  **Tools & Privacy** (privacy/cloud, tool permissions, MCP, skills).
  Active tab persists across sheet re-opens.
- **Mac: Keyboard Shortcuts cheat sheet.** `Help → Keyboard Shortcuts…`
  (⌘?) opens a catalog of every shortcut in the app, grouped by
  surface (App, Conversations, Composer, Chat & tools, Slash commands).
  Static `ShortcutCategory` catalog is the single source of truth.
  (+5 Swift tests.)
- **Mac: custom accent colors.** Settings → General → Accent lets you
  pick from 9 preset colors (Codeep Red default + Orange, Amber, Green,
  Teal, Blue, Indigo, Purple, Pink). Applies live to `.tint()` across
  the whole app via a reactive `@AppStorage`. New `AccentChoice` enum.
  (+7 Swift tests.)
- **Mac: Quick Agent pinned prompts.** The ⌥Space panel now shows a
  horizontally-scrolling strip of pinned one-click starters (seeded
  with sensible defaults on first launch). Right-click to remove; a
  "Pin" button appears when there's draft text to save. New
  `QuickPromptStore` (UserDefaults-backed, `@Observable`) + pin sheet.
  (+14 Swift tests.)

### Security

- **`@git <ref>` no longer executes shell commands.** The ref was interpolated
  into a string run through `/bin/sh`, so prompt text containing
  `@git HEAD; <command>` ran that command — reachable from anything pasted into
  a prompt (an issue body, a log, model output routed over ACP). git is now
  spawned via argv with no shell, and refs are validated; `@git diff` flags are
  allow-listed so a ref can't be smuggled in as `--output=…` either.
- **Mentions no longer auto-inline secret files.** `@.env`, `@~/.aws/credentials`,
  `*.pem`, `id_rsa` and friends are refused with a pointer to `/add`, so a
  pasted mention can't ship credentials to the provider.
- **`@web` won't follow a redirect into your private network.** A public URL
  that redirects to loopback/RFC1918/link-local (including the cloud-metadata
  endpoint) is refused. Directly typing `@web http://localhost:3000` still
  works — that's the documented dev-server case. The fetch timeout now covers
  the response *body* (a slow-drip reply could hang the chat forever), the body
  is read with a hard byte cap instead of being buffered whole, and the timer
  can no longer leak on failure.

### Fixed

- **The `@`-mention picker no longer draws over the chat.** It was missing
  from the layout snapshot entirely, so the bottom panel measured zero rows
  while the picker still painted up to eleven — straight over the end of the
  transcript.
- **The suggestion scan is bounded.** It ran on the first `@` keystroke with
  no file cap and a `statSync` per entry, so opening the picker in a large
  monorepo blocked the render loop for seconds. Capped at 20k entries and
  switched to `readdirSync(withFileTypes)`, which drops a syscall per file.
- **`@~name` resolves correctly.** Only `~/` is treated as a home reference;
  a bare `@~foo/bar.ts` used to become `$HOME/oo/bar.ts` and report a
  confusing "file not found".

- **`/apply` no longer corrupts files whose changes are close together.**
  Unified-diff context overlaps between adjacent hunks; the applier replayed
  each hunk in sequence, so shared context lines were written twice — and with
  a small gap a later hunk's deletion landed inside an earlier hunk's context
  and was silently dropped. Rebuilt as a per-line union, with a regression test
  sweeping the hunk gap.
- **`/apply --only` with a malformed spec applied *everything*.** The selective
  branch fell through to the apply-all path, doing the opposite of what was
  asked. It now reports the bad spec and applies nothing.
- **Tab-completing an `@`-mention dropped the `@`**, so the completed path was
  no longer a mention and the file was never attached — the picker broke the
  feature it exists to serve. The picker's boundary rule is now shared with the
  expander so the two can't drift apart again.
- **Every `@`-mention attached its file twice**, doubling the token cost of
  each mention: the merged file+folder path stripped its own attachment block
  back out with a lazy regex that removed only the header.
- **`/apply` on a very large file no longer crashes the CLI** — a spread-based
  `Math.min` over the hunk's line numbers blew the argument limit and surfaced
  as an unhandled rejection. The apply paths also report failures as a toast
  instead of dying.

## [2.15.0] — 2026-07-13

> Cross-tool rules + MCP config parity: Codeep now reads `AGENTS.md` (Claude Code / Cursor / Kilo Code standard) as a third project-rules source, and `.mcp.json` at the workspace root as a fourth MCP config source — so users coming from those tools don't have to duplicate config.

### Added

- **New provider models.** Refreshed the catalog for the current release:
  OpenAI's **GPT-5.6** family — `gpt-5.6-sol` (new default, $5/$30 per MTok,
  1.05M context), `gpt-5.6-terra` ($2.50/$15), and `gpt-5.6-luna` ($1/$6);
  xAI **`grok-4.5`** (flagship reasoning, $2/$6, 500K context); Google
  **`gemini-3.1-flash-lite`** (low-latency workhorse, $0.25/$1.50, ~1.05M
  context); and **`qwen3.7-max`** (replaces `qwen3-max`, $2.50/$7.50, 1M
  context) across all four Qwen variants. Model lists, the OpenRouter seed,
  reasoning-effort gates, and the `tokenTracker` context + pricing tables
  (`src/config/providers.ts`, `src/utils/tokenTracker.ts`) were updated in
  lockstep, so cost and context-window estimates are correct for each id.

- **Cross-device session resume (`/cloud`).** The CLI can now pull sessions
  synced from other devices (Mac app, VS Code, another CLI machine) and
  resume them locally. `src/utils/codeepCloud.ts` gained
  `listCloudSessions(projectId?)` and `pullCloudSession(sessionId)` —
  thin `x-sync-token`-authenticated wrappers over the existing
  `GET /api/sessions` endpoint (which already served the web dashboard).
  The new `/cloud` slash command lists remote sessions scoped to the
  current project (or all if none is open), and on selection fetches the
  full message array, persists it into the local `.codeep/sessions/`
  store via `saveSession`, and loads it — so the resumed session is
  first-class: it shows up in `/sessions`, autosaves on the next change,
  and re-syncs on the next turn.

  Why: the push path (`syncSession` → `POST /api/sessions`) has existed
  since 2.0, and the Mac app and web dashboard already read from the
  cloud store. The CLI was the only surface that could push but not
  pull, so cross-device resume — start on the desktop, continue on the
  laptop — was impossible from the terminal. Now it isn't.

  `telemetry` is deliberately NOT consulted on the pull path: reading
  your own previously-pushed data back is not telemetry, and the user
  is explicitly asking for it. The original push was already gated.

- **`AGENTS.md` project-rules support** (closes #3). `loadProjectRules`
  (`src/utils/agentChat.ts`) now falls back to `AGENTS.md` when neither
  `.codeep/rules.md` nor `CODEEP.md` exists. Lookup precedence (highest
  first): `.codeep/rules.md` → `CODEEP.md` → `AGENTS.md`. First non-empty
  file wins; they are not concatenated, so a user can keep a trimmed
  `AGENTS.md` for the other tools and a richer Codeep-specific rules file.

  Why: `AGENTS.md` is becoming the de-facto cross-tool project-rules
  standard. Users coming from Claude Code, Cursor, or Kilo Code can now
  point Codeep at their existing file without duplicating rules into a
  Codeep-specific file.

- **`.mcp.json` MCP config source** (closes #5). `loadMcpServerConfig`
  (`src/utils/mcpConfig.ts`) now reads `.mcp.json` at the workspace root
  in addition to `.codeep/mcp_servers.json`. Same JSON shape, same
  `mcpServers` map/array form. Precedence chain (highest first):
  `.codeep/mcp_servers.json` (project) → `.mcp.json` (project, cross-tool)
  → `~/.codeep/mcp_servers.json` (global). Non-colliding server names
  from all sources merge; on collisions, higher-precedence sources win.

  Why: Claude Code, Cursor, and Kilo Code already read `.mcp.json` at
  the repo root. Users can now keep one MCP config file for their whole
  toolset.

- **Web dashboard: cache-savings insight card.** The main dashboard
  (`Codeep-web/src/app/dashboard/page.tsx`) now shows a green insight
  banner when the user has any cache reads: "Prompt caching saved you
  ~$X" with the total cache-read tokens and a circular cache-hit-ratio
  gauge. Cost-by-model rows gained a ⚡ badge with per-model cache-read
  counts. Brings the dashboard to parity with the macOS app's existing
  "Saved $X via caching" display.

  The savings estimate assumes $3/1M input rate (a common flagship
  rate) and a 90% discount for cache reads. It's a ballpark — the
  actual billed cost is already shown via `estimated_cost`. The point
  is the "you avoided spending ~$X" framing, which is what users
  actually want to see.

### Security

- **Workspace MCP servers now require a one-time trust approval.** MCP
  servers defined by files that travel WITH a repo — `.codeep/mcp_servers.json`
  and the new `.mcp.json` — no longer auto-spawn at startup: cloning a
  repository containing one of these files would otherwise execute
  repo-author-chosen commands on your machine before you typed anything.
  The TUI now shows the server list and asks once per workspace ("Trust &
  start"); ACP sessions (Zed, VS Code) skip untrusted workspace servers with
  a notice. Manage with `/mcp trust` / `/mcp untrust` (mirrors the existing
  per-workspace hooks trust). Global `~/.codeep` servers and ACP-provided
  servers are your own config and start without a prompt.
- **`/cloud` hardening.** Cloud API responses are now shape-validated before
  use (malformed payloads degrade to the normal "unavailable" path instead of
  throwing mid-picker), and the pulled session id is whitelisted before being
  used as a local filename — a hostile or corrupted server response could
  otherwise write outside `.codeep/sessions/`.
- **Project rules are capped at 64KB** when injected into the system prompt
  (applies to `.codeep/rules.md`, `CODEEP.md`, and the new `AGENTS.md`), so an
  oversized rules file can't bloat every request or overflow small-context
  models.

### Fixed

- **`/cloud` resume left session identity half-updated.** The pulled session
  now also updates `config.currentSessionId` (autosave and agent-mode sync
  previously kept writing under the PREVIOUS session's id) and the session
  display name (the next sync would have renamed the cloud record to the old
  session's title). If a local copy of the pulled session is newer than the
  cloud record, the local copy is loaded instead of being overwritten.
- **`/cloud` cross-device listing actually finds your sessions now.** Scope
  is a hash of the local *absolute* project path, so the same repo cloned at
  a different path on another machine (the normal cross-device case) produced
  an empty list. When the project-scoped list is empty, `/cloud` now falls
  back to listing all sessions; when it's non-empty it appends a "Show all
  cloud sessions…" entry so a differently-pathed session is still reachable.
- **`.mcp.json` now expands `${VAR}` / `${VAR:-default}` env references**
  (all MCP config files do), matching Claude Code semantics — previously the
  literal `"${GITHUB_TOKEN}"` string was passed through and even shadowed a
  real environment variable of the same name at spawn time.
- **Truncated action targets show the `...` marker again** — the path
  shortener lost it for very long paths during the `ActionFormatting`
  extraction.
- **Lifecycle hooks degrade gracefully on Windows without a POSIX shell**
  (closes #4). `.sh` hooks can't be spawned directly on Windows; previously a
  `pre_tool_call` / `pre_commit` hook would fail to spawn and — because those
  events are blocking — could wedge every tool call. Codeep now detects the
  platform's shell: it runs `.sh` hooks through Git Bash's `sh` when installed,
  and when no POSIX shell is found reports an explicit *"cannot run on this
  system"* state in `/hooks` and the welcome banner and **skips** them (never
  blocking). A new README "Windows notes" section documents which features need
  a shell (hooks) and which are Node-native (rules, commands, skills, MCP config).

### Breaking (Linux / Windows)

- **Stored API keys need a one-time re-login after the keytar →
  `@napi-rs/keyring` migration** (closes #6). The two libraries use different
  credential-store naming on Linux (Secret Service attributes) and Windows
  (Credential Vault target names), so keys saved by Codeep ≤ 2.14 are not
  visible to the new backend there. The CLI detects this and prints a
  one-time hint; re-add keys with `/login <provider> <key>`. macOS is
  unaffected (both use the same Keychain items). Keychain access now also
  runs off the event loop (`AsyncEntry`), so the TUI no longer freezes while
  macOS shows a keychain-authorization dialog.

### Changed

- **CLI: `App.ts` message-formatting extracted into `MessageFormatter.ts`.**
  The 3.2k-line `App.ts` had five pure (or near-pure) formatting methods
  inlined as `private` — `wordWrap`, `applyInlineMarkdown`, `formatTextLines`,
  `formatCodeBlock`, `formatMessage` — totalling ~600 LoC. Pulled them out
  into `src/renderer/components/MessageFormatter.ts` (443 LoC) as
  module-level functions, following the same `components/` pattern already
  used by `Settings`, `Export`, `Search`, etc.

  The only non-trivial change: `codeBlockCounter` (previously a `private
  number` on `App`) is now a `BlockCounter` object (`{ current: number }`)
  threaded through `formatMessage` by reference, so the counter still
  increments across consecutive calls during a single render pass — block
  numbers for `/copy [n]` stay stable.

  Also removed a duplicate `wordWrap`: the chat-flavoured variant in
  `App.ts` (hard-breaks over-width words like long file paths) is now the
  one in `MessageFormatter.ts`; the simpler `wordWrap` in `ansi.ts`
  (lets over-width words overflow) stays for non-chat use cases.

  Why: `App.ts` was the largest TypeScript file in the project. The
  formatting logic was untestable in isolation (it lived on a class that
  requires a screen, input loop, and 30+ state fields to instantiate).
  Extracted as pure functions, it now has 26 unit tests covering inline
  markdown, word-wrap, headings, lists, blockquotes, code blocks, and
  counter threading — the first tests ever for this code. App.ts shrank
  from 3189 → 2860 LoC (-10%).

- **ACP registry entry synced to 2.14.0.** `acp-registry/codeep/agent.json`
  had fallen behind to 2.4.2 — ten minor releases out of date — so ACP
  clients (Zed, Cursor, etc. via the registry) were advertising a stale
  binary. Bumped the `version` field and all four platform archive URLs
  (darwin-aarch64, darwin-x86_64, linux-x86_64, linux-aarch64) to the
  `v2.14.0` GitHub release.

- **Mac: ProviderChoice + Conversation computed-property test coverage; +199 tests total.**
  Added two pure test files (no `AppState` instance needed):
  - `ProviderChoiceTests.swift` (17 tests) — exhaustive coverage of the
    `ProviderChoice` enum's pure API: `displayName`, `isKeyless`,
    `from(providerID:)` round-trip for every case (including the
    `z.ai` / `minimax-api` / `qwen-cn-api` hyphenated-id cases that a
    naive `rawValue` match would miss), `keychainKeyID` uniqueness,
    `makeProvider().id` ↔ `keychainKeyID` consistency, and `CaseIterable`
    completeness.
  - `ConversationDisplayTests.swift` (13 tests) — coverage for the
    sidebar's two computed invariants: `title` (custom-wins, derived
    from first user message, 40-char trim, whitespace-only fallback to
    "New chat") and `updatedAt` (last message timestamp, createdAt
    fallback), plus `snapshot()` round-trip assertions (customSystem
    vs resolved system separation, identity preservation, message
    inclusion).
  Total Mac tests: 169 → 199 (+30 this round).

- **Web: key validation + provider metadata extraction; +228 tests total.**
  Extracted `validateKey` and the `PROVIDERS` list from
  `app/dashboard/KeysSection.tsx` (287→239 LoC) into a new
  `src/lib/keyValidation.ts` (63 LoC, 18 tests). The component also now
  uses the shared `maskKey` from `lib/format.ts` instead of a local
  `mask()` duplicate. Tests cover all five prefix rules (openai,
  anthropic, google, openrouter, deepseek), the empty/whitespace/length
  guards, and the PROVIDERS array integrity.

- **Web: review-analytics + project-page stats extraction; +210 tests total.**
  Extracted two more pure data-transform layers:
  - `src/lib/reviewStats.ts` (206 LoC, 25 tests) from
    `app/dashboard/reviews/page.tsx` (404→366 LoC):
    `readJson`, `buildHotspotsAndCategories`, `shapeTrendRows`,
    `shapeRepoRows`, `shapeRecentRows`, `shapeTotals`.
  - `src/lib/projectStats.ts` (50 LoC, 16 tests) from
    `app/dashboard/projects/[name]/page.tsx` (317→309 LoC):
    `buildProjectCostByModel`, `sumTokens`, `parseCost`.
    Also removed a duplicate `COLORS`/`colorFor` palette that was
    shadowing the one in `lib/format.ts`.

- **Web: dashboard stats pipeline extraction; +169 tests total.**
  Extracted the pure data-transform layer from `app/dashboard/page.tsx`
  (933→883 LoC) into a new `src/lib/stats.ts` (209 LoC, 26 tests):
  - `buildModelStats` — merge live model rows with the snapshot table,
    sort/cap/colour. 8 tests.
  - `buildProviderStats` — shape provider GROUP BY rows with pct + colour. 4 tests.
  - `buildCostByModel` — merge live cost-by-model with snapshot, handling
    the snapshot's missing cache columns. 5 tests.
  - `computeCacheStats` — the cache-savings ($3/1M × 0.9) and hit-ratio
    roll-up. 4 tests.
  - `buildDailyCost` — parse MySQL string costs to numbers. 5 tests.
  The page now imports these instead of inlining ~60 lines of merge logic.

- **CLI: commands.ts refactoring round 4 — insights, cloud, me, skills extraction; +2239 tests total.**
  Extracted 8 more helpers covering the remaining mid-sized cases:
  - `parseInsightsDays` — the `--days`/`--days=` flag parser from `/insights`. 10 tests.
  - `formatCloudSessionLabel` — the `/cloud` picker row formatter
    (title · date · N msg · [project]). 6 tests.
  - `formatMeSyncReport` — the `/me sync` push/pull result list. 5 tests.
  - `formatMeLearnResult` — the `/me learn` updated/no-changes renderer. 2 tests.
  - `formatMeInitResult` — the `/me init` created/exists renderer. 3 tests.
  - `formatSkillsShow` — the `/skills show` detail view. 1 test.
  - `formatSkillsBrowseEmpty` — the `/skills browse` empty-state message. 2 tests.
  - `formatSkillsPublishResult` — the `/skills publish` success message. 3 tests.
  `commands.ts` is now down to **2350 LoC** (−138 from the original 2488).

- **CLI: commands.ts refactoring round 3 — full /mcp subcommand extraction; +2207 tests total.**
  Decomposed the entire `/mcp` case (the last big monolith in `commands.ts`,
  originally ~200 lines) by extracting 9 helpers into
  `renderer/commands/helpers.ts` (now 514 LoC, 146 tests):
  - `parsePromptArgs` — the `key=value` token parser from `/mcp prompt`. 8 tests.
  - `pluralTools` / `groupToolsByServer` — shared pluraliser and tool-by-server
    grouper used across `/mcp`, `/mcp reload`, and install reports. 7 tests.
  - `formatMcpServerList` — the default `/mcp` server/tool listing (with
    empty-state and failed-servers sections). 5 tests.
  - `formatMcpReloadReport` — the `/mcp reload` summary. 4 tests.
  - `formatMcpResourcesList` — the `/mcp resources` listing. 3 tests.
  - `formatMcpResourceRead` — the `/mcp read` content renderer (text fences,
    json/markdown detection, blob notes). 6 tests.
  - `formatMcpPromptsList` — the `/mcp prompts` listing with arg annotations. 4 tests.
  - `formatMcpPromptResult` — the `/mcp prompt` materialised-output renderer. 4 tests.
  All eight `/mcp` subcommand branches now delegate to these helpers,
  shrinking each by 5–34 lines. `commands.ts` is down to **2388 LoC**
  (−100 from the original 2488).

- **CLI: commands.ts refactoring round 2 — stats, copy, apply extraction; +2166 tests total.**
  Continued decomposing `commands.ts` by extracting three more groups of
  pure helpers into `renderer/commands/helpers.ts` (now 346 LoC, 105 tests):
  - `formatStatsReport` + `formatModelCost` — the full `/stats` Markdown
    report (per-model breakdown, totals, prompt-cache summary, pricing
    table). Token formatter is injected so the module stays pure. 15 tests.
  - `formatProfileList` / `formatMemoryList` — list renderers for
    `/profile list` and `/memory list`. 8 tests.
  - `extractCodeBlocks` / `resolveBlockIndex` — the code-block extractor
    and 1-based index validator from `/copy`. 14 tests.
  - `extractFileChanges` / `formatApplyDiffLine` / `shortPathForDisplay` —
    the fence/comment-pattern file-change extractor and diff-line
    formatter from `/apply`. 21 tests.
  The `/stats`, `/copy`, and `/apply` cases now delegate to these helpers,
  shrinking each by 40 / 5 / 22 lines respectively.

- **CLI: commands.ts refactoring — extracted helpers module, 2 bugs fixed, +2082 tests total.**
  Decomposed `commands.ts` (2488 → **2448 LoC**, −40) by extracting pure
  helpers from the giant switch/case into a new
  `renderer/commands/helpers.ts` module (140 LoC, 49 tests):
  - `buildSearchSnippets` — the asymmetric 30/50-char window snippet
    extractor from `/search` (kept separate from `utils/search.ts`’s
    50/50 because the inline panel is narrower). 10 tests.
  - `parseKeepRecent` — the `/compact <n>` arg parser.
    **Fixed a real bug**: the old `parseInt(arg) || fallback` treated `0`
    as falsy and returned the default (4) instead of clamping to 2.
    Switched to `Number.isNaN` check. 7 tests.
  - `joinSessionName` — the hyphen-joiner from `/rename`. 6 tests.
  - `parseTaskAddArgs` — the `--bug` / `--feature` / `--desc` flag parser
    from `/tasks add`. 13 tests.
  - `formatTaskList` — the Markdown list renderer from `/tasks`. 13 tests.
  The `commands.ts` cases now delegate to these helpers; the parser and
  renderer have direct coverage for edge cases (empty args, flag
  ordering, type overrides, null descriptions).

- **CLI: App.ts refactoring round 3 — progress bar, paste detection, notification truncation extracted; 1 bug fixed.**
  Continued decomposing `App.ts` (2622 → **2613 LoC**, −9 more) by pulling
  three more pure concerns into `renderer/layout.ts`:
  - `agentProgressBar` — the gradient ░▒▓█ bar from
    `renderInlineAgentProgress`. **Fixed a real bug**: when `maxIterations`
    was 0, the old code divided by zero (yielding Infinity) and rendered a
    *full* bar instead of an empty one. Added a `maxIterations > 0` guard.
    6 new tests, including the zero-budget edge case.
  - `truncateNotification` — the ellipsis truncation from
    `renderStatusBar`. 7 new tests.
  - `shouldShowPasteDialog` / `buildPasteInfo` — the paste-size threshold
    check and preview struct builder extracted from `handlePaste`.
    14 new tests covering the exact 100-char boundary, the `>3` lines rule,
    and the 200-char preview truncation.
  The layout module is now **123 tests** strong and has uncovered one bug.

- **CLI: App.ts refactoring round 2 — input display + scroll window extracted, +2006 tests total.**
  Continued decomposing `App.ts` (2662 → **2632 LoC**, −30 more) by pulling
  two more pure concerns into `renderer/layout.ts`:
  - `computeInputDisplay` / `inputPromptSymbol` / `inputViewport` — the
    input-row geometry: prompt-symbol scaling for multi-line content,
    horizontal viewport scrolling for long lines (cursor anchored at 70%
    of the available width), placeholder selection. 21 new tests.
  - `scrollWindow` — the visible-window math from `getVisibleMessages`
    (maxScroll clamping, startIndex/endIndex derivation). 7 new tests.
  `renderInput` and `getVisibleMessages` now delegate to these helpers;
  the layout module is up to **96 tests** covering every extracted helper.

- **CLI: App.ts refactoring — extracted pure layout/input modules, +1978 tests total.**
  Decomposed `App.ts` (2727 → **2662 LoC**, −65) by pulling three previously
  inlined, untestable concerns into pure, unit-tested modules:

  - **New module `renderer/layout.ts`** (190 LoC, 68 tests) — the layout math
    that was buried inside `renderChat`, `scrollToMessage`, `renderStatusBar`,
    and `handleChatKey`:
    - `bottomPanelHeight(snapshot)` — the 15-branch if/else that reserves
      space for whichever inline panel is open (paste / agent / permission /
      session picker / confirm / status / help / search / export / logout /
      login / menu / settings / autocomplete), with caps and priority.
    - `chatLayout(height, panel)` — derives the y-coordinates for the
      messages / separator / input / status rows.
    - `messageLineCount`, `messageOffsets`, `scrollOffsetForTarget` — the
      word-wrap line-counting and scroll-centring logic that used to live in
      `scrollToMessage`.
    - `formatTokenCount` — the "1.2K tok" compaction.
    - `statusBarRightHint` — context-sensitive right-edge hint (idle /
      streaming / "new messages below" badge).
    - `activePanel(state)` — the focus-precedence decision the keystroke
      handler walked as a 13-step if/else chain on every keypress.
  - **New module `renderer/inputParsing.ts`** (14 tests) —
    `parseCommandInput` extracts the `/command arg arg` parser from
    `handleCommand`, with whitespace collapsing and case normalisation.

  `App.ts` now delegates to these modules via small snapshot objects; the
  big methods shrank by 65 lines and their core logic is now covered by
  82 dedicated tests instead of being unreachable from the test suite.

- **CLI: deeper coverage round 5 — 5 more test files, +50 tests.**
  Closed the remaining small-module gaps:

  - **`utils/search.test.ts`** (15 tests) — `searchMessages`:
    case-insensitive match (both directions), messageIndex tracking,
    one-result-per-message, 50-char context window, leading/trailing
    ellipsis boundary, original-case preservation, multi-word terms,
    regex-char-as-literal safety.
  - **`utils/commandIndex.test.ts`** (8 tests) — `COMMAND_INDEX`
    structural invariants (non-empty, no dupes, slash-prefixed) and
    `formatCommandIndex` Markdown rendering (bullet list, backtick
    wrapping, em-dash separator, one-bullet-per-command).
  - **`utils/taskContext.test.ts`** (11 tests) — `getTaskContextPrompt`
    empty-state, task title/description/project/badge rendering,
    missing-field fallbacks, multi-task bullet list, header + footer.
  - **`utils/ollamaCatalog.test.ts`** (10 tests) — `OLLAMA_CODING_MODELS`
    catalog invariants (fields populated, pull-tag format, no dupes,
    size variety) and `catalogAgentHint` (7B threshold, consistency
    with the catalog).
  - **`renderer/components/uiConstants.test.ts`** (6 tests) —
    `PRIMARY_COLOR` ANSI escape, `SPINNER_FRAMES` (8 distinct single
    chars), `LOGO_LINES` / `LOGO_HEIGHT` consistency.

- **CLI: deeper coverage round 4 — 6 more test files, +83 tests, 1 duplikat helpera istaknut.**
  - **`renderer/main.test.ts`** (10 tests) — `deriveSessionName` (whitespace
    collapse, 5-word cap, 48-char truncation with ellipsis).
  - **`utils/export.test.ts`** (25 tests) — Markdown / JSON / plain-text
    exporters: header structure, role labels, message preservation,
    session name defaulting, message-count field, ISO timestamp,
    format dispatch + unknown-format error, empty-list safety.
  - **`renderer/components/Box.test.ts`** (20 tests) — `boxChars`
    completeness, `createBox` (line count, y-placement, corner chars per
    style, middle-row pattern, x-padding, title embed/alignment/
    truncation/narrow-box suppression), `centerBox` (centring, floor,
    negative when overflow).
  - **`renderer/components/Search.test.ts`** (7 tests) — `handleSearchKey`
    (escape/close, up/down clamping, enter-selects-messageIndex,
    empty-results guard, ignore-unknown, position vs index).
  - **`renderer/components/Intro.test.ts`** (12 tests) — `GLITCH_CHARS`,
    `generateNoiseLine` (length, space preservation, glitch membership),
    `getDecryptedLine` (length, space preservation, full reveal at
    progress > 0.95, probabilistic reveal at 0, empty + long input).
  - **`renderer/components/Logout.test.ts`** (9 tests) — `handleLogoutKey`
    (escape close, up/down navigation capped at providers + all + cancel,
    enter on provider / "all" / "cancel" slot, no-callback safety,
    unknown-key ignore, empty-providers cap).
  - Also surfaced a **duplicate `truncatePath` helper** (identical
    implementation in `Permission.ts` and `Status.ts`) — exported both for
    testability; a future refactor should consolidate into a shared util.

- **CLI: deeper coverage round 3 — 4 more test files, +79 tests.**
  Continued closing the test gap:

  - **`utils/terminal.test.ts`** (31 tests) — terminal control helpers:
    `supportsSynchronizedOutput` (env-driven detection of ghostty /
    iterm / kitty / wezterm / vscode / alacritty + xterm/256color
    fallback), `hideCursor`/`showCursor` escape sequences, `clearLinesAbove`
    multi-line clear-and-restore, `moveCursor` (up/down), `getTerminalSize`
    fallback, and `createSyncWriter` (sync-frame wrapping, idempotent
    startSync, unsupported-terminal pass-through).
  - **`utils/skillBundles.test.ts`** (32 tests) — the skill-bundle engine:
    `parseFrontmatter` (BOM/CRLF normalisation, inline + block lists,
    quote stripping, kebab-case keys, body preservation, no-frontmatter
    fallback), `stripQuotes`, `asStringArray`, `formatBundlesForSysprompt`
    (per-line 200-char cap, 3-trigger hint, total 4000-char budget with
    "omitted" note), `formatBundleList` (project/global grouping, version
    badge, empty hint).
  - **`utils/skillBundlesCloud.test.ts`** (14 tests) — `serialiseSkillMd`
    (YAML frontmatter round-trip for all optional fields and list
    sections), `readRawSkillMd` (missing-file null), `uninstallLocalBundle`
    (delete + idempotent second call).
  - **`renderer/components/Permission.test.ts`** (9 tests) —
    `getPermissionOptions`, `truncatePath` (basename fallback, .../ prefix,
    boundary behaviour).
  - **`renderer/components/SelectScreen.test.ts`** (12 tests) —
    `handleSelectKey` dispatch for all navigation keys, mutation-free
    state, and the defensive empty-list case.

- **CLI: deeper coverage round 2 — 4 more test files, +117 tests, 1 crash bug fixed.**
  Continued closing the test gap on large untested modules:

  - **`utils/codeepCloud.test.ts`** (23 tests) — `generateProjectId`
    (deterministic sha256-16, trailing-slash + case normalisation),
    `_readFileBundleForTest` / `_writeFileBundleForTest` (the
    personality/command bundle sync): case-folding of filenames,
    name-regex validation, 64-char name cap, 64 KB size cap (boundary
    included), additive-merge (no clobber of local edits), directory
    auto-creation, empty/invalid-body skip.
  - **`renderer/Input.test.ts`** (35 tests) — `LineEditor`, the
    readline-style input editor: cursor movement, word-boundary
    navigation (`wordLeft`/`wordRight` over spaces, path separators and
    dots), `deleteWordBackward` (path-aware), `deleteToEnd`, history
    navigation (up/down walk, draft restoration, empty-entry skip,
    100-entry cap), and `handleKey` dispatch (backspace/delete/left/
    right/home/end/ctrl-left/ctrl-right/alt+b/alt+f, regular char
    insert, ctrl-suppression).
  - **`renderer/Screen.test.ts`** (16 tests) — the terminal screen
    buffer: out-of-bounds rejection, newline-truncation in `write`,
    `writeLine` overwrite, `writeWrapped` line counting, `horizontalLine`,
    cursor API, and render/fullRender safety.
  - **`renderer/agentExecution.test.ts`** (43 tests) — `getActionType`
    (tool-name → action classification) and `isDangerousTool` (name +
    command heuristics). **Found and fixed a real crash bug**: when the
    LLM returned `parameters.command` as a number (`123`) instead of a
    string, `isDangerousTool` threw `TypeError: command.toLowerCase is
    not a function` — taking the whole agent loop down with it. The fix
    guards with `typeof rawCommand === 'string'`.

- **CLI: deep test coverage — 6 new test files, +126 tests.**
  Added tests for six previously-untested modules across the CLI:

  - **`config/index.test.ts`** (26 tests) — project detection (`isProjectDirectory`,
    `hasStandardProjectMarkers`, `initializeAsProject`, `isManuallyInitializedProject`):
    all 9 standard markers, the `.codeep/project.json` manual marker,
    idempotent re-initialisation, non-writable-path failure, and the
    `isProjectDirectory` precedence (manual marker wins over standard markers).
  - **`utils/taskPlanner.test.ts`** (19 tests) — the dependency-aware task
    scheduler (`canStartTask`, `getNextTask`, `formatTaskPlan`): blocked /
    unblocked dependency chains, failed-dependency handling, multi-level
    chains, in-progress skip, and the status-icon / dependency rendering.
  - **`utils/logger.test.ts`** (9 tests) — `formatLogEntry`: level uppercasing,
    JSON-serialised data suffix, falsy-data suppression (0/false/''),
    multi-line messages, trailing newline.
  - **`utils/interactive.test.ts`** (28 tests) — the prompt-clarification
    flow (`analyzeForClarification`, `formatQuestions`, `parseAnswers`,
    `enhancePromptWithAnswers`): all ambiguity triggers (auth, database,
    api, deploy, test, styling, state-management, refactor, form),
    letter-answer parsing (`1a`/`1b`), option-name matching, and the
    "proceed" escape hatch. **Documents a real false-positive bug** in
    `checkForDetails` (substring match: "authentication" contains "auth"
    from the "Basic auth" option label).
  - **`utils/mcpMarketplace.test.ts`** (14 tests) — `findMarketplaceEntry`,
    `formatMarketplaceList`, `formatMarketplaceEntry`: case-insensitive
    lookup, the Markdown table rendering, one-row-per-entry invariant,
    arg-hint / env-note / docs-link sections.
  - **`renderer/handlers.test.ts`** (30 tests) — the inline modal key
    handlers (`handleInlineStatusKey`, `handleInlineHelpKey`,
    `handleInlinePermissionKey`, `handleInlineSessionPickerKey`,
    `handleInlineConfirmKey`): close-on-escape, cursor clamping, scroll
    step sizes, the yes/no/extra cycle, delete-mode toggling, and
    empty-list cleanup.

- **CLI: `App.ts` + `commands.ts` decomposition — +61 tests, 2 more helpers extracted.**
  Continued the `App.ts` / `commands.ts` cleanup:

  - **`components/Autocomplete.ts`** — `filterCommands(value, commands)`,
    the `/`-command prefix matcher. Rules: only triggers on input
    starting with `/` and containing no space, case-insensitive prefix
    match, 8-item cap. 10 tests cover the accept/reject paths, the cap,
    and the empty-query special case.
  - **`ollamaHint.ts`** — `ollamaModelHint(modelId)`, the parameter-
    count hint (`✓ agent mode` / `⚠ chat only (< 7B)`) shown beside
    Ollama models. 20 tests cover the size-threshold boundary (7B),
    namespaced ids (`qwen3:14b`), hyphenated ids (`mistral-7b-instruct`),
    and the no-size-detected fallback.
  - **`utils/toolParsing.test.ts`** (31 tests) — the LLM tool-call
    parser had **no test coverage** despite being critical path (it's
    how the agent extracts `read_file` / `write_file` / `execute_command`
    calls from model output). Added test seams (`_forTest` exports) for
    the three file-private helpers (`extractPartialToolParams`,
    `tryExtractParams`, `tryParseToolCall`) and covered: name
    normalisation (camelCase → snake_case), OpenAI / Anthropic / text
    response formats, the truncation-recovery path (partial JSON →
    recovered params), required-field validation (write_file missing
    path, edit_file missing old_text/new_text), and the trailing-comma
    tolerance in `tryParseToolCall`.

- **VS Code: `extension.ts` decomposed — 654 → 627 LoC, +50 tests (81 → 131).**
  `extension.ts` (the activation entry point) had no test coverage and
  kept its status-bar presentation rules and input-box validators inline.
  Two pure-function modules extracted:

  - **`statusBarRenderer.ts`** — `renderStatusBar(state)` returns the
    text / tooltip / command / background-colour per connection state
    (connecting / connected / reconnecting / disconnected / failed).
    The `activate()` body now has a 6-line `applyStatusBar` wrapper that
    applies those fields to the live `StatusBarItem`. 17 tests cover each
    state's icon, label, click command, tooltip content (model name in
    connected, attempt counter in reconnecting), and background tint
    (warning vs. error).
  - **`validators.ts`** — `validateMcpServerName`, `validateSkillBundleName`,
    `validateApiKey`, `validateModelId`, `validateRequired`. Five regex /
    length rules that were inline as `InputBox.validateInput` lambdas,
    now reusable and unit-tested. 33 tests cover accept paths, reject
    paths, boundary lengths, leading-character rules, whitespace
    trimming, and the embedded-whitespace API-key check.

- **Web: dashboard formatting helpers de-duplicated across 8 files + 24 tests.**
  Six pure helpers (`COLORS`, `colorFor`, `maskKey`, `timeAgo`, `fmt`,
  `fmtCost`, `fmtTokens`) were copy-pasted — sometimes with subtly
  different bodies — across eight dashboard pages and components:

  | File | Had |
  |------|-----|
  | `app/dashboard/page.tsx` | all six |
  | `app/dashboard/KeysSection.tsx` | `timeAgo` |
  | `app/dashboard/ProjectRow.tsx` | `timeAgo` |
  | `app/dashboard/CliConnectionSection.tsx` | `timeAgo` |
  | `app/dashboard/projects/[name]/page.tsx` | `timeAgo`, `fmtCost`, `fmtTokens` |
  | `app/dashboard/sessions/page.tsx` | `timeAgo` |
  | `app/dashboard/sessions/[id]/page.tsx` | `fmtTokens` |
  | `app/dashboard/reviews/page.tsx` | `timeAgo`, `fmt` |
  | `app/dashboard/reviews/CiTokensSection.tsx` | `timeAgo` |

  Consolidated into `src/lib/format.ts` (78 LoC, single source of truth),
  with `fmtCost`'s `Number(n) || 0` NaN-guard propagated everywhere (the
  project-page copy lacked it). All eight call sites now import from
  `@/lib/format`.

  New `src/lib/format.test.ts` (24 tests) pins the rules — palette
  wrapping, key masking, `timeAgo` tier boundaries (mocked clock),
  compact number/cost/token formats including the adaptive cost
  precision that sub-cent cached-token bills depend on.

- **CLI: `App.ts` decomposed — 2860 → 2732 LoC, +22 tests, 3 constants de-duplicated.**
  `App.ts` (the terminal renderer's main file) had drifted back to
  2860 LoC after the earlier `MessageFormatter` extraction. Three more
  pure-function / constant clusters extracted into `components/`:

  - **`uiConstants.ts`** — `PRIMARY_COLOR`, `SPINNER_FRAMES`,
    `LOGO_LINES`, `LOGO_HEIGHT`. **De-duplication win:** `PRIMARY_COLOR`
    was redeclared in `Status.ts` and `Intro.ts`, and `LOGO_LINES` was
    copy-pasted into `Intro.ts` (as `LOGO`). Both now import from the
    single source, so the palette / logo can't drift between files.
  - **`ActionFormatting.ts`** — `getActionColor`, `formatActionTarget`,
    `getActionLabel` (the agent-progress-panel colour/label/path
    helpers). Pure functions, now unit-tested (11 tests).
  - **`WelcomeFormatter.ts`** — `formatWelcomeMessage` (the welcome-
    banner DSL renderer: version header, Project/Access/Mode labels,
    ⚠ warnings, /help hints). Pure function, now unit-tested (11 tests).

  Writing the `ActionFormatting` tests surfaced a real truncation bug
  in `formatActionTarget`: when a 3+ segment path was already shortened
  to `.../parent/file` and still exceeded `maxLen`, the function
  prepended *another* `...` and sliced from the end — producing
  `.../b/c` → `../b/c` (dropping a dot) instead of a clean left-trim.
  Now slices the short form directly so the file extension always
  survives.

- **Mac App: unit-test coverage expanded (+64 tests, 114 → 178) + 3 parser bugs fixed.**
  Four new test files cover the pure parsers and helpers behind the
  `MessageContent/` views (the ones reinstated when the split was fixed
  in Cycle #29):

  - **`MarkdownTableParserTests.swift`** (13 tests) — GFM table splitter:
    header + delimiter detection, alignment colons, pipe-less tables,
    row padding, prose-before/after, single-dash delimiters.
  - **`MarkdownBlocksTests.swift`** (19 tests) — block-level markdown:
    paragraphs, ATX headings (levels 1–6 + 7-hash fallback), bullet /
    numbered / task lists (with `[ ]`/`[x]`/`[X]` markers), blockquotes,
    horizontal rules, mixed content.
  - **`ParseEditDiffTests.swift`** (8 tests) — `parseEditDiff`: the
    edit-file tool-output parser. Nil for non-edit output, prefix-only
    guard, mixed added/removed/context ordering, leading-blank skip.
  - **`CodeHighlightingTests.swift`** (13 tests) — the SwiftUI bridge
    from `SyntaxHighlighter` tokens to `Color`s. Pins the colour per
    kind and verifies `attributed(_:)` round-trips source verbatim.
  - **`SegmentsTests.swift`** (11 tests) — `segments(from:)`: the
    fenced-code-block splitter driving `MessageContentView`. Covers
    language tags, unclosed fences (streaming), inline-backtick
    non-detection, tables-inside-prose promotion.

  Writing the tests surfaced three real bugs in the parsers we'd
  reinstated from memory in Cycle #29, now fixed:

  1. **`MarkdownBlocks.parseTaskItem`** read the checkbox marker at the
     wrong string index (off-by-one) — `- [ ]` and `- [x]` were never
     recognized and fell through to `parseBullet`, so task items
     rendered as plain bullets with the `[ ]`/`[x]` visible in the
     text. Index arithmetic corrected.
  2. **`MarkdownTableParser.isDelimiter`** required 3+ dashes per
     delimiter cell. GFM/CommonMark only require one dash, so valid
     tables with short delimiters (`|-|-|`, `|:--|:-:|`) were rejected
     and rendered as prose. Regex relaxed to `:?-+:?`.
  3. **`MarkdownTableParser.flushBuffer`** didn't trim trailing blank
     lines, so an empty string or a table followed by a blank produced
     a spurious empty `.prose` chunk. Now trims trailing blanks before
     emitting.

- **Mac App: `ChatView.swift` decomposed — 2554 → 1075 LoC (−58%).**
  The 2.5k-line `ChatView.swift` was the second-largest Swift file in the
  project (after `AppState.swift`). It bundled the main chat surface,
  the private `ChatDetailView` helper, and **eight** independent sheet /
  popover / banner sub-views behind a single file. The sub-views had no
  shared state with the detail view beyond what they already received as
  parameters or read from `@Environment(AppState.self)`, so they were
  pure extraction candidates.

  Split into eight focused files under `Views/`, each carrying a header
  comment documenting its origin:

  | File | LoC | Contents |
  |------|-----|----------|
  | `ConfirmationSheet.swift` | 259 | tool-approval modal (Run/Skip/Cancel) |
  | `TasksSheet.swift` | 285 | codeep.dev tasks panel + `TaskRow` |
  | `UsageStatsView.swift` | 193 | token/cost popover + `ModelCostRow` |
  | `ProjectContextSheet.swift` | 243 | `.codeep/` context viewer + `ProjectNotesSheet` |
  | `InsightsView.swift` | 224 | codeep.dev insights panel |
  | `CheckpointsSheet.swift` | 126 | checkpoint history + rewind UI |
  | `UserPromptsEditor.swift` | 138 | "My Prompts" CRUD editor |
  | `ErrorBanner.swift` | 83 | error banner |

  What's left in `ChatView.swift` (1075 LoC): the top-level `ChatView`
  (NavigationSplitView shell + sheet wiring) and `ChatDetailView` (the
  actual message list + composer + toolbar). These two are tightly
  coupled and share a lot of state — further splitting would just
  shuffle parameters around.

  `private struct` → `struct` (module-internal) on every moved type so
  it stays visible to `ChatView.swift` across files; `private extension`
  companions moved with their owner.

- **VS Code Extension: unit-test coverage expanded (+32 tests, 49 → 81).**
  The VS Code extension had 4 test files covering 49 tests, all on the
  vscode-free modules (`acpClient`, `mcpConfigFile`, `diffPreview`,
  `webview/markdown`). `chatPanel.ts` (1008 LoC) — the largest source
  file — had zero tests; same for `codeActions.ts`.

  Three new test files + one expanded one close that gap by testing the
  pure functions those modules already contained, exposed for tests via
  `_…ForTest` named exports (same pattern as `diffPreview.test.ts`):

  - **`chatPanel.test.ts`** (6 tests) — `friendlyError`, the user-facing
    message formatter for CLI failure modes (timeouts, crashes, missing
    binary). Covers each known failure string + passthrough for unknown.
  - **`codeActions.test.ts`** (12 tests) — `fence` (code-fence builder)
    and `buildPrompt` (lightbulb prompt templates for explain / improve /
    tests / docs / fix). Verifies each action kind produces the right
    instruction and embeds the fenced block; fix-without-diagnostics
    omits the problems section.
  - **`webview/markdown.test.ts`** (+14 tests) — `escapeHtml` and
    `inline`, the two security-sensitive internal helpers behind
    `renderMarkdown`. Adds direct coverage for HTML-entity escaping
    (including the `"` href-breakout regression) and the URL-scheme
    allowlist (`http(s)`, `mailto:`, `vscode:` pass; `javascript:`,
    `data:` are stripped to label-only) independently of the
    full-pipeline tests.

  Mocking: `chatPanel.test.ts` and `codeActions.test.ts` use
  `vi.mock('vscode', …)` with a minimal stub (same approach the existing
  `diffPreview.test.ts` pioneered) so the modules load under Node
  without the Electron extension host.

- **Mac App: `AppState+MCP.swift` extracted + MessageContent build fix.**
  The MCP (Model Context Protocol) server lifecycle — `reloadMCPServers`,
  `trustPendingMCP`, `dismissPendingMCP`, `revokeMCPTrust`,
  `handleMCPToolsChanged`, `addCatalogServer`, `makeMCPSampler`,
  `reattachToolsToAllConversations` — moved out of the 2.8k-line
  `AppState.swift` into a dedicated `AppState+MCP.swift` extension (170 LoC),
  following the same pattern as the existing `+Cloud` / `+Git` / `+Permissions`
  / `+RecentProjects` splits.

  The MCP-related stored properties (`mcpManager`, `mcpTools`,
  `mcpResults`, `isReloadingMCP`, `didWireMCPToolsHandler`,
  `trustedMCPProjectPaths`, `persistTrustedMCPProjects`) were widened
  from `private` / `private(set)` to `internal` / `internal(set)` so the
  cross-file extension can reach them — Swift's `private` is file-scoped.
  Each carries a comment explaining why.

  Also fixed a build regression left over from the Ciklus #29
  `MessageBubble` decomposition: `MarkdownTableParser` and `MarkdownBlocks`
  were referenced by the extracted sub-views (`MessageContentView`,
  `ProseView`, `MarkdownTableView`) but never defined — the parsers had
  been dropped during the split. Added them as standalone files
  (`MarkdownTableParser.swift` 115 LoC, `MarkdownBlocks.swift` 190 LoC)
  and refactored the two `ForEach { switch … }` blocks in
  `MessageContentView` and `ProseView` into dedicated `@ViewBuilder`
  helper functions to satisfy Swift's result-builder type inference
  (the inline switch was producing the misleading
  `AccessibilityRotorContent` conformance error).

  Why: `AppState.swift` was the largest Swift file in the project.
  Pulling MCP out cuts it to 2684 LoC (-4.5%) and groups every
  MCP-related entry-point under one navigable file. The parser fix
  was blocking the build outright — Xcode was failing on
  `MessageContentView` before any of the new MCP extension could compile.

- **Mac App: `MessageBubble.swift` decomposed into focused sub-components.**
  The 924-line view was a God Object holding the bubble shell, the markdown
  segment dispatcher + parser, code-block rendering + syntax highlighting,
  prose/list/heading/quote rendering, GFM table rendering, and the three
  tool-execution card views (`ToolCallCard`, `ToolResultCard`, `DiffBody`)
  plus their diff parser. Split into:

  - `Views/MessageBubble.swift` (315 LoC) — the bubble shell: role icon,
    content switch, hover-revealed action row, inline edit mode.
  - `Views/MessageContent/MessageContentView.swift` — prose/code/table
    dispatcher + the fenced-code parser.
  - `Views/MessageContent/CodeBlockView.swift` — code panel + the shared
    `CodeHighlighting` palette.
  - `Views/MessageContent/ProseView.swift` — block + inline markdown.
  - `Views/MessageContent/MarkdownTableView.swift` — GFM table grid.
  - `Views/MessageContent/ToolCards.swift` — `ToolCallCard`,
    `ToolResultCard`, `EditDiff`/`DiffLine`/`DiffBody`, `parseEditDiff`.

  Pure relocation — no behaviour change. The `private` types became
  `internal` so the bubble (and the existing `QuickAgentView` /
  `ChatView` callers) can still reach them. Xcode 16 file-system-
  synchronized groups pick up the new folder automatically, so no
  `.pbxproj` edit was needed. The iOS target keeps its own copy for
  now (it has UIKit-specific rendering); the same split can be applied
  there as a follow-up.

  Why: the monolith was the largest Swift file in the project and the
  one most likely to grow further (tool-card variants, snapshot tests).
  Smaller files mean smaller review diffs, Xcode Previews that target
  one piece at a time, and a natural seam for the snapshot-test suite
  that's still missing.

- **README: replaced the stale "Upgrading from 1.x to 2.0" section.**
  The top-of-README upgrade note still described the 2.0.0 breaking
  changes as if they were the latest migration, 14 minor releases later.
  Replaced with a short "Upgrading" paragraph that points at CHANGELOG
  for per-release breaking changes and mentions 2.0.0 only as the last
  breaking bump. The old details (MCP `clientInfo` version, optional
  `McpServer` shape) remain in the 2.0.0 changelog entry.

- **Native keychain backend swapped from `keytar` to `@napi-rs/keyring`.**
  `src/utils/keychain.ts` now loads `@napi-rs/keyring` (a Rust binary
  with prebuilt per-platform artifacts shipped as optionalDependencies)
  instead of the deprecated `keytar` addon. The public `SecureStorage`
  surface is unchanged — only the internal adapter was rewritten to
  bridge the new sync `Entry` API to the async methods the rest of the
  code expects.

  Why: `keytar` pulls `prebuild-install`, which frequently fails to
  fetch or compile on new macOS releases and ARM Linux, breaking
  `npm install` outright for affected users. `@napi-rs/keyring` has no
  build step and installs a precompiled binary for the target platform
  automatically, so installs are reliable across macOS / Linux / Windows
  / FreeBSD on both x64 and arm64.

- **Docs:** `/docs/rules` and `/docs/mcp` rewritten to list the new
  sources and the full precedence chains. README updated in lockstep.
  The old docs claimed both Codeep-native rules files were loaded and
  concatenated — that was never true (first non-empty file wins), so
  the rewrite also fixes that inaccuracy.

## [2.14.0] — 2026-07-01

> Claude Sonnet 5 replaces Sonnet 4.6 in the Anthropic picker (1M context, the full low→max reasoning-effort range), plus correctness fixes from a full-project audit: the ACP edit-approval diff, per-session naming, Grok effort gating, OpenAI-protocol cache accounting, and a `/copy` edge case.

### Added

- **Claude Sonnet 5** (`claude-sonnet-5`) replaces Claude Sonnet 4.6 in the
  Anthropic model list (and the OpenRouter seed). Same $3/$15 pricing and 1M
  context window; graded `/thinking` effort (`low`–`max`). Sonnet 5 rejects
  *non-default* sampling params, so a custom `/temperature` is now omitted for
  it (it would otherwise 400) — matching the Fable 5 / Opus 4.7+ handling.
- **Claude Fable 5** (`claude-fable-5`) is back in the Anthropic model picker
  (and the OpenRouter seed) now that it's available again — Anthropic's most
  capable model, for the hardest reasoning and long-horizon agentic work. 1M
  context, full `low`–`max` `/thinking` effort, $10/$50 pricing in `/cost`. The
  sampling-param and effort handling were already wired up, so this just re-lists
  it in the picker.

### Fixed

- **ACP edit approvals showed no diff.** The permission dialog shown to Zed /
  VS Code branched on `old_string`/`new_string`, but the `edit_file` tool emits
  `old_text`/`new_text` — so in Manual mode you approved an edit seeing only the
  file path, not the change. Now reads the real parameter names.
- **`/new` reported the new session under the previous session's name.** The
  derived display name wasn't cleared on `/new`, so `syncSession`/`reportStats`
  attributed the fresh, unrelated session to the old name on the dashboard.
- **`reasoning_effort` sent to non-reasoning Grok coders.** `grok-build` (the
  default) and `grok-code-fast` are coders, not reasoning models — the param
  400s, and a 400 there silently dropped the turn into the weaker text-tool
  fallback. They're now excluded from the effort gate.
- **OpenAI-protocol cache tokens over-billed in `/cost`.** `extractOpenAIUsage`
  ignored `prompt_tokens_details.cached_tokens`, so DeepSeek/OpenAI cache hits
  were estimated at the full input rate instead of the ~0.1× cache-read rate.
- **`/copy <non-number>`** (e.g. `/copy abc`) reported a bogus success and
  cleared the clipboard instead of showing "Invalid block number"; now guarded.
- **Streamed agent turns recorded zero tokens on most non-OpenAI providers.**
  `stream_options.include_usage` was only requested for the literal `openai`
  provider, so DeepSeek/Kimi/Grok/Qwen/GLM/… streamed with no usage block and
  the whole turn logged 0 tokens / $0.00 in `/cost` and the dashboard. Now
  requested for every OpenAI-compatible provider (as the plain-chat path
  already does).
- **An agent run (or ACP prompt) wiped the session's running `/cost` total.**
  Token tracking was destructively reset at the start of each run to compute
  the cloud-telemetry delta, so the status bar and `/cost` lost all prior
  session usage (and in the ACP server, `/cost` after a 2nd prompt showed only
  the last one — or nothing). Now uses a non-destructive marker: cloud stats
  still get only the run's delta while the session-cumulative total survives.
- **Concurrent ACP sessions mixed each other's token usage.** The tracker kept
  one process-wide record buffer, so two sessions on one process (e.g. VS Code
  "New chat" while another turn streams) clobbered and cross-reported totals.
  Each ACP session now accumulates into its own buffer (via AsyncLocalStorage),
  isolating usage while keeping the single-session TUI path unchanged.

## [2.13.2] — 2026-06-30

> Cloud stats: the CLI now reports Anthropic prompt-caching breakdown (cache-creation and cache-read token counts) alongside the existing input/output/cost totals, so the dashboard can show "saved $X with caching" for CLI and VS Code (ACP) sessions.

### Changed

- **Cache token reporting in cloud stats.** `StatsPayload`
  (`src/utils/codeepCloud.ts`) now carries optional
  `cacheCreationTokens` / `cacheReadTokens`. The three `reportStats`
  call sites — `src/renderer/main.ts` (sync and async paths) and
  `src/renderer/agentExecution.ts` — pass through the per-model
  buckets from `getCostBreakdown()`, and `getSessionStats()` exposes
  session-totals via new `totalCacheCreationTokens` /
  `totalCacheReadTokens` fields. The ACP server (`src/acp/server.ts`)
  — the path VS Code uses — was updated in lockstep so both clients
  report the same shape.

  Why: `estimatedCost` already folded cache multipliers into the
  dollar total, but the *raw cache counts* were dropped on the floor,
  so the dashboard couldn't break out "this session read 500k tokens
  from cache." Now it can.

- **`ProviderCostBreakdown` and `SessionTokenStats` extended.** Both
  interfaces gained `cacheCreationTokens` / `cacheReadTokens`
  (required on the breakdown, since every provider reports something
  — 0 for non-caching). `getCostBreakdown()` accumulates them per
  provider/model group; `getSessionStats()` sums across all records.
  Two new tests cover the accumulation paths.

## [2.13.1] — 2026-06-24

> Repo hygiene: dropped dead React-hooks dir, locked the package manager to npm, made `npm run build` rebuild `dist/` from scratch, added a command registry as the single source of truth for autocomplete + `/help` + dispatch validation, lifted ACP test coverage from 0% to ~45% on the testable surface, removed all `as any` casts from the settings screen, upgraded `conf` to v13, fixed the tsconfig so `tsc --noEmit` is now genuinely clean (was silently emitting 445+ errors), patched the high-severity `vite` advisory, switched CI from bun to npm, added `CONTRIBUTING.md` + `SECURITY.md`, extracted the synchronous ACP handlers + pure helpers out of the `startAcpServer()` closure into a testable `serverHandlers.ts` module (89.7% line coverage on the extracted surface; 0 → 25.7% on `server.ts`), migrated `release-binaries.yml` from bun to npm (keeping bun only for the `bun build --compile` binary step), removed the deprecated + vulnerable `pkg` devDependency (0 high/critical advisories remaining), and hardened the build with `noEmitOnError: true`.

### Removed

- **`src/hooks/` deleted.** This directory (`index.ts` + `useAgent.ts`) was a
  leftover from the old Ink-based TUI: it imported `react` (which is **not** in
  `package.json`) and was kept out of `tsc` via an `exclude` in `tsconfig.json`,
  so the project type-checked only because the dead code was hidden. Nobody
  imported it (`grep "from.*hooks/" src/` returned zero hits), and it referenced
  a `runAgent` signature that no longer exists. The `src/hooks/**/*` exclude
  entry is removed from `tsconfig.json` — `tsc --noEmit` is now clean with
  nothing hidden.

### Changed

- **Single package manager: npm.** `bun.lock` is removed and `package-lock.json`
  is now the canonical lockfile (previously both were git-ignored and drifted).
  `.gitignore` no longer ignores `package-lock.json`; other lockfiles
  (`yarn.lock`, `pnpm-lock.yaml`, `bun.lock*`) stay ignored.
- **`/` autocomplete trimmed.** Five rarely-tab-completed utility/legacy
  commands were dropped from the `/` dropdown — `/clear`, `/exit`,
  `/context-save`, `/context-load`, `/context-clear` — to cut clutter. They
  remain fully dispatchable and listed in `/help`. (`/sessions` was kept in
  the dropdown as a primary navigation command.)
- **`npm run build` now wipes `dist/` first** (`rm -rf dist && tsc …`). The
  `bun build --compile` binary step reads from `dist/`, so a stale `dist/`
  (e.g. leftover output from the now-deleted `src/hooks/` dir, or a renamed
  module) could ship outdated JS. A clean rebuild on every build closes that
  hole.
- **`src/acp/**/*.ts` added to the Vitest coverage scope** so the editor-
  integration layer is measured alongside `utils/`, `api/`, and `config/`.
- **`conf` upgraded 12 → 13** (`^13.1.0`). Brings `rootSchema`/`ajvOptions`
  options, a `.delete()` dot-notation typing fix, and updated transitive deps
  (`dot-prop` 8→9, `ajv` patch bumps). Held below v14 pending a separate
  engine/compat review — the v13 bump was all this release needed.
- **`tsconfig.json` now declares `"types": ["node"]`.** Without it, `tsc
  --noEmit` was silently emitting 445+ `TS2591: Cannot find name 'fs'/'path'/
  'process'/…` errors across 86 files — `npm run build` appeared to succeed
  only because the config doesn't set `noEmitOnError`, so the broken JS was
  written to `dist/` alongside the errors. With `types: ["node"]` the type
  check is genuinely clean (0 errors). This was a long-standing latent issue
  masked by the emit-on-error behaviour.
- **`npm audit fix` patched the high-severity `vite` advisory**
  (GHSA-v6wh-96g9-6wx3 / GHSA-fx2h-pf6j-xcff — `launch-editor` UNC path +
  `server.fs.deny` bypass on Windows) by bumping the transitive `vite`
  brought in by `vitest`. One advisory remains: a single **low** in `esbuild`
  (GHSA-g7r4-m6w7-qqqr — dev-server-only arbitrary file read on Windows),
  pulled in transitively by `vitest`/`tsx`, with no fix short of a major bump
  of those dev tools. Removing `pkg` (below) cleared the prior moderate
  advisory, so `npm audit` now reports **0 high/critical** (1 low total).

### Added

- **Command registry — single source of truth for slash-command metadata**
  (`src/renderer/commands/registry.ts`). Previously three places carried the
  same data and drifted: the `COMMAND_DESCRIPTIONS` record in `App.ts` (123
  hand-typed rows driving `/` autocomplete), the `helpCategories` array in
  `components/Help.ts` (hand-typed `/help` rows), and the `case` labels in
  `renderer/commands.ts` + `acp/commands.ts`. Now `App.ts` and `Help.ts` both
  derive from the registry, and two new tests (`registry.test.ts`) enforce the
  invariant at build time: **every top-level `case` label in either dispatcher
  must exist in the registry** — adding a `case 'foo':` without a registry
  entry now fails CI. The registry also exposes `resolveCommand()`,
  `ALL_COMMAND_NAMES`, and `ALL_ALIASES` so the dispatchers themselves can
  move to registry lookups incrementally.
- **ACP layer test coverage.** Two new test files lift the previously
  untested ACP adapter from 0% to meaningful coverage:
  - `src/acp/session.test.ts` (35 tests) covers `buildProjectContext`,
    `toolCallMeta` (every tool → ACP kind mapping), and `buildRawOutput`
    (diff formatting for edits, stdout surfacing for commands, error paths).
    `toolCallMeta` and `buildRawOutput` were promoted from module-private to
    exported specifically so they can be tested in isolation.
  - `src/acp/commands.test.ts` (10 tests) covers `initWorkspace` — the
    filesystem bootstrap that runs on every ACP `session/new`: `.codeep/`
    creation, project initialization, the read+write permission grant, and
    the informed-consent banners for custom slash commands and lifecycle
    hooks. Uses an isolated tmpdir per test (same pattern as
    `checkpoints.test.ts`).
  - Together they catch regressions in the data-shaping surface and the
    onboarding flow without mocking the agent loop, which is exercised
    end-to-end by `toolExecution.test.ts`.
- **Settings screen: all 7 `as any` casts removed.** Previously every
  `config.set`/`config.get` call in `Settings.ts` used `setting.key as any`
  because `SettingItem.key` was typed as `string` rather than `keyof
  ConfigSchema`. Now:
  - `ConfigSchema` is exported from `config/index.ts` so consumers can
    reference its keys.
  - `SettingItem.key` is typed as `keyof ConfigSchema` — a typo'd or unknown
    setting key is now a compile error, not a silent runtime no-op.
  - All writes go through a single typed `writeSetting(setting, value)`
    helper. The unavoidable `as ConfigSchema[K]` cast lives in exactly one
    audited spot instead of seven call sites, and `config.get(setting.key)`
    no longer needs any cast.
  - 13 new tests (`Settings.test.ts`) pin the write path: number editing +
    clamping, select cycling (forward/backward/wrap), escape-abort, and the
    `updateRateLimits()` side effect for the rate-limit settings.
- **`CONTRIBUTING.md` + `SECURITY.md` added.** Previously the repo had
  neither — the README's "Contributing" section was one sentence pointing
  at GitHub issues. The new files cover:
  - `CONTRIBUTING.md`: the npm-based setup, the test/build/type-check loop
    (including "what gets a test" guidance), code style, an architecture
    reading order for new contributors, the provider-integration flow, and
    the release pipeline.
  - `SECURITY.md`: how to report a vulnerability (GitHub Security Advisories
    preferred), what's in/out of scope for an agent that can edit files and
    run shell commands, and a list of the hardening features already in place
    (project permissions, confirmation modes, hook trust gate, keychain
    storage, telemetry opt-out) so contributors don't regress them.
  - The README's "Contributing" section now links to both.
- **CI workflow switched from bun to npm** (`.github/workflows/ci.yml`).
  The workflow used `bun install --frozen-lockfile`, but `bun.lock` was
  removed and `.gitignored` when npm became canonical (#2), so the gate
  would fail on a clean checkout. Now uses `actions/setup-node@v5` with
  Node 20 + `npm ci` + `npx tsc --noEmit` + `npm test`, consistent with
  `CONTRIBUTING.md`. `release-binaries.yml` still uses bun (its
  `bun build --compile` step produces the cross-platform binaries — that's
  tracked as a separate migration, not safe to flip blindly).
- **`server.ts` refactor: extracted handlers + pure helpers to module scope.**
  `startAcpServer()` was a ~1300-line closure whose 12+ request handlers
  (`session/set_mode`, `session/set_config_option`, `session/list`,
  `session/delete`, …) were unreachable by unit tests because they captured
  the live stdio transport. The refactor lifts them into two testable
  surfaces:
  - **`server.ts` module-scope exports** — the pure helpers
    (`formatToolInputForPermission`, `resolveLocalPath`,
    `collectEmbeddedContext`, `providerHasKey`, `buildConfigOptions`,
    `AGENT_MODES`) now carry `export` and are covered by `server.test.ts`.
  - **New `serverHandlers.ts` module** — the four synchronous session
    handlers (`handleSetMode`, `handleSetConfigOption`, `handleSessionList`,
    `handleSessionDelete`) plus a pure `applyConfigOption` helper, each
    taking an explicit `(msg, deps)` pair where `deps = { transport,
    sessions }`. The transport is stubbed in tests via a recorded-call
    array, which is what makes the assertions readable.
  - `startAcpServer()` now constructs one `handlerDeps` object and delegates
    to the extracted functions, keeping the dispatch loop intact.
  - The async handlers (`handleSessionPrompt`, `handleSessionNew`,
    `handleSessionLoad`, `handleSessionResume`, image/vision, agent loop)
    stay in the closure for now — they reach into MCP spawning, the
    keychain, and `runAgentSession`, each of which needs its own extraction
    pass. Tracked as a follow-up.
  - Coverage: `serverHandlers.ts` at **89.7% lines / 87% statements**;
    `server.ts` up from 0% to 25.7%. 56 new tests across `server.test.ts`
    (34) and `serverHandlers.test.ts` (22).
- **`release-binaries.yml` migrated from bun to npm** (build + publish-npm
  jobs). `bun install` → `npm ci`, `bun run` → `npm run`,
  `setup-bun` → `setup-node@v5` (Node 20 build, Node 24 publish). Only the
  `bun build --compile` step keeps bun — it produces the distributed
  standalone binaries and has no npm-side equivalent (the deprecated `pkg`
  was never wired into CI). This makes CI + release consistent with the
  canonical npm toolchain (#8 fixed the same drift in `ci.yml`).
- **Removed deprecated `pkg` devDependency.** `pkg` was unmaintained since
  2023 (archived by Vercel), carried a moderate-severity advisory, and its
  `build:binary` script was never invoked by any workflow — the release
  pipeline uses `bun build --compile` instead. Removed `pkg`, the
  `build:binary` script, and the top-level `"pkg"` config block from
  `package.json`. `npm audit` now reports **0 high/critical** (was 1 high).
  `@yao-pkg/pkg` (the active fork) stays available if we ever need an
  npm-side path to standalone binaries.
- **Added `noEmitOnError: true` to `tsconfig.json`.** Now that `tsc --noEmit`
  is clean (0 errors), this flag hardens the build: `tsc` will refuse to emit
  `dist/` if a type error slips in, so a broken build can no longer be masked
  by a stale `dist/`. Prevents regressions of the kind that #7 fixed (445+
  errors silently emitted for months).
- **Lifted `handleListProviders` + `buildProviderList` into
  `serverHandlers.ts`.** The provider-catalog handler was the simplest
  remaining async-safe handler — pure shape mapping over `PROVIDERS` + a
  single `transport.respond`. Extracted as `buildProviderList()` (pure,
  testable shape) + `handleListProviders(msg, deps)` (thin wrapper). 5 new
  tests pin the shape including `dynamicModels` flagging for open-ended
  providers (OpenRouter, Ollama). `serverHandlers.ts` coverage now at
  **89.7% lines**.

## [2.13.0] — 2026-06-18

> Three new providers — **Kimi** (Moonshot), **Grok** (xAI), and **Qwen** (Alibaba) — covering the major coding models. Kimi and Qwen include their flat-fee coding-plan subscriptions alongside pay-per-use; Grok adds graded `/thinking` effort.

### Added

- **Kimi (Moonshot AI).** `kimi` drives the **Kimi Code** subscription
  (`api.kimi.com/coding`, model alias `kimi-for-coding`); `kimi-api` is
  pay-per-use (`api.moonshot.ai`, default `kimi-k2.7-code`); `kimi-cn` for
  mainland China. Keys: `KIMI_CODE_API_KEY` / `MOONSHOT_API_KEY`.
- **Qwen (Alibaba Model Studio).** `qwen` drives the **Coding Plan**
  subscription (`coding-intl.dashscope…`, `sk-sp-` key); `qwen-api` is
  pay-per-use (DashScope, default `qwen3-coder-plus`); plus `qwen-cn` /
  `qwen-cn-api` and a free **ModelScope** tier (`modelscope`). Keys:
  `BAILIAN_CODING_PLAN_API_KEY` / `DASHSCOPE_API_KEY` / `MODELSCOPE_API_KEY`.
- **Grok (xAI).** `grok` — pay-per-use (`api.x.ai`), default `grok-build-0.1`
  plus `grok-4.3` and the fast/reasoning variants. Key: `XAI_API_KEY`.

### Changed

- **`/thinking` now covers Grok** (`reasoning_effort` — low/medium/high). Kimi
  and the Qwen coder models have no graded knob, so they stay out of the picker.
- **Qwen tool turns are sent non-streamed.** DashScope rejects `tools` with
  `stream:true`, so agent turns that carry tools buffer the reply (handled
  transparently); other providers keep streaming.
- Kimi K2.x code models fix temperature internally — Codeep withholds the
  sampling params so they don't 400.

## [2.12.0] — 2026-06-16

> New `/thinking` (alias `/effort`) reasoning-effort control — `auto · low · medium · high · max`, shown beside the model in the status bar and clamped per provider+model so it never sends a value the API rejects. Plus a Codeep agent identity and iOS-testing MCP servers.

### Added

- **`/thinking` (alias `/effort`) — thinking / reasoning-effort tiers.** A single
  control with five tiers (`auto · low · medium · high · max`) for how hard the
  model reasons. `auto` (default) sends nothing — each model's own default. The
  other tiers are clamped to the nearest level the **active provider+model**
  actually accepts, so an unsupported value is never sent: Anthropic Opus/Sonnet
  → `output_config.effort`, OpenAI GPT‑5.x → `reasoning_effort` (Max→xhigh),
  Google Gemini 3 → low/high, DeepSeek V4 & Z.AI **GLM‑5.2** → high/max,
  OpenRouter → unified `reasoning.effort`. The active tier shows next to the
  model in the status bar; models without a graded knob (Haiku, GLM‑Turbo,
  Ollama, custom) hide it.
- **About‑Codeep persona.** The agent system prompt now states what Codeep is and
  points you at the right slash‑command, backed by a curated command index.
- **MCP marketplace: iOS‑testing servers.** Added **iOS Simulator** and **Mobile
  (iOS + Android)** servers for device/UI automation.

### Changed

- **MCP browser server is now Playwright** (supersedes Puppeteer) — the de‑facto
  browser‑automation MCP.

## [2.11.2] — 2026-06-14

> Trimmed the model pickers (Claude Fable 5 is de-listed — unavailable under the US export ban — and a few older variants drop off), and editor clients (VS Code, Zed) now see API retry/backoff instead of an endless "Thinking…" spinner.

### Changed

- **Model picker cleanup across every provider.** Claude **Fable 5** is removed
  from the Anthropic picker (unavailable under the US export ban; Opus 4.8 stays
  the default). Z.AI drops `glm-5.1` and `glm-5` (keeps `glm-5.2` + `glm-5-turbo`);
  OpenAI drops `gpt-5.4-nano` (keeps 5.5 / 5.4 / 5.4-mini). DeepSeek, Google, and
  MiniMax are unchanged. All ids remain valid if set by hand — they're just no
  longer offered. Context/cost tables updated to match.

### Fixed

- **ACP retry visibility.** When a request hit a transient API error and the
  agent retried with backoff, the ACP path dropped the notice (only the bare
  iteration counter was suppressed, but the retry message went with it) — so
  editor clients showed an indefinite "Thinking…" while the CLI was actually
  retrying. Retry/backoff notices ("API 429 … retrying in 10s (1/3)") and
  context warnings (⚠) are now forwarded as agent thoughts; the plain
  iteration counter stays internal.

## [2.11.1] — 2026-06-14

> Hotfix: the Z.AI default was `glm-5.2[1m]`, but the API rejects that id ("Unknown Model", code 1211) — so a fresh Z.AI session failed on its first request. The default is now plain `glm-5.2` (which works), and the non-working `[1m]` variant is removed from the picker.

### Fixed

- **Z.AI default model `glm-5.2[1m]` returned "Unknown Model".** The 1M-context
  `[1m]` suffix from the devpack docs isn't accepted by the Z.AI chat API
  endpoints Codeep uses, so it 400'd on every request. The default (and
  cold-start default) is now `glm-5.2`, and `glm-5.2[1m]` is dropped from all
  four Z.AI providers' model lists. If your config still points at
  `glm-5.2[1m]`, switch with `/model glm-5.2`.

## [2.11.0] — 2026-06-12

> New default model **GLM-5.2** (1M-context `glm-5.2[1m]`) across every Z.AI provider, plus TUI polish: ↑ recalls history, diffs render green/red, full `/` autocomplete, and `/settings` values now stick.

### Added

- **GLM-5.2 — the new default Z.AI model.** Added across all four Z.AI
  providers (international + China, subscription + pay-per-use): `glm-5.2[1m]`
  (1M context — the `[1m]` suffix selects the million-token window) is now the
  default, with plain `glm-5.2` also offered; GLM-5.1, GLM-5 Turbo, and GLM-5
  stay available. Context-window and cost tables include both new ids. (GLM-5.2
  per-token pricing isn't published yet, so `/cost` mirrors GLM-5.1 for now —
  and on the GLM Coding Plan billing is a flat subscription anyway.) Editor
  clients pick this up automatically over ACP.

### Fixed

- **`/settings` values stick now.** A block of startup "migrations" ran on
  every launch and silently forced user-chosen values back up — `maxTokens`
  below 32768, `agentMaxDuration` below 480 min, API timeout and rate limits —
  so the affected settings were effectively lies. They now run exactly once
  per config (recorded via `migrationVersion`); after that, what you set is
  what you get.
- **`↑` recalls prompt history on an empty input.** The status bar has always
  advertised "↑↓ history", but a scroll handler intercepted the arrows first,
  so history recall was unreachable. Arrows now do history (like every shell);
  scrolling lives on PgUp/PgDn and the mouse wheel.
- **New messages no longer yank you to the bottom.** While you're scrolled up
  reading, incoming messages (every agent action, mid-run) used to reset the
  view to the bottom. The view now stays put and the status bar shows a
  "↓ N new · PgDn" badge until you return.

### Changed

- **Diff blocks render as diffs.** ```diff fences — which the agent emits on
  every edit confirmation — now highlight +added lines green, -removed red,
  and @@hunks cyan. Previously they fell through to JS keyword colors.
- **Every command in `/` autocomplete has a description.** 48 of 123 rows were
  blank (the whole scaffold/git/devops family — /component, /pr, /docker, …)
  and 9 bare single-letter aliases cluttered the list. The dropdown is now
  derived from a single command registry, so a command can't ship without a
  description again; the single-letter shortcuts (`/c`, `/t`, …) still work,
  they're just not listed.
- **~800 lines of dead UI code removed** (an unused parallel chat renderer and
  two unreachable fullscreen screens) — no behavior change, but edits can no
  longer land in the wrong renderer by mistake.
- **ACP `session/new` now returns the prior transcript on resume.** When an
  editor client reconnects with `fresh: false` (e.g. a VS Code window reload),
  the response carries the workspace session's `history` (user/assistant only,
  mirroring `session/load`) so the client can repaint the chat instead of
  showing blank while the agent still holds the context. Empty on a fresh
  session; older clients ignore the extra field. Powers Codeep VS Code 2.6.0's
  reload restore.

## [2.10.0] — 2026-06-11

> `/tasks add` now matches the dashboard: tag a task as a bug or feature and give it a description inline (`--bug` / `--feature` / `--desc`), and the list tags each row with its project when global.

### Added

- **Task types in `/tasks add`.** Append `--bug` or `--feature` (or `--task`,
  the default) to file the task under the right type on the codeep.dev
  dashboard — e.g. `/tasks add login button misaligned --bug`. The flag can sit
  anywhere in the arguments and is stripped from the title; the dashboard and
  the macOS app already render the type with its own icon and color, so this
  brings all three surfaces to parity (the dashboard and macOS both let you pick
  a type; the CLI previously hardcoded `task`).
- **Task descriptions in `/tasks add`.** `--desc` (or `--description`) captures
  the following words — up to the next flag — as the task's description, e.g.
  `/tasks add Fix login --bug --desc NPE when the email is empty`. It's the same
  field the dashboard and macOS app set; the `/tasks` list already prints it and
  it's injected into the agent's task-context prompt, so a CLI-set description
  immediately enriches what the agent sees. Omitted from the request when absent.

### Changed

- **`/tasks` list tags each row with its project when listed globally.** Running
  `/tasks` outside a project lists pending tasks across all projects; each row
  now shows its project name (matching the macOS and dashboard task rows) so a
  mixed list is legible. Inside a project the header already names it, so rows
  stay uncluttered.
- **`/tasks` autocomplete description** now reflects the full command — it
  covered only "show pending tasks" and hid the `add`/`done`/`delete`
  subcommands and the type flags from `/` autocomplete.

### Fixed

- **`/stats` now shows the prompt-caching summary, and a dead duplicate cost
  case is gone.** The session-cost view had two switch branches sharing a
  `case 'cost'`: `/cost` always rendered the full `formatCostReport()` (the
  cross-surface report the editor clients use, with the prompt-caching section),
  while the second branch — the detailed `/stats` view — was unreachable for
  `/cost` yet was the only one *missing* that caching section. `/stats` now
  reports cache reads/writes and estimated savings too (parity with `/cost` and
  the 2.0.2 caching work), and the dead `cost` label was removed so the dispatch
  is honest. What `/cost` displays is unchanged.
- **`/keysync` now appears in `/` autocomplete.** The command shipped in 2.8.0
  with a description and an ACP entry, but was missing from the TUI command
  list, so terminal users never saw it offered. (It always worked when typed.)

## [2.9.0] — 2026-06-09

> Claude Fable 5 — Anthropic's most powerful model, a new tier above Opus — is now in the model picker ($10/$50 per MTok, 1M context). Opus 4.7 and 4.6 leave the picker (Opus 4.8 stays the default). Plus a real compatibility fix: temperature is no longer sent to models that reject it (Fable 5 / Opus 4.7+), which previously surfaced as an opaque 400.

### Added

- **Claude Fable 5** (`claude-fable-5`) in the Anthropic provider — the most
  powerful Claude model, a new tier above Opus. $10 input / $50 output per
  MTok, 1M context window. Pick it with `/model claude-fable-5`.

### Changed

- **Opus 4.7 and 4.6 removed from the model picker** now that Opus 4.8 and
  Fable 5 cover both tiers. The ids remain valid — if your config still points
  at one, it keeps working; it just isn't offered for new selection.

### Fixed

- **`temperature` is no longer sent to Anthropic models that reject it.**
  Fable 5 and Opus 4.7+ return HTTP 400 when the request includes
  `temperature` — and that 400 was previously masked by the tools-fallback
  retry, surfacing as a generic "API error". A model-aware guard
  (`modelRejectsSamplingParams`) now omits the parameter on those models
  across all three Anthropic request paths (agent, fallback, plain chat);
  omission means the API default, so behavior on other models is unchanged.

## [2.8.0] — 2026-06-09

> API keys are now keychain-first and stay local by default — syncing them to codeep.dev is an explicit opt-in (`/keysync on`), and `codeep account purge-keys` wipes any keys already on the server.

### Added

- **`/keysync on|off|status`** — opt in (or out) of syncing API keys to
  codeep.dev. **OFF by default**: your keys live only in the OS keychain unless
  you enable this. When on, `codeep account push`/`sync` upload/download keys;
  the command warns that synced keys are stored server-readable. Also available
  in `/settings`, and forced off by the `CODEEP_NO_KEY_SYNC` env var (org policy).
- **`codeep account purge-keys`** — delete every API key stored on codeep.dev in
  one shot (cloud-only; your local OS keychain is untouched). A clean exit if you
  synced keys before and want them off the server.

### Changed

- **`codeep account push` / `account sync` no longer move API keys unless cloud
  key sync is enabled** (`/keysync on`). They still push/pull personalities,
  custom commands, and your profile as before — only the secret half is gated.
  Existing users who relied on key sync just run `/keysync on` once.

## [2.7.0] — 2026-06-09

> A batch of review tooling: YAML review config, a `codeep hook install` pre-commit reviewer, `codeep review --rules` to list rule ids, and an opt-in `codeep review --ai` second opinion. Plus fixes: compiled binaries report the real version (no more "vunknown"), ACP editor sessions no longer mutate the global confirmation setting, and keychain-fallback keys get swept into the keychain once it's available.

### Added

- **YAML review config.** `.codeep/review.yml` / `.codeep/review.yaml` are now
  supported alongside `.codeep/review.json` (YAML preferred when present).
  Single-quoted YAML keeps regex backslashes literal (`pattern: '\bfoo\('`),
  avoiding JSON's double-escaping. Same schema; format is auto-detected.
- **`codeep hook install`** — installs a git pre-commit (or `--pre-push`) hook
  that runs `codeep review --fail-on <level>` on your changes, blocking the
  commit when issues at/above the threshold are found (honors `.codeep/review.*`,
  no API key). `codeep hook uninstall` removes it; Codeep never overwrites a hook
  it didn't create.
- **`codeep review --rules`** — lists the built-in rule ids (the values you can
  put in `disable` in `.codeep/review.*`) and exits.
- **`codeep review --ai`** — opt-in: after the offline pass, asks your configured
  provider for a contextual second opinion, merged into the report as a clearly
  tagged advisory section. Needs an API key (degrades to deterministic-only
  without one) and never affects the exit code — the deterministic review stays
  authoritative, so CI (the GitHub Action) is unchanged.

### Fixed

- **Keychain fallback sweep.** If the OS keychain was unavailable on a prior run,
  API keys fell back to plaintext config. They're now swept into the keychain
  automatically once it becomes available (completes the 2.5.2 key-storage work).

- **Compiled binary version.** The standalone binaries printed "Codeep
  vunknown" because they read the version from `package.json`, which isn't on
  disk in a compiled binary. The version is now baked in at build time, so
  `--version` is correct everywhere (npm, Homebrew, and the standalone binaries).
- **ACP confirmation setting no longer leaks/races.** Manual-mode editor
  sessions used to flip the global `agentConfirmWriteFile` config and restore it
  non-atomically around each prompt — which could leak the session's mode into
  the terminal app and race when prompts overlapped. Write/edit confirmation is
  now scoped to the run via a per-call option, with no global config mutation.

## [2.6.0] — 2026-06-09

> New: configurable code-review rules. Drop a `.codeep/review.json` into a repo to add your own deterministic review rules, disable built-in ones, and scope which files are reviewed — enforced the same way by `codeep review` (CLI) and the Codeep GitHub Action, with zero LLM cost.

### Added

- **`.codeep/review.json` — review rules as config.** The deterministic
  reviewer (`codeep review`, `/review --static`, and the GitHub Action) now
  reads a per-project config:
  - **`rules`** — your own checks: `id`, `pattern` (regex), `message` (required)
    plus optional `flags`, `category`, `severity`, `suggestion`, `extensions`.
  - **`disable`** — turn off built-in rules by id (each built-in now has a stable
    id, e.g. `eval-usage`, `todo-comment`, `any-type`, `long-file`).
  - **`include` / `exclude`** — glob scoping (`**`, `*`, `?`).
  A missing, malformed, or partially-invalid config never breaks a review — bad
  entries are skipped with a warning and valid ones still apply.

### Security

- **Hardened the reviewer against untrusted custom rules.** Since a PR's
  `.codeep/review.json` runs in CI via the Action, custom regexes are screened
  at load (length cap + a catastrophic-backtracking/ReDoS heuristic), the match
  loop guards zero-width patterns (no infinite loop) and caps matches per rule,
  and the GitHub Action bounds each review's wall-clock at 180s.

## [2.5.2] — 2026-06-08

> Security: provider API keys are now stored in your OS keychain instead of plaintext in the config file, and there's a first-class telemetry opt-out (`CODEEP_NO_TELEMETRY` / `DO_NOT_TRACK` / `telemetry: false`). Existing plaintext keys migrate to the keychain automatically on first run.

### Security

- **API keys moved to the OS keychain.** Keys were written in plaintext to
  `~/.codeep/config.json`. They now persist in the system keychain (macOS
  Keychain / Linux Secret Service / Windows Credential Vault) via the secure
  storage layer; a synchronous in-memory cache keeps key lookups fast. On first
  run, any existing plaintext keys (and the legacy single-key field) are
  migrated into the keychain and the plaintext is wiped — a key is only removed
  from plaintext after its keychain write is confirmed, so an interrupted
  migration never loses a key (it retries next start). When no keychain is
  available (e.g. headless Linux without libsecret) Codeep falls back to config
  storage and warns.
- **Telemetry opt-out.** Once linked to codeep.dev, Codeep uploads usage stats,
  session transcripts, `progress.md`, and project memory notes to power the
  dashboard. Set `CODEEP_NO_TELEMETRY=1` (or the cross-tool `DO_NOT_TRACK=1`, or
  `"telemetry": false` in config) to disable all automatic uploads. Explicit
  `codeep account push` / `account sync` are user-initiated and never gated.
- **`/telemetry` command.** New slash command (TUI + ACP) to show telemetry
  status and toggle it: `/telemetry`, `/telemetry on`, `/telemetry off`. It
  reports when an env var is forcing it off (the config flag can't override env).
- **Confirmation gate fails closed.** The agent's permission gate now allows a
  dangerous tool only on an explicit allow outcome — a malformed/unknown
  permission response from an editor client now denies instead of letting the
  tool run. The ACP mode switch no longer writes the global `agentConfirmation`
  setting, so switching an editor session to auto-approve can't silently disarm
  the confirmation gate in your terminal sessions.

### Added

- **`/telemetry`** — show or toggle automatic cloud telemetry from the CLI or
  any ACP editor.

### Notes

- The keychain migration is **one-way**: after upgrading, plaintext keys are
  removed from the config file. If you downgrade to an older Codeep that doesn't
  read the keychain, re-enter your keys or run `codeep account sync`. Your keys
  remain in the keychain and are picked up again when you re-upgrade.

## [2.5.1] — 2026-06-08

> Fix: chat could crash with "Cannot read properties of undefined (reading 'indentation')" when a project's `.codeep/intelligence.json` was missing sections (from an interrupted or older scan). The file is now backfilled on load, so partial intelligence can never crash a prompt — most visible in the VS Code/Zed (ACP) chat.

### Fixed

- **Partial `.codeep/intelligence.json` crash** — a project intelligence file
  that was missing whole sections (e.g. `conventions`) — written by an
  interrupted scan or an older CLI — caused `generateContextFromIntelligence`
  to throw `Cannot read properties of undefined (reading 'indentation')` on the
  next prompt. This surfaced in editor clients (VS Code / Zed via ACP) as a chat
  error on every message. `loadProjectIntelligence` now merges loaded data over
  a complete default skeleton (per-section), and the context formatter
  defensively normalizes its input, so a partial or older-schema file is
  backfilled instead of dereferenced blindly. No re-scan required.

## [2.5.0] — 2026-06-04

> New: `codeep review` (offline, CI-friendly code review) and Continue (a paused-at-the-limit run resumes when you say "continue" instead of dead-ending). Plus a fix where file edits or skill params containing a `$` could be written corrupted.

### Added

- **`codeep review`** — a headless, deterministic code review you can drop into
  CI (no API key, no TUI). Reviews the files you pass (or your unstaged git
  changes, falling back to a `src/` scan), prints a markdown report or `--json`,
  and exits non-zero when an issue at or above `--fail-on <error|warning|info|none>`
  is found (default `error`). Pairs with a GitHub Action to gate PRs.
- **Continue after a safety limit.** When the agent reaches its step or time
  limit it no longer dead-ends — the run pauses with a clear, resumable notice
  (`⏸ Paused … say **continue** to pick up where it left off`) instead of looking
  like a failure, and saying *continue* resumes it with full context. Works in
  the TUI and in ACP clients (Zed, the VS Code extension).

### Fixed

- **Edits containing `$` are written literally.** `edit_file` (and the diff
  preview) applied replacements with `String.replace(text, newText)`, which
  interprets `$&`, `$$`, `$1` etc. in the replacement — so any edit whose new
  text contained `$` (template literals, shell variables, regex) was silently
  corrupted on write. Replacements are now inserted verbatim.
- **Skill parameter expansion is `$`-safe and literal.** `${param}` substitution
  had the same `$`-interpretation bug in the value, and interpolated the param
  name into a regex unescaped (so a `.` over-matched and a `(` could throw).
  Both are fixed.

## [2.4.2] — 2026-06-02

> Stability: an unexpected error no longer crashes Codeep to a garbled terminal — it's logged, your conversation is saved, and recoverable background errors keep the session alive. Also fixes `codeep account` occasionally linking without storing the sync token.

### Fixed

- **Crash resilience** — added global `uncaughtException` / `unhandledRejection`
  handlers. A stray throw deep in the agent loop used to kill the process with the
  terminal still in raw mode + alternate screen (leaving your shell garbled), or
  vanish silently. Now an uncaught exception restores the terminal, logs the cause,
  and best-effort saves the conversation before exiting; an unhandled promise
  rejection (e.g. a failed background sync) surfaces as a warning and keeps the TUI
  running instead of tearing it down.
- **`codeep account` sync token** — account linking now waits for the sync token
  before completing. The server could briefly report the login authorized before
  the token was issued, so the CLI linked the account but stored no token, leaving
  `codeep account sync` failing with "Not linked to codeep.dev". Pairs with the
  matching codeep.dev fix.

## [2.4.1] — 2026-06-01

> MiniMax M3: the new MiniMax flagship replaces M2.7 across all three MiniMax providers (subscription, pay-per-use, China), with updated pricing and context window so cost tracking stays accurate.

### Changed

- **MiniMax M3** (`MiniMax-M3`) replaces `MiniMax-M2.7` as the model + default for
  the `minimax`, `minimax-api`, and `minimax-cn` providers. Pricing updated to the
  standard rate **$0.60 / $2.40** per 1M tokens (input / output) and context window
  to **512K**, so `/cost` and the dashboard bill it correctly. The native macOS / iOS
  apps get the same update via the shared CodeepCore catalog.
- **README provider list** is now generic (model families, not pinned versions) —
  it no longer needs editing every time a provider ships a new model.

## [2.4.0] — 2026-05-30

> New models (Claude Opus 4.8, Gemini 3.5 Flash) plus a better local-model experience: browse a curated catalog of coding models, remove models, and see on-disk sizes — all from `/model`.

### Added

- **Claude Opus 4.8** — added to the Anthropic provider and set as the new
  default model. Pricing: $5 / $25 per 1M tokens (input / output), 1M context.
- **Gemini 3.5 Flash** (`gemini-3.5-flash`) — replaces the preview Flash in the
  Google provider list. Pricing: $1.50 / $9.00 per 1M tokens, 1M context.
- **`/model browse` (Ollama)** — a curated catalog of recommended local coding
  models (Qwen2.5 Coder, DeepSeek Coder V2, Llama 3.1, DeepSeek R1, …) with
  parameter sizes, rough VRAM, and an agent-mode suitability hint. Pick one to
  pull it. Mirrors the MCP/skills catalog pattern.
- **`/model rm <name>` (Ollama)** — remove a locally-installed model to reclaim
  disk, without leaving Codeep. Remote-server guard like `/model pull`.
- **On-disk size in `/model` picker** — the Ollama model list now shows each
  model's size on disk alongside the agent-mode hint.
- **Native Ollama API (beta, opt-in)** — set **Ollama Native API (beta) → On**
  in `/settings` to route Ollama through its native `/api/chat` endpoint instead
  of the OpenAI-compatible `/v1` shim. Honors **`num_ctx`** (the model uses its
  full context window instead of Ollama's small default) and **`keep_alive`**
  (keeps the model resident, avoiding reload latency every turn). Tunable via
  `ollamaKeepAlive` (default `30m`) and `ollamaNumCtx` (`0` = auto-detect via
  `/api/show`). **Off by default** — existing transport unchanged unless you opt
  in. Verified against Ollama 0.24 (chat, streaming, usage, native tool calls);
  marked **beta** while it gets coverage across more models and longer sessions.
  **Please report issues** at https://github.com/VladoIvankovic/Codeep/issues —
  feedback decides when it becomes the default.

### Notes

- Pricing tables (`/cost`, dashboard) updated so the new models bill at the
  right rates. Previous models (Opus 4.7 / 4.6, Flash preview) stay listed for
  back-compat. VS Code/Zed inherit the new catalog automatically over ACP; the
  native macOS / iOS apps get the same update via the shared CodeepCore catalog.
- `/model browse` and `/model rm` shell out to the local `ollama` binary, so
  they only run when Ollama is local (remote servers get an SSH hint instead).

## [2.3.1] — 2026-05-25

> Profile sync everywhere: `codeep account sync`/`push` now carry your user profile too, and a new `/me sync` pushes it from any surface.

### Fixed

- **`codeep account sync` / `account push` now include your user profile.** They
  synced keys + personalities + commands but skipped `~/.codeep/profile.md`;
  now the profile rides along (additive pull — never clobbers a local profile).

### Added

- **`/me sync`** — push your profile to the dashboard (and additive-pull) right
  from the profile command, reachable on every surface (TUI, ACP/Zed, and the
  VS Code chat).

## [2.3.0] — 2026-05-25

> Codeep gets personal and gains a team: a **user profile** (`/me`) makes it adapt to you across every surface, and **multi-agent delegation** lets it hand self-contained sub-tasks to specialist sub-agents that run in their own context.

### Added — Personalization

- **User profile (`/me`).** A durable, human-readable description of you, injected
  into the agent's system prompt on every run so it adapts to how you work
  without you repeating yourself. Two scopes: global `~/.codeep/profile.md`
  (reply language, response style, default stack, universal "always / never")
  and project `.codeep/profile.md` (your role, goals, constraints for this repo).
  Manage with `/me`, `/me init [project]`, and `/me on` / `/me off`. Flows to
  every surface because they share the same files.
- **Opt-in profile auto-learn.** `/me learn on` lets Codeep quietly extract your
  durable preferences from sessions — one cheap, throttled LLM pass at session
  save — and merge them into a separate `profile.learned.md` (global + project),
  kept apart from your hand-written file so it's never clobbered. `/me learn`
  runs it once on demand, `/me learn project` scopes to this repo, `/me forget`
  clears it. Off by default; gated by `autoLearnProfile`.
- **Profile sync.** `codeep account sync` pushes your global `profile.md` to the
  codeep.dev dashboard (where it's editable) and pulls it to new machines. Pull
  is additive — a web edit never overwrites an existing local profile.
- **`/me` in ACP.** Zed, VS Code, and any ACP client can view and manage the
  profile, not just the terminal.

### Added — Multi-agent delegation

- **Sub-agents + the `delegate` tool.** The agent can delegate a self-contained
  sub-task to a specialist that runs in its OWN fresh context window and returns
  only a summary — so the main context stays small and each sub-task runs with a
  tuned persona and a scoped toolset. Four built-ins: `planner` (read-only
  planning), `researcher` (read-only explorer), `reviewer` (read-only senior
  review), `tester` (writes + runs tests). Run `/agents` to list them.
- **Custom sub-agents.** Define your own with a frontmatter `.md` in
  `.codeep/agents/<name>.md` (project) or `~/.codeep/agents/` (global): name,
  description, a `tools` allowlist, optional `model` override, `personality`
  preset, and `maxIterations` budget. Mirrors the personalities/skills pattern.
- **Auto-review pipeline.** Enable **Agent Auto-Review** (`agentAutoReview`, off
  by default) and after any run that changes files, Codeep automatically
  delegates to the `reviewer` and appends its findings — a review stage that
  always happens, without relying on the model to self-delegate one.
- **`/agents`** surfaced in the TUI and ACP (Zed / VS Code).

### Notes

- Profile is local-first and opt-in: injection is gated by `userProfile` (default
  on), auto-learn by `autoLearnProfile` (default off). Nothing reaches the
  dashboard unless you run `codeep account sync`.
- Sub-agent tool scoping is enforced at dispatch — a `researcher` can't write
  files even if it tries. Sub-agents inherit your profile, project rules, and
  permission prompts, and their file changes are covered by `/undo` (they record
  into the parent's session). Delegation depth is capped at 1; model overrides
  are sequential-safe.

## [2.1.4] — 2026-05-22

> Long agent runs no longer silently forget how they started — when prior chat history overflows the context budget, the dropped older messages are summarized instead of just truncated. Plus a command-whitelist hardening.

### Security

- **Inline code execution is blocked in agent mode.** The command whitelist
  allowed interpreters like `node`/`python`/`php`, but their eval flags
  (`node -e`, `python -c`, `php -r`, `deno eval`, …) turned a whitelisted
  runtime into arbitrary code execution. Those flags are now rejected (including
  combined short clusters like `-pe`). Running a *file* (`node app.js`,
  `python script.py`) is unaffected. Defense-in-depth — the manual-mode
  permission prompt is still the primary gate.

### Added

- **Auto-summarized history.** When the prior conversation exceeds the agent's
  context budget, Codeep now condenses the dropped (oldest) messages into a
  short recap — preserving early decisions, constraints, and unfinished threads
  — and injects it before the recent verbatim history. Previously those older
  messages were silently truncated. The recap is one cheap LLM call, made only
  on overflow and cached per session. Opt out with
  `autoSummarizeHistory: false` (falls back to plain truncation, no extra call).

## [2.1.3] — 2026-05-22

> Security hardening: project hooks now require trust before they run, the web-fetch tool blocks internal/metadata addresses, and usage stats are sent with your sync token.

### Security

- **Hooks now require trust-on-first-use.** Project-local `.codeep/hooks/*` run
  arbitrary shell, so a freshly-cloned repo could previously execute its scripts
  on your first tool call. Hooks in an unapproved workspace are now **skipped**
  until you run `/hooks trust` (revoke with `/hooks untrust`). `/hooks` and the
  welcome banner show the trust state. Your own already-set-up projects just need
  a one-time `/hooks trust`.
- **SSRF guard on the `fetch_url` web tool.** The agent can no longer be steered
  (e.g. via prompt injection) into fetching `localhost`, private/RFC1918, or
  link-local addresses — including the cloud metadata endpoint
  `169.254.169.254`. Only `http`/`https` are allowed, on the initial request and
  redirects. Your configured provider endpoints (Ollama, custom vLLM/Tailscale)
  are unaffected — they don't go through this tool.

### Changed

- **Stats reporting now sends the `x-sync-token` header.** The dashboard derives
  your GitHub id from the token instead of trusting the `githubId` in the request
  body, closing a spoofing gap where anyone could forge usage events (or unarchive
  projects) for another user. Stats keep working on older CLIs — they're just
  recorded anonymously until you upgrade. No behavior change for you locally.

## [2.1.2] — 2026-05-21

> ACP server enhancements that power the new Codeep VS Code 2.2 features — editor clients can now list models per provider and pin a provider, model, or custom endpoint over the protocol.

### Added

- **`session/list_providers` now returns model metadata** — each provider
  carries its `models` (id + name), `defaultModel`, and a `dynamicModels`
  flag. Lets ACP clients (the VS Code model picker, Zed) build a provider →
  model selector without hardcoding a catalog. Backward-compatible: older
  clients ignore the extra fields.
- **New `session/set_config_option` ids: `provider` and `customBaseUrl`.**
  `provider` switches the active provider (and picks its default model +
  protocol); `customBaseUrl` sets the base URL for the `custom`
  (OpenAI-compatible) provider. These let editor settings drive provider /
  model / endpoint without hand-editing `~/.codeep/config.json`.

### Notes

- Pure additive ACP surface — no behavior change for the TUI or existing
  clients. The Codeep VS Code extension 2.2.0 builds on these.

## [2.1.1] — 2026-05-20

> Codeep now works with any OpenAI-compatible endpoint — vLLM, LiteLLM, LM Studio, text-generation-webui. New "Custom (OpenAI-compatible)" provider with a configurable base URL, plus support for the standard OPENAI_BASE_URL env var. Fixes #1.

### Added

- **Custom (OpenAI-compatible) provider.** Point Codeep at any self-hosted
  or proxied OpenAI-compatible server (vLLM, LiteLLM, LM Studio,
  text-generation-webui). Pick **Custom (OpenAI-compatible)** in the welcome
  flow or `/provider`, set the endpoint under `/settings` → **Custom Base URL**
  (config key `customBaseUrl`, e.g. `http://host:8000/v1`), then choose your
  model with `/model` (fetched live from the server's `/models` endpoint).
  No API key required; set one only if your endpoint enforces it.
- **`OPENAI_BASE_URL` env var.** The `openai` provider now honors
  `OPENAI_BASE_URL` (OpenAI-SDK convention), so an OpenAI-compatible proxy
  serving `gpt-*` model names works with zero config changes.

### Fixed

- Custom base URLs were silently ignored for every provider except Ollama —
  requests always went to `api.openai.com`, and an unknown model fell back to
  the default. Base-URL resolution is now centralized (`resolveBaseUrl`) and
  applied consistently across every path — chat, agent (TUI + ACP/editor),
  `/plan` task planning, and API-key validation. (#1)
- Welcome flow no longer forces an API-key prompt for keyless providers
  (Ollama, Custom) — selecting one proceeds straight into the app.
- Test isolation: `customCommands` tests now run against an isolated HOME so a
  developer's global `~/.codeep/commands` can't make the suite non-deterministic.

## [2.1.0] — 2026-05-19

> Session memory: `/recall <query>` searches across **all** your saved sessions, `--resume` jumps straight back into the best match, `--summarize` asks the LLM what you accomplished, and sessions now get readable AI-generated titles instead of truncated first messages.

### Added — `/recall` cross-session search

- **`/recall <query>`** scans every saved session in the active scope
  (project `.codeep/sessions/` when in a project, else global
  `~/.codeep/sessions/`), matches with AND semantics (every query term
  must appear), and ranks results by term-hit count plus a recency
  boost. Each result shows a context snippet and the session name.
- **`/recall <query> --resume`** loads the top-matching session
  directly into the current conversation — skips the list + `/sessions`
  picker dance. (TUI only; ACP shows results since it can't swap the
  client's conversation in place.)
- **`/recall <query> --summarize`** reads the matching sessions and
  returns a short LLM recap of what you actually accomplished across
  them — "ask your history a question". Works in TUI + ACP.
- No new dependency: in-memory JSON scan, fast for the realistic
  tens-to-hundreds-of-sessions case.

### Added — portable personal config sync

- **Personalities and custom commands now sync across your machines**
  via `codeep account sync` (pull) and `codeep account push`. Global
  ones (`~/.codeep/personalities/*.md`, `~/.codeep/commands/*.md`)
  travel with your account alongside API keys and profiles — set up a
  `senior-reviewer` personality or a `/deploy` command once, get it
  everywhere. New endpoints `/api/personalities` + `/api/commands`,
  new DB tables `user_personalities` + `user_commands`.
- **Additive merge, never destructive**: pull only writes files that
  don't already exist locally, so a sync can't clobber edits you
  haven't pushed. Last-write-wins on the server via upsert.
- **Dashboard sections** to view + delete synced personalities and
  commands at codeep.dev/dashboard (read + prune; editing stays in the
  CLI).
- **Deliberately not synced**: lifecycle hooks (arbitrary shell —
  syncing + auto-running on another machine is a security risk) and
  MCP server configs (contain tokens). Those stay local by design.

### Added — AI-generated session titles

- Sessions now get a concise LLM-generated title ("OAuth2 migration
  for auth module") instead of the first user message truncated to 60
  chars ("help me with the…"). Generated once per session in the
  background after it has ≥3 messages — fire-and-forget on autosave,
  never blocks a save, never regenerates once set. Makes both
  `/sessions` and `/recall` dramatically more readable.
- Title priority: AI title > stored title > first-message fallback >
  session name. Stored under `aiTitle` in the session JSON.
- **Opt-out: `autoSessionTitle` setting** (default on). This is the
  only feature that makes a background API call you didn't explicitly
  request, so it's toggleable in `/settings` for privacy/cost-conscious
  users. Off → sessions keep the first-message title, zero background
  calls.

### Changed

- **`/search` description clarified** to "search the current session"
  (vs `/recall` for cross-session) — the two were easy to confuse when
  both said "search history".

### Fixed

- **`/sessions` picker showed raw session ids** (`session-2026-05-20-757cbda5`)
  instead of readable titles. Now shows the title (AI-generated > stored
  > first-message) with a short date + message count, so the list is
  scannable.
- **Models hallucinating their identity in chat mode.** Asked "which
  model are you", GLM (and others) would claim to be Claude because the
  chat system prompt never stated the actual identity. Both the chat
  and agent system prompts now inject the real `model` + `provider`
  from config, so the answer is truthful. (Agent mode already said
  "never call yourself Claude" but didn't state the real model; now it
  does.)

## [2.0.4] — 2026-05-19

> Discoverability patch: new `/docs <command>` jumps from any slash command to its full guide on codeep.dev, the `/help` footer now points at the same place, and `/personality` and `/insights` have proper docs pages instead of one-liners.

### Added

- **`/docs <command>`** — opens the per-command guide for any 2.0
  feature in your default browser. Knows 17 commands directly
  (`personality`, `insights`, `plan`, `go`, `mcp`, `skills`,
  `checkpoint`, `rewind`, `hooks`, `commands`, `openrouter`, `memory`,
  `profile`, `compact`, `cost`, …); falls back to a marketplace search
  on `/docs/commands?q=<cmd>` for unknown ones. Plain `/docs` opens
  the docs index. Closes the gap between brief slash-command
  autocomplete and the actual reference material.
- **`/help` footer hint.** Below the scroll line: `Full guides →
  codeep.dev/docs · /docs <command>`. Users skimming the inline help
  now know there's a deeper layer one keystroke away.

### Improved — web docs

- **`/personality` guide** went from a 2-row table to a full reference:
  3-column "when to use / what it changes" table for all 6 presets,
  basic-flow terminal demo, end-to-end "combo with plan mode" example
  (security-paranoid OAuth callback), custom personalities section
  with full Acme Corp template, scope override rules, where-it-works
  matrix, and a warning callout about chat() path behaviour.
- **`/insights` guide** got similar treatment: source-of-truth JSON
  shape from `~/.codeep/history/<id>.json`, what-you-see breakdown
  per section, flags table, realistic terminal demo, and a tip
  pointing at the dashboard for historical cost.

### Notes

- No agent behaviour or API changes — this is purely discoverability
  and documentation. Safe to skip if you already know the surface area,
  worthwhile if you've been wondering "what else is in here".

## [2.0.3] — 2026-05-19

> Two Hermes-inspired additions: `/personality <name>` switches agent tone mid-conversation (concise, security-paranoid, senior-reviewer, junior-mentor, ship-it, verbose, or your own from `.codeep/personalities/*.md`), and `/insights [--days N]` summarises what you've been working on — runs, files, tools, projects.

### Added — `/personality` slash command

- **Six built-in personalities** that swap the agent's tone and
  priorities by appending a system-prompt addendum:
  - `concise` — no preamble, no filler, bullet-heavy
  - `verbose` — explains rationale + alternatives + caveats
  - `security` — treats every input as hostile, enumerates attack surface
  - `senior-reviewer` — pushes back on shortcuts, names things well
  - `junior-mentor` — explains as it goes, links to canonical docs
  - `ship-it` — picks first reasonable approach, defers cleanup
- **Custom personalities** via `.codeep/personalities/<name>.md`
  (project) or `~/.codeep/personalities/<name>.md` (global). First
  `# Personality: Name` line becomes the display name; rest of the
  Markdown body is the prompt addendum. Capped at 64 KB per file.
- **Persistence**: active personality lives in `config.activePersonality`
  so it survives session restarts. Clear with `/personality off`.
- Usable from CLI TUI, Zed, and the VS Code extension via ACP.

### Added — `/insights [--days N]`

- **Activity summary** over a configurable window (default 7 days,
  capped at 365). Reads `~/.codeep/history/<id>.json` files written by
  every agent run, so output reflects actual tool actions rather than
  chat-message proxies.
- Headline metrics: total runs, total tool actions, total active time,
  active-days density, average actions per run.
- **By-project breakdown** sorted by active time — see which repo soaked
  up your week.
- **Top tools** (read_file × 340, write_file × 80, …) and
  **most-touched files** (with `~` prefix for readability).
- **Recent runs** list — 10 most recent with project, duration, and the
  user prompt that started them.
- Per-session cost still lives in `/cost`; `/insights` is a deliberately
  history-only view (the in-memory token tracker doesn't survive a
  restart, so historical cost would be misleading).

### Surfaced

- Both commands appear in `/help`, `/` autocomplete, `Codeep-web`
  `/docs/commands`, VS Code Settings → Commands chips, and ACP
  `availableCommands`. Spot-check parity: typing `/per` or `/insi` in
  any client autocompletes to the right command.

## [2.0.2] — 2026-05-19

> Two big quality-of-life additions: Anthropic prompt caching is on by default (60–90% cheaper on cache-eligible input), and `/plan` lets you preview an agent's full plan before any file gets touched. Run `/go` to execute, or `/plan <revised task>` to refine.

### Added — Anthropic prompt caching, automatic

- **Two cache breakpoints per request**: the system prompt (and embedded
  skills catalog / project intelligence) and the tools array. Cache hits
  bill at 0.1× the input rate; cache writes at 1.25×. Net win after the
  second same-shape request, which is every iteration in an agent loop.
  Below 1024 input tokens Anthropic silently skips caching — no error
  path. Applies to the agent chat path, the agent fallback path, and
  the chat() path used by `/agent` and inline replies. Also propagates
  through OpenRouter → Anthropic routes (caching headers honoured
  upstream).
- **`TokenUsage.cacheCreationTokens` + `cacheReadTokens`** fields
  surfaced on every record. `getCacheStats()` aggregates per-session
  cache hits, misses, and estimated USD savings vs running without
  caching. `/cost` (and `/stats`) renders a new "Prompt caching"
  section when at least one cached call landed.

### Added — Plan mode (`/plan` + `/go`)

- **`/plan <task>`** — generates a numbered plan for the task (no tool
  calls, no file changes), surfaces it as a Markdown message so you can
  review what the agent would do, which files it would touch, what
  commands it would run, and the risk level it self-assesses. Holds
  the (task, plan) pair as the *pending* plan, scoped to the current
  process. Re-running `/plan <revised task>` replaces the pending plan
  with a new one (you pay one extra LLM call but get readable revision
  history in the chat).
- **`/go`** — executes the pending plan: hands the task + approved plan
  as a single prompt to the regular agent loop, so all MCP tools,
  lifecycle hooks, verification, permissions, and skill bundles apply
  unchanged. Includes an explicit anti-improvisation clause in the
  injected prompt — if any step turns out to be wrong mid-execution
  the agent must stop and report rather than silently rewriting the
  plan.
- Available in **both the TUI and ACP clients** (Zed, VS Code). ACP
  `/plan` streams the plan back via `session/update`; ACP `/go` runs
  the agent inline and streams iterations through onChunk.
- Surfaced in `/help` ("Agent Mode" section) and `/` autocomplete.

### Fixed

- **Anthropic streaming usage extraction missed cache fields.** Both
  the agent stream handler (`utils/agentStream.ts`) and the chat
  stream handler (`api/index.ts`) now pick up
  `cache_creation_input_tokens` and `cache_read_input_tokens` from the
  `message_start` event, so cached requests no longer undercount
  prompt tokens or display $0 savings.

### Notes

- OpenAI-format providers (OpenAI direct, Z.AI, DeepSeek, MiniMax,
  Ollama) don't expose explicit cache markers — those providers
  generally apply automatic prefix caching server-side. No code change
  on our end needed; cost reports stay accurate via standard
  `prompt_tokens` accounting.

## [2.0.1] — 2026-05-18

> Patch: `/mcp` now works in the CLI TUI (was only wired into the ACP path
> in 2.0.0, so Zed and VS Code worked but `codeep` direct didn't). Full
> subcommand parity — browse, install, add, remove, reload, resources,
> read, prompts, prompt.

### Fixed

- **`/mcp` slash command in CLI TUI returned `Unknown command: /mcp`.**
  The 2.0.0 implementation lived only in `src/acp/commands.ts`, so it
  worked for ACP clients (Zed, VS Code extension) but TUI users hit the
  unknown-command path. Ported the full handler to
  `src/renderer/commands.ts` with TUI-appropriate output (uses the fixed
  `codeep-tui` session id and `ctx.projectPath` as workspace root).
  Subcommands now usable from the TUI: `/mcp`, `/mcp browse [id]`,
  `/mcp install <id> [args...]`, `/mcp add <name> <command> [args...]`,
  `/mcp remove <name>`, `/mcp reload`, `/mcp resources`,
  `/mcp read <uri>`, `/mcp prompts`, `/mcp prompt <server> <name> [k=v]`.
- **Eight 2.0 commands missing from `/` autocomplete and `/help`** —
  `/mcp`, `/compact`, `/checkpoint`, `/checkpoints`, `/rewind`, `/hooks`,
  `/openrouter`, `/commands` were all implemented but invisible to
  discovery. Added to `App.COMMANDS` + `COMMAND_DESCRIPTIONS` so they
  appear when the user types `/`, and added two new `/help` sections
  ("Checkpoints (2.0)", "Extensions & MCP (2.0)") plus `/compact`
  under Sessions and `/openrouter` under Settings.
- **`/skills publish` rejected global bundles.** The helper required
  `bundle.scope === 'project'`, blocking a common case: user writes a
  cross-project skill once in `~/.codeep/skills/<name>/` and tries to
  share it. The `--public` flag is the user's explicit consent gate,
  so an extra scope check is redundant gatekeeping. Now publishes
  project OR global bundles; project wins on slug collision (mirrors
  `loadSkillBundles`). Error message also clarifies *both* lookup
  paths when the slug isn't found anywhere.

## [2.0.0] — 2026-05-18

> Codeep 2.0 is here. Full MCP support (stdio + HTTP), skill bundles with a public marketplace, OpenRouter with accurate per-call cost, checkpoints, custom commands, lifecycle hooks. 921 tests green.

Big release. Major version bump because the on-disk `mcp_servers.json`
shape now accepts `url` (HTTP transport) alongside `command` (stdio),
because the agent now actively reads from MCP servers' `resources`,
`prompts`, and (optionally) hosts `sampling` for them — clients that
relied on Codeep behaving as a tools-only client will see new traffic
— and because **skill bundles** are a new top-level concept the agent
auto-discovers and invokes.

### Added — OpenRouter provider (100+ models via one key)

- **`openrouter` provider** wired through the existing OpenAI-compatible
  flow. Top 12 popular models hardcoded for the picker; the full
  catalogue (100+) is fetched on demand via `/model`, with live pricing
  per 1M tokens and context-window size shown per row.
- **Authoritative cost from `usage.cost`.** OpenRouter returns the
  per-call USD figure in its response — we use that instead of our
  local pricing table, so your dashboard / `/cost` numbers match the
  OpenRouter invoice exactly with zero local maintenance.
- **Branding headers** (`HTTP-Referer: https://codeep.dev`,
  `X-Title: Codeep`) sent on every OpenRouter request — surfaces
  Codeep traffic in their dashboard for attribution.
- **`/openrouter` slash command** for routing preferences:
  `prefer <p1>,<p2>` (provider order), `ignore <p1>` (block list),
  `fallbacks on|off`, `privacy strict|allow` (sets `data_collection`),
  `clear`. Stored per-machine in conf.
- **`openrouter/auto` support** — set the model id to `openrouter/auto`
  and OpenRouter picks the best upstream for each task. Combine with
  `/openrouter prefer` to bias the auto-router without locking it down.

### Added — Skill bundles (Claude Code-compatible)

- **Structured skill bundles** under `.codeep/skills/<name>/SKILL.md`
  (project) and `~/.codeep/skills/<name>/SKILL.md` (global). The
  SKILL.md format is a **superset of Claude Code skills** — paste an
  existing skill verbatim and it works. Codeep-specific extensions
  (`codeep-min-version`, `codeep-requires-mcp`) are valid YAML, so
  Claude Code parsers tolerate them.
- **Agent auto-discovery.** Every agent run injects the bundle catalog
  into the system prompt and registers a virtual `invoke_skill` tool.
  The model picks a skill when the user's intent matches; we return
  the SKILL.md body for it to follow step by step.
- **Slash commands** for managing bundles:
  - `/skills bundles` — list installed
  - `/skills create-bundle <name>` — scaffold a project skill
  - `/skills show <name>` — print the SKILL.md
  - `/skills browse [query]` — search the public marketplace
  - `/skills install <owner>/<slug>` — pull from marketplace
  - `/skills publish <slug> [--public]` — share to codeep.dev
  - `/skills unpublish <owner>/<slug>` — remove your published skill
- **Public marketplace** at [codeep.dev/skills](https://codeep.dev/skills).
  Owners manage their published skills at `/dashboard/skills` —
  toggle visibility, unpublish, see install counts.
- **VS Code commands** for the bundle workflow: `Codeep: Browse Skill
  Bundles…`, `Codeep: Create Skill Bundle…`, `Codeep: Open Skills
  Folder`.
- **Welcome banner warning** when a workspace ships project-scoped
  skill bundles — informed consent before the agent starts invoking
  unfamiliar capabilities.

### Added — MCP gets full spec coverage

- **Streamable HTTP transport.** MCP servers configured with `url` (and
  optional `headers`) are reached over the spec's HTTP+SSE flow instead
  of stdio. POST for requests, GET-side SSE for server-pushed
  notifications and server-initiated requests. Mutually exclusive with
  `command` — pick one per server.
- **Sampling capability.** When a server opts into `sampling`, it can
  ask Codeep to generate a completion on its behalf; we bridge to the
  active provider via `chat()`. Server gets just the assistant text;
  no tool use is forwarded.
- **Resources & prompts auto-injected into the agent's tool catalog.**
  Each server that exposes resources or prompts gets four virtual tools
  the model can call natively: `<server>__resource_list`,
  `<server>__resource_read`, `<server>__prompt_list`,
  `<server>__prompt_get`. No more "user types `/mcp read <uri>`
  manually". Servers that don't expose either get nothing extra.
- **Mid-run tool catalog refresh.** A `tools/list_changed` notification
  (or a successful auto-restart) flips a dirty bit; the agent re-fetches
  the catalog at the start of the next iteration so the model sees new
  tools without a session restart.
- **MCP marketplace.** `/mcp browse` shows a curated catalog of popular
  servers (filesystem, github, postgres, slack, brave-search, …);
  `/mcp install <id> [extra args]` writes the config + spawns. Each
  entry surfaces env-var and arg hints so the user knows what to set.
- **`roots` + `roots/list` capability negotiation.** Codeep advertises
  `roots: { listChanged: true }` in `initialize` and handles
  `roots/list` requests by returning the current workspace folder —
  filesystem-shaped servers can scope reads accordingly.

### Added — TUI polish

- **Type-to-filter in every menu picker.** `/model`, `/provider`,
  `/login`, `/lang`, sessions, export, logout — start typing and the
  list narrows by key / label / description. Backspace edits, first
  Esc clears the filter, second Esc closes. Critical for the
  OpenRouter 100+ model catalogue but useful everywhere.
- **First-run provider picker reordered.** Anthropic, OpenAI,
  OpenRouter, Z.AI sit at the top instead of being buried under
  regional / parameter-variant entries. Each row now shows the short
  provider description ("Unified access to 100+ models via one API
  key") so the value prop is visible at a glance.

### Added — earlier in the 2.0 cycle (already in dev builds)

- **`/cost`**, **`/compact [keepN]`**, **`/commands`**, **`/checkpoint
  [name]`**, **`/checkpoints`**, **`/rewind <id>`**, **`/hooks`**,
  **`/mcp`** slash commands.
- **Custom slash commands.** `.codeep/commands/<name>.md` Markdown
  templates with `{{args}}` / `$ARGUMENTS` / `{{argN}}` placeholders.
  Project files shadow global. Warning banner on first session.
- **Lifecycle hooks.** `.codeep/hooks/<event>.sh` shell scripts run on
  `pre_tool_call`, `post_edit`, `on_error`, `pre_commit`. Apply
  uniformly to built-in and MCP tools.
- **`/memory`** and **`/profile`** now work in ACP (Zed / VS Code), not
  just the TUI.
- **ACP `fs/read_text_file` and `fs/write_text_file` delegation** —
  agent tool calls route through the client when capability is
  advertised, with a 100 KB size cap on delegated reads.
- **ACP `authMethods`** — single `Codeep CLI` agent-type entry for
  acp-registry compliance + `authenticate` no-op handler.
- **Auto-reconnect on MCP server crash** (3× in 60s with exponential
  backoff). Persistent failures surface in `/mcp` instead of being
  silently dropped.
- **VS Code 0.2.0:**
  - Native `vscode.diff` viewer for proposed edits + Accept/Reject
    CodeLens (closes diff tab → implicit reject).
  - `Cmd+Shift+A` Attach Active File.
  - `@symbol` mentions alongside `@file`.
  - MCP server management from the command palette (Add / Remove /
    Open Config).
  - Auto-loads `~/.codeep/mcp_servers.json` and project equivalent.
  - Permission labels honest about scope ("Allow for this session").

### Fixed

- `/provider` was not in `AVAILABLE_COMMANDS` — invisible to Zed / VS
  Code `/` autocomplete.
- `/apikey` and `/login` warn that inline keys leak into shell history.
- `write_file` double-recorded itself in the action log when client-side
  delegation failed and we fell through to disk.
- Delegated `fs/read_text_file` had no size cap; a misbehaving client
  could return a multi-GB blob and OOM the agent.
- `compactHistory()` had no timeout — a hung provider would wedge the
  session. Now caps at 60 s with an external `abortSignal` honoured.
- Diff editor occasionally stayed orphaned in VS Code if the user
  responded faster than the open completed.
- MCP tool name normalization stripped hyphens, so servers named with a
  `-` couldn't route their tool calls (`my-fs__read_file` ≠
  `my_fs__read_file`).

### Removed

- 19 obsolete model entries in `tokenTracker.ts` (gpt-4.1*, o3,
  o4-mini, gpt-4o, claude-mythos-preview, claude-sonnet-4-5-20250929,
  gemini-2.5-*, gemini-3.1-flash-lite-preview, MiniMax-M2.5*,
  MiniMax-M2.1*, MiniMax-M2) — continuation of the 1.3.42 cleanup.

### Security

- **MCP `sampling/createMessage` now rate-limited and budget-capped per
  server** (≥1 s spacing, 100 requests / process). Each accepted request
  is logged to stderr with the originating server name. Closes the path
  by which a misbehaving or malicious MCP server could drain a user's
  paid-provider credits.
- `npm audit fix` resolved `fast-uri` (path traversal / host confusion)
  and `picomatch` (ReDoS / method injection) high-severity CVEs in
  transitive dependencies.

### Packaging

- npm tarball reduced from **164.8 MB → 340 kB** (unpacked 436 MB → 1.4 MB)
  by excluding `dist/zed/*` and `bin/codeep-*` pkg-built standalone
  binaries from the `files` field. Those binaries continue to ship via
  GitHub releases and the Zed extension distribution.

### Breaking changes

- `McpServer` in the protocol now has `command?` and `args?` (was
  required), plus new `url?` and `headers?`. ACP clients that produced
  the old shape still work — fields are optional, parser accepts both.
- MCP client protocol version bumped from `1.4.0` to `2.0.0` in
  `initialize`'s `clientInfo`. Servers that key off the version string
  may need an allowlist update.

## [1.3.42] — 2026-05-12

### Fixed
- **Default model `glm-4.7` did not exist in the Z.AI catalogue.**
  `src/config/index.ts` shipped with `model: 'glm-4.7'` as the
  cold-start default for the `z.ai` provider, but `src/config/providers.ts`
  only advertises `glm-5.1`, `glm-5-turbo`, and `glm-5`. Fresh installs
  therefore booted with a model id that wasn't in any picker — the
  first send had to be preceded by a manual model switch, and any
  client (Mac / iOS / web dashboard) reading the config saw an unknown
  model. Default is now `glm-5.1`, matching what `providers.ts` lists
  as the Z.AI default.
- `config.test.ts` updated to the new default so the validation
  test stays in sync.

### Removed
- **Obsolete Z.AI model entries in `tokenTracker.ts`.** Pricing and
  context-window rows for `glm-4.7-flash` and `glm-4.5-air` were
  never reachable through the provider catalogue (`providers.ts`
  retired both during the GLM-5 rebrand). They only produced phantom
  cost estimates if a user typed those ids in by hand. Dropping them
  keeps the tracker's tables in lockstep with the canonical provider
  list.

## [1.3.41] — 2026-05-10

### Fixed
- **Slash commands (`/`) still showed "Available commands: none" in Zed
  after v1.3.40.** The earlier patch (removing the spec-extension
  `session_info_update` notification and re-emitting commands on every
  prompt) was insufficient — the actual root cause is a **race in Zed**:
  it processes `AvailableCommandsUpdated` events synchronously and silently
  drops them if the session's `thread_view` isn't registered yet. Codeep
  was sending the notification ~1 ms after the `session/new` response —
  well inside Zed's setup window — so the agent's command list never
  reached the slash autocomplete and `/help` was rejected as unsupported.
  Confirmed by reading Zed source (`crates/agent_ui` + `crates/agent`)
  and reproduced via the new `CODEEP_ACP_DEBUG` log. Codeep now sends
  `available_commands_update` with a configurable delay (200 ms by
  default, override via `CODEEP_ACP_COMMANDS_DELAY_MS`) on `session/new`,
  `session/load`, and `session/resume` — well outside the race window.

## [1.3.40] — 2026-05-10

### Fixed
- **First attempt at fixing slash commands in Zed.** Removed a
  `session_info_update` notification that was emitted between the
  `session/new` response and `available_commands_update`, on the suspicion
  that it was poisoning Zed's deserializer. Turned out the variant was
  actually spec-valid (`SessionInfoUpdate` exists in `agent-client-protocol`
  v0.11+) and the real fix needed was in v1.3.41. Also added the
  resilience pass: `available_commands_update` is re-emitted at the start
  of every `session/prompt` turn.

### Added
- **`CODEEP_ACP_DEBUG` env var** for ACP debugging — when set, every inbound
  and outbound JSON-RPC frame is appended to
  `~/.cache/codeep/acp-debug.log` (override path via
  `CODEEP_ACP_DEBUG_FILE`). Writes go to a file rather than stderr because
  most ACP clients (Zed included) don't pipe agent stderr anywhere readable.
  This is what let us confirm the v1.3.41 fix.

## [1.3.39] — 2026-05-06

### Added
- **CLI sessions surfaced in Zed welcome message** — when you open a chat in
  Zed, Codeep now lists the most recent saved sessions for that workspace
  with one-line load instructions. Solves the discoverability gap where
  users couldn't find their CLI sessions in Zed's sidebar (Zed only lists
  sessions it created itself; CLI ones live in the hidden "Import Threads"
  modal).
- **README "Loading CLI sessions in Zed" section** documenting both the
  in-chat (`/sessions`, `/session load <name>`) and the import-modal paths.

### Fixed
- **`available_commands_update` not sent on `session/load` and `session/resume`**
  — the slash command popup (`/`) stayed empty after a panel reload because
  Zed registers commands only when the agent emits the notification. Codeep
  was emitting it only on `session/new`. Now also sent on load and resume.

### Internal
- Added `npm run release` wrapper script — single command bumps version,
  verifies CHANGELOG section, runs tests, commits, tags, and pushes. See
  `scripts/release.js`.

## [1.3.38] — 2026-05-05

### Added
- **`promptCapabilities.embeddedContext`** — dragging a file into the Zed chat
  (or pinning a code selection) now actually injects the file content into the
  prompt. Previously the `resource_link` / `resource` blocks were silently
  dropped. 200 KB cap per resource with a visible truncation marker.
- **`session/resume` ACP method** — lightweight reconnect on panel reload.
  The client keeps history locally and only re-wires the in-memory session
  (modes + config), avoiding a full history replay. Advertised via
  `sessionCapabilities.resume`.
- **Dashboard sync after every manual chat** in the CLI — previously only
  the agent-mode and graceful-shutdown paths reported to `codeep.dev`, so
  Agent Mode: OFF looked like it never synced.

### Changed
- **ACP boolean dropdown labels** in the Zed agent settings panel now include
  the action prefix (`Confirm delete: ON`, `Confirm exec: ON`,
  `Confirm write: ON`) so the three toggles are distinguishable. Previously
  Zed rendered all three identically as `ON`.

### Fixed
- **`terminal/wait_for_exit`** — was calling the camelCase `terminal/waitForExit`
  variant; corrected to the spec snake_case name. Also dropped the non-standard
  `timeoutMs` parameter.
- **Removed `terminal: true` from `agentCapabilities`** — `terminal` is a
  *client* capability per the ACP spec, not an agent capability. Codeep now
  reads `clientCapabilities.terminal` from the initialize params and routes
  `execute_command` through the editor's terminal only when the client
  supports it (falling back to local execution otherwise).

## [1.3.37] — 2026-04-29

### Changed
- Maintenance release. Republished with the same code as v1.3.36 to align the
  npm version, GitHub binaries, and Homebrew formula across all distribution
  channels. If you're on v1.3.36, no need to upgrade.

## [1.3.36] — 2026-04-28

### Added
- **`session/list_providers` ACP method** — returns the canonical provider
  catalog (`id`, `name`, `groupLabel`, `hint`, `requiresKey`, `subscribeUrl`)
  so ACP clients no longer need to hard-code provider lists. Prerequisite for
  Codeep VS Code extension v0.1.23+, which fetches the catalog dynamically.
- **`groupLabel` and `hint` fields** in `ProviderConfig` (`src/config/providers.ts`)
  for richer client-side rendering of the provider picker.

## [1.3.35] — 2026-04-28

### Added
- **Diff previews on permission prompts** — manual-mode `session/request_permission`
  payloads now include the actual change (`old_string` / `new_string` for
  `edit_file`, full content for `write_file`, command + cwd for `execute_command`).
  Truncated at ~4 KB per field, 200 lines per file. Other ACP clients see the
  extra fields as harmless additional keys.
- **Reasoning stream support** — `agent_thought_chunk` notifications flow
  through to clients that subscribe to them, so models with extended thinking
  (Claude, GPT-5 reasoning, DeepSeek R1, etc.) can surface their reasoning UI.

### Changed
- Input formatting tweaks for clearer user-side verification.
