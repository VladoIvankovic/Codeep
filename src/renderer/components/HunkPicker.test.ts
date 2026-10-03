// Unit tests for the extracted HunkPicker component (P2 App.ts refactor).
// The picker logic was previously inline in App.ts and untestable in
// isolation; these tests pin the y/n/a/q/↑/↓ semantics and the
// fires-exactly-once onComplete contract.

import { describe, it, expect, vi } from 'vitest';
import {
  createHunkPickerState,
  handleHunkPickerKey,
  hunkPickerLegend,
  hunkPickerPanelHeight,
  renderHunkPicker,
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

  // /apply -i wrote on a single y or a, also to a file that decides what runs
  // later (.git/*, hooks, MCP server lists, skills) or one outside the
  // project. Those hunks take an Enter after the key, as /apply's dialog does.
  describe('a hunk that needs Enter', () => {
    /** Items 0 and 2 are ordinary; item 1 is `.git/hooks/pre-commit`. */
    function riskyOptions(onComplete: HunkPickerOptions['onComplete']): HunkPickerOptions {
      const items = makeItems(3);
      items[1] = { ...items[1], path: '.git/hooks/pre-commit', needsEnter: 'decides what runs later' };
      return { title: 'Apply hunks', items, onComplete };
    }
    const at = (options: HunkPickerOptions, index: number): HunkPickerState => ({ ...openState(options), index });

    for (const k of ['y', 'right', 'enter']) {
      it(`is selected, not accepted, by ${k}; Enter then accepts it`, () => {
        const cb = vi.fn();
        let s = handleHunkPickerKey(at(riskyOptions(cb), 1), key(k));
        expect(s.accepted).toEqual([]);
        expect(s.index).toBe(1);
        expect(s.pending).toBe('one');
        s = handleHunkPickerKey(s, key('enter'));
        expect(s.accepted).toEqual([{ path: '.git/hooks/pre-commit', hunkIndex: 1 }]);
        expect(s.index).toBe(2);
        expect(s.pending ?? null).toBeNull();
      });
    }

    it('is not written on a single y when it is the last hunk', () => {
      const cb = vi.fn();
      const options = riskyOptions(cb);
      options.items = [options.items[1]];
      let s = handleHunkPickerKey(openState(options), key('y'));
      expect(cb).not.toHaveBeenCalled();
      expect(s.open).toBe(true);
      s = handleHunkPickerKey(s, key('enter'));
      expect(cb).toHaveBeenCalledWith([{ path: '.git/hooks/pre-commit', hunkIndex: 1 }]);
      expect(s.open).toBe(false);
    });

    it('drops the selection on any other key, which does nothing else', () => {
      const cb = vi.fn();
      for (const k of ['n', 'escape', 'q', 'y', 'down', 'a']) {
        let s = handleHunkPickerKey(at(riskyOptions(cb), 1), key('y'));
        s = handleHunkPickerKey(s, key(k));
        expect(s.pending ?? null, k).toBeNull();
        expect(s.index, k).toBe(1);
        expect(s.open, k).toBe(true);
        expect(s.accepted, k).toEqual([]);
      }
      expect(cb).not.toHaveBeenCalled();
    });

    it('can still be skipped with n, and quit with Esc', () => {
      const cb = vi.fn();
      expect(handleHunkPickerKey(at(riskyOptions(cb), 1), key('n')).index).toBe(2);
      handleHunkPickerKey(at(riskyOptions(cb), 1), key('escape'));
      expect(cb).toHaveBeenCalledWith([]);
    });

    it('makes "a" ask for Enter when it is among the remaining hunks', () => {
      const cb = vi.fn();
      let s = handleHunkPickerKey(at(riskyOptions(cb), 0), key('a'));
      expect(cb).not.toHaveBeenCalled();
      expect(s.pending).toBe('all');
      s = handleHunkPickerKey(s, key('enter'));
      expect(cb).toHaveBeenCalledWith([
        { path: 'file0.ts', hunkIndex: 0 },
        { path: '.git/hooks/pre-commit', hunkIndex: 1 },
        { path: 'file2.ts', hunkIndex: 2 },
      ]);
      expect(s.open).toBe(false);
    });

    it('lets "a" cancel on any other key', () => {
      const cb = vi.fn();
      let s = handleHunkPickerKey(at(riskyOptions(cb), 0), key('a'));
      s = handleHunkPickerKey(s, key('n'));
      expect(s.pending ?? null).toBeNull();
      expect(s.index).toBe(0);
      expect(cb).not.toHaveBeenCalled();
    });

    it('leaves ordinary hunks on one key, and "a" past it on one key', () => {
      const cb = vi.fn();
      let s = handleHunkPickerKey(at(riskyOptions(cb), 0), key('y'));
      expect(s.accepted).toEqual([{ path: 'file0.ts', hunkIndex: 0 }]);
      s = handleHunkPickerKey(at(riskyOptions(cb), 2), key('a'));
      expect(cb).toHaveBeenCalledWith([{ path: 'file2.ts', hunkIndex: 2 }]);
    });
  });

  describe('legend', () => {
    function riskyAt(index: number, pending?: 'one' | 'all'): HunkPickerState {
      const items = makeItems(3);
      items[1] = { ...items[1], needsEnter: 'outside the project' };
      return { open: true, options: { title: 't', items, onComplete: () => {} }, index, accepted: [], pending };
    }

    it('is the one-key legend when no hunk needs Enter', () => {
      expect(hunkPickerLegend(openState(makeOptions(() => {})))).toBe(
        'y/Enter accept • n skip • a accept all • q/Esc quit • ↑/↓ navigate');
    });

    it('says a hunk that needs Enter takes one after the key', () => {
      expect(hunkPickerLegend(riskyAt(1))).toBe(
        'y/Enter, then Enter, accept • n skip • a, then Enter, accept all • q/Esc quit • ↑/↓ navigate');
    });

    it('says "a" needs Enter while such a hunk is still to come', () => {
      expect(hunkPickerLegend(riskyAt(0))).toBe(
        'y/Enter accept • n skip • a, then Enter, accept all • q/Esc quit • ↑/↓ navigate');
      expect(hunkPickerLegend(riskyAt(2))).toBe(
        'y/Enter accept • n skip • a accept all • q/Esc quit • ↑/↓ navigate');
    });

    it('says what Enter does while it is awaited', () => {
      expect(hunkPickerLegend(riskyAt(1, 'one'))).toBe('Enter accepts this hunk • any other key cancels');
      expect(hunkPickerLegend(riskyAt(0, 'all'))).toBe('Enter accepts all 3 remaining hunks • any other key cancels');
    });
  });

  describe('render', () => {
    it('shows why a hunk needs Enter, and the legend that says so', () => {
      const lines: string[] = [];
      const screen = {
        horizontalLine: () => {},
        writeLine: (y: number, text: string) => { lines[y] = text; },
      } as unknown as Parameters<typeof renderHunkPicker>[0];
      const items = makeItems(2);
      items[0] = { ...items[0], path: '.mcp.json', needsEnter: 'decides what runs later' };
      const state: HunkPickerState = { open: true, options: { title: 'Review', items, onComplete: () => {} }, index: 0, accepted: [] };
      renderHunkPicker(screen, state, 0, 120);
      expect(lines).toContain('File: .mcp.json  (decides what runs later)');
      expect(lines).toContain(hunkPickerLegend(state));
      renderHunkPicker(screen, { ...state, pending: 'one' }, 0, 120);
      expect(lines).toContain('Enter accepts this hunk • any other key cancels');
    });
  });
});
