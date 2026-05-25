import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs so we control which `.codeep/agents/` dirs exist and their contents.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readdirSync: vi.fn(), readFileSync: vi.fn() };
});

import { existsSync, readdirSync, readFileSync } from 'fs';
import { loadAgents, findAgent, formatAgentsForSysprompt, formatAgentList } from './agents';

const mockExists = existsSync as ReturnType<typeof vi.fn>;
const mockReaddir = readdirSync as ReturnType<typeof vi.fn>;
const mockRead = readFileSync as ReturnType<typeof vi.fn>;

describe('agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(false); // no custom dirs by default → built-ins only
  });

  it('exposes the built-in agents by default', () => {
    const names = loadAgents().filter((a) => a.scope === 'builtin').map((a) => a.name).sort();
    expect(names).toEqual(['planner', 'researcher', 'reviewer', 'tester']);
  });

  it('built-in researcher and planner are read-only (scoped tools, no write)', () => {
    for (const name of ['researcher', 'planner']) {
      const a = findAgent(name);
      expect(a, name).not.toBeNull();
      expect(a!.tools).toContain('read_file');
      expect(a!.tools).not.toContain('write_file');
    }
  });

  it('findAgent is case-insensitive; unknown → null', () => {
    expect(findAgent('REVIEWER')?.name).toBe('reviewer');
    expect(findAgent('nope')).toBeNull();
  });

  it('loads a custom project agent and parses frontmatter', () => {
    mockExists.mockImplementation((p: string) => String(p).includes('/proj/.codeep/agents'));
    mockReaddir.mockReturnValue(['deployer.md'] as never);
    mockRead.mockReturnValue(
      `---\nname: Deployer\ndescription: Ships to staging\ntools: [execute_command, read_file]\nmodel: glm-5.1\npersonality: ship-it\nmaxIterations: 8\n---\nYou deploy the current branch.`,
    );
    const a = findAgent('deployer', '/proj');
    expect(a).not.toBeNull();
    expect(a!.displayName).toBe('Deployer');
    expect(a!.description).toBe('Ships to staging');
    expect(a!.tools).toEqual(['execute_command', 'read_file']);
    expect(a!.model).toBe('glm-5.1');
    expect(a!.personality).toBe('ship-it');
    expect(a!.maxIterations).toBe(8);
    expect(a!.prompt).toContain('You deploy the current branch.');
    expect(a!.scope).toBe('project');
  });

  it('project agent shadows a built-in of the same name', () => {
    mockExists.mockImplementation((p: string) => String(p).includes('/proj/.codeep/agents'));
    mockReaddir.mockReturnValue(['reviewer.md'] as never);
    mockRead.mockReturnValue(`---\nname: My Reviewer\ndescription: custom\n---\nCustom review prompt.`);
    const r = findAgent('reviewer', '/proj');
    expect(r!.scope).toBe('project');
    expect(r!.prompt).toContain('Custom review prompt.');
  });

  it('formatAgentsForSysprompt advertises delegate + agent names', () => {
    const out = formatAgentsForSysprompt(loadAgents());
    expect(out).toContain('delegate');
    expect(out).toContain('researcher');
    expect(out).toContain('Sub-agents');
  });

  it('formatAgentList renders a table with scope + tool info', () => {
    const out = formatAgentList();
    expect(out).toContain('## Sub-agents');
    expect(out).toContain('| `researcher` |');
    expect(out).toContain('built-in');
  });
});
