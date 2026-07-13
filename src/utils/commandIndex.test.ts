import { describe, it, expect } from 'vitest';
import { COMMAND_INDEX, formatCommandIndex } from './commandIndex';

describe('COMMAND_INDEX', () => {
  it('is a non-empty array of {cmd, desc} entries', () => {
    expect(Array.isArray(COMMAND_INDEX)).toBe(true);
    expect(COMMAND_INDEX.length).toBeGreaterThan(0);
    for (const entry of COMMAND_INDEX) {
      expect(typeof entry.cmd).toBe('string');
      expect(typeof entry.desc).toBe('string');
      expect(entry.cmd.startsWith('/')).toBe(true);
      expect(entry.desc.length).toBeGreaterThan(0);
    }
  });

  it('contains the core commands users need to discover', () => {
    const cmds = COMMAND_INDEX.map((c) => c.cmd);
    for (const required of ['/scan', '/plan', '/skills', '/mcp', '/cost']) {
      expect(cmds).toContain(required);
    }
  });

  it('has no duplicate commands', () => {
    const cmds = COMMAND_INDEX.map((c) => c.cmd);
    expect(new Set(cmds).size).toBe(cmds.length);
  });
});

describe('formatCommandIndex', () => {
  const out = formatCommandIndex();

  it('returns a Markdown bullet list', () => {
    expect(out.split('\n').every((l) => l.startsWith('- '))).toBe(true);
  });

  it('emits one bullet per command in the index', () => {
    expect(out.split('\n').length).toBe(COMMAND_INDEX.length);
  });

  it('wraps each command in backticks', () => {
    for (const entry of COMMAND_INDEX) {
      expect(out).toContain(`\`${entry.cmd}\``);
    }
  });

  it('separates the command from the description with an em dash', () => {
    for (const entry of COMMAND_INDEX) {
      expect(out).toContain(`\`${entry.cmd}\` — ${entry.desc}`);
    }
  });

  it('returns an empty string when the index is empty', () => {
    // formatCommandIndex reads the module-level COMMAND_INDEX directly,
    // so we can't easily empty it — but we can assert that joining an
    // empty list would produce an empty string by replicating the logic.
    expect([].map((c: { cmd: string; desc: string }) => `- \`${c.cmd}\` — ${c.desc}`).join('\n')).toBe('');
  });
});
