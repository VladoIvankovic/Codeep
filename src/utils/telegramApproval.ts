/**
 * Answer a pending tool confirmation from a phone.
 *
 * The agent already parks on `onRequestPermission` and resumes when that promise
 * settles. This adds a second way to settle it — nothing in the gate changes,
 * and whichever answers first wins. A run that would have sat at an empty desk
 * until someone came back can now continue.
 *
 * Telegram carries it because Telegram runs the infrastructure: the bot API is
 * polled outbound from this machine, so there is no server to host, no inbound
 * port, and no per-user cost. Long polling, never a webhook — a webhook needs a
 * public address, which is precisely what we do not want to need. That is also
 * why this works identically on Linux and Windows, where the Mac app's CloudKit
 * route does not exist.
 *
 * SECURITY: a Telegram bot is reachable by anyone who learns its username. Every
 * update is checked against the configured chat id before it can decide
 * anything. Without that check a stranger who found the bot could approve a
 * destructive command on someone else's machine. See `isFromOwner`.
 *
 * PRIVACY: the message carries the command line, so Telegram sees it. Stated in
 * the docs rather than hidden — it is the reason this is opt-in.
 *
 * Ported from the Mac app's `TelegramApproval.swift`; the wire format, the token
 * matching and the ownership check are deliberately identical, so a bug found on
 * one side is findable on the other.
 */

/** What the phone sent back. Mirrors the three buttons the desktop offers. */
export type TelegramAnswer = 'run' | 'skip' | 'cancel';

const ANSWERS: readonly TelegramAnswer[] = ['run', 'skip', 'cancel'];

import { sharedUpdates, type TelegramCredentials } from './telegramUpdates';

// Re-exported so callers and tests keep the import site they had before the
// cursor moved into its own module.
export type { TelegramCredentials } from './telegramUpdates';
export { nextOffset } from './telegramUpdates';

/** Longest command we put in a message. Telegram caps at 4096 for the whole
 *  text; this keeps room for the heading and the fences, and a command longer
 *  than this is not something anyone reads off a phone anyway. */
const MAX_COMMAND_CHARS = 300;

/**
 * The message text.
 *
 * Fenced, because a command containing underscores or asterisks would otherwise
 * be mangled by Markdown parsing into something that is not what will run — and
 * approving a command you were shown incorrectly is the one failure this whole
 * feature must not have.
 */
export function composeMessage(
  command: string,
  toolName: string,
  isDestructive: boolean,
): string {
  const head = isDestructive
    ? '⚠️ Codeep wants to run a destructive tool'
    : 'Codeep needs approval';
  const trimmed = command.length > MAX_COMMAND_CHARS
    ? command.slice(0, MAX_COMMAND_CHARS - 1) + '…'
    : command;
  // A fence inside the command would close ours early and leak the rest as
  // prose. Neutralise it rather than trusting the input.
  const safe = trimmed.replace(/```/g, "'''");
  return `${head}\n\n\`${toolName}\`\n\n\`\`\`\n${safe}\n\`\`\``;
}

/**
 * Only the configured chat may decide.
 *
 * A bot's username is discoverable, so without this an unrelated Telegram user
 * could approve a command on someone else's machine. Telegram sends the id as a
 * number; it is compared as a string because that is how the user typed it.
 */
export function isFromOwner(callback: unknown, chatID: string): boolean {
  if (!chatID) return false;
  const message = (callback as { message?: unknown } | null)?.message;
  const chat = (message as { chat?: unknown } | null)?.chat;
  const id = (chat as { id?: unknown } | null)?.id;
  if (typeof id === 'number') return String(id) === chatID;
  if (typeof id === 'string') return id === chatID;
  return false;
}

/**
 * Split `run:<token>` into its parts.
 *
 * A callback whose token does not match the question in flight is ignored, and
 * that is what stops a stale button — tapped after the run moved on — from
 * answering a later question it was never shown.
 */
export function parseCallbackData(
  data: string,
): { answer: TelegramAnswer; token: string } | null {
  const separator = data.indexOf(':');
  if (separator <= 0) return null;
  const answer = data.slice(0, separator);
  const token = data.slice(separator + 1);
  if (!token) return null;
  if (!ANSWERS.includes(answer as TelegramAnswer)) return null;
  return { answer: answer as TelegramAnswer, token };
}

/** The keyboard sent with the question. Shape pinned by a test — a renamed
 *  callback_data field would leave three buttons that silently do nothing. */
export function buildKeyboard(token: string): Record<string, unknown> {
  return {
    inline_keyboard: [[
      { text: 'Run', callback_data: `run:${token}` },
      { text: 'Skip', callback_data: `skip:${token}` },
      { text: 'Cancel', callback_data: `cancel:${token}` },
    ]],
  };
}


/**
 * Telegram's three buttons, in the terms the agent's gate speaks.
 *
 * The gate has four outcomes and `classifyPermissionOutcome` fails closed on
 * anything it does not recognise, so this must be exhaustive rather than
 * defaulted — a typo here would read as a denial, which is safe but silently
 * wrong, and the user would tap Run and watch nothing happen.
 */
export function outcomeForAnswer(answer: TelegramAnswer): 'allow_once' | 'reject_once' | 'reject_always' {
  switch (answer) {
    case 'run': return 'allow_once';
    // Skip this one and carry on — not a standing refusal.
    case 'skip': return 'reject_once';
    // Stop asking. The phone has no "always allow": granting a blanket
    // permission is a decision that belongs at the keyboard, where you can see
    // what you are granting it to.
    case 'cancel': return 'reject_always';
  }
}

/**
 * How a decision reads on the other device, once it is too late to change it.
 *
 * The withdrawn side says what happened rather than just going blank, so
 * someone reaching for their phone a moment late learns what they missed
 * instead of finding a message that silently lost its buttons.
 */
export function describePermissionOutcome(outcome: string): string {
  switch (outcome) {
    case 'allow_once': return 'allowed';
    case 'allow_always': return 'allowed, and always from now on';
    case 'reject_once': return 'skipped';
    case 'reject_always': return 'denied';
    default: return 'decided';
  }
}

/**
 * Telegram's failure, phrased for someone who is setting this up.
 *
 * `chat not found` is the one people actually hit: the id belongs to a
 * conversation with a *different* bot, or the bot has never been messaged from
 * that chat at all. Repeating the API's words and adding what they mean beats
 * a generic failure that sends them back to the docs.
 */
export function describeApiError(status: number, json: Record<string, unknown> | null): string {
  const description = typeof json?.description === 'string' ? json.description : '';
  if (/chat not found/i.test(description)) {
    return 'Telegram says "chat not found" — the chat ID does not belong to a conversation with this bot. Message the bot from that chat, then read the ID back from getUpdates.';
  }
  if (/bot was blocked/i.test(description)) {
    return 'Telegram says the bot was blocked by this chat. Unblock it and try again.';
  }
  if (status === 401) {
    return 'Telegram rejected the bot token. Re-enter it with /telegram.';
  }
  return description ? `Telegram refused the message: ${description}` : `Telegram returned HTTP ${status}.`;
}

// ─── The client ───────────────────────────────────────────────────────────────

const API = 'https://api.telegram.org';
/** Sending a message or editing one — no long poll lives here any more. */
const REQUEST_TIMEOUT_MS = 15_000;

interface Outstanding {
  token: string;
  messageID: number;
  resolve: (answer: TelegramAnswer | null) => void;
}

export class TelegramApproval {
  private readonly credentials: TelegramCredentials;
  private outstanding: Outstanding | null = null;
  /** Set while a question is open; called to stop listening once it closes. */
  private unlisten: (() => void) | null = null;

  /** Called once when the question could not be put at all. Not for a missing
   *  answer — only for a failure to ask. */
  private readonly onProblem?: (reason: string) => void;

  constructor(credentials: TelegramCredentials, onProblem?: (reason: string) => void) {
    this.credentials = credentials;
    this.onProblem = onProblem;
  }

  /**
   * Send the question and wait.
   *
   * Resolves `null` when no answer arrived — the terminal was used instead, the
   * caller aborted, or Telegram could not be reached. **A null is never
   * approval**: the caller keeps its own gate and decides for itself.
   */
  async ask(
    command: string,
    toolName: string,
    isDestructive: boolean,
    signal?: AbortSignal,
  ): Promise<TelegramAnswer | null> {
    const token = randomToken();
    const messageID = await this.sendQuestion(
      composeMessage(command, toolName, isDestructive),
      token,
    );
    if (messageID === null) {
      // Say it once, here, rather than leaving the caller to guess from a null
      // that also means "answered elsewhere" and "cancelled".
      this.onProblem?.(this.lastError ?? 'the question could not be sent');
      return null;
    }

    return new Promise<TelegramAnswer | null>(resolve => {
      let settled = false;
      const finish = (answer: TelegramAnswer | null) => {
        if (settled) return;
        settled = true;
        this.outstanding = null;
        this.unlisten?.();
        this.unlisten = null;
        resolve(answer);
      };

      this.outstanding = { token, messageID, resolve: finish };

      if (signal) {
        if (signal.aborted) { finish(null); return; }
        signal.addEventListener('abort', () => finish(null), { once: true });
      }

      // Listen on the bot's one poller rather than opening a second. Two
      // cursors on the same bot silently eat each other's updates.
      this.unlisten = sharedUpdates(this.credentials.botToken)
        .subscribe('callback_query', callback => this.handle(callback));
    });
  }

  /**
   * The terminal answered first. Close the question on the phone so nobody taps
   * a button that would do nothing, and say where it was decided.
   */
  async withdraw(decidedInTerminal: string): Promise<void> {
    const pending = this.outstanding;
    if (!pending) return;
    this.outstanding = null;
    this.unlisten?.();
    this.unlisten = null;
    pending.resolve(null);
    await this.edit(pending.messageID, `Answered in the terminal — ${decidedInTerminal}.`);
  }

  // ── plumbing ──

  /**
   * Why the last call failed, in Telegram's own words.
   *
   * Kept because swallowing it made a misconfiguration indistinguishable from
   * silence: a wrong chat id answers `chat not found` on the very first send,
   * and reporting nothing left the user watching a phone that was never going
   * to ring.
   */
  private lastError: string | null = null;

  private async post(method: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${API}/bot${this.credentials.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || json?.ok === false) {
        this.lastError = describeApiError(response.status, json);
        return null;
      }
      this.lastError = null;
      return json;
    } catch (error) {
      // Network, timeout, malformed JSON. Still "no answer from the phone",
      // but now it can say which.
      this.lastError = (error as Error)?.message || 'could not reach Telegram';
      return null;
    }
  }

  private async sendQuestion(text: string, token: string): Promise<number | null> {
    const json = await this.post('sendMessage', {
      chat_id: this.credentials.chatID,
      text,
      parse_mode: 'Markdown',
      reply_markup: buildKeyboard(token),
    });
    const result = json?.result as { message_id?: unknown } | undefined;
    return typeof result?.message_id === 'number' ? result.message_id : null;
  }

  private async edit(messageID: number, text: string): Promise<void> {
    await this.post('editMessageText', {
      chat_id: this.credentials.chatID,
      message_id: messageID,
      text,
    });
  }

  private async handle(callback: unknown): Promise<void> {
    const pending = this.outstanding;
    if (!pending) return;
    if (!isFromOwner(callback, this.credentials.chatID)) return;

    const data = (callback as { data?: unknown }).data;
    if (typeof data !== 'string') return;
    const parsed = parseCallbackData(data);
    if (!parsed || parsed.token !== pending.token) return;

    this.outstanding = null;
    this.unlisten?.();
    this.unlisten = null;

    const id = (callback as { id?: unknown }).id;
    if (typeof id === 'string') await this.post('answerCallbackQuery', { callback_query_id: id });
    await this.edit(pending.messageID, `${capitalise(parsed.answer)} — sent to your terminal.`);

    pending.resolve(parsed.answer);
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

