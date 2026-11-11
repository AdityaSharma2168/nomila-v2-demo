# R1 deal-scoring — deferred follow-ups

Context: the score is now grid-derived (`server/skills/dealScoreGrid.ts`) — economics ×
fit → 1–10, with a reconciliation layer tying the recommendation to the score. The items
below were deliberately deferred; they're the known gaps, in rough priority order.

## 1. Fit + red-flag prompt rubric — flag-precision (correctness, not just tuning)
**Reclassified from "optional fit-inflation cleanup" to a correctness item**, because the missing
rubric already produced a **real false-delete**. `SCORE_SYSTEM` asks Kimi for `sportFit`/`audienceFit`
and `redFlags` with **no rubric** — and Lilyeve, a normal product-gifting deal, came back with a
`redFlag` of *"no cash for a known-rate athlete"*, **directly against the prompt's instruction that
absent/missing cash is NEVER a red flag**. The red-flag floor would have **deleted** it; only the
reconciliation guardrail (delete requires Kimi *also* recommending delete) demoted it to `reject`.
So a code guardrail is currently *compensating* for Kimi ignoring an explicit instruction — brittle.
The real fix is precise flagging at the source: restate that absent/product-only/commission-only cash
is an **economics** signal, never a `redFlag`.

The same rubric also fixes the `great/great` **fit inflation** (a TV brand / tourism board / hotel
rated "great" for a soccer player) and the inconsistent gifting recommendations. Fit anchors:
`great` = exact sport / its gear or governing body; `good` = adjacent/athletic; `fair` =
lifestyle/consumer, loose tie; `poor` = none — reserve `great` for genuine alignment.

## 2. Summarizer: tag contests / prize-only as no-cash  (the "Manychat" gap)
`threadSummarizer` extracts `key_details.offer_struct`, but a **contest / prize-only** pitch
(e.g. Manychat — "win a Times Square billboard") is left `unit=null` (reads as "no offer yet"),
so the known-rate no-cash → BELOW rule doesn't catch it and it scores fair/negotiate instead of
poor. Add a `unit` value (e.g. `contest` / `prize_only`) or map it to `commission_only`-style
no-cash so it's positioned BELOW for a known-rate athlete.

## 3. Consumer-promo / no-deliverable detection  (the "Chipotle" gap)
A consumer rewards promo with no deliverables and no partnership (e.g. Chipotle "free queso")
is not a real deal. Today it scores fair/negotiate (unknown-rate → N/A economics, no red flag).
Detect "no deliverables + consumer promotion" at classify/summarize time and route it to
delete/reject regardless of rate. Distinct from the pay-to-play red flag (Wells Fargo).

## 4. Surface fitRead / economicsState on the card
Backend now returns `fitRead {rating,label}` and `economicsState {state,read}`, but the client
(`use-deals.ts` `ApiDealScore`, `DealCard`) doesn't consume them. Surfacing a "fit" chip +
economics line is what makes a `fair` great-fit deal read as "strong fit, terms not there yet,
negotiate" rather than a rejection. ~30–40 lines, additive, no migration.

## 5. One-time gated re-score of existing deals
New deals get grid scores on detection; existing rows keep their old holistic scores until a
one-time re-score. Sequence it close to the deploy so the inbox isn't mixed. Marker-guarded,
run after a full dry re-score is reviewed. Writes to the DB — keep it gated.

## Notes on current guardrail behavior (intentional, documented here so it isn't "fixed" by accident)
- `delete` requires a red flag AND Kimi independently recommending delete; a lone soft flag
  declines (reject), never dismisses. Keep-visible bias — `reject`/`delete` are both soft
  (status=`rejected`, visible under the Declined filter, one-tap Reopen; no hard delete exists).
- Kimi recommendations MORE POSITIVE than the score are kept (not coerced down) — the holistic
  judge may see signal on thin/unpriced threads — EXCEPT a poor + explicit-no-cash deal, which
  declines (2′). Priced-but-low (TITAD) and unpriced-yet (Starot) are spared.
