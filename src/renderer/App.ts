/**
 * Main Application using custom renderer
 * Replaces Ink-based App
 */

import { Screen } from './Screen';
import { Input, LineEditor, KeyEvent } from './Input';
import { fg, style } from './ansi';
import { renderHelpScreen } from './components/Help';
import { renderStatusScreen, StatusInfo } from './components/Status';
import { renderListModal } from './components/Modal';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type AppScreen = 'chat' | 'help' | 'status' | 'provider' | 'model' | 'sessions';

export interface AppOptions {
  onSubmit: (message: string) => Promise<void>;
  onCommand: (command: string, args: string[]) => void;
  onExit: () => void;
  getStatus: () => StatusInfo;
}

export class App {
  private screen: Screen;
  private input: Input;
  private editor: LineEditor;
  private messages: Message[] = [];
  private streamingContent = '';
  private isStreaming = false;
  private isLoading = false;
  private currentScreen: AppScreen = 'chat';
  private options: AppOptions;
  private scrollOffset = 0;
  private notification = '';
  private notificationTimeout: NodeJS.Timeout | null = null;
  
  // Modal state
  private listItems: string[] = [];
  private listSelectedIndex = 0;
  private listTitle = '';
  private listCallback: ((index: number) => void) | null = null;
  
  constructor(options: AppOptions) {
    this.screen = new Screen();
    this.input = new Input();
    this.editor = new LineEditor();
    this.options = options;
  }
  
  /**
   * Start the application
   */
  start(): void {
    this.screen.init();
    this.input.start();
    
    this.input.onKey((event) => this.handleKey(event));
    
    this.render();
  }
  
  /**
   * Stop the application
   */
  stop(): void {
    this.input.stop();
    this.screen.cleanup();
  }
  
  /**
   * Add a message
   */
  addMessage(message: Message): void {
    this.messages.push(message);
    this.scrollOffset = 0;
    this.render();
  }
  
  /**
   * Set messages (for loading session)
   */
  setMessages(messages: Message[]): void {
    this.messages = messages;
    this.scrollOffset = 0;
    this.render();
  }
  
  /**
   * Clear messages
   */
  clearMessages(): void {
    this.messages = [];
    this.scrollOffset = 0;
    this.render();
  }
  
  /**
   * Get all messages (for API history)
   */
  getMessages(): Message[] {
    return this.messages;
  }
  
  /**
   * Get messages without system messages (for API)
   */
  getChatHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }
  
  /**
   * Start streaming
   */
  startStreaming(): void {
    this.isStreaming = true;
    this.isLoading = false;
    this.streamingContent = '';
    this.render();
  }
  
  /**
   * Add streaming chunk
   */
  addStreamChunk(chunk: string): void {
    this.streamingContent += chunk;
    this.render();
  }
  
  /**
   * End streaming
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
   * Set loading state
   */
  setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.render();
  }
  
  /**
   * Show notification
   */
  notify(message: string, duration = 3000): void {
    this.notification = message;
    this.render();
    
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    
    this.notificationTimeout = setTimeout(() => {
      this.notification = '';
      this.render();
    }, duration);
  }
  
  /**
   * Show list selection modal
   */
  showList(title: string, items: string[], callback: (index: number) => void): void {
    this.listTitle = title;
    this.listItems = items;
    this.listSelectedIndex = 0;
    this.listCallback = callback;
    this.currentScreen = 'sessions'; // Generic list screen
    this.render();
  }
  
  /**
   * Handle keyboard input
   */
  private handleKey(event: KeyEvent): void {
    // Global shortcuts
    if (event.ctrl && (event.key === 'c' || event.key === 'd')) {
      this.stop();
      this.options.onExit();
      return;
    }
    
    // Screen-specific handling
    switch (this.currentScreen) {
      case 'help':
        if (event.key === 'escape' || event.key === 'q') {
          this.currentScreen = 'chat';
          this.render();
        }
        break;
        
      case 'status':
        if (event.key === 'escape' || event.key === 'q') {
          this.currentScreen = 'chat';
          this.render();
        }
        break;
        
      case 'sessions':
      case 'provider':
      case 'model':
        this.handleListKey(event);
        break;
        
      case 'chat':
      default:
        this.handleChatKey(event);
        break;
    }
  }
  
  /**
   * Handle chat screen keys
   */
  private handleChatKey(event: KeyEvent): void {
    // Escape to cancel streaming/loading
    if (event.key === 'escape') {
      if (this.isStreaming) {
        this.endStreaming();
      }
      return;
    }
    
    // Ctrl+L to clear
    if (event.ctrl && event.key === 'l') {
      this.clearMessages();
      this.notify('Chat cleared');
      return;
    }
    
    // Page up/down for scrolling
    if (event.key === 'pageup') {
      this.scrollOffset = Math.min(this.scrollOffset + 5, Math.max(0, this.messages.length - 1));
      this.render();
      return;
    }
    
    if (event.key === 'pagedown') {
      this.scrollOffset = Math.max(this.scrollOffset - 5, 0);
      this.render();
      return;
    }
    
    // Enter to submit
    if (event.key === 'enter' && !this.isLoading && !this.isStreaming) {
      const value = this.editor.getValue().trim();
      if (value) {
        this.editor.addToHistory(value);
        this.editor.clear();
        
        // Check for commands
        if (value.startsWith('/')) {
          this.handleCommand(value);
        } else {
          // Regular message
          this.addMessage({ role: 'user', content: value });
          this.setLoading(true);
          this.options.onSubmit(value).catch(err => {
            this.notify(`Error: ${err.message}`);
            this.setLoading(false);
          });
        }
      }
      return;
    }
    
    // Handle editor keys
    if (this.editor.handleKey(event)) {
      this.render();
    }
  }
  
  /**
   * Handle list modal keys
   */
  private handleListKey(event: KeyEvent): void {
    if (event.key === 'escape') {
      this.currentScreen = 'chat';
      this.listCallback = null;
      this.render();
      return;
    }
    
    if (event.key === 'up') {
      this.listSelectedIndex = Math.max(0, this.listSelectedIndex - 1);
      this.render();
      return;
    }
    
    if (event.key === 'down') {
      this.listSelectedIndex = Math.min(this.listItems.length - 1, this.listSelectedIndex + 1);
      this.render();
      return;
    }
    
    if (event.key === 'enter') {
      const callback = this.listCallback;
      const index = this.listSelectedIndex;
      this.currentScreen = 'chat';
      this.listCallback = null;
      this.render();
      
      if (callback) {
        callback(index);
      }
      return;
    }
  }
  
  /**
   * Handle command
   */
  private handleCommand(input: string): void {
    const parts = input.slice(1).split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    switch (command) {
      case 'help':
        this.currentScreen = 'help';
        this.render();
        break;
        
      case 'status':
        this.currentScreen = 'status';
        this.render();
        break;
        
      case 'clear':
        this.clearMessages();
        this.notify('Chat cleared');
        break;
        
      case 'exit':
      case 'quit':
        this.stop();
        this.options.onExit();
        break;
        
      default:
        // Pass to external handler
        this.options.onCommand(command, args);
        break;
    }
  }
  
  /**
   * Render current screen
   */
  render(): void {
    switch (this.currentScreen) {
      case 'help':
        renderHelpScreen(this.screen);
        break;
        
      case 'status':
        renderStatusScreen(this.screen, this.options.getStatus());
        break;
        
      case 'sessions':
      case 'provider':
      case 'model':
        this.renderChatWithModal();
        break;
        
      case 'chat':
      default:
        this.renderChat();
        break;
    }
  }
  
  /**
   * Render chat screen
   */
  private renderChat(): void {
    const { width, height } = this.screen.getSize();
    
    this.screen.clear();
    
    // Layout
    const headerLine = 0;
    const messagesStart = 1;
    const messagesEnd = height - 4;
    const separatorLine = height - 3;
    const inputLine = height - 2;
    const statusLine = height - 1;
    
    // Header
    const header = ' Codeep ';
    const headerPadding = '─'.repeat(Math.max(0, (width - header.length) / 2));
    this.screen.writeLine(headerLine, headerPadding + header + headerPadding, fg.cyan);
    
    // Messages
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
    
    // Input
    this.renderInput(inputLine, width);
    
    // Status bar
    this.renderStatusBar(statusLine, width);
    
    this.screen.fullRender();
  }
  
  /**
   * Render chat with modal overlay
   */
  private renderChatWithModal(): void {
    // First render chat
    this.renderChat();
    
    // Then overlay modal
    if (this.listItems.length > 0) {
      renderListModal(
        this.screen,
        this.listTitle,
        this.listItems,
        this.listSelectedIndex,
        '↑↓ Navigate | Enter Select | Esc Cancel'
      );
      this.screen.fullRender();
    }
  }
  
  /**
   * Render input line
   */
  private renderInput(y: number, width: number): void {
    const prompt = this.isLoading ? '⏳ ' : this.isStreaming ? '◆ ' : '> ';
    const inputValue = this.editor.getValue();
    const cursorPos = this.editor.getCursorPos();
    const maxInputWidth = width - prompt.length - 1;
    
    let displayValue: string;
    let cursorX: number;
    
    if (inputValue.length <= maxInputWidth) {
      displayValue = inputValue;
      cursorX = prompt.length + cursorPos;
    } else {
      const visibleStart = Math.max(0, cursorPos - Math.floor(maxInputWidth * 0.7));
      const visibleEnd = visibleStart + maxInputWidth;
      
      if (visibleStart > 0) {
        displayValue = '…' + inputValue.slice(visibleStart + 1, visibleEnd);
      } else {
        displayValue = inputValue.slice(0, maxInputWidth);
      }
      
      cursorX = prompt.length + (cursorPos - visibleStart);
    }
    
    const promptColor = this.isLoading ? fg.yellow : this.isStreaming ? fg.cyan : fg.green;
    this.screen.writeLine(y, prompt + displayValue, promptColor);
    
    this.screen.setCursor(cursorX, y);
    this.screen.showCursor(!this.isLoading && !this.isStreaming);
  }
  
  /**
   * Render status bar
   */
  private renderStatusBar(y: number, width: number): void {
    let leftText = '';
    let rightText = '';
    
    if (this.notification) {
      leftText = ` ${this.notification}`;
    } else {
      leftText = ` ${this.messages.length} messages`;
    }
    
    if (this.isStreaming) {
      rightText = 'Streaming... (Esc to cancel)';
    } else if (this.isLoading) {
      rightText = 'Thinking...';
    } else {
      rightText = 'Enter send | /help commands';
    }
    
    const padding = ' '.repeat(Math.max(0, width - leftText.length - rightText.length));
    this.screen.writeLine(y, leftText + padding + rightText, fg.gray);
  }
  
  /**
   * Get visible messages (including streaming)
   */
  private getVisibleMessages(height: number, width: number): Array<{ text: string; style: string }> {
    const allLines: Array<{ text: string; style: string }> = [];
    
    for (const msg of this.messages) {
      const msgLines = this.formatMessage(msg.role, msg.content, width);
      allLines.push(...msgLines);
    }
    
    if (this.isStreaming && this.streamingContent) {
      const streamLines = this.formatMessage('assistant', this.streamingContent + '▊', width);
      allLines.push(...streamLines);
    }
    
    const startIndex = Math.max(0, allLines.length - height - this.scrollOffset);
    const endIndex = allLines.length - this.scrollOffset;
    
    return allLines.slice(startIndex, endIndex);
  }
  
  /**
   * Format message into lines
   */
  private formatMessage(role: 'user' | 'assistant' | 'system', content: string, maxWidth: number): Array<{ text: string; style: string }> {
    const lines: Array<{ text: string; style: string }> = [];
    
    const roleStyle = role === 'user' ? fg.green : role === 'assistant' ? fg.cyan : fg.yellow;
    const roleLabel = role === 'user' ? '> ' : role === 'assistant' ? '  ' : '# ';
    
    const contentLines = content.split('\n');
    
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i];
      const prefix = i === 0 ? roleLabel : '  ';
      const prefixStyle = i === 0 ? roleStyle : '';
      
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
    
    lines.push({ text: '', style: '' });
    
    return lines;
  }
  
  /**
   * Word wrap
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
