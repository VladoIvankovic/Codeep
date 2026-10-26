/**
 * Skills System - predefined workflows and commands
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { ProjectContext } from './project';
import { logger } from './logger';

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
  /**
   * A parameter that stands in for this step. When the user gives it, the
   * step does not run and the parameter's value becomes the step's output —
   * `${_prev}` for the steps after it.
   */
  skipIf?: string;
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

/** `git` is /commit, the one built-in; every skill a user wrote is `custom`. */
export type SkillCategory = 'git' | 'custom';

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  steps: { step: SkillStep; result: string; success: boolean }[];
}

export interface SkillChain {
  skills: string[];
  stopOnError: boolean;
}

// Built-in skills. Only /commit: it is the one with a flow worth shipping (diff,
// message, confirmation, commit). What the other 50 did — "write tests",
// "refactor this", "make a Dockerfile" — is a request to the agent in plain
// words, or a skill of the user's own in ~/.codeep/skills.
const BUILT_IN_SKILLS: Skill[] = [
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
      { type: 'prompt', content: 'Based on this git diff, generate ONLY a conventional commit message (no explanation, no markdown). Format: type(scope): description. Types: feat, fix, docs, style, refactor, test, chore. Be concise. One line only.\n\n${_prev}', skipIf: 'message' },
      { type: 'confirm', content: 'Commit with this message? ${_prev}' },
      { type: 'command', content: 'git add -A && git commit -m "${_prev}"' },
      { type: 'notify', content: 'Changes committed successfully!' },
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

function isValidCustomSkill(value: unknown): value is Skill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Partial<Skill>;
  return typeof s.name === 'string'
    && typeof s.description === 'string'
    && Array.isArray(s.steps)
    && (s.shortcut === undefined || typeof s.shortcut === 'string');
}

/** A custom skill file that could not be used, and why. */
export interface SkippedSkillFile {
  file: string;
  problem: string;
}

// What the latest load passed over. Kept so the places a user looks — the
// "Unknown command" reply, /skills — can name the file; the log alone is
// somewhere nobody reads while wondering where their skill went.
let skippedSkillFiles: SkippedSkillFile[] = [];
// Every lookup reloads the directory; log each bad file once, not per lookup.
const loggedSkippedFiles = new Set<string>();

/**
 * Load custom skills from disk
 */
export function loadCustomSkills(): Skill[] {
  ensureSkillsDir();
  const skills: Skill[] = [];
  const skipped: SkippedSkillFile[] = [];
  const skip = (file: string, problem: string) => {
    skipped.push({ file, problem });
    if (!loggedSkippedFiles.has(file)) {
      loggedSkippedFiles.add(file);
      logger.warn(`Skipping custom skill ${file}: ${problem}`);
    }
  };

  try {
    const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      let content: string;
      let skill: unknown;
      try {
        content = readFileSync(join(SKILLS_DIR, file), 'utf-8');
      } catch {
        skip(file, 'could not be read');
        continue;
      }
      try {
        skill = JSON.parse(content);
      } catch {
        skip(file, 'not valid JSON');
        continue;
      }
      // These files are edited by hand. One entry without a string name
      // would make every lookup that reaches it throw, taking down all
      // custom skills and the "Unknown command" reply with it.
      if (!isValidCustomSkill(skill)) {
        skip(file, 'needs a string "name" and "description" and a "steps" array');
        continue;
      }
      skill.category = 'custom';
      skills.push(skill);
    }
  } catch {}

  skippedSkillFiles = skipped;
  return skills;
}

/** Custom skill files the latest load could not use. */
export function getSkippedCustomSkills(): SkippedSkillFile[] {
  return [...skippedSkillFiles];
}

/** One line per skipped file, naming where it is and what is wrong with it. */
export function formatSkippedCustomSkills(skipped: SkippedSkillFile[]): string {
  return skipped
    .map(s => `Skipped ~/.codeep/skills/${s.file} — ${s.problem}. Fix or delete the file.`)
    .join('\n');
}

/**
 * Whether ~/.codeep/skills/<name>.json exists, whether or not it loads. A
 * file that fails to load is invisible to findSkill, and creating a skill of
 * that name would write over what the user wrote by hand.
 */
export function customSkillFileExists(name: string): boolean {
  const filepath = customSkillFile(name);
  return filepath !== null && existsSync(filepath);
}

/**
 * ~/.codeep/skills/<name>.json, or null when the name would put the file
 * anywhere else. Names come straight from `/skill create|delete <name>`, and
 * `../mcp_servers` would otherwise reach ~/.codeep/mcp_servers.json.
 */
function customSkillFile(name: string): string | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  if (/[\\/]/.test(name)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return null;
  const filepath = join(SKILLS_DIR, `${name}.json`);
  return dirname(resolve(filepath)) === resolve(SKILLS_DIR) ? filepath : null;
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
  const keyValuePattern = /(?<!\S)(\w+)=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  const quotedPattern = /^["'](.+)["']$/;
  // A skill that declares parameters takes only those as key=value; any other
  // `word=value` is part of the text for its first parameter — "fix: set
  // retries=3 by default" is a commit message, not a `retries` parameter.
  const declared = skill.parameters && skill.parameters.length > 0
    ? new Set(skill.parameters.map(p => p.name))
    : null;

  // First, try to parse key=value pairs
  let match;
  let remainingArgs = args;

  while ((match = keyValuePattern.exec(args)) !== null) {
    const key = match[1];
    if (declared && !declared.has(key)) continue;
    const value = match[2] || match[3] || match[4];
    result[key] = value;
    remainingArgs = remainingArgs.replace(match[0], '').trim();
  }
  
  // If there's remaining text and skill has parameters, use as first param —
  // unless that one was given as key=value, which is the more explicit of the two
  if (remainingArgs.trim() && skill.parameters && skill.parameters.length > 0
    && result[skill.parameters[0].name] === undefined) {
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

// Only the first line is used, and a commit message, branch name or stash
// message never needs more than this. The cap also bounds the regexes below:
// an unclosed fence or a run of unclosed `$(` in a long reply made them
// quadratic.
const SHELL_TEXT_MAX = 8192;

/**
 * Sanitize model output for use inside a double-quoted shell string —
 * `"${_prev}"`. Takes the first line of the reply (markdown removed), drops
 * shell syntax and escapes it for that position.
 *
 * Only the double quotes make it safe. Unquoted, the result can still carry
 * spaces, globs, redirects and (outside Windows) `&`.
 */
function sanitizeForShell(text: string, platform: NodeJS.Platform = process.platform): string {
  return quoteForDoubleQuotes(modelTextForShell(text, platform), platform);
}

/** The part of a model reply that `"${_prev}"` hands to a command, unescaped. */
function modelTextForShell(text: string, platform: NodeJS.Platform): string {
  const capped = text.slice(0, SHELL_TEXT_MAX);
  const firstLine = capped
    // Unwrap fenced code blocks, keeping their content — models often fence a
    // one-line answer even when told not to, and dropping the block would
    // leave nothing but the raw fallback below
    .replace(/```[^\n]{0,100}\n?([\s\S]*?)```/g, '$1')
    // Strip inline backtick code spans (remove content too, not just markers)
    .replace(/`[^`]*`/g, '')
    // Strip bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // Take only the first non-empty line
    .split('\n').map(l => l.trim()).filter(Boolean)[0] || capped.trim();

  // The escaping must hold on its own: the fallback above hands back the raw
  // text, so nothing can rely on the markdown stripping having happened.
  return plainTextForShell(stripShellSyntax(firstLine, platform), platform);
}

/**
 * Remove shell syntax from model output. On POSIX this is not what makes it
 * safe — the escaping does that — but kept for templates that leave
 * `${_prev}` unquoted, which it only partly protects.
 *
 * On Windows it is what makes it safe. `shell: true` runs cmd.exe there,
 * which takes no backslash escapes: every `"` opens or closes quoting, so a
 * reply could close the string and chain a command. Model output loses the
 * characters cmd.exe acts on outright.
 */
function stripShellSyntax(text: string, platform: NodeJS.Platform): string {
  const stripped = text
    .slice(0, SHELL_TEXT_MAX)
    // Remove $(...) subshell expansion
    .replace(/\$\([^)]*\)/g, '')
    // Remove ${...} variable/subshell expansion
    .replace(/\$\{[^}]*\}/g, '')
    // Remove bare $var variable references
    .replace(/\$\w+/g, '')
    // Remove command chaining operators
    .replace(/[;|]/g, '')
    // Backticks run a command even inside "..." shell strings
    .replace(/`/g, '');
  return platform === 'win32' ? stripped.replace(/["&|<>^%]/g, '') : stripped;
}

/**
 * The text a double-quoted `"${_prev}"` passes on: one line, and on Windows
 * without `"` and `%`. cmd.exe cannot keep those inside quotes — a `"` ends
 * them and `%NAME%` expands even there. With no `"` left to end the quotes,
 * the rest (`&`, `|`, `<`, `>`, `^`) is plain text to cmd.exe.
 */
function plainTextForShell(text: string, platform: NodeJS.Platform): string {
  const line = text.slice(0, SHELL_TEXT_MAX).replace(/[\n\r\0]/g, ' ');
  return (platform === 'win32' ? line.replace(/["%]/g, '') : line).trim();
}

/** Escape text from plainTextForShell for the inside of a double-quoted shell string. */
function quoteForDoubleQuotes(text: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // cmd.exe passes backslashes on as they are, and the program's own
    // argument parsing reads backslashes right before the closing quote as
    // escaping it. Doubled, they stay backslashes and the quote closes.
    let end = text.length;
    while (end > 0 && text[end - 1] === '\\') end--;
    return text + text.slice(end);
  }
  // Escape what is still special inside "..." for sh. A backslash left alone
  // would escape the backslash added before a quote, and that quote would
  // then close the string early.
  return text.replace(/[\\"$`]/g, '\\$&');
}

/** Escape text so a double-quoted shell string holds it literally. */
function escapeForDoubleQuotes(text: string, platform: NodeJS.Platform = process.platform): string {
  return quoteForDoubleQuotes(plainTextForShell(text, platform), platform);
}

/**
 * Interpolate parameters into skill step content
 */
export function interpolateParams(content: string, params: Record<string, string>): string {
  let result = content;

  for (const [key, value] of Object.entries(params)) {
    // Literal find/replace-all via split+join. Avoids two bugs of the old
    // regex form: a regex-meta char in `key` (e.g. `.`, `(`) breaking the match
    // or throwing, and `$`-sequences in `value` ($&, $$, $1) being interpreted
    // as replacement patterns and corrupting the output.
    result = result.split('${' + key + '}').join(value);
  }

  return result;
}

/**
 * Save a custom skill
 */
export function saveCustomSkill(skill: Skill): void {
  const filepath = customSkillFile(skill.name);
  if (!filepath) {
    throw new Error(`Skill name "${skill.name}" is not allowed: it cannot be empty or contain "/", "\\" or control characters.`);
  }
  ensureSkillsDir();
  skill.category = 'custom';
  writeFileSync(filepath, JSON.stringify(skill, null, 2));
}

/**
 * Delete a custom skill
 */
export function deleteCustomSkill(name: string): boolean {
  const filepath = customSkillFile(name);
  if (!filepath) return false;
  if (existsSync(filepath)) {
    unlinkSync(filepath);
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
 * The latest command, prompt or agent output is available as ${_prev} in later
 * steps' content; confirm and notify steps leave it unchanged.
 * Returns the collected results from all steps.
 */
export async function executeSkill(
  skill: Skill,
  params: Record<string, string>,
  callbacks: SkillExecutionCallbacks
): Promise<SkillExecutionResult> {
  const stepResults: SkillExecutionResult['steps'] = [];
  let lastOutput = '';
  // Whether lastOutput is text the user typed rather than a model reply.
  let lastOutputIsUsers = false;

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    // A parameter the user gave replaces the step outright — `/commit "msg"`
    // commits "msg" instead of asking the model for a message.
    const standIn = step.skipIf ? params[step.skipIf] : undefined;
    if (standIn) {
      if (step.type === 'command' || step.type === 'prompt' || step.type === 'agent') {
        lastOutput = standIn;
        lastOutputIsUsers = true;
      }
      stepResults.push({ step, result: standIn, success: true });
      continue;
    }

    // Interpolate params and ${_prev} into step content
    // For command steps, sanitize _prev for safe shell usage. The user's own
    // text is only escaped: it is not markdown to strip, and a `$5` or a `;`
    // in a commit message is part of the message.
    // A confirm step right before a command that uses ${_prev} shows the text
    // that command will be given, so what the user approves is what runs.
    const platform = process.platform;
    const next = skill.steps[i + 1];
    const approvesCommand = step.type === 'confirm'
      && next?.type === 'command' && next.content.includes('${_prev}');
    const sanitizedPrev = step.type === 'command'
      ? (lastOutputIsUsers ? escapeForDoubleQuotes(lastOutput, platform) : sanitizeForShell(lastOutput, platform))
      : approvesCommand
        ? (lastOutputIsUsers ? plainTextForShell(lastOutput, platform) : modelTextForShell(lastOutput, platform))
        : lastOutput;
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

      // Only steps that produce something feed ${_prev}. A confirm or notify
      // in between must pass the earlier output through — otherwise
      // "generate message → confirm → git commit -m ${_prev}" commits the
      // word "confirmed" instead of the message the user just approved.
      if (step.type === 'command' || step.type === 'prompt' || step.type === 'agent') {
        lastOutput = result;
        lastOutputIsUsers = false;
      }
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
export function formatSkillsList(skills: Skill[], skipped: SkippedSkillFile[] = getSkippedCustomSkills()): string {
  const byCategory = new Map<SkillCategory, Skill[]>();
  
  for (const skill of skills) {
    const existing = byCategory.get(skill.category) || [];
    existing.push(skill);
    byCategory.set(skill.category, existing);
  }
  
  const lines: string[] = ['# Available Skills', ''];
  
  const categoryOrder: SkillCategory[] = ['git', 'custom'];

  const categoryNames: Record<SkillCategory, string> = {
    git: 'Built-in',
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
  lines.push('Chain skills with `+`, for example `/commit+my-skill` (a skill of yours from ~/.codeep/skills).');
  lines.push('');

  if (skipped.length > 0) {
    lines.push('## Not loaded');
    lines.push(formatSkippedCustomSkills(skipped));
    lines.push('');
  }
  
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
    const optional = (step.optional ? ' (optional)' : '')
      + (step.skipIf ? ` (skipped when ${step.skipIf} is given)` : '');
    
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
      if (findSkill(input) || customSkillFileExists(input)) {
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
      unlinkSync(SKILLS_HISTORY_FILE);
    }
  } catch {
    // Ignore errors
  }
}
