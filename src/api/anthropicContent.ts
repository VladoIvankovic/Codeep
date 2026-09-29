/**
 * Reading an Anthropic Messages response: its text, and whether it was refused.
 *
 * Kept free of imports so every Anthropic call site (chat, agent, planner) can
 * share it, including under tests that mock providers or tokenTracker wholesale.
 */

/**
 * The reply's text: every `text` block, in order, and nothing else.
 *
 * "A response can begin with `thinking` blocks, so code that reads
 * `content[0].text` breaks" (Anthropic, Migrating to Claude Sonnet 5.5). Opus 5.5
 * and Sonnet 5/5.5 all think by default, so `content[0]` is often a thinking
 * block whose text is empty at the default `display: "omitted"`, and a reader
 * of the first block returned "" for a reply that had one.
 */
export function anthropicText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * The line to show when Claude declined the request, or null when it did not.
 *
 * A decline is HTTP 200 with `stop_reason: "refusal"` and a `stop_details`
 * naming the policy area ("cyber", "bio", "frontier_llm",
 * "reasoning_extraction", "general_harms" on Sonnet 5.5 — What's new in Claude
 * Sonnet 5.5). `content` is empty when it declines before any output, so
 * without this the user saw a blank reply, and in agent mode the empty turn
 * read as an unfinished one and was sent again. Branch on `stop_reason` only:
 * `stop_details` is informational and can be null, as can its `category`.
 */
export function anthropicRefusalNotice(stopReason: unknown, stopDetails: unknown): string | null {
  if (stopReason !== 'refusal') return null;
  const category = stopDetails && typeof stopDetails === 'object'
    ? (stopDetails as { category?: unknown }).category
    : undefined;
  return typeof category === 'string' && category
    ? `Claude declined this request (category: ${category}).`
    : 'Claude declined this request.';
}

// Exactly the two lines anthropicRefusalNotice produces, nothing around them.
const REFUSAL_NOTICE = /^Claude declined this request(?: \(category: [^()\n]+\))?\.$/;

/**
 * Whether a reply is the decline notice rather than an answer.
 *
 * On a decline chat() returns the notice alone (any partial text is dropped),
 * which is right where a person reads the reply. Callers that use the reply as
 * data — a summary to cache or splice in, a title, a plan, a skill's `${_prev}`,
 * an MCP server's sampling result — must not take the notice for one: before
 * it existed a pre-output decline came back as "", which each of them already
 * handled as a failure. They check this and fail the same way.
 */
export function isAnthropicRefusalNotice(text: unknown): boolean {
  return typeof text === 'string' && REFUSAL_NOTICE.test(text.trim());
}
