/**
 * `/recall` — cross-session search.
 *
 * Distinct from `/search`, which scans only the *current* session's
 * messages. `/recall` scans every saved session in the active scope
 * (project sessions under `<workspace>/.codeep/sessions/` when in a
 * project, else global `~/.codeep/sessions/`) and surfaces the ones
 * that match — ranked by how many query terms hit, boosted by recency.
 *
 * No FTS index / SQLite dependency: sessions are JSON files, and for
 * the realistic case (tens to low-hundreds of sessions) an in-memory
 * scan is fast and dependency-free. If a power user accumulates
 * thousands of sessions and this gets slow, the natural upgrade is a
 * cached FTS5 index — but that's premature today.
 */

import { listSessionsWithInfo, loadSession, type SessionInfo } from '../config/index.js';

export interface RecallMatch {
  session: SessionInfo;
  /** Composite relevance: term-hit count + recency boost. */
  score: number;
  /** Context snippet from the best-matching message. */
  snippet: string;
  /** How many messages in the session matched at least one term. */
  matchedMessages: number;
}

/**
 * Search saved sessions for the query. A session matches only if EVERY
 * query term appears somewhere in its non-system messages (AND
 * semantics — narrows results to genuinely relevant sessions rather
 * than any-term noise). Returns up to `limit` matches, best first.
 */
export function recallSessions(query: string, projectPath?: string, limit = 10): RecallMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const sessions = listSessionsWithInfo(projectPath);
  const matches: RecallMatch[] = [];

  for (const session of sessions) {
    const history = loadSession(session.name, projectPath);
    if (!history || history.length === 0) continue;

    let totalTermHits = 0;
    let matchedMessages = 0;
    let bestSnippet = '';
    let bestSnippetTermCount = 0;
    // Track which terms appear anywhere in the session (for AND gate).
    const termsSeen = new Set<string>();

    for (const msg of history) {
      if (msg.role === 'system') continue;
      const lower = msg.content.toLowerCase();
      const termsInMsg = terms.filter((t) => lower.includes(t));
      if (termsInMsg.length === 0) continue;

      matchedMessages++;
      totalTermHits += termsInMsg.length;
      for (const t of termsInMsg) termsSeen.add(t);

      // Pick the snippet from whichever message hits the most distinct terms.
      if (termsInMsg.length > bestSnippetTermCount) {
        bestSnippetTermCount = termsInMsg.length;
        bestSnippet = extractSnippet(msg.content, termsInMsg[0]);
      }
    }

    // AND gate: every query term must appear somewhere in the session.
    if (termsSeen.size < terms.length) continue;

    // Recency boost: sessions touched in the last ~10 days get up to +10,
    // tapering linearly. Keeps "what did I do recently" answers near the top
    // without drowning out an older session that's a much stronger text match.
    const ageDays = (Date.now() - new Date(session.createdAt).getTime()) / 86_400_000;
    const recencyBoost = Math.max(0, 10 - ageDays);
    const score = totalTermHits + recencyBoost;

    matches.push({ session, score, snippet: bestSnippet, matchedMessages });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Extract a one-line context window around the first match of `term`. */
function extractSnippet(content: string, term: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx === -1) return content.slice(0, 120).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + term.length + 80);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

function relativeAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * LLM-summarize what was accomplished across the matching sessions.
 * Loads each match's history, builds a compact multi-session transcript,
 * and asks the model for a short "here's what you did" paragraph. Used
 * by `/recall <query> --summarize`. Returns null on chat failure.
 */
export async function summarizeRecall(
  query: string,
  matches: RecallMatch[],
  projectPath?: string,
): Promise<string | null> {
  if (matches.length === 0) return null;

  // Build a transcript across the top matches, capped so the prompt
  // stays affordable even when many sessions match.
  const blocks: string[] = [];
  for (const m of matches.slice(0, 5)) {
    const history = loadSession(m.session.name, projectPath);
    if (!history) continue;
    const turns = history
      .filter((msg) => msg.role !== 'system')
      .slice(0, 8)
      .map((msg) => `${msg.role}: ${msg.content.replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');
    blocks.push(`### Session: ${m.session.name} (${relativeAge(m.session.createdAt)})\n${turns}`);
  }
  if (blocks.length === 0) return null;

  const system = `You are summarizing a developer's past work sessions that matched the search "${query}". Read the transcripts and write a SHORT recap (2-4 sentences) of what they actually accomplished across these sessions — concrete changes, decisions, and any unfinished threads. Use past tense. No preamble, no bullet headers, just the recap paragraph.`;

  try {
    const { chat } = await import('../api/index.js');
    const summary = await chat(blocks.join('\n\n'), [{ role: 'system', content: system }]);
    return summary.trim() || null;
  } catch {
    return null;
  }
}

/** Render recall results as a Markdown block for TUI / ACP display. */
export function formatRecall(query: string, matches: RecallMatch[]): string {
  if (matches.length === 0) {
    return `_No saved sessions match "${query}"._\n\nTip: \`/recall\` searches across all your sessions. For the current session only, use \`/search\`.`;
  }

  const lines: string[] = [
    `## Recall: "${query}"`,
    '',
    `${matches.length} session${matches.length === 1 ? '' : 's'} match${matches.length === 1 ? 'es' : ''}, best first:`,
    '',
  ];

  for (const m of matches) {
    const age = relativeAge(m.session.createdAt);
    const title = m.session.title && m.session.title !== m.session.name ? m.session.title : '';
    lines.push(`**${m.session.name}**${title ? ` — ${title}` : ''}`);
    lines.push(`_${age} · ${m.session.messageCount} messages · ${m.matchedMessages} matched_`);
    if (m.snippet) lines.push(`> ${m.snippet}`);
    lines.push('');
  }

  lines.push('Resume one with `/sessions` and pick it from the list.');
  return lines.join('\n').trim();
}
