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
 * Read image from clipboard as base64 data URL, or null if no image present.
 */
export function readImageFromClipboard(): string | null {
  try {
    if (process.platform === 'darwin') {
      const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
      const tmpPath = '/tmp/codeep_clipboard_img.png';
      const shPath = '/tmp/codeep_clipboard.sh';

      // Clean up leftovers
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }

      // Use bash heredoc — direct execSync('osascript') lacks clipboard access
      const shScript = `#!/bin/bash
osascript << 'EOF'
set imgData to (the clipboard as \u00ABclass PNGf\u00BB)
set f to open for access POSIX file "${tmpPath}" with write permission
set eof of f to 0
write imgData to f
close access f
EOF`;
      try {
        writeFileSync(shPath, shScript, 'utf-8');
        execSync(`/bin/bash "${shPath}"`, { stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { /* ignore */ }
      try { if (existsSync(shPath)) unlinkSync(shPath); } catch { /* ignore */ }

      if (existsSync(tmpPath)) {
        const data = readFileSync(tmpPath) as Buffer;
        unlinkSync(tmpPath);
        if (data.length > 100) return 'data:image/png;base64,' + data.toString('base64');
      }

      return null;
    } else if (process.platform === 'linux') {
      const data = execSync('xclip -selection clipboard -t image/png -o 2>/dev/null', { encoding: 'buffer' }) as Buffer;
      if (data.length > 0) return 'data:image/png;base64,' + data.toString('base64');
      return null;
    } else if (process.platform === 'win32') {
      const { existsSync, readFileSync, unlinkSync } = require('fs');
      const tmpPath = 'C:\\Temp\\codeep_clipboard_img.png';
      execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${tmpPath}', [System.Drawing.Imaging.ImageFormat]::Png) }"`, { encoding: 'utf-8' });
      if (existsSync(tmpPath)) {
        const data = readFileSync(tmpPath) as Buffer;
        unlinkSync(tmpPath);
        if (data.length > 0) return 'data:image/png;base64,' + data.toString('base64');
      }
      return null;
    }
    return null;
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
