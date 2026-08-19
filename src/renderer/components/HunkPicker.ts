// components/HunkPicker.ts
// Interactive hunk-by-hunk diff picker for `/apply --interactive`.
//
// Extracted from App.ts (P2 refactor) following the established component
// convention (Settings/Export/Search): a pure-ish state object + key handler
// + render function, so App.ts only owns a HunkPickerState field and the
// wiring. The picker walks the user through items one at a time; for each
// they accept (`y`/Enter/→) or skip (`n`/←). `a` accepts all remaining,
// `q`/Esc quits. `onComplete` fires exactly once with the accepted set.

import type { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { PRIMARY_COLOR } from './uiConstants';

/** One hunk in the interactive `/apply --interactive` picker. */
export interface HunkPickerItem {
  /** File path this hunk belongs to. */
  path: string;
  /** 0-based hunk index within the file diff. */
  hunkIndex: number;
  /** Human-readable hunk header, e.g. `@@ -12,3 +12,5 @@`. */
  header: string;
  /** Pre-formatted diff lines to display. */
  lines: string[];
}

export interface HunkPickerOptions {
  title: string;
  items: HunkPickerItem[];
  onComplete: (accepted: Array<{ path: string; hunkIndex: number }>) => void;
}

export interface HunkPickerState {
  open: boolean;
  options: HunkPickerOptions | null;
  index: number;
  accepted: Array<{ path: string; hunkIndex: number }>;
}

export function createHunkPickerState(): HunkPickerState {
  return { open: false, options: null, index: 0, accepted: [] };
}

/** Minimal key shape App's KeyEvent satisfies. */
export interface HunkPickerKeyEvent {
  key: string;
}

/**
 * Handle one key event for the picker. Returns the (possibly updated) state
 * and whether the picker consumed the event (always true while open — the
 * picker is modal). `onComplete` from the options fires exactly once, from
 * `finish()`; after that the state is reset to closed.
 */
export function handleHunkPickerKey(
  state: HunkPickerState,
  event: HunkPickerKeyEvent,
): HunkPickerState {
  const opts = state.options;
  if (!opts || !state.open) {
    return { ...state, open: false };
  }

  const finish = (): HunkPickerState => {
    const accepted = state.accepted;
    const cb = opts.onComplete;
    // Reset first so a re-entrant show() from the callback can't race the
    // stale state; then fire the callback once.
    const next = createHunkPickerState();
    cb(accepted);
    return next;
  };

  const advance = (): HunkPickerState => {
    if (state.index >= opts.items.length - 1) {
      return finish();
    }
    return { ...state, index: state.index + 1 };
  };

  const acceptCurrent = (): HunkPickerState => {
    const item = opts.items[state.index];
    if (item) {
      return advanceWith(state, { path: item.path, hunkIndex: item.hunkIndex });
    }
    return advance();
  };

  const advanceWith = (
    s: HunkPickerState,
    entry: { path: string; hunkIndex: number },
  ): HunkPickerState => {
    const next: HunkPickerState = { ...s, accepted: [...s.accepted, entry] };
    if (next.index >= opts.items.length - 1) {
      return finishFrom(next);
    }
    return { ...next, index: next.index + 1 };
  };

  const finishFrom = (s: HunkPickerState): HunkPickerState => {
    const cb = opts.onComplete;
    const next = createHunkPickerState();
    cb(s.accepted);
    return next;
  };

  switch (event.key) {
    case 'y':
    case 'enter':
    case 'right':
      return acceptCurrent();
    case 'n':
    case 'left':
      return advance();
    case 'a': {
      // Accept current + all remaining.
      const accepted = [...state.accepted];
      for (let i = state.index; i < opts.items.length; i++) {
        const item = opts.items[i];
        accepted.push({ path: item.path, hunkIndex: item.hunkIndex });
      }
      return finishFrom({ ...state, accepted });
    }
    case 'q':
    case 'escape':
      return finish();
    case 'up':
      return state.index > 0 ? { ...state, index: state.index - 1 } : state;
    case 'down':
      return state.index < opts.items.length - 1
        ? { ...state, index: state.index + 1 }
        : state;
    default:
      return state;
  }
}

/** Panel height the layout needs to reserve for the picker. */
export function hunkPickerPanelHeight(): number {
  // Title + progress + path + header + up to 12 diff lines + more marker + legend.
  return 18;
}

/**
 * Paint the picker into the screen. Mirrors the rendering previously inlined
 * in App.renderInlineHunkPicker.
 */
export function renderHunkPicker(
  screen: Screen,
  state: HunkPickerState,
  startY: number,
  width: number,
): void {
  const opts = state.options;
  if (!opts) return;
  const item = opts.items[state.index];

  let y = startY;
  screen.horizontalLine(y++, '─', PRIMARY_COLOR);

  // Title + progress
  const progress =
    opts.items.length > 0 ? ` (${state.index + 1}/${opts.items.length})` : '';
  screen.writeLine(y++, `${opts.title}${progress}`, PRIMARY_COLOR + style.bold);

  if (!item) {
    screen.writeLine(y++, 'No hunks to review.', fg.gray);
    screen.writeLine(y, 'Press any key to close.', fg.gray);
    return;
  }

  // File path + hunk header
  screen.writeLine(y++, `File: ${item.path}`, fg.cyan);
  screen.writeLine(y++, `Hunk: ${item.header}`, fg.gray);

  // Diff lines (capped to available vertical space; show up to 12)
  const maxDiffLines = 12;
  const lines = item.lines.slice(0, maxDiffLines);
  for (const line of lines) {
    const prefix = line.charAt(0);
    let color = fg.white;
    if (prefix === '+') color = fg.green;
    else if (prefix === '-') color = fg.red;
    else if (prefix === '@') color = fg.cyan;
    // Truncate long lines to terminal width.
    const truncated =
      line.length > width - 2 ? line.slice(0, width - 5) + '...' : line;
    screen.writeLine(y++, `  ${truncated}`, color);
  }
  if (item.lines.length > maxDiffLines) {
    screen.writeLine(
      y++,
      `  … (${item.lines.length - maxDiffLines} more lines)`,
      fg.gray,
    );
  }

  y++;
  // Key legend
  screen.writeLine(
    y,
    'y/Enter accept • n skip • a accept all • q/Esc quit • ↑/↓ navigate',
    fg.gray,
  );
}
