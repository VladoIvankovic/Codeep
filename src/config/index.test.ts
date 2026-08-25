import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  applyProfile,
  config,
  hasStandardProjectMarkers,
  initializeAsProject,
  isManuallyInitializedProject,
  isProjectDirectory,
  type Profile,
  describeUnsendableKey,
} from './index';

let root: string;

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'codeep-cfg-'));
}

beforeEach(() => {
  root = freshDir();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hasStandardProjectMarkers', () => {
  it('returns false for an empty directory', () => {
    expect(hasStandardProjectMarkers(root)).toBe(false);
  });

  it.each([
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'Cargo.toml',
    'go.mod',
    'composer.json',
    'pom.xml',
    'build.gradle',
  ])('returns true when %s is present', (file) => {
    writeFileSync(join(root, file), '{}');
    expect(hasStandardProjectMarkers(root)).toBe(true);
  });

  it('returns true when a .git directory is present', () => {
    mkdirSync(join(root, '.git'));
    expect(hasStandardProjectMarkers(root)).toBe(true);
  });

  it('returns false for an unrelated file', () => {
    writeFileSync(join(root, 'README.md'), 'hi');
    expect(hasStandardProjectMarkers(root)).toBe(false);
  });
});

describe('initializeAsProject', () => {
  it('creates .codeep/project.json and returns true', () => {
    expect(initializeAsProject(root)).toBe(true);
    expect(existsSync(join(root, '.codeep', 'project.json'))).toBe(true);
  });

  it('marks the folder as manually initialised', () => {
    initializeAsProject(root);
    expect(isManuallyInitializedProject(root)).toBe(true);
  });

  it('is idempotent (re-initialising keeps the marker)', () => {
    expect(initializeAsProject(root)).toBe(true);
    expect(initializeAsProject(root)).toBe(true);
    expect(isManuallyInitializedProject(root)).toBe(true);
  });

  it('writes the directory name as the project name', () => {
    initializeAsProject(root);
    const data = JSON.parse(
      require('fs').readFileSync(join(root, '.codeep', 'project.json'), 'utf8'),
    );
    expect(data.name).toBe(root.split('/').pop());
    expect(data.initializedAt).toBeTruthy();
    expect(data.version).toBe('1.0');
  });

  it('returns false when the directory is not writable', () => {
    // Point at a path under a non-existent root that can't be created.
    expect(initializeAsProject('/nonexistent-root-xyz/cannot/crete')).toBe(false);
  });
});

describe('isManuallyInitializedProject', () => {
  it('returns false before initialisation', () => {
    expect(isManuallyInitializedProject(root)).toBe(false);
  });

  it('returns true after initialiseAsProject', () => {
    initializeAsProject(root);
    expect(isManuallyInitializedProject(root)).toBe(true);
  });

  it('returns false if only a standard marker is present', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    expect(isManuallyInitializedProject(root)).toBe(false);
  });
});

describe('isProjectDirectory', () => {
  it('returns false for an empty directory', () => {
    expect(isProjectDirectory(root)).toBe(false);
  });

  it('returns true for a manual .codeep/project.json marker', () => {
    initializeAsProject(root);
    expect(isProjectDirectory(root)).toBe(true);
  });

  it('returns true when a standard project marker is present', () => {
    writeFileSync(join(root, 'go.mod'), 'module x');
    expect(isProjectDirectory(root)).toBe(true);
  });

  it('returns true when .git is present', () => {
    mkdirSync(join(root, '.git'));
    expect(isProjectDirectory(root)).toBe(true);
  });

  it('prefers the manual marker over standard markers (both true)', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    initializeAsProject(root);
    expect(isProjectDirectory(root)).toBe(true);
  });

  it('returns false for an unrelated file', () => {
    writeFileSync(join(root, 'notes.txt'), 'hi');
    expect(isProjectDirectory(root)).toBe(false);
  });
});

describe('applyProfile', () => {
  function profileWith(provider: string, model: string): Profile {
    return {
      name: 'test',
      createdAt: new Date().toISOString(),
      provider,
      model,
      protocol: 'openai',
      temperature: 0.7,
      maxTokens: 32768,
      language: 'auto',
      agentMode: 'off',
      agentConfirmation: 'dangerous',
      agentAutoCommit: false,
    };
  }

  it('migrates a retired model id the same way the startup migration does', () => {
    applyProfile(profileWith('openai', 'gpt-5.5'));
    expect(config.get('model')).toBe('gpt-5.6-sol');

    applyProfile(profileWith('qwen-api', 'qwen3-coder-flash'));
    expect(config.get('model')).toBe('qwen3.6-flash');
  });

  it('leaves current and dynamic model ids untouched', () => {
    applyProfile(profileWith('openai', 'gpt-5.6-terra'));
    expect(config.get('model')).toBe('gpt-5.6-terra');

    applyProfile(profileWith('openrouter', 'openai/gpt-5.5'));
    expect(config.get('model')).toBe('openai/gpt-5.5');

    applyProfile(profileWith('ollama', 'qwen3-coder-plus:latest'));
    expect(config.get('model')).toBe('qwen3-coder-plus:latest');
  });
});

describe('describeUnsendableKey', () => {
  // Found from a live run: a key with an invisible character produced
  // "Cannot convert argument to a ByteString because the character at index
  // 10…" — an index counted across `Bearer <key>`, so it pointed seven
  // characters left of the real culprit, and the message never said "key".
  // Worse, the caller retried twice more, which could not possibly help.
  it('accepts an ordinary key', () => {
    expect(describeUnsendableKey('sk-abcdef0123456789')).toBeNull();
    expect(describeUnsendableKey('')).toBeNull();
  });

  it('names the position in the key, not in the header', () => {
    // Character 4 of the key is the one at index 10 of `Bearer <key>`.
    const problem = describeUnsendableKey('abc​def');
    expect(problem).toContain('character 4');
    expect(problem).toContain('zero-width space');
  });

  it('recognises the characters a paste actually introduces', () => {
    expect(describeUnsendableKey('ab cd')).toContain('non-breaking space');
    expect(describeUnsendableKey('ab’cd')).toContain('curly quote');
    expect(describeUnsendableKey('ab“cd')).toContain('curly double quote');
  });

  it('falls back to a code point for anything else', () => {
    expect(describeUnsendableKey('abc中')).toContain('U+4E2D');
  });

  // The description exists to be shown to someone. It must never contain the
  // key it is describing.
  it('never reproduces the key', () => {
    const secret = 'sk-supersecret​value';
    const problem = describeUnsendableKey(secret)!;
    expect(problem).not.toContain('supersecret');
    expect(problem).not.toContain(secret);
  });
});
