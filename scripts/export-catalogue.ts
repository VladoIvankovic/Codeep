#!/usr/bin/env node --import tsx
/**
 * Export the shipped model catalogue as JSON for codeep.dev.
 *
 * The site used to hand-maintain its own short list, which drifted the moment a
 * model was added here — it was showing 4 models against a catalogue of 70+.
 * This makes the CLI catalogue the single source of truth and the site a
 * renderer of it, so "what does Codeep support" can only ever be answered from
 * the code that actually answers it at runtime.
 *
 * Run it from the CLI repo root after any catalogue change (it is step 1 of the
 * checklist in docs/MODEL_MAINTENANCE.md):
 *
 *   npm run export:catalogue
 *
 * The output is committed to the web repo so the site still builds standalone —
 * codeep.dev must not need this repo present at build time.
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  PROVIDERS,
  isDynamicModelsProvider,
  isFlatFeeProvider,
  availableReasoningTiers,
} from '../src/config/providers';
import { getModelContextWindow, getPricingTable } from '../src/utils/tokenTracker';
import { VERSION } from '../src/version';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(repoRoot, 'Codeep-web', 'src', 'data', 'catalogue.json');

const priced = new Map(getPricingTable().map(p => [p.model, p]));

// 128k is the unknown-model fallback in getModelContextWindow, so a model that
// resolves to exactly that has no explicit entry. Say "not published" rather
// than printing a number nobody verified.
const FALLBACK_CONTEXT = 128_000;
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
          : { inputPer1M: rate.inputPer1M, outputPer1M: rate.outputPer1M },
        /** Thinking-effort levels the model distinguishes, minus 'auto'. */
        effortTiers: availableReasoningTiers(id, m.id).filter(t => t !== 'auto'),
      };
    }),
  };
});

const payload = {
  // Regenerate with `npm run export:catalogue` in the Codeep CLI repo.
  generatedBy: `codeep@${VERSION}`,
  providerCount: providers.length,
  modelCount: providers.reduce((n, p) => n + p.models.length, 0),
  providers,
};

if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(
  `Exported ${payload.modelCount} models across ${payload.providerCount} providers → ${outPath}`,
);
