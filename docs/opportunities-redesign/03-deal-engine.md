# WS3 — Deal Engine (server / algorithm)

**Goal:** the server-side changes every other stream depends on. No UI here — this is the data and
intent layer that makes the agent surface honest.

**Branch:** `feat/opps-ws3-engine` · **Depends on:** nothing · **Blocks:** WS2, WS4, WS5.

> This stream is the reason the agent can "sound competent." Ship it before the Brief, or the Brief
> will state stale numbers and score blank emails.

---

## Scope

Six changes, each independently shippable:

1. `request_terms` intent (the missing verb).
2. Parse-confidence gate (stop scoring unreadable emails).
3. Amount reconciliation + rate-at-render (kill the $200-vs-$950 and $861-vs-$1108 bugs).
4. `composeDealVoice()` — one selector both Brief and Files read.
5. Bulk PATCH endpoint (for WS4).
6. `pending_action` lifecycle scaffolding (co-pilot approval).

## Reuse

- `server/routes/deals.ts:241-518` — the draft endpoint. Extend, don't rewrite. The negotiate prompt
  at `:438` **already describes** ask-for-terms behavior in prose; we promote it to a real intent.
- `server/skills/dealDetector.ts` (Aaron's v2) — the classifier + `emptyClassification()` (`:1133`)
  already detect empties; we surface that state instead of scoring through it.
- `server/skills/threadSummarizer.ts` — `offer_struct`, `amounts[]`, `awaiting_response_from`.
- `athletes_current.rate_card.headlineSocial.ratePerPost` — the canonical rate ({low,mid,high}).

## Tasks

### 3.1 `request_terms` intent
- [ ] Add `request_terms` to `VALID_INTENTS` (`deals.ts:37`) and `INTENT_INSTRUCTIONS` (`:51`).
- [ ] Add to the client `GenerateOptions.reply_intent` union (`use-deal-draft.ts:8`).
- [ ] Map `recommendation` → intent: unpriced deals surface `request_terms`, not `negotiate`.
      (Scorer emits `negotiate` for unpriced today — `dealDetector.ts:790`; add a downstream mapping
      so the UI/verb is `request_terms` when `economicsState.state` is unpriced/tbd. Do NOT require a
      scorer retrain for v1 — map at read time.)
- [ ] Delete dead `VALID_TONES`/`DraftTone` (`deals.ts:34-35`).

### 3.2 Parse-confidence gate
- [ ] Define a parse-confidence signal on ingest (empty body / truncated HTML / timestamp-only).
      Reuse `emptyClassification()` conditions.
- [ ] Below threshold: **do not score, do not recommend, do not assign a type.** Mark the thread
      `unreadable` (new boolean/flag on the thread or a `parse_state` field).
- [ ] Surface it: add `parseState` to the deal payload / `DealItem` so the client can render the
      "Couldn't read" card (WS5). Never fall back to a thin summary that looks like a real card.

### 3.3 Amount reconciliation + rate-at-render
- [ ] **Never emit `deals.amount` as a spoken number.** Add a resolver: spoken figure precedence =
      `offer_struct.amount` → `amounts[]` (range) → `offer_display` (verbatim) → none (relational only).
- [ ] Add a **conflict flag**: if `deals.amount` differs >15% from `offer_struct.amount`, mark
      `amountConflict` so the UI uses movement phrasing ("they've come up to…").
- [ ] **Reconciliation job:** copy `offer_struct.amount` → `deals.amount` so Files stops contradicting
      the Brief. One-off script + on-summarize hook.
- [ ] **Rate at render:** every surface that cites "your rate" resolves
      `rate_card.headlineSocial.ratePerPost.mid` at read time. Remove any snapshotted rate from stored
      deal copy. (Deals currently cite $861/$1108; canonical is $835.)

### 3.4 `composeDealVoice()`
- [ ] One server (or shared) selector that composes the agent line from
      `conversation_state` + `recommendation_ui` + `economicsState.read`, with the null-fallback ladder
      (see [02](02-brief.md) field spec). Both Brief and Files call it — single source of voice.
- [ ] v1 ships **template composition** (no new LLM call); leave a seam for an LLM formatting pass.
- [ ] Post-check: any `$` figure in the output must appear verbatim in a structured field, else strip
      to relational phrasing. (Reuses the spirit of `stripInternalLeaks`.)

### 3.5 Bulk PATCH
- [ ] `PATCH /api/v1/me/deals` (plural) accepting `{ ids[], patch }` for bulk status/saved/archive.
      Mirror the single-id validation in `deals.ts:183-227`.
- [ ] Guardrail: cap batch size, require explicit action, return per-id results.

### 3.6 `pending_action` lifecycle
- [ ] Define the shape written to `deals.pending_action` (kind, draft ref, created_at, expires,
      approved_at). Comment in schema already sanctions it.
- [ ] Endpoints: create pending action, approve (→ executes via the existing reply route), dismiss.
- [ ] This is the co-pilot spine WS2's buttons call. Autopilot (auto-approve) is Phase 2.

### 3.7 Ranking server-side
- [ ] Move Brief ranking off the client score-sort (`use-deals.ts:217`). Rank by: awaiting-athlete +
      deadline proximity + thread age + score. Return a bounded, ranked "brief set" (≤ N) plus counts.
- [ ] Add thread **age** as a first-class field (staleness distinguishes live deal from fossil).

## Test plan

- [ ] **Unit:** intent validation accepts `request_terms`; rejects junk. `composeDealVoice()` fallback
      ladder (scored / no-conversation_state / unscored / no-offer / redFlags) — table-driven test.
- [ ] **Unit:** spoken-figure resolver — asserts `deals.amount` is never emitted; conflict flag fires
      at >15%; relational fallback when no structured number.
- [ ] **Unit:** parse gate — empty / truncated / timestamp-only inputs produce `unreadable`, no score.
- [ ] **Integration:** bulk PATCH updates N deals, returns per-id results, respects the cap.
- [ ] **Integration:** `pending_action` create → approve → send calls the real reply route once and
      records outbound (extend `inbox.reply.test.ts` patterns).
- [ ] **Data check (real DB):** run `composeDealVoice()` over Mia's 178 deals; manually eyeball 15
      samples for stapled-sentence / wrong-number issues; confirm 0 emit `deals.amount`.
- [ ] Existing 19 reply tests still green.

## Acceptance criteria

- No surface can state a stale `deals.amount`; rate always resolves to $835 (canonical) at render.
- Unreadable emails carry `unreadable` and no score.
- `request_terms` is a first-class, routable intent.
- Bulk PATCH + `pending_action` create/approve/dismiss all work with tests.

## Risks

- **Reconciliation job** must run before/with the Brief or the two surfaces disagree (single worst
  trust bug). Ship together.
- Template-composed voice can read stapled; acceptable for v1, flag for LLM pass.
- Do **not** attempt a scorer retrain here — map intents/ranking at read time. Retraining is Phase 2.
