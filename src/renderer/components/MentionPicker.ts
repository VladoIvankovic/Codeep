// components/MentionPicker.ts
// `@mention` file autocomplete — mid-sentence `@path/to/file` picker.
//
// Extracted from App.ts (P2 refactor) following the component convention.
// Separate from the `/command` Autocomplete because mentions appear
// mid-sentence (not just at the start) and insert a file path (not a slash
// command). `atStart` is the index of the `@` in the editor value, used to
// replace `@query` with `@selectedPath` on Tab.
//
// App keeps the editor mutations (setValue/setCursorPos) as side effects;
// this module owns the state shape, navigation, selection math, and render.

import type { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { PRIMARY_COLOR } from './uiConstants';
import type { MentionSuggestion } from '../../utils/mentions';

export interface MentionPickerState {
  open: boolean;
  index: number;
  items: MentionSuggestion[];
  /** Index of the `@` in the editor value at the time the query started. */
  atStart: number;
  /** Project root used to resolve suggestions (cached per update). */
  root: string;
}

export function createMentionPickerState(): MentionPickerState {
  return { open: false, index: 0, items: [], atStart: 0, root: '' };
}

/** Set the picker to a fresh query result. */
export function openMentionPicker(
  state: MentionPickerState,
  items: MentionSuggestion[],
  atStart: number,
  root: string,
): MentionPickerState {
  return { open: items.length > 0, index: 0, items, atStart, root };
}

/** Close the picker and clear its items. */
export function closeMentionPicker(state: MentionPickerState): MentionPickerState {
  return { ...state, open: false, items: [] };
}

/** Minimal key shape App's KeyEvent satisfies. */
export interface MentionPickerKeyEvent {
  key: string;
}

/** What App should do after a key press. */
export type MentionPickerAction =
  | { type: 'none' } // key not for us — fall through to the editor
  | { type: 'close' } // Esc (or selection applied) — picker closes
  | { type: 'navigate'; delta: -1 | 1 }
  | { type: 'select'; suggestion: MentionSuggestion; atStart: number };

/**
 * Handle one key event while the mention picker is open. Returns the next
 * state plus an action; `select` carries the chosen suggestion and the
 * `@` index so App can rewrite the editor buffer.
 */
export function handleMentionPickerKey(
  state: MentionPickerState,
  event: MentionPickerKeyEvent,
): { state: MentionPickerState; action: MentionPickerAction } {
  switch (event.key) {
    case 'up':
      return {
        state: { ...state, index: Math.max(0, state.index - 1) },
        action: { type: 'navigate', delta: -1 },
      };
    case 'down':
      return {
        state: {
          ...state,
          index: Math.min(state.items.length - 1, state.index + 1),
        },
        action: { type: 'navigate', delta: 1 },
      };
    case 'tab':
      if (state.items.length > 0) {
        const suggestion = state.items[state.index];
        return {
          state: closeMentionPicker(state),
          action: { type: 'select', suggestion, atStart: state.atStart },
        };
      }
      return { state, action: { type: 'none' } };
    default:
      return { state, action: { type: 'none' } };
  }
}

/**
 * Compute the editor buffer after applying a mention selection. Pure:
 * returns the next value + cursor position for App to set.
 *
 * `atStart` is the index OF the `@`, so the `before` slice EXCLUDES it —
 * the sigil is re-added or the completed path is no longer a mention and
 * the file never gets attached.
 */
export function applyMentionToBuffer(
  value: string,
  cursor: number,
  atStart: number,
  suggestion: MentionSuggestion,
): { value: string; cursor: number } {
  const before = value.slice(0, atStart) + '@';
  const after = value.slice(cursor);
  const next = before + suggestion.insertPath + ' ' + after;
  return { value: next, cursor: (before + suggestion.insertPath + ' ').length };
}

/**
 * Paint the mention picker below the status bar. Mirrors the layout of the
 * `/` Autocomplete (separator → title → items → footer) but shows file
 * paths with their parent directory as the description, and an `@` prefix.
 */
export function renderMentionPicker(
  screen: Screen,
  state: MentionPickerState,
  startY: number,
): void {
  const items = state.items;
  const maxVisible = Math.min(items.length, 8);

  let y = startY;

  // Separator line
  screen.horizontalLine(y++, '─', PRIMARY_COLOR);

  // Title
  screen.writeLine(
    y++,
    'Add file to context (@mention)',
    PRIMARY_COLOR + style.bold,
  );

  // Items: `path` + directory detail
  const visibleStart = Math.max(0, state.index - maxVisible + 1);
  const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);

  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const actualIndex = visibleStart + i;
    const isSelected = actualIndex === state.index;

    const prefix = isSelected ? '► ' : '  ';
    const pathText = ('@' + item.label).padEnd(40);

    if (isSelected) {
      screen.write(0, y, prefix, PRIMARY_COLOR);
      screen.write(prefix.length, y, pathText, PRIMARY_COLOR + style.bold);
      screen.write(prefix.length + pathText.length, y, item.detail, fg.white);
    } else {
      screen.write(0, y, prefix, '');
      screen.write(prefix.length, y, pathText, fg.cyan);
      screen.write(prefix.length + pathText.length, y, item.detail, fg.gray);
    }
    y++;
  }

  // Footer
  const scrollInfo =
    items.length > maxVisible
      ? ` (${visibleStart + 1}-${visibleStart + visibleItems.length}/${items.length})`
      : '';
  screen.writeLine(
    y,
    `↑↓ navigate • Tab select • Esc cancel${scrollInfo}`,
    fg.gray,
  );
}
