import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => false),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  };
});

import {
  loadGlobalPreferences,
  saveGlobalPreferences,
  loadProjectPreferences,
  saveProjectPreferences,
  learnFromCode,
  formatPreferencesForPrompt,
  addCustomRule,
  removeCustomRule,
  getLearningStatus,
  UserPreferences,
} from './learning';

function makePrefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    codeStyle: { indentation: 'spaces', indentSize: 2, quotes: 'single', semicolons: true, trailingComma: 'es5', lineWidth: 100 },
    naming: { variables: 'camelCase', functions: 'camelCase', classes: 'PascalCase', constants: 'UPPER_CASE', files: 'kebab-case' },
    frameworks: {},
    languages: { preferTypeScript: true, preferAsyncAwait: true },
    patterns: {},
    preferredLibraries: [],
    customRules: [],
    lastUpdated: Date.now(),
    sampleCount: 0,
    ...overrides,
  };
}

describe('loadGlobalPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns defaults when no prefs file exists', () => {
    const prefs = loadGlobalPreferences();
    expect(prefs.codeStyle.indentation).toBe('spaces');
    expect(prefs.codeStyle.quotes).toBe('single');
    expect(prefs.preferredLibraries).toEqual([]);
  });

  it('overrides defaults with saved prefs (shallow merge)', () => {
    mockExistsSync.mockReturnValue(true);
    // codeStyle must be complete because spread is shallow
    const savedPrefs = { codeStyle: { indentation: 'tabs', indentSize: 4, quotes: 'double', semicolons: false, trailingComma: 'none', lineWidth: 80 } };
    mockReadFileSync.mockReturnValue(JSON.stringify(savedPrefs));
    const prefs = loadGlobalPreferences();
    expect(prefs.codeStyle.quotes).toBe('double');
    expect(prefs.codeStyle.indentation).toBe('tabs');
    // Top-level defaults still present
    expect(prefs.preferredLibraries).toEqual([]);
  });

  it('returns defaults on corrupt prefs file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ bad json');
    const prefs = loadGlobalPreferences();
    expect(prefs.codeStyle.indentation).toBe('spaces');
  });
});

describe('saveGlobalPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('writes prefs to file', () => {
    const prefs = makePrefs();
    saveGlobalPreferences(prefs);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.codeStyle).toBeDefined();
  });

  it('updates lastUpdated timestamp', () => {
    const before = Date.now();
    const prefs = makePrefs({ lastUpdated: 0 });
    saveGlobalPreferences(prefs);
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.lastUpdated).toBeGreaterThanOrEqual(before);
  });
});

describe('loadProjectPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns global prefs when no project prefs file', () => {
    const prefs = loadProjectPreferences('/project');
    expect(prefs.codeStyle.quotes).toBe('single'); // default
  });

  it('project prefs override global prefs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ codeStyle: { quotes: 'double', indentation: 'tabs' } }));
    const prefs = loadProjectPreferences('/project');
    expect(prefs.codeStyle.quotes).toBe('double');
    expect(prefs.codeStyle.indentation).toBe('tabs');
  });
});

describe('saveProjectPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('writes merged prefs to project-specific file', () => {
    saveProjectPreferences('/project', { customRules: ['use tabs'] });
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.customRules).toContain('use tabs');
  });

  it('merges with existing project prefs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ customRules: ['rule1'] }));
    saveProjectPreferences('/project', { customRules: ['rule2'] });
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.customRules).toContain('rule2');
  });

  it('handles corrupt existing prefs — starts fresh', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ bad json');
    expect(() => saveProjectPreferences('/project', { sampleCount: 5 })).not.toThrow();
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.sampleCount).toBe(5);
  });
});

describe('learnFromCode', () => {
  const basePrefs = makePrefs();

  it('detects tab indentation', () => {
    const code = '\tconst x = 1;\n\tfunction foo() {}';
    const learned = learnFromCode(code, 'test.js', basePrefs);
    expect(learned.codeStyle?.indentation).toBe('tabs');
  });

  it('detects space indentation and size', () => {
    const code = '    const x = 1;\n    const y = 2;';
    const learned = learnFromCode(code, 'test.js', basePrefs);
    expect(learned.codeStyle?.indentation).toBe('spaces');
    expect(learned.codeStyle?.indentSize).toBe(4);
  });

  it('detects double quote preference', () => {
    const code = 'const a = "hello"; const b = "world"; const c = "foo";';
    const learned = learnFromCode(code, 'test.js', basePrefs);
    expect(learned.codeStyle?.quotes).toBe('double');
  });

  it('detects single quote preference', () => {
    const code = "const a = 'hello'; const b = 'world'; const c = 'foo';";
    const learned = learnFromCode(code, 'test.js', basePrefs);
    expect(learned.codeStyle?.quotes).toBe('single');
  });

  it('detects named import style', () => {
    const code = [
      "import { useState } from 'react';",
      "import { useEffect } from 'react';",
      "import { useRef } from 'react';",
    ].join('\n');
    const learned = learnFromCode(code, 'test.ts', basePrefs);
    expect(learned.patterns?.importStyle).toBe('named');
  });

  it('detects default import style', () => {
    const code = [
      "import React from 'react';",
      "import express from 'express';",
      "import lodash from 'lodash';",
    ].join('\n');
    const learned = learnFromCode(code, 'test.ts', basePrefs);
    expect(learned.patterns?.importStyle).toBe('default');
  });

  it('detects camelCase variable naming', () => {
    const code = 'const myVar = 1; const helloWorld = 2; const fooBar = 3;';
    const learned = learnFromCode(code, 'test.ts', basePrefs);
    expect(learned.naming?.variables).toBe('camelCase');
  });

  it('detects snake_case variable naming', () => {
    const code = 'const my_var = 1; const hello_world = 2; const foo_bar = 3;';
    const learned = learnFromCode(code, 'test.ts', basePrefs);
    expect(learned.naming?.variables).toBe('snake_case');
  });

  it('detects functional component style', () => {
    const code = 'function MyComponent() { return <div>Hello</div>; }';
    const learned = learnFromCode(code, 'Component.tsx', basePrefs);
    expect(learned.patterns?.componentStyle).toBe('functional');
  });

  it('detects async/await preference', () => {
    const code = 'async function getData() { const result = await fetch(url); return result; }';
    const learned = learnFromCode(code, 'api.ts', basePrefs);
    expect(learned.languages?.preferAsyncAwait).toBe(true);
  });

  it('extracts external library names', () => {
    const code = [
      "import axios from 'axios';",
      "import { format } from 'date-fns';",
    ].join('\n');
    const learned = learnFromCode(code, 'api.ts', basePrefs);
    expect(learned.preferredLibraries).toContain('axios');
    expect(learned.preferredLibraries).toContain('date-fns');
  });

  it('does not include relative imports in preferred libraries', () => {
    const code = "import { helper } from './utils';";
    const learned = learnFromCode(code, 'index.ts', basePrefs);
    expect(learned.preferredLibraries ?? []).not.toContain('./utils');
  });

  it('increments sampleCount', () => {
    const prefs = makePrefs({ sampleCount: 5 });
    const learned = learnFromCode('const x = 1;', 'test.ts', prefs);
    expect(learned.sampleCount).toBe(6);
  });
});

describe('formatPreferencesForPrompt', () => {
  it('includes code style section', () => {
    const prefs = makePrefs();
    const result = formatPreferencesForPrompt(prefs);
    expect(result).toContain('Code Style');
    expect(result).toContain('spaces');
    expect(result).toContain('single');
  });

  it('includes naming conventions', () => {
    const prefs = makePrefs();
    const result = formatPreferencesForPrompt(prefs);
    expect(result).toContain('Naming Conventions');
    expect(result).toContain('camelCase');
  });

  it('includes patterns when present', () => {
    const prefs = makePrefs({ patterns: { importStyle: 'named', componentStyle: 'functional' } });
    const result = formatPreferencesForPrompt(prefs);
    expect(result).toContain('Patterns');
    expect(result).toContain('named');
    expect(result).toContain('functional');
  });

  it('includes preferred libraries when present', () => {
    const prefs = makePrefs({ preferredLibraries: ['react', 'axios'] });
    const result = formatPreferencesForPrompt(prefs);
    expect(result).toContain('Preferred Libraries');
    expect(result).toContain('react');
    expect(result).toContain('axios');
  });

  it('includes custom rules when present', () => {
    const prefs = makePrefs({ customRules: ['always use arrow functions'] });
    const result = formatPreferencesForPrompt(prefs);
    expect(result).toContain('Custom Rules');
    expect(result).toContain('always use arrow functions');
  });

  it('ends with instruction to follow preferences', () => {
    const prefs = makePrefs();
    const result = formatPreferencesForPrompt(prefs);
    expect(result).toContain('Follow these preferences');
  });
});

describe('addCustomRule / removeCustomRule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('addCustomRule saves rule globally', () => {
    addCustomRule('use semicolons');
    expect(mockWriteFileSync).toHaveBeenCalled();
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.customRules).toContain('use semicolons');
  });

  it('addCustomRule deduplicates rules', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ customRules: ['use semicolons'] }));
    addCustomRule('use semicolons');
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.customRules.filter((r: string) => r === 'use semicolons')).toHaveLength(1);
  });

  it('removeCustomRule removes rule globally', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ customRules: ['rule1', 'rule2'] }));
    removeCustomRule('rule1');
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.customRules).not.toContain('rule1');
    expect(parsed.customRules).toContain('rule2');
  });
});

describe('getLearningStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns status string with sample count', () => {
    const result = getLearningStatus();
    expect(result).toContain('Samples analyzed: 0');
    expect(result).toContain('Libraries known: 0');
    expect(result).toContain('Custom rules: 0');
  });

  it('reflects actual prefs data', () => {
    mockExistsSync.mockReturnValue(true);
    const prefs = makePrefs({ sampleCount: 42, preferredLibraries: ['react', 'vue', 'angular'] });
    mockReadFileSync.mockReturnValue(JSON.stringify(prefs));
    const result = getLearningStatus();
    expect(result).toContain('Samples analyzed: 42');
    expect(result).toContain('Libraries known: 3');
  });
});
