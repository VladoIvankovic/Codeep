import { describe, it, expect } from 'vitest';
import { buildCatalogue } from './catalogueExport';
import { PROVIDERS } from '../config/providers';

// `npm run export:catalogue` writes this object to codeep.dev's
// src/data/catalogue.json. The site's reader types `pricing` as
// { inputPer1M, outputPer1M } | null, so anything added has to be additive.
describe('buildCatalogue', () => {
  const catalogue = buildCatalogue();
  const model = (providerId: string, modelId: string) => {
    const found = catalogue.providers.find(p => p.id === providerId)!.models.find(m => m.id === modelId);
    expect(found, `${providerId}/${modelId}`).toBeDefined();
    return found!;
  };

  it('counts what PROVIDERS offers', () => {
    expect(catalogue.providerCount).toBe(Object.keys(PROVIDERS).length);
    expect(catalogue.modelCount).toBe(Object.values(PROVIDERS).reduce((n, p) => n + p.models.length, 0));
    expect(catalogue.generatedBy).toMatch(/^codeep@\d+\.\d+\.\d+/);
  });

  it('carries the long-prompt tier of Claude Haiku 5.5, beside the base rates', () => {
    const haiku = model('anthropic', 'claude-haiku-5-5');
    expect(haiku.name).toBe('Claude Haiku 5.5');
    expect(haiku.context).toBe(1_000_000);
    expect(haiku.pricing).toEqual({
      inputPer1M: 0.1,
      outputPer1M: 0.5,
      longPrompt: { overTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5 },
    });
    expect(haiku.effortTiers).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('adds the tier to no other model: every other price keeps exactly its two rates', () => {
    const withTier: string[] = [];
    for (const provider of catalogue.providers) {
      for (const m of provider.models) {
        if (m.pricing && 'longPrompt' in m.pricing) withTier.push(`${provider.id}/${m.id}`);
        if (m.pricing && !('longPrompt' in m.pricing)) {
          expect(Object.keys(m.pricing), `${provider.id}/${m.id}`).toEqual(['inputPer1M', 'outputPer1M']);
        }
      }
    }
    expect(withTier).toEqual(['anthropic/claude-haiku-5-5']);
    expect(model('anthropic', 'claude-haiku-4-5-20251001').pricing).toEqual({ inputPer1M: 1, outputPer1M: 5 });
    expect(model('anthropic', 'claude-sonnet-5-5').pricing).toEqual({ inputPer1M: 2, outputPer1M: 10 });
  });

  it('prices nothing on OpenRouter, where the call reports its own cost', () => {
    const haiku = model('openrouter', 'anthropic/claude-haiku-5.5');
    expect(haiku.pricing).toBeNull();
    expect(haiku.context).toBe(1_000_000);
  });

  it('survives the JSON round trip the site reads it through', () => {
    const roundTripped = JSON.parse(JSON.stringify(catalogue)) as typeof catalogue;
    const haiku = roundTripped.providers.find(p => p.id === 'anthropic')!.models.find(m => m.id === 'claude-haiku-5-5')!;
    expect(haiku.pricing).toMatchObject({ longPrompt: { overTokens: 100_000 } });
  });
});
