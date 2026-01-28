/**
 * Input validation and sanitization utilities
 */

const MAX_INPUT_LENGTH = 50000; // ~50KB max input
const MAX_LINES = 5000;

export interface ValidationResult {
  valid: boolean;
  sanitized?: string;
  error?: string;
}

/**
 * Validate and sanitize user input before sending to API
 */
export function validateInput(input: string): ValidationResult {
  // Check for empty input
  if (!input || input.trim().length === 0) {
    return {
      valid: false,
      error: 'Input cannot be empty',
    };
  }

  // Check length
  if (input.length > MAX_INPUT_LENGTH) {
    return {
      valid: false,
      error: `Input too long (max ${MAX_INPUT_LENGTH} characters)`,
    };
  }

  // Check line count
  const lines = input.split('\n');
  if (lines.length > MAX_LINES) {
    return {
      valid: false,
      error: `Too many lines (max ${MAX_LINES} lines)`,
    };
  }

  // Sanitize: remove null bytes and other control characters (except newlines, tabs)
  let sanitized = input
    .replace(/\0/g, '') // Remove null bytes
    .replace(/[\x01-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ''); // Remove other control chars

  // Trim excessive whitespace (but preserve intentional formatting)
  sanitized = sanitized.replace(/\n{5,}/g, '\n\n\n\n'); // Max 4 consecutive newlines

  return {
    valid: true,
    sanitized,
  };
}

/**
 * Validate API key format
 */
export function validateApiKey(key: string): ValidationResult {
  if (!key || key.trim().length === 0) {
    return {
      valid: false,
      error: 'API key cannot be empty',
    };
  }

  // Basic format check - most API keys are alphanumeric with some special chars
  const keyPattern = /^[a-zA-Z0-9._-]+$/;
  if (!keyPattern.test(key)) {
    return {
      valid: false,
      error: 'API key contains invalid characters',
    };
  }

  // Length check - most API keys are 20-100 characters
  if (key.length < 10 || key.length > 200) {
    return {
      valid: false,
      error: 'API key length invalid (expected 10-200 characters)',
    };
  }

  return {
    valid: true,
    sanitized: key.trim(),
  };
}

/**
 * Validate command arguments
 */
export function validateCommandArgs(command: string, args: string[]): ValidationResult {
  // Check for command injection attempts
  const dangerousPatterns = [
    /[;&|`$()]/,  // Shell metacharacters
    /\.\./,       // Path traversal
    /\beval\b/i,  // eval() attempts
    /\bexec\b/i,  // exec() attempts
  ];

  const fullCommand = [command, ...args].join(' ');

  for (const pattern of dangerousPatterns) {
    if (pattern.test(fullCommand)) {
      return {
        valid: false,
        error: 'Command contains potentially dangerous characters',
      };
    }
  }

  return {
    valid: true,
    sanitized: fullCommand,
  };
}

/**
 * Validate file path (for file operations)
 */
export function validateFilePath(path: string): ValidationResult {
  if (!path || path.trim().length === 0) {
    return {
      valid: false,
      error: 'File path cannot be empty',
    };
  }

  // Check for path traversal
  if (path.includes('..')) {
    return {
      valid: false,
      error: 'Path traversal not allowed',
    };
  }

  // Check for absolute paths outside project (basic check)
  if (path.startsWith('/etc/') || 
      path.startsWith('/sys/') || 
      path.startsWith('/proc/') ||
      path.startsWith('C:\\Windows\\') ||
      path.startsWith('C:\\System')) {
    return {
      valid: false,
      error: 'Access to system paths not allowed',
    };
  }

  return {
    valid: true,
    sanitized: path.trim(),
  };
}

/**
 * Sanitize output before display (prevent terminal escape sequence injection)
 */
export function sanitizeOutput(output: string): string {
  // Remove ANSI escape sequences that could be malicious
  // Keep basic formatting codes but remove cursor movement, clear screen, etc.
  return output
    .replace(/\x1b\[(\d+;)*\d*[ABCDEFGHJKSTfmsu]/g, '') // Remove cursor control
    .replace(/\x1b\].*?\x07/g, '') // Remove OSC sequences
    .replace(/\x1b\[.*?~/g, ''); // Remove other escape sequences
}
