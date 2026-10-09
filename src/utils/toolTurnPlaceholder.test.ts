import { describe, it, expect } from 'vitest';
import { NO_REPLY, isNotAnAnswer, isToolTurnPlaceholder, toolTurnPlaceholder, withoutPlaceholderLines, withoutToolTurnPlaceholders } from './toolTurnPlaceholder';
import type { Message } from '../config/index';

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

describe('withoutToolTurnPlaceholders', () => {
  const user = (content: string): Message => ({ role: 'user', content });
  const assistant = (content: string): Message => ({ role: 'assistant', content });
  const system = (content: string): Message => ({ role: 'system', content });

  it('leaves out the turns that only called tools, and joins the results either side of them', () => {
    const history = [
      user('Add a route'),
      assistant('[tool call: read_file]'),
      user('Tool results:\n\nA\n\nContinue with the task.'),
      assistant('[tool call: read_file, list_files]'),
      user('Tool results:\n\nB\n\nContinue with the task.'),
    ];

    expect(withoutToolTurnPlaceholders(history)).toEqual([
      user('Add a route\n\nTool results:\n\nA\n\nContinue with the task.\n\nTool results:\n\nB\n\nContinue with the task.'),
    ]);
  });

  it('leaves out an echo — one placeholder, several, or "(no reply)" — and joins the nudge to the results before it', () => {
    for (const echo of ['[tool call: read_file]', '[tool call: read_file]\n[tool call: write_file]', NO_REPLY, '[tool call: a]\n\n(no reply)']) {
      const history = [user('Task'), assistant('[tool call: read_file]'), user('Results'), assistant(echo), user('Nudge')];

      expect(withoutToolTurnPlaceholders(history), JSON.stringify(echo)).toEqual([user('Task\n\nResults\n\nNudge')]);
    }
  });

  it('keeps what the model said, including above a placeholder line', () => {
    const history = [
      user('Task'),
      assistant('Let me look at the controllers.'),
      user('Results'),
      assistant('[tool call: read_file]\nThat covers the controllers.'),
      user('More results'),
    ];

    expect(withoutToolTurnPlaceholders(history)).toEqual(history);
  });

  it('keeps the roles alternating wherever only placeholders stood between two user messages', () => {
    const history = [
      user('Task'),
      assistant('[tool call: a]'),
      user('R1'),
      assistant('I will now edit it.'),
      user('R2'),
      assistant('[tool call: b]'),
      user('R3'),
      assistant('[tool call: c]'),
      user('R4'),
    ];

    const sent = withoutToolTurnPlaceholders(history);

    expect(sent).toEqual([user('Task\n\nR1'), assistant('I will now edit it.'), user('R2\n\nR3\n\nR4')]);
    sent.slice(1).forEach((m, i) => expect(m.role, `message ${i + 1}`).not.toBe(sent[i].role));
  });

  it('does not join user messages that had a real reply between them, or a system message', () => {
    const history = [system('Rules'), user('Task'), assistant('Done with part one.'), user('Next'), system('Note'), user('Last')];

    expect(withoutToolTurnPlaceholders(history)).toEqual(history);
  });

  it('joins user messages only: two of anything else in a row are the model\'s or the app\'s own words', () => {
    const history = [system('Rules'), system('More rules'), user('Task'), assistant('One.'), assistant('Two.'), user('Next')];

    expect(withoutToolTurnPlaceholders(history)).toEqual(history);
  });

  it('is a copy: the history it was given is as it was, and messages it left alone are the same objects', () => {
    const task = user('Task');
    const real = assistant('Looking.');
    const results = user('Results');
    const history = [task, assistant('[tool call: read_file]'), user('R1'), real, results];
    const before = JSON.parse(JSON.stringify(history));

    const sent = withoutToolTurnPlaceholders(history);

    expect(history).toEqual(before);
    expect(sent).not.toBe(history);
    expect(sent[1]).toBe(real);
    expect(sent[2]).toBe(results);
    expect(sent[0]).not.toBe(task);
  });

  it('gives back an equal history when there is nothing to leave out, and an empty one for an empty one', () => {
    const history = [user('Task'), assistant('Answer'), user('Thanks')];

    expect(withoutToolTurnPlaceholders(history)).toEqual(history);
    expect(withoutToolTurnPlaceholders([])).toEqual([]);
  });
});
