/**
 * Did the model stop in the middle of its turn?
 *
 * A model sometimes announces the work and then yields without calling a
 * tool ("I'll create everything now", "Let me look at the files:"). The agent
 * loop answers that with a nudge to go on. Nudging a model that HAS answered
 * is worse than missing a stall: the nudge says "Execute the tool calls now",
 * a model with nothing to execute replies with a confused recap, and that
 * recap replaces the answer the user asked for ("ready" became "There are no
 * pending tool calls…").
 *
 * Structural signals only — no keyword lists. Lists of "let me" / "sada ću"
 * phrases were tried and dropped (commit e79c546): they cover a handful of
 * languages and miss every other one. What is left works on any language that
 * puts spaces between words:
 *
 *  - an empty reply: nothing was said, so nothing can be the answer;
 *  - a reply that ends with ':' — it introduces something that never came;
 *  - a short sentence that stops without punctuation, when it is prose: at
 *    least four words, the last line starting and the last word made of
 *    letters. An announcement is a sentence; an answer this short with no
 *    full stop is usually a value — a word, a number, a name, a path, a
 *    command — and those are never nudged.
 *
 * The Mac app nudges only on the trailing ':' (Agent.looksLikeIncompleteLeadIn).
 * The CLI keeps the short-sentence rule as well because the stalls it was
 * written for came without one ("Let me check the files", "I'll create
 * everything now"), which is what the old keyword lists matched.
 */

/** Below this length a reply without a full stop may be a fragment. */
export const FRAGMENT_MAX_CHARS = 120;

/** Fewer words than this is an answer (a word, a value, a short phrase). */
export const FRAGMENT_MIN_WORDS = 4;

/** Characters a finished sentence, quote or code span can end on. */
const PROPER_ENDINGS = new Set(['.', '!', '?', '"', '\'', '`', ')']);

/** A word made of letters, in any script, with inner ' or - (don't, follow-up). */
const PLAIN_WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;

export function looksUnfinished(reply: string): boolean {
  const text = reply.trim();
  if (text === '') return true;
  if (text.endsWith(':')) return true;
  if (text.length >= FRAGMENT_MAX_CHARS) return false;
  if (PROPER_ENDINGS.has(text.slice(-1))) return false;

  const lastLine = text.slice(text.lastIndexOf('\n') + 1).trim();
  const words = lastLine.split(/\s+/);
  // "Let me check the files…" trails off into the work it announces, the way
  // a colon does; a one-word "Maybe…" is an answer. (Three dots end in "."
  // and read as a full stop, as before.)
  if (text.endsWith('…') && words.length >= 2) return true;
  if (words.length < FRAGMENT_MIN_WORDS) return false;
  // A list item, a heading, a quote or code starts with a marker, not a word.
  if (!/^\p{L}/u.test(lastLine)) return false;
  // "The answer is 42", "It is in src/utils/agent.ts", "npm run build --watch":
  // the sentence ends on a value, which is what was asked for.
  return PLAIN_WORD.test(words[words.length - 1]);
}
