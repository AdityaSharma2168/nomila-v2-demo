# Issues Log — scoring / LLM / data-quality

Issues spotted while building, that are **out of scope for the current work stream** but need
fixing. Workflow: **log → discuss the fix with the founder → a parallel session implements it**
(after agreement). The main build does NOT stop for these.

Status: `spotted` → `discussed` (fix agreed) → `queued` (parallel session running) → `fixed`.

---

## ISSUE-1 · Rate: no user-set floor + stale snapshots baked into voice  ·  status: SUBSTANTIALLY DONE (low remainder)
**Severity: was high → now LOW** · Items #1–5 shipped + verified (v3 promoted, per-type floors, re-score,
per-deal override, fresh voice). Only remainder: delete dead v7 `computeDealTypeRates`/`applyPAVFloor`
(follow-up below). **Reframed 2026-07-24 with founder's rate model.**

**The model (founder):** rates are **calculated *suggested* rates per deal type** (post / appearance /
autograph / …) that update over time (`rate_card`, `rateService.ts`). A deal's score uses the rate *at
score time* — so an old figure is a snapshot, not a bug. What's missing is a **floor rate the athlete
sets**, which scoring + the voice should use; and per-deal she can override it in negotiation.

**Evidence of the two sub-problems:**
- Voice says *"$1,108 rate"* while current suggested `rate_card.headlineSocial.ratePerPost.mid` = **$835**
  and old scores cite **$861** → stale snapshots baked into scorer prose.
- No athlete-set floor is used by scoring or the voice today.

**What already exists (verified):** `athletes.deal_preferences.minimum_rate` + save/get API
(`POST/GET /deals/preferences`, `deals.ts:539-602`); the *draft* endpoint already reads `minimum_rate`
(`deals.ts:338`). Missing: **UI to set the floor**, and wiring the floor into **scoring** (`scoreDeal`)
and the **voice** (`composeDealVoice` / `resolveAthleteRate`).

**Agreed fix (feature, not just a bug):**
1. **Floor-rate UI** — a Settings control to set `minimum_rate` (backend already accepts it).
2. **Wire the floor into scoring** — `scoreDeal` should evaluate offers against the floor (+ suggested rate).
3. **Fresh rate in the voice** — reference the *current* suggested rate / floor at render, not the stale
   figure baked in old score prose. `resolveAthleteRate` resolves the current suggested; add a
   `resolveFloor` reading `minimum_rate`. Durable: scorer should stop baking the absolute number into prose.
4. **Per-deal override** — the negotiate composer lets her pick a different rate for one deal (WS2 composer).
5. (Optional) a re-score pass so existing deals reflect the current rate/floor.

**Parallel-session candidate:** yes — items 2/3/5 (scoring + voice + re-score) coordinate with Aaron's
scoring work (`feat/r1-scoring-recalibration`); item 1 (floor UI) is a small client task; item 4 rides WS2.

**DECISION (founder, 2026-07-24): promote v3 `rate_card`, retire v7 `deal_type_rates`, wire v3 everywhere.**
Root cause was a half-finished v7→v3 migration: v3 built as SHADOW but client/agent surfaces already used
it, scorer stayed on v7 → $1,108 (v7) vs $835 (v3) live. Scoring rule: **floor if set, else v3 suggested mid.**

**Progress (2026-07-24):**
- [x] **#1 Floor UI (per-type)** — `RatesFloorSection` (now reads v3 `rate_card`, matches Brand screen);
  `PATCH /preferences` extended for `minimum_rates` (per-type, deep-merged).
- [x] **v3 promotion / v7 retirement (core):** `deriveDealTypeRates(rateCard)` maps v3→legacy shape;
  `scoreDeal` reads v3 `rate_card` + floor (floor-else-v3-mid); writers `refreshScores` + `researchAthlete`
  store v3-derived `pav`+`deal_type_rates`; fixed a latent `dtr as RateCard` miscast in the score grid.
  **VERIFIED on real deals: scoring now says $835, not $1,108.** Client + server typecheck clean.
- [x] **#2 scoring uses floor** — done (floor-else-suggested rule in `scoreDeal`).
- [x] **#3 fresh rate in voice** — subsumed: re-scored prose carries v3 numbers; voice reads it.
- [x] **#5 re-score pass** — DONE (2026-07-24). Floors set for the 3 impacted athletes (Mia/Lilia/Aditya)
  = high of each v3 range; `athletes_current.pav`/`deal_type_rates` backfilled to v3 for all 8 rate-card
  athletes; all scored deals re-scored (205 batch + straggler sweeps). **Verified: 0 v7 PAV ($49,626) and
  0 stale-rate across the 3 athletes; the only remaining $1,108 is a genuine Finish Line offer vs the
  $1,044 floor.** Exposed ISSUE-6 (silent no-op) — mitigated with retry+verify sweeps.
- [x] **#4 per-deal override** — `NegotiateComposer` (WS2, merged): three-number strip floor/suggested/
  counter, review-only draft, explicit send through existing reply plumbing (co-pilot, no auto-send).
- [ ] Follow-ups: delete dead v7 `computeDealTypeRates`/`applyPAVFloor` (still called inside `computeScore`;
  needs a small `ScoreResult` refactor) · make the score-refresh cron re-score deals so v3 stays fresh ·
  `fetchSocialData` still writes v7 `deal_type_rates` on ingest (self-corrects next `refreshScores`;
  `scoreDeal`/floor-UI read `rate_card` directly, so scoring is unaffected).

**Rate-usage answer (documented for reference):** SUGGESTED rate (per-type `rate_card`/`pav`) = market
benchmark → used in *scoring* (`rateVsMarket`) and as the negotiation *anchor*. FLOOR (`minimum_rate` /
now `minimum_rates`) = walk-away minimum → used in *negotiation drafts* today, NOT yet in scoring (that's
#2). They're complementary: "is it good vs market?" (suggested) + "will I take it at all?" (floor).

---

## ISSUE-2 · Score distribution compressed — zero "great", most 6–7  ·  status: spotted
**Severity: high** (the Brief can't surface a genuinely great opportunity because none are rated great)

**Evidence:** across ~188 deals: 92 fair / 41 poor / 34 good / **0 great**. Blank/truncated emails were
also being scored (the WS3 parse gate now stops the blanks).

**Root cause:** scorer calibration — verdict thresholds and/or rubric compress everything to the middle.

**Proposed fix (for discussion):** recalibrate the scorer rubric/thresholds; evaluate against the golden
anchors (`seedGoldenAnchors` / `evaluateRates`). Bigger effort; overlaps ISSUE-1.

**Parallel-session candidate:** yes (scoring recalibration — the big one; `feat/r1-scoring-recalibration`).

---

## ISSUE-3 · Voice "stapling" — "Push for {negotiate_term}" reads clunky  ·  status: spotted
**Severity: low** (reads awkward, not wrong)

**Evidence:** *"Push for Convert to $500-750 flat fee"*, *"Push for Clarify expected deliverables"* —
`negotiate_terms` are imperative/noun phrases that don't follow "Push for" grammatically.

**Proposed fix (for discussion):** (a) normalize imperative terms in `buildPosition` (small template tweak),
and/or (b) activate the LLM formatting seam already marked in `dealVoice.ts` (smooths all stapling; must
re-run `assertNoUnbackedFigures` with STRUCTURED-only fields on the model output).

**Parallel-session candidate:** yes (small — template tweak now; LLM pass is a later, bigger piece).

---

## ISSUE-4 · Misclassification — newsletters as FAN, recruiting/agency as PAID  ·  status: spotted
**Severity: medium**

**Evidence:** FAN pile = a Red Bull newsletter, "hm", "Spain vs Austria"; "Athletes Untapped" (recruiting
Mia as a *coach*) scored as PAID; a TOGETHXR *community-run invite* surfaced as a deal.

**Root cause:** classifier edge cases (Aaron's v2 cut false positives but these remain).

**Proposed fix (for discussion):** classifier refinement (Aaron's domain) + the WS5 "reclassify" recovery
net as a UI backstop ("Treat as a deal" / "Not a fan").

**Parallel-session candidate:** yes (classifier tuning — coordinate with Aaron), plus WS5 does the backstop.

---

## ISSUE-5 · `score.draft_points` computed server-side but dropped on the client  ·  status: FIXED (2026-07-25)
**Severity: low** (a nicer-chips gap, not wrong data)

**RESOLVED (DTO enrichment):** `mapToDealItem` now surfaces `draftPoints` on `DealItem`;
`resolveDraftPoints(draftPoints, negotiateTerms)` prefers it over negotiate_terms, then static. Tested.

**Evidence:** `ApiDealScore.draft_points?: string[]` arrives from `GET /deals` (use-deals.ts:23) but
`mapToDealItem` never copies it onto `DealItem`, so the client can't see it. The WS2 Negotiate composer
(draft_points chips) therefore sources its chips from `deal.negotiateTerms` (`score.negotiate_terms`) and
falls back to a static starter set — see the seam comment in
`client/components/deals/brief/negotiateLogic.ts` (`resolveDraftPoints`).

**Proposed fix (for discussion):** surface `draft_points` on `DealItem` in `mapToDealItem` (one line), then
prefer it over `negotiateTerms` in `resolveDraftPoints`. Owner: whoever holds `use-deals.ts` (out of the WS2
composer file lane, so left untouched here).

**Parallel-session candidate:** yes (trivial client mapping change).

---

## ISSUE-6 · `rescoreThread` silently no-ops when `scoreDeal` returns null  ·  status: spotted
**Severity: medium** (data-integrity: hides failures in any batch re-score)

**Evidence:** the #5 re-score batch reported 205/205, 0 failures, yet ~4 of Mia's deals kept the
retired v7 figures ($1,108/post, $49,626 PAV). A fresh single-thread rescore fixed each instantly
(→ "$1,044 floor / $21,632"). Root cause: on a transient Kimi parse failure `scoreDeal` returns
`null`; `rescoreThread` does `if (!score) return;` (dealDetector.ts ~1090) — leaving the OLD score
in place and returning **void**, so the batch counts it as a success (✓). Silent no-op.

**Fix (for discussion):** have `rescoreThread` signal outcome (return a boolean / throw on null) so
batch callers can retry, and/or add a retry-with-backoff inside `scoreDeal` around the Kimi call.
Interim mitigation already applied: `_fixStaleScores.ts` re-scores stragglers with retry + a
post-verify that the v7 PAV token is gone. **Parallel-session candidate:** yes (small server fix).

**Also fixed alongside (2026-07-24):** `athletes_current.pav` + `deal_type_rates` held stale v7 for
all 8 rate-card athletes (the v3 writers hadn't run) → client surfaces read v7. Backfilled to v3 via
`_syncCurrentToV3.ts` (derives from `rate_card`). The scorer was already v3-correct (reads `rate_card`
+ floor directly), so this only affected stored/displayed columns, not scoring.

---

## ISSUE-7 · Files "Lapsed" stamp uses `detectedAt` as a recency proxy  ·  status: FIXED (2026-07-25)
**Severity: low** (stamp can be slightly off, never wrong data)

**RESOLVED (DTO enrichment):** `lastMessageAt` is now surfaced on `DealItem`; Files `dealActivityMs`
(and The Week's) prefer it over `detectedAt`, so lapse/recency use real last-activity. Falls back to
detection time when absent.

`FilesView`/`dispositionStamp` compute the 45-day "Lapsed" disposition from `deal.detectedAt` because
the client `DealItem` doesn't surface raw `last_message_at`. Mapping `last_message_at` onto `DealItem`
(owned by the deals hook lane) would make lapse exact. **Parallel-session candidate:** yes (trivial).

---

## ISSUE-8 · Reclassify doesn't upsert a `deals` row  ·  status: FIXED (2026-07-25)
**Severity: medium** (affected the 5C/5E recovery flows)

`POST /inbox/threads/:id/reclassify` wrote `classification`+`score` and flipped the thread to
`deal_detected`, but `GET /deals` reads `.from(deals)` — so a reclassified fan/unreadable thread showed
via the thread endpoint yet NOT in the canonical deals list (Brief/Files).

**RESOLVED — recovery (add) + demote (set aside), both reversible:**
- Extracted `detectDeal`'s deal-upsert into a shared **`upsertDealForThread`** (one deal per thread,
  idempotent — keyed on `thread.deal_id`, so it can NEVER duplicate). Reclassify now calls it on a
  scoreable result → the deal actually surfaces (**promote**).
- **`demoteDealThread`** — when reclassify re-reads an existing deal as non-commercial: archives the
  thread (leaves the Brief), keeps the `deals` row, and appends a **reversible `agent_actions` receipt**
  → The Week "Set aside by Nomila" (Undo) + Files (Pull it back).
- **Automatic demote** (`maybeAutoDemote`, in `detectDeal`'s non-scoreable branch — reuses the
  classification already run, **zero extra LLM cost**): a new message on an existing deal-thread that
  re-reads as FAN/NOISE sets it aside *silently but surfaced*. Hard guardrails: only a **category flip to
  non-commercial** (never a low SCORE), **confidence ≥ 0.8**, and the deal must be **untouched** (status
  `detected`) — the moment she negotiates/accepts, the agent never pulls it out on its own.
- Latent bug fixed alongside: archiving a thread didn't remove it from the Brief (Brief filtered on deal
  status, not thread status). Surfaced `threadStatus` on `DealItem`; Brief now excludes `archived`.
- Tests: 7 new (`dealDetector.demote.test.ts`) — upsert idempotency, demote receipt, all four auto-demote
  gates. Founder decision (2026-07-25): auto-demote OK because it's communicated + accessible + reversible.

---

## ISSUE-9 · WS5 agent_actions: write-path + auto-actions not yet wired  ·  status: spotted
**Severity: low** (foundation is in; wiring is the incremental next step)

The `agent_actions` table + `GET /agent-actions` + undo + `writeAgentAction()` helper exist, but (a) no
path yet CALLS `writeAgentAction` (manual PATCH filing is intentionally receipt-free; the 24h
`held_until` auto-decline scheduler/sender isn't built), (b) `POST /agent-actions/:id/wrong` is a stub
sink (`recordEvalFixture` — marked seam), (c) reclassify classifies off the latest inbound message only,
not a full-thread concat. All expected per the "incremental" WS5 plan; The Week (5B) build will exercise
these. **Parallel-session candidate:** yes.

---

## ISSUE-10 · WS5 The Week (5B): receipt rows need a brand label + the deal sections lean on `detectedAt`  ·  status: spotted
**Severity: low** (surface renders honestly today; these are enrichment + accuracy follow-ups)

Spotted while building `TheWeekView` (5B):

1. **Set-aside rows have no reliable brand identity.** `agent_actions.payload` has no guaranteed shape, so
   `weekLogic.actionSubject()` reads `payload.brand_name`/`brand`/`advertiser`/`subject`/`title` when present
   and otherwise falls back to the honest-but-generic "a deal" / "a message" (never fabricates a name, and no
   logo). When the write path (ISSUE-9) starts calling `writeAgentAction`, it should log a **stable brand label
   (+ domain)** into `payload` so the receipt can show the real brand + `BrandLogo` like every other surface
   (see memory: "Brand logos everywhere"). Until then the fallback is intentional.

2. **The 24h `held_until` is displayed as an *undo window*, never as an auto-send** — because the send-
   suppression/scheduler isn't built (ISSUE-9). Copy is deliberately "On hold · Xh left to undo", not "sends in
   Xh". When the sender lands, revisit the framing so it stays action-honest.

3. **Arrived / You moved / Still waiting derive recency from `detectedAt`** (the only ISO date on `DealItem`) —
   same proxy limitation flagged for Files in **ISSUE-7**. A true `last_message_at` on the client DTO would make
   the week-window split (and lapse) exact. **Parallel-session candidate:** rides ISSUE-7's fix.

---

## ISSUE-11 · From People (5E): `FanMessageCard` action reads "Reply", not "Open the DM"  ·  status: FIXED (2026-07-25)
**Severity: low** (behavior is safe; copy is imprecise)

**RESOLVED:** `FanMessageCard` now takes an optional `actionLabel` (default "Reply", unchanged for the
classic view); From People passes "Open the DM". Still never auto-sends — the button opens the DM to type.

The reused `FanMessageCard` button says "Reply"; the 5E spec wants "Open the DM". Behavior is already
safe (opens the composer, she types — never auto-sends), only the label is off. Clean fix: an
`actionLabel?` prop on `FanMessageCard` (out of the 5E file lane). **Parallel-session candidate:** yes (trivial).

---

## ISSUE-12 · From People (5E): sender-mute is device-local only  ·  status: spotted
**Severity: low**

"Mute senders like these" persists to AsyncStorage (`nomila.people.mutedSenders.v1`) and filters
client-side. No cross-device sync, and muted DMs are still fetched then hidden (not un-ingested) until a
server mute endpoint + a `mute_sender` write (the `agent_actions` action allowlist already includes it)
land. Seam marked in `people/muteStore.ts`. **Parallel-session candidate:** yes (server mute endpoint).

---

## ISSUE-13 · In Flight (5F): raw offer history not surfaced on `DealItem`  ·  status: FIXED (2026-07-25)
**Severity: low** (timeline is honest but often single-point)

**RESOLVED (DTO enrichment):** `mapToDealItem` now surfaces `offerHistory` (the ordered, positive-filtered
`key_details.amounts`) on `DealItem`; In-Flight `dealAmounts()` prefers it over parsing `offerDisplay`, so
real multi-step negotiations now render as a full timeline. Still money-safe (only real stated figures).

`mapToDealItem` consumes `conversation_state.key_details.amounts` only for `monthlyEstimate` and drops the
ordered array, so `DealItem` never exposes the offer back-and-forth. In-lane, In Flight's `dealAmounts()`
parses `$`-marked figures from `offerDisplay` (the honest ceiling) — a single-figure `offerDisplay` yields a
one-point timeline even after real negotiation. Fix (needs a hook edit, out of 5F lane): surface
`offerHistory?: number[]` on `DealItem` and feed it to the already-multi-step-tested `extractTimeline()`.
Cross-refs ISSUE-5 (another dropped `score`/`conversation_state` field on the client DTO).

---

## ISSUE-14 · Media-kit / Nomi Card deck shows retired v7 PAV + rates  ·  status: queued (parallel session)
**Severity: medium** (customer-facing deck contradicts the live Rate Card)

Spotted in the live app (Mia). The Brand → media-kit deck ("PRICED BY THE DATA" / "PARTNERSHIP VALUE" /
"START THE STORY") shows **v7**: "$49.6K PROJECTED ANNUAL", "$24.8K–$89.3K partnership value",
"$582/post" — while the live **Rate Card** shows **v3**: "$22K PAV", "$834/post". The deck predates the
v3 sync or reads a different source. A parallel session is investigating + fixing (deck must read v3
`rate_card`). **Not the same as ISSUE-15** (that's a baked thread summary, not the deck).

---

## ISSUE-15 · Files/Week filing notes can cite the old $1,108 rate  ·  status: spotted
**Severity: low** (historical text, not a live number)

Pilllar's Files note: *"…stating her baseline rate of $1,108 per dedicated post…"*. This is a **thread
summary** (conversation_state/aiSummary) describing what was said — likely from a draft/reply generated
when v7 was live. If $1,108 was actually SENT, the summary is accurate history (leave it); if it was a
never-sent draft, it's stale. Distinct from the score prose (re-scored) and the deck (ISSUE-14). Decide
per-case; not a blind rewrite. **Parallel-session candidate:** needs a data audit first.

---

## ISSUE-16 · The Week "The Bar" used the max per-type floor  ·  status: FIXED (2026-07-25)
**Severity: low** (read oddly, not wrong)

The Bar showed "Held your line at **$3,602**" — Mia's *ambassador monthly* floor (the max across her
per-type floors), which reads strangely against a pile of per-post offers. **RESOLVED:** `resolveFloor`
(TheWeekView) now prefers the **per-post** floor ($1,044 for Mia), then the max as a last resort — the
line most comparable to what arrives. Spec intent ("held your line at ~$835") restored.

---

## ISSUE-17 · Couldn't-read (5C): no parse_state signal + reclassify drops the human-read capture  ·  status: spotted (partly wired)
**Severity: low–medium** (surface works honestly on a heuristic today; seams to wire when deps land)

Spotted while building `CouldntReadView` (5C). Functional + honest, but leans on seams:

1. **No `parse_state` column (WS3 parse gate un-merged).** `couldntReadLogic.isUnreadable` uses a heuristic
   (no score + no classified category + no summary). `parseState` is an authoritative optional field on
   `CouldntReadThread`; when WS3 merges, map `parse_state` onto the thread row and the logic prefers it.
2. **Reclassify takes only a `threadId` — the human-read capture is dropped.** `CaptureSheet` collects
   `{ humanRead, offer, want, notes }` but `POST /reclassify` accepts no body (re-reads the STORED message),
   so those fields confirm intent but aren't persisted. Fix: let reclassify accept an optional body and have
   the classifier prefer it. Cross-refs ISSUE-8/9. **Parallel-session candidate:** yes (small server change).
3. **Thread-list feed — PARTLY RESOLVED (2026-07-25):** the orchestrator now feeds `CouldntReadView` via a
   new `useInboxThreadList()` hook (`use-inbox-list.ts`, mirrors `useFanMessages`) mapping `GET /inbox/threads`
   → `CouldntReadThread`. Still unmapped from the list payload: `hasBodyContent` (so Six-Star detection stays
   conservative — offers the WebView rather than falsely declaring empty) and a dedicated HTML body field
   (`RawEmailView` renders the single `body`; HTML-escaped bodies would show as source). **Follow-up:** add
   `has_body_content` + an HTML field to the list/thread DTOs.

---

<!-- Append new issues here as they're spotted. Keep the main build moving. -->
