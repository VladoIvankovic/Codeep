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
 *
 * The same pattern has a second effect. A model that has been shown dozens of
 * these turns sometimes writes one of its own where it means to call tools —
 * GLM-5.3 at max effort, on Z.AI, in about one run in twelve — and does it
 * again after being asked for the call or a summary. Nothing in such a reply
 * can be run, and asking again with the same turns in view gets the same
 * reply; withoutToolTurnPlaceholders is the history without them.
 */

import type { Message } from '../config/index';

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

/**
 * The history as a model that has started to write the placeholder should see
 * it: without the turns that only called tools, or only echoed one. The user
 * messages either side of each — the tool results, the nudge — are joined by a
 * blank line, so the roles still alternate and no message is empty, which
 * Anthropic's Messages API refuses. The calls themselves are not lost: the
 * placeholder named only the tools, and every result says which tool it came
 * from.
 *
 * A copy; the loop keeps its own history as it is. Messages it leaves alone
 * are the same objects, so a tag one carries (the Responses API's, which this
 * is not meant for) stays on it.
 */
export function withoutToolTurnPlaceholders(messages: readonly Message[]): Message[] {
  const kept: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && isToolTurnPlaceholder(message.content)) continue;
    const previous = kept[kept.length - 1];
    if (message.role === 'user' && previous?.role === 'user') {
      kept[kept.length - 1] = { role: 'user', content: `${previous.content}\n\n${message.content}` };
      continue;
    }
    kept.push(message);
  }
  return kept;
}
