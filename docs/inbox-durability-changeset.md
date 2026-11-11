# Inbox correctness changeset — timeout + cursor-reorder + idempotency gate

Status: spec, ready to ship. **Separate from the scale wrapper** (`llm-concurrency-spec.md`),
which stays deferred until multi-mailbox scale. These three are volume-independent correctness
fixes — they lose or hang on real deals at any volume.

## Fix 1 — `kimiInstant` / `kimiThinking` timeout (stop the indefinite hang)
Today `kimi.ts` calls the Vertex SDK with no timeout; a hung call blocks its caller forever
(holds a DB connection, stalls the whole `Promise.allSettled` batch). This is the only piece of
the future wrapper we build now — `withTimeout` alone, **no gate, no retry.**

Lifted the helper out of `researchAthlete.ts` into `server/lib/withTimeout.ts` (also clears its
timer on settle). `kimi.ts` wraps `kimiInstant` and `kimiThinking`:
```ts
const KIMI_INSTANT_TIMEOUT_MS  = Number(process.env.KIMI_INSTANT_TIMEOUT_MS  ?? 30_000);
const KIMI_THINKING_TIMEOUT_MS = Number(process.env.KIMI_THINKING_TIMEOUT_MS ?? 60_000);
export async function kimiInstant(system, user, jsonMode = false, timeoutMs = KIMI_INSTANT_TIMEOUT_MS) {
  return withTimeout(getVertexClient().then(k => k.chat.completions.create({ /* unchanged */ })), timeoutMs, "kimiInstant");
}
```
**Timeout values:** deal-path `kimiInstant` = **30s** (not 60). Rationale: a hung call holds its DB
connection + batch slot for the full timeout; at 60s enough concurrent hangs exhaust the pool
(max 20) *before* timing out, and for an "instant" JSON call >30s is already pathological — fail
fast to avoid the cascade. `kimiThinking` = **60s** (creative generation over temp 0.9 legitimately
runs longer, and it's off the webhook batch so pool risk is lower). `researchAthlete`'s extraction
passes **60s** explicitly (`kimiInstant(..., 60_000)`) — large research prompt; its local
`withTimeout` copy is removed in favor of the shared one (no behavior change). `kimiStream` excluded
(stream timeout semantics belong with the deferred wrapper).

## Fix 2 — idempotency gate BEFORE classify (redelivery safety)
Pub/Sub is at-least-once; today the dedup is `onConflictDoNothing` on the message INSERT, which is
*after* classify+summarize+score — so a redelivered message re-runs ~3 Kimi calls before the insert
no-ops. Add an early gate at the top of `detectDeal` (after the pre-filter, before `classifyMessage`):
```ts
const [dupe] = await db.select({ id: inboxMessages.id })
  .from(inboxMessages)
  .where(eq(inboxMessages.external_message_id, gmailMessageId))
  .limit(1);
if (dupe) return { skipped: true, reason: "already_processed" };
```
Keyed on `external_message_id`, so it only skips *exact* message re-delivery — the follow-up /
preservation paths (different message ids) are unaffected. This is both a standalone win (redelivery
happens today) and the precondition for Fix 3.

## Fix 3 — advance the Gmail cursor AFTER processing (stop silent message loss)
`webhooks.ts:103–105` advances `gmail_history_id` to the notification's `historyId` *before* the
`Promise.allSettled` at `:117`. If the instance is reclaimed post-ack (Cloud Run throttles CPU after
the 200), the messages between `storedHistoryId` and `historyId` are lost — the next notification
starts from the advanced cursor and never re-fetches them.

Reorder: advance the cursor **after** the batch is processed.
```ts
const messages = await fetchMessagesByHistoryId(connectionId, storedHistoryId);
if (messages.length === 0) {
  await advanceCursor(connectionId, historyId);   // nothing to lose — safe to advance
  return;
}
const results = await Promise.allSettled(messages.map(m => detectDeal({ athleteId, connectionId, message: m })));
// ...tally...
await advanceCursor(connectionId, historyId);      // only after processing
```
Because this makes re-fetch more likely, it **must** ship with Fix 2 (else every recovered message
re-burns 3 Kimi calls).

### Partial-batch policy — the one decision to make
When some messages in a push fail (`rejected`), what happens to the cursor?
- **Chosen (pragmatic):** advance after the batch regardless of per-message failures — avoids a
  "poison message" freezing the cursor forever. Transiently-failed messages are recovered by the
  cron `syncRecent` backstop, made cheap by Fix 2's idempotency gate. **Every message the cursor
  advances past on failure is logged with its Gmail id + a count** (`droppedIds`, `droppedCount`) —
  so if the cron backstop also misses it, it left a trace instead of vanishing silently. That log
  is the metric to watch; a nonzero `droppedCount` is the signal to prioritize the durable queue.
- **Alternative (strict no-loss, not chosen):** advance only if zero rejections; needs an
  attempt-counter / dead-letter to avoid a poison message stalling the cursor. More code.

### Honest scope limit
Because we ack Pub/Sub first (`:41`), a hung/throttled instance can still fail to finish — the
reorder recovers those via the **next notification + cron**, not immediately. Eliminating the window
entirely requires the **durable queue** (enqueue+ack, worker processes) — deferred with the wrapper.
This changeset shrinks the loss window from "any post-ack reclaim" to "a message that both errored
and isn't re-listed by cron," and makes all re-processing cheap.

## Tests
- **Fix 1 (unit, hermetic):** `withTimeout` rejects when the inner promise outlives `ms`, resolves
  when it beats `ms`, propagates inner rejections, clears its timer. Added as
  `server/lib/withTimeout.test.ts` (pure, no DB). Manual: force a hung Vertex call (e.g. point at an
  unresponsive endpoint) → `detectDeal` returns in ~30s with a "timed out" error, and the slot + DB
  connection are released (pool `idle`/`waiting` counts recover) instead of hanging indefinitely.
- **Fix 2 / Fix 3 (integration):** these touch the DB, which our current jest setup can't cover
  hermetically. Options: (a) a lightweight integration test against a throwaway Postgres, or (b)
  extract the *ordering* into a documented manual-verification checklist:
  - redeliver the same Pub/Sub notification twice → second run logs `already_processed`, **zero**
    Kimi calls, no duplicate deal row.
  - simulate a mid-batch throw (one message's `detectDeal` rejects) → cursor behavior matches the
    chosen partial-batch policy; a follow-up notification re-fetches and the idempotency gate skips
    the already-recorded messages.
  Recommend (a) if we're standing up any integration harness; otherwise (b) + a code-review of the
  reorder is proportionate for a 3-line change.

## Sequencing
Ship Fix 1 + Fix 2 + Fix 3 together (Fix 3 depends on Fix 2). Small, correctness-only, no new infra.
The scale wrapper (gate + retry consolidation + Gemini routing) and the durable queue remain
deferred to `llm-concurrency-spec.md`, triggered by multi-mailbox load.
