import type { TelegramCredentials } from './telegramApproval';

/**
 * Telling you the run is done, on the phone that already answers its questions.
 *
 * Separate from TelegramApproval on purpose: that class exists to ask a
 * question and wait for one of three answers, and none of its machinery — the
 * keyboard, the token, the outstanding-message bookkeeping — means anything
 * for a message nobody replies to.
 */

const API = 'https://api.telegram.org/bot';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Runs shorter than this are not worth a notification.
 *
 * The problem this solves is walking away — starting something substantial,
 * making coffee, and not knowing it finished. A `git status` that returned in
 * two seconds was never going to outlast your attention, and a phone that
 * buzzes for every one of those gets muted within a day, taking the
 * notifications that mattered with it.
 */
export const NOTIFY_AFTER_MS = 60_000;

export function shouldNotify(elapsedMs: number, enabled: boolean): boolean {
  return enabled && elapsedMs >= NOTIFY_AFTER_MS;
}

/** `92s` / `4m 12s` / `1h 03m` — short enough to read on a lock screen. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Telegram refuses a message over 4096 characters outright.
 *
 * Kept well under, because the summary head shares the first message.
 */
export const MAX_ANSWER_LENGTH = 3000;

/**
 * How many messages one answer may become.
 *
 * A long answer is worth several; an enormous one is not worth a phone buzzing
 * eleven times, and past a point nobody is reading it there anyway. Three is
 * enough for an explanation and short of a flood.
 */
export const MAX_ANSWER_PARTS = 3;

/**
 * An answer as the messages to send, in order.
 *
 * Cutting at the limit was honest — it said it had cut — but lossy in the place
 * it hurts: an answer that lists files or walks through a change passes 3000
 * characters easily, and the conclusion is at the end. So it is split instead,
 * on a paragraph or line boundary where there is one nearby, and only what
 * exceeds three messages is cut.
 *
 * Mirrors the Mac app's `TelegramAnswerText.partsForPhone` deliberately: two
 * implementations of "what does the phone get" that can disagree is worse than
 * either.
 */
export function splitAnswer(text: string): string[] {
  const plain = text.trim();
  if (!plain) return [];

  const parts: string[] = [];
  let rest = plain;

  while (rest.length > 0 && parts.length < MAX_ANSWER_PARTS) {
    if (rest.length <= MAX_ANSWER_LENGTH) {
      parts.push(rest);
      rest = '';
      break;
    }
    const cut = breakPoint(rest);
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).replace(/^[\n ]+/, '');
  }

  // Say it was cut rather than ending mid-sentence and looking finished.
  if (rest.length > 0 && parts.length > 0) {
    parts[parts.length - 1] += '\n\n[…cut — the full answer is in the terminal]';
  }
  return parts;
}

/**
 * Where to end a part: the last paragraph break in the final third of the
 * allowance, else the last line break, else the last space.
 *
 * Splitting mid-word reads as damage; splitting mid-paragraph reads as a
 * continuation. Only the tail is searched so a single long paragraph does not
 * send a 200-character message and push the rest into the next one.
 */
function breakPoint(text: string): number {
  const earliest = Math.floor((MAX_ANSWER_LENGTH * 2) / 3);
  const window = text.slice(earliest, MAX_ANSWER_LENGTH);

  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph >= 0) return earliest + paragraph;
  const line = window.lastIndexOf('\n');
  if (line >= 0) return earliest + line;
  const space = window.lastIndexOf(' ');
  if (space >= 0) return earliest + space;
  return MAX_ANSWER_LENGTH;
}

/**
 * Markdown out, plain words in.
 *
 * The agent writes for a terminal that renders markdown, so its answer arrives
 * on a phone as `**140 datoteka**` — asterisks and backticks read as noise
 * exactly where the answer should be easiest to read.
 *
 * Stripped rather than handed to Telegram as `parse_mode`, which would be the
 * obvious fix and the wrong one: Telegram rejects a whole message whose markup
 * is unbalanced, and an agent's answer is arbitrary text. One stray asterisk
 * and the notice does not arrive at all. Ugly beats missing, and this is
 * neither.
 *
 * Deliberately conservative. Only paired markers are touched, and single
 * underscores are left alone entirely — `execute_command` and `snake_case`
 * appear in these answers constantly, and mangling an identifier to italicise
 * nothing is worse than leaving a marker visible.
 */
export function stripMarkdown(text: string): string {
  return text
    // Fenced blocks: keep the code, drop the fence and any language tag.
    .replace(/```[a-zA-Z0-9-]*\n?([\s\S]*?)```/g, '$1')
    // Headings, which a phone shows as literal hashes.
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Single backticks only — a lone one is left alone rather than eating the
    // rest of the answer looking for a partner.
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}

export interface RunSummary {
  /** What the run was called — the session display name, not the full prompt. */
  task: string;
  elapsedMs: number;
  /** Set when the run ended on an error, so the message can say so. */
  failure?: string;
  tokens?: number;
  /** Pay-per-use dollars. Omitted on a flat-fee plan, where any figure is invented. */
  costUsd?: number;
  /**
   * The agent's own reply, for a run that was started from the phone.
   *
   * Omitted for a run started at the terminal, where the answer is already on
   * the screen the person is sitting at and sending it would put file contents
   * or a command line into a chat for nothing.
   */
  answer?: string;
}

/** The head: what ran, how long it took, what it cost. Never the answer. */
function composeHead(summary: RunSummary): string {
  const head = summary.failure ? '⚠️ Codeep stopped' : '✅ Codeep finished';
  const lines = [`${head} — ${summary.task}`, `took ${formatDuration(summary.elapsedMs)}`];

  if (summary.failure) lines.push(summary.failure);

  const cost: string[] = [];
  if (typeof summary.tokens === 'number' && summary.tokens > 0) {
    cost.push(`${Math.round(summary.tokens / 1000)}K tokens`);
  }
  if (typeof summary.costUsd === 'number' && summary.costUsd > 0) {
    cost.push(`$${summary.costUsd.toFixed(summary.costUsd < 0.01 ? 4 : 2)}`);
  }
  if (cost.length > 0) lines.push(cost.join(' · '));

  return lines.join('\n');
}

/**
 * The notification, as the messages to send in order.
 *
 * One message when the answer fits, which is the common case. A longer answer
 * continues into further messages rather than being cut at the first limit —
 * see `splitAnswer`. The head shares the first message, so the reply is not a
 * bare wall of text with no idea which run it belongs to.
 *
 * Carries the agent's answer only when the run was started from the phone. A
 * finished run can end with anything in it — a file it read, a command it ran,
 * a secret inside an error — and this goes to a chat that syncs to Telegram's
 * servers, so it travels only where it was actually asked for. Start a run at
 * the terminal and this says there is a result to come back to, and no more.
 */
export function composeRunMessages(summary: RunSummary): string[] {
  const head = composeHead(summary);
  const parts = summary.answer ? splitAnswer(stripMarkdown(summary.answer)) : [];
  if (parts.length === 0) return [head];
  return [`${head}\n\n${parts[0]}`, ...parts.slice(1)];
}

/**
 * Send it, and say nothing if it fails.
 *
 * A notification that could not be delivered is not worth interrupting the
 * terminal for — the run already finished and its result is on screen. Returns
 * whether it went, so a caller that does care can look.
 */
export async function sendTelegramNotice(
  credentials: TelegramCredentials,
  text: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${API}${credentials.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: credentials.chatID,
        text,
        // No parse_mode: a task name is arbitrary user text and Telegram
        // rejects the whole message on unbalanced Markdown, which would turn a
        // stray underscore in a branch name into a silently dropped notice.
        disable_notification: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
