# Changelog

All notable changes to **Codeep CLI** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [Semantic Versioning](https://semver.org/).

For releases before v1.3.35, see [GitHub Releases](https://github.com/VladoIvankovic/Codeep/releases).

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
