// components/CommandAutocomplete.ts
// `/command` autocomplete picker.
//
// Extracted from App.ts (P2 refactor) following the component convention
// (HunkPicker/PasteDialog/MentionPicker). Appears when the input starts
// with `/` and offers matching slash commands; ↑/↓ navigate, Tab or Enter
// select (App rewrites the editor buffer with `/<command> `), Esc closes.
// Descriptions come from the command registry via COMMAND_DESCRIPTIONS —
// passed into render so this module doesn't import the registry itself.

import type { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { PRIMARY_COLOR } from './uiConstants';

export interface CommandAutocompleteState {
  open: boolean;
  index: number;
  items: string[];
}

export function createCommandAutocompleteState(): CommandAutocompleteState {
  return { open: false, index: 0, items: [] };
}

/** Set the picker to a fresh filter result (from filterCommands). */
export function setCommandAutocomplete(
  state: CommandAutocompleteState,
  items: string[],
  index: number,
): CommandAutocompleteState {
  return { open: items.length > 0, items, index };
}

/** Close the picker and clear its items. */
export function closeCommandAutocomplete(
  state: CommandAutocompleteState,
): CommandAutocompleteState {
  return { ...state, open: false, items: [] };
}

/** Minimal key shape App's KeyEvent satisfies. */
export interface CommandAutocompleteKeyEvent {
  key: string;
}

/** What App should do after a key press. */
export type CommandAutocompleteAction =
  | { type: 'none' } // key not for us — fall through to the editor
  | { type: 'close' } // Esc — picker closes
  | { type: 'navigate'; delta: -1 | 1 }
  | { type: 'select'; command: string };

/**
 * Handle one key event while the `/command` picker is open. Returns the
 * next state plus an action; `select` carries the chosen command name so
 * App can rewrite the editor buffer (`/<command> `).
 */
export function handleCommandAutocompleteKey(
  state: CommandAutocompleteState,
  event: CommandAutocompleteKeyEvent,
): { state: CommandAutocompleteState; action: CommandAutocompleteAction } {
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
    case 'enter':
      if (state.items.length > 0) {
        const command = state.items[state.index];
        return {
          state: closeCommandAutocomplete(state),
          action: { type: 'select', command },
        };
      }
      return { state, action: { type: 'none' } };
    default:
      return { state, action: { type: 'none' } };
  }
}

/**
 * Compute the editor buffer after selecting a command. Pure: returns the
 * next value for App to set.
 */
export function commandToBuffer(command: string): string {
  return '/' + command + ' ';
}

/**
 * Paint the `/command` picker below the status bar. `descriptions` maps
 * command name → one-line description (App passes COMMAND_DESCRIPTIONS).
 */
export function renderCommandAutocomplete(
  screen: Screen,
  state: CommandAutocompleteState,
  startY: number,
  descriptions: Record<string, string>,
): void {
  const items = state.items;
  const maxVisible = Math.min(items.length, 8);

  let y = startY;

  // Separator line
  screen.horizontalLine(y++, '─', PRIMARY_COLOR);

  // Title
  screen.writeLine(y++, 'Commands', PRIMARY_COLOR + style.bold);

  // Items with descriptions
  const visibleStart = Math.max(0, state.index - maxVisible + 1);
  const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);

  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const actualIndex = visibleStart + i;
    const isSelected = actualIndex === state.index;
    const desc = descriptions[item] || '';

    const prefix = isSelected ? '► ' : '  ';
    const cmdText = ('/' + item).padEnd(18);

    if (isSelected) {
      screen.write(0, y, prefix, PRIMARY_COLOR);
      screen.write(prefix.length, y, cmdText, PRIMARY_COLOR + style.bold);
      screen.write(prefix.length + cmdText.length, y, desc, fg.white);
    } else {
      screen.write(0, y, prefix, '');
      screen.write(prefix.length, y, cmdText, fg.green);
      screen.write(prefix.length + cmdText.length, y, desc, fg.gray);
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
    `↑↓ navigate • Tab/Enter select • Esc cancel${scrollInfo}`,
    fg.gray,
  );
}
