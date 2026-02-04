/**
 * Status screen component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { createBox, centerBox } from './Box';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

export interface StatusInfo {
  version: string;
  provider: string;
  model: string;
  agentMode: string;
  projectPath: string;
  hasWriteAccess: boolean;
  sessionId: string;
  messageCount: number;
}

/**
 * Render status screen
 */
export function renderStatusScreen(screen: Screen, status: StatusInfo): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const title = '═══ Codeep Status ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 0, title, PRIMARY_COLOR + style.bold);
  
  // Status items
  const items = [
    { label: 'Version', value: `v${status.version}` },
    { label: 'Provider', value: status.provider },
    { label: 'Model', value: status.model },
    { label: 'Agent Mode', value: status.agentMode.toUpperCase(), color: status.agentMode === 'on' ? fg.green : status.agentMode === 'manual' ? fg.yellow : fg.gray },
    { label: 'Project', value: truncatePath(status.projectPath, 40) },
    { label: 'Write Access', value: status.hasWriteAccess ? 'Yes' : 'No', color: status.hasWriteAccess ? fg.green : fg.red },
    { label: 'Session', value: status.sessionId || 'New' },
    { label: 'Messages', value: status.messageCount.toString() },
  ];
  
  // Calculate layout
  const labelWidth = Math.max(...items.map(i => i.label.length)) + 2;
  const contentStartY = 3;
  
  // Render items
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const y = contentStartY + i;
    
    // Label
    screen.write(4, y, item.label + ':', fg.gray);
    
    // Value
    const valueColor = item.color || fg.white;
    screen.write(4 + labelWidth, y, item.value, valueColor);
  }
  
  // System info
  const sysInfoY = contentStartY + items.length + 2;
  screen.write(4, sysInfoY, 'System', fg.yellow + style.bold);
  
  const sysItems = [
    { label: 'Platform', value: process.platform },
    { label: 'Node', value: process.version },
    { label: 'Terminal', value: `${width}x${height}` },
  ];
  
  for (let i = 0; i < sysItems.length; i++) {
    const item = sysItems[i];
    const y = sysInfoY + 1 + i;
    screen.write(4, y, item.label + ':', fg.gray);
    screen.write(4 + labelWidth, y, item.value, fg.white);
  }
  
  // Footer
  const footerY = height - 1;
  screen.write(2, footerY, 'Press Esc to close', fg.gray);
  
  screen.showCursor(false);
  screen.fullRender();
}

/**
 * Truncate path for display
 */
function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  
  // Try to keep the end of the path
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
