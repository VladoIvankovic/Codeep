import { describe, it, expect } from 'vitest';
import {
  OLLAMA_CODING_MODELS,
  catalogAgentHint,
} from './ollamaCatalog';

describe('OLLAMA_CODING_MODELS', () => {
  it('is a non-empty curated catalog', () => {
    expect(OLLAMA_CODING_MODELS.length).toBeGreaterThan(5);
  });

  it('every entry has all required fields populated', () => {
    for (const m of OLLAMA_CODING_MODELS) {
      expect(typeof m.pull).toBe('string');
      expect(m.pull.length).toBeGreaterThan(0);
      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.params).toBe('number');
      expect(m.params).toBeGreaterThan(0);
      expect(typeof m.vram).toBe('string');
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  it('every pull tag follows the ollama name:tag format', () => {
    for (const m of OLLAMA_CODING_MODELS) {
      expect(m.pull).toMatch(/^[a-z0-9.-]+:[a-z0-9.+]+$/);
    }
  });

  it('has no duplicate pull tags', () => {
    const pulls = OLLAMA_CODING_MODELS.map((m) => m.pull);
    expect(new Set(pulls).size).toBe(pulls.length);
  });

  it('includes at least one qwen2.5-coder and one llama entry', () => {
    const pulls = OLLAMA_CODING_MODELS.map((m) => m.pull);
    expect(pulls.some((p) => p.startsWith('qwen2.5-coder'))).toBe(true);
    expect(pulls.some((p) => p.startsWith('llama'))).toBe(true);
  });

  it('includes models below and above the 7B agent threshold', () => {
    const small = OLLAMA_CODING_MODELS.filter((m) => m.params < 7);
    const large = OLLAMA_CODING_MODELS.filter((m) => m.params >= 7);
    expect(small.length).toBeGreaterThan(0);
    expect(large.length).toBeGreaterThan(0);
  });
});

describe('catalogAgentHint', () => {
  it('returns the agent-mode hint for params >= 7', () => {
    expect(catalogAgentHint(7)).toBe('✓ agent mode');
    expect(catalogAgentHint(14)).toBe('✓ agent mode');
    expect(catalogAgentHint(70)).toBe('✓ agent mode');
  });

  it('returns the chat-only warning for params < 7', () => {
    expect(catalogAgentHint(3)).toBe('⚠ chat / completions (small)');
    expect(catalogAgentHint(1)).toBe('⚠ chat / completions (small)');
  });

  it('is consistent with the catalog entries', () => {
    for (const m of OLLAMA_CODING_MODELS) {
      const hint = catalogAgentHint(m.params);
      if (m.params >= 7) expect(hint).toContain('agent');
      else expect(hint).toContain('chat');
    }
  });

  it('handles the boundary at exactly 7B', () => {
    expect(catalogAgentHint(7)).toContain('agent');
    expect(catalogAgentHint(6)).toContain('chat');
  });
});
