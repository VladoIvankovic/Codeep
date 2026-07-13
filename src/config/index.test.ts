import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hasStandardProjectMarkers,
  initializeAsProject,
  isManuallyInitializedProject,
  isProjectDirectory,
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
