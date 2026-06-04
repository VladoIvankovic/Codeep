import { describe, it, expect, vi } from 'vitest';
import {
  parseReviewArgs,
  exitCodeForResult,
  runHeadlessReview,
  REVIEW_HELP,
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
    expect(parseReviewArgs([])).toEqual({ files: [], json: false, failOn: 'error', help: false });
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
      help: false,
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

describe('runHeadlessReview', () => {
  it('prints help and returns 0 without running the review', () => {
    const review = vi.fn();
    const writes: string[] = [];
    const code = runHeadlessReview(['--help'], { review, write: (s) => writes.push(s) });
    expect(code).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(writes[0]).toBe(REVIEW_HELP);
  });

  it('reviews the given files and returns the fail-on exit code', () => {
    const review = vi.fn(() => result([{ severity: 'error' }]));
    const writes: string[] = [];
    const code = runHeadlessReview(['a.ts', 'b.ts'], { review, write: (s) => writes.push(s) });
    expect(review).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    expect(writes[0]).toContain('# Code Review Report');
    expect(code).toBe(1);
  });

  it('emits JSON with --json and passes undefined files when none are given', () => {
    const r = result([{ severity: 'warning' }]);
    const review = vi.fn(() => r);
    const writes: string[] = [];
    const code = runHeadlessReview(['--json'], { review, write: (s) => writes.push(s) });
    expect(review).toHaveBeenCalledWith(undefined); // no positional files → whole-scope review
    expect(JSON.parse(writes[0])).toMatchObject({ score: 100, summary: { totalIssues: 1 } });
    expect(code).toBe(0); // a warning doesn't trip the default error threshold
  });
});
