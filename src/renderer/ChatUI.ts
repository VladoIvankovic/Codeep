/**
 * Simple Chat UI - Proof of Concept
 * Demonstrates custom renderer without Ink
 */

import { Screen } from './Screen';
import { Input, LineEditor, KeyEvent } from './Input';
import { fg, style, styled } from './ansi';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatUIOptions {
  onSubmit: (message: string) => void;
  onExit: () => void;
}

export class ChatUI {
  private screen: Screen;
  private input: Input;
  private editor: LineEditor;
  private messages: ChatMessage[] = [];
  private streamingContent = '';
  private isStreaming = false;
  private options: ChatUIOptions;
  private scrollOffset = 0;
  
  constructor(options: ChatUIOptions) {
    this.screen = new Screen();
    this.input = new Input();
    this.editor = new LineEditor();
    this.options = options;
  }
  
  /**
   * Start the UI
   */
  start(): void {
    this.screen.init();
    this.input.start();
    
    // Handle keyboard input
    this.input.onKey((event) => this.handleKey(event));
    
    // Initial render - use full render first time
    this.fullRender();
  }
  
  /**
   * Stop the UI
   */
  stop(): void {
    this.input.stop();
    this.screen.cleanup();
  }
  
  /**
   * Add a message to chat
   */
  addMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.scrollOffset = 0; // Reset scroll to bottom
    this.render();
  }
  
  /**
   * Start streaming response
   */
  startStreaming(): void {
    this.isStreaming = true;
    this.streamingContent = '';
    this.render();
  }
  
  /**
   * Add chunk to streaming response
   */
  addStreamChunk(chunk: string): void {
    this.streamingContent += chunk;
    this.render();
  }
  
  /**
   * End streaming and add as message
   */
  endStreaming(): void {
    if (this.streamingContent) {
      this.messages.push({
        role: 'assistant',
        content: this.streamingContent,
      });
    }
    this.streamingContent = '';
    this.isStreaming = false;
    this.render();
  }
  
  /**
   * Handle keyboard input
   */
  private handleKey(event: KeyEvent): void {
    // Ctrl+C or Ctrl+D to exit
    if (event.ctrl && (event.key === 'c' || event.key === 'd')) {
      this.stop();
      this.options.onExit();
      return;
    }
    
    // Escape to cancel streaming
    if (event.key === 'escape' && this.isStreaming) {
      this.endStreaming();
      return;
    }
    
    // Ctrl+L to clear
    if (event.ctrl && event.key === 'l') {
      this.messages = [];
      this.render();
      return;
    }
    
    // Page up/down for scrolling
    if (event.key === 'pageup') {
      this.scrollOffset = Math.min(this.scrollOffset + 5, this.messages.length - 1);
      this.render();
      return;
    }
    
    if (event.key === 'pagedown') {
      this.scrollOffset = Math.max(this.scrollOffset - 5, 0);
      this.render();
      return;
    }
    
    // Enter to submit
    if (event.key === 'enter') {
      const value = this.editor.getValue().trim();
      if (value) {
        this.editor.addToHistory(value);
        this.editor.clear();
        
        // Add user message
        this.addMessage({ role: 'user', content: value });
        
        // Callback
        this.options.onSubmit(value);
      }
      this.render();
      return;
    }
    
    // Handle editor keys
    if (this.editor.handleKey(event)) {
      this.render();
    }
  }
  
  /**
   * Render the entire UI
   */
  render(): void {
    const { width, height } = this.screen.getSize();
    
    this.screen.clear();
    
    // Layout:
    // - Line 0: Header
    // - Lines 1 to height-4: Messages
    // - Line height-3: Separator
    // - Line height-2: Input
    // - Line height-1: Status bar
    
    const headerLine = 0;
    const messagesStart = 1;
    const messagesEnd = height - 4;
    const separatorLine = height - 3;
    const inputLine = height - 2;
    const statusLine = height - 1;
    
    // Header
    const header = ' Codeep Chat ';
    const headerPadding = '─'.repeat(Math.max(0, (width - header.length) / 2));
    this.screen.writeLine(headerLine, headerPadding + header + headerPadding, fg.cyan);
    
    // Messages area (including streaming content)
    const messagesHeight = messagesEnd - messagesStart + 1;
    const messagesToRender = this.getVisibleMessages(messagesHeight, width - 2);
    
    let y = messagesStart;
    for (const line of messagesToRender) {
      if (y > messagesEnd) break;
      this.screen.writeLine(y, line.text, line.style);
      y++;
    }
    
    // Separator
    this.screen.horizontalLine(separatorLine, '─', fg.gray);
    
    // Input line
    const prompt = '> ';
    const inputValue = this.editor.getValue();
    const cursorPos = this.editor.getCursorPos();
    const maxInputWidth = width - prompt.length - 1;
    
    // Calculate what part of input to show and where cursor should be
    let displayValue: string;
    let cursorX: number;
    
    if (inputValue.length <= maxInputWidth) {
      // Input fits - show all, cursor at actual position
      displayValue = inputValue;
      cursorX = prompt.length + cursorPos;
    } else {
      // Input too long - scroll to keep cursor visible
      // Keep cursor roughly in the middle-right of visible area
      const visibleStart = Math.max(0, cursorPos - Math.floor(maxInputWidth * 0.7));
      const visibleEnd = visibleStart + maxInputWidth;
      
      if (visibleStart > 0) {
        displayValue = '…' + inputValue.slice(visibleStart + 1, visibleEnd);
      } else {
        displayValue = inputValue.slice(0, maxInputWidth);
      }
      
      // Cursor position relative to visible portion
      cursorX = prompt.length + (cursorPos - visibleStart);
      if (visibleStart > 0) {
        cursorX = prompt.length + (cursorPos - visibleStart);
      }
    }
    
    this.screen.writeLine(inputLine, prompt + displayValue, fg.green);
    
    // Position cursor
    this.screen.setCursor(cursorX, inputLine);
    this.screen.showCursor(true);
    
    // Status bar
    const statusLeft = ` ${this.messages.length} messages`;
    const statusRight = this.isStreaming ? 'Streaming... (Esc to cancel)' : 'Enter to send | Ctrl+C to exit';
    const statusPadding = ' '.repeat(Math.max(0, width - statusLeft.length - statusRight.length));
    this.screen.writeLine(statusLine, statusLeft + statusPadding + statusRight, fg.gray);
    
    // Render to terminal (use fullRender for now - more reliable)
    this.screen.fullRender();
  }
  
  /**
   * Full render (alias for render, used on start)
   */
  private fullRender(): void {
    this.render();
  }
  
  /**
   * Format a message into lines
   */
  private formatMessage(role: 'user' | 'assistant' | 'system', content: string, maxWidth: number): Array<{ text: string; style: string }> {
    const lines: Array<{ text: string; style: string }> = [];
    
    // Role indicator
    const roleStyle = role === 'user' ? fg.green : role === 'assistant' ? fg.cyan : fg.yellow;
    const roleLabel = role === 'user' ? '> ' : role === 'assistant' ? '  ' : '# ';
    
    // Split content into lines
    const contentLines = content.split('\n');
    
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i];
      const prefix = i === 0 ? roleLabel : '  ';
      const prefixStyle = i === 0 ? roleStyle : '';
      
      // Word wrap long lines
      if (line.length > maxWidth - prefix.length) {
        const wrapped = this.wordWrap(line, maxWidth - prefix.length);
        for (let j = 0; j < wrapped.length; j++) {
          lines.push({
            text: (j === 0 ? prefix : '  ') + wrapped[j],
            style: j === 0 ? prefixStyle : '',
          });
        }
      } else {
        lines.push({
          text: prefix + line,
          style: prefixStyle,
        });
      }
    }
    
    // Add empty line after message
    lines.push({ text: '', style: '' });
    
    return lines;
  }
  
  /**
   * Get messages formatted for visible area (including streaming)
   */
  private getVisibleMessages(height: number, width: number): Array<{ text: string; style: string }> {
    const allLines: Array<{ text: string; style: string }> = [];
    
    for (const msg of this.messages) {
      const msgLines = this.formatMessage(msg.role, msg.content, width);
      allLines.push(...msgLines);
    }
    
    // Add streaming content if active
    if (this.isStreaming && this.streamingContent) {
      const streamLines = this.formatMessage('assistant', this.streamingContent + '▊', width);
      allLines.push(...streamLines);
    }
    
    // Apply scroll offset and return last 'height' lines
    const startIndex = Math.max(0, allLines.length - height - this.scrollOffset);
    const endIndex = allLines.length - this.scrollOffset;
    
    return allLines.slice(startIndex, endIndex);
  }
  
  /**
   * Simple word wrap
   */
  private wordWrap(text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    
    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine += (currentLine ? ' ' : '') + word;
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines.length > 0 ? lines : [''];
  }
}
