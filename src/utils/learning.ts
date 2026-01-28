/**
 * Learning Mode - remember user preferences and coding style
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Learning data storage
const LEARNING_DIR = join(homedir(), '.codeep', 'learning');
const GLOBAL_PREFS_FILE = join(LEARNING_DIR, 'preferences.json');

export interface UserPreferences {
  // Code style preferences
  codeStyle: {
    indentation: 'tabs' | 'spaces';
    indentSize: number;
    quotes: 'single' | 'double';
    semicolons: boolean;
    trailingComma: 'none' | 'es5' | 'all';
    lineWidth: number;
  };
  
  // Naming conventions
  naming: {
    variables: 'camelCase' | 'snake_case' | 'PascalCase';
    functions: 'camelCase' | 'snake_case' | 'PascalCase';
    classes: 'PascalCase' | 'camelCase';
    constants: 'UPPER_CASE' | 'camelCase';
    files: 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case';
  };
  
  // Framework preferences
  frameworks: {
    frontend?: string;
    backend?: string;
    testing?: string;
    styling?: string;
    stateManagement?: string;
  };
  
  // Language preferences
  languages: {
    primary?: string;
    preferTypeScript: boolean;
    preferAsyncAwait: boolean;
  };
  
  // Patterns learned
  patterns: {
    importStyle?: 'named' | 'default' | 'mixed';
    exportStyle?: 'named' | 'default' | 'mixed';
    componentStyle?: 'functional' | 'class';
    errorHandling?: 'try-catch' | 'then-catch' | 'result-type';
  };
  
  // Frequently used libraries
  preferredLibraries: string[];
  
  // Custom rules
  customRules: string[];
  
  // Learning metadata
  lastUpdated: number;
  sampleCount: number;
}

export interface ProjectPreferences extends UserPreferences {
  projectPath: string;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  codeStyle: {
    indentation: 'spaces',
    indentSize: 2,
    quotes: 'single',
    semicolons: true,
    trailingComma: 'es5',
    lineWidth: 100,
  },
  naming: {
    variables: 'camelCase',
    functions: 'camelCase',
    classes: 'PascalCase',
    constants: 'UPPER_CASE',
    files: 'kebab-case',
  },
  frameworks: {},
  languages: {
    preferTypeScript: true,
    preferAsyncAwait: true,
  },
  patterns: {},
  preferredLibraries: [],
  customRules: [],
  lastUpdated: Date.now(),
  sampleCount: 0,
};

/**
 * Ensure learning directory exists
 */
function ensureLearningDir(): void {
  if (!existsSync(LEARNING_DIR)) {
    mkdirSync(LEARNING_DIR, { recursive: true });
  }
}

/**
 * Get project-specific preferences file path
 */
function getProjectPrefsPath(projectRoot: string): string {
  const projectId = Buffer.from(projectRoot).toString('base64url').substring(0, 32);
  return join(LEARNING_DIR, `project-${projectId}.json`);
}

/**
 * Load global preferences
 */
export function loadGlobalPreferences(): UserPreferences {
  ensureLearningDir();
  
  if (existsSync(GLOBAL_PREFS_FILE)) {
    try {
      const content = readFileSync(GLOBAL_PREFS_FILE, 'utf-8');
      return { ...DEFAULT_PREFERENCES, ...JSON.parse(content) };
    } catch {}
  }
  
  return { ...DEFAULT_PREFERENCES };
}

/**
 * Save global preferences
 */
export function saveGlobalPreferences(prefs: UserPreferences): void {
  ensureLearningDir();
  prefs.lastUpdated = Date.now();
  writeFileSync(GLOBAL_PREFS_FILE, JSON.stringify(prefs, null, 2));
}

/**
 * Load project-specific preferences
 */
export function loadProjectPreferences(projectRoot: string): UserPreferences {
  const globalPrefs = loadGlobalPreferences();
  const projectPrefsPath = getProjectPrefsPath(projectRoot);
  
  if (existsSync(projectPrefsPath)) {
    try {
      const content = readFileSync(projectPrefsPath, 'utf-8');
      const projectPrefs = JSON.parse(content);
      // Merge with global, project takes precedence
      return { ...globalPrefs, ...projectPrefs };
    } catch {}
  }
  
  return globalPrefs;
}

/**
 * Save project-specific preferences
 */
export function saveProjectPreferences(projectRoot: string, prefs: Partial<UserPreferences>): void {
  ensureLearningDir();
  const projectPrefsPath = getProjectPrefsPath(projectRoot);
  
  const existing = existsSync(projectPrefsPath)
    ? JSON.parse(readFileSync(projectPrefsPath, 'utf-8'))
    : {};
  
  const merged = { ...existing, ...prefs, lastUpdated: Date.now() };
  writeFileSync(projectPrefsPath, JSON.stringify(merged, null, 2));
}

/**
 * Analyze code to learn preferences
 */
export function learnFromCode(
  code: string,
  filename: string,
  currentPrefs: UserPreferences
): Partial<UserPreferences> {
  const learned: Partial<UserPreferences> = {};
  const codeStyle: Partial<UserPreferences['codeStyle']> = {};
  const naming: Partial<UserPreferences['naming']> = {};
  const patterns: Partial<UserPreferences['patterns']> = {};
  
  const lines = code.split('\n');
  
  // Learn indentation
  const indentedLines = lines.filter(l => l.match(/^(\s+)\S/));
  if (indentedLines.length > 0) {
    const firstIndent = indentedLines[0].match(/^(\s+)/)?.[1] || '';
    if (firstIndent.includes('\t')) {
      codeStyle.indentation = 'tabs';
    } else {
      codeStyle.indentation = 'spaces';
      codeStyle.indentSize = firstIndent.length;
    }
  }
  
  // Learn quote style
  const singleQuotes = (code.match(/'/g) || []).length;
  const doubleQuotes = (code.match(/"/g) || []).length;
  if (singleQuotes > doubleQuotes * 1.5) {
    codeStyle.quotes = 'single';
  } else if (doubleQuotes > singleQuotes * 1.5) {
    codeStyle.quotes = 'double';
  }
  
  // Learn semicolon usage
  const withSemicolons = (code.match(/;\s*$/gm) || []).length;
  const statements = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
  codeStyle.semicolons = withSemicolons > statements * 0.5;
  
  // Learn trailing comma
  if (code.includes(',\n]') || code.includes(',\n}')) {
    codeStyle.trailingComma = 'all';
  }
  
  // Learn naming conventions from variable declarations
  const varMatches = code.matchAll(/(?:const|let|var)\s+(\w+)/g);
  let camelCount = 0;
  let snakeCount = 0;
  
  for (const match of varMatches) {
    const name = match[1];
    if (name.includes('_')) snakeCount++;
    else if (/^[a-z]/.test(name) && /[A-Z]/.test(name)) camelCount++;
  }
  
  if (camelCount > snakeCount * 2) {
    naming.variables = 'camelCase';
  } else if (snakeCount > camelCount * 2) {
    naming.variables = 'snake_case';
  }
  
  // Learn import style
  const namedImports = (code.match(/import\s*{[^}]+}\s*from/g) || []).length;
  const defaultImports = (code.match(/import\s+\w+\s+from/g) || []).length;
  
  if (namedImports > defaultImports * 2) {
    patterns.importStyle = 'named';
  } else if (defaultImports > namedImports * 2) {
    patterns.importStyle = 'default';
  } else {
    patterns.importStyle = 'mixed';
  }
  
  // Learn component style (React)
  if (code.includes('function') && code.includes('return') && code.includes('<')) {
    patterns.componentStyle = 'functional';
  } else if (code.includes('class') && code.includes('extends') && code.includes('render')) {
    patterns.componentStyle = 'class';
  }
  
  // Learn async/await vs then/catch
  const asyncAwait = (code.match(/async|await/g) || []).length;
  const thenCatch = (code.match(/\.then\(|\.catch\(/g) || []).length;
  
  if (asyncAwait > thenCatch) {
    learned.languages = { ...currentPrefs.languages, preferAsyncAwait: true };
  }
  
  // Learn preferred libraries
  const libraries: string[] = [];
  const importMatches = code.matchAll(/import\s+.*?\s+from\s+['"]([^'"./][^'"]*)['"]/g);
  for (const match of importMatches) {
    const lib = match[1].split('/')[0];
    if (!libraries.includes(lib)) {
      libraries.push(lib);
    }
  }
  
  if (libraries.length > 0) {
    learned.preferredLibraries = [
      ...new Set([...currentPrefs.preferredLibraries, ...libraries]),
    ].slice(0, 20);
  }
  
  // Merge learned styles
  if (Object.keys(codeStyle).length > 0) {
    learned.codeStyle = { ...currentPrefs.codeStyle, ...codeStyle };
  }
  if (Object.keys(naming).length > 0) {
    learned.naming = { ...currentPrefs.naming, ...naming };
  }
  if (Object.keys(patterns).length > 0) {
    learned.patterns = { ...currentPrefs.patterns, ...patterns };
  }
  
  learned.sampleCount = (currentPrefs.sampleCount || 0) + 1;
  
  return learned;
}

/**
 * Learn from multiple files in a project
 */
export function learnFromProject(projectRoot: string, files: string[]): UserPreferences {
  let prefs = loadProjectPreferences(projectRoot);
  
  for (const file of files.slice(0, 20)) { // Limit to 20 files
    try {
      const content = readFileSync(join(projectRoot, file), 'utf-8');
      const learned = learnFromCode(content, file, prefs);
      prefs = { ...prefs, ...learned };
    } catch {}
  }
  
  saveProjectPreferences(projectRoot, prefs);
  return prefs;
}

/**
 * Format preferences for system prompt
 */
export function formatPreferencesForPrompt(prefs: UserPreferences): string {
  const lines: string[] = ['## User Preferences (Learned)', ''];
  
  // Code style
  lines.push('### Code Style');
  lines.push(`- Indentation: ${prefs.codeStyle.indentSize} ${prefs.codeStyle.indentation}`);
  lines.push(`- Quotes: ${prefs.codeStyle.quotes}`);
  lines.push(`- Semicolons: ${prefs.codeStyle.semicolons ? 'yes' : 'no'}`);
  lines.push(`- Trailing comma: ${prefs.codeStyle.trailingComma}`);
  lines.push('');
  
  // Naming
  lines.push('### Naming Conventions');
  lines.push(`- Variables: ${prefs.naming.variables}`);
  lines.push(`- Functions: ${prefs.naming.functions}`);
  lines.push(`- Classes: ${prefs.naming.classes}`);
  lines.push(`- Files: ${prefs.naming.files}`);
  lines.push('');
  
  // Patterns
  if (Object.keys(prefs.patterns).length > 0) {
    lines.push('### Patterns');
    if (prefs.patterns.importStyle) lines.push(`- Import style: ${prefs.patterns.importStyle}`);
    if (prefs.patterns.componentStyle) lines.push(`- Components: ${prefs.patterns.componentStyle}`);
    if (prefs.patterns.errorHandling) lines.push(`- Error handling: ${prefs.patterns.errorHandling}`);
    lines.push('');
  }
  
  // Libraries
  if (prefs.preferredLibraries.length > 0) {
    lines.push('### Preferred Libraries');
    lines.push(prefs.preferredLibraries.slice(0, 10).join(', '));
    lines.push('');
  }
  
  // Custom rules
  if (prefs.customRules.length > 0) {
    lines.push('### Custom Rules');
    for (const rule of prefs.customRules) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }
  
  lines.push('Follow these preferences when writing code.');
  
  return lines.join('\n');
}

/**
 * Add a custom rule
 */
export function addCustomRule(rule: string, projectRoot?: string): void {
  if (projectRoot) {
    const prefs = loadProjectPreferences(projectRoot);
    prefs.customRules = [...new Set([...prefs.customRules, rule])];
    saveProjectPreferences(projectRoot, prefs);
  } else {
    const prefs = loadGlobalPreferences();
    prefs.customRules = [...new Set([...prefs.customRules, rule])];
    saveGlobalPreferences(prefs);
  }
}

/**
 * Remove a custom rule
 */
export function removeCustomRule(rule: string, projectRoot?: string): void {
  if (projectRoot) {
    const prefs = loadProjectPreferences(projectRoot);
    prefs.customRules = prefs.customRules.filter(r => r !== rule);
    saveProjectPreferences(projectRoot, prefs);
  } else {
    const prefs = loadGlobalPreferences();
    prefs.customRules = prefs.customRules.filter(r => r !== rule);
    saveGlobalPreferences(prefs);
  }
}

/**
 * Reset preferences
 */
export function resetPreferences(projectRoot?: string): void {
  if (projectRoot) {
    const projectPrefsPath = getProjectPrefsPath(projectRoot);
    if (existsSync(projectPrefsPath)) {
      writeFileSync(projectPrefsPath, JSON.stringify({}, null, 2));
    }
  } else {
    saveGlobalPreferences({ ...DEFAULT_PREFERENCES });
  }
}

/**
 * Get learning status
 */
export function getLearningStatus(projectRoot?: string): string {
  const prefs = projectRoot
    ? loadProjectPreferences(projectRoot)
    : loadGlobalPreferences();
  
  const lines: string[] = [];
  lines.push(`Samples analyzed: ${prefs.sampleCount || 0}`);
  lines.push(`Last updated: ${new Date(prefs.lastUpdated).toLocaleString()}`);
  lines.push(`Libraries known: ${prefs.preferredLibraries.length}`);
  lines.push(`Custom rules: ${prefs.customRules.length}`);
  
  return lines.join('\n');
}
