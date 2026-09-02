import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A run must report itself by its task, not by its session id.
 *
 * makeCtx() copies sessionDisplayName by value, so calling
 * ctx.setSessionDisplayName() updates the module's variable while the ctx
 * object in hand keeps the undefined it was built with. Reading it back on the
 * next line therefore always returned nothing, and every consumer of the name —
 * the dashboard sync, the stats report, and the Telegram notice — fell back to
 * "session-2026-09-02-ddc1f13c".
 *
 * Guarded at the source level: the failure is a stale read on an object built
 * elsewhere, which no unit of this function can reproduce in isolation.
 */
const source = readFileSync('src/renderer/agentExecution.ts', 'utf8');

describe('session display name', () => {
  it('does not read the name back off ctx after setting it', () => {
    expect(source).not.toContain('const displayName = ctx.sessionDisplayName ||');
  });

  it('keeps the derived name in a local the callers below can use', () => {
    expect(source).toContain('let displayName = ctx.sessionDisplayName;');
    // The setter is still called, so the name survives into the next run.
    expect(source).toContain('ctx.setSessionDisplayName?.(displayName);');
  });

  it('still falls back to the session id when there is no task to name it', () => {
    expect(source).toContain('if (!displayName) displayName = sessionId;');
  });
});
