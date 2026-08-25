import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() };
});
// No git in the specific-files path, but mock it so the import is inert.
vi.mock('./git', () => ({ getChangedFiles: vi.fn(() => []), getGitDiff: vi.fn(() => '') }));

import { existsSync, readFileSync } from 'fs';
import { performCodeReview, listBuiltinRules } from './codeReview';

const mockExists = existsSync as ReturnType<typeof vi.fn>;
const mockRead = readFileSync as ReturnType<typeof vi.fn>;

const ROOT = '/proj';
const ctx = { root: ROOT } as Parameters<typeof performCodeReview>[0];

/** Wire fs so .codeep/review.json returns `config` and each source file returns its content. */
function setup(config: unknown | null, files: Record<string, string>) {
  mockExists.mockImplementation((p: string) => {
    if (p.endsWith('.codeep/review.json')) return config !== null;
    return Object.keys(files).some((f) => p.endsWith(f));
  });
  mockRead.mockImplementation((p: string) => {
    if (p.endsWith('.codeep/review.json')) return JSON.stringify(config);
    const hit = Object.keys(files).find((f) => p.endsWith(f));
    if (hit) return files[hit];
    throw new Error('ENOENT ' + p);
  });
}

describe('performCodeReview with .codeep/review.json', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('applies a custom rule from the config', () => {
    setup(
      { rules: [{ id: 'no-foo', pattern: 'foo\\(', message: 'Do not call foo()', severity: 'error', category: 'bug' }] },
      { 'a.ts': 'const x = foo();\n' },
    );
    const result = performCodeReview(ctx, ['a.ts']);
    const custom = result.issues.find((i) => i.message === 'Do not call foo()');
    expect(custom).toBeDefined();
    expect(custom!.severity).toBe('error');
    expect(custom!.category).toBe('bug');
  });

  it('disables a built-in rule by id', () => {
    const content = '// TODO: fix this later\n';
    // Without disable → the todo-comment built-in fires.
    setup(null, { 'a.ts': content });
    const withRule = performCodeReview(ctx, ['a.ts']);
    expect(withRule.issues.some((i) => i.message.includes('TODO/FIXME'))).toBe(true);

    // With disable → it's gone.
    setup({ disable: ['todo-comment'] }, { 'a.ts': content });
    const without = performCodeReview(ctx, ['a.ts']);
    expect(without.issues.some((i) => i.message.includes('TODO/FIXME'))).toBe(false);
  });

  it('excludes files matching an exclude glob', () => {
    setup(
      { exclude: ['**/*.test.ts'] },
      { 'a.test.ts': '// TODO: x\n', 'b.ts': '// TODO: y\n' },
    );
    const result = performCodeReview(ctx, ['a.test.ts', 'b.ts']);
    expect(result.files).toContain('b.ts');
    expect(result.files).not.toContain('a.test.ts');
  });

  it('with an include glob, reviews only matching files', () => {
    setup(
      { include: ['src/**'] },
      { 'src/a.ts': '// TODO: x\n', 'other/b.ts': '// TODO: y\n' },
    );
    const result = performCodeReview(ctx, ['src/a.ts', 'other/b.ts']);
    expect(result.files).toContain('src/a.ts');
    expect(result.files).not.toContain('other/b.ts');
  });

  it('still works (built-ins only) when no config is present', () => {
    setup(null, { 'a.ts': 'eval("x")\n' });
    const result = performCodeReview(ctx, ['a.ts']);
    expect(result.issues.some((i) => i.message.includes('eval()'))).toBe(true);
  });

  it('terminates on a zero-width custom rule instead of hanging', () => {
    // `a?` matches the empty string at every position — without the zero-width
    // lastIndex guard this would loop forever. Must return, bounded.
    setup({ rules: [{ id: 'zw', pattern: 'a?', message: 'zero width' }] }, { 'a.ts': 'bbb\nccc\n' });
    const result = performCodeReview(ctx, ['a.ts']);
    const zw = result.issues.filter((i) => i.message === 'zero width');
    expect(zw.length).toBeGreaterThan(0);
    expect(zw.length).toBeLessThanOrEqual(1000); // capped, never infinite
  });
});

describe('listBuiltinRules', () => {
  it('lists built-in rule ids (incl. the heuristics), all unique and fully populated', () => {
    const rules = listBuiltinRules();
    const ids = rules.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['eval-usage', 'todo-comment', 'any-type', 'long-file', 'long-function']));
    expect(new Set(ids).size).toBe(ids.length); // ids are unique
    expect(rules.every((r) => r.id && r.category && r.severity && r.description)).toBe(true);
  });
});

describe('JavaScript module extensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // Thirteen rules name '.js' in their `extensions` array. `.mjs` and `.cjs`
  // are JavaScript too, and were silently skipped by every one of them —
  // including all four security rules. The action's own scripts are `.mjs`,
  // so its self-review had never applied a security rule to itself.
  it.each(['.mjs', '.cjs'])('applies .js rules to %s files', (ext) => {
    const file = `a${ext}`;
    setup(null, { [file]: 'el.innerHTML = user;\n' });
    const result = performCodeReview(ctx, [file]);
    expect(result.issues.some((i) => i.message.includes('innerHTML'))).toBe(true);
  });

  it('still withholds TypeScript-only rules from .mjs', () => {
    setup(null, { 'a.mjs': 'const x = y as any;\n' });
    const result = performCodeReview(ctx, ['a.mjs']);
    expect(result.issues.some((i) => i.message.includes('any'))).toBe(false);
  });

  it('leaves unrelated extensions alone', () => {
    setup(null, { 'a.py': 'el.innerHTML = user\n' });
    const result = performCodeReview(ctx, ['a.py']);
    expect(result.issues.some((i) => i.message.includes('innerHTML'))).toBe(false);
  });
});

describe('foreach-await', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // The original pattern required the `await` to follow forEach's *closing
  // paren*, which only ever lines up for `function (x) {` — every arrow form,
  // the dominant style, went unreported.
  it.each([
    ['arrow with parens', 'ids.forEach(async (id) => {\n  await save(id);\n});\n'],
    ['arrow without parens', 'ids.forEach(async id => {\n  await save(id);\n});\n'],
    ['single line', 'ids.forEach(async x => { await f(x) });\n'],
    ['await inside an expression', 'ids.forEach(async id => {\n  out.push(await fetch(id));\n});\n'],
    ['await after an assignment', 'ids.forEach(async id => {\n  const r = await fetch(id);\n  use(r);\n});\n'],
    ['function expression', 'ids.forEach(async function (id) {\n  await save(id);\n});\n'],
  ])('flags %s', (_name, code) => {
    setup(null, { 'a.ts': code });
    const result = performCodeReview(ctx, ['a.ts']);
    expect(result.issues.some((i) => i.message.includes('Sequential async'))).toBe(true);
  });

  it.each([
    ['a synchronous forEach', 'ids.forEach(id => {\n  save(id);\n});\n'],
    ['an async callback that never awaits', 'ids.forEach(async id => {\n  fireAndForget(id);\n});\n'],
  ])('leaves %s alone', (_name, code) => {
    setup(null, { 'a.ts': code });
    const result = performCodeReview(ctx, ['a.ts']);
    expect(result.issues.some((i) => i.message.includes('Sequential async'))).toBe(false);
  });
});
