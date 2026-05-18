# Changelog

All notable changes to **Codeep CLI** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [Semantic Versioning](https://semver.org/).

For releases before v1.3.35, see [GitHub Releases](https://github.com/VladoIvankovic/Codeep/releases).

> **Authoring convention:** put a one-line `> TL;DR` under each
> `## [version]` heading. It's auto-extracted by `codeep.dev/releases/rss.xml`
> as the social-share summary (IFTTT → X/Bluesky), capped at 220 chars.
> If omitted, the feed falls back to the first paragraph.

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
