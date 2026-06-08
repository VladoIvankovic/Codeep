/**
 * Project Intelligence - Deep project analysis and caching
 * Scans project once and caches important information for faster AI context
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { join, basename, extname, relative } from 'path';
import { loadIgnoreRules, isIgnored, type IgnoreRules } from './gitignore';

// ============================================================================
// Types
// ============================================================================

export interface ProjectIntelligence {
  // Metadata
  version: string;
  scannedAt: string;
  projectPath: string;
  
  // Basic info
  name: string;
  type: string;
  description: string;
  
  // Structure
  structure: {
    totalFiles: number;
    totalDirectories: number;
    languages: Record<string, number>; // extension -> count
    topDirectories: string[];
  };
  
  // Dependencies
  dependencies: {
    runtime: string[];
    dev: string[];
    frameworks: string[];
  };
  
  // Key files content (cached)
  keyFiles: {
    path: string;
    summary: string;
  }[];
  
  // Entry points
  entryPoints: string[];
  
  // Scripts/commands
  scripts: Record<string, string>;
  
  // Architecture insights
  architecture: {
    patterns: string[];      // e.g., "MVC", "Component-based", "Microservices"
    mainModules: string[];   // Key directories/modules
    apiEndpoints?: string[]; // Detected API routes
    components?: string[];   // UI components
    ciSystem?: string | null;      // GitHub Actions, GitLab CI, CircleCI, etc.
    containerization?: string[];    // Docker, docker-compose, Kubernetes manifests
    monorepoTool?: string | null;   // Turborepo, Nx, Lerna, pnpm workspaces
  };
  
  // Code conventions
  conventions: {
    indentation: 'tabs' | 'spaces' | 'mixed';
    quotes: 'single' | 'double' | 'mixed';
    semicolons: boolean;
    namingStyle: 'camelCase' | 'snake_case' | 'PascalCase' | 'mixed';
  };
  
  // Testing
  testing: {
    framework: string | null;
    testDirectory: string | null;
    hasTests: boolean;
  };
  
  // Custom notes (user can add)
  notes: string[];
}

// ============================================================================
// Constants
// ============================================================================

const INTELLIGENCE_VERSION = '1.2';
const INTELLIGENCE_FILE = 'intelligence.json';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.vscode', '.idea', '__pycache__', 'venv', '.env',
  'vendor', 'target', 'out', 'bin', 'obj', '.nuxt', '.output',
]);

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
  '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.c': 'C',
  '.vue': 'Vue', '.svelte': 'Svelte',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
  '.md': 'Markdown', '.sql': 'SQL', '.sh': 'Shell',
};

const FRAMEWORK_INDICATORS: Record<string, string[]> = {
  'React': ['react', 'react-dom'],
  'Next.js': ['next'],
  'Vue': ['vue'],
  'Nuxt': ['nuxt'],
  'Angular': ['@angular/core'],
  'Svelte': ['svelte'],
  'Express': ['express'],
  'Fastify': ['fastify'],
  'NestJS': ['@nestjs/core'],
  'Django': ['django'],
  'Flask': ['flask'],
  'FastAPI': ['fastapi'],
  'Rails': ['rails'],
  'Laravel': ['laravel'],
  'Spring': ['spring-boot'],
};

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Scan project and generate intelligence
 */
export async function scanProject(projectPath: string): Promise<ProjectIntelligence> {
  const intelligence: ProjectIntelligence = {
    version: INTELLIGENCE_VERSION,
    scannedAt: new Date().toISOString(),
    projectPath,
    name: basename(projectPath),
    type: 'Unknown',
    description: '',
    structure: {
      totalFiles: 0,
      totalDirectories: 0,
      languages: {},
      topDirectories: [],
    },
    dependencies: {
      runtime: [],
      dev: [],
      frameworks: [],
    },
    keyFiles: [],
    entryPoints: [],
    scripts: {},
    architecture: {
      patterns: [],
      mainModules: [],
      ciSystem: null,
      containerization: [],
      monorepoTool: null,
    },
    conventions: {
      indentation: 'spaces',
      quotes: 'single',
      semicolons: true,
      namingStyle: 'camelCase',
    },
    testing: {
      framework: null,
      testDirectory: null,
      hasTests: false,
    },
    notes: [],
  };

  // Load .gitignore rules once — used by scan and endpoint detection
  const ignoreRules = loadIgnoreRules(projectPath);

  // Scan directory structure (honors .gitignore)
  scanDirectoryStructure(projectPath, intelligence, 0, ignoreRules);

  // Detect project type and dependencies
  detectProjectType(projectPath, intelligence);

  // Analyze key files
  analyzeKeyFiles(projectPath, intelligence);

  // Detect architecture patterns
  detectArchitecture(projectPath, intelligence);

  // Detect CI/CD, containerization, monorepo
  detectDevOps(projectPath, intelligence);

  // Analyze code conventions
  analyzeConventions(projectPath, intelligence);

  // Detect testing setup
  detectTesting(projectPath, intelligence);

  return intelligence;
}

/**
 * Save intelligence to .codeep/intelligence.json
 */
export function saveProjectIntelligence(projectPath: string, intelligence: ProjectIntelligence): boolean {
  try {
    const codeepDir = join(projectPath, '.codeep');
    if (!existsSync(codeepDir)) {
      mkdirSync(codeepDir, { recursive: true });
    }
    
    const filePath = join(codeepDir, INTELLIGENCE_FILE);
    writeFileSync(filePath, JSON.stringify(intelligence, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete default intelligence skeleton — every nested section is present so
 * consumers (e.g. generateContextFromIntelligence) never dereference an
 * undefined section. Used as the merge base when normalizing a loaded file.
 */
function createBaseIntelligence(projectPath: string): ProjectIntelligence {
  return {
    version: INTELLIGENCE_VERSION,
    scannedAt: new Date().toISOString(),
    projectPath,
    name: basename(projectPath),
    type: 'Unknown',
    description: '',
    structure: {
      totalFiles: 0,
      totalDirectories: 0,
      languages: {},
      topDirectories: [],
    },
    dependencies: {
      runtime: [],
      dev: [],
      frameworks: [],
    },
    keyFiles: [],
    entryPoints: [],
    scripts: {},
    architecture: {
      patterns: [],
      mainModules: [],
      ciSystem: null,
      containerization: [],
      monorepoTool: null,
    },
    conventions: {
      indentation: 'spaces',
      quotes: 'single',
      semicolons: true,
      namingStyle: 'camelCase',
    },
    testing: {
      framework: null,
      testDirectory: null,
      hasTests: false,
    },
    notes: [],
  };
}

/**
 * Merge a loaded (possibly partial or older-schema) intelligence object over
 * the complete default skeleton so every nested section is guaranteed present.
 * An interrupted scan or an older CLI can write a file that is missing whole
 * sections (e.g. `conventions`); without this, reading `conventions.indentation`
 * downstream throws "Cannot read properties of undefined". Nested objects are
 * merged per-section so partial sub-objects are also backfilled.
 */
function normalizeIntelligence(
  data: Partial<ProjectIntelligence>,
  projectPath: string
): ProjectIntelligence {
  const base = createBaseIntelligence(projectPath);
  return {
    ...base,
    ...data,
    structure: { ...base.structure, ...data.structure },
    dependencies: { ...base.dependencies, ...data.dependencies },
    architecture: { ...base.architecture, ...data.architecture },
    conventions: { ...base.conventions, ...data.conventions },
    testing: { ...base.testing, ...data.testing },
  };
}

/**
 * Load intelligence from .codeep/intelligence.json
 */
export function loadProjectIntelligence(projectPath: string): ProjectIntelligence | null {
  try {
    const filePath = join(projectPath, '.codeep', INTELLIGENCE_FILE);
    if (!existsSync(filePath)) return null;

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data || typeof data !== 'object') return null;
    if (data.version !== INTELLIGENCE_VERSION) return null;
    // Backfill any missing sections so a partial/interrupted file can't crash
    // downstream consumers that assume a complete shape.
    return normalizeIntelligence(data as Partial<ProjectIntelligence>, projectPath);
  } catch {
    return null;
  }
}

/**
 * Check if intelligence exists and is fresh (less than 24 hours old)
 */
export function isIntelligenceFresh(projectPath: string, maxAgeHours: number = 24): boolean {
  const intelligence = loadProjectIntelligence(projectPath);
  if (!intelligence) return false;
  
  const scannedAt = new Date(intelligence.scannedAt).getTime();
  const now = Date.now();
  const ageHours = (now - scannedAt) / (1000 * 60 * 60);
  
  return ageHours < maxAgeHours;
}

/**
 * Generate AI-friendly context from intelligence
 */
export function generateContextFromIntelligence(intelligence: ProjectIntelligence): string {
  // Defensive: backfill any missing sections so a partial object (e.g. from an
  // older/interrupted scan, or an external SDK caller) can't crash the
  // formatter on a nested dereference like `conventions.indentation`.
  intelligence = normalizeIntelligence(
    (intelligence ?? {}) as Partial<ProjectIntelligence>,
    intelligence?.projectPath ?? ''
  );

  const lines: string[] = [];

  lines.push(`# Project: ${intelligence.name}`);
  lines.push(`Type: ${intelligence.type}`);
  if (intelligence.description) {
    lines.push(`Description: ${intelligence.description}`);
  }
  lines.push('');
  
  // Structure
  lines.push('## Structure');
  lines.push(`- ${intelligence.structure.totalFiles} files, ${intelligence.structure.totalDirectories} directories`);
  
  const topLangs = Object.entries(intelligence.structure.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => `${LANGUAGE_MAP[ext] || ext} (${count})`)
    .join(', ');
  if (topLangs) {
    lines.push(`- Languages: ${topLangs}`);
  }
  
  if (intelligence.structure.topDirectories.length > 0) {
    lines.push(`- Main directories: ${intelligence.structure.topDirectories.join(', ')}`);
  }
  lines.push('');
  
  // Frameworks
  if (intelligence.dependencies.frameworks.length > 0) {
    lines.push('## Frameworks');
    lines.push(intelligence.dependencies.frameworks.join(', '));
    lines.push('');
  }
  
  // Architecture
  if (intelligence.architecture.patterns.length > 0 || intelligence.architecture.mainModules.length > 0) {
    lines.push('## Architecture');
    if (intelligence.architecture.patterns.length > 0) {
      lines.push(`Patterns: ${intelligence.architecture.patterns.join(', ')}`);
    }
    if (intelligence.architecture.mainModules.length > 0) {
      lines.push(`Main modules: ${intelligence.architecture.mainModules.join(', ')}`);
    }
    lines.push('');
  }

  // DevOps / Tooling — high signal for command execution
  const devopsLines: string[] = [];
  if (intelligence.architecture.monorepoTool) {
    devopsLines.push(`Monorepo: ${intelligence.architecture.monorepoTool}`);
  }
  if (intelligence.architecture.ciSystem) {
    devopsLines.push(`CI/CD: ${intelligence.architecture.ciSystem}`);
  }
  if (intelligence.architecture.containerization && intelligence.architecture.containerization.length > 0) {
    devopsLines.push(`Containerization: ${intelligence.architecture.containerization.join(', ')}`);
  }
  if (devopsLines.length > 0) {
    lines.push('## DevOps');
    devopsLines.forEach(l => lines.push(l));
    lines.push('');
  }
  
  // Entry points
  if (intelligence.entryPoints.length > 0) {
    lines.push('## Entry Points');
    intelligence.entryPoints.forEach(ep => lines.push(`- ${ep}`));
    lines.push('');
  }

  // API Endpoints
  if (intelligence.architecture.apiEndpoints && intelligence.architecture.apiEndpoints.length > 0) {
    lines.push('## API Endpoints');
    intelligence.architecture.apiEndpoints.forEach(ep => lines.push(`- ${ep}`));
    lines.push('');
  }

  // Scripts
  if (Object.keys(intelligence.scripts).length > 0) {
    lines.push('## Available Scripts');
    Object.entries(intelligence.scripts).slice(0, 10).forEach(([name, cmd]) => {
      lines.push(`- ${name}: ${cmd}`);
    });
    lines.push('');
  }
  
  // Key files
  if (intelligence.keyFiles.length > 0) {
    lines.push('## Key Files');
    intelligence.keyFiles.forEach(kf => {
      lines.push(`- ${kf.path}: ${kf.summary}`);
    });
    lines.push('');
  }
  
  // Testing
  if (intelligence.testing.hasTests) {
    lines.push('## Testing');
    lines.push(`Framework: ${intelligence.testing.framework || 'Unknown'}`);
    if (intelligence.testing.testDirectory) {
      lines.push(`Test directory: ${intelligence.testing.testDirectory}`);
    }
    lines.push('');
  }
  
  // Conventions
  lines.push('## Code Conventions');
  lines.push(`- Indentation: ${intelligence.conventions.indentation}`);
  lines.push(`- Quotes: ${intelligence.conventions.quotes}`);
  lines.push(`- Semicolons: ${intelligence.conventions.semicolons ? 'yes' : 'no'}`);
  lines.push(`- Naming: ${intelligence.conventions.namingStyle}`);
  
  // Notes
  if (intelligence.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    intelligence.notes.forEach(note => lines.push(`- ${note}`));
  }
  
  return lines.join('\n');
}

// ============================================================================
// Helper Functions
// ============================================================================

function scanDirectoryStructure(
  dir: string,
  intelligence: ProjectIntelligence,
  depth: number = 0,
  ignoreRules?: IgnoreRules,
): void {
  if (depth > 5) return; // Max depth

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry)) continue;
      if (entry.startsWith('.') && entry !== '.env.example') continue;

      const fullPath = join(dir, entry);

      // Honor .gitignore — skip anything the user has marked as ignored
      if (ignoreRules && isIgnored(fullPath, ignoreRules)) continue;

      try {
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          intelligence.structure.totalDirectories++;

          // Track top-level directories
          if (depth === 0) {
            intelligence.structure.topDirectories.push(entry);
          }

          scanDirectoryStructure(fullPath, intelligence, depth + 1, ignoreRules);
        } else {
          intelligence.structure.totalFiles++;

          const ext = extname(entry).toLowerCase();
          if (ext) {
            intelligence.structure.languages[ext] = (intelligence.structure.languages[ext] || 0) + 1;
          }
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
}

function detectProjectType(projectPath: string, intelligence: ProjectIntelligence): void {
  // Node.js / JavaScript
  const packageJsonPath = join(projectPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      
      intelligence.name = pkg.name || intelligence.name;
      intelligence.description = pkg.description || '';
      
      // Detect type
      if (existsSync(join(projectPath, 'tsconfig.json'))) {
        intelligence.type = 'TypeScript/Node.js';
      } else {
        intelligence.type = 'JavaScript/Node.js';
      }
      
      // Dependencies
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      intelligence.dependencies.runtime = Object.keys(pkg.dependencies || {});
      intelligence.dependencies.dev = Object.keys(pkg.devDependencies || {});
      
      // Detect frameworks
      for (const [framework, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
        if (indicators.some(ind => allDeps[ind])) {
          intelligence.dependencies.frameworks.push(framework);
        }
      }
      
      // Scripts
      intelligence.scripts = pkg.scripts || {};
      
      // Entry points
      if (pkg.main) intelligence.entryPoints.push(pkg.main);
      if (pkg.module) intelligence.entryPoints.push(pkg.module);
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') {
          intelligence.entryPoints.push(pkg.bin);
        } else {
          intelligence.entryPoints.push(...Object.values(pkg.bin as Record<string, string>));
        }
      }
      
      return;
    } catch {
      // Invalid package.json
    }
  }
  
  // Python
  if (existsSync(join(projectPath, 'requirements.txt')) || 
      existsSync(join(projectPath, 'pyproject.toml')) ||
      existsSync(join(projectPath, 'setup.py'))) {
    intelligence.type = 'Python';
    
    // Try to read requirements
    const reqPath = join(projectPath, 'requirements.txt');
    if (existsSync(reqPath)) {
      const content = readFileSync(reqPath, 'utf-8');
      intelligence.dependencies.runtime = content
        .split('\n')
        .map(l => l.trim().split('==')[0].split('>=')[0])
        .filter(l => l && !l.startsWith('#'));
      
      // Detect frameworks
      if (intelligence.dependencies.runtime.includes('django')) {
        intelligence.dependencies.frameworks.push('Django');
      }
      if (intelligence.dependencies.runtime.includes('flask')) {
        intelligence.dependencies.frameworks.push('Flask');
      }
      if (intelligence.dependencies.runtime.includes('fastapi')) {
        intelligence.dependencies.frameworks.push('FastAPI');
      }
    }
    return;
  }
  
  // Go
  if (existsSync(join(projectPath, 'go.mod'))) {
    intelligence.type = 'Go';
    try {
      const content = readFileSync(join(projectPath, 'go.mod'), 'utf-8');
      const moduleMatch = content.match(/module\s+(\S+)/);
      if (moduleMatch) {
        intelligence.name = moduleMatch[1].split('/').pop() || intelligence.name;
      }
    } catch {}
    return;
  }
  
  // Rust
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    intelligence.type = 'Rust';
    try {
      const content = readFileSync(join(projectPath, 'Cargo.toml'), 'utf-8');
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch) {
        intelligence.name = nameMatch[1];
      }
    } catch {}
    return;
  }
  
  // PHP
  if (existsSync(join(projectPath, 'composer.json'))) {
    intelligence.type = 'PHP';
    try {
      const composer = JSON.parse(readFileSync(join(projectPath, 'composer.json'), 'utf-8'));
      intelligence.name = composer.name?.split('/').pop() || intelligence.name;
      intelligence.description = composer.description || '';

      if (composer.require?.['laravel/framework']) {
        intelligence.dependencies.frameworks.push('Laravel');
      }
    } catch {}
    return;
  }

  // Fallback: detect type from already-scanned file extension counts
  const skipExts = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.ttf', '.woff', '.woff2', '.eot', '.map', '.lock', '.md', '.txt', '.json', '.xml', '.yml', '.yaml', '.sql', '.env', '.gitignore', '.zip', '.gz', '.pdf']);
  const extToType: Record<string, string> = {
    '.php': 'PHP', '.py': 'Python', '.rb': 'Ruby', '.java': 'Java',
    '.kt': 'Kotlin', '.swift': 'Swift', '.cs': 'C#', '.cpp': 'C++', '.c': 'C/C++',
    '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart/Flutter',
    '.html': 'HTML/CSS', '.htm': 'HTML/CSS', '.css': 'HTML/CSS', '.scss': 'HTML/CSS',
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  };
  const dominant = Object.entries(intelligence.structure.languages)
    .filter(([ext]) => !skipExts.has(ext) && extToType[ext])
    .sort((a, b) => b[1] - a[1])[0];
  if (dominant) {
    intelligence.type = extToType[dominant[0]];
  }
}

function analyzeKeyFiles(projectPath: string, intelligence: ProjectIntelligence): void {
  const keyFilesToAnalyze = [
    { path: 'README.md', summarize: summarizeReadme },
    { path: 'readme.md', summarize: summarizeReadme },
    { path: 'package.json', summarize: summarizePackageJson },
    { path: 'tsconfig.json', summarize: summarizeTsConfig },
    { path: 'Dockerfile', summarize: summarizeDockerfile },
    { path: '.env.example', summarize: summarizeEnvExample },
  ];
  
  for (const { path, summarize } of keyFilesToAnalyze) {
    const fullPath = join(projectPath, path);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const summary = summarize(content);
        if (summary) {
          intelligence.keyFiles.push({ path, summary });
        }
      } catch {}
    }
  }
}

function summarizeReadme(content: string): string {
  // Extract first meaningful paragraph
  const lines = content.split('\n');
  let inHeader = false;
  
  for (const line of lines) {
    if (line.startsWith('#')) {
      inHeader = true;
      continue;
    }
    if (inHeader && line.trim() && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*')) {
      return line.trim().slice(0, 150) + (line.length > 150 ? '...' : '');
    }
  }
  return 'Project documentation';
}

function summarizePackageJson(content: string): string {
  try {
    const pkg = JSON.parse(content);
    const parts: string[] = [];
    if (pkg.description) parts.push(pkg.description);
    if (pkg.version) parts.push(`v${pkg.version}`);
    return parts.join(' - ') || 'Node.js project configuration';
  } catch {
    return 'Node.js project configuration';
  }
}

function summarizeTsConfig(content: string): string {
  try {
    const config = JSON.parse(content);
    const target = config.compilerOptions?.target || 'unknown';
    const module = config.compilerOptions?.module || 'unknown';
    return `TypeScript config (target: ${target}, module: ${module})`;
  } catch {
    return 'TypeScript configuration';
  }
}

function summarizeDockerfile(_content: string): string {
  return 'Container configuration';
}

function summarizeEnvExample(content: string): string {
  const vars = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#')).length;
  return `${vars} environment variables`;
}

function detectArchitecture(projectPath: string, intelligence: ProjectIntelligence): void {
  const topDirs = intelligence.structure.topDirectories;
  
  // Detect patterns based on directory structure
  if (topDirs.includes('src')) {
    intelligence.architecture.mainModules.push('src');
  }
  
  // MVC pattern
  if (topDirs.includes('models') || topDirs.includes('views') || topDirs.includes('controllers')) {
    intelligence.architecture.patterns.push('MVC');
  }
  
  // Component-based (React/Vue/etc)
  if (topDirs.includes('components') || existsSync(join(projectPath, 'src', 'components'))) {
    intelligence.architecture.patterns.push('Component-based');
    intelligence.architecture.mainModules.push('components');
  }
  
  // API/Services pattern
  if (topDirs.includes('api') || topDirs.includes('services') || 
      existsSync(join(projectPath, 'src', 'api')) || existsSync(join(projectPath, 'src', 'services'))) {
    intelligence.architecture.patterns.push('Service-oriented');
  }
  
  // Hooks (React)
  if (topDirs.includes('hooks') || existsSync(join(projectPath, 'src', 'hooks'))) {
    intelligence.architecture.mainModules.push('hooks');
  }
  
  // Utils/Helpers
  if (topDirs.includes('utils') || topDirs.includes('helpers') || topDirs.includes('lib')) {
    intelligence.architecture.mainModules.push('utils');
  }
  
  // Pages (Next.js, Nuxt, etc)
  if (topDirs.includes('pages') || topDirs.includes('app')) {
    intelligence.architecture.patterns.push('File-based routing');
  }
  
  // Detect API endpoints
  intelligence.architecture.apiEndpoints = detectApiEndpoints(projectPath);
}

function collectFiles(dir: string, exts: Set<string>, ignore: Set<string>, maxFiles = 500): string[] {
  const results: string[] = [];
  function walk(current: string) {
    if (results.length >= maxFiles) return;
    let entries: string[];
    try { entries = readdirSync(current); } catch { return; }
    for (const entry of entries) {
      if (ignore.has(entry)) continue;
      const full = join(current, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (exts.has(extname(entry).toLowerCase())) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function detectApiEndpoints(projectPath: string): string[] {
  const endpoints: string[] = [];
  const seen = new Set<string>();

  function add(method: string, path: string) {
    // Normalise: ensure path starts with /
    const p = path.startsWith('/') ? path : '/' + path;
    const key = `${method} ${p}`;
    if (!seen.has(key)) { seen.add(key); endpoints.push(key); }
  }

  // ── Next.js App Router: app/**/route.ts|js ──────────────────────────────
  const appDirs = [
    join(projectPath, 'app'),
    join(projectPath, 'src', 'app'),
    join(projectPath, 'Codeep-web', 'src', 'app'), // monorepo fallback
  ];
  for (const appDir of appDirs) {
    if (!existsSync(appDir)) continue;
    const routeFiles = collectFiles(appDir, new Set(['.ts', '.tsx', '.js', '.jsx']), IGNORE_DIRS);
    for (const file of routeFiles) {
      if (!basename(file).match(/^route\.(ts|tsx|js|jsx)$/)) continue;
      // Derive path from file location: app/api/users/route.ts → /api/users
      const rel = relative(appDir, file).replace(/\\/g, '/');
      const routePath = '/' + rel.replace(/\/route\.(ts|tsx|js|jsx)$/, '').replace(/\(.*?\)\//g, '');
      let content: string;
      try { content = readFileSync(file, 'utf-8'); } catch { continue; }
      const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      for (const m of methods) {
        if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(content)) {
          add(m, routePath);
        }
      }
    }
  }

  // ── Next.js Pages Router: pages/api/**/*.ts|js ──────────────────────────
  const pagesApiDirs = [
    join(projectPath, 'pages', 'api'),
    join(projectPath, 'src', 'pages', 'api'),
  ];
  for (const pagesApiDir of pagesApiDirs) {
    if (!existsSync(pagesApiDir)) continue;
    const files = collectFiles(pagesApiDir, new Set(['.ts', '.tsx', '.js', '.jsx']), IGNORE_DIRS);
    for (const file of files) {
      const rel = relative(pagesApiDir, file).replace(/\\/g, '/');
      const routePath = '/api/' + rel.replace(/\.(ts|tsx|js|jsx)$/, '').replace(/\/index$/, '');
      add('*', routePath);
    }
  }

  // ── Express / Fastify ────────────────────────────────────────────────────
  const jsFiles = collectFiles(projectPath, new Set(['.ts', '.js']), IGNORE_DIRS, 300);
  // Match: app.get('/path', ...) or router.post('/path', ...)
  const expressRe = /(?:app|router|server)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;
  for (const file of jsFiles) {
    // Skip test files and node_modules (already excluded by collectFiles)
    if (file.includes('.test.') || file.includes('.spec.')) continue;
    let content: string;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }
    let m: RegExpExecArray | null;
    expressRe.lastIndex = 0;
    while ((m = expressRe.exec(content)) !== null) {
      add(m[1].toUpperCase(), m[2]);
    }
  }

  // ── Laravel: routes/api.php, routes/web.php ──────────────────────────────
  const laravelRouteDirs = [join(projectPath, 'routes')];
  const phpRouteRe = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]/gi;
  for (const dir of laravelRouteDirs) {
    if (!existsSync(dir)) continue;
    const phpFiles = collectFiles(dir, new Set(['.php']), IGNORE_DIRS, 20);
    for (const file of phpFiles) {
      let content: string;
      try { content = readFileSync(file, 'utf-8'); } catch { continue; }
      let m: RegExpExecArray | null;
      phpRouteRe.lastIndex = 0;
      while ((m = phpRouteRe.exec(content)) !== null) {
        add(m[1].toUpperCase(), m[2]);
      }
    }
  }

  // ── Django: urls.py ──────────────────────────────────────────────────────
  const djangoRe = /path\s*\(\s*['"]([^'"]+)['"]/g;
  const pyFiles = collectFiles(projectPath, new Set(['.py']), IGNORE_DIRS, 200);
  for (const file of pyFiles) {
    if (!basename(file).includes('urls')) continue;
    let content: string;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }
    let m: RegExpExecArray | null;
    djangoRe.lastIndex = 0;
    while ((m = djangoRe.exec(content)) !== null) {
      add('*', '/' + m[1]);
    }
  }

  return endpoints.slice(0, 50); // cap at 50
}

/**
 * Detect CI/CD system, containerization, and monorepo tooling.
 * These are high-signal facts that shape how the agent should run commands
 * (e.g. "this uses Turbo — use `turbo run build` not `npm run build`").
 */
function detectDevOps(projectPath: string, intelligence: ProjectIntelligence): void {
  // ─── CI/CD ────────────────────────────────────────────────────────────────
  if (existsSync(join(projectPath, '.github', 'workflows'))) {
    intelligence.architecture.ciSystem = 'GitHub Actions';
  } else if (existsSync(join(projectPath, '.gitlab-ci.yml'))) {
    intelligence.architecture.ciSystem = 'GitLab CI';
  } else if (existsSync(join(projectPath, '.circleci', 'config.yml'))) {
    intelligence.architecture.ciSystem = 'CircleCI';
  } else if (existsSync(join(projectPath, 'azure-pipelines.yml'))) {
    intelligence.architecture.ciSystem = 'Azure Pipelines';
  } else if (existsSync(join(projectPath, '.travis.yml'))) {
    intelligence.architecture.ciSystem = 'Travis CI';
  } else if (existsSync(join(projectPath, 'Jenkinsfile'))) {
    intelligence.architecture.ciSystem = 'Jenkins';
  } else if (existsSync(join(projectPath, '.drone.yml'))) {
    intelligence.architecture.ciSystem = 'Drone CI';
  }

  // ─── Containerization ────────────────────────────────────────────────────
  const containers: string[] = [];
  if (existsSync(join(projectPath, 'Dockerfile'))) containers.push('Docker');
  if (
    existsSync(join(projectPath, 'docker-compose.yml')) ||
    existsSync(join(projectPath, 'docker-compose.yaml')) ||
    existsSync(join(projectPath, 'compose.yml')) ||
    existsSync(join(projectPath, 'compose.yaml'))
  ) {
    containers.push('docker-compose');
  }
  if (existsSync(join(projectPath, 'k8s')) || existsSync(join(projectPath, 'kubernetes'))) {
    containers.push('Kubernetes');
  }
  if (existsSync(join(projectPath, 'Chart.yaml'))) {
    containers.push('Helm');
  }
  intelligence.architecture.containerization = containers;

  // ─── Monorepo tooling ────────────────────────────────────────────────────
  if (existsSync(join(projectPath, 'turbo.json'))) {
    intelligence.architecture.monorepoTool = 'Turborepo';
  } else if (existsSync(join(projectPath, 'nx.json'))) {
    intelligence.architecture.monorepoTool = 'Nx';
  } else if (existsSync(join(projectPath, 'lerna.json'))) {
    intelligence.architecture.monorepoTool = 'Lerna';
  } else if (existsSync(join(projectPath, 'pnpm-workspace.yaml'))) {
    intelligence.architecture.monorepoTool = 'pnpm workspaces';
  } else if (existsSync(join(projectPath, 'rush.json'))) {
    intelligence.architecture.monorepoTool = 'Rush';
  } else {
    // Yarn workspaces: detected via package.json "workspaces" field
    try {
      const pkgPath = join(projectPath, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.workspaces && (Array.isArray(pkg.workspaces) || typeof pkg.workspaces === 'object')) {
          intelligence.architecture.monorepoTool = 'Yarn/npm workspaces';
        }
      }
    } catch {}
  }
}

function analyzeConventions(projectPath: string, intelligence: ProjectIntelligence): void {
  // Find a sample code file to analyze
  const sampleExtensions = ['.ts', '.tsx', '.js', '.jsx'];
  let sampleContent: string | null = null;
  
  const srcDir = join(projectPath, 'src');
  const searchDir = existsSync(srcDir) ? srcDir : projectPath;
  
  try {
    const files = readdirSync(searchDir);
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (sampleExtensions.includes(ext)) {
        const content = readFileSync(join(searchDir, file), 'utf-8');
        if (content.length > 100) {
          sampleContent = content;
          break;
        }
      }
    }
  } catch {}
  
  if (!sampleContent) return;
  
  // Analyze indentation
  const tabCount = (sampleContent.match(/^\t/gm) || []).length;
  const spaceCount = (sampleContent.match(/^  /gm) || []).length;
  if (tabCount > spaceCount * 2) {
    intelligence.conventions.indentation = 'tabs';
  } else if (spaceCount > tabCount * 2) {
    intelligence.conventions.indentation = 'spaces';
  } else {
    intelligence.conventions.indentation = 'mixed';
  }
  
  // Analyze quotes
  const singleQuotes = (sampleContent.match(/'/g) || []).length;
  const doubleQuotes = (sampleContent.match(/"/g) || []).length;
  if (singleQuotes > doubleQuotes * 1.5) {
    intelligence.conventions.quotes = 'single';
  } else if (doubleQuotes > singleQuotes * 1.5) {
    intelligence.conventions.quotes = 'double';
  } else {
    intelligence.conventions.quotes = 'mixed';
  }
  
  // Analyze semicolons
  const semicolons = (sampleContent.match(/;\s*$/gm) || []).length;
  const statements = (sampleContent.match(/\n/g) || []).length;
  intelligence.conventions.semicolons = semicolons > statements * 0.3;
  
  // Analyze naming
  const camelCase = (sampleContent.match(/[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g) || []).length;
  const snakeCase = (sampleContent.match(/[a-z]+_[a-z]+/g) || []).length;
  if (camelCase > snakeCase * 2) {
    intelligence.conventions.namingStyle = 'camelCase';
  } else if (snakeCase > camelCase * 2) {
    intelligence.conventions.namingStyle = 'snake_case';
  } else {
    intelligence.conventions.namingStyle = 'mixed';
  }
}

function detectTesting(projectPath: string, intelligence: ProjectIntelligence): void {
  // Check for test directories
  const testDirs = ['test', 'tests', '__tests__', 'spec', 'specs'];
  for (const dir of testDirs) {
    if (existsSync(join(projectPath, dir))) {
      intelligence.testing.hasTests = true;
      intelligence.testing.testDirectory = dir;
      break;
    }
  }
  
  // Also check src/__tests__
  if (existsSync(join(projectPath, 'src', '__tests__'))) {
    intelligence.testing.hasTests = true;
    intelligence.testing.testDirectory = 'src/__tests__';
  }
  
  // Detect framework from config files or dependencies
  if (existsSync(join(projectPath, 'jest.config.js')) || 
      existsSync(join(projectPath, 'jest.config.ts')) ||
      intelligence.dependencies.dev.includes('jest')) {
    intelligence.testing.framework = 'Jest';
    intelligence.testing.hasTests = true;
  } else if (existsSync(join(projectPath, 'vitest.config.ts')) ||
             existsSync(join(projectPath, 'vitest.config.js')) ||
             intelligence.dependencies.dev.includes('vitest')) {
    intelligence.testing.framework = 'Vitest';
    intelligence.testing.hasTests = true;
  } else if (existsSync(join(projectPath, 'pytest.ini')) ||
             existsSync(join(projectPath, 'pyproject.toml'))) {
    intelligence.testing.framework = 'Pytest';
    intelligence.testing.hasTests = true;
  } else if (intelligence.dependencies.dev.includes('mocha')) {
    intelligence.testing.framework = 'Mocha';
    intelligence.testing.hasTests = true;
  }
}
