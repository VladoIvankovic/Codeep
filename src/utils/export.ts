import { Message } from '../config/index';
import { writeFileSync } from 'fs';
import { join } from 'path';

export type ExportFormat = 'md' | 'json' | 'txt';

export interface ExportOptions {
  format: ExportFormat;
  sessionName?: string;
  timestamp?: string;
}

/**
 * Export messages to Markdown format
 */
function exportToMarkdown(messages: Message[], sessionName?: string): string {
  const timestamp = new Date().toLocaleString('hr-HR');
  let markdown = `# Codeep Chat Export\n\n`;
  
  if (sessionName) {
    markdown += `**Session:** ${sessionName}\n`;
  }
  markdown += `**Exported:** ${timestamp}\n\n`;
  markdown += `---\n\n`;

  messages.forEach((message, index) => {
    const role = message.role === 'user' ? '👤 User' : '🤖 Assistant';
    markdown += `## ${role}\n\n`;
    markdown += `${message.content}\n\n`;
    
    if (index < messages.length - 1) {
      markdown += `---\n\n`;
    }
  });

  return markdown;
}

/**
 * Export messages to JSON format
 */
function exportToJson(messages: Message[], sessionName?: string): string {
  const exportData = {
    session: sessionName || 'Unnamed',
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages,
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Export messages to plain text format
 */
function exportToText(messages: Message[], sessionName?: string): string {
  const timestamp = new Date().toLocaleString('hr-HR');
  let text = `Codeep Chat Export\n`;
  text += `===================\n\n`;
  
  if (sessionName) {
    text += `Session: ${sessionName}\n`;
  }
  text += `Exported: ${timestamp}\n`;
  text += `Messages: ${messages.length}\n\n`;
  text += `===================\n\n`;

  messages.forEach((message, index) => {
    const role = message.role === 'user' ? 'USER' : 'ASSISTANT';
    text += `[${role}]\n`;
    text += `${message.content}\n\n`;
    
    if (index < messages.length - 1) {
      text += `---\n\n`;
    }
  });

  return text;
}

/**
 * Export messages to specified format
 */
export function exportMessages(
  messages: Message[],
  options: ExportOptions
): string {
  switch (options.format) {
    case 'md':
      return exportToMarkdown(messages, options.sessionName);
    case 'json':
      return exportToJson(messages, options.sessionName);
    case 'txt':
      return exportToText(messages, options.sessionName);
    default:
      throw new Error(`Unknown export format: ${options.format}`);
  }
}

/**
 * Save exported content to file
 */
export function saveExport(
  content: string,
  format: ExportFormat,
  outputPath: string,
  sessionName?: string
): { success: boolean; filePath: string; error?: string } {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const fileName = sessionName 
      ? `${sessionName}-${timestamp}.${format}`
      : `chat-export-${timestamp}.${format}`;
    
    const filePath = join(outputPath, fileName);
    writeFileSync(filePath, content, 'utf-8');
    
    return { success: true, filePath };
  } catch (error) {
    return { 
      success: false, 
      filePath: '', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}
