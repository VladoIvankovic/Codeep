import { execSync, spawnSync } from 'child_process';
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
  const hasCommands = actions.some(a => a.type === 'command');
  
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
