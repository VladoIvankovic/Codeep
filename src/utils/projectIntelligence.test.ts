import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs before importing
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  scanProject,
  saveProjectIntelligence,
  loadProjectIntelligence,
  isIntelligenceFresh,
  generateContextFromIntelligence,
  ProjectIntelligence,
} from './projectIntelligence';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;

// Minimal valid intelligence object for testing generateContextFromIntelligence
function makeIntelligence(overrides: Partial<ProjectIntelligence> = {}): ProjectIntelligence {
  return {
    version: '1.0',
    scannedAt: new Date().toISOString(),
    projectPath: '/project',
    name: 'my-app',
    type: 'TypeScript/Node.js',
    description: 'A test project',
    structure: {
      totalFiles: 42,
      totalDirectories: 8,
      languages: { '.ts': 30, '.js': 5, '.md': 7 },
      topDirectories: ['src', 'tests'],
    },
    dependencies: {
      runtime: ['express'],
      dev: ['vitest'],
      frameworks: ['Express'],
    },
    keyFiles: [{ path: 'README.md', summary: 'Main docs' }],
    entryPoints: ['src/index.ts'],
    scripts: { build: 'tsc', test: 'vitest' },
    architecture: {
      patterns: ['Service-oriented'],
      mainModules: ['src'],
    },
    conventions: {
      indentation: 'spaces',
      quotes: 'single',
      semicolons: true,
      namingStyle: 'camelCase',
    },
    testing: {
      framework: 'Vitest',
      testDirectory: 'tests',
      hasTests: true,
    },
    notes: [],
    ...overrides,
  };
}

// ─── generateContextFromIntelligence ─────────────────────────────────────────

describe('generateContextFromIntelligence', () => {
  it('includes project name and type', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('# Project: my-app');
    expect(output).toContain('Type: TypeScript/Node.js');
  });

  it('includes description when present', () => {
    const output = generateContextFromIntelligence(makeIntelligence({ description: 'Some desc' }));
    expect(output).toContain('Description: Some desc');
  });

  it('omits description when empty', () => {
    const output = generateContextFromIntelligence(makeIntelligence({ description: '' }));
    expect(output).not.toContain('Description:');
  });

  it('shows file and directory counts', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('42 files');
    expect(output).toContain('8 directories');
  });

  it('shows top 5 languages by count', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('TypeScript (30)');
    expect(output).toContain('JavaScript (5)');
    expect(output).toContain('Markdown (7)');
  });

  it('shows main directories', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('src, tests');
  });

  it('shows frameworks section when frameworks present', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('## Frameworks');
    expect(output).toContain('Express');
  });

  it('omits frameworks section when empty', () => {
    const output = generateContextFromIntelligence(makeIntelligence({ dependencies: { runtime: [], dev: [], frameworks: [] } }));
    expect(output).not.toContain('## Frameworks');
  });

  it('shows architecture patterns and modules', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('## Architecture');
    expect(output).toContain('Service-oriented');
    expect(output).toContain('src');
  });

  it('omits architecture section when empty', () => {
    const output = generateContextFromIntelligence(makeIntelligence({
      architecture: { patterns: [], mainModules: [] },
    }));
    expect(output).not.toContain('## Architecture');
  });

  it('shows entry points', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('## Entry Points');
    expect(output).toContain('src/index.ts');
  });

  it('shows available scripts (max 10)', () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 12; i++) scripts[`script${i}`] = `cmd${i}`;
    const output = generateContextFromIntelligence(makeIntelligence({ scripts }));
    expect(output).toContain('## Available Scripts');
    // Only first 10 shown
    expect(output).toContain('script0');
    expect(output).not.toContain('script10');
  });

  it('shows key files', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('## Key Files');
    expect(output).toContain('README.md: Main docs');
  });

  it('shows testing section when hasTests is true', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('## Testing');
    expect(output).toContain('Vitest');
    expect(output).toContain('tests');
  });

  it('omits testing section when hasTests is false', () => {
    const output = generateContextFromIntelligence(makeIntelligence({
      testing: { framework: null, testDirectory: null, hasTests: false },
    }));
    expect(output).not.toContain('## Testing');
  });

  it('shows code conventions', () => {
    const output = generateContextFromIntelligence(makeIntelligence());
    expect(output).toContain('## Code Conventions');
    expect(output).toContain('spaces');
    expect(output).toContain('single');
    expect(output).toContain('yes'); // semicolons: true
    expect(output).toContain('camelCase');
  });

  it('shows notes when present', () => {
    const output = generateContextFromIntelligence(makeIntelligence({ notes: ['Use pnpm', 'No console.log'] }));
    expect(output).toContain('## Notes');
    expect(output).toContain('Use pnpm');
    expect(output).toContain('No console.log');
  });

  it('omits notes section when empty', () => {
    const output = generateContextFromIntelligence(makeIntelligence({ notes: [] }));
    expect(output).not.toContain('## Notes');
  });
});

// ─── saveProjectIntelligence / loadProjectIntelligence ───────────────────────

describe('saveProjectIntelligence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns true and writes file when successful', () => {
    const intel = makeIntelligence();
    const result = saveProjectIntelligence('/project', intel);

    expect(result).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFileSync.mock.calls[0];
    expect(path).toContain('.codeep/intelligence.json');
    const parsed = JSON.parse(content as string);
    expect(parsed.name).toBe('my-app');
  });

  it('creates .codeep dir if it does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    saveProjectIntelligence('/project', makeIntelligence());
    expect(mockMkdirSync).toHaveBeenCalledWith(join('/project', '.codeep'), { recursive: true });
  });

  it('returns false on write error', () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('disk full'); });
    const result = saveProjectIntelligence('/project', makeIntelligence());
    expect(result).toBe(false);
  });
});

describe('loadProjectIntelligence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadProjectIntelligence('/project')).toBeNull();
  });

  it('returns parsed intelligence when file exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(makeIntelligence()));

    const result = loadProjectIntelligence('/project');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-app');
  });

  it('returns null on parse error', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');
    expect(loadProjectIntelligence('/project')).toBeNull();
  });
});

// ─── isIntelligenceFresh ─────────────────────────────────────────────────────

describe('isIntelligenceFresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no intelligence file exists', () => {
    mockExistsSync.mockReturnValue(false);
    expect(isIntelligenceFresh('/project')).toBe(false);
  });

  it('returns true when scanned less than 24 hours ago', () => {
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
    const intel = makeIntelligence({ scannedAt: recentTime });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(intel));

    expect(isIntelligenceFresh('/project')).toBe(true);
  });

  it('returns false when scanned more than 24 hours ago', () => {
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    const intel = makeIntelligence({ scannedAt: oldTime });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(intel));

    expect(isIntelligenceFresh('/project')).toBe(false);
  });

  it('respects custom maxAgeHours parameter', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const intel = makeIntelligence({ scannedAt: twoHoursAgo });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(intel));

    expect(isIntelligenceFresh('/project', 1)).toBe(false);  // 1h limit, 2h old → stale
    expect(isIntelligenceFresh('/project', 3)).toBe(true);   // 3h limit, 2h old → fresh
  });
});

// ─── detectProjectType (via scanProject) ─────────────────────────────────────

describe('detectProjectType via scanProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No files by default
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  });

  it('detects TypeScript Node.js project', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join('/project', 'package.json') || p === join('/project', 'tsconfig.json')
    );
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === join('/project', 'package.json')) {
        return JSON.stringify({
          name: 'my-ts-app',
          description: 'TypeScript app',
          dependencies: { express: '^4.0.0' },
          devDependencies: { vitest: '^1.0.0' },
          scripts: { build: 'tsc' },
          main: 'dist/index.js',
        });
      }
      return '{}';
    });

    const result = await scanProject('/project');
    expect(result.type).toBe('TypeScript/Node.js');
    expect(result.name).toBe('my-ts-app');
    expect(result.description).toBe('TypeScript app');
    expect(result.dependencies.runtime).toContain('express');
    expect(result.dependencies.dev).toContain('vitest');
    expect(result.scripts.build).toBe('tsc');
    expect(result.entryPoints).toContain('dist/index.js');
  });

  it('detects React framework from dependencies', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'package.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({
        name: 'react-app',
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: {},
      })
    );

    const result = await scanProject('/project');
    expect(result.dependencies.frameworks).toContain('React');
  });

  it('detects Python project from requirements.txt', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join('/project', 'requirements.txt')
    );
    mockReadFileSync.mockImplementation(() => 'flask\nrequests\ngunicorn');

    const result = await scanProject('/project');
    expect(result.type).toBe('Python');
    expect(result.dependencies.runtime).toContain('flask');
    expect(result.dependencies.frameworks).toContain('Flask');
  });

  it('detects Django from requirements.txt', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join('/project', 'requirements.txt')
    );
    mockReadFileSync.mockImplementation(() => 'django\npsycopg2');

    const result = await scanProject('/project');
    expect(result.dependencies.frameworks).toContain('Django');
  });

  it('detects Go project from go.mod', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'go.mod'));
    mockReadFileSync.mockImplementation(() => 'module github.com/user/my-go-app\n\ngo 1.21');

    const result = await scanProject('/project');
    expect(result.type).toBe('Go');
    expect(result.name).toBe('my-go-app');
  });

  it('detects Rust project from Cargo.toml', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'Cargo.toml'));
    mockReadFileSync.mockImplementation(() => '[package]\nname = "my-rust-app"\nversion = "0.1.0"');

    const result = await scanProject('/project');
    expect(result.type).toBe('Rust');
    expect(result.name).toBe('my-rust-app');
  });

  it('detects PHP project from composer.json', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'composer.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({ name: 'vendor/my-php-app', description: 'PHP project' })
    );

    const result = await scanProject('/project');
    expect(result.type).toBe('PHP');
    expect(result.name).toBe('my-php-app');
  });

  it('detects Laravel from composer.json', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'composer.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({ require: { 'laravel/framework': '^10.0' } })
    );

    const result = await scanProject('/project');
    expect(result.dependencies.frameworks).toContain('Laravel');
  });

  it('uses bin object entry points', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'package.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({
        name: 'cli-app',
        dependencies: {},
        devDependencies: {},
        bin: { 'my-cli': './bin/cli.js', 'my-other': './bin/other.js' },
      })
    );

    const result = await scanProject('/project');
    expect(result.entryPoints).toContain('./bin/cli.js');
    expect(result.entryPoints).toContain('./bin/other.js');
  });
});

// ─── detectTesting (via scanProject) ─────────────────────────────────────────

describe('detectTesting via scanProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  });

  it('detects Vitest from config file', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join('/project', 'vitest.config.ts')
    );

    const result = await scanProject('/project');
    expect(result.testing.framework).toBe('Vitest');
    expect(result.testing.hasTests).toBe(true);
  });

  it('detects Jest from config file', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join('/project', 'jest.config.js')
    );

    const result = await scanProject('/project');
    expect(result.testing.framework).toBe('Jest');
    expect(result.testing.hasTests).toBe(true);
  });

  it('detects Jest from devDependencies', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'package.json'));
    mockReadFileSync.mockImplementation(() =>
      JSON.stringify({ name: 'app', dependencies: {}, devDependencies: { jest: '^29.0.0' } })
    );

    const result = await scanProject('/project');
    expect(result.testing.framework).toBe('Jest');
  });

  it('detects Pytest from pyproject.toml', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === join('/project', 'pyproject.toml')
    );

    const result = await scanProject('/project');
    expect(result.testing.framework).toBe('Pytest');
    expect(result.testing.hasTests).toBe(true);
  });

  it('detects test directory', async () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/project', 'tests'));

    const result = await scanProject('/project');
    expect(result.testing.hasTests).toBe(true);
    expect(result.testing.testDirectory).toBe('tests');
  });

  it('returns hasTests=false when no testing indicators', async () => {
    const result = await scanProject('/project');
    expect(result.testing.hasTests).toBe(false);
    expect(result.testing.framework).toBeNull();
  });
});
