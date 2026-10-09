/**
 * Login screen for API key setup
 */

import { Screen } from '../Screen';
import { Input, LineEditor, KeyEvent } from '../Input';
import { fg, style } from '../ansi';
import { createBox, centerBox } from './Box';
import { spawn } from 'child_process';
import clipboardy from 'clipboardy';

// Codeep red and its bright variant, read live from the palette so an
// Omarchy theme switch recolours this screen too.
import { PRIMARY_COLOR, PRIMARY_BRIGHT } from './uiConstants';

export interface LoginOptions {
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
  providerName: string;
  error?: string;
  subscribeUrl?: string;
}

/**
 * Login screen component
 */
export class LoginScreen {
  private screen: Screen;
  private editor: LineEditor;
  private options: LoginOptions;
  private showKey = false;
  
  constructor(screen: Screen, input: Input, options: LoginOptions) {
    this.screen = screen;
    this.editor = new LineEditor();
    this.options = options;
  }
  
  /**
   * Handle key event
   * Returns true if handled, false to pass to parent
   */
  handleKey(event: KeyEvent): boolean {
    // Toggle visibility
    if (event.ctrl && event.key === 't') {
      this.showKey = !this.showKey;
      this.render();
      return true;
    }
    
    // Open subscribe URL in browser
    if (event.ctrl && event.key === 'b' && this.options.subscribeUrl) {
      openUrl(this.options.subscribeUrl);
      return true;
    }
    
    // Ctrl+V paste from clipboard
    if (event.ctrl && event.key === 'v') {
      this.pasteFromClipboard();
      return true;
    }
    
    // Paste detection (fast input)
    if (event.isPaste && event.key.length > 1) {
      this.editor.setValue(event.key.trim());
      this.render();
      return true;
    }
    
    // Submit
    if (event.key === 'enter') {
      const value = this.editor.getValue().trim();
      if (value) {
        this.options.onSubmit(value);
      }
      return true;
    }
    
    // Cancel
    if (event.key === 'escape') {
      this.options.onCancel();
      return true;
    }
    
    // Editor keys
    if (this.editor.handleKey(event)) {
      this.render();
    }
    
    return true;
  }
  
  /**
   * Render login screen
   *
   * The title stays on row 1 and the box below it at any height. The box
   * keeps its blank rows while there is room and gives them up, top to
   * bottom, on a short terminal; the key field and the key hints come first.
   * It used to be centred at a fixed 14 rows, so below about 17 rows it
   * covered the title.
   */
  render(): void {
    const { width, height } = this.screen.getSize();
    
    this.screen.clear();
    
    // Title
    const title = '═══ Codeep Setup ═══';
    const titleX = Math.floor((width - title.length) / 2);
    this.screen.write(titleX, 1, title, PRIMARY_COLOR + style.bold);
    
    // Box dimensions
    const boxWidth = Math.min(60, width - 4);
    const textWidth = Math.max(10, boxWidth - 6);
    const errorLines = this.options.error ? wrapText(this.options.error, textWidth, 2) : [];
    const helpParts2: string[] = [];
    if (this.options.subscribeUrl) {
      helpParts2.push('Ctrl+B: Get API key');
    }
    helpParts2.push('Esc: Cancel');
    // Instruction, the 3-row field, the error, two lines of key hints.
    const essential = 1 + 3 + errorLines.length + 2;
    const boxTop = 3;
    const boxHeight = Math.max(essential + 2, Math.min(LOGIN_BOX_HEIGHT, height - 1 - boxTop));
    const boxX = Math.floor((width - boxWidth) / 2);
    const boxY = Math.max(boxTop, Math.floor((height - boxHeight) / 2));
    
    // Draw box
    const boxLines = createBox({
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      style: 'rounded',
      title: ` ${this.options.providerName} API Key `,
      borderColor: PRIMARY_COLOR,
      titleColor: PRIMARY_BRIGHT,
    });
    
    for (const line of boxLines) {
      this.screen.writeLine(line.y, line.text, line.style);
    }
    
    // Blank rows, while there is room: above the instruction, under it, and
    // under the field.
    let spare = boxHeight - 2 - essential;
    const blank = () => (spare > 0 ? (spare--, 1) : 0);
    const padTop = blank();
    const gapAfterInstruction = blank();
    const gapAfterField = blank();

    // Content
    const contentX = boxX + 3;
    let contentY = boxY + 1 + padTop;
    
    // Instructions
    this.screen.write(contentX, contentY, 'Enter your API key to get started:', fg.white);
    contentY += 1 + gapAfterInstruction;
    
    // Input field
    const inputValue = this.editor.getValue();
    const maxInputWidth = boxWidth - 8;
    
    let displayValue: string;
    if (this.showKey) {
      displayValue = inputValue.length > maxInputWidth 
        ? '...' + inputValue.slice(-(maxInputWidth - 3))
        : inputValue;
    } else {
      // Mask the key
      displayValue = '*'.repeat(Math.min(inputValue.length, maxInputWidth));
    }
    
    // Input box
    const inputBoxWidth = boxWidth - 6;
    this.screen.write(contentX, contentY, '┌' + '─'.repeat(inputBoxWidth - 2) + '┐', fg.gray);
    contentY++;
    const inputY = contentY;
    this.screen.write(contentX, contentY, '│ ' + displayValue.padEnd(inputBoxWidth - 4) + ' │', fg.gray);
    const cursorX = contentX + 2 + Math.min(inputValue.length, maxInputWidth);
    contentY++;
    this.screen.write(contentX, contentY, '└' + '─'.repeat(inputBoxWidth - 2) + '┘', fg.gray);
    contentY += 1 + gapAfterField;
    
    // Error message
    for (const line of errorLines) {
      this.screen.write(contentX, contentY, line, fg.red);
      contentY++;
    }
    
    // Help text
    this.screen.write(contentX, contentY, 'Ctrl+V: Paste | Ctrl+T: Toggle visibility', fg.gray);
    contentY++;
    this.screen.write(contentX, contentY, helpParts2.join(' | '), fg.gray);
    
    // Position cursor
    this.screen.setCursor(cursorX, inputY);
    this.screen.showCursor(true);
    
    this.screen.fullRender();
  }
  
  /**
   * Paste from clipboard
   */
  private async pasteFromClipboard(): Promise<void> {
    try {
      const text = await clipboardy.read();
      if (text) {
        this.editor.setValue(text.trim());
        this.render();
      }
    } catch {
      // Clipboard not available
    }
  }
  
  /**
   * Reset state
   */
  reset(): void {
    this.editor.clear();
    this.showKey = false;
  }
}

/** The API-key box's height when the terminal has room for all of it. */
const LOGIN_BOX_HEIGHT = 14;

/** Word-wrap `text` to `width` columns, at most `maxLines` lines. */
function wrapText(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  const fitted = lines.map((l) => (l.length > width ? l.slice(0, width - 1) + '…' : l));
  if (fitted.length > maxLines) {
    const last = fitted[maxLines - 1];
    fitted.length = maxLines;
    fitted[maxLines - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + '…';
  }
  return fitted;
}

/**
 * Open URL in the default browser
 */
function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' 
      : process.platform === 'win32' ? 'start' 
      : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Silently fail if browser can't be opened
  }
}

/**
 * Provider selection screen
 */
export function renderProviderSelect(
  screen: Screen,
  providers: Array<{ id: string; name: string; description?: string }>,
  selectedIndex: number,
  hint?: string,
): void {
  const { width, height } = screen.getSize();

  screen.clear();

  // Title
  const title = '═══ Welcome to Codeep ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 1, title, PRIMARY_COLOR + style.bold);

  // Subtitle
  const subtitle = 'Pick an AI provider — you can switch later with /provider';
  const subtitleX = Math.floor((width - subtitle.length) / 2);
  screen.write(subtitleX, 3, subtitle, fg.white);

  // Box — wider so we can show name + description on a single row.
  const longestName = providers.reduce((m, p) => Math.max(m, p.name.length), 0);
  const longestDesc = providers.reduce((m, p) => Math.max(m, (p.description ?? '').length), 0);
  const boxWidth = Math.min(width - 4, Math.max(60, 6 + longestName + 3 + longestDesc));

  // The box goes between the subtitle and the key hints, never over them.
  // On a terminal too short for every provider (two dozen of them want a
  // 28-row box) the list scrolls with the selection, and the blank rows at
  // its ends say how many are out of view. It used to be centred at full
  // height, which put it over the title at 30 rows.
  const footerY = height - 2;
  const boxTop = 5;
  const boxBottom = footerY - 2;
  const visible = Math.min(providers.length, Math.max(1, boxBottom - boxTop + 1 - 4));
  const first = Math.max(0, Math.min(selectedIndex - Math.floor(visible / 2), providers.length - visible));
  const boxHeight = visible + 4;
  const centered = centerBox(width, height, boxWidth, boxHeight);
  const boxX = centered.x;
  const boxY = Math.max(boxTop, Math.min(centered.y, boxBottom - boxHeight + 1));

  const boxLines = createBox({
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: boxHeight,
    style: 'rounded',
    borderColor: PRIMARY_COLOR,
  });

  for (const line of boxLines) {
    screen.writeLine(line.y, line.text, line.style);
  }

  // Provider list — name in white/bold-on-selected, dim description beside it.
  // Description is clipped to the room remaining inside the box so it never
  // overwrites the right border on narrow terminals (80-col laptop splits).
  const contentX = boxX + 3;
  const contentY = boxY + 2;
  const nameColWidth = longestName + 2;
  const descStartX = contentX + 2 + nameColWidth;
  const boxInnerRight = boxX + boxWidth - 2;
  const descBudget = Math.max(0, boxInnerRight - descStartX);

  if (first > 0) {
    screen.write(contentX, boxY + 1, `▲ ${first} more`, fg.gray);
  }
  const below = providers.length - first - visible;
  if (below > 0) {
    screen.write(contentX, boxY + boxHeight - 2, `▼ ${below} more`, fg.gray);
  }

  for (let row = 0; row < visible; row++) {
    const i = first + row;
    const provider = providers[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? '► ' : '  ';
    const nameStyle = isSelected ? PRIMARY_BRIGHT + style.bold : fg.white;
    const descStyle = isSelected ? fg.white : fg.gray;

    screen.write(contentX, contentY + row, prefix + provider.name.padEnd(nameColWidth), nameStyle);
    if (provider.description && descBudget > 0) {
      const desc = provider.description.length > descBudget
        ? provider.description.slice(0, Math.max(1, descBudget - 1)) + '…'
        : provider.description;
      screen.write(descStartX, contentY + row, desc, descStyle);
    }
  }

  // Footer. Esc ends setup ("Setup cancelled." in main.ts); it said "skip
  // (provider chosen later)", which sent people to a later that never came.
  screen.write(2, footerY, '↑↓ Navigate · Enter Select · Esc Cancel setup', fg.gray);

  // The hint goes on the row between the box and the key hints, which the
  // box never takes (it ends two rows above the footer), so the list keeps
  // every row it had. Left out on a terminal too short for that row to be
  // below the box and the subtitle; cut at the width, so a hint puts what
  // matters first.
  const hintY = footerY - 1;
  if (hint && hintY > Math.max(3, boxY + boxHeight - 1)) {
    const room = Math.max(1, width - 4);
    screen.write(2, hintY, hint.length > room ? hint.slice(0, room - 1) + '…' : hint, fg.white);
  }

  screen.showCursor(false);
  screen.fullRender();
}
