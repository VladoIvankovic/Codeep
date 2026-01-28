/**
 * Code Review Mode - AI-powered code review
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { ProjectContext } from './project';
import { getGitDiff, getChangedFiles } from './git';

export interface ReviewIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  category: ReviewCategory;
  message: string;
  suggestion?: string;
}

export type ReviewCategory = 
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'bug'
  | 'style'
  | 'types'
  | 'best-practice'
  | 'documentation';

export interface ReviewResult {
  files: string[];
  issues: ReviewIssue[];
  summary: ReviewSummary;
  score: number; // 0-100
}

export interface ReviewSummary {
  totalIssues: number;
  byCategory: Record<ReviewCategory, number>;
  bySeverity: Record<string, number>;
}

// Common code patterns that indicate issues
const CODE_PATTERNS: Array<{
  pattern: RegExp;
  category: ReviewCategory;
  severity: ReviewIssue['severity'];
  message: string;
  suggestion?: string;
  extensions?: string[];
}> = [
  // Security issues
  {
    pattern: /eval\s*\(/g,
    category: 'security',
    severity: 'error',
    message: 'Use of eval() is dangerous and can lead to code injection',
    suggestion: 'Use JSON.parse() or a safer alternative',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  {
    pattern: /innerHTML\s*=/g,
    category: 'security',
    severity: 'warning',
    message: 'innerHTML can lead to XSS vulnerabilities',
    suggestion: 'Use textContent or sanitize input before using innerHTML',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  {
    pattern: /dangerouslySetInnerHTML/g,
    category: 'security',
    severity: 'warning',
    message: 'dangerouslySetInnerHTML can lead to XSS if not properly sanitized',
    suggestion: 'Ensure content is sanitized using DOMPurify or similar',
    extensions: ['.jsx', '.tsx'],
  },
  {
    pattern: /password\s*=\s*['"][^'"]+['"]/gi,
    category: 'security',
    severity: 'error',
    message: 'Hardcoded password detected',
    suggestion: 'Use environment variables for sensitive data',
  },
  {
    pattern: /api[_-]?key\s*=\s*['"][^'"]+['"]/gi,
    category: 'security',
    severity: 'error',
    message: 'Hardcoded API key detected',
    suggestion: 'Use environment variables for API keys',
  },
  
  // Performance issues
  {
    pattern: /\.forEach\s*\([^)]*\)\s*{\s*await/g,
    category: 'performance',
    severity: 'warning',
    message: 'Sequential async operations in forEach are inefficient',
    suggestion: 'Use Promise.all() with map() for parallel execution',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  {
    pattern: /for\s*\([^)]+\)\s*{\s*await/g,
    category: 'performance',
    severity: 'info',
    message: 'Consider if sequential await in loop is necessary',
    suggestion: 'Use Promise.all() if operations can run in parallel',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  {
    pattern: /SELECT\s+\*/gi,
    category: 'performance',
    severity: 'warning',
    message: 'SELECT * can be inefficient, select only needed columns',
    suggestion: 'Specify required columns explicitly',
  },
  
  // Bug-prone patterns
  {
    pattern: /==\s*null|null\s*==/g,
    category: 'bug',
    severity: 'info',
    message: 'Using == for null check also matches undefined',
    suggestion: 'Use === null or == null intentionally',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  {
    pattern: /catch\s*\(\s*\w*\s*\)\s*{\s*}/g,
    category: 'bug',
    severity: 'warning',
    message: 'Empty catch block swallows errors silently',
    suggestion: 'Log the error or handle it appropriately',
  },
  {
    pattern: /console\.(log|debug|info|warn|error)\s*\(/g,
    category: 'maintainability',
    severity: 'info',
    message: 'Console statement found - remove before production',
    suggestion: 'Use a proper logging library',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  {
    pattern: /TODO|FIXME|HACK|XXX/g,
    category: 'maintainability',
    severity: 'info',
    message: 'TODO/FIXME comment found',
    suggestion: 'Address the TODO or create a ticket',
  },
  
  // Type safety
  {
    pattern: /:\s*any\b/g,
    category: 'types',
    severity: 'warning',
    message: 'Using "any" type bypasses type checking',
    suggestion: 'Use a more specific type or unknown',
    extensions: ['.ts', '.tsx'],
  },
  {
    pattern: /@ts-ignore/g,
    category: 'types',
    severity: 'warning',
    message: '@ts-ignore suppresses TypeScript errors',
    suggestion: 'Fix the underlying type issue instead',
    extensions: ['.ts', '.tsx'],
  },
  {
    pattern: /as\s+any\b/g,
    category: 'types',
    severity: 'warning',
    message: 'Type assertion to "any" bypasses type safety',
    suggestion: 'Use proper type assertion or fix the types',
    extensions: ['.ts', '.tsx'],
  },
  
  // Best practices
  {
    pattern: /var\s+\w+/g,
    category: 'best-practice',
    severity: 'info',
    message: 'Using var instead of let/const',
    suggestion: 'Use const for constants, let for variables',
    extensions: ['.js', '.jsx'],
  },
  {
    pattern: /function\s*\(/g,
    category: 'style',
    severity: 'info',
    message: 'Anonymous function expression',
    suggestion: 'Consider using arrow functions or named functions',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
  
  // Documentation
  {
    pattern: /export\s+(default\s+)?(?:function|class|const)\s+\w+/g,
    category: 'documentation',
    severity: 'suggestion',
    message: 'Exported function/class without JSDoc',
    suggestion: 'Add JSDoc documentation for public APIs',
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },
];

/**
 * Analyze a single file for issues
 */
function analyzeFile(
  filePath: string,
  content: string,
  projectRoot: string
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const ext = extname(filePath);
  const relativePath = relative(projectRoot, filePath);
  const lines = content.split('\n');
  
  for (const pattern of CODE_PATTERNS) {
    // Skip if pattern doesn't apply to this file type
    if (pattern.extensions && !pattern.extensions.includes(ext)) {
      continue;
    }
    
    // Find all matches
    let match;
    const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
    
    while ((match = regex.exec(content)) !== null) {
      // Find line number
      const beforeMatch = content.slice(0, match.index);
      const lineNumber = beforeMatch.split('\n').length;
      
      issues.push({
        file: relativePath,
        line: lineNumber,
        severity: pattern.severity,
        category: pattern.category,
        message: pattern.message,
        suggestion: pattern.suggestion,
      });
    }
  }
  
  // Check for long files
  if (lines.length > 500) {
    issues.push({
      file: relativePath,
      severity: 'info',
      category: 'maintainability',
      message: `File has ${lines.length} lines - consider splitting into smaller modules`,
    });
  }
  
  // Check for long functions (basic heuristic)
  let braceDepth = 0;
  let functionStart = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (/function\s+\w+|=>\s*{|\)\s*{/.test(line)) {
      if (braceDepth === 0) {
        functionStart = i;
      }
    }
    
    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;
    
    if (braceDepth === 0 && functionStart !== -1) {
      const functionLength = i - functionStart;
      if (functionLength > 50) {
        issues.push({
          file: relativePath,
          line: functionStart + 1,
          severity: 'info',
          category: 'maintainability',
          message: `Function is ${functionLength} lines long - consider breaking it down`,
        });
      }
      functionStart = -1;
    }
  }
  
  return issues;
}

/**
 * Get files to review
 */
function getFilesToReview(
  projectRoot: string,
  specificFiles?: string[]
): string[] {
  if (specificFiles && specificFiles.length > 0) {
    return specificFiles
      .map(f => join(projectRoot, f))
      .filter(f => existsSync(f));
  }
  
  // Get changed files from git
  const changedFiles = getChangedFiles(projectRoot);
  if (changedFiles.length > 0) {
    return changedFiles.map(f => join(projectRoot, f));
  }
  
  // Otherwise, review src directory
  const srcDir = join(projectRoot, 'src');
  if (existsSync(srcDir)) {
    return getAllSourceFiles(srcDir);
  }
  
  return getAllSourceFiles(projectRoot);
}

/**
 * Get all source files in directory
 */
function getAllSourceFiles(dir: string, maxFiles: number = 50): string[] {
  const files: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '__pycache__']);
  
  function walk(currentDir: string) {
    if (files.length >= maxFiles) return;
    
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        
        const fullPath = join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (['.ts', '.tsx', '.js', '.jsx', '.py', '.php', '.go', '.rs'].includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {}
  }
  
  walk(dir);
  return files;
}

/**
 * Perform code review
 */
export function performCodeReview(
  projectContext: ProjectContext,
  specificFiles?: string[]
): ReviewResult {
  const projectRoot = projectContext.root || process.cwd();
  const filesToReview = getFilesToReview(projectRoot, specificFiles);
  const allIssues: ReviewIssue[] = [];
  
  for (const filePath of filesToReview) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const issues = analyzeFile(filePath, content, projectRoot);
      allIssues.push(...issues);
    } catch {}
  }
  
  // Calculate summary
  const summary: ReviewSummary = {
    totalIssues: allIssues.length,
    byCategory: {} as Record<ReviewCategory, number>,
    bySeverity: { error: 0, warning: 0, info: 0, suggestion: 0 },
  };
  
  for (const issue of allIssues) {
    summary.byCategory[issue.category] = (summary.byCategory[issue.category] || 0) + 1;
    summary.bySeverity[issue.severity]++;
  }
  
  // Calculate score (100 - deductions)
  let score = 100;
  score -= summary.bySeverity.error * 10;
  score -= summary.bySeverity.warning * 3;
  score -= summary.bySeverity.info * 1;
  score = Math.max(0, Math.min(100, score));
  
  return {
    files: filesToReview.map(f => relative(projectRoot, f)),
    issues: allIssues,
    summary,
    score,
  };
}

/**
 * Format review result for display
 */
export function formatReviewResult(result: ReviewResult): string {
  const lines: string[] = [];
  
  // Header
  lines.push('# Code Review Report');
  lines.push('');
  
  // Score
  const scoreEmoji = result.score >= 80 ? '✅' : result.score >= 60 ? '⚠️' : '❌';
  lines.push(`## Score: ${result.score}/100 ${scoreEmoji}`);
  lines.push('');
  
  // Summary
  lines.push('## Summary');
  lines.push(`- Files reviewed: ${result.files.length}`);
  lines.push(`- Total issues: ${result.summary.totalIssues}`);
  lines.push(`  - Errors: ${result.summary.bySeverity.error}`);
  lines.push(`  - Warnings: ${result.summary.bySeverity.warning}`);
  lines.push(`  - Info: ${result.summary.bySeverity.info}`);
  lines.push('');
  
  // Issues by category
  if (result.summary.totalIssues > 0) {
    lines.push('## Issues by Category');
    for (const [category, count] of Object.entries(result.summary.byCategory)) {
      if (count > 0) {
        lines.push(`- ${category}: ${count}`);
      }
    }
    lines.push('');
    
    // Detailed issues
    lines.push('## Detailed Issues');
    lines.push('');
    
    // Group by file
    const byFile = new Map<string, ReviewIssue[]>();
    for (const issue of result.issues) {
      const existing = byFile.get(issue.file) || [];
      existing.push(issue);
      byFile.set(issue.file, existing);
    }
    
    for (const [file, issues] of byFile) {
      lines.push(`### ${file}`);
      for (const issue of issues.slice(0, 10)) { // Limit issues per file
        const loc = issue.line ? `:${issue.line}` : '';
        const icon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
        lines.push(`${icon} **${issue.category}**${loc}: ${issue.message}`);
        if (issue.suggestion) {
          lines.push(`   → ${issue.suggestion}`);
        }
      }
      if (issues.length > 10) {
        lines.push(`   ... and ${issues.length - 10} more issues`);
      }
      lines.push('');
    }
  } else {
    lines.push('## No issues found! 🎉');
  }
  
  return lines.join('\n');
}

/**
 * Get review prompt for AI-enhanced review
 */
export function getReviewSystemPrompt(result: ReviewResult): string {
  return `You are a code reviewer. Analyze the following code review results and provide additional insights.

## Automated Review Results
${formatReviewResult(result)}

## Your Task
1. Identify any additional issues the automated review might have missed
2. Prioritize the most critical issues to fix first
3. Provide specific, actionable recommendations
4. Highlight any positive aspects of the code

Be concise and practical. Focus on issues that matter most for code quality and maintainability.`;
}
