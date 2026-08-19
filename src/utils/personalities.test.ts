import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../config/index.js', () => {
  const data: Record<string, unknown> = {};
  return {
    config: {
      get: (k: string) => data[k],
      set: (k: string, v: unknown) => { data[k] = v; },
    },
  };
});

import {
  loadAllPersonalities,
  findPersonality,
  getActivePersonalityPrompt,
  formatPersonalityList,
  getPersonalityToolAllowlist,
  isPersonalityAvailable,
  isPersonalityToolCallAllowed,
  isPersonalityModelPreferenceValid,
  parsePersonalityMarkdown,
  resolvePersonalityRuntimeModel,
  formatPersonalityActivation,
} from './personalities';
import { config } from '../config/index.js';

describe('personalities', () => {
  beforeEach(() => {
    config.set('activePersonality', null);
  });

  it('exposes six built-in personalities by default', () => {
    const all = loadAllPersonalities();
    const builtinNames = all.filter((p) => p.scope === 'builtin').map((p) => p.name).sort();
    expect(builtinNames).toEqual([
      'concise', 'junior-mentor', 'security', 'senior-reviewer', 'ship-it', 'verbose',
    ]);
  });

  it('findPersonality is case-insensitive', () => {
    expect(findPersonality('CONCISE')?.name).toBe('concise');
    expect(findPersonality('Ship-It')?.name).toBe('ship-it');
    expect(findPersonality('nonsense')).toBeNull();
  });

  it('returns the active personality prompt when set', () => {
    config.set('activePersonality', 'security');
    const prompt = getActivePersonalityPrompt();
    expect(prompt).toContain('Personality: Security-paranoid');
    expect(prompt).toContain('Treat every input as hostile');
  });

  it('returns empty string when no personality is active', () => {
    expect(getActivePersonalityPrompt()).toBe('');
  });

  it('returns empty string when active name does not match any personality', () => {
    config.set('activePersonality', 'phantom-name');
    expect(getActivePersonalityPrompt()).toBe('');
  });

  it('formatPersonalityList shows the active marker and clear hint', () => {
    config.set('activePersonality', 'verbose');
    const out = formatPersonalityList();
    expect(out).toContain('**Active:** `verbose`');
    expect(out).toContain('| `verbose` ✓ |');
    expect(out).toContain('Drop a `<name>.md` file');
  });

  it('formatPersonalityList notes when no personality is active', () => {
    const out = formatPersonalityList();
    expect(out).toMatch(/Active:.*none.*default tone/);
  });

  it('parses custom-bot/v1 frontmatter and structured behavior sections', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
description: Safe releases
model: z.ai/glm-5.3
tools: [files, tests, git]
scope: selected
projects: [Codeep, client-*]
---
# Release Guardian
> Safe releases

## Responsibility
Verify release readiness.

## Response style
Concise

## Always
- Run tests

## Never
- Deploy without approval

## Advanced instructions
Prefer reversible changes.
`, 'release-guardian', 'global');

    expect(personality).toMatchObject({
      name: 'release-guardian',
      displayName: 'Release Guardian',
      description: 'Safe releases',
      structured: true,
      modelPreference: 'z.ai/glm-5.3',
      tools: ['files', 'tests', 'git'],
      restrictTools: true,
      projectScope: 'selected',
      projects: ['Codeep', 'client-*'],
      responsibility: 'Verify release readiness.',
      responseStyle: 'Concise',
      always: ['Run tests'],
      never: ['Deploy without approval'],
    });
    expect(personality.prompt).not.toContain('custom-bot/v1');
    expect(personality.prompt).toContain('Verify release readiness.');
  });

  it('marks an explicit unsupported codeep schema unavailable without legacy reinterpretation', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v2
model: automatic
tools: [files]
scope: all
---
# Future bot

## Responsibility
Do future work.

## Tools
- Terminal
`, 'future-bot', 'global');
    expect(personality.structured).toBe(true);
    expect(personality.schemaValid).toBe(false);
    expect(personality.restrictTools).toBe(true);
    expect(personality.tools).toEqual(['files']);
    expect(isPersonalityAvailable(personality, process.cwd())).toBe(false);

    const wrongCase = parsePersonalityMarkdown(`---
codeep: CUSTOM-BOT/V1
tools: [files]
---
# Wrong case
`, 'wrong-case', 'global');
    expect(wrongCase.schemaValid).toBe(false);
    expect(isPersonalityAvailable(wrongCase, process.cwd())).toBe(false);
  });

  it('falls back to the original web heading format', () => {
    const personality = parsePersonalityMarkdown(`# Reviewer

> Reviews changes

## Responsibility
Review changes safely.

## Model
Automatic

## Tools
- Files
- Web

## Scope
All projects
`, 'reviewer', 'global');
    expect(personality.structured).toBe(true);
    expect(personality.modelPreference).toBe('Automatic');
    expect(personality.tools).toEqual(['files', 'web']);
    expect(personality.projectScope).toBe('all');
    expect(personality.restrictTools).toBe(true);
  });

  it('requires a strong multi-section signature for the old builder format', () => {
    const loneTools = parsePersonalityMarkdown(`# Legacy helper

Use whichever utilities help answer the request.

## Tools
- Explain tools before using them
`, 'legacy-helper', 'global');
    expect(loneTools.structured).toBe(false);
    expect(loneTools.restrictTools).toBe(false);

    const modelToolsScopeProse = parsePersonalityMarkdown(`# Legacy docs

## Model
Describe the application's data model.

## Tools
Describe its developer tools.

## Scope
Describe module scope.
`, 'legacy-docs', 'global');
    expect(modelToolsScopeProse.structured).toBe(false);
    expect(modelToolsScopeProse.restrictTools).toBe(false);

    const responsibilityModel = parsePersonalityMarkdown(`# Builder bot

## Responsibility
Review changes.

## Model
Automatic
`, 'responsibility-model', 'global');
    expect(responsibilityModel.structured).toBe(true);
    expect(responsibilityModel.restrictTools).toBe(false);

    const oldBuilder = parsePersonalityMarkdown(`# Builder bot

## Responsibility

## Tools
- Files
`, 'builder-bot', 'global');
    expect(oldBuilder.structured).toBe(true);
    expect(oldBuilder.restrictTools).toBe(true);
    expect(oldBuilder.tools).toEqual(['files']);
  });

  it('keeps legacy prompt-only personalities unrestricted', () => {
    const personality = parsePersonalityMarkdown('# Friendly\nBe patient and encouraging.', 'friendly', 'global');
    expect(personality.structured).toBe(false);
    expect(personality.restrictTools).toBe(false);
    expect(getPersonalityToolAllowlist(personality)).toBeUndefined();
    expect(isPersonalityToolCallAllowed(personality, { tool: 'future_tool', parameters: {} })).toBe(true);
  });

  it('maps high-level tools to a filtered advertised catalog', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [files, tests, git, web, mcp]
---
# Bot
`, 'bot', 'global');
    const registeredMcp = new Set(['github__issues']);
    const allowlist = getPersonalityToolAllowlist(personality, registeredMcp)!;
    expect(allowlist).toContain('read_file');
    expect(allowlist).toContain('execute_command');
    expect(allowlist).toContain('fetch_url');
    expect(allowlist).toContain('github__issues');
    expect(allowlist).not.toContain('delegate');
    expect(isPersonalityToolCallAllowed(personality, { tool: 'github__issues', parameters: {} }, registeredMcp)).toBe(true);
    expect(isPersonalityToolCallAllowed(personality, { tool: 'unknown__tool', parameters: {} }, registeredMcp)).toBe(false);
    expect(isPersonalityToolCallAllowed(personality, { tool: 'delegate', parameters: { task: 'review' } }, registeredMcp)).toBe(false);
  });

  it('enforces Tests and Git command subtypes without granting a general terminal', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [tests, git]
---
# Checker
`, 'checker', 'global');
    expect(isPersonalityToolCallAllowed(personality, {
      tool: 'execute_command', parameters: { command: 'npm', args: ['test'] },
    })).toBe(true);
    expect(isPersonalityToolCallAllowed(personality, {
      tool: 'execute_command', parameters: { command: 'git', args: ['status'] },
    })).toBe(true);
    expect(isPersonalityToolCallAllowed(personality, {
      tool: 'execute_command', parameters: { command: 'C:\\Program Files\\Git\\bin\\git.exe', args: ['status'] },
    })).toBe(true);
    expect(isPersonalityToolCallAllowed(personality, {
      tool: 'execute_command', parameters: { command: 'npm', args: ['install', 'left-pad'] },
    })).toBe(false);
    expect(isPersonalityToolCallAllowed(personality, {
      tool: 'execute_command', parameters: { command: 'bash', args: ['script.sh'] },
    })).toBe(false);
  });

  it('allows ordinary built-in Git operations for a Git-only bot', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [git]
---
# Release bot
`, 'release-bot', 'global');
    const allowed: Array<[string, string[]]> = [
      ['git', ['--no-pager', 'diff', '--stat']],
      ['git', ['log', '-n', '5']],
      ['git', ['add', 'src/index.ts']],
      ['git', ['commit', '-m', 'Apply safe change']],
      ['git', ['fetch', 'origin']],
      ['git', ['rebase', 'main']],
      ['git', ['merge', '--ff-only', 'main']],
      ['git', ['merge', '--no-edit', 'feature']],
      ['git', ['pull', '--ff-only']],
      ['git', ['revert', '--no-edit', 'HEAD']],
      ['git', ['submodule', 'status', '--recursive']],
      ['git', ['bisect', 'good', 'HEAD']],
    ];
    for (const [command, args] of allowed) {
      expect(isPersonalityToolCallAllowed(personality, {
        tool: 'execute_command', parameters: { command, args },
      }), `${command} ${args.join(' ')}`).toBe(true);
    }
  });

  it('blocks Git command-dispatch escapes and GitHub CLI, including Windows executables', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [git]
---
# Release bot
`, 'release-bot', 'global');
    const denied: Array<[string, string[]]> = [
      ['git', ['-c', 'alias.x=!sh -c "touch /tmp/pwn"', 'x']],
      ['git', ['-calias.x=!cmd.exe /c calc.exe', 'x']],
      ['git', ['--config-env=alias.x=PAYLOAD', 'x']],
      ['git', ['config', 'alias.x', '!sh -c id']],
      ['git', ['x']], // unknown names can dispatch git-x from PATH
      ['git', ['submodule', 'foreach', 'sh', '-c', 'id']],
      ['git', ['difftool', '--extcmd', 'sh -c id']],
      ['git', ['mergetool', '--tool', 'evil']],
      ['git', ['bisect', 'run', 'sh', '-c', 'id']],
      ['git', ['rebase', '--exec', 'touch /tmp/pwn', 'main']],
      ['git', ['rebase', '-xtouch /tmp/pwn', 'main']],
      ['git', ['rebase', '--continue']],
      ['git', ['merge', 'feature']],
      ['git', ['merge', '--edit', 'feature']],
      ['git', ['pull']],
      ['git', ['pull', '--rebase=interactive']],
      ['git', ['revert', 'HEAD']],
      ['git', ['cherry-pick', '--edit', 'HEAD']],
      ['git', ['filter-branch', '--tree-filter', 'touch /tmp/pwn']],
      ['git', ['diff', '--ext-diff']],
      ['git', ['grep', '--open-files-in-pager=sh']],
      ['git', ['fetch', 'ext::sh -c id']],
      ['git', ['commit']], // may launch an arbitrary configured editor
      ['git', ['commit', '--reedit-message=HEAD']],
      ['git', ['commit', '-cHEAD']],
      ['git', ['notes', 'edit', 'HEAD']],
      ['git', ['init', '--separate-git-dir=/tmp/escaped.git']],
      ['git', ['diff', '--output=/tmp/leaked.patch']],
      ['git', ['format-patch', '--output-directory=/tmp', 'HEAD~1']],
      ['git', ['format-patch', '-o/tmp', 'HEAD~1']],
      ['git', ['apply', '--unsafe-paths', 'change.patch']],
      ['git', ['apply', '--directory=../../', 'change.patch']],
      ['git', ['add', '--pathspec-from-file=C:\\temp\\paths.txt']],
      ['git', ['init', '-t/tmp/template']],
      ['git', ['fetch', '-u/bin/sh', 'origin']],
      ['git', ['ls-remote', '-u/bin/sh', 'origin']],
      ['git', ['grep', '-Osh', 'needle']],
      ['git', ['commit', '-F/etc/passwd']],
      ['git', ['tag', '-a', 'v1', '--file=/etc/passwd']],
      ['git', ['tag', '-s', 'v1', '-m', 'signed']],
      ['git', ['tag', '--sign', 'v1', '-m', 'signed']],
      ['git', ['tag', '-uEVIL', 'v1', '-m', 'signed']],
      ['git', ['format-patch', '--signature-file=/etc/passwd', 'HEAD~1']],
      ['gh', ['alias', 'set', 'x', '!sh -c id', '--shell']],
      ['gh', ['extension', 'exec', 'evil']],
      ['gh', ['config', 'set', 'editor', 'sh -c id']],
      ['gh', ['unknown-extension', 'arg']],
      ['gh', ['pr', 'view', '--web']],
      ['gh', ['api', '--input=/tmp/secret']],
      ['gh', ['api', '-F', 'payload=@/tmp/secret']],
      ['gh', ['issue', 'create', '--body-file=/tmp/secret']],
      ['gh', ['secret', 'set', 'TOKEN', '--body-file=/tmp/secret']],
      ['gh', ['repo', 'create', '--source=/tmp/outside']],
      ['gh', ['repo', 'clone', 'owner/repo', '--', '-u/bin/sh']],
      ['C:\\Program Files\\Git\\bin\\git.exe', ['-c', 'alias.x=!cmd.exe /c calc.exe', 'x']],
      ['C:\\Program Files\\GitHub CLI\\gh.cmd', ['extension', 'exec', 'evil']],
    ];
    for (const [command, args] of denied) {
      expect(isPersonalityToolCallAllowed(personality, {
        tool: 'execute_command', parameters: { command, args },
      }), `${command} ${args.join(' ')}`).toBe(false);
    }
  });

  it('keeps arbitrary commands available when Terminal is explicitly selected', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [terminal]
---
# Terminal bot
`, 'terminal-bot', 'global');
    expect(isPersonalityToolCallAllowed(personality, {
      tool: 'execute_command',
      parameters: { command: 'git', args: ['-c', 'alias.x=!sh -c id', 'x'] },
    })).toBe(true);
  });

  it('fails closed when a non-empty structured Tools declaration is unknown', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [Production]
---
# Deploy bot
`, 'deploy-bot', 'global');
    expect(personality.restrictTools).toBe(true);
    expect(personality.tools).toEqual([]);
    expect(getPersonalityToolAllowlist(personality)).toEqual([]);
    expect(isPersonalityToolCallAllowed(personality, { tool: 'execute_command', parameters: { command: 'git' } })).toBe(false);
  });

  it('fails closed for malformed v1 Tools syntax but retains recognised groups in a valid mixed list', () => {
    const malformed = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: files
---
# Malformed tools
`, 'malformed-tools', 'global');
    expect(malformed.restrictTools).toBe(true);
    expect(malformed.declaredTools).toEqual([]);
    expect(malformed.tools).toEqual([]);
    expect(isPersonalityToolCallAllowed(malformed, { tool: 'read_file', parameters: { path: 'README.md' } })).toBe(false);

    const mixed = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: [files, Production]
---
# Mixed tools
`, 'mixed-tools', 'global');
    expect(mixed.declaredTools).toEqual(['files', 'Production']);
    expect(mixed.tools).toEqual(['files']);
    expect(isPersonalityToolCallAllowed(mixed, { tool: 'read_file', parameters: { path: 'README.md' } })).toBe(true);
    expect(isPersonalityToolCallAllowed(mixed, { tool: 'execute_command', parameters: { command: 'git', args: ['status'] } })).toBe(false);
  });

  it('treats an explicitly empty structured Tools list as conversation-only', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
tools: []
---
# Prompt-only bot
`, 'prompt-only-bot', 'global');
    expect(personality.restrictTools).toBe(true);
    expect(getPersonalityToolAllowlist(personality)).toEqual([]);
    expect(isPersonalityToolCallAllowed(personality, { tool: 'read_file', parameters: { path: 'README.md' } })).toBe(false);
    expect(isPersonalityToolCallAllowed(personality, { tool: 'execute_command', parameters: { command: 'git', args: ['status'] } })).toBe(false);
  });

  it('fails closed when custom-bot/v1 omits Tools entirely', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
model: automatic
scope: all
---
# Missing tools bot
`, 'missing-tools-bot', 'global');
    expect(personality.structured).toBe(true);
    expect(personality.declaredTools).toEqual([]);
    expect(personality.restrictTools).toBe(true);
    expect(getPersonalityToolAllowlist(personality)).toEqual([]);
    expect(isPersonalityToolCallAllowed(personality, { tool: 'read_file', parameters: { path: 'README.md' } })).toBe(false);
  });

  it('treats v1 frontmatter as authoritative instead of reviving missing fields from body sections', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
---
# Metadata-first bot

## Responsibility
Review changes.

## Model
z.ai/glm-5.3

## Tools
- Files

## Scope
Selected projects

## Projects
- Codeep
`, 'metadata-first', 'global');
    expect(personality.modelPreference).toBe('automatic');
    expect(personality.tools).toEqual([]);
    expect(personality.restrictTools).toBe(true);
    expect(personality.projectScope).toBe('unspecified');
    expect(personality.scopeValid).toBe(true);
    expect(personality.projects).toEqual([]);
  });

  it('enforces selected project names and simple glob patterns', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
scope: selected
projects: [Codeep, client-*]
---
# Scoped
`, 'scoped', 'global');
    expect(isPersonalityAvailable(personality, '/work/Codeep')).toBe(true);
    expect(isPersonalityAvailable(personality, '/work/client-api')).toBe(true);
    expect(isPersonalityAvailable(personality, '/work/unrelated')).toBe(false);

    const projectLocal = { ...personality, scope: 'project' as const, projects: [] };
    expect(isPersonalityAvailable(projectLocal, '/work/unrelated')).toBe(true);

    const malformedProjects = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
scope: selected
projects: *
tools: []
---
# Malformed projects
`, 'malformed-projects', 'global');
    expect(malformedProjects.projects).toEqual([]);
    expect(isPersonalityAvailable(malformedProjects, '/work/Codeep')).toBe(false);
  });

  it('marks an explicitly invalid v1 scope unavailable instead of widening it', () => {
    const invalid = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
model: automatic
tools: []
scope: selectd
---
# Typo scope
`, 'typo-scope', 'global');
    expect(invalid.projectScope).toBe('unspecified');
    expect(invalid.scopeValid).toBe(false);
    expect(isPersonalityAvailable(invalid, '/work/Codeep')).toBe(false);

    const missing = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
model: automatic
tools: []
---
# Missing scope
`, 'missing-scope', 'global');
    expect(missing.scopeValid).toBe(true);
    expect(isPersonalityAvailable(missing, '/work/Codeep')).toBe(true);

    const invalidOldSection = parsePersonalityMarkdown(`# Old builder

## Responsibility
Review changes.

## Scope
selectd
`, 'invalid-old-scope', 'global');
    expect(invalidOldSection.structured).toBe(true);
    expect(invalidOldSection.scopeValid).toBe(false);
    expect(isPersonalityAvailable(invalidOldSection, '/work/Codeep')).toBe(false);
  });

  it('enforces personal-only scope outside project workspaces', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
scope: personal
---
# Personal
`, 'personal', 'global');
    expect(isPersonalityAvailable(personality)).toBe(true);
    expect(isPersonalityAvailable(personality, process.cwd())).toBe(false);
  });

  it('does not classify common Swift, VCS, build-only, or IDE workspaces as personal', () => {
    const personality = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
scope: personal
tools: []
---
# Personal
`, 'personal-markers', 'global');
    const markerCases: Array<{ path: string; directory?: boolean }> = [
      { path: 'Package.swift' },
      { path: 'Makefile' },
      { path: '.hg', directory: true },
      { path: '.svn', directory: true },
      { path: 'DesktopApp.xcodeproj', directory: true },
      { path: 'DesktopApp.xcworkspace', directory: true },
      { path: 'DesktopApp.sln' },
    ];

    for (const marker of markerCases) {
      const root = mkdtempSync(join(tmpdir(), 'codeep-personal-scope-'));
      try {
        expect(isPersonalityAvailable(personality, root), `empty ${marker.path}`).toBe(true);
        const markerPath = join(root, marker.path);
        if (marker.directory) mkdirSync(markerPath);
        else writeFileSync(markerPath, '');
        expect(isPersonalityAvailable(personality, root), marker.path).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('treats Automatic as inherit-current and validates an exact provider/model', () => {
    const current = { providerId: 'z.ai', model: 'glm-5-turbo', protocol: 'openai' as const };
    const automatic = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
model: automatic
---
# Auto
`, 'auto', 'global');
    expect(resolvePersonalityRuntimeModel(automatic, current)).toBeNull();

    const exact = parsePersonalityMarkdown(`---
codeep: custom-bot/v1
model: z.ai/glm-5.3
---
# Exact
`, 'exact', 'global');
    expect(resolvePersonalityRuntimeModel(exact, current)).toEqual({
      providerId: 'z.ai', model: 'glm-5.3', protocol: 'openai',
    });

    exact.modelPreference = 'glm-5.3';
    expect(isPersonalityModelPreferenceValid(exact)).toBe(false);
    expect(isPersonalityAvailable(exact, process.cwd())).toBe(false);
    expect(resolvePersonalityRuntimeModel(exact, current)).toBeNull();
    exact.modelPreference = 'z.ai/';
    expect(resolvePersonalityRuntimeModel(exact, current)).toBeNull();
    exact.modelPreference = 'missing-provider/nope';
    expect(resolvePersonalityRuntimeModel(exact, current)).toBeNull();

    exact.modelPreference = 'z.ai/not-in-the-catalog';
    expect(isPersonalityModelPreferenceValid(exact)).toBe(false);
    expect(isPersonalityAvailable(exact, process.cwd())).toBe(false);

    exact.modelPreference = 'ollama/a-local-model-not-in-the-static-fallback';
    expect(isPersonalityModelPreferenceValid(exact)).toBe(true);
    expect(isPersonalityAvailable(exact, process.cwd())).toBe(true);
  });
});

describe('capability disclosure', () => {
  // The builder promises "unselected tools are removed from this agent's
  // runtime", and a user reading that reasonably assumes a Git-only bot cannot
  // see file contents. It can: `git show HEAD:file` is functionally `cat file`,
  // and history inspection cannot be separated from the content it inspects.
  // The activation output has to say so rather than leave the promise standing.
  const bot = (tools: string[]) => ({
    name: 'b', displayName: 'B', description: 'd', scope: 'project',
    content: '', structured: true, restrictTools: true,
    tools, declaredTools: tools, projectScope: 'all', modelPreference: 'automatic',
  } as never);

  it('warns when Git is granted without Files', () => {
    const out = formatPersonalityActivation(bot(['git']));
    expect(out).toContain('Git is not read-only');
      expect(out).toContain('git push'); // the write half must be disclosed too
  });

  it('stays quiet when Files is granted too — nothing is being implied', () => {
    expect(formatPersonalityActivation(bot(['git', 'files'])))
      .not.toContain('Git is not read-only');
  });

  it('stays quiet for a bot with no Git at all', () => {
    expect(formatPersonalityActivation(bot(['tests'])))
      .not.toContain('Git is not read-only');
  });

  // The disclosure above is only honest if these really are permitted. If a
  // future change narrows SAFE_GIT_SUBCOMMANDS, this test fails and the
  // wording has to be narrowed with it.
  it('the Git capability really does permit writes and pushes', () => {
    const p = bot(['git']);
    const call = (command: string, args: string[]) =>
      isPersonalityToolCallAllowed(p, { tool: 'execute_command', parameters: { command, args } } as never);
    for (const args of [['rm', 'x'], ['commit', '-m', 'x'], ['push'], ['reset', '--hard']]) {
      expect(call('git', args)).toBe(true);
    }
    expect(call('git', ['log'])).toBe(true);
    expect(call('rm', ['-rf', '/'])).toBe(false);
  });
});
