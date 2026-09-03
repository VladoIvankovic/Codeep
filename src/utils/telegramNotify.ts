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
 * Kept well under: the rest of the summary shares the message, and a reply
 * that fills a phone screen twice over is not read on a phone anyway.
 */
export const MAX_ANSWER_LENGTH = 3000;

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

/**
 * The notification text.
 *
 * Carries the agent's answer only when the run was started from the phone. A
 * finished run can end with anything in it — a file it read, a command it ran,
 * a secret inside an error — and this goes to a chat that syncs to Telegram's
 * servers, so it travels only where it was actually asked for. Start a run at
 * the terminal and this says there is a result to come back to, and no more.
 */
export function composeRunSummary(summary: RunSummary): string {
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

  const answer = summary.answer?.trim();
  if (answer) {
    lines.push('');
    lines.push(answer.length > MAX_ANSWER_LENGTH
      // Say it was cut rather than ending mid-sentence and looking finished.
      ? `${answer.slice(0, MAX_ANSWER_LENGTH)}\n\n[…cut — the full answer is in the terminal]`
      : answer);
  }

  return lines.join('\n');
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
