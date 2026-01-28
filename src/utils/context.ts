/**
 * Context persistence - save and load conversation context between sessions
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { Message } from '../config/index';
import { logger } from './logger';

// Context storage directory
const CONTEXT_DIR = join(homedir(), '.codeep', 'contexts');

export interface ConversationContext {
  id: string;
  projectPath: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  summary?: string;
}

/**
 * Ensure context directory exists
 */
function ensureContextDir(): void {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }
}

/**
 * Generate context ID from project path
 */
function generateContextId(projectPath: string): string {
  // Create a stable ID from project path
  return Buffer.from(projectPath).toString('base64url').substring(0, 32);
}

/**
 * Get context file path for a project
 */
function getContextPath(projectPath: string): string {
  ensureContextDir();
  const id = generateContextId(projectPath);
  return join(CONTEXT_DIR, `${id}.json`);
}

/**
 * Save conversation context for a project
 */
export function saveContext(
  projectPath: string,
  messages: Message[],
  summary?: string
): boolean {
  try {
    const contextPath = getContextPath(projectPath);
    const existing = loadContext(projectPath);
    
    const context: ConversationContext = {
      id: generateContextId(projectPath),
      projectPath,
      projectName: basename(projectPath),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages,
      summary,
    };
    
    writeFileSync(contextPath, JSON.stringify(context, null, 2));
    return true;
  } catch (error) {
    logger.error('Failed to save context', error as Error);
    return false;
  }
}

/**
 * Load conversation context for a project
 */
export function loadContext(projectPath: string): ConversationContext | null {
  try {
    const contextPath = getContextPath(projectPath);
    
    if (!existsSync(contextPath)) {
      return null;
    }
    
    const content = readFileSync(contextPath, 'utf-8');
    return JSON.parse(content) as ConversationContext;
  } catch (error) {
    logger.error('Failed to load context', error as Error);
    return null;
  }
}

/**
 * Clear context for a project
 */
export function clearContext(projectPath: string): boolean {
  try {
    const contextPath = getContextPath(projectPath);
    
    if (existsSync(contextPath)) {
      unlinkSync(contextPath);
    }
    
    return true;
  } catch (error) {
    logger.error('Failed to clear context', error as Error);
    return false;
  }
}

/**
 * Get all saved contexts
 */
export function getAllContexts(): ConversationContext[] {
  ensureContextDir();
  
  try {
    const files = readdirSync(CONTEXT_DIR)
      .filter(f => f.endsWith('.json'));
    
    const contexts: ConversationContext[] = [];
    
    for (const file of files) {
      try {
        const content = readFileSync(join(CONTEXT_DIR, file), 'utf-8');
        const context = JSON.parse(content) as ConversationContext;
        contexts.push(context);
      } catch {
        // Skip invalid files
      }
    }
    
    // Sort by most recent
    return contexts.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * Summarize messages for context persistence
 * Keeps recent messages and summarizes older ones
 */
export function summarizeContext(
  messages: Message[],
  maxMessages: number = 20
): { messages: Message[]; summary?: string } {
  if (messages.length <= maxMessages) {
    return { messages };
  }
  
  // Keep recent messages
  const recentMessages = messages.slice(-maxMessages);
  const oldMessages = messages.slice(0, -maxMessages);
  
  // Create summary of old messages
  const summary = createSummary(oldMessages);
  
  return {
    messages: recentMessages,
    summary,
  };
}

/**
 * Create a text summary of messages
 */
function createSummary(messages: Message[]): string {
  const lines: string[] = ['Previous conversation summary:'];
  
  for (const msg of messages) {
    if (msg.role === 'user') {
      // Extract key actions/questions
      const content = msg.content.slice(0, 100);
      lines.push(`- User: ${content}${msg.content.length > 100 ? '...' : ''}`);
    } else if (msg.role === 'assistant') {
      // Check for tool calls or key actions
      if (msg.content.includes('created') || msg.content.includes('modified')) {
        lines.push(`- Assistant: Made file changes`);
      } else if (msg.content.includes('executed')) {
        lines.push(`- Assistant: Executed commands`);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Merge loaded context with current conversation
 */
export function mergeContext(
  loaded: ConversationContext | null,
  currentMessages: Message[]
): Message[] {
  if (!loaded) {
    return currentMessages;
  }
  
  // If there's a summary, add it as a system message
  const messages: Message[] = [];
  
  if (loaded.summary) {
    messages.push({
      role: 'user',
      content: `[Context from previous session]\n${loaded.summary}`,
    });
    messages.push({
      role: 'assistant',
      content: 'I understand the previous context. How can I help you continue?',
    });
  }
  
  // Add loaded messages
  messages.push(...loaded.messages);
  
  // Add current messages
  messages.push(...currentMessages);
  
  return messages;
}

/**
 * Format context info for display
 */
export function formatContextInfo(context: ConversationContext): string {
  const date = new Date(context.updatedAt).toLocaleString();
  const messageCount = context.messages.length;
  
  return `Project: ${context.projectName}
Path: ${context.projectPath}
Last updated: ${date}
Messages: ${messageCount}${context.summary ? ' (+ summary)' : ''}`;
}

/**
 * Clear all contexts
 */
export function clearAllContexts(): number {
  ensureContextDir();
  
  let cleared = 0;
  
  try {
    const files = readdirSync(CONTEXT_DIR)
      .filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      try {
        unlinkSync(join(CONTEXT_DIR, file));
        cleared++;
      } catch {
        // Skip errors
      }
    }
  } catch {
    // Ignore errors
  }
  
  return cleared;
}
