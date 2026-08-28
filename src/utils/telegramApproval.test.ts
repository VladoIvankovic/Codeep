import { describe, it, expect } from 'vitest';
import {
  composeMessage,
  isFromOwner,
  parseCallbackData,
  buildKeyboard,
  nextOffset,
  outcomeForAnswer,
  describeApiError,
} from './telegramApproval';

describe('isFromOwner', () => {
  const owner = { message: { chat: { id: 123456789 } } };

  /**
   * The whole feature rests on this one function. A Telegram bot answers anyone
   * who finds its username, so without this check a stranger could approve a
   * destructive command on someone else's machine.
   */
  it('accepts the configured chat', () => {
    expect(isFromOwner(owner, '123456789')).toBe(true);
  });

  it('rejects any other chat', () => {
    expect(isFromOwner({ message: { chat: { id: 987654321 } } }, '123456789')).toBe(false);
  });

  // A numeric id compared loosely against a string is the classic way this goes
  // wrong: `123456789 == '123456789'` is true in JavaScript, and so is
  // `0 == ''`. The comparison is done on strings for exactly that reason.
  it('does not treat an empty configured id as a wildcard', () => {
    expect(isFromOwner(owner, '')).toBe(false);
    expect(isFromOwner({ message: { chat: { id: 0 } } }, '')).toBe(false);
  });

  it('rejects a near miss rather than coercing it', () => {
    expect(isFromOwner(owner, '12345678')).toBe(false);
    expect(isFromOwner(owner, ' 123456789')).toBe(false);
    expect(isFromOwner(owner, '123456789 ')).toBe(false);
  });

  it('accepts an id Telegram sent as a string', () => {
    expect(isFromOwner({ message: { chat: { id: '123456789' } } }, '123456789')).toBe(true);
  });

  // Anything malformed must fail closed. These are what a hostile or broken
  // client actually sends, and none of them may reach a decision.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['no chat', { message: {} }],
    ['no id', { message: { chat: {} } }],
    ['id is an object', { message: { chat: { id: {} } } }],
    ['id is null', { message: { chat: { id: null } } }],
    ['message is a string', { message: 'nope' }],
    ['chat nested wrongly', { chat: { id: 123456789 } }],
  ])('rejects %s', (_name, payload) => {
    expect(isFromOwner(payload, '123456789')).toBe(false);
  });
});

describe('parseCallbackData', () => {
  it.each([
    ['run', 'run:abc123'],
    ['skip', 'skip:abc123'],
    ['cancel', 'cancel:abc123'],
  ])('reads %s', (answer, data) => {
    expect(parseCallbackData(data)).toEqual({ answer, token: 'abc123' });
  });

  // Splitting on the FIRST colon only. A token containing one would otherwise
  // be truncated, and a truncated token never matches, so every tap would be
  // silently ignored.
  it('keeps a colon inside the token', () => {
    expect(parseCallbackData('run:ab:cd')).toEqual({ answer: 'run', token: 'ab:cd' });
  });

  it.each([
    ['unknown answer', 'approve:abc'],
    ['no separator', 'runabc'],
    ['empty token', 'run:'],
    ['empty answer', ':abc'],
    ['empty string', ''],
    ['just a colon', ':'],
    ['case mismatch', 'Run:abc'],
    ['answer with padding', ' run:abc'],
  ])('refuses %s', (_name, data) => {
    expect(parseCallbackData(data)).toBeNull();
  });
});

describe('composeMessage', () => {
  it('marks a destructive tool differently', () => {
    expect(composeMessage('rm -rf build', 'execute_command', true)).toContain('destructive');
    expect(composeMessage('ls', 'execute_command', false)).not.toContain('destructive');
  });

  it('shows the tool and the command', () => {
    const text = composeMessage('git push --force', 'execute_command', true);
    expect(text).toContain('execute_command');
    expect(text).toContain('git push --force');
  });

  /**
   * A command that closes the fence would spill the rest of itself out as
   * prose, so what someone approves would not be what they were shown. That is
   * the one failure this feature cannot have.
   */
  it('neutralises a fence hidden in the command', () => {
    const text = composeMessage('echo ```; rm -rf /', 'execute_command', true);
    expect(text).not.toContain('echo ```');
    expect(text.match(/```/g)).toHaveLength(2);
  });

  it('truncates a very long command but keeps the fences balanced', () => {
    const text = composeMessage('x'.repeat(5000), 'execute_command', false);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('…');
    expect(text.match(/```/g)).toHaveLength(2);
  });
});

describe('buildKeyboard', () => {
  // The three callback_data strings are the contract with parseCallbackData.
  // Renamed on one side only, the buttons render and do nothing at all.
  it('emits three buttons whose data this module can parse back', () => {
    const keyboard = buildKeyboard('tok') as { inline_keyboard: { text: string; callback_data: string }[][] };
    const row = keyboard.inline_keyboard[0]!;
    expect(row).toHaveLength(3);

    for (const button of row) {
      const parsed = parseCallbackData(button.callback_data);
      expect(parsed).not.toBeNull();
      expect(parsed!.token).toBe('tok');
      expect(button.text.toLowerCase()).toBe(parsed!.answer);
    }
  });
});

describe('nextOffset', () => {
  /**
   * Telegram redelivers anything not acknowledged by a higher offset. Too low
   * and the same tap arrives forever; too high and a real answer is skipped.
   */
  it('advances past the highest update seen', () => {
    expect(nextOffset(0, [{ update_id: 5 }, { update_id: 7 }, { update_id: 6 }])).toBe(8);
  });

  it('never goes backwards', () => {
    expect(nextOffset(100, [{ update_id: 5 }])).toBe(100);
  });

  it('ignores updates with no usable id', () => {
    expect(nextOffset(3, [{}, { update_id: 'x' }, { update_id: null }])).toBe(3);
  });

  it('is unchanged by an empty poll', () => {
    expect(nextOffset(42, [])).toBe(42);
  });
});

describe('outcomeForAnswer', () => {
  it('maps each button to the gate outcome it means', () => {
    expect(outcomeForAnswer('run')).toBe('allow_once');
    expect(outcomeForAnswer('skip')).toBe('reject_once');
    expect(outcomeForAnswer('cancel')).toBe('reject_always');
  });

  /**
   * `classifyPermissionOutcome` fails closed, so a mapping that produced an
   * unrecognised string would deny silently: the user taps Run, nothing runs,
   * and nothing says why. Cross-checked against the real classifier rather than
   * against a copy of its rules.
   */
  it('produces outcomes the agent actually recognises', async () => {
    const { classifyPermissionOutcome } = await import('./agent');
    expect(classifyPermissionOutcome(outcomeForAnswer('run'))).toBe('allow-once');
    expect(classifyPermissionOutcome(outcomeForAnswer('skip'))).toBe('deny-once');
    expect(classifyPermissionOutcome(outcomeForAnswer('cancel'))).toBe('deny-always');
  });

  // The phone deliberately cannot grant a standing allow.
  it('never grants allow_always from a phone', () => {
    for (const answer of ['run', 'skip', 'cancel'] as const) {
      expect(outcomeForAnswer(answer)).not.toBe('allow_always');
    }
  });
});

describe('describeApiError', () => {
  /**
   * The failure people actually hit while setting this up. Left as a bare
   * "could not send", it is indistinguishable from a phone nobody picked up —
   * which is exactly how it presented the first time this ran for real.
   */
  it('explains a wrong chat ID in terms of what to do', () => {
    const message = describeApiError(400, { ok: false, description: 'Bad Request: chat not found' });
    expect(message).toContain('chat not found');
    expect(message).toMatch(/getUpdates|message the bot/i);
  });

  it('names a rejected token and where to fix it', () => {
    expect(describeApiError(401, { ok: false, description: 'Unauthorized' })).toContain('/telegram');
  });

  it('explains a blocked bot', () => {
    expect(describeApiError(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }))
      .toMatch(/blocked/i);
  });

  it('passes through anything else Telegram said rather than inventing a reason', () => {
    expect(describeApiError(400, { ok: false, description: 'Bad Request: message is too long' }))
      .toContain('message is too long');
  });

  it('still says something when there is no description', () => {
    expect(describeApiError(502, null)).toContain('502');
  });
});
