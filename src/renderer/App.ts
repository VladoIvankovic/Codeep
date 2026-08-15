/**
 * Main Application using custom renderer
 * Replaces Ink-based App
 */

import { Screen } from './Screen';
import { Input, LineEditor, KeyEvent } from './Input';
import { fg, style } from './ansi';
import { getActionColor, formatActionTarget, getActionLabel } from './components/ActionFormatting';
import { PRIMARY_COLOR, SPINNER_FRAMES, LOGO_LINES, LOGO_HEIGHT } from './components/uiConstants';
import { bottomPanelHeight, chatLayout, messageOffsets, scrollOffsetForTarget, scrollWindow, formatTokenCount, statusBarRightHint, activePanel, computeInputDisplay, agentProgressBar, truncateNotification, shouldShowPasteDialog, buildPasteInfo, type LayoutSnapshot } from './layout';
import {
  buildAgentTimelineModel,
  formatElapsed,
  truncateMiddle,
  type TimelineStageStatus,
} from './components/AgentTimeline';
import { parseCommandInput } from './inputParsing';
import { formatWelcomeMessage } from './components/WelcomeFormatter';
import { filterCommands, detectMentionQuery } from './components/Autocomplete';
import { suggestMentions } from '../utils/mentions';
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
import { readImageFromClipboard } from '../utils/clipboard.js';
import { spawn } from 'child_process';
import { estimateResourceImpact, formatResourceImpact } from '../utils/resourceImpact';

// (PRIMARY_COLOR, SPINNER_FRAMES, LOGO_LINES, LOGO_HEIGHT moved to
// ./components/uiConstants — imported above.)

// ─── Command metadata ────────────────────────────────────────────────────────
//
// `COMMAND_DESCRIPTIONS` used to be hand-maintained here in App.ts and kept in
// sync (manually) with the `/help` screen in components/Help.ts. Both now derive
// from the single source of truth in `./commands/registry.ts`.
import { COMMAND_DESCRIPTIONS } from './commands/registry';

import { helpCategories, keyboardShortcuts } from './components/Help';
import { StatusInfo } from './components/Status';

import { handleSettingsKey, SettingsState, SETTINGS } from './components/Settings';
import { SelectItem } from './components/SelectScreen';
import { renderExportPanel, handleExportKey as handleExportKeyComponent, ExportState } from './components/Export';
import { renderLogoutPanel, handleLogoutKey as handleLogoutKeyComponent, LogoutState } from './components/Logout';
import { renderSearchPanel, handleSearchKey as handleSearchKeyComponent, SearchState } from './components/Search';
import {
  formatMessage as formatMessageFn,
  type BlockCounter,
} from './components/MessageFormatter';

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'welcome';
  content: string;
}

export interface ConfirmOptions {
  title: string;
  message: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  extraOption?: { label: string; onSelect: () => void };
  onConfirm: () => void;
  onCancel?: () => void;
}

/**
 * One hunk in the interactive `/apply --interactive` picker.
 * `lines` are already-formatted diff lines (e.g. `+ added`, `- removed`).
 */
export interface HunkPickerItem {
  /** File path this hunk belongs to. */
  path: string;
  /** 0-based hunk index within the file diff. */
  hunkIndex: number;
  /** Human-readable hunk header, e.g. `@@ -12,3 +12,5 @@`. */
  header: string;
  /** Pre-formatted diff lines to display. */
  lines: string[];
}

/**
 * Options for the interactive hunk picker. The picker walks the user
 * through `items` one at a time; for each they accept (`y`/Enter) or
 * skip (`n`). `a` accepts all remaining, `q`/Esc quits.
 *
 * `onComplete` fires once with the set of accepted `[path, hunkIndex]`
 * pairs (possibly empty) so the caller can apply them via
 * `applyHunksToFiles`.
 */
export interface HunkPickerOptions {
  title: string;
  items: HunkPickerItem[];
  onComplete: (accepted: Array<{ path: string; hunkIndex: number }>) => void;
}

export interface AppOptions {
  onSubmit: (message: string) => Promise<void>;
  onCommand: (command: string, args: string[]) => void;
  onExit: () => void;
  onStopAgent?: () => void;
  onImagePaste?: (imageData: string) => Promise<void>;
  getStatus: () => StatusInfo;
  hasWriteAccess?: () => boolean;
  hasProjectContext?: () => boolean;
  /** Project root for `@mention` autocomplete suggestions. Falls back to cwd. */
  getProjectRoot?: () => string;
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
  /** Messages that arrived while the user was scrolled up — drives the
   *  status bar's "↓ N new" badge; 0 whenever the view is at the bottom. */
  private unseenWhileScrolled = 0;
  private notification = '';
  private notificationIsWarn = false;
  private notificationTimeout: NodeJS.Timeout | null = null;
  
  // Render scheduling
  private pendingRender = false;

  // Spinner animation state
  private spinnerFrame = 0;
  private spinnerInterval: NodeJS.Timeout | null = null;
  
  // Agent progress state
  private isAgentRunning = false;
  private agentIteration = 0;
  private agentMaxIterations = 0;
  private agentActions: Array<{ type: string; target: string; result: string }> = [];
  private agentThinking = '';
  private agentWaitingForAI = false;
  private agentLog: string[] = [];
  /** Process uptime shown in the persistent footer. */
  private appStartedAt = Date.now();
  /** Start of the current agent run; unlike app uptime, resets per task. */
  private agentStartedAt: number | null = null;
  
  // Paste detection state
  private pasteInfo: { chars: number; lines: number; preview: string; fullText: string } | null = null;
  private pasteInfoOpen = false;
  private codeBlockCounter: BlockCounter = { current: 0 }; // Global code block counter for /copy numbering

  // Message render cache: index → { lines, width, startBlock, blockCount }
  private messageCache: Array<{ lines: Array<{ text: string; style: string; raw?: boolean }>; width: number; startBlock: number; blockCount: number } | null> = [];
  
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

  // `@mention` autocomplete state — separate from the `/command` picker
  // because mentions appear mid-sentence (not just at the start) and
  // insert a file path (not a slash command). `mentionAtStart` is the
  // index of the `@` in the editor value, used to replace `@query` with
  // `@selectedPath` on Tab/Enter.
  private showMentionAutocomplete = false;
  private mentionIndex = 0;
  private mentionItems: import('../utils/mentions').MentionSuggestion[] = [];
  private mentionAtStart = 0;
  /** Project root for resolving `suggestMentions`. Cached per update. */
  private mentionRoot = '';
  
  // Inline confirmation dialog state
  private confirmOpen = false;
  private confirmOptions: ConfirmOptions | null = null;
  private confirmSelection: 'yes' | 'no' | 'extra' = 'no';

  // Inline hunk-picker state (`/apply --interactive`)
  private hunkPickerOpen = false;
  private hunkPickerOptions: HunkPickerOptions | null = null;
  private hunkPickerIndex = 0;
  private hunkPickerAccepted: Array<{ path: string; hunkIndex: number }> = [];
  
  // Inline menu state (renders below input/status)
  private menuOpen = false;
  private menuTitle = '';
  /** Filtered view shown to the user; derived from `menuItemsAll` + `menuFilter`. */
  private menuItems: SelectItem[] = [];
  /** Full unfiltered list captured on `showSelect`. */
  private menuItemsAll: SelectItem[] = [];
  private menuFilter = '';
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
  private loginProviders: Array<{ id: string; name: string; description?: string; subscribeUrl?: string; noApiKey?: boolean }> = [];
  private loginProviderIndex = 0;
  private loginApiKey = '';
  private loginError = '';
  private loginCallback: ((result: { providerId: string; apiKey: string } | null) => void) | null = null;
  
  // Glitch characters for intro animation
  private static readonly GLITCH_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*<>?/;:[]=';
  
  // The `/` autocomplete list, derived from COMMAND_DESCRIPTIONS so it IS
  // the registry — a command can no longer ship without a description (a
  // hand-maintained parallel array drifted to 48 blank rows over time).
  // Single-letter shortcuts (c, t, d, r, f, e, o, b, p) stay routable in
  // commands.ts but are deliberately not listed: they alias commands that
  // already appear, and bare one-letter rows just cluttered the dropdown.
  private static readonly COMMANDS = Object.keys(COMMAND_DESCRIPTIONS);
  
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
    this.screen.onResize(() => {
      this.messageCache = new Array(this.messages.length).fill(null);
      this.scheduleRender();
    });
    
    this.scheduleRender();
  }
  
  /**
   * Stop the application
   */
  stop(): void {
    this.stopSpinner();
    if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
    if (this.introInterval) clearInterval(this.introInterval);
    this.input.stop();
    this.screen.cleanup();
  }
  
  /**
   * Add a message. Autoscrolls only when the user is already at the
   * bottom — if they scrolled up to read something, new messages must
   * not yank the view away; the status bar shows a "↓ N new" badge
   * instead (cleared when they return to the bottom).
   */
  addMessage(message: Message): void {
    this.messages.push(message);
    this.messageCache.push(null); // slot za novu poruku
    if (this.scrollOffset === 0) {
      this.unseenWhileScrolled = 0;
    } else {
      this.unseenWhileScrolled++;
    }
    this.scheduleRender();
  }

  setMessages(messages: Message[]): void {
    this.messages = messages;
    this.messageCache = new Array(messages.length).fill(null);
    this.scrollOffset = 0;
    this.unseenWhileScrolled = 0;
    this.scheduleRender();
  }

  clearMessages(): void {
    this.messages = [];
    this.messageCache = [];
    this.scrollOffset = 0;
    this.unseenWhileScrolled = 0;
    this.scheduleRender();
  }
  
  /**
   * Get all messages (for API history)
   */
  getMessages(): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    return this.messages.filter(m => m.role !== 'welcome') as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  }
  
  /**
   * Scroll to a specific message by index
   */
  scrollToMessage(messageIndex: number): void {
    const { width, height } = this.screen.getSize();
    const maxWidth = width - 4; // Account for margins

    const { totalLines, targetStartLine } = messageOffsets(
      this.messages.map((m) => m.content),
      maxWidth,
      messageIndex,
    );

    const visibleLines = height - 12; // Approximate visible area

    // Set scroll offset to show the target message near the top
    this.scrollOffset = scrollOffsetForTarget(totalLines, targetStartLine, visibleLines);
    this.scheduleRender();
    this.notify(`Jumped to message #${messageIndex + 1}`);
  }
  
  /**
   * Get messages without system messages (for API)
   */
  getChatHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.messages
      .filter(m => m.role !== 'system' && m.role !== 'welcome')
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
    this.scheduleRender();
  }
  
  /**
   * Add streaming chunk
   */
  addStreamChunk(chunk: string): void {
    this.streamingContent += chunk;
    this.scheduleRender();
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
      this.messageCache.push(null);
    }
    this.streamingContent = '';
    this.isStreaming = false;
    this.stopSpinner();
    this.scheduleRender();
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
    this.scheduleRender();
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
    const wasRunning = this.isAgentRunning;
    this.isAgentRunning = running;
    if (running) {
      if (!wasRunning) this.agentStartedAt = Date.now();
      this.agentIteration = 0;
      this.agentMaxIterations = 0;
      this.agentActions = [];
      this.agentThinking = '';
      this.agentWaitingForAI = true;
      this.agentLog = [];
      this.isLoading = false; // Clear loading state when agent takes over
      this.startSpinner();
    } else {
      this.agentStartedAt = null;
      this.isLoading = false; // Ensure loading is cleared when agent finishes
      this.stopSpinner();
    }
    this.scheduleRender();
  }
  
  /**
   * Update agent progress
   */
  updateAgentProgress(iteration: number, action?: { type: string; target: string; result: string }): void {
    this.agentIteration = iteration;
    if (action) {
      this.agentActions.push(action);
    }
    this.scheduleRender();
  }

  setAgentMaxIterations(max: number): void {
    this.agentMaxIterations = max;
  }

  /**
   * Set agent thinking text
   */
  setAgentThinking(text: string): void {
    this.agentThinking = text;
    this.scheduleRender();
  }

  setAgentWaitingForAI(waiting: boolean): void {
    this.agentWaitingForAI = waiting;
    this.scheduleRender();
  }

  addAgentLog(entry: string): void {
    this.agentLog.push(entry);
    if (this.agentLog.length > 5) this.agentLog.shift();
    this.scheduleRender();
  }
  
  /**
   * Paste from system clipboard (Ctrl+V)
   */
  private pasteFromClipboard(): void {
    // Check for image in clipboard first
    if (this.options.onImagePaste) {
      const imageData = readImageFromClipboard();
      if (imageData) {
        this.notify('Image detected — sending to vision model...');
        this.options.onImagePaste(imageData).catch((err: Error) => {
          this.notify(`Image error: ${err.message}`);
        });
        return;
      }
    }

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
    // Only show paste info for significant pastes (>100 chars or >3 lines)
    if (!shouldShowPasteDialog(text)) {
      // Small paste - just add to input directly
      this.editor.insert(text);
      this.updateAutocomplete();
      this.scheduleRender();
      return;
    }
    
    // Large paste - show info box
    this.pasteInfo = buildPasteInfo(text);
    this.pasteInfoOpen = true;
    this.scheduleRender();
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
      this.scheduleRender();
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
      this.scheduleRender();
      return;
    }
    
    if (event.key === 's') {
      // Submit paste directly as message
      if (this.pasteInfo) {
        const text = this.pasteInfo.fullText;
        this.pasteInfo = null;
        this.pasteInfoOpen = false;
        this.scheduleRender();
        
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
    this.notificationIsWarn = false;
    this.scheduleRender();

    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }

    this.notificationTimeout = setTimeout(() => {
      this.notification = '';
      this.notificationIsWarn = false;
      this.scheduleRender();
    }, duration);
  }

  /**
   * Show warning toast (orange) — replaces itself if called repeatedly.
   * Used for API errors / retries so they don't pollute the chat.
   */
  notifyWarn(message: string, duration = 8000): void {
    this.notification = message;
    this.notificationIsWarn = true;
    this.scheduleRender();

    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }

    this.notificationTimeout = setTimeout(() => {
      this.notification = '';
      this.notificationIsWarn = false;
      this.scheduleRender();
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
    this.scheduleRender();
  }
  
  /**
   * Show settings (inline, below status bar)
   */
  showSettings(): void {
    this.settingsState = { selectedIndex: 0, editing: false, editValue: '' };
    this.settingsOpen = true;
    this.scheduleRender();
  }
  
  /**
   * Show confirmation dialog
   */
  showConfirm(options: ConfirmOptions): void {
    this.confirmOptions = options;
    this.confirmSelection = 'no'; // Default to No for safety
    this.confirmOpen = true;
    this.scheduleRender();
  }

  /**
   * Show the interactive hunk picker (`/apply --interactive`).
   * The caller passes pre-built items + an `onComplete` callback.
   */
  showHunkPicker(options: HunkPickerOptions): void {
    this.hunkPickerOptions = options;
    this.hunkPickerIndex = 0;
    this.hunkPickerAccepted = [];
    this.hunkPickerOpen = true;
    this.scheduleRender();
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
    this.scheduleRender();
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
    this.scheduleRender();
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
    this.scheduleRender();
  }
  
  /**
   * Show export screen
   */
  showExport(callback: (format: 'md' | 'json' | 'txt') => void): void {
    this.exportIndex = 0;
    this.exportCallback = callback;
    this.exportOpen = true;
    this.scheduleRender();
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
    this.scheduleRender();
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
      this.scheduleRender();
      
      if (noiseCount >= 10) {
        clearInterval(noiseInterval);
        
        // Phase 2: Decryption animation (1500ms)
        this.introPhase = 'decrypt';
        const startTime = Date.now();
        const duration = 1500;
        
        this.introInterval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          this.introProgress = Math.min(elapsed / duration, 1);
          this.scheduleRender();
          
          if (this.introProgress >= 1) {
            this.finishIntro();
          }
        }, 16); // ~60 FPS
      }
    }, 50);
    
    this.scheduleRender();
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
    
    this.scheduleRender();
  }
  
  /**
   * Show inline login dialog
   */
  showLogin(
    providers: Array<{ id: string; name: string; description?: string; subscribeUrl?: string }>,
    callback: (result: { providerId: string; apiKey: string } | null) => void
  ): void {
    this.loginProviders = providers;
    this.loginProviderIndex = 0;
    this.loginStep = 'provider';
    this.loginApiKey = '';
    this.loginError = '';
    this.loginCallback = callback;
    this.loginOpen = true;
    this.scheduleRender();
  }
  
  /**
   * Reinitialize screen (after external screen takeover)
   */
  reinitScreen(): void {
    this.screen.init();
    this.input.start();
    this.input.onKey((event) => this.handleKey(event));
    
    this.scheduleRender();
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
    this.menuItemsAll = items;
    this.menuItems = items;
    this.menuFilter = '';
    this.menuCurrentValue = currentValue;
    this.menuCallback = callback;
    this.menuOpen = true;

    // Find current value index
    const currentIndex = items.findIndex(item => item.key === currentValue);
    this.menuIndex = currentIndex >= 0 ? currentIndex : 0;

    this.scheduleRender();
  }

  /**
   * Recompute the visible menu list from the current filter string.
   * Matches across key/label/description, case-insensitive. Keeps the
   * current value highlighted if it survives the filter; otherwise
   * cursor returns to the top.
   */
  private applyMenuFilter(next: string): void {
    this.menuFilter = next;
    if (!next) {
      this.menuItems = this.menuItemsAll;
    } else {
      const f = next.toLowerCase();
      this.menuItems = this.menuItemsAll.filter((item) =>
        item.key.toLowerCase().includes(f) ||
        item.label.toLowerCase().includes(f) ||
        (item.description?.toLowerCase().includes(f) ?? false)
      );
    }
    const surviving = this.menuItems.findIndex((item) => item.key === this.menuCurrentValue);
    this.menuIndex = surviving >= 0 ? surviving : 0;
    this.scheduleRender();
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
    // Dispatch to whichever inline panel currently owns focus.
    switch (activePanel({
      pasteInfoOpen: this.pasteInfoOpen,
      permissionOpen: this.permissionOpen,
      sessionPickerOpen: this.sessionPickerOpen,
      confirmOpen: this.confirmOpen,
      statusOpen: this.statusOpen,
      helpOpen: this.helpOpen,
      settingsOpen: this.settingsOpen,
      searchOpen: this.searchOpen,
      exportOpen: this.exportOpen,
      logoutOpen: this.logoutOpen,
      loginOpen: this.loginOpen,
      menuOpen: this.menuOpen,
      showAutocomplete: this.showAutocomplete,
      hunkPickerOpen: this.hunkPickerOpen,
    })) {
      case 'pasteInfo':      this.handlePasteInfoKey(event); return;
      case 'permission':     this.handleInlinePermissionKey(event); return;
      case 'sessionPicker':  this.handleInlineSessionPickerKey(event); return;
      case 'confirm':        this.handleInlineConfirmKey(event); return;
      case 'status':         this.handleInlineStatusKey(event); return;
      case 'help':           this.handleInlineHelpKey(event); return;
      case 'settings':       this.handleInlineSettingsKey(event); return;
      case 'search':         this.handleSearchKey(event); return;
      case 'export':         this.handleExportKey(event); return;
      case 'logout':         this.handleLogoutKey(event); return;
      case 'login':          this.handleLoginKey(event); return;
      case 'menu':           this.handleMenuKey(event); return;
      case 'hunkPicker':     this.handleHunkPickerKey(event); return;
    }

    // If intro is playing, skip on any key.
    if (this.showIntro) {
      this.skipIntro();
      return;
    }

    // Escape to cancel streaming/loading/agent or close autocomplete
    if (event.key === 'escape') {
      if (this.showMentionAutocomplete) {
        this.showMentionAutocomplete = false;
        this.scheduleRender();
        return;
      }
      if (this.showAutocomplete) {
        this.showAutocomplete = false;
        this.scheduleRender();
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
    
    // Handle autocomplete navigation (`/command` picker)
    if (this.showAutocomplete) {
      if (event.key === 'up') {
        this.autocompleteIndex = Math.max(0, this.autocompleteIndex - 1);
        this.scheduleRender();
        return;
      }
      if (event.key === 'down') {
        this.autocompleteIndex = Math.min(this.autocompleteItems.length - 1, this.autocompleteIndex + 1);
        this.scheduleRender();
        return;
      }
      if (event.key === 'tab' || event.key === 'enter') {
        // Select autocomplete item
        if (this.autocompleteItems.length > 0) {
          const selected = this.autocompleteItems[this.autocompleteIndex];
          this.editor.setValue('/' + selected + ' ');
          this.showAutocomplete = false;
          this.scheduleRender();
          return;
        }
      }
    }

    // Handle `@mention` autocomplete navigation
    if (this.showMentionAutocomplete) {
      if (event.key === 'up') {
        this.mentionIndex = Math.max(0, this.mentionIndex - 1);
        this.scheduleRender();
        return;
      }
      if (event.key === 'down') {
        this.mentionIndex = Math.min(this.mentionItems.length - 1, this.mentionIndex + 1);
        this.scheduleRender();
        return;
      }
      if (event.key === 'tab') {
        // Replace `@query` with `@selectedPath` in the editor.
        if (this.mentionItems.length > 0) {
          this.applyMentionSelection();
          this.showMentionAutocomplete = false;
          this.scheduleRender();
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
      this.scheduleRender();
      return;
    }
    
    // Ctrl+E - go to end of line
    if (event.ctrl && event.key === 'e') {
      this.editor.setCursorPos(this.editor.getValue().length);
      this.scheduleRender();
      return;
    }
    
    // Ctrl+U - clear line
    if (event.ctrl && event.key === 'u') {
      this.editor.clear();
      this.showAutocomplete = false;
      this.scheduleRender();
      return;
    }
    
    // Ctrl+W - delete word backward
    if (event.ctrl && event.key === 'w') {
      this.editor.deleteWordBackward();
      this.updateAutocomplete();
      this.scheduleRender();
      return;
    }
    
    // Ctrl+K - delete to end of line
    if (event.ctrl && event.key === 'k') {
      this.editor.deleteToEnd();
      this.updateAutocomplete();
      this.scheduleRender();
      return;
    }
    
    // Page up/down for scrolling chat history
    if (event.key === 'pageup') {
      // Scroll up (show older messages)
      this.scrollOffset += 10;
      this.scheduleRender();
      return;
    }
    
    if (event.key === 'pagedown') {
      // Scroll down (show newer messages)
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      if (this.scrollOffset === 0) this.unseenWhileScrolled = 0;
      this.scheduleRender();
      return;
    }
    
    // NOTE: ↑/↓ on an empty input deliberately fall through to the editor —
    // that's prompt-history recall (Input.ts), which the status bar has
    // always advertised but this handler used to shadow with a 3-line
    // scroll. Scrolling lives on PgUp/PgDn and the mouse wheel.

    // Mouse scroll
    if (event.key === 'scrollup') {
      this.scrollOffset += 3;
      this.scheduleRender();
      return;
    }
    
    if (event.key === 'scrolldown') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 3);
      if (this.scrollOffset === 0) this.unseenWhileScrolled = 0;
      this.scheduleRender();
      return;
    }
    
    // Ignore other mouse events
    if (event.key === 'mouse') {
      return;
    }
    
    // While agent/loading/streaming: allow typing and Enter to interrupt+reply
    if (this.isAgentRunning || this.isLoading || this.isStreaming) {
      if (event.key === 'enter' && !this.showAutocomplete) {
        const text = this.editor.getValue().trim();
        if (text) {
          if (this.isStreaming) {
            this.endStreaming();
            setTimeout(() => { this.submitInput(); }, 50);
          } else if (this.options.onStopAgent) {
            this.options.onStopAgent();
            setTimeout(() => { this.submitInput(); }, 100);
          }
        }
        return;
      }
      // Allow regular typing while busy
      if (this.editor.handleKey(event)) {
        this.scheduleRender();
      }
      return;
    }

    // Enter to submit (only if not in autocomplete)
    if (event.key === 'enter' && !this.isLoading && !this.isStreaming && !this.showAutocomplete) {
      const rawValue = this.editor.getValue();

      // Backslash continuation: if line ends with \, add newline instead of submitting
      if (rawValue.endsWith('\\')) {
        this.editor.setValue(rawValue.slice(0, -1) + '\n');
        this.scheduleRender();
        return;
      }

      // Multiline mode: Enter adds newline, Ctrl+Enter submits
      if (this.isMultilineMode && !event.ctrl) {
        this.editor.insert('\n');
        this.scheduleRender();
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
      this.scheduleRender();
    }
  }
  
  /**
   * Update autocomplete suggestions
   */
  private updateAutocomplete(): void {
    const value = this.editor.getValue();
    const cursorPos = this.editor.getCursorPos();

    // `/command` picker — only when the input starts with `/` and the
    // cursor is in the command-name segment (no space yet).
    const result = filterCommands(value, App.COMMANDS);
    if (result === null) {
      this.showAutocomplete = false;
      this.autocompleteItems = [];
    } else {
      this.autocompleteItems = result.items;
      this.showAutocomplete = result.items.length > 0;
      this.autocompleteIndex = result.index;
    }

    // `@mention` picker — detect an in-progress mention at the cursor.
    // Independent of the `/` picker so the two never compete.
    const mention = detectMentionQuery(value, cursorPos);
    if (mention) {
      const root = this.options.getProjectRoot?.() ?? process.cwd();
      this.mentionRoot = root;
      this.mentionAtStart = mention.atStart;
      this.mentionItems = suggestMentions({ root, query: mention.query, limit: 10 });
      this.showMentionAutocomplete = this.mentionItems.length > 0;
      this.mentionIndex = 0;
    } else {
      this.showMentionAutocomplete = false;
      this.mentionItems = [];
    }
  }

  /**
   * Replace the in-progress `@query` (from `mentionAtStart` to the
   * cursor) with the selected mention's path. Keeps the `@` prefix and
   * positions the cursor right after the inserted path so the user can
   * keep typing the rest of the message.
   */
  private applyMentionSelection(): void {
    if (this.mentionItems.length === 0) return;
    const selected = this.mentionItems[this.mentionIndex];
    const value = this.editor.getValue();
    const cursor = this.editor.getCursorPos();
    if (this.mentionAtStart >= value.length) return;
    // `mentionAtStart` is the index OF the `@`, so this slice EXCLUDES it —
    // re-add the sigil or the completed path is no longer a mention and the
    // file never gets attached.
    const before = value.slice(0, this.mentionAtStart) + '@';
    const after = value.slice(cursor);
    const next = before + selected.insertPath + ' ' + after;
    this.editor.setValue(next);
    const newCursor = (before + selected.insertPath + ' ').length;
    this.editor.setCursorPos(newCursor);
    // The picker may still have matches for the new prefix — refresh.
    this.updateAutocomplete();
  }
  
  /**
   * Handle inline status keys
   */
  private handleInlineStatusKey(event: KeyEvent): void {
    handleInlineStatusKey(event, {
      close: () => { this.statusOpen = false; },
      render: () => this.scheduleRender(),
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
      render: () => this.scheduleRender(),
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
    
    this.scheduleRender();
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
        this.scheduleRender();
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
      this.scheduleRender();
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
      onRender: () => { syncState(); this.scheduleRender(); },
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
      render: () => this.scheduleRender(),
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
        this.menuFilter = '';
        this.menuItemsAll = [];
        if (selected && callback) callback(selected);
      },
      render: () => this.scheduleRender(),
      filter: this.menuFilter,
      setFilter: (v) => this.applyMenuFilter(v),
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
      render: () => this.scheduleRender(),
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
      render: () => this.scheduleRender(),
    });
  }
  
  private handleInlineConfirmKey(event: KeyEvent): void {
    if (!this.confirmOptions) {
      this.confirmOpen = false;
      this.scheduleRender();
      return;
    }
    handleInlineConfirmKey(event, {
      options: this.confirmOptions,
      selection: this.confirmSelection,
      setSelection: (v) => { this.confirmSelection = v; },
      close: (result) => {
        const options = this.confirmOptions!;
        this.confirmOptions = null;
        this.confirmOpen = false;
        if (result === 'yes') options.onConfirm();
        else if (result === 'extra') options.extraOption?.onSelect();
        else if (options.onCancel) options.onCancel();
      },
      render: () => this.scheduleRender(),
    });
  }

  /**
   * Handle keys in the interactive hunk picker.
   *   y / Enter / →  accept this hunk, advance
   *   n / ←         skip this hunk, advance
   *   a             accept this + all remaining, finish
   *   q / Esc       finish without accepting this hunk
   *   ↑ / ↓         navigate (preview only — no decision)
   */
  private handleHunkPickerKey(event: KeyEvent): void {
    const opts = this.hunkPickerOptions;
    if (!opts) {
      this.hunkPickerOpen = false;
      this.scheduleRender();
      return;
    }
    const finish = () => {
      const accepted = this.hunkPickerAccepted;
      const cb = opts.onComplete;
      this.hunkPickerOptions = null;
      this.hunkPickerOpen = false;
      this.hunkPickerAccepted = [];
      this.hunkPickerIndex = 0;
      cb(accepted);
      this.scheduleRender();
    };
    const advance = () => {
      if (this.hunkPickerIndex >= opts.items.length - 1) {
        finish();
      } else {
        this.hunkPickerIndex++;
        this.scheduleRender();
      }
    };
    const acceptCurrent = () => {
      const item = opts.items[this.hunkPickerIndex];
      if (item) {
        this.hunkPickerAccepted.push({ path: item.path, hunkIndex: item.hunkIndex });
      }
      advance();
    };

    switch (event.key) {
      case 'y':
      case 'enter':
      case 'right':
        acceptCurrent();
        return;
      case 'n':
      case 'left':
        advance();
        return;
      case 'a':
        // Accept current + all remaining.
        for (let i = this.hunkPickerIndex; i < opts.items.length; i++) {
          const item = opts.items[i];
          this.hunkPickerAccepted.push({ path: item.path, hunkIndex: item.hunkIndex });
        }
        finish();
        return;
      case 'q':
      case 'escape':
        finish();
        return;
      case 'up':
        if (this.hunkPickerIndex > 0) {
          this.hunkPickerIndex--;
          this.scheduleRender();
        }
        return;
      case 'down':
        if (this.hunkPickerIndex < opts.items.length - 1) {
          this.hunkPickerIndex++;
          this.scheduleRender();
        }
        return;
      default:
        return;
    }
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
    const parsed = parseCommandInput(input);
    if (!parsed) return;
    const { command, args } = parsed;
    
    switch (command) {
      case 'help':
        this.helpOpen = true;
        this.helpScrollIndex = 0;
        this.scheduleRender();
        break;
        
      case 'status':
        this.statusOpen = true;
        this.scheduleRender();
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
  scheduleRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    setImmediate(() => {
      this.pendingRender = false;
      this.render();
    });
  }

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

    // Graceful degradation for very small terminals
    if (width < 40 || height < 10) {
      this.screen.clear();
      const msg = `Terminal too small (${width}x${height}) — resize to at least 40x10`;
      this.screen.writeLine(0, msg.slice(0, width), '');
      this.screen.render();
      return;
    }

    this.screen.clear();

    if (this.shouldRenderAgentTimeline(width, height)) {
      this.renderAgentTimelineScreen(width, height);
      return;
    }
    
    // If menu or settings is open, reserve space for it at bottom
    const panelHeight = bottomPanelHeight({
      height,
      pasteInfoOpen: this.pasteInfoOpen,
      pasteInfoPreviewLines: this.pasteInfo ? this.pasteInfo.preview.split('\n').length : 0,
      isAgentRunning: this.isAgentRunning,
      confirmOpen: this.confirmOpen && !!this.confirmOptions,
      hunkPickerOpen: this.hunkPickerOpen && !!this.hunkPickerOptions,
      permissionOpen: this.permissionOpen,
      sessionPickerOpen: this.sessionPickerOpen,
      sessionPickerItemCount: this.sessionPickerItems.length,
      confirmMessageCount: this.confirmOptions?.message.length ?? 0,
      statusOpen: this.statusOpen,
      helpOpen: this.helpOpen,
      searchOpen: this.searchOpen,
      searchResultCount: this.searchResults.length,
      exportOpen: this.exportOpen,
      logoutOpen: this.logoutOpen,
      logoutProviderCount: this.logoutProviders.length,
      loginOpen: this.loginOpen,
      loginStep: this.loginStep,
      loginProviderCount: this.loginProviders.length,
      menuOpen: this.menuOpen,
      menuItemCount: this.menuItems.length,
      settingsOpen: this.settingsOpen,
      settingsCount: SETTINGS.length,
      showAutocomplete: this.showAutocomplete,
      autocompleteItemCount: this.autocompleteItems.length,
      mentionPickerOpen: this.showMentionAutocomplete,
      mentionItemCount: this.mentionItems.length,
    } satisfies LayoutSnapshot);
    const layout = chatLayout(height, panelHeight);
    const mainHeight = layout.mainHeight;
    const headerHeight = width >= 60 && height >= 16 ? 2 : 0;
    const messagesStart = Math.min(layout.messagesEnd, headerHeight);
    const messagesEnd = layout.messagesEnd;
    const separatorLine = layout.separatorLine;
    const inputLine = layout.inputLine;
    const statusLine = layout.statusLine;

    if (headerHeight > 0) {
      this.renderPersistentHeader(width);
    }

    // Messages
    const messagesHeight = Math.max(1, messagesEnd - messagesStart + 1);
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
    
    // Gradient separator
    this.screen.writeRaw(separatorLine, PRIMARY_COLOR + '─'.repeat(width) + style.reset);
    
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

    // Inline hunk picker renders BELOW status bar
    if (this.hunkPickerOpen && this.hunkPickerOptions) {
      this.renderInlineHunkPicker(statusLine + 1, width);
    }
    
    // Inline autocomplete renders BELOW status bar
    if (this.showAutocomplete && this.autocompleteItems.length > 0 && !this.menuOpen && !this.settingsOpen && !this.helpOpen && !this.confirmOpen && !this.permissionOpen && !this.sessionPickerOpen) {
      this.renderInlineAutocomplete(statusLine + 1, width);
    } else if (this.showMentionAutocomplete && this.mentionItems.length > 0 && !this.menuOpen && !this.settingsOpen && !this.helpOpen && !this.confirmOpen && !this.permissionOpen && !this.sessionPickerOpen) {
      this.renderInlineMentionPicker(statusLine + 1, width);
    }
    
    // Inline permission renders BELOW status bar
    if (this.permissionOpen) {
      this.renderInlinePermission(statusLine + 1, width);
    }
    
    // Inline session picker renders BELOW status bar
    if (this.sessionPickerOpen) {
      this.renderInlineSessionPicker(statusLine + 1, width);
    }
    
    // Inline agent progress renders BELOW status bar (but not when confirm dialog is active)
    if (this.isAgentRunning && !(this.confirmOpen && this.confirmOptions)) {
      this.renderInlineAgentProgress(statusLine + 1, width);
    }
    
    // Inline paste info renders BELOW status bar
    if (this.pasteInfoOpen && this.pasteInfo) {
      this.renderInlinePasteInfo(statusLine + 1, width);
    }
    
    this.screen.render();
  }

  private shouldRenderAgentTimeline(width: number, height: number): boolean {
    if (!this.isAgentRunning || width < 92 || height < 26) return false;
    return !(
      this.pasteInfoOpen ||
      this.permissionOpen ||
      this.sessionPickerOpen ||
      this.confirmOpen ||
      this.hunkPickerOpen ||
      this.statusOpen ||
      this.helpOpen ||
      this.settingsOpen ||
      this.searchOpen ||
      this.exportOpen ||
      this.logoutOpen ||
      this.loginOpen ||
      this.menuOpen ||
      this.showAutocomplete ||
      this.showMentionAutocomplete
    );
  }

  private renderPersistentHeader(width: number): void {
    const status = this.options.getStatus();
    const project = status.projectPath.split('/').filter(Boolean).pop() || status.projectPath || 'no project';
    const session = status.sessionId ? status.sessionId.slice(0, 8) : 'new';
    const branch = status.branch || '';

    this.screen.writeLine(0, '');
    let x = 1;
    const writeSegment = (label: string, value: string, valueStyle = fg.white): boolean => {
      const separator = x > 1 ? ' │ ' : '';
      const required = separator.length + label.length + value.length;
      if (x + required >= width - 1) return false;
      if (separator) {
        this.screen.write(x, 0, separator, fg.gray);
        x += separator.length;
      }
      this.screen.write(x, 0, label, fg.gray);
      x += label.length;
      this.screen.write(x, 0, value, valueStyle);
      x += value.length;
      return true;
    };

    const wordmark = 'CODEEP';
    this.screen.write(x, 0, wordmark, PRIMARY_COLOR + style.bold);
    x += wordmark.length;
    writeSegment('', `v${status.version}`);
    if (width >= 86) writeSegment('session: ', session);
    writeSegment('model: ', truncateMiddle(status.model || 'unknown', 22));
    if (width >= 112) writeSegment('provider: ', truncateMiddle(status.provider, 14));
    if (width >= 128) writeSegment('project: ', truncateMiddle(project, 18));
    if (width >= 148 && branch) {
      // Budget the separator and label before truncating. Sizing the value off
      // `width - x` alone always overshoots writeSegment's fit guard, so a
      // branch long enough to need truncating used to render nothing at all.
      const branchBudget = width - x - ' │ '.length - 'branch: '.length - 2;
      if (branchBudget >= 10) {
        writeSegment('branch: ', truncateMiddle(branch, branchBudget), PRIMARY_COLOR);
      }
    }
    this.screen.horizontalLine(1, '─', PRIMARY_COLOR);
  }

  private renderAgentTimelineScreen(width: number, height: number): void {
    this.screen.clear();
    this.renderPersistentHeader(width);

    const inputY = height - 4;
    const hintsY = height - 3;
    const footerDividerY = height - 2;
    const statusY = height - 1;
    const workspaceTop = 2;
    const workspaceBottom = inputY - 2;
    const railWidth = width >= 132 ? Math.min(44, Math.floor(width * 0.28)) : 0;
    const dividerX = railWidth > 0 ? width - railWidth : width;
    const leftWidth = railWidth > 0 ? dividerX - 1 : width;

    const timeline = buildAgentTimelineModel({
      actions: this.agentActions,
      thinking: this.agentThinking,
      waitingForAI: this.agentWaitingForAI,
      iteration: this.agentIteration,
      maxIterations: this.agentMaxIterations,
    });
    const task = this.currentAgentTask();

    this.screen.writeLine(workspaceTop, '');
    this.screen.write(1, workspaceTop, 'YOU', PRIMARY_COLOR + style.bold);
    this.screen.write(7, workspaceTop, 'Task:', PRIMARY_COLOR + style.bold);
    this.screen.write(
      13,
      workspaceTop,
      truncateMiddle(task, Math.max(8, leftWidth - 15)),
      fg.white,
    );
    this.screen.horizontalLine(workspaceTop + 1, '─', fg.gray);

    this.screen.writeLine(workspaceTop + 2, '');
    this.screen.write(1, workspaceTop + 2, 'AGENT', PRIMARY_COLOR + style.bold);
    const runLabel = this.agentWaitingForAI ? 'Choosing the next step' : 'Executing a tool';
    this.screen.write(9, workspaceTop + 2, runLabel, fg.white);
    const stepLabel = this.agentMaxIterations > 0
      ? `step ${this.agentIteration}/${this.agentMaxIterations}`
      : `step ${this.agentIteration}`;
    if (stepLabel.length + 2 < leftWidth) {
      this.screen.write(leftWidth - stepLabel.length - 1, workspaceTop + 2, stepLabel, fg.gray);
    }

    const expandedTimeline = workspaceBottom - workspaceTop >= 30;
    let y = workspaceTop + 4;
    if (expandedTimeline) {
      this.screen.write(4, y, 'PLAN (HIGH LEVEL)', PRIMARY_COLOR + style.bold);
      this.screen.write(22, y++, 'Inspect the relevant project context', fg.white);
      this.screen.write(22, y++, 'Apply focused changes with permission checks', fg.white);
      this.screen.write(22, y++, 'Run verification and summarize the result', fg.white);
      this.screen.write(4, y, '─'.repeat(Math.max(8, leftWidth - 6)), fg.gray);
      y += 2;
    }

    for (const stage of timeline.stages) {
      if (y + 1 > workspaceBottom) break;
      const marker = stage.status === 'done' ? '●' : stage.status === 'active' ? '◆' : '○';
      const markerStyle = this.timelineStatusStyle(stage.status);
      this.screen.write(1, y, marker, markerStyle);
      this.screen.write(2, y + 1, '│', stage.status === 'pending' ? fg.gray : markerStyle);
      if (expandedTimeline && y + 2 <= workspaceBottom) {
        this.screen.write(2, y + 2, '│', stage.status === 'pending' ? fg.gray : markerStyle);
      }
      this.screen.write(4, y, stage.id.padEnd(8), markerStyle + (stage.status === 'active' ? style.bold : ''));
      this.screen.write(
        13,
        y,
        truncateMiddle(stage.summary, Math.max(8, leftWidth - 24)),
        stage.status === 'pending' ? fg.gray : fg.white,
      );
      const stateLabel = stage.status === 'done' ? 'done' : stage.status === 'active' ? 'active' : 'pending';
      if (leftWidth > 50) {
        this.screen.write(leftWidth - stateLabel.length - 1, y, stateLabel, markerStyle);
      }
      this.screen.write(
        13,
        y + 1,
        truncateMiddle(stage.detail, Math.max(8, leftWidth - 16)),
        fg.gray,
      );
      y += expandedTimeline ? 3 : 2;

      if (stage.status === 'active' && y + 2 <= workspaceBottom) {
        if (timeline.currentTarget) {
          const actionType = this.currentActionType();
          const actionLabel = actionType ? getActionLabel(actionType) : 'Working';
          this.screen.write(13, y, `${actionLabel}:`, PRIMARY_COLOR);
          this.screen.write(
            13 + actionLabel.length + 2,
            y,
            formatActionTarget(timeline.currentTarget, Math.max(12, leftWidth - actionLabel.length - 18)),
            fg.white,
          );
          y++;
        }
        if (this.agentMaxIterations > 0) {
          const barWidth = Math.max(8, Math.min(36, leftWidth - 28));
          const bar = agentProgressBar(this.agentIteration, this.agentMaxIterations, barWidth);
          const percent = `${Math.round(timeline.progress * 100)}%`;
          this.screen.write(13, y, percent.padStart(4), PRIMARY_COLOR);
          this.screen.write(19, y, bar, PRIMARY_COLOR);
          y++;
        }
        if (expandedTimeline && y + 3 <= workspaceBottom) {
          this.screen.write(13, y, 'RECENT ACTIVITY', PRIMARY_COLOR + style.bold);
          this.screen.write(
            29,
            y,
            '─'.repeat(Math.max(4, leftWidth - 31)),
            fg.gray,
          );
          y++;

          const recentActivity = this.agentLog.slice(-3);
          if (recentActivity.length === 0) {
            this.screen.write(13, y++, 'Waiting for the first completed action', fg.gray);
          } else {
            for (const entry of recentActivity) {
              if (y > workspaceBottom) break;
              const isError = entry.startsWith('✗') || entry.startsWith('!');
              const isActive = entry.startsWith('◆');
              const entryStyle = isError ? fg.red : isActive ? PRIMARY_COLOR : fg.green;
              this.screen.write(13, y, entry.slice(0, 1), entryStyle + style.bold);
              this.screen.write(
                15,
                y++,
                truncateMiddle(entry.slice(2), Math.max(8, leftWidth - 17)),
                isActive ? fg.white : fg.gray,
              );
            }
          }
          y++;
        }
      }
    }

    if (railWidth > 0) {
      this.renderAgentContextRail(dividerX, workspaceTop, workspaceBottom, railWidth, timeline);
    }

    this.screen.horizontalLine(inputY - 1, '─', PRIMARY_COLOR);
    this.renderInput(inputY, width, false);
    this.renderAgentKeyHints(hintsY, width);
    this.screen.horizontalLine(footerDividerY, '─', fg.gray);
    this.renderStatusBar(statusY, width);
    this.screen.render();
  }

  private renderAgentContextRail(
    dividerX: number,
    top: number,
    bottom: number,
    railWidth: number,
    timeline: ReturnType<typeof buildAgentTimelineModel>,
  ): void {
    for (let y = top; y <= bottom; y++) {
      this.screen.write(dividerX, y, '│', PRIMARY_COLOR);
    }

    const x = dividerX + 2;
    const contentWidth = Math.max(8, railWidth - 3);
    let y = top + 1;
    this.screen.write(x, y++, `CURRENT: ${timeline.currentStage}`, PRIMARY_COLOR + style.bold);
    y++;

    this.screen.write(x, y++, `FILES (${timeline.files.length})`, PRIMARY_COLOR + style.bold);
    if (timeline.files.length === 0) {
      this.screen.write(x, y++, 'No file changes yet', fg.gray);
    } else {
      for (const file of timeline.files.slice(-6)) {
        if (y > bottom - 7) break;
        const marker = file.type === 'delete' ? 'D' : file.type === 'write' ? 'A' : 'M';
        const color = file.result === 'error' ? fg.red : getActionColor(file.type);
        this.screen.write(x, y, marker, color + style.bold);
        this.screen.write(
          x + 2,
          y++,
          formatActionTarget(file.target, contentWidth - 2),
          file.result === 'error' ? fg.red : fg.white,
        );
      }
    }

    y++;
    if (y <= bottom - 5) {
      this.screen.write(x, y++, 'CHECKS', PRIMARY_COLOR + style.bold);
      if (timeline.checks.length === 0) {
        const activeCheck = timeline.currentStage === 'VERIFY' && timeline.currentTarget
          ? formatActionTarget(timeline.currentTarget, contentWidth)
          : 'Pending';
        this.screen.write(x, y++, activeCheck, timeline.currentStage === 'VERIFY' ? fg.yellow : fg.gray);
      } else {
        for (const check of timeline.checks.slice(-3)) {
          if (y > bottom - 3) break;
          const symbol = check.result === 'success' ? '✓' : '!';
          const color = check.result === 'success' ? fg.green : fg.red;
          this.screen.write(x, y, symbol, color + style.bold);
          this.screen.write(x + 2, y++, formatActionTarget(check.target, contentWidth - 2), fg.white);
        }
      }
    }

    const status = this.options.getStatus();
    const contextY = Math.max(y + 1, bottom - 3);
    if (contextY <= bottom) {
      this.screen.write(x, contextY, 'CONTEXT', PRIMARY_COLOR + style.bold);
      if (contextY + 1 <= bottom) {
        const project = status.projectPath.split('/').filter(Boolean).pop() || status.projectPath;
        this.screen.write(x, contextY + 1, truncateMiddle(project, contentWidth), fg.white);
      }
      if (contextY + 2 <= bottom) {
        const branch = status.branch ? `branch ${status.branch}` : `${status.provider} · ${status.model}`;
        this.screen.write(x, contextY + 2, truncateMiddle(branch, contentWidth), fg.gray);
      }
    }
  }

  private renderAgentKeyHints(y: number, width: number): void {
    this.screen.writeLine(y, '');
    const left = 'Keys: Enter reply · / commands · Esc stop · ↑↓ history';
    const runStartedAt = this.agentStartedAt ?? Date.now();
    const right = `agent: working · ${formatElapsed(Date.now() - runStartedAt)}`;
    this.screen.write(1, y, truncateMiddle(left, Math.max(12, width - right.length - 4)), fg.gray);
    if (right.length + 2 < width) {
      this.screen.write(width - right.length - 1, y, right, fg.gray);
    }
  }

  private timelineStatusStyle(status: TimelineStageStatus): string {
    if (status === 'done') return fg.green;
    if (status === 'active') return PRIMARY_COLOR;
    return fg.gray;
  }

  private currentActionType(): string {
    const separator = this.agentThinking.indexOf(':');
    if (separator < 0) return '';
    const type = this.agentThinking.slice(0, separator).trim().toLowerCase();
    return ['read', 'search', 'list', 'fetch', 'write', 'edit', 'delete', 'mkdir', 'command'].includes(type)
      ? type
      : '';
  }

  private currentAgentTask(): string {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role !== 'user') continue;
      const task = message.content
        .replace(/^\[DRY RUN]\s*/i, '')
        .replace(/^\[AGENT]\s*/i, '')
        .trim();
      if (task) return task;
    }
    return 'Autonomous coding task';
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
    const extraLabel = this.confirmOptions.extraOption?.label;

    const yesStyle   = this.confirmSelection === 'yes'   ? PRIMARY_COLOR + style.bold : fg.gray;
    const noStyle    = this.confirmSelection === 'no'    ? PRIMARY_COLOR + style.bold : fg.gray;
    const extraStyle = this.confirmSelection === 'extra' ? PRIMARY_COLOR + style.bold : fg.gray;

    const yesButton   = this.confirmSelection === 'yes'   ? `► ${yesLabel}` : `  ${yesLabel}`;
    const noButton    = this.confirmSelection === 'no'    ? `► ${noLabel}`  : `  ${noLabel}`;
    const extraButton = extraLabel
      ? (this.confirmSelection === 'extra' ? `► ${extraLabel}` : `  ${extraLabel}`)
      : null;

    this.screen.write(2, y, yesButton, yesStyle);
    this.screen.write(2 + yesButton.length + 4, y, noButton, noStyle);
    if (extraButton) {
      this.screen.write(2 + yesButton.length + 4 + noButton.length + 4, y, extraButton, extraStyle);
    }
    y++;

    // Footer
    this.screen.writeLine(y, '←/→ select • y/n quick • Enter confirm • Esc cancel', fg.gray);
  }

  /**
   * Render inline hunk picker (`/apply --interactive`).
   * Shows the current hunk's diff + the y/n/a/q key legend.
   */
  private renderInlineHunkPicker(startY: number, width: number): void {
    const opts = this.hunkPickerOptions;
    if (!opts) return;
    const item = opts.items[this.hunkPickerIndex];

    let y = startY;
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);

    // Title + progress
    const progress = opts.items.length > 0
      ? ` (${this.hunkPickerIndex + 1}/${opts.items.length})`
      : '';
    this.screen.writeLine(y++, `${opts.title}${progress}`, PRIMARY_COLOR + style.bold);

    if (!item) {
      this.screen.writeLine(y++, 'No hunks to review.', fg.gray);
      this.screen.writeLine(y, 'Press any key to close.', fg.gray);
      return;
    }

    // File path + hunk header
    this.screen.writeLine(y++, `File: ${item.path}`, fg.cyan);
    this.screen.writeLine(y++, `Hunk: ${item.header}`, fg.gray);

    // Diff lines (capped to available vertical space; show up to 12)
    const maxDiffLines = 12;
    const lines = item.lines.slice(0, maxDiffLines);
    for (const line of lines) {
      const prefix = line.charAt(0);
      let color = fg.white;
      if (prefix === '+') color = fg.green;
      else if (prefix === '-') color = fg.red;
      else if (prefix === '@') color = fg.cyan;
      // Truncate long lines to terminal width.
      const truncated = line.length > width - 2 ? line.slice(0, width - 5) + '...' : line;
      this.screen.writeLine(y++, `  ${truncated}`, color);
    }
    if (item.lines.length > maxDiffLines) {
      this.screen.writeLine(y++, `  … (${item.lines.length - maxDiffLines} more lines)`, fg.gray);
    }

    y++;
    // Key legend
    this.screen.writeLine(y, 'y/Enter accept • n skip • a accept all • q/Esc quit • ↑/↓ navigate', fg.gray);
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
      const hint = this.menuItemsAll.length > 10
        ? 'Type to filter, ↑↓ to navigate, Enter to pick…'
        : 'Select an option below…';
      this.screen.write(2, y, hint, fg.yellow);
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
    
    // Keep the composer available while the agent works so the user can steer
    // the run without losing context or waiting for the current tool to finish.
    if (this.isAgentRunning) {
      const promptSymbol = '❯ ';
      const maxInputWidth = Math.max(1, width - promptSymbol.length - 1);
      if (inputValue) {
        const displayInput = inputValue.length <= maxInputWidth ? inputValue : '…' + inputValue.slice(-(maxInputWidth - 1));
        this.screen.write(0, y, promptSymbol, PRIMARY_COLOR);
        this.screen.write(promptSymbol.length, y, displayInput + ' ');
        const cursorX = promptSymbol.length + Math.min(cursorPos, maxInputWidth);
        if (!hideCursor) {
          this.screen.setCursor(cursorX, y);
          this.screen.showCursor(true);
        }
      } else {
        this.screen.write(0, y, promptSymbol, PRIMARY_COLOR + style.bold);
        this.screen.write(promptSymbol.length, y, 'Reply to agent…', fg.gray);
        if (!hideCursor) {
          this.screen.setCursor(promptSymbol.length, y);
          this.screen.showCursor(true);
        }
      }
      return;
    }

    // Loading/streaming state — show typed input if any, else spinner
    if (this.isLoading || this.isStreaming) {
      if (inputValue) {
        const promptSymbol = '❯ ';
        const maxInputWidth = width - promptSymbol.length - 1;
        const displayInput = inputValue.length <= maxInputWidth ? inputValue : '…' + inputValue.slice(-(maxInputWidth - 1));
        this.screen.write(0, y, promptSymbol, PRIMARY_COLOR);
        this.screen.write(promptSymbol.length, y, displayInput + ' ');
        const cursorX = promptSymbol.length + Math.min(cursorPos, maxInputWidth);
        if (!hideCursor) {
          this.screen.setCursor(cursorX, y);
          this.screen.showCursor(true);
        }
      } else {
        const spinner = SPINNER_FRAMES[this.spinnerFrame];
        const message = this.isStreaming ? 'Writing...' : 'Thinking...';
        this.screen.write(0, y, PRIMARY_COLOR + `${spinner} ${message} (type to interrupt)` + style.reset);
        this.screen.showCursor(false);
      }
      return;
    }
    
    // Build prompt prefix
    const display = computeInputDisplay({
      value: inputValue,
      cursorPos,
      width,
      isMultilineMode: this.isMultilineMode,
    });

    // Show placeholder when input is empty
    if (display.isEmpty) {
      this.screen.write(0, y, display.promptSymbol, PRIMARY_COLOR);
      this.screen.write(display.promptSymbol.length, y, display.placeholder, fg.gray);

      if (!hideCursor) {
        this.screen.setCursor(display.promptSymbol.length, y);
        this.screen.showCursor(true);
      } else {
        this.screen.showCursor(false);
      }
      return;
    }

    // Prompt symbol in primary color, input text in white
    this.screen.write(0, y, display.promptSymbol, PRIMARY_COLOR);
    this.screen.write(display.promptSymbol.length, y, display.displayValue, fg.white);
    
    // Hide cursor when menu/settings is open
    if (hideCursor) {
      this.screen.showCursor(false);
    } else {
      this.screen.setCursor(Math.min(display.cursorX, width - 1), y);
      this.screen.showCursor(true);
    }
  }
  
  /**
   * Render inline menu below status bar
   */
  private renderInlineMenu(startY: number, width: number): void {
    const items = this.menuItems;
    const maxVisible = Math.min(Math.max(items.length, 1), 10);

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

    // Filter line — only rendered while filtering, so the menu looks
    // identical to the pre-filter UI by default.
    if (this.menuFilter) {
      const matchInfo = items.length === 0
        ? ' (no matches)'
        : ` (${items.length}/${this.menuItemsAll.length})`;
      this.screen.writeLine(y++, `Filter: ${this.menuFilter}█${matchInfo}`, fg.cyan);
    }

    if (items.length === 0) {
      this.screen.writeLine(y++, '  No items match. Backspace to edit, Esc to clear.', fg.gray);
    }

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
    const escHint = this.menuFilter ? 'Esc clear · Esc Esc cancel' : 'Esc cancel';
    this.screen.writeLine(y, `↑↓ navigate • Enter select • type to filter • ${escHint}${scrollInfo}`, fg.gray);
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
    this.screen.writeLine(y++, `↑↓ scroll • PgUp/PgDn fast scroll • Esc close${scrollInfo}`, fg.gray);
    this.screen.writeLine(y, 'Full guides → codeep.dev/docs    ·    /docs <command>  (e.g. /docs personality)', fg.cyan);
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
   * Render inline `@mention` file picker below the status bar.
   *
   * Mirrors the layout of `renderInlineAutocomplete` (separator → title →
   * items → footer) but shows file paths with their parent directory as
   * the description, and a `@` prefix instead of `/`.
   */
  private renderInlineMentionPicker(startY: number, width: number): void {
    const items = this.mentionItems;
    const maxVisible = Math.min(items.length, 8);

    let y = startY;

    // Separator line
    this.screen.horizontalLine(y++, '─', PRIMARY_COLOR);

    // Title
    this.screen.writeLine(y++, 'Add file to context (@mention)', PRIMARY_COLOR + style.bold);

    // Items: `path` + directory detail
    const visibleStart = Math.max(0, this.mentionIndex - maxVisible + 1);
    const visibleItems = items.slice(visibleStart, visibleStart + maxVisible);

    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      const actualIndex = visibleStart + i;
      const isSelected = actualIndex === this.mentionIndex;

      const prefix = isSelected ? '► ' : '  ';
      const pathText = ('@' + item.label).padEnd(40);

      if (isSelected) {
        this.screen.write(0, y, prefix, PRIMARY_COLOR);
        this.screen.write(prefix.length, y, pathText, PRIMARY_COLOR + style.bold);
        this.screen.write(prefix.length + pathText.length, y, item.detail, fg.white);
      } else {
        this.screen.write(0, y, prefix, '');
        this.screen.write(prefix.length, y, pathText, fg.cyan);
        this.screen.write(prefix.length + pathText.length, y, item.detail, fg.gray);
      }
      y++;
    }

    // Footer
    const scrollInfo = items.length > maxVisible ? ` (${visibleStart + 1}-${visibleStart + visibleItems.length}/${items.length})` : '';
    this.screen.writeLine(y, `↑↓ navigate • Tab select • Esc cancel${scrollInfo}`, fg.gray);
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

    // Top border: gradient line with gradient title embedded
    const titleInner = ` ${spinner} AGENT `;
    const titlePadLeft = 2;
    const lineLeft = PRIMARY_COLOR + '─'.repeat(titlePadLeft) + style.reset;
    const titleColored = PRIMARY_COLOR + style.bold + titleInner + style.reset;
    const lineRight = PRIMARY_COLOR + '─'.repeat(Math.max(0, width - titlePadLeft - titleInner.length - 1)) + style.reset;
    this.screen.write(0, y, lineLeft + titleColored + lineRight);
    y++;

    // Rolling log (last 5 actions)
    const LOG_LINES = 5;
    const padded = [...this.agentLog];
    while (padded.length < LOG_LINES) padded.unshift('');
    for (let i = 0; i < LOG_LINES; i++) {
      this.screen.writeLine(y, '');
      const entry = padded[i];
      if (entry) {
        // entry format: "symbol label target"
        const spaceIdx = entry.indexOf(' ', 2);
        const spaceIdx2 = spaceIdx > 0 ? entry.indexOf(' ', spaceIdx + 1) : -1;
        if (spaceIdx2 > 0) {
          const symbol = entry.slice(0, 2);
          const label = entry.slice(2, spaceIdx2);
          const target = entry.slice(spaceIdx2 + 1);
          const isActive = i === padded.length - 1;
          const symbolColor = isActive ? PRIMARY_COLOR : fg.gray;
          const labelColor = isActive ? fg.white + style.bold : fg.gray;
          const targetColor = isActive ? fg.white : fg.gray;
          this.screen.write(1, y, symbol, symbolColor);
          this.screen.write(3, y, label, labelColor);
          this.screen.write(3 + label.length + 1, y, target, targetColor);
        } else {
          this.screen.write(1, y, entry, fg.gray);
        }
      }
      y++;
    }

    // Stats + 8-bit progress bar line
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

    // 8-bit gradient progress bar (right side, if max iterations known)
    if (this.agentMaxIterations > 0) {
      const barWidth = 14;
      const bar = agentProgressBar(this.agentIteration, this.agentMaxIterations, barWidth);
      const barColored = PRIMARY_COLOR + bar + style.reset;
      const stepText = `${this.agentIteration}/${this.agentMaxIterations}`;
      const barX = width - barWidth - stepText.length - 3;
      this.screen.write(barX, y, barColored);
      this.screen.write(width - stepText.length - 1, y, stepText, fg.gray);
    } else {
      const stepText = `step ${this.agentIteration}`;
      this.screen.write(width - stepText.length - 1, y, stepText, fg.gray);
    }
    y++;

    // Bottom border with help text
    const helpText = ' Esc to stop ';
    const helpPadLeft = Math.floor((width - helpText.length) / 2);
    const helpPadRight = Math.max(0, width - helpPadLeft - helpText.length);
    this.screen.write(0, y, PRIMARY_COLOR + '─'.repeat(helpPadLeft) + style.reset);
    this.screen.write(helpPadLeft, y, helpText, fg.gray);
    this.screen.write(helpPadLeft + helpText.length, y, PRIMARY_COLOR + '─'.repeat(helpPadRight) + style.reset);
  }
  
  /**
   * Get color for action type
   */
  /**
   * Render status bar
   */
  private renderStatusBar(y: number, width: number): void {
    // Clear the line first
    this.screen.writeLine(y, '');

    if (this.notification) {
      const notifColor = this.notificationIsWarn ? '\x1b[38;5;208m' : PRIMARY_COLOR; // orange for warn
      const maxLen = width - 2;
      const msg = truncateNotification(this.notification, maxLen);
      this.screen.write(0, y, notifColor + ' ' + msg + style.reset);
      return;
    }

    const status = this.options.getStatus();
    const stats = status.tokenStats;
    const rightText = statusBarRightHint({
      scrollOffset: this.scrollOffset,
      unseenWhileScrolled: this.unseenWhileScrolled,
      isStreaming: this.isStreaming,
      isLoading: this.isLoading,
    });

    if (this.scrollOffset > 0 && this.unseenWhileScrolled > 0) {
      this.screen.write(width - rightText.length, y, rightText, PRIMARY_COLOR);
      return;
    }

    // Wide terminals get an operational footer: elapsed time and honest,
    // explicitly-labelled resource ranges. These are estimates, never implied
    // to be provider measurements.
    if (width >= 110 && stats) {
      const totalTokens = Math.max(0, stats.totalTokens);
      const elapsed = formatElapsed(Date.now() - this.appStartedAt);
      const leftParts = [
        `runtime ${elapsed}`,
        `tokens ${formatTokenCount(totalTokens)}`,
      ];
      // Only pay-per-use tokens carry a real price; flat-fee providers get the
      // short "in plan" wording so the segment can't crowd the right-edge hint.
      const billable = typeof stats.billableCost === 'number' ? stats.billableCost : (stats.estimatedCost ?? 0);
      if (billable > 0) {
        leftParts.push(`cost $${billable < 0.01 ? billable.toFixed(4) : billable.toFixed(2)}${stats.hasFlatFeeUsage ? ' + in plan' : ''}`);
      } else if (stats.hasFlatFeeUsage) {
        leftParts.push('cost in plan');
      }
      // Thinking-effort tier, same chip the compact fallback shows beside the
      // model. Only present when set + supported — see getStatus.
      if (status.reasoningEffort) {
        leftParts.push(`effort ${status.reasoningEffort}`);
      }
      const leftText = leftParts.join(' · ');
      this.screen.write(1, y, leftText, fg.gray);

      // The right edge belongs to the hint: while streaming it reads
      // "Esc to stop", the only on-screen affordance for interrupting a run.
      // Claim it first, then spend whatever gap is left on the (decorative)
      // resource estimate — never the other way around.
      // Same right-edge column as the compact fallback and the scroll badge, so
      // the hint doesn't shift by one when the terminal crosses 110 columns.
      let rightEdge = width;
      if (rightText && width - rightText.length > leftText.length + 3) {
        rightEdge = width - rightText.length;
        this.screen.write(rightEdge, y, rightText, fg.gray);
      }
      if (totalTokens > 0 && width >= 138) {
        const impact = formatResourceImpact(estimateResourceImpact(totalTokens));
        const impactText = `energy ${impact.energy} est · water ${impact.water} est`;
        const impactX = rightEdge - impactText.length - 3;
        if (impactX > leftText.length + 3) {
          this.screen.write(impactX, y, impactText, fg.gray);
        }
      }
      return;
    }

    // Compact fallback: model · messages · token count.
    const modelName = status.model || '';
    const msgCount = `${this.messages.length} msg`;
    const tokenStr = stats && stats.totalTokens > 0
      ? `${formatTokenCount(stats.totalTokens)} tok`
      : '';

    let leftX = 1;
    if (modelName) {
      this.screen.write(leftX, y, PRIMARY_COLOR + modelName + style.reset);
      leftX += modelName.length + 2;
      this.screen.write(leftX - 1, y, '·', fg.gray);
      leftX += 1;
    }
    // Thinking-effort tier, right beside the model (the CLI twin of the Mac
    // app's effort chip). Only present when set + supported — see getStatus.
    if (status.reasoningEffort) {
      this.screen.write(leftX, y, fg.yellow + status.reasoningEffort + style.reset);
      leftX += status.reasoningEffort.length + 2;
      this.screen.write(leftX - 1, y, '·', fg.gray);
      leftX += 1;
    }
    this.screen.write(leftX, y, msgCount, fg.gray);
    leftX += msgCount.length;
    if (tokenStr) {
      this.screen.write(leftX, y, ' · ', fg.gray);
      this.screen.write(leftX + 3, y, tokenStr, fg.gray);
    }

    this.screen.write(width - rightText.length, y, rightText, fg.gray);
  }
  
  /**
   * Get visible messages (including streaming)
   */
  private getVisibleMessages(height: number, width: number): Array<{ text: string; style: string; raw?: boolean }> {
    const allLines: Array<{ text: string; style: string; raw?: boolean }> = [];
    this.codeBlockCounter.current = 0; // Reset block counter for each render pass

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const cached = this.messageCache[i];

      if (cached && cached.width === width && cached.startBlock === this.codeBlockCounter.current) {
        // Cache hit — preskoči formatiranje
        this.codeBlockCounter.current += cached.blockCount;
        allLines.push(...cached.lines);
      } else {
        // Cache miss — formatiraj i spremi
        const startBlock = this.codeBlockCounter.current;
        const msgLines = msg.role === 'welcome'
          ? formatWelcomeMessage(msg.content)
          : formatMessageFn(msg.role, msg.content, width, this.codeBlockCounter);
        const blockCount = this.codeBlockCounter.current - startBlock;
        this.messageCache[i] = { lines: msgLines, width, startBlock, blockCount };
        allLines.push(...msgLines);
      }
    }

    if (this.isStreaming && this.streamingContent) {
      const streamLines = formatMessageFn('assistant', this.streamingContent + '▊', width, this.codeBlockCounter);
      allLines.push(...streamLines);
    }

    // Calculate visible window based on scroll offset
    const totalLines = allLines.length;
    const { startIndex, endIndex, clampedScrollOffset } = scrollWindow({
      totalLines,
      height,
      scrollOffset: this.scrollOffset,
    });
    this.scrollOffset = clampedScrollOffset;

    return allLines.slice(startIndex, endIndex);
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

      // Name column width — pad so descriptions align in a column.
      // Description is clipped to remaining terminal width with an ellipsis;
      // on narrow panes the user still sees the name and a hint of the
      // description rather than a silent overrun past the right edge.
      const longestName = this.loginProviders.reduce((m, p) => Math.max(m, p.name.length), 0);
      const descStartX = 2 + longestName + 2;
      const descBudget = Math.max(0, width - descStartX - 1);

      for (let i = 0; i < this.loginProviders.length; i++) {
        const provider = this.loginProviders[i];
        const isSelected = i === this.loginProviderIndex;
        const prefix = isSelected ? '→ ' : '  ';

        this.screen.write(0, y, prefix, isSelected ? fg.green : '');
        this.screen.write(2, y, provider.name.padEnd(longestName + 2), isSelected ? fg.green + style.bold : fg.white);
        if (provider.description && descBudget > 0) {
          const desc = provider.description.length > descBudget
            ? provider.description.slice(0, Math.max(1, descBudget - 1)) + '…'
            : provider.description;
          this.screen.write(descStartX, y, desc, isSelected ? fg.white : fg.gray);
        }
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
}
