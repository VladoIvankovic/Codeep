import { describe, it, expect } from 'vitest';
import {
  messageFromOwner,
  extractPrompt,
  describeRejection,
  describeQueued,
  describeStarted,
  InboxQueue,
  MAX_PROMPT_LENGTH,
  MAX_MESSAGE_AGE_MS,
  markRunFromPhone,
  takeRunFromPhone,
} from './telegramInbox';

const CHAT = '7843585422';
const NOW = 1_800_000_000_000;
const fresh = Math.floor(NOW / 1000);
const msg = (over: Record<string, unknown> = {}) =>
  ({ chat: { id: Number(CHAT) }, text: 'run the tests', date: fresh, ...over });

describe('messageFromOwner', () => {
  it('accepts the configured chat', () => {
    expect(messageFromOwner(msg(), CHAT)).toBe(true);
    expect(messageFromOwner(msg({ chat: { id: CHAT } }), CHAT)).toBe(true);
  });

  it('rejects any other chat', () => {
    expect(messageFromOwner(msg({ chat: { id: 999 } }), CHAT)).toBe(false);
  });

  it('does not treat an empty configured id as a wildcard', () => {
    // A half-configured install must not accept the whole world.
    expect(messageFromOwner(msg(), '')).toBe(false);
  });

  it('rejects a near miss rather than coercing it', () => {
    expect(messageFromOwner(msg({ chat: { id: 78435854220 } }), CHAT)).toBe(false);
    expect(messageFromOwner({ chat: {} }, CHAT)).toBe(false);
    expect(messageFromOwner(null, CHAT)).toBe(false);
  });
});

describe('extractPrompt', () => {
  it('takes a plain instruction from the owner', () => {
    expect(extractPrompt(msg(), CHAT, NOW)).toEqual({ ok: true, text: 'run the tests' });
  });

  it('trims, so a trailing newline does not become part of the prompt', () => {
    expect(extractPrompt(msg({ text: '  run the tests \n' }), CHAT, NOW))
      .toEqual({ ok: true, text: 'run the tests' });
  });

  it('refuses a stranger before looking at anything else', () => {
    expect(extractPrompt(msg({ chat: { id: 999 } }), CHAT, NOW))
      .toEqual({ ok: false, reason: 'not-from-owner' });
  });

  it('refuses anything that is not text', () => {
    // A photo or voice note has no `text` at all.
    expect(extractPrompt({ chat: { id: Number(CHAT) }, date: fresh }, CHAT, NOW))
      .toEqual({ ok: false, reason: 'not-text' });
  });

  it('refuses slash commands, which are addressed to the bot', () => {
    for (const text of ['/start', '/help now']) {
      expect(extractPrompt(msg({ text }), CHAT, NOW)).toEqual({ ok: false, reason: 'command' });
    }
  });

  it('refuses a paste', () => {
    expect(extractPrompt(msg({ text: 'x'.repeat(MAX_PROMPT_LENGTH + 1) }), CHAT, NOW))
      .toEqual({ ok: false, reason: 'too-long' });
    expect(extractPrompt(msg({ text: 'x'.repeat(MAX_PROMPT_LENGTH) }), CHAT, NOW).ok).toBe(true);
  });

  it('refuses a message the backlog delivered late', () => {
    // Telegram keeps undelivered updates for 24 hours. Typing an instruction to
    // a machine that is switched off must not run it when the CLI next starts.
    const old = Math.floor((NOW - MAX_MESSAGE_AGE_MS - 1000) / 1000);
    expect(extractPrompt(msg({ date: old }), CHAT, NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts one sent just inside the window', () => {
    const recent = Math.floor((NOW - MAX_MESSAGE_AGE_MS + 5_000) / 1000);
    expect(extractPrompt(msg({ date: recent }), CHAT, NOW).ok).toBe(true);
  });

  it('accepts a message with no date rather than guessing it is old', () => {
    expect(extractPrompt({ chat: { id: Number(CHAT) }, text: 'go' }, CHAT, NOW).ok).toBe(true);
  });
});

describe('describeRejection', () => {
  it('tells a stranger nothing at all', () => {
    // Any reply confirms the bot is live and attached to something worth probing.
    expect(describeRejection('not-from-owner')).toBeNull();
  });

  it('explains every rejection the owner can cause', () => {
    for (const reason of ['not-text', 'too-long', 'stale', 'command'] as const) {
      expect(describeRejection(reason)).toBeTruthy();
    }
  });

  it('says what to do, not just what went wrong', () => {
    expect(describeRejection('stale')).toMatch(/send it again/i);
    expect(describeRejection('too-long')).toMatch(/shorter/i);
  });
});

describe('InboxQueue', () => {
  it('holds one instruction and hands it over once', () => {
    const queue = new InboxQueue();
    expect(queue.waiting).toBe(false);
    expect(queue.offer('run the tests')).toEqual({ replaced: false });
    expect(queue.waiting).toBe(true);
    expect(queue.take()).toBe('run the tests');
    expect(queue.take()).toBeNull();
    expect(queue.waiting).toBe(false);
  });

  it('keeps the newest instruction, not the oldest', () => {
    // Two corrections sent during one long run mean the second, not both.
    const queue = new InboxQueue();
    queue.offer('run the tests');
    expect(queue.offer('actually, run the linter')).toEqual({ replaced: true });
    expect(queue.take()).toBe('actually, run the linter');
  });

  it('says when it displaced something rather than dropping it quietly', () => {
    const queue = new InboxQueue();
    queue.offer('first');
    expect(describeQueued(queue.offer('second').replaced)).toMatch(/replaces/i);
    expect(describeQueued(false)).not.toMatch(/replaces/i);
  });

  it('can be emptied when the session it belonged to ends', () => {
    const queue = new InboxQueue();
    queue.offer('run the tests');
    queue.clear();
    expect(queue.waiting).toBe(false);
  });
});

describe('describeStarted', () => {
  it('quotes the instruction back so the sender knows it was read correctly', () => {
    expect(describeStarted('run the tests')).toContain('run the tests');
  });

  it('shortens a long one instead of repeating a wall of text to a phone', () => {
    const text = 'a'.repeat(200);
    const out = describeStarted(text);
    expect(out.length).toBeLessThan(80);
    expect(out).toMatch(/…$/);
  });

describe('run origin', () => {
  it('reports a phone-started run once, then forgets', () => {
    // Consumed rather than read: left set, the next run started at the terminal
    // would post its output to Telegram too.
    markRunFromPhone();
    expect(takeRunFromPhone()).toBe(true);
    expect(takeRunFromPhone()).toBe(false);
  });

  it('starts out false, so a terminal run says nothing', () => {
    takeRunFromPhone();
    expect(takeRunFromPhone()).toBe(false);
  });
});
});
