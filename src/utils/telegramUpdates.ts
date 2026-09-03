/**
 * One long poll, one offset, both kinds of update.
 *
 * Telegram's getUpdates has a single cursor per bot. `offset` confirms every
 * update older than itself **regardless of `allowed_updates`** — that parameter
 * only filters what comes back in the response, not what the call acknowledges.
 * So two pollers on one bot do not coexist: each advances the cursor past
 * updates the other never saw, and both start losing traffic silently. An
 * approval tapped on the phone would simply not register, with nothing anywhere
 * to say why.
 *
 * Hence this. Everything that wants updates subscribes here, the loop asks for
 * every type any subscriber could want, and dispatch happens locally where
 * losing one is impossible.
 */

const API = 'https://api.telegram.org';
/** Server-side long-poll window. The request blocks for up to this long. */
const POLL_SECONDS = 25;
/** Local ceiling, comfortably past the server's own. */
const REQUEST_TIMEOUT_MS = (POLL_SECONDS + 10) * 1000;
/**
 * Pause after a poll that brought nothing back.
 *
 * Telegram's long poll already blocks server-side for POLL_SECONDS, so in
 * normal running this never fires. It exists for the case where the request
 * returns immediately — a network failure, or a server that ignored the
 * timeout — which without it turns this into a loop that hammers the API as
 * fast as the connection allows.
 */
const IDLE_PAUSE_MS = 1000;

export interface TelegramCredentials {
  /** From @BotFather. A credential — belongs in the keychain, never in config. */
  botToken: string;
  /** The single chat allowed to answer. Anything else is ignored. */
  chatID: string;
}

export type UpdateKind = 'callback_query' | 'message';
export type UpdateHandler = (payload: unknown) => void | Promise<void>;
/**
 * Told when a poll fails, and when one succeeds after failing.
 *
 * Without this the loop was completely silent: a webhook left configured on the
 * bot answers 409 to every getUpdates, a revoked token answers 401, and both
 * looked exactly like a phone nobody had messaged. Diagnosing it meant reading
 * the source.
 */
export type PollObserver = (event: { ok: boolean; detail: string }) => void;

/**
 * Where the cursor goes after a batch.
 *
 * Never backwards: a retry that returns an older batch, or a response with ids
 * this build does not understand, must not re-deliver what was already handled.
 */
export function nextOffset(current: number, updates: { update_id?: unknown }[]): number {
  let out = current;
  for (const update of updates) {
    if (typeof update.update_id === 'number') out = Math.max(out, update.update_id + 1);
  }
  return out;
}

/** Every kind this loop asks for, so one cursor can serve every subscriber. */
export const POLLED_KINDS: readonly UpdateKind[] = ['callback_query', 'message'];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class TelegramUpdates {
  private readonly botToken: string;
  private readonly handlers = new Map<UpdateKind, Set<UpdateHandler>>();
  private offset = 0;
  private running = false;

  private readonly idlePauseMs: number;
  private observer: PollObserver | null = null;
  /** Only the first failure of a streak is reported, then the recovery. */
  private failing = false;

  constructor(botToken: string, idlePauseMs: number = IDLE_PAUSE_MS) {
    this.botToken = botToken;
    this.idlePauseMs = idlePauseMs;
  }

  /** Watch the health of the poll itself, separately from its payload. */
  observe(observer: PollObserver | null): void {
    this.observer = observer;
  }

  private report(ok: boolean, detail: string): void {
    if (ok === !this.failing) return;   // nothing changed; stay quiet
    this.failing = !ok;
    this.observer?.({ ok, detail });
  }

  /**
   * Listen for one kind of update. Returns the function that stops listening.
   *
   * The loop runs while anyone is listening and stops when the last subscriber
   * leaves, so a CLI with the inbox switched off never opens a connection.
   */
  subscribe(kind: UpdateKind, handler: UpdateHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    set.add(handler);
    if (!this.running) void this.loop();

    return () => {
      set!.delete(handler);
      if (this.subscriberCount() === 0) this.running = false;
    };
  }

  private subscriberCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.running && this.subscriberCount() > 0) {
      const json = await this.getUpdates();
      if (!this.running) break;

      const updates = Array.isArray(json?.result) ? json.result as Record<string, unknown>[] : [];
      // Advance before dispatching. A handler that throws must not make the
      // loop re-read the same update forever.
      this.offset = nextOffset(this.offset, updates);

      for (const update of updates) {
        for (const kind of POLLED_KINDS) {
          const payload = update[kind];
          if (payload === undefined) continue;
          for (const handler of this.handlers.get(kind) ?? []) {
            try {
              await handler(payload);
            } catch {
              // One subscriber's failure is not the others' problem, and is
              // certainly not a reason to stop reading the bot.
            }
          }
        }
      }

      // Covers an empty batch as well as a failed request: both mean the loop
      // would otherwise come straight back with nothing to do.
      if (updates.length === 0) await sleep(this.idlePauseMs);
    }

    this.running = false;
  }

  private async getUpdates(): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${API}/bot${this.botToken}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset: this.offset,
          timeout: POLL_SECONDS,
          allowed_updates: POLLED_KINDS,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || json?.ok === false) {
        const description = typeof json?.description === 'string' ? json.description : `HTTP ${response.status}`;
        this.report(false, description);
        return null;
      }
      this.report(true, 'reading updates again');
      return json;
    } catch (error) {
      this.report(false, (error as Error)?.message || 'could not reach Telegram');
      return null;
    }
  }
}

/**
 * The one poller per bot token.
 *
 * Approvals are constructed per dangerous tool call and the inbox lives for the
 * whole session; both must reach the same cursor, so the instance is keyed by
 * token rather than owned by either.
 */
const shared = new Map<string, TelegramUpdates>();

export function sharedUpdates(botToken: string): TelegramUpdates {
  let instance = shared.get(botToken);
  if (!instance) { instance = new TelegramUpdates(botToken); shared.set(botToken, instance); }
  return instance;
}
