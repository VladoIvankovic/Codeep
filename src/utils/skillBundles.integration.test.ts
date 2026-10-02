import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real fs, with readFileSync recorded so a test can prove a file was never
// read, and readdirSync so one can list a directory in an order of its own.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync) };
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect homedir() before module import — same hoisted-mock pattern
// as mcpConfig.test.ts so the global skill dir resolves to our fixture.
const { fakeHomeRef } = vi.hoisted(() => ({ fakeHomeRef: { current: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHomeRef.current || actual.homedir() };
});

import {
  loadSkillBundles,
  findSkillBundle,
  formatBundleList,
  formatBundlesForSysprompt,
  summarizeBundles,
} from './skillBundles';

let workspaceRoot: string;
let fakeHome: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codeep-skills-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'codeep-skills-home-'));
  fakeHomeRef.current = fakeHome;
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  fakeHomeRef.current = '';
});

function writeSkill(opts: {
  /** `agents` is `~/.agents/skills`, the directory agent harnesses share. */
  root: 'project' | 'global' | 'agents';
  name: string;
  body: string;
}): void {
  const dir = join(skillsDir(opts.root), opts.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), opts.body);
}

function skillsDir(root: 'project' | 'global' | 'agents'): string {
  if (root === 'agents') return join(fakeHome, '.agents', 'skills');
  return join(root === 'project' ? workspaceRoot : fakeHome, '.codeep', 'skills');
}

const SKILL = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody`;

const FRONT = (body: string) => `---\nname: my-skill\ndescription: Test skill\n---\n${body}`;

describe('loadSkillBundles', () => {
  it('returns empty when no skills installed', () => {
    expect(loadSkillBundles(workspaceRoot)).toEqual([]);
  });

  it('loads a project-scoped skill', () => {
    writeSkill({ root: 'project', name: 'deploy', body: FRONT('Run `npm run deploy`.') });
    const bundles = loadSkillBundles(workspaceRoot);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].name).toBe('my-skill');
    expect(bundles[0].description).toBe('Test skill');
    expect(bundles[0].scope).toBe('project');
    expect(bundles[0].body).toMatch(/Run `npm run deploy`/);
  });

  it('falls back to the directory name when frontmatter `name` is missing', () => {
    const dir = join(workspaceRoot, '.codeep', 'skills', 'no-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: Has no name field\n---\nBody');
    expect(loadSkillBundles(workspaceRoot)[0].name).toBe('no-name');
  });

  it('checks the kind and size of SKILL.md before reading it', () => {
    // A cloned repo can commit `SKILL.md -> /dev/zero` (or a FIFO), and
    // readFileSync on either never returns. /dev/null takes the same path but
    // returns at once.
    const device = join(workspaceRoot, '.codeep', 'skills', 'device');
    mkdirSync(device, { recursive: true });
    symlinkSync('/dev/null', join(device, 'SKILL.md'));
    writeSkill({ root: 'project', name: 'huge', body: FRONT('x'.repeat(256 * 1024)) });
    writeSkill({ root: 'project', name: 'deploy', body: '---\nname: deploy\ndescription: Ships\n---\nGo.' });
    vi.mocked(readFileSync).mockClear();

    expect(loadSkillBundles(workspaceRoot).map((b) => b.name)).toEqual(['deploy']);
    const read = vi.mocked(readFileSync).mock.calls.map((c) => String(c[0]));
    expect(read).toEqual([join(workspaceRoot, '.codeep', 'skills', 'deploy', 'SKILL.md')]);
  });

  it('skips bundles with no description (catalog noise guard)', () => {
    const dir = join(workspaceRoot, '.codeep', 'skills', 'desc-less');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: desc-less\n---\nBody');
    expect(loadSkillBundles(workspaceRoot)).toEqual([]);
  });

  it('project entries shadow global with the same name', () => {
    writeSkill({ root: 'global', name: 'deploy', body: '---\nname: deploy\ndescription: Global deploy\n---\nG' });
    writeSkill({ root: 'project', name: 'deploy', body: '---\nname: deploy\ndescription: Project deploy\n---\nP' });
    const bundles = loadSkillBundles(workspaceRoot);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].description).toBe('Project deploy');
    expect(bundles[0].scope).toBe('project');
  });

  it('parses allowed-tools and triggers as arrays (inline + block form)', () => {
    const inline = '---\nname: a\ndescription: d\nallowed-tools: [read_file, write_file]\ntriggers: ["deploy", "ship"]\n---\nBody';
    writeSkill({ root: 'project', name: 'a', body: inline });
    const block = `---\nname: b\ndescription: d\nallowed-tools:\n  - read_file\n  - execute_command\n---\nBody`;
    writeSkill({ root: 'project', name: 'b', body: block });

    const bundles = loadSkillBundles(workspaceRoot);
    const a = bundles.find(x => x.name === 'a')!;
    expect(a.allowedTools).toEqual(['read_file', 'write_file']);
    expect(a.triggers).toEqual(['deploy', 'ship']);
    const b = bundles.find(x => x.name === 'b')!;
    expect(b.allowedTools).toEqual(['read_file', 'execute_command']);
  });

  it('reads Codeep-specific extensions (codeep-min-version, codeep-requires-mcp)', () => {
    const body = `---
name: pg-tool
description: Postgres skill
version: 1.2.3
author: me
codeep-min-version: 2.0.0
codeep-requires-mcp:
  - postgres
  - filesystem
---
Body`;
    writeSkill({ root: 'project', name: 'pg-tool', body });
    const b = loadSkillBundles(workspaceRoot)[0];
    expect(b.version).toBe('1.2.3');
    expect(b.author).toBe('me');
    expect(b.codeepMinVersion).toBe('2.0.0');
    expect(b.requiresMcp).toEqual(['postgres', 'filesystem']);
  });

  it('handles BOM and CRLF line endings (real-world file tolerance)', () => {
    const body = `﻿---\r\nname: with-bom\r\ndescription: d\r\n---\r\nBody`;
    writeSkill({ root: 'project', name: 'with-bom', body });
    const b = loadSkillBundles(workspaceRoot)[0];
    expect(b.name).toBe('with-bom');
    expect(b.description).toBe('d');
  });

  it('skips bundles without SKILL.md (just a stray directory)', () => {
    mkdirSync(join(workspaceRoot, '.codeep', 'skills', 'no-skill-file'), { recursive: true });
    expect(loadSkillBundles(workspaceRoot)).toEqual([]);
  });

  it('skips bundles where SKILL.md is bigger than 256 KB (sanity ceiling)', () => {
    const huge = '---\nname: big\ndescription: d\n---\n' + 'x'.repeat(300_000);
    writeSkill({ root: 'project', name: 'big', body: huge });
    expect(loadSkillBundles(workspaceRoot)).toEqual([]);
  });

  it('loads global bundles from ~/.agents/skills too', () => {
    writeSkill({ root: 'agents', name: 'crash', body: SKILL('crash', 'Shared') });
    const bundles = loadSkillBundles(workspaceRoot);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].scope).toBe('global');
    expect(bundles[0].source).toBe(join(fakeHome, '.agents', 'skills', 'crash'));
  });

  it('is fine without ~/.agents/skills', () => {
    writeSkill({ root: 'global', name: 'deploy', body: SKILL('deploy', 'Global') });
    expect(loadSkillBundles(workspaceRoot).map(b => b.source)).toEqual([join(fakeHome, '.codeep', 'skills', 'deploy')]);
  });

  it('prefers .codeep/skills, then ~/.codeep/skills, then ~/.agents/skills for the same name', () => {
    writeSkill({ root: 'agents', name: 'deploy', body: SKILL('deploy', 'Shared deploy') });
    writeSkill({ root: 'global', name: 'deploy', body: SKILL('deploy', 'Global deploy') });
    expect(loadSkillBundles(workspaceRoot).map(b => b.description)).toEqual(['Global deploy']);

    writeSkill({ root: 'project', name: 'deploy', body: SKILL('deploy', 'Project deploy') });
    expect(loadSkillBundles(workspaceRoot).map(b => b.description)).toEqual(['Project deploy']);
    // No workspace: the project directory is not in the running.
    expect(loadSkillBundles().map(b => b.description)).toEqual(['Global deploy']);
  });

  it('keeps the first directory, by name, when two in one place claim the same name', () => {
    writeSkill({ root: 'agents', name: 'b-copy', body: SKILL('deploy', 'From b-copy') });
    writeSkill({ root: 'agents', name: 'a-copy', body: SKILL('deploy', 'From a-copy') });
    // Listed out of order, as Windows may list it. Node sorts a listing on
    // Linux and macOS already, so a real one there could not show the sort.
    vi.mocked(readdirSync).mockReturnValueOnce(['b-copy', 'a-copy'] as unknown as ReturnType<typeof readdirSync>);
    expect(loadSkillBundles(workspaceRoot).map(b => b.description)).toEqual(['From a-copy']);
    expect(vi.mocked(readdirSync)).toHaveBeenCalledWith(skillsDir('agents'));
  });

  it('reads a folded or literal description as one line', () => {
    writeSkill({ root: 'agents', name: 'folded', body: '---\nname: folded\ndescription: >\n  Diagnose a crash.\n  Use on a core dump.\n---\nBody' });
    writeSkill({ root: 'agents', name: 'literal', body: '---\nname: literal\ndescription: |\n  First.\n  Second.\n---\nBody' });
    const bundles = loadSkillBundles(workspaceRoot);
    expect(bundles.find(b => b.name === 'folded')?.description).toBe('Diagnose a crash. Use on a core dump.');
    expect(bundles.find(b => b.name === 'literal')?.description).toBe('First. Second.');
  });
});

describe('linked bundles', () => {
  // Stands in for $OMARCHY_PATH: neither in the project nor under ~/.agents.
  let elsewhere: string;

  beforeEach(() => {
    elsewhere = mkdtempSync(join(tmpdir(), 'codeep-skills-elsewhere-'));
    mkdirSync(join(elsewhere, 'crash'));
    writeFileSync(join(elsewhere, 'crash', 'SKILL.md'), SKILL('crash', 'Linked in'));
  });

  afterEach(() => {
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('loads a global bundle that is a symlink, as Omarchy installs its skills', () => {
    mkdirSync(skillsDir('agents'), { recursive: true });
    symlinkSync(join(elsewhere, 'crash'), join(skillsDir('agents'), 'crash'));
    const bundles = loadSkillBundles(workspaceRoot);
    expect(bundles.map(b => b.description)).toEqual(['Linked in']);
    expect(bundles[0].source).toBe(join(fakeHome, '.agents', 'skills', 'crash'));
  });

  it('loads ~/.agents/skills when it is a symlink itself', () => {
    mkdirSync(join(fakeHome, '.agents'));
    symlinkSync(elsewhere, skillsDir('agents'));
    expect(loadSkillBundles(workspaceRoot).map(b => b.name)).toEqual(['crash']);
  });

  it('still refuses a project bundle that links outside the project', () => {
    mkdirSync(skillsDir('project'), { recursive: true });
    symlinkSync(join(elsewhere, 'crash'), join(skillsDir('project'), 'crash'));
    expect(loadSkillBundles(workspaceRoot)).toEqual([]);
  });
});

describe('findSkillBundle', () => {
  beforeEach(() => {
    writeSkill({ root: 'project', name: 'deploy', body: FRONT('B') });
  });

  it('finds by lowercased name', () => {
    expect(findSkillBundle('MY-SKILL', workspaceRoot)?.name).toBe('my-skill');
  });

  it('returns null for unknown name', () => {
    expect(findSkillBundle('nonsense', workspaceRoot)).toBeNull();
  });
});

describe('formatBundleList', () => {
  it('shows setup guide when no bundles installed', () => {
    const md = formatBundleList([]);
    expect(md).toMatch(/No skill bundles installed/);
    expect(md).toMatch(/SKILL\.md/);
  });

  it('names the directory each global bundle came from, in precedence order', () => {
    writeSkill({ root: 'agents', name: 'crash', body: SKILL('crash', 'Shared') });
    writeSkill({ root: 'global', name: 'deploy', body: SKILL('deploy', 'Mine') });
    const md = formatBundleList(loadSkillBundles(workspaceRoot));
    expect(md).toContain([
      '**Global** — `~/.codeep/skills`',
      '- **deploy** — Mine',
      '',
      '**Global** — `~/.agents/skills`',
      '- **crash** — Shared',
    ].join('\n'));
  });

  it('groups by scope', () => {
    const project = { name: 'p', description: 'PP', source: '', scope: 'project' as const, allowedTools: [], triggers: [], requiresMcp: [], frontmatterRaw: {}, body: '' };
    const global = { name: 'g', description: 'GG', source: '', scope: 'global' as const, allowedTools: [], triggers: [], requiresMcp: [], frontmatterRaw: {}, body: '' };
    const md = formatBundleList([project, global]);
    expect(md).toMatch(/\*\*Project\*\*[\s\S]*\*\*p\*\* — PP/);
    expect(md).toMatch(/\*\*Global\*\*[\s\S]*\*\*g\*\* — GG/);
  });
});

describe('formatBundlesForSysprompt', () => {
  it('returns empty string when no bundles', () => {
    expect(formatBundlesForSysprompt([])).toBe('');
  });

  it('includes invoke_skill instructions + bundle list', () => {
    const b = { name: 'deploy', description: 'Deploy to staging', source: '', scope: 'project' as const, allowedTools: [], triggers: ['ship', 'release'], requiresMcp: [], frontmatterRaw: {}, body: '' };
    const out = formatBundlesForSysprompt([b]);
    expect(out).toMatch(/Available skill bundles/);
    expect(out).toMatch(/invoke_skill/);
    expect(out).toMatch(/\*\*deploy\*\* — Deploy to staging/);
    expect(out).toMatch(/triggers: ship, release/);
  });

  const bundle = (name: string, description: string) => ({ name, description, source: '', scope: 'global' as const, allowedTools: [], triggers: [], requiresMcp: [], frontmatterRaw: {}, body: '' });

  it('keeps a long description whole, with the part that says when to use it', () => {
    // Omarchy's run to 590 characters and end on their triggers and what they
    // exclude, which the catalog's old 200-character lines cut off.
    const description = `${'Customize the desktop, its bar and its theme. '.repeat(11)}Triggers: waybar, hyprland. Excludes Omarchy source development.`;
    expect(description.length).toBeGreaterThan(560);
    const out = formatBundlesForSysprompt(['diagnose-crash', 'omarchy', 'omarchy-app'].map(n => bundle(n, description)));
    expect(out.split('\n').filter(l => l.endsWith(description))).toHaveLength(3);
  });

  it('cuts a line past the cap at a word, not inside one', () => {
    const out = formatBundlesForSysprompt([bundle('long', 'abcdefghij '.repeat(200).trim())]);
    const line = out.split('\n').find(l => l.startsWith('- **long**'))!;
    expect(line).toMatch(/ abcdefghij…$/);
    expect(line.length).toBeLessThanOrEqual(1201);
  });
});

describe('summarizeBundles (welcome banner)', () => {
  it('empty string when no project bundles', () => {
    expect(summarizeBundles(workspaceRoot)).toBe('');
  });

  it('mentions count when project bundles exist', () => {
    writeSkill({ root: 'project', name: 'one', body: FRONT('B') });
    expect(summarizeBundles(workspaceRoot)).toMatch(/1 project skill/);
  });

  it('ignores global-only bundles (those don\'t need a warning — user owns ~/.codeep)', () => {
    writeSkill({ root: 'global', name: 'g', body: FRONT('B') });
    expect(summarizeBundles(workspaceRoot)).toBe('');
  });
});
