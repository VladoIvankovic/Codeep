// Unit tests for the extracted HunkPicker component (P2 App.ts refactor).
// The picker logic was previously inline in App.ts and untestable in
// isolation; these tests pin the y/n/a/q/↑/↓ semantics and the
// fires-exactly-once onComplete contract.

import { describe, it, expect, vi } from 'vitest';
import {
  createHunkPickerState,
  handleHunkPickerKey,
  hunkPickerPanelHeight,
  type HunkPickerItem,
  type HunkPickerOptions,
  type HunkPickerState,
} from './HunkPicker';

function makeItems(n: number): HunkPickerItem[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `file${i}.ts`,
    hunkIndex: i,
    header: `@@ -1,${i + 1} +1,${i + 2} @@`,
    lines: [`@@ -1,${i + 1} +1,${i + 2} @@`, '-old', '+new'],
  }));
}

function makeOptions(onComplete: HunkPickerOptions['onComplete'], n = 3): HunkPickerOptions {
  return { title: 'Apply hunks', items: makeItems(n), onComplete };
}

function key(k: string): { key: string } {
  return { key: k };
}

/** An open picker state over the given options. */
function openState(options: HunkPickerOptions): HunkPickerState {
  return { open: true, options, index: 0, accepted: [] };
}

describe('HunkPicker', () => {
  it('fresh state is closed with no options', () => {
    const s = createHunkPickerState();
    expect(s.open).toBe(false);
    expect(s.options).toBeNull();
    expect(s.index).toBe(0);
    expect(s.accepted).toEqual([]);
  });

  describe('key handling', () => {
    it('accepts with y and advances', () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb));
      s = handleHunkPickerKey(s, key('y'));
      expect(s.index).toBe(1);
      expect(s.accepted).toEqual([{ path: 'file0.ts', hunkIndex: 0 }]);
      expect(cb).not.toHaveBeenCalled();
    });

    it('skips with n without recording', () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb));
      s = handleHunkPickerKey(s, key('n'));
      expect(s.index).toBe(1);
      expect(s.accepted).toEqual([]);
    });

    it('enter and right also accept; left skips', () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 4));
      s = handleHunkPickerKey(s, key('enter'));
      expect(s.accepted.length).toBe(1);
      s = handleHunkPickerKey(s, key('right'));
      expect(s.accepted.length).toBe(2);
      s = handleHunkPickerKey(s, key('left'));
      expect(s.accepted.length).toBe(2); // skip doesn't record
      expect(s.index).toBe(3);           // still advancing (2 → 3)
      expect(s.open).toBe(true);         // mid-list skip doesn't finish
    });

    it('finishes after the last item, firing onComplete exactly once', () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 2));
      s = handleHunkPickerKey(s, key('y')); // item 0 → index 1
      s = handleHunkPickerKey(s, key('y')); // item 1 → last → finish
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith([
        { path: 'file0.ts', hunkIndex: 0 },
        { path: 'file1.ts', hunkIndex: 1 },
      ]);
      expect(s.open).toBe(false);
      expect(s.options).toBeNull();
    });

    it("'a' accepts current + all remaining and finishes", () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 4));
      s = handleHunkPickerKey(s, key('y')); // accept item 0
      s = handleHunkPickerKey(s, key('a')); // accept items 1..3 + finish
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith([
        { path: 'file0.ts', hunkIndex: 0 },
        { path: 'file1.ts', hunkIndex: 1 },
        { path: 'file2.ts', hunkIndex: 2 },
        { path: 'file3.ts', hunkIndex: 3 },
      ]);
      expect(s.open).toBe(false);
    });

    it("'q' finishes with only what was accepted so far", () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 4));
      s = handleHunkPickerKey(s, key('y'));
      s = handleHunkPickerKey(s, key('q'));
      expect(cb).toHaveBeenCalledWith([{ path: 'file0.ts', hunkIndex: 0 }]);
      expect(s.open).toBe(false);
    });

    it("'escape' behaves like q", () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 4));
      s = handleHunkPickerKey(s, key('escape'));
      expect(cb).toHaveBeenCalledWith([]);
    });

    it('navigates with up/down without mutating accepted', () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 3));
      s = handleHunkPickerKey(s, key('down'));
      s = handleHunkPickerKey(s, key('down'));
      expect(s.index).toBe(2);
      s = handleHunkPickerKey(s, key('up'));
      expect(s.index).toBe(1);
      expect(s.accepted).toEqual([]);
    });

    it('ignores unrelated keys', () => {
      const cb = vi.fn();
      const s0 = openState(makeOptions(cb));
      const s = handleHunkPickerKey(s0, key('x'));
      expect(s.index).toBe(s0.index);
      expect(s.accepted).toEqual(s0.accepted);
      expect(cb).not.toHaveBeenCalled();
    });

    it('clamped at the last item (down does not overflow)', () => {
      const cb = vi.fn();
      let s = openState(makeOptions(cb, 2));
      s = handleHunkPickerKey(s, key('down'));
      s = handleHunkPickerKey(s, key('down')); // already at last
      expect(s.index).toBe(1);
      expect(s.open).toBe(true);
    });
  });

  describe('layout contract', () => {
    it('panel height is exported and stable', () => {
      // layout.ts hardcodes this value — if it changes here, update there.
      expect(hunkPickerPanelHeight()).toBe(18);
    });
  });
});
