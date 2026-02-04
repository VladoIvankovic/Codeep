/**
 * Modal overlay component
 * Renders a box with content on top of existing screen
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { createBox, centerBox, BoxStyle } from './Box';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);
const PRIMARY_BRIGHT = fg.rgb(255, 80, 85);

export interface ModalOptions {
  title: string;
  content: string[];
  width?: number;
  height?: number;
  boxStyle?: BoxStyle;
  borderColor?: string;
  titleColor?: string;
  contentColor?: string;
  centered?: boolean;
  x?: number;
  y?: number;
}

export interface ModalAction {
  key: string;
  label: string;
  action: () => void;
}

/**
 * Render a modal on the screen
 */
export function renderModal(screen: Screen, options: ModalOptions): void {
  const { width: screenWidth, height: screenHeight } = screen.getSize();
  
  // Calculate dimensions
  const contentWidth = Math.max(...options.content.map(l => l.length), options.title.length + 4);
  const modalWidth = options.width || Math.min(contentWidth + 4, screenWidth - 4);
  const modalHeight = options.height || Math.min(options.content.length + 4, screenHeight - 4);
  
  // Calculate position
  let x: number, y: number;
  if (options.centered !== false) {
    const pos = centerBox(screenWidth, screenHeight, modalWidth, modalHeight);
    x = pos.x;
    y = pos.y;
  } else {
    x = options.x || 0;
    y = options.y || 0;
  }
  
  // Draw box
  const boxLines = createBox({
    x,
    y,
    width: modalWidth,
    height: modalHeight,
    style: options.boxStyle || 'rounded',
    title: options.title,
    borderColor: options.borderColor || PRIMARY_COLOR,
    titleColor: options.titleColor || PRIMARY_BRIGHT,
  });
  
  for (const line of boxLines) {
    screen.writeLine(line.y, line.text, line.style);
  }
  
  // Draw content
  const contentStartY = y + 1;
  const contentStartX = x + 2;
  const maxContentWidth = modalWidth - 4;
  
  for (let i = 0; i < options.content.length && i < modalHeight - 2; i++) {
    const line = options.content[i];
    const truncated = line.length > maxContentWidth 
      ? line.slice(0, maxContentWidth - 1) + '…'
      : line;
    
    screen.write(contentStartX, contentStartY + i, truncated, options.contentColor || '');
  }
}

/**
 * Render a help/info modal with key bindings
 */
export function renderHelpModal(
  screen: Screen,
  title: string,
  items: Array<{ key: string; description: string }>,
  footer?: string
): void {
  const { width: screenWidth, height: screenHeight } = screen.getSize();
  
  // Format content
  const content: string[] = [];
  const keyWidth = Math.max(...items.map(i => i.key.length)) + 2;
  
  for (const item of items) {
    const paddedKey = item.key.padEnd(keyWidth);
    content.push(`${paddedKey}${item.description}`);
  }
  
  if (footer) {
    content.push('');
    content.push(footer);
  }
  
  // Calculate size
  const contentWidth = Math.max(...content.map(l => l.length), title.length + 4);
  const modalWidth = Math.min(contentWidth + 6, screenWidth - 4);
  const modalHeight = Math.min(content.length + 4, screenHeight - 4);
  
  const { x, y } = centerBox(screenWidth, screenHeight, modalWidth, modalHeight);
  
  // Draw box
  const boxLines = createBox({
    x,
    y,
    width: modalWidth,
    height: modalHeight,
    style: 'rounded',
    title,
    borderColor: PRIMARY_COLOR,
    titleColor: PRIMARY_BRIGHT,
  });
  
  for (const line of boxLines) {
    screen.writeLine(line.y, line.text, line.style);
  }
  
  // Draw content with syntax highlighting for keys
  const contentStartY = y + 1;
  const contentStartX = x + 2;
  
  for (let i = 0; i < content.length && i < modalHeight - 2; i++) {
    const line = content[i];
    
    // Highlight key part (before the description)
    if (i < items.length) {
      const item = items[i];
      screen.write(contentStartX, contentStartY + i, item.key.padEnd(keyWidth), fg.yellow);
      screen.write(contentStartX + keyWidth, contentStartY + i, item.description, fg.white);
    } else {
      screen.write(contentStartX, contentStartY + i, line, fg.gray);
    }
  }
}

/**
 * Render a list selection modal
 */
export function renderListModal(
  screen: Screen,
  title: string,
  items: string[],
  selectedIndex: number,
  footer?: string
): void {
  const { width: screenWidth, height: screenHeight } = screen.getSize();
  
  // Calculate size - include footer in width calculation
  const contentWidth = Math.max(
    ...items.map(l => l.length + 4), 
    title.length + 4,
    footer ? footer.length + 2 : 0
  );
  const modalWidth = Math.min(contentWidth + 6, screenWidth - 4);
  const maxVisibleItems = screenHeight - 8;
  const modalHeight = Math.min(items.length + 4 + (footer ? 2 : 0), screenHeight - 4);
  
  const { x, y } = centerBox(screenWidth, screenHeight, modalWidth, modalHeight);
  
  // Draw box
  const boxLines = createBox({
    x,
    y,
    width: modalWidth,
    height: modalHeight,
    style: 'rounded',
    title,
    borderColor: PRIMARY_COLOR,
    titleColor: PRIMARY_BRIGHT,
  });
  
  for (const line of boxLines) {
    screen.writeLine(line.y, line.text, line.style);
  }
  
  // Calculate visible range (scroll if needed)
  let startIndex = 0;
  if (items.length > maxVisibleItems) {
    startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisibleItems / 2), items.length - maxVisibleItems));
  }
  
  // Draw items
  const contentStartY = y + 1;
  const contentStartX = x + 2;
  const visibleItems = items.slice(startIndex, startIndex + maxVisibleItems);
  
  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const actualIndex = startIndex + i;
    const isSelected = actualIndex === selectedIndex;
    
    const prefix = isSelected ? '► ' : '  ';
    const itemStyle = isSelected ? PRIMARY_BRIGHT + style.bold : fg.white;
    
    screen.write(contentStartX, contentStartY + i, prefix + item, itemStyle);
  }
  
  // Draw footer (truncate if needed)
  if (footer) {
    const maxFooterWidth = modalWidth - 4;
    const displayFooter = footer.length > maxFooterWidth 
      ? footer.slice(0, maxFooterWidth - 1) + '…'
      : footer;
    screen.write(contentStartX, y + modalHeight - 2, displayFooter, fg.gray);
  }
}
