/**
 * What a CI fix run says when it was refused a write to a file that decides
 * what runs later.
 *
 * `codeep review --fix` passes no permission callback — there is nobody in CI
 * to answer one — so the agent refuses those writes instead of making them
 * unasked. That is the decision, and it stays: an unattended run must not be
 * the thing that installs a git hook or rewrites `.git/config`. What was
 * missing is that the refusal only ever reached the model, so the run looked
 * like it had simply chosen not to fix that finding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentResult } from './agent';

const h = vi.hoisted(() => ({ result: null as unknown }));

vi.mock('./agent.js', () => ({ runAgent: vi.fn(async () => h.result) }));
vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/index.js')>();
  return { ...actual, loadAllApiKeys: vi.fn(async () => {}), isConfigured: vi.fn(() => true) };
});

import { runFixPlan } from './headlessReview';
import { NO_CONFIRMER_REFUSAL } from './toolExecution';
import { buildFixPlan } from './reviewFix';
import type { ProjectContext } from './project';

const plan = buildFixPlan([
  { file: 'src/a.ts', line: 3, category: 'security', severity: 'error', message: 'innerHTML with user input' },
]);
const context = { root: '/work', name: 'work', type: 'Unknown', structure: '', keyFiles: [], fileCount: 0, summary: '' } as ProjectContext;
const edit = (target: string) => ({ type: 'edit' as const, target, result: 'success' as const, timestamp: 0 });
/** The action the agent logs when its trust-bearing gate had nobody to ask. */
const refusedWrite = (target: string) => ({
  type: 'write' as const,
  target,
  result: 'error' as const,
  details: `Refused write_file on ${target}: This is a git hook — git runs it on your next commit or push, in your own terminal. ${NO_CONFIRMER_REFUSAL}`,
  timestamp: 0,
});

beforeEach(() => { h.result = null; });

describe('a fix run that was refused one of those writes', () => {
  it('says so, names the file and says who has to do it', async () => {
    h.result = {
      success: true,
      iterations: 3,
      actions: [edit('src/a.ts'), refusedWrite('.githooks/pre-commit')],
      finalResponse: 'Done what I could.',
    } satisfies AgentResult;

    const summary = await runFixPlan(plan, context);

    expect(summary).toContain('Edited 1 file: src/a.ts.');
    expect(summary).toContain('refused 1 write to .githooks/pre-commit');
    expect(summary).toContain('a headless run has nobody to confirm them');
    expect(summary).toContain('Edit them yourself.');
  });

  it('counts each file once, however many times the agent tried', async () => {
    // A model that is refused tends to try again with the same path. Three
    // attempts are one thing for a human to do, not three.
    h.result = {
      success: true,
      iterations: 6,
      actions: [refusedWrite('.git/config'), refusedWrite('.git/config'), refusedWrite('.mcp.json')],
      finalResponse: '',
    } satisfies AgentResult;

    const summary = await runFixPlan(plan, context);

    expect(summary).toContain('refused 2 writes to .git/config, .mcp.json');
    // Nothing was edited, and that is still said — the refusal is the reason,
    // not a replacement for the result.
    expect(summary).toContain('Nothing was changed.');
  });

  it('says nothing extra when nothing was refused', async () => {
    h.result = { success: true, iterations: 2, actions: [edit('src/a.ts')], finalResponse: 'Done.' } satisfies AgentResult;

    const summary = await runFixPlan(plan, context);

    expect(summary).toContain('Edited 1 file: src/a.ts.');
    expect(summary).not.toContain('refused');
  });

  it('still says it when the run ended on failing checks', async () => {
    // The path CI hits most: the fix landed, the suite still fails, and the
    // refused hook is why one finding is untouched.
    h.result = {
      success: false,
      iterations: 8,
      actions: [edit('src/a.ts'), refusedWrite('.git/hooks/pre-push')],
      finalResponse: '',
      error: 'Verification failed: npm run test',
      failedChecks: ['npm run test'],
    } satisfies AgentResult;

    const summary = await runFixPlan(plan, context);

    expect(summary).toContain('refused 1 write to .git/hooks/pre-push');
    expect(summary).toContain('These checks still fail afterwards: npm run test.');
  });
});
