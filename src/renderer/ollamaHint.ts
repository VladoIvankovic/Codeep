/**
 * Ollama model-size hint.
 *
 * Extracted from `commands.ts` so the size threshold + label rule can be
 * unit-tested. Maps a model id like `qwen3:14b` to a UI hint telling the
 * user whether the model is agent-capable (≥ 7B params) or chat-only.
 */
const AGENT_MIN_PARAMS_B = 7;

/**
 * Return a UI hint for an Ollama model id, based on its parameter count.
 *
 * Examples:
 *   - `7b`, `8b`, `14b`, `72b` → `'✓ agent mode'`
 *   - `1.5b`, `3b`            → `'⚠ chat only (< 7B)'`
 *   - `custom-name` (no size) → `''` (no hint)
 *
 * The parameter count is parsed from the first `<number>b` token in the
 * id (case-insensitive), so both `qwen3:14b` and `llama2-13b` work.
 */
export function ollamaModelHint(modelId: string): string {
  const lower = modelId.toLowerCase();
  const match = lower.match(/(\d+(?:\.\d+)?)b/);
  if (!match) return '';
  const params = parseFloat(match[1]);
  if (params >= AGENT_MIN_PARAMS_B) return '✓ agent mode';
  return '⚠ chat only (< 7B)';
}
