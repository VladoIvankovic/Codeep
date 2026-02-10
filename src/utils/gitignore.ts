/**
 * .gitignore parser — loads ignore patterns and tests file paths against them.
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';

export interface IgnoreRules {
  patterns: IgnorePattern[];
  projectRoot: string;
}

interface IgnorePattern {
  regex: RegExp;
  negated: boolean;
}

/**
 * Always-ignored directories (even without a .gitignore)
 */
const BUILTIN_IGNORES = [
  'node_modules',
  '.git',
  '.codeep',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  'coverage',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'target',          // Rust, Java/Maven
  'out',
  '.output',
];

/**
 * Load .gitignore rules from a project root.
 * Falls back to built-in ignores if no .gitignore exists.
 */
export function loadIgnoreRules(projectRoot: string): IgnoreRules {
  const patterns: IgnorePattern[] = [];

  // Built-in ignores always apply
  for (const dir of BUILTIN_IGNORES) {
    patterns.push({ regex: new RegExp(`(^|/)${escapeRegex(dir)}(/|$)`), negated: false });
  }

  // Parse .gitignore if it exists
  const gitignorePath = join(projectRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      const parsed = parseGitignore(content);
      patterns.push(...parsed);
    } catch {
      // Ignore read errors
    }
  }

  return { patterns, projectRoot };
}

/**
 * Test whether a file path should be ignored.
 * @param filePath Absolute or relative path
 * @param rules Loaded ignore rules
 * @returns true if the path should be ignored
 */
export function isIgnored(filePath: string, rules: IgnoreRules): boolean {
  // Normalize to forward-slash relative path
  let rel = filePath;
  if (filePath.startsWith(rules.projectRoot)) {
    rel = relative(rules.projectRoot, filePath);
  }
  rel = rel.split(sep).join('/');

  // Empty path is never ignored
  if (!rel) return false;

  let ignored = false;

  for (const pattern of rules.patterns) {
    if (pattern.regex.test(rel)) {
      ignored = !pattern.negated;
    }
  }

  return ignored;
}

/**
 * Parse .gitignore content into patterns.
 */
function parseGitignore(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (let line of content.split('\n')) {
    // Strip trailing whitespace (but not leading — significant in gitignore)
    line = line.replace(/\s+$/, '');

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }

    // Remove leading slash (anchored to root)
    const anchored = line.startsWith('/');
    if (anchored) {
      line = line.slice(1);
    }

    // Remove trailing slash (directory-only marker — we don't distinguish)
    if (line.endsWith('/')) {
      line = line.slice(0, -1);
    }

    // Convert glob pattern to regex
    const regex = globToRegex(line, anchored);
    patterns.push({ regex, negated });
  }

  return patterns;
}

/**
 * Convert a gitignore glob pattern to a RegExp.
 */
function globToRegex(pattern: string, anchored: boolean): RegExp {
  let re = '';

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches everything including /
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        // * matches everything except /
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      // Character class — pass through until ]
      const end = pattern.indexOf(']', i + 1);
      if (end !== -1) {
        re += pattern.slice(i, end + 1);
        i = end;
      } else {
        re += escapeRegex(c);
      }
    } else {
      re += escapeRegex(c);
    }
  }

  if (anchored) {
    return new RegExp(`^${re}(/|$)`);
  }

  // Unanchored patterns match anywhere in the path
  return new RegExp(`(^|/)${re}(/|$)`);
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
