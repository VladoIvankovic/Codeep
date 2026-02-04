#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app';
import { getCurrentVersion } from './utils/update';

// Handle CLI flags
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`Codeep v${getCurrentVersion()}`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Codeep - AI-powered coding assistant TUI

Usage:
  codeep              Start interactive chat
  codeep --version    Show version
  codeep --help       Show this help

Commands (in chat):
  /help      Show all available commands
  /status    Show current status
  /version   Show version and current model
  /update    Check for updates
  /exit      Quit application

Documentation: https://codeep.dev
GitHub: https://github.com/VladoIvankovic/Codeep
X/Twitter: https://x.com/CodeepDev
Contact: info@codeep.dev
  `);
  process.exit(0);
}

// Clear screen on start
console.clear();

// Enable synchronized output (DEC mode 2026) for compatible terminals
// This tells the terminal to buffer output and display it all at once
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

// Wrap stdout.write to add synchronized output
const originalWrite = process.stdout.write.bind(process.stdout);
let syncEnabled = false;

// Check if terminal likely supports DEC 2026 (modern terminals)
const termProgram = process.env.TERM_PROGRAM || '';
const supportsSync = ['ghostty', 'wezterm', 'kitty', 'alacritty', 'iTerm.app', 'vscode'].some(
  t => termProgram.toLowerCase().includes(t.toLowerCase())
) || process.env.TERM?.includes('256color');

if (supportsSync) {
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void): boolean => {
    if (typeof chunk === 'string' && chunk.length > 100 && !syncEnabled) {
      // For larger outputs, use synchronized rendering
      syncEnabled = true;
      originalWrite(SYNC_START);
      const result = originalWrite(chunk, encoding as BufferEncoding, () => {
        originalWrite(SYNC_END);
        syncEnabled = false;
        if (typeof callback === 'function') callback();
      });
      return result;
    }
    return originalWrite(chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stdout.write;
}

// Render app with optimized settings
render(<App />, {
  // Limit frames per second to reduce CPU usage and flickering
  // Default is undefined (no limit), we set to 30fps
  patchConsole: false, // Don't patch console - we handle output ourselves
});
