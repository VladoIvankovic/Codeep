import { describe, it, expect } from 'vitest';
import {
  bottomPanelHeight,
  chatLayout,
  messageLineCount,
  messageOffsets,
  scrollOffsetForTarget,
  formatTokenCount,
  statusBarRightHint,
  type LayoutSnapshot,
} from './layout';

function snapshot(overrides: Partial<LayoutSnapshot> = {}): LayoutSnapshot {
  return {
    height: 40,
    pasteInfoOpen: false,
    pasteInfoPreviewLines: 0,
    isAgentRunning: false,
    confirmOpen: false,
    permissionOpen: false,
    sessionPickerOpen: false,
    sessionPickerItemCount: 0,
    confirmMessageCount: 0,
    statusOpen: false,
    helpOpen: false,
    searchOpen: false,
    searchResultCount: 0,
    exportOpen: false,
    logoutOpen: false,
    logoutProviderCount: 0,
    loginOpen: false,
    loginStep: 'provider',
    loginProviderCount: 0,
    menuOpen: false,
    menuItemCount: 0,
    settingsOpen: false,
    settingsCount: 0,
    showAutocomplete: false,
    autocompleteItemCount: 0,
    mentionPickerOpen: false,
    mentionItemCount: 0,
    hunkPickerOpen: false,
    ...overrides,
  };
}

// ─── bottomPanelHeight ─────────────────────────────────────────────────────
describe('bottomPanelHeight', () => {
  it('returns 0 when no panel is open', () => {
    expect(bottomPanelHeight(snapshot())).toBe(0);
  });

  it('returns preview+6 when the paste-info panel is open', () => {
    expect(bottomPanelHeight(snapshot({ pasteInfoOpen: true, pasteInfoPreviewLines: 3 }))).toBe(9);
  });

  it('caps the paste preview at 5 lines before adding the chrome', () => {
    expect(bottomPanelHeight(snapshot({ pasteInfoOpen: true, pasteInfoPreviewLines: 20 }))).toBe(11);
  });

  it('returns 9 when the agent is running and no confirm is open', () => {
    expect(bottomPanelHeight(snapshot({ isAgentRunning: true }))).toBe(9);
  });

  it('returns 0 for the agent box when a confirm dialog is open on top of it', () => {
    // The agent box is suppressed while a confirm is visible — but the
    // confirm branch is checked lower down and returns its own height.
    expect(bottomPanelHeight(snapshot({ isAgentRunning: true, confirmOpen: true, confirmMessageCount: 2 }))).toBe(7);
  });

  it('returns 10 for the permission dialog', () => {
    expect(bottomPanelHeight(snapshot({ permissionOpen: true }))).toBe(10);
  });

  it('scales the session picker with item count, capped at 14', () => {
    expect(bottomPanelHeight(snapshot({ sessionPickerOpen: true, sessionPickerItemCount: 3 }))).toBe(9);
    expect(bottomPanelHeight(snapshot({ sessionPickerOpen: true, sessionPickerItemCount: 100 }))).toBe(14);
  });

  it('scales the confirm dialog with message count', () => {
    expect(bottomPanelHeight(snapshot({ confirmOpen: true, confirmMessageCount: 4 }))).toBe(9);
  });

  it('returns 16 for the status panel', () => {
    expect(bottomPanelHeight(snapshot({ statusOpen: true }))).toBe(16);
  });

  it('caps the help panel at min(height-6, 20)', () => {
    expect(bottomPanelHeight(snapshot({ height: 40, helpOpen: true }))).toBe(20);
    expect(bottomPanelHeight(snapshot({ height: 18, helpOpen: true }))).toBe(12);
  });

  it('scales the search panel by result count, capped at 18', () => {
    expect(bottomPanelHeight(snapshot({ searchOpen: true, searchResultCount: 2 }))).toBe(12);
    expect(bottomPanelHeight(snapshot({ searchOpen: true, searchResultCount: 100 }))).toBe(18);
  });

  it('returns 10 for the export dialog', () => {
    expect(bottomPanelHeight(snapshot({ exportOpen: true }))).toBe(10);
  });

  it('scales the logout picker, capped at 12', () => {
    expect(bottomPanelHeight(snapshot({ logoutOpen: true, logoutProviderCount: 2 }))).toBe(8);
    expect(bottomPanelHeight(snapshot({ logoutOpen: true, logoutProviderCount: 100 }))).toBe(12);
  });

  it('returns 8 for the login apikey step', () => {
    expect(bottomPanelHeight(snapshot({ loginOpen: true, loginStep: 'apikey' }))).toBe(8);
  });

  it('scales the login provider step, capped at 14', () => {
    expect(bottomPanelHeight(snapshot({ loginOpen: true, loginStep: 'provider', loginProviderCount: 4 }))).toBe(9);
    expect(bottomPanelHeight(snapshot({ loginOpen: true, loginStep: 'provider', loginProviderCount: 100 }))).toBe(14);
  });

  it('scales the menu, capped at 14', () => {
    expect(bottomPanelHeight(snapshot({ menuOpen: true, menuItemCount: 5 }))).toBe(9);
    expect(bottomPanelHeight(snapshot({ menuOpen: true, menuItemCount: 100 }))).toBe(14);
  });

  it('scales the settings panel, capped at 16', () => {
    expect(bottomPanelHeight(snapshot({ settingsOpen: true, settingsCount: 10 }))).toBe(14);
    expect(bottomPanelHeight(snapshot({ settingsOpen: true, settingsCount: 100 }))).toBe(16);
  });

  it('omits autocomplete when the list is empty even if showAutocomplete is true', () => {
    expect(bottomPanelHeight(snapshot({ showAutocomplete: true, autocompleteItemCount: 0 }))).toBe(0);
  });

  it('scales autocomplete, capped at 12', () => {
    expect(bottomPanelHeight(snapshot({ showAutocomplete: true, autocompleteItemCount: 4 }))).toBe(7);
    expect(bottomPanelHeight(snapshot({ showAutocomplete: true, autocompleteItemCount: 100 }))).toBe(12);
  });

  it('respects the documented priority: pasteInfo beats agent beats permission', () => {
    expect(
      bottomPanelHeight(snapshot({ pasteInfoOpen: true, pasteInfoPreviewLines: 1, isAgentRunning: true, permissionOpen: true })),
    ).toBe(7);
  });

  it('returns 18 for the hunk picker', () => {
    expect(bottomPanelHeight(snapshot({ hunkPickerOpen: true }))).toBe(18);
  });
});

// ─── chatLayout ────────────────────────────────────────────────────────────
describe('chatLayout', () => {
  it('reserves 4 rows at the bottom when no panel is open', () => {
    const l = chatLayout(40, 0);
    expect(l).toEqual({
      messagesStart: 0,
      messagesEnd: 36,
      separatorLine: 37,
      inputLine: 38,
      statusLine: 39,
      mainHeight: 40,
    });
  });

  it('shrinks the message area by the panel height', () => {
    const l = chatLayout(40, 10);
    expect(l.mainHeight).toBe(30);
    expect(l.messagesEnd).toBe(26);
    expect(l.separatorLine).toBe(27);
    expect(l.inputLine).toBe(28);
    expect(l.statusLine).toBe(29);
  });

  it('clamps mainHeight to a minimum of 1', () => {
    const l = chatLayout(5, 100);
    expect(l.mainHeight).toBe(1);
  });

  it('clamps the message/separator/input rows at 0 for tiny terminals', () => {
    const l = chatLayout(2, 0);
    expect(l.messagesEnd).toBe(0);
    expect(l.separatorLine).toBe(0);
    expect(l.inputLine).toBe(0);
    // statusLine is max(0, mainHeight-1) = max(0, 1) = 1.
    expect(l.statusLine).toBe(1);
  });
});

// ─── messageLineCount ───────────────────────────────────────────────────────
describe('messageLineCount', () => {
  it('counts a single short line as header + blank + content + spacing = 4', () => {
    expect(messageLineCount('hi', 80)).toBe(4);
  });

  it('wraps a long line across multiple rows', () => {
    // 10 chars at maxWidth 4 → 3 wrapped rows. Total: 2 + 3 + 1 = 6.
    expect(messageLineCount('abcdefghij', 4)).toBe(6);
  });

  it('counts an empty content line as one row (Math.max(1, 0)/width)', () => {
    expect(messageLineCount('', 80)).toBe(4);
  });

  it('handles multi-line content', () => {
    // Two short lines → 2 + 1 + 1 + 1 = 5.
    expect(messageLineCount('a\nb', 80)).toBe(5);
  });

  it('rounds up partial wraps', () => {
    // 5 chars at width 4 → ceil(5/4) = 2 rows. Total: 2 + 2 + 1 = 5.
    expect(messageLineCount('abcde', 4)).toBe(5);
  });
});

// ─── messageOffsets ─────────────────────────────────────────────────────────
describe('messageOffsets', () => {
  it('returns 0 for the target start line when the list is empty', () => {
    expect(messageOffsets([], 80, 0)).toEqual({ totalLines: 0, targetStartLine: 0 });
  });

  it('places the first message at offset 0', () => {
    const { totalLines, targetStartLine } = messageOffsets(['hi'], 80, 0);
    expect(targetStartLine).toBe(0);
    expect(totalLines).toBe(4);
  });

  it('places the second message after the first message’s line count', () => {
    const { targetStartLine } = messageOffsets(['hi', 'bye'], 80, 1);
    expect(targetStartLine).toBe(4); // first message occupies 4 lines
  });

  it('sums the total across all messages', () => {
    const { totalLines } = messageOffsets(['hi', 'bye', 'ok'], 80, 0);
    expect(totalLines).toBe(12); // 3 messages × 4 lines
  });
});

// ─── scrollOffsetForTarget ──────────────────────────────────────────────────
describe('scrollOffsetForTarget', () => {
  it('returns 0 when the target is already near the top', () => {
    expect(scrollOffsetForTarget(100, 0, 20)).toBe(90);
  });

  it('centres the target in the visible window', () => {
    // totalLines 100, target at line 50, visible 20 → 100 - 50 - 10 = 40.
    expect(scrollOffsetForTarget(100, 50, 20)).toBe(40);
  });

  it('floors the visible/2 term', () => {
    expect(scrollOffsetForTarget(100, 50, 21)).toBe(40); // floor(21/2) = 10
  });

  it('clamps to 0 when the result would be negative', () => {
    expect(scrollOffsetForTarget(10, 50, 20)).toBe(0);
  });
});

// ─── scrollWindow ─────────────────────────────────────────────────────────────
import { scrollWindow } from './layout';

describe('scrollWindow', () => {
  it('returns the last `height` lines when not scrolled', () => {
    const w = scrollWindow({ totalLines: 100, height: 20, scrollOffset: 0 });
    expect(w.startIndex).toBe(80);
    expect(w.endIndex).toBe(100);
    expect(w.clampedScrollOffset).toBe(0);
  });

  it('shifts the window up by scrollOffset', () => {
    const w = scrollWindow({ totalLines: 100, height: 20, scrollOffset: 30 });
    expect(w.startIndex).toBe(50);
    expect(w.endIndex).toBe(70);
    expect(w.clampedScrollOffset).toBe(30);
  });

  it('clamps scrollOffset to maxScroll when it would exceed the content', () => {
    // totalLines 100, height 20 → maxScroll = 80. An offset of 200 should clamp.
    const w = scrollWindow({ totalLines: 100, height: 20, scrollOffset: 200 });
    expect(w.clampedScrollOffset).toBe(80);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(20);
  });

  it('returns the whole content when totalLines <= height', () => {
    const w = scrollWindow({ totalLines: 10, height: 20, scrollOffset: 5 });
    // maxScroll = max(0, 10-20) = 0, so scrollOffset clamps to 0.
    expect(w.clampedScrollOffset).toBe(0);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(10);
  });

  it('handles the degenerate empty-content case', () => {
    const w = scrollWindow({ totalLines: 0, height: 20, scrollOffset: 0 });
    expect(w.clampedScrollOffset).toBe(0);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(0);
  });

  it('clamps startIndex to 0 when endIndex - height would be negative', () => {
    // totalLines 5, height 20, scrollOffset 0 → endIndex 5, startIndex max(0, -15) = 0.
    const w = scrollWindow({ totalLines: 5, height: 20, scrollOffset: 0 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(5);
  });

  it('keeps the window size equal to height when there is enough content', () => {
    const w = scrollWindow({ totalLines: 100, height: 25, scrollOffset: 10 });
    expect(w.endIndex - w.startIndex).toBe(25);
  });
});

// ─── agentProgressBar ─────────────────────────────────────────────────────────
import { agentProgressBar } from './layout';

describe('agentProgressBar', () => {
  it('produces a string of the requested width', () => {
    expect(agentProgressBar(3, 10, 14).length).toBe(14);
    expect(agentProgressBar(0, 10, 5).length).toBe(5);
  });

  it('renders a single ▒ at the start when iteration is 0', () => {
    // filled = round(0 * 8) = 0 → char 0 === filled → '▒', rest '░'.
    expect(agentProgressBar(0, 10, 8)).toBe('▒░░░░░░░');
  });

  it('renders a near-full bar with a ▓ at the leading edge at 100% progress', () => {
    // filled = round(1 * 8) = 8 → chars 0..6 = █, char 7 === filled-1 → ▓.
    expect(agentProgressBar(10, 10, 8)).toBe('███████▓');
  });

  it('uses the gradient chars (▓ at the leading edge, ▒ just behind)', () => {
    // iteration 5/10, width 10 → filled = round(0.5 * 10) = 5.
    // chars 0..3 = █, char 4 = ▓, char 5 = ▒, chars 6..9 = ░.
    const bar = agentProgressBar(5, 10, 10);
    expect(bar.slice(0, 4)).toBe('████');
    expect(bar[4]).toBe('▓');
    expect(bar[5]).toBe('▒');
    expect(bar.slice(6)).toBe('░░░░');
  });

  it('clamps iteration > maxIterations to 100%', () => {
    // Same as the 100% case: filled = round(1 * 6) = 6 → chars 0..4 = █, char 5 = ▓.
    expect(agentProgressBar(15, 10, 6)).toBe('█████▓');
  });

  it('handles maxIterations of 0 by showing an empty bar', () => {
    // The guard `maxIterations > 0` forces progress to 0, so filled = 0,
    // char 0 === filled → '▒', rest '░'. Avoids the Infinity bug.
    const bar = agentProgressBar(1, 0, 4);
    expect(bar).toBe('▒░░░');
  });
});

// ─── truncateNotification ─────────────────────────────────────────────────────
import { truncateNotification } from './layout';

describe('truncateNotification', () => {
  it('returns the text unchanged when it fits within maxLen', () => {
    expect(truncateNotification('hi', 10)).toBe('hi');
  });

  it('returns the text unchanged when it equals maxLen exactly', () => {
    expect(truncateNotification('abcd', 4)).toBe('abcd');
  });

  it('truncates with an ellipsis when the text exceeds maxLen', () => {
    expect(truncateNotification('abcdef', 4)).toBe('abc…');
  });

  it('produces a string of exactly maxLen columns when truncated', () => {
    expect(truncateNotification('a'.repeat(100), 10).length).toBe(10);
  });

  it('handles an empty string', () => {
    expect(truncateNotification('', 10)).toBe('');
  });

  it('handles maxLen of 1 (only the ellipsis fits)', () => {
    expect(truncateNotification('abc', 1)).toBe('…');
  });

  it('does not truncate when maxLen is larger than the text', () => {
    expect(truncateNotification('short', 100)).toBe('short');
  });
});

// ─── paste detection ──────────────────────────────────────────────────────────
import {
  shouldShowPasteDialog,
  buildPasteInfo,
  PASTE_DIALOG_THRESHOLD,
} from './layout';

describe('shouldShowPasteDialog', () => {
  it('returns false for a short single-line paste', () => {
    expect(shouldShowPasteDialog('hi')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(shouldShowPasteDialog('')).toBe(false);
  });

  it('returns false for just under the char threshold', () => {
    expect(shouldShowPasteDialog('a'.repeat(PASTE_DIALOG_THRESHOLD.chars - 1))).toBe(false);
  });

  it('returns true at exactly the char threshold (100 chars)', () => {
    expect(shouldShowPasteDialog('a'.repeat(PASTE_DIALOG_THRESHOLD.chars))).toBe(true);
  });

  it('returns false for exactly 3 lines (threshold is >3)', () => {
    expect(shouldShowPasteDialog('a\nb\nc')).toBe(false);
  });

  it('returns true for 4+ lines even if under the char threshold', () => {
    expect(shouldShowPasteDialog('a\nb\nc\nd')).toBe(true);
  });

  it('returns true for a long single-line paste', () => {
    expect(shouldShowPasteDialog('a'.repeat(500))).toBe(true);
  });
});

describe('buildPasteInfo', () => {
  it('captures the full char and line counts', () => {
    const info = buildPasteInfo('hello\nworld');
    expect(info.chars).toBe(11);
    expect(info.lines).toBe(2);
    expect(info.fullText).toBe('hello\nworld');
  });

  it('uses the text as the preview when under 200 chars', () => {
    const info = buildPasteInfo('short');
    expect(info.preview).toBe('short');
  });

  it('truncates the preview to 200 chars with an ellipsis for long pastes', () => {
    const long = 'x'.repeat(500);
    const info = buildPasteInfo(long);
    expect(info.preview.length).toBe(200);
    expect(info.preview.endsWith('...')).toBe(true);
    expect(info.preview.startsWith('xxx')).toBe(true);
  });

  it('keeps the preview exactly 200 chars for a 201-char paste', () => {
    const info = buildPasteInfo('a'.repeat(201));
    expect(info.preview.length).toBe(200);
    expect(info.preview.endsWith('...')).toBe(true);
  });

  it('does not truncate a 200-char paste', () => {
    const exact = 'a'.repeat(200);
    const info = buildPasteInfo(exact);
    expect(info.preview).toBe(exact);
  });

  it('counts a single line for a paste with no newlines', () => {
    expect(buildPasteInfo('hello').lines).toBe(1);
  });

  it('counts trailing newline as an extra line', () => {
    expect(buildPasteInfo('hello\n').lines).toBe(2);
  });
});

// ─── formatTokenCount ───────────────────────────────────────────────────────
describe('formatTokenCount', () => {
  it('returns an empty string for 0 tokens', () => {
    expect(formatTokenCount(0)).toBe('');
  });

  it('returns an empty string for negative inputs', () => {
    expect(formatTokenCount(-5)).toBe('');
  });

  it('returns the raw number below 1000', () => {
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('compacts to one-decimal K at 1000 and above', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(1234)).toBe('1.2K');
    expect(formatTokenCount(12345)).toBe('12.3K');
  });

  it('keeps one decimal even for round thousands', () => {
    expect(formatTokenCount(5000)).toBe('5.0K');
  });
});

// ─── statusBarRightHint ─────────────────────────────────────────────────────
describe('statusBarRightHint', () => {
  it('shows the "new messages" badge when scrolled up with unseen messages', () => {
    expect(statusBarRightHint({ scrollOffset: 5, unseenWhileScrolled: 3, isStreaming: false, isLoading: false }))
      .toBe('↓ 3 new · PgDn ');
  });

  it('omits the badge when unseenWhileScrolled is 0 even if scrolled', () => {
    expect(statusBarRightHint({ scrollOffset: 5, unseenWhileScrolled: 0, isStreaming: false, isLoading: false }))
      .toBe('/help · ↑↓ history ');
  });

  it('omits the badge when not scrolled even if there are unseen messages', () => {
    expect(statusBarRightHint({ scrollOffset: 0, unseenWhileScrolled: 5, isStreaming: false, isLoading: false }))
      .toBe('/help · ↑↓ history ');
  });

  it('shows "Esc to stop" while streaming', () => {
    expect(statusBarRightHint({ scrollOffset: 0, unseenWhileScrolled: 0, isStreaming: true, isLoading: false }))
      .toBe('Esc to stop ');
  });

  it('shows "Esc to stop" while loading', () => {
    expect(statusBarRightHint({ scrollOffset: 0, unseenWhileScrolled: 0, isStreaming: false, isLoading: true }))
      .toBe('Esc to stop ');
  });

  it('shows the default help hint when idle and not scrolled', () => {
    expect(statusBarRightHint({ scrollOffset: 0, unseenWhileScrolled: 0, isStreaming: false, isLoading: false }))
      .toBe('/help · ↑↓ history ');
  });

  it('badge takes priority over streaming', () => {
    expect(statusBarRightHint({ scrollOffset: 5, unseenWhileScrolled: 3, isStreaming: true, isLoading: false }))
      .toBe('↓ 3 new · PgDn ');
  });
});

// ─── activePanel ─────────────────────────────────────────────────────────────
import { activePanel, type PanelState } from './layout';

function panels(overrides: Partial<PanelState> = {}): PanelState {
  return {
    pasteInfoOpen: false,
    permissionOpen: false,
    sessionPickerOpen: false,
    confirmOpen: false,
    statusOpen: false,
    helpOpen: false,
    settingsOpen: false,
    searchOpen: false,
    exportOpen: false,
    logoutOpen: false,
    loginOpen: false,
    menuOpen: false,
    showAutocomplete: false,
    hunkPickerOpen: false,
    ...overrides,
  };
}

describe('activePanel', () => {
  it('returns "chat" when no panel is open', () => {
    expect(activePanel(panels())).toBe('chat');
  });

  it.each([
    ['pasteInfo', 'pasteInfoOpen'],
    ['permission', 'permissionOpen'],
    ['sessionPicker', 'sessionPickerOpen'],
    ['confirm', 'confirmOpen'],
    ['status', 'statusOpen'],
    ['help', 'helpOpen'],
    ['settings', 'settingsOpen'],
    ['search', 'searchOpen'],
    ['export', 'exportOpen'],
    ['logout', 'logoutOpen'],
    ['login', 'loginOpen'],
    ['menu', 'menuOpen'],
    ['hunkPicker', 'hunkPickerOpen'],
    ['autocomplete', 'showAutocomplete'],
  ] as const)('returns %s when only %s is open', (panel, flag) => {
    expect(activePanel(panels({ [flag]: true } as Partial<PanelState>))).toBe(panel);
  });

  it('respects the documented priority: pasteInfo beats all', () => {
    const all: PanelState = {
      ...panels(),
      permissionOpen: true,
      sessionPickerOpen: true,
      confirmOpen: true,
      statusOpen: true,
      helpOpen: true,
      settingsOpen: true,
      searchOpen: true,
      exportOpen: true,
      logoutOpen: true,
      loginOpen: true,
      menuOpen: true,
      showAutocomplete: true,
      pasteInfoOpen: true,
    };
    expect(activePanel(all)).toBe('pasteInfo');
  });

  it('permission beats sessionPicker', () => {
    expect(activePanel(panels({ permissionOpen: true, sessionPickerOpen: true }))).toBe('permission');
  });

  it('confirm beats status', () => {
    expect(activePanel(panels({ confirmOpen: true, statusOpen: true }))).toBe('confirm');
  });

  it('menu beats autocomplete', () => {
    expect(activePanel(panels({ menuOpen: true, showAutocomplete: true }))).toBe('menu');
  });

  it('autocomplete is the lowest-priority panel (returns only when nothing else is open)', () => {
    expect(activePanel(panels({ showAutocomplete: true }))).toBe('autocomplete');
    expect(activePanel(panels({ showAutocomplete: true, menuOpen: true }))).toBe('menu');
  });
});

// ─── input display ───────────────────────────────────────────────────────────
import {
  inputPromptSymbol,
  inputViewport,
  computeInputDisplay,
  type InputDisplayOptions,
} from './layout';

describe('inputPromptSymbol', () => {
  it('returns the plain ❯ prompt for a single-line value', () => {
    expect(inputPromptSymbol('hi', false)).toBe('❯ ');
  });

  it('returns ❯❯ in multi-line mode for a single-line value', () => {
    expect(inputPromptSymbol('hi', true)).toBe('❯❯ ');
  });

  it('returns the [n] ❯ prefix when the value spans multiple lines', () => {
    expect(inputPromptSymbol('a\nb', false)).toBe('[2] ❯ ');
    expect(inputPromptSymbol('a\nb\nc\nd', true)).toBe('[4] ❯ ');
  });

  it('multi-line content wins over the multi-line mode flag', () => {
    expect(inputPromptSymbol('a\nb', true)).toBe('[2] ❯ ');
  });

  it('handles an empty value as a single line', () => {
    expect(inputPromptSymbol('', false)).toBe('❯ ');
    expect(inputPromptSymbol('', true)).toBe('❯❯ ');
  });
});

describe('inputViewport', () => {
  it('returns the whole line when it fits', () => {
    const out = inputViewport({ line: 'abc', cursorInLine: 1, maxInputWidth: 80 });
    expect(out.displayValue).toBe('abc');
    expect(out.cursorOffset).toBe(1);
  });

  it('places the cursor at the line start when cursorInLine is 0', () => {
    const out = inputViewport({ line: 'abc', cursorInLine: 0, maxInputWidth: 80 });
    expect(out.cursorOffset).toBe(0);
  });

  it('clamps a negative cursorInLine to 0', () => {
    const out = inputViewport({ line: 'abc', cursorInLine: -5, maxInputWidth: 80 });
    expect(out.cursorOffset).toBe(0);
  });

  it('truncates from the right when the line is longer than maxInputWidth', () => {
    const line = 'abcdefghij';
    const out = inputViewport({ line, cursorInLine: 0, maxInputWidth: 4 });
    // No leading ellipsis because visibleStart is 0.
    expect(out.displayValue).toBe('abcd');
    expect(out.cursorOffset).toBe(0);
  });

  it('adds a leading ellipsis and slides the viewport when the cursor is past the anchor', () => {
    const line = 'abcdefghijklmnopqrstuvwxyz';
    // maxInputWidth 10, cursor at 20 → visibleStart = 20 - floor(10*0.7) = 20 - 7 = 13.
    const out = inputViewport({ line, cursorInLine: 20, maxInputWidth: 10 });
    expect(out.displayValue.startsWith('…')).toBe(true);
    // The cursor should sit 7 chars from the visibleStart.
    expect(out.cursorOffset).toBe(20 - 13);
  });

  it('keeps the cursor offset non-negative even at the start of a long line', () => {
    const out = inputViewport({ line: 'x'.repeat(100), cursorInLine: 0, maxInputWidth: 10 });
    expect(out.cursorOffset).toBe(0);
  });

  it('handles a line exactly at maxInputWidth without truncation', () => {
    const line = 'abcd';
    const out = inputViewport({ line, cursorInLine: 4, maxInputWidth: 4 });
    expect(out.displayValue).toBe('abcd');
  });
});

describe('computeInputDisplay', () => {
  function opts(overrides: Partial<InputDisplayOptions> = {}): InputDisplayOptions {
    return { value: '', cursorPos: 0, width: 80, isMultilineMode: false, ...overrides };
  }

  it('marks the display as empty and returns the placeholder when value is blank', () => {
    const d = computeInputDisplay(opts());
    expect(d.isEmpty).toBe(true);
    expect(d.displayValue).toBe('');
    expect(d.placeholder).toBe('Message or /command');
    expect(d.cursorX).toBe(d.promptSymbol.length);
  });

  it('uses the multi-line placeholder in multi-line mode', () => {
    const d = computeInputDisplay(opts({ isMultilineMode: true }));
    expect(d.placeholder).toContain('Multi-line mode');
  });

  it('returns the full short value when it fits', () => {
    const d = computeInputDisplay(opts({ value: 'hello', cursorPos: 5 }));
    expect(d.isEmpty).toBe(false);
    expect(d.displayValue).toBe('hello');
    expect(d.cursorX).toBe(d.promptSymbol.length + 5);
  });

  it('shows the last line when the value spans multiple lines', () => {
    const d = computeInputDisplay(opts({ value: 'first\nsecond\nthird', cursorPos: 17 }));
    expect(d.promptSymbol).toBe('[3] ❯ ');
    expect(d.displayValue).toBe('third');
  });

  it('computes the cursor relative to the last line', () => {
    // value "first\nsecond", cursor at end (offset 11) → last line "second" (6 chars),
    // cursorInLine = 11 - 6 = 5.
    const d = computeInputDisplay(opts({ value: 'first\nsecond', cursorPos: 11 }));
    expect(d.cursorX).toBe(d.promptSymbol.length + 5);
  });

  it('truncates long values using the viewport logic', () => {
    const long = 'x'.repeat(200);
    const d = computeInputDisplay(opts({ value: long, cursorPos: 200, width: 20 }));
    expect(d.displayValue.length).toBeLessThanOrEqual(20 - d.promptSymbol.length);
    expect(d.displayValue.startsWith('…')).toBe(true);
  });

  it('uses the multi-line prompt symbol when the value has newlines', () => {
    const d = computeInputDisplay(opts({ value: 'a\nb', cursorPos: 3 }));
    expect(d.promptSymbol).toBe('[2] ❯ ');
  });

  it('respects the width parameter for the max input width', () => {
    const d = computeInputDisplay(opts({ value: 'abcdefghij', cursorPos: 5, width: 10 }));
    // promptSymbol "❯ " is 2 chars, so maxInputWidth = 10 - 2 - 1 = 7.
    expect(d.displayValue.length).toBeLessThanOrEqual(7);
  });

  it('keeps the cursor X within the prompt + visible window', () => {
    const d = computeInputDisplay(opts({ value: 'hello world', cursorPos: 11, width: 80 }));
    expect(d.cursorX).toBeGreaterThanOrEqual(d.promptSymbol.length);
    expect(d.cursorX).toBeLessThanOrEqual(80);
  });
});

describe('bottomPanelHeight — @mention picker', () => {
  // The picker paints a separator, a title, up to 8 rows and a footer. It was
  // missing from the snapshot entirely, so the panel measured 0 while those
  // rows were still drawn — straight over the bottom of the transcript.
  it('reserves rows for the mention picker when it is open', () => {
    expect(bottomPanelHeight(snapshot({ mentionPickerOpen: true, mentionItemCount: 5 }))).toBe(8);
  });

  it('caps at the 8 visible rows the renderer actually draws', () => {
    expect(bottomPanelHeight(snapshot({ mentionPickerOpen: true, mentionItemCount: 50 }))).toBe(11);
  });

  it('reserves nothing when the picker is closed or empty', () => {
    expect(bottomPanelHeight(snapshot({ mentionPickerOpen: false, mentionItemCount: 5 }))).toBe(0);
    expect(bottomPanelHeight(snapshot({ mentionPickerOpen: true, mentionItemCount: 0 }))).toBe(0);
  });
});
