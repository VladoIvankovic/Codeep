/**
 * ANSI escape codes for terminal control
 * Low-level building blocks for custom renderer
 */

// Cursor control
export const cursor = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  home: '\x1b[H',
  
  // Move cursor to position (1-indexed)
  to: (row: number, col: number) => `\x1b[${row};${col}H`,
  
  // Move cursor relative
  up: (n = 1) => `\x1b[${n}A`,
  down: (n = 1) => `\x1b[${n}B`,
  right: (n = 1) => `\x1b[${n}C`,
  left: (n = 1) => `\x1b[${n}D`,
  
  // Save/restore position
  save: '\x1b[s',
  restore: '\x1b[u',
  
  // Get position (requires reading response)
  getPosition: '\x1b[6n',
};

// Screen control
export const screen = {
  clear: '\x1b[2J',
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[J',
  clearToLineEnd: '\x1b[K',
  
  // Scroll region
  setScrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
  resetScrollRegion: '\x1b[r',
  
  // Alternative screen buffer (like vim uses)
  enterAltBuffer: '\x1b[?1049h',
  exitAltBuffer: '\x1b[?1049l',
};

// Colors - basic 16 colors
export const fg = {
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Bright variants
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // 256 color
  color256: (n: number) => `\x1b[38;5;${n}m`,
  
  // RGB
  rgb: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
};

export const bg = {
  black: '\x1b[40m',
  red: '\x1b[41m',
  green: '\x1b[42m',
  yellow: '\x1b[43m',
  blue: '\x1b[44m',
  magenta: '\x1b[45m',
  cyan: '\x1b[46m',
  white: '\x1b[47m',
  gray: '\x1b[100m',
  
  // 256 color
  color256: (n: number) => `\x1b[48;5;${n}m`,
  
  // RGB
  rgb: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
};

// Text styles
export const style = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',
  
  // Reset specific
  resetBold: '\x1b[22m',
  resetDim: '\x1b[22m',
  resetItalic: '\x1b[23m',
  resetUnderline: '\x1b[24m',
  resetBlink: '\x1b[25m',
  resetInverse: '\x1b[27m',
  resetHidden: '\x1b[28m',
  resetStrikethrough: '\x1b[29m',
};

/**
 * Helper to create styled text
 */
export function styled(text: string, ...styles: string[]): string {
  if (styles.length === 0) return text;
  return styles.join('') + text + style.reset;
}

/**
 * Strip ANSI codes from string (for length calculation)
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Get visible length of string (excluding ANSI codes)
 */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Truncate string to visible length, preserving ANSI codes
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  const visible = stripAnsi(str);
  if (visible.length <= maxLength) return str;
  
  // Simple truncation - may cut ANSI codes
  // For proper handling, we'd need to parse ANSI sequences
  let visibleCount = 0;
  let result = '';
  let inEscape = false;
  
  for (const char of str) {
    if (char === '\x1b') {
      inEscape = true;
      result += char;
    } else if (inEscape) {
      result += char;
      if (char.match(/[a-zA-Z]/)) {
        inEscape = false;
      }
    } else {
      if (visibleCount < maxLength - suffix.length) {
        result += char;
        visibleCount++;
      } else {
        break;
      }
    }
  }
  
  return result + style.reset + suffix;
}

/**
 * Wrap text to fit width, respecting ANSI codes
 */
export function wordWrap(str: string, width: number): string[] {
  const lines: string[] = [];
  const words = str.split(' ');
  let currentLine = '';
  let currentLength = 0;
  
  for (const word of words) {
    const wordLength = visibleLength(word);
    
    if (currentLength + wordLength + 1 > width && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      currentLength = wordLength;
    } else {
      currentLine += (currentLine ? ' ' : '') + word;
      currentLength += wordLength + (currentLine ? 1 : 0);
    }
  }
  
  if (currentLine) {
    lines.push(currentLine);
  }
  
  return lines;
}
