/**
 * Auto-generated session titles.
 *
 * The default title is the first user message truncated to 60 chars —
 * which makes `/sessions` and `/recall` read like "help me fix the…",
 * "can you add a…". This module replaces that with an LLM one-liner
 * ("OAuth2 migration for auth module") generated once per session, in
 * the background, after the session has enough content to summarize.
 *
 * Design notes:
 *   - Fire-and-forget from saveSession. Never blocks a save.
 *   - One-shot: once `aiTitle` is written to the session file, the
 *     generator early-returns. An in-flight guard prevents concurrent
 *     duplicate calls during the 5s autosave cadence.
 *   - Uses the user's active model via chat() — a 4-8 word completion
 *     is negligible cost, and respecting the active model means it
 *     works for every provider without special-casing.
 */

import type { Message } from '../config/index.js';

const TITLE_SYSTEM_PROMPT = `You write concise titles for coding sessions. Given a transcript, reply with ONLY a 4-8 word title that captures the main task. No quotes. No trailing period. No preamble.

Good examples:
- OAuth2 migration for auth module
- Fix flaky payment integration tests
- Add dark mode to settings page
- Debug WebSocket reconnection loop

Reply with the title and nothing else.`;

/**
 * Generate a short title from a session's history, or null if there
 * isn't enough to summarize (fewer than 3 non-system messages) or the
 * LLM call fails. The caller persists the result.
 */
export async function generateSessionTitle(history: Message[]): Promise<string | null> {
  const turns = history.filter((m) => m.role !== 'system');
  if (turns.length < 3) return null;

  // Compact transcript: first 6 turns, each capped, so the prompt stays
  // cheap regardless of how long the session ran.
  const transcript = turns
    .slice(0, 6)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');

  try {
    const { chat } = await import('../api/index.js');
    const raw = await chat(transcript, [{ role: 'system', content: TITLE_SYSTEM_PROMPT }]);
    const cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, '') // strip wrapping quotes
      .replace(/[.\s]+$/, '')          // strip trailing period / whitespace
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    return cleaned.length > 70 ? cleaned.slice(0, 67) + '…' : cleaned;
  } catch {
    return null;
  }
}
