/**
 * Terminal utilities for better rendering control
 * Implements DEC Mode 2026 (Synchronized Output) and other optimizations
 */

import { WriteStream } from 'tty';

// DEC Mode 2026 - Synchronized Output
// Tells terminal to batch all output until end marker
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

// Alternate screen buffer (not used - loses scroll history)
// const ALT_SCREEN_ON = '\x1b[?1049h';
// const ALT_SCREEN_OFF = '\x1b[?1049l';

// Cursor visibility
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';

// Screen clearing (avoid - causes scroll jump)
// const CLEAR_SCREEN = '\x1b[2J';
// const CLEAR_SCROLLBACK = '\x1b[3J';

/**
 * Check if terminal supports synchronized output (DEC 2026)
 * Modern terminals: Ghostty, iTerm2 3.5+, Kitty, WezTerm, VSCode 1.80+
 */
export function supportsSynchronizedOutput(): boolean {
  const term = process.env.TERM_PROGRAM?.toLowerCase() || '';
  const termEnv = process.env.TERM?.toLowerCase() || '';
  
  // Known supported terminals
  const supportedTerminals = [
    'ghostty',
    'iterm.app',
    'iterm2',
    'kitty',
    'wezterm',
    'vscode',
    'alacritty', // 0.13+
  ];
  
  // Check TERM_PROGRAM
  if (supportedTerminals.some(t => term.includes(t))) {
    return true;
  }
  
  // Check for xterm-256color with modern terminal
  if (termEnv.includes('xterm') || termEnv.includes('256color')) {
    // Most modern terminals report as xterm-256color
    // We'll enable sync output and let it gracefully degrade if not supported
    return true;
  }
  
  return false;
}

/**
 * Wrap stdout.write to use synchronized output when available
 */
export function createSyncWriter(stdout: WriteStream | undefined): {
  startSync: () => void;
  endSync: () => void;
  write: (data: string) => void;
} {
  const syncSupported = supportsSynchronizedOutput();
  let inSync = false;
  
  return {
    startSync: () => {
      if (syncSupported && stdout && !inSync) {
        stdout.write(SYNC_START);
        inSync = true;
      }
    },
    endSync: () => {
      if (syncSupported && stdout && inSync) {
        stdout.write(SYNC_END);
        inSync = false;
      }
    },
    write: (data: string) => {
      stdout?.write(data);
    },
  };
}

/**
 * Hide cursor during heavy rendering operations
 */
export function hideCursor(stdout: WriteStream | undefined): void {
  stdout?.write(CURSOR_HIDE);
}

/**
 * Show cursor after rendering
 */
export function showCursor(stdout: WriteStream | undefined): void {
  stdout?.write(CURSOR_SHOW);
}

/**
 * Clear N lines above cursor without scrolling
 * More targeted than full screen clear
 */
export function clearLinesAbove(stdout: WriteStream | undefined, lines: number): void {
  if (!stdout || lines <= 0) return;
  
  let seq = '';
  seq += `\x1b[${lines}A`; // Move up N lines
  for (let i = 0; i < lines; i++) {
    seq += '\x1b[2K'; // Clear line
    if (i < lines - 1) seq += '\x1b[B'; // Move down (except last)
  }
  seq += `\x1b[${lines - 1}A`; // Move back to top of cleared area
  
  stdout.write(seq);
}

/**
 * Move cursor to specific line (relative to current position)
 */
export function moveCursor(stdout: WriteStream | undefined, lines: number): void {
  if (!stdout || lines === 0) return;
  
  if (lines > 0) {
    stdout.write(`\x1b[${lines}B`); // Move down
  } else {
    stdout.write(`\x1b[${Math.abs(lines)}A`); // Move up
  }
}

/**
 * Request terminal size (for responsive layouts)
 */
export function getTerminalSize(stdout: WriteStream | undefined): { columns: number; rows: number } {
  return {
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  };
}
