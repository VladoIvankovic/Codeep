#!/usr/bin/env node --import tsx
/**
 * Export the shipped model catalogue as JSON for codeep.dev.
 *
 * The site used to hand-maintain its own short list, which drifted the moment a
 * model was added here — it was showing 4 models against a catalogue of 70+.
 * This makes the CLI catalogue the single source of truth and the site a
 * renderer of it, so "what does Codeep support" can only ever be answered from
 * the code that actually answers it at runtime. The catalogue itself is built
 * in src/utils/catalogueExport.ts; this only writes it.
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
import { buildCatalogue } from '../src/utils/catalogueExport';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(repoRoot, 'Codeep-web', 'src', 'data', 'catalogue.json');

const payload = buildCatalogue();

if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(
  `Exported ${payload.modelCount} models across ${payload.providerCount} providers → ${outPath}`,
);
