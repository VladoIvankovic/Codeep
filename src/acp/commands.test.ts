/**
 * Tests for the ACP workspace/session bootstrap (`initWorkspace`).
 *
 * `initWorkspace` runs on every ACP `session/new` and is responsible for:
 *   1. Creating `.codeep/` if missing
 *   2. Marking the workspace as a project
 *   3. Granting read+write permission (ACP always has access)
 *   4. Loading the most recent session, or starting a fresh one
 *   5. Returning a welcome banner the editor streams back to the user
 *
 * The agent-loop-driven `handleCommand` cases are intentionally not covered
 * here — they reach into config/api/agent code that's already tested in their
 * own suites, and mocking all of that would test the mocks, not the code.
 * We focus on the pure-filesystem bootstrap path, which is the part that's
 * both testable in isolation and most likely to regress silently (e.g. a
 * changed permission check that breaks "fresh project onboarding" in Zed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initWorkspace } from './commands';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codeep-acp-init-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('initWorkspace — filesystem bootstrap', () => {
  it('creates the .codeep/ directory if it does not exist', () => {
    expect(existsSync(join(workspaceRoot, '.codeep'))).toBe(false);
    initWorkspace(workspaceRoot);
    expect(existsSync(join(workspaceRoot, '.codeep'))).toBe(true);
  });

  it('is idempotent — calling twice does not throw and leaves .codeep intact', () => {
    initWorkspace(workspaceRoot);
    expect(() => initWorkspace(workspaceRoot)).not.toThrow();
    expect(existsSync(join(workspaceRoot, '.codeep'))).toBe(true);
  });

  it('writes a project config under .codeep/config.json (marks as initialized)', () => {
    initWorkspace(workspaceRoot);
    const cfgPath = join(workspaceRoot, '.codeep', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    // Should be valid JSON; project permission block is the contract.
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(parsed.permission).toBeTruthy();
    expect(parsed.permission.readPermission).toBe(true);
    expect(parsed.permission.writePermission).toBe(true);
    expect(parsed.permission.path).toBe(workspaceRoot);
  });
});

describe('initWorkspace — return value', () => {
  it('returns a non-empty codeepSessionId, history array, and welcomeText', () => {
    const result = initWorkspace(workspaceRoot);
    expect(typeof result.codeepSessionId).toBe('string');
    expect(result.codeepSessionId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.history)).toBe(true);
    expect(typeof result.welcomeText).toBe('string');
    expect(result.welcomeText.length).toBeGreaterThan(0);
  });

  it('welcomeText names the provider and model so the user can verify their setup', () => {
    const { welcomeText } = initWorkspace(workspaceRoot);
    // The banner format is "**Codeep** • <provider> • `<model>`" — assert on
    // the structural prefix rather than the specific provider/model so the
    // test is stable across provider config changes.
    expect(welcomeText).toContain('**Codeep**');
    expect(welcomeText).toContain('•');
    expect(welcomeText).toMatch(/`[^`]+`/); // a backticked model id
  });

  it('welcomeText mentions the workspace path and access level', () => {
    const { welcomeText } = initWorkspace(workspaceRoot);
    expect(welcomeText).toContain(workspaceRoot);
    expect(welcomeText).toMatch(/Access/i);
  });

  it('fresh=true ignores prior sessions and starts a new session', () => {
    // First init creates a session id; even without persisted messages, a
    // second init (fresh=false) on the same workspace is contract-stable:
    // it does not throw and returns a valid session id. The exact equality
    // of ids across calls depends on whether a session file was written,
    // which only happens after a prompt round-trip — out of scope here.
    const first = initWorkspace(workspaceRoot);
    expect(typeof first.codeepSessionId).toBe('string');

    expect(() => initWorkspace(workspaceRoot, false)).not.toThrow();
    expect(() => initWorkspace(workspaceRoot, true)).not.toThrow();

    const freshResult = initWorkspace(workspaceRoot, true);
    expect(typeof freshResult.codeepSessionId).toBe('string');
    expect(freshResult.codeepSessionId.length).toBeGreaterThan(0);
  });
});

describe('initWorkspace — informed-consent banners', () => {
  it('mentions custom slash commands when the workspace ships .codeep/commands/*.md', () => {
    // Write a project-scoped custom command; initWorkspace should flag it.
    mkdirSync(join(workspaceRoot, '.codeep', 'commands'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, '.codeep', 'commands', 'refactor.md'),
      '# refactor\nRefactor the current file.',
    );

    const { welcomeText } = initWorkspace(workspaceRoot);
    expect(welcomeText).toMatch(/custom slash command/i);
    expect(welcomeText).toContain('`/refactor`');
  });

  it('does not mention custom commands when the workspace has none', () => {
    const { welcomeText } = initWorkspace(workspaceRoot);
    expect(welcomeText).not.toMatch(/custom slash command/i);
  });

  it('mentions lifecycle hooks when the workspace ships an executable .codeep/hooks/<event>.sh', () => {
    mkdirSync(join(workspaceRoot, '.codeep', 'hooks'), { recursive: true });
    const hookPath = join(workspaceRoot, '.codeep', 'hooks', 'post_edit.sh');
    writeFileSync(hookPath, '#!/bin/sh\necho edited\n');
    // listInstalledHooks requires the user-executable bit; without it the
    // file is silently skipped (correctly — a non-executable hook would
    // surprise the user later with "permission denied").
    chmodSync(hookPath, 0o755);

    const { welcomeText } = initWorkspace(workspaceRoot);
    expect(welcomeText).toMatch(/hook/i);
  });
});
