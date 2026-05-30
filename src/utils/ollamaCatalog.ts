/**
 * Curated catalog of recommended local coding models for Ollama, surfaced via
 * `/model browse`. Mirrors the MCP catalog pattern: a hand-picked shortlist so
 * users don't have to hunt ollama.com for good coding models.
 *
 * Each entry's `pull` is the exact `ollama pull` tag. `params` is the parameter
 * count (drives the agent-mode hint — <7B models struggle with tool-calling
 * loops). `vram` is a rough "comfortable" requirement for the default quant.
 *
 * Curated, not exhaustive — users can still `/model pull <anything>`.
 */

export interface OllamaCatalogEntry {
  /** Exact `ollama pull` tag, e.g. "qwen2.5-coder:7b". */
  pull: string;
  /** Display name. */
  name: string;
  /** Parameter count in billions (for the agent-mode hint). */
  params: number;
  /** Rough comfortable RAM/VRAM for the default quantization. */
  vram: string;
  /** One-line description. */
  description: string;
}

/**
 * Recommended coding models. Ordered roughly best-for-agent first within size
 * tiers. All are real Ollama library tags as of this release.
 */
export const OLLAMA_CODING_MODELS: OllamaCatalogEntry[] = [
  // ── Coding-tuned, agent-capable ──────────────────────────────────────────
  { pull: 'qwen2.5-coder:32b', name: 'Qwen2.5 Coder 32B', params: 32, vram: '~20 GB', description: 'Top open coding model — strong at tool use and multi-file edits' },
  { pull: 'qwen2.5-coder:14b', name: 'Qwen2.5 Coder 14B', params: 14, vram: '~9 GB',  description: 'Great balance of quality and speed for agent work' },
  { pull: 'qwen2.5-coder:7b',  name: 'Qwen2.5 Coder 7B',  params: 7,  vram: '~5 GB',  description: 'Smallest Qwen Coder that still handles agent mode' },
  { pull: 'deepseek-coder-v2:16b', name: 'DeepSeek Coder V2 16B', params: 16, vram: '~10 GB', description: 'MoE coding model — fast for its quality' },

  // ── General-purpose, agent-capable ───────────────────────────────────────
  { pull: 'llama3.1:8b',  name: 'Llama 3.1 8B',  params: 8,  vram: '~5 GB',  description: 'Solid all-rounder; reliable tool-calling for its size' },
  { pull: 'llama3.1:70b', name: 'Llama 3.1 70B', params: 70, vram: '~40 GB', description: 'Large general model — strongest reasoning if you have the VRAM' },
  { pull: 'mistral-nemo:12b', name: 'Mistral Nemo 12B', params: 12, vram: '~8 GB', description: '128K context general model, good instruction following' },
  { pull: 'gemma2:9b',  name: 'Gemma 2 9B',  params: 9,  vram: '~6 GB',  description: 'Google open model — capable general assistant' },

  // ── Reasoning ────────────────────────────────────────────────────────────
  { pull: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', params: 14, vram: '~9 GB', description: 'Reasoning model — thinks before answering; good for hard bugs' },
  { pull: 'deepseek-r1:8b',  name: 'DeepSeek R1 8B',  params: 8,  vram: '~5 GB', description: 'Smaller reasoning model for modest hardware' },

  // ── Small / fast (chat-first; weaker at agent loops) ─────────────────────
  { pull: 'qwen2.5-coder:3b', name: 'Qwen2.5 Coder 3B', params: 3, vram: '~3 GB', description: 'Fast inline completions / chat; light for full agent tasks' },
  { pull: 'llama3.2:3b',      name: 'Llama 3.2 3B',     params: 3, vram: '~3 GB', description: 'Tiny + fast; great for quick chat on low-end machines' },
];

/** Agent-mode suitability hint for a catalog entry (≥7B → agent-capable). */
export function catalogAgentHint(params: number): string {
  return params >= 7 ? '✓ agent mode' : '⚠ chat / completions (small)';
}
