/**
 * Deciding what a CI agent may attempt to fix, and under what boundary.
 *
 * The reviewer already finds problems. This decides which of them are worth
 * handing to an agent, caps how much it may take on, and pins the capabilities
 * it runs with. It deliberately stops there: it produces a plan, never a
 * commit. Staging, branching and opening a pull request belong to the action,
 * which has the token — and keeping git out of the agent's reach is half the
 * reason this is safe to run in CI at all.
 *
 * The boundary is the point. A fix run gets `files` (it must edit) and `tests`
 * (it must check its own work) and nothing else. No shell, no git, no network.
 * Enforced by the same machinery as any other custom bot, so an agent that
 * decides it would like to curl something simply has no tool to do it with.
 */

import type { ReviewIssue } from './codeReview.js';
import type { Personality } from './personalities.js';

/** Severities an agent may act on, in descending confidence. */
const FIXABLE_SEVERITIES: ReviewIssue['severity'][] = ['error', 'warning'];

export interface FixPlanOptions {
  /** Lowest severity to attempt. Defaults to `warning`. */
  minSeverity?: 'error' | 'warning';
  /** Most issues to hand over in one run. */
  maxIssues?: number;
  /** Most files to touch. A fix that rewrites half the repo is not a fix. */
  maxFiles?: number;
}

export interface FixPlan {
  /** The issues the agent is being asked to address, in file order. */
  issues: ReviewIssue[];
  /** Files it is allowed to be working in. */
  files: string[];
  /** Why nothing is being attempted, when that is the case. */
  skipped?: 'no-issues' | 'nothing-fixable';
  /** The instruction handed to the agent. */
  prompt: string;
  /** The capability boundary the run executes under. */
  personality: Personality;
}

const DEFAULTS = { minSeverity: 'warning' as const, maxIssues: 20, maxFiles: 10 };

/**
 * `suggestion` and `info` are opinion — style preferences, "consider extracting
 * this". Acting on them unasked produces churn in someone else's pull request
 * and buries the findings that matter. Only what the reviewer states as a
 * defect is eligible.
 */
export function isFixable(issue: ReviewIssue, minSeverity: 'error' | 'warning'): boolean {
  if (!FIXABLE_SEVERITIES.includes(issue.severity)) return false;
  return minSeverity === 'warning' ? true : issue.severity === 'error';
}

/**
 * The capability set a CI fix runs under.
 *
 * Not a suggestion in the prompt — a real `custom-bot/v1` personality, enforced
 * by `isPersonalityToolCallAllowed` and by the tool registry filter, exactly as
 * a bot built in Agent Studio would be. An agent running unattended against
 * someone else's repository is precisely where a boundary has to be real.
 */
export function ciFixPersonality(): Personality {
  return {
    name: 'ci-fix',
    displayName: 'CI Fix',
    description: 'Applies review findings in CI. Files and tests only.',
    prompt: [
      'You are fixing problems a reviewer already found in a pull request.',
      '',
      'Rules:',
      '- Fix only the issues listed. Do not refactor around them.',
      '- Do not reformat untouched lines; the diff should read as a fix, not a rewrite.',
      '- Run the project tests when you are done and fix what you broke.',
      '- If an issue needs a judgement call you cannot make from the code, leave it and say so.',
    ].join('\n'),
    scope: 'project',
    structured: true,
    schemaValid: true,
    modelPreference: 'automatic',
    restrictTools: true,
    tools: ['files', 'tests'],
    declaredTools: ['files', 'tests'],
    projectScope: 'all',
  } as Personality;
}

/**
 * Turn a review into a bounded instruction, or decline.
 *
 * Caps matter more than they look. An agent handed sixty findings across forty
 * files will produce a pull request nobody reviews, which is the same as no
 * pull request — except it also burned tokens and someone's afternoon.
 */
export function buildFixPlan(issues: ReviewIssue[], options: FixPlanOptions = {}): FixPlan {
  const { minSeverity, maxIssues, maxFiles } = { ...DEFAULTS, ...options };
  const personality = ciFixPersonality();

  if (issues.length === 0) {
    return { issues: [], files: [], skipped: 'no-issues', prompt: '', personality };
  }

  const eligible = issues
    .filter(issue => isFixable(issue, minSeverity))
    // Errors before warnings, then by file so one file's issues arrive together.
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
      return a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
    });

  if (eligible.length === 0) {
    return { issues: [], files: [], skipped: 'nothing-fixable', prompt: '', personality };
  }

  // Take whole files rather than cutting a file's issues in half — a partial
  // fix to one file is the worst outcome available, since it looks addressed.
  const files: string[] = [];
  const taken: ReviewIssue[] = [];
  for (const issue of eligible) {
    const knownFile = files.includes(issue.file);
    if (!knownFile && files.length >= maxFiles) continue;
    if (taken.length >= maxIssues && !knownFile) continue;
    if (!knownFile) files.push(issue.file);
    taken.push(issue);
  }

  return { issues: taken, files, prompt: formatFixPrompt(taken), personality };
}

/** The instruction the agent receives: the findings, grouped by file. */
export function formatFixPrompt(issues: ReviewIssue[]): string {
  const byFile = new Map<string, ReviewIssue[]>();
  for (const issue of issues) {
    const list = byFile.get(issue.file) ?? [];
    list.push(issue);
    byFile.set(issue.file, list);
  }

  const lines = [
    `Fix the following ${issues.length} review finding${issues.length === 1 ? '' : 's'}.`,
    '',
  ];
  for (const [file, found] of byFile) {
    lines.push(`## ${file}`);
    for (const issue of found) {
      const where = issue.line ? `line ${issue.line}` : 'file';
      lines.push(`- [${issue.severity}] ${where}: ${issue.message}`);
      if (issue.suggestion) lines.push(`  suggested: ${issue.suggestion}`);
    }
    lines.push('');
  }
  lines.push('Change nothing outside these files.');
  return lines.join('\n');
}

/** A one-line summary for the pull request body the action opens. */
export function summariseFixPlan(plan: FixPlan): string {
  if (plan.skipped === 'no-issues') return 'The review found nothing.';
  if (plan.skipped === 'nothing-fixable') {
    return 'The review found only suggestions, which are left for a human to weigh.';
  }
  const errors = plan.issues.filter(i => i.severity === 'error').length;
  const warnings = plan.issues.length - errors;
  const parts = [
    errors ? `${errors} error${errors === 1 ? '' : 's'}` : '',
    warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `Attempting ${parts.join(' and ')} across ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}.`;
}

/**
 * What the agent actually did, in one line.
 *
 * A fix that changes nothing is the hardest outcome to act on, because the
 * summary that reports it — "the run did not finish", "nothing was changed" —
 * says what did not happen and never what did. Debugging one such run through
 * CI cost two releases and forty minutes of guessing at whether the agent
 * could not find the file, could not write, or was being refused a tool.
 *
 * Counting the action log answers that in the message itself. Failures are
 * called out separately from successes, and one failing detail is quoted,
 * because a refusal reason is usually the whole explanation.
 */
export function describeAgentActivity(actions: { type: string; result: string; details?: string }[]): string {
  if (actions.length === 0) return 'It made no tool calls at all.';

  const byType = new Map<string, { ok: number; failed: number }>();
  for (const action of actions) {
    const tally = byType.get(action.type) ?? { ok: 0, failed: 0 };
    if (action.result === 'error') tally.failed++;
    else tally.ok++;
    byType.set(action.type, tally);
  }

  const parts = [...byType.entries()]
    .sort((a, b) => (b[1].ok + b[1].failed) - (a[1].ok + a[1].failed))
    .map(([type, { ok, failed }]) => (failed ? `${ok + failed} ${type} (${failed} failed)` : `${ok} ${type}`));

  const firstFailure = actions.find(a => a.result === 'error' && a.details);
  const why = firstFailure ? ` First failure: ${firstFailure.details!.slice(0, 200)}` : '';

  return `It made ${actions.length} tool call${actions.length === 1 ? '' : 's'}: ${parts.join(', ')}.${why}`;
}
