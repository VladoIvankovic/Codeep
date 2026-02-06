/**
 * Generic fullscreen selection component
 * Used for Language, Provider, Model, Protocol selection
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { config } from '../../config/index';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);
const PRIMARY_BRIGHT = fg.rgb(255, 80, 85);

export interface SelectItem {
  key: string;
  label: string;
  description?: string;
}

export interface SelectScreenState {
  selectedIndex: number;
}

/**
 * Render a fullscreen selection screen
 */
export function renderSelectScreen(
  screen: Screen,
  title: string,
  items: SelectItem[],
  state: SelectScreenState,
  currentValue?: string
): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const titleText = `═══ ${title} ═══`;
  const titleX = Math.floor((width - titleText.length) / 2);
  screen.write(titleX, 0, titleText, PRIMARY_COLOR + style.bold);
  
  // Calculate visible items with scrolling
  const startY = 2;
  const maxVisible = height - 5; // Leave room for title and footer
  
  let scrollOffset = 0;
  if (items.length > maxVisible) {
    // Keep selected item in view
    if (state.selectedIndex >= maxVisible - 2) {
      scrollOffset = Math.min(
        state.selectedIndex - Math.floor(maxVisible / 2),
        items.length - maxVisible
      );
    }
  }
  
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxVisible);
  
  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const actualIndex = scrollOffset + i;
    const isSelected = actualIndex === state.selectedIndex;
    const isCurrent = item.key === currentValue;
    const y = startY + i;
    
    // Selection indicator
    const prefix = isSelected ? '► ' : '  ';
    
    // Current value indicator
    const currentIndicator = isCurrent ? ' ✓' : '';
    
    // Label
    const labelColor = isSelected ? PRIMARY_BRIGHT + style.bold : isCurrent ? fg.green : fg.white;
    
    screen.write(2, y, prefix, isSelected ? PRIMARY_COLOR : '');
    screen.write(4, y, item.label + currentIndicator, labelColor);
    
    // Description (if any)
    if (item.description && isSelected) {
      const descX = Math.max(4 + item.label.length + currentIndicator.length + 2, 30);
      if (descX + item.description.length < width - 2) {
        screen.write(descX, y, item.description, fg.gray);
      }
    }
  }
  
  // Scroll indicators
  if (scrollOffset > 0) {
    screen.write(width - 3, startY, '▲', fg.gray);
  }
  if (scrollOffset + maxVisible < items.length) {
    screen.write(width - 3, startY + maxVisible - 1, '▼', fg.gray);
  }
  
  // Footer
  const footerY = height - 1;
  screen.write(2, footerY, '↑/↓ Navigate | Enter Select | Esc Cancel', fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}

/**
 * Handle selection screen key
 */
export function handleSelectKey(
  key: string,
  state: SelectScreenState,
  itemCount: number
): { handled: boolean; close: boolean; select: boolean; newState: SelectScreenState } {
  const newState = { ...state };
  
  if (key === 'escape') {
    return { handled: true, close: true, select: false, newState };
  }
  
  if (key === 'up') {
    newState.selectedIndex = Math.max(0, state.selectedIndex - 1);
    return { handled: true, close: false, select: false, newState };
  }
  
  if (key === 'down') {
    newState.selectedIndex = Math.min(itemCount - 1, state.selectedIndex + 1);
    return { handled: true, close: false, select: false, newState };
  }
  
  if (key === 'enter') {
    return { handled: true, close: true, select: true, newState };
  }
  
  if (key === 'pageup') {
    newState.selectedIndex = Math.max(0, state.selectedIndex - 10);
    return { handled: true, close: false, select: false, newState };
  }
  
  if (key === 'pagedown') {
    newState.selectedIndex = Math.min(itemCount - 1, state.selectedIndex + 10);
    return { handled: true, close: false, select: false, newState };
  }
  
  if (key === 'home') {
    newState.selectedIndex = 0;
    return { handled: true, close: false, select: false, newState };
  }
  
  if (key === 'end') {
    newState.selectedIndex = itemCount - 1;
    return { handled: true, close: false, select: false, newState };
  }
  
  return { handled: false, close: false, select: false, newState };
}
