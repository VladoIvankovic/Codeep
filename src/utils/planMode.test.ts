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
