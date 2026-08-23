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
 * Myers diff algorithm — finds the shortest edit script (SES).
 * Returns matched line pairs as [oldIndex, newIndex][].
 * The final entry is the sentinel [old.length, new.length].
 */
function longestCommonSubsequence(
  oldArr: string[],
  newArr: string[]
): [number, number][] {
  const N = oldArr.length;
  const M = newArr.length;

  // Trivial cases
  if (N === 0 && M === 0) return [[0, 0]];
  if (N === 0) return [[0, M]];
  if (M === 0) return [[N, M]];

  const MAX = N + M;
  // V[k] stores the furthest-reaching x on diagonal k.
  // Diagonals range from -MAX to +MAX, index with offset MAX.
  const size = 2 * MAX + 1;
  const V = new Int32Array(size);
  V.fill(-1);
  V[MAX + 1] = 0; // V[1] = 0

  // Store each step's V snapshot for backtracking
  const trace: Int32Array[] = [];

  let found = false;
  for (let d = 0; d <= MAX; d++) {
    // Save current V before mutation
    trace.push(V.slice());

    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + MAX;
      let x: number;
      if (k === -d || (k !== d && V[kIdx - 1] < V[kIdx + 1])) {
        x = V[kIdx + 1]; // move down
      } else {
        x = V[kIdx - 1] + 1; // move right
      }
      let y = x - k;

      // Follow diagonal (matching lines)
      while (x < N && y < M && oldArr[x] === newArr[y]) {
        x++;
        y++;
      }

      V[kIdx] = x;

      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
    if (found) break;
  }

  // Backtrack through trace to recover the edit path
  let x = N;
  let y = M;
  const edits: Array<{ prevX: number; prevY: number; x: number; y: number }> = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const Vd = trace[d];
    const k = x - y;
    const kIdx = k + MAX;

    let prevK: number;
    if (k === -d || (k !== d && Vd[kIdx - 1] < Vd[kIdx + 1])) {
      prevK = k + 1; // came from above (insertion)
    } else {
      prevK = k - 1; // came from left (deletion)
    }

    const prevX = Vd[prevK + MAX];
    const prevY = prevX - prevK;

    // Record diagonal moves (matches) between prevX,prevY and x,y
    edits.push({ prevX, prevY, x, y });

    x = prevX;
    y = prevY;
  }

  edits.reverse();

  // Extract matched pairs from the diagonal segments
  const result: [number, number][] = [];
  for (const edit of edits) {
    // The diagonal portion: from (edit.prevX, edit.prevY) moving diagonally to where the non-diagonal step leads to (edit.x, edit.y)
    // The non-diagonal step comes first, then diagonal. So diagonal is from (startX, startY) to (edit.x, edit.y)
    // where startX/startY is one step from prevX/prevY.
    let sx = edit.prevX;
    let sy = edit.prevY;

    // The non-diagonal step
    if (sx < edit.x && sy < edit.y) {
      // Both moved — this is diagonal only if lines match
      // Actually in Myers, the non-diagonal step is exactly 1 move (right or down)
      // followed by diagonal matches. Let's just skip non-diagonal and collect diagonals.
    }

    // Determine the start of diagonal: prevX,prevY + one step
    const k = edit.x - edit.y;
    const prevK = edit.prevX - edit.prevY;
    if (prevK !== k) {
      // There was a non-diagonal step
      if (k === prevK + 1) {
        // Moved right (deletion in old)
        sx = edit.prevX + 1;
        sy = edit.prevY;
      } else {
        // Moved down (insertion in new)
        sx = edit.prevX;
        sy = edit.prevY + 1;
      }
    }

    // Collect diagonal matches
    while (sx < edit.x && sy < edit.y) {
      result.push([sx, sy]);
      sx++;
      sy++;
    }
  }

  // Sentinel
  result.push([N, M]);
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
    
    // Literal replacement ($-safe): a plain-string replace would interpret
    // $&, $1, $$ in newText and mis-render the diff.
    const newContent = content.replace(oldText, () => newText);
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

// ─── Selective apply (per-hunk accept/reject) ───────────────────────────────

/**
 * Apply a subset of a file diff's hunks to the original content.
 *
 * Hunk indices in `acceptedHunks` refer to positions in `diff.hunks`
 * (0-based). Hunks not in the set are skipped — their original lines
 * stay, their additions are dropped.
 *
 * Returns the resulting file content. The caller writes it to disk.
 *
 * For `type === 'create'`, the whole file is either accepted (any hunk
 * accepted) or rejected (empty set) — there's no original to merge
 * against. For `type === 'delete'`, accepting any hunk deletes the file.
 */
export function applyHunks(
  diff: FileDiff,
  acceptedHunks: Set<number>,
): string {
  // Create: accept-all-or-nothing — there's no original content to
  // selectively merge into.
  if (diff.type === 'create') {
    return acceptedHunks.size > 0 ? (diff.newContent ?? '') : (diff.oldContent ?? '');
  }

  const oldLines = (diff.oldContent ?? '').split('\n');

  // No accepted hunks → original content unchanged.
  if (acceptedHunks.size === 0) {
    return oldLines.join('\n');
  }

  const acceptedHunkList = diff.hunks
    .map((h, i) => ({ hunk: h, index: i }))
    .filter(({ index }) => acceptedHunks.has(index));

  // Per-original-line union model.
  //
  // The obvious implementation — walk the hunks in order, copying original
  // lines between them and replaying each hunk's line list — is wrong for
  // hunks that sit close together, because unified-diff context OVERLAPS:
  // hunk N's trailing context is hunk N+1's leading context, so the shared
  // lines get emitted twice. Worse, with a small gap a later hunk's `remove`
  // can fall *inside* an earlier hunk's already-emitted context, so the
  // deletion is silently lost. Both corrupt the user's file on `/apply`.
  //
  // Instead reduce every accepted hunk to two facts per original line — is it
  // removed, and what is inserted after it — then rebuild the file once.
  // Overlap becomes a set union rather than double emission, and the result
  // is independent of hunk order.
  const removed = new Set<number>();               // old line numbers deleted
  const insertAfter = new Map<number, string[]>(); // old line number → inserted lines (0 = file head)

  for (const { hunk } of acceptedHunkList) {
    // Adds before any context in this hunk belong right before its start,
    // not at the top of the file.
    let anchor = Math.max(0, hunk.oldStart - 1);
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        const at = insertAfter.get(anchor);
        if (at) at.push(line.content);
        else insertAfter.set(anchor, [line.content]);
        continue;
      }
      if (line.oldLineNum === undefined) continue;
      anchor = line.oldLineNum;
      if (line.type === 'remove') removed.add(line.oldLineNum);
    }
  }

  const result: string[] = [];
  for (const head of insertAfter.get(0) ?? []) result.push(head);
  for (let n = 1; n <= oldLines.length; n++) {
    if (!removed.has(n)) result.push(oldLines[n - 1]);
    const added = insertAfter.get(n);
    if (added) for (const line of added) result.push(line);
  }

  return result.join('\n');
}

/**
 * Apply accepted hunks across multiple file diffs and return the
 * resulting content for each. The caller writes the files to disk.
 *
 * `accepted` maps file path → set of accepted hunk indices. Files not
 * in the map are skipped entirely.
 */
export function applyHunksToFiles(
  diffs: FileDiff[],
  accepted: Map<string, Set<number>>,
): Array<{ path: string; content: string; type: FileDiff['type'] }> {
  const results: Array<{ path: string; content: string; type: FileDiff['type'] }> = [];
  for (const diff of diffs) {
    const acceptedSet = accepted.get(diff.path);
    if (!acceptedSet) continue;
    const content = applyHunks(diff, acceptedSet);
    results.push({ path: diff.path, content, type: diff.type });
  }
  return results;
}

/**
 * Count how many hunks in a diff contain actual changes (not just
 * context). Used to label hunks in the UI ("hunk 2/5").
 */
export function countChangeHunks(diff: FileDiff): number {
  return diff.hunks.filter(
    (h) => h.lines.some((l) => l.type === 'add' || l.type === 'remove'),
  ).length;
}
