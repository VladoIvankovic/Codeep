import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config/index.js', () => {
  const data: Record<string, unknown> = {};
  return {
    config: {
      get: (k: string) => data[k],
      set: (k: string, v: unknown) => { data[k] = v; },
    },
  };
});

import {
  loadAllPersonalities,
  findPersonality,
  getActivePersonalityPrompt,
  formatPersonalityList,
} from './personalities';
import { config } from '../config/index.js';

describe('personalities', () => {
  beforeEach(() => {
    config.set('activePersonality', null);
  });

  it('exposes six built-in personalities by default', () => {
    const all = loadAllPersonalities();
    const builtinNames = all.filter((p) => p.scope === 'builtin').map((p) => p.name).sort();
    expect(builtinNames).toEqual([
      'concise', 'junior-mentor', 'security', 'senior-reviewer', 'ship-it', 'verbose',
    ]);
  });

  it('findPersonality is case-insensitive', () => {
    expect(findPersonality('CONCISE')?.name).toBe('concise');
    expect(findPersonality('Ship-It')?.name).toBe('ship-it');
    expect(findPersonality('nonsense')).toBeNull();
  });

  it('returns the active personality prompt when set', () => {
    config.set('activePersonality', 'security');
    const prompt = getActivePersonalityPrompt();
    expect(prompt).toContain('Personality: Security-paranoid');
    expect(prompt).toContain('Treat every input as hostile');
  });

  it('returns empty string when no personality is active', () => {
    expect(getActivePersonalityPrompt()).toBe('');
  });

  it('returns empty string when active name does not match any personality', () => {
    config.set('activePersonality', 'phantom-name');
    expect(getActivePersonalityPrompt()).toBe('');
  });

  it('formatPersonalityList shows the active marker and clear hint', () => {
    config.set('activePersonality', 'verbose');
    const out = formatPersonalityList();
    expect(out).toContain('**Active:** `verbose`');
    expect(out).toContain('| `verbose` ✓ |');
    expect(out).toContain('Drop a `<name>.md` file');
  });

  it('formatPersonalityList notes when no personality is active', () => {
    const out = formatPersonalityList();
    expect(out).toMatch(/Active:.*none.*default tone/);
  });
});
