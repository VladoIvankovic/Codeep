import { describe, it, expect } from 'vitest';
import { NO_REPLY, isNotAnAnswer, isToolTurnPlaceholder, toolTurnPlaceholder, withoutPlaceholderLines } from './toolTurnPlaceholder';

/**
 * The text a tool-only turn is kept as, and the test that tells it from an
 * answer. "Using write_file." — the old form — ended a 26-step run as its
 * answer: a model had seen it two dozen times and wrote it back.
 */

describe('toolTurnPlaceholder', () => {
  it('names the tool, in brackets no answer has', () => {
    expect(toolTurnPlaceholder([{ tool: 'write_file' }])).toBe('[tool call: write_file]');
  });

  it('names several once each, in the order they were called, as called', () => {
    expect(toolTurnPlaceholder([{ tool: 'read_file' }, { tool: 'mcp__github__list_issues' }, { tool: 'read_file' }]))
      .toBe('[tool call: read_file, mcp__github__list_issues]');
  });
});

describe('isToolTurnPlaceholder', () => {
  for (const [text, expected] of [
    ['[tool call: write_file]', true],
    ['[tool call: read_file, write_file]', true],
    ['  [tool call: write_file]  \n', true],
    ['[tool call: write_file]\n\n[tool call: read_file]', true],
    ['[tool call: write_file]\n(no reply)', true],
    [NO_REPLY, true],
    ['', false],
    ['   \n ', false],
    // Answers, short ones included.
    ['Using Redis.', false],
    ['Using write_file.', false],
    ['ready', false],
    ['[tool call: write_file]\nDone: wrote index.php.', false],
    ['I made the [tool call: write_file] change.', false],
    ['[Tool call: write_file]', false],
    ['[tool call: ]', false],
  ] as const) {
    it(`${JSON.stringify(text)} → ${expected}`, () => {
      expect(isToolTurnPlaceholder(text)).toBe(expected);
    });
  }
});

describe('withoutPlaceholderLines', () => {
  it('drops an echo above or between the lines of an answer, and nothing else', () => {
    expect(withoutPlaceholderLines('[tool call: write_file]\nDone: wrote index.php.')).toBe('Done: wrote index.php.');
    expect(withoutPlaceholderLines('Done.\n\n  [tool call: read_file]  \nRun npm test.')).toBe('Done.\n\nRun npm test.');
    expect(withoutPlaceholderLines('Using Redis.')).toBe('Using Redis.');
    expect(withoutPlaceholderLines('See `[tool call: x]` in the log.')).toBe('See `[tool call: x]` in the log.');
    expect(withoutPlaceholderLines('[tool call: write_file]\n(no reply)')).toBe('');
  });
});

describe('isNotAnAnswer', () => {
  it('is an empty reply or placeholders only, never a short answer', () => {
    expect(isNotAnAnswer('')).toBe(true);
    expect(isNotAnAnswer(' \n')).toBe(true);
    expect(isNotAnAnswer('[tool call: write_file]')).toBe(true);
    expect(isNotAnAnswer(NO_REPLY)).toBe(true);
    for (const answer of ['ready', '42', 'Using Redis.', 'Done.']) expect(isNotAnAnswer(answer), answer).toBe(false);
  });
});
