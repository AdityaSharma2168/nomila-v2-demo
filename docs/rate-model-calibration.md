# Rate Model v3.1 — Calibration (record)

Calibrates the shadow rate model (`rateModelConfig.ts` / `rateService.ts`) from `v3.0.0-phase1`
→ `v3.1.0-calibrated`. Still **shadow** (not wired to the live app). Synthesized by a Fable-5 pass
over: corrected IMH per-platform tables, a range-width study, and a real-NIL-deal-data study.

## What changed
1. **Anchors corrected to authoritative IMH** per-platform pages (the prior values misread a
   reproduction that compressed IMH's micro+mid tiers → IG/YouTube 100k were ~10× too high,
   TikTok nano ~8–10× too low). A 100k-follower IG athlete was quoted ~$6k/post vs ~$1.1k market.
   - IG: 1k$10 / 10k$100 / 100k$500 / 500k$5k / 1M$10k
   - TikTok: 1k$50 / 10k$200 / 100k$800 / 1M$5k / 10M$50k
   - YouTube: 1k$20 / 10k$200 / 100k$1k / 500k$10k / 1M$20k
2. **Athlete premium** (`ATHLETE_PREMIUM_ANCHORS`) — multiplier on the **social base only**,
   log-log interp, flat outside the ends: 1k=2.0× · 30k=**2.6×** · 200k=2.0× · 700k=1.5× · 2M+=1.0×.
   Justified: IMH generic 22.7k creator ~$180/IG post vs D-I athlete average >$500 (~2.6× at micro);
   tapers to 1.0× at mega (a 5M athlete ≈ a 5M creator). NOT applied to appearance/autograph/
   licensing (already athlete-specific) or podcast (reach-priced ad inventory).
3. **Score-mod rebalanced** — socialPost was `brand .40` (press volume dominated the price,
   penalizing low-press athletes); now `narrative .40 / athletic .30 / brand .25 / commercial .05`,
   bounds [0.85,1.25]. Commercial cut to ~0 platform-wide until deal data populates it.
4. **Range scheme** — confidence-tied single-deal band (~2×, not the 4× population spread):
   high 0.80×/1.25× · medium 0.70×/1.40× · low 0.55×/1.60×, tied to `dealBenchmarkQuality ×
   provenance`; nano <5k and mega >2M demote one band. Applied uniformly to every deal type.
   Framing: High = anchor shown first · Mid = target · Low = private walk-away.
5. **Format multipliers** → IMH's own: feed 1.0 · Reel 1.35 · Story 0.4.
6. **Podcast** deal type added (`PODCAST_CPM` host-read $22 CPM / mid-roll $30 / pre $15 / post $10,
   min $150) — priced on listens, no premium, no engagement adj (listens ARE the engagement).
7. **Engagement adj unchanged** — `clamp(sqrt(ER/tierNorm), 0.7, 1.4)`; the 1.4 cap is load-bearing
   (Caitlin breaches her ceiling at 1.5).

## Validation (backtest, `evaluateRates.ts`)
Golden anchors — **7/7 in IMH band, 3/3 published-estimate hits**, no overshoot:
Livvy $44.4k feed / $60k Reel (est $50–80k) · Caitlin $54.1k (est $40–70k) · Arch $13.3k (est $10–20k).

Roster (before → after): Mia IG $543→**$631**, TikTok headline **$905** (IMH prices TikTok higher at
her tier + her 12% engagement), PAV $15k→**$23.4k**; small D-1 athletes up ~2.2× (the sub-15k segment
was the biggest miss); the 100k-follower 5× overshoot is gone.

Ambassador retainers *look* large at the top (Caitlin ~$2.2M/yr) but are correct: her real endorsement
income is ~$16M/yr (Nike alone ~$3.5M/yr) — a brand endorsement IS an ambassador deal.

## Honest limits (calibration targets for closed-deal data)
1. The **premium curve rests on ~one measured point** (2.6× micro) + boundary conditions (goldens pin
   1.0× at mega). Mid/macro (2.0/1.5) are interpolated → **re-fit with first closed deals** (#1 target).
2. Premium evidence is **Instagram-only**; applying it to TikTok/YT/X is an assumption.
3. IMH numbers are **asking-price estimates**, not transactions (closes run 20–40% lower — why Low =
   walk-away framing matters).
4. Golden targets are themselves published estimates, n=3, all mega/macro → **micro/mid validation is
   roster-anecdotal** until we have real deals.
5. PAV is **deliberately conservative for megas** (models ~1 ambassador deal + posts, not a mega's full
   ~10-deal portfolio; Caitlin PAV $5.6M vs real ~$16M). Fine — PAV is "credibly projectable," not their
   whole empire.
6. Still open: sport/gender premium unmodeled; licensing guarantee $0.02/follower invented; appearance
   P5–P7 ±2×; commercial capital = 0 platform-wide.

**No free source of real per-deal $-by-follower data exists** (disclosure data is aggregate-only /
FERPA-blocked). Granular calibration needs our own closed deals (Bühlmann blend, k=10, activates at n=1)
or a paid Opendorse/SponsorUnited partnership. NCAA NIL Assist aggregates (median deal $60, mean $5,594)
are used only to sanity-check per-deal-type rates (commercial-vs-collective caveat: ~82% of NIL $ is
collective, not commercial market rate).
