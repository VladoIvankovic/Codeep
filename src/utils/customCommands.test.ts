import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCustomCommands, findCustomCommand, expandCommand, formatCommandList } from './customCommands';

let tmpRoot: string;
let cmdDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codeep-custom-cmds-'));
  cmdDir = join(tmpRoot, '.codeep', 'commands');
  mkdirSync(cmdDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadCustomCommands', () => {
  it('returns empty array when workspace has no commands dir', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'codeep-empty-'));
    try {
      expect(loadCustomCommands(fresh)).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('loads a single command with no frontmatter', () => {
    writeFileSync(join(cmdDir, 'hello.md'), 'Say hello to {{args}}');
    const cmds = loadCustomCommands(tmpRoot);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('hello');
    expect(cmds[0].scope).toBe('project');
    expect(cmds[0].body).toBe('Say hello to {{args}}');
    expect(cmds[0].description).toBe('Custom project command');
  });

  it('parses frontmatter description and aliases', () => {
    writeFileSync(
      join(cmdDir, 'sec-review.md'),
      '---\ndescription: Security review\naliases: [sec, secrev]\n---\n\nReview {{args}}',
    );
    const cmds = loadCustomCommands(tmpRoot);
    expect(cmds[0].description).toBe('Security review');
    expect(cmds[0].aliases).toEqual(['sec', 'secrev']);
    expect(cmds[0].body).toBe('Review {{args}}');
  });

  it('skips non-md files', () => {
    writeFileSync(join(cmdDir, 'good.md'), 'good');
    writeFileSync(join(cmdDir, 'readme.txt'), 'ignored');
    writeFileSync(join(cmdDir, 'config.json'), '{}');
    const cmds = loadCustomCommands(tmpRoot);
    expect(cmds.map(c => c.name)).toEqual(['good']);
  });

  it('rejects names that are not valid slash-command identifiers', () => {
    writeFileSync(join(cmdDir, 'has spaces.md'), 'x');
    writeFileSync(join(cmdDir, 'CAPS.md'), 'x');           // becomes "caps" — valid
    writeFileSync(join(cmdDir, '_leading.md'), 'x');       // invalid
    writeFileSync(join(cmdDir, '-leading-dash.md'), 'x');  // invalid
    writeFileSync(join(cmdDir, 'good-name.md'), 'x');
    const cmds = loadCustomCommands(tmpRoot);
    expect(cmds.map(c => c.name).sort()).toEqual(['caps', 'good-name']);
  });

  it('sorts results alphabetically', () => {
    writeFileSync(join(cmdDir, 'zebra.md'), 'z');
    writeFileSync(join(cmdDir, 'alpha.md'), 'a');
    writeFileSync(join(cmdDir, 'mango.md'), 'm');
    const cmds = loadCustomCommands(tmpRoot);
    expect(cmds.map(c => c.name)).toEqual(['alpha', 'mango', 'zebra']);
  });
});

describe('findCustomCommand', () => {
  beforeEach(() => {
    writeFileSync(
      join(cmdDir, 'deploy.md'),
      '---\ndescription: Deploy\naliases: [ship, release-it]\n---\n\nDeploy {{args}}',
    );
  });

  it('finds by primary name', () => {
    expect(findCustomCommand('deploy', tmpRoot)?.name).toBe('deploy');
  });

  it('finds by alias', () => {
    expect(findCustomCommand('ship', tmpRoot)?.name).toBe('deploy');
    expect(findCustomCommand('release-it', tmpRoot)?.name).toBe('deploy');
  });

  it('is case-insensitive', () => {
    expect(findCustomCommand('DEPLOY', tmpRoot)?.name).toBe('deploy');
    expect(findCustomCommand('Ship', tmpRoot)?.name).toBe('deploy');
  });

  it('returns null for unknown names', () => {
    expect(findCustomCommand('nonsense', tmpRoot)).toBeNull();
  });
});

describe('expandCommand', () => {
  const cmd = {
    name: 'test',
    description: 'd',
    body: '',
    source: '',
    scope: 'project' as const,
    aliases: [],
  };

  it('replaces {{args}} placeholder', () => {
    expect(expandCommand({ ...cmd, body: 'Review {{args}}' }, ['src/api.ts'])).toBe('Review src/api.ts');
  });

  it('replaces $ARGUMENTS placeholder (Claude Code compat)', () => {
    expect(expandCommand({ ...cmd, body: 'Look at $ARGUMENTS' }, ['foo', 'bar'])).toBe('Look at foo bar');
  });

  it('replaces positional {{arg1}} {{arg2}}', () => {
    expect(expandCommand({ ...cmd, body: 'Move {{arg1}} to {{arg2}}' }, ['a.ts', 'b.ts']))
      .toBe('Move a.ts to b.ts');
  });

  it('leaves unfilled positionals empty', () => {
    expect(expandCommand({ ...cmd, body: 'A={{arg1}} B={{arg2}}' }, ['only-one']))
      .toBe('A=only-one B=');
  });

  it('appends args when no placeholders and args were given', () => {
    expect(expandCommand({ ...cmd, body: 'Run security check' }, ['file.ts']))
      .toBe('Run security check\n\nfile.ts');
  });

  it('does not append args when no placeholders and no args', () => {
    expect(expandCommand({ ...cmd, body: 'Run security check' }, []))
      .toBe('Run security check');
  });

  it('does not append args when placeholder already consumed them', () => {
    expect(expandCommand({ ...cmd, body: 'Review {{args}}' }, ['x.ts']))
      .toBe('Review x.ts');
  });
});

describe('formatCommandList', () => {
  it('shows guidance when there are no commands', () => {
    const md = formatCommandList([]);
    expect(md).toMatch(/No custom commands yet/);
    expect(md).toMatch(/\.codeep\/commands/);
  });

  it('groups by scope and lists aliases', () => {
    const md = formatCommandList([
      { name: 'one', description: 'first', body: '', source: '', scope: 'project', aliases: ['1'] },
      { name: 'two', description: 'second', body: '', source: '', scope: 'global', aliases: [] },
    ]);
    expect(md).toMatch(/\*\*Project\*\*[\s\S]*\/one[\s\S]*aliases.*\/1/);
    expect(md).toMatch(/\*\*Global\*\*[\s\S]*\/two/);
  });
});
