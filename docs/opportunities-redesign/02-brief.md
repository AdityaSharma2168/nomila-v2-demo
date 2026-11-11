# WS2 — The Brief (co-pilot decision surface)

**Goal:** the default view. Mila states ≤3 recommended actions in plain language + the "also this
week" rollup; the athlete approves / edits / overrides. Tapping a deal opens the decision sheet;
committing opens the negotiate composer.

**Branch:** `feat/opps-ws2-brief` · **Depends on:** WS3 (voice, rate, pending_action), WS1 (shell).
**Blocks:** flipping the default tab to Brief.

---

## Scope

**In:** the Brief tab content — greeting/debt line, the ask cards (agent-voice, per-type commitment
row + fact line), the "also this week" rollup rows, the decision sheet, the negotiate composer.
**Out:** the batch flow (WS4), Files/Week/Gifting/People/InFlight surfaces (WS5), the engine (WS3).

## Reuse

- **`recoCard`** style from `DealCard.tsx` (`#FFF8FC` + 3px `#E84591` left border) — the ask card IS
  this, promoted to top level. Type-hierarchy inversion: Mila's line at body 16 in `text`, metadata at
  caption/muted.
- **`DealItem`** + `CATEGORY_CONFIG`/`VERDICT_CONFIG`/`STATUS_CONFIG` (`DealCard.tsx:41-143`) —
  salvage.
- **`useDealDraft`** (SSE stream) + **`useThreadReply`** + `canSend`/`openReply` fallback — the
  composer's engine, unchanged.
- **Mined from Variant B:** `opps/detail/DraftReply.tsx` (tone-chips + tappable asks, already wired to
  the real draft+send endpoints) → basis for the negotiate composer.
- **`composeDealVoice()`** (WS3) — the source of every agent sentence.
- **Decision sheet chassis:** `ScoreAnalysisSheet.tsx` container pattern; `BrandInfoSheet` reachable
  behind "The math ▸".

## The card anatomy (1 card × 2 variable slots × 6 registers)

- **Constant:** logo + `catBadge` + status pill + the `recoCard` voice region + the disclosure ladder.
- **Variable slot 1 — fact line** (type-selected): offer (PAID) · product+ask (GIFTING) · date+duration
  (MEDIA/EDITORIAL) · deadline (SCHOOL_NIL).
- **Variable slot 2 — commitment row** (from `recommendation`/category): money/terms · time · a single
  neutral "Open the form" for SCHOOL_NIL (no yes/no).
- **FAN gets no card** (routes to From People, WS5).

## Field composition (the agent line) — exact sources

| Line | Source | Fallback |
|---|---|---|
| Greeting / debt | count(asks) + `awaiting` count | count 0 → "Nothing needs you." |
| Brand + badge | `advertiser ?? brand_name`, `category` | agency-unknown → "Brand TBD via {agency}" |
| Status pill | `deals.status` | — |
| **Mila's paragraph** | `conversation_state` + `recommendation_agent` + `economicsState.read` (via `composeDealVoice`) | template ladder in WS3 3.4 |
| Fact line | type-selected structured field | omit if absent |
| Primary button | `recommendation` → verb map (incl. `request_terms` → "Ask for their budget") | "Take a look" |
| Also rows | counts by category / disposition | hide row if 0 |

**Numbers obey WS3:** never `deals.amount`; rate at render.

## Tasks

- [ ] `BriefView` component: greeting/debt line, ranked ask list (≤3 from WS3's brief set), "also"
      rollup.
- [ ] `AskCard` component from `recoCard` — voice region, fact-line slot, commitment-row slot,
      disclosure ladder ("Why? ▸ / The math ▸ / Red flags ▸").
- [ ] Commitment-row resolver (extend `dealActions.ts` shape) — 3 variants keyed on category + has-date.
- [ ] Fact-line selector (type → structured field).
- [ ] "Also this week" rows: In flight · Couldn't read · Gifting · From people · Passed (counts only;
      each routes to a WS5 surface).
- [ ] **Decision sheet** (72% detent, Brief visible behind): position-first (`recommendation_agent`),
      ladder to reasons/factors/redFlags, "The plan" (`negotiate_terms`), primary CTA = Mila's plan,
      talk-back composer.
- [ ] **Negotiate composer** (pushed full screen): three-number strip (their offer → **your ask**
      (editable) → your rate), `draft_points` toggle chips, tone Friendly/Professional (2 not 4),
      streamed draft, preflight + send. Mine `opps/detail/DraftReply`.
- [ ] Wire the primary CTA through `pending_action` create (co-pilot: preview before send).
- [ ] Empty/degraded states: unscored deal → "haven't sized it yet"; unreadable → routes to WS5 card,
      never an ask.

## Server changes

None beyond WS3 (Brief consumes WS3's ranked set + `composeDealVoice` + `pending_action`).

## Client changes

- New: `BriefView`, `AskCard`, `DecisionSheet`, `NegotiateComposer`, commitment-row resolver.
- Modified: `OpportunitiesScreen` (mount BriefView under the Brief tab; flip default at stream end).
- Salvage from `DealCard`/`DealActionSheet`, then leave them in place (retire in a later cleanup PR).

## Test plan

- [ ] **Unit:** commitment-row resolver returns the right variant per (category, has-date, recommendation).
- [ ] **Unit:** fact-line selector picks the right field per type; omits when absent.
- [ ] **Integration:** tapping a PAID ask → decision sheet → "Edit the plan" → composer → send routes
      through the real reply endpoint exactly once; status flips to `negotiating`; turn flips to brand.
- [ ] **Integration:** `request_terms` ask → composer pre-fills the "ask for budget" draft; sends.
- [ ] **Manual (`/verify`) on real data:** open Brief for Mia; confirm the 3 asks are the real
      Playermaker / Brazil / adidas-style deals; confirm no `$deals.amount` leaks; confirm rate reads
      $835; send one real counter and confirm it threads correctly in Gmail.
- [ ] **Manual:** override path — pick a non-recommended action; confirm it's respected and logged
      (feeds Phase 2 learning).
- [ ] Typecheck + all prior tests green.

## Acceptance criteria

- Brief shows ≤3 real, ranked, agent-voiced asks + an honest "also" rollup.
- Every outbound goes through preview/approval (co-pilot); nothing auto-sends.
- Decision sheet keeps the Brief in view; composer is the only full-screen commit surface.
- Zero stale numbers; rate = $835 everywhere.

## Risks

- **Stapled-sentence voice** (template composition) — acceptable v1; track for the LLM pass.
- **Persuasiveness:** an emphasized wrong recommendation is very persuasive. Instrument override rate
  (how often she picks a non-primary action) from day one — it's also the Phase-2 learning signal.
