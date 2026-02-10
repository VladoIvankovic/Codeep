import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
import { loadIgnoreRules, isIgnored } from './gitignore';

const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadIgnoreRules', () => {
  it('returns built-in ignores when no .gitignore exists', () => {
    mockExistsSync.mockReturnValue(false);
    const rules = loadIgnoreRules('/project');
    expect(rules.projectRoot).toBe('/project');
    expect(rules.patterns.length).toBeGreaterThan(0);
    // node_modules should be a built-in
    expect(isIgnored('node_modules/foo.js', rules)).toBe(true);
  });

  it('loads .gitignore when it exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('*.log\ntmp/\n');
    const rules = loadIgnoreRules('/project');
    expect(isIgnored('error.log', rules)).toBe(true);
    expect(isIgnored('tmp/cache', rules)).toBe(true);
  });

  it('handles read errors gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    const rules = loadIgnoreRules('/project');
    // Should still have built-in ignores
    expect(rules.patterns.length).toBeGreaterThan(0);
  });
});

describe('isIgnored — built-in ignores', () => {
  let rules: ReturnType<typeof loadIgnoreRules>;

  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
    rules = loadIgnoreRules('/project');
  });

  it('ignores node_modules', () => {
    expect(isIgnored('node_modules/package/index.js', rules)).toBe(true);
    expect(isIgnored('/project/node_modules', rules)).toBe(true);
  });

  it('ignores .git', () => {
    expect(isIgnored('.git/config', rules)).toBe(true);
  });

  it('ignores .codeep', () => {
    expect(isIgnored('.codeep/state.json', rules)).toBe(true);
  });

  it('ignores dist and build', () => {
    expect(isIgnored('dist/bundle.js', rules)).toBe(true);
    expect(isIgnored('build/output.js', rules)).toBe(true);
  });

  it('ignores __pycache__', () => {
    expect(isIgnored('src/__pycache__/module.pyc', rules)).toBe(true);
  });

  it('ignores .next', () => {
    expect(isIgnored('.next/static/chunks/main.js', rules)).toBe(true);
  });

  it('ignores coverage', () => {
    expect(isIgnored('coverage/lcov.info', rules)).toBe(true);
  });

  it('does not ignore regular source files', () => {
    expect(isIgnored('src/index.ts', rules)).toBe(false);
    expect(isIgnored('package.json', rules)).toBe(false);
    expect(isIgnored('README.md', rules)).toBe(false);
  });

  it('does not ignore files that contain ignore names as substrings', () => {
    expect(isIgnored('src/builder.ts', rules)).toBe(false);
    expect(isIgnored('src/distribute.ts', rules)).toBe(false);
  });
});

describe('isIgnored — .gitignore patterns', () => {
  function rulesFrom(gitignore: string) {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(gitignore);
    return loadIgnoreRules('/project');
  }

  it('matches simple file patterns', () => {
    const rules = rulesFrom('*.log');
    expect(isIgnored('error.log', rules)).toBe(true);
    expect(isIgnored('logs/debug.log', rules)).toBe(true);
    expect(isIgnored('error.txt', rules)).toBe(false);
  });

  it('matches directory patterns', () => {
    const rules = rulesFrom('tmp/');
    expect(isIgnored('tmp/file.txt', rules)).toBe(true);
    expect(isIgnored('src/tmp/file.txt', rules)).toBe(true);
  });

  it('matches anchored patterns (leading /)', () => {
    const rules = rulesFrom('/config.local');
    expect(isIgnored('config.local', rules)).toBe(true);
    expect(isIgnored('sub/config.local', rules)).toBe(false);
  });

  it('matches ** glob patterns', () => {
    const rules = rulesFrom('docs/**/*.md');
    expect(isIgnored('docs/readme.md', rules)).toBe(true);
    expect(isIgnored('docs/guides/setup.md', rules)).toBe(true);
    expect(isIgnored('src/readme.md', rules)).toBe(false);
  });

  it('matches ? single char wildcard', () => {
    const rules = rulesFrom('file?.txt');
    expect(isIgnored('file1.txt', rules)).toBe(true);
    expect(isIgnored('fileA.txt', rules)).toBe(true);
    expect(isIgnored('file10.txt', rules)).toBe(false);
  });

  it('matches character classes [...]', () => {
    const rules = rulesFrom('file[0-9].txt');
    expect(isIgnored('file5.txt', rules)).toBe(true);
    expect(isIgnored('fileA.txt', rules)).toBe(false);
  });

  it('handles negation patterns', () => {
    const rules = rulesFrom('*.log\n!important.log');
    expect(isIgnored('error.log', rules)).toBe(true);
    expect(isIgnored('important.log', rules)).toBe(false);
  });

  it('skips comments and empty lines', () => {
    const rules = rulesFrom('# this is a comment\n\n*.tmp');
    expect(isIgnored('file.tmp', rules)).toBe(true);
    expect(isIgnored('# this is a comment', rules)).toBe(false);
  });

  it('handles .env files', () => {
    const rules = rulesFrom('.env\n.env.local\n.env.*.local');
    expect(isIgnored('.env', rules)).toBe(true);
    expect(isIgnored('.env.local', rules)).toBe(true);
    expect(isIgnored('.env.production.local', rules)).toBe(true);
    expect(isIgnored('.env.example', rules)).toBe(false);
  });

  it('handles complex real-world .gitignore', () => {
    const rules = rulesFrom([
      'node_modules/',
      '*.log',
      '.env',
      '/dist',
      '!dist/keep.txt',
      '**/*.map',
    ].join('\n'));

    expect(isIgnored('app.log', rules)).toBe(true);
    expect(isIgnored('.env', rules)).toBe(true);
    expect(isIgnored('dist/bundle.js', rules)).toBe(true);
    expect(isIgnored('src/utils/helper.js.map', rules)).toBe(true);
    expect(isIgnored('src/index.ts', rules)).toBe(false);
  });
});

describe('isIgnored — path normalization', () => {
  let rules: ReturnType<typeof loadIgnoreRules>;

  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('*.log');
    rules = loadIgnoreRules('/project');
  });

  it('handles absolute paths under project root', () => {
    expect(isIgnored('/project/error.log', rules)).toBe(true);
    expect(isIgnored('/project/src/debug.log', rules)).toBe(true);
  });

  it('handles relative paths', () => {
    expect(isIgnored('error.log', rules)).toBe(true);
    expect(isIgnored('src/debug.log', rules)).toBe(true);
  });

  it('returns false for empty path', () => {
    expect(isIgnored('', rules)).toBe(false);
  });
});
