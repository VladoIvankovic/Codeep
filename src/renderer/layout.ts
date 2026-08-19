/**
 * Pure layout helpers extracted from App.ts.
 *
 * These functions take a *snapshot* of the App's UI state (which panels are
 * open, how many items they hold) and return geometric values (heights,
 * offsets) without touching `this`. Keeping them pure means they can be
 * unit-tested directly — the layout math is the part of the renderer most
 * prone to off-by-one regressions, and it was previously untestable because
 * it was inlined in `renderChat` with `this.*` access on every line.
 *
 * Convention: every field on `LayoutSnapshot` is `readonly` so callers
 * cannot mutate the App's real state through the snapshot.
 */

/** Read-only snapshot of the fields `bottomPanelHeight` consults. */
export interface LayoutSnapshot {
  readonly height: number;
  readonly pasteInfoOpen: boolean;
  readonly pasteInfoPreviewLines: number;
  readonly isAgentRunning: boolean;
  readonly confirmOpen: boolean;
  readonly permissionOpen: boolean;
  readonly sessionPickerOpen: boolean;
  readonly sessionPickerItemCount: number;
  readonly confirmMessageCount: number;
  readonly statusOpen: boolean;
  readonly helpOpen: boolean;
  readonly searchOpen: boolean;
  readonly searchResultCount: number;
  readonly exportOpen: boolean;
  readonly logoutOpen: boolean;
  readonly logoutProviderCount: number;
  readonly loginOpen: boolean;
  readonly loginStep: 'provider' | 'apikey';
  readonly loginProviderCount: number;
  readonly menuOpen: boolean;
  readonly menuItemCount: number;
  readonly settingsOpen: boolean;
  readonly settingsCount: number;
  readonly showAutocomplete: boolean;
  readonly autocompleteItemCount: number;
  readonly hunkPickerOpen: boolean;
  readonly mentionPickerOpen: boolean;
  readonly mentionItemCount: number;
}

/**
 * Compute how many terminal rows the bottom panel (paste info, agent box,
 * permission/session/confirm/search/export/login/logout/menu/settings
 * dialogs, autocomplete) occupies in the current frame.
 *
 * Mirrors the if/else chain that used to live inline in `renderChat`.
 * Returns 0 when no panel is open.
 */
export function bottomPanelHeight(s: LayoutSnapshot): number {
  if (s.pasteInfoOpen) {
    const previewLines = Math.min(s.pasteInfoPreviewLines, 5);
    return previewLines + 6; // title + preview + extra line indicator + options
  }
  if (s.isAgentRunning && !s.confirmOpen) {
    return 9; // Agent progress box: top + 5 log lines + stats + bottom + 1 margin
  }
  if (s.permissionOpen) {
    return 10; // Permission dialog
  }
  if (s.sessionPickerOpen) {
    return Math.min(s.sessionPickerItemCount + 6, 14); // Session picker
  }
  if (s.confirmOpen) {
    return s.confirmMessageCount + 5; // title + messages + buttons + padding
  }
  if (s.hunkPickerOpen) {
    // Title + progress + path + header + up to 12 diff lines + more marker + legend.
    // Kept in sync with components/HunkPicker.ts (hunkPickerPanelHeight).
    return 18;
  }
  if (s.statusOpen) {
    return 16; // Status info panel
  }
  if (s.helpOpen) {
    return Math.min(s.height - 6, 20); // Help takes more space
  }
  if (s.searchOpen) {
    return Math.min(s.searchResultCount * 3 + 6, 18); // Search results
  }
  if (s.exportOpen) {
    return 10; // Export dialog
  }
  if (s.logoutOpen) {
    return Math.min(s.logoutProviderCount + 6, 12); // Logout picker
  }
  if (s.loginOpen) {
    return s.loginStep === 'provider'
      ? Math.min(s.loginProviderCount + 5, 14)
      : 8; // Login dialog
  }
  if (s.menuOpen) {
    return Math.min(s.menuItemCount + 4, 14);
  }
  if (s.settingsOpen) {
    return Math.min(s.settingsCount + 4, 16);
  }
  if (s.showAutocomplete && s.autocompleteItemCount > 0) {
    return Math.min(s.autocompleteItemCount + 3, 12);
  }
  // `@`-mention picker: separator + title + up to 8 rows + footer. Without
  // this branch the panel measured 0 while the picker still painted its rows,
  // so it drew straight over the bottom of the chat transcript.
  if (s.mentionPickerOpen && s.mentionItemCount > 0) {
    return Math.min(s.mentionItemCount, 8) + 3;
  }
  return 0;
}

/**
 * Split the available terminal height into the main chat area and the
 * bottom panel. Returns the y-coordinates the renderer paints into.
 *
 * - `messagesStart` is always 0 (top of the screen).
 * - `messagesEnd` is the last row the message list may use.
 * - `separatorLine`, `inputLine`, `statusLine` are the three reserved
 *   rows at the bottom of the main area, in order.
 */
export interface ChatLayout {
  messagesStart: number;
  messagesEnd: number;
  separatorLine: number;
  inputLine: number;
  statusLine: number;
  mainHeight: number;
}

export function chatLayout(height: number, panelHeight: number): ChatLayout {
  const mainHeight = Math.max(1, height - panelHeight);
  const messagesEnd = Math.max(0, mainHeight - 4);
  const separatorLine = Math.max(0, mainHeight - 3);
  const inputLine = Math.max(0, mainHeight - 2);
  const statusLine = Math.max(0, mainHeight - 1);
  return { messagesStart: 0, messagesEnd, separatorLine, inputLine, statusLine, mainHeight };
}

/**
 * Count how many terminal rows a single chat message will occupy once
 * word-wrapped to `maxWidth` columns. Used by `scrollToMessage` to find
 * the right scroll offset.
 *
 * Every message renders as: 1 header row + 1 blank row + one or more
 * wrapped content rows, followed by 1 blank spacing row.
 */
export function messageLineCount(content: string, maxWidth: number): number {
  const contentLines = content.split('\n');
  let lines = 2; // Header + empty line after
  for (const line of contentLines) {
    lines += Math.ceil(Math.max(1, line.length) / maxWidth);
  }
  return lines + 1; // +1 for spacing between messages
}

/**
 * Sum `messageLineCount` across a list of messages and return both the
 * running total and the line offset where `targetIndex` begins. This is
 * the pure core of the old `scrollToMessage` method.
 */
export function messageOffsets(
  contents: string[],
  maxWidth: number,
  targetIndex: number,
): { totalLines: number; targetStartLine: number } {
  let totalLines = 0;
  let targetStartLine = 0;
  for (let i = 0; i < contents.length; i++) {
    if (i === targetIndex) targetStartLine = totalLines;
    totalLines += messageLineCount(contents[i], maxWidth);
  }
  return { totalLines, targetStartLine };
}

/**
 * Compute the scroll offset that places the target message roughly in
 * the middle of the visible window.
 */
export function scrollOffsetForTarget(
  totalLines: number,
  targetStartLine: number,
  visibleLines: number,
): number {
  return Math.max(0, totalLines - targetStartLine - Math.floor(visibleLines / 2));
}

/**
 * Compute the visible window of a chat transcript given the current scroll
 * offset. Returns the [startIndex, endIndex) slice into the all-lines array
 * and, as a side-effect contract, the clamped scroll offset the caller
 * should store (the renderer overwrites `this.scrollOffset` with this).
 *
 * Extracted from `getVisibleMessages` so the off-by-one-prone scroll math
 * has direct unit tests.
 */
export function scrollWindow(args: {
  totalLines: number;
  height: number;
  scrollOffset: number;
}): { startIndex: number; endIndex: number; clampedScrollOffset: number } {
  const maxScroll = Math.max(0, args.totalLines - args.height);
  const clampedScrollOffset = Math.min(args.scrollOffset, maxScroll);
  const endIndex = args.totalLines - clampedScrollOffset;
  const startIndex = Math.max(0, endIndex - args.height);
  return { startIndex, endIndex, clampedScrollOffset };
}

// ─── Agent progress bar ───────────────────────────────────────────────────────
//
// `renderInlineAgentProgress` builds a gradient progress bar from block
// characters (░▒▓█) when the agent has a known iteration budget. The bar
// construction is pure string math; extracting it makes the gradient
// thresholds testable without a Screen mock.

/** Render a gradient progress bar of the given width for the given ratio. */
export function agentProgressBar(iteration: number, maxIterations: number, barWidth: number): string {
  // Avoid Infinity when maxIterations is 0 — show an empty bar instead.
  const progress = maxIterations > 0 ? Math.min(iteration / maxIterations, 1) : 0;
  const filled = Math.round(progress * barWidth);
  let bar = '';
  for (let i = 0; i < barWidth; i++) {
    if (i < filled - 1) bar += '█';
    else if (i === filled - 1) bar += '▓';
    else if (i === filled) bar += '▒';
    else bar += '░';
  }
  return bar;
}

// ─── Notification truncation ──────────────────────────────────────────────────
//
// `renderStatusBar` truncates the notification string to fit the terminal
// width with an ellipsis. The truncation rule is pure.

/** Truncate `text` to `maxLen` columns, appending an ellipsis if it doesn’t fit. */
export function truncateNotification(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

// ─── Paste detection ──────────────────────────────────────────────────────────
//
// `handlePaste` decides whether to show the confirm-paste dialog (for large
// pastes) or insert the text directly. The threshold check and preview
// generation are pure.

export interface PasteInfo {
  chars: number;
  lines: number;
  preview: string;
  fullText: string;
}

/** Threshold above which a paste is considered "large" and shows a dialog. */
export const PASTE_DIALOG_THRESHOLD = { chars: 100, lines: 3 };

/** True when the paste is large enough to warrant the confirm dialog. */
export function shouldShowPasteDialog(text: string): boolean {
  const chars = text.length;
  const lines = text.split('\n').length;
  return chars >= PASTE_DIALOG_THRESHOLD.chars || lines > PASTE_DIALOG_THRESHOLD.lines;
}

/** Build the PasteInfo struct for a large paste (preview truncated to 200 chars). */
export function buildPasteInfo(text: string): PasteInfo {
  const preview = text.length > 200 ? text.slice(0, 197) + '...' : text;
  return {
    chars: text.length,
    lines: text.split('\n').length,
    preview,
    fullText: text,
  };
}

// ─── Status-bar formatting ────────────────────────────────────────────────────
//
// Small pure helpers used by `renderStatusBar`. Extracted so the
// formatting rules (token compacting, context-sensitive right hint) are
// unit-testable instead of buried in a 60-line screen-painting method.

/**
 * Compact a raw token count into the short string shown in the status bar
 * ("123", "1.2K", "12.3K"). Returns an empty string when tokens is 0 so
 * the caller can omit the segment entirely.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens <= 0) return '';
  if (tokens < 1000) return String(tokens);
  return (tokens / 1000).toFixed(1) + 'K';
}

/**
 * Pick the context-sensitive hint shown at the right edge of the status
 * bar. The "new messages below" badge takes priority when the user has
 * scrolled up — otherwise the hint depends on whether work is in flight.
 */
export function statusBarRightHint(args: {
  scrollOffset: number;
  unseenWhileScrolled: number;
  isStreaming: boolean;
  isLoading: boolean;
}): string {
  if (args.scrollOffset > 0 && args.unseenWhileScrolled > 0) {
    return `↓ ${args.unseenWhileScrolled} new · PgDn `;
  }
  return args.isStreaming || args.isLoading ? 'Esc to stop ' : '/help · ↑↓ history ';
}

// ─── Active-panel detection ──────────────────────────────────────────────────
//
// `handleChatKey` walks a long if/else chain every keystroke to decide which
// inline panel should receive the event. Pulling that decision into a pure
// function (a) makes the precedence order explicit and documented, (b) lets
// us unit-test the priority instead of constructing a full App, and
// (c) lets `renderChat` reuse the same precedence for focus indication.

/** The panel that currently owns keyboard focus, in priority order. */
export type ActivePanel =
  | 'pasteInfo'
  | 'permission'
  | 'sessionPicker'
  | 'confirm'
  | 'status'
  | 'help'
  | 'settings'
  | 'search'
  | 'export'
  | 'logout'
  | 'login'
  | 'menu'
  | 'autocomplete'
  | 'hunkPicker'
  | 'chat';

export interface PanelState {
  readonly pasteInfoOpen: boolean;
  readonly permissionOpen: boolean;
  readonly sessionPickerOpen: boolean;
  readonly confirmOpen: boolean;
  readonly statusOpen: boolean;
  readonly helpOpen: boolean;
  readonly settingsOpen: boolean;
  readonly searchOpen: boolean;
  readonly exportOpen: boolean;
  readonly logoutOpen: boolean;
  readonly loginOpen: boolean;
  readonly menuOpen: boolean;
  readonly showAutocomplete: boolean;
  readonly hunkPickerOpen: boolean;
}

/**
 * Return the highest-priority open panel. `chat` is the fallback when no
 * panel is open. The order matches the if/else chain that used to live in
 * `handleChatKey`.
 */
export function activePanel(s: PanelState): ActivePanel {
  if (s.pasteInfoOpen) return 'pasteInfo';
  if (s.permissionOpen) return 'permission';
  if (s.sessionPickerOpen) return 'sessionPicker';
  if (s.confirmOpen) return 'confirm';
  if (s.statusOpen) return 'status';
  if (s.helpOpen) return 'help';
  if (s.settingsOpen) return 'settings';
  if (s.searchOpen) return 'search';
  if (s.exportOpen) return 'export';
  if (s.logoutOpen) return 'logout';
  if (s.loginOpen) return 'login';
  if (s.menuOpen) return 'menu';
  if (s.hunkPickerOpen) return 'hunkPicker';
  if (s.showAutocomplete) return 'autocomplete';
  return 'chat';
}

// ─── Input-line display ───────────────────────────────────────────────────────
//
// `renderInput` builds the text and cursor position for the bottom input
// row. The geometry (which slice of a long line to show, where the cursor
// lands within that slice, how the prompt symbol scales with multi-line
// mode) is pure and was previously inlined alongside screen-write calls.
// Extracting it makes the truncation/scroll behaviour unit-testable.

/** Multiplier that controls how far from the left edge the cursor sits. */
const INPUT_CURSOR_ANCHOR = 0.7;

export interface InputDisplayOptions {
  /** Full editor value (may contain newlines). */
  value: string;
  /** Character offset of the cursor within `value`. */
  cursorPos: number;
  /** Available width (terminal columns). */
  width: number;
  /** Whether multi-line (❯❯) mode is active. */
  isMultilineMode: boolean;
}

export interface InputDisplay {
  /** Prompt symbol shown before the text ("❯ ", "❯❯ ", "[3] ❯ "). */
  promptSymbol: string;
  /** Visible slice of the input (already truncated / ellipsised). */
  displayValue: string;
  /** Column position for the cursor (absolute, 0-based from screen left). */
  cursorX: number;
  /** Placeholder text to show when the editor is empty. */
  placeholder: string;
  /** True when the editor value is empty. */
  isEmpty: boolean;
}

/**
 * Compute the prompt symbol for the current state. Multi-line content
 * shows a `[n] ❯ ` prefix with the line count; otherwise `❯❯ ` in
 * multi-line mode, or the plain `❯ `.
 */
export function inputPromptSymbol(value: string, isMultilineMode: boolean): string {
  const lineCount = value.split('\n').length;
  if (lineCount > 1) return `[${lineCount}] ❯ `;
  return isMultilineMode ? '❯❯ ' : '❯ ';
}

/**
 * Compute the visible slice of a long input line, plus the cursor column
 * it maps to. Mirrors the inline logic that used to live in `renderInput`:
 * when the line fits, show it whole; otherwise anchor the cursor at 70%
 * of the available width and slide the viewport.
 */
export function inputViewport(args: {
  line: string;
  cursorInLine: number;
  maxInputWidth: number;
}): { displayValue: string; cursorOffset: number } {
  const { line, cursorInLine, maxInputWidth } = args;
  if (line.length <= maxInputWidth) {
    return { displayValue: line, cursorOffset: Math.max(0, cursorInLine) };
  }
  const effectiveCursor = Math.max(0, cursorInLine);
  const visibleStart = Math.max(0, effectiveCursor - Math.floor(maxInputWidth * INPUT_CURSOR_ANCHOR));
  const visibleEnd = visibleStart + maxInputWidth;
  let displayValue: string;
  if (visibleStart > 0) {
    displayValue = '…' + line.slice(visibleStart + 1, visibleEnd);
  } else {
    displayValue = line.slice(0, maxInputWidth);
  }
  return { displayValue, cursorOffset: effectiveCursor - visibleStart };
}

/**
 * Top-level entry point used by `renderInput`. Produces the prompt symbol,
 * the visible text, the absolute cursor X, and the placeholder.
 */
export function computeInputDisplay(opts: InputDisplayOptions): InputDisplay {
  const promptSymbol = inputPromptSymbol(opts.value, opts.isMultilineMode);
  const maxInputWidth = opts.width - promptSymbol.length - 1;
  const isEmpty = opts.value.length === 0;
  const placeholder = opts.isMultilineMode
    ? 'Multi-line mode  Enter=newline · Esc=send'
    : 'Message or /command';

  if (isEmpty) {
    return {
      promptSymbol,
      displayValue: '',
      cursorX: promptSymbol.length,
      placeholder,
      isEmpty,
    };
  }

  // For multi-line content, show the last line being edited.
  const lines = opts.value.split('\n');
  const lineCount = lines.length;
  const lastLine = lines[lines.length - 1];
  const displayInput = lineCount > 1 ? lastLine : opts.value;
  const charsBeforeLastLine = lineCount > 1 ? opts.value.lastIndexOf('\n') + 1 : 0;
  const cursorInLine = opts.cursorPos - charsBeforeLastLine;

  const { displayValue, cursorOffset } = inputViewport({
    line: displayInput,
    cursorInLine,
    maxInputWidth,
  });

  return {
    promptSymbol,
    displayValue,
    cursorX: promptSymbol.length + cursorOffset,
    placeholder,
    isEmpty,
  };
}
