import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  beginAuditRun, endAuditRun, recordAuditEvent, readAuditRuns, describeAuditTarget,
} from './auditLog';

let root: string;
const auditDir = () => join(root, '.codeep', 'audit');
const rawLines = () =>
  readdirSync(auditDir())
    .flatMap(f => readFileSync(join(auditDir(), f), 'utf8').split('\n'))
    .filter(Boolean);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codeep-audit-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('audit run round-trip', () => {
  it('records a run with its agent and the capabilities it was granted', () => {
    const run = beginAuditRun(root, {
      prompt: 'tidy the imports',
      agent: 'Reviewer',
      capabilities: ['files', 'tests'],
    });
    endAuditRun(root, run, 'ok');

    const [entry] = readAuditRuns(root);
    expect(entry.run).toBe(run);
    expect(entry.prompt).toBe('tidy the imports');
    expect(entry.agent).toBe('Reviewer');
    expect(entry.capabilities).toEqual(['files', 'tests']);
    expect(entry.outcome).toBe('ok');
  });

  it('counts refusals separately — the entry the boundary exists to produce', () => {
    const run = beginAuditRun(root, { prompt: 'read secrets' });
    recordAuditEvent(root, { ts: Date.now(), run, tool: 'read_file', action: 'refused', outcome: 'refused', target: 'secrets.env' });
    recordAuditEvent(root, { ts: Date.now(), run, tool: 'execute_command', action: 'command', outcome: 'ok', target: 'git log' });
    endAuditRun(root, run, 'ok');

    const [entry] = readAuditRuns(root);
    expect(entry.refusals).toBe(1);
    expect(entry.events).toHaveLength(2);
  });

  it('closes the run even when it failed, and says so', () => {
    const run = beginAuditRun(root, { prompt: 'break something' });
    endAuditRun(root, run, 'error', 'provider timed out');
    const [entry] = readAuditRuns(root);
    expect(entry.outcome).toBe('error');
  });

  it('returns runs newest first', () => {
    const older = beginAuditRun(root, { prompt: 'first' });
    endAuditRun(root, older, 'ok');
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const newer = beginAuditRun(root, { prompt: 'second' });
    endAuditRun(root, newer, 'ok');
    vi.useRealTimers();

    expect(readAuditRuns(root).map(r => r.prompt)).toEqual(['second', 'first']);
  });
});

describe('what must never reach the record', () => {
  // The record exists to say what was touched. history.ts is the thing that
  // keeps contents, because it has to put them back.
  it('describeAuditTarget never reads content-bearing arguments', () => {
    const target = describeAuditTarget({
      tool: 'write_file',
      parameters: { path: 'src/app.ts', content: 'SUPER SECRET BODY', old_string: 'ALSO SECRET' },
    });
    expect(target).toBe('src/app.ts');
    expect(target).not.toContain('SECRET');
  });

  it('keeps a command and its arguments, which are the point', () => {
    expect(describeAuditTarget({ tool: 'execute_command', parameters: { command: 'git', args: ['log', '-5'] } }))
      .toBe('git log -5');
  });

  it('truncates a long target rather than writing an unbounded line', () => {
    const run = beginAuditRun(root, { prompt: 'x' });
    recordAuditEvent(root, { ts: Date.now(), run, action: 'read', target: 'a'.repeat(5000) });
    const longest = Math.max(...rawLines().map(l => l.length));
    expect(longest).toBeLessThan(1000);
  });
});

describe('the record says what it is', () => {
  // The module docstring used to claim the directory was git-ignored by
  // default. It is not — Codeep never edits a project's .gitignore. A comment
  // that promises a protection nobody implements is worse than no comment.
  it('does not claim to git-ignore anything', () => {
    const source = readFileSync(new URL('./auditLog.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/git-ignored by default/);
    expect(source).toMatch(/Codeep does\s+\*?\s*not edit anyone's `\.gitignore`/);
  });
});

describe('robustness', () => {
  it('survives a torn final line — an append-only log killed mid-write', () => {
    const run = beginAuditRun(root, { prompt: 'interrupted' });
    endAuditRun(root, run, 'ok');
    const file = join(auditDir(), readdirSync(auditDir())[0]);
    writeFileSync(file, readFileSync(file, 'utf8') + '{"run":"torn","ts":');

    const runs = readAuditRuns(root);
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe('interrupted');
  });

  it('returns nothing rather than throwing when no audit directory exists', () => {
    expect(readAuditRuns(join(root, 'nowhere'))).toEqual([]);
  });

  it('does not throw when the project cannot be written to', () => {
    const readOnly = join(root, 'ro');
    mkdirSync(readOnly);
    vi.spyOn(process, 'cwd').mockReturnValue(readOnly);
    // Simulate an unwritable tree by pointing at a path that cannot be created.
    expect(() => recordAuditEvent('/proc/nonexistent-codeep-audit', {
      ts: Date.now(), run: 'r', action: 'read', target: 'x',
    })).not.toThrow();
  });
});
