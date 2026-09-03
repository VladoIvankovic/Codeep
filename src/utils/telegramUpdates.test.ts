import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelegramUpdates, nextOffset, POLLED_KINDS } from './telegramUpdates';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

/** Serve one batch, then nothing, so the loop has something to do and stops. */
function serve(batches: Record<string, unknown>[][]) {
  const calls: Record<string, unknown>[] = [];
  let index = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
    calls.push(JSON.parse((init as { body: string }).body));
    const result = batches[index++] ?? [];
    return { ok: true, json: async () => ({ ok: true, result }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('nextOffset', () => {
  it('advances past the highest update seen', () => {
    expect(nextOffset(0, [{ update_id: 7 }, { update_id: 9 }])).toBe(10);
  });

  it('never goes backwards', () => {
    expect(nextOffset(20, [{ update_id: 3 }])).toBe(20);
  });

  it('ignores updates with no usable id, and an empty poll', () => {
    expect(nextOffset(5, [{}, { update_id: 'x' }])).toBe(5);
    expect(nextOffset(5, [])).toBe(5);
  });
});

describe('TelegramUpdates', () => {
  it('asks for every kind, so one cursor can serve every subscriber', async () => {
    // getUpdates confirms everything older than `offset` regardless of
    // allowed_updates. Asking for only one kind here would acknowledge the
    // other on a subscriber's behalf and lose it.
    const calls = serve([[]]);
    const updates = new TelegramUpdates('token', 1);
    const stop = updates.subscribe('message', () => {});
    await settle();
    stop();
    expect(calls[0]!.allowed_updates).toEqual([...POLLED_KINDS]);
  });

  it('delivers both kinds from one batch to their own subscribers', async () => {
    const seen: string[] = [];
    serve([[
      { update_id: 1, callback_query: { id: 'c' } },
      { update_id: 2, message: { text: 'hello' } },
    ]]);
    const updates = new TelegramUpdates('token', 1);
    const stopCallbacks = updates.subscribe('callback_query', () => { seen.push('callback'); });
    const stopMessages = updates.subscribe('message', () => { seen.push('message'); });
    await settle();
    stopCallbacks(); stopMessages();
    expect(seen).toEqual(['callback', 'message']);
  });

  it('advances the cursor once for the whole batch', async () => {
    const calls = serve([[{ update_id: 41, message: { text: 'a' } }, { update_id: 42, message: { text: 'b' } }]]);
    const updates = new TelegramUpdates('token', 1);
    const stop = updates.subscribe('message', () => {});
    await settle();
    stop();
    expect(calls[0]!.offset).toBe(0);
    expect(calls[1]!.offset).toBe(43);
  });

  it('keeps reading after a subscriber throws', async () => {
    // One listener's failure is not a reason to stop reading the bot — and the
    // cursor must still move, or the same update is replayed forever.
    const calls = serve([[{ update_id: 5, message: { text: 'boom' } }]]);
    const updates = new TelegramUpdates('token', 1);
    const stop = updates.subscribe('message', () => { throw new Error('boom'); });
    await settle();
    stop();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1]!.offset).toBe(6);
  });

  it('opens no connection until something is listening', async () => {
    const calls = serve([[]]);
    new TelegramUpdates('token', 1);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('says why a poll failed instead of looking like an idle bot', async () => {
    // A webhook left on the bot answers 409 to every getUpdates, and a revoked
    // token answers 401. Silent, both were indistinguishable from a phone
    // nobody had messaged.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 409,
      json: async () => ({ ok: false, description: 'Conflict: terminated by other getUpdates request' }),
    }) as unknown as Response) as unknown as typeof fetch;

    const seen: { ok: boolean; detail: string }[] = [];
    const updates = new TelegramUpdates('token', 1);
    updates.observe(event => seen.push(event));
    const stop = updates.subscribe('message', () => {});
    await settle();
    stop();

    expect(seen[0]!.ok).toBe(false);
    expect(seen[0]!.detail).toContain('Conflict');
  });

  it('reports a streak once, and again when it recovers', async () => {
    // A poll that fails every second for an hour is one problem, not 3600.
    let failing = true;
    globalThis.fetch = vi.fn(async () => (failing
      ? { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) }
      : { ok: true, json: async () => ({ ok: true, result: [] }) }) as unknown as Response,
    ) as unknown as typeof fetch;

    const seen: { ok: boolean }[] = [];
    const updates = new TelegramUpdates('token', 1);
    updates.observe(event => seen.push(event));
    const stop = updates.subscribe('message', () => {});
    await settle();
    failing = false;
    await settle();
    stop();

    expect(seen.map(e => e.ok)).toEqual([false, true]);
  });
});
