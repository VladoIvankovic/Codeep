/**
 * Login screen for API key setup
 */

import { Screen } from '../Screen';
import { Input, LineEditor, KeyEvent } from '../Input';
import { fg, style } from '../ansi';
import { createBox, centerBox } from './Box';

export interface LoginOptions {
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
  providerName: string;
  error?: string;
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
    this.screen.write(titleX, 1, title, fg.cyan + style.bold);
    
    // Box dimensions
    const boxWidth = Math.min(60, width - 4);
    const boxHeight = 12;
    const { x: boxX, y: boxY } = centerBox(width, height, boxWidth, boxHeight);
    
    // Draw box
    const boxLines = createBox({
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      style: 'rounded',
      title: ` ${this.options.providerName} API Key `,
      borderColor: fg.cyan,
      titleColor: fg.brightCyan,
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
    this.screen.write(contentX, contentY, 'Ctrl+T: Toggle visibility | Esc: Cancel', fg.gray);
    
    // Footer
    const footerY = height - 2;
    this.screen.write(2, footerY, 'Get your API key from your provider\'s dashboard', fg.gray);
    
    // Position cursor
    this.screen.setCursor(cursorX, boxY + 5);
    this.screen.showCursor(true);
    
    this.screen.fullRender();
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
  screen.write(titleX, 1, title, fg.cyan + style.bold);
  
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
    borderColor: fg.cyan,
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
    const itemStyle = isSelected ? fg.brightCyan + style.bold : fg.white;
    
    screen.write(contentX, contentY + i, prefix + provider.name, itemStyle);
  }
  
  // Footer
  const footerY = height - 2;
  screen.write(2, footerY, '↑↓ Navigate | Enter Select', fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}
