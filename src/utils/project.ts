/**
 * Project scanning and file detection utilities
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, basename, extname, relative, resolve, dirname } from 'path';

// Directories to ignore when scanning
const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.vscode',
  '.idea',
  '__pycache__',
  'venv',
  '.env',
];

// File extensions to include in scanning
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.php', '.swift', '.vue', '.svelte',
  '.css', '.scss', '.less', '.sass',
  '.html', '.htm', '.xml', '.yaml', '.yml',
  '.json', '.md', '.txt', '.sh', '.bash',
];

// Key config files to always include
const KEY_FILES = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'readme.md',
  '.env.example',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'Makefile',
  'docker-compose.yml',
  'Dockerfile',
];

export interface ProjectFile {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  isDirectory: boolean;
}

export interface ProjectContext {
  root: string;
  name: string;
  type: string;
  structure: string;
  keyFiles: string[];
  fileCount: number;
  summary: string;
  hasWriteAccess?: boolean;
}

export interface DetectedFile {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Check if current directory is a project (has package.json or other markers)
 */
export function isProjectDirectory(dir: string = process.cwd()): boolean {
  const markers = ['package.json', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pom.xml', '.git'];
  return markers.some(marker => existsSync(join(dir, marker)));
}

/**
 * Get project type based on config files
 */
export function getProjectType(dir: string = process.cwd()): string {
  if (existsSync(join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript || existsSync(join(dir, 'tsconfig.json'))) {
        return 'TypeScript/Node.js';
      }
    } catch {
      // Corrupt package.json — fall through to return JavaScript/Node.js
    }
    return 'JavaScript/Node.js';
  }
  if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust';
  if (existsSync(join(dir, 'go.mod'))) return 'Go';
  if (existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'setup.py'))) return 'Python';
  if (existsSync(join(dir, 'Gemfile'))) return 'Ruby';
  if (existsSync(join(dir, 'pom.xml')) || existsSync(join(dir, 'build.gradle'))) return 'Java';
  return 'Unknown';
}

/**
 * Scan directory recursively up to specified depth
 */
export function scanDirectory(
  dir: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
  rootDir?: string
): ProjectFile[] {
  const root = rootDir || dir;
  const files: ProjectFile[] = [];

  if (currentDepth >= maxDepth) return files;

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relativePath = relative(root, fullPath);

      // Skip ignored directories
      if (IGNORE_DIRS.includes(entry)) continue;

      try {
        const stat = statSync(fullPath);
        const isDirectory = stat.isDirectory();
        const extension = extname(entry).toLowerCase();

        // Add directories
        if (isDirectory) {
          files.push({
            path: fullPath,
            relativePath,
            name: entry,
            extension: '',
            size: 0,
            isDirectory: true,
          });

          // Recurse into subdirectories
          files.push(...scanDirectory(fullPath, maxDepth, currentDepth + 1, root));
        } 
        // Add relevant files
        else if (CODE_EXTENSIONS.includes(extension) || KEY_FILES.includes(entry)) {
          files.push({
            path: fullPath,
            relativePath,
            name: entry,
            extension,
            size: stat.size,
            isDirectory: false,
          });
        }
      } catch {
        // Skip files we can't access
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}

/**
 * Generate directory tree structure string
 */
export function generateTreeStructure(files: ProjectFile[], maxLines: number = 30): string {
  const dirs = new Set<string>();
  const filesByDir: Record<string, string[]> = {};

  for (const file of files) {
    const parts = file.relativePath.split('/');
    if (file.isDirectory) {
      dirs.add(file.relativePath);
    } else {
      const dir = parts.slice(0, -1).join('/') || '.';
      if (!filesByDir[dir]) filesByDir[dir] = [];
      filesByDir[dir].push(parts[parts.length - 1]);
    }
  }

  const lines: string[] = [];
  const sortedDirs = ['', ...Array.from(dirs).sort()];

  for (const dir of sortedDirs) {
    if (lines.length >= maxLines) {
      lines.push('... (truncated)');
      break;
    }

    const displayDir = dir || '.';
    const indent = dir ? '  '.repeat(dir.split('/').length) : '';

    if (dir) {
      lines.push(`${indent}${basename(dir)}/`);
    }

    const dirFiles = filesByDir[dir] || filesByDir[displayDir] || [];
    for (const file of dirFiles.slice(0, 10)) {
      if (lines.length >= maxLines) break;
      lines.push(`${indent}  ${file}`);
    }
    if (dirFiles.length > 10) {
      lines.push(`${indent}  ... (+${dirFiles.length - 10} more)`);
    }
  }

  return lines.join('\n');
}

/**
 * Read a project file with size limit
 */
export function readProjectFile(filePath: string, maxSize: number = 50000): DetectedFile | null {
  try {
    const absolutePath = resolve(filePath);
    
    if (!existsSync(absolutePath)) return null;
    
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) return null;
    if (stat.size > maxSize * 2) return null; // Skip very large files

    let content = readFileSync(absolutePath, 'utf-8');
    let truncated = false;

    if (content.length > maxSize) {
      content = content.slice(0, maxSize) + '\n\n... (file truncated)';
      truncated = true;
    }

    return {
      path: absolutePath,
      content,
      truncated,
    };
  } catch {
    return null;
  }
}

/**
 * Write content to a project file
 */
export function deleteProjectFile(filePath: string): { success: boolean; error?: string } {
  try {
    const absolutePath = resolve(filePath);
    
    // Check if file exists
    if (!existsSync(absolutePath)) {
      return { success: false, error: 'File does not exist' };
    }
    
    // Delete file
    unlinkSync(absolutePath);
    
    return { success: true };
  } catch (error) {
    const err = error as Error;
    return { success: false, error: err.message };
  }
}

export function writeProjectFile(filePath: string, content: string): { success: boolean; error?: string } {
  try {
    const absolutePath = resolve(filePath);
    
    // Ensure directory exists
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write file
    writeFileSync(absolutePath, content, 'utf-8');
    
    return { success: true };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      error: err.message || 'Failed to write file',
    };
  }
}

/**
 * Parse file changes from AI response
 * Supports multiple formats:
 * 1. ```filepath:path/to/file.ts\ncode\n```
 * 2. Box format with :filename on second line
 * 3. Delete format: ```delete:path/to/file.ts```
 */
export function parseFileChanges(response: string): Array<{ path: string; content: string; action?: 'create' | 'edit' | 'delete' }> {
  const changes: Array<{ path: string; content: string; action?: 'create' | 'edit' | 'delete' }> = [];
  
  // Format 1: Match code blocks with filepath: prefix
  const regex1 = /```filepath:([^\n]+)\n([\s\S]*?)```/g;
  let match;
  
  while ((match = regex1.exec(response)) !== null) {
    const path = match[1].trim();
    const content = match[2];
    const action = existsSync(path) ? 'edit' : 'create';
    changes.push({ path, content, action });
  }
  
  // Format 3: Match delete format
  const deleteRegex = /```delete:([^\n]+)```/g;
  while ((match = deleteRegex.exec(response)) !== null) {
    const path = match[1].trim();
    changes.push({ path, content: '', action: 'delete' });
  }
  
  // Format 2: Match box format - simpler line-by-line approach
  const lines = response.split('\n');
  let inBox = false;
  let currentPath = '';
  let currentContent: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Start of box
    if (line.includes('╭') && line.includes('─')) {
      inBox = true;
      currentContent = [];
      continue;
    }
    
    // End of box
    if (line.includes('╰') && line.includes('─')) {
      if (inBox && currentPath && currentContent.length > 0) {
        const action = existsSync(currentPath) ? 'edit' : 'create';
        changes.push({ 
          path: currentPath, 
          content: currentContent.join('\n').trim(),
          action
        });
      }
      inBox = false;
      currentPath = '';
      currentContent = [];
      continue;
    }
    
    // Inside box
    if (inBox) {
      // Line with :filename
      if (line.includes('│') && line.includes(':') && !currentPath) {
        const match = line.match(/:\s*([^\s│]+)/);
        if (match) {
          currentPath = match[1].trim();
        }
      }
      // Content lines (skip header lines with "filepath")
      else if (line.includes('│') && !line.includes('filepath') && !line.includes('[0]')) {
        const content = line.replace(/^[│\s]+/, '').replace(/[│\s]+$/, '');
        if (content && currentPath) {
          currentContent.push(content);
        }
      }
    }
  }
  
  return changes;
}

/**
 * Detect file paths mentioned in text
 */
export function detectFilePaths(text: string, projectRoot: string = process.cwd()): string[] {
  const detectedPaths: string[] = [];
  
  // Patterns to match file paths
  const patterns = [
    // Explicit paths: ./src/app.tsx, ../utils/helper.ts
    /(?:^|\s)(\.{1,2}\/[\w\-./]+\.\w+)/g,
    // Relative paths without ./: src/app.tsx, components/Button.tsx
    /(?:^|\s)((?:src|lib|app|components|pages|utils|hooks|services|api|config|test|tests|spec)\/[\w\-./]+\.\w+)/gi,
    // Single files in current dir or common names: package.json, tsconfig.json
    /(?:^|\s)((?:package|tsconfig|webpack|babel|jest|vite|rollup|eslint|prettier)\.(?:json|config\.\w+|js|ts|cjs|mjs))/gi,
    // README, Dockerfile, Makefile
    /(?:^|\s)((?:README|Dockerfile|Makefile|Cargo\.toml|go\.mod|requirements\.txt)(?:\.\w+)?)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const potentialPath = match[1].trim();
      const absolutePath = resolve(projectRoot, potentialPath);
      
      // Check if file exists
      if (existsSync(absolutePath)) {
        const stat = statSync(absolutePath);
        if (!stat.isDirectory() && !detectedPaths.includes(potentialPath)) {
          detectedPaths.push(potentialPath);
        }
      }
    }
  }

  return detectedPaths;
}

/**
 * Get full project context for AI
 */
export function getProjectContext(dir: string = process.cwd()): ProjectContext | null {
  try {
    const files = scanDirectory(dir, 3);
    const isProject = isProjectDirectory(dir);
    const projectType = isProject ? getProjectType(dir) : 'generic';
    const structure = generateTreeStructure(files, 25);
    
    // Find key files that exist
    const existingKeyFiles = KEY_FILES
      .filter(f => existsSync(join(dir, f)))
      .slice(0, 5);

    // Get project name
    let projectName = basename(dir);
    if (existsSync(join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        projectName = pkg.name || projectName;
      } catch {}
    }

    const codeFiles = files.filter(f => !f.isDirectory);
    const fileCount = codeFiles.length;

    // Generate summary
    const summary = isProject 
      ? `${projectName} is a ${projectType} project with ${fileCount} code files.`
      : `${projectName} is a folder with ${fileCount} files.`;

    return {
      root: dir,
      name: projectName,
      type: projectType,
      structure,
      keyFiles: existingKeyFiles,
      fileCount,
      summary,
    };
  } catch {
    return null;
  }
}

/**
 * Get project summary for display
 */
export function getProjectSummary(dir: string = process.cwd()): {
  name: string;
  type: string;
  fileCount: number;
  hasReadme: boolean;
} | null {
  if (!isProjectDirectory(dir)) return null;

  try {
    const files = scanDirectory(dir, 2);
    const codeFiles = files.filter(f => !f.isDirectory);
    
    let name = basename(dir);
    if (existsSync(join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        name = pkg.name || name;
      } catch {}
    }

    return {
      name,
      type: getProjectType(dir),
      fileCount: codeFiles.length,
      hasReadme: existsSync(join(dir, 'README.md')) || existsSync(join(dir, 'readme.md')),
    };
  } catch {
    return null;
  }
}

/**
 * Project feature detection
 */
export interface ProjectFeatures {
  hasGit: boolean;
  hasPackageJson: boolean;
  hasTypescript: boolean;
  hasPython: boolean;
  hasDocker: boolean;
  hasTests: boolean;
  hasCargo: boolean;
  hasGoMod: boolean;
  projectType: string;
}

/**
 * Suggested command based on project features
 */
export interface ProjectSuggestion {
  command: string;
  description: string;
  reason: string;
  priority: number; // Lower = higher priority
}

/**
 * Detect project features
 */
export function detectProjectFeatures(dir: string = process.cwd()): ProjectFeatures {
  return {
    hasGit: existsSync(join(dir, '.git')),
    hasPackageJson: existsSync(join(dir, 'package.json')),
    hasTypescript: existsSync(join(dir, 'tsconfig.json')),
    hasPython: existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'setup.py')) || existsSync(join(dir, 'pyproject.toml')),
    hasDocker: existsSync(join(dir, 'Dockerfile')) || existsSync(join(dir, 'docker-compose.yml')),
    hasTests: existsSync(join(dir, 'jest.config.js')) || existsSync(join(dir, 'jest.config.ts')) || 
              existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'test')) || existsSync(join(dir, 'tests')) ||
              existsSync(join(dir, '__tests__')) || existsSync(join(dir, 'spec')),
    hasCargo: existsSync(join(dir, 'Cargo.toml')),
    hasGoMod: existsSync(join(dir, 'go.mod')),
    projectType: getProjectType(dir),
  };
}

/**
 * Get smart suggestions based on project type
 */
export function getProjectSuggestions(dir: string = process.cwd()): ProjectSuggestion[] {
  const features = detectProjectFeatures(dir);
  const suggestions: ProjectSuggestion[] = [];

  // Git suggestions
  if (features.hasGit) {
    suggestions.push({
      command: '/diff',
      description: 'Review uncommitted changes',
      reason: 'Git repository detected',
      priority: 1,
    });
    suggestions.push({
      command: '/commit',
      description: 'Generate commit message',
      reason: 'Git repository detected',
      priority: 2,
    });
  }

  // Node.js/TypeScript suggestions
  if (features.hasPackageJson) {
    suggestions.push({
      command: '/agent npm run build',
      description: 'Build the project',
      reason: 'Node.js project detected',
      priority: 3,
    });
    if (features.hasTests) {
      suggestions.push({
        command: '/agent npm test',
        description: 'Run tests',
        reason: 'Test configuration found',
        priority: 4,
      });
    }
  }

  // Python suggestions
  if (features.hasPython) {
    suggestions.push({
      command: '/agent pip install -r requirements.txt',
      description: 'Install dependencies',
      reason: 'Python project detected',
      priority: 3,
    });
    if (features.hasTests) {
      suggestions.push({
        command: '/agent pytest',
        description: 'Run tests',
        reason: 'Python tests detected',
        priority: 4,
      });
    }
  }

  // Rust suggestions
  if (features.hasCargo) {
    suggestions.push({
      command: '/agent cargo build',
      description: 'Build the project',
      reason: 'Rust project detected',
      priority: 3,
    });
    suggestions.push({
      command: '/agent cargo test',
      description: 'Run tests',
      reason: 'Rust project detected',
      priority: 4,
    });
  }

  // Go suggestions
  if (features.hasGoMod) {
    suggestions.push({
      command: '/agent go build',
      description: 'Build the project',
      reason: 'Go project detected',
      priority: 3,
    });
    suggestions.push({
      command: '/agent go test ./...',
      description: 'Run tests',
      reason: 'Go project detected',
      priority: 4,
    });
  }

  // Docker suggestions
  if (features.hasDocker) {
    suggestions.push({
      command: '/agent docker build',
      description: 'Build Docker image',
      reason: 'Dockerfile detected',
      priority: 5,
    });
  }

  // Always suggest agent for code tasks
  suggestions.push({
    command: '/agent',
    description: 'Run autonomous agent for any task',
    reason: 'Project access granted',
    priority: 10,
  });

  // Sort by priority
  return suggestions.sort((a, b) => a.priority - b.priority);
}

/**
 * Get a brief tip message for the project type
 */
export function getProjectTip(dir: string = process.cwd()): string | null {
  const features = detectProjectFeatures(dir);
  const tips: string[] = [];

  if (features.hasGit) {
    tips.push('/diff, /commit');
  }

  if (features.hasPackageJson || features.hasCargo || features.hasGoMod || features.hasPython) {
    tips.push('/agent for tasks');
  }

  if (tips.length === 0) return null;

  const projectName = features.projectType !== 'Unknown' ? features.projectType : 'project';
  return `${projectName} • Try: ${tips.join(' • ')}`;
}
