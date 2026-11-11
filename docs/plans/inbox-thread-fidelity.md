# Inbox Thread Fidelity — Fix Plan

> **Status (2026-07-16):** Phases 0–3 implemented and committed
> (branch fix/inbox-thread-fidelity; all server suites green).
> Pending: run `_cleanupEchoMessages.ts --apply` and `_reextractBodies.ts
> --apply` against prod (dry-runs validated), decide branch/PR topology,
> Phase 4 (SENT ingestion) unstarted.

**Problem:** three user-visible bugs in the deals conversation experience:

1. **Messy bubbles** — thread messages render raw CSS/HTML fragments, empty bodies,
   or contain the entire quoted "On … wrote:" history; ordering sometimes shuffles.
2. **Mirror messages** — a reply sent from the app also appears as an *inbound*
   message from the other side (white-bubble twin of the black bubble).
3. **Wrong turn state** — "Your turn / Their turn" and LATEST COMMUNICATION on the
   deal card go stale or flip the wrong way after the athlete replies.

All three are **data problems, not rendering problems** — `ThreadScreen.tsx` and
`DealCard.tsx` faithfully render what the API returns.

---

## Part 1 — How it works today

Two tables: `inbox_threads` + `inbox_messages` (one row per message, `direction`
= `inbound|outbound`). Three writers:

```
INGEST (direction hardcoded "inbound", dealDetector.ts:407)
  ├─ Gmail Pub/Sub webhook  → history.list(labelId=INBOX)   webhooks.ts:50, gmail.ts:247
  ├─ cron poll              → q="is:unread newer_than:2d"   gmail.ts:440
  └─ 90-day backfill        → q="in:inbox after:…"          gmail.ts:200

IN-APP REPLY (direction "outbound", received_at = server now)
  └─ POST /inbox/threads/:id/reply → sendGmailReply → insert  inbox.ts:103,323

(nothing records replies sent from the native Gmail app — SENT is never ingested)
```

Read path: `GET /inbox/threads/:id` → messages `ORDER BY received_at ASC LIMIT 30`
(inbox.ts:82-87) → bubbles by `direction` (ThreadScreen.tsx:51).

Turn state: `summarizeThread()` (Kimi call) writes `conversation_state` JSONB on the
thread; the deal card reads `key_details.awaiting_response_from`
(use-deals.ts:174 → DealCard.tsx:498-507).

### Root causes

| # | Bug | Root cause | Where |
|---|-----|-----------|-------|
| 1 | messy bubbles | No HTML→text: takes top-level `text/plain` part, else falls back to **raw payload body** (raw HTML for html-only mail). Comment claims "html stripping" — none exists. No recursion into nested multipart → empty bodies. 4000-char truncation mid-content. | gmail.ts:157-160, 284-289 |
| 2 | messy bubbles | Quoted reply chains ("On … wrote:", `>` blocks) never stripped → one bubble contains the whole prior thread. | ingest (missing) |
| 3 | messy bubbles | `received_at` = sender-controlled RFC 2822 `Date` header (inbound) vs server `now` (outbound) → bad headers shuffle ordering. Gmail's `internalDate` is not captured. | dealDetector.ts:273,410; gmail.ts:297 |
| 4 | messy bubbles | Thread endpoint `ASC LIMIT 30` keeps the **oldest** 30 — newest replies silently dropped on long threads. (Summarizer had the same bug; fixed there with desc+reverse, not here.) | inbox.ts:82-87 |
| 5 | mirror messages | Own app-sent reply re-enters via ingest (multi-inbox delivery / self-addressed mail), gets hardcoded `inbound`. Per-mailbox Gmail id differs from the outbound row's, so gate 1a can't match; the preserved-thread path records **any** message on a deal thread unfiltered. | dealDetector.ts:259-301 |
| 6 | wrong turn | Deployed code only re-summarizes on inbound ingest — an outbound reply never flips the turn until the brand's next email. | inbox.ts (fixed in WIP) |
| 7 | wrong turn | Mirror message (#5) lands *after* the reply → last message is inbound again → flips back to "Your turn". | — |
| 8 | wrong turn | Client: `staleTime: Infinity`, no focus/interval refetch (query-client.ts:75-77); reply mutation invalidates only the thread query (use-thread.ts:46), never `["/api/v1/me/deals"]` → badge frozen until pull-to-refresh. | client |
| 9 | wrong turn | Turn update rides on LLM success: `summarizeThread` bails before the mechanical direction flip if Kimi fails/unparses → stale turn + stale `last_contact`. | threadSummarizer.ts:100-104 |
| 10 | wrong count | `message_count` incremented unconditionally even when the insert is deduped by `onConflictDoNothing` → drift; phantoms inflated it further. | dealDetector.ts:280-287, 369-381 |

### Confirmed in production (2026-07-16, prod DB via cloud-sql-proxy)

The screenshot thread ("Aaron, our big promotion is here", `f5354051-…`) reproduces
all three bugs in 3 rows: an inbound body that is raw HTML (`<!doctypehtml><html…` →
the CSS-junk bubble), the athlete's reply stored **twice** (inbound 03:10:09 +
outbound 03:10:09.64, identical body — the mirror bubbles), and `message_count = 4`
vs 3 actual rows. Fleet-wide:

| Metric | Count |
|---|---|
| Phantom inbound echoes (Message-ID match with an outbound row) | 9 |
| Phantom inbound echoes (identical body, same thread) | 11 |
| Threads whose stored `awaiting_response_from` contradicts the actual last direction | 52 / 257 with state |
| Threads with `message_count` ≠ actual row count | 80 |
| Messages storing raw HTML/CSS bodies | 54 |

All bugs date to the feature's origin (summarizer 2026-06-02 `a0e63e8`; reply
endpoint + thread screen 2026-06-04 `9a97ed5`/`0c02ff8`); the fixes exist only in
the working tree (`git log -S message_id_echo --all` is empty).

Ops check resolved: Cloud Run `run.googleapis.com/cpu-throttling = false` (CPU
always allocated) — fire-and-forget summarize/rescore is safe as designed; Phase
2.4 needs no migration.

---

## Part 2 — Fix plan

### Phase 0 — Ship the WIP that already exists (split off the Stripe branch)

Uncommitted on `feat/stripe-payments` right now, tangled with unrelated test-page
CSP work (`server/index.ts`, `securityHeaders.ts`, `test-auth.html`):

- **Echo gate** (dealDetector.ts:188-201 + ingest test) — skips ingest of any
  message whose RFC 2822 `Message-ID` is already recorded for the athlete. Fixes #5
  for future messages.
- **Post-reply summarize** (inbox.ts:344-350 + reply tests) — fixes #6.
- **Summarizer turn mechanics** (threadSummarizer.ts + new test + fixtures) —
  desc+reverse window fix; code owns `awaiting_response_from` from last direction.

Action: commit these hunks (+ `threadSummarizer.test.ts`, `__fixtures__/`) on their
own branch/PR, separate from the CSP hunks and from Stripe work. Deploy.

### Phase 1 — Close the echo-gate gaps + clean existing data

1. **Self-sender guard.** The gate is blind when the outbound row's Message-ID
   readback failed (`sendGmailReply` is best-effort, gmail.ts:381-388 → stored
   null). Add a second guard in `detectDeal`: skip (or record as `outbound`) any
   ingested message whose `From` address equals any of the athlete's connected
   Gmail addresses (`connectedAccounts.platform_username`). Cheap, athlete-scoped.
2. **Backfill cleanup script** (`server/scripts/cleanupEchoMessages.ts`):
   - delete `inbound` rows whose `gmail_message_id_header` matches an `outbound`
     row for the same athlete (the existing phantoms);
   - recompute `message_count` per affected thread from an actual `COUNT(*)`;
   - re-run `summarizeThread` on affected threads so turn state heals.
3. **Fix the counter at the source** (#10): make inserts `.returning({id})` and
   only increment `message_count` when a row was actually inserted — or drop the
   counter and compute it in the list query.

### Phase 2 — Turn state that can't go stale

1. **Mechanical write, no LLM dependency** (#9): hoist `awaiting_response_from` +
   `last_contact` out of the Kimi success path. On every message insert (ingest and
   reply), merge them into `conversation_state.key_details` directly from the data
   we already have (last direction, max received_at). Kimi keeps enriching the
   judgment fields (offer, ask, summary) async; failure no longer freezes the turn.
2. **Reply endpoint ordering**: await the mechanical write before `res.json` (it's
   one UPDATE); keep the LLM summarize fire-and-forget.
3. **Client invalidation** (#8): in `useThreadReply.onSuccess`, also invalidate
   `["/api/v1/me/deals"]`. Because the mechanical write is synchronous (2.2), the
   refetch can't race the summarizer for the fields the badge needs.
4. **Ops check**: confirm the Cloud Run service runs with CPU always allocated;
   with request-only CPU, post-response work (webhook processing, fire-and-forget
   summarize) can be starved. If request-only, move summarize/rescore behind the
   internal cron endpoint or await them.

### Phase 3 — Thread rendering fidelity

1. **One shared MIME extractor** (`server/lib/emailBody.ts`), used by both
   `fetchFullMessage` and `fetchMessagesByHistoryId` (currently duplicated):
   - walk the MIME tree recursively; prefer `text/plain`, else `text/html`
     converted to text with `node-html-parser` (already a dep): drop
     `<style>/<script>`, take textContent, collapse whitespace;
   - strip quoted history heuristically: cut at `^On .* wrote:$`,
     `^-+ ?Original Message`, `^From: … Sent: …`, `________________`, trailing
     `>`-quoted blocks;
   - truncate 4000 chars *after* cleaning.
2. **Reliable ordering** (#3): capture Gmail `internalDate` (epoch ms, format=full
   already returns it) and use it for `received_at`; Date header as fallback only.
3. **Thread endpoint window** (#4): `ORDER BY received_at DESC LIMIT 50` +
   reverse in code — same pattern as the summarizer fix.
4. **Body backfill** (best-effort script): for stored bodies that look like raw
   HTML/CSS, re-fetch via `external_message_id` + `connected_account_id` and
   re-extract with the new pipeline; where the account is gone, run the cleaner
   over the stored text.

### Phase 4 (optional, later) — Replies sent outside the app

Ingest currently never sees SENT mail, so a reply from the native Gmail app (a)
never appears in the thread and (b) leaves the turn stuck on "Your turn" forever.
Fix: include SENT in the watch/history processing for *known deal threads only*,
recording matches as `direction: "outbound"` (keyed by `From` == connected
address). Bigger blast radius — scope it separately.

---

## Part 3 — Validation

- **Unit fixtures** for the MIME extractor: nested multipart/mixed→alternative,
  html-only, plain+quoted chain, CSS-in-plain-text (the Santa Cruz Paleo case).
- **Ingest tests**: self-sender guard skips From==connected-address; echo gate
  already covered by the WIP test.
- **Thread endpoint test**: >50-message thread returns the *newest* window in
  chronological order.
- **Turn tests**: mechanical turn persists when the Kimi mock throws; reply flips
  `awaiting_response_from` to `brand` before the response returns.
- **Cleanup script**: dry-run mode printing rows it would delete + count deltas.
- **Manual**: reply to a deal thread in the app → no mirror bubble; card flips to
  "Their turn" without pull-to-refresh; CSS-junk thread renders clean after
  backfill.

## Non-goals

- Instagram DM threading (separate path; `is_echo` already handled in webhook).
- Outlook parity (`outlook.ts` shares `detectDeal`, so gates apply; body
  extraction there is a separate audit).
- Classifier precision (covered by `deal-classifier-precision.md`).
