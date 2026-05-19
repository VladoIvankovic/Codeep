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
      { key: '/settings', description: 'Open settings' },
      { key: '/version', description: 'Show version' },
      { key: '/update', description: 'Check for updates' },
      { key: '/stats (/cost)', description: 'Token usage & cost this session' },
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
      { key: '/compact [keepN]', description: 'AI-summarize older messages to free up context (keeps last N)' },
    ],
  },
  {
    title: 'Checkpoints (2.0)',
    items: [
      { key: '/checkpoint [name]', description: 'Snapshot conversation + provider/model + git HEAD' },
      { key: '/checkpoints', description: 'List saved checkpoints in this workspace' },
      { key: '/rewind <id>', description: 'Restore conversation from a checkpoint' },
      { key: '/checkpoint delete <id>', description: 'Delete a saved checkpoint' },
    ],
  },
  {
    title: 'Agent Mode',
    items: [
      { key: '/agent <task>', description: 'Run agent with task' },
      { key: '/agent-dry <task>', description: 'Dry run (no changes)' },
      { key: '/plan <task>', description: 'Generate a plan first — review before /go executes' },
      { key: '/go', description: 'Execute the pending plan from /plan' },
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
      { key: '/amend', description: 'Amend last commit' },
      { key: '/branch', description: 'Create/manage branches' },
      { key: '/stash', description: 'Stash changes' },
      { key: '/init', description: 'Initialize project (.codeep/ folder)' },
      { key: '/scan', description: 'Scan project structure' },
      { key: '/memory <note>', description: 'Add note to project intelligence' },
      { key: '/memory list', description: 'Show all memory notes' },
      { key: '/memory remove <n>', description: 'Remove note by index' },
      { key: '/memory clear', description: 'Clear all memory notes' },
      { key: '/review', description: 'AI review of unstaged git changes (not full codebase)' },
      { key: '/review --staged', description: 'AI review of staged git changes' },
      { key: '/review --static', description: 'Static analysis — changed files, or whole src/ if clean' },
      { key: '/review <file>', description: 'Static analysis of specific file(s)' },
    ],
  },
  {
    title: 'Code Operations',
    items: [
      { key: '/copy [n]', description: 'Copy code block to clipboard' },
      { key: '/paste', description: 'Paste from clipboard' },
      { key: '/apply', description: 'Apply file changes from AI' },
      { key: '/add <path>', description: 'Add file to context' },
      { key: '/drop [path]', description: 'Remove file (or all) from context' },
      { key: '/multiline', description: 'Toggle multi-line input mode' },
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
      { key: '/security', description: 'Security audit (SQLi, XSS, secrets, auth)' },
      { key: '/coverage', description: 'Run/analyze test coverage' },
      { key: '/component <name>', description: 'Generate UI component' },
      { key: '/api <name>', description: 'Generate API endpoint' },
      { key: '/docker', description: 'Generate Dockerfile + compose' },
      { key: '/skills', description: 'List all 50+ skills' },
      { key: '/skills <query>', description: 'Search skills by keyword' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { key: '/provider', description: 'Change AI provider' },
      { key: '/model', description: 'Change model' },
      { key: '/model <name>', description: 'Load saved profile (e.g. /model fast)' },
      { key: '/protocol', description: 'Switch API protocol' },
      { key: '/lang', description: 'Set response language' },
      { key: '/grant', description: 'Grant write permission' },
      { key: '/login', description: 'Login with API key' },
      { key: '/logout', description: 'Logout from provider' },
      { key: '/profile save <name>', description: 'Save current provider+model as profile' },
      { key: '/profile list', description: 'List saved profiles' },
      { key: '/openrouter', description: 'OpenRouter routing prefs (prefer/ignore providers, fallbacks, privacy)' },
      { key: '/personality', description: 'List or switch agent tone (concise / verbose / security / senior-reviewer / …)' },
      { key: '/personality <name>', description: 'Activate a personality. /personality off to clear.' },
      { key: '/insights [--days N]', description: 'Activity summary — runs, files, tools, projects over the last N days (default 7)' },
    ],
  },
  {
    title: 'Extensions & MCP (2.0)',
    items: [
      { key: '/mcp', description: 'List connected MCP servers + their tools' },
      { key: '/mcp browse [id]', description: 'Browse marketplace (12 servers) or show one' },
      { key: '/mcp install <id> [args]', description: 'Install a marketplace server into this project' },
      { key: '/mcp add <name> <cmd>', description: 'Add a custom MCP server (npx, binary, etc.)' },
      { key: '/mcp remove <name>', description: 'Remove a project-scoped MCP server' },
      { key: '/mcp reload', description: 'Re-read .codeep/mcp_servers.json (after manual edit)' },
      { key: '/mcp resources', description: 'List resources exposed by connected servers' },
      { key: '/mcp read <uri>', description: 'Read one MCP resource' },
      { key: '/mcp prompts', description: 'List prompt templates exposed by servers' },
      { key: '/mcp prompt <server> <name>', description: 'Materialize a prompt with arguments (key=value)' },
      { key: '/hooks', description: 'List installed lifecycle hooks (.codeep/hooks/<event>.sh)' },
      { key: '/commands', description: 'List custom slash commands (.codeep/commands/*.md)' },
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
  {
    title: 'Ollama (Local AI)',
    items: [
      { key: '/provider', description: 'Select "ollama" for local models' },
      { key: '/settings > Ollama URL', description: 'Set URL (default: http://localhost:11434)' },
      { key: '/model', description: 'Pick installed Ollama model dynamically' },
      { key: '/model pull <model>', description: 'Pull an Ollama model (local Ollama only)' },
      { key: 'OLLAMA_HOST=0.0.0.0', description: 'Required env var for remote Ollama access' },
    ],
  },
];

/**
 * Keyboard shortcuts
 */
export const keyboardShortcuts = [
  { key: 'Enter', description: 'Send message' },
  { key: '\\+Enter', description: 'Continue on next line' },
  { key: 'Esc', description: 'Cancel/Close (send in multiline)' },
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
