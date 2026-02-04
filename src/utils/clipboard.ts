/**
 * Clipboard utilities
 */

import { execSync } from 'child_process';

/**
 * Copy text to clipboard
 */
export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'darwin') {
      // macOS
      execSync('pbcopy', { input: text, encoding: 'utf-8' });
    } else if (process.platform === 'linux') {
      // Linux - try xclip first, then xsel
      try {
        execSync('xclip -selection clipboard', { input: text, encoding: 'utf-8' });
      } catch {
        execSync('xsel --clipboard --input', { input: text, encoding: 'utf-8' });
      }
    } else if (process.platform === 'win32') {
      // Windows
      execSync('clip', { input: text, encoding: 'utf-8' });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read text from clipboard
 */
export function readFromClipboard(): string | null {
  try {
    let result: string;
    
    if (process.platform === 'darwin') {
      // macOS
      result = execSync('pbpaste', { encoding: 'utf-8' });
    } else if (process.platform === 'linux') {
      // Linux - try xclip first, then xsel
      try {
        result = execSync('xclip -selection clipboard -o', { encoding: 'utf-8' });
      } catch {
        result = execSync('xsel --clipboard --output', { encoding: 'utf-8' });
      }
    } else if (process.platform === 'win32') {
      // Windows - use PowerShell
      result = execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8' });
    } else {
      return null;
    }
    
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Check if clipboard is available
 */
export function isClipboardAvailable(): boolean {
  try {
    if (process.platform === 'darwin') {
      execSync('which pbcopy', { encoding: 'utf-8' });
      return true;
    } else if (process.platform === 'linux') {
      try {
        execSync('which xclip', { encoding: 'utf-8' });
        return true;
      } catch {
        execSync('which xsel', { encoding: 'utf-8' });
        return true;
      }
    } else if (process.platform === 'win32') {
      return true; // clip is always available on Windows
    }
    return false;
  } catch {
    return false;
  }
}
