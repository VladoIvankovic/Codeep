import { describe, it, expect } from 'vitest';
import {
  analyzeForClarification,
  formatQuestions,
  parseAnswers,
  enhancePromptWithAnswers,
  getInteractiveSystemPrompt,
} from './interactive';

describe('analyzeForClarification', () => {
  it('detects "refactor" and asks what to focus on', () => {
    const ctx = analyzeForClarification('refactor this module');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].question).toMatch(/focus/i);
    expect(ctx.questions[0].options).toContain('Performance');
  });

  it('detects "add a database" and offers choices', () => {
    const ctx = analyzeForClarification('add a database');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].options).toContain('PostgreSQL');
    expect(ctx.questions[0].options).toContain('MongoDB');
  });

  it('does not ask about a database when one is already named', () => {
    const ctx = analyzeForClarification('add a postgresql database');
    expect(ctx.needsClarification).toBe(false);
  });

  it('detects "create an api" prompts', () => {
    const ctx = analyzeForClarification('create an api');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].options).toContain('REST API');
    expect(ctx.questions[0].options).toContain('GraphQL');
  });

  it('detects "deploy" prompts', () => {
    const ctx = analyzeForClarification('deploy');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].options).toContain('Vercel');
  });

  it('detects "add a test" prompts', () => {
    const ctx = analyzeForClarification('add a test');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].options).toContain('Vitest');
  });

  it('detects "add styling" prompts', () => {
    const ctx = analyzeForClarification('add styling');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].options).toContain('Tailwind CSS');
  });

  it('detects "add state management" prompts', () => {
    const ctx = analyzeForClarification('add state management');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].options).toContain('Redux');
  });

  it('detects "add a form" as a free-text question (no options)', () => {
    const ctx = analyzeForClarification('add a form');
    expect(ctx.needsClarification).toBe(true);
    expect(ctx.questions[0].type).toBe('text');
    expect(ctx.questions[0].options).toBeUndefined();
  });

  // KNOWN BUG: `checkForDetails` matches option keywords as substrings
  // of the prompt. "authentication" contains "auth" (a 4-char word from
  // the "Basic auth" option label), so the auth question is suppressed
  // even when the user just wrote "add authentication". Pinned here so
  // a future fix to checkForDetails makes this test flip to `true`.
  it('BUG: "add authentication" is suppressed by the "auth" substring match', () => {
    const ctx = analyzeForClarification('add authentication');
    expect(ctx.needsClarification).toBe(false);
  });

  it('preserves the original prompt on the context', () => {
    const prompt = 'refactor the code';
    const ctx = analyzeForClarification(prompt);
    expect(ctx.originalPrompt).toBe(prompt);
  });

  it('does not trigger on a plain greeting', () => {
    expect(analyzeForClarification('hello there').needsClarification).toBe(false);
  });
});

describe('formatQuestions', () => {
  it('returns an empty string when no clarification is needed', () => {
    const ctx = analyzeForClarification('hello there');
    expect(formatQuestions(ctx)).toBe('');
  });

  it('numbers questions starting at 1', () => {
    const ctx = analyzeForClarification('refactor this module');
    expect(formatQuestions(ctx)).toContain('1. ');
  });

  it('letter-options the choices a, b, c…', () => {
    const ctx = analyzeForClarification('refactor this module');
    const out = formatQuestions(ctx);
    expect(out).toContain('a) Performance');
    expect(out).toContain('b) Readability');
  });

  it('ends with the "proceed" instruction', () => {
    const ctx = analyzeForClarification('refactor this module');
    expect(formatQuestions(ctx)).toContain('proceed');
  });
});

describe('parseAnswers', () => {
  const ctx = analyzeForClarification('create an api');

  it('returns an empty map when the user says "proceed"', () => {
    expect(parseAnswers('proceed', ctx).size).toBe(0);
  });

  it('returns an empty map for "continue" / "decide" / "skip"', () => {
    expect(parseAnswers('continue', ctx).size).toBe(0);
    expect(parseAnswers('you decide', ctx).size).toBe(0);
    expect(parseAnswers('skip', ctx).size).toBe(0);
  });

  it('parses a letter answer "1a" → first option', () => {
    const answers = parseAnswers('1a', ctx);
    expect(answers.get(0)).toBe('REST API');
  });

  it('parses a letter answer "1b" → second option', () => {
    const answers = parseAnswers('1b', ctx);
    expect(answers.get(0)).toBe('GraphQL');
  });

  it('matches an option mentioned by name', () => {
    const answers = parseAnswers('I want GraphQL', ctx);
    expect(answers.get(0)).toBe('GraphQL');
  });

  it('is case-insensitive when matching option names', () => {
    const answers = parseAnswers('use graphql', ctx);
    expect(answers.get(0)).toBe('GraphQL');
  });
});

describe('enhancePromptWithAnswers', () => {
  it('returns the original prompt unchanged when there are no answers', () => {
    const ctx = analyzeForClarification('create an api');
    const out = enhancePromptWithAnswers(ctx, new Map());
    expect(out).toBe(ctx.originalPrompt);
  });

  it('appends a "User specifications" block with the answer', () => {
    const ctx = analyzeForClarification('create an api');
    const answers = new Map([[0, 'GraphQL']]);
    const out = enhancePromptWithAnswers(ctx, answers);
    expect(out).toContain('User specifications:');
    expect(out).toContain('GraphQL');
  });

  it('prefixes each specification with a dash', () => {
    const ctx = analyzeForClarification('create an api');
    const answers = new Map([[0, 'GraphQL']]);
    const out = enhancePromptWithAnswers(ctx, answers);
    expect(out).toContain('\n- ');
  });
});

describe('getInteractiveSystemPrompt', () => {
  it('returns a non-empty system prompt', () => {
    expect(getInteractiveSystemPrompt().length).toBeGreaterThan(0);
  });

  it('documents the CLARIFICATION_NEEDED format', () => {
    expect(getInteractiveSystemPrompt()).toContain('CLARIFICATION_NEEDED');
  });

  it('tells the agent not to over-ask', () => {
    expect(getInteractiveSystemPrompt().toLowerCase()).toContain('over-ask');
  });
});
