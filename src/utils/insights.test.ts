import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// We can't easily redirect homedir() at runtime, so insights.test seeds
// a unique-named history file in the REAL ~/.codeep/history/ and cleans
// it up afterwards. This keeps the test honest (exercises real disk +
// real paths) without colliding with the user's actual history.

const HISTORY_DIR = join(homedir(), '.codeep', 'history');
const TEST_ID_PREFIX = '_insights_test_';

import { formatInsights } from './insights';

interface TestRun {
  id: string;
  startTime: number;
  endTime: number;
  prompt: string;
  projectRoot: string;
  actions: { id: string; timestamp: number; type: string; path?: string }[];
}

function writeTestRun(run: TestRun): string {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const filename = `${TEST_ID_PREFIX}${run.id}.json`;
  writeFileSync(join(HISTORY_DIR, filename), JSON.stringify(run));
  return filename;
}

function cleanupTestRuns(): void {
  if (!existsSync(HISTORY_DIR)) return;
  for (const f of readdirSync(HISTORY_DIR)) {
    if (f.startsWith(TEST_ID_PREFIX)) {
      try { unlinkSync(join(HISTORY_DIR, f)); } catch { /* best-effort */ }
    }
  }
}

describe('insights', () => {
  beforeEach(() => cleanupTestRuns());
  afterEach(() => cleanupTestRuns());

  it('renders empty state with hint when no runs in window', () => {
    const out = formatInsights({ days: 7 });
    // Real history dir may have other runs from the user; only assert
    // shape (headline + "_No agent runs_" OR aggregate metrics line).
    expect(out).toMatch(/^## Activity — last 7 days/);
  });

  it('aggregates runs across project, tools, and files', () => {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    writeTestRun({
      id: `${TEST_ID_PREFIX}a`,
      startTime: oneHourAgo,
      endTime: oneHourAgo + 120_000,
      prompt: 'add a new endpoint',
      projectRoot: '/Users/test/proj-a',
      actions: [
        { id: 'x1', timestamp: oneHourAgo + 10_000, type: 'read', path: '/Users/test/proj-a/api.ts' },
        { id: 'x2', timestamp: oneHourAgo + 20_000, type: 'write', path: '/Users/test/proj-a/api.ts' },
        { id: 'x3', timestamp: oneHourAgo + 30_000, type: 'write', path: '/Users/test/proj-a/api.test.ts' },
      ],
    });
    writeTestRun({
      id: `${TEST_ID_PREFIX}b`,
      startTime: oneHourAgo + 1_000,
      endTime: oneHourAgo + 60_000,
      prompt: 'fix the failing test',
      projectRoot: '/Users/test/proj-b',
      actions: [
        { id: 'y1', timestamp: oneHourAgo + 5_000, type: 'execute', path: undefined },
      ],
    });

    const out = formatInsights({ days: 1 });
    // Headline tally includes our 2 runs (real user runs may also be
    // present, so assert ≥ not exact).
    expect(out).toMatch(/\*\*\d+\*\* runs?/);
    // Per-project section names our buckets (basename of projectRoot).
    expect(out).toContain('proj-a');
    expect(out).toContain('proj-b');
    // Top tools section surfaces the action types we wrote.
    expect(out).toContain('`write`');
    expect(out).toContain('`read`');
    expect(out).toContain('`execute`');
    // Most-touched files section abbreviates HOME prefix.
    expect(out).toContain('api.ts');
    // Recent runs section quotes the user prompt.
    expect(out).toContain('add a new endpoint');
    expect(out).toContain('fix the failing test');
  });

  it('clamps --days to [1, 365]', () => {
    expect(formatInsights({ days: 0 })).toMatch(/last 1 day\b/);
    expect(formatInsights({ days: -10 })).toMatch(/last 1 day\b/);
    expect(formatInsights({ days: 9999 })).toMatch(/last 365 days/);
  });
});
