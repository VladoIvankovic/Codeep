import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isProjectDirectory,
  getProjectType,
  scanDirectory,
  generateTreeStructure,
  readProjectFile,
  deleteProjectFile,
  writeProjectFile,
} from './project';

const TEST_DIR = join(tmpdir(), 'codeep-project-test-' + Date.now());

describe('project utilities', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('isProjectDirectory', () => {
    it('should return true for directory with package.json', () => {
      writeFileSync(join(TEST_DIR, 'package.json'), '{}');
      expect(isProjectDirectory(TEST_DIR)).toBe(true);
    });

    it('should return true for directory with Cargo.toml', () => {
      writeFileSync(join(TEST_DIR, 'Cargo.toml'), '[package]');
      expect(isProjectDirectory(TEST_DIR)).toBe(true);
    });

    it('should return true for directory with go.mod', () => {
      writeFileSync(join(TEST_DIR, 'go.mod'), 'module test');
      expect(isProjectDirectory(TEST_DIR)).toBe(true);
    });

    it('should return true for directory with .git', () => {
      mkdirSync(join(TEST_DIR, '.git'), { recursive: true });
      expect(isProjectDirectory(TEST_DIR)).toBe(true);
    });

    it('should return false for empty directory', () => {
      expect(isProjectDirectory(TEST_DIR)).toBe(false);
    });
  });

  describe('getProjectType', () => {
    it('should detect TypeScript project', () => {
      writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
        devDependencies: { typescript: '^5.0.0' }
      }));
      expect(getProjectType(TEST_DIR)).toBe('TypeScript/Node.js');
    });

    it('should detect TypeScript project with tsconfig', () => {
      writeFileSync(join(TEST_DIR, 'package.json'), '{}');
      writeFileSync(join(TEST_DIR, 'tsconfig.json'), '{}');
      expect(getProjectType(TEST_DIR)).toBe('TypeScript/Node.js');
    });

    it('should detect JavaScript project', () => {
      writeFileSync(join(TEST_DIR, 'package.json'), '{}');
      expect(getProjectType(TEST_DIR)).toBe('JavaScript/Node.js');
    });

    it('should detect Rust project', () => {
      writeFileSync(join(TEST_DIR, 'Cargo.toml'), '[package]');
      expect(getProjectType(TEST_DIR)).toBe('Rust');
    });

    it('should detect Go project', () => {
      writeFileSync(join(TEST_DIR, 'go.mod'), 'module test');
      expect(getProjectType(TEST_DIR)).toBe('Go');
    });

    it('should detect Python project', () => {
      writeFileSync(join(TEST_DIR, 'requirements.txt'), 'flask');
      expect(getProjectType(TEST_DIR)).toBe('Python');
    });

    it('should return Unknown for unrecognized project', () => {
      expect(getProjectType(TEST_DIR)).toBe('Unknown');
    });
  });

  describe('scanDirectory', () => {
    it('should scan files in directory', () => {
      writeFileSync(join(TEST_DIR, 'index.ts'), 'export {}');
      writeFileSync(join(TEST_DIR, 'utils.js'), '// utils');
      writeFileSync(join(TEST_DIR, 'package.json'), '{}');
      
      const files = scanDirectory(TEST_DIR);
      const names = files.map(f => f.name);
      
      expect(names).toContain('index.ts');
      expect(names).toContain('utils.js');
      expect(names).toContain('package.json');
    });

    it('should ignore node_modules', () => {
      mkdirSync(join(TEST_DIR, 'node_modules'), { recursive: true });
      writeFileSync(join(TEST_DIR, 'node_modules', 'dep.js'), '// dep');
      writeFileSync(join(TEST_DIR, 'index.ts'), 'export {}');
      
      const files = scanDirectory(TEST_DIR);
      const paths = files.map(f => f.relativePath);
      
      expect(paths).not.toContain('node_modules/dep.js');
      expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    });

    it('should ignore .git directory', () => {
      mkdirSync(join(TEST_DIR, '.git'), { recursive: true });
      writeFileSync(join(TEST_DIR, '.git', 'config'), '# git config');
      
      const files = scanDirectory(TEST_DIR);
      const paths = files.map(f => f.relativePath);
      
      expect(paths.some(p => p.includes('.git'))).toBe(false);
    });

    it('should respect maxDepth', () => {
      mkdirSync(join(TEST_DIR, 'a', 'b', 'c', 'd'), { recursive: true });
      writeFileSync(join(TEST_DIR, 'a', 'b', 'c', 'd', 'deep.ts'), '// deep');
      writeFileSync(join(TEST_DIR, 'a', 'shallow.ts'), '// shallow');
      
      const files = scanDirectory(TEST_DIR, 2);
      const names = files.map(f => f.name);
      
      expect(names).toContain('shallow.ts');
      expect(names).not.toContain('deep.ts');
    });

    it('should include directories in results', () => {
      mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
      writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'export {}');
      
      const files = scanDirectory(TEST_DIR);
      const dirs = files.filter(f => f.isDirectory);
      
      expect(dirs.some(d => d.name === 'src')).toBe(true);
    });
  });

  describe('generateTreeStructure', () => {
    it('should generate tree structure', () => {
      mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
      writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'export {}');
      writeFileSync(join(TEST_DIR, 'package.json'), '{}');
      
      const files = scanDirectory(TEST_DIR);
      const tree = generateTreeStructure(files);
      
      expect(tree).toContain('src/');
      expect(tree).toContain('index.ts');
      expect(tree).toContain('package.json');
    });

    it('should truncate when exceeding maxLines', () => {
      // Create many files
      for (let i = 0; i < 50; i++) {
        writeFileSync(join(TEST_DIR, `file${i}.ts`), '// file');
      }
      
      const files = scanDirectory(TEST_DIR);
      const tree = generateTreeStructure(files, 10);
      
      // The function uses "(+N more)" format for truncation
      expect(tree).toContain('more');
    });
  });

  describe('readProjectFile', () => {
    it('should read file content', () => {
      const content = 'export const hello = "world";';
      writeFileSync(join(TEST_DIR, 'test.ts'), content);
      
      const result = readProjectFile(join(TEST_DIR, 'test.ts'));
      
      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      expect(result!.truncated).toBe(false);
    });

    it('should return null for non-existent file', () => {
      const result = readProjectFile(join(TEST_DIR, 'nonexistent.ts'));
      expect(result).toBeNull();
    });

    it('should return null for directories', () => {
      mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true });
      const result = readProjectFile(join(TEST_DIR, 'subdir'));
      expect(result).toBeNull();
    });

    it('should truncate large files', () => {
      // File size is 60000 bytes, maxSize is 50000
      // Function skips files > maxSize * 2 (100000), so 60000 should be read and truncated
      const largeContent = 'x'.repeat(60000);
      writeFileSync(join(TEST_DIR, 'large.ts'), largeContent);
      
      const result = readProjectFile(join(TEST_DIR, 'large.ts'), 50000);
      
      expect(result).not.toBeNull();
      expect(result!.truncated).toBe(true);
      expect(result!.content.length).toBeLessThan(largeContent.length);
      expect(result!.content).toContain('truncated');
    });

    it('should skip very large files', () => {
      const hugeContent = 'x'.repeat(200000);
      writeFileSync(join(TEST_DIR, 'huge.ts'), hugeContent);
      
      const result = readProjectFile(join(TEST_DIR, 'huge.ts'), 50000);
      expect(result).toBeNull();
    });
  });

  describe('writeProjectFile', () => {
    it('should write file content', () => {
      const filePath = join(TEST_DIR, 'output.ts');
      const content = 'export const test = true;';
      
      const result = writeProjectFile(filePath, content);
      
      expect(result.success).toBe(true);
      
      const written = readProjectFile(filePath);
      expect(written!.content).toBe(content);
    });

    it('should create parent directories', () => {
      const filePath = join(TEST_DIR, 'new', 'nested', 'dir', 'file.ts');
      const content = '// nested file';
      
      const result = writeProjectFile(filePath, content);
      
      expect(result.success).toBe(true);
      
      const written = readProjectFile(filePath);
      expect(written!.content).toBe(content);
    });

    it('should overwrite existing file', () => {
      const filePath = join(TEST_DIR, 'existing.ts');
      writeFileSync(filePath, 'old content');
      
      const result = writeProjectFile(filePath, 'new content');
      
      expect(result.success).toBe(true);
      
      const written = readProjectFile(filePath);
      expect(written!.content).toBe('new content');
    });
  });

  describe('deleteProjectFile', () => {
    it('should delete existing file', () => {
      const filePath = join(TEST_DIR, 'to-delete.ts');
      writeFileSync(filePath, 'delete me');
      
      const result = deleteProjectFile(filePath);
      
      expect(result.success).toBe(true);
      expect(readProjectFile(filePath)).toBeNull();
    });

    it('should return error for non-existent file', () => {
      const result = deleteProjectFile(join(TEST_DIR, 'nonexistent.ts'));
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });
});
