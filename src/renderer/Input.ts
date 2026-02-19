/**
 * Raw input handling for terminal
 * Handles keypresses, special keys, and line editing
 */

import * as readline from 'readline';

export interface KeyEvent {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  raw: string;
  isPaste?: boolean; // True if this is a paste event (multiple chars at once)
}

export type KeyHandler = (event: KeyEvent) => void;

export class Input {
  private handlers: KeyHandler[] = [];
  private rl: readline.Interface | null = null;
  private dataHandler: ((data: string) => void) | null = null;
  
  /**
   * Start listening for input
   */
  start(): void {
    // Enable raw mode for character-by-character input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    // Enable mouse tracking (SGR mode for better compatibility)
    // \x1b[?1000h - enable basic mouse tracking
    // \x1b[?1006h - enable SGR extended mouse mode
    // \x1b[?2004h - enable bracketed paste mode (wraps pastes in \x1b[200~ ... \x1b[201~)
    process.stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?2004h');
    
    this.dataHandler = (data: string) => {
      const event = this.parseKey(data);
      this.emit(event);
    };
    process.stdin.on('data', this.dataHandler);
  }
  
  /**
   * Stop listening
   */
  stop(): void {
    // Remove data listener
    if (this.dataHandler) {
      process.stdin.removeListener('data', this.dataHandler);
      this.dataHandler = null;
    }
    
    // Disable mouse tracking and bracketed paste mode
    process.stdout.write('\x1b[?2004l\x1b[?1006l\x1b[?1000l');
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
  
  /**
   * Add key handler
   */
  onKey(handler: KeyHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index !== -1) {
        this.handlers.splice(index, 1);
      }
    };
  }
  
  /**
   * Emit key event to all handlers
   */
  private emit(event: KeyEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
  
  /**
   * Parse raw input into KeyEvent
   */
  private parseKey(data: string): KeyEvent {
    const event: KeyEvent = {
      key: '',
      ctrl: false,
      alt: false,
      shift: false,
      raw: data,
      isPaste: false,
    };
    
    // Check for mouse scroll events (SGR format: \x1b[<button;x;yM or \x1b[<button;x;ym)
    // Button 64 = scroll up, Button 65 = scroll down
    const mouseMatch = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const button = parseInt(mouseMatch[1], 10);
      // const x = parseInt(mouseMatch[2], 10);
      // const y = parseInt(mouseMatch[3], 10);
      // const release = mouseMatch[4] === 'm';
      
      if (button === 64) {
        // Scroll up
        event.key = 'scrollup';
        return event;
      } else if (button === 65) {
        // Scroll down
        event.key = 'scrolldown';
        return event;
      }
      // Ignore other mouse events (clicks, etc.)
      event.key = 'mouse';
      return event;
    }
    
    // Enter (also handle \r\n sent by some terminals)
    if (data === '\r' || data === '\n' || data === '\r\n') {
      event.key = 'enter';
      return event;
    }
    
    // Bracketed paste mode: terminal wraps Cmd+V paste in \x1b[200~ ... \x1b[201~
    if (data.includes('\x1b[200~') || data.includes('\x1b[201~')) {
      const pasteContent = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      if (pasteContent.length > 0) {
        event.key = pasteContent;
        event.isPaste = true;
        return event;
      }
    }
    
    // Detect paste: multiple printable characters at once (not escape sequences)
    if (data.length > 1 && !data.startsWith('\x1b')) {
      // Check if it's all printable characters (paste event)
      const isPrintable = /^[\x20-\x7E\n\r\t]+$/.test(data) || 
                         data.split('').every(c => c.charCodeAt(0) >= 32 || c === '\n' || c === '\r' || c === '\t');
      if (isPrintable) {
        event.key = data;
        event.isPaste = true;
        return event;
      }
    }
    
    // Ctrl+C
    if (data === '\x03') {
      event.key = 'c';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+D
    if (data === '\x04') {
      event.key = 'd';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+L
    if (data === '\x0c') {
      event.key = 'l';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+V (paste)
    if (data === '\x16') {
      event.key = 'v';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+A (go to beginning)
    if (data === '\x01') {
      event.key = 'a';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+E (go to end)
    if (data === '\x05') {
      event.key = 'e';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+U (clear line)
    if (data === '\x15') {
      event.key = 'u';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+W (delete word)
    if (data === '\x17') {
      event.key = 'w';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+K (delete to end of line)
    if (data === '\x0b') {
      event.key = 'k';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+G
    if (data === '\x07') {
      event.key = 'g';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+O
    if (data === '\x0f') {
      event.key = 'o';
      event.ctrl = true;
      return event;
    }
    
    // Ctrl+T
    if (data === '\x14') {
      event.key = 't';
      event.ctrl = true;
      return event;
    }
    
    // Backspace
    if (data === '\x7f' || data === '\b') {
      event.key = 'backspace';
      return event;
    }
    
    // Escape
    if (data === '\x1b') {
      event.key = 'escape';
      return event;
    }
    
    // Tab
    if (data === '\t') {
      event.key = 'tab';
      return event;
    }
    
    // Arrow keys and other escape sequences
    if (data.startsWith('\x1b[')) {
      const seq = data.slice(2);
      
      switch (seq) {
        case 'A':
          event.key = 'up';
          break;
        case 'B':
          event.key = 'down';
          break;
        case 'C':
          event.key = 'right';
          break;
        case 'D':
          event.key = 'left';
          break;
        case 'H':
          event.key = 'home';
          break;
        case 'F':
          event.key = 'end';
          break;
        case '3~':
          event.key = 'delete';
          break;
        case '5~':
          event.key = 'pageup';
          break;
        case '6~':
          event.key = 'pagedown';
          break;
        default:
          event.key = 'unknown';
      }
      
      return event;
    }
    
    // Alt+key (ESC followed by character)
    if (data.startsWith('\x1b') && data.length === 2) {
      event.key = data[1];
      event.alt = true;
      return event;
    }
    
    // Ctrl+letter (0x01-0x1a maps to a-z)
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      event.key = String.fromCharCode(code + 96); // 1 -> 'a', etc.
      event.ctrl = true;
      return event;
    }
    
    // Regular character
    event.key = data;
    
    return event;
  }
}

/**
 * Simple line editor with cursor support
 */
export class LineEditor {
  private value = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private tempValue = '';
  
  getValue(): string {
    return this.value;
  }
  
  getCursorPos(): number {
    return this.cursorPos;
  }
  
  setValue(value: string): void {
    this.value = value;
    this.cursorPos = value.length;
  }
  
  clear(): void {
    this.value = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
  }
  
  /**
   * Insert text at cursor position
   */
  insert(text: string): void {
    this.value = this.value.slice(0, this.cursorPos) + text + this.value.slice(this.cursorPos);
    this.cursorPos += text.length;
  }
  
  /**
   * Set cursor position
   */
  setCursorPos(pos: number): void {
    this.cursorPos = Math.max(0, Math.min(pos, this.value.length));
  }
  
  /**
   * Delete word backward (Ctrl+W)
   */
  deleteWordBackward(): void {
    if (this.cursorPos === 0) return;
    
    const beforeCursor = this.value.slice(0, this.cursorPos);
    const afterCursor = this.value.slice(this.cursorPos);
    
    // Find last word boundary (skip trailing spaces, then find space)
    let i = beforeCursor.length - 1;
    while (i >= 0 && beforeCursor[i] === ' ') i--;
    while (i >= 0 && beforeCursor[i] !== ' ') i--;
    
    const newBefore = beforeCursor.slice(0, i + 1);
    this.value = newBefore + afterCursor;
    this.cursorPos = newBefore.length;
  }
  
  /**
   * Delete to end of line (Ctrl+K)
   */
  deleteToEnd(): void {
    this.value = this.value.slice(0, this.cursorPos);
  }
  
  addToHistory(value: string): void {
    if (value.trim()) {
      this.history.push(value);
      // Keep last 100 entries
      if (this.history.length > 100) {
        this.history.shift();
      }
    }
    this.historyIndex = -1;
  }
  
  /**
   * Handle key event, returns true if value changed
   */
  handleKey(event: KeyEvent): boolean {
    const oldValue = this.value;
    const oldCursor = this.cursorPos;
    
    switch (event.key) {
      case 'backspace':
        if (this.cursorPos > 0) {
          this.value = this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
          this.cursorPos--;
        }
        break;
        
      case 'delete':
        if (this.cursorPos < this.value.length) {
          this.value = this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
        }
        break;
        
      case 'left':
        if (this.cursorPos > 0) {
          this.cursorPos--;
        }
        break;
        
      case 'right':
        if (this.cursorPos < this.value.length) {
          this.cursorPos++;
        }
        break;
        
      case 'home':
        this.cursorPos = 0;
        break;
        
      case 'end':
        this.cursorPos = this.value.length;
        break;
        
      case 'up':
        if (this.history.length > 0) {
          if (this.historyIndex === -1) {
            this.tempValue = this.value;
            this.historyIndex = this.history.length - 1;
          } else if (this.historyIndex > 0) {
            this.historyIndex--;
          }
          this.value = this.history[this.historyIndex];
          this.cursorPos = this.value.length;
        }
        break;
        
      case 'down':
        if (this.historyIndex !== -1) {
          if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.value = this.history[this.historyIndex];
          } else {
            this.historyIndex = -1;
            this.value = this.tempValue;
          }
          this.cursorPos = this.value.length;
        }
        break;
        
      default:
        // Regular character (single char, not control)
        if (event.key.length === 1 && !event.ctrl && !event.alt) {
          this.value = this.value.slice(0, this.cursorPos) + event.key + this.value.slice(this.cursorPos);
          this.cursorPos++;
        }
    }
    
    return this.value !== oldValue || this.cursorPos !== oldCursor;
  }
}
