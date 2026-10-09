/**
 * The shipped model catalogue as the JSON codeep.dev renders.
 *
 * The site used to hand-maintain its own short list, which drifted the moment a
 * model was added here — it was showing 4 models against a catalogue of 70+.
 * This builds the catalogue straight from `PROVIDERS`, the context table and the
 * pricing table, so "what does Codeep support" can only ever be answered from
 * the code that actually answers it at runtime. `scripts/export-catalogue.ts`
 * writes it to the web repo (`npm run export:catalogue`); it lives here, and not
 * in the script, so a test can read the output without writing a file.
 */
import {
  PROVIDERS,
  isDynamicModelsProvider,
  isFlatFeeProvider,
  availableReasoningTiers,
} from '../config/providers';
import { getModelContextWindow, getPricingTable } from './tokenTracker';
import { VERSION } from '../version';

// 128k is the unknown-model fallback in getModelContextWindow, so a model that
// resolves to exactly that has no explicit entry. Say "not published" rather
// than printing a number nobody verified.
const FALLBACK_CONTEXT = 128_000;

export function buildCatalogue() {
  const priced = new Map(getPricingTable().map(p => [p.model, p]));

  const explicitContext = (id: string): number | null => {
    const n = getModelContextWindow(id);
    return n === FALLBACK_CONTEXT ? null : n;
  };

  const providers = Object.entries(PROVIDERS).map(([id, p]) => {
    const flatFee = isFlatFeeProvider(id);
    return {
      id,
      name: p.name,
      description: p.description,
      groupLabel: p.groupLabel ?? null,
      hint: p.hint ?? null,
      /** Billed as a flat subscription (or free) — no per-token price is shown. */
      flatFee,
      /** Catalogue is fetched at runtime; the models below are only a fallback. */
      dynamic: isDynamicModelsProvider(id),
      defaultModel: p.defaultModel,
      models: p.models.map(m => {
        const rate = priced.get(m.id);
        return {
          id: m.id,
          name: m.name,
          description: m.description,
          context: explicitContext(m.id),
          // A price is emitted only when the provider publishes a per-token rate
          // AND the account is actually metered. Rule 5 of the catalogue policy:
          // never invent one.
          pricing: flatFee || !rate
            ? null
            : {
                inputPer1M: rate.inputPer1M,
                outputPer1M: rate.outputPer1M,
                // Only on a model priced by prompt length (Claude Haiku 5.5):
                // a request whose prompt is over `overTokens` pays these for
                // every token of it. Left out everywhere else, so every other
                // model's entry is exactly what it was before the tier existed
                // and a reader that does not know the key never sees it.
                ...(rate.longPrompt ? { longPrompt: { ...rate.longPrompt } } : {}),
              },
          /** Thinking-effort levels the model distinguishes, minus 'auto'. */
          effortTiers: availableReasoningTiers(id, m.id).filter(t => t !== 'auto'),
        };
      }),
    };
  });

  return {
    // Regenerate with `npm run export:catalogue` in the Codeep CLI repo.
    generatedBy: `codeep@${VERSION}`,
    providerCount: providers.length,
    modelCount: providers.reduce((n, p) => n + p.models.length, 0),
    providers,
  };
}
