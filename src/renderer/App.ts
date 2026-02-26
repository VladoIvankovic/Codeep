/**
 * Main Application using custom renderer
 * Replaces Ink-based App
 */

import { Screen } from './Screen';
import { Input, LineEditor, KeyEvent } from './Input';
import { fg, bg, style, stringWidth } from './ansi';
import { SYNTAX, highlightCode } from './highlight';
import {
  handleInlineStatusKey,
  handleInlineHelpKey,
  handleMenuKey,
  handleInlinePermissionKey,
  handleInlineSessionPickerKey,
  handleInlineConfirmKey,
  handleLoginKey,
} from './handlers';
import clipboardy from 'clipboardy';
import { spawn } from 'child_process';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

// Spinner frames for animation
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

// ASCII Logo
const LOGO_LINES = [
  ' ██████╗ ██████╗ ██████╗ ███████╗███████╗██████╗ ',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗',
  '██║     ██║   ██║██║  ██║█████╗  █████╗  ██████╔╝',
  '██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ',
  '╚██████╗╚██████╔╝██████╔╝███████╗███████╗██║     ',
  ' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝     ',
];
const LOGO_HEIGHT = LOGO_LINES.length;

// Command descriptions for autocomplete
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  'help': 'Show help',
  'status': 'Show status',
  'settings': 'Adjust settings',
  'version': 'Show version',
  'update': 'Check updates',
  'clear': 'Clear chat',
  'exit': 'Quit',
  'sessions': 'Manage sessions',
  'new': 'New session',
  'rename': 'Rename session',
  'search': 'Search history',
  'export': 'Export chat',
  'agent': 'Run agent for a task',
  'agent-dry': 'Preview agent actions',
  'stop': 'Stop running agent',
  'undo': 'Undo last action',
  'undo-all': 'Undo all actions',
  'history': 'Show agent history',
  'changes': 'Show session changes',
  'diff': 'Review git changes',
  'commit': 'Generate commit message',
  'git-commit': 'Commit with message',
  'push': 'Git push',
  'pull': 'Git pull',
  'scan': 'Scan project',
  'review': 'Code review',
  'copy': 'Copy code block',
  'paste': 'Paste from clipboard',
  'apply': 'Apply file changes',
  'add': 'Add file to context',
  'drop': 'Remove file from context',
  'multiline': 'Toggle multi-line input',
  'test': 'Generate/run tests',
  'docs': 'Add documentation',
  'refactor': 'Improve code quality',
  'fix': 'Debug and fix issues',
  'explain': 'Explain code',
  'optimize': 'Optimize performance',
  'debug': 'Debug problems',
  'skills': 'List all skills',
  'provider': 'Switch provider',
  'model': 'Switch model',
  'protocol': 'Switch protocol',
  'lang': 'Set language',
  'grant': 'Grant write permission',
  'login': 'Change API key',
  'logout': 'Logout',
  'context-save': 'Save conversation',
  'context-load': 'Load conversation',
  'context-clear': 'Clear saved context',
  'learn': 'Learn code preferences',
};

import { helpCategories, keyboardShortcuts } from './components/Help';
import { StatusInfo } from './components/Status';

import { renderSettingsScreen, handleSettingsKey, SettingsState, SETTINGS } from './components/Settings';
import { SelectItem } from './components/SelectScreen';
import { renderExportPanel, handleExportKey as handleExportKeyComponent, ExportState } from './components/Export';
import { renderLogoutPanel, handleLogoutKey as handleLogoutKeyComponent, LogoutState } from './components/Logout';
import { renderSearchPanel, handleSearchKey as handleSearchKeyComponent, SearchState } from './components/Search';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ConfirmOptions {
  title: string;
  message: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export interface AppOptions {
  onSubmit: (message: string) => Promise<void>;
  onCommand: (command: string, args: string[]) => void;
  onExit: () => void;
  onStopAgent?: () => void;
  getStatus: () => StatusInfo;
  hasWriteAccess?: () => boolean;
  hasProjectContext?: () => boolean;
}

export class App {
  private screen: Screen;
  private input: Input;
  private editor: LineEditor;
  private messages: Message[] = [];
  private streamingContent = '';
  private isStreaming = false;
  private isLoading = false;
  private options: AppOptions;
  private scrollOffset = 0;
  private notification = '';
  private notificationTimeout: NodeJS.Timeout | null = null;
  
  // Spinner animation state
  private spinnerFrame = 0;
  private spinnerInterval: NodeJS.Timeout | null = null;
  
  // Agent progress state
  private isAgentRunning = false;
  private agentIteration = 0;
  private agentMaxIterations = 0;
  private agentActions: Array<{ type: string; target: string; result: string }> = [];
  private agentThinking = '';
  
  // Paste detection state
  private pasteInfo: { chars: number; lines: number; preview: string; fullText: string } | null = null;
  private pasteInfoOpen = false;
  private codeBlockCounter = 0; // Global code block counter for /copy numbering
  
  // Inline help state
  private helpOpen = false;
  private helpScrollIndex = 0;

  // Inline status state
  private statusOpen = false;
  
  // Settings screen state
  private settingsState: SettingsState = {
    selectedIndex: 0,
    editing: false,
    editValue: '',
  };
  
  // Autocomplete state
  private showAutocomplete = false;
  private autocompleteIndex = 0;
  private autocompleteItems: string[] = [];
  
  // Inline confirmation dialog state
  private confirmOpen = false;
  private confirmOptions: ConfirmOptions | null = null;
  private confirmSelection: 'yes' | 'no' = 'no';
  
  // Inline menu state (renders below input/status)
  private menuOpen = false;
  private menuTitle = '';
  private menuItems: SelectItem[] = [];
  private menuIndex = 0;
  private menuCurrentValue = '';
  private menuCallback: ((item: SelectItem) => void) | null = null;
  
  // Inline settings state
  private settingsOpen = false;
  
  // Inline permission state
  private permissionOpen = false;
  private permissionIndex = 0;
  private permissionPath = '';
  private permissionIsProject = false;
  private permissionCallback: ((level: 'none' | 'read' | 'write') => void) | null = null;
  
  // Inline session picker state
  private sessionPickerOpen = false;
  private sessionPickerIndex = 0;
  private sessionPickerItems: Array<{ name: string; messageCount: number; createdAt: string }> = [];
  private sessionPickerCallback: ((sessionName: string | null) => void) | null = null;
  private sessionPickerDeleteMode = false;
  private sessionPickerDeleteCallback: ((sessionName: string) => void) | null = null;
  
  // Search screen state
  private searchOpen = false;
  private searchQuery = '';
  private searchResults: Array<{ role: string; messageIndex: number; matchedText: string }> = [];
  private searchIndex = 0;
  private searchCallback: ((messageIndex: number) => void) | null = null;
  
  // Export screen state
  private exportOpen = false;
  private exportIndex = 0;
  private exportCallback: ((format: 'md' | 'json' | 'txt') => void) | null = null;
  
  // Logout picker state
  private logoutOpen = false;
  private logoutIndex = 0;
  private logoutProviders: Array<{ id: string; name: string; isCurrent: boolean }> = [];
  private logoutCallback: ((providerId: string | 'all' | null) => void) | null = null;
  
  // Intro animation state
  private showIntro = false;
  private introPhase: 'init' | 'decrypt' | 'done' = 'init';
  private introProgress = 0;
  private introInterval: NodeJS.Timeout | null = null;
  private introCallback: (() => void) | null = null;
  
  // Multi-line input state
  private isMultilineMode = false;

  // Inline login state
  private loginOpen = false;
  private loginStep: 'provider' | 'apikey' = 'provider';
  private loginProviders: Array<{ id: string; name: string; subscribeUrl?: string }> = [];
  private loginProviderIndex = 0;
  private loginApiKey = '';
  private loginError = '';
  private loginCallback: ((result: { providerId: string; apiKey: string } | null) => void) | null = null;
  
  // Glitch characters for intro animation
  private static readonly GLITCH_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*<>?/;:[]=';
  
  // All available commands
  private static readonly COMMANDS = [
    'help', 'status', 'settings', 'version', 'update', 'clear', 'exit',
    'sessions', 'new', 'rename', 'search', 'export',
    'agent', 'agent-dry', 'stop', 'undo', 'undo-all', 'history', 'changes',
    'diff', 'commit', 'git-commit', 'push', 'pull', 'scan', 'review',
    'copy', 'paste', 'apply', 'add', 'drop',
    'test', 'docs', 'refactor', 'fix', 'explain', 'optimize', 'debug', 'skills',
    'amend', 'pr', 'changelog', 'branch', 'stash', 'unstash',
    'build', 'deploy', 'release', 'publish',
    'component', 'api', 'hook', 'service', 'page', 'form', 'crud',
    'security', 'profile', 'log', 'types', 'cleanup', 'modernize', 'migrate',
    'split', 'rename', 'coverage', 'e2e', 'mock', 'readme', 'translate',
    'docker', 'ci', 'env', 'k8s', 'terraform', 'nginx', 'monitor',
    'test-fix', 'api-docs',
    'multiline',
    'provider', 'model', 'protocol', 'lang', 'grant', 'login', 'logout',
    'context-save', 'context-load', 'context-clear', 'learn',
    'c', 't', 'd', 'r', 'f', 'e', 'o', 'b', 'p',
  ];
  
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
    this.screen.onResize(() => this.render());
    
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
   * Scroll to a specific message by index
   */
  scrollToMessage(messageIndex: number): void {
    const { width, height } = this.screen.getSize();
    const maxWidth = width - 4; // Account for margins
    
    // Calculate actual line count for messages up to target
    let totalLines = 0;
    let targetStartLine = 0;
    
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      
      if (i === messageIndex) {
        targetStartLine = totalLines;
      }
      
      // Count lines for this message (header + content)
      const contentLines = msg.content.split('\n');
      let msgLines = 2; // Header + empty line after
      
      for (const line of contentLines) {
        // Account for word wrapping
        msgLines += Math.ceil(Math.max(1, line.length) / maxWidth);
      }
      
      totalLines += msgLines + 1; // +1 for spacing between messages
    }
    
    const visibleLines = height - 12; // Approximate visible area
    
    // Set scroll offset to show the target message near the top
    this.scrollOffset = Math.max(0, totalLines - targetStartLine - Math.floor(visibleLines / 2));
    this.render();
    this.notify(`Jumped to message #${messageIndex + 1}`);
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
    this.startSpinner();
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
    this.stopSpinner();
    this.render();
  }
  
  /**
   * Set loading state
   */
  setLoading(loading: boolean): void {
    this.isLoading = loading;
    if (loading) {
      this.startSpinner();
    } else {
      this.stopSpinner();
    }
    this.render();
  }
  
  /**
   * Start spinner animation
   */
  private startSpinner(): void {
    if (this.spinnerInterval) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 100);
  }
  
  /**
   * Stop spinner animation
   */
  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }
  
  /**
   * Set agent running state
   */
  setAgentRunning(running: boolean): void {
    this.isAgentRunning = running;
    if (running) {
      this.agentIteration = 0;
      this.agentMaxIterations = 0;
      this.agentActions = [];
      this.agentThinking = '';
      this.isLoading = false; // Clear loading state when agent takes over
      this.startSpinner();
    } else {
      this.isLoading = false; // Ensure loading is cleared when agent finishes
      this.stopSpinner();
    }
    this.render();
  }
  
  /**
   * Update agent progress
   */
  updateAgentProgress(iteration: number, action?: { type: string; target: string; result: string }): void {
    this.agentIteration = iteration;
    if (action) {
      this.agentActions.push(action);
    }
    this.render();
  }

  setAgentMaxIterations(max: number): void {
    this.agentMaxIterations = max;
  }

  /**
   * Set agent thinking text
   */
  setAgentThinking(text: string): void {
    this.agentThinking = text;
    this.render();
  }
  
  /**
   * Paste from system clipboard (Ctrl+V)
   */
  private pasteFromClipboard(): void {
    try {
      const clipboardContent = clipboardy.readSync();
      
      if (clipboardContent && clipboardContent.trim()) {
        this.handlePaste(clipboardContent.trim());
      } else {
        this.notify('Clipboard is empty');
      }
    } catch (err) {
      const error = err as Error;
      this.notify(`Clipboard error: ${error.message || 'unknown'}`);
    }
  }
  
  /**
   * Handle paste detection - call this when large text is pasted
   */
  handlePaste(text: string): void {
    const lines = text.split('\n');
    const chars = text.length;
    
    // Only show paste info for significant pastes (>100 chars or >3 lines)
    if (chars < 100 && lines.length <= 3) {
      // Small paste - just add to input directly
      this.editor.insert(text);
      this.updateAutocomplete();
      this.render();
      return;
    }
    
    // Large paste - show info box
    const preview = text.length > 200 ? text.slice(0, 197) + '...' : text;
    this.pasteInfo = {
      chars,
      lines: lines.length,
      preview,
      fullText: text,
    };
    this.pasteInfoOpen = true;
    this.render();
  }
  
  /**
   * Handle paste info key events
   */
  private handlePasteInfoKey(event: KeyEvent): void {
    if (event.key === 'escape' || event.key === 'n') {
      // Cancel paste
      this.pasteInfo = null;
      this.pasteInfoOpen = false;
      this.notify('Paste cancelled');
      this.render();
      return;
    }
    
    if (event.key === 'enter' || event.key === 'y') {
      // Accept paste - add to input
      if (this.pasteInfo) {
        this.editor.insert(this.pasteInfo.fullText);
        this.updateAutocomplete();
      }
      this.pasteInfo = null;
      this.pasteInfoOpen = false;
      this.render();
      return;
    }
    
    if (event.key === 's') {
      // Submit paste directly as message
      if (this.pasteInfo) {
        const text = this.pasteInfo.fullText;
        this.pasteInfo = null;
        this.pasteInfoOpen = false;
        this.render();
        
        // Submit directly
        this.addMessage({ role: 'user', content: text });
        this.setLoading(true);
        this.options.onSubmit(text).catch(err => {
          this.notify(`Error: ${err.message}`);
          this.setLoading(false);
        });
      }
      return;
    }
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
   * Show list selection (inline menu below status bar)
   */
  showList(title: string, items: string[], callback: (index: number) => void): void {
    // Convert string items to SelectItem format and use inline menu
    const selectItems: SelectItem[] = items.map((label, index) => ({
      key: String(index),
      label,
    }));
    
    this.menuTitle = title;
    this.menuItems = selectItems;
    this.menuCurrentValue = '';
    this.menuIndex = 0;
    this.menuCallback = (item) => callback(parseInt(item.key, 10));
    this.menuOpen = true;
    this.render();
  }
  
  /**
   * Show settings (inline, below status bar)
   */
  showSettings(): void {
    this.settingsState = { selectedIndex: 0, editing: false, editValue: '' };
    this.settingsOpen = true;
    this.render();
  }
  
  /**
   * Show confirmation dialog
   */
  showConfirm(options: ConfirmOptions): void {
    this.confirmOptions = options;
    this.confirmSelection = 'no'; // Default to No for safety
    this.confirmOpen = true;
    this.render();
  }
  
  /**
   * Show permission dialog (inline, below status bar)
   */
  showPermission(
    projectPath: string, 
    isProject: boolean, 
    callback: (level: 'none' | 'read' | 'write') => void
  ): void {
    this.permissionPath = projectPath;
    this.permissionIsProject = isProject;
    this.permissionIndex = 0;
    this.permissionCallback = callback;
    this.permissionOpen = true;
    this.render();
  }
  
  /**
   * Show session picker (inline, below status bar)
   */
  showSessionPicker(
    sessions: Array<{ name: string; messageCount: number; createdAt: string }>,
    callback: (sessionName: string | null) => void,
    deleteCallback?: (sessionName: string) => void
  ): void {
    this.sessionPickerItems = sessions;
    this.sessionPickerIndex = 0;
    this.sessionPickerCallback = callback;
    this.sessionPickerDeleteCallback = deleteCallback || null;
    this.sessionPickerDeleteMode = false;
    this.sessionPickerOpen = true;
    this.render();
  }
  
  /**
   * Show search screen
   */
  showSearch(
    query: string,
    results: Array<{ role: string; messageIndex: number; matchedText: string }>,
    callback: (messageIndex: number) => void
  ): void {
    this.searchQuery = query;
    this.searchResults = results;
    this.searchIndex = 0;
    this.searchCallback = callback;
    this.searchOpen = true;
    this.render();
  }
  
  /**
   * Show export screen
   */
  showExport(callback: (format: 'md' | 'json' | 'txt') => void): void {
    this.exportIndex = 0;
    this.exportCallback = callback;
    this.exportOpen = true;
    this.render();
  }
  
  /**
   * Show logout picker
   */
  showLogoutPicker(
    providers: Array<{ id: string; name: string; isCurrent: boolean }>,
    callback: (providerId: string | 'all' | null) => void
  ): void {
    this.logoutProviders = providers;
    this.logoutIndex = 0;
    this.logoutCallback = callback;
    this.logoutOpen = true;
    this.render();
  }
  
  /**
   * Start intro animation
   */
  startIntro(callback: () => void): void {
    this.showIntro = true;
    this.introPhase = 'init';
    this.introProgress = 0;
    this.introCallback = callback;
    
    // Phase 1: Initial noise (500ms)
    let noiseCount = 0;
    const noiseInterval = setInterval(() => {
      noiseCount++;
      this.introProgress = Math.random();
      this.render();
      
      if (noiseCount >= 10) {
        clearInterval(noiseInterval);
        
        // Phase 2: Decryption animation (1500ms)
        this.introPhase = 'decrypt';
        const startTime = Date.now();
        const duration = 1500;
        
        this.introInterval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          this.introProgress = Math.min(elapsed / duration, 1);
          this.render();
          
          if (this.introProgress >= 1) {
            this.finishIntro();
          }
        }, 16); // ~60 FPS
      }
    }, 50);
    
    this.render();
  }
  
  /**
   * Skip intro animation
   */
  private skipIntro(): void {
    this.finishIntro();
  }
  
  /**
   * Finish intro animation
   */
  private finishIntro(): void {
    if (this.introInterval) {
      clearInterval(this.introInterval);
      this.introInterval = null;
    }
    this.introPhase = 'done';
    this.showIntro = false;
    
    if (this.introCallback) {
      this.introCallback();
      this.introCallback = null;
    }
    
    this.render();
  }
  
  /**
   * Show inline login dialog
   */
  showLogin(
    providers: Array<{ id: string; name: string; subscribeUrl?: string }>,
    callback: (result: { providerId: string; apiKey: string } | null) => void
  ): void {
    this.loginProviders = providers;
    this.loginProviderIndex = 0;
    this.loginStep = 'provider';
    this.loginApiKey = '';
    this.loginError = '';
    this.loginCallback = callback;
    this.loginOpen = true;
    this.render();
  }
  
  /**
   * Reinitialize screen (after external screen takeover)
   */
  reinitScreen(): void {
    this.screen.init();
    this.input.start();
    this.input.onKey((event) => this.handleKey(event));
    
    this.render();
  }
  
  /**
   * Show inline menu (renders below status bar)
   */
  showSelect(
    title: string, 
    items: SelectItem[], 
    currentValue: string,
    callback: (item: SelectItem) => void
  ): void {
    this.menuTitle = title;
    this.menuItems = items;
    this.menuCurrentValue = currentValue;
    this.menuCallback = callback;
    this.menuOpen = true;
    
    // Find current value index
    const currentIndex = items.findIndex(item => item.key === currentValue);
    this.menuIndex = currentIndex >= 0 ? currentIndex : 0;
    
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
    
    this.handleChatKey(event);
  }
  
  /**
   * Handle chat screen keys
   */
  private handleChatKey(event: KeyEvent): void {
    // If paste info is open, handle paste keys first
    if (this.pasteInfoOpen) {
      this.handlePasteInfoKey(event);
      return;
    }
    
    // If permission is open, handle permission keys first
    if (this.permissionOpen) {
      this.handleInlinePermissionKey(event);
      return;
    }
    
    // If session picker is open, handle session picker keys first
    if (this.sessionPickerOpen) {
      this.handleInlineSessionPickerKey(event);
      return;
    }
    
    // If confirm is open, handle confirm keys first
    if (this.confirmOpen) {
      this.handleInlineConfirmKey(event);
      return;
    }
    
    // If status is open, handle status keys first
    if (this.statusOpen) {
      this.handleInlineStatusKey(event);
      return;
    }

    // If help is open, handle help keys first
    if (this.helpOpen) {
      this.handleInlineHelpKey(event);
      return;
    }
    
    // If settings is open, handle settings keys first
    if (this.settingsOpen) {
      this.handleInlineSettingsKey(event);
      return;
    }
    
    // If search is open, handle search keys first
    if (this.searchOpen) {
      this.handleSearchKey(event);
      return;
    }
    
    // If export is open, handle export keys first
    if (this.exportOpen) {
      this.handleExportKey(event);
      return;
    }
    
    // If logout is open, handle logout keys first
    if (this.logoutOpen) {
      this.handleLogoutKey(event);
      return;
    }
    
    // If login is open, handle login keys first
    if (this.loginOpen) {
      this.handleLoginKey(event);
      return;
    }
    
    // If intro is playing, skip on any key
    if (this.showIntro) {
      this.skipIntro();
      return;
    }
    
    // If menu is open, handle menu keys first
    if (this.menuOpen) {
      this.handleMenuKey(event);
      return;
    }
    
    // Escape to cancel streaming/loading/agent or close autocomplete
    if (event.key === 'escape') {
      if (this.showAutocomplete) {
        this.showAutocomplete = false;
        this.render();
        return;
      }
      // In multiline mode, Escape submits the buffered input
      if (this.isMultilineMode && !this.isLoading && !this.isStreaming) {
        if (this.editor.getValue().trim()) {
          this.submitInput();
          return;
        }
      }
      if (this.isAgentRunning && this.options.onStopAgent) {
        this.options.onStopAgent();
        return;
      }
      if (this.isStreaming) {
        this.endStreaming();
      }
      return;
    }
    
    // Handle autocomplete navigation
    if (this.showAutocomplete) {
      if (event.key === 'up') {
        this.autocompleteIndex = Math.max(0, this.autocompleteIndex - 1);
        this.render();
        return;
      }
      if (event.key === 'down') {
        this.autocompleteIndex = Math.min(this.autocompleteItems.length - 1, this.autocompleteIndex + 1);
        this.render();
        return;
      }
      if (event.key === 'tab' || event.key === 'enter') {
        // Select autocomplete item
        if (this.autocompleteItems.length > 0) {
          const selected = this.autocompleteItems[this.autocompleteIndex];
          this.editor.setValue('/' + selected + ' ');
          this.showAutocomplete = false;
          this.render();
          return;
        }
      }
    }
    
    // Ctrl+L to clear
    if (event.ctrl && event.key === 'l') {
      this.clearMessages();
      this.notify('Chat cleared');
      return;
    }
    
    // Ctrl+V to paste from clipboard
    if (event.ctrl && event.key === 'v') {
      this.pasteFromClipboard();
      return;
    }
    
    // Ctrl+A - go to beginning of line
    if (event.ctrl && event.key === 'a') {
      this.editor.setCursorPos(0);
      this.render();
      return;
    }
    
    // Ctrl+E - go to end of line
    if (event.ctrl && event.key === 'e') {
      this.editor.setCursorPos(this.editor.getValue().length);
      this.render();
      return;
    }
    
    // Ctrl+U - clear line
    if (event.ctrl && event.key === 'u') {
      this.editor.clear();
      this.showAutocomplete = false;
      this.render();
      return;
    }
    
    // Ctrl+W - delete word backward
    if (event.ctrl && event.key === 'w') {
      this.editor.deleteWordBackward();
      this.updateAutocomplete();
      this.render();
      return;
    }
    
    // Ctrl+K - delete to end of line
    if (event.ctrl && event.key === 'k') {
      this.editor.deleteToEnd();
      this.updateAutocomplete();
      this.render();
      return;
    }
    
    // Page up/down for scrolling chat history
    if (event.key === 'pageup') {
      // Scroll up (show older messages)
      this.scrollOffset += 10;
      this.render();
      return;
    }
    
    if (event.key === 'pagedown') {
      // Scroll down (show newer messages)
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.render();
      return;
    }
    
    // Arrow up/down can also scroll when input is empty
    if (event.key === 'up' && !this.editor.getValue() && !this.showAutocomplete) {
      this.scrollOffset += 3;
      this.render();
      return;
    }
    
    if (event.key === 'down' && !this.editor.getValue() && !this.showAutocomplete && this.scrollOffset > 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      this.render();
      return;
    }
    
    // Mouse scroll
    if (event.key === 'scrollup') {
      this.scrollOffset += 3;
      this.render();
      return;
    }
    
    if (event.key === 'scrolldown') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      this.render();
      return;
    }
    
    // Ignore other mouse events
    if (event.key === 'mouse') {
      return;
    }
    
    // Enter to submit (only if not in autocomplete)
    if (event.key === 'enter' && !this.isLoading && !this.isStreaming && !this.showAutocomplete) {
      const rawValue = this.editor.getValue();

      // Backslash continuation: if line ends with \, add newline instead of submitting
      if (rawValue.endsWith('\\')) {
        this.editor.setValue(rawValue.slice(0, -1) + '\n');
        this.render();
        return;
      }

      // Multiline mode: Enter adds newline, Ctrl+Enter submits
      if (this.isMultilineMode && !event.ctrl) {
        this.editor.insert('\n');
        this.render();
        return;
      }

      this.submitInput();
      return;
    }
    
    // Handle paste detection
    if (event.isPaste && event.key.length > 1) {
      this.handlePaste(event.key);
      return;
    }
    
    // Handle editor keys
    if (this.editor.handleKey(event)) {
      // Update autocomplete based on input
      this.updateAutocomplete();
      this.render();
    }
  }
  
  /**
   * Update autocomplete suggestions
   */
  private updateAutocomplete(): void {
    const value = this.editor.getValue();
    
    // Show autocomplete only when typing a command
    if (value.startsWith('/') && !value.includes(' ')) {
      const query = value.slice(1).toLowerCase();
      this.autocompleteItems = App.COMMANDS.filter(cmd => 
        cmd.startsWith(query)
      ).slice(0, 8); // Max 8 items
      
      this.showAutocomplete = this.autocompleteItems.length > 0 && query.length > 0;
      this.autocompleteIndex = 0;
    } else {
      this.showAutocomplete = false;
      this.autocompleteItems = [];
    }
  }
  
  /**
   * Handle inline status keys
   */
  private handleInlineStatusKey(event: KeyEvent): void {
    handleInlineStatusKey(event, {
      close: () => { this.statusOpen = false; },
      render: () => this.render(),
    });
  }

  /**
   * Handle help screen keys
   */
  private handleInlineHelpKey(event: KeyEvent): void {
    handleInlineHelpKey(event, {
      scrollIndex: this.helpScrollIndex,
      setScrollIndex: (v) => { this.helpScrollIndex = v; },
      close: () => { this.helpOpen = false; },
      render: () => this.render(),
    });
  }
  
  /**
   * Handle inline settings keys
   */
  private handleInlineSettingsKey(event: KeyEvent): void {
    const result = handleSettingsKey(event.key, event.ctrl, this.settingsState);
    this.settingsState = result.newState;
    
    if (result.close) {
      this.settingsOpen = false;
    }
    
    if (result.notify) {
      this.notify(result.notify);
    }
    
    this.render();
  }
  
  /**
   * Handle search screen keys
   */
  private handleSearchKey(event: KeyEvent): void {
    const state: SearchState = {
      searchOpen: this.searchOpen,
      searchQuery: this.searchQuery,
      searchResults: this.searchResults,
      searchIndex: this.searchIndex,
      searchCallback: this.searchCallback,
    };
    const callback = this.searchCallback;
    handleSearchKeyComponent(event, state, {
      onClose: () => {
        this.searchOpen = false;
        this.searchCallback = null;
      },
      onRender: () => {
        this.searchIndex = state.searchIndex;
        this.render();
      },
      onResult: (messageIndex: number) => {
        if (callback) {
          callback(messageIndex);
        }
      },
    });
  }
  
  /**
   * Handle export screen keys
   */
  private handleExportKey(event: KeyEvent): void {
    const state: ExportState = {
      exportOpen: this.exportOpen,
      exportIndex: this.exportIndex,
      exportCallback: this.exportCallback,
    };
    const syncState = () => {
      this.exportOpen = state.exportOpen;
      this.exportIndex = state.exportIndex;
      this.exportCallback = state.exportCallback;
      this.render();
    };
    handleExportKeyComponent(event, state, {
      onClose: syncState,
      onRender: syncState,
      onExport: (format: 'md' | 'json' | 'txt') => {
        const callback = this.exportCallback;
        syncState();
        if (callback) {
          callback(format);
        }
      },
    });
  }
  
  /**
   * Handle logout picker keys
   */
  private handleLogoutKey(event: KeyEvent): void {
    const state: LogoutState = {
      logoutOpen: this.logoutOpen,
      logoutIndex: this.logoutIndex,
      logoutProviders: this.logoutProviders,
      logoutCallback: this.logoutCallback,
    };
    const syncState = () => {
      this.logoutOpen = state.logoutOpen;
      this.logoutIndex = state.logoutIndex;
      this.logoutCallback = state.logoutCallback;
    };
    handleLogoutKeyComponent(event, state, {
      onClose: () => {},
      onRender: () => { syncState(); this.render(); },
      onSelect: () => {},
    });
    syncState();
  }
  
  /**
   * Handle login keys
   */
  private handleLoginKey(event: KeyEvent): void {
    handleLoginKey(event, {
      step: this.loginStep,
      providerIndex: this.loginProviderIndex,
      providers: this.loginProviders,
      apiKey: this.loginApiKey,
      setStep: (v) => { this.loginStep = v; },
      setProviderIndex: (v) => { this.loginProviderIndex = v; },
      setApiKey: (v) => { this.loginApiKey = v; },
      setError: (msg) => { this.loginError = msg; },
      close: (result) => {
        const callback = this.loginCallback;
        this.loginOpen = false;
        this.loginCallback = null;
        if (callback) callback(result);
      },
      render: () => this.render(),
    });
  }
  
  /**
   * Handle inline menu keys
   */
  private handleMenuKey(event: KeyEvent): void {
    handleMenuKey(event, {
      index: this.menuIndex,
      items: this.menuItems,
      setIndex: (v) => { this.menuIndex = v; },
      close: (_cb, selected) => {
        const callback = this.menuCallback;
        this.menuOpen = false;
        this.menuCallback = null;
        if (selected && callback) callback(selected);
      },
      render: () => this.render(),
    });
  }
  
  /**
   * Handle permission dialog keys
   */
  private handleInlinePermissionKey(event: KeyEvent): void {
    handleInlinePermissionKey(event, {
      index: this.permissionIndex,
      setIndex: (v) => { this.permissionIndex = v; },
      close: (level) => {
        const callback = this.permissionCallback;
        this.permissionOpen = false;
        this.permissionCallback = null;
        if (callback) callback(level);
      },
      render: () => this.render(),
    });
  }
  
  private handleInlineSessionPickerKey(event: KeyEvent): void {
    handleInlineSessionPickerKey(event, {
      index: this.sessionPickerIndex,
      items: this.sessionPickerItems,
      deleteMode: this.sessionPickerDeleteMode,
      hasDeleteCallback: !!this.sessionPickerDeleteCallback,
      setIndex: (v) => { this.sessionPickerIndex = v; },
      setItems: (items) => { this.sessionPickerItems = items; },
      setDeleteMode: (v) => { this.sessionPickerDeleteMode = v; },
      close: (sessionName) => {
        const callback = this.sessionPickerCallback;
        this.sessionPickerOpen = false;
        this.sessionPickerCallback = null;
        this.sessionPickerDeleteMode = false;
        if (callback) callback(sessionName);
      },
      onDelete: (name) => {
        if (this.sessionPickerDeleteCallback) this.sessionPickerDeleteCallback(name);
      },
      notify: (msg) => this.notify(msg),
      render: () => this.render(),
    });
  }
  
  private handleInlineConfirmKey(event: KeyEvent): void {
    if (!this.confirmOptions) {
      this.confirmOpen = false;
      this.render();
      return;
    }
    handleInlineConfirmKey(event, {
      options: this.confirmOptions,
      selection: this.confirmSelection,
      setSelection: (v) => { this.confirmSelection = v; },
      close: (confirmed) => {
        const options = this.confirmOptions!;
        this.confirmOptions = null;
        this.confirmOpen = false;
        if (confirmed) options.onConfirm();
        else if (options.onCancel) options.onCancel();
      },
      render: () => this.render(),
    });
  }
  
  /**
   * Submit the current input buffer (used by Enter and Escape-in-multiline)
   */
  private submitInput(): void {
    const value = this.editor.getValue().trim();
    if (!value) return;
    this.editor.addToHistory(value);
    this.editor.clear();
    this.showAutocomplete = false;
    if (value.startsWith('/')) {
      this.handleCommand(value);
    } else {
      this.addMessage({ role: 'user', content: value });
      this.setLoading(true);
      this.options.onSubmit(value).catch(err => {
        this.notify(`Error: ${err.message}`);
        this.setLoading(false);
      });
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
        this.helpOpen = true;
        this.helpScrollIndex = 0;
        this.render();
        break;
        
      case 'status':
        this.statusOpen = true;
        this.render();
        break;
        
      case 'clear':
        this.clearMessages();
        this.notify('Chat cleared');
        break;

      case 'multiline':
        this.isMultilineMode = !this.isMultilineMode;
        this.notify(this.isMultilineMode
          ? 'Multi-line mode ON — Enter adds line, Esc sends'
          : 'Multi-line mode OFF — Enter sends');
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
    // Intro animation takes over the whole screen
    if (this.showIntro) {
      this.renderIntro();
      return;
    }
    
    this.renderChat();
  }
  
  /**
   * Render chat screen
   */
  private renderChat(): void {
    const { width, height } = this.screen.getSize();
    
    this.screen.clear();
    
    // If menu or settings is open, reserve space for it at bottom
    let bottomPanelHeight = 0;
    if (this.pasteInfoOpen && this.pasteInfo) {
      const previewLines = Math.min(this.pasteInfo.preview.split('\n').length, 5);
      bottomPanelHeight = previewLines + 6; // title + preview + extra line indicator + options
    } else if (this.isAgentRunning) {
      bottomPanelHeight = 5; // Agent progress box (4 lines + 1 margin)
    } else if (this.permissionOpen) {
      bottomPanelHeight = 10; // Permission dialog
    } else if (this.sessionPickerOpen) {
      bottomPanelHeight = Math.min(this.sessionPickerItems.length + 6, 14); // Session picker
    } else if (this.confirmOpen && this.confirmOptions) {
      bottomPanelHeight = this.confirmOptions.message.length + 5; // title + messages + buttons + padding
    } else if (this.statusOpen) {
      bottomPanelHeight = 16; // Status info panel
    } else if (this.helpOpen) {
      bottomPanelHeight = Math.min(height - 6, 20); // Help takes more space
    } else if (this.searchOpen) {
      bottomPanelHeight = Math.min(this.searchResults.length * 3 + 6, 18); // Search results
    } else if (this.exportOpen) {
      bottomPanelHeight = 10; // Export dialog
    } else if (this.logoutOpen) {
      bottomPanelHeight = Math.min(this.logoutProviders.length + 6, 12); // Logout picker
    } else if (this.loginOpen) {
      bottomPanelHeight = this.loginStep === 'provider' 
        ? Math.min(this.loginProviders.length + 5, 14) 
        : 8; // Login dialog
    } else if (this.menuOpen) {
      bottomPanelHeight = Math.min(this.menuItems.length + 4, 14);
    } else if (this.settingsOpen) {
      bottomPanelHeight = Math.min(SETTINGS.length + 4, 16);
    } else if (this.showAutocomplete && this.autocompleteItems.length > 0) {
      bottomPanelHeight = Math.min(this.autocompleteItems.length + 3, 12);
    }
    const mainHeight = height - bottomPanelHeight;
    
    // Layout - main UI takes top portion
    const messagesStart = 0;
    const messagesEnd = mainHeight - 4;
    const separatorLine = mainHeight - 3;
    const inputLine = mainHeight - 2;
    const statusLine = mainHeight - 1;

    // Messages
    const messagesHeight = messagesEnd - messagesStart + 1;
    const messagesToRender = this.getVisibleMessages(messagesHeight, width - 2);
    
    let y = messagesStart;
    for (const line of messagesToRender) {
      if (y > messagesEnd) break;
      if (line.raw) {
        // Line contains pre-formatted ANSI codes (e.g., syntax highlighted code)
        this.screen.writeRaw(y, line.text, line.style);
      } else {
        this.screen.writeLine(y, line.text, line.style);
      }
      y++;
    }
    
    // Separator
    this.screen.horizontalLine(separatorLine, '─', fg.gray);
    
    // Input (don't render cursor when menu/settings is open)
    this.renderInput(inputLine, width, this.menuOpen || this.settingsOpen);
    
    
    
    // Status bar
    this.renderStatusBar(statusLine, width);
    
    // Inline menu renders BELOW status bar
    if (this.menuOpen && this.menuItems.length > 0) {
      this.renderInlineMenu(statusLine + 1, width);
    }
    
    // Inline settings renders BELOW status bar
    if (this.settingsOpen) {
      this.renderInlineSettings(statusLine + 1, width, height - statusLine - 1);
    }
    
    // Inline help renders BELOW status bar
    if (this.helpOpen) {
      this.renderInlineHelp(statusLine + 1, width, height - statusLine - 1);
    }

    // Inline status renders BELOW status bar
    if (this.statusOpen) {
      this.renderInlineStatus(statusLine + 1, width);
    }
    
    // Inline search renders BELOW status bar
    if (this.searchOpen) {
      this.renderInlineSearch(statusLine + 1, width, height - statusLine - 1);
    }
    
    // Inline export renders BELOW status bar
    if (this.exportOpen) {
      this.renderInlineExport(statusLine + 1, width);
    }
    
    // Inline logout renders BELOW status bar
    if (this.logoutOpen) {
      this.renderInlineLogout(statusLine + 1, width);
    }
    
    // Inline login renders BELOW status bar
    if (this.loginOpen) {
      this.renderInlineLogin(statusLine + 1, width);
    }
    
    // Inline confirm renders BELOW status bar
    if (this.confirmOpen && this.confirmOptions) {
      this.renderInlineConfirm(statusLine + 1, width);
    }
    
    // Inline autocomplete renders BELOW status bar
    if (this.showAutocomplete && this.autocompleteItems.length > 0 && !this.menuOpen && !this.settingsOpen && !this.helpOpen && !this.confirmOpen && !this.permissionOpen && !this.sessionPickerOpen) {
      this.renderInlineAutocomplete(statusLine + 1, width);
    }
    
    // Inline permission renders BELOW status bar
    if (this.permissionOpen) {
      this.renderInlinePermission(statusLine + 1, width);
    }
    
    // Inline session picker renders BELOW status bar
    if (this.sessionPickerOpen) {
      this.renderInlineSessionPicker(statusLine + 1, width);
    }
    
    // Inline agent progress renders BELOW status bar
    if (this.isAgentRunning) {
      this.renderInlineAgentProgress(statusLine + 1, width);
    }
    
    // Inline paste info renders BELOW status bar
    if (this.pasteInfoOpen && this.pasteInfo) {
      this.renderInlinePasteInfo(statusLine + 1, width);
    }
    
    this.screen.render();
  }
  
  /**
   * Render inline confirmation dialog below status bar
   */
  private renderInlineConfirm(startY: number, width: number): void {
    if (!this.confirmOptions) return;
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title
    this.screen.writeLine(y++, this.confirmOptions.title, PRIMARY_COLOR + style.bold);
    
    // Message lines
    for (const line of this.confirmOptions.message) {
      this.screen.writeLine(y++, line, fg.white);
    }
    
    // Buttons
    y++;
    const yesLabel = this.confirmOptions.confirmLabel || 'Yes';
    const noLabel = this.confirmOptions.cancelLabel || 'No';
    
    const yesStyle = this.confirmSelection === 'yes' ? PRIMARY_COLOR + style.bold : fg.gray;
    const noStyle = this.confirmSelection === 'no' ? PRIMARY_COLOR + style.bold : fg.gray;
    
    const yesButton = this.confirmSelection === 'yes' ? `► ${yesLabel}` : `  ${yesLabel}`;
    const noButton = this.confirmSelection === 'no' ? `► ${noLabel}` : `  ${noLabel}`;
    
    this.screen.write(2, y, yesButton, yesStyle);
    this.screen.write(2 + yesButton.length + 4, y, noButton, noStyle);
    y++;
    
    // Footer
    this.screen.writeLine(y, '←/→ select • y/n quick • Enter confirm • Esc cancel', fg.gray);
  }
  
  /**
   * Render input line
   */
  private renderInput(y: number, width: number, hideCursor = false): void {
    const inputValue = this.editor.getValue();
    const cursorPos = this.editor.getCursorPos();
    
    // Session picker open - show different prompt
    if (this.sessionPickerOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Select a session below or press N for new...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Permission dialog open
    if (this.permissionOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Select access level below...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Paste info open
    if (this.pasteInfoOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Confirm paste action below...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Menu open (provider, model, lang, etc.)
    if (this.menuOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Select an option below...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Search open
    if (this.searchOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Navigate search results below...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Export open
    if (this.exportOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Select export format below...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Logout open
    if (this.logoutOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      this.screen.write(2, y, 'Select provider to logout...', fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Login open
    if (this.loginOpen) {
      this.screen.write(0, y, '> ', fg.gray);
      const msg = this.loginStep === 'provider' 
        ? 'Select a provider below...' 
        : 'Enter your API key below...';
      this.screen.write(2, y, msg, fg.yellow);
      this.screen.showCursor(false);
      return;
    }
    
    // Agent running state - show special prompt
    if (this.isAgentRunning) {
      const spinner = SPINNER_FRAMES[this.spinnerFrame];
      const stepLabel = this.agentMaxIterations > 0
        ? `step ${this.agentIteration}/${this.agentMaxIterations}`
        : `step ${this.agentIteration}`;
      const agentText = `${spinner} Agent working... ${stepLabel} | ${this.agentActions.length} actions (Esc to stop)`;
      this.screen.writeLine(y, agentText, PRIMARY_COLOR);
      this.screen.showCursor(false);
      return;
    }
    
    // Loading/streaming state with animated spinner
    if (this.isLoading || this.isStreaming) {
      const spinner = SPINNER_FRAMES[this.spinnerFrame];
      const message = this.isStreaming ? 'Writing' : 'Thinking';
      this.screen.writeLine(y, `${spinner} ${message}...`, PRIMARY_COLOR);
      this.screen.showCursor(false);
      return;
    }
    
    // Build prompt prefix — show line count for multi-line buffers
    const lines = inputValue.split('\n');
    const lineCount = lines.length;
    const prompt = lineCount > 1 ? `[${lineCount}] > ` : this.isMultilineMode ? 'M> ' : '> ';
    const maxInputWidth = width - prompt.length - 1;
    
    // Show placeholder when input is empty
    if (!inputValue) {
      this.screen.write(0, y, prompt, fg.green);
      const placeholder = this.isMultilineMode
        ? 'Multi-line mode (Enter=newline, Esc=send)...'
        : 'Type a message or /command...';
      this.screen.write(prompt.length, y, placeholder, fg.gray);
      
      if (!hideCursor) {
        this.screen.setCursor(prompt.length, y);
        this.screen.showCursor(true);
      } else {
        this.screen.showCursor(false);
      }
      return;
    }
    
    // For multi-line content, show the last line being edited
    const lastLine = lines[lines.length - 1];
    const displayInput = lineCount > 1 ? lastLine : inputValue;
    // Cursor position within the last line
    const charsBeforeLastLine = lineCount > 1 ? inputValue.lastIndexOf('\n') + 1 : 0;
    const cursorInLine = cursorPos - charsBeforeLastLine;
    
    let displayValue: string;
    let cursorX: number;
    
    if (displayInput.length <= maxInputWidth) {
      displayValue = displayInput;
      cursorX = prompt.length + Math.max(0, cursorInLine);
    } else {
      const effectiveCursor = Math.max(0, cursorInLine);
      const visibleStart = Math.max(0, effectiveCursor - Math.floor(maxInputWidth * 0.7));
      const visibleEnd = visibleStart + maxInputWidth;
      
      if (visibleStart > 0) {
        displayValue = '…' + displayInput.slice(visibleStart + 1, visibleEnd);
      } else {
        displayValue = displayInput.slice(0, maxInputWidth);
      }
      
      cursorX = prompt.length + (effectiveCursor - visibleStart);
    }
    
    this.screen.writeLine(y, prompt + displayValue, fg.green);
    
    // Hide cursor when menu/settings is open
    if (hideCursor) {
      this.screen.showCursor(false);
    } else {
      this.screen.setCursor(Math.min(cursorX, width - 1), y);
      this.screen.showCursor(true);
    }
  }
  
  /**
   * Render inline menu below status bar
   */
  private renderInlineMenu(startY: number, width: number): void {
    const items = this.menuItems;
    const maxVisible = Math.min(items.length, 10);
    
    // Calculate visible range with scroll
    let visibleStart = 0;
    if (items.length > maxVisible) {
      visibleStart = Math.max(0, Math.min(this.menuIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
    }
    const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title
    this.screen.writeLine(y++, this.menuTitle, PRIMARY_COLOR + style.bold);
    
    // Items
    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      const actualIndex = visibleStart + i;
      const isSelected = actualIndex === this.menuIndex;
      const isCurrent = item.key === this.menuCurrentValue;
      
      const prefix = isSelected ? '► ' : '  ';
      const suffix = isCurrent ? ' ✓' : '';
      
      let itemStyle = fg.white;
      if (isSelected) {
        itemStyle = PRIMARY_COLOR + style.bold;
      } else if (isCurrent) {
        itemStyle = fg.green;
      }
      
      this.screen.writeLine(y++, prefix + item.label + suffix, itemStyle);
    }
    
    // Footer with navigation hints
    const scrollInfo = items.length > maxVisible ? ` (${visibleStart + 1}-${visibleStart + visibleItems.length}/${items.length})` : '';
    this.screen.writeLine(y, `↑↓ navigate • Enter select • Esc cancel${scrollInfo}`, fg.gray);
  }
  
  /**
   * Render inline settings below status bar
   */
  private renderInlineSettings(startY: number, width: number, availableHeight: number): void {
    const maxVisible = Math.min(SETTINGS.length, availableHeight - 3);
    const scrollOffset = Math.max(0, this.settingsState.selectedIndex - maxVisible + 3);
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title
    this.screen.writeLine(y++, 'Settings', PRIMARY_COLOR + style.bold);
    
    // Settings items
    for (let i = 0; i < maxVisible && (i + scrollOffset) < SETTINGS.length; i++) {
      const settingIdx = i + scrollOffset;
      const setting = SETTINGS[settingIdx];
      const isSelected = settingIdx === this.settingsState.selectedIndex;
      
      const prefix = isSelected ? '► ' : '  ';
      
      // Format value
      let valueStr: string;
      if (this.settingsState.editing && isSelected) {
        valueStr = this.settingsState.editValue + '█';
      } else {
        const value = setting.getValue();
        if (setting.type === 'select' && setting.options) {
          const option = setting.options.find(o => o.value === value);
          valueStr = option ? option.label : String(value);
        } else {
          valueStr = String(value);
        }
      }
      
      const labelStyle = isSelected ? PRIMARY_COLOR + style.bold : fg.white;
      const valueStyle = this.settingsState.editing && isSelected ? fg.cyan : fg.green;
      
      this.screen.write(2, y, prefix, isSelected ? PRIMARY_COLOR : '');
      this.screen.write(4, y, setting.label + ': ', labelStyle);
      this.screen.write(4 + setting.label.length + 2, y, valueStr, valueStyle);
      
      // Hint for selected item
      if (isSelected && !this.settingsState.editing) {
        const hintX = 4 + setting.label.length + 2 + valueStr.length + 2;
        const hint = setting.type === 'number' ? '(←/→ adjust)' : '(←/→ toggle)';
        this.screen.write(hintX, y, hint, fg.gray);
      }
      
      y++;
    }
    
    // Footer
    const scrollInfo = SETTINGS.length > maxVisible ? ` (${scrollOffset + 1}-${scrollOffset + maxVisible}/${SETTINGS.length})` : '';
    this.screen.writeLine(y, `↑↓ navigate • ←/→ adjust • Esc close${scrollInfo}`, fg.gray);
  }
  
  /**
   * Render inline help below status bar
   */
  private renderInlineStatus(startY: number, width: number): void {
    const status = this.options.getStatus();
    let y = startY;

    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);

    // Title
    this.screen.writeLine(y++, 'Status', PRIMARY_COLOR + style.bold);

    const items = [
      { label: 'Version', value: 'v' + status.version, color: fg.white },
      { label: 'Provider', value: status.provider, color: fg.white },
      { label: 'Model', value: status.model, color: fg.white },
      { label: 'Agent Mode', value: status.agentMode.toUpperCase(), color: status.agentMode === 'on' ? fg.green : status.agentMode === 'manual' ? fg.yellow : fg.gray },
      { label: 'Project', value: status.projectPath, color: fg.white },
      { label: 'Write Access', value: status.hasWriteAccess ? 'Yes' : 'No', color: status.hasWriteAccess ? fg.green : fg.red },
      { label: 'Session', value: status.sessionId || 'New', color: fg.white },
      { label: 'Messages', value: status.messageCount.toString(), color: fg.white },
      { label: 'Platform', value: process.platform, color: fg.white },
      { label: 'Node', value: process.version, color: fg.white },
      { label: 'Terminal', value: width + 'x' + this.screen.getSize().height, color: fg.white },
    ];

    const labelWidth = Math.max(...items.map(i => i.label.length)) + 2;
    for (const item of items) {
      this.screen.write(2, y, item.label + ':', fg.gray);
      this.screen.write(2 + labelWidth, y, item.value, item.color);
      y++;
    }

    y++;
    this.screen.writeLine(y, 'Esc close', fg.gray);
  }

  private renderInlineHelp(startY: number, width: number, availableHeight: number): void {
    // Build all help items
    const allItems: Array<{ text: string; isHeader: boolean }> = [];
    
    for (const category of helpCategories) {
      allItems.push({ text: category.title, isHeader: true });
      for (const item of category.items) {
        allItems.push({ text: `  ${item.key.padEnd(22)} ${item.description}`, isHeader: false });
      }
    }
    
    // Add keyboard shortcuts
    allItems.push({ text: 'Keyboard Shortcuts', isHeader: true });
    for (const shortcut of keyboardShortcuts) {
      allItems.push({ text: `  ${shortcut.key.padEnd(22)} ${shortcut.description}`, isHeader: false });
    }
    
    const maxVisible = availableHeight - 3;
    const visibleItems = allItems.slice(this.helpScrollIndex, this.helpScrollIndex + maxVisible);
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title
    this.screen.writeLine(y++, 'Help - Commands & Shortcuts', PRIMARY_COLOR + style.bold);
    
    // Help items
    for (const item of visibleItems) {
      if (item.isHeader) {
        this.screen.writeLine(y, item.text, fg.yellow + style.bold);
      } else {
        // Highlight command part
        const match = item.text.match(/^(\s*)(\S+)(\s+)(.*)$/);
        if (match) {
          const [, indent, cmd, space, desc] = match;
          this.screen.write(0, y, indent, '');
          this.screen.write(indent.length, y, cmd, fg.green);
          this.screen.write(indent.length + cmd.length, y, space + desc, fg.white);
        } else {
          this.screen.writeLine(y, item.text, fg.white);
        }
      }
      y++;
    }
    
    // Footer
    const scrollInfo = allItems.length > maxVisible ? ` (${this.helpScrollIndex + 1}-${Math.min(this.helpScrollIndex + maxVisible, allItems.length)}/${allItems.length})` : '';
    this.screen.writeLine(y, `↑↓ scroll • PgUp/PgDn fast scroll • Esc close${scrollInfo}`, fg.gray);
  }
  
  /**
   * Render inline autocomplete below status bar
   */
  private renderInlineAutocomplete(startY: number, width: number): void {
    const items = this.autocompleteItems;
    const maxVisible = Math.min(items.length, 8);
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title
    this.screen.writeLine(y++, 'Commands', PRIMARY_COLOR + style.bold);
    
    // Items with descriptions
    const visibleStart = Math.max(0, this.autocompleteIndex - maxVisible + 1);
    const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);
    
    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      const actualIndex = visibleStart + i;
      const isSelected = actualIndex === this.autocompleteIndex;
      const desc = COMMAND_DESCRIPTIONS[item] || '';
      
      const prefix = isSelected ? '► ' : '  ';
      const cmdText = ('/' + item).padEnd(18);
      
      if (isSelected) {
        this.screen.write(0, y, prefix, PRIMARY_COLOR);
        this.screen.write(prefix.length, y, cmdText, PRIMARY_COLOR + style.bold);
        this.screen.write(prefix.length + cmdText.length, y, desc, fg.white);
      } else {
        this.screen.write(0, y, prefix, '');
        this.screen.write(prefix.length, y, cmdText, fg.green);
        this.screen.write(prefix.length + cmdText.length, y, desc, fg.gray);
      }
      y++;
    }
    
    // Footer
    const scrollInfo = items.length > maxVisible ? ` (${visibleStart + 1}-${visibleStart + visibleItems.length}/${items.length})` : '';
    this.screen.writeLine(y, `↑↓ navigate • Tab/Enter select • Esc cancel${scrollInfo}`, fg.gray);
  }
  
  /**
   * Render inline permission dialog
   */
  private renderInlinePermission(startY: number, width: number): void {
    const options = [
      { level: 'read', label: 'Read Only', desc: 'AI can read files, no modifications' },
      { level: 'write', label: 'Read & Write', desc: 'AI can read and modify files (Agent mode)' },
      { level: 'none', label: 'No Access', desc: 'Chat without project context' },
    ];
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title
    this.screen.writeLine(y++, 'Folder Access', PRIMARY_COLOR + style.bold);
    
    // Project path
    const displayPath = this.permissionPath.length > width - 12 
      ? '...' + this.permissionPath.slice(-(width - 15))
      : this.permissionPath;
    this.screen.writeLine(y++, `Project: ${displayPath}`, fg.cyan);
    
    // Description
    const desc = this.permissionIsProject ? 'This looks like a project folder.' : 'Grant access to enable AI assistance.';
    this.screen.writeLine(y++, desc, fg.white);
    y++;
    
    // Options
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSelected = i === this.permissionIndex;
      const prefix = isSelected ? '► ' : '  ';
      
      const labelStyle = isSelected ? PRIMARY_COLOR + style.bold : fg.white;
      this.screen.write(2, y, prefix + opt.label.padEnd(16), labelStyle);
      this.screen.write(22, y, opt.desc, fg.gray);
      y++;
    }
    
    // Footer
    this.screen.writeLine(y, '↑↓ navigate • Enter select • Esc skip', fg.gray);
  }
  
  /**
   * Render inline session picker
   */
  private renderInlineSessionPicker(startY: number, width: number): void {
    const sessions = this.sessionPickerItems;
    const maxVisible = Math.min(sessions.length, 8);
    const deleteMode = this.sessionPickerDeleteMode;
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', deleteMode ? fg.red : PRIMARY_COLOR);
    
    // Title
    if (deleteMode) {
      this.screen.writeLine(y++, 'Delete Session (Enter to confirm, Esc to cancel)', fg.red + style.bold);
    } else {
      this.screen.writeLine(y++, 'Select Session', PRIMARY_COLOR + style.bold);
    }
    
    if (sessions.length === 0) {
      this.screen.writeLine(y++, 'No previous sessions found.', fg.gray);
      this.screen.writeLine(y, 'Press N or Enter to start a new session.', fg.white);
    } else {
      // Sessions list
      const visibleStart = Math.max(0, this.sessionPickerIndex - maxVisible + 1);
      const visibleSessions = sessions.slice(visibleStart, visibleStart + maxVisible);
      
      for (let i = 0; i < visibleSessions.length; i++) {
        const session = visibleSessions[i];
        const actualIndex = visibleStart + i;
        const isSelected = actualIndex === this.sessionPickerIndex;
        const prefix = isSelected ? (deleteMode ? '✗ ' : '► ') : '  ';
        
        // Format relative time
        const date = new Date(session.createdAt);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
        const timeStr = diffDays === 0 ? 'today' : diffDays === 1 ? 'yesterday' : `${diffDays}d ago`;
        
        const name = session.name.length > 25 ? session.name.slice(0, 22) + '...' : session.name;
        const meta = `${session.messageCount} msg, ${timeStr}`;
        
        let nameStyle = fg.white;
        if (isSelected && deleteMode) {
          nameStyle = fg.red + style.bold;
        } else if (isSelected) {
          nameStyle = PRIMARY_COLOR + style.bold;
        }
        
        this.screen.write(2, y, prefix + name, nameStyle);
        this.screen.write(32, y, meta, fg.cyan);
        y++;
      }
      
      // Scroll info
      if (sessions.length > maxVisible) {
        this.screen.write(2, y++, `(${visibleStart + 1}-${visibleStart + visibleSessions.length}/${sessions.length})`, fg.gray);
      }
    }
    
    y++;
    // Options
    if (deleteMode) {
      this.screen.writeLine(y++, '[Enter] Delete selected • [Esc] Cancel', fg.red);
    } else {
      this.screen.write(0, y, '[N] ', fg.yellow);
      this.screen.write(4, y, 'New session', fg.white);
      if (this.sessionPickerDeleteCallback && sessions.length > 0) {
        this.screen.write(18, y, ' [D] ', fg.red);
        this.screen.write(23, y, 'Delete mode', fg.white);
      }
      y++;
      
      // Footer
      this.screen.writeLine(y, '↑↓ navigate • Enter select', fg.gray);
    }
  }
  
  /**
   * Render inline paste info below status bar
   */
  private renderInlinePasteInfo(startY: number, width: number): void {
    if (!this.pasteInfo) return;
    
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);
    
    // Title with stats
    this.screen.write(0, y, 'Paste Detected ', PRIMARY_COLOR + style.bold);
    this.screen.write(15, y, `(${this.pasteInfo.chars} chars, ${this.pasteInfo.lines} lines)`, fg.cyan);
    y++;
    
    // Preview box
    y++;
    const previewLines = this.pasteInfo.preview.split('\n').slice(0, 5);
    for (const line of previewLines) {
      const displayLine = line.length > width - 4 ? line.slice(0, width - 7) + '...' : line;
      this.screen.writeLine(y++, '  ' + displayLine, fg.gray);
    }
    if (this.pasteInfo.lines > 5) {
      this.screen.writeLine(y++, `  ... (${this.pasteInfo.lines - 5} more lines)`, fg.gray);
    }
    
    y++;
    // Options
    this.screen.write(0, y, '[Y/Enter] ', fg.green);
    this.screen.write(10, y, 'Add to input', fg.white);
    this.screen.write(25, y, '[S] ', fg.yellow);
    this.screen.write(29, y, 'Send directly', fg.white);
    this.screen.write(45, y, '[N/Esc] ', fg.red);
    this.screen.write(53, y, 'Cancel', fg.white);
  }
  
  /**
   * Render inline agent progress below status bar (LiveCodeStream style)
   */
  private renderInlineAgentProgress(startY: number, width: number): void {
    let y = startY;
    const spinner = SPINNER_FRAMES[this.spinnerFrame];
    
    // Calculate stats in a single pass
    const stats = this.agentActions.reduce(
      (acc, a) => {
        if (a.type === 'read') acc.reads++;
        else if (a.type === 'write') acc.writes++;
        else if (a.type === 'edit') acc.edits++;
        else if (a.type === 'delete') acc.deletes++;
        else if (a.type === 'command') acc.commands++;
        else if (a.type === 'search') acc.searches++;
        if (a.result === 'error') acc.errors++;
        return acc;
      },
      { reads: 0, writes: 0, edits: 0, deletes: 0, commands: 0, searches: 0, errors: 0 },
    );
    
    // Top border with title
    const title = ` ${spinner} AGENT `;
    const titlePadLeft = 2;
    const titlePadRight = width - titlePadLeft - title.length - 1;
    this.screen.write(0, y, '─'.repeat(titlePadLeft), PRIMARY_COLOR);
    this.screen.write(titlePadLeft, y, title, PRIMARY_COLOR + style.bold);
    this.screen.write(titlePadLeft + title.length, y, '─'.repeat(Math.max(0, titlePadRight)), PRIMARY_COLOR);
    y++;
    
    // Current action line (clear first to avoid stale text from longer previous paths)
    this.screen.writeLine(y, '');
    if (this.agentActions.length > 0) {
      const lastAction = this.agentActions[this.agentActions.length - 1];
      const actionLabel = this.getActionLabel(lastAction.type);
      const actionColor = this.getActionColor(lastAction.type);
      const maxTargetLen = width - actionLabel.length - 4;
      const target = this.formatActionTarget(lastAction.target, maxTargetLen);
      this.screen.write(1, y, actionLabel, actionColor + style.bold);
      this.screen.write(1 + actionLabel.length + 1, y, target, fg.white);
    } else {
      this.screen.write(1, y, 'Starting...', fg.gray);
    }
    y++;
    
    // Stats line: Files and step info (clear line first to avoid stale text)
    this.screen.writeLine(y, '');
    let x = 1;

    // File changes
    if (stats.writes > 0) {
      const txt = `+${stats.writes}`;
      this.screen.write(x, y, txt, fg.green);
      x += txt.length + 1;
    }
    if (stats.edits > 0) {
      const txt = `~${stats.edits}`;
      this.screen.write(x, y, txt, fg.yellow);
      x += txt.length + 1;
    }
    if (stats.deletes > 0) {
      const txt = `-${stats.deletes}`;
      this.screen.write(x, y, txt, fg.red);
      x += txt.length + 1;
    }
    if (stats.reads > 0) {
      const txt = `${stats.reads}R`;
      this.screen.write(x, y, txt, fg.blue);
      x += txt.length + 1;
    }
    if (stats.commands > 0) {
      const txt = `${stats.commands}C`;
      this.screen.write(x, y, txt, fg.magenta);
      x += txt.length + 1;
    }
    if (stats.searches > 0) {
      const txt = `${stats.searches}S`;
      this.screen.write(x, y, txt, fg.cyan);
      x += txt.length + 1;
    }
    
    // Step info on the right
    const stepText = this.agentMaxIterations > 0
      ? `step ${this.agentIteration}/${this.agentMaxIterations}`
      : `step ${this.agentIteration}`;
    this.screen.write(width - stepText.length - 1, y, stepText, fg.gray);
    y++;
    
    // Bottom border with help
    const helpText = ' Esc to stop ';
    const helpPadLeft = Math.floor((width - helpText.length) / 2);
    const helpPadRight = Math.ceil((width - helpText.length) / 2);
    this.screen.write(0, y, '─'.repeat(helpPadLeft), fg.gray);
    this.screen.write(helpPadLeft, y, helpText, fg.gray);
    this.screen.write(helpPadLeft + helpText.length, y, '─'.repeat(helpPadRight), fg.gray);
  }
  
  /**
   * Get color for action type
   */
  private getActionColor(type: string): string {
    const colors: Record<string, string> = {
      'read': fg.blue,
      'write': fg.green,
      'edit': fg.yellow,
      'delete': fg.red,
      'command': fg.magenta,
      'search': fg.cyan,
      'list': fg.white,
      'mkdir': fg.blue,
      'fetch': fg.cyan,
    };
    return colors[type] || fg.white;
  }
  
  /**
   * Format action target for display
   */
  private formatActionTarget(target: string, maxLen: number): string {
    if (target.includes('/')) {
      const parts = target.split('/');
      const filename = parts[parts.length - 1];
      if (parts.length > 2) {
        const short = `.../${parts[parts.length - 2]}/${filename}`;
        return short.length > maxLen ? '...' + short.slice(-(maxLen - 3)) : short;
      }
    }
    return target.length > maxLen ? '...' + target.slice(-(maxLen - 3)) : target;
  }
  
  /**
   * Get action label for display
   */
  private getActionLabel(type: string): string {
    const labels: Record<string, string> = {
      'read': 'Reading',
      'write': 'Creating',
      'edit': 'Editing',
      'delete': 'Deleting',
      'command': 'Running',
      'search': 'Searching',
      'list': 'Listing',
      'mkdir': 'Creating dir',
      'fetch': 'Fetching',
    };
    return labels[type] || type;
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
      const stats = this.options.getStatus().tokenStats;
      const tokenInfo = stats && stats.totalTokens > 0
        ? ` | ${stats.totalTokens < 1000 ? stats.totalTokens : (stats.totalTokens / 1000).toFixed(1) + 'K'} tokens`
        : '';
      leftText = ` ${this.messages.length} messages${tokenInfo}`;
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
  private getVisibleMessages(height: number, width: number): Array<{ text: string; style: string; raw?: boolean }> {
    const allLines: Array<{ text: string; style: string; raw?: boolean }> = [];
    this.codeBlockCounter = 0; // Reset block counter for each render pass

    // Logo at the top, scrolls with content
    if (height >= 20) {
      const logoWidth = LOGO_LINES[0].length;
      const logoX = Math.max(0, Math.floor((width - logoWidth) / 2));
      const pad = ' '.repeat(logoX);
      for (const line of LOGO_LINES) {
        allLines.push({ text: pad + line, style: PRIMARY_COLOR, raw: false });
      }
      allLines.push({ text: '', style: '' });
    } else {
      allLines.push({ text: ' Codeep', style: PRIMARY_COLOR, raw: false });
      allLines.push({ text: '', style: '' });
    }

    for (const msg of this.messages) {
      const msgLines = this.formatMessage(msg.role, msg.content, width);
      allLines.push(...msgLines);
    }

    if (this.isStreaming && this.streamingContent) {
      const streamLines = this.formatMessage('assistant', this.streamingContent + '▊', width);
      allLines.push(...streamLines);
    }

    // Calculate visible window based on scroll offset
    const totalLines = allLines.length;

    const maxScroll = Math.max(0, totalLines - height);
    if (this.scrollOffset > maxScroll) {
      this.scrollOffset = maxScroll;
    }

    const endIndex = totalLines - this.scrollOffset;
    const startIndex = Math.max(0, endIndex - height);

    return allLines.slice(startIndex, endIndex);
  }
  
  /**
   * Format message into lines with syntax highlighting for code blocks
   */
  private formatMessage(role: 'user' | 'assistant' | 'system', content: string, maxWidth: number): Array<{ text: string; style: string; raw?: boolean }> {
    const lines: Array<{ text: string; style: string; raw?: boolean }> = [];
    
    const roleStyle = role === 'user' ? fg.green : role === 'assistant' ? PRIMARY_COLOR : fg.yellow;
    const roleLabel = role === 'user' ? '> ' : role === 'assistant' ? '  ' : '# ';
    
    // Parse content for code blocks
    const codeBlockRegex = /```([^\n]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    let isFirstLine = true;
    
    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      const textBefore = content.slice(lastIndex, match.index);
      if (textBefore) {
        const textLines = this.formatTextLines(textBefore, maxWidth, isFirstLine ? roleLabel : '  ', isFirstLine ? roleStyle : '');
        lines.push(...textLines);
        isFirstLine = false;
      }
      
      // Add code block with syntax highlighting
      this.codeBlockCounter++;
      const rawLang = (match[1] || 'text').trim();
      // Handle filepath:name.ext format - extract extension as language
      let lang = rawLang;
      if (rawLang.includes(':') || rawLang.includes('.')) {
        const ext = rawLang.split('.').pop() || rawLang;
        lang = ext;
      }
      const code = match[2];
      const codeLines = this.formatCodeBlock(code, lang, maxWidth, this.codeBlockCounter);
      lines.push(...codeLines);
      
      lastIndex = match.index + match[0].length;
      isFirstLine = false;
    }
    
    // Add remaining text after last code block
    const textAfter = content.slice(lastIndex);
    if (textAfter) {
      const textLines = this.formatTextLines(textAfter, maxWidth, isFirstLine ? roleLabel : '  ', isFirstLine ? roleStyle : '');
      lines.push(...textLines);
    }
    
    lines.push({ text: '', style: '' });
    
    return lines;
  }
  
  /**
   * Apply inline markdown formatting (bold, italic, inline code) to a line
   */
  private applyInlineMarkdown(text: string): { formatted: string; hasFormatting: boolean } {
    let result = '';
    let hasFormatting = false;
    let i = 0;

    while (i < text.length) {
      // Inline code: `code`
      if (text[i] === '`' && text[i + 1] !== '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          const code = text.slice(i + 1, end);
          result += fg.rgb(209, 154, 102) + code + '\x1b[0m';
          hasFormatting = true;
          i = end + 1;
          continue;
        }
      }

      // Bold + italic: ***text***
      if (text.slice(i, i + 3) === '***') {
        const end = text.indexOf('***', i + 3);
        if (end !== -1) {
          const inner = text.slice(i + 3, end);
          result += style.bold + style.italic + fg.white + inner + '\x1b[0m';
          hasFormatting = true;
          i = end + 3;
          continue;
        }
      }

      // Bold: **text**
      if (text.slice(i, i + 2) === '**') {
        const end = text.indexOf('**', i + 2);
        if (end !== -1) {
          const inner = text.slice(i + 2, end);
          result += style.bold + fg.white + inner + '\x1b[0m';
          hasFormatting = true;
          i = end + 2;
          continue;
        }
      }

      // Italic: *text*
      if (text[i] === '*' && text[i + 1] !== '*') {
        const end = text.indexOf('*', i + 1);
        if (end !== -1 && end > i + 1) {
          const inner = text.slice(i + 1, end);
          result += style.italic + inner + '\x1b[0m';
          hasFormatting = true;
          i = end + 1;
          continue;
        }
      }

      result += text[i];
      i++;
    }

    return { formatted: result, hasFormatting };
  }

  /**
   * Format plain text lines with markdown support
   */
  private formatTextLines(text: string, maxWidth: number, firstPrefix: string, firstStyle: string): Array<{ text: string; style: string; raw?: boolean }> {
    const lines: Array<{ text: string; style: string; raw?: boolean }> = [];
    const contentLines = text.split('\n');
    
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i];
      const prefix = i === 0 ? firstPrefix : '  ';
      const prefixStyle = i === 0 ? firstStyle : '';

      // Heading: ## or ### etc.
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2];
        const headingColor = level <= 2 ? fg.rgb(97, 175, 239) : fg.rgb(198, 120, 221);
        lines.push({
          text: prefix + headingColor + style.bold + headingText + '\x1b[0m',
          style: prefixStyle,
          raw: true,
        });
        continue;
      }

      // Horizontal rule: --- or *** or ___
      if (/^[-*_]{3,}\s*$/.test(line)) {
        const ruleWidth = Math.min(maxWidth - 4, 40);
        lines.push({
          text: prefix + fg.gray + '─'.repeat(ruleWidth) + '\x1b[0m',
          style: prefixStyle,
          raw: true,
        });
        continue;
      }

      // List items: - item or * item or numbered 1. item
      const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
      if (listMatch) {
        const indent = listMatch[1];
        const bullet = listMatch[2];
        const content = listMatch[3];
        const { formatted, hasFormatting } = this.applyInlineMarkdown(content);
        const bulletChar = bullet === '-' || bullet === '*' ? '•' : bullet;
        if (hasFormatting) {
          lines.push({
            text: prefix + indent + fg.gray + bulletChar + '\x1b[0m' + ' ' + formatted,
            style: prefixStyle,
            raw: true,
          });
        } else {
          lines.push({
            text: prefix + indent + bulletChar + ' ' + content,
            style: prefixStyle,
          });
        }
        continue;
      }

      // Regular text with possible inline markdown
      const { formatted, hasFormatting } = this.applyInlineMarkdown(line);

      if (hasFormatting) {
        // Use original (no-ANSI) line to measure and wrap, then apply markdown per segment
        if (stringWidth(line) > maxWidth - prefix.length) {
          const wrapped = this.wordWrap(line, maxWidth - prefix.length);
          for (let j = 0; j < wrapped.length; j++) {
            const { formatted: segFormatted } = this.applyInlineMarkdown(wrapped[j]);
            lines.push({
              text: (j === 0 ? prefix : '  ') + segFormatted,
              style: j === 0 ? prefixStyle : '',
              raw: true,
            });
          }
        } else {
          lines.push({
            text: prefix + formatted,
            style: prefixStyle,
            raw: true,
          });
        }
      } else {
        // Plain text - word wrap as before
        if (stringWidth(line) > maxWidth - prefix.length) {
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
    }
    
    return lines;
  }
  
  /**
   * Format code block with syntax highlighting (no border)
   */
  private formatCodeBlock(code: string, lang: string, maxWidth: number, blockNum?: number): Array<{ text: string; style: string; raw?: boolean }> {
    const lines: Array<{ text: string; style: string; raw?: boolean }> = [];
    const codeLines = code.split('\n');
    
    // Remove trailing empty line if exists
    if (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') {
      codeLines.pop();
    }
    
    // Language label with block number for /copy
    const label = blockNum ? (lang ? `  ${lang} [${blockNum}]` : `  [${blockNum}]`) : (lang ? '  ' + lang : '');
    if (label) {
      lines.push({ text: label, style: SYNTAX.codeLang, raw: false });
    }
    
    // Code lines with highlighting and indent
    for (const codeLine of codeLines) {
      const highlighted = highlightCode(codeLine, lang);
      lines.push({ 
        text: '    ' + highlighted, 
        style: '', 
        raw: true  // Don't apply additional styling, code is pre-highlighted
      });
    }
    
    // Empty line after code block
    lines.push({ text: '', style: '', raw: false });
    
    return lines;
  }
  
  /**
   * Render inline search screen
   */
  private renderInlineSearch(startY: number, width: number, availableHeight: number): void {
    renderSearchPanel(this.screen, startY, width, availableHeight, {
      searchOpen: this.searchOpen,
      searchQuery: this.searchQuery,
      searchResults: this.searchResults,
      searchIndex: this.searchIndex,
      searchCallback: this.searchCallback,
    });
  }
  
  /**
   * Render inline export screen
   */
  private renderInlineExport(startY: number, width: number): void {
    renderExportPanel(this.screen, startY, width, {
      exportOpen: this.exportOpen,
      exportIndex: this.exportIndex,
      exportCallback: this.exportCallback,
    });
  }
  
  /**
   * Render inline logout picker
   */
  private renderInlineLogout(startY: number, width: number): void {
    renderLogoutPanel(this.screen, startY, width, {
      logoutOpen: this.logoutOpen,
      logoutIndex: this.logoutIndex,
      logoutProviders: this.logoutProviders,
      logoutCallback: this.logoutCallback,
    });
  }
  
  /**
   * Render inline login dialog
   */
  private renderInlineLogin(startY: number, width: number): void {
    let y = startY;
    
    // Separator line
    this.screen.horizontalLine(y++, '─', fg.cyan);
    
    if (this.loginStep === 'provider') {
      // Provider selection
      this.screen.writeLine(y++, 'Select Provider', fg.cyan + style.bold);
      y++;
      
      for (let i = 0; i < this.loginProviders.length; i++) {
        const provider = this.loginProviders[i];
        const isSelected = i === this.loginProviderIndex;
        const prefix = isSelected ? '→ ' : '  ';
        
        this.screen.write(0, y, prefix, isSelected ? fg.green : '');
        this.screen.write(2, y, provider.name, isSelected ? fg.green + style.bold : fg.white);
        y++;
      }
      
      y++;
      this.screen.writeLine(y, '↑↓ Navigate • Enter Select • Esc Cancel', fg.gray);
    } else {
      // API key entry
      const selectedProvider = this.loginProviders[this.loginProviderIndex];
      this.screen.writeLine(y++, `Enter API Key for ${selectedProvider.name}`, fg.cyan + style.bold);
      y++;
      
      // API key input (masked)
      const maskedKey = this.loginApiKey.length > 0 
        ? '*'.repeat(Math.min(this.loginApiKey.length, 40)) + (this.loginApiKey.length > 40 ? '...' : '')
        : '(type your API key)';
      this.screen.write(0, y, 'Key: ', fg.white);
      this.screen.write(5, y, maskedKey, this.loginApiKey.length > 0 ? fg.green : fg.gray);
      y++;
      
      // Error message
      if (this.loginError) {
        y++;
        this.screen.writeLine(y, this.loginError, fg.red);
      }
      
      y++;
      const hints = ['Ctrl+V Paste'];
      if (selectedProvider.subscribeUrl) {
        hints.push('Ctrl+B Get API key');
      }
      hints.push('Enter Submit', 'Esc Back');
      this.screen.writeLine(y, hints.join(' • '), fg.gray);
    }
  }
  
  /**
   * Render intro animation
   */
  private renderIntro(): void {
    const { width, height } = this.screen.getSize();
    
    this.screen.clear();
    
    // Get decrypted logo text
    const logoText = this.getDecryptedLogo();
    const logoLines = logoText.split('\n');
    
    // Center logo vertically
    const startY = Math.max(0, Math.floor((height - logoLines.length - 2) / 2));
    
    // Center logo horizontally
    const logoWidth = LOGO_LINES[0].length;
    const startX = Math.max(0, Math.floor((width - logoWidth) / 2));
    
    for (let i = 0; i < logoLines.length; i++) {
      this.screen.write(startX, startY + i, logoLines[i], PRIMARY_COLOR + style.bold);
    }
    
    // Tagline (only show when done)
    if (this.introPhase === 'done') {
      const tagline = 'Deep into Code.';
      const taglineX = Math.floor((width - tagline.length) / 2);
      this.screen.write(taglineX, startY + logoLines.length + 1, tagline, PRIMARY_COLOR);
    }
    
    this.screen.fullRender();
  }
  
  /**
   * Get decrypted logo for intro animation
   */
  private getDecryptedLogo(): string {
    const lines = LOGO_LINES;
    
    return lines.map((line) => {
      let resultLine = '';
      
      for (let charIndex = 0; charIndex < line.length; charIndex++) {
        const char = line[charIndex];
        let isDecrypted = false;
        
        if (this.introPhase === 'init') {
          isDecrypted = false;
        } else if (this.introPhase === 'decrypt' || this.introPhase === 'done') {
          const threshold = line.length > 0 ? charIndex / line.length : 0;
          if (this.introProgress >= threshold - 0.1) {
            isDecrypted = Math.random() > 0.2;
          }
        }
        
        if (this.introPhase === 'done') isDecrypted = true;
        
        if (char === ' ' && this.introPhase !== 'init') {
          resultLine += ' ';
        } else if (isDecrypted) {
          resultLine += char;
        } else {
          if (char === ' ' && Math.random() > 0.1) {
            resultLine += ' ';
          } else {
            resultLine += App.GLITCH_CHARS.charAt(Math.floor(Math.random() * App.GLITCH_CHARS.length));
          }
        }
      }
      return resultLine;
    }).join('\n');
  }
  
  /**
   * Word wrap
   */
  private wordWrap(text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const wordW = stringWidth(word);
      // Hard-break words wider than maxWidth (e.g. long file paths with no spaces)
      if (wordW > maxWidth) {
        if (currentLine) { lines.push(currentLine); currentLine = ''; }
        // Slice the word into maxWidth chunks
        let remaining = word;
        while (stringWidth(remaining) > maxWidth) {
          lines.push(remaining.slice(0, maxWidth));
          remaining = remaining.slice(maxWidth);
        }
        currentLine = remaining;
        continue;
      }
      if (stringWidth(currentLine) + wordW + 1 > maxWidth && currentLine) {
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
