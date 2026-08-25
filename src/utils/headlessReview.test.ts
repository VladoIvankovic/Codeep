import { describe, it, expect, vi } from 'vitest';
import type { FixPlan } from './reviewFix';
import {
  parseReviewArgs,
  exitCodeForResult,
  runHeadlessReview,
  REVIEW_HELP,
  type ReviewDeps,
} from './headlessReview';
import type { ReviewResult, ReviewIssue } from './codeReview';

function result(issues: Array<Pick<ReviewIssue, 'severity'>>): ReviewResult {
  return {
    files: ['a.ts'],
    issues: issues.map((i) => ({ file: 'a.ts', category: 'bug', message: 'x', severity: i.severity })),
    summary: {
      totalIssues: issues.length,
      byCategory: {} as ReviewResult['summary']['byCategory'],
      bySeverity: { error: 0, warning: 0, info: 0, suggestion: 0 },
    },
    score: 100,
    scope: 'specific files (1)',
  };
}

describe('parseReviewArgs', () => {
  it('defaults to no files, markdown output, fail-on error', () => {
    expect(parseReviewArgs([])).toEqual({
      files: [], json: false, failOn: 'error', rules: false, ai: false, help: false,
      fix: false, fixMinSeverity: 'warning',
    });
  });

  it('collects positional file arguments', () => {
    expect(parseReviewArgs(['src/a.ts', 'src/b.ts']).files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('parses --json and --help', () => {
    expect(parseReviewArgs(['--json']).json).toBe(true);
    expect(parseReviewArgs(['--help']).help).toBe(true);
    expect(parseReviewArgs(['-h']).help).toBe(true);
  });

  it('parses --fail-on in both space and equals forms', () => {
    expect(parseReviewArgs(['--fail-on', 'warning']).failOn).toBe('warning');
    expect(parseReviewArgs(['--fail-on=info']).failOn).toBe('info');
    expect(parseReviewArgs(['--fail-on', 'none']).failOn).toBe('none');
  });

  it('ignores an invalid --fail-on value (keeps the default) and unknown flags', () => {
    expect(parseReviewArgs(['--fail-on', 'bogus']).failOn).toBe('error');
    expect(parseReviewArgs(['--made-up']).files).toEqual([]); // unknown flag, not a file
  });

  it('handles a realistic mix', () => {
    expect(parseReviewArgs(['src/x.ts', '--json', '--fail-on', 'none'])).toEqual({
      files: ['src/x.ts'],
      json: true,
      failOn: 'none',
      rules: false,
      ai: false,
      help: false,
        fix: false,
        fixMinSeverity: 'warning',
    });
  });
});

describe('exitCodeForResult', () => {
  it('trips on an error at the default threshold', () => {
    expect(exitCodeForResult(result([{ severity: 'error' }]), 'error')).toBe(1);
  });

  it('does not trip on warnings when failing on error only', () => {
    expect(exitCodeForResult(result([{ severity: 'warning' }, { severity: 'info' }]), 'error')).toBe(0);
  });

  it('trips on a warning when --fail-on warning', () => {
    expect(exitCodeForResult(result([{ severity: 'warning' }]), 'warning')).toBe(1);
  });

  it('never trips when --fail-on none, even with errors', () => {
    expect(exitCodeForResult(result([{ severity: 'error' }]), 'none')).toBe(0);
  });

  it('passes a clean result', () => {
    expect(exitCodeForResult(result([]), 'error')).toBe(0);
  });
});

describe('--fix', () => {
  it('parses the flag and its severity floor, in both forms', () => {
    expect(parseReviewArgs(['--fix']).fix).toBe(true);
    expect(parseReviewArgs(['--fix']).fixMinSeverity).toBe('warning');
    expect(parseReviewArgs(['--fix', '--fix-min-severity', 'error']).fixMinSeverity).toBe('error');
    expect(parseReviewArgs(['--fix', '--fix-min-severity=error']).fixMinSeverity).toBe('error');
  });

  it('ignores a nonsense severity rather than widening the default', () => {
    expect(parseReviewArgs(['--fix-min-severity', 'suggestion']).fixMinSeverity).toBe('warning');
    expect(parseReviewArgs(['--fix-min-severity=everything']).fixMinSeverity).toBe('warning');
  });
});

describe('runHeadlessReview', () => {

  // The exit code is the reviewer's verdict. Letting a successful fix turn a
  // red check green would hide the finding rather than resolve it — the point
  // of CI is that someone sees it.
  it('never changes the exit code, however the fix goes', async () => {
    const failing = result([{ severity: 'error' }]);
    const withoutFix = await runHeadlessReview([], deps({ review: () => failing }).d);
    const withFix = await runHeadlessReview(['--fix'], deps({ review: () => failing }).d);
    expect(withoutFix).toBe(1);
    expect(withFix).toBe(1);
  });

  it('does not call the agent at all when nothing is fixable', async () => {
    const applyFixes = vi.fn(async (_plan: FixPlan) => 'should not happen');
    const onlyOpinions = result([{ severity: 'suggestion' }]);
    await runHeadlessReview(['--fix'], deps({ review: () => onlyOpinions, applyFixes }).d);
    expect(applyFixes).not.toHaveBeenCalled();
  });

  it('hands the agent a plan bounded to files and tests', async () => {
    const applyFixes = vi.fn(async (_plan: FixPlan) => 'done');
    const failing = result([{ severity: 'error' }]);
    await runHeadlessReview(['--fix'], deps({ review: () => failing, applyFixes }).d);

    expect(applyFixes).toHaveBeenCalledOnce();
    const plan = applyFixes.mock.calls[0]![0];
    expect(plan.personality.tools).toEqual(['files', 'tests']);
    expect(plan.personality.restrictTools).toBe(true);
  });

  it('reports the fix in the JSON payload without disturbing the rest', async () => {
    const failing = result([{ severity: 'error' }]);
    const d = deps({ review: () => failing, applyFixes: async () => 'Edited 1 file: a.ts.' });
    await runHeadlessReview(['--fix', '--json'], d.d);
    const payload = JSON.parse(d.writes.join(''));
    expect(payload.fix).toBe('Edited 1 file: a.ts.');
    expect(payload.issues).toHaveLength(1);
  });

  it('says nothing about fixing when --fix was not asked for', async () => {
    const failing = result([{ severity: 'error' }]);
    const d = deps({ review: () => failing });
    await runHeadlessReview(['--json'], d.d);
    expect(JSON.parse(d.writes.join(''))).not.toHaveProperty('fix');
  });

  function deps(overrides: Partial<ReviewDeps> = {}) {
    const writes: string[] = [];
    const d: ReviewDeps = {
      review: vi.fn(() => result([])),
      write: (s) => { writes.push(s); },
      listRules: vi.fn(() => 'eval-usage\ntodo-comment\nlong-file'),
      aiReview: vi.fn(async () => 'AI second opinion text'),
      aiMeta: () => ({ provider: 'Z.AI', model: 'glm-5.1' }),
      applyFixes: vi.fn(async () => 'Edited 1 file: src/a.ts.'),
      ...overrides,
    };
    return { d, writes };
  }

  it('prints help and returns 0 without running the review', async () => {
    const review = vi.fn(() => result([]));
    const { d, writes } = deps({ review });
    const code = await runHeadlessReview(['--help'], d);
    expect(code).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(writes[0]).toBe(REVIEW_HELP);
  });

  it('prints the rule list with --rules and does not run the review', async () => {
    const review = vi.fn(() => result([]));
    const listRules = vi.fn(() => 'eval-usage\ntodo-comment');
    const { d, writes } = deps({ review, listRules });
    const code = await runHeadlessReview(['--rules'], d);
    expect(code).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(listRules).toHaveBeenCalled();
    expect(writes[0]).toContain('eval-usage');
  });

  it('reviews the given files and returns the fail-on exit code', async () => {
    const review = vi.fn(() => result([{ severity: 'error' }]));
    const { d, writes } = deps({ review });
    const code = await runHeadlessReview(['a.ts', 'b.ts'], d);
    expect(review).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    expect(writes[0]).toContain('# Code Review Report');
    expect(code).toBe(1);
  });

  it('emits JSON with --json and passes undefined files when none are given', async () => {
    const r = result([{ severity: 'warning' }]);
    const review = vi.fn(() => r);
    const { d, writes } = deps({ review });
    const code = await runHeadlessReview(['--json'], d);
    expect(review).toHaveBeenCalledWith(undefined); // no positional files → whole-scope review
    expect(JSON.parse(writes[0])).toMatchObject({ score: 100, summary: { totalIssues: 1 } });
    expect(code).toBe(0);
  });

  it('--ai appends the AI section to markdown but does NOT change the exit code', async () => {
    const review = vi.fn(() => result([{ severity: 'error' }]));
    const aiReview = vi.fn(async () => 'The error on line 1 is a real bug.');
    const { d, writes } = deps({ review, aiReview });
    const code = await runHeadlessReview(['--ai'], d);
    expect(aiReview).toHaveBeenCalled();
    expect(writes[0]).toContain('AI Second Opinion');
    expect(writes[0]).toContain('real bug');
    expect(code).toBe(1); // still gated purely by the deterministic error
  });

  it('--ai --json attaches an aiReview field, exit code still deterministic', async () => {
    const review = vi.fn(() => result([]));
    const aiReview = vi.fn(async () => 'all good');
    const { d, writes } = deps({ review, aiReview });
    const code = await runHeadlessReview(['--ai', '--json'], d);
    expect(JSON.parse(writes[0]).aiReview).toBe('all good');
    expect(code).toBe(0);
  });

  it('--ai degrades gracefully when the AI pass returns null', async () => {
    const aiReview = vi.fn(async () => null);
    const { d, writes } = deps({ aiReview });
    const code = await runHeadlessReview(['--ai'], d);
    expect(writes[0]).toContain('AI Second Opinion');
    expect(writes[0]).toContain('Skipped');
    expect(code).toBe(0);
  });
});

describe('runFixPlan wiring', () => {
  /**
   * `getApiKey` is synchronous and reads a cache that only `loadAllApiKeys`
   * fills — it never consults the environment itself. So an agent started
   * without that call sends an empty bearer token and is rejected on every
   * request. The AI review path had always loaded keys; the fix path never
   * did, and a CI run with a perfectly valid key in the environment spent its
   * whole iteration budget collecting 401s before blaming the iteration limit.
   *
   * The ordering is what matters and the ordering is textual, so this reads the
   * source rather than claiming to have exercised the network.
   */
  it('loads API keys before it starts the agent', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(new URL('./headlessReview.ts', import.meta.url), 'utf8');

    const body = src.slice(src.indexOf('async function runFixPlan'));
    const load = body.indexOf('loadAllApiKeys()');
    const run = body.indexOf('runAgent(');

    expect(load, 'runFixPlan must load API keys').toBeGreaterThan(-1);
    expect(run, 'runFixPlan must call runAgent').toBeGreaterThan(-1);
    expect(load, 'keys must be loaded before the agent starts').toBeLessThan(run);
  });
});
