import { describe, it, expect } from 'vitest';
import {
  validateInput,
  validateApiKey,
  validateCommandArgs,
  validateFilePath,
  sanitizeOutput,
} from './validation';

describe('validation utilities', () => {
  describe('validateInput', () => {
    it('should reject empty input', () => {
      expect(validateInput('').valid).toBe(false);
      expect(validateInput('   ').valid).toBe(false);
    });

    it('should accept valid input', () => {
      const result = validateInput('Hello, world!');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('Hello, world!');
    });

    it('should reject input exceeding max length', () => {
      const longInput = 'a'.repeat(60000);
      const result = validateInput(longInput);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject input with too many lines', () => {
      const manyLines = Array(6000).fill('line').join('\n');
      const result = validateInput(manyLines);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Too many lines');
    });

    it('should remove null bytes', () => {
      const result = validateInput('hello\0world');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('helloworld');
    });

    it('should remove control characters except newlines and tabs', () => {
      const result = validateInput('hello\x01\x02world\n\ttab');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('helloworld\n\ttab');
    });

    it('should limit consecutive newlines to 4', () => {
      const result = validateInput('hello\n\n\n\n\n\n\nworld');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('hello\n\n\n\nworld');
    });

    it('should preserve normal formatting', () => {
      const input = 'function test() {\n  return true;\n}';
      const result = validateInput(input);
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe(input);
    });
  });

  describe('validateApiKey', () => {
    it('should reject empty key', () => {
      expect(validateApiKey('').valid).toBe(false);
      expect(validateApiKey('   ').valid).toBe(false);
    });

    it('should accept valid API key', () => {
      const result = validateApiKey('sk-abcdef123456789012345');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('sk-abcdef123456789012345');
    });

    it('should reject key with invalid characters', () => {
      const result = validateApiKey('sk-test!@#$%');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should reject too short keys', () => {
      const result = validateApiKey('short');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('length invalid');
    });

    it('should reject too long keys', () => {
      const result = validateApiKey('a'.repeat(250));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('length invalid');
    });

    it('should reject keys with whitespace', () => {
      // API keys with leading/trailing spaces contain invalid characters
      const result = validateApiKey('  sk-validkey12345678  ');
      expect(result.valid).toBe(false);
    });

    it('should accept keys with dots, underscores, and dashes', () => {
      const result = validateApiKey('sk_test.key-123456789');
      expect(result.valid).toBe(true);
    });
  });

  describe('validateCommandArgs', () => {
    it('should accept safe commands', () => {
      const result = validateCommandArgs('help', []);
      expect(result.valid).toBe(true);
    });

    it('should reject shell metacharacters', () => {
      expect(validateCommandArgs('test', ['; rm -rf /']).valid).toBe(false);
      expect(validateCommandArgs('test', ['| cat /etc/passwd']).valid).toBe(false);
      expect(validateCommandArgs('test', ['`whoami`']).valid).toBe(false);
      expect(validateCommandArgs('test', ['$(id)']).valid).toBe(false);
      expect(validateCommandArgs('test', ['&& echo']).valid).toBe(false);
    });

    it('should reject path traversal', () => {
      const result = validateCommandArgs('read', ['../../etc/passwd']);
      expect(result.valid).toBe(false);
    });

    it('should reject eval attempts', () => {
      const result = validateCommandArgs('run', ['eval("code")', 'test']);
      expect(result.valid).toBe(false);
    });

    it('should reject exec attempts', () => {
      const result = validateCommandArgs('run', ['exec(cmd)']);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateFilePath', () => {
    it('should reject empty path', () => {
      expect(validateFilePath('').valid).toBe(false);
      expect(validateFilePath('   ').valid).toBe(false);
    });

    it('should accept valid paths', () => {
      expect(validateFilePath('src/index.ts').valid).toBe(true);
      expect(validateFilePath('./package.json').valid).toBe(true);
      expect(validateFilePath('utils/helper.js').valid).toBe(true);
    });

    it('should reject path traversal', () => {
      expect(validateFilePath('../secret.txt').valid).toBe(false);
      expect(validateFilePath('src/../../etc/passwd').valid).toBe(false);
      expect(validateFilePath('..').valid).toBe(false);
    });

    it('should reject system paths on Unix', () => {
      expect(validateFilePath('/etc/passwd').valid).toBe(false);
      expect(validateFilePath('/sys/kernel').valid).toBe(false);
      expect(validateFilePath('/proc/self').valid).toBe(false);
    });

    it('should reject system paths on Windows', () => {
      expect(validateFilePath('C:\\Windows\\System32').valid).toBe(false);
      expect(validateFilePath('C:\\System\\config').valid).toBe(false);
    });

    it('should trim whitespace', () => {
      const result = validateFilePath('  src/index.ts  ');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('src/index.ts');
    });
  });

  describe('sanitizeOutput', () => {
    it('should preserve normal text', () => {
      expect(sanitizeOutput('Hello, world!')).toBe('Hello, world!');
    });

    it('should remove cursor control sequences', () => {
      // Move cursor up
      expect(sanitizeOutput('text\x1b[2Amore')).toBe('textmore');
      // Move cursor down
      expect(sanitizeOutput('text\x1b[5Bmore')).toBe('textmore');
      // Clear screen
      expect(sanitizeOutput('text\x1b[2Jmore')).toBe('textmore');
    });

    it('should remove OSC sequences', () => {
      // Set window title
      expect(sanitizeOutput('text\x1b]0;malicious title\x07more')).toBe('textmore');
    });

    it('should handle multiple escape sequences', () => {
      const malicious = '\x1b[2J\x1b[H\x1b]0;pwned\x07dangerous content';
      const result = sanitizeOutput(malicious);
      expect(result).not.toContain('\x1b');
      expect(result).toContain('dangerous content');
    });

    it('should handle empty string', () => {
      expect(sanitizeOutput('')).toBe('');
    });
  });
});
