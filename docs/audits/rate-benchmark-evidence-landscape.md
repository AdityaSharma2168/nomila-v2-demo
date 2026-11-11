# Rate benchmark evidence — discovery spike findings

**Owner:** Mia
**Date:** 2026-09-18
**Status:** Findings. **No registry, no schema, no seeding, no approved benchmarks.**
**Spike:** `rate-benchmark-discovery-spike/1` · Gemini 3.5 Flash via Vertex, Google Search grounding, temperature 1.0
**Method:** 11 slots × 2 framings = 22 planned calls; **21 completed** (one 429 on `ugc`), **338 provider searches**, **$0.83**
**Artifacts:** `artifacts/rate-benchmark-spike/` — `calls.jsonl.gz` (raw responses, queries, grounding metadata,
usage), `search-log.txt`, `run.json`

> **The harness that produced this is deliberately not checked in.** `benchmarkDiscoverySpike.ts` was opened as PR
> #504 and closed unmerged: the spike's whole finding was that pre-curating market evidence is machinery we should
> not build, so keeping its collection script on `main` would leave an apparently active line of work we decided
> against. The raw artifacts above preserve every query and response, so the evidence remains **auditable** — it is
> simply not **re-runnable** from a checked-in script, which is the right trade for a one-off spike.
>
> These findings are load-bearing: `rate-v0-design.md` §8.2 cites this document as the justification for removing the
> registry precondition, and §6.3 and §7.7 rest on it too. They are preserved here for that reason.

Collection was **deliberately permissive**: §8 admissibility was *not* applied as a filter, because doing so would let
the spike only confirm what §8 already assumes. Nothing here is a benchmark or a candidate for automatic promotion.

---

## The finding that governs everything else

**227 findings. 225 state a price. Zero are a specific transaction that states both a price and its rights.**

| | | |
|---|---:|---|
| total findings | 227 | |
| price stated | 225 | 99% |
| "terms" stated | 158 | 70% |
| **rights or exclusivity stated** | **31** | **14%** |
| **specific transaction + price + rights** | **0** | **0%** |

The 70% figure is the trap. Most of what a source calls terms is **operational** — session duration, deliverable
count, whether travel is included. Only 14% state **rights**, and not one transaction-shaped observation states both a
price and the rights it was struck on.

§8 is already frozen that *"a benchmark price without its terms cannot be compared to §7's bases, and is therefore not
usable as a benchmark."* Read strictly against this sample, the market cannot currently supply a single admissible
transaction benchmark for any rights-defined family.

---

## 1. The asymmetry that is actually actionable

Families divide by **what their terms basis is defined in terms of**, and evidence availability follows that division
almost perfectly.

| slot | states its own basis-defining terms | basis defined by |
|---|---:|---|
| `ugc` | 6/6 · 100% | rights |
| `appearance_in_person` | 11/18 · 61% | operational |
| `autograph_session` | 14/27 · 52% | operational |
| `camp_clinic` | 5/11 · 45% | operational |
| `appearance_virtual` | 9/25 · 36% | operational |
| `social_short_video/tiktok` | 6/23 · 26% | rights |
| `social_story/instagram` | 5/21 · 24% | rights |
| `social_feed_post/instagram` | 5/25 · 20% | rights |
| `annual_partnership` | 5/32 · 16% | rights |
| `social_short_video/youtube` | 1/13 · 8% | rights |
| `social_short_video/instagram` | 0/26 · 0% | rights |

**Operational terms are observable; rights are not.** Duration and travel inclusion are the things a booking page has
to state to transact, so they appear. Rights are negotiated privately and appear almost nowhere.

`ugc` at 100% is the instructive exception and is **not** a counterexample: UGC guidance content is *about* the
usage-rights split, so the terms are the subject matter. It is also the thinnest sample (n=6, one framing lost to a
429) and the one to re-run before relying on it.

**Consequence for Beta.1 scope.** The families where a market anchor is most plausible are appearance, autograph and
clinic — the ones we treated as the easy afterthought. The families the product most needs — social and annual — are
where admissible benchmark evidence is least available.

---

## 2. Five evidence shapes, not two. My proposed distinction does not describe the landscape

The registry design proposed transaction-shaped versus aggregate-shaped as the identity question. The evidence:

| shape | n |
|---|---:|
| agency or expert guidance | 63 |
| ask or listing | 53 |
| aggregate or survey | 45 |
| **specific transaction** | **36** |
| estimate of unclear basis | 29 |

**The largest category is neither** — 63 findings are an agency or bureau saying what this kind of thing costs, which
is `EXPERT_GUIDANCE` with a null `commercial_state`. Adding `estimate of unclear basis`, **40% of the landscape is
not an observation of anything**; it is practitioner opinion or an estimate whose basis the source does not disclose.

The §9.4 decomposition handles this correctly — `evidence_method` and `commercial_state` describe all five shapes
without strain, which is a real vindication of separating those axes. But a registry whose identity model assumes
"transaction or aggregate" would have had nowhere truthful to put 40% of what exists.

---

## 3. Corroboration is effectively absent — which removes a design problem I had assumed

I treated *"several sources corroborate one transaction"* as a central identity case requiring a merge path.

**221 distinct (subject, price) pairs. Six appear more than once. All six are the same source under two spellings**
(`Collabstr`/`collabstr.com`, `influencerfee.com`/`Influencerfee`).

There is **no independent corroboration in this sample at all**. The many-sources-to-one-observation case is real in
principle and essentially nonexistent in this landscape. The one-source-to-many-observations case is the common one: a
single rate-card page yields twenty tier rows.

That inverts the identity design. The hard problem is not merging duplicates; it is that **each observation has
exactly one source and no independent confirmation**, which is a verification problem rather than an identity problem.

---

## 4. Commercial stage is unknown far more often than it is known

| `commercial_stage` | n |
|---|---:|
| **unclear** | **101** |
| an ask | 59 |
| completed deal | 40 |
| agreed deal | 17 |
| an offer | 8 |
| interest | 2 |

**44% cannot be placed on the ladder at all.** Block 5's status-promotion discipline assumes a source establishes
*something*; for nearly half of this evidence the source does not say whether a number was asked, offered, agreed or
imagined. Under §9.4 those are a null `commercial_state` — the vocabulary holds, but the population of nulls is far
larger than the design anticipated.

---

## 5. Recency is mostly unknowable

| | n | |
|---|---:|---|
| publication date stated | 178 | 78% |
| **event date stated** | **64** | **28%** |

Block 1 must weigh recency, and §9.4 distinguishes `observed_at` from `published_at` precisely so the two are not
confused. **In 72% of cases there is no `observed_at` to weigh.** A 2026 article quoting a rate of unknown vintage is
the common shape.

This makes the three-date separation more important than it looked, not less: without it, publication date would
silently become recency for three-quarters of the corpus.

---

## 6. Source concentration

115 distinct sources across 227 findings, but the head is narrow and homogeneous: OpenSponsorship, LaunchPoint,
InfluencerFee, Collabstr, All American Entertainment, Mayfield Sports. These are **marketplaces and booking agencies
publishing their own rate content** — which is simultaneously the most structured evidence available and the most
interested.

Under §9.4 these are `MARKETPLACE` or `EXPERT_GUIDANCE`, and mostly `ASK` or null. None is an `OBSERVED` transaction.

---

## 7. Subject identity

| | n |
|---|---:|
| named individual | 153 |
| described segment | 74 |

More named individuals than expected — but the named ones are overwhelmingly global stars whose figures come from
press estimates of undisclosed basis, not from disclosed terms. Named does not mean observed.

---

## 8. What the evidence implies for registry design

**Do not build the transaction/aggregate split.** It describes 36% of the landscape. `evidence_method` plus
`commercial_state` already describe all five shapes; the registry needs one observation shape carrying those two axes,
not two tables.

**Identity's hard case is the reverse of what I assumed.** One source → many observations is the dominant pattern.
Merge-on-corroboration can be deferred; it has no population to serve.

**Terms need a three-way value, and the third value is the common one.** *stated* · *not stated* · *not applicable* —
with *not stated* being the majority for rights. Recording rights as absent rather than as canonical is the difference
between an inadmissible benchmark and a silently wrong one.

**Verification, not deduplication, is the load-bearing process.** Every observation rests on a single uncorroborated
source, and 14% of sources state the terms that would make the price comparable. Whatever the verification standard
turns out to be, it is doing almost all of the work of making evidence admissible.

**The strict reading of §8 would approve approximately nothing for social and annual.** That is a finding about the
market, not a defect in §8 — but it forces a decision that belongs to the next round, not to this report.

---

## 9. What this means for Beta.1, stated plainly

If §8 admissibility holds as written, then for social and annual partnership the Rate evaluator will have **no
approved market benchmark to anchor on**. Under §9.4 those estimates resolve to `anchor_basis` of
`ATHLETE_OWN_TRANSACTIONS`, `INDIRECT_EVIDENCE`, or `NOT_ESTABLISHED`.

That is the architecture behaving correctly and visibly rather than failing — `anchor_basis` exists precisely to make
this legible, and §15.1's cohort distribution was already identified as the benchmark-coverage diagnostic. But it
means the honest expectation for Beta.1 is that **market benchmarking cannot carry social Rate**, and the weight falls
on athlete-specific and indirect evidence.

Whether that is acceptable, or whether §8's admissibility bar should distinguish *rights-defined* from
*operationally-defined* families, is the decision this spike exists to inform. **It is not decided here.**

---

## 10. Limitations of this spike

Recorded so conclusions are not read as stronger than the method supports.

- **Source URLs are model-reported, not provider-attested.** `groundingChunks` came back empty on every call while 8–24
  searches ran per call, so provenance rests on the model's own claim. **No URL here has been fetched or verified**,
  and OBS-1 in the MIA learning log is exactly the failure mode of a plausible-but-wrong source attribution.
- **The classifications are the model's judgments**, not ours. `evidence_shape` and `commercial_stage` were assigned by
  the same model that found the evidence, and were not independently checked. The 44% "unclear" rate may partly be
  classification difficulty rather than source silence.
- **One provider, one day, one language, US-centric.** No cross-provider comparison.
- **`ugc` has half the intended effort** — one framing lost to a 429, so n=6 and its 100% figure is the least reliable
  number in this report.
- **Effort was fixed per slot before results were seen**, which is what makes a thin family interpretable as scarce
  evidence rather than scarce searching. Searches ranged 22–48 per slot; the thinnest results (`camp_clinic`, n=11)
  came from the **most** searching (48), which supports scarcity rather than under-effort.
