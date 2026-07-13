import { describe, it, expect } from 'vitest';
import {
  exportToMarkdown,
  exportToJson,
  exportToText,
  exportMessages,
  type ExportFormat,
} from './export';
import type { Message } from '../config/index';

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content } as Message;
}

const conversation: Message[] = [
  msg('user', 'Hello'),
  msg('assistant', 'Hi there'),
];

describe('exportToMarkdown', () => {
  const out = exportToMarkdown(conversation, 'my-session');

  it('includes a title header', () => {
    expect(out).toContain('# Codeep Chat Export');
  });

  it('includes the session name when provided', () => {
    expect(out).toContain('**Session:** my-session');
  });

  it('includes a timestamp', () => {
    expect(out).toMatch(/\*\*Exported:\*\* .+/);
  });

  it('labels user messages with the user emoji', () => {
    expect(out).toContain('## 👤 User');
    expect(out).toContain('Hello');
  });

  it('labels assistant messages with the assistant emoji', () => {
    expect(out).toContain('## 🤖 Assistant');
    expect(out).toContain('Hi there');
  });

  it('separates messages with a horizontal rule (except after the last)', () => {
    const rules = out.match(/^---$/gm) ?? [];
    // One after the header, plus separators between messages.
    expect(rules.length).toBeGreaterThanOrEqual(2);
  });
});

describe('exportToJson', () => {
  const out = exportToJson(conversation, 'my-session');
  const parsed = JSON.parse(out);

  it('produces valid JSON', () => {
    expect(parsed).toBeTruthy();
  });

  it('includes the session name', () => {
    expect(parsed.session).toBe('my-session');
  });

  it('defaults the session name to "Unnamed" when not provided', () => {
    expect(JSON.parse(exportToJson(conversation)).session).toBe('Unnamed');
  });

  it('includes a messageCount field that matches the array length', () => {
    expect(parsed.messageCount).toBe(2);
    expect(parsed.messages.length).toBe(2);
  });

  it('preserves message content verbatim', () => {
    expect(parsed.messages[0].content).toBe('Hello');
    expect(parsed.messages[1].content).toBe('Hi there');
  });

  it('includes an ISO-8601 exportedAt timestamp', () => {
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('exportToText', () => {
  const out = exportToText(conversation, 'my-session');

  it('includes a title banner', () => {
    expect(out).toContain('Codeep Chat Export');
    expect(out).toContain('===================');
  });

  it('includes the session name when provided', () => {
    expect(out).toContain('Session: my-session');
  });

  it('includes a message count', () => {
    expect(out).toContain('Messages: 2');
  });

  it('uses UPPERCASE role labels', () => {
    expect(out).toContain('[USER]');
    expect(out).toContain('[ASSISTANT]');
  });

  it('separates messages with ---', () => {
    expect(out).toContain('---');
  });
});

describe('exportMessages', () => {
  it.each(['md', 'json', 'txt'] as ExportFormat[])(
    'dispatches format %s without throwing',
    (format) => {
      expect(typeof exportMessages(conversation, { format })).toBe('string');
    },
  );

  it('throws on an unknown format', () => {
    expect(() =>
      exportMessages(conversation, { format: 'pdf' as unknown as ExportFormat }),
    ).toThrow(/Unknown export format/);
  });

  it('produces Markdown output for the md format', () => {
    expect(exportMessages(conversation, { format: 'md' })).toContain('# Codeep Chat Export');
  });

  it('produces valid JSON output for the json format', () => {
    expect(() => JSON.parse(exportMessages(conversation, { format: 'json' }))).not.toThrow();
  });

  it('produces plain-text output for the txt format', () => {
    expect(exportMessages(conversation, { format: 'txt' })).toContain('[USER]');
  });

  it('handles an empty message list', () => {
    expect(() => exportMessages([], { format: 'md' })).not.toThrow();
    expect(() => exportMessages([], { format: 'json' })).not.toThrow();
    expect(() => exportMessages([], { format: 'txt' })).not.toThrow();
  });
});
