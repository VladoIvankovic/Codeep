/**
 * Project-level review configuration: `.codeep/review.json`.
 *
 * Lets a repo extend the deterministic reviewer with its own rules, disable
 * built-in rules by id, and scope which files are reviewed — all checked into
 * the repo so the CLI (`codeep review`) and the GitHub Action enforce the same
 * conventions with zero LLM cost. Loading is fully defensive: a missing,
 * malformed, or partially-invalid config never throws — bad entries are skipped
 * with a warning and the review proceeds with whatever is valid.
 *
 * Shape:
 *   {
 *     "rules": [
 *       { "id": "no-foo", "pattern": "\\bfoo\\(", "flags": "gi",
 *         "category": "bug", "severity": "warning",
 *         "message": "Avoid foo()", "suggestion": "Use bar()",
 *         "extensions": [".ts", ".js"] }
 *     ],
 *     "disable": ["eval-usage", "todo-comment"],
 *     "include": ["src/**"],
 *     "exclude": ["vendor/**", "dist/**"]
 *   }
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { RuleDef, ReviewCategory, ReviewIssue } from './codeReview';

const CONFIG_PATH = '.codeep/review.json';
const MAX_RULES = 200;
const VALID_CATEGORIES: ReviewCategory[] = [
  'security', 'performance', 'maintainability', 'bug', 'style', 'types', 'best-practice', 'documentation',
];
const VALID_SEVERITIES: ReviewIssue['severity'][] = ['error', 'warning', 'info', 'suggestion'];

export interface ReviewConfig {
  rules: RuleDef[];       // validated + compiled custom rules
  disabled: Set<string>;  // built-in rule ids to skip
  include: string[];      // path globs (posix, relative) — empty = all files
  exclude: string[];      // path globs (posix, relative)
}

/** Convert a simple glob (`**`, `*`, `?`) into an anchored RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  // Escape regex metacharacters but keep the glob wildcards * ? for translation.
  // Function replacer (not `$&`) so a literal `$` in a path can't be mangled.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, (m) => '\\' + m);
  // Plain ASCII sentinels that won't appear in a real glob; split/join avoids
  // any `$`-replacement pitfalls when substituting the regex fragments.
  const DSTAR_SLASH = '__CODEEP_DSTAR_SLASH__';
  const DSTAR = '__CODEEP_DSTAR__';
  const body = escaped
    .replace(/\*\*\//g, DSTAR_SLASH)  // **/ → zero or more directory segments
    .replace(/\*\*/g, DSTAR)          // **  → anything, including slashes
    .replace(/\*/g, '[^/]*')          // *   → within a single path segment
    .replace(/\?/g, '[^/]')           // ?   → a single non-slash char
    .split(DSTAR_SLASH).join('(?:.*/)?')
    .split(DSTAR).join('.*');
  return new RegExp('^' + body + '$');
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

export function loadReviewConfig(projectRoot: string): ReviewConfig | null {
  const filePath = join(projectRoot, CONFIG_PATH);
  if (!existsSync(filePath)) return null;

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    console.warn(`[codeep] Ignoring ${CONFIG_PATH}: not valid JSON.`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn(`[codeep] Ignoring ${CONFIG_PATH}: expected a JSON object.`);
    return null;
  }
  const cfg = data as Record<string, unknown>;

  const disabled = new Set<string>(asStringArray(cfg.disable));
  const include = asStringArray(cfg.include);
  const exclude = asStringArray(cfg.exclude);

  const rules: RuleDef[] = [];
  const rawRules = Array.isArray(cfg.rules) ? cfg.rules.slice(0, MAX_RULES) : [];
  for (const raw of rawRules) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : null;
    const message = typeof r.message === 'string' && r.message.trim() ? r.message.trim() : null;
    const patternSrc = typeof r.pattern === 'string' && r.pattern ? r.pattern : null;
    if (!id || !message || !patternSrc) {
      console.warn(`[codeep] Skipping a rule in ${CONFIG_PATH}: each rule needs id, pattern and message.`);
      continue;
    }
    // Reject oversized patterns outright — keeps regex compilation/run bounded.
    if (patternSrc.length > 1000) {
      console.warn(`[codeep] Skipping rule "${id}" in ${CONFIG_PATH}: pattern is too long (>1000 chars).`);
      continue;
    }
    // Conservative ReDoS screen: reject the classic catastrophic shape — a group
    // ending in an unbounded quantifier that is itself quantified, e.g. (a+)+,
    // (\d*)*, (.*)+, (x+){2,}. Not exhaustive (the GitHub Action also bounds
    // wall-clock), but it blocks the common foot-guns in an untrusted review.json.
    if (/\([^)]*[+*]\)\s*[+*{]/.test(patternSrc)) {
      console.warn(`[codeep] Skipping rule "${id}" in ${CONFIG_PATH}: nested quantifiers risk catastrophic backtracking (ReDoS).`);
      continue;
    }
    // Always include the global flag so every match in a file is found.
    let flags = typeof r.flags === 'string' && /^[gimsuy]*$/.test(r.flags) ? r.flags : '';
    if (!flags.includes('g')) flags += 'g';
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternSrc, flags);
    } catch {
      console.warn(`[codeep] Skipping rule "${id}" in ${CONFIG_PATH}: invalid regex.`);
      continue;
    }
    const category = (VALID_CATEGORIES as string[]).includes(r.category as string)
      ? (r.category as ReviewCategory) : 'best-practice';
    const severity = (VALID_SEVERITIES as string[]).includes(r.severity as string)
      ? (r.severity as ReviewIssue['severity']) : 'warning';
    const extensions = asStringArray(r.extensions);
    rules.push({
      id,
      pattern,
      category,
      severity,
      message,
      suggestion: typeof r.suggestion === 'string' ? r.suggestion : undefined,
      extensions: extensions.length ? extensions : undefined,
    });
  }

  return { rules, disabled, include, exclude };
}
