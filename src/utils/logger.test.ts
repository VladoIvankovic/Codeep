import { describe, it, expect } from 'vitest';
import { formatLogEntry, type LogEntry } from './logger';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2025-01-15T12:00:00.000Z',
    level: 'info',
    message: 'hello',
    ...overrides,
  };
}

describe('formatLogEntry', () => {
  it('formats a basic entry with timestamp, level, and message', () => {
    const out = formatLogEntry(entry());
    expect(out).toBe('[2025-01-15T12:00:00.000Z] [INFO] hello\n');
  });

  it('uppercases the level', () => {
    expect(formatLogEntry(entry({ level: 'warn' }))).toContain('[WARN]');
    expect(formatLogEntry(entry({ level: 'error' }))).toContain('[ERROR]');
    expect(formatLogEntry(entry({ level: 'debug' }))).toContain('[DEBUG]');
  });

  it('appends JSON-stringified data after the message when present', () => {
    const out = formatLogEntry(entry({ data: { count: 3 } }));
    expect(out).toBe('[2025-01-15T12:00:00.000Z] [INFO] hello {"count":3}\n');
  });

  it('omits the data suffix entirely when data is undefined', () => {
    const out = formatLogEntry(entry({ data: undefined }));
    expect(out).not.toContain('{');
  });

  it('treats falsy data values (0, false, empty string) as absent', () => {
    // `data ? ...` treats 0 / false / '' as absent — this documents that.
    // We check the data suffix (the JSON part) is missing by looking for
    // the key we'd otherwise serialise, not for a bare digit.
    expect(formatLogEntry(entry({ data: 0 }))).toBe('[2025-01-15T12:00:00.000Z] [INFO] hello\n');
    expect(formatLogEntry(entry({ data: false }))).toBe('[2025-01-15T12:00:00.000Z] [INFO] hello\n');
    expect(formatLogEntry(entry({ data: '' }))).toBe('[2025-01-15T12:00:00.000Z] [INFO] hello\n');
  });

  it('serialises arrays in data', () => {
    const out = formatLogEntry(entry({ data: [1, 2, 3] }));
    expect(out).toContain('[1,2,3]');
  });

  it('serialises nested objects', () => {
    const out = formatLogEntry(entry({ data: { a: { b: 'c' } } }));
    expect(out).toContain('{"a":{"b":"c"}}');
  });

  it('preserves multi-line messages verbatim', () => {
    const out = formatLogEntry(entry({ message: 'line1\nline2' }));
    expect(out).toContain('line1\nline2');
  });

  it('always ends with a trailing newline', () => {
    expect(formatLogEntry(entry()).endsWith('\n')).toBe(true);
    expect(formatLogEntry(entry({ data: { x: 1 } })).endsWith('\n')).toBe(true);
  });
});
