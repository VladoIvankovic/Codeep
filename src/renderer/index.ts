/**
 * Custom Terminal Renderer
 * 
 * A lightweight alternative to Ink for terminal UIs.
 * Uses direct ANSI escape codes and a virtual screen buffer
 * with diff-based rendering for flicker-free updates.
 */

export { cursor, screen, fg, bg, style, styled, stripAnsi, visibleLength, truncate, wordWrap } from './ansi';
export { Screen, Cell } from './Screen';
export { Input, LineEditor, KeyEvent, KeyHandler } from './Input';
export { ChatUI, ChatMessage, ChatUIOptions } from './ChatUI';
export { App, AppOptions, Message } from './App';

// Components
export { createBox, centerBox, BoxStyle, BoxOptions } from './components/Box';
export { renderModal, renderHelpModal, renderListModal, ModalOptions } from './components/Modal';
export { renderHelpScreen, helpCategories, keyboardShortcuts } from './components/Help';
export { renderStatusScreen, StatusInfo } from './components/Status';
