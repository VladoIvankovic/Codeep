import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  composeRunMessages,
  splitAnswer,
  formatDuration,
  shouldNotify,
  NOTIFY_AFTER_MS,
  MAX_ANSWER_LENGTH,
  MAX_ANSWER_PARTS,
  stripMarkdown,
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
