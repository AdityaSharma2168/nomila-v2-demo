# Voice ↔ screen data parity — field-by-field provenance map

Companion to `mila-37-voice-feedback-triage.md`. Investigation only.

## Verdict up front

**Your hypothesis is right about the plumbing and wrong about the payoff.**

Right: the screen gets everything from **one endpoint, one query** — `GET /api/v1/me/deals`
(`server/routes/deals.ts:60-160`), a 3-way join `deals ⟕ inbox_threads ⟕ inbox_brands` — and
voice is on a completely separate, narrower path. There is no second data source, no
magic. Voice genuinely can't see it.

Wrong: widening the pipe to strictly-trusted fields recovers **less than you'd expect,
because voice already has most of them.** `scoreNumeric`, `verdict`, `fitBand`, `sportFit`,
`audienceFit`, `brandTier`, the four factor ratings, `recommendation`, `urgency`,
`economicsState.state`, `hasRedFlag` are *all already on the voice wire today*. The
richness you're seeing on screen is disproportionately the **prose**, and essentially all
of that prose is model-written downstream of brand email.

**The binary in your question doesn't hold.** There are three provenance classes, not two,
and the middle one is where most of the good stuff lives.

## The three classes

| Class | Definition | Safe to speak? |
|---|---|---|
| **A — app-owned** | Computed by our code, or constrained to a closed vocabulary our code validates. No free text can flow in. | **Yes.** Most already on the wire. |
| **B — app-written, untrusted-grounded** | Prose *our* prompt generated, but *from* attacker-influenceable retrieval (web search). Schema-constrained, never copied verbatim. | **Policy call.** Not a technical fact. |
| **C — untrusted-derived** | Model-written from brand *email* text, or the email text itself. The attacker sends the payload directly. | **No**, not without derivation or sanitization. |

The distinction between B and C is the whole game, and it is *not* "generated vs lifted" —
both B and C are generated. It's **who controls the input**: for B it's whoever ranks for
the brand's name on Google (realistically the brand itself); for C it's whoever emailed
the athlete.

---

## 1. What the screen calls

```
OpportunitiesScreen / DealDetailScreen / BrandDetails / ScoreAnalysisSheet
  → useDeals()                          client/hooks/use-deals.ts:242
  → GET /api/v1/me/deals                server/routes/deals.ts:165
  → loadRankedDeals()                   server/routes/deals.ts:62
      deals
        ⟕ inbox_threads  ON thread.deal_id = deal.id
        ⟕ inbox_brands   ON brand.id = thread.brand_id
      + composeDealVoice()  ← server-side spoken line, per row
      + computeDealRank()   ← server-authoritative ordering
```

One request. `mapToDealItem()` (`use-deals.ts:~150-228`) unpacks the jsonb into the flat
fields the components render.

> **The finding that matters most.** That endpoint already calls `composeDealVoice()`
> (`server/lib/dealVoice.ts`), whose own header says it is *"the single source of Mila's
> spoken agent line for a deal. Every surface that speaks about a deal MUST read
> `composeDealVoice()`."* Voice-Mila — the one surface that literally speaks — does not.
> **But see the warning under `voice.line` below before wiring it up.** It is not what the
> name implies.

---

## 2. Field-by-field map

### Deal core

| Screen field | Source | Class | On voice wire? | Safe to speak |
|---|---|---|---|---|
| `brandName` | `deals.brand_name` | C (email-extracted) | ✅ yes | ⚠️ already crossing by precedent; sanitized in `voiceSeed` (`safeName()`) but not in `dealRoutes` |
| `status`, `dealType`, `detectedAt`, `saved` | `deals.*` | **A** | ✅ yes | ✅ |
| `amount` | `deals.amount` | **A** (number) | ✅ yes | ⚠️ **stale** — see below |
| `rank`, `threadAgeDays` | `computeDealRank()` | **A** | ❌ | ✅ |
| `messageCount`, `lastMessageAt` | `inbox_threads.*` | **A** | ❌ (only `hasThread` bool) | ✅ |

> ⚠️ **`deals.amount` is the wrong number.** `dealVoice.ts:14-17` names it money-safety
> invariant #1: *"NEVER speak `deals.amount`. It goes stale (we saw $200 on a deal whose
> live offer was $950)."* `resolveSpokenAmount()` structurally cannot see it. The voice
> wire reads exactly that field and speaks it. `detectAmountConflict()` (`dealVoice.ts:196`)
> exists specifically to detect >15% drift between the two.

### Money — the live figures

| Screen field | Source | Class | On voice wire? | Safe |
|---|---|---|---|---|
| `offerHistory[]` | `conversation_state.key_details.amounts[]` | **A** (number[]) | ❌ | ✅ |
| `monthlyEstimate` | derived from `amounts[]` | **A** | ❌ | ✅ |
| — | `key_details.offer_struct.amount` | **A** (number) | ❌ | ✅ **the correct figure** |
| — | `offer_struct.unit`, `recurring`, `commission_pct` | **A** | ❌ | ✅ |
| — | `offer_struct.deliverable_counts` `{reels:2,posts:3}` | **A** | ❌ | ✅ **the real deliverables** |
| `offerDisplay` | `conversation_state.offer_display` | **C** (model-written, e.g. `"$75/creative · 15%"`) | ❌ | ❌ |

### Score and "why this score"

| Screen element | Source | Class | On voice wire? | Safe |
|---|---|---|---|---|
| Score ring number | `score.scoreNumeric` | **A** — `grid.scoreNumeric`, `dealScoreGrid.ts:202` | ✅ yes | ✅ |
| Verdict label | `score.verdict` | **A** — `grid.verdict` wins over the model's own (`dealDetector.ts:1045`) | ✅ yes | ✅ |
| Factor grid **ratings** (rate / brand fit / scope / exclusivity) | `score.factorRatings.*.rating` | **A** — closed `poor\|fair\|good\|great`, re-validated at `getDeal.ts:71` | ✅ yes | ✅ |
| Factor grid **labels** ("Heavy (6/mo)") | `score.factorRatings.*.label` | **C** — model-written, ≤20 chars | ❌ | ❌ |
| **"Why" bullets** | `score.reasons[]` | **C** — *"2-4 bullet reasons"* from the email-fed prompt | ❌ | ❌ |
| Factor analysis paragraphs | `score.factors.*` | **C** — *"full sentence analysis"* | ❌ | ❌ |
| `recommendation` | `score.recommendation` | **A** — `reconcileRecommendation()` output | ✅ yes | ✅ |
| `recommendationUi` | `score.recommendation_ui` | **C** — templated *only when the action changed*, otherwise model-written (`getDeal.ts:124-128`) | ❌ | ❌ |
| `recommendation_agent` | jsonb | **C** — free paragraph | ❌ | ❌ |
| `urgency`, `economicsState.state` | jsonb | **A** — closed enums | ✅ yes | ✅ |
| `economicsState.read` ("$750/post vs $300 floor") | jsonb | **C** — model-written | ❌ | ❌ |
| `redFlags[]` strings | jsonb | **C** | ❌ (only `hasRedFlag` bool) | ❌ |
| `negotiateTerms[]`, `draftPoints[]` | jsonb | **C** | ❌ | ❌ |

**The scoring pipeline is genuinely trustworthy where it counts.** `dealScoreGrid.ts` is
deterministic app code: `fitBand(sport, aud, tier) → composeScore(econ, fit, redFlag) →
verdictFromScore(n)`. Its inputs are closed-enum model judgments, structured numbers, and
the app-owned rate card. **No free text can reach the score.** That's why the number and
the ratings are safe and the prose beside them is not.

> ⚠️ **A safe money string is computed and then thrown away.** `economicsBand()` returns
> `{ band, detail }` where `detail` is a *deterministic* econ read. `dealDetector` persists
> only the model's `economicsState.read` and drops `econDetail` (noted at `getDeal.ts:135-137`).
> Recovering it is a scoring-pipeline change — **out of Mila's scope, and Mia's call.**

### Fit breakdown

| Screen element | Source | Class | On wire? | Safe |
|---|---|---|---|---|
| Sport fit / audience fit **rating** | `score.brandAnalysis.{sportFit,audienceFit}.rating` | **A** — closed enum | ✅ yes | ✅ |
| …their **labels** | `.label` | **C** | ❌ | ❌ |
| `brandTier` | `score.brandAnalysis.brandTier` | **A** — closed `TIERS` | ✅ yes | ✅ |
| `brandDiversification`, `capitalContributionLabel` | jsonb | A rating / C label | ❌ | rating ✅ |
| `fitBand` | `score.fitRead.rating` | **A** | ✅ yes | ✅ |

### Brand panel — where the two provenance classes get conflated

| Screen field | Source | Class | On wire? | Safe |
|---|---|---|---|---|
| `brandDescription` ("gorjana is a rapidly growing…") | `inbox_brands.description` | **B** | ❌ | **policy call** |
| `brandAudienceSummary` ("women 25-34…") | `inbox_brands.audience_summary` | **B** | ❌ | **policy call** |
| `brandSportCategories[]` | `inbox_brands.sport_categories` | **B**, small vocabulary | ❌ | ✅ with an allow-list |
| `brandKnownPartnerships[]` | `inbox_brands.known_athlete_partnerships` | **B**, proper nouns | ❌ | ✅ with `safeName()`-style sanitizing |
| `brandCategory` | `inbox_brands.category` **||** `score.brandAnalysis.category` | **B or C** | ❌ | depends which won |
| `brandSummary` | `score.brandAnalysis.brandSummary` | **C — email-derived** | ❌ | ❌ |
| `brand_tier` (row column) | `inbox_brands.brand_tier` | **B**, closed enum | ❌ | ✅ |
| everything in `enrichment` jsonb (`brand_values`, `content_style`, `recent_campaigns[]`, `product_categories[]`, `partnership_style`, `competitors[]`, `markets[]`) | `inbox_brands.enrichment` | **B** | ❌ | **policy call** |

> ⚠️ **The screen already conflates B and C in one visual slot.**
> `BrandDetails.tsx:14` and `DealDetailScreen.tsx:224`:
> `const description = deal.brandDescription || deal.brandSummary;`
> First is web-grounded enrichment (B). Second is model-written **from the brand's own
> email** (C). They render identically. Any "just show what the screen shows" rule inherits
> that conflation — on a brand whose research hasn't run, the fallback silently becomes
> email-derived text.

### `voice.line` — read this before wiring it up

| Field | Source | Class | Safe |
|---|---|---|---|
| `voice.primaryActionLabel` | `labelFor(rec, spoken)` — pure switch over an enum | **A** | ✅ |
| `voice.factLine` | `` `On the table: ${spoken}.` `` | **A**, *unless* it fell through to `offer_display` | ⚠️ mostly |
| `voice.line` | template stitched from **C-class spans** | **C** | ❌ |

`composeDealVoice` is an *app-owned template filled with untrusted spans*. Every branch
interpolates model-written-from-email text (`dealVoice.ts:383-414`):

- `situation` ← `conversation_state.conversation_state`
- `position` ← `verbify(score.recommendation_ui)` + `negotiate_terms[0]`
- `math` ← `economicsState.read` **or** `reasons[0]`
- fallback E ← `thread.summary`
- red-flag branch ← `redFlags[0]`

Its only guard, `assertNoUnbackedFigures()`, checks **dollar figures only** — it strips
numbers not backed by a structured field and does nothing whatsoever about instruction text.

**That's correct for a screen and wrong for a live model.** Rendering attacker text as
pixels is safe; feeding it to a Gemini Live session that will read it aloud is the exact
surface `dealRoutes.ts:20-26` exists to close. The name `dealVoice` is about *Mila's tone
of voice*, not about TTS.

---

## 3. The brand enrichment prose — is it ours?

**It is ours, and it never touches email. But it is grounded on live web search.**

`server/skills/researchBrand.ts`:

- **Inputs are `brandId`, `brandName`, `domain`.** No email body, no thread, no message
  text — anywhere in the module.
- Four parallel Gemini calls with `tools: [{ googleSearch: {} }]` and our own
  `GEMINI_SYSTEM` (line 23).
- Results concatenated → `combinedText`, passed to Kimi with our `KIMI_SYSTEM` (*"Never
  invent data"*) and our fixed `EXTRACTION_SCHEMA` (line 31), which is what pins
  `description` to "2-3 sentences", `brand_tier` to four values, etc.
- Output written to `inbox_brands`.

So the gorjana paragraph was **written by our pipeline, under our prompt, into our schema**.
Nothing was lifted verbatim from an email or a webpage.

**The caveat that makes it a policy call, not a green light:** the research text goes into
the extraction prompt undelimited —

```ts
`Research text:\n${combinedText.slice(0, 8000)}`   // researchBrand.ts:~118
```

— so whoever controls what Google returns for *"gorjana company brand overview industry
products founded"* influences what lands in `description`. Realistically that's the brand's
own site and press coverage; the hostile version is SEO poisoning against a brand name.

**How that compares to what already crosses:** `reasons` (from `narrateWhyFits`) is
permitted on the voice wire today on exactly this reasoning — *"APP-GENERATED copy from our
own constrained JSON call, not brand-authored text passed through"* (`brandBriefRoute.ts:82-87`).
And that same header flags (`:89-94`) that `narrateWhyFits` *also* interpolates the brand's
category and `audience_summary` undelimited into its prompt, worked around by passing
`facts: []`.

**So Class B already crosses the voice boundary.** Admitting enrichment prose is a
consistency change, not a new precedent — but it widens the volume from three curated
sentences to arbitrary paragraphs, which is a real difference in blast radius.

Cheap mitigations if you take it: cap length; single-line collapse; reject on `<`/`>` and
on imperative-looking openers (the `voiceSeed.ts safeName()` pattern, generalized);
prefer the short enumerable fields (`brand_tier`, `partnership_style`, `content_style`,
`product_categories`) over the paragraphs.

---

## 4. How much is "just widen the pipe"?

Honest accounting against the things you named:

| What you want | Fixed by widening to Class A? | Why |
|---|---|---|
| Score + ring | **Already there** | on the wire; the *prompt* bans saying it |
| Sport-fit / audience-fit breakdown | **Already there** | ratings on the wire; the labels aren't |
| Real deliverables | ✅ **yes** | `offer_struct.deliverable_counts` is pure structure |
| Correct comp / live money | ✅ **yes** | `offer_struct.amount` + `amounts[]`; also fixes the stale bug |
| Athlete brand profile + rate card | ✅ **yes** | app-owned, zero new surface (needs a route + tool) |
| Brand tier / sport categories | ✅ mostly | Class B but effectively closed vocabularies |
| Known partnerships | ⚠️ with sanitizing | Class B proper nouns |
| One-line deal summary | ❌ **no** | Class C — email-derived, every source |
| "Why this score" bullets | ❌ **no** | Class C — `reasons[]` from the email-fed prompt |
| Factor labels ("Heavy (6/mo)") | ❌ **no** | Class C |
| Brand enrichment prose | ❌ policy call | Class B paragraphs |
| `voice.line` | ❌ **no** | Class C spans in an app template |

**Rough split of the perceived gap:** about a third is a genuinely free pipe-widening
(deliverables, live money, athlete profile, brand tier/categories). About a third is
**already on the wire and suppressed by the prompt** — score, verdict, all the ratings —
which costs nothing but a prompt edit. The final third is Class B/C prose and needs a
decision or a derivation.

**The third bucket has a cheaper answer than sanitizing.** `voiceSeed.ts` already proves
the pattern: it builds fluent spoken sentences purely from ids, enums and booleans, with
every word app-authored. A one-line deal summary composed from `{dealType, offer_struct,
deliverable_counts, status, brandTier, fitBand}` would read as *"a three-post deal with a
premium brand, twelve hundred on the table, still unpriced on usage"* — which is better
than the email-derived summary, not a degraded substitute for it. Same for the "why": the
ratings already carry it; only the prose is missing, and prose is the part we can write
ourselves.

## The safe subset — what voice can have without a new risk class

Add to the voice wire (all Class A unless noted):

- `offer_struct.{amount, unit, recurring, commission_pct}` and `key_details.amounts[]`
  → correct live money, and retires the stale `deals.amount`
- `offer_struct.deliverable_counts` → real deliverables, key-allow-listed, integer-clamped
- `messageCount`, `lastMessageAt`, `rank`, `threadAgeDays` → "you've been going back and forth a while"
- `voice.primaryActionLabel` → pure enum
- `inbox_brands.{brand_tier, sport_categories}` (B, closed vocabularies)
- `athletes.{sport, school, division, goal_archetype, secondary_goals, brand_voice}` + rate card
  → a new internal route; app-owned, no new surface
- **unblock in the prompt, no code:** `scoreNumeric`, `verdict`, and all nine ratings

Stays behind the boundary:

- `reasons[]`, `factors.*`, all `label` fields, `redFlags[]` strings, `negotiate_terms[]`,
  `draft_points[]`, `recommendation_agent`, `recommendation_ui`, `economicsState.read`
- `thread.summary`, `conversation_state.*` prose, `offer_display`, `raw_data.summary`,
  `raw_data.deliverables` (the string[] — use the counts instead)
- `score.brandAnalysis.brandSummary` (email-derived, and the screen's silent fallback)
- **`voice.line`** — despite the name
- Brand enrichment paragraphs — pending your call

## Open questions for you

1. **Class B paragraphs — in or out?** Consistency says in (`reasons` already crosses on the
   same logic). Volume says the blast radius is different. This is the single decision that
   determines whether "brand details don't surface" is a small change or a large one.
2. **Score number in speech** — the data is already there; the prompt bans it. Confirm you
   want that reversed and under what conditions.
3. **`econDetail`** — a deterministic, safe money string exists in `economicsBand()` and is
   discarded before persistence. Recovering it means touching the scoring pipeline, which
   is out of our scope. Worth raising with Mia separately.
