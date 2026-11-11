# PR #151 — audit & hardening plan

**Reviewed:** PR #151 (commit `5fa7ce1`), author **aaronsongnguyen** (Cursor),
merged to `main` 2026-08-03. Four features: SENT-ingest/outbound threading,
cross-mailbox dedupe (Message-ID echo → thread aliases), PDF-brief extraction,
in-app draft save (+ `gmail.compose` scope).

**Verdict:** thoughtful work with tests, but it doesn't fully close the dedupe bug
it targeted and ships one real security hole. All fixes below are targeted (no
rewrite). Reuse-first: reuses the existing `onConflictDoNothing`+bail pattern,
`draftPrompt.ts` fencing, and `draftLimiter`; new only where needed (1 index, 1
`text[]` column + GIN index, timeout guards).

---

## C1 (Critical) — Untrusted PDF text is fed UNFENCED into classify/score → prompt injection
`pdfExtract.mergeBodyWithAttachments` folds PDF text into `body` under a plain
`[PDF attachment]` label; `classifyMessage` (`dealDetector.ts:791`) and the scorer
consume it raw, with no "untrusted data" guard — unlike `draftPrompt.ts:170` (same
PR) which fences brand text in `<<<EMAIL … EMAIL>>>` with "do NOT comply". A PDF
can carry invisible text (white/0pt) → hidden instructions steer classification
(fake high-confidence PAID) and injected `draft_points` reach the athlete's draft.
**Fix:** reuse the `draftPrompt` fence on the classify + score inputs; wrap the PDF
block in `mergeBodyWithAttachments` as clearly-labeled untrusted DATA.
**Watch:** re-verify a few real classifications after fencing (prompt change can
shift behavior); stored body is fenced downstream by draftPrompt already — ingest
is the hole. Future hardening: schema-locked structured extraction + hidden-text
heuristic.

## C2 (Critical) — Dual-inbox dedupe still races → the Gorjana duplicate isn't closed
Echo gate (`dealDetector.ts:213`) is check-then-insert on `gmail_message_id_header`
with **no DB unique constraint**; webhooks run concurrently (`Promise.allSettled`,
two Pub/Sub POSTs, no lock). CC'd-to-two-inboxes → same Message-ID, different
per-mailbox thread+message ids → both gates miss → **two deals**. The existing
message-insert bail only dedups `(thread_id, external_message_id)` (per-mailbox).
**Fix (reuses the bail):**
- Add partial unique index `inbox_messages (athlete_id, gmail_message_id_header)
  WHERE gmail_message_id_header IS NOT NULL` — the DB arbitrates the race.
- The final message insert already `.onConflictDoNothing()` + bails on 0 rows.
  Enhance the bail: on conflict, resolve the winning thread by Message-ID,
  `registerThreadAlias(winner, gmailThreadId)`, delete the orphan empty thread the
  loser just created → one deal.
**Dedup scope decision:** Message-ID is the authoritative key (zero false-merge).
Do NOT merge on subject/sender-alone (collapses distinct offers). Optional guarded
follow-up: `(athlete, sender)` + content-fingerprint within a short window for
non-CC separate sends. Brand-from-two-addresses (two separate emails) stays two
deals by design.

## H1 (High) — Registered aliases clobbered by re-classification
Aliases live in `classification` JSONB, which `dealDetector.ts:571/590` overwrites
wholesale (no `alias_thread_ids`) on any follow-up/upgrade → dedupe re-splits.
**Fix:** move aliases to a dedicated `inbox_threads.alias_thread_ids text[]` column
(additive) — classification writes never touch it. Bundles with H4 + the scan.

## H2 (High) — Blanket Fwd:/Fw: drop loses legitimate mail
`dealDetector.ts:273-278` drops every forward unconditionally → forwarded brand
proposals never create a deal, and forwards on a live deal thread are silently
dropped (card doesn't update/flip turns).
**Fix:** scope the drop to `!existingThreadForPreservation` (record forwards on live
deals); stop blanket-dropping new forwards — let the classifier be the noise gate;
dedupe handled by Message-ID/References.

## H3 (High) — PDF parse on ingest hot path, no timeout, size-cap after download
`extractPdfAttachments` downloads then checks `buf.length > 5MB`; `pdf-parse` runs
sync on the event loop with no timeout → a bad/bomb PDF blocks the process.
**Fix:** gate size via `part.body.size` before `attachments.get`; `AbortController`
timeout on the fetch; wall-clock `Promise.race` on `extractPdfText`.
**Follow-up:** move parsing off-thread (worker/queue); replace unmaintained
`pdf-parse@1.1.1`.
**Status (3 Nov 2026, INTERIM):** done in `server/lib/pdfExtract.ts` — pdf-parse replaced by
`pdfjs-dist` 6 (legacy build), run in a `worker_thread` with a 10 s wall-clock kill, a 256 MB heap
limit, a 384 MB RSS-growth guard, a 50-page cap and a 20 MB input cap. Still open: the parser runs
in the API's process; per the owner rule, untrusted-file parsers move into the per-task job model
(a Cloud Run job, per the sandbox design).

## H4 (High) — `registerThreadAlias` is a non-atomic read-modify-write
`SELECT classification → mutate → UPDATE` loses aliases under concurrency.
**Fix:** single atomic SQL append on the new `alias_thread_ids` column
(`array_append` + dedup). Folds into H1.

## Medium
- **M1** — clear-on-send can orphan a Gmail draft → duplicate send. Delete the
  Gmail draft awaited + retry/log BEFORE nulling `latest_draft`/`gmail_draft_id`.
- **M2** — draft-save idempotency not concurrency-safe → orphaned drafts. Serialize
  per-thread (`SELECT … FOR UPDATE`) around read-id → create/update → persist.
- **M3** — PUT `/deals/:id/draft` has no rate limiter. Add the existing
  `draftLimiter` (already on the POST route).

## Low (noted, not blocking)
`pdf-parse@1.1.1` unmaintained; CRLF header injection in the raw draft builder;
no length cap in `saveThreadDraft`; serial-only tests give false confidence (add a
genuinely concurrent two-mailbox test).

---

## Order
1. C1 fence + C2 index/bail  →  2. H1/H4 alias column  →  3. H2 forward scope +
H3 guards  →  4. Mediums.
Coordinate with Aaron (his merged code); tag him on the PR.
