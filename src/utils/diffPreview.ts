/**
 * Diff Preview - show changes before applying them
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface FileDiff {
  path: string;
  type: 'create' | 'modify' | 'delete';
  oldContent?: string;
  newContent?: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffPreviewResult {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
}

/**
 * Generate diff between old and new content
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = 3
): DiffHunk[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunks: DiffHunk[] = [];
  
  // Simple diff algorithm (Myers-like)
  const lcs = longestCommonSubsequence(oldLines, newLines);
  
  let oldIdx = 0;
  let newIdx = 0;
  let currentHunk: DiffHunk | null = null;
  let pendingContext: DiffLine[] = [];
  
  for (const [oldMatch, newMatch] of lcs) {
    // Handle deletions
    while (oldIdx < oldMatch) {
      if (!currentHunk) {
        currentHunk = createHunk(oldIdx, newIdx);
        // Add leading context
        for (let i = Math.max(0, oldIdx - contextLines); i < oldIdx; i++) {
          currentHunk.lines.push({
            type: 'context',
            content: oldLines[i],
            oldLineNum: i + 1,
            newLineNum: newIdx - (oldIdx - i) + 1,
          });
        }
      }
      currentHunk.lines.push({
        type: 'remove',
        content: oldLines[oldIdx],
        oldLineNum: oldIdx + 1,
      });
      oldIdx++;
    }
    
    // Handle additions
    while (newIdx < newMatch) {
      if (!currentHunk) {
        currentHunk = createHunk(oldIdx, newIdx);
        // Add leading context
        for (let i = Math.max(0, oldIdx - contextLines); i < oldIdx; i++) {
          currentHunk.lines.push({
            type: 'context',
            content: oldLines[i],
            oldLineNum: i + 1,
            newLineNum: newIdx - (oldIdx - i) + 1,
          });
        }
      }
      currentHunk.lines.push({
        type: 'add',
        content: newLines[newIdx],
        newLineNum: newIdx + 1,
      });
      newIdx++;
    }
    
    // Handle match
    if (oldIdx < oldLines.length && newIdx < newLines.length) {
      if (currentHunk) {
        // Add trailing context
        for (let i = 0; i < contextLines && oldIdx + i < oldLines.length; i++) {
          currentHunk.lines.push({
            type: 'context',
            content: oldLines[oldIdx + i],
            oldLineNum: oldIdx + i + 1,
            newLineNum: newIdx + i + 1,
          });
        }
        
        // Finalize hunk
        finalizeHunk(currentHunk);
        hunks.push(currentHunk);
        currentHunk = null;
      }
      
      oldIdx++;
      newIdx++;
    }
  }
  
  // Handle remaining deletions
  while (oldIdx < oldLines.length) {
    if (!currentHunk) {
      currentHunk = createHunk(oldIdx, newIdx);
    }
    currentHunk.lines.push({
      type: 'remove',
      content: oldLines[oldIdx],
      oldLineNum: oldIdx + 1,
    });
    oldIdx++;
  }
  
  // Handle remaining additions
  while (newIdx < newLines.length) {
    if (!currentHunk) {
      currentHunk = createHunk(oldIdx, newIdx);
    }
    currentHunk.lines.push({
      type: 'add',
      content: newLines[newIdx],
      newLineNum: newIdx + 1,
    });
    newIdx++;
  }
  
  // Finalize last hunk
  if (currentHunk) {
    finalizeHunk(currentHunk);
    hunks.push(currentHunk);
  }
  
  return hunks;
}

/**
 * Create a new hunk
 */
function createHunk(oldStart: number, newStart: number): DiffHunk {
  return {
    oldStart: oldStart + 1,
    oldLines: 0,
    newStart: newStart + 1,
    newLines: 0,
    lines: [],
  };
}

/**
 * Finalize hunk by counting lines
 */
function finalizeHunk(hunk: DiffHunk): void {
  hunk.oldLines = hunk.lines.filter(l => l.type !== 'add').length;
  hunk.newLines = hunk.lines.filter(l => l.type !== 'remove').length;
}

/**
 * Simple LCS algorithm for diff
 */
function longestCommonSubsequence(
  old: string[],
  newArr: string[]
): [number, number][] {
  const result: [number, number][] = [];
  let oldIdx = 0;
  let newIdx = 0;
  
  while (oldIdx < old.length && newIdx < newArr.length) {
    if (old[oldIdx] === newArr[newIdx]) {
      result.push([oldIdx, newIdx]);
      oldIdx++;
      newIdx++;
    } else {
      // Try to find match
      let foundOld = -1;
      let foundNew = -1;
      
      // Look ahead in new array
      for (let i = newIdx + 1; i < Math.min(newIdx + 10, newArr.length); i++) {
        if (old[oldIdx] === newArr[i]) {
          foundNew = i;
          break;
        }
      }
      
      // Look ahead in old array
      for (let i = oldIdx + 1; i < Math.min(oldIdx + 10, old.length); i++) {
        if (old[i] === newArr[newIdx]) {
          foundOld = i;
          break;
        }
      }
      
      if (foundNew !== -1 && (foundOld === -1 || foundNew - newIdx < foundOld - oldIdx)) {
        newIdx = foundNew;
      } else if (foundOld !== -1) {
        oldIdx = foundOld;
      } else {
        oldIdx++;
        newIdx++;
      }
    }
  }
  
  // Add end markers
  result.push([old.length, newArr.length]);
  
  return result;
}

/**
 * Create file diff for a write operation
 */
export function createFileDiff(
  path: string,
  newContent: string,
  projectRoot: string
): FileDiff {
  const fullPath = join(projectRoot, path);
  const exists = existsSync(fullPath);
  
  let oldContent = '';
  let type: FileDiff['type'] = 'create';
  
  if (exists) {
    try {
      oldContent = readFileSync(fullPath, 'utf-8');
      type = 'modify';
    } catch {}
  }
  
  const hunks = generateDiff(oldContent, newContent);
  
  return {
    path,
    type,
    oldContent: exists ? oldContent : undefined,
    newContent,
    hunks,
  };
}

/**
 * Create file diff for an edit operation
 */
export function createEditDiff(
  path: string,
  oldText: string,
  newText: string,
  projectRoot: string
): FileDiff | null {
  const fullPath = join(projectRoot, path);
  
  if (!existsSync(fullPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(fullPath, 'utf-8');
    
    if (!content.includes(oldText)) {
      return null;
    }
    
    const newContent = content.replace(oldText, newText);
    const hunks = generateDiff(content, newContent);
    
    return {
      path,
      type: 'modify',
      oldContent: content,
      newContent,
      hunks,
    };
  } catch {
    return null;
  }
}

/**
 * Create file diff for a delete operation
 */
export function createDeleteDiff(
  path: string,
  projectRoot: string
): FileDiff | null {
  const fullPath = join(projectRoot, path);
  
  if (!existsSync(fullPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const hunks = generateDiff(content, '');
    
    return {
      path,
      type: 'delete',
      oldContent: content,
      hunks,
    };
  } catch {
    return null;
  }
}

/**
 * Format diff for terminal display
 */
export function formatDiffForDisplay(diff: FileDiff): string {
  const lines: string[] = [];
  
  // Header
  if (diff.type === 'create') {
    lines.push(`+++ NEW FILE: ${diff.path}`);
  } else if (diff.type === 'delete') {
    lines.push(`--- DELETE FILE: ${diff.path}`);
  } else {
    lines.push(`--- a/${diff.path}`);
    lines.push(`+++ b/${diff.path}`);
  }
  
  // Hunks
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        lines.push(`+ ${line.content}`);
      } else if (line.type === 'remove') {
        lines.push(`- ${line.content}`);
      } else {
        lines.push(`  ${line.content}`);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Format multiple diffs
 */
export function formatDiffPreview(diffs: FileDiff[]): string {
  const lines: string[] = ['## Diff Preview', ''];
  
  let totalAdditions = 0;
  let totalDeletions = 0;
  
  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') totalAdditions++;
        if (line.type === 'remove') totalDeletions++;
      }
    }
  }
  
  lines.push(`Files: ${diffs.length} | +${totalAdditions} -${totalDeletions}`);
  lines.push('');
  
  for (const diff of diffs) {
    lines.push('```diff');
    lines.push(formatDiffForDisplay(diff));
    lines.push('```');
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Calculate diff statistics
 */
export function getDiffStats(diffs: FileDiff[]): DiffPreviewResult {
  let totalAdditions = 0;
  let totalDeletions = 0;
  
  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') totalAdditions++;
        if (line.type === 'remove') totalDeletions++;
      }
    }
  }
  
  return {
    files: diffs,
    totalAdditions,
    totalDeletions,
    totalFiles: diffs.length,
  };
}
