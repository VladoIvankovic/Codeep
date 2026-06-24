# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately using one of these channels:

- **GitHub Security Advisories** (preferred): go to the
  [Security tab](https://github.com/VladoIvankovic/Codeep/security/advisories/new)
  and create a private advisory. This lets us collaborate on a fix before
  disclosure.
- **Email**: [vlado@codeep.dev](mailto:vlado@codeep.dev) with `[security]` in
  the subject line.

Include as much of the following as you can:

- A description of the issue and its potential impact.
- Steps to reproduce (a minimal repro is ideal).
- The affected version(s) — run `/version` inside Codeep or check
  `package.json`.
- Any suggested mitigations or fixes.

You should receive an acknowledgement within **72 hours**. If a fix is
agreed, we'll coordinate a disclosure timeline with you (default: fix-first,
then publish a GitHub Security Advisory with credit).

## Scope

Codeep is an autonomous AI agent that can read and modify files, run shell
commands, and make network requests on the user's behalf. Security issues
that fall in scope include, but are not limited to:

- **Prompt injection** that causes the agent to take actions the user did not
  authorise (e.g. a malicious file or web page tricking the agent into
  running a destructive command or exfiltrating data).
- **Permission-bypass** in the `hasWritePermission` / `hasReadPermission`
  gate (a project that should be read-only gaining write access).
- **Hook / custom-command execution** from an untrusted repository without
  explicit user consent (`.codeep/hooks/*.sh`, `.codeep/commands/*.md`).
- **Credential leakage**: API keys, session tokens, or profile data reaching
  an unintended destination (logs, telemetry, a prompt to the wrong model).
- **Supply-chain issues** in the dependency tree that could lead to any of
  the above.

The following are **out of scope** for this policy:

- An LLM provider's own behaviour (rate limits, content policy, model
  hallucinations). Report those to the provider.
- Anything that requires the user to intentionally run `codeep` as root, or
  to point Codeep at a filesystem path they don't control.
- Social engineering of the maintainer.

## Hardening features already in place

These exist to reduce the attack surface; please don't regress them without
discussion:

- **Project permissions** (`config.projectPermissions`): workspaces are
  read-only by default until the user grants write access (`/grant`).
- **Agent confirmation modes** (`always` / `dangerous` / `never`): the
  `dangerous` default asks before destructive tools (`delete_file`,
  `execute_command`, optionally `write_file` / `edit_file`).
- **Hook trust gate**: lifecycle hooks in `.codeep/hooks/` do **not** run
  until the user runs `/hooks trust` for that workspace. The ACP welcome
  banner flags any hooks or custom slash commands a workspace ships so the
  user sees them before invoking the agent.
- **Secure key storage**: provider API keys live in the OS keychain
  (`utils/keychain.ts`) rather than plaintext on disk. Plaintext fallback
  exists only when the keychain is unavailable and is swept into it on the
  next launch.
- **Telemetry opt-in/out**: `telemetry` defaults to on but can be disabled
  (`/telemetry off`) or forced off via `CODEEP_NO_TELEMETRY` / `DO_NOT_TRACK`
  env vars. API-key sync to codeep.dev is **off by default**.
- **`npm audit`** runs as part of routine maintenance; high-severity
  advisories are patched or documented here before the next release.

## Disclosure policy

1. We acknowledge the report and confirm the issue (or explain why it's out
   of scope).
2. We work on a fix on a private branch.
3. Once a fix is ready, we publish a new release and file a public
   [GitHub Security Advisory][advisories] crediting the reporter (unless they
   prefer to remain anonymous).
4. The `CHANGELOG.md` entry for the release references the advisory.

[advisories]: https://github.com/VladoIvankovic/Codeep/security/advisories
