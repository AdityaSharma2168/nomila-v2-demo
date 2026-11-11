# Phase 2 — Learning, Autopilot, Payments (documented, deferred)

These are **not** in the initial build. They are documented so the Phase-1 work leaves the right
seams. Build order and risk differ sharply from Phase 1.

---

## P2.1 · Per-user learning (cheap, do first in Phase 2)

Learn standing preferences from behavior — no model retrain.
- Signals: edits to drafts, rescues from passed, declines by category, floor overrides.
- Store as per-athlete preferences ("declines K-beauty gifting", "floor is $500", "no unpaid editorial").
- Feeds the classifier's routing + the Brief's ranking + auto-triage thresholds.
- **Seam to leave in Phase 1:** log every (proposed action, actual action) pair. The Brief already
  needs override-rate instrumentation (WS2) — that log IS the training data.

## P2.2 · Co-pilot → Autopilot (the mandate ladder)

The progression from "approve everything" to "act unasked", per action class.
- **Levels:** Advisor (nothing) → Screener (files junk, reversible) → Correspondent (sends routine
  declines / info requests) → Negotiator (runs counters within a written mandate).
- **Undelegable forever:** accepting money, signing, posting, replying to fans, SCHOOL_NIL.
- **Earned mechanically:** approval streak per class; a threshold prompts the upgrade with evidence
  ("you agreed with my last 12 filings"). **Any undo auto-demotes** that class.
- **Honesty rule:** confidence is per-class. 99% at filing spam ≠ trust to negotiate.
- **Built on:** `deals.pending_action` (WS3) + `agent_actions` log (WS5) + the track-record number
  (WS5 The Week). Autopilot = auto-approving a `pending_action` at a granted level.

## P2.3 · Qualification funnel + commitment deposit

The staged funnel (scam/junk → ask-for-terms → qualify → negotiate → accept) is largely Phase 1
(WS3/WS4). Phase 2 adds:
- **Commitment deposit — pressure-tested, likely folded into escrow.** A pay-to-pitch fee filters out
  scammers *and* premium brands (adidas/tourism boards won't pay to pitch), so it risks adverse
  selection. Prefer a **refundable good-faith deposit at the contract stage**, which is just the first
  stage of escrow — not a separate gate. Decide before building; do not ship pay-to-pitch naively.

## P2.4 · Escrow (Stripe Connect) — the big one

The strong "prove it with money" mechanism: brand funds upfront → held → athlete completes work →
brand acknowledges → funds release.
- **Current state (verified 2026-07-24):** Stripe SDK is a dependency (`stripe ^20.0.0`) but **never
  instantiated**; only `athletes.stripe_customer_id` exists. **No escrow/payout/Connect code on any
  branch.** Greenfield. (Aaron's committed work is the classifier/drafts engine, NOT payments.)
- **Architecture:** Stripe **Connect** (athletes = connected accounts) + **separate charges &
  transfers** or **delayed capture** to hold funds; release on brand acknowledgment / completion.
- **This is a regulated-money product, not just code.** Requires: athlete KYC/onboarding, dispute
  handling, refunds, 1099 tax reporting, platform liability, ToS. Weeks-to-months; part legal.
- **Threads into the workflow** at the "accept" stage of the deal — the one place Phase 1 deliberately
  leaves undelegable. Escrow is what makes "accept" safe to eventually automate.
- **Do not share a timeline with Phase-1 UI work in your head.** Different risk class.

## P2.5 · Global model retraining

Aggregate labels (from P2.1 logs + `Wrong?` fixtures) to retrain classifier/scorer.
- Needs volume, an eval harness (the eval-fixture pipeline is the seed), and guardrails against
  single-user poisoning.
- Fixes the systemic issues real data exposed: everything scoring 6–7/"negotiate", zero "great",
  blank emails scored, newsletters tagged FAN.
- Ongoing, not a milestone.

---

**Phase-1 seams that keep Phase-2 cheap:** the (proposed, actual) action log (WS2), `pending_action`
lifecycle (WS3), `agent_actions` + `Wrong?` fixtures (WS5), and never auto-sending in Phase 1 so
autopilot is a deliberate, later grant.
