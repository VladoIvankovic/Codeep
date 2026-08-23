import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { ActionLog } from './tools';

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  hasChanges?: boolean;
  ahead?: number;
  behind?: number;
}

export interface GitDiffResult {
  success: boolean;
  diff: string;
  error?: string;
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  error?: string;
}

/**
 * Check if current directory is a git repository
 */
export function isGitRepository(cwd: string = process.cwd()): boolean {
  try {
    const gitDir = join(cwd, '.git');
    if (existsSync(gitDir)) return true;
    
    // Check if we're inside a git repo (not necessarily at root)
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git status
 */
export function getGitStatus(cwd: string = process.cwd()): GitStatus {
  if (!isGitRepository(cwd)) {
    return { isRepo: false };
  }

  try {
    // Get current branch
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { 
      cwd, 
      encoding: 'utf-8' 
    }).trim();

    // Check for changes
    const status = execSync('git status --porcelain', { 
      cwd, 
      encoding: 'utf-8' 
    });
    const hasChanges = status.trim().length > 0;

    // Check ahead/behind
    let ahead = 0;
    let behind = 0;
    try {
      const counts = execSync('git rev-list --left-right --count @{u}...HEAD', { 
        cwd, 
        encoding: 'utf-8' 
      }).trim();
      const [behindStr, aheadStr] = counts.split('\t');
      behind = parseInt(behindStr) || 0;
      ahead = parseInt(aheadStr) || 0;
    } catch {
      // No upstream branch
    }

    return {
      isRepo: true,
      branch,
      hasChanges,
      ahead,
      behind,
    };
  } catch (error) {
    return {
      isRepo: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    } as GitStatus;
  }
}

/**
 * Get git diff (staged or unstaged)
 */
export function getGitDiff(
  staged: boolean = false, 
  cwd: string = process.cwd()
): GitDiffResult {
  if (!isGitRepository(cwd)) {
    return {
      success: false,
      diff: '',
      error: 'Not a git repository',
    };
  }

  try {
    const command = staged ? 'git diff --cached' : 'git diff';
    const diff = execSync(command, { 
      cwd, 
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    if (!diff.trim()) {
      return {
        success: true,
        diff: '',
        error: staged ? 'No staged changes' : 'No unstaged changes',
      };
    }

    return {
      success: true,
      diff: diff.trim(),
    };
  } catch (error) {
    return {
      success: false,
      diff: '',
      error: error instanceof Error ? error.message : 'Failed to get diff',
    };
  }
}

/**
 * Get list of changed files
 */
export function getChangedFiles(cwd: string = process.cwd()): string[] {
  if (!isGitRepository(cwd)) {
    return [];
  }

  try {
    const output = execSync('git status --porcelain', { 
      cwd, 
      encoding: 'utf-8' 
    });

    return output
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        // Format: "XY filename" where XY are status codes
        return line.substring(3).trim();
      });
  } catch {
    return [];
  }
}

/**
 * Generate commit message suggestion based on diff
 */
export function suggestCommitMessage(diff: string): string {
  // Simple heuristics for commit message suggestions
  const lines = diff.split('\n');
  const additions = lines.filter(l => l.startsWith('+')).length;
  const deletions = lines.filter(l => l.startsWith('-')).length;
  
  // Look for common patterns
  if (diff.includes('new file mode')) {
    return 'feat: add new files';
  }
  if (diff.includes('deleted file mode')) {
    return 'chore: remove files';
  }
  if (diff.includes('package.json') || diff.includes('package-lock.json')) {
    return 'chore: update dependencies';
  }
  if (diff.includes('README') || diff.includes('.md')) {
    return 'docs: update documentation';
  }
  if (diff.includes('test') || diff.includes('spec')) {
    return 'test: update tests';
  }
  
  // Generic based on size
  if (additions > deletions * 2) {
    return 'feat: add functionality';
  }
  if (deletions > additions * 2) {
    return 'refactor: remove code';
  }
  
  return 'chore: update code';
}

/**
 * Create a commit with the given message
 */
export function createCommit(
  message: string,
  cwd: string = process.cwd()
): GitCommitResult {
  if (!isGitRepository(cwd)) {
    return {
      success: false,
      error: 'Not a git repository',
    };
  }

  try {
    // Check if there are staged changes
    const staged = execSync('git diff --cached --name-only', { 
      cwd, 
      encoding: 'utf-8' 
    }).trim();

    if (!staged) {
      return {
        success: false,
        error: 'No staged changes to commit',
      };
    }

    // Create commit using spawnSync to prevent command injection
    const result = spawnSync('git', ['commit', '-m', message], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Commit failed');
    }

    // Get commit hash
    const hash = execSync('git rev-parse --short HEAD', { 
      cwd, 
      encoding: 'utf-8' 
    }).trim();

    return {
      success: true,
      hash,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Commit failed',
    };
  }
}

/**
 * Stage all changes
 */
export function stageAll(cwd: string = process.cwd()): boolean {
  if (!isGitRepository(cwd)) {
    return false;
  }

  try {
    execSync('git add -A', { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format git diff for display
 */
export function formatDiffForDisplay(diff: string, maxLines: number = 50): string {
  const lines = diff.split('\n');
  
  if (lines.length <= maxLines) {
    return diff;
  }
  
  const truncated = lines.slice(0, maxLines).join('\n');
  const remaining = lines.length - maxLines;
  
  return `${truncated}\n\n... (${remaining} more lines, showing first ${maxLines})`;
}

/**
 * Create a new branch
 */
export function createBranch(
  branchName: string,
  cwd: string = process.cwd()
): { success: boolean; error?: string } {
  if (!isGitRepository(cwd)) {
    return { success: false, error: 'Not a git repository' };
  }

  try {
    // Check if branch already exists
    const branches = execSync('git branch --list', { cwd, encoding: 'utf-8' });
    if (branches.includes(branchName)) {
      return { success: false, error: `Branch '${branchName}' already exists` };
    }

    execSync(`git checkout -b ${branchName}`, { cwd, stdio: 'ignore' });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create branch',
    };
  }
}

/**
 * Switch to a branch
 */
export function switchBranch(
  branchName: string,
  cwd: string = process.cwd()
): { success: boolean; error?: string } {
  if (!isGitRepository(cwd)) {
    return { success: false, error: 'Not a git repository' };
  }

  try {
    execSync(`git checkout ${branchName}`, { cwd, stdio: 'ignore' });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to switch branch',
    };
  }
}

/**
 * Generate a commit message based on agent actions
 */
export function generateCommitMessage(
  prompt: string,
  actions: ActionLog[]
): string {
  // Analyze actions to determine commit type
  const hasWrites = actions.some(a => a.type === 'write');
  const hasEdits = actions.some(a => a.type === 'edit');
  const hasDeletes = actions.some(a => a.type === 'delete');
  
  // Determine prefix
  let prefix = 'chore';
  
  // Check prompt for common patterns
  const promptLower = prompt.toLowerCase();
  if (promptLower.includes('fix') || promptLower.includes('bug')) {
    prefix = 'fix';
  } else if (promptLower.includes('add') || promptLower.includes('create') || promptLower.includes('implement')) {
    prefix = 'feat';
  } else if (promptLower.includes('refactor') || promptLower.includes('clean')) {
    prefix = 'refactor';
  } else if (promptLower.includes('test')) {
    prefix = 'test';
  } else if (promptLower.includes('doc') || promptLower.includes('readme')) {
    prefix = 'docs';
  } else if (hasWrites && !hasEdits) {
    prefix = 'feat';
  } else if (hasDeletes && !hasWrites) {
    prefix = 'refactor';
  }
  
  // Generate message body from prompt
  let body = prompt
    .replace(/^(please\s+)?/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  
  // Truncate if too long
  if (body.length > 50) {
    body = body.substring(0, 47) + '...';
  }
  
  // Make first letter lowercase
  body = body.charAt(0).toLowerCase() + body.slice(1);
  
  return `${prefix}: ${body}`;
}

/**
 * Auto-commit agent changes
 */
export function autoCommitAgentChanges(
  prompt: string,
  actions: ActionLog[],
  cwd: string = process.cwd()
): GitCommitResult {
  if (!isGitRepository(cwd)) {
    return { success: false, error: 'Not a git repository' };
  }
  
  // Check if there are any file changes
  const fileActions = actions.filter(a => 
    a.type === 'write' || a.type === 'edit' || a.type === 'delete' || a.type === 'mkdir'
  );
  
  if (fileActions.length === 0) {
    return { success: false, error: 'No file changes to commit' };
  }
  
  // Check for actual git changes
  const status = getGitStatus(cwd);
  if (!status.hasChanges) {
    return { success: false, error: 'No changes detected by git' };
  }
  
  // Stage all changes
  if (!stageAll(cwd)) {
    return { success: false, error: 'Failed to stage changes' };
  }
  
  // Generate commit message
  const message = generateCommitMessage(prompt, actions);
  
  // Create commit
  return createCommit(message, cwd);
}

/**
 * Generate branch name from prompt
 */
export function generateBranchName(prompt: string): string {
  // Clean up prompt
  let name = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  
  // Add prefix
  const prefix = 'agent';
  const timestamp = Date.now().toString(36).slice(-4);
  
  return `${prefix}/${name}-${timestamp}`;
}

/**
 * Create branch and commit agent changes
 */
export function createBranchAndCommit(
  prompt: string,
  actions: ActionLog[],
  cwd: string = process.cwd()
): { success: boolean; branch?: string; hash?: string; error?: string } {
  if (!isGitRepository(cwd)) {
    return { success: false, error: 'Not a git repository' };
  }
  
  // Generate branch name
  const branchName = generateBranchName(prompt);
  
  // Create branch
  const branchResult = createBranch(branchName, cwd);
  if (!branchResult.success) {
    return { success: false, error: branchResult.error };
  }
  
  // Commit changes
  const commitResult = autoCommitAgentChanges(prompt, actions, cwd);
  if (!commitResult.success) {
    return { 
      success: false, 
      branch: branchName, 
      error: commitResult.error 
    };
  }
  
  return {
    success: true,
    branch: branchName,
    hash: commitResult.hash,
  };
}

// ─── @git mention support ────────────────────────────────────────────────────

/**
 * Result of resolving a `@git <ref>` mention.
 */
export interface GitContentResult {
  success: boolean;
  /** Raw output from git (diff text, file content, or commit metadata). */
  content: string;
  /** A short label for the [Attached files]-style block header. */
  label: string;
  error?: string;
}

/** Max bytes we'll inline from a single `@git` mention. */
export const MAX_GIT_BYTES = 64 * 1024;

/**
 * Characters a git ref/pathspec may contain for `@git` mentions. Deliberately
 * conservative: word chars plus the punctuation real refs use
 * (`main..feature`, `HEAD~3`, `v1.2.0^{}`, `main:src/x.ts`, `origin/main`).
 * A leading `-` is rejected separately so a ref can never be read as a flag.
 */
const SAFE_GIT_REF = /^[A-Za-z0-9._/:~^@{}-]+$/;

export function isSafeGitRef(token: string): boolean {
  return token.length > 0 && !token.startsWith('-') && SAFE_GIT_REF.test(token);
}

/**
 * The only flags `@git diff …` may pass through. An allowlist rather than a
 * deny-list because several git flags write files or run commands
 * (`--output=`, `--ext-diff`), which would turn a mention into a side effect.
 */
const GIT_DIFF_FLAG_ALLOWLIST = new Set([
  '--staged', '--cached', '--stat', '--numstat', '--shortstat',
  '--name-only', '--name-status', '--patch', '-p', '--no-color',
]);

/**
 * Resolve a `@git <ref>` mention to inline content. The `ref` can be:
 *
 * - `diff`           — unstaged changes (`git diff`)
 * - `diff --staged`  — staged changes (`git diff --cached`)
 * - `diff a..b`      — diff between two refs (`git diff a..b`)
 * - `HEAD`           — the latest commit's full diff vs its parent
 * - `<sha>`          — a specific commit's patch (`git show <sha>`)
 * - `<ref>:<path>`   — a file at a ref (`git show main:src/x.ts`)
 * - `<ref>`          — any other git ref → `git show`
 *
 * Sync (spawn-based) so it slots into the mention-expansion pipeline.
 */
export function getGitContent(ref: string, cwd: string = process.cwd()): GitContentResult {
  if (!isGitRepository(cwd)) {
    return { success: false, content: '', label: ref, error: 'not a git repository' };
  }

  const trimmed = ref.trim();
  if (!trimmed) {
    return { success: false, content: '', label: ref, error: 'empty git ref' };
  }

  // Pick the git subcommand based on the ref shape. NOTE: the ref comes from
  // free-form prompt text (`@git <ref>`), which may be pasted from an issue,
  // a log, or model output — so it is UNTRUSTED. We therefore (a) build an
  // argv array and spawn git directly with `execFileSync` (no `/bin/sh`, so
  // `;`, `|`, backticks and friends are inert), and (b) validate every token,
  // because argv alone doesn't stop *argument* injection — a ref that starts
  // with `-` would still be read by git as a flag (e.g. `--output=…` writes a
  // file). Anything unrecognized is rejected rather than guessed at.
  let args: string[];
  let label: string;

  if (trimmed === 'diff') {
    args = ['diff'];
    label = 'diff (unstaged)';
  } else if (trimmed === 'diff --staged' || trimmed === 'diff --cached' || trimmed === 'staged') {
    args = ['diff', '--cached'];
    label = 'diff (staged)';
  } else if (trimmed.startsWith('diff ')) {
    // e.g. `diff main..feature` or `diff HEAD~3` or `diff --stat`
    const rest = trimmed.slice('diff '.length).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);
    const bad = tokens.find(t => !(isSafeGitRef(t) || GIT_DIFF_FLAG_ALLOWLIST.has(t)));
    if (bad) {
      return { success: false, content: '', label: ref, error: `unsupported git argument: ${bad}` };
    }
    args = ['diff', ...tokens];
    label = `diff (${rest})`;
  } else if (trimmed === 'HEAD' || trimmed === '@') {
    // Show the latest commit's patch.
    args = ['show', 'HEAD'];
    label = 'HEAD';
  } else {
    // Any other ref → `git show`. Works for SHAs, tags, branches, and
    // `<ref>:<path>` (file-at-ref) forms.
    if (!isSafeGitRef(trimmed)) {
      return { success: false, content: '', label: ref, error: `unsupported git ref: ${trimmed}` };
    }
    args = ['show', trimmed];
    label = trimmed;
  }

  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const content = (out ?? '').trimEnd();
    if (!content) {
      return { success: false, content: '', label, error: 'empty result (no changes / unknown ref)' };
    }
    // Truncate to the cap so a massive diff can't blow the context.
    const capped = content.length > MAX_GIT_BYTES
      ? content.slice(0, MAX_GIT_BYTES) + `\n\n… (truncated at ${MAX_GIT_BYTES / 1024}KB)`
      : content;
    return { success: true, content: capped, label };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // git show exits non-zero on unknown refs; surface a friendly reason.
    const reason = /unknown revision|bad revision|ambiguous argument/i.test(msg)
      ? `unknown git ref: ${trimmed}`
      : msg;
    return { success: false, content: '', label, error: reason };
  }
}
