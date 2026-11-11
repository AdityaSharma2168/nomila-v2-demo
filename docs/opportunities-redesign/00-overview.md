# Opportunities Redesign — Master Plan

**Status:** Planning complete, implementation not started.
**Owner:** (you) · **Design source:** the "Mila as agent" concept, prototyped on Mia's real data.
**Last updated:** 2026-07-24

---

## What we're building

The Opportunities tab today is a scored mailbox: one flat list of ~180 dense deal cards.
On real data that degenerates into "a second inbox" — 145 of 179 deals are unanswered, 77 have
no price, ~8 are unreadable, and nothing is rated "great."

The redesign turns it into an **agent surface**: Mila states a short list of recommended actions in
plain language; the athlete approves, edits, or overrides. It is **co-pilot first** (nothing acts
without approval), with a documented path to **autopilot** later (Phase 2).

This is **additive**. The existing screen and components are NOT deleted. We build the new views
alongside, prove them, then flip the default. The orphaned "Variant B" code (`deals/opps/**`) is
**kept** — we mine three pieces from it, delete nothing yet.

## Non-negotiable principles (carried from the design)

1. **Co-pilot by default.** Every outbound action is previewed/approved. `deals.pending_action`
   (already in the schema, unused) is the approval slot.
2. **Never speak `deals.amount`.** It goes stale (we saw $200 vs $950 on a real deal). Spoken numbers
   resolve from `conversation_state` / `offer_struct`; the rate resolves at render/send time from
   `rate_card`, never a snapshot. See WS3.
3. **Never fabricate confidence.** Unreadable emails are not scored. Autopilot is earned per action
   class, reversibly. See WS3 + Phase 2.
4. **Reuse the hardened pipeline.** The reply path (Gmail RFC-2822 threading, account resolution,
   REAUTH, IG DM, 19 tests) and Aaron's classifier v2 / draft system are reused verbatim.
5. **Real brand logos everywhere** (`brand-logo.ts`); **ring capitals never appear** on these surfaces;
   Nomila tokens only (`client/constants/theme.ts`).

## Navigation model — DECIDED

Opportunities becomes a **top-tab container**, matching `BrandScreen`'s pattern exactly
(`activeTab` state + underline tab bar + conditional render — no tab library):

```
Opportunities (bottom tab)
 └─ top tabs:  [ Brief ]   [ The Week ]   [ Files ]
      Brief   → the co-pilot decision surface (default)
      The Week→ the receipt / accountability
      Files   → the archive cabinet
```

Within Brief, deciding happens in **sheets** (over the Brief, keep your place); doing (composing,
batch sending) happens in **pushed screens**. The existing `Thread` route is reused unchanged.

> The current list screen is preserved during the build — initially reachable as a fallback so we
> never regress. It is retired only after Brief is proven.

## The five work streams

| # | Work stream | One line | Doc |
|---|---|---|---|
| 1 | **Shell & Navigation** | Opportunities → 3 top tabs, additive | [01](01-shell-navigation.md) |
| 2 | **The Brief** | Agent-voice cards, decision sheet, negotiate composer | [02](02-brief.md) |
| 3 | **Deal Engine** (server/algo) | `request_terms` intent, parse gate, amount/rate fix, bulk PATCH, `pending_action` | [03](03-deal-engine.md) |
| 4 | **Ask-for-Terms batch** | Turn 77 unpriced threads into replies with numbers | [04](04-ask-for-terms.md) |
| 5 | **Supporting surfaces** | Files, The Week, Gifting, From People, In Flight, Couldn't-read | [05](05-supporting-surfaces.md) |

**Phase 2 (documented, deferred):** per-user learning, co-pilot→autopilot mandates, escrow/Stripe,
global model retraining — see [PHASE-2](PHASE-2.md).

## Dependency order

```
WS3 (engine) ─┬─> WS2 (Brief needs composeDealVoice, pending_action, rate fix)
              ├─> WS4 (batch needs request_terms + bulk PATCH)
              └─> WS5 (Files needs archived write path; Couldn't-read needs parse gate)
WS1 (shell) is independent and lands first (cheap, unblocks everyone).
```

Recommended build order: **WS1 → WS3 → WS2 → WS5 → WS4**. WS4 last because the batch is the
highest-risk surface (bulk email from the athlete's identity) and should ship "fresh only" first.

## How we work (don't shortchange)

- Every work stream has: scope, **reuse inventory**, a task checklist, **explicit server + client
  changes**, a **test plan** (unit + integration + manual verification via the `/verify` skill), and
  acceptance criteria.
- **Nothing is "done" until tested.** Each stream lists the tests that must pass. We drive the real
  flow, not just typecheck.
- The rollup [CHECKLIST](CHECKLIST.md) is the single source of truth for status. Update it as items
  complete.
- Branch per work stream (`feat/opps-ws1-shell`, etc.). Small PRs.

## Reuse inventory (global)

Confirmed present and reused across streams (from the code scan, 2026-07-24):

| Asset | Location | Use |
|---|---|---|
| Reply send pipeline | `server/routes/inbox.ts:105-385` | Reused verbatim (Gmail + IG, 19 tests) |
| Draft streaming | `client/hooks/use-deal-draft.ts` | Feeds every compose/edit surface |
| Turn state (code-owned) | `server/skills/threadSummarizer.ts` (`updateMechanicalThreadState`) | "whose move" signal |
| Classifier v2 | Aaron's `dealDetector.ts` (#93/#94) | Foundation; we extend, not replace |
| Recommendation card style (`recoCard`) | `client/components/deals/DealCard.tsx` | Promoted to the Brief card |
| `DealItem` type + config maps | `DealCard.tsx:41-143` | Salvaged; god-component retired later |
| In-screen tab pattern | `client/screens/BrandScreen.tsx:103,172-182` | WS1 copies it |
| Orphaned Variant B (mine, don't delete) | `client/components/deals/opps/**` | swipe-to-archive, archive drawer, `detail/DraftReply` |
| Approval slot | `deals.pending_action` (schema, unused) | Co-pilot lifecycle |
| Archive state | `inbox_threads.status='archived'` (enum exists, never written) | Files |
