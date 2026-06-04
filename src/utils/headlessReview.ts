// Headless `codeep review` — a non-interactive entry point around the
// deterministic reviewer in codeReview.ts. No API key, no TUI: it scans, prints
// a report (markdown or JSON), and exits non-zero when issues at/above a chosen
// severity are found, so it drops cleanly into CI (e.g. a GitHub Action).

import { performCodeReview, formatReviewResult, ReviewResult } from './codeReview.js';
import { ProjectContext } from './project.js';

export type FailOn = 'error' | 'warning' | 'info' | 'none';

export interface ReviewArgs {
  files: string[];
  json: boolean;
  failOn: FailOn;
  help: boolean;
}

const FAIL_ON_VALUES: readonly FailOn[] = ['error', 'warning', 'info', 'none'];

// Higher = more severe. `suggestion` sits below `info` so `--fail-on info`
// never trips on a mere suggestion.
const SEVERITY_RANK: Record<string, number> = { suggestion: 0, info: 1, warning: 2, error: 3 };

export const REVIEW_HELP = `Usage: codeep review [options] [files...]

Run a deterministic, offline code review (no API key required). With no files,
reviews your unstaged git changes, falling back to a src/ scan when the tree is
clean. Pass files (or let your CI pass the PR's changed files) to scope it.

Options:
  --json              Print the result as JSON instead of the markdown report
  --fail-on <level>   Exit non-zero when an issue at or above <level> is found:
                      error | warning | info | none   (default: error)
  -h, --help          Show this help

Exit code: 0 when nothing at/above --fail-on is found, 1 otherwise.`;

/** Parse `codeep review` argv (everything after the subcommand). Pure. */
export function parseReviewArgs(argv: string[]): ReviewArgs {
  const out: ReviewArgs = { files: [], json: false, failOn: 'error', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
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

export interface ReviewDeps {
  /** Run the review over optional specific files. */
  review: (files?: string[]) => ReviewResult;
  /** Sink for the report (one call). */
  write: (text: string) => void;
}

/**
 * Orchestrate a headless review and return the process exit code. Side effects
 * (filesystem, stdout) live behind `deps` so the flow is unit-testable.
 */
export function runHeadlessReview(argv: string[], deps: ReviewDeps = defaultDeps()): number {
  const args = parseReviewArgs(argv);
  if (args.help) {
    deps.write(REVIEW_HELP);
    return 0;
  }
  const result = deps.review(args.files.length ? args.files : undefined);
  deps.write(args.json ? JSON.stringify(result, null, 2) : formatReviewResult(result));
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
  return {
    review: (files) => performCodeReview(minimalContext(process.cwd()), files),
    write: (text) => process.stdout.write(text + '\n'),
  };
}
