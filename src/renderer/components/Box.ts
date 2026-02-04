/**
 * Box drawing utilities for borders, frames, modals
 */

import { fg, style } from '../ansi';

// Box drawing characters (Unicode)
export const boxChars = {
  // Single line
  single: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
  },
  // Double line
  double: {
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    horizontal: '═',
    vertical: '║',
  },
  // Rounded
  rounded: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
  },
  // Heavy
  heavy: {
    topLeft: '┏',
    topRight: '┓',
    bottomLeft: '┗',
    bottomRight: '┛',
    horizontal: '━',
    vertical: '┃',
  },
};

export type BoxStyle = keyof typeof boxChars;

export interface BoxOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  style?: BoxStyle;
  title?: string;
  titleAlign?: 'left' | 'center' | 'right';
  borderColor?: string;
  titleColor?: string;
}

/**
 * Generate box lines for rendering
 */
export function createBox(options: BoxOptions): Array<{ y: number; text: string; style: string }> {
  const {
    x,
    y,
    width,
    height,
    style: boxStyle = 'single',
    title,
    titleAlign = 'center',
    borderColor = '',
    titleColor = '',
  } = options;

  const chars = boxChars[boxStyle];
  const lines: Array<{ y: number; text: string; style: string }> = [];

  // Top border with optional title
  let topLine = chars.topLeft + chars.horizontal.repeat(width - 2) + chars.topRight;
  
  if (title && width > 4) {
    const maxTitleLen = width - 4;
    const displayTitle = title.length > maxTitleLen ? title.slice(0, maxTitleLen - 1) + '…' : title;
    const titleWithPadding = ` ${displayTitle} `;
    
    let titlePos: number;
    if (titleAlign === 'left') {
      titlePos = 2;
    } else if (titleAlign === 'right') {
      titlePos = width - titleWithPadding.length - 2;
    } else {
      titlePos = Math.floor((width - titleWithPadding.length) / 2);
    }
    
    // Insert title into top line
    const before = chars.topLeft + chars.horizontal.repeat(titlePos - 1);
    const after = chars.horizontal.repeat(width - titlePos - titleWithPadding.length - 1) + chars.topRight;
    topLine = before + (titleColor || borderColor) + titleWithPadding + borderColor + after;
  }
  
  lines.push({ y, text: ' '.repeat(x) + topLine, style: borderColor });

  // Middle lines (empty content area)
  const emptyLine = chars.vertical + ' '.repeat(width - 2) + chars.vertical;
  for (let row = 1; row < height - 1; row++) {
    lines.push({ y: y + row, text: ' '.repeat(x) + emptyLine, style: borderColor });
  }

  // Bottom border
  const bottomLine = chars.bottomLeft + chars.horizontal.repeat(width - 2) + chars.bottomRight;
  lines.push({ y: y + height - 1, text: ' '.repeat(x) + bottomLine, style: borderColor });

  return lines;
}

/**
 * Center a box on screen
 */
export function centerBox(
  screenWidth: number,
  screenHeight: number,
  boxWidth: number,
  boxHeight: number
): { x: number; y: number } {
  return {
    x: Math.floor((screenWidth - boxWidth) / 2),
    y: Math.floor((screenHeight - boxHeight) / 2),
  };
}
