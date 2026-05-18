/**
 * OpenRouter provider-routing preferences.
 *
 * OpenRouter lets the caller bias which upstream provider its router
 * picks for a given model — useful for cost, latency, geography, or
 * privacy reasons. The shape we send in the request body's `provider`
 * field follows the OpenRouter spec
 * (https://openrouter.ai/docs#provider-routing):
 *
 *   {
 *     "order":          ["DeepInfra", "Together"],   // try first in order
 *     "allow_fallbacks": true,                        // fall back to others if order fails
 *     "ignore":         ["OpenAI"],                   // never use these
 *     "data_collection": "deny" | "allow",            // privacy gate
 *     "require_parameters": true,                     // strict spec compliance
 *   }
 *
 * We store the user's preferences in `conf` so they persist across CLI
 * launches. Empty / unset means "let OpenRouter route freely".
 */

import { config } from '../config/index.js';

export interface OpenRouterPreferences {
  order?: string[];
  allow_fallbacks?: boolean;
  ignore?: string[];
  data_collection?: 'allow' | 'deny';
  require_parameters?: boolean;
}

/**
 * Return the user's stored preferences, or null if none set. Returning
 * null (vs empty object) lets `agentChat` omit the `provider` field
 * entirely — OpenRouter is happier with no field than with an empty one.
 */
export function readOpenRouterPreferences(): OpenRouterPreferences | null {
  const raw = config.get('openrouterPreferences');
  if (!raw || typeof raw !== 'object') return null;
  // Strip empty arrays — those would tell OpenRouter "use exactly nothing".
  const cleaned: OpenRouterPreferences = {};
  if (Array.isArray(raw.order) && raw.order.length > 0) cleaned.order = raw.order;
  if (Array.isArray(raw.ignore) && raw.ignore.length > 0) cleaned.ignore = raw.ignore;
  if (typeof raw.allow_fallbacks === 'boolean') cleaned.allow_fallbacks = raw.allow_fallbacks;
  if (raw.data_collection === 'allow' || raw.data_collection === 'deny') cleaned.data_collection = raw.data_collection;
  if (typeof raw.require_parameters === 'boolean') cleaned.require_parameters = raw.require_parameters;
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

export function writeOpenRouterPreferences(prefs: OpenRouterPreferences | null): void {
  if (!prefs) {
    // conf's typing wants a value of the right shape; `undefined` is a
    // valid clearing signal but doesn't match TS' strict optional.
    config.set('openrouterPreferences', undefined as unknown as OpenRouterPreferences);
    return;
  }
  config.set('openrouterPreferences', prefs);
}

/** Render preferences for `/openrouter` command output. */
export function formatOpenRouterPreferences(prefs: OpenRouterPreferences | null): string {
  if (!prefs) {
    return [
      '## OpenRouter preferences',
      '',
      '_No routing preferences set — OpenRouter picks freely._',
      '',
      'Tune routing with:',
      '- `/openrouter prefer <provider1>,<provider2>` — try these providers first (in order)',
      '- `/openrouter ignore <provider1>,<provider2>` — never route through these',
      '- `/openrouter fallbacks on|off` — allow fallback when preferred providers fail',
      '- `/openrouter privacy strict|allow` — strict = `data_collection: deny`',
      '- `/openrouter clear` — drop all preferences',
    ].join('\n');
  }
  const lines = ['## OpenRouter preferences', ''];
  if (prefs.order) lines.push(`- **Prefer**: ${prefs.order.map(p => `\`${p}\``).join(', ')}`);
  if (prefs.ignore) lines.push(`- **Ignore**: ${prefs.ignore.map(p => `\`${p}\``).join(', ')}`);
  if (typeof prefs.allow_fallbacks === 'boolean') lines.push(`- **Fallbacks**: ${prefs.allow_fallbacks ? 'allowed' : 'disabled'}`);
  if (prefs.data_collection) lines.push(`- **Data collection**: ${prefs.data_collection}`);
  if (prefs.require_parameters) lines.push(`- **Require parameters**: strict`);
  lines.push('', 'Clear with `/openrouter clear`.');
  return lines.join('\n');
}
