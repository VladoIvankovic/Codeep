/**
 * Agent action history for undo/rollback functionality
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, statSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// Types of reversible actions
export interface ActionRecord {
  id: string;
  timestamp: number;
  type: 'write' | 'edit' | 'delete' | 'mkdir' | 'command';
  path?: string;
  // For undo
  previousContent?: string;      // Content before write/edit
  previousExisted?: boolean;     // Did file exist before?
  wasDirectory?: boolean;        // Was it a directory?
  deletedContent?: string;       // Content of deleted file
  // Command info
  command?: string;
  args?: string[];
  // Status
  undone?: boolean;
}

export interface ActionSession {
  id: string;
  startTime: number;
  endTime?: number;
  prompt: string;
  actions: ActionRecord[];
  projectRoot: string;
}

// In-memory current session
let currentSession: ActionSession | null = null;

// History storage path
const HISTORY_DIR = join(homedir(), '.codeep', 'history');

/**
 * Initialize history directory
 */
function ensureHistoryDir(): void {
  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

/**
 * Generate unique ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Start a new action session
 */
export function startSession(prompt: string, projectRoot: string): string {
  const sessionId = generateId();
  currentSession = {
    id: sessionId,
    startTime: Date.now(),
    prompt,
    actions: [],
    projectRoot,
  };
  return sessionId;
}

/**
 * End current session and save to disk
 */
export function endSession(): void {
  if (!currentSession) return;
  
  currentSession.endTime = Date.now();
  
  // Only save if there were actions
  if (currentSession.actions.length > 0) {
    ensureHistoryDir();
    const filename = `${currentSession.id}.json`;
    const filepath = join(HISTORY_DIR, filename);
    writeFileSync(filepath, JSON.stringify(currentSession, null, 2));
  }
  
  currentSession = null;
}

/**
 * Record a file write action (before it happens)
 */
export function recordWrite(path: string): ActionRecord | null {
  if (!currentSession) return null;
  
  const record: ActionRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'write',
    path,
    previousExisted: existsSync(path),
  };
  
  // Save previous content if file existed
  if (record.previousExisted) {
    try {
      record.previousContent = readFileSync(path, 'utf-8');
    } catch {
      // Could be binary or unreadable
    }
  }
  
  currentSession.actions.push(record);
  return record;
}

/**
 * Record a file edit action (before it happens)
 */
export function recordEdit(path: string): ActionRecord | null {
  if (!currentSession) return null;
  
  const record: ActionRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'edit',
    path,
    previousExisted: true,
  };
  
  // Save previous content
  try {
    record.previousContent = readFileSync(path, 'utf-8');
  } catch {
    // Could be binary or unreadable
  }
  
  currentSession.actions.push(record);
  return record;
}

/**
 * Record a file/directory delete action (before it happens)
 */
export function recordDelete(path: string): ActionRecord | null {
  if (!currentSession) return null;
  
  const record: ActionRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'delete',
    path,
    previousExisted: true,
  };
  
  try {
    const stat = statSync(path);
    record.wasDirectory = stat.isDirectory();
    
    if (!record.wasDirectory) {
      record.deletedContent = readFileSync(path, 'utf-8');
    }
    // Note: For directories, we can't easily restore all contents
    // User should use git for that
  } catch {
    // Ignore errors
  }
  
  currentSession.actions.push(record);
  return record;
}

/**
 * Record a mkdir action
 */
export function recordMkdir(path: string): ActionRecord | null {
  if (!currentSession) return null;
  
  const record: ActionRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'mkdir',
    path,
    previousExisted: existsSync(path),
  };
  
  currentSession.actions.push(record);
  return record;
}

/**
 * Record a command execution (can't be undone, but tracked)
 */
export function recordCommand(command: string, args: string[]): ActionRecord | null {
  if (!currentSession) return null;
  
  const record: ActionRecord = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'command',
    command,
    args,
  };
  
  currentSession.actions.push(record);
  return record;
}

/**
 * Get current session
 */
export function getCurrentSession(): ActionSession | null {
  return currentSession;
}

/**
 * Undo the last action in current session
 */
export function undoLastAction(): { success: boolean; message: string } {
  if (!currentSession || currentSession.actions.length === 0) {
    return { success: false, message: 'No actions to undo' };
  }
  
  // Find last non-undone action
  const action = [...currentSession.actions].reverse().find(a => !a.undone);
  if (!action) {
    return { success: false, message: 'All actions already undone' };
  }
  
  return undoAction(action);
}

/**
 * Undo a specific action
 */
export function undoAction(action: ActionRecord): { success: boolean; message: string } {
  try {
    switch (action.type) {
      case 'write':
        if (action.previousExisted && action.previousContent !== undefined) {
          // Restore previous content
          writeFileSync(action.path!, action.previousContent);
          action.undone = true;
          return { success: true, message: `Restored: ${action.path}` };
        } else if (!action.previousExisted) {
          // Delete the newly created file
          if (existsSync(action.path!)) {
            unlinkSync(action.path!);
          }
          action.undone = true;
          return { success: true, message: `Deleted new file: ${action.path}` };
        }
        break;
        
      case 'edit':
        if (action.previousContent !== undefined) {
          writeFileSync(action.path!, action.previousContent);
          action.undone = true;
          return { success: true, message: `Restored: ${action.path}` };
        }
        break;
        
      case 'delete':
        if (action.deletedContent !== undefined) {
          // Recreate the file
          const dir = dirname(action.path!);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(action.path!, action.deletedContent);
          action.undone = true;
          return { success: true, message: `Restored deleted file: ${action.path}` };
        } else if (action.wasDirectory) {
          return { success: false, message: `Cannot restore directory: ${action.path}. Use git checkout.` };
        }
        break;
        
      case 'mkdir':
        if (!action.previousExisted && existsSync(action.path!)) {
          // Only remove if empty
          try {
            rmSync(action.path!, { recursive: false });
            action.undone = true;
            return { success: true, message: `Removed directory: ${action.path}` };
          } catch {
            return { success: false, message: `Cannot remove non-empty directory: ${action.path}` };
          }
        }
        break;
        
      case 'command':
        return { success: false, message: `Cannot undo command: ${action.command} ${action.args?.join(' ')}` };
    }
    
    return { success: false, message: 'Cannot undo this action' };
  } catch (error) {
    const err = error as Error;
    return { success: false, message: `Undo failed: ${err.message}` };
  }
}

/**
 * Undo all actions in current session
 */
export function undoAllActions(): { success: boolean; results: string[] } {
  if (!currentSession || currentSession.actions.length === 0) {
    return { success: false, results: ['No actions to undo'] };
  }
  
  const results: string[] = [];
  let allSuccess = true;
  
  // Undo in reverse order
  const actions = [...currentSession.actions].reverse();
  for (const action of actions) {
    if (action.undone) continue;
    
    const result = undoAction(action);
    results.push(result.message);
    if (!result.success) allSuccess = false;
  }
  
  return { success: allSuccess, results };
}

/**
 * Get list of recent sessions
 */
export function getRecentSessions(limit: number = 10): ActionSession[] {
  ensureHistoryDir();
  
  try {
    const files = readdirSync(HISTORY_DIR)
      .filter((f: string) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);
    
    return files.map((f: string) => {
      try {
        const content = readFileSync(join(HISTORY_DIR, f), 'utf-8');
        return JSON.parse(content) as ActionSession;
      } catch {
        return null;
      }
    }).filter(Boolean) as ActionSession[];
  } catch {
    return [];
  }
}

/**
 * Get a specific session by ID
 */
export function getSession(sessionId: string): ActionSession | null {
  const filepath = join(HISTORY_DIR, `${sessionId}.json`);
  
  if (!existsSync(filepath)) {
    return null;
  }
  
  try {
    const content = readFileSync(filepath, 'utf-8');
    return JSON.parse(content) as ActionSession;
  } catch {
    return null;
  }
}

/**
 * Format session for display
 */
export function formatSession(session: ActionSession): string {
  const date = new Date(session.startTime).toLocaleString();
  const duration = session.endTime 
    ? `${Math.round((session.endTime - session.startTime) / 1000)}s`
    : 'ongoing';
  
  const lines = [
    `Session: ${session.id}`,
    `Date: ${date}`,
    `Duration: ${duration}`,
    `Prompt: ${session.prompt.slice(0, 50)}${session.prompt.length > 50 ? '...' : ''}`,
    `Actions (${session.actions.length}):`,
  ];
  
  for (const action of session.actions) {
    const status = action.undone ? '↩️' : '✓';
    const target = action.path || `${action.command} ${action.args?.join(' ')}`;
    lines.push(`  ${status} ${action.type}: ${target}`);
  }
  
  return lines.join('\n');
}

/**
 * Clear all history
 */
export function clearHistory(): void {
  ensureHistoryDir();
  
  try {
    const files = readdirSync(HISTORY_DIR);
    for (const f of files) {
      unlinkSync(join(HISTORY_DIR, f));
    }
  } catch {
    // Ignore errors
  }
}
