import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn() };
});
// No git in the specific-files path, but mock it so the import is inert.
vi.mock('./git', () => ({ getChangedFiles: vi.fn(() => []), getGitDiff: vi.fn(() => '') }));

import { existsSync, readFileSync } from 'fs';
import { performCodeReview } from './codeReview';

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
