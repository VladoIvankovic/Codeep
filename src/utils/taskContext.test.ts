import { describe, it, expect, beforeEach } from 'vitest';
import {
  setTaskContext,
  clearTaskContext,
  getTaskContextPrompt,
} from './taskContext';
import type { CloudTask } from './codeepCloud';

function task(overrides: Partial<CloudTask> = {}): CloudTask {
  return {
    id: 1,
    title: 'Default title',
    description: 'Default desc',
    type: 'feature',
    project_name: 'codeep',
    project_id: 'abc',
    status: 'open',
    created_at: '2024-01-01',
    ...overrides,
  } as CloudTask;
}

describe('getTaskContextPrompt', () => {
  beforeEach(() => {
    clearTaskContext();
  });

  it('returns an empty string when no tasks are set', () => {
    expect(getTaskContextPrompt()).toBe('');
  });

  it('returns an empty string after clearTaskContext', () => {
    setTaskContext([task()]);
    expect(getTaskContextPrompt()).not.toBe('');
    clearTaskContext();
    expect(getTaskContextPrompt()).toBe('');
  });

  it('includes the task title', () => {
    setTaskContext([task({ title: 'Fix OAuth' })]);
    expect(getTaskContextPrompt()).toContain('Fix OAuth');
  });

  it('includes the task description when present', () => {
    setTaskContext([task({ description: 'Refresh tokens are broken' })]);
    expect(getTaskContextPrompt()).toContain('Refresh tokens are broken');
  });

  it('includes the project name when present', () => {
    setTaskContext([task({ project_name: 'web' })]);
    expect(getTaskContextPrompt()).toContain('project: web');
  });

  it('includes the type badge when present', () => {
    setTaskContext([task({ type: 'bug' })]);
    expect(getTaskContextPrompt()).toContain('[bug]');
  });

  it('falls back to [task] when type is missing', () => {
    setTaskContext([task({ type: undefined })]);
    expect(getTaskContextPrompt()).toContain('[task]');
  });

  it('omits the description separator when description is missing', () => {
    setTaskContext([task({ title: 'T1', description: undefined })]);
    const out = getTaskContextPrompt();
    expect(out).toContain('T1');
    // The line should not contain ": " right after the title (the desc
    // separator only appears when there's a description).
    const line = out.split('\n').find((l) => l.includes('T1'))!;
    expect(line.endsWith('T1') || line.includes('(project:')).toBe(true);
  });

  it('lists multiple tasks as separate bullets', () => {
    setTaskContext([
      task({ id: 1, title: 'First' }),
      task({ id: 2, title: 'Second' }),
    ]);
    const out = getTaskContextPrompt();
    expect(out).toContain('First');
    expect(out).toContain('Second');
    // Two task bullets (lines starting with "- [").
    const taskLines = out.split('\n').filter((l) => /^- \[/.test(l));
    expect(taskLines.length).toBe(2);
  });

  it('includes the "Pending Tasks" header', () => {
    setTaskContext([task()]);
    expect(getTaskContextPrompt()).toContain('Pending Tasks');
    expect(getTaskContextPrompt()).toContain('codeep.dev dashboard');
  });

  it('includes the call-to-action footer', () => {
    setTaskContext([task()]);
    expect(getTaskContextPrompt()).toContain('Work on these tasks');
  });
});
