/**
 * Login screen for API key setup
 */

import { Screen } from '../Screen';
import { Input, LineEditor, KeyEvent } from '../Input';
import { fg, style } from '../ansi';
import { createBox, centerBox } from './Box';
import { spawn } from 'child_process';
import clipboardy from 'clipboardy';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);
const PRIMARY_BRIGHT = fg.rgb(255, 80, 85);

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
  private input: Input;
  private editor: LineEditor;
  private options: LoginOptions;
  private showKey = false;
  
  constructor(screen: Screen, input: Input, options: LoginOptions) {
    this.screen = screen;
    this.input = input;
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
    const boxHeight = 14;
    const { x: boxX, y: boxY } = centerBox(width, height, boxWidth, boxHeight);
    
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
    
    // Content
    const contentX = boxX + 3;
    let contentY = boxY + 2;
    
    // Instructions
    this.screen.write(contentX, contentY, 'Enter your API key to get started:', fg.white);
    contentY += 2;
    
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
    this.screen.write(contentX, contentY, '│ ' + displayValue.padEnd(inputBoxWidth - 4) + ' │', fg.gray);
    const cursorX = contentX + 2 + Math.min(inputValue.length, maxInputWidth);
    contentY++;
    this.screen.write(contentX, contentY, '└' + '─'.repeat(inputBoxWidth - 2) + '┘', fg.gray);
    contentY += 2;
    
    // Error message
    if (this.options.error) {
      this.screen.write(contentX, contentY, this.options.error, fg.red);
      contentY++;
    }
    
    // Help text
    this.screen.write(contentX, contentY, 'Ctrl+V: Paste | Ctrl+T: Toggle visibility', fg.gray);
    contentY++;
    const helpParts2: string[] = [];
    if (this.options.subscribeUrl) {
      helpParts2.push('Ctrl+B: Get API key');
    }
    helpParts2.push('Esc: Cancel');
    this.screen.write(contentX, contentY, helpParts2.join(' | '), fg.gray);
    
    // Position cursor
    this.screen.setCursor(cursorX, boxY + 5);
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
  providers: Array<{ id: string; name: string }>,
  selectedIndex: number
): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const title = '═══ Codeep Setup ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 1, title, PRIMARY_COLOR + style.bold);
  
  // Subtitle
  const subtitle = 'Select your AI provider';
  const subtitleX = Math.floor((width - subtitle.length) / 2);
  screen.write(subtitleX, 3, subtitle, fg.white);
  
  // Box
  const boxWidth = Math.min(40, width - 4);
  const boxHeight = providers.length + 4;
  const { x: boxX, y: boxY } = centerBox(width, height, boxWidth, boxHeight);
  
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
  
  // Provider list
  const contentX = boxX + 3;
  let contentY = boxY + 2;
  
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? '► ' : '  ';
    const itemStyle = isSelected ? PRIMARY_BRIGHT + style.bold : fg.white;
    
    screen.write(contentX, contentY + i, prefix + provider.name, itemStyle);
  }
  
  // Footer
  const footerY = height - 2;
  screen.write(2, footerY, '↑↓ Navigate | Enter Select', fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}
