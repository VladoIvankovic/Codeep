import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const plannerMocks = vi.hoisted(() => ({
  configGet: vi.fn(),
  getApiKey: vi.fn(),
  resolveBaseUrl: vi.fn(),
}));

vi.mock('../config/index', () => ({
  config: { get: plannerMocks.configGet },
  getApiKey: plannerMocks.getApiKey,
  resolveBaseUrl: plannerMocks.resolveBaseUrl,
}));
import {
  canStartTask,
  getNextTask,
  formatTaskPlan,
  planTasks,
  type SubTask,
  type TaskPlan,
} from './taskPlanner';

const originalFetch = global.fetch;

beforeEach(() => {
  plannerMocks.configGet.mockReset();
  plannerMocks.getApiKey.mockReset();
  plannerMocks.resolveBaseUrl.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

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

describe('planTasks runtime', () => {
  it('uses the custom-bot provider, model, protocol, and matching API key for planning', async () => {
    plannerMocks.getApiKey.mockReturnValue('bot-provider-key');
    plannerMocks.resolveBaseUrl.mockReturnValue('https://bot-provider.invalid/v1');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          tasks: [{ id: 1, description: 'Use the selected model', dependencies: [] }],
        }) } }],
      }),
    } as Response);

    const plan = await planTasks('Build the requested feature', {
      name: 'Codeep',
      type: 'typescript',
      structure: 'src/',
    }, {
      providerId: 'z.ai',
      model: 'glm-5.3',
      protocol: 'openai',
    });

    expect(plannerMocks.getApiKey).toHaveBeenCalledWith('z.ai');
    expect(plannerMocks.resolveBaseUrl).toHaveBeenCalledWith('z.ai', 'openai');
    expect(plannerMocks.configGet).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://bot-provider.invalid/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer bot-provider-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'glm-5.3' });
    expect(plan.tasks[0].description).toBe('Use the selected model');
  });

  it('uses the Anthropic endpoint and auth contract for an Anthropic custom bot', async () => {
    plannerMocks.getApiKey.mockReturnValue('anthropic-bot-key');
    plannerMocks.resolveBaseUrl.mockReturnValue('https://api.anthropic.invalid');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: JSON.stringify({
          tasks: [{ id: 1, description: 'Plan with Claude', dependencies: [] }],
        }) }],
      }),
    } as Response);

    const plan = await planTasks('Implement this complex feature', {
      name: 'Codeep',
      type: 'typescript',
      structure: 'src/',
    }, {
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
      protocol: 'anthropic',
    });

    expect(plannerMocks.getApiKey).toHaveBeenCalledWith('anthropic');
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.anthropic.invalid/v1/messages');
    expect(init.headers['x-api-key']).toBe('anthropic-bot-key');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'claude-sonnet-4-6' });
    expect(plan.tasks[0].description).toBe('Plan with Claude');
  });
});
