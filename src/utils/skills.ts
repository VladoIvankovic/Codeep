/**
 * Skills System - predefined workflows and commands
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { ProjectContext } from './project';

// Skills directory
const SKILLS_DIR = join(homedir(), '.codeep', 'skills');
const SKILLS_HISTORY_FILE = join(homedir(), '.codeep', 'skill-history.json');

// Skill usage tracking
interface SkillUsageEntry {
  skillName: string;
  timestamp: number;
  success: boolean;
}

interface SkillHistory {
  entries: SkillUsageEntry[];
  maxEntries: number;
}

export interface SkillStep {
  type: 'prompt' | 'command' | 'confirm' | 'notify' | 'agent';
  content: string;
  optional?: boolean;
}

export interface SkillParameter {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface Skill {
  name: string;
  description: string;
  shortcut?: string;  // e.g., "c" for /c → commit
  category: SkillCategory;
  steps: SkillStep[];
  parameters?: SkillParameter[];  // Skill parameters
  requiresWriteAccess?: boolean;
  requiresGit?: boolean;
}

export type SkillCategory = 
  | 'git'
  | 'testing'
  | 'documentation'
  | 'refactoring'
  | 'debugging'
  | 'deployment'
  | 'generation'
  | 'devops'
  | 'custom';

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  steps: { step: SkillStep; result: string; success: boolean }[];
}

export interface SkillChain {
  skills: string[];
  stopOnError: boolean;
}

// Built-in skills
const BUILT_IN_SKILLS: Skill[] = [
  // ==================== GIT SKILLS ====================
  {
    name: 'commit',
    description: 'Generate commit message and commit changes',
    shortcut: 'c',
    category: 'git',
    requiresGit: true,
    parameters: [
      { name: 'message', description: 'Optional commit message (skips AI generation)', required: false },
    ],
    steps: [
      { type: 'command', content: 'git diff --cached --stat || git diff --stat' },
      { type: 'prompt', content: 'Based on this git diff, generate ONLY a conventional commit message (no explanation, no markdown). Format: type(scope): description. Types: feat, fix, docs, style, refactor, test, chore. Be concise. One line only.\n\n${_prev}' },
      { type: 'confirm', content: 'Commit with this message?' },
      { type: 'command', content: 'git add -A && git commit -m "${_prev}"' },
      { type: 'notify', content: 'Changes committed successfully!' },
    ],
  },
  {
    name: 'amend',
    description: 'Amend the last commit',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'command', content: 'git add -A' },
      { type: 'confirm', content: 'Amend the last commit with staged changes?' },
      { type: 'command', content: 'git commit --amend --no-edit' },
      { type: 'notify', content: 'Commit amended!' },
    ],
  },
  {
    name: 'push',
    description: 'Push changes to remote',
    shortcut: 'p',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'command', content: 'git push' },
      { type: 'notify', content: 'Changes pushed!' },
    ],
  },
  {
    name: 'pull',
    description: 'Pull latest changes from remote',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'command', content: 'git pull' },
      { type: 'notify', content: 'Changes pulled!' },
    ],
  },
  {
    name: 'pr',
    description: 'Create a pull request description',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'prompt', content: 'Analyze the commits since main/master branch and generate a pull request description. Include: title, summary of changes, any breaking changes, and testing notes.' },
    ],
  },
  {
    name: 'changelog',
    description: 'Generate changelog from recent commits',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'command', content: 'git log --oneline -20' },
      { type: 'prompt', content: 'Based on these commits, generate a changelog entry in Keep a Changelog format. Group by: Added, Changed, Fixed, Removed.' },
    ],
  },
  {
    name: 'branch',
    description: 'Create a new branch with smart naming',
    category: 'git',
    requiresGit: true,
    parameters: [
      { name: 'description', description: 'What the branch is for', required: true },
    ],
    steps: [
      { type: 'prompt', content: 'Based on the description "${description}", suggest a branch name following convention: type/short-description. Types: feature, fix, hotfix, refactor, chore.' },
      { type: 'confirm', content: 'Create this branch?' },
      { type: 'command', content: 'git checkout -b ${branch}' },
    ],
  },
  {
    name: 'stash',
    description: 'Stash changes with a meaningful message',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'prompt', content: 'Analyze the current changes and suggest a meaningful stash message.' },
      { type: 'command', content: 'git stash push -m "${message}"' },
      { type: 'notify', content: 'Changes stashed!' },
    ],
  },
  {
    name: 'unstash',
    description: 'Apply and drop the most recent stash',
    category: 'git',
    requiresGit: true,
    steps: [
      { type: 'command', content: 'git stash pop' },
      { type: 'notify', content: 'Stash applied!' },
    ],
  },
  
  // ==================== TESTING SKILLS ====================
  {
    name: 'test',
    description: 'Generate tests for current file or function',
    shortcut: 't',
    category: 'testing',
    requiresWriteAccess: true,
    parameters: [
      { name: 'file', description: 'File or function to test', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Analyze the current file and generate comprehensive unit tests. Use the existing test framework in the project. Cover edge cases and error scenarios. Write tests in a separate test file following project conventions.' },
    ],
  },
  {
    name: 'test-fix',
    description: 'Fix failing tests',
    category: 'testing',
    requiresWriteAccess: true,
    steps: [
      { type: 'command', content: 'npm test 2>&1 || true' },
      { type: 'agent', content: 'Analyze the test failures above and fix them. Either fix the tests if they are incorrect, or fix the code if the tests are correct.' },
    ],
  },
  {
    name: 'coverage',
    description: 'Analyze test coverage and suggest improvements',
    category: 'testing',
    steps: [
      { type: 'command', content: 'npm run test:coverage 2>&1 || npm test -- --coverage 2>&1 || true' },
      { type: 'prompt', content: 'Analyze the test coverage report and suggest which files/functions need more tests. Prioritize by importance and complexity.' },
    ],
  },
  {
    name: 'e2e',
    description: 'Generate end-to-end tests',
    category: 'testing',
    requiresWriteAccess: true,
    parameters: [
      { name: 'feature', description: 'Feature to test', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Generate end-to-end tests for the feature "${feature}". Use Playwright, Cypress, or the e2e framework already in the project. Cover the main user flows and edge cases.' },
    ],
  },
  {
    name: 'mock',
    description: 'Generate mock data for testing',
    category: 'testing',
    requiresWriteAccess: true,
    parameters: [
      { name: 'type', description: 'Type/interface to mock', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Generate realistic mock data for the type "${type}". Create a mock factory function that can generate multiple variations. Include edge cases (empty strings, null values, special characters).' },
    ],
  },
  
  // ==================== DOCUMENTATION SKILLS ====================
  {
    name: 'docs',
    description: 'Generate documentation for code',
    shortcut: 'd',
    category: 'documentation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'file', description: 'File to document', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Add JSDoc/docstring documentation to all exported functions, classes, and interfaces in the current file. Include parameter descriptions, return types, and examples where helpful.' },
    ],
  },
  {
    name: 'readme',
    description: 'Generate or update README',
    category: 'documentation',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Analyze the project structure and generate a comprehensive README.md. Include: project description, installation, usage, configuration, API documentation if applicable, and contributing guidelines.' },
    ],
  },
  {
    name: 'explain',
    description: 'Explain how the code works',
    shortcut: 'e',
    category: 'documentation',
    parameters: [
      { name: 'file', description: 'File to explain', required: false },
    ],
    steps: [
      { type: 'prompt', content: 'Explain how this code works in detail. Cover: purpose, data flow, key functions, dependencies, and potential gotchas. Use simple language.' },
    ],
  },
  {
    name: 'api-docs',
    description: 'Generate API documentation',
    category: 'documentation',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Generate API documentation for all endpoints in the project. For each endpoint, document: HTTP method, path, parameters, request body, response format, status codes, and examples.' },
    ],
  },
  {
    name: 'translate',
    description: 'Translate code comments to English',
    category: 'documentation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'file', description: 'File to translate', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Translate all comments in this file to English. Keep the code unchanged, only translate comments and documentation strings.' },
    ],
  },
  
  // ==================== REFACTORING SKILLS ====================
  {
    name: 'refactor',
    description: 'Refactor code for better quality',
    shortcut: 'r',
    category: 'refactoring',
    requiresWriteAccess: true,
    parameters: [
      { name: 'file', description: 'File to refactor', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Refactor the current file to improve code quality. Focus on: extracting functions, reducing complexity, improving naming, removing duplication, and following best practices. Keep functionality identical.' },
    ],
  },
  {
    name: 'types',
    description: 'Add or improve TypeScript types',
    category: 'refactoring',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Improve TypeScript types in this file. Replace any types with proper types, add missing type annotations, create interfaces for complex objects, and ensure strict type safety.' },
    ],
  },
  {
    name: 'optimize',
    description: 'Optimize code performance',
    shortcut: 'o',
    category: 'refactoring',
    requiresWriteAccess: true,
    steps: [
      { type: 'prompt', content: 'Analyze this code for performance issues. Identify: unnecessary re-renders, memory leaks, inefficient algorithms, missing caching opportunities, and N+1 queries.' },
      { type: 'confirm', content: 'Apply optimizations?' },
      { type: 'agent', content: 'Apply the suggested performance optimizations.' },
    ],
  },
  {
    name: 'cleanup',
    description: 'Clean up code (remove unused, format)',
    category: 'refactoring',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Clean up this file: remove unused imports, remove dead code, remove console.logs, fix formatting inconsistencies, and organize imports.' },
    ],
  },
  {
    name: 'modernize',
    description: 'Update code to use modern syntax',
    category: 'refactoring',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Update this code to use modern JavaScript/TypeScript syntax. Convert: var to const/let, callbacks to async/await, .then chains to async/await, class components to functional (React), and old APIs to modern equivalents.' },
    ],
  },
  {
    name: 'migrate',
    description: 'Migrate code to newer version',
    category: 'refactoring',
    requiresWriteAccess: true,
    parameters: [
      { name: 'target', description: 'Target version or framework (e.g., React 18, Node 20)', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Migrate the codebase to ${target}. Update deprecated APIs, fix breaking changes, and update dependencies as needed. Follow the official migration guide.' },
    ],
  },
  {
    name: 'split',
    description: 'Split a large file into smaller modules',
    category: 'refactoring',
    requiresWriteAccess: true,
    parameters: [
      { name: 'file', description: 'File to split', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Split the file "${file}" into smaller, focused modules. Group related functions together, create proper exports, and update all imports across the project.' },
    ],
  },
  {
    name: 'rename',
    description: 'Rename a symbol across the codebase',
    category: 'refactoring',
    requiresWriteAccess: true,
    parameters: [
      { name: 'old', description: 'Current name', required: true },
      { name: 'new', description: 'New name', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Rename "${old}" to "${new}" across the entire codebase. Update all references, imports, and documentation.' },
    ],
  },
  
  // ==================== DEBUGGING SKILLS ====================
  {
    name: 'debug',
    description: 'Debug and fix issues',
    shortcut: 'b',
    category: 'debugging',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Analyze the code and identify potential bugs. Check for: null pointer errors, race conditions, incorrect logic, missing error handling, and edge cases. Fix any issues found.' },
    ],
  },
  {
    name: 'fix',
    description: 'Fix a specific error or issue',
    shortcut: 'f',
    category: 'debugging',
    requiresWriteAccess: true,
    parameters: [
      { name: 'error', description: 'Error message or description', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Fix the error or issue described. Read relevant files, understand the problem, implement a fix, and verify it works.' },
    ],
  },
  {
    name: 'security',
    description: 'Security audit',
    category: 'debugging',
    steps: [
      { type: 'prompt', content: 'Perform a security audit on this code. Check for: SQL injection, XSS, CSRF, insecure dependencies, hardcoded secrets, authentication issues, and authorization flaws. Provide specific recommendations.' },
    ],
  },
  {
    name: 'profile',
    description: 'Profile code for performance issues',
    category: 'debugging',
    steps: [
      { type: 'prompt', content: 'Analyze this code for performance bottlenecks. Identify: slow database queries, memory-intensive operations, blocking I/O, unnecessary computations, and missing indexes. Suggest specific optimizations.' },
    ],
  },
  {
    name: 'log',
    description: 'Add logging to code',
    category: 'debugging',
    requiresWriteAccess: true,
    parameters: [
      { name: 'file', description: 'File to add logging to', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Add appropriate logging to this code. Use the project\'s logging library. Add logs for: function entry/exit, error conditions, important state changes, and external API calls. Include relevant context in each log.' },
    ],
  },
  
  // ==================== DEPLOYMENT SKILLS ====================
  {
    name: 'build',
    description: 'Build the project',
    category: 'deployment',
    steps: [
      { type: 'command', content: 'npm run build' },
      { type: 'notify', content: 'Build completed!' },
    ],
  },
  {
    name: 'deploy',
    description: 'Build and deploy',
    category: 'deployment',
    steps: [
      { type: 'command', content: 'npm run build' },
      { type: 'command', content: 'npm test' },
      { type: 'confirm', content: 'All checks passed. Deploy to production?' },
      { type: 'command', content: 'npm run deploy' },
      { type: 'notify', content: 'Deployed successfully!' },
    ],
  },
  {
    name: 'release',
    description: 'Create a new release',
    category: 'deployment',
    requiresGit: true,
    parameters: [
      { name: 'version', description: 'Version number (major/minor/patch or specific)', required: false },
    ],
    steps: [
      { type: 'prompt', content: 'Based on commits since last tag, suggest a version bump (major/minor/patch) following semver.' },
      { type: 'confirm', content: 'Create this release?' },
      { type: 'command', content: 'npm version ${version}' },
      { type: 'command', content: 'git push --tags' },
      { type: 'notify', content: 'Release created!' },
    ],
  },
  {
    name: 'publish',
    description: 'Publish package to npm',
    category: 'deployment',
    steps: [
      { type: 'command', content: 'npm run build' },
      { type: 'command', content: 'npm test' },
      { type: 'confirm', content: 'Publish to npm?' },
      { type: 'command', content: 'npm publish' },
      { type: 'notify', content: 'Package published!' },
    ],
  },
  
  // ==================== GENERATION SKILLS ====================
  {
    name: 'component',
    description: 'Generate a React/Vue component',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Component name', required: true },
      { name: 'type', description: 'Component type (page, form, list, card, modal)', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Generate a React/Vue component named "${name}". Type: ${type}. Follow the project\'s component conventions. Include: TypeScript types, props interface, styles (CSS/Tailwind/styled-components based on project), and a test file.' },
    ],
  },
  {
    name: 'api',
    description: 'Generate an API endpoint',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Endpoint name', required: true },
      { name: 'method', description: 'HTTP method (GET, POST, PUT, DELETE)', required: false, default: 'GET' },
    ],
    steps: [
      { type: 'agent', content: 'Generate an API endpoint for "${name}" with ${method} method. Include: route handler, input validation, error handling, TypeScript types, and a test file. Follow the project\'s API conventions.' },
    ],
  },
  {
    name: 'model',
    description: 'Generate a database model',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Model name', required: true },
      { name: 'fields', description: 'Comma-separated fields (e.g., name:string,age:number)', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Generate a database model for "${name}". Fields: ${fields}. Use the project\'s ORM (Prisma, TypeORM, Mongoose, etc.). Include: schema definition, TypeScript types, validation, and any necessary migrations.' },
    ],
  },
  {
    name: 'hook',
    description: 'Generate a React hook',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Hook name (without use prefix)', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Generate a React hook named "use${name}". Include: proper TypeScript types, cleanup logic, error handling, and a test file. Follow React hooks best practices.' },
    ],
  },
  {
    name: 'service',
    description: 'Generate a service/utility module',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Service name', required: true },
    ],
    steps: [
      { type: 'agent', content: 'Generate a service module for "${name}". Include: class or functions, TypeScript interfaces, error handling, and a test file. Follow the project\'s service patterns.' },
    ],
  },
  {
    name: 'page',
    description: 'Generate a new page/route',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Page name', required: true },
      { name: 'path', description: 'Route path', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Generate a new page named "${name}" at path "${path}". Include: page component, route registration, any required data fetching, loading states, and error handling. Follow the project\'s page conventions.' },
    ],
  },
  {
    name: 'form',
    description: 'Generate a form with validation',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Form name', required: true },
      { name: 'fields', description: 'Comma-separated fields', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Generate a form component for "${name}". Fields: ${fields}. Include: form validation (using project\'s validation library), error messages, submit handling, loading state, TypeScript types, and a test file.' },
    ],
  },
  {
    name: 'crud',
    description: 'Generate full CRUD for an entity',
    category: 'generation',
    requiresWriteAccess: true,
    parameters: [
      { name: 'name', description: 'Entity name', required: true },
      { name: 'fields', description: 'Comma-separated fields', required: false },
    ],
    steps: [
      { type: 'agent', content: 'Generate complete CRUD functionality for "${name}". Fields: ${fields}. Include: database model, API endpoints (list, get, create, update, delete), list page, detail page, create/edit form, TypeScript types, and tests.' },
    ],
  },
  
  // ==================== DEVOPS SKILLS ====================
  {
    name: 'docker',
    description: 'Generate Dockerfile and docker-compose',
    category: 'devops',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Generate a Dockerfile for this project. Include: multi-stage build for smaller image, proper base image, dependency caching, security best practices (non-root user, minimal image). Also generate docker-compose.yml for local development with any required services (database, redis, etc.).' },
    ],
  },
  {
    name: 'ci',
    description: 'Generate CI/CD configuration',
    category: 'devops',
    requiresWriteAccess: true,
    parameters: [
      { name: 'platform', description: 'CI platform (github, gitlab, bitbucket)', required: false, default: 'github' },
    ],
    steps: [
      { type: 'agent', content: 'Generate CI/CD configuration for ${platform}. Include: install dependencies, lint, type check, test, build, and optional deploy steps. Add caching for faster builds. Follow ${platform} best practices.' },
    ],
  },
  {
    name: 'env',
    description: 'Setup environment configuration',
    category: 'devops',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Create environment configuration. Generate: .env.example with all required variables, environment validation using zod or joi, typed config module, and update .gitignore to exclude .env files.' },
    ],
  },
  {
    name: 'k8s',
    description: 'Generate Kubernetes manifests',
    category: 'devops',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Generate Kubernetes manifests for this project. Include: Deployment, Service, ConfigMap, Secrets template, Ingress (optional), HPA for auto-scaling. Follow Kubernetes best practices (resource limits, health checks, security context).' },
    ],
  },
  {
    name: 'terraform',
    description: 'Generate Terraform configuration',
    category: 'devops',
    requiresWriteAccess: true,
    parameters: [
      { name: 'provider', description: 'Cloud provider (aws, gcp, azure)', required: false, default: 'aws' },
    ],
    steps: [
      { type: 'agent', content: 'Generate Terraform configuration for ${provider}. Include: main infrastructure (compute, storage, networking), variables with sensible defaults, outputs for important values, and a README for usage instructions.' },
    ],
  },
  {
    name: 'nginx',
    description: 'Generate Nginx configuration',
    category: 'devops',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Generate Nginx configuration for this project. Include: reverse proxy setup, SSL configuration template, gzip compression, caching headers, security headers, and rate limiting.' },
    ],
  },
  {
    name: 'monitor',
    description: 'Add monitoring and observability',
    category: 'devops',
    requiresWriteAccess: true,
    steps: [
      { type: 'agent', content: 'Add monitoring and observability to the project. Include: health check endpoint, metrics endpoint (Prometheus format), structured logging, error tracking integration (Sentry-compatible), and performance monitoring hooks.' },
    ],
  },
];

/**
 * Ensure skills directory exists
 */
function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

/**
 * Get all built-in skills
 */
export function getBuiltInSkills(): Skill[] {
  return BUILT_IN_SKILLS;
}

/**
 * Load custom skills from disk
 */
export function loadCustomSkills(): Skill[] {
  ensureSkillsDir();
  const skills: Skill[] = [];
  
  try {
    const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      try {
        const content = readFileSync(join(SKILLS_DIR, file), 'utf-8');
        const skill = JSON.parse(content) as Skill;
        skill.category = 'custom';
        skills.push(skill);
      } catch {}
    }
  } catch {}
  
  return skills;
}

/**
 * Get all skills (built-in + custom)
 */
export function getAllSkills(): Skill[] {
  return [...getBuiltInSkills(), ...loadCustomSkills()];
}

/**
 * Find skill by name or shortcut
 */
export function findSkill(nameOrShortcut: string): Skill | null {
  const skills = getAllSkills();
  const lower = nameOrShortcut.toLowerCase();
  
  return skills.find(s => 
    s.name.toLowerCase() === lower || 
    s.shortcut?.toLowerCase() === lower
  ) || null;
}

/**
 * Parse skill chain (e.g., "commit+push" → ["commit", "push"])
 */
export function parseSkillChain(input: string): SkillChain | null {
  if (!input.includes('+')) {
    return null;
  }
  
  const parts = input.split('+').map(s => s.trim()).filter(Boolean);
  
  if (parts.length < 2) {
    return null;
  }
  
  // Verify all skills exist
  for (const part of parts) {
    if (!findSkill(part)) {
      return null;
    }
  }
  
  return {
    skills: parts,
    stopOnError: true,
  };
}

/**
 * Parse skill parameters from args string
 * Supports: "value" for first param, key=value, key="value with spaces"
 */
export function parseSkillArgs(args: string, skill: Skill): Record<string, string> {
  const result: Record<string, string> = {};
  
  // Pattern to match key=value or key="value with spaces" or just "value"
  const keyValuePattern = /(\w+)=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  const quotedPattern = /^["'](.+)["']$/;
  
  // First, try to parse key=value pairs
  let match;
  let remainingArgs = args;
  
  while ((match = keyValuePattern.exec(args)) !== null) {
    const key = match[1];
    const value = match[2] || match[3] || match[4];
    result[key] = value;
    remainingArgs = remainingArgs.replace(match[0], '').trim();
  }
  
  // If there's remaining text and skill has parameters, use as first param
  if (remainingArgs.trim() && skill.parameters && skill.parameters.length > 0) {
    const firstParam = skill.parameters[0];
    // Check if it's quoted
    const quotedMatch = remainingArgs.match(quotedPattern);
    if (quotedMatch) {
      result[firstParam.name] = quotedMatch[1];
    } else {
      result[firstParam.name] = remainingArgs.trim();
    }
  }
  
  // Apply defaults
  if (skill.parameters) {
    for (const param of skill.parameters) {
      if (param.default && !result[param.name]) {
        result[param.name] = param.default;
      }
    }
  }
  
  return result;
}

/**
 * Sanitize text for safe use inside shell commands.
 * Strips markdown formatting and removes shell metacharacters to prevent
 * command injection via $(), backtick subshells, semicolons, pipes, etc.
 */
function sanitizeForShell(text: string): string {
  const firstLine = text
    // Strip markdown code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Strip inline backtick code spans (remove content too, not just markers)
    .replace(/`[^`]*`/g, '')
    // Strip bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // Take only the first non-empty line
    .split('\n').map(l => l.trim()).filter(Boolean)[0] || text.trim();

  return firstLine
    // Remove $(...) subshell expansion
    .replace(/\$\([^)]*\)/g, '')
    // Remove ${...} variable/subshell expansion
    .replace(/\$\{[^}]*\}/g, '')
    // Remove bare $var variable references
    .replace(/\$\w+/g, '')
    // Remove command chaining operators
    .replace(/[;|]/g, '')
    // Remove newlines and null bytes
    .replace(/[\n\r\0]/g, ' ')
    // Escape double quotes for safe embedding in "..." shell strings
    .replace(/"/g, '\\"')
    .trim();
}

/**
 * Interpolate parameters into skill step content
 */
export function interpolateParams(content: string, params: Record<string, string>): string {
  let result = content;
  
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
  }
  
  return result;
}

/**
 * Save a custom skill
 */
export function saveCustomSkill(skill: Skill): void {
  ensureSkillsDir();
  skill.category = 'custom';
  const filename = `${skill.name}.json`;
  writeFileSync(join(SKILLS_DIR, filename), JSON.stringify(skill, null, 2));
}

/**
 * Delete a custom skill
 */
export function deleteCustomSkill(name: string): boolean {
  const filepath = join(SKILLS_DIR, `${name}.json`);
  if (existsSync(filepath)) {
    require('fs').unlinkSync(filepath);
    return true;
  }
  return false;
}

/**
 * Generate prompt for a skill with parameters
 */
export function generateSkillPrompt(
  skill: Skill,
  context: ProjectContext,
  additionalContext?: string,
  params?: Record<string, string>
): string {
  const lines: string[] = [];
  
  lines.push(`# Skill: ${skill.name}`);
  lines.push(`Description: ${skill.description}`);
  lines.push('');
  
  if (additionalContext) {
    lines.push(`Context: ${additionalContext}`);
    lines.push('');
  }
  
  // Collect all prompt/agent steps and interpolate params
  for (const step of skill.steps) {
    if (step.type === 'prompt' || step.type === 'agent') {
      let content = step.content;
      if (params) {
        content = interpolateParams(content, params);
      }
      lines.push(content);
      lines.push('');
    }
  }
  
  return lines.join('\n');
}

/**
 * Get skill steps that need execution
 */
export function getExecutableSteps(skill: Skill): SkillStep[] {
  return skill.steps.filter(s => s.type === 'command' || s.type === 'agent');
}

/**
 * Skill execution callbacks
 */
export interface SkillExecutionCallbacks {
  /** Run a shell command, return stdout */
  onCommand: (cmd: string) => Promise<string>;
  /** Send a prompt to AI chat, return AI response */
  onPrompt: (prompt: string) => Promise<string>;
  /** Run an agent task autonomously */
  onAgent: (task: string) => Promise<string>;
  /** Show confirmation dialog, return true if user confirms */
  onConfirm: (message: string) => Promise<boolean>;
  /** Show a notification to the user */
  onNotify: (message: string) => void;
}

/**
 * Execute a skill's steps sequentially.
 * Each step's output is available as ${_prev} in the next step's content.
 * Returns the collected results from all steps.
 */
export async function executeSkill(
  skill: Skill,
  params: Record<string, string>,
  callbacks: SkillExecutionCallbacks
): Promise<SkillExecutionResult> {
  const stepResults: SkillExecutionResult['steps'] = [];
  let lastOutput = '';

  for (const step of skill.steps) {
    // Interpolate params and ${_prev} into step content
    // For command steps, sanitize _prev for safe shell usage
    const sanitizedPrev = step.type === 'command' ? sanitizeForShell(lastOutput) : lastOutput;
    const allParams = { ...params, _prev: sanitizedPrev };
    const content = interpolateParams(step.content, allParams);

    try {
      let result = '';

      switch (step.type) {
        case 'command':
          result = await callbacks.onCommand(content);
          break;

        case 'prompt':
          result = await callbacks.onPrompt(content);
          break;

        case 'agent':
          result = await callbacks.onAgent(content);
          break;

        case 'confirm': {
          const confirmed = await callbacks.onConfirm(content);
          if (!confirmed) {
            stepResults.push({ step, result: 'cancelled', success: false });
            return { success: false, output: 'Cancelled by user', steps: stepResults };
          }
          result = 'confirmed';
          break;
        }

        case 'notify':
          callbacks.onNotify(content);
          result = 'notified';
          break;
      }

      lastOutput = result;
      stepResults.push({ step, result, success: true });
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      stepResults.push({ step, result: errMsg, success: false });
      if (!step.optional) {
        return { success: false, output: errMsg, steps: stepResults };
      }
    }
  }

  return { success: true, output: lastOutput, steps: stepResults };
}

/**
 * Format skills list for display
 */
export function formatSkillsList(skills: Skill[]): string {
  const byCategory = new Map<SkillCategory, Skill[]>();
  
  for (const skill of skills) {
    const existing = byCategory.get(skill.category) || [];
    existing.push(skill);
    byCategory.set(skill.category, existing);
  }
  
  const lines: string[] = ['# Available Skills', ''];
  
  const categoryOrder: SkillCategory[] = [
    'git', 'testing', 'documentation', 'refactoring', 'debugging', 'deployment', 'generation', 'devops', 'custom'
  ];
  
  const categoryNames: Record<SkillCategory, string> = {
    git: 'Git',
    testing: 'Testing',
    documentation: 'Documentation',
    refactoring: 'Refactoring',
    debugging: 'Debugging',
    deployment: 'Deployment',
    generation: 'Code Generation',
    devops: 'DevOps',
    custom: 'Custom',
  };
  
  for (const category of categoryOrder) {
    const categorySkills = byCategory.get(category);
    if (!categorySkills || categorySkills.length === 0) continue;
    
    lines.push(`## ${categoryNames[category]}`);
    
    for (const skill of categorySkills) {
      const shortcut = skill.shortcut ? ` (/${skill.shortcut})` : '';
      const params = skill.parameters?.map(p => p.required ? `<${p.name}>` : `[${p.name}]`).join(' ') || '';
      lines.push(`- **/${skill.name}**${shortcut}${params ? ' ' + params : ''} - ${skill.description}`);
    }
    
    lines.push('');
  }
  
  lines.push('## Skill Chaining');
  lines.push('Chain multiple skills with `+`: `/commit+push`, `/test+commit+push`');
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Format skill help
 */
export function formatSkillHelp(skill: Skill): string {
  const lines: string[] = [];
  
  lines.push(`# /${skill.name}`);
  if (skill.shortcut) {
    lines.push(`Shortcut: /${skill.shortcut}`);
  }
  lines.push('');
  lines.push(skill.description);
  lines.push('');
  
  if (skill.parameters && skill.parameters.length > 0) {
    lines.push('## Parameters:');
    for (const param of skill.parameters) {
      const required = param.required ? ' (required)' : '';
      const defaultVal = param.default ? ` [default: ${param.default}]` : '';
      lines.push(`- **${param.name}**${required}${defaultVal} - ${param.description}`);
    }
    lines.push('');
  }
  
  if (skill.requiresWriteAccess) {
    lines.push('Requires write access');
  }
  if (skill.requiresGit) {
    lines.push('Requires git repository');
  }
  
  lines.push('');
  lines.push('## Steps:');
  
  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    const optional = step.optional ? ' (optional)' : '';
    
    switch (step.type) {
      case 'prompt':
        lines.push(`${i + 1}. AI Analysis${optional}`);
        break;
      case 'command':
        lines.push(`${i + 1}. Run: \`${step.content}\`${optional}`);
        break;
      case 'confirm':
        lines.push(`${i + 1}. Confirm: ${step.content}${optional}`);
        break;
      case 'agent':
        lines.push(`${i + 1}. Agent Action${optional}`);
        break;
      case 'notify':
        lines.push(`${i + 1}. Notify: ${step.content}${optional}`);
        break;
    }
  }
  
  lines.push('');
  lines.push('## Examples:');
  
  // Generate example usage
  if (skill.parameters && skill.parameters.length > 0) {
    const example1 = skill.parameters[0];
    lines.push(`\`/${skill.name} example-value\``);
    lines.push(`\`/${skill.name} ${example1.name}="example value"\``);
  } else {
    lines.push(`\`/${skill.name}\``);
  }
  
  return lines.join('\n');
}

/**
 * Create a custom skill from template
 */
export function createSkillTemplate(name: string): Skill {
  return {
    name,
    description: 'Custom skill description',
    category: 'custom',
    steps: [
      { type: 'prompt', content: 'Describe what this skill should do' },
    ],
  };
}

/**
 * Wizard step for creating custom skills
 */
export interface WizardStep {
  field: 'name' | 'description' | 'shortcut' | 'step_type' | 'step_content' | 'add_another' | 'done';
  prompt: string;
  validate?: (input: string) => string | null;  // Returns error message or null if valid
}

export const WIZARD_STEPS: WizardStep[] = [
  {
    field: 'name',
    prompt: 'Skill name (lowercase, no spaces):',
    validate: (input) => {
      if (!input.match(/^[a-z][a-z0-9-]*$/)) {
        return 'Name must be lowercase letters, numbers, and hyphens. Must start with a letter.';
      }
      if (findSkill(input)) {
        return 'A skill with this name already exists.';
      }
      return null;
    },
  },
  {
    field: 'description',
    prompt: 'Description (what does this skill do?):',
    validate: (input) => input.length < 5 ? 'Description too short' : null,
  },
  {
    field: 'shortcut',
    prompt: 'Shortcut (single letter, or empty to skip):',
    validate: (input) => {
      if (!input) return null;
      if (!input.match(/^[a-z]$/)) {
        return 'Shortcut must be a single lowercase letter';
      }
      if (findSkill(input)) {
        return 'This shortcut is already used';
      }
      return null;
    },
  },
  {
    field: 'step_type',
    prompt: 'Step type (prompt/command/agent/confirm/notify):',
    validate: (input) => {
      const valid = ['prompt', 'command', 'agent', 'confirm', 'notify'];
      if (!valid.includes(input.toLowerCase())) {
        return `Must be one of: ${valid.join(', ')}`;
      }
      return null;
    },
  },
  {
    field: 'step_content',
    prompt: 'Step content:',
    validate: (input) => input.length < 2 ? 'Content too short' : null,
  },
  {
    field: 'add_another',
    prompt: 'Add another step? (y/n):',
    validate: (input) => {
      if (!['y', 'n', 'yes', 'no'].includes(input.toLowerCase())) {
        return 'Enter y or n';
      }
      return null;
    },
  },
];

/**
 * Parse skill definition from YAML-like string
 */
export function parseSkillDefinition(content: string): Skill | null {
  try {
    // Simple parser for skill definitions
    const lines = content.split('\n');
    const skill: Partial<Skill> = {
      steps: [],
      category: 'custom',
    };
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('name:')) {
        skill.name = trimmed.replace('name:', '').trim();
      } else if (trimmed.startsWith('description:')) {
        skill.description = trimmed.replace('description:', '').trim();
      } else if (trimmed.startsWith('shortcut:')) {
        skill.shortcut = trimmed.replace('shortcut:', '').trim();
      } else if (trimmed.startsWith('- prompt:')) {
        skill.steps!.push({ type: 'prompt', content: trimmed.replace('- prompt:', '').trim() });
      } else if (trimmed.startsWith('- command:') || trimmed.startsWith('- run:')) {
        skill.steps!.push({ type: 'command', content: trimmed.replace(/- (?:command|run):/, '').trim() });
      } else if (trimmed.startsWith('- confirm:')) {
        skill.steps!.push({ type: 'confirm', content: trimmed.replace('- confirm:', '').trim() });
      } else if (trimmed.startsWith('- agent:')) {
        skill.steps!.push({ type: 'agent', content: trimmed.replace('- agent:', '').trim() });
      } else if (trimmed.startsWith('- notify:')) {
        skill.steps!.push({ type: 'notify', content: trimmed.replace('- notify:', '').trim() });
      }
    }
    
    if (skill.name && skill.description && skill.steps!.length > 0) {
      return skill as Skill;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Get skill categories summary
 */
export function getSkillsSummary(): Record<SkillCategory, number> {
  const skills = getAllSkills();
  const summary: Record<SkillCategory, number> = {
    git: 0,
    testing: 0,
    documentation: 0,
    refactoring: 0,
    debugging: 0,
    deployment: 0,
    generation: 0,
    devops: 0,
    custom: 0,
  };
  
  for (const skill of skills) {
    summary[skill.category]++;
  }
  
  return summary;
}

/**
 * Search skills by keyword
 */
export function searchSkills(query: string): Skill[] {
  const skills = getAllSkills();
  const lower = query.toLowerCase();
  
  return skills.filter(s => 
    s.name.toLowerCase().includes(lower) ||
    s.description.toLowerCase().includes(lower) ||
    s.category.toLowerCase().includes(lower)
  );
}

/**
 * Load skill usage history from disk
 */
function loadSkillHistory(): SkillHistory {
  try {
    if (existsSync(SKILLS_HISTORY_FILE)) {
      const content = readFileSync(SKILLS_HISTORY_FILE, 'utf-8');
      return JSON.parse(content) as SkillHistory;
    }
  } catch {
    // Ignore errors, return default
  }
  
  return { entries: [], maxEntries: 100 };
}

/**
 * Save skill usage history to disk
 */
function saveSkillHistory(history: SkillHistory): void {
  try {
    const dir = join(homedir(), '.codeep');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(SKILLS_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {
    // Ignore errors
  }
}

/**
 * Track skill usage
 */
export function trackSkillUsage(skillName: string, success: boolean = true): void {
  const history = loadSkillHistory();
  
  // Add new entry
  history.entries.push({
    skillName,
    timestamp: Date.now(),
    success,
  });
  
  // Trim old entries
  if (history.entries.length > history.maxEntries) {
    history.entries = history.entries.slice(-history.maxEntries);
  }
  
  saveSkillHistory(history);
}

/**
 * Get recently used skills
 */
export function getRecentSkills(limit: number = 10): string[] {
  const history = loadSkillHistory();
  
  // Get unique skills ordered by most recent usage
  const seen = new Set<string>();
  const recent: string[] = [];
  
  // Iterate from newest to oldest
  for (let i = history.entries.length - 1; i >= 0 && recent.length < limit; i--) {
    const entry = history.entries[i];
    if (!seen.has(entry.skillName)) {
      seen.add(entry.skillName);
      recent.push(entry.skillName);
    }
  }
  
  return recent;
}

/**
 * Get most frequently used skills
 */
export function getMostUsedSkills(limit: number = 10): Array<{ name: string; count: number }> {
  const history = loadSkillHistory();
  
  // Count usage
  const counts = new Map<string, number>();
  for (const entry of history.entries) {
    counts.set(entry.skillName, (counts.get(entry.skillName) || 0) + 1);
  }
  
  // Sort by count
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Get skill usage statistics
 */
export function getSkillStats(): { totalUsage: number; uniqueSkills: number; successRate: number } {
  const history = loadSkillHistory();
  
  const uniqueSkills = new Set(history.entries.map(e => e.skillName)).size;
  const successCount = history.entries.filter(e => e.success).length;
  const successRate = history.entries.length > 0 
    ? Math.round((successCount / history.entries.length) * 100) 
    : 100;
  
  return {
    totalUsage: history.entries.length,
    uniqueSkills,
    successRate,
  };
}

/**
 * Clear skill usage history
 */
export function clearSkillHistory(): void {
  try {
    if (existsSync(SKILLS_HISTORY_FILE)) {
      require('fs').unlinkSync(SKILLS_HISTORY_FILE);
    }
  } catch {
    // Ignore errors
  }
}
