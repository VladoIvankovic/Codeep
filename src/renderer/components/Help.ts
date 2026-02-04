/**
 * Help screen component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { renderHelpModal } from './Modal';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

export interface HelpCategory {
  title: string;
  items: Array<{ key: string; description: string }>;
}

/**
 * Codeep command help data
 */
export const helpCategories: HelpCategory[] = [
  {
    title: 'General',
    items: [
      { key: '/help', description: 'Show this help' },
      { key: '/status', description: 'Current status' },
      { key: '/version', description: 'Show version' },
      { key: '/update', description: 'Check for updates' },
      { key: '/clear', description: 'Clear chat' },
      { key: '/exit', description: 'Quit application' },
    ],
  },
  {
    title: 'Sessions',
    items: [
      { key: '/sessions', description: 'List and load sessions' },
      { key: '/new', description: 'Start new session' },
      { key: '/rename <name>', description: 'Rename current session' },
      { key: '/search <term>', description: 'Search chat history' },
      { key: '/export [md|json|txt]', description: 'Export chat' },
    ],
  },
  {
    title: 'Agent Mode',
    items: [
      { key: '/agent <task>', description: 'Run agent with task' },
      { key: '/agent-dry <task>', description: 'Dry run (no changes)' },
      { key: '/stop', description: 'Stop running agent' },
      { key: '/undo', description: 'Undo last agent action' },
      { key: '/undo-all', description: 'Undo all agent actions' },
      { key: '/history', description: 'Show agent history' },
      { key: '/changes', description: 'Show session changes' },
    ],
  },
  {
    title: 'Git & Project',
    items: [
      { key: '/diff', description: 'Review git diff with AI' },
      { key: '/diff --staged', description: 'Review staged changes' },
      { key: '/commit (/c)', description: 'Generate commit message' },
      { key: '/git-commit <msg>', description: 'Commit with message' },
      { key: '/push (/p)', description: 'Git push' },
      { key: '/pull', description: 'Git pull' },
      { key: '/scan', description: 'Scan project structure' },
      { key: '/review', description: 'Code review' },
    ],
  },
  {
    title: 'Code Operations',
    items: [
      { key: '/copy [n]', description: 'Copy code block to clipboard' },
      { key: '/paste', description: 'Paste from clipboard' },
      { key: '/apply', description: 'Apply file changes from AI' },
    ],
  },
  {
    title: 'Skills (Shortcuts)',
    items: [
      { key: '/test (/t)', description: 'Generate/run tests' },
      { key: '/docs (/d)', description: 'Add documentation' },
      { key: '/refactor (/r)', description: 'Improve code quality' },
      { key: '/fix (/f)', description: 'Debug and fix issues' },
      { key: '/explain (/e)', description: 'Explain code' },
      { key: '/optimize (/o)', description: 'Optimize performance' },
      { key: '/debug (/b)', description: 'Debug problems' },
      { key: '/skills', description: 'List all skills' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { key: '/provider', description: 'Change AI provider' },
      { key: '/model', description: 'Change model' },
      { key: '/protocol', description: 'Switch API protocol' },
      { key: '/lang', description: 'Set response language' },
      { key: '/grant', description: 'Grant write permission' },
      { key: '/login', description: 'Login with API key' },
      { key: '/logout', description: 'Logout from provider' },
    ],
  },
  {
    title: 'Context',
    items: [
      { key: '/context-save', description: 'Save conversation' },
      { key: '/context-load', description: 'Load conversation' },
      { key: '/context-clear', description: 'Clear saved context' },
      { key: '/learn', description: 'Learn code preferences' },
      { key: '/learn status', description: 'Show learned prefs' },
      { key: '/learn rule <text>', description: 'Add custom rule' },
    ],
  },
];

/**
 * Keyboard shortcuts
 */
export const keyboardShortcuts = [
  { key: 'Enter', description: 'Send message' },
  { key: 'Esc', description: 'Cancel/Close' },
  { key: 'Ctrl+L', description: 'Clear screen' },
  { key: 'Ctrl+C', description: 'Exit' },
  { key: '↑/↓', description: 'Input history' },
  { key: 'PgUp/PgDn', description: 'Scroll messages' },
];

/**
 * Get total number of help pages
 */
export function getHelpTotalPages(screenHeight: number): number {
  const availableHeight = screenHeight - 5; // Account for title and footer
  
  // Count all items
  let itemCount = 0;
  for (const category of helpCategories) {
    itemCount += 2; // Empty line + category header
    itemCount += category.items.length;
  }
  itemCount += 2; // Keyboard shortcuts header
  itemCount += keyboardShortcuts.length;
  
  return Math.max(1, Math.ceil(itemCount / availableHeight));
}

/**
 * Render full help screen
 */
export function renderHelpScreen(screen: Screen, page: number = 0): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const title = '═══ Codeep Help ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 0, title, PRIMARY_COLOR + style.bold);
  
  // Calculate layout
  const contentStartY = 2;
  const contentEndY = height - 3;
  const availableHeight = contentEndY - contentStartY;
  
  // Collect all items with categories
  const allItems: Array<{ text: string; style: string }> = [];
  
  for (const category of helpCategories) {
    // Category header
    allItems.push({ text: '', style: '' });
    allItems.push({ text: `  ${category.title}`, style: fg.yellow + style.bold });
    
    // Items
    for (const item of category.items) {
      const keyPadded = item.key.padEnd(20);
      allItems.push({ 
        text: `    ${keyPadded} ${item.description}`,
        style: '',
      });
    }
  }
  
  // Add keyboard shortcuts section
  allItems.push({ text: '', style: '' });
  allItems.push({ text: '  Keyboard Shortcuts', style: fg.yellow + style.bold });
  for (const shortcut of keyboardShortcuts) {
    const keyPadded = shortcut.key.padEnd(12);
    allItems.push({
      text: `    ${keyPadded} ${shortcut.description}`,
      style: '',
    });
  }
  
  // Pagination
  const totalPages = Math.ceil(allItems.length / availableHeight);
  const startIndex = page * availableHeight;
  const visibleItems = allItems.slice(startIndex, startIndex + availableHeight);
  
  // Render items
  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    // Highlight command part (starts with /)
    if (item.text.includes('/')) {
      const match = item.text.match(/^(\s*)(\S+)(\s+)(.*)$/);
      if (match) {
        const [, indent, cmd, space, desc] = match;
        screen.write(0, contentStartY + i, indent, '');
        screen.write(indent.length, contentStartY + i, cmd, fg.green);
        screen.write(indent.length + cmd.length, contentStartY + i, space + desc, fg.white);
        continue;
      }
    }
    screen.write(0, contentStartY + i, item.text, item.style || fg.white);
  }
  
  // Footer
  const footerY = height - 1;
  const pageInfo = totalPages > 1 ? `Page ${page + 1}/${totalPages} | ←→ Navigate | ` : '';
  const footer = `${pageInfo}Esc Close`;
  screen.write(2, footerY, footer, fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}
