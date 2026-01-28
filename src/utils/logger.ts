import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const GLOBAL_LOG_DIR = join(homedir(), '.codeep', 'logs');

// Ensure global log directory exists
if (!existsSync(GLOBAL_LOG_DIR)) {
  mkdirSync(GLOBAL_LOG_DIR, { recursive: true });
}

// Current project path for local logging
let currentProjectPath: string | null = null;

/**
 * Set current project path for local logging
 */
export function setLogProjectPath(projectPath: string | null): void {
  currentProjectPath = projectPath;
}

/**
 * Get local log directory for project
 */
function getLocalLogDir(projectPath: string): string {
  const logDir = join(projectPath, '.codeep', 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

/**
 * Check if path is a project directory
 */
function isProjectDirectory(path: string): boolean {
  return existsSync(join(path, 'package.json'));
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
}

/**
 * Get log file paths for today (global and optionally local)
 */
function getLogFilePaths(): { global: string; local?: string } {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `codeep-${date}.log`;
  
  const paths: { global: string; local?: string } = {
    global: join(GLOBAL_LOG_DIR, filename),
  };
  
  // Add local path if in a project
  if (currentProjectPath && isProjectDirectory(currentProjectPath)) {
    const localLogDir = getLocalLogDir(currentProjectPath);
    paths.local = join(localLogDir, filename);
  }
  
  return paths;
}

/**
 * Format log entry as string
 */
function formatLogEntry(entry: LogEntry): string {
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${dataStr}\n`;
}

/**
 * Write log entry to file(s)
 */
function writeLog(level: LogLevel, message: string, data?: any, localOnly: boolean = false): void {
  try {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };
    
    const logLine = formatLogEntry(entry);
    const paths = getLogFilePaths();
    
    // Always write to global log unless localOnly
    if (!localOnly) {
      appendFileSync(paths.global, logLine, 'utf-8');
    }
    
    // Write to local log if available
    if (paths.local) {
      appendFileSync(paths.local, logLine, 'utf-8');
    }
  } catch {
    // Silent fail - don't crash app if logging fails
    // Cannot use logger here as it would cause infinite recursion
  }
}

/**
 * Logger API
 */
export const logger = {
  info: (message: string, data?: any) => writeLog('info', message, data),
  warn: (message: string, data?: any) => writeLog('warn', message, data),
  error: (message: string, data?: any) => writeLog('error', message, data),
  debug: (message: string, data?: any) => writeLog('debug', message, data),
};

/**
 * Log API request (both global and local)
 */
export function logApiRequest(provider: string, model: string, messageCount: number): void {
  writeLog('info', 'API Request', { provider, model, messageCount });
}

/**
 * Log API response (both global and local)
 */
export function logApiResponse(provider: string, success: boolean, responseLength?: number, error?: string): void {
  if (success) {
    writeLog('info', 'API Response', { provider, success, responseLength });
  } else {
    writeLog('error', 'API Error', { provider, error });
  }
}

/**
 * Log session operation (local only - project-specific)
 */
export function logSession(operation: 'save' | 'load' | 'delete' | 'rename', sessionName: string, success: boolean): void {
  writeLog('info', `Session ${operation}`, { sessionName, success }, true);
}

/**
 * Log application startup
 */
export function logStartup(version: string): void {
  logger.info('Application started', { version });
}

/**
 * Log application error
 */
export function logAppError(error: Error, context?: string): void {
  logger.error('Application error', {
    context,
    message: error.message,
    stack: error.stack,
  });
}
