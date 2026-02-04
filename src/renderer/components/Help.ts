/**
 * Help screen component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { renderHelpModal } from './Modal';

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
    ],
  },
  {
    title: 'Git & Project',
    items: [
      { key: '/diff', description: 'Review git diff with AI' },
      { key: '/diff --staged', description: 'Review staged changes' },
      { key: '/commit', description: 'Generate commit message' },
      { key: '/scan', description: 'Scan project structure' },
      { key: '/review', description: 'Code review' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { key: '/provider', description: 'Change AI provider' },
      { key: '/model', description: 'Change model' },
      { key: '/grant', description: 'Manage permissions' },
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
 * Render full help screen
 */
export function renderHelpScreen(screen: Screen, page: number = 0): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const title = '═══ Codeep Help ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 0, title, fg.cyan + style.bold);
  
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
  const pageInfo = totalPages > 1 ? `Page ${page + 1}/${totalPages} | ` : '';
  const footer = `${pageInfo}Press Esc to close`;
  screen.write(2, footerY, footer, fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}
