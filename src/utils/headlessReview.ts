import { buildFixPlan, summariseFixPlan, describeAgentActivity, type FixPlan } from './reviewFix.js';
// Headless `codeep review` — a non-interactive entry point around the
// deterministic reviewer in codeReview.ts. No API key, no TUI: it scans, prints
// a report (markdown or JSON), and exits non-zero when issues at/above a chosen
// severity are found, so it drops cleanly into CI (e.g. a GitHub Action).
//
// `--ai` is the one opt-in online mode: after the offline pass it asks the
// configured provider for a contextual second opinion (advisory only — it never
// affects the exit code), and degrades to deterministic-only when no key is set.

import {
  performCodeReview,
  formatReviewResult,
  getReviewSystemPrompt,
  listBuiltinRules,
  appendAiSection,
  ReviewResult,
} from './codeReview.js';
import { ProjectContext } from './project.js';
import { config, getCurrentProvider } from '../config/index.js';

export type FailOn = 'error' | 'warning' | 'info' | 'none';

export interface ReviewArgs {
  files: string[];
  json: boolean;
  failOn: FailOn;
  rules: boolean;
  ai: boolean;
  help: boolean;
  /** Hand the findings to an agent and let it edit the working tree. */
  fix: boolean;
  /** Lowest severity the fix run may act on. Suggestions are never eligible. */
  fixMinSeverity: 'error' | 'warning';
}

const FAIL_ON_VALUES: readonly FailOn[] = ['error', 'warning', 'info', 'none'];

// Higher = more severe. `suggestion` sits below `info` so `--fail-on info`
// never trips on a mere suggestion.
const SEVERITY_RANK: Record<string, number> = { suggestion: 0, info: 1, warning: 2, error: 3 };

export const REVIEW_HELP = `Usage: codeep review [options] [files...]

Run a deterministic, offline code review (no API key required). With no files,
reviews your unstaged git changes, falling back to a src/ scan when the tree is
clean. Pass files (or let your CI pass the PR's changed files) to scope it.

Custom/disabled rules come from .codeep/review.yml (or .json) in the repo.

Options:
  --json              Print the result as JSON instead of the markdown report
  --fail-on <level>   Exit non-zero when an issue at or above <level> is found:
                      error | warning | info | none   (default: error)
  --fix               After the review, let an agent fix what it found. Edits the
                      working tree and stops there — it never commits, branches
                      or pushes. Runs under a files+tests boundary: no shell, no
                      network, no git. Needs an API key.
  --fix-min-severity  Lowest severity --fix may act on: error | warning
                      (default: warning). Suggestions are never eligible.
  --rules             List the built-in rule ids (for "disable" in .codeep/review.*) and exit
  --ai                After the offline pass, ask your configured provider for a
                      contextual second opinion on the working-tree diff
                      (advisory; needs an API key; never affects the exit code)
  -h, --help          Show this help

Exit code: 0 when nothing at/above --fail-on is found, 1 otherwise.`;

/** Parse `codeep review` argv (everything after the subcommand). Pure. */
export function parseReviewArgs(argv: string[]): ReviewArgs {
  const out: ReviewArgs = {
    files: [], json: false, failOn: 'error', rules: false, ai: false, help: false,
    fix: false, fixMinSeverity: 'warning',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--rules') {
      out.rules = true;
    } else if (arg === '--ai') {
      out.ai = true;
    } else if (arg === '--fix') {
      out.fix = true;
    } else if (arg === '--fix-min-severity') {
      const v = argv[++i];
      if (v === 'error' || v === 'warning') out.fixMinSeverity = v;
    } else if (arg.startsWith('--fix-min-severity=')) {
      const v = arg.slice('--fix-min-severity='.length);
      if (v === 'error' || v === 'warning') out.fixMinSeverity = v;
    } else if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else if (arg === '--fail-on') {
      const v = argv[++i];
      if (FAIL_ON_VALUES.includes(v as FailOn)) out.failOn = v as FailOn;
    } else if (arg.startsWith('--fail-on=')) {
      const v = arg.slice('--fail-on='.length);
      if (FAIL_ON_VALUES.includes(v as FailOn)) out.failOn = v as FailOn;
    } else if (!arg.startsWith('-')) {
      out.files.push(arg);
    }
    // Unknown flags are ignored so a future flag doesn't hard-fail old clients.
  }
  return out;
}

/** Exit code for a result under a fail-on threshold. Pure. */
export function exitCodeForResult(result: ReviewResult, failOn: FailOn): number {
  if (failOn === 'none') return 0;
  const threshold = SEVERITY_RANK[failOn];
  const tripped = result.issues.some((i) => (SEVERITY_RANK[i.severity] ?? 0) >= threshold);
  return tripped ? 1 : 0;
}

/** Render the built-in rule ids for `--rules`. Pure. */
export function formatBuiltinRules(): string {
  const rules = listBuiltinRules();
  const idW = Math.max(...rules.map((r) => r.id.length));
  const sevW = Math.max(...rules.map((r) => r.severity.length));
  const out = [
    'Built-in review rules — put any id in "disable" in .codeep/review.yml|json:',
    '',
  ];
  for (const r of rules) {
    out.push(`  ${r.id.padEnd(idW)}  ${r.severity.padEnd(sevW)}  ${r.description}`);
  }
  return out.join('\n');
}

export interface ReviewDeps {
  /** Run the review over optional specific files. */
  review: (files?: string[]) => ReviewResult;
  /** Sink for the report (one call). */
  write: (text: string) => void;
  /** List of built-in rule ids (for --rules). */
  listRules: () => string;
  /** Optional AI second opinion; returns null when unavailable (no key / error). */
  aiReview: (result: ReviewResult) => Promise<string | null>;
  /** Provider/model label for the AI section header. */
  aiMeta: () => { provider?: string; model?: string };
  /** Run an agent over a fix plan. Returns a human summary, or null when it
   *  could not run at all (no API key, provider unreachable). */
  applyFixes: (plan: FixPlan) => Promise<string | null>;
}

/**
 * Orchestrate a headless review and return the process exit code. Side effects
 * (filesystem, stdout, provider call) live behind `deps` so the flow is
 * unit-testable. The exit code is ALWAYS deterministic — `--ai` is advisory.
 */
export async function runHeadlessReview(argv: string[], deps: ReviewDeps = defaultDeps()): Promise<number> {
  const args = parseReviewArgs(argv);
  if (args.help) {
    deps.write(REVIEW_HELP);
    return 0;
  }
  if (args.rules) {
    deps.write(deps.listRules());
    return 0;
  }

  const result = deps.review(args.files.length ? args.files : undefined);
  const aiText = args.ai ? await deps.aiReview(result) : null;

  // Fixing happens after reporting, and never changes the exit code. CI decides
  // pass or fail from what the reviewer found; whether an agent then managed to
  // repair some of it is a separate question, and letting a successful fix turn
  // a red check green would hide the finding rather than resolve it.
  let fixSummary: string | null = null;
  if (args.fix) {
    const plan = buildFixPlan(result.issues, { minSeverity: args.fixMinSeverity });
    fixSummary = plan.skipped ? summariseFixPlan(plan) : await deps.applyFixes(plan);
  }

  if (args.json) {
    deps.write(JSON.stringify({
      ...result,
      ...(args.ai ? { aiReview: aiText } : {}),
      ...(args.fix ? { fix: fixSummary } : {}),
    }, null, 2));
  } else {
    const md = formatReviewResult(result);
    const withAi = args.ai ? appendAiSection(md, aiText, deps.aiMeta()) : md;
    deps.write(fixSummary ? `${withAi}\n\n## Fix run\n\n${fixSummary}\n` : withAi);
  }
  return exitCodeForResult(result, args.failOn);
}

// Only the reviewer's `.root` is read, so a minimal context rooted at cwd is
// enough — no need for a full (slower) project scan just to lint.
function minimalContext(root: string): ProjectContext {
  return {
    root,
    name: root.split('/').pop() ?? 'workspace',
    type: 'Unknown',
    structure: '',
    keyFiles: [],
    fileCount: 0,
    summary: `Workspace at ${root}`,
  } as ProjectContext;
}

function defaultDeps(): ReviewDeps {
  const cwd = process.cwd();
  return {
    review: (files) => performCodeReview(minimalContext(cwd), files),
    write: (text) => process.stdout.write(text + '\n'),
    listRules: () => formatBuiltinRules(),
    applyFixes: (plan) => runFixPlan(plan, minimalContext(cwd)),
    aiMeta: () => {
      try {
        return { provider: getCurrentProvider().name, model: String(config.get('model') || '') };
      } catch {
        return {};
      }
    },
    aiReview: async (result) => {
      try {
        const { loadAllApiKeys, isConfigured } = await import('../config/index.js');
        await loadAllApiKeys();
        if (!isConfigured()) {
          process.stderr.write('codeep review --ai: no API key configured for the current provider; skipping the AI pass (deterministic results below).\n');
          return null;
        }
        const { getGitDiff } = await import('./git.js');
        const { chat } = await import('../api/index.js');
        const d = getGitDiff(false, cwd);
        const diff = d.success && d.diff ? d.diff.slice(0, 50000) : '(no textual diff available — reviewing the deterministic findings only)';
        // Fold the prompt + findings into the user message (not a system-role
        // history entry): chat() does not hoist a history `system` entry into
        // the Anthropic top-level `system` field, so it would be dropped on
        // Anthropic-protocol providers. As the user message it reaches every provider.
        const message = `${getReviewSystemPrompt(result)}\n\n## Diff under review\n\`\`\`diff\n${diff}\n\`\`\``;
        return await chat(message, []);
      } catch {
        return null; // never hard-fail the review on an AI error
      }
    },
  };
}

/**
 * Run a fix plan through the agent.
 *
 * The plan's personality is passed as the active one, so the same enforcement
 * any custom bot gets applies here: the model is offered `files` and `tests`
 * and nothing else. It edits the working tree and stops — branching, committing
 * and opening a pull request belong to whatever called this, which in CI is the
 * action that holds the token.
 */
async function runFixPlan(plan: FixPlan, context: ProjectContext): Promise<string | null> {
  try {
    // Populate the key cache before anything asks for it. `getApiKey` is
    // synchronous and reads the cache alone — it does not consult the
    // environment — so without this every request goes out with an empty
    // bearer token and the provider answers 401. The AI review path next door
    // has always done this; the fix path never did, which is why a CI run with
    // a perfectly good key in the environment spent its whole iteration budget
    // being rejected.
    const { loadAllApiKeys, isConfigured } = await import('../config/index.js');
    await loadAllApiKeys();
    if (!isConfigured()) {
      return `${summariseFixPlan(plan)} No API key is configured for the current provider, so the fix agent could not start.`;
    }

    const { runAgent } = await import('./agent.js');
    // No cast here. `as never` on this call once hid the fact that
    // personalityOverride did not exist, which would have run the CI fix with
    // no boundary at all while the tests happily asserted otherwise.
    const result = await runAgent(plan.prompt, context, {
      personalityOverride: plan.personality,
      // The product default. 12 was picked to keep a CI run cheap and was
      // simply too small: fixing one innerHTML call and running the suite ran
      // out of steps, and an agent stopped mid-edit leaves a worse diff than
      // one that never started. The real bounds on cost here are the size of
      // the plan, which buildFixPlan caps, and the action's wall-clock.
      maxIterations: 25,
    });

    const edited = new Set(
      result.actions
        .filter(a => a.type === 'write' || a.type === 'edit')
        .map(a => a.target),
    );
    const activity = describeAgentActivity(result.actions);
    if (!result.success) {
      return `${summariseFixPlan(plan)} The run did not finish: ${result.error ?? 'unknown error'}. ${activity}`;
    }
    if (edited.size === 0) {
      return `${summariseFixPlan(plan)} Nothing was changed. ${activity}`;
    }
    return `${summariseFixPlan(plan)} Edited ${edited.size} file${edited.size === 1 ? '' : 's'}: ${[...edited].join(', ')}.`;
  } catch (error) {
    // A missing key or an unreachable provider must not fail the review. The
    // findings are already reported and the exit code already decided.
    return `Could not run the fix: ${(error as Error).message}`;
  }
}
