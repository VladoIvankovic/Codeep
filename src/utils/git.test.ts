import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isGitRepository,
  getGitStatus,
  getGitDiff,
  getChangedFiles,
  suggestCommitMessage,
  createCommit,
  stageAll,
  formatDiffForDisplay,
  getGitContent,
  MAX_GIT_BYTES,
} from './git';

// Create a temp directory for git tests
const TEST_DIR = join(tmpdir(), 'codeep-git-test-' + Date.now());
const NON_GIT_DIR = join(tmpdir(), 'codeep-non-git-test-' + Date.now());

describe('git utilities', () => {
  beforeEach(() => {
    // Create test directories
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(NON_GIT_DIR, { recursive: true });
    
    // Initialize git repo in TEST_DIR
    execSync('git init', { cwd: TEST_DIR, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: TEST_DIR, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: TEST_DIR, stdio: 'ignore' });
  });

  afterEach(() => {
    // Cleanup
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      rmSync(NON_GIT_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('isGitRepository', () => {
    it('should return true for git repository', () => {
      expect(isGitRepository(TEST_DIR)).toBe(true);
    });

    it('should return false for non-git directory', () => {
      expect(isGitRepository(NON_GIT_DIR)).toBe(false);
    });

    it('should return false for non-existent directory', () => {
      expect(isGitRepository('/non/existent/path')).toBe(false);
    });
  });

  describe('getGitStatus', () => {
    it('should return isRepo: false for non-git directory', () => {
      const status = getGitStatus(NON_GIT_DIR);
      expect(status.isRepo).toBe(false);
    });

    it('should return correct status for git repo', () => {
      // Create initial commit so we have a branch
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: TEST_DIR, stdio: 'ignore' });
      
      const status = getGitStatus(TEST_DIR);
      expect(status.isRepo).toBe(true);
      expect(status.branch).toBeDefined();
      expect(status.hasChanges).toBe(false);
    });

    it('should detect changes', () => {
      // Create initial commit
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: TEST_DIR, stdio: 'ignore' });
      
      // Make a change
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello world');
      
      const status = getGitStatus(TEST_DIR);
      expect(status.hasChanges).toBe(true);
    });
  });

  describe('getGitDiff', () => {
    it('should return error for non-git directory', () => {
      const result = getGitDiff(false, NON_GIT_DIR);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a git repository');
    });

    it('should return empty diff when no changes', () => {
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: TEST_DIR, stdio: 'ignore' });
      
      const result = getGitDiff(false, TEST_DIR);
      expect(result.success).toBe(true);
      expect(result.diff).toBe('');
    });

    it('should return diff for unstaged changes', () => {
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: TEST_DIR, stdio: 'ignore' });
      
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello world');
      
      const result = getGitDiff(false, TEST_DIR);
      expect(result.success).toBe(true);
      expect(result.diff).toContain('hello world');
    });

    it('should return diff for staged changes', () => {
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: TEST_DIR, stdio: 'ignore' });
      
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello world');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      
      const result = getGitDiff(true, TEST_DIR);
      expect(result.success).toBe(true);
      expect(result.diff).toContain('hello world');
    });
  });

  describe('getChangedFiles', () => {
    it('should return empty array for non-git directory', () => {
      expect(getChangedFiles(NON_GIT_DIR)).toEqual([]);
    });

    it('should return changed files', () => {
      writeFileSync(join(TEST_DIR, 'file1.txt'), 'content1');
      writeFileSync(join(TEST_DIR, 'file2.txt'), 'content2');
      
      const files = getChangedFiles(TEST_DIR);
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.txt');
    });
  });

  describe('suggestCommitMessage', () => {
    it('should suggest feat for new files', () => {
      const diff = 'new file mode 100644\n+++ b/newfile.ts';
      expect(suggestCommitMessage(diff)).toBe('feat: add new files');
    });

    it('should suggest chore for deleted files', () => {
      const diff = 'deleted file mode 100644\n--- a/oldfile.ts';
      expect(suggestCommitMessage(diff)).toBe('chore: remove files');
    });

    it('should suggest chore for package.json changes', () => {
      const diff = '+++ b/package.json\n+  "new-dep": "1.0.0"';
      expect(suggestCommitMessage(diff)).toBe('chore: update dependencies');
    });

    it('should suggest docs for README changes', () => {
      const diff = '+++ b/README.md\n+ New documentation';
      expect(suggestCommitMessage(diff)).toBe('docs: update documentation');
    });

    it('should suggest test for test file changes', () => {
      const diff = '+++ b/utils.test.ts\n+ test case';
      expect(suggestCommitMessage(diff)).toBe('test: update tests');
    });
  });

  describe('createCommit', () => {
    it('should return error for non-git directory', () => {
      const result = createCommit('test message', NON_GIT_DIR);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a git repository');
    });

    it('should return error when no staged changes', () => {
      const result = createCommit('test message', TEST_DIR);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No staged changes to commit');
    });

    it('should create commit successfully', () => {
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      
      const result = createCommit('test commit message', TEST_DIR);
      expect(result.success).toBe(true);
      expect(result.hash).toBeDefined();
      expect(result.hash!.length).toBeGreaterThan(0);
    });

    it('should handle special characters in commit message safely', () => {
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      
      // Test with potentially dangerous characters that could cause shell injection
      const dangerousMessage = 'test `whoami` $(echo dangerous) ; rm -rf /';
      const result = createCommit(dangerousMessage, TEST_DIR);
      
      expect(result.success).toBe(true);
      
      // Verify the commit message was stored correctly (not executed)
      const log = execSync('git log -1 --format=%s', { cwd: TEST_DIR, encoding: 'utf-8' });
      expect(log.trim()).toBe(dangerousMessage);
    });
  });

  describe('stageAll', () => {
    it('should return false for non-git directory', () => {
      expect(stageAll(NON_GIT_DIR)).toBe(false);
    });

    it('should stage all files', () => {
      writeFileSync(join(TEST_DIR, 'file1.txt'), 'content1');
      writeFileSync(join(TEST_DIR, 'file2.txt'), 'content2');
      
      expect(stageAll(TEST_DIR)).toBe(true);
      
      // Verify files are staged
      const staged = execSync('git diff --cached --name-only', { cwd: TEST_DIR, encoding: 'utf-8' });
      expect(staged).toContain('file1.txt');
      expect(staged).toContain('file2.txt');
    });
  });

  describe('formatDiffForDisplay', () => {
    it('should return full diff if under limit', () => {
      const diff = 'line1\nline2\nline3';
      expect(formatDiffForDisplay(diff, 10)).toBe(diff);
    });

    it('should truncate long diffs', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
      const diff = lines.join('\n');
      
      const result = formatDiffForDisplay(diff, 10);
      expect(result).toContain('line0');
      expect(result).toContain('line9');
      expect(result).not.toContain('line99');
      expect(result).toContain('90 more lines');
    });
  });

  describe('getGitContent (@git mention resolver)', () => {
    beforeEach(() => {
      // Initial commit so HEAD exists.
      writeFileSync(join(TEST_DIR, 'a.txt'), 'line1\nline2\nline3\n');
      execSync('git add .', { cwd: TEST_DIR, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: TEST_DIR, stdio: 'ignore' });
    });

    it('returns the unstaged diff for "diff"', () => {
      writeFileSync(join(TEST_DIR, 'a.txt'), 'line1\nCHANGED\nline3\n');
      const r = getGitContent('diff', TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content).toContain('CHANGED');
      expect(r.label).toBe('diff (unstaged)');
    });

    it('returns the staged diff for "diff --staged"', () => {
      writeFileSync(join(TEST_DIR, 'a.txt'), 'line1\nSTAGED\nline3\n');
      execSync('git add a.txt', { cwd: TEST_DIR, stdio: 'ignore' });
      const r = getGitContent('diff --staged', TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content).toContain('STAGED');
      expect(r.label).toBe('diff (staged)');
    });

    it('accepts "staged" as an alias for staged diff', () => {
      writeFileSync(join(TEST_DIR, 'a.txt'), 'staged2\n');
      execSync('git add a.txt', { cwd: TEST_DIR, stdio: 'ignore' });
      const r = getGitContent('staged', TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content).toContain('staged2');
    });

    it('returns the HEAD commit patch for "HEAD"', () => {
      const r = getGitContent('HEAD', TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content).toContain('line1');
      expect(r.label).toBe('HEAD');
    });

    it('returns a specific commit by short SHA', () => {
      const sha = execSync('git rev-parse HEAD', { cwd: TEST_DIR, encoding: 'utf-8' }).trim();
      const r = getGitContent(sha.slice(0, 7), TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content).toContain('line1');
    });

    it('returns a file at a ref with <ref>:<path> syntax', () => {
      const r = getGitContent('HEAD:a.txt', TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content).toContain('line1');
      expect(r.content).toContain('line2');
    });

    it('accepts "diff a..b" range syntax', () => {
      // Modify and commit a second change.
      writeFileSync(join(TEST_DIR, 'a.txt'), 'v2\n');
      execSync('git add . && git commit -m "second"', { cwd: TEST_DIR, stdio: 'ignore' });
      writeFileSync(join(TEST_DIR, 'a.txt'), 'v3\n');
      execSync('git add . && git commit -m "third"', { cwd: TEST_DIR, stdio: 'ignore' });
      const r = getGitContent('diff HEAD~2..HEAD', TEST_DIR);
      expect(r.success).toBe(true);
      // Should show the transition from line1 → v3.
      expect(r.content).toMatch(/v3|line1/);
    });

    it('fails gracefully for an unknown ref', () => {
      const r = getGitContent('nonexistent-branch-xyz', TEST_DIR);
      expect(r.success).toBe(false);
      expect(r.error).toContain('unknown git ref');
    });

    it('fails gracefully for an empty ref', () => {
      const r = getGitContent('   ', TEST_DIR);
      expect(r.success).toBe(false);
      expect(r.error).toContain('empty');
    });

    it('fails for a non-git directory', () => {
      const r = getGitContent('diff', NON_GIT_DIR);
      expect(r.success).toBe(false);
      expect(r.error).toContain('not a git repository');
    });

    it('truncates content above MAX_GIT_BYTES', () => {
      // Create a large staged change so `git diff` (cached fallback)
      // surfaces it. We add+commit an initial big.txt, then modify it
      // hugely so `git diff` shows a large addition.
      const initial = 'initial\n';
      writeFileSync(join(TEST_DIR, 'big.txt'), initial);
      execSync('git add big.txt', { cwd: TEST_DIR, stdio: 'ignore' });
      // Modify in place — now unstaged diff shows the big change.
      const big = 'x'.repeat(MAX_GIT_BYTES + 5000) + '\n';
      writeFileSync(join(TEST_DIR, 'big.txt'), big);
      const r = getGitContent('diff', TEST_DIR);
      expect(r.success).toBe(true);
      expect(r.content.length).toBeLessThan(MAX_GIT_BYTES + 1000);
      expect(r.content).toContain('truncated');
    });
  });
});
