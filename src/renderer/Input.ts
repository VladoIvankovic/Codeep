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
}

export type KeyHandler = (event: KeyEvent) => void;

export class Input {
  private handlers: KeyHandler[] = [];
  private rl: readline.Interface | null = null;
  
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
    
    process.stdin.on('data', (data: string) => {
      const event = this.parseKey(data);
      this.emit(event);
    });
  }
  
  /**
   * Stop listening
   */
  stop(): void {
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
    };
    
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
    
    // Enter
    if (data === '\r' || data === '\n') {
      event.key = 'enter';
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
