import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock chat() before importing planMode so the import-time alias is the mock.
vi.mock('../api/index.js', () => ({
  chat: vi.fn(),
}));

import { chat } from '../api/index.js';
import {
  generatePlan,
  getPendingPlan,
  clearPendingPlan,
  setPendingPlan,
  composeExecutionPrompt,
} from './planMode';

describe('planMode', () => {
  beforeEach(() => {
    clearPendingPlan();
    vi.mocked(chat).mockReset();
  });

  it('stores pending plan after generation', async () => {
    vi.mocked(chat).mockResolvedValue('## Plan: refactor auth\n\n1. Read src/auth.ts');
    const result = await generatePlan('refactor auth to use OAuth');
    expect(result).toContain('## Plan: refactor auth');
    const pending = getPendingPlan();
    expect(pending).not.toBeNull();
    expect(pending?.task).toBe('refactor auth to use OAuth');
    expect(pending?.plan).toBe(result);
    expect(pending?.createdAt).toBeGreaterThan(0);
  });

  it('passes the PLAN MODE system prompt to chat()', async () => {
    vi.mocked(chat).mockResolvedValue('plan');
    await generatePlan('any task');
    const [_message, history] = vi.mocked(chat).mock.calls[0];
    expect(history).toHaveLength(1);
    expect(history?.[0].role).toBe('system');
    expect(history?.[0].content).toMatch(/PLAN MODE/);
    expect(history?.[0].content).toMatch(/Do not execute anything/);
  });

  it('replaces the pending plan when generatePlan runs twice', async () => {
    vi.mocked(chat).mockResolvedValueOnce('first plan');
    vi.mocked(chat).mockResolvedValueOnce('revised plan');
    await generatePlan('task one');
    await generatePlan('task two');
    const pending = getPendingPlan();
    expect(pending?.task).toBe('task two');
    expect(pending?.plan).toBe('revised plan');
  });

  it('clearPendingPlan removes the pending plan', async () => {
    vi.mocked(chat).mockResolvedValue('plan');
    await generatePlan('x');
    expect(getPendingPlan()).not.toBeNull();
    clearPendingPlan();
    expect(getPendingPlan()).toBeNull();
  });

  it('composeExecutionPrompt embeds task + plan + approval signal', () => {
    const composed = composeExecutionPrompt({
      task: 'add a new endpoint',
      plan: '1. Create handler\n2. Wire route',
      createdAt: Date.now(),
    });
    expect(composed).toContain('add a new endpoint');
    expect(composed).toContain('1. Create handler');
    expect(composed).toContain('reviewed the following plan and approved it');
    // Anti-improvisation clause is important — keeps the agent honest about
    // mid-execution surprises instead of silently rewriting the plan.
    expect(composed.toLowerCase()).toContain("don't silently improvise");
  });
});

describe('planMode — one pending plan per conversation', () => {
  beforeEach(() => {
    clearPendingPlan();
    clearPendingPlan('thread-a');
    clearPendingPlan('thread-b');
    vi.mocked(chat).mockReset();
  });

  it('a plan made in one thread is not the pending plan of another', async () => {
    vi.mocked(chat).mockResolvedValue('plan for a');
    await generatePlan('task a', undefined, 'thread-a');
    expect(getPendingPlan('thread-a')?.task).toBe('task a');
    expect(getPendingPlan('thread-b')).toBeNull();
    expect(getPendingPlan()).toBeNull();
  });

  it('clearing one thread leaves the others', async () => {
    vi.mocked(chat).mockResolvedValue('plan');
    await generatePlan('task a', undefined, 'thread-a');
    await generatePlan('task b', undefined, 'thread-b');
    await generatePlan('task tui');
    clearPendingPlan('thread-a');
    expect(getPendingPlan('thread-a')).toBeNull();
    expect(getPendingPlan('thread-b')?.task).toBe('task b');
    expect(getPendingPlan()?.task).toBe('task tui');
  });

  it('setPendingPlan stores the plan as given and null clears it', () => {
    const plan = { task: 't', plan: 'p', createdAt: 1 };
    setPendingPlan(plan, 'thread-a');
    expect(getPendingPlan('thread-a')).toBe(plan);
    setPendingPlan(null, 'thread-a');
    expect(getPendingPlan('thread-a')).toBeNull();
  });
});

describe('planMode — cancelling a plan', () => {
  beforeEach(() => {
    clearPendingPlan();
    clearPendingPlan('thread-a');
    vi.mocked(chat).mockReset();
  });

  it('hands the abort signal to the model request', async () => {
    vi.mocked(chat).mockResolvedValue('plan');
    const controller = new AbortController();
    await generatePlan('task', undefined, undefined, controller.signal);
    const call = vi.mocked(chat).mock.calls[0];
    expect(call[5]).toBe(controller.signal);
    // The project context is left as it is, not cleared.
    expect(call[4]).toBeUndefined();
  });

  it('stores no plan when the request is cancelled', async () => {
    const controller = new AbortController();
    vi.mocked(chat).mockImplementation(async (_m, _h, _c, _r, _p, signal) => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (signal?.aborted) throw err;
      return 'plan';
    });
    await expect(generatePlan('task', undefined, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getPendingPlan()).toBeNull();
  });

  it('stores no plan when the reply arrives after the cancel', async () => {
    const controller = new AbortController();
    vi.mocked(chat).mockImplementation(async () => {
      controller.abort();
      return 'a plan the user no longer wants';
    });
    await expect(generatePlan('task', undefined, 'thread-a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getPendingPlan('thread-a')).toBeNull();
  });

  it('still works without a signal', async () => {
    vi.mocked(chat).mockResolvedValue('plan');
    await expect(generatePlan('task')).resolves.toBe('plan');
    expect(getPendingPlan()?.plan).toBe('plan');
  });
});
