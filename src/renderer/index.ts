/**
 * Custom Terminal Renderer
 * 
 * A lightweight alternative to Ink for terminal UIs.
 * Uses direct ANSI escape codes and a virtual screen buffer
 * with diff-based rendering for flicker-free updates.
 */

export { cursor, screen, fg, bg, style, styled, stripAnsi, visibleLength, truncate, wordWrap } from './ansi';
export { Screen } from './Screen';
export type { Cell } from './Screen';
export { Input, LineEditor } from './Input';
export type { KeyEvent, KeyHandler } from './Input';
export { App } from './App';
export type { AppOptions, Message } from './App';

// Components
export { createBox, centerBox } from './components/Box';
export type { BoxStyle, BoxOptions } from './components/Box';
export { renderModal, renderHelpModal, renderListModal } from './components/Modal';
export type { ModalOptions } from './components/Modal';
export { helpCategories, keyboardShortcuts } from './components/Help';
export { renderStatusScreen } from './components/Status';
export type { StatusInfo } from './components/Status';
