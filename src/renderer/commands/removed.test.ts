/**
 * The list of slash commands Codeep 4.0 removed, and the sentence each one gets.
 * The names are written out here a second time on purpose: the table in
 * removed.ts is the thing under test, so it cannot also be the oracle.
 */

import { describe, it, expect } from 'vitest';
import { REMOVED_COMMANDS, REMOVED_ALIASES, removedCommandMessage } from './removed';
import { ALL_COMMAND_NAMES, COMMANDS } from './registry';

/** The 62 commands of the 4.0 cut (SPEC "UKLONITI", minus agent-dry, hooks and lang, which the review put back), by hand. */
const SPEC_REMOVED = `
add amend api api-docs apply branch build changelog ci cleanup commands component context-clear
context-load context-save copy cost coverage crud debug deploy docker drop e2e env explain fix form git-commit
hook insights k8s log migrate mock modernize monitor nginx optimize page paste pr profile publish
pull push readme refactor release search security service split stash stats terraform test test-fix translate
types unstash web-cache
`.split(/\s+/).filter(Boolean);

/** The 59 commands the cut keeps (SPEC "ZADRZATI" plus agent-dry, hooks and lang), by hand. */
const SPEC_KEPT = `
account agent agent-dry agents audit changes checkpoint checkpoints clear cloud commit compact diff docs exit export go grant
help history hooks init keysync lang learn login logout mcp me memory model multiline new openrouter personality plan protocol
provider recall rename review rewind scan sessions settings skill skills status stop sync tasks telegram telemetry
thinking undo undo-all update usage version
`.split(/\s+/).filter(Boolean);

/** Shortcuts the removed commands owned in 3.x. */
const SPEC_REMOVED_ALIASES: Record<string, string> = {
  p: 'push', t: 'test', r: 'refactor', f: 'fix', e: 'explain', o: 'optimize', b: 'debug', webcache: 'web-cache',
};

describe('the removed-commands table', () => {
  it('is exactly the 62 commands of the 4.0 cut', () => {
    expect(SPEC_REMOVED).toHaveLength(62);
    expect(new Set(SPEC_REMOVED).size).toBe(62);
    expect([...REMOVED_COMMANDS].sort()).toEqual([...SPEC_REMOVED].sort());
  });

  it('names the shortcuts that went with them, and what each pointed at', () => {
    expect(REMOVED_ALIASES).toEqual(SPEC_REMOVED_ALIASES);
    for (const target of Object.values(REMOVED_ALIASES)) expect(REMOVED_COMMANDS).toContain(target);
  });

  it('shares no name with a registered command or alias', () => {
    const shared = [...REMOVED_COMMANDS, ...Object.keys(REMOVED_ALIASES)].filter(n => ALL_COMMAND_NAMES.has(n));
    expect(shared, `registered AND listed as removed: ${shared.join(', ')}`).toEqual([]);
  });

  it('plus the registry covers the 121 commands 3.x had', () => {
    expect(COMMANDS.length + REMOVED_COMMANDS.length).toBe(121);
  });

  it('leaves the registry with exactly the 59 commands of the 4.0 cut, and the aliases of those', () => {
    expect(SPEC_KEPT).toHaveLength(59);
    expect(COMMANDS.map(c => c.name).sort()).toEqual([...SPEC_KEPT].sort());
    expect([...ALL_COMMAND_NAMES].filter(t => !SPEC_KEPT.includes(t)).sort()).toEqual(['apikey', 'c', 'd', 'effort', 'session']);
  });
});

describe('removedCommandMessage', () => {
  it('answers every removed name with one sentence that names it and says 4.0', () => {
    for (const name of REMOVED_COMMANDS) {
      const message = removedCommandMessage(name);
      expect(message, `/${name}`).not.toBeNull();
      expect(message, `/${name}`).toContain(`/${name}`);
      expect(message, `/${name}`).toMatch(/Codeep 4\.0/);
      expect(message, `/${name}`).not.toMatch(/Unknown command/i);
      expect(message, `/${name}`).not.toContain('\n');
    }
  });

  it('answers a removed shortcut, and says which command it was a shortcut for', () => {
    for (const [alias, target] of Object.entries(REMOVED_ALIASES)) {
      const message = removedCommandMessage(alias)!;
      expect(message, `/${alias}`).toContain(`/${alias} was removed in Codeep 4.0`);
      expect(message, `/${alias}`).toContain(`/${target}`);
    }
  });

  it('points /cost and /stats at /usage, and /search at /recall', () => {
    expect(removedCommandMessage('cost')).toMatch(/merged into \/usage/);
    expect(removedCommandMessage('stats')).toMatch(/\/usage --detail/);
    expect(removedCommandMessage('search')).toMatch(/\/recall/);
  });

  it('leaves a typo, a registered command and an empty name alone', () => {
    for (const token of ['psuh', 'pus', 'pushh', 'notacommand', 'tset', '', 'agent', 'commit', 'usage', 'c']) {
      expect(removedCommandMessage(token), `/${token}`).toBeNull();
    }
  });

  it('is not fooled by the names every object has', () => {
    for (const token of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(removedCommandMessage(token), token).toBeNull();
    }
  });
});
