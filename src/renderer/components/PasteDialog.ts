// components/PasteDialog.ts
// Large-paste confirmation dialog ("Paste Detected").
//
// Extracted from App.ts (P2 refactor) following the component convention
// (Settings/Export/Search/HunkPicker): a state object + key handler + render
// function. When a large clipboard paste arrives, App stores the text here;
// the user then picks one of three actions — add to the input buffer
// (`y`/Enter), send directly as a message (`s`), or cancel (`n`/Esc).
// The key handler returns `{ action, state }` so App can perform the
// side-effectful parts (editor.insert / message submit) itself — the
// component stays pure and testable.

import type { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { PRIMARY_COLOR } from './uiConstants';

/** Stats + preview for the pasted text (built by layout.buildPasteInfo). */
export interface PasteDialogInfo {
  chars: number;
  lines: number;
  preview: string;
  fullText: string;
}

export interface PasteDialogState {
  open: boolean;
  info: PasteDialogInfo | null;
}

export function createPasteDialogState(): PasteDialogState {
  return { open: false, info: null };
}

/** What App should do after a key press. */
export type PasteDialogAction =
  | { type: 'none' } // key not recognized — dialog stays open
  | { type: 'cancel' }
  | { type: 'add-to-input'; text: string }
  | { type: 'send-directly'; text: string };

/** Minimal key shape App's KeyEvent satisfies. */
export interface PasteDialogKeyEvent {
  key: string;
}

/**
 * Handle one key event for the paste dialog. Returns the next dialog state
 * plus an action describing what App should perform as a side effect.
 * The dialog closes on every recognized key.
 */
export function handlePasteDialogKey(
  state: PasteDialogState,
  event: PasteDialogKeyEvent,
): { state: PasteDialogState; action: PasteDialogAction } {
  const closed = createPasteDialogState();

  if (event.key === 'escape' || event.key === 'n') {
    return { state: closed, action: { type: 'cancel' } };
  }

  if (event.key === 'enter' || event.key === 'y') {
    const text = state.info?.fullText ?? '';
    return { state: closed, action: { type: 'add-to-input', text } };
  }

  if (event.key === 's') {
    const text = state.info?.fullText ?? '';
    return { state: closed, action: { type: 'send-directly', text } };
  }

  return { state, action: { type: 'none' } };
}

/**
 * Paint the paste dialog below the status bar. Mirrors the rendering
 * previously inlined in App.renderInlinePasteInfo.
 */
export function renderPasteDialog(
  screen: Screen,
  state: PasteDialogState,
  startY: number,
  width: number,
): void {
  const info = state.info;
  if (!info) return;

  let y = startY;

  // Separator line
  screen.horizontalLine(y++, '─', PRIMARY_COLOR);

  // Title with stats
  screen.write(0, y, 'Paste Detected ', PRIMARY_COLOR + style.bold);
  screen.write(15, y, `(${info.chars} chars, ${info.lines} lines)`, fg.cyan);
  y++;

  // Preview box
  y++;
  const previewLines = info.preview.split('\n').slice(0, 5);
  for (const line of previewLines) {
    const displayLine =
      line.length > width - 4 ? line.slice(0, width - 7) + '...' : line;
    screen.writeLine(y++, '  ' + displayLine, fg.gray);
  }
  if (info.lines > 5) {
    screen.writeLine(y++, `  ... (${info.lines - 5} more lines)`, fg.gray);
  }

  y++;
  // Options
  screen.write(0, y, '[Y/Enter] ', fg.green);
  screen.write(10, y, 'Add to input', fg.white);
  screen.write(25, y, '[S] ', fg.yellow);
  screen.write(29, y, 'Send directly', fg.white);
  screen.write(45, y, '[N/Esc] ', fg.red);
  screen.write(53, y, 'Cancel', fg.white);
}
