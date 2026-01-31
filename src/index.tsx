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

// Enter alternate screen buffer (like vim, less, htop)
// This isolates the app from terminal scroll history
// Eliminates ghost content and jumping issues
process.stdout.write('\x1b[?1049h'); // Enter alternate buffer
process.stdout.write('\x1b[H');      // Move cursor to top-left

// Exit alternate buffer on app exit
const exitAlternateBuffer = () => {
  process.stdout.write('\x1b[?1049l'); // Exit alternate buffer
};

// Handle various exit scenarios
process.on('exit', exitAlternateBuffer);
process.on('SIGINT', () => {
  exitAlternateBuffer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  exitAlternateBuffer();
  process.exit(0);
});

// Also handle uncaught exceptions to ensure clean exit
process.on('uncaughtException', (err) => {
  exitAlternateBuffer();
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Render app
const { unmount, waitUntilExit } = render(<App />);

// Ensure alternate buffer is exited when Ink unmounts
waitUntilExit().then(() => {
  exitAlternateBuffer();
});
