/**
 * Screen buffer with diff-based rendering
 * Only writes changes to terminal - minimizes flickering
 */

import { cursor, screen, style, stripAnsi, visibleLength } from './ansi';

export interface Cell {
  char: string;
  style: string;
}

export class Screen {
  private width: number;
  private height: number;
  private buffer: Cell[][];
  private rendered: Cell[][];
  private cursorX = 0;
  private cursorY = 0;
  private cursorVisible = true;
  
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.buffer = this.createEmptyBuffer();
    this.rendered = this.createEmptyBuffer();
    
    // Handle resize
    process.stdout.on('resize', () => {
      this.width = process.stdout.columns || 80;
      this.height = process.stdout.rows || 24;
      this.buffer = this.createEmptyBuffer();
      this.rendered = this.createEmptyBuffer();
      this.fullRender();
    });
  }
  
  private createEmptyBuffer(): Cell[][] {
    const buffer: Cell[][] = [];
    for (let y = 0; y < this.height; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < this.width; x++) {
        row.push({ char: ' ', style: '' });
      }
      buffer.push(row);
    }
    return buffer;
  }
  
  /**
   * Get terminal dimensions
   */
  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
  
  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = this.createEmptyBuffer();
  }
  
  /**
   * Write text at position
   */
  write(x: number, y: number, text: string, textStyle = ''): void {
    if (y < 0 || y >= this.height) return;
    
    let col = x;
    let inEscape = false;
    let currentStyle = textStyle;
    
    for (const char of text) {
      if (char === '\x1b') {
        inEscape = true;
        currentStyle += char;
      } else if (inEscape) {
        currentStyle += char;
        if (char.match(/[a-zA-Z]/)) {
          inEscape = false;
        }
      } else if (char === '\n') {
        // Newline - would need to handle multi-line writes
        break;
      } else {
        if (col >= 0 && col < this.width) {
          this.buffer[y][col] = { char, style: currentStyle };
        }
        col++;
      }
    }
  }
  
  /**
   * Write a line, clearing rest of line
   */
  writeLine(y: number, text: string, textStyle = ''): void {
    // Clear the line first
    for (let x = 0; x < this.width; x++) {
      this.buffer[y][x] = { char: ' ', style: '' };
    }
    this.write(0, y, text, textStyle);
  }
  
  /**
   * Write multiple lines starting at y
   */
  writeLines(startY: number, lines: string[], textStyle = ''): number {
    let y = startY;
    for (const line of lines) {
      if (y >= this.height) break;
      this.writeLine(y, line, textStyle);
      y++;
    }
    return y; // Return next available line
  }
  
  /**
   * Write text with word wrapping
   */
  writeWrapped(x: number, y: number, text: string, maxWidth: number, textStyle = ''): number {
    const words = text.split(' ');
    let line = '';
    let lineLength = 0;
    let currentY = y;
    
    for (const word of words) {
      const wordLength = visibleLength(word);
      
      if (lineLength + wordLength + 1 > maxWidth && line) {
        this.write(x, currentY, line, textStyle);
        currentY++;
        if (currentY >= this.height) break;
        line = word;
        lineLength = wordLength;
      } else {
        line += (line ? ' ' : '') + word;
        lineLength += wordLength + (line.length > wordLength ? 1 : 0);
      }
    }
    
    if (line && currentY < this.height) {
      this.write(x, currentY, line, textStyle);
      currentY++;
    }
    
    return currentY; // Return next available line
  }
  
  /**
   * Draw a horizontal line
   */
  horizontalLine(y: number, char = '─', textStyle = ''): void {
    const line = char.repeat(this.width);
    this.writeLine(y, line, textStyle);
  }
  
  /**
   * Set cursor position for input
   */
  setCursor(x: number, y: number): void {
    this.cursorX = Math.max(0, Math.min(x, this.width - 1));
    this.cursorY = Math.max(0, Math.min(y, this.height - 1));
  }
  
  /**
   * Show/hide cursor
   */
  showCursor(visible: boolean): void {
    this.cursorVisible = visible;
  }
  
  /**
   * Render only changed cells (diff render)
   */
  render(): void {
    let output = '';
    let lastStyle = '';
    
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.buffer[y][x];
        const renderedCell = this.rendered[y][x];
        
        // Skip if unchanged
        if (cell.char === renderedCell.char && cell.style === renderedCell.style) {
          continue;
        }
        
        // Move cursor and write
        output += cursor.to(y + 1, x + 1);
        
        if (cell.style !== lastStyle) {
          output += style.reset + cell.style;
          lastStyle = cell.style;
        }
        
        output += cell.char;
        
        // Update rendered buffer
        this.rendered[y][x] = { ...cell };
      }
    }
    
    // Reset style and position cursor
    output += style.reset;
    output += cursor.to(this.cursorY + 1, this.cursorX + 1);
    output += this.cursorVisible ? cursor.show : cursor.hide;
    
    if (output) {
      process.stdout.write(output);
    }
  }
  
  /**
   * Full render (no diff, redraw everything)
   */
  fullRender(): void {
    let output = cursor.hide + cursor.home;
    let lastStyle = '';
    
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.buffer[y][x];
        
        if (cell.style !== lastStyle) {
          output += style.reset + cell.style;
          lastStyle = cell.style;
        }
        
        output += cell.char;
        
        // Update rendered buffer
        this.rendered[y][x] = { ...cell };
      }
      
      // Don't add newline after last row
      if (y < this.height - 1) {
        output += '\r\n';
      }
    }
    
    // Reset style and position cursor
    output += style.reset;
    output += cursor.to(this.cursorY + 1, this.cursorX + 1);
    output += this.cursorVisible ? cursor.show : cursor.hide;
    
    process.stdout.write(output);
  }
  
  /**
   * Initialize screen (hide cursor, clear)
   */
  init(): void {
    process.stdout.write(cursor.hide + screen.clear + cursor.home);
  }
  
  /**
   * Cleanup (show cursor, clear)
   */
  cleanup(): void {
    process.stdout.write(style.reset + screen.clear + cursor.home + cursor.show);
  }
}
