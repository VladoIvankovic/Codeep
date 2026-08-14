import { describe, expect, it } from 'vitest';
import {
  buildAgentTimelineModel,
  formatElapsed,
  truncateMiddle,
} from './AgentTimeline';
import { stringWidth } from '../ansi';

describe('buildAgentTimelineModel', () => {
  it('starts in PLAN before the first tool call', () => {
    const model = buildAgentTimelineModel({
      actions: [],
      thinking: '',
      waitingForAI: true,
      iteration: 0,
      maxIterations: 20,
    });
    expect(model.currentStage).toBe('PLAN');
    expect(model.stages[0].status).toBe('active');
    expect(model.progress).toBe(0);
  });

  it('maps an active edit tool to EDIT and keeps prior work visible', () => {
    const model = buildAgentTimelineModel({
      actions: [
        { type: 'read', target: 'src/auth.ts', result: 'success' },
      ],
      thinking: 'edit: src/auth.ts',
      waitingForAI: false,
      iteration: 2,
      maxIterations: 10,
    });
    expect(model.currentStage).toBe('EDIT');
    expect(model.currentTarget).toBe('src/auth.ts');
    expect(model.stages.find(stage => stage.id === 'PLAN')?.status).toBe('done');
    expect(model.stages.find(stage => stage.id === 'READ')?.status).toBe('done');
    expect(model.stages.find(stage => stage.id === 'EDIT')?.status).toBe('active');
  });

  it('deduplicates changed files and keeps the latest result', () => {
    const model = buildAgentTimelineModel({
      actions: [
        { type: 'edit', target: 'src/auth.ts', result: 'error' },
        { type: 'edit', target: 'src/auth.ts', result: 'success' },
        { type: 'write', target: 'tests/auth.test.ts', result: 'success' },
      ],
      thinking: '',
      waitingForAI: true,
      iteration: 3,
      maxIterations: 6,
    });
    expect(model.files).toHaveLength(2);
    expect(model.files[0]).toMatchObject({ target: 'src/auth.ts', result: 'success' });
    expect(model.progress).toBe(0.5);
  });

  it('surfaces command actions as verification checks', () => {
    const model = buildAgentTimelineModel({
      actions: [
        { type: 'command', target: 'npm run typecheck', result: 'success' },
      ],
      thinking: 'command: npm test',
      waitingForAI: false,
      iteration: 4,
      maxIterations: 8,
    });
    expect(model.currentStage).toBe('VERIFY');
    expect(model.checks).toEqual([
      { target: 'npm run typecheck', result: 'success' },
    ]);
  });
});

describe('formatElapsed', () => {
  it('formats minutes and seconds', () => {
    expect(formatElapsed(65_000)).toBe('01:05');
  });

  it('includes hours when needed', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});

describe('truncateMiddle', () => {
  it('keeps short strings intact', () => {
    expect(truncateMiddle('codeep.dev', 20)).toBe('codeep.dev');
  });

  it('preserves both ends of a long string', () => {
    expect(truncateMiddle('codex/dashboard-redesign', 14)).toBe('codex/d…design');
  });

  it('budgets columns, not code units, for CJK text', () => {
    // 12 double-width ideographs = 24 columns. String.length would call this
    // a fit at maxLength 16 and overflow the pane by 8 columns.
    const cjk = '重构终端界面并添加代理时间线';
    expect(truncateMiddle(cjk, 16).length).toBeLessThan(cjk.length);
    expect(stringWidth(truncateMiddle(cjk, 16))).toBeLessThanOrEqual(16);
    expect(stringWidth(truncateMiddle(cjk, 9))).toBeLessThanOrEqual(9);
  });

  it('keeps CJK text intact when it already fits in columns', () => {
    expect(truncateMiddle('代理时间线', 10)).toBe('代理时间线');
  });
});
