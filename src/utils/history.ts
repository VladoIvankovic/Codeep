/**
 * Agent action history for undo/rollback functionality
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync, statSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

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
  /** Hash of what the agent left in the file (write/edit). Undo only puts
   *  the old content back while the file still holds exactly that. */
  resultHash?: string;
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

// The last finished run that changed something. Every run ends before the
// user can type /undo, so undo has to reach back to it.
let lastSession: ActionSession | null = null;

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

function writeSessionFile(session: ActionSession): void {
  ensureHistoryDir();
  writeFileSync(join(HISTORY_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

/** Whether a run recorded anything undo can put back. Commands never can. */
function hasFileActions(session: ActionSession): boolean {
  return session.actions.some(a => a.type !== 'command');
}

/**
 * The session undo and the change listings act on: the run in progress, or
 * else the last finished run that changed something.
 *
 * A run in progress that has not touched a file yet does not hide the
 * finished one: /undo typed while a run is still winding down would
 * otherwise find nothing. `projectRoot` keeps one workspace's /undo away
 * from a run in another; without it any run is in reach.
 */
function undoableSession(projectRoot?: string): ActionSession | null {
  const inScope = (session: ActionSession | null): ActionSession | null =>
    session && (projectRoot === undefined || resolve(session.projectRoot) === resolve(projectRoot))
      ? session
      : null;
  const current = inScope(currentSession);
  if (current && hasFileActions(current)) return current;
  return inScope(lastSession) ?? current;
}

/**
 * Keep a finished run's saved record in step with what has been undone.
 * The run in progress is written when it ends.
 */
function saveUndone(session: ActionSession): void {
  if (session === currentSession) return;
  try {
    writeSessionFile(session);
  } catch {
    // The files are already restored. A record that could not be updated
    // must not turn that into a reported failure.
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
    writeSessionFile(currentSession);
  }
  // Only a run that changed a file replaces the one to undo: a read-only or
  // command-only follow-up must not put the previous edits out of reach.
  if (hasFileActions(currentSession)) {
    lastSession = currentSession;
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

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Note what a write or edit left in the file, once it happened.
 */
export function recordResult(record: ActionRecord | null | undefined, content: string): void {
  if (record) record.resultHash = contentHash(content);
}

/**
 * Why putting a file back would lose someone else's change, or null. The
 * user (or a later command) may have edited the file since the run; undo
 * must not overwrite that, or delete a file that has become theirs.
 */
function changedSince(action: ActionRecord): string | null {
  const path = action.path!;
  if ((action.type === 'write' || action.type === 'edit') && action.resultHash !== undefined && existsSync(path)) {
    let now: string | null = null;
    try { now = readFileSync(path, 'utf-8'); } catch { /* unreadable: treat as changed */ }
    if (now === null || contentHash(now) !== action.resultHash) {
      return `Not undone: ${path} has changed since the agent wrote it. Use git to restore it if you need to.`;
    }
  }
  if (action.type === 'delete' && !action.wasDirectory && existsSync(path)) {
    return `Not undone: ${path} exists again, and restoring the deleted copy would overwrite it.`;
  }
  return null;
}

/**
 * Drop a record whose change never happened (the write failed or the
 * editor refused it). Left in place, undo would write its saved content
 * over whatever the file holds by then.
 */
export function discardAction(record: ActionRecord | null | undefined): void {
  if (!record || !currentSession) return;
  const i = currentSession.actions.indexOf(record);
  if (i !== -1) currentSession.actions.splice(i, 1);
}

/**
 * Get the run in progress, or else the last finished run that changed
 * something. Pass the workspace to leave out runs from another one.
 */
export function getCurrentSession(projectRoot?: string): ActionSession | null {
  return undoableSession(projectRoot);
}

/**
 * Undo the most recent file change of the run undo acts on. Pass the
 * workspace the user is in so a run in another one is left alone.
 */
export function undoLastAction(projectRoot?: string): { success: boolean; message: string } {
  const session = undoableSession(projectRoot);
  if (!session || session.actions.length === 0) {
    return { success: false, message: 'No actions to undo' };
  }
  
  // Commands cannot be undone, so they are passed over: a run that edits and
  // then runs the tests must still have its edits undoable.
  const pending = [...session.actions].reverse().filter(a => !a.undone);
  const action = pending.find(a => a.type !== 'command');
  if (!action) {
    // Only commands are left. Once the file changes are undone that is
    // "all undone"; a run that only ran commands says why nothing happens.
    return hasFileActions(session) || pending.length === 0
      ? { success: false, message: 'All actions already undone' }
      : undoAction(pending[0]);
  }
  
  const result = undoAction(action);
  if (result.success) saveUndone(session);
  return result;
}

/**
 * Undo a specific action
 */
export function undoAction(action: ActionRecord): { success: boolean; message: string } {
  try {
    const conflict = action.path ? changedSince(action) : null;
    if (conflict) return { success: false, message: conflict };
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
          // Only remove if empty (rmdirSync refuses anything else)
          try {
            rmdirSync(action.path!);
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
 * Undo every action of the run undo acts on. Pass the workspace the user is
 * in so a run in another one is left alone.
 */
export function undoAllActions(projectRoot?: string): { success: boolean; results: string[] } {
  const session = undoableSession(projectRoot);
  if (!session || session.actions.length === 0) {
    return { success: false, results: ['No actions to undo'] };
  }
  
  const results: string[] = [];
  let restored = 0;
  
  // Undo in reverse order
  const actions = [...session.actions].reverse();
  for (const action of actions) {
    if (action.undone) continue;
    
    const result = undoAction(action);
    results.push(result.message);
    if (result.success) restored++;
  }
  
  if (restored > 0) saveUndone(session);
  // Success means something was put back. A command in the run can never be
  // undone, and must not make restored files read as "Nothing to undo".
  return { success: restored > 0, results };
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
  // The finished run's record goes with the files.
  lastSession = null;
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
