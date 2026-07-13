import { describe, it, expect } from 'vitest';
import { searchMessages, type SearchResult } from './search';
import type { Message } from '../config/index';

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content } as Message;
}

describe('searchMessages', () => {
  it('returns an empty array when no message matches', () => {
    const out = searchMessages([msg('user', 'hello world')], 'missing');
    expect(out).toEqual([]);
  });

  it('returns an empty array for an empty message list', () => {
    expect(searchMessages([], 'anything')).toEqual([]);
  });

  it('finds a substring inside a message', () => {
    const out = searchMessages([msg('user', 'fix the bug')], 'bug');
    expect(out.length).toBe(1);
    expect(out[0].messageIndex).toBe(0);
    expect(out[0].role).toBe('user');
    expect(out[0].matchedText).toContain('bug');
  });

  it('is case-insensitive on the search term', () => {
    const out = searchMessages([msg('assistant', 'Hello World')], 'hello');
    expect(out.length).toBe(1);
    expect(out[0].matchedText).toContain('Hello');
  });

  it('is case-insensitive on the message content', () => {
    expect(searchMessages([msg('user', 'ERROR')], 'error').length).toBe(1);
    expect(searchMessages([msg('user', 'error')], 'ERROR').length).toBe(1);
  });

  it('records the correct messageIndex for matches across multiple messages', () => {
    const msgs = [
      msg('user', 'first'),
      msg('assistant', 'second'),
      msg('user', 'third with target'),
    ];
    const out = searchMessages(msgs, 'target');
    expect(out.length).toBe(1);
    expect(out[0].messageIndex).toBe(2);
  });

  it('returns one result per matching message (not per occurrence)', () => {
    const out = searchMessages([msg('user', 'x x x')], 'x');
    expect(out.length).toBe(1);
  });

  it('includes up to 50 chars of context on each side of the match', () => {
    const long = 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200);
    const out = searchMessages([msg('user', long)], 'needle');
    expect(out.length).toBe(1);
    const snippet = out[0].matchedText;
    expect(snippet).toContain('NEEDLE');
    // The snippet should be much shorter than the full content.
    expect(snippet.length).toBeLessThan(long.length);
  });

  it('prefixes with ... when the match starts after char 50', () => {
    // The snippet window is matchIndex-50 .. matchIndex+term+50; the
    // leading "..." only appears when start > 0, i.e. matchIndex > 50.
    const long = 'x'.repeat(60) + 'TARGET';
    const out = searchMessages([msg('user', long)], 'target');
    expect(out[0].matchedText.startsWith('...')).toBe(true);
  });

  it('does not prefix with ... when the match is within the first 50 chars', () => {
    const out = searchMessages([msg('user', 'prefix TARGET')], 'target');
    expect(out[0].matchedText.startsWith('...')).toBe(false);
  });

  it('appends ... when the match ends before the last 50 chars', () => {
    // Trailing "..." only appears when end < content.length, i.e. there
    // are more than 50 chars after the match.
    const long = 'TARGET' + 'x'.repeat(60);
    const out = searchMessages([msg('user', long)], 'target');
    expect(out[0].matchedText.endsWith('...')).toBe(true);
  });

  it('does not append ... when the match is within the last 50 chars', () => {
    const out = searchMessages([msg('user', 'TARGET suffix')], 'target');
    expect(out[0].matchedText.endsWith('...')).toBe(false);
  });

  it('preserves the original-case content in the result', () => {
    const out = searchMessages([msg('assistant', 'MixedCase TEXT')], 'text');
    expect(out[0].content).toBe('MixedCase TEXT');
  });

  it('handles a multi-word search term', () => {
    const out = searchMessages([msg('user', 'fix the broken test')], 'broken test');
    expect(out.length).toBe(1);
    expect(out[0].matchedText).toContain('broken test');
  });

  it('handles special regex characters in the term as literals', () => {
    // searchMessages uses String.includes, not RegExp, so regex chars
    // like ( and . are treated as literals.
    const out = searchMessages([msg('user', 'function(args).x')], '(args)');
    expect(out.length).toBe(1);
  });
});
