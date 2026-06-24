/**
 * Help screen component.
 *
 * The `/help` layout lives in `../commands/registry.ts` as `HELP_LAYOUT`
 * (single source of truth, alongside the command metadata). This file
 * re-exports it under the historical `helpCategories` name so existing
 * callers (`App.ts`, `handlers.ts`) keep working, and owns the keyboard-
 * shortcuts panel (which is independent of commands). The actual rendering
 * is done by `App.ts`, which iterates `helpCategories` directly.
 */

import { HELP_LAYOUT } from '../commands/registry';

export interface HelpCategory {
  title: string;
  items: Array<{ key: string; description: string }>;
}

/**
 * Codeep command help data — re-exported from the registry so there's a
 * single source of truth for both `/help` rendering and `/` autocomplete.
 */
export const helpCategories: HelpCategory[] = HELP_LAYOUT;

/**
 * Keyboard shortcuts (independent of the command registry — raw key
 * bindings, not slash commands).
 */
export const keyboardShortcuts = [
  { key: 'Enter', description: 'Send message' },
  { key: '\\+Enter', description: 'Continue on next line' },
  { key: 'Esc', description: 'Cancel/Close (send in multiline)' },
  { key: 'Ctrl+L', description: 'Clear screen' },
  { key: 'Ctrl+C', description: 'Exit' },
  { key: '↑/↓', description: 'Input history' },
  { key: 'PgUp/PgDn', description: 'Scroll messages' },
];

/**
 * Get total number of help pages
 */
export function getHelpTotalPages(screenHeight: number): number {
  const availableHeight = screenHeight - 5; // Account for title and footer
  
  // Count all items
  let itemCount = 0;
  for (const category of helpCategories) {
    itemCount += 2; // Empty line + category header
    itemCount += category.items.length;
  }
  itemCount += 2; // Keyboard shortcuts header
  itemCount += keyboardShortcuts.length;
  
  return Math.max(1, Math.ceil(itemCount / availableHeight));
}
