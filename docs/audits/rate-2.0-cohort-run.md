# Rate 2.0 — eight-athlete cohort run

**Owner:** Mia
**Date:** 2026-09-19
**Spec:** `rate-eval-spec/2.0.0` (digest `03af8cec…`) · terms bases all `1.0.0` · sources `rate-benchmarks/2026-09`
**Conditions:** Gemini 3.5 Flash via Vertex, Google Search grounding, temperature 1.0
**Scale:** 8 athletes × 2 runs = 16 calls, **$0.48**

**The grid:** [`rate-2.0-cohort-grid.html`](rate-2.0-cohort-grid.html) — open it in a browser. Eight athletes across,
eleven products down, four views (mean · run 1 · run 2 · run spread).

**Raw:** [`artifacts/rate-2.0-cohort/runs.jsonl.gz`](artifacts/rate-2.0-cohort/runs.jsonl.gz) — every response with its
prompt digest, slots sent, grounding queries, usage and cost.

> **Not production.** No ledger writes, no triggers, no athlete-facing surface. This is the comparison artifact that
> tells us whether 2.0's simplification did what it was meant to.

---

## The four intended behaviour changes all fired

Each was a specific 1.x failure, and each is 2/2 across runs — the bar for calling something a change rather than
run-to-run variance.

| | 1.1.0 | 2.0.0 |
|---|---|---|
| **Riya Mehta** — no athlete-specific basis | declined all 11 | **declined all 11**, both runs |
| **Mia's TikTok** — 548 days dormant | `NOT_ESTABLISHED` | **$800 / $600, LOW confidence** |
| **LeBron's autograph** — no comparable transaction | `NOT_ESTABLISHED` | **priced**, both runs |
| **Livvy's session products** | appearance = autograph = clinic = $150k | **differentiated**: $90k / $40k / $45k |

Riya's survival matters most. The narrowed decline rule — *"any number would merely restate the general market"* —
had to let a dormant account be priced while still refusing an athlete with no public commercial footprint. It did
both.

**Mia's YouTube is the architecture working in two layers.** Applicability sent the slot (she has a channel:
`UCW4jH5snDOCY7bRPzALkFxw`), and the evaluator declined it. The product exists; it cannot be priced
athlete-specifically. Those are different judgments and they now happen in different places.

---

## What needs commercial judgment

**LeBron is the least stable and the least plausible.** Autograph session **$1.2M → $450k**, camp/clinic
**$1.2M → $350k**, appearance **$1M → $500k**. A $1.2M two-hour youth clinic is not a real price. Removing the
comparable-transaction requirement unbottled the top end, and nothing replaced it there.

**Mia moved up roughly 3×** on Instagram — $800 under 1.1.0 to **$2,250** — on identical connected evidence. Against
v3.1's live $524 that is now a ~4× gap. Same data, different prompt.

**Lilia is genuinely split**: run 1 declines all social, run 2 prices it at $50–125. One of two, so it is not called
either way here.

**Everything else is materially more stable than 1.1.0.** Livvy, Ben, Zippy and Carlin hold together across runs far
better than the ~2.5× session-product swings that appeared in every 1.x condition.

---

## One defect, and how it got through

**Carlin Isles · Instagram Story · run 1 → `low $4,500 / expected $750 / high $1,200`.** LOW above EXPECTED.

`validateRateResponse` existed, had ten passing tests, and was **imported into the runner and never called**. The
structural guard shipped in 2.0 specifically to stop this class of output, and it was not wired to anything.

Now wired: every response is parsed and validated before it is recorded, and failures print. Retrospective validation
of all 16 responses finds exactly this one — **1 malformed estimate in 176**, against 1 in 165 under 1.1.0. The rate
did not improve; the detection did.

---

## What this does not establish

- **Prices are not validated.** The 1.1.0 cards are comparison artifacts, not labels to reproduce, and neither is
  ground truth. Whether these numbers are commercially right is a human judgment that has not been made.
- **Two runs per athlete** is enough to separate a deterministic change from judgment variance only when a result is
  2/2 one way and 0/2 the other. Differences smaller than that are not reported as findings.
- **Citations are unverified.** The citation-validation problem from 1.1.0 — references without resolvable locators —
  was not addressed in 2.0 and is unchanged.
- **The session products remain the weak family.** Appearance, autograph and clinic are where there is least market
  evidence and no connected measurement to anchor on, and LeBron's instability sits entirely there.
