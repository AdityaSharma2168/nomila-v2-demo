# Deals domain audit — for Rate Intelligence integration

**Owner:** Mia
**Date:** 2026-09-17
**Purpose:** Establish what the Deals domain already represents, so Rate references it rather than inventing a parallel commercial ontology. Descriptive; no design here beyond the §17 recommendation.
**Method:** schema, live dev data (276 deals), and constraint definitions. Counts are dev as of this date.

---

## The finding that governs everything else

**The normalized deal model exists and is unpopulated. The live data is denormalized jsonb.**

| table | rows |
|---|---:|
| `deals` | **276** |
| `deal_deliverables` | **0** |
| `deal_periods` | **0** |
| `deal_installments` | **0** |
| `payments` | 2 |

Deliverables actually live in `deals.raw_data.deliverables` — **free text**, e.g. `["Set up a storefront of favorite merch", "Share storefront with audience", "Post first piece of content this month"]`. Not typed, no quantity, no format, no platform.

And the commercial corpus is thin: of 276 deals, **24 carry an amount**, **0 carry a term start**, and **6 are accepted or completed** (5 + 1), all 6 with an amount.

**Consequence for Rate:** the linkage architecture is worth designing now because it must exist before data arrives — but the gate on Rate learning is not the linkage. It is **Deals capturing structured deliverables and terms at all.** Six unstructured transactions cannot calibrate anything, however well referenced.

---

## 1. Deal / opportunity types

`deals.deal_type`, CHECK-constrained:

```
social_post | appearance | ambassador | autograph | licensing | other
```

In use: `social_post` 153 · `other` 107 · `appearance` 12 · `ambassador` 1 · null 3.

**No platform distinction** — one `social_post` covers Instagram, TikTok and YouTube alike. **No format distinction** — feed, Reel and Story are the same type. `other` is 39% of the corpus.

## 2. Lifecycle / status

`deals.status`, CHECK-constrained:

```
detected | pending | negotiating | accepted | completed | rejected
```

In use: `detected` 257 · `negotiating` 11 · `accepted` 5 · `rejected` 2 · `completed` 1. **`pending` is permitted and unused.**

Meanings as implemented: `detected` = extracted from an inbox scan, unreviewed; `negotiating` = in active conversation; `accepted` = terms agreed; `completed` = delivered/finished; `rejected` = declined by either side.

Two further, **independent** lifecycles exist alongside it:

```
payment_status   none | payment_requested | funded | delivered_pending_confirmation | settled | refunded | disputed
deposit_status   none | held | released | expired
```

Plus `direction` (`inbound | outbound`) and `source` (`inbox_scan | self_reported | contract_upload | api | public_profile | outbound_agent`).

## 3. Offers

**There is no offer entity.** An offer is represented as the deal's current economics — `amount`, `amount_cash`, `amount_product` — overwritten as understanding improves. The cash/product split is written at ingest (`dealDetector.ts`).

So "the offer" and "the deal" are the same row, and **only the latest understanding survives**.

## 4. Counters / negotiation steps

**Not represented.** `deals.negotiation_state` is a jsonb column that is `{}` in **275 of 276** rows.

The underlying conversation exists in `inbox_threads` / `inbox_messages` as email, but nothing extracts a structured sequence of offer → counter → counter. There is no record of *what was asked* versus *what was offered* versus *what was agreed*.

## 5. Accepted / agreed / contracted / closed

A single status value, `accepted`, then `completed`. There is no separate representation of *contracted* (signed) versus *agreed in principle*. Contract documents attach via a separate path (`source: contract_upload`), not as a lifecycle state.

## 6. Is negotiation history preserved?

**No.** Economics are overwritten in place on the `deals` row; `negotiation_state` is unused. There is no append-only history of commercial positions.

This is the same structural problem the Rate audit found in `athletes_current.rate_card`: current-state projection, no history.

## 7. Economics

| represented | not represented |
|---|---|
| `amount` (total) | royalties |
| `amount_cash` | revenue share |
| `amount_product` (in-kind) | bonuses / incentives |
| `commission_pct` | escalators |
| `deal_periods.cash_cents` / `product_cents` *(0 rows)* | performance payments |
| `deal_installments.amount_cents` *(0 rows)* | |

Population: amount 24, cash 15, product 3, commission 17 — of 276.

Note `licensing` is a valid `deal_type` while **royalty economics have no representation at all**, so a licensing deal cannot record its royalty terms.

## 8. Deliverables

Two representations, one live:

- **`deal_deliverables`** (0 rows): `seq, campaign, format, kind, quantity, due_on, optional, status, source_quote, superseded_at` — a proper structured model, with supersession, entirely unused.
- **`deals.raw_data.deliverables`** (270 rows): an array of **free-text strings**.

So structured deliverables are designed but not captured. For Rate this is decisive: a closed deal cannot today be attributed to a rate type, because nothing says which deliverables it contained.

## 9. Rights / usage

**Not represented anywhere.** A schema-wide search for `right|usage|territor` columns returns only `athletes.media_rights_ack_at` (a consent timestamp) and `mia_evaluation_runs.usage` (LLM token usage). Neither is commercial rights.

## 10. Exclusivity

**Not represented anywhere.**

## 11. Term / duration

`deals.term_start` / `term_end` exist and are **populated in 0 of 276 rows**. `deal_periods` would carry multi-period structure; also empty.

## 12. Accepted vs declined outcomes

`status = accepted` (5) vs `rejected` (2). **No decline reason, no declined amount, no record of what was on the table when it was declined** — so a rejection carries no commercial information beyond its existence.

## 13. Delivered / completed campaigns

`status = completed` (1 row), plus `payment_status` values (`delivered_pending_confirmation`, `settled`) which track money rather than delivery. `deal_deliverables.status` would track per-deliverable delivery; unused.

**No campaign performance data of any kind** — no impressions, engagement or outcome metrics against a delivered deal.

## 14. Repeat business / renewals

`deals.deal_group_id`: **69 of 276 deals grouped into 27 groups.** This is the closest thing to a relationship model, and per the known cross-thread grouping gap it groups *within* a thread — the same brand arriving on four email threads mints four deals.

There is no renewal concept, no prior-deal reference, no relationship entity.

## 15. Canonical vs legacy

| | |
|---|---|
| **Canonical and live** | `deals` row-level economics, `status`, `payment_status`, `deposit_status`, `direction`, `source`, `deal_group_id`; `inbox_threads`/`inbox_messages` as the conversation source of truth |
| **Designed, unpopulated** | `deal_deliverables`, `deal_periods`, `deal_installments`, `negotiation_state` |
| **Legacy / transitional** | `inbox_brands_bak`, `threads_brand_bak`; `deals.raw_data` as the de facto deliverable store |
| **Absent** | rights, usage, exclusivity, territory, royalties, revenue share, bonuses, campaign performance, renewal linkage, negotiation history |

## 16. What Rate can reference directly, today

**Usable as commercial evidence now:**

- `deals.status` — the lifecycle position (with the caveats above)
- `deals.amount` / `amount_cash` / `amount_product` — when populated (24 of 276)
- `deals.brand_name` / `brand_id` — brand identity and quality
- `deals.deal_type` — coarse activity family
- `deals.direction` — inbound demand is itself evidence
- `deals.source` — provenance of the claim
- `deal_group_id` — weak repeat-business signal

**Not available, and each blocks a specific Rate capability:**

| missing | blocks |
|---|---|
| structured deliverables | attributing a closed deal to a rate type |
| platform / format on social deals | platform-specific rate learning (§VII) |
| rights, usage, exclusivity | knowing whether a transaction is terms-comparable |
| term dates | annual partnership evidence |
| negotiation history | distinguishing offer from counter from close (§XXII) |
| royalty / rev-share / bonus | licensing rate evidence |

---

## 17. Recommendation — the minimum Rate needs

**Do not create a Rate-side commercial lifecycle.** The proposed `SEEDED | CONVERSATION | OFFERED | CONTRACTED | DELIVERED | RENEWED` vocabulary is withdrawn: five of its six states already exist in `deals.status`, and a parallel vocabulary would immediately drift.

**Instead, Rate reads Deals and classifies evidence strength by what the deal record can support.** The mapping is deliberately thin:

| deals.status | commercial evidence value to Rate |
|---|---|
| `detected` | interest only — a brand approached. **Never** pricing evidence |
| `negotiating` | interest with a stated economic position, if an amount exists |
| `accepted` | agreed economics — the strongest signal available today |
| `completed` | agreed economics, delivered |
| `rejected` | **not** evidence that the rate is above or below the amount (§XXII) |

**The status-promotion guard survives in a different form.** The concern was real — product seeding must not read as a partnership. But the guard belongs where the claim is *made*: the Rate evaluator classifying **researched, external** commercial claims, where no Deal record exists and prose is all there is. For Nomila's *own* deals, the record already states the status and the evaluator must use it rather than re-infer it.

So the guard splits cleanly:
- **internal** commercial evidence → read `deals.status`, never re-interpret
- **external / researched** commercial evidence → classify with `EvidenceMethod`, which already distinguishes `OBSERVED_TRANSACTION` from `REPORTED_DEAL` from `MARKETPLACE_ASK`

No new vocabulary is required for either.

### The minimum linkage for learning

One append-only record, owned by Rate, holding **only** the temporal linkage — never a copy of the deal:

```
rate_estimate_id  → the exact ledger ESTIMATE that existed at the time
deal_id           → the canonical Deals record
linked_at         → when the linkage was made
basis             → why this deal is relevant to this estimate
```

Everything commercial stays in Deals and is read through the FK. The property this buys is the one that matters: **this estimate existed before this outcome**, which is what prevents hindsight contamination.

### What must change in Deals before Rate can learn anything

Not Rate's work, and not blocking Rate v0 — but it is the real gate, and it should be visible:

1. **Structured deliverables populated**, with platform and format for social. Without this a closed deal cannot be attributed to a rate type.
2. **Rights, usage and exclusivity captured** — without them, no transaction can be judged terms-comparable, so every closed deal is derived evidence at best.
3. **Negotiation history preserved** rather than overwritten, if offer-versus-close is ever to be distinguished.

Until (1) and (2) exist, Rate's learning loop can be built and linked but cannot produce a calibration signal.
