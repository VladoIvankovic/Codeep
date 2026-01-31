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

// Render app
render(<App />);
