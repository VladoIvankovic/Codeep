import { describe, it, expect } from 'vitest';
import { parseCommandInput } from './inputParsing';

describe('parseCommandInput', () => {
  it('parses a bare command with no args', () => {
    expect(parseCommandInput('/help')).toEqual({ command: 'help', args: [] });
  });

  it('parses a command with a single arg', () => {
    expect(parseCommandInput('/scan src')).toEqual({ command: 'scan', args: ['src'] });
  });

  it('parses a command with multiple args', () => {
    expect(parseCommandInput('/rename my session name')).toEqual({
      command: 'rename',
      args: ['my', 'session', 'name'],
    });
  });

  it('lower-cases the command name but preserves arg case', () => {
    expect(parseCommandInput('/SCAN FooBar')).toEqual({
      command: 'scan',
      args: ['FooBar'],
    });
  });

  it('collapses runs of whitespace between args', () => {
    expect(parseCommandInput('/scan    a   b')).toEqual({
      command: 'scan',
      args: ['a', 'b'],
    });
  });

  it('trims trailing whitespace', () => {
    expect(parseCommandInput('/help   ')).toEqual({ command: 'help', args: [] });
  });

  it('returns null when the input does not start with /', () => {
    expect(parseCommandInput('help')).toBeNull();
    expect(parseCommandInput(' help')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseCommandInput('')).toBeNull();
  });

  it('returns null for a lone slash', () => {
    expect(parseCommandInput('/')).toBeNull();
  });

  it('returns null for a slash followed only by whitespace', () => {
    expect(parseCommandInput('/   ')).toBeNull();
  });

  it('treats a leading double slash as a single command', () => {
    // input.startsWith('/') is true; slice(1) leaves "/help", then split
    // on whitespace → ["/help"], lower-cased to "/help". This documents
    // the current behaviour: a double slash is NOT normalised away.
    const parsed = parseCommandInput('//help');
    expect(parsed).not.toBeNull();
    expect(parsed!.command).toBe('/help');
    expect(parsed!.args).toEqual([]);
  });

  it('preserves arg order', () => {
    const parsed = parseCommandInput('/x a b c d e');
    expect(parsed).not.toBeNull();
    expect(parsed!.args).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('handles args that contain slashes', () => {
    expect(parseCommandInput('/docs src/index.ts')).toEqual({
      command: 'docs',
      args: ['src/index.ts'],
    });
  });

  it('handles a command name with hyphens', () => {
    expect(parseCommandInput('/git-commit')).toEqual({ command: 'git-commit', args: [] });
  });
});
