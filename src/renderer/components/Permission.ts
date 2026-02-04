/**
 * Permission screen for granting folder access
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { createBox, centerBox } from './Box';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);
const PRIMARY_BRIGHT = fg.rgb(255, 80, 85);

export type PermissionLevel = 'none' | 'read' | 'write';

export interface PermissionOptions {
  projectPath: string;
  isProject: boolean;
  currentPermission: PermissionLevel;
  onSelect: (permission: PermissionLevel) => void;
  onCancel: () => void;
}

/**
 * Render permission screen
 */
export function renderPermissionScreen(
  screen: Screen,
  options: PermissionOptions,
  selectedIndex: number
): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const title = '═══ Folder Access ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 1, title, PRIMARY_COLOR + style.bold);
  
  // Box
  const boxWidth = Math.min(60, width - 4);
  const boxHeight = 14;
  const { x: boxX, y: boxY } = centerBox(width, height, boxWidth, boxHeight);
  
  const boxLines = createBox({
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: boxHeight,
    style: 'rounded',
    borderColor: PRIMARY_COLOR,
  });
  
  for (const line of boxLines) {
    screen.writeLine(line.y, line.text, line.style);
  }
  
  // Content
  const contentX = boxX + 3;
  let contentY = boxY + 2;
  
  // Project path
  const displayPath = truncatePath(options.projectPath, boxWidth - 8);
  screen.write(contentX, contentY, 'Project:', fg.gray);
  screen.write(contentX + 9, contentY, displayPath, fg.white);
  contentY += 2;
  
  // Description
  if (options.isProject) {
    screen.write(contentX, contentY, 'This looks like a project folder.', fg.white);
  } else {
    screen.write(contentX, contentY, 'Grant access to enable AI assistance.', fg.white);
  }
  contentY += 2;
  
  // Options
  const permissionOptions = [
    { 
      level: 'read' as PermissionLevel, 
      label: 'Read Only', 
      desc: 'AI can read files, no modifications' 
    },
    { 
      level: 'write' as PermissionLevel, 
      label: 'Read & Write', 
      desc: 'AI can read and modify files (Agent mode)' 
    },
    { 
      level: 'none' as PermissionLevel, 
      label: 'No Access', 
      desc: 'Chat without project context' 
    },
  ];
  
  for (let i = 0; i < permissionOptions.length; i++) {
    const opt = permissionOptions[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? '► ' : '  ';
    
    // Label
    const labelStyle = isSelected ? PRIMARY_BRIGHT + style.bold : fg.white;
    screen.write(contentX, contentY, prefix + opt.label, labelStyle);
    
    // Description on same line
    const descX = contentX + 20;
    screen.write(descX, contentY, opt.desc, fg.gray);
    
    contentY++;
  }
  
  // Current permission indicator
  contentY++;
  if (options.currentPermission !== 'none') {
    screen.write(contentX, contentY, `Current: ${options.currentPermission}`, fg.yellow);
  }
  
  // Footer
  const footerY = height - 2;
  screen.write(2, footerY, '↑↓ Navigate | Enter Select | Esc Skip', fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}

/**
 * Get permission options array for easy indexing
 */
export function getPermissionOptions(): PermissionLevel[] {
  return ['read', 'write', 'none'];
}

/**
 * Truncate path for display
 */
function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  
  const parts = path.split('/');
  let result = parts[parts.length - 1];
  
  for (let i = parts.length - 2; i >= 0; i--) {
    const newResult = parts[i] + '/' + result;
    if (newResult.length + 3 > maxLen) {
      return '.../' + result;
    }
    result = newResult;
  }
  
  return result;
}
