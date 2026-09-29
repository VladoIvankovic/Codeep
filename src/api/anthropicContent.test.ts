import { describe, it, expect } from 'vitest';
import { anthropicText, anthropicRefusalNotice, isAnthropicRefusalNotice } from './anthropicContent';

describe('anthropicText', () => {
  // "A response can begin with thinking blocks, so code that reads
  // content[0].text breaks" — Anthropic, Migrating to Claude Sonnet 5.5. At the
  // default display "omitted" the thinking block's text is empty.
  it('reads the text blocks after a thinking block, not content[0]', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'The answer.' },
    ];
    expect(anthropicText(content)).toBe('The answer.');
  });

  it('joins every text block in order and skips everything else', () => {
    const content = [
      { type: 'text', text: 'Reading the file. ' },
      { type: 'thinking', thinking: 'progress update', signature: 's' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'text', text: 'Done.' },
    ];
    expect(anthropicText(content)).toBe('Reading the file. Done.');
  });

  it('returns "" for a declined reply (no content) and for anything that is not a block list', () => {
    expect(anthropicText([])).toBe('');
    expect(anthropicText(undefined)).toBe('');
    expect(anthropicText(null)).toBe('');
    expect(anthropicText('text')).toBe('');
    expect(anthropicText([null, { type: 'text' }, { type: 'text', text: 42 }])).toBe('');
  });
});

describe('anthropicRefusalNotice', () => {
  it('names the stop_details category of a decline', () => {
    for (const category of ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms']) {
      expect(anthropicRefusalNotice('refusal', { type: 'refusal', category, explanation: 'x' }))
        .toBe(`Claude declined this request (category: ${category}).`);
    }
  });

  // stop_details is informational: it (and its category) can be null.
  it('still reports a decline without a category', () => {
    expect(anthropicRefusalNotice('refusal', null)).toBe('Claude declined this request.');
    expect(anthropicRefusalNotice('refusal', undefined)).toBe('Claude declined this request.');
    expect(anthropicRefusalNotice('refusal', { type: 'refusal', category: null })).toBe('Claude declined this request.');
  });

  it('is null for every other stop reason', () => {
    for (const reason of ['end_turn', 'max_tokens', 'tool_use', 'pause_turn', 'stop_sequence', null, undefined]) {
      expect(anthropicRefusalNotice(reason, { category: 'cyber' })).toBeNull();
    }
  });
});

describe('isAnthropicRefusalNotice', () => {
  // Internal callers (summaries, titles, plans, skill steps, MCP sampling) use
  // it to tell the notice chat() returns on a decline from an answer.
  it('recognises every notice anthropicRefusalNotice produces', () => {
    const notices = [
      anthropicRefusalNotice('refusal', null),
      ...['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms', 'new_category']
        .map(category => anthropicRefusalNotice('refusal', { category })),
    ];
    for (const notice of notices) {
      expect(isAnthropicRefusalNotice(notice)).toBe(true);
      expect(isAnthropicRefusalNotice(`  ${notice}\n`)).toBe(true);
    }
  });

  it('is false for answers, even ones that mention a decline', () => {
    for (const text of [
      '',
      'OAuth2 migration for auth module',
      'Claude declined this request',            // no period: not the notice
      'Here is\n\nClaude declined this request.', // partial text + notice is not what chat() returns
      'Summary: Claude declined this request (category: cyber). Then the user rephrased.',
      // Opens with the notice and ends in `).`: a category match that ran past
      // the first `)` took this recap for a decline.
      'Claude declined this request (category: cyber). The user then narrowed the scan (see notes).',
      'claude declined this request.',
    ]) {
      expect(isAnthropicRefusalNotice(text)).toBe(false);
    }
    expect(isAnthropicRefusalNotice(null)).toBe(false);
    expect(isAnthropicRefusalNotice(undefined)).toBe(false);
  });
});
