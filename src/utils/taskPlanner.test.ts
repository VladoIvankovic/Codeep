import { describe, it, expect } from 'vitest';
import {
  canStartTask,
  getNextTask,
  formatTaskPlan,
  type SubTask,
  type TaskPlan,
} from './taskPlanner';

function task(overrides: Partial<SubTask> = {}): SubTask {
  return { id: 1, description: 'do something', status: 'pending', ...overrides };
}

describe('canStartTask', () => {
  it('returns true for a task with no dependencies', () => {
    expect(canStartTask(task(), [])).toBe(true);
  });

  it('returns true when all dependencies are completed', () => {
    const t = task({ id: 3, dependencies: [1, 2] });
    const all = [
      task({ id: 1, status: 'completed' }),
      task({ id: 2, status: 'completed' }),
      t,
    ];
    expect(canStartTask(t, all)).toBe(true);
  });

  it('returns false when a dependency is still pending', () => {
    const t = task({ id: 2, dependencies: [1] });
    const all = [task({ id: 1, status: 'pending' }), t];
    expect(canStartTask(t, all)).toBe(false);
  });

  it('returns false when a dependency is in progress', () => {
    const t = task({ id: 2, dependencies: [1] });
    const all = [task({ id: 1, status: 'in_progress' }), t];
    expect(canStartTask(t, all)).toBe(false);
  });

  it('returns false when a dependency failed', () => {
    const t = task({ id: 2, dependencies: [1] });
    const all = [task({ id: 1, status: 'failed' }), t];
    expect(canStartTask(t, all)).toBe(false);
  });

  it('returns false when a dependency id is missing from the list', () => {
    const t = task({ id: 2, dependencies: [99] });
    expect(canStartTask(t, [t])).toBe(false);
  });

  it('returns false when only some dependencies are complete', () => {
    const t = task({ id: 3, dependencies: [1, 2] });
    const all = [
      task({ id: 1, status: 'completed' }),
      task({ id: 2, status: 'pending' }),
      t,
    ];
    expect(canStartTask(t, all)).toBe(false);
  });
});

describe('getNextTask', () => {
  it('returns null for an empty list', () => {
    expect(getNextTask([])).toBeNull();
  });

  it('returns null when no tasks are pending', () => {
    const all = [task({ id: 1, status: 'completed' })];
    expect(getNextTask(all)).toBeNull();
  });

  it('returns the first pending task with no dependencies', () => {
    const a = task({ id: 1, status: 'pending' });
    const b = task({ id: 2, status: 'pending' });
    expect(getNextTask([a, b])).toBe(a);
  });

  it('skips a pending task whose dependencies are not done', () => {
    const a = task({ id: 1, status: 'pending' });
    const b = task({ id: 2, status: 'pending', dependencies: [1] });
    // b can't start, but a can — expect a.
    expect(getNextTask([b, a])).toBe(a);
  });

  it('returns null when the only pending task is blocked', () => {
    const a = task({ id: 1, status: 'in_progress' });
    const b = task({ id: 2, status: 'pending', dependencies: [1] });
    expect(getNextTask([a, b])).toBeNull();
  });

  it('skips in-progress tasks', () => {
    const a = task({ id: 1, status: 'in_progress' });
    const b = task({ id: 2, status: 'pending' });
    expect(getNextTask([a, b])).toBe(b);
  });

  it('respects dependency chains across multiple levels', () => {
    const a = task({ id: 1, status: 'completed' });
    const b = task({ id: 2, status: 'completed' });
    const c = task({ id: 3, status: 'pending', dependencies: [1, 2] });
    const d = task({ id: 4, status: 'pending', dependencies: [3] });
    // c can start (deps done), d can't (c not done).
    expect(getNextTask([a, b, c, d])).toBe(c);
  });
});

describe('formatTaskPlan', () => {
  const plan: TaskPlan = {
    originalPrompt: 'build it',
    tasks: [
      task({ id: 1, description: 'first', status: 'completed' }),
      task({ id: 2, description: 'second', status: 'in_progress' }),
      task({ id: 3, description: 'third', status: 'pending', dependencies: [1, 2] }),
      task({ id: 4, description: 'fourth', status: 'failed' }),
    ],
    estimatedIterations: 12,
  };

  it('renders a header and the iteration estimate', () => {
    const out = formatTaskPlan(plan);
    expect(out).toContain('Task Plan:');
    expect(out).toContain('Estimated iterations: ~12');
  });

  it('renders a status icon per task', () => {
    const out = formatTaskPlan(plan);
    expect(out).toContain('✓ 1. first');
    expect(out).toContain('⏳ 2. second');
    expect(out).toContain('⏸ 3. third');
    expect(out).toContain('✗ 4. fourth');
  });

  it('lists dependencies in parentheses when present', () => {
    const out = formatTaskPlan(plan);
    expect(out).toContain('(after: 1, 2)');
  });

  it('omits the dependency suffix for tasks without deps', () => {
    const out = formatTaskPlan(plan);
    expect(out).not.toMatch(/first\(after/);
  });

  it('handles an empty task list', () => {
    const out = formatTaskPlan({
      originalPrompt: '',
      tasks: [],
      estimatedIterations: 0,
    });
    expect(out).toContain('Task Plan:');
    expect(out).toContain('Estimated iterations: ~0');
  });
});
