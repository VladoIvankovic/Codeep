import { describe, it, expect } from 'vitest';
import { formatWelcomeMessage } from './WelcomeFormatter';
import { PRIMARY_COLOR } from './uiConstants';
import { fg, style } from '../ansi';

describe('formatWelcomeMessage', () => {
  it('renders a blank line as an empty line and keeps the trailing newline', () => {
    const out = formatWelcomeMessage('');
    // Empty body → split yields [''], becomes one blank line, plus the
    // canonical trailing blank line.
    expect(out).toHaveLength(2);
    expect(out.every(l => l.text === '')).toBe(true);
  });

  it('colors the version header with the brand red and the two meta parts', () => {
    const out = formatWelcomeMessage('Codeep v1.0.0  ·  Anthropic  ·  claude-4');
    const versionLine = out[0];
    expect(versionLine.raw).toBe(true);
    expect(versionLine.text).toContain(PRIMARY_COLOR);
    expect(versionLine.text).toContain('Codeep v1.0.0');
    expect(versionLine.text).toContain('Anthropic');
    expect(versionLine.text).toContain('claude-4');
  });

  it('renders a Project label line in the label/project colours', () => {
    const out = formatWelcomeMessage('  Project /some/path');
    expect(out[0].text).toContain('Project');
    expect(out[0].text).toContain('/some/path');
    expect(out[0].raw).toBe(true);
  });

  it('renders an Access line with a green access level and joined extras', () => {
    const out = formatWelcomeMessage('  Access read  ·  write');
    expect(out[0].text).toContain('Access');
    expect(out[0].text).toContain('read');
    expect(out[0].text).toContain('write');
  });

  it('renders a Mode line in the muted grey', () => {
    const out = formatWelcomeMessage('  Mode auto');
    expect(out[0].text).toContain('Mode');
    expect(out[0].text).toContain('auto');
  });

  it('renders a ⚠ warning line in amber', () => {
    const out = formatWelcomeMessage('⚠ Agent mode active');
    expect(out[0].text).toContain('Agent mode active');
    // The amber colour code is fg.rgb(220,160,40).
    expect(out[0].text).toContain(fg.rgb(220, 160, 40));
  });

  it('renders a /help shortcuts line', () => {
    const out = formatWelcomeMessage('Type /help for commands  ·  /exit to quit');
    expect(out[0].text).toContain('/help');
    expect(out[0].text).toContain('/exit');
  });

  it('passes through an unrecognised line verbatim', () => {
    const out = formatWelcomeMessage('just some text');
    expect(out[0]).toEqual({ text: 'just some text', style: '' });
  });

  it('always appends one trailing blank line', () => {
    const out = formatWelcomeMessage('Codeep v1.0.0');
    expect(out[out.length - 1]).toEqual({ text: '', style: '' });
  });

  it('preserves blank lines in the middle of the body', () => {
    const out = formatWelcomeMessage('line one\n\nline two');
    // [line one, '', line two, '' (trailing)]
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ text: '', style: '' });
  });

  it('handles a multi-part welcome body end-to-end', () => {
    const body = [
      'Codeep v1.0.0  ·  OpenAI  ·  gpt-4o',
      '',
      '  Project /Users/me/code',
      '  Access read  ·  write',
      '  Mode auto',
      '⚠ Agent mode active',
      'Type /help for commands',
    ].join('\n');
    const out = formatWelcomeMessage(body);
    // 7 body lines + 1 trailing blank.
    expect(out).toHaveLength(8);
    expect(out[0].text).toContain('Codeep v1.0.0');
    expect(out[6].text).toContain('/help');
  });
});
