/**
 * MCP Streamable HTTP transport — the spec successor to the original
 * HTTP+SSE transport, used by cloud-hosted MCP servers (Anthropic remote
 * servers, internal HTTP wrappers, etc.).
 *
 * Per the 2025-03 spec, a single URL endpoint accepts both:
 *   - POST { jsonrpc, id, method, params } → JSON response, or
 *     text/event-stream of one-or-more JSON-RPC frames.
 *   - GET                                  → text/event-stream channel
 *     for server-initiated notifications and requests (sampling, etc.).
 *
 * This client opens the GET stream lazily on the first message the server
 * tells us to expect — many simple HTTP servers never send anything
 * unsolicited, so we don't burn a TCP connection waiting.
 *
 * Session continuity uses the `mcp-session-id` header. The server sets it
 * on the initialize response; we echo it on every subsequent request.
 */

/** Hard cap on a single SSE response stream. Bounds OOM risk from a
 *  remote server that pushes unbounded data on either the POST reply or
 *  the long-lived GET notification channel. 10 MB is comfortably above
 *  any legitimate MCP frame (tools/list, resources/read) and well below
 *  default Node heap limits. */
const MAX_SSE_BYTES = 10 * 1024 * 1024;

export interface StreamableHttpOptions {
  /** Endpoint URL of the MCP server. */
  url: string;
  /** Optional headers (Authorization, custom auth, etc.). */
  headers?: Record<string, string>;
  /** Called for every JSON-RPC frame the server sends, from either channel. */
  onFrame: (msg: unknown) => void;
  /** Called when the server's notification stream errors or closes unexpectedly. */
  onError?: (err: Error) => void;
}

export class StreamableHttpClient {
  private sessionId: string | null = null;
  private notificationAbort: AbortController | null = null;
  private stopped = false;
  /** True after the server has set a session id (i.e. it tracks state). */
  private get hasServerSession(): boolean {
    return this.sessionId !== null;
  }

  constructor(private readonly opts: StreamableHttpOptions) {}

  /**
   * Issue a JSON-RPC frame as POST. Reply may be a single JSON response
   * (synchronous tools/call), or an SSE stream of one-or-more responses
   * + notifications. The transport invokes `onFrame` for every message
   * it sees on the response, regardless of shape.
   */
  async send(frame: object): Promise<void> {
    if (this.stopped) throw new Error('StreamableHttpClient.stop() already called');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Accept both shapes so the server can pick. Spec requires both.
      'Accept': 'application/json, text/event-stream',
      ...this.opts.headers,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(frame),
    });

    // 202 Accepted = fire-and-forget (notifications); nothing to parse.
    if (res.status === 202) return;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }

    // Server may set the session id on the first response. Capture and
    // open the notification stream if it did (the server now has state
    // and may want to push us notifications/requests).
    const newSession = res.headers.get('mcp-session-id');
    if (newSession && newSession !== this.sessionId) {
      this.sessionId = newSession;
      // Don't await — we want POST to return as soon as the response is
      // parsed; the notification stream lives independently.
      void this.openNotificationStream();
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // Process inline streaming response (multiple frames possible).
      await this.consumeSseBody(res);
    } else {
      // Single JSON response.
      const body = await res.json().catch(() => null);
      if (body && typeof body === 'object') {
        this.opts.onFrame(body);
      }
    }
  }

  /**
   * Open the server-push SSE channel. Idempotent — won't open twice if
   * already streaming. Errors are surfaced via `onError`, not thrown, so
   * a transient network blip doesn't crash the agent loop.
   */
  private async openNotificationStream(): Promise<void> {
    if (this.notificationAbort || this.stopped) return;
    this.notificationAbort = new AbortController();

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      ...this.opts.headers,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    try {
      const res = await fetch(this.opts.url, {
        method: 'GET',
        headers,
        signal: this.notificationAbort.signal,
      });
      if (!res.ok || !res.body) {
        // Some servers don't support the GET channel — that's fine, they
        // just won't push anything. Don't escalate to an error.
        return;
      }
      await this.consumeSseBody(res);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.opts.onError?.(err as Error);
    } finally {
      this.notificationAbort = null;
    }
  }

  /**
   * Parse a `text/event-stream` body, invoking `onFrame` for each JSON
   * payload. SSE framing is intentionally permissive — we treat any line
   * starting with `data:` as one event's payload and join multi-line
   * data: blocks until a blank line.
   *
   * Bounded by `MAX_SSE_BYTES`: a misbehaving or malicious remote server
   * can push unbounded data on an SSE channel — without a cap, the
   * accumulating buffer would OOM the agent. We track cumulative bytes
   * read and bail with `onError` past the cap.
   */
  private async consumeSseBody(res: Response): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let bytesRead = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > MAX_SSE_BYTES) {
          // Abort the reader so we don't keep allocating; surface via
          // onError so the registry can mark the server as failed.
          try { await reader.cancel(); } catch { /* best-effort */ }
          this.opts.onError?.(new Error(
            `mcp http: SSE body exceeded ${MAX_SSE_BYTES} bytes; aborting (likely a misbehaving server)`,
          ));
          return;
        }
        buffer += decoder.decode(value, { stream: true });

        // Split on the SSE event boundary (two consecutive newlines).
        // CRLF and LF both legal — normalise first.
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const eventBlock = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.dispatchSseEvent(eventBlock);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
  }

  private dispatchSseEvent(block: string): void {
    // Each event is a set of `field:value` lines. We only care about the
    // `data:` field — `event:` types are server-defined; the MCP spec
    // doesn't use them for transport framing.
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    try {
      const msg = JSON.parse(raw);
      this.opts.onFrame(msg);
    } catch {
      // Malformed JSON in the stream — skip rather than blow up.
    }
  }

  /** Tear down the notification stream and refuse further sends. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.notificationAbort?.abort();
    this.notificationAbort = null;
  }
}
