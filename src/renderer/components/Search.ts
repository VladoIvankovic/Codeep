/**
 * Search panel component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { KeyEvent } from '../Input';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

export interface SearchResult {
  role: string;
  messageIndex: number;
  matchedText: string;
}

export interface SearchState {
  searchOpen: boolean;
  searchQuery: string;
  searchResults: SearchResult[];
  searchIndex: number;
  searchCallback: ((messageIndex: number) => void) | null;
}

export interface SearchCallbacks {
  onClose: () => void;
  onRender: () => void;
  onResult: (messageIndex: number) => void;
}

/**
 * Render inline search panel
 */
export function renderSearchPanel(
  screen: Screen,
  startY: number,
  width: number,
  availableHeight: number,
  state: SearchState
): void {
  let y = startY;

  // Separator line
  screen.horizontalLine(y++, '\u2500', PRIMARY_COLOR);

  // Title
  screen.writeLine(y++, 'Search Results', PRIMARY_COLOR + style.bold);

  // Query
  screen.write(0, y, 'Query: ', fg.white);
  screen.write(7, y, `"${state.searchQuery}"`, fg.cyan);
  if (state.searchResults.length > 0) {
    screen.write(9 + state.searchQuery.length, y, ` (${state.searchResults.length} ${state.searchResults.length === 1 ? 'result' : 'results'})`, fg.gray);
  }
  y++;
  y++;

  if (state.searchResults.length === 0) {
    screen.writeLine(y++, 'No results found.', fg.yellow);
  } else {
    const maxVisible = availableHeight - 6;
    const visibleStart = Math.max(0, state.searchIndex - Math.floor(maxVisible / 2));
    const visibleResults = state.searchResults.slice(visibleStart, visibleStart + maxVisible);

    for (let i = 0; i < visibleResults.length; i++) {
      const result = visibleResults[i];
      const actualIndex = visibleStart + i;
      const isSelected = actualIndex === state.searchIndex;

      const prefix = isSelected ? '\u25B8 ' : '  ';
      const roleColor = result.role === 'user' ? fg.green : fg.blue;

      // First line: role and message number
      screen.write(0, y, prefix, isSelected ? PRIMARY_COLOR : '');
      screen.write(2, y, `[${result.role.toUpperCase()}]`, roleColor + style.bold);
      screen.write(2 + result.role.length + 2, y, ` Message #${result.messageIndex + 1}`, fg.gray);
      y++;

      // Second line: matched text (truncated)
      const maxTextWidth = width - 4;
      const matchedText = result.matchedText.length > maxTextWidth
        ? result.matchedText.slice(0, maxTextWidth - 3) + '...'
        : result.matchedText;
      screen.writeLine(y, '  ' + matchedText, fg.white);
      y++;

      if (i < visibleResults.length - 1) y++; // spacing between results
    }
  }

  // Footer
  y = startY + availableHeight - 1;
  screen.writeLine(y, '\u2191\u2193 Navigate \u2022 Enter Jump to message \u2022 Esc Close', fg.gray);
}

/**
 * Handle search key events
 */
export function handleSearchKey(
  event: KeyEvent,
  state: SearchState,
  callbacks: SearchCallbacks
): void {
  if (event.key === 'escape') {
    callbacks.onClose();
    callbacks.onRender();
    return;
  }

  if (event.key === 'up') {
    state.searchIndex = Math.max(0, state.searchIndex - 1);
    callbacks.onRender();
    return;
  }

  if (event.key === 'down') {
    state.searchIndex = Math.min(state.searchResults.length - 1, state.searchIndex + 1);
    callbacks.onRender();
    return;
  }

  if (event.key === 'enter' && state.searchResults.length > 0) {
    const selectedResult = state.searchResults[state.searchIndex];
    callbacks.onClose();
    callbacks.onRender();
    callbacks.onResult(selectedResult.messageIndex);
    return;
  }
}
