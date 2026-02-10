/**
 * Logout panel component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { KeyEvent } from '../Input';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

export interface LogoutProvider {
  id: string;
  name: string;
  isCurrent: boolean;
}

export interface LogoutState {
  logoutOpen: boolean;
  logoutIndex: number;
  logoutProviders: LogoutProvider[];
  logoutCallback: ((providerId: string | 'all' | null) => void) | null;
}

export interface LogoutCallbacks {
  onClose: () => void;
  onRender: () => void;
  onSelect: (result: string | 'all' | null) => void;
}

/**
 * Render inline logout picker
 */
export function renderLogoutPanel(
  screen: Screen,
  startY: number,
  width: number,
  state: LogoutState
): void {
  let y = startY;

  // Separator line
  screen.horizontalLine(y++, '─', fg.cyan);

  // Title
  screen.writeLine(y++, 'Select provider to logout:', fg.cyan + style.bold);
  y++;

  if (state.logoutProviders.length === 0) {
    screen.writeLine(y++, 'No providers configured.', fg.yellow);
    screen.writeLine(y++, 'Press Escape to go back.', fg.gray);
    return;
  }

  // Provider options
  for (let i = 0; i < state.logoutProviders.length; i++) {
    const provider = state.logoutProviders[i];
    const isSelected = i === state.logoutIndex;
    const prefix = isSelected ? '→ ' : '  ';

    screen.write(0, y, prefix, isSelected ? fg.green : '');
    screen.write(2, y, provider.name, isSelected ? fg.green + style.bold : fg.white);
    if (provider.isCurrent) {
      screen.write(2 + provider.name.length + 1, y, '(current)', fg.cyan);
    }
    y++;
  }

  // "All" option
  const allIndex = state.logoutProviders.length;
  const isAllSelected = state.logoutIndex === allIndex;
  screen.write(0, y, isAllSelected ? '→ ' : '  ', isAllSelected ? fg.red : '');
  screen.write(2, y, 'Logout from all providers', isAllSelected ? fg.red + style.bold : fg.yellow);
  y++;

  // "Cancel" option
  const cancelIndex = state.logoutProviders.length + 1;
  const isCancelSelected = state.logoutIndex === cancelIndex;
  screen.write(0, y, isCancelSelected ? '→ ' : '  ', isCancelSelected ? fg.blue : '');
  screen.write(2, y, 'Cancel', isCancelSelected ? fg.blue + style.bold : fg.gray);
  y++;

  y++;
  screen.writeLine(y, '↑↓ Navigate • Enter Select • Esc Cancel', fg.gray);
}

/**
 * Handle logout picker keys
 */
export function handleLogoutKey(
  event: KeyEvent,
  state: LogoutState,
  callbacks: LogoutCallbacks
): void {
  // Options: providers + "all" + "cancel"
  const totalOptions = state.logoutProviders.length + 2;

  if (event.key === 'escape') {
    state.logoutOpen = false;
    state.logoutCallback = null;
    callbacks.onRender();
    return;
  }

  if (event.key === 'up') {
    state.logoutIndex = Math.max(0, state.logoutIndex - 1);
    callbacks.onRender();
    return;
  }

  if (event.key === 'down') {
    state.logoutIndex = Math.min(totalOptions - 1, state.logoutIndex + 1);
    callbacks.onRender();
    return;
  }

  if (event.key === 'enter') {
    const callback = state.logoutCallback;
    state.logoutOpen = false;
    state.logoutCallback = null;

    let result: string | 'all' | null = null;
    if (state.logoutIndex < state.logoutProviders.length) {
      result = state.logoutProviders[state.logoutIndex].id;
    } else if (state.logoutIndex === state.logoutProviders.length) {
      result = 'all';
    } else {
      result = null; // Cancel
    }

    callbacks.onRender();
    if (callback) {
      callback(result);
    }
    return;
  }
}
