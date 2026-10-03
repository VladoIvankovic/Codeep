import { describe, it, expect } from 'vitest';
import { looksUnfinished, FRAGMENT_MAX_CHARS } from './unfinishedReply';

describe('looksUnfinished — a model that stopped mid-turn', () => {
  it.each([
    ['an empty reply', ''],
    ['only whitespace', '  \n '],
    ['a lead-in ending with a colon', 'Let me look at the files:'],
    ['a lead-in in Croatian ending with a colon', 'Evo, kreiram sve odjednom:'],
    ['an announcement with no colon', "I'll create everything now"],
    ['an announcement in Croatian with no colon', 'Sada ću napraviti sve datoteke'],
    ['an announcement after a first line', 'Got it.\n\nI will write the fix now'],
    ['an announcement ending on a hyphenated word', 'Now I will write the follow-up'],
    ['a lead-in that trails off with an ellipsis', 'Let me check the files…'],
    ['a short lead-in that trails off with an ellipsis', 'Let me check…'],
  ])('%s', (_label, reply) => {
    expect(looksUnfinished(reply)).toBe(true);
  });
});

describe('looksUnfinished — an answer, which is never nudged', () => {
  it.each([
    ['one word', 'ready'],
    ['one word, padded', '  ready\n'],
    ['two words', 'Yes please'],
    ['three words', 'No changes needed'],
    ['a number', '42'],
    ['a negative decimal', '-3.14'],
    ['an identifier', 'CODEEP_CONFIG_DIR'],
    ['a path', 'src/utils/agent.ts'],
    ['a code span', '`npm test`'],
    ['a sentence ending on a number', 'The answer is 42'],
    ['a sentence ending on a path', 'It lives in src/utils/agent.ts'],
    ['a command with a flag', 'git log --oneline -5'],
    ['a sentence with a full stop', 'I created the three files you asked for.'],
    ['a question', 'Which of the two files should I change?'],
    ['a list', 'Two options\n- fast\n- slow'],
    ['CJK with no spaces', '我现在创建所有文件'],
    ['a one-word answer with an ellipsis', 'Maybe…'],
  ])('%s', (_label, reply) => {
    expect(looksUnfinished(reply)).toBe(false);
  });

  it('takes a long reply without a full stop as finished', () => {
    const long = 'word '.repeat(Math.ceil(FRAGMENT_MAX_CHARS / 5) + 1).trim();
    expect(long.length).toBeGreaterThanOrEqual(FRAGMENT_MAX_CHARS);
    expect(looksUnfinished(long)).toBe(false);
  });
});
