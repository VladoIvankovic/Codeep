/**
 * Starting work from the phone.
 *
 * Approval lets the phone answer a question the agent asked. This lets the
 * phone ask one — which is a different thing, and a larger one. A chat that can
 * only say Run, Skip or Cancel is bounded by what the agent already decided to
 * do; a chat that can send a prompt is a keyboard attached to this machine.
 * That is why it is off by default and has its own switch rather than riding on
 * the approval one.
 */

import { sharedUpdates, type TelegramCredentials } from './telegramUpdates';

/** Longest prompt accepted. Past this it is a paste, not an instruction. */
export const MAX_PROMPT_LENGTH = 2000;

/**
 * How old a message may be and still run.
 *
 * Telegram keeps undelivered updates for 24 hours. Without this, a message
 * typed at midnight to a machine that was switched off would be handed to the
 * agent the moment the CLI next started — hours later, in a repository that has
 * moved on, with nobody watching. A prompt is an instruction for now.
 */
export const MAX_MESSAGE_AGE_MS = 5 * 60_000;

export type PromptRejection =
  | 'not-from-owner'
  | 'not-text'
  | 'empty'
  | 'too-long'
  | 'stale'
  | 'command';

export type PromptResult =
  | { ok: true; text: string }
  | { ok: false; reason: PromptRejection };

/**
 * Whether a message update came from the one chat allowed to drive this agent.
 *
 * A bot's username is discoverable, so without this anyone who found it could
 * type into somebody else's terminal. Mirrors the approval check deliberately:
 * both gate the same machine, and they should not be able to disagree.
 */
export function messageFromOwner(message: unknown, chatID: string): boolean {
  if (!chatID) return false;
  const chat = (message as { chat?: unknown } | null)?.chat;
  const id = (chat as { id?: unknown } | null)?.id;
  if (typeof id === 'number') return String(id) === chatID;
  if (typeof id === 'string') return id === chatID;
  return false;
}

/**
 * Turn a Telegram message into a prompt, or say why it is not one.
 *
 * Returns a reason rather than null throughout: every rejection here has a
 * different thing to tell the sender, and a bot that goes quiet is
 * indistinguishable from one that is switched off.
 */
export function extractPrompt(
  message: unknown,
  chatID: string,
  now: number = Date.now(),
): PromptResult {
  if (!messageFromOwner(message, chatID)) return { ok: false, reason: 'not-from-owner' };

  const text = (message as { text?: unknown } | null)?.text;
  // A photo, sticker or voice note has no `text` at all.
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' };

  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_PROMPT_LENGTH) return { ok: false, reason: 'too-long' };
  // `/start` and friends are addressed to the bot, not to the agent.
  if (trimmed.startsWith('/')) return { ok: false, reason: 'command' };

  const date = (message as { date?: unknown } | null)?.date;
  if (typeof date === 'number' && now - date * 1000 > MAX_MESSAGE_AGE_MS) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, text: trimmed };
}

/** What to say back, so silence never has to be interpreted. */
export function describeRejection(reason: PromptRejection): string | null {
  switch (reason) {
    // Answering a stranger confirms the bot is live and attached to something
    // worth probing. They get nothing.
    case 'not-from-owner': return null;
    case 'not-text':  return 'I can only take text — send the instruction as a message.';
    case 'empty':     return null;
    case 'too-long':  return `That is longer than ${MAX_PROMPT_LENGTH} characters. Send a shorter instruction, or paste the text into the terminal.`;
    case 'stale':     return 'That message is older than five minutes, so I have not run it. Send it again if you still want it.';
    case 'command':   return 'Send an instruction in plain words — I do not take slash commands here.';
  }
}

/**
 * The one instruction waiting for the agent to be free.
 *
 * One slot, and a newer message replaces an older one. A queue that grows is a
 * queue that runs things you have forgotten asking for: send two corrections
 * while a run is busy and you meant the second, not both in order. Replacing
 * says so out loud rather than quietly dropping either.
 */
export class InboxQueue {
  private pending: string | null = null;

  /** @returns whether this displaced an instruction that had not run yet. */
  offer(text: string): { replaced: boolean } {
    const replaced = this.pending !== null;
    this.pending = text;
    return { replaced };
  }

  /** Hand over what is waiting, and empty the slot. */
  take(): string | null {
    const out = this.pending;
    this.pending = null;
    return out;
  }

  get waiting(): boolean {
    return this.pending !== null;
  }

  clear(): void {
    this.pending = null;
  }
}

/** Confirmation for a prompt that will run later, so the sender can stop wondering. */
export function describeQueued(replaced: boolean): string {
  return replaced
    ? 'Queued — replaces the one you sent before it. It runs when the current task finishes.'
    : 'Queued — it runs when the current task finishes.';
}

/** Confirmation for a prompt that starts immediately. */
export function describeStarted(text: string): string {
  const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return `Started — ${short}`;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

export interface InboxHost {
  /** True while a run owns the agent, so a prompt has to wait its turn. */
  isBusy: () => boolean;
  /** Run a prompt as though it had been typed into the input. */
  submit: (text: string) => void;
  /** Say something back on the phone. Failures here are not worth surfacing. */
  reply: (text: string) => void;
}

/**
 * Listen for instructions from the phone until the returned function is called.
 *
 * The queue is drained by `drain`, which the host calls when a run ends —
 * rather than polled from here — so that "the agent is free" is decided in one
 * place instead of two that can disagree.
 */
export function attachTelegramInbox(
  credentials: TelegramCredentials,
  host: InboxHost,
): { stop: () => void; drain: () => void } {
  const queue = new InboxQueue();

  const unsubscribe = sharedUpdates(credentials.botToken).subscribe('message', message => {
    const result = extractPrompt(message, credentials.chatID);
    if (!result.ok) {
      const explanation = describeRejection(result.reason);
      if (explanation) host.reply(explanation);
      return;
    }

    if (host.isBusy()) {
      host.reply(describeQueued(queue.offer(result.text).replaced));
      return;
    }

    host.reply(describeStarted(result.text));
    host.submit(result.text);
  });

  return {
    stop: () => { unsubscribe(); queue.clear(); },
    drain: () => {
      // Re-check busy: a run can start from the terminal between the last one
      // ending and this firing, and two agents on one workspace is not a thing
      // this queue gets to cause.
      if (host.isBusy()) return;
      const next = queue.take();
      if (next === null) return;
      host.reply(describeStarted(next));
      host.submit(next);
    },
  };
}
