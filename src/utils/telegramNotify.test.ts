import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  composeRunMessages,
  noticeAnswer,
  splitAnswer,
  formatDuration,
  shouldNotify,
  NOTIFY_AFTER_MS,
  NOTICE_DELAY_CHOICES_S,
  validNoticeDelaySeconds,
  noticeDelayLabel,
  MAX_ANSWER_LENGTH,
  MAX_ANSWER_PARTS,
  stripMarkdown,
  shortLabel,
} from './telegramNotify';

describe('shouldNotify', () => {
  it('stays quiet for a run you never stopped watching', () => {
    // A phone that buzzes for every `git status` gets muted within a day,
    // taking the notices that mattered with it.
    expect(shouldNotify(2_000, true)).toBe(false);
    expect(shouldNotify(NOTIFY_AFTER_MS - 1, true)).toBe(false);
  });

  it('fires once a run outlasts the coffee it was started for', () => {
    expect(shouldNotify(NOTIFY_AFTER_MS, true)).toBe(true);
    expect(shouldNotify(20 * 60_000, true)).toBe(true);
  });

  it('never fires when the feature is off, however long the run', () => {
    expect(shouldNotify(60 * 60_000, false)).toBe(false);
  });

  it('still means a minute when no delay is passed', () => {
    expect(NOTIFY_AFTER_MS).toBe(60_000);
    expect(shouldNotify(59_999, true)).toBe(false);
    expect(shouldNotify(60_000, true)).toBe(true);
  });

  describe('with a delay of its own', () => {
    it('fires at exactly the delay and not a millisecond before', () => {
      expect(shouldNotify(30_000, true, 30_000)).toBe(true);
      expect(shouldNotify(29_999, true, 30_000)).toBe(false);
      expect(shouldNotify(30_001, true, 30_000)).toBe(true);
    });

    it('does not fall back to a minute when the delay is shorter', () => {
      expect(shouldNotify(15_000, true, 15_000)).toBe(true);
      expect(shouldNotify(30_000, true, 15_000)).toBe(true);
    });

    it('holds a run back for as long as a longer delay says', () => {
      expect(shouldNotify(61_000, true, 300_000)).toBe(false);
      expect(shouldNotify(299_999, true, 300_000)).toBe(false);
      expect(shouldNotify(300_000, true, 300_000)).toBe(true);
    });

    it('sends every run, however short, at a delay of zero', () => {
      expect(shouldNotify(0, true, 0)).toBe(true);
      expect(shouldNotify(1, true, 0)).toBe(true);
    });

    it('is still off when the feature is off', () => {
      expect(shouldNotify(60 * 60_000, false, 0)).toBe(false);
    });
  });
});

describe('the notice delay choices', () => {
  it('are the five the Mac app offers, in order, and a minute is among them', () => {
    expect([...NOTICE_DELAY_CHOICES_S]).toEqual([0, 15, 30, 60, 300]);
    expect(NOTICE_DELAY_CHOICES_S).toContain(NOTIFY_AFTER_MS / 1000);
  });

  describe('validNoticeDelaySeconds', () => {
    it.each([0, 15, 30, 60, 300])('keeps %s', (seconds) => {
      expect(validNoticeDelaySeconds(seconds)).toBe(seconds);
    });

    it('keeps 0 as 0 and does not mistake it for "unset"', () => {
      expect(validNoticeDelaySeconds(0)).toBe(0);
      // -0 is what JSON.parse("-0") gives; it is the choice 0, not a new value.
      expect(Object.is(validNoticeDelaySeconds(-0), 0)).toBe(true);
    });

    it.each([
      ['a string that spells a choice', '30'],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['a negative number', -1],
      ['a number between choices', 45],
      ['a number past the last choice', 3600],
      ['a fraction of a choice', 29.5],
      ['null', null],
      ['undefined', undefined],
      ['true', true],
      ['false', false],
      ['an object', {}],
      ['an array holding a choice', [30]],
    ])('falls back to a minute for %s', (_what, value) => {
      expect(validNoticeDelaySeconds(value)).toBe(60);
    });
  });

  describe('noticeDelayLabel', () => {
    it.each([
      [0, 'Right away'],
      [15, '15 seconds'],
      [30, '30 seconds'],
      [60, '1 minute'],
      [300, '5 minutes'],
    ])('calls %s "%s"', (seconds, label) => {
      expect(noticeDelayLabel(seconds)).toBe(label);
    });

    it('calls a value that is not offered the minute it will be treated as', () => {
      expect(noticeDelayLabel(45)).toBe('1 minute');
      expect(noticeDelayLabel('30')).toBe('1 minute');
      expect(noticeDelayLabel(undefined)).toBe('1 minute');
    });
  });
});

describe('formatDuration', () => {
  it('reads at a glance on a lock screen', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(4 * 60_000 + 12_000)).toBe('4m 12s');
    expect(formatDuration(63 * 60_000)).toBe('1h 03m');
  });
});

describe('composeRunMessages — the head', () => {
  it('says what finished and how long it took', () => {
    const text = composeRunMessages({ task: 'Refactor auth flow', elapsedMs: 5 * 60_000 })[0];
    expect(text).toContain('Refactor auth flow');
    expect(text).toContain('5m 00s');
    expect(text).toMatch(/finished/i);
  });

  it('marks a failed run rather than reporting it as done', () => {
    const text = composeRunMessages({
      task: 'Bump deps', elapsedMs: 90_000, failure: 'API error: 401',
    })[0];
    expect(text).toMatch(/stopped/i);
    expect(text).toContain('API error: 401');
    expect(text).not.toMatch(/finished/i);
  });

  it('omits a cost line rather than printing a zero on a flat-fee plan', () => {
    const text = composeRunMessages({ task: 'Update docs', elapsedMs: 70_000, costUsd: 0, tokens: 0 })[0];
    expect(text).not.toContain('$');
    expect(text).not.toMatch(/tokens/);
  });

  it('gives sub-cent amounts enough decimals to not read as free', () => {
    expect(composeRunMessages({ task: 'x', elapsedMs: 70_000, costUsd: 0.0042 })[0]).toContain('$0.0042');
    expect(composeRunMessages({ task: 'x', elapsedMs: 70_000, costUsd: 1.5 })[0]).toContain('$1.50');
  });

  it('carries no agent output for a run started at the terminal', () => {
    // The chat syncs to Telegram's servers, and a finished run can end with a
    // file it read or a secret inside an error. The answer travels only where
    // it was asked for, and at the terminal it is already on screen.
    const text = composeRunMessages({ task: 'Deploy', elapsedMs: 120_000, tokens: 128_000 })[0];
    expect(text.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('carries the answer when the phone is the one that asked', () => {
    // "finished, 33K tokens" answers nothing you asked from a phone.
    const text = composeRunMessages({
      task: 'koliko datoteka', elapsedMs: 20_000, answer: 'U src/utils ima 140 datoteka.',
    })[0];
    expect(text).toContain('U src/utils ima 140 datoteka.');
  });

  it('keeps every message inside what Telegram accepts', () => {
    // Telegram refuses anything over 4096 characters outright, so an uncut
    // answer would arrive as no message at all.
    for (const text of composeRunMessages({
      task: 'x', elapsedMs: 20_000, answer: 'y '.repeat(MAX_ANSWER_LENGTH),
    })) {
      expect(text.length).toBeLessThan(4096);
    }
  });

  it('ignores an answer that is only whitespace', () => {
    const text = composeRunMessages({ task: 'x', elapsedMs: 20_000, answer: '   \n  ' })[0];
    expect(text.split('\n').filter(Boolean).length).toBe(2);
  });

describe('composeRunMessages', () => {
  it('is one message when the answer fits, which is the usual case', () => {
    const messages = composeRunMessages({
      task: 'koliko datoteka', elapsedMs: 20_000, answer: 'U src/utils ima 140 datoteka.',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('U src/utils ima 140 datoteka.');
  });

  it('keeps the head on the first message so the reply says which run it is', () => {
    const messages = composeRunMessages({
      task: 'koliko datoteka', elapsedMs: 20_000, answer: 'x'.repeat(MAX_ANSWER_LENGTH * 2),
    });
    expect(messages[0]).toContain('koliko datoteka');
    expect(messages.length).toBeGreaterThan(1);
  });

  it('sends nothing extra when there is no answer', () => {
    expect(composeRunMessages({ task: 'x', elapsedMs: 90_000 })).toHaveLength(1);
  });
});

describe('splitAnswer', () => {
  it('says nothing when there is nothing to say', () => {
    expect(splitAnswer('   \n  ')).toEqual([]);
  });

  // The point of splitting: a long answer arrives whole, not truncated at the
  // first limit. The end is usually where the answer actually is.
  it('sends a long answer as several messages rather than cutting it', () => {
    const paragraph = 'rijec '.repeat(400);
    const parts = splitAnswer([paragraph, paragraph, 'zakljucak'].join('\n\n'));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toContain('zakljucak');
    expect(parts.join('')).not.toMatch(/cut/i);
  });

  it('stops after three and says the rest is in the terminal', () => {
    const parts = splitAnswer('z '.repeat(MAX_ANSWER_LENGTH * 4));
    expect(parts).toHaveLength(MAX_ANSWER_PARTS);
    expect(parts[parts.length - 1]).toMatch(/cut/i);
  });

  // Splitting mid-word reads as damage; splitting between paragraphs reads as
  // a continuation.
  it('breaks between paragraphs when one ends near the limit', () => {
    const first = 'a'.repeat(MAX_ANSWER_LENGTH - 10);
    expect(splitAnswer(`${first}\n\ndrugi odlomak`)).toEqual([first, 'drugi odlomak']);
  });

  it('never splits in the middle of a word', () => {
    const parts = splitAnswer('alfa beta gama '.repeat(400));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) {
      expect(['alfa', 'beta', 'gama']).toContain(part.split(' ').pop());
    }
  });
});

describe('stripMarkdown', () => {
  it('unwraps the markers a phone shows as noise', () => {
    expect(stripMarkdown('**140 datoteka**')).toBe('140 datoteka');
    expect(stripMarkdown('u `src/utils`')).toBe('u src/utils');
    expect(stripMarkdown('## Naslov')).toBe('Naslov');
  });

  it('leaves single underscores alone, because identifiers use them', () => {
    // `execute_command` and snake_case turn up in these answers constantly;
    // mangling one to italicise nothing is worse than a visible marker.
    expect(stripMarkdown('moj execute_command alat')).toBe('moj execute_command alat');
    expect(stripMarkdown('a_b_c_d')).toBe('a_b_c_d');
  });

  it('keeps the code inside a fence and drops the fence', () => {
    expect(stripMarkdown('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('leaves an unpaired marker rather than eating the rest of the answer', () => {
    // Looking for a partner that is not there is how a strip turns one stray
    // character into a truncated answer.
    expect(stripMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(stripMarkdown('a lone ` backtick')).toBe('a lone ` backtick');
  });

  it('is applied to the answer that goes to the phone', () => {
    expect(composeRunMessages({ task: 'x', elapsedMs: 20_000, answer: '**140** datoteka' })[0])
      .toContain('140 datoteka');
  });

  it('does not send markup to Telegram as parse_mode instead', () => {
    // Telegram rejects a whole message whose markup is unbalanced, and an
    // agent's answer is arbitrary text. One stray asterisk and the notice
    // would not arrive at all.
    // Comments stripped first: this file explains at length why parse_mode is
    // not used, and matching that explanation would pass for the wrong reason.
    const code = readFileSync('src/utils/telegramNotify.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('parse_mode');
  });
});
});

describe('noticeAnswer', () => {
  it('gives a run started from the phone its answer, whatever the setting', () => {
    expect(noticeAnswer({ fromPhone: true, terminalAnswers: false, finalResponse: 'done' })).toBe('done');
  });

  it('keeps a terminal run\'s answer off the chat unless the user turned that on', () => {
    expect(noticeAnswer({ fromPhone: false, terminalAnswers: false, finalResponse: 'done' })).toBeUndefined();
    expect(noticeAnswer({ fromPhone: false, terminalAnswers: true, finalResponse: 'done' })).toBe('done');
  });
});

describe('shortLabel', () => {
  // What the phone's head has said since the run's name came from the task
  // and not the session: moved here from agentExecution.ts so the desktop
  // toast names a run the same way, and pinned so the move changed nothing.
  it('is the first five words, white space collapsed', () => {
    expect(shortLabel('fix the login bug')).toBe('fix the login bug');
    expect(shortLabel('  fix \n the\tlogin   bug in the auth module ')).toBe('fix the login bug in');
    expect(shortLabel('')).toBe('');
    expect(shortLabel('   ')).toBe('');
  });

  it('is cut at 48 characters, 45 and an ellipsis', () => {
    const long = 'internationalization internationalization internationalization';
    expect(shortLabel(long)).toBe(`${long.slice(0, 45)}…`);
    expect(shortLabel('x'.repeat(48))).toBe('x'.repeat(48));
    expect(shortLabel('x'.repeat(49))).toBe(`${'x'.repeat(45)}…`);
  });

  it('can leave words out before it takes five, which the phone never does', () => {
    const words = 'one SKIP two SKIP three four five six';
    expect(shortLabel(words)).toBe('one SKIP two SKIP three');
    expect(shortLabel(words, word => word !== 'SKIP')).toBe('one two three four five');
  });
});
