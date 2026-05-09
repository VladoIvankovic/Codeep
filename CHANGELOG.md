# Changelog

All notable changes to **Codeep CLI** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [Semantic Versioning](https://semver.org/).

For releases before v1.3.35, see [GitHub Releases](https://github.com/VladoIvankovic/Codeep/releases).

## [1.3.40] — 2026-05-10

### Fixed
- **Slash command autocomplete (`/`) sometimes empty in Zed** — Zed registers
  agent commands only when its `thread_view` is fully set up, which can lose
  to the race against the `session/new` response on slow machines or first
  cold-start. Codeep now re-emits `available_commands_update` at the start of
  every `session/prompt` turn as a belt-and-suspenders fallback, so the
  command list is guaranteed to be live by the time the user types their
  next prompt.

### Added
- **`CODEEP_ACP_DEBUG` env var** for ACP debugging — when set (any non-empty
  value), Codeep mirrors every inbound and outbound JSON-RPC frame to stderr
  prefixed with `[ACP←client]` / `[ACP→client]`. Enable in Zed via the agent
  config `env` block; lines show up in **Help → Open Log**. Useful for
  diagnosing client-specific format issues without affecting normal stdio
  protocol traffic.

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
