/**
 * Export panel component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { KeyEvent } from '../Input';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

export interface ExportState {
  exportOpen: boolean;
  exportIndex: number;
  exportCallback: ((format: 'md' | 'json' | 'txt') => void) | null;
}

const FORMATS = [
  { id: 'md', name: 'Markdown', desc: 'Formatted with headers and separators' },
  { id: 'json', name: 'JSON', desc: 'Structured data format' },
  { id: 'txt', name: 'Plain Text', desc: 'Simple text format' },
] as const;

const FORMAT_IDS: Array<'md' | 'json' | 'txt'> = ['md', 'json', 'txt'];

/**
 * Render inline export panel
 */
export function renderExportPanel(
  screen: Screen,
  startY: number,
  width: number,
  state: ExportState
): void {
  let y = startY;

  // Separator line
  screen.horizontalLine(y++, '─', fg.green);

  // Title
  screen.writeLine(y++, 'Export Chat', fg.green + style.bold);
  y++;

  screen.writeLine(y++, 'Select export format:', fg.white);
  y++;

  for (let i = 0; i < FORMATS.length; i++) {
    const format = FORMATS[i];
    const isSelected = i === state.exportIndex;
    const prefix = isSelected ? '› ' : '  ';

    screen.write(0, y, prefix, isSelected ? fg.green : '');
    screen.write(2, y, format.name.padEnd(12), isSelected ? fg.green + style.bold : fg.white);
    screen.write(14, y, ' - ' + format.desc, fg.gray);
    y++;
  }

  y++;
  screen.writeLine(y, '↑↓ Navigate • Enter Export • Esc Cancel', fg.gray);
}

/**
 * Handle export panel key events
 */
export function handleExportKey(
  event: KeyEvent,
  state: ExportState,
  callbacks: {
    onClose: () => void;
    onRender: () => void;
    onExport: (format: 'md' | 'json' | 'txt') => void;
  }
): void {
  if (event.key === 'escape') {
    state.exportOpen = false;
    state.exportCallback = null;
    callbacks.onClose();
    return;
  }

  if (event.key === 'up') {
    state.exportIndex = state.exportIndex > 0 ? state.exportIndex - 1 : FORMAT_IDS.length - 1;
    callbacks.onRender();
    return;
  }

  if (event.key === 'down') {
    state.exportIndex = state.exportIndex < FORMAT_IDS.length - 1 ? state.exportIndex + 1 : 0;
    callbacks.onRender();
    return;
  }

  if (event.key === 'enter') {
    const selectedFormat = FORMAT_IDS[state.exportIndex];
    state.exportOpen = false;
    state.exportCallback = null;
    callbacks.onExport(selectedFormat);
    return;
  }
}
