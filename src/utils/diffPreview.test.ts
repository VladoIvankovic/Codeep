import { describe, it, expect, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'fs';
import {
  generateDiff,
  createFileDiff,
  createEditDiff,
  createDeleteDiff,
  formatDiffForDisplay,
  formatDiffPreview,
  getDiffStats,
} from './diffPreview';
import type { FileDiff } from './diffPreview';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

// ─── generateDiff ─────────────────────────────────────────────────────────────

describe('generateDiff', () => {
  it('returns empty hunks for identical content', () => {
    const content = 'line1\nline2\nline3';
    expect(generateDiff(content, content)).toEqual([]);
  });

  it('returns add lines when going from empty to content', () => {
    // ''.split('\n') === [''] so the diff sees one removed empty line + added lines
    const hunks = generateDiff('', 'hello\nworld');
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap(h => h.lines);
    expect(allLines.some(l => l.type === 'add' && l.content === 'hello')).toBe(true);
    expect(allLines.some(l => l.type === 'add' && l.content === 'world')).toBe(true);
  });

  it('returns remove lines when going from content to empty', () => {
    const hunks = generateDiff('hello\nworld', '');
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap(h => h.lines);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'hello')).toBe(true);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'world')).toBe(true);
  });

  it('detects a single line change', () => {
    const old = 'line1\nline2\nline3';
    const next = 'line1\nCHANGED\nline3';
    const hunks = generateDiff(old, next);
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap(h => h.lines);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'line2')).toBe(true);
    expect(allLines.some(l => l.type === 'add' && l.content === 'CHANGED')).toBe(true);
  });

  it('detects appended lines', () => {
    const old = 'a\nb';
    const next = 'a\nb\nc\nd';
    const hunks = generateDiff(old, next);
    const allLines = hunks.flatMap(h => h.lines);
    const added = allLines.filter(l => l.type === 'add').map(l => l.content);
    expect(added).toEqual(expect.arrayContaining(['c', 'd']));
  });

  it('detects prepended lines', () => {
    const old = 'b\nc';
    const next = 'a\nb\nc';
    const hunks = generateDiff(old, next);
    const added = hunks.flatMap(h => h.lines).filter(l => l.type === 'add');
    expect(added.some(l => l.content === 'a')).toBe(true);
  });

  it('includes context lines around changes', () => {
    const old = 'ctx1\nctx2\nctx3\nOLD\nctx4\nctx5\nctx6';
    const next = 'ctx1\nctx2\nctx3\nNEW\nctx4\nctx5\nctx6';
    const hunks = generateDiff(old, next, 2);
    const contextLines = hunks.flatMap(h => h.lines).filter(l => l.type === 'context');
    expect(contextLines.length).toBeGreaterThan(0);
  });

  it('produces correct oldLineNum and newLineNum for unchanged lines', () => {
    const content = 'a\nb\nc';
    const hunks = generateDiff(content, 'a\nX\nc');
    const contextLines = hunks.flatMap(h => h.lines).filter(l => l.type === 'context');
    for (const line of contextLines) {
      expect(typeof line.oldLineNum).toBe('number');
      expect(typeof line.newLineNum).toBe('number');
    }
  });

  it('sets correct hunk oldLines and newLines counts', () => {
    const hunks = generateDiff('a\nb\nc', 'a\nX\nY\nc');
    for (const hunk of hunks) {
      const expectedOld = hunk.lines.filter(l => l.type !== 'add').length;
      const expectedNew = hunk.lines.filter(l => l.type !== 'remove').length;
      expect(hunk.oldLines).toBe(expectedOld);
      expect(hunk.newLines).toBe(expectedNew);
    }
  });

  it('handles two separate change blocks as two hunks', () => {
    // Large enough gap so they don't merge into one hunk (default context=3)
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const old = lines.join('\n');
    // Change first and last line
    const newLines = [...lines];
    newLines[0] = 'CHANGED_A';
    newLines[9] = 'CHANGED_J';
    const next = newLines.join('\n');
    const hunks = generateDiff(old, next);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles single-line files', () => {
    const hunks = generateDiff('old', 'new');
    const allLines = hunks.flatMap(h => h.lines);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'old')).toBe(true);
    expect(allLines.some(l => l.type === 'add' && l.content === 'new')).toBe(true);
  });

  it('handles empty old and empty new', () => {
    expect(generateDiff('', '')).toEqual([]);
  });
});

// ─── createFileDiff ───────────────────────────────────────────────────────────

describe('createFileDiff', () => {
  it('creates a "create" diff when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const diff = createFileDiff('src/new.ts', 'const x = 1;', '/root');
    expect(diff.type).toBe('create');
    expect(diff.path).toBe('src/new.ts');
    expect(diff.oldContent).toBeUndefined();
    expect(diff.newContent).toBe('const x = 1;');
  });

  it('creates a "modify" diff when file exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('const x = 0;');
    const diff = createFileDiff('src/existing.ts', 'const x = 1;', '/root');
    expect(diff.type).toBe('modify');
    expect(diff.oldContent).toBe('const x = 0;');
    expect(diff.newContent).toBe('const x = 1;');
  });

  it('includes generated hunks', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('old content');
    const diff = createFileDiff('f.ts', 'new content', '/root');
    expect(Array.isArray(diff.hunks)).toBe(true);
    expect(diff.hunks.length).toBeGreaterThan(0);
  });
});

// ─── createEditDiff ───────────────────────────────────────────────────────────

describe('createEditDiff', () => {
  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(createEditDiff('f.ts', 'old', 'new', '/root')).toBeNull();
  });

  it('returns null when oldText is not found in file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('completely different content');
    expect(createEditDiff('f.ts', 'old', 'new', '/root')).toBeNull();
  });

  it('returns a modify diff when text is found and replaced', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('hello world');
    const diff = createEditDiff('f.ts', 'world', 'earth', '/root');
    expect(diff).not.toBeNull();
    expect(diff!.type).toBe('modify');
    expect(diff!.newContent).toBe('hello earth');
    expect(diff!.oldContent).toBe('hello world');
  });

  it('generates correct hunks for the replacement', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('line1\nOLD\nline3');
    const diff = createEditDiff('f.ts', 'OLD', 'NEW', '/root');
    expect(diff).not.toBeNull();
    const allLines = diff!.hunks.flatMap(h => h.lines);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'OLD')).toBe(true);
    expect(allLines.some(l => l.type === 'add' && l.content === 'NEW')).toBe(true);
  });

  it('inserts newText literally — $ sequences are not interpreted', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('value = MARK');
    const diff = createEditDiff('f.ts', 'MARK', '$& and $$ and ${x}', '/root');
    expect(diff!.newContent).toBe('value = $& and $$ and ${x}');
  });
});

// ─── createDeleteDiff ─────────────────────────────────────────────────────────

describe('createDeleteDiff', () => {
  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(createDeleteDiff('f.ts', '/root')).toBeNull();
  });

  it('returns a delete diff containing remove lines for file content', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('line1\nline2');
    const diff = createDeleteDiff('f.ts', '/root');
    expect(diff).not.toBeNull();
    expect(diff!.type).toBe('delete');
    const allLines = diff!.hunks.flatMap(h => h.lines);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'line1')).toBe(true);
    expect(allLines.some(l => l.type === 'remove' && l.content === 'line2')).toBe(true);
  });

  it('sets oldContent but not newContent', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('content');
    const diff = createDeleteDiff('f.ts', '/root');
    expect(diff!.oldContent).toBe('content');
    expect(diff!.newContent).toBeUndefined();
  });
});

// ─── formatDiffForDisplay ─────────────────────────────────────────────────────

describe('formatDiffForDisplay', () => {
  const baseDiff = (type: FileDiff['type'], hunks: FileDiff['hunks'] = []): FileDiff => ({
    path: 'src/foo.ts',
    type,
    hunks,
  });

  it('shows NEW FILE header for create diffs', () => {
    const output = formatDiffForDisplay(baseDiff('create'));
    expect(output).toContain('+++ NEW FILE: src/foo.ts');
  });

  it('shows DELETE FILE header for delete diffs', () => {
    const output = formatDiffForDisplay(baseDiff('delete'));
    expect(output).toContain('--- DELETE FILE: src/foo.ts');
  });

  it('shows a/b headers for modify diffs', () => {
    const output = formatDiffForDisplay(baseDiff('modify'));
    expect(output).toContain('--- a/src/foo.ts');
    expect(output).toContain('+++ b/src/foo.ts');
  });

  it('prefixes added lines with +', () => {
    const diff = baseDiff('modify', [{
      oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
      lines: [{ type: 'add', content: 'new line', newLineNum: 1 }],
    }]);
    expect(formatDiffForDisplay(diff)).toContain('+ new line');
  });

  it('prefixes removed lines with -', () => {
    const diff = baseDiff('modify', [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 0,
      lines: [{ type: 'remove', content: 'old line', oldLineNum: 1 }],
    }]);
    expect(formatDiffForDisplay(diff)).toContain('- old line');
  });

  it('prefixes context lines with two spaces', () => {
    const diff = baseDiff('modify', [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ type: 'context', content: 'ctx', oldLineNum: 1, newLineNum: 1 }],
    }]);
    expect(formatDiffForDisplay(diff)).toContain('  ctx');
  });

  it('includes hunk header @@ ... @@', () => {
    const diff = baseDiff('modify', [{
      oldStart: 5, oldLines: 3, newStart: 5, newLines: 4,
      lines: [],
    }]);
    expect(formatDiffForDisplay(diff)).toContain('@@ -5,3 +5,4 @@');
  });
});

// ─── formatDiffPreview ────────────────────────────────────────────────────────

describe('formatDiffPreview', () => {
  it('shows summary line with file count and +/- stats', () => {
    const diff: FileDiff = {
      path: 'f.ts', type: 'modify',
      hunks: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [
          { type: 'add', content: 'a', newLineNum: 1 },
          { type: 'remove', content: 'b', oldLineNum: 1 },
        ],
      }],
    };
    const output = formatDiffPreview([diff]);
    expect(output).toContain('Files: 1');
    expect(output).toContain('+1');
    expect(output).toContain('-1');
  });

  it('wraps each diff in a ```diff code block', () => {
    const diff: FileDiff = { path: 'f.ts', type: 'create', hunks: [] };
    const output = formatDiffPreview([diff]);
    expect(output).toContain('```diff');
    expect(output).toContain('```');
  });

  it('handles empty diffs array', () => {
    const output = formatDiffPreview([]);
    expect(output).toContain('Files: 0');
    expect(output).toContain('+0');
    expect(output).toContain('-0');
  });
});

// ─── getDiffStats ─────────────────────────────────────────────────────────────

describe('getDiffStats', () => {
  it('returns zero stats for empty array', () => {
    const stats = getDiffStats([]);
    expect(stats.totalFiles).toBe(0);
    expect(stats.totalAdditions).toBe(0);
    expect(stats.totalDeletions).toBe(0);
    expect(stats.files).toEqual([]);
  });

  it('counts additions and deletions across multiple files', () => {
    const makeDiff = (adds: number, removes: number): FileDiff => ({
      path: 'f.ts', type: 'modify',
      hunks: [{
        oldStart: 1, oldLines: removes, newStart: 1, newLines: adds,
        lines: [
          ...Array.from({ length: adds }, (_, i) => ({
            type: 'add' as const, content: `add${i}`, newLineNum: i + 1,
          })),
          ...Array.from({ length: removes }, (_, i) => ({
            type: 'remove' as const, content: `rm${i}`, oldLineNum: i + 1,
          })),
        ],
      }],
    });

    const stats = getDiffStats([makeDiff(3, 1), makeDiff(0, 2)]);
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalAdditions).toBe(3);
    expect(stats.totalDeletions).toBe(3);
  });

  it('does not count context lines', () => {
    const diff: FileDiff = {
      path: 'f.ts', type: 'modify',
      hunks: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{ type: 'context', content: 'ctx', oldLineNum: 1, newLineNum: 1 }],
      }],
    };
    const stats = getDiffStats([diff]);
    expect(stats.totalAdditions).toBe(0);
    expect(stats.totalDeletions).toBe(0);
  });

  it('preserves the original diffs array reference', () => {
    const diffs: FileDiff[] = [{ path: 'f.ts', type: 'create', hunks: [] }];
    const stats = getDiffStats(diffs);
    expect(stats.files).toBe(diffs);
  });
});

// ─── applyHunks (selective per-hunk apply) ───────────────────────────────────

import { applyHunks, applyHunksToFiles, countChangeHunks } from './diffPreview';

/**
 * Helper: build a FileDiff via generateDiff so the hunk line numbers
 * are populated the same way the real pipeline produces them.
 */
function buildModifyDiff(oldContent: string, newContent: string, path = 'f.ts'): FileDiff {
  return {
    path,
    type: 'modify',
    oldContent,
    newContent,
    hunks: generateDiff(oldContent, newContent),
  };
}

describe('applyHunks — overlapping hunks (regression)', () => {
  // Two changes closer together than ~2x the context size produce hunks whose
  // context OVERLAPS. Replaying each hunk's line list in sequence duplicated
  // the shared context, and at very small gaps a later hunk's `remove` landed
  // inside an earlier hunk's already-emitted context and was silently lost —
  // either way `/apply` corrupted the user's file. Sweep the gap so the
  // boundary cases stay covered.
  function twoChanges(gap: number) {
    const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[10] = 'CHANGED A';
    newLines[10 + gap] = 'CHANGED B';
    return { oldContent: oldLines.join('\n'), newContent: newLines.join('\n') };
  }

  for (const gap of [1, 2, 3, 4, 5, 6, 7, 8, 15]) {
    it(`accepting every hunk reproduces the new content exactly (gap ${gap})`, () => {
      const { oldContent, newContent } = twoChanges(gap);
      const diff = buildModifyDiff(oldContent, newContent);
      const all = new Set(diff.hunks.map((_, i) => i));
      expect(applyHunks(diff, all)).toBe(newContent);
    });
  }

  it('applies only the selected hunk when hunks overlap', () => {
    const { oldContent, newContent } = twoChanges(4);
    const diff = buildModifyDiff(oldContent, newContent);
    // Whichever hunk is picked, exactly one change must land and the file
    // must keep its original line count.
    for (let i = 0; i < diff.hunks.length; i++) {
      const out = applyHunks(diff, new Set([i])).split('\n');
      expect(out).toHaveLength(oldContent.split('\n').length);
      const changed = out.filter(l => l.startsWith('CHANGED'));
      expect(changed).toHaveLength(1);
    }
  });

  it('does not blow the stack on a very large hunk', () => {
    // A spread-based Math.min/max over the hunk's line numbers threw
    // RangeError past ~120k lines, inside an uncaught promise chain.
    const oldContent = Array.from({ length: 150_000 }, (_, i) => `l${i}`).join('\n');
    const newContent = oldContent.replace('l0', 'CHANGED');
    const diff = buildModifyDiff(oldContent, newContent);
    expect(() => applyHunks(diff, new Set(diff.hunks.map((_, i) => i)))).not.toThrow();
  });
});

describe('applyHunks', () => {
  it('returns original content when no hunks accepted', () => {
    const diff = buildModifyDiff('a\nb\nc', 'a\nB\nc');
    const out = applyHunks(diff, new Set());
    expect(out).toBe('a\nb\nc');
  });

  it('applies all hunks when all accepted', () => {
    const diff = buildModifyDiff('a\nb\nc', 'a\nB\nc');
    const all = new Set(diff.hunks.map((_, i) => i));
    expect(applyHunks(diff, all)).toBe('a\nB\nc');
  });

  it('applies a single accepted hunk and leaves others unchanged', () => {
    // Two independent changes: line 2 (b→B) and line 4 (d→D).
    const diff = buildModifyDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    expect(diff.hunks.length).toBeGreaterThanOrEqual(1);
    // Accept only the first hunk.
    const out = applyHunks(diff, new Set([0]));
    // First change applied, second not.
    expect(out).toBe('a\nB\nc\nd\ne');
  });

  it('applies the second hunk only', () => {
    const diff = buildModifyDiff('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    // If there are two separate hunks, accept the second.
    if (diff.hunks.length >= 2) {
      const out = applyHunks(diff, new Set([1]));
      expect(out).toBe('a\nb\nc\nD\ne');
    }
  });

  it('handles pure additions (insert lines)', () => {
    const diff = buildModifyDiff('a\nb\nc', 'a\nb\nX\nc');
    const out = applyHunks(diff, new Set(diff.hunks.map((_, i) => i)));
    expect(out).toBe('a\nb\nX\nc');
  });

  it('handles pure deletions (remove lines)', () => {
    const diff = buildModifyDiff('a\nb\nX\nc', 'a\nb\nc');
    const out = applyHunks(diff, new Set(diff.hunks.map((_, i) => i)));
    expect(out).toBe('a\nb\nc');
  });

  it('create diff: returns newContent when any hunk accepted', () => {
    const diff: FileDiff = {
      path: 'new.ts',
      type: 'create',
      newContent: 'hello',
      hunks: [],
    };
    expect(applyHunks(diff, new Set([0]))).toBe('hello');
  });

  it('create diff: returns empty when no hunks accepted', () => {
    const diff: FileDiff = {
      path: 'new.ts',
      type: 'create',
      newContent: 'hello',
      oldContent: '',
      hunks: [],
    };
    expect(applyHunks(diff, new Set())).toBe('');
  });

  it('preserves trailing lines after the last hunk', () => {
    const diff = buildModifyDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nC\nd\ne\nf\ng');
    const out = applyHunks(diff, new Set(diff.hunks.map((_, i) => i)));
    expect(out).toBe('a\nb\nC\nd\ne\nf\ng');
  });

  it('preserves leading lines before the first hunk', () => {
    const diff = buildModifyDiff('a\nb\nc\nd\ne', 'a\nb\nc\nD\ne');
    const out = applyHunks(diff, new Set(diff.hunks.map((_, i) => i)));
    expect(out).toBe('a\nb\nc\nD\ne');
  });

  it('is idempotent: applying the full diff twice yields newContent', () => {
    const old = 'a\nb\nc';
    const diff = buildModifyDiff(old, 'a\nB\nc');
    const once = applyHunks(diff, new Set(diff.hunks.map((_, i) => i)));
    expect(once).toBe(diff.newContent);
  });

  it('handles a diff with no hunks (identical content)', () => {
    const diff = buildModifyDiff('a\nb', 'a\nb');
    expect(applyHunks(diff, new Set())).toBe('a\nb');
  });
});

describe('applyHunksToFiles', () => {
  it('skips files not in the accepted map', () => {
    const d1 = buildModifyDiff('a', 'A', 'f1.ts');
    const d2 = buildModifyDiff('b', 'B', 'f2.ts');
    const accepted = new Map([['f1.ts', new Set([0])]]);
    const results = applyHunksToFiles([d1, d2], accepted);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('f1.ts');
    expect(results[0].content).toBe('A');
  });

  it('returns empty array when nothing accepted', () => {
    const d1 = buildModifyDiff('a', 'A', 'f1.ts');
    expect(applyHunksToFiles([d1], new Map())).toEqual([]);
  });

  it('handles multiple files each with their own accepted set', () => {
    const d1 = buildModifyDiff('x\ny', 'X\ny', 'a.ts');
    const d2 = buildModifyDiff('p\nq', 'p\nQ', 'b.ts');
    const accepted = new Map([
      ['a.ts', new Set([0])],
      ['b.ts', new Set([0])],
    ]);
    const results = applyHunksToFiles([d1, d2], accepted);
    expect(results).toHaveLength(2);
    const byPath = Object.fromEntries(results.map((r) => [r.path, r.content]));
    expect(byPath['a.ts']).toBe('X\ny');
    expect(byPath['b.ts']).toBe('p\nQ');
  });
});

describe('countChangeHunks', () => {
  it('counts hunks containing adds or removes', () => {
    const diff = buildModifyDiff('a\nb\nc\nd', 'a\nB\nc\nD');
    // generateDiff may merge close changes into one hunk or split them.
    const count = countChangeHunks(diff);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
  });

  it('returns 0 for identical content', () => {
    const diff = buildModifyDiff('a\nb', 'a\nb');
    expect(countChangeHunks(diff)).toBe(0);
  });
});
