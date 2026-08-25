import { describe, it, expect } from 'vitest';
import { buildFixPlan, isFixable, ciFixPersonality, formatFixPrompt, summariseFixPlan, describeAgentActivity } from './reviewFix';
import { isPersonalityToolCallAllowed, getPersonalityToolAllowlist } from './personalities';
import type { ReviewIssue } from './codeReview';

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  file: 'src/a.ts', line: 1, severity: 'error', category: 'security', message: 'boom', ...over,
});

describe('what a CI agent may attempt', () => {
  // Opinions are not defects. Acting on them unasked buries the findings that
  // matter under churn in someone else's pull request.
  it('never acts on suggestions or info', () => {
    expect(isFixable(issue({ severity: 'suggestion' }), 'warning')).toBe(false);
    expect(isFixable(issue({ severity: 'info' }), 'warning')).toBe(false);
    expect(isFixable(issue({ severity: 'warning' }), 'warning')).toBe(true);
    expect(isFixable(issue({ severity: 'error' }), 'warning')).toBe(true);
  });

  it('honours a stricter threshold', () => {
    expect(isFixable(issue({ severity: 'warning' }), 'error')).toBe(false);
    expect(isFixable(issue({ severity: 'error' }), 'error')).toBe(true);
  });

  it('declines cleanly when the review found only opinions', () => {
    const plan = buildFixPlan([issue({ severity: 'suggestion' }), issue({ severity: 'info' })]);
    expect(plan.skipped).toBe('nothing-fixable');
    expect(plan.issues).toHaveLength(0);
    expect(summariseFixPlan(plan)).toContain('left for a human');
  });

  it('declines cleanly when the review found nothing', () => {
    expect(buildFixPlan([]).skipped).toBe('no-issues');
  });
});

describe('bounding the attempt', () => {
  it('caps the number of files it will touch', () => {
    const many = Array.from({ length: 30 }, (_, i) => issue({ file: `src/f${i}.ts` }));
    const plan = buildFixPlan(many, { maxFiles: 3 });
    expect(plan.files).toHaveLength(3);
  });

  // A file fixed halfway is the worst outcome: it looks addressed and is not.
  it('does not take half of a file\'s issues', () => {
    const issues = [
      issue({ file: 'src/a.ts', line: 1 }),
      issue({ file: 'src/a.ts', line: 2 }),
      issue({ file: 'src/a.ts', line: 3 }),
      issue({ file: 'src/b.ts', line: 1 }),
    ];
    const plan = buildFixPlan(issues, { maxIssues: 2 });
    const forA = plan.issues.filter(i => i.file === 'src/a.ts');
    expect(forA).toHaveLength(3);
    expect(plan.files).not.toContain('src/b.ts');
  });

  it('puts errors before warnings', () => {
    const plan = buildFixPlan([
      issue({ severity: 'warning', file: 'src/a.ts' }),
      issue({ severity: 'error', file: 'src/z.ts' }),
    ]);
    expect(plan.issues[0].severity).toBe('error');
  });
});

describe('the boundary it runs under', () => {
  // The whole reason this is safe unattended. Not a line in the prompt — the
  // same enforcement any custom bot gets.
  it('is a real restricted personality, not a suggestion', () => {
    const p = ciFixPersonality();
    expect(p.restrictTools).toBe(true);
    expect(p.tools).toEqual(['files', 'tests']);
  });

  it('cannot run arbitrary commands, reach the network, or touch git', () => {
    const p = ciFixPersonality();
    const call = (tool: string, command?: string, args: string[] = []) =>
      isPersonalityToolCallAllowed(p, { tool, parameters: command ? { command, args } : {} } as never);

    expect(call('fetch_url')).toBe(false);
    expect(call('web_search')).toBe(false);
    expect(call('execute_command', 'curl', ['evil.example'])).toBe(false);
    expect(call('execute_command', 'rm', ['-rf', '/'])).toBe(false);
    // git is deliberately withheld: the action holds the token and does the
    // branching, so an agent that could commit could also push.
    expect(call('execute_command', 'git', ['push'])).toBe(false);
    expect(call('execute_command', 'git', ['log'])).toBe(false);
  });

  it('can edit files and run the tests, which is the job', () => {
    const p = ciFixPersonality();
    const call = (tool: string, command?: string, args: string[] = []) =>
      isPersonalityToolCallAllowed(p, { tool, parameters: command ? { command, args } : {} } as never);

    expect(call('read_file')).toBe(true);
    expect(call('write_file')).toBe(true);
    expect(call('edit_file')).toBe(true);
    expect(call('execute_command', 'npm', ['test'])).toBe(true);
  });

  it('offers the model no tool it is not allowed to use', () => {
    const allowed = getPersonalityToolAllowlist(ciFixPersonality());
    expect(allowed).not.toContain('fetch_url');
    expect(allowed).not.toContain('web_search');
    expect(allowed).toContain('write_file');
  });
});

describe('the instruction', () => {
  it('groups findings by file and names the boundary of the change', () => {
    const prompt = formatFixPrompt([
      issue({ file: 'src/a.ts', line: 4, message: 'unchecked index' }),
      issue({ file: 'src/a.ts', line: 9, severity: 'warning', message: 'unused import' }),
      issue({ file: 'src/b.ts', line: 2, message: 'missing await', suggestion: 'await the call' }),
    ]);
    expect(prompt).toContain('## src/a.ts');
    expect(prompt).toContain('line 4: unchecked index');
    expect(prompt).toContain('suggested: await the call');
    expect(prompt).toContain('Change nothing outside these files.');
  });

  it('counts what it is attempting for the pull request body', () => {
    const plan = buildFixPlan([
      issue({ severity: 'error', file: 'src/a.ts' }),
      issue({ severity: 'warning', file: 'src/b.ts' }),
    ]);
    expect(summariseFixPlan(plan)).toBe('Attempting 1 error and 1 warning across 2 files.');
  });
});

describe('describeAgentActivity', () => {
  it('counts what the agent did, by kind', () => {
    const out = describeAgentActivity([
      { type: 'read', result: 'success' },
      { type: 'read', result: 'success' },
      { type: 'edit', result: 'success' },
    ]);
    expect(out).toContain('3 tool calls');
    expect(out).toContain('2 read');
    expect(out).toContain('1 edit');
  });

  // The reason a fix did nothing is usually in a refusal, and a refusal is the
  // one thing a "nothing was changed" summary never used to mention.
  it('separates failures and quotes the first reason', () => {
    const out = describeAgentActivity([
      { type: 'command', result: 'error', details: 'git is not available to this agent' },
      { type: 'command', result: 'error', details: 'still not available' },
      { type: 'read', result: 'success' },
    ]);
    expect(out).toContain('2 command (2 failed)');
    expect(out).toContain('git is not available to this agent');
    expect(out).not.toContain('still not available');
  });

  it('says so when the agent never called a tool', () => {
    expect(describeAgentActivity([])).toContain('no tool calls');
  });

  it('caps a long failure detail', () => {
    const out = describeAgentActivity([
      { type: 'command', result: 'error', details: 'x'.repeat(500) },
    ]);
    expect(out.length).toBeLessThan(320);
  });
});
