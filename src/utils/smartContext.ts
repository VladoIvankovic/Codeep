/**
 * Smart Context - automatically gather relevant files for better understanding
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, basename, extname, relative } from 'path';
import { ProjectContext } from './project';
import { loadIgnoreRules, isIgnored, IgnoreRules } from './gitignore';

export interface RelatedFile {
  path: string;
  relativePath: string;
  reason: string;
  priority: number; // Higher = more relevant
  content?: string;
  size: number;
}

export interface SmartContextResult {
  files: RelatedFile[];
  totalSize: number;
  truncated: boolean;
}

// Max context size (characters)
const MAX_CONTEXT_SIZE = 50000;
const MAX_FILES = 15;

// File extensions we care about
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.php', '.phtml',
  '.java', '.kt', '.scala',
  '.cs', '.fs',
  '.rb',
  '.swift',
  '.c', '.cpp', '.h', '.hpp',
  '.vue', '.svelte',
  '.css', '.scss', '.less',
  '.html', '.htm',
  '.json', '.yaml', '.yml', '.toml',
  '.sql',
  '.md',
]);

/**
 * Extract imports/requires from file content
 */
function extractImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    // ES imports: import X from 'path' or import 'path'
    const esImports = content.matchAll(/import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g);
    for (const match of esImports) {
      imports.push(match[1]);
    }
    
    // CommonJS: require('path')
    const cjsImports = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of cjsImports) {
      imports.push(match[1]);
    }
    
    // Dynamic imports: import('path')
    const dynamicImports = content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of dynamicImports) {
      imports.push(match[1]);
    }
  }
  
  if (ext === '.py') {
    // Python: import X, from X import Y
    const pyImports = content.matchAll(/(?:from\s+(\S+)\s+import|import\s+(\S+))/g);
    for (const match of pyImports) {
      imports.push(match[1] || match[2]);
    }
  }
  
  if (ext === '.go') {
    // Go: import "path" or import (...)
    const goImports = content.matchAll(/import\s+(?:\(\s*)?"([^"]+)"/g);
    for (const match of goImports) {
      imports.push(match[1]);
    }
  }
  
  if (ext === '.php') {
    // PHP: use Namespace\Class, require/include
    const phpUse = content.matchAll(/use\s+([^;]+);/g);
    for (const match of phpUse) {
      imports.push(match[1]);
    }
    const phpRequire = content.matchAll(/(?:require|include)(?:_once)?\s*\(?['"]([^'"]+)['"]/g);
    for (const match of phpRequire) {
      imports.push(match[1]);
    }
  }
  
  if (ext === '.rs') {
    // Rust: use crate::path, mod name
    const rustUse = content.matchAll(/use\s+(?:crate::)?([^;{]+)/g);
    for (const match of rustUse) {
      imports.push(match[1].trim());
    }
  }
  
  return imports;
}

/**
 * Resolve import path to actual file path
 */
function resolveImportPath(
  importPath: string,
  fromFile: string,
  projectRoot: string
): string | null {
  const fromDir = dirname(fromFile);
  const ext = extname(fromFile);
  
  // Skip external packages
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    // Could be a local alias like @/components
    if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
      const aliasPath = importPath.replace(/^[@~]\//, 'src/');
      return resolveWithExtensions(join(projectRoot, aliasPath), ext);
    }
    return null;
  }
  
  // Resolve relative path
  const resolved = join(fromDir, importPath);
  return resolveWithExtensions(resolved, ext);
}

/**
 * Try to resolve path with various extensions
 */
function resolveWithExtensions(basePath: string, preferredExt: string): string | null {
  // Try exact path first
  if (existsSync(basePath) && statSync(basePath).isFile()) {
    return basePath;
  }
  
  // Try with extensions
  const extensions = [
    preferredExt,
    '.ts', '.tsx', '.js', '.jsx',
    '.py', '.go', '.rs', '.php',
    '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  ];
  
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt;
    }
  }
  
  return null;
}

/**
 * Find related files based on naming conventions
 */
function findRelatedByNaming(
  filePath: string,
  projectRoot: string
): RelatedFile[] {
  const related: RelatedFile[] = [];
  const fileName = basename(filePath);
  const fileDir = dirname(filePath);
  const ext = extname(filePath);
  const baseName = fileName.replace(ext, '');
  
  // Common related file patterns
  const patterns = [
    // Test files
    { suffix: '.test', reason: 'test file' },
    { suffix: '.spec', reason: 'spec file' },
    { suffix: '_test', reason: 'test file' },
    // Type definitions
    { suffix: '.d', reason: 'type definitions' },
    { suffix: '.types', reason: 'type definitions' },
    // Related modules
    { suffix: '.model', reason: 'model' },
    { suffix: '.service', reason: 'service' },
    { suffix: '.controller', reason: 'controller' },
    { suffix: '.repository', reason: 'repository' },
    { suffix: '.utils', reason: 'utilities' },
    { suffix: '.helper', reason: 'helper' },
    { suffix: '.interface', reason: 'interface' },
  ];
  
  // Check if current file matches a pattern, find the base
  for (const pattern of patterns) {
    if (baseName.endsWith(pattern.suffix)) {
      const realBase = baseName.replace(pattern.suffix, '');
      const basePath = join(fileDir, realBase + ext);
      if (existsSync(basePath)) {
        try {
          const stat = statSync(basePath);
          related.push({
            path: basePath,
            relativePath: relative(projectRoot, basePath),
            reason: 'main file',
            priority: 8,
            size: stat.size,
          });
        } catch {}
      }
    }
  }
  
  // Find files with same base name
  for (const pattern of patterns) {
    const relatedPath = join(fileDir, baseName + pattern.suffix + ext);
    if (existsSync(relatedPath) && relatedPath !== filePath) {
      try {
        const stat = statSync(relatedPath);
        related.push({
          path: relatedPath,
          relativePath: relative(projectRoot, relatedPath),
          reason: pattern.reason,
          priority: 5,
          size: stat.size,
        });
      } catch {}
    }
  }
  
  return related;
}

/**
 * Find type definition files
 */
function findTypeDefinitions(
  projectRoot: string,
  imports: string[]
): RelatedFile[] {
  const related: RelatedFile[] = [];
  
  // Common type definition locations
  const typePaths = [
    'src/types/index.ts',
    'src/types.ts',
    'types/index.ts',
    'types.ts',
    'src/@types/index.d.ts',
    'src/interfaces/index.ts',
  ];
  
  for (const typePath of typePaths) {
    const fullPath = join(projectRoot, typePath);
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        related.push({
          path: fullPath,
          relativePath: typePath,
          reason: 'type definitions',
          priority: 7,
          size: stat.size,
        });
      } catch {}
    }
  }
  
  return related;
}

/**
 * Find config files
 */
function findConfigFiles(projectRoot: string): RelatedFile[] {
  const related: RelatedFile[] = [];
  
  const configFiles = [
    { path: 'tsconfig.json', reason: 'TypeScript config' },
    { path: 'package.json', reason: 'package info' },
    { path: '.env.example', reason: 'environment variables' },
    { path: 'composer.json', reason: 'PHP dependencies' },
    { path: 'Cargo.toml', reason: 'Rust config' },
    { path: 'go.mod', reason: 'Go modules' },
    { path: 'requirements.txt', reason: 'Python dependencies' },
    { path: 'pyproject.toml', reason: 'Python config' },
  ];
  
  for (const config of configFiles) {
    const fullPath = join(projectRoot, config.path);
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        related.push({
          path: fullPath,
          relativePath: config.path,
          reason: config.reason,
          priority: 3,
          size: stat.size,
        });
      } catch {}
    }
  }
  
  return related;
}

/**
 * Gather smart context for a target file or task
 */
export function gatherSmartContext(
  targetFile: string | null,
  projectContext: ProjectContext,
  taskDescription?: string
): SmartContextResult {
  const projectRoot = projectContext.root || process.cwd();
  const ignoreRules = loadIgnoreRules(projectRoot);
  const allRelated: Map<string, RelatedFile> = new Map();
  
  // If we have a target file, analyze it
  if (targetFile) {
    const targetPath = join(projectRoot, targetFile);
    
    if (existsSync(targetPath)) {
      try {
        const content = readFileSync(targetPath, 'utf-8');
        const ext = extname(targetPath);
        const stat = statSync(targetPath);
        
        // Add the target file itself
        allRelated.set(targetPath, {
          path: targetPath,
          relativePath: targetFile,
          reason: 'target file',
          priority: 10,
          content,
          size: stat.size,
        });
        
        // Extract and resolve imports
        const imports = extractImports(content, ext);
        for (const imp of imports) {
          const resolved = resolveImportPath(imp, targetPath, projectRoot);
          if (resolved && !allRelated.has(resolved)) {
            try {
              const impStat = statSync(resolved);
              allRelated.set(resolved, {
                path: resolved,
                relativePath: relative(projectRoot, resolved),
                reason: 'imported module',
                priority: 8,
                size: impStat.size,
              });
            } catch {}
          }
        }
        
        // Find related by naming
        const namedRelated = findRelatedByNaming(targetPath, projectRoot);
        for (const rel of namedRelated) {
          if (!allRelated.has(rel.path)) {
            allRelated.set(rel.path, rel);
          }
        }
      } catch {}
    }
  }
  
  // Find type definitions
  const typeDefs = findTypeDefinitions(projectRoot, []);
  for (const td of typeDefs) {
    if (!allRelated.has(td.path)) {
      allRelated.set(td.path, td);
    }
  }
  
  // Add config files (lower priority)
  const configs = findConfigFiles(projectRoot);
  for (const cfg of configs) {
    if (!allRelated.has(cfg.path)) {
      allRelated.set(cfg.path, cfg);
    }
  }
  
  // If task mentions specific files, try to find them
  if (taskDescription) {
    const mentionedFiles = extractMentionedFiles(taskDescription, projectRoot);
    for (const mf of mentionedFiles) {
      if (!allRelated.has(mf.path)) {
        allRelated.set(mf.path, mf);
      }
    }
  }
  
  // Filter out ignored files (except the target file itself)
  for (const [key, file] of allRelated) {
    if (file.reason !== 'target file' && isIgnored(file.path, ignoreRules)) {
      allRelated.delete(key);
    }
  }

  // Sort by priority and limit
  let files = Array.from(allRelated.values())
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_FILES);
  
  // Load content for files that don't have it
  let totalSize = 0;
  let truncated = false;
  
  for (const file of files) {
    if (!file.content && totalSize < MAX_CONTEXT_SIZE) {
      try {
        const content = readFileSync(file.path, 'utf-8');
        if (totalSize + content.length <= MAX_CONTEXT_SIZE) {
          file.content = content;
          totalSize += content.length;
        } else {
          // Truncate this file
          const remaining = MAX_CONTEXT_SIZE - totalSize;
          file.content = content.slice(0, remaining) + '\n... (truncated)';
          totalSize = MAX_CONTEXT_SIZE;
          truncated = true;
        }
      } catch {}
    } else if (file.content) {
      totalSize += file.content.length;
    }
  }
  
  // Remove files without content if we're at limit
  if (truncated) {
    files = files.filter(f => f.content);
  }
  
  return {
    files,
    totalSize,
    truncated,
  };
}

/**
 * Extract file paths mentioned in task description
 */
function extractMentionedFiles(
  task: string,
  projectRoot: string
): RelatedFile[] {
  const related: RelatedFile[] = [];
  
  // Match file paths like src/utils/helper.ts or ./config.json
  const pathPattern = /(?:^|[\s'"`])([.\w/-]+\.\w{1,10})(?:[\s'"`]|$)/g;
  const matches = task.matchAll(pathPattern);
  
  for (const match of matches) {
    const filePath = match[1];
    const fullPath = join(projectRoot, filePath);
    
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          related.push({
            path: fullPath,
            relativePath: filePath,
            reason: 'mentioned in task',
            priority: 9,
            size: stat.size,
          });
        }
      } catch {}
    }
  }
  
  return related;
}

/**
 * Format smart context for system prompt
 */
export function formatSmartContext(context: SmartContextResult): string {
  if (context.files.length === 0) {
    return '';
  }
  
  const lines: string[] = ['## Related Files (Smart Context)', ''];
  
  for (const file of context.files) {
    if (file.content) {
      lines.push(`### ${file.relativePath}`);
      lines.push(`> Reason: ${file.reason}`);
      lines.push('```');
      lines.push(file.content);
      lines.push('```');
      lines.push('');
    }
  }
  
  if (context.truncated) {
    lines.push('> Note: Some files were truncated due to size limits.');
  }
  
  return lines.join('\n');
}

/**
 * Extract target file from task description
 */
export function extractTargetFile(task: string): string | null {
  // Common patterns for target files
  const patterns = [
    /(?:edit|modify|update|change|fix)\s+(?:the\s+)?(?:file\s+)?['"`]?([.\w/-]+\.\w{1,10})['"`]?/i,
    /(?:in|to)\s+(?:the\s+)?(?:file\s+)?['"`]?([.\w/-]+\.\w{1,10})['"`]?/i,
    /['"`]([.\w/-]+\.\w{1,10})['"`]/,
    /(?:^|\s)([.\w/-]+\.\w{1,10})(?:\s|$)/,
  ];
  
  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}
