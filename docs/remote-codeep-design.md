# Remote Codeep — Architecture Design

*Status: proposal for green-light. Grounds every claim in the current substrate (verified against `src/acp/*`, `Codeep-web/schema.sql`, `Codeep-web/src/app/api/*`, `src/utils/codeepCloud.ts`, both Apple apps). Synthesizes a four-architecture judge-panel spike (serverless-native, realtime-relay, e2e-zero-knowledge, p2p-signaling); does not blindly pick one.*

*Produced 2026-06-15 via a 9-agent design workflow (4 proposals → comparative judging → synthesis).*

---

## 1. Recommendation (TL;DR)

Build a **server-mediated append-only event journal on the existing Next.js + MySQL**, with a **durable, asynchronously-answerable permission gate** as the spine, **APNs/web-push as a doorbell only** (never the source of truth), and an **opaque-payload schema from day one** so E2E ("option C") is a later client-side change, not a migration. This is the **serverless-native** proposal as the chassis, with four grafts: realtime-relay's *durable perm-row + first-writer-wins idempotency*, e2e's *opaque-ciphertext columns + seq-in-AAD tamper-evidence (schema only now)* and *two-tier privacy split*, and p2p's *configurable auto-decision policy* for missed pushes.

It beats the alternatives **for this team** because: (a) it adds **zero always-on infrastructure** — matching the manual-deploy / owner-runs-migrations reality; (b) the journal is the one mechanism that fixes the substrate's two real gaps — *no event log/replay* and *no async approval delivery* — for both live-tail (`?since=lastSeq`) and late-joiner replay (`?since=0`); (c) it ships **Approve Anywhere (priority #1) on the thinnest possible slice** without sockets, WebRTC, or a pairing UX. The realtime-relay and p2p proposals defer their entire differentiator to the *last* phase and fall back to exactly this design for the MVP — so this *is* the MVP they both describe, minus the speculative infra. Full-E2E is the right *north star* but the wrong *first build*: it front-loads X25519 pairing + key-wrap on three platforms before a single approval round-trips.

**One honest correction baked in:** the server-held ~25s long-poll all four spikes leaned on is **net-new**, not a reuse. Verified: `GET /api/auth/cli` returns `{status:'pending'}` *immediately* and the CLI re-polls every 2s; `/api/review-events` GET is a *cached* read. No held handler, no `maxDuration`, no `ReadableStream` anywhere. So we **start with client-side short-poll + push doorbell** (proven pattern) and treat any server-held long-poll or SSE as a deliberate, measured Phase-2 upgrade — not an assumed primitive.

---

## 2. Architecture

### 2.1 Transport
PULL over the stack already running. No WebSocket, no long-lived process, for Phases 0–2.
- **Agent → viewers:** the CLI/Mac agent tees each ACP `session/update` it already emits (verified call sites server.ts:595/634/698/785/857/952/988+) into a batched POST to `/api/remote/events`, debounced ~250ms.
- **Viewers → agent:** phone/web POST approvals/prompts/cancel to `/api/remote/commands`.
- **Agent reads commands:** the CLI is already long-lived (`process.stdin.on('end')` keeps `codeep acp` alive). Phase 0/1: client-side short-poll every 1–2s. Phase 2 (measured): server-held ~25s long-poll behind `dynamic='force-dynamic'`, adopted only if poll cost/latency justifies it.
- **Viewers read events:** short-poll `GET /api/remote/events?session=&since=<seq>` (indexed `WHERE session_id=? AND seq>?`). Phase 3 (optional): managed SSE route that internally polls MySQL ~500ms and flushes rows.

Push (APNs/web-push) is **only a doorbell** to wake the phone; correctness never depends on it.

### 2.2 Auth
Reuse `getGithubIdFromRequest` / `getGithubIdFromSyncToken` (auth-helpers.ts) **verbatim**. Every `/api/remote/*` endpoint authorizes via `x-sync-token` (CLI/Mac/iOS) or NextAuth session (web), resolved against hashed `user_devices` (dual-match `SHA2(?,256) OR ?`). A device may only read/write journals for sessions whose `owner_github_id` equals its resolved `github_id` — same boundary `session_history` uses today. Rate-limit every endpoint with the existing `checkRateLimit`.

For **Go-Live /share**, mint a capability token like `session_history.share_token`: `randomBytes(12).toString("base64url")` (16 url-safe chars). A `share_token` gives unauthenticated read of the *redacted* event stream at `/live/<token>` (clone of `/s/<token>`). A separate, **opt-in, revocable, short-TTL** `control_token` grants prompt/approve; approvals are **owner-only by default** even on a shared link.

### 2.3 Event model + catch-up/replay
`seq` is a **per-session monotonic counter the agent assigns**. `id BIGINT AUTO_INCREMENT` is the global tiebreak.
- **Live tail:** viewer holds `?since=<lastSeq>`, gets new rows.
- **Late-joiner catch-up (the missing gap, now solved):** join mid-run with `?since=0`, replay the transcript, tail from `nextSeq`. The cursor *is* the seq — no in-memory replay buffer.
- **Retention (two-tier privacy split):** `remote_events` rows TTL out via the existing `/api/cleanup` cron pattern (`created_at < NOW() - INTERVAL 24 HOUR` unless pinned). The **canonical transcript still lands in `session_history`** via the existing end-of-turn `syncSession()` (server.ts:1289). The journal is purely the live/recent tail.
- **Seq integrity (schema hook for later):** when E2E lands, bind `seq` into the GCM AAD so any relay reorder/drop/truncate fails decryption — free tamper-evidence.

### 2.4 The approval round-trip (the crux)
Today (verified): server.ts:1158 `transport.request('session/request_permission', …)`; transport.ts resolves the in-memory `pendingRequests` promise or times out at `REQUEST_TIMEOUT_MS=30_000` → `null`; server.ts:1176 maps `null`/cancelled → `reject_once` (fail-closed). agent.ts:983 awaits inline; agent.ts:160 `classifyPermissionOutcome` fails closed. **No durable step journal** — the in-flight turn lives only in process memory.

Redesigned gate (durable, async, owner-only by default):
```
AGENT (manual mode)                       codeep.dev (MySQL)           PHONE / WEB
  1. assign request_id = perm_<uuid>
     POST /api/remote/events
     { kind:'permission_request',
       payload: formatToolInputForPermission(...) } ──▶ INSERT remote_events (durable, seq'd)
  2. fire APNs/web-push doorbell ───────────────────────────────────────▶ lock-screen actions
     (best-effort; NOT source of truth)                                   [Allow once][Always][Reject]
  3. poll GET /api/remote/commands?session=&request_id=  ◀── (short-poll 1-2s; Phase2 held ~25s)
                                          ◀── POST /api/remote/commands   4. user taps (works from
                                              { request_id, outcome }         push action)
                                              UNIQUE(session_id,request_id)
  5. poll returns the row → map outcome → PermissionOutcome union
     return to agent.ts:983 — loop unblocks exactly as if Zed answered
```
- **Idempotency:** `UNIQUE(session_id, request_id)` on `remote_commands` → double-tap / push+in-app = no-op (first writer wins).
- **Fail-closed expiry:** each `permission_request` carries `expires_at` (default 10 min; configurable to hours for Overnight). On expiry with no command row → `reject_once` (identical to current null-timeout, just a longer durable window).
- **Agent blocked (normal async):** the poll loop waits with no 30s ceiling — an overnight run can block for hours.
- **CLI restart while blocked (honest scope):** the *answer* is durable (`remote_commands` keyed by `request_id`), but the *in-flight turn is NOT* — cold `session/resume` (server.ts:735+) spins a **fresh** acpSession with `currentModeId:'auto'`, `abortController:null`, so the gate isn't re-armed. **Phase-1 reality: the interrupted turn is lost and re-prompted.** A transactional **"executed" marker written before running an approved tool** guarantees re-prompt can never double-execute a destructive command. The MVP does *not* advertise free restart recovery.
- **Phone asleep / push dropped:** push is best-effort (iOS silent-push throttling); the journal/poll is the source of truth, so a dropped push just delays the doorbell. Plus a **configurable auto-decision policy**: Overnight mode can pre-set "auto-reject on expiry" (default) or "auto-allow a safe-tool allow-list (e.g. read-only)".

### 2.5 Session ownership
New `remote_sessions` records ownership/claim/share. The agent **claims** at `session/new` (or `codeep run -p --remote` / `/share`), stamping `host_device_id` (`getDeviceId()`) + a random `claim_token`. One host per live session; viewers are stateless readers.
- **Heartbeat:** `last_heartbeat_at` bumps on every event POST + ~20s idle keepalive; viewers show "agent offline" when stale >60s.
- **Two-desktops-same-repo:** writes gated on holding the current `claim_token`; a second claim rotates the token, the first host's next POST gets 409 → self-demotes (last-claimer-wins). UX: "session is live on `<hostname>` — take over?".

---

## 3. Security & privacy
- **Trust model now:** codeep.dev is a **low-trust relay** — stores journal rows, routes by `(session_id, seq)`, doesn't interpret them. observe/approve gated to the user's **own** devices (`github_id == owner_github_id`) — the exact `session_history` boundary. Not a regression: the server already stores `session_history` (MEDIUMTEXT) and AES-GCM-at-rest keys.
- **What codeep.dev can see (now):** which session is live, event sizes/timing, and — until E2E — payloads (agent output, formatted tool input/diffs in prompts). **Can't see:** raw sync tokens (hashed), provider API keys via this path.
- **Where E2E ("option C") lands — schema now, crypto later:** `remote_events.payload` / `remote_commands.payload` are **opaque blobs from day one**, so option C is an additive client-side change with **zero migration**: encrypt payloads under a per-session AES-256-GCM key, wrapped to each device's X25519 key, wrap-list synced via a future `remote_session_keys` table. **Permission prompts encrypt first** (they carry diffs/commands). Pairing via QR + 6-word SAS confirmed on both screens to defeat a relay MITM.
- **Two-tier privacy posture:** *live/relay tail = ephemeral, short-TTL, E2E-able; canonical transcript = existing server-readable `session_history`.* Losing all devices = losing only ephemeral live events, never history.
- **Go-Live blast radius:** `control_token` **off by default, short-TTL, revocable**, approvals owner-only — or a shared link becomes RCE-by-stranger.

---

## 4. What we build on vs net-new
**Reused:** ACP shapes (`SessionUpdateInner`, `RequestPermissionParams`, `PermissionOption`/`PermissionOptionKind`, protocol.ts:271–292) serialized 1:1 into journal rows; `PermissionOutcome` + `classifyPermissionOutcome` (agent.ts:145/156/160) unchanged; `formatToolInputForPermission` (server.ts:143) as the phone prompt card; `getGithubIdFromRequest`/`getGithubIdFromSyncToken`, `user_devices`, `getDeviceId()`; `session_history.share_token` + `randomBytes(12).base64url` + `/s/<token>` page → `/live/<token>`; `checkRateLimit`; `/api/cleanup` cron+secret; `syncSession()` (server.ts:1289) for the canonical transcript; `codeepCloud.ts` + `CodeepCloudClient.swift` plumbing; `keyEncryption.ts` AES-256-GCM (moved client-side for E2E later).

**Net-new:** 4 tables (§5); `/api/remote/{events,commands,sessions,push/register}` (+ Phase-3 `/events/stream`); **APNs remote push on both apps** (verified zero `registerForRemoteNotifications` today — needs .p8 auth key + JWT-signed HTTP/2 call from a Next route; web-push needs VAPID); CLI/ACP changes (tee `session/update` → batched `pushEvents`; swap manual-mode `onRequestPermission` stdio request for journal-write + doorbell + poll; `codeep run -p --remote` flag; transactional "executed" marker) — **no change to the ACP wire protocol** (Zed/VS Code untouched; remote is a parallel transport); CloudClient methods `pushEvents`/`pollCommands`/`claimSession`/`registerPushToken`.

---

## 5. Phased roadmap

DDL (idempotent; **owner runs the migration**):
```sql
CREATE TABLE IF NOT EXISTS remote_sessions (
  session_id      VARCHAR(64) PRIMARY KEY,
  owner_github_id VARCHAR(50) NOT NULL,
  host_device_id  VARCHAR(32) NOT NULL,
  acp_session_id  VARCHAR(64), project_id VARCHAR(16), title VARCHAR(255),
  status          ENUM('live','idle','ended') DEFAULT 'live',
  share_token     VARCHAR(32) DEFAULT NULL,
  control_token   VARCHAR(32) DEFAULT NULL,
  claim_token     VARCHAR(64) NOT NULL,
  last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at      DATETIME, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_owner_status (owner_github_id, status), UNIQUE KEY uq_share (share_token));

CREATE TABLE IF NOT EXISTS remote_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL, owner_github_id VARCHAR(50) NOT NULL,
  seq BIGINT NOT NULL, kind VARCHAR(40) NOT NULL,
  payload MEDIUMTEXT NOT NULL,            -- OPAQUE: plaintext now, ciphertext under E2E
  enc TINYINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session_seq (session_id, seq), INDEX idx_created (created_at));

CREATE TABLE IF NOT EXISTS remote_commands (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL, request_id VARCHAR(64) NOT NULL,
  from_github_id VARCHAR(50) NOT NULL,
  kind ENUM('approve','prompt','cancel','set_mode') NOT NULL,
  payload MEDIUMTEXT NOT NULL,            -- OPAQUE
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_session_request (session_id, request_id),   -- first-writer-wins
  INDEX idx_session_id (session_id, id));

CREATE TABLE IF NOT EXISTS device_push_tokens (
  github_id VARCHAR(50) NOT NULL, device_id VARCHAR(32) NOT NULL,
  platform ENUM('apns','webpush') NOT NULL, token TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (github_id, device_id));
```

- **Phase 0 — schema + plumbing (days):** migrate the 4 tables; add `claimSession`/`pushEvents`/`pollCommands`/`registerPushToken` to `codeepCloud.ts` + `CodeepCloudClient.swift`; iOS `registerForRemoteNotifications` → `POST /api/remote/push/register`. **iOS push (APNs) enters here.**
- **Phase 1 — Approve Anywhere (priority #1), the thinnest slice:** owner-only, no live transcript yet, single event kind. Claim on `codeep acp`/`codeep run`; on a manual-mode permission, write a `permission_request` row + one push with Allow-once/Always/Reject + short-poll `/commands`; phone answers from the push action; agent unblocks or `reject_once` on 10-min expiry; transactional "executed" marker. Exercises the whole journal+poll+push+idempotency+fail-closed spine with **no socket**.
- **Phase 2 — Overnight runner (priority #2):** full `remote_events` journal + phone short-poll viewer (replay via `?since=0`); longer/configurable `expires_at`; configurable auto-decision policy; heartbeat "agent offline" UI. **Decision point:** measure poll cost — introduce server-held ~25s long-poll only if it hurts. **No always-on relay here.**
- **Phase 3 — Go Live /share (priority #3):** `share_token`/`control_token` + public `/live/<token>` page + optional managed SSE. Read-only by default, opt-in revocable control. A small dedicated relay becomes the upgrade **only if** Go-Live volume breaks the poll/SSE model — and it's a transport swap, journal contract unchanged.
- **Phase 4 — Headless + E2E:** `codeep run -p --remote` observability; then E2E (option C) on the already-opaque columns + `remote_session_keys` (QR/SAS pairing, per-session key wrap, encrypt prompts first, `enc:1`). Durable turn-resume tackled here if not pulled earlier.

---

## 6. Open questions / decisions for the owner
1. **Server-held long-poll — accept it, and when?** Net-new (no held handler today), pins a serverless invocation per held call. Rec: short-poll through Phase 1, measure, decide in Phase 2.
2. **Stateful relay — ever?** Avoided through Phase 3. Rec: defer; revisit only with real concurrency numbers.
3. **E2E now or later?** Schema is E2E-ready now; crypto deferred to Phase 4. Rec: ship server-readable first (matches "ship fast"; two-tier split keeps history private-as-today).
4. **Go-Live read-only or interactive?** Rec: read-only `/live/<token>` in Phase 3; `control_token` only with off-by-default + short-TTL + revoke.
5. **Restart turn-resume — build it, or accept re-prompt?** Rec: accept re-prompt for MVP (cheap, safe); the "executed" marker is mandatory either way.
6. **Push provider on web:** Rec: APNs-only (iOS is the natural remote surface) for Phase 1, add VAPID web-push in Phase 3 with Go-Live.

---

## 7. Risks & non-goals
**Risks:** poll cost/latency at scale (held long-poll/SSE burns invocations — phase as earned upgrades); MySQL as a message bus (append-only churn + disciplined GC; the 24h TTL cron + `INDEX(session_id,seq)` are load-bearing); restart correctness (in-flight turn not durable today — "executed" marker prevents double-execution; full turn-resume is large/unscoped, do not promise in Phase 1); push reliability (best-effort, throttled — never depend on it for correctness, keep `expires_at` conservative); Go-Live `control_token` blast radius (off/short-TTL/revocable/owner-only — non-negotiable); APNs genuinely net-new on both apps (single point of failure for Approve Anywhere — mitigated by doorbell-over-durable-poll).

**Non-goals (Phases 0–3):** WebRTC/P2P (native-addon vs single-binary distribution is a real packaging blocker, and the asleep-phone case falls back to push+relay anyway — buys nothing toward #1/#2); a dedicated always-on relay (deferred until volume proves serverless breaks); full zero-knowledge E2E as the first build (north star, not MVP); durable agent-turn-resume across CLI restart (re-prompt is the accepted Phase-1 behavior); changing the ACP wire protocol (remote is a parallel transport; Zed/VS Code untouched).

---

**Green-light ask:** approve **Phase 0 + Phase 1** (4-table migration, `/api/remote/{events,commands,sessions,push/register}`, the CLI `onRequestPermission` remote branch + executed-marker, iOS APNs registration). That single slice delivers **Approve Anywhere** on the existing infra with zero new always-on services, and exercises the entire journal + poll + push + idempotency + fail-closed spine every later phase reuses.

### Grounding references (for the implementation session)
`src/acp/server.ts:143` (`formatToolInputForPermission`), `:1155-1178` (manual-mode `onRequestPermission`), `:735-756` (cold `session/resume`), `:1289` (`syncSession`); `src/acp/transport.ts:35,103` (`REQUEST_TIMEOUT_MS=30_000`, in-memory `pendingRequests`); `src/utils/agent.ts:156-160,983` (fail-closed classify, inline await); `src/acp/protocol.ts:271-292` (permission shapes); `Codeep-web/src/lib/auth-helpers.ts` (`getGithubIdFromSyncToken`), `Codeep-web/src/lib/rateLimit.ts` (`checkRateLimit`), `Codeep-web/src/app/api/sessions/share/route.ts` (`randomBytes(12).base64url`), `Codeep-web/src/app/api/auth/cli/route.ts` (immediate-return poll — NOT held), `Codeep-web/src/app/api/cleanup/route.ts` (cron+secret GC), `Codeep-web/schema.sql` (`user_devices`, `session_history.share_token`); `Codeep-web/src/lib/keyEncryption.ts` (AES-256-GCM for later E2E); `src/utils/codeepCloud.ts` + `CodeepCore/Cloud/CodeepCloudClient.swift` (CloudClient surface; both apps have NO `registerForRemoteNotifications`).
