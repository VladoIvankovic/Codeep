# Changelog

All notable changes to **Codeep CLI** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [Semantic Versioning](https://semver.org/).

For releases before v1.3.35, see [GitHub Releases](https://github.com/VladoIvankovic/Codeep/releases).

> **Authoring convention:** put a one-line `> TL;DR` under each
> `## [version]` heading. It's auto-extracted by `codeep.dev/releases/rss.xml`
> as the social-share summary (IFTTT → X/Bluesky), capped at 220 chars.
> If omitted, the feed falls back to the first paragraph.

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
