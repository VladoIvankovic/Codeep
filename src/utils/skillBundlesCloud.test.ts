import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  serialiseSkillMd,
  readRawSkillMd,
  uninstallLocalBundle,
} from './skillBundlesCloud';
import type { SkillBundle } from './skillBundles';

function bundle(overrides: Partial<SkillBundle> = {}): SkillBundle {
  return {
    name: 'demo',
    description: 'a demo skill',
    source: '/x/.codeep/skills/demo',
    scope: 'project',
    allowedTools: [],
    triggers: [],
    requiresMcp: [],
    frontmatterRaw: {},
    body: 'do the thing',
    ...overrides,
  };
}

describe('serialiseSkillMd', () => {
  it('emits a YAML frontmatter block with name + description', () => {
    const out = serialiseSkillMd(bundle());
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('name: demo');
    expect(out).toContain('description: a demo skill');
  });

  it('closes the frontmatter with a trailing ---', () => {
    const out = serialiseSkillMd(bundle());
    // The second --- appears after the metadata block.
    const closes = out.match(/---/g);
    expect(closes?.length).toBe(2);
  });

  it('includes the body after the frontmatter', () => {
    const out = serialiseSkillMd(bundle({ body: 'unique body text' }));
    expect(out).toContain('unique body text');
  });

  it('omits optional fields when they are missing', () => {
    const out = serialiseSkillMd(bundle());
    expect(out).not.toContain('version:');
    expect(out).not.toContain('author:');
    expect(out).not.toContain('codeep-min-version:');
  });

  it('includes version / author / codeep-min-version when present', () => {
    const out = serialiseSkillMd(
      bundle({ version: '1.2.0', author: 'me', codeepMinVersion: '2.0.0' }),
    );
    expect(out).toContain('version: 1.2.0');
    expect(out).toContain('author: me');
    expect(out).toContain('codeep-min-version: 2.0.0');
  });

  it('serialises requiresMcp as a YAML block list', () => {
    const out = serialiseSkillMd(bundle({ requiresMcp: ['postgres', 'github'] }));
    expect(out).toContain('codeep-requires-mcp:');
    expect(out).toContain('  - postgres');
    expect(out).toContain('  - github');
  });

  it('serialises allowedTools as a YAML block list', () => {
    const out = serialiseSkillMd(bundle({ allowedTools: ['read_file', 'write_file'] }));
    expect(out).toContain('allowed-tools:');
    expect(out).toContain('  - read_file');
    expect(out).toContain('  - write_file');
  });

  it('serialises triggers as a YAML block list', () => {
    const out = serialiseSkillMd(bundle({ triggers: ['commit', 'save'] }));
    expect(out).toContain('triggers:');
    expect(out).toContain('  - commit');
    expect(out).toContain('  - save');
  });

  it('omits empty list sections', () => {
    const out = serialiseSkillMd(bundle({ requiresMcp: [], allowedTools: [], triggers: [] }));
    expect(out).not.toContain('codeep-requires-mcp:');
    expect(out).not.toContain('allowed-tools:');
    expect(out).not.toContain('triggers:');
  });
});

describe('readRawSkillMd / uninstallLocalBundle', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeep-skills-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('readRawSkillMd', () => {
    it('returns null when the SKILL.md does not exist', () => {
      expect(readRawSkillMd(root, 'missing')).toBeNull();
    });

    it('returns the raw file contents when present', () => {
      const skillDir = join(root, '.codeep', 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nbody');
      expect(readRawSkillMd(root, 'demo')).toBe('---\nname: demo\n---\nbody');
    });
  });

  describe('uninstallLocalBundle', () => {
    it('returns false when the bundle directory does not exist', () => {
      expect(uninstallLocalBundle(root, 'nope')).toBe(false);
    });

    it('removes the bundle directory and returns true', () => {
      const skillDir = join(root, '.codeep', 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'x');
      expect(uninstallLocalBundle(root, 'demo')).toBe(true);
      expect(existsSync(skillDir)).toBe(false);
    });

    it('is safe to call twice (idempotent — second call returns false)', () => {
      const skillDir = join(root, '.codeep', 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      expect(uninstallLocalBundle(root, 'demo')).toBe(true);
      expect(uninstallLocalBundle(root, 'demo')).toBe(false);
    });
  });
});
