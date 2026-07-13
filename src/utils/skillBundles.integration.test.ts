import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
  root: 'project' | 'global';
  name: string;
  body: string;
}): void {
  const base = opts.root === 'project' ? workspaceRoot : fakeHome;
  const dir = join(base, '.codeep', 'skills', opts.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), opts.body);
}

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
