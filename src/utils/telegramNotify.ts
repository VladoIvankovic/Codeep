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

export interface RunSummary {
  /** What the run was called — the session display name, not the full prompt. */
  task: string;
  elapsedMs: number;
  /** Set when the run ended on an error, so the message can say so. */
  failure?: string;
  tokens?: number;
  /** Pay-per-use dollars. Omitted on a flat-fee plan, where any figure is invented. */
  costUsd?: number;
}

/**
 * The notification text.
 *
 * Deliberately does not carry the agent's output. A finished run can end with
 * anything in it — a file it read, a command it ran, a secret in an error — and
 * this goes to a chat that syncs to Telegram's servers. The terminal has the
 * result; this says only that there is one to come back to.
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
