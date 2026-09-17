/**
 * What the CI fix run reports about the agent run it started. The agent and
 * the key store are replaced; the report is built from the agent's result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentResult } from './agent';

const h = vi.hoisted(() => ({ result: null as unknown }));

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async () => h.result),
}));

vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/index.js')>();
  return { ...actual, loadAllApiKeys: vi.fn(async () => {}), isConfigured: vi.fn(() => true) };
});

import { runFixPlan } from './headlessReview';
import { buildFixPlan } from './reviewFix';
import type { ProjectContext } from './project';

const plan = buildFixPlan([
  { file: 'src/a.ts', line: 3, category: 'security', severity: 'error', message: 'innerHTML with user input' },
]);
const context = { root: '/work', name: 'work', type: 'Unknown', structure: '', keyFiles: [], fileCount: 0, summary: '' } as ProjectContext;
const edit = (target: string) => ({ type: 'edit' as const, target, result: 'success' as const, timestamp: 0 });

beforeEach(() => { h.result = null; });

describe('the fix run report', () => {
  it('names the edited files next to the checks that still fail', async () => {
    h.result = {
      success: false,
      iterations: 4,
      actions: [edit('src/a.ts'), edit('src/b.ts')],
      finalResponse: 'Escaped the input.\n\n✗ Verification failed: 1/1 checks',
      error: 'Verification failed: npm run test',
      failedChecks: ['npm run test'],
    } satisfies AgentResult;

    const summary = await runFixPlan(plan, context);

    expect(summary).toContain('Edited 2 files: src/a.ts, src/b.ts.');
    expect(summary).toContain('These checks still fail afterwards: npm run test.');
    expect(summary).not.toContain('did not finish');
  });

  it('still says the run did not finish when something else stopped it', async () => {
    h.result = {
      success: false,
      iterations: 25,
      actions: [edit('src/a.ts')],
      finalResponse: '',
      error: 'Exceeded maximum of 25 iterations',
    } satisfies AgentResult;

    const summary = await runFixPlan(plan, context);

    expect(summary).toContain('The run did not finish: Exceeded maximum of 25 iterations.');
  });

  it('lists the edited files of a run that succeeded', async () => {
    h.result = { success: true, iterations: 3, actions: [edit('src/a.ts')], finalResponse: 'Done.' } satisfies AgentResult;

    expect(await runFixPlan(plan, context)).toContain('Edited 1 file: src/a.ts.');
  });
});
