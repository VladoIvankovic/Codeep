import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs and path modules before importing skills
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => '/home/test') };
});

import {
  findSkill,
  parseSkillChain,
  parseSkillArgs,
  interpolateParams,
  parseSkillDefinition,
  searchSkills,
  getBuiltInSkills,
  getSkillsSummary,
} from './skills';
import type { Skill } from './skills';

// ─── findSkill ───────────────────────────────────────────────────────────────

describe('findSkill', () => {
  it('finds a built-in skill by name', () => {
    const skill = findSkill('commit');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('commit');
  });

  it('finds a built-in skill by shortcut', () => {
    const commit = findSkill('commit');
    if (commit?.shortcut) {
      const byShortcut = findSkill(commit.shortcut);
      expect(byShortcut?.name).toBe('commit');
    }
  });

  it('is case-insensitive', () => {
    expect(findSkill('COMMIT')).not.toBeNull();
    expect(findSkill('Commit')).not.toBeNull();
  });

  it('returns null for unknown skill', () => {
    expect(findSkill('nonexistent-skill-xyz')).toBeNull();
  });
});

// ─── parseSkillChain ─────────────────────────────────────────────────────────

describe('parseSkillChain', () => {
  it('returns null when there is no + in input', () => {
    expect(parseSkillChain('commit')).toBeNull();
  });

  it('returns null when fewer than 2 parts after split', () => {
    expect(parseSkillChain('commit+')).toBeNull();
  });

  it('returns null when any skill in chain does not exist', () => {
    expect(parseSkillChain('commit+nonexistent-xyz')).toBeNull();
  });

  it('parses a valid two-skill chain', () => {
    // Use two skills that are guaranteed to exist
    const skills = getBuiltInSkills();
    if (skills.length >= 2) {
      const [a, b] = skills;
      const chain = parseSkillChain(`${a.name}+${b.name}`);
      expect(chain).not.toBeNull();
      expect(chain!.skills).toEqual([a.name, b.name]);
      expect(chain!.stopOnError).toBe(true);
    }
  });

  it('trims whitespace around skill names', () => {
    const skills = getBuiltInSkills();
    if (skills.length >= 2) {
      const [a, b] = skills;
      const chain = parseSkillChain(` ${a.name} + ${b.name} `);
      expect(chain).not.toBeNull();
      expect(chain!.skills[0]).toBe(a.name);
      expect(chain!.skills[1]).toBe(b.name);
    }
  });
});

// ─── parseSkillArgs ──────────────────────────────────────────────────────────

describe('parseSkillArgs', () => {
  const skillWithParam: Skill = {
    name: 'test-skill',
    description: 'Test',
    category: 'custom',
    steps: [],
    parameters: [
      { name: 'message', description: 'A message', required: false },
      { name: 'scope', description: 'A scope', required: false, default: 'all' },
    ],
  };

  it('returns empty object for empty args', () => {
    expect(parseSkillArgs('', skillWithParam)).toEqual({ scope: 'all' });
  });

  it('parses key=value pairs', () => {
    const result = parseSkillArgs('message=hello scope=auth', skillWithParam);
    expect(result.message).toBe('hello');
    expect(result.scope).toBe('auth');
  });

  it('parses quoted values with spaces', () => {
    const result = parseSkillArgs('message="fix login bug"', skillWithParam);
    expect(result.message).toBe('fix login bug');
  });

  it('assigns remaining text to first parameter', () => {
    const result = parseSkillArgs('fix login bug', skillWithParam);
    expect(result.message).toBe('fix login bug');
  });

  it('applies default values for missing parameters', () => {
    const result = parseSkillArgs('', skillWithParam);
    expect(result.scope).toBe('all');
  });

  it('does not override provided value with default', () => {
    const result = parseSkillArgs('scope=frontend', skillWithParam);
    expect(result.scope).toBe('frontend');
  });
});

// ─── interpolateParams ───────────────────────────────────────────────────────

describe('interpolateParams', () => {
  it('replaces a single placeholder', () => {
    const result = interpolateParams('Hello ${name}!', { name: 'world' });
    expect(result).toBe('Hello world!');
  });

  it('replaces multiple placeholders', () => {
    const result = interpolateParams('${a} and ${b}', { a: 'foo', b: 'bar' });
    expect(result).toBe('foo and bar');
  });

  it('replaces the same placeholder multiple times', () => {
    const result = interpolateParams('${x} ${x}', { x: 'hi' });
    expect(result).toBe('hi hi');
  });

  it('leaves unknown placeholders untouched', () => {
    const result = interpolateParams('Hello ${unknown}', { name: 'world' });
    expect(result).toBe('Hello ${unknown}');
  });

  it('handles empty params object', () => {
    const result = interpolateParams('no placeholders here', {});
    expect(result).toBe('no placeholders here');
  });
});

// ─── parseSkillDefinition ────────────────────────────────────────────────────

describe('parseSkillDefinition', () => {
  it('parses a valid skill definition', () => {
    const content = [
      'name: my-skill',
      'description: Does something useful',
      'shortcut: m',
      '- prompt: Explain what this code does',
      '- command: npm test',
    ].join('\n');

    const skill = parseSkillDefinition(content);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('my-skill');
    expect(skill!.description).toBe('Does something useful');
    expect(skill!.shortcut).toBe('m');
    expect(skill!.steps).toHaveLength(2);
    expect(skill!.steps[0]).toEqual({ type: 'prompt', content: 'Explain what this code does' });
    expect(skill!.steps[1]).toEqual({ type: 'command', content: 'npm test' });
  });

  it('returns null when name is missing', () => {
    const content = 'description: Does something\n- prompt: hello';
    expect(parseSkillDefinition(content)).toBeNull();
  });

  it('returns null when description is missing', () => {
    const content = 'name: my-skill\n- prompt: hello';
    expect(parseSkillDefinition(content)).toBeNull();
  });

  it('returns null when steps are missing', () => {
    const content = 'name: my-skill\ndescription: Does something';
    expect(parseSkillDefinition(content)).toBeNull();
  });

  it('parses - run: as command step', () => {
    const content = 'name: s\ndescription: d\n- run: echo hello';
    const skill = parseSkillDefinition(content);
    expect(skill!.steps[0]).toEqual({ type: 'command', content: 'echo hello' });
  });

  it('parses confirm, agent, and notify step types', () => {
    const content = [
      'name: s',
      'description: d',
      '- confirm: Are you sure?',
      '- agent: refactor the code',
      '- notify: Done!',
    ].join('\n');
    const skill = parseSkillDefinition(content);
    expect(skill!.steps[0].type).toBe('confirm');
    expect(skill!.steps[1].type).toBe('agent');
    expect(skill!.steps[2].type).toBe('notify');
  });
});

// ─── searchSkills ────────────────────────────────────────────────────────────

describe('searchSkills', () => {
  it('returns skills matching by name', () => {
    const results = searchSkills('commit');
    expect(results.some(s => s.name === 'commit')).toBe(true);
  });

  it('returns skills matching by description keyword', () => {
    const results = searchSkills('git');
    expect(results.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    const lower = searchSkills('commit');
    const upper = searchSkills('COMMIT');
    expect(lower.length).toBe(upper.length);
  });

  it('returns empty array for no matches', () => {
    expect(searchSkills('zzz-no-match-xyz')).toEqual([]);
  });
});

// ─── getSkillsSummary ────────────────────────────────────────────────────────

describe('getSkillsSummary', () => {
  it('returns a summary with all expected categories', () => {
    const summary = getSkillsSummary();
    const expectedCategories = ['git', 'testing', 'documentation', 'refactoring', 'debugging', 'deployment', 'generation', 'devops', 'custom'];
    for (const cat of expectedCategories) {
      expect(summary).toHaveProperty(cat);
    }
  });

  it('has non-negative counts for all categories', () => {
    const summary = getSkillsSummary();
    for (const count of Object.values(summary)) {
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  it('total count equals number of built-in skills', () => {
    const summary = getSkillsSummary();
    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(getBuiltInSkills().length);
  });
});
