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
