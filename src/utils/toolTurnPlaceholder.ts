/**
 * The text a turn that only called tools is kept as in the history the agent
 * loop sends back, and how to tell it — and a reply made of nothing else —
 * from an answer.
 *
 * The loop flattens its history to text, and such a turn has none, so it is
 * kept under a placeholder (agent.ts, assistantHistoryText, says why it must
 * not be empty). The placeholder was "Using write_file." — a sentence an
 * answer could be. After twenty-odd tool turns a model took the pattern up and
 * wrote that line as its last message, with no tool call, so the loop took it
 * for the answer: a 26-step run that wrote twenty files ended on "Using
 * write_file.", and its auto-review on "Using read_file.". Bracketed, it is
 * never a natural answer, and a reply made only of it can be caught.
 */

/** A turn with neither text nor a tool call. */
export const NO_REPLY = '(no reply)';

/** The placeholder for a turn that called these tools, each named once, as
 *  the model called it. */
export function toolTurnPlaceholder(toolCalls: ReadonlyArray<{ tool: string }>): string {
  return `[tool call: ${[...new Set(toolCalls.map(t => t.tool))].join(', ')}]`;
}

const PLACEHOLDER_LINE = /^\[tool call: [^[\]\n]+\]$/;

/**
 * Whether a text is only placeholders — every line that is not blank is
 * toolTurnPlaceholder's or NO_REPLY, ignoring the space around it. A model
 * that echoes them writes one or several. Case-sensitive and bracketed, so
 * "Using Redis." — an answer — is not one.
 */
export function isToolTurnPlaceholder(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line => line === NO_REPLY || PLACEHOLDER_LINE.test(line));
}

/** A final reply that says nothing: empty, or placeholders only. */
export function isNotAnAnswer(reply: string): boolean {
  return reply.trim() === '' || isToolTurnPlaceholder(reply);
}

/** A reply without its placeholder lines — an echo above a real answer
 *  ("[tool call: write_file]" then "Done: …") must not travel with it into
 *  the chat, the editor or progress.md. '' when nothing else was there. */
export function withoutPlaceholderLines(reply: string): string {
  return reply
    .split('\n')
    .filter(line => !isToolTurnPlaceholder(line))
    .join('\n')
    .trim();
}
