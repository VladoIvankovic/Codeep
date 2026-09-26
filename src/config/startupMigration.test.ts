/**
 * The stored-model migration as it runs for real: at module load, against a
 * config file already on disk.
 *
 * It used to sit inside `migrationVersion < 4`, and every config written since
 * 2026-08-15 records 4 — so each RETIRED_MODEL_REPLACEMENTS entry added after
 * that reached new installs only, and a test of replacementModelFor() passed
 * throughout. Only loading the module over an existing config shows it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const originalDir = process.env.CODEEP_CONFIG_DIR;
const dirs: string[] = [];

afterEach(() => {
  process.env.CODEEP_CONFIG_DIR = originalDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** Load config/index.ts fresh over a config.json holding `stored`. */
async function loadWith(stored: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'codeep-migrate-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(stored));
  process.env.CODEEP_CONFIG_DIR = dir;
  vi.resetModules();
  return import('./index');
}

describe('stored model migration at startup', () => {
  it('rewrites a retired id in a config that already recorded migrationVersion 4', async () => {
    const { config } = await loadWith({ migrationVersion: 4, provider: 'qwen-token-plan', model: 'qwen3.8-max-preview' });
    expect(config.get('model')).toBe('qwen3.8-max');
    expect(config.get('provider')).toBe('qwen-token-plan');
  });

  it('applies the entries added after the gate closed', async () => {
    const cases: [string, string, string][] = [
      ['z.ai', 'glm-5.2', 'glm-5.3'],
      ['google', 'gemini-3-flash-preview', 'gemini-3.6-flash'],
      ['openai', 'gpt-5.5', 'gpt-5.6-sol'],
    ];
    for (const [provider, from, to] of cases) {
      const { config } = await loadWith({ migrationVersion: 4, provider, model: from });
      expect(config.get('model'), `${provider}/${from}`).toBe(to);
    }
  });

  // Alibaba names 3.7 Max for bare qwen3-max, but the Coding Plans do not list
  // it, so the plans land on 3.7 Plus and pay-per-use keeps the named model.
  it('moves bare qwen3-max to a model each Qwen surface accepts', async () => {
    const cases: [string, string][] = [
      ['qwen', 'qwen3.7-plus'],
      ['qwen-cn', 'qwen3.7-plus'],
      ['qwen-api', 'qwen3.7-max'],
      ['qwen-cn-api', 'qwen3.7-max'],
    ];
    for (const [provider, to] of cases) {
      const { config } = await loadWith({ migrationVersion: 4, provider, model: 'qwen3-max' });
      expect(config.get('model'), provider).toBe(to);
    }
  });

  // Codeep's own former fallback, which ModelScope no longer serves.
  it('moves a config still on the old ModelScope fallback', async () => {
    const { config } = await loadWith({ migrationVersion: 4, provider: 'modelscope', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' });
    expect(config.get('model')).toBe('Qwen/Qwen3.5-397B-A17B');
  });

  // GPT-6 Astra was moved to Sol here while Chat Completions was the only
  // transport. It is offered again (Responses API, 2026-09-26), and this runs
  // on every load: a leftover entry would undo the pick at every launch.
  it('leaves current, user-controlled and un-retired ids alone', async () => {
    const cases: [string, string][] = [
      ['openai', 'gpt-6-astra'],
      ['openai', 'gpt-6-sol'],
      ['openrouter', 'openai/gpt-6-astra'],
      ['deepseek', 'deepseek-v4-pro'],
      ['z.ai-api', 'glm-5.2'],
      ['anthropic', 'claude-opus-5'],
      ['modelscope', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'],
    ];
    for (const [provider, model] of cases) {
      const { config } = await loadWith({ migrationVersion: 4, provider, model });
      expect(config.get('model'), `${provider}/${model}`).toBe(model);
    }
  });
});
