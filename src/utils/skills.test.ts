import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

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
    unlinkSync: vi.fn(),
  };
});

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

  it('inserts the value literally — $ sequences are not treated as replacement patterns', () => {
    // A param value can be any text (a command, a price, a regex). $&, $$, $1
    // must survive verbatim rather than expanding against the match.
    expect(interpolateParams('x = ${v}', { v: '$& and $$ and $1' })).toBe('x = $& and $$ and $1');
  });

  it('matches the placeholder literally — a regex-meta char in the key does not over-match', () => {
    // `.` in the key must mean a literal dot, not "any char" (which would also
    // have replaced `${aXb}`).
    expect(interpolateParams('${a.b} ${aXb}', { 'a.b': 'Z' })).toBe('Z ${aXb}');
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

// ─── executeSkill ────────────────────────────────────────────────────────────

import { executeSkill } from './skills';
import type { SkillExecutionCallbacks } from './skills';
import { readdirSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { basename, join } from 'path';

function recordingCallbacks(aiReply: string, overrides: Partial<SkillExecutionCallbacks> = {}) {
  const commands: string[] = [];
  const callbacks: SkillExecutionCallbacks = {
    onCommand: async (cmd) => { commands.push(cmd); return ' 1 file changed, 3 insertions(+)'; },
    onPrompt: async () => aiReply,
    onAgent: async () => 'agent done',
    onConfirm: async () => true,
    onNotify: () => {},
    ...overrides,
  };
  return { commands, callbacks };
}

describe('executeSkill — ${_prev} survives confirm and notify steps', () => {
  it('/commit commits with the generated message the user confirmed', async () => {
    const { commands, callbacks } = recordingCallbacks('feat(auth): add token refresh');
    const result = await executeSkill(findSkill('commit')!, {}, callbacks);
    expect(result.success).toBe(true);
    expect(commands[commands.length - 1]).toBe('git add -A && git commit -m "feat(auth): add token refresh"');
  });

  it('/commit takes the message out of a code fence the model added', async () => {
    const { commands, callbacks } = recordingCallbacks('```\nfix(api): retry on 429\n```\nThis follows the conventional format.');
    await executeSkill(findSkill('commit')!, {}, callbacks);
    expect(commands[commands.length - 1]).toBe('git add -A && git commit -m "fix(api): retry on 429"');
  });

  it('/branch creates the branch the model suggested', async () => {
    const skill = findSkill('branch')!;
    const { commands, callbacks } = recordingCallbacks('feature/add-login-page');
    const result = await executeSkill(skill, parseSkillArgs('add login page', skill), callbacks);
    expect(result.success).toBe(true);
    expect(commands).toEqual(['git checkout -b "feature/add-login-page"']);
  });

  it('/stash stashes with the message the model suggested', async () => {
    const { commands, callbacks } = recordingCallbacks('wip: half-done login form');
    const result = await executeSkill(findSkill('stash')!, {}, callbacks);
    expect(result.success).toBe(true);
    expect(commands).toEqual(['git stash push -m "wip: half-done login form"']);
  });

  it('a notify step between two steps passes the earlier output through', async () => {
    const skill: Skill = {
      name: 'notify-between', description: 'd', category: 'custom',
      steps: [
        { type: 'prompt', content: 'p' },
        { type: 'notify', content: 'Got it' },
        { type: 'command', content: 'echo "${_prev}"' },
      ],
    };
    const { commands, callbacks } = recordingCallbacks('the answer');
    await executeSkill(skill, {}, callbacks);
    expect(commands).toEqual(['echo "the answer"']);
  });
});

describe('executeSkill — model output handed to a command cannot run anything', () => {
  let dir: string;
  let marker: string;
  let realFs: typeof import('fs');

  beforeAll(async () => {
    realFs = await vi.importActual<typeof import('fs')>('fs');
    dir = realFs.mkdtempSync(join(tmpdir(), 'codeep-skill-shell-'));
    marker = join(dir, 'pwned');
  });
  afterEach(() => { realFs.rmSync(marker, { force: true }); });
  afterAll(() => { realFs.rmSync(dir, { recursive: true, force: true }); });

  const cases: [string, (m: string) => string, (m: string) => string][] = [
    ['a reply wrapped in a code fence', m => '```\ntouch ' + m + '\n```', m => 'touch ' + m],
    ['a backslash in front of a quote', m => `x\\" & touch ${m} #`, m => `x\\" & touch ${m} #`],
    ['a background operator', m => `x & touch ${m} &`, m => `x & touch ${m} &`],
    ['an ampersand in ordinary text', () => 'feat: R&D dashboard', () => 'feat: R&D dashboard'],
    ['a reply that is one inline code span', m => '`touch ' + m + '`', m => 'touch ' + m],
    ['a subshell', m => '$(touch ' + m + ')', () => ''],
  ];

  it.each(cases)('%s is passed on as plain text', async (_label, reply, expected) => {
    const skill: Skill = {
      name: 'print-prev', description: 'd', category: 'custom',
      steps: [
        { type: 'prompt', content: 'p' },
        { type: 'command', content: 'printf "%s" "${_prev}"' },
      ],
    };
    let printed: string | null = null;
    const { callbacks } = recordingCallbacks(reply(marker), {
      onCommand: async (cmd) => {
        const proc = spawnSync(cmd, { shell: true, cwd: dir, encoding: 'utf-8' });
        if (proc.status !== 0) throw new Error(proc.stderr || `exit ${proc.status}`);
        printed = proc.stdout;
        return proc.stdout;
      },
    });
    const result = await executeSkill(skill, {}, callbacks);
    expect(realFs.existsSync(marker)).toBe(false);
    expect(result.success).toBe(true);
    expect(printed).toBe(expected(marker));
  });
});

// ─── loadCustomSkills — hand-edited files ────────────────────────────────────

describe('custom skills with a malformed file alongside', () => {
  const files: Record<string, string> = {
    'deploy-staging.json': JSON.stringify({ nmae: 'deploy-staging', description: 'Deploy', steps: [] }),
    'null-name.json': JSON.stringify({ name: null, description: 'x', steps: [] }),
    'array.json': '[]',
    'no-steps.json': JSON.stringify({ name: 'no-steps', description: 'x' }),
    'lint-all.json': JSON.stringify({
      name: 'lint-all',
      description: 'Lint every package',
      steps: [{ type: 'command', content: 'npm run lint --workspaces' }],
    }),
  };
  const mockReaddir = readdirSync as unknown as ReturnType<typeof vi.fn>;
  const mockReadFile = readFileSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockReaddir.mockImplementation(() => Object.keys(files));
    mockReadFile.mockImplementation((p: string) => files[basename(p)] ?? '');
  });
  afterEach(() => {
    mockReaddir.mockImplementation(() => []);
    mockReadFile.mockImplementation(() => '');
  });

  it('still finds the valid custom skill', () => {
    expect(findSkill('lint-all')?.name).toBe('lint-all');
  });

  it('still reports an unknown name as not found', () => {
    expect(findSkill('notacommand')).toBeNull();
  });

  it('leaves search working and drops the malformed entries', () => {
    const names = searchSkills('').map(s => s.name);
    expect(names).toContain('lint-all');
    expect(names).not.toContain('no-steps');
  });

  it('keeps skill chains that use a custom skill working', () => {
    expect(parseSkillChain('lint-all+commit')?.skills).toEqual(['lint-all', 'commit']);
  });
});

// ─── /commit with a message ──────────────────────────────────────────────────

import { formatSkillHelp } from './skills';

describe('/commit with a message of its own', () => {
  it('commits that message without asking the model for one', async () => {
    const commit = findSkill('commit')!;
    const onPrompt = vi.fn(async () => 'feat(auth): add token refresh');
    const { commands, callbacks } = recordingCallbacks('unused', { onPrompt });
    const result = await executeSkill(commit, parseSkillArgs('"fix: my explicit message"', commit), callbacks);
    expect(result.success).toBe(true);
    expect(onPrompt).not.toHaveBeenCalled();
    expect(commands[commands.length - 1]).toBe('git add -A && git commit -m "fix: my explicit message"');
  });

  it('still asks for confirmation before committing it', async () => {
    const commit = findSkill('commit')!;
    const onConfirm = vi.fn(async () => false);
    const { commands, callbacks } = recordingCallbacks('unused', { onConfirm });
    const result = await executeSkill(commit, parseSkillArgs('fix: typo', commit), callbacks);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(commands.some(c => c.includes('git commit'))).toBe(false);
  });

  it('keeps the message as typed, escaped for the quotes around it', async () => {
    const commit = findSkill('commit')!;
    const { commands, callbacks } = recordingCallbacks('unused');
    await executeSkill(commit, parseSkillArgs('fix: R&D costs $5; see `x`', commit), callbacks);
    expect(commands[commands.length - 1]).toBe('git add -A && git commit -m "fix: R&D costs \\$5; see \\`x\\`"');
  });

  it('says in /skill help which step the message replaces', () => {
    expect(formatSkillHelp(findSkill('commit')!)).toContain('AI Analysis (skipped when message is given)');
  });
});

describe('a parameter that replaces a step, handed to a real shell', () => {
  let dir: string;
  let marker: string;
  let realFs: typeof import('fs');

  beforeAll(async () => {
    realFs = await vi.importActual<typeof import('fs')>('fs');
    dir = realFs.mkdtempSync(join(tmpdir(), 'codeep-skill-param-'));
    marker = join(dir, 'pwned');
  });
  afterEach(() => { realFs.rmSync(marker, { force: true }); });
  afterAll(() => { realFs.rmSync(dir, { recursive: true, force: true }); });

  it('reaches the shell as exactly the text the user typed', async () => {
    const skill: Skill = {
      name: 'print-text', description: 'd', category: 'custom',
      parameters: [{ name: 'text', description: 't' }],
      steps: [
        { type: 'prompt', content: 'p', skipIf: 'text' },
        { type: 'command', content: 'printf "%s" "${_prev}"' },
      ],
    };
    let printed: string | null = null;
    const { callbacks } = recordingCallbacks('unused', {
      onCommand: async (cmd) => {
        const proc = spawnSync(cmd, { shell: true, cwd: dir, encoding: 'utf-8' });
        if (proc.status !== 0) throw new Error(proc.stderr || `exit ${proc.status}`);
        printed = proc.stdout;
        return proc.stdout;
      },
    });
    const text = `say "hi" \`touch ${marker}\` $(touch ${marker}) \${HOME} costs $5; a | b & R&D \\`;
    const result = await executeSkill(skill, { text }, callbacks);
    expect(realFs.existsSync(marker)).toBe(false);
    expect(result.success).toBe(true);
    expect(printed).toBe(text);
  });
});

// ─── long model replies ──────────────────────────────────────────────────────

describe('a very long model reply handed to a command', () => {
  const printSkill: Skill = {
    name: 'print-prev', description: 'd', category: 'custom',
    steps: [
      { type: 'prompt', content: 'p' },
      { type: 'command', content: 'printf "%s" "${_prev}"' },
    ],
  };

  async function timed(reply: string) {
    const { commands, callbacks } = recordingCallbacks(reply);
    const started = performance.now();
    await executeSkill(printSkill, {}, callbacks);
    return { command: commands[0], ms: performance.now() - started };
  }

  it('an unclosed code fence is handled in linear time, first 8 KB only', async () => {
    const { command, ms } = await timed('```' + 'a'.repeat(300_000));
    expect(ms).toBeLessThan(1000);
    expect(command).toBe(`printf "%s" "${'a'.repeat(8192 - 3)}"`);
  });

  it('a run of unclosed $( is handled in linear time', async () => {
    const { command, ms } = await timed('$('.repeat(100_000));
    expect(ms).toBeLessThan(1000);
    expect(command).toBe(`printf "%s" "${'\\$('.repeat(4096)}"`);
  });
});

// ─── skipped custom skill files ──────────────────────────────────────────────

import {
  getSkippedCustomSkills,
  formatSkippedCustomSkills,
  customSkillFileExists,
  deleteCustomSkill,
  clearSkillHistory,
  formatSkillsList,
  getAllSkills,
} from './skills';
import { existsSync, unlinkSync } from 'fs';
import { logger } from './logger';

describe('custom skill files that do not load', () => {
  const files: Record<string, string> = {};
  const mockReaddir = readdirSync as unknown as ReturnType<typeof vi.fn>;
  const mockReadFile = readFileSync as unknown as ReturnType<typeof vi.fn>;
  const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of Object.keys(files)) delete files[k];
    Object.assign(files, {
      'deploy-staging.json': JSON.stringify({ nmae: 'deploy-staging', description: 'Deploy', steps: [] }),
      'typo.json': '{ "name": "typo", ',
      'lint-all.json': JSON.stringify({ name: 'lint-all', description: 'Lint', steps: [] }),
    });
    mockReaddir.mockImplementation(() => Object.keys(files));
    mockReadFile.mockImplementation((p: string) => files[basename(p)] ?? '');
  });
  afterEach(() => {
    mockReaddir.mockImplementation(() => []);
    mockReadFile.mockImplementation(() => '');
    mockExists.mockImplementation(() => false);
    getAllSkills();
  });

  it('are listed with what is wrong with each', () => {
    expect(findSkill('deploy-staging')).toBeNull();
    expect(getSkippedCustomSkills()).toEqual([
      { file: 'deploy-staging.json', problem: 'needs a string "name" and "description" and a "steps" array' },
      { file: 'typo.json', problem: 'not valid JSON' },
    ]);
  });

  it('are named by path in the message', () => {
    findSkill('x');
    const text = formatSkippedCustomSkills(getSkippedCustomSkills());
    expect(text).toContain('Skipped ~/.codeep/skills/deploy-staging.json — needs a string "name"');
    expect(text).toContain('Skipped ~/.codeep/skills/typo.json — not valid JSON');
  });

  it('show up in the skills list', () => {
    const list = formatSkillsList(getAllSkills());
    expect(list).toContain('## Not loaded');
    expect(list).toContain('~/.codeep/skills/typo.json');
  });

  it('drop out of the list once fixed', () => {
    findSkill('x');
    files['typo.json'] = JSON.stringify({ name: 'typo', description: 'fixed', steps: [] });
    delete files['deploy-staging.json'];
    expect(findSkill('typo')?.description).toBe('fixed');
    expect(getSkippedCustomSkills()).toEqual([]);
    expect(formatSkillsList(getAllSkills())).not.toContain('Not loaded');
  });

  it('are logged once, not on every lookup', () => {
    files['logged-once.json'] = '[';
    findSkill('a'); findSkill('b'); findSkill('c');
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn.mock.calls.filter(([m]) => String(m).includes('logged-once.json'))).toHaveLength(1);
  });

  it('that cannot be read are told apart from bad JSON', () => {
    mockReadFile.mockImplementation((p: string) => {
      if (basename(p) === 'locked.json') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return files[basename(p)] ?? '';
    });
    files['locked.json'] = '';
    findSkill('x');
    expect(getSkippedCustomSkills()).toContainEqual({ file: 'locked.json', problem: 'could not be read' });
  });

  it('still count as existing, so nothing writes over them', () => {
    mockExists.mockImplementation((p: string) => basename(p) in files);
    expect(customSkillFileExists('deploy-staging')).toBe(true);
    expect(customSkillFileExists('brand-new')).toBe(false);
  });
});

describe('deleting skill files', () => {
  const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;
  const mockUnlink = unlinkSync as unknown as ReturnType<typeof vi.fn>;
  afterEach(() => { mockExists.mockImplementation(() => false); mockUnlink.mockReset(); });

  it('/skill delete removes the file', () => {
    mockExists.mockImplementation(() => true);
    expect(deleteCustomSkill('old-skill')).toBe(true);
    expect(mockUnlink).toHaveBeenCalledWith(join('/home/test', '.codeep', 'skills', 'old-skill.json'));
  });

  it('clearing the history removes its file', () => {
    mockExists.mockImplementation(() => true);
    clearSkillHistory();
    expect(mockUnlink).toHaveBeenCalledWith(join('/home/test', '.codeep', 'skill-history.json'));
  });
});

// ─── skill names that leave ~/.codeep/skills ─────────────────────────────────

import { saveCustomSkill, createSkillTemplate } from './skills';
import { writeFileSync } from 'fs';

describe('a skill name that points outside ~/.codeep/skills', () => {
  const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;
  const mockUnlink = unlinkSync as unknown as ReturnType<typeof vi.fn>;
  const mockWrite = writeFileSync as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => { mockExists.mockImplementation(() => true); });
  afterEach(() => {
    mockExists.mockImplementation(() => false);
    mockUnlink.mockReset();
    mockWrite.mockReset();
  });

  const outside = ['../mcp_servers', '../../.ssh/config', '..\\mcp_servers', 'a/b', '/etc/x', '', '   ', 'x\u0000y'];

  it.each(outside)('%j is not deleted', (name) => {
    expect(deleteCustomSkill(name)).toBe(false);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it.each(outside)('%j is not written', (name) => {
    expect(() => saveCustomSkill(createSkillTemplate(name))).toThrow(/not allowed/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it.each(outside)('%j is not reported as an existing skill file', (name) => {
    expect(customSkillFileExists(name)).toBe(false);
  });

  it('a hand-made file with capitals and underscores can still be deleted', () => {
    expect(deleteCustomSkill('Deploy_Staging')).toBe(true);
    expect(mockUnlink).toHaveBeenCalledWith(join('/home/test', '.codeep', 'skills', 'Deploy_Staging.json'));
  });

  it('a valid name is still written to the skills folder', () => {
    saveCustomSkill(createSkillTemplate('deploy-staging'));
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toBe(join('/home/test', '.codeep', 'skills', 'deploy-staging.json'));
  });
});

// ─── /commit: what the user approves is what gets committed ──────────────────

describe('/commit shows the message it will commit', () => {
  const commit = () => findSkill('commit')!;

  it('keeps word=value inside a typed message', async () => {
    const params = parseSkillArgs('fix: set retries=3 by default', commit());
    expect(params).toEqual({ message: 'fix: set retries=3 by default' });
    const onConfirm = vi.fn(async () => true);
    const { commands, callbacks } = recordingCallbacks('unused', { onConfirm });
    await executeSkill(commit(), params, callbacks);
    expect(onConfirm).toHaveBeenCalledWith('Commit with this message? fix: set retries=3 by default');
    expect(commands[commands.length - 1]).toBe('git add -A && git commit -m "fix: set retries=3 by default"');
  });

  it('still takes message=... as the message', () => {
    expect(parseSkillArgs('message="feat: add key=value parsing"', commit())).toEqual({ message: 'feat: add key=value parsing' });
    expect(parseSkillArgs('feat: add key=value parsing', commit())).toEqual({ message: 'feat: add key=value parsing' });
  });

  it('shows the generated message as it will be committed, not the raw reply', async () => {
    const onConfirm = vi.fn(async () => true);
    const { commands, callbacks } = recordingCallbacks('```\nfix(api): retry on 429\n```\nThis follows the format.', { onConfirm });
    await executeSkill(commit(), {}, callbacks);
    expect(onConfirm).toHaveBeenCalledWith('Commit with this message? fix(api): retry on 429');
    expect(commands[commands.length - 1]).toBe('git add -A && git commit -m "fix(api): retry on 429"');
  });

  it('a confirm step that is not right before a ${_prev} command still gets the raw output', async () => {
    const skill: Skill = {
      name: 'show-raw', description: 'd', category: 'custom',
      steps: [
        { type: 'prompt', content: 'p' },
        { type: 'confirm', content: 'Output: ${_prev}' },
        { type: 'command', content: 'echo done' },
      ],
    };
    const onConfirm = vi.fn(async () => true);
    const { callbacks } = recordingCallbacks('line one $HOME\nline two', { onConfirm });
    await executeSkill(skill, {}, callbacks);
    expect(onConfirm).toHaveBeenCalledWith('Output: line one $HOME\nline two');
  });
});

describe('parseSkillArgs — word=value that is not a parameter', () => {
  it('a skill without parameters still takes every key=value', () => {
    const skill: Skill = { name: 'deploy', description: 'd', category: 'custom', steps: [] };
    expect(parseSkillArgs('env=prod region="eu west"', skill)).toEqual({ env: 'prod', region: 'eu west' });
  });

  it('an unknown key=value does not replace a parameter given by name', () => {
    const skill: Skill = {
      name: 'gen', description: 'd', category: 'custom', steps: [],
      parameters: [{ name: 'file', description: 'f' }],
    };
    expect(parseSkillArgs('file=src/a.ts verbose=1', skill)).toEqual({ file: 'src/a.ts' });
  });

  it('key=value inside a word is not a parameter', () => {
    const skill: Skill = {
      name: 'gen', description: 'd', category: 'custom', steps: [],
      parameters: [{ name: 'message', description: 'm' }],
    };
    expect(parseSkillArgs('fix: re-message=1', skill)).toEqual({ message: 'fix: re-message=1' });
  });
});

// ─── Windows: skill commands run through cmd.exe ─────────────────────────────

/** The parts of a command line cmd.exe reads outside double quotes: every `"` toggles quoting. */
function cmdUnquoted(cmd: string): { text: string; endsQuoted: boolean } {
  let text = '';
  let quoted = false;
  for (const ch of cmd) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted) text += ch;
  }
  return { text, endsQuoted: quoted };
}

async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('skill commands on Windows', () => {
  const commitTemplateOutside = 'git add -A && git commit -m ';

  async function commitWith(reply: string, params: Record<string, string> = {}, platform: NodeJS.Platform = 'win32') {
    const onConfirm = vi.fn(async (_message: string) => true);
    const { commands, callbacks } = recordingCallbacks(reply, { onConfirm });
    await onPlatform(platform, () => executeSkill(findSkill('commit')!, params, callbacks));
    return { command: commands[commands.length - 1], confirmed: onConfirm.mock.calls[0]?.[0] as string | undefined };
  }

  it.each([
    ['a quote that closes the string', 'x" & calc.exe & "'],
    ['a redirect after a quote', 'x" > important.txt'],
    ['a pipe and a caret', 'x" | calc ^& "'],
    ['a backslash before a quote', 'x\\" & calc.exe'],
    ['an environment variable', 'fix: leak %GITHUB_TOKEN%'],
  ])('model output with %s stays inside the quotes', async (_label, reply) => {
    const { command, confirmed } = await commitWith(reply);
    const { text, endsQuoted } = cmdUnquoted(command!);
    expect(text).toBe(commitTemplateOutside);
    expect(endsQuoted).toBe(false);
    const message = command!.slice(commitTemplateOutside.length + 1, -1);
    expect(message).not.toMatch(/[%&|<>^"]/);
    expect(confirmed).toBe(`Commit with this message? ${message}`);
  });

  it('model output loses what cmd.exe acts on, and gets no sh escapes', async () => {
    const { command } = await commitWith('feat: R&D costs 50% "more" <x> a^b \\n');
    expect(command).toBe('git add -A && git commit -m "feat: RD costs 50 more x ab \\n"');
  });

  it('a trailing backslash does not escape the closing quote', async () => {
    const { command, confirmed } = await commitWith('fix: path C:\\temp\\');
    expect(command).toBe('git add -A && git commit -m "fix: path C:\\temp\\\\"');
    expect(confirmed).toBe('Commit with this message? fix: path C:\\temp\\');
  });

  it('a typed message keeps & and $ and loses only " and %', async () => {
    const { command, confirmed } = await commitWith('unused', { message: 'fix: R&D costs $5, "quoted" & 50% <done>' });
    expect(command).toBe('git add -A && git commit -m "fix: R&D costs $5, quoted & 50 <done>"');
    expect(cmdUnquoted(command!).text).toBe(commitTemplateOutside);
    expect(confirmed).toBe('Commit with this message? fix: R&D costs $5, quoted & 50 <done>');
  });

  it('outside Windows the same reply is escaped for sh as before', async () => {
    const { command } = await commitWith('x" & calc.exe & "', {}, 'linux');
    expect(command).toBe('git add -A && git commit -m "x\\" & calc.exe & \\""');
    const typed = await commitWith('unused', { message: 'fix: R&D costs $5' }, 'darwin');
    expect(typed.command).toBe('git add -A && git commit -m "fix: R&D costs \\$5"');
    expect(typed.confirmed).toBe('Commit with this message? fix: R&D costs $5');
  });
});

// ─── the (unused) create wizard ──────────────────────────────────────────────

import { WIZARD_STEPS } from './skills';

describe('WIZARD_STEPS name check', () => {
  const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;
  afterEach(() => { mockExists.mockImplementation(() => false); });

  it('refuses a name whose file exists but does not load', () => {
    mockExists.mockImplementation((p: string) => basename(p) === 'deploy-staging.json');
    const validate = WIZARD_STEPS.find(s => s.field === 'name')!.validate!;
    expect(validate('deploy-staging')).toBe('A skill with this name already exists.');
    expect(validate('brand-new')).toBeNull();
  });
});
