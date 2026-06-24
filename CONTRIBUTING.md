# Contributing to Codeep

Thanks for your interest in contributing to Codeep! This document covers the
practical bits you need to get a change merged: setup, the build/test loop,
code style, and how to propose a change.

Codeep is an autonomous AI coding agent that runs in the terminal and
integrates with editors via the [Agent Client Protocol][acp]. It's written in
TypeScript, built with Node.js, and distributed as an npm package, standalone
binaries, and a Homebrew formula.

[acp]: https://github.com/ZedEditor/agent-client-protocol

## Quick start

```bash
git clone https://github.com/VladoIvankovic/Codeep.git
cd Codeep
npm install
npm test        # 1300+ tests, should be green
npm run build   # tsc + import fixup → dist/
```

You need **Node.js ≥ 20** (see `engines` in `package.json`). The distributed
standalone binaries are produced in CI with `bun build --compile` (see
`.github/workflows/release-binaries.yml`) — there is no local binary build.

### Package manager: npm

**npm is the canonical package manager.** `package-lock.json` is committed;
other lockfiles (`bun.lock`, `yarn.lock`, `pnpm-lock.yaml`) are `.gitignored`.

- Install dependencies: `npm install`
- Install in CI / from a clean checkout: `npm ci` (strictly respects the lockfile)
- Add a dependency: `npm install <pkg>` (updates `package-lock.json` too)

Do **not** introduce a `bun.lock` / `yarn.lock` — the dual-lockfile drift that
prompted the single-manager decision is exactly what we're avoiding.

## The development loop

| Task | Command |
|---|---|
| Run the TUI in development | `npm run dev` |
| Run the test suite once | `npm test` |
| Run tests in watch mode | `npm run test:watch` |
| Run tests with coverage | `npm run test:coverage` |
| Type-check without emitting | `npx tsc --noEmit` |
| Build to `dist/` | `npm run build` |
| Build standalone binaries | _CI only_ — `bun build --compile` (see `release-binaries.yml`) |

### Before opening a PR

1. **`npx tsc --noEmit` is clean** (0 errors). The project uses `strict: true`
   and `"types": ["node"]`; any `Cannot find name 'fs'/'path'/…` error means
   something regressed in the type config.
2. **`npm test` is green.** If you add a feature, add a test — the suite is
   the regression net that lets us refactor aggressively.
3. **`npm run build` succeeds.** The build wipes `dist/` first (`rm -rf dist`)
   so a stale output can't mask a real failure.
4. **No `as any` in new code** without a justifying comment. The settings
   screen, for example, was recently de-`as any`-ed; keep that bar.

### What gets a test

- Pure helpers and data-shaping functions (`toolCallMeta`, `buildRawOutput`,
  registry lookups, formatters) → **always**. Cheap to test, high regression value.
- Filesystem bootstrap and config mutations (`initWorkspace`, checkpoint
  creation, settings writes) → **always**, using an isolated tmpdir per test
  (see `vitest.setup.ts` + the pattern in `checkpoints.test.ts`).
- Agent-loop integration (end-to-end prompt → tool call → response) → covered
  by `toolExecution.test.ts`; don't duplicate that in a new test.
- ACP server request handlers (`session/new`, `session/prompt`, …) → currently
  hard to unit-test because they live inside the `startAcpServer()` closure.
  There's a tracked refactor to extract them into a testable class; until
  then, prefer testing the helpers they delegate to.

## Code style

- **Indentation:** 2 spaces.
- **Functions:** prefer arrow functions; use `function` declarations only for
  hoisted helpers or when you need `this`.
- **TypeScript:** `strict: true`. Avoid `as any`; when a cast is unavoidable
  (e.g. a heterogeneous config write), centralise it in one typed helper and
  document why.
- **Imports:** ESM (`import … from '…'`), not `require()`. Node built-ins
  use the `node:` prefix inside dependencies but plain `'fs'` / `'path'` is
  fine in our own code (the `@types/node` resolution handles both).
- **Comments:** explain *why*, not *what*. The codebase leans heavily on
  inline rationale comments (see `acp/transport.ts` for the house style);
  when you add a non-obvious decision, leave a note for the next reader.
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types
  and interfaces, `UPPER_SNAKE_CASE` for constants.

### Architecture orientation

If you're new to the codebase, read in this order:

1. **`README.md`** — feature tour and the "Architecture" / "Libraries" sections.
2. **`src/renderer/main.ts`** — TUI entry point; the dispatch loop lives here.
3. **`src/renderer/commands/registry.ts`** — the single source of truth for
   slash-command metadata; `App.ts` and `Help.ts` both derive from it.
4. **`src/config/index.ts`** — the on-disk config (`Conf<ConfigSchema>`) and
   every accessor/mutator. `ConfigSchema` is the exported type that other
   modules (e.g. `Settings.ts`) key off.
5. **`src/utils/agent.ts`** — the agent loop: prompt → tool calls → response.
6. **`src/acp/server.ts`** — the ACP adapter that editors (Zed, VS Code) talk
   to over newline-delimited JSON-RPC on stdio.
7. **`CHANGELOG.md`** — recent history; the `[Unreleased]` section lists
   in-flight changes.

## Proposing a change

### Small fixes (typos, bug fixes, small features)

1. Open an issue first if the fix isn't obvious — saves wasted work.
2. Branch from `main`, commit with a clear message
   (`fix: …`, `feat: …`, `docs: …`, `refactor: …`, `test: …`).
3. Open a PR against `main`. CI runs `tsc --noEmit` + the full vitest suite.

### Larger features

1. **Open an issue** describing the problem and the shape of the solution.
   We'll discuss scope before you write code.
2. Add tests as you go — a PR that lands untested code sets a precedent we
   then have to clean up.
3. If your change is user-visible, add a `CHANGELOG.md` entry under
   `[Unreleased]` (see the existing entries for format).

### Provider integrations

Adding support for a new LLM provider is a common contribution. The flow:

1. Add the provider to `src/config/providers.ts` (id, name, models, pricing).
2. Wire its API adapter in `src/api/` (most providers are OpenAI-compatible;
   reuse `openaiCompatible.ts` where possible).
3. Add the env-var name and any auth quirks to the provider definition.
4. Test the chat path against a real key if you can; otherwise document the
   expected request/response shape and mark it `[needs testing]` in the PR.

## Releasing

Releases are tag-driven: pushing a `v*` tag triggers
`.github/workflows/release-binaries.yml`, which builds cross-platform
binaries, publishes to npm, and bumps the Homebrew formula. **You don't need
to run a release to contribute** — this is here for context.

Before tagging a release:

1. Bump `version` in `package.json`.
2. Move `[Unreleased]` → `[ vX.Y.Z — date ]` in `CHANGELOG.md`.
3. Ensure `npm test`, `npx tsc --noEmit`, and `npm run build` are all clean.

## License

By contributing, you agree that your contributions are licensed under the
[Apache 2.0 License](./LICENSE) that covers the project.
