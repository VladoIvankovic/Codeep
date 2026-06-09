import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

import { existsSync, readFileSync } from 'fs';
import { loadReviewConfig, globToRegExp } from './reviewConfig';

const mockExists = existsSync as ReturnType<typeof vi.fn>;
const mockRead = readFileSync as ReturnType<typeof vi.fn>;

// Path-aware fs mock: existsSync is true only for the target config file, so
// the loader's .yml > .yaml > .json candidate search is exercised honestly.
function withConfig(obj: unknown, ext: 'json' | 'yml' | 'yaml' = 'json') {
  const target = `.codeep/review.${ext}`;
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  mockExists.mockImplementation((p: string) => p.endsWith(target));
  mockRead.mockImplementation((p: string) => {
    if (!p.endsWith(target)) throw new Error('ENOENT ' + p);
    return body;
  });
}

describe('globToRegExp', () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('* matches within a single segment, not across slashes', () => {
    expect(m('*.md', 'README.md')).toBe(true);
    expect(m('*.md', 'docs/README.md')).toBe(false);
    expect(m('src/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/sub/a.ts')).toBe(false);
  });

  it('** matches across directory segments', () => {
    expect(m('src/**', 'src/a.ts')).toBe(true);
    expect(m('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(m('src/**', 'other/a.ts')).toBe(false);
    expect(m('vendor/**', 'vendor/x/y.js')).toBe(true);
  });

  it('**/ matches zero or more leading directories', () => {
    expect(m('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(m('**/*.test.ts', 'src/deep/a.test.ts')).toBe(true);
    expect(m('**/*.test.ts', 'src/a.ts')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    expect(m('a.b', 'a.b')).toBe(true);
    expect(m('a.b', 'axb')).toBe(false); // the dot is literal, not "any char"
  });
});

describe('loadReviewConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns null when the file does not exist', () => {
    mockExists.mockReturnValue(false);
    expect(loadReviewConfig('/proj')).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    withConfig('{ not json');
    expect(loadReviewConfig('/proj')).toBeNull();
  });

  it('returns null when the top level is not an object', () => {
    withConfig([1, 2, 3]);
    expect(loadReviewConfig('/proj')).toBeNull();
  });

  it('parses disable / include / exclude', () => {
    withConfig({ disable: ['eval-usage', 'todo-comment'], include: ['src/**'], exclude: ['vendor/**'] });
    const cfg = loadReviewConfig('/proj')!;
    expect(cfg.disabled.has('eval-usage')).toBe(true);
    expect(cfg.disabled.has('todo-comment')).toBe(true);
    expect(cfg.include).toEqual(['src/**']);
    expect(cfg.exclude).toEqual(['vendor/**']);
  });

  it('compiles a valid custom rule with defaults', () => {
    withConfig({ rules: [{ id: 'no-foo', pattern: 'foo', message: 'no foo' }] });
    const cfg = loadReviewConfig('/proj')!;
    expect(cfg.rules).toHaveLength(1);
    const r = cfg.rules[0];
    expect(r.id).toBe('no-foo');
    expect(r.message).toBe('no foo');
    expect(r.category).toBe('best-practice'); // default
    expect(r.severity).toBe('warning');       // default
    expect(r.pattern.flags).toContain('g');   // global always added
    expect(r.pattern.test('foo')).toBe(true);
  });

  it('honors category/severity/flags/extensions/suggestion when valid', () => {
    withConfig({ rules: [{ id: 'x', pattern: 'bar', flags: 'i', category: 'security', severity: 'error', message: 'm', suggestion: 's', extensions: ['.ts'] }] });
    const r = loadReviewConfig('/proj')!.rules[0];
    expect(r.category).toBe('security');
    expect(r.severity).toBe('error');
    expect(r.pattern.flags).toContain('i');
    expect(r.pattern.flags).toContain('g'); // g forced even if user only gave 'i'
    expect(r.suggestion).toBe('s');
    expect(r.extensions).toEqual(['.ts']);
    expect(r.pattern.test('BAR')).toBe(true); // case-insensitive
  });

  it('skips rules missing id, pattern, or message', () => {
    withConfig({ rules: [
      { pattern: 'a', message: 'm' },     // no id
      { id: 'b', message: 'm' },          // no pattern
      { id: 'c', pattern: 'a' },          // no message
      { id: 'ok', pattern: 'a', message: 'm' },
    ] });
    const cfg = loadReviewConfig('/proj')!;
    expect(cfg.rules.map((r) => r.id)).toEqual(['ok']);
  });

  it('skips a rule with an invalid regex without throwing', () => {
    withConfig({ rules: [{ id: 'bad', pattern: '([', message: 'm' }, { id: 'good', pattern: 'x', message: 'm' }] });
    const cfg = loadReviewConfig('/proj')!;
    expect(cfg.rules.map((r) => r.id)).toEqual(['good']);
  });

  it('falls back to defaults for invalid category/severity', () => {
    withConfig({ rules: [{ id: 'x', pattern: 'a', message: 'm', category: 'bogus', severity: 'nope' }] });
    const r = loadReviewConfig('/proj')!.rules[0];
    expect(r.category).toBe('best-practice');
    expect(r.severity).toBe('warning');
  });

  it('skips patterns with nested quantifiers (ReDoS screen)', () => {
    withConfig({ rules: [
      { id: 'redos1', pattern: '(a+)+', message: 'm' },
      { id: 'redos2', pattern: '(.*)+', message: 'm' },
      { id: 'redos3', pattern: '(\\d+){2,}', message: 'm' },
      { id: 'ok', pattern: 'foo\\(', message: 'm' },
    ] });
    expect(loadReviewConfig('/proj')!.rules.map((r) => r.id)).toEqual(['ok']);
  });

  it('skips an over-long pattern', () => {
    withConfig({ rules: [{ id: 'long', pattern: 'a'.repeat(1001), message: 'm' }] });
    expect(loadReviewConfig('/proj')!.rules).toHaveLength(0);
  });
});

describe('loadReviewConfig — YAML', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const YAML = [
    'disable:',
    '  - eval-usage',
    'include:',
    "  - 'src/**'",
    'rules:',
    '  - id: no-foo',
    "    pattern: 'foo\\('",   // single-quoted YAML keeps the backslash literal
    '    severity: error',
    '    message: Avoid foo()',
  ].join('\n');

  it('parses .codeep/review.yml', () => {
    withConfig(YAML, 'yml');
    const cfg = loadReviewConfig('/proj')!;
    expect(cfg).not.toBeNull();
    expect(cfg.disabled.has('eval-usage')).toBe(true);
    expect(cfg.include).toEqual(['src/**']);
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0].id).toBe('no-foo');
    expect(cfg.rules[0].severity).toBe('error');
    expect(cfg.rules[0].pattern.test('foo(')).toBe(true);
  });

  it('also accepts the .yaml extension', () => {
    withConfig('disable: [todo-comment]\n', 'yaml');
    expect(loadReviewConfig('/proj')!.disabled.has('todo-comment')).toBe(true);
  });

  it('prefers .yml over .json when both exist', () => {
    mockExists.mockImplementation((p: string) => p.endsWith('.yml') || p.endsWith('.json'));
    mockRead.mockImplementation((p: string) => {
      if (p.endsWith('.yml')) return 'disable: [from-yml]\n';
      if (p.endsWith('.json')) return JSON.stringify({ disable: ['from-json'] });
      throw new Error('ENOENT');
    });
    const cfg = loadReviewConfig('/proj')!;
    expect(cfg.disabled.has('from-yml')).toBe(true);
    expect(cfg.disabled.has('from-json')).toBe(false);
  });

  it('returns null on malformed YAML', () => {
    withConfig('rules:\n  - id: x\n   bad: indent\n', 'yml');
    expect(loadReviewConfig('/proj')).toBeNull();
  });
});
