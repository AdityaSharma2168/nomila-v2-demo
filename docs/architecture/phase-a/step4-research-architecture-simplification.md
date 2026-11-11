# Step 4 — Research architecture simplification (design for review)

Status: **PROPOSED (14 Sep 2026)**, nothing implemented, nothing run. Follows the four-path experiment
(`step4-direct-research-experiment.md`, PR #443) and the review decisions: Kimi leaves the normal research path,
direct research stays provider-agnostic, Gemini research must not think unboundedly, the provider contract gets simpler,
canonicalization stays deterministic, research serves scoring AND generation.

## 0. First-class conclusion from the four-path experiment

**The dominant failure mode is provider-facing contract overreach — not a lack of sourced research, and not primarily
the registry.** Across all 16 arms the strict registry refused 339 fact-bearing claims; 263 of them (78%) were fully
sourced (cited by Kimi, or natively supported/retrieved by the provider). Path B refused more (224 vs 115) precisely
because direct-evidence/1 asked the provider to pick Nomila's evidence kind and fact key from a 40-field vocabulary:
endorsements were pushed into `nil_mention` (93), the same team relationship arrived under four keys, values were
stringified, and level/kind guesses were made that no source stated. The registry itself accounts for a smaller,
real remainder (no shape for endorsements or season statistics, single-year awards, mandatory `level`). The simplified
contract removes the provider's access to Nomila's vocabulary; the registry changes in §4 close the remainder.

Refinements adopted as part of this design (review, 14 Sep 2026): `career_status` is derived deterministically from
dated affiliations and career events, never researched as a provider item; `level` is optional at ingestion and is
derived only through deterministic canonical mappings or taxonomies where the entity/event supports it, otherwise kept
as unknown — never inferred by an LLM; both the strict and the retrieved-source provenance views stay in benchmark
reporting as different evidence guarantees, not provider rankings; any next direct comparison sets low/bounded
reasoning explicitly on both providers (Gemini `thinkingLevel: MINIMAL`, OpenAI `reasoning.effort: low`).

## 1. Target architecture

```
                 research-spec/1 (six queries, unchanged)
                              │
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │ Research / Fact Mode: search-enabled model            │  execution = model + grounding ON + reasoning MINIMAL/LOW
   │ Gemini (hybrid prose+JSON) | OpenAI (JSON + sources) │  provider-agnostic; router chooses per stage
   └──────────────────────────────────────────────────────┘
                              │  direct-evidence/2: items → findings (value · statement · sources · status)
                              ▼
   ┌──────────────────────────┐   native lineage (native_supported / native_retrieved / asserted_only / unsupported)
   │ EVIDENCE  research_evidence│◄─ every finding is kept, sourced, dated, with its lineage level and item id
   └──────────────────────────┘
                              │  item-mapping/1 + claim-canonicalization/1 (deterministic, no LLM)
                              ▼
   ┌──────────────────────────┐   strict registry, resolver (unchanged); unmappable findings stay evidence
   │ CANONICAL FACTS athlete_facts │
   └──────────────────────────┘
                              │  Beta.1 normalization (cohorts, priors, lookups — still to be frozen)
                              ▼
   ┌──────────────────────────┐            ┌───────────────────────────────────────────────┐
   │ DERIVED SIGNALS → M.I.A. │            │ Reasoning / Creative Mode: grounding OFF        │
   │ deterministic, no LLM     │            │ inputs = canonical facts + evidence + assets    │
   └──────────────────────────┘            │ outputs = profile, narrative, bios, pitches,    │
                                           │ campaigns, brand matching, Mila answers         │
                                           └───────────────────────────────────────────────┘
   research once → preserve evidence → normalize facts → derive signals → reuse everywhere
```

Kimi (path A) stays in the repo as a fallback/verifier for malformed provider output, ambiguity or conflict, invoked only
when a validator asks for it — never as a mandatory stage.

## 2. Simplified provider contract — `direct-evidence/2`

**Principle: the provider answers items, Nomila assigns keys.** The provider never sees registry fact keys, evidence
kinds, enums or unrelated shapes. For each requested item of the query it returns findings in a small item-typed
shape declared by research-spec/1 itself, plus a statement and sources. Nomila maps item → registry key.

Per query the provider receives: the frozen request text (anchor, athlete, as-of, the numbered items) and this
contract with only that query's items:

```json
{
  "contract": "direct-evidence/2", "query": "Q1",
  "identity": { "anchor_match": "matched | uncertain | not_resolved", "confidence": 0.0,
                "namesakes": [ { "description": "...", "source_url": "..." } ] },
  "items": {
    "<item id>": {
      "status": "found | not_found | conflicting | not_applicable",
      "reason": "not_applicable or conflicting only",
      "findings": [
        {
          "value": { "...item-typed fields (below); omit any field the sources do not state..." },
          "statement": "one sentence as the source states it",
          "as_of": "YYYY-MM-DD or null — the date the statement is true for",
          "sources": [ { "url": "...", "title": "...", "published_at": "YYYY-MM-DD or null", "quote": "short verbatim passage" } ]
        }
      ]
    }
  }
}
```

Item-typed value shapes for Q1 (the spec declares one per item; every field optional; unknown fields are kept as evidence):

| Item | Value fields |
|---|---|
| full_name | `full`, `first`, `last` |
| aliases | `text`, `kind` (nickname / maiden / transliteration / handle / other) — one finding per alias |
| birth_year | `year`, `date` (adults only) |
| nationality | `country` — one finding per country |
| hometown | `city`, `region`, `country` |
| sport_discipline | `sport`, `discipline` |
| namesakes | `description` |
| current_affiliation / past_affiliations | `organization`, `organization_type` (school / club / pro / national / olympic / other), `league`, `level`, `conference`, `city`, `country`, `from`, `to`, `role` |
| league_level_division, market | folded into the affiliation finding (`league`, `level`, `conference`, `city`, `country`) |
| position_role | `position`, `role` |
| education_class_year | `class_year_label`, `season`, `graduation_year`, `degree` |
| national_team_programme | `team`, `age_group`, `year`, `role` |

Q1 Caitlin example of two findings (as the provider would return them):

```json
"current_affiliation": { "status": "found", "findings": [ { "value": { "organization": "Indiana Fever", "organization_type": "pro", "league": "WNBA", "city": "Indianapolis", "country": "United States", "from": "2024" }, "statement": "Caitlin Clark plays for the Indiana Fever of the WNBA, which selected her first overall in the 2024 draft.", "as_of": "2026-09-13", "sources": [ { "url": "https://www.wnba.com/player/1642286/caitlin-clark/bio", "title": "Caitlin Clark - Indiana Fever", "published_at": null, "quote": "Caitlin Clark plays for the Indiana Fever" } ] } ] },
"education_class_year": { "status": "found", "findings": [ { "value": { "graduation_year": 2024, "degree": "Marketing" }, "statement": "She graduated from the University of Iowa in 2024 with a degree in marketing.", "as_of": "2024-05-01", "sources": [ { "url": "https://hawkeyesports.com/sports/wbball/roster/player/caitlin-clark", "title": "Caitlin Clark - Iowa Hawkeyes", "published_at": null, "quote": "graduated in 2024 with a degree in marketing" } ] } ] }
```

**Commercial relationships (Q4 / S7) without a premature canonical key.** The provider answers the S7 items in their
own item-typed shapes; nothing is forced into `nil_mention` or any registry key at the provider:

| Item | Value fields |
|---|---|
| partnerships_deals | `brand`, `deal_type` (sponsorship / endorsement / nil_deal / collaboration / ambassador / other), `category`, `start`, `end`, `renewal` (true/false), `campaign`, `published_value`, `currency` — one finding per brand relationship |
| representation | `agency`, `agent`, `since` |
| ventures | `name`, `venture_type` (business / product_line / equity / other), `since` |
| third_party_valuations | `estimator`, `value`, `currency`, `year`, `basis` — the only S7 item that maps to `nil_mention` |
| deal_categories, deal_dates, renewals_repeat, campaigns, published_values | folded into the `partnerships_deals` finding's fields; reported as item statuses only |

Q4 Caitlin example (one finding, as researched in the direct run):

```json
"partnerships_deals": { "status": "found", "findings": [ { "value": { "brand": "Gainbridge", "deal_type": "sponsorship", "category": "financial services", "start": "2024-03-05" }, "statement": "Gainbridge announced a partnership with Caitlin Clark on March 5, 2024.", "as_of": "2024-03-05", "sources": [ { "url": "https://www.gainbridge.io/press/caitlin-clark", "title": "Gainbridge and Caitlin Clark", "published_at": "2024-03-05", "quote": "Gainbridge announced a partnership with Caitlin Clark" } ] } ] }
```

Downstream: every S7 finding is stored as a `research_finding` evidence row and shown in the context's evidence block
regardless of mapping. `item-mapping/1` maps `partnerships_deals` findings to the proposed `endorsement` fact key only
once that key exists (registry v2, §4); until then they remain `unmapped` sourced evidence, never `nil_mention`.
`third_party_valuations` → `nil_mention`. Commercial proof (verified deals, payments) stays a separate channel and
never comes from research.

What is removed from direct-evidence/1: `kind`, `factKey`, registry value examples, the 40-field descriptive block,
cross-query shapes (reputation, venture, social metrics in Q1), the unescaped-JSON example. Output rules unchanged:
prefer not_found over invention, no tiers/scores/judgements, follower counts as stated only (S8 item), reputation
items keep their three stages as separate items (S9), minor line unchanged. Per-provider compilation unchanged
(Gemini hybrid prose + marker + JSON with quotes copied from the prose; OpenAI JSON + `include: action.sources`).

**Provider output vs Nomila:** the provider resolves identity, researches items, returns status/values/statements/
sources/dates and preserves conflicts and uncertainty. Nomila validates lineage, maps items to registry keys,
canonicalizes, validates against the strict registry, resolves facts, classifies sources, minimizes for minors, keeps
everything else as evidence, derives signals, scores.

## 3. Mapping onto the existing infrastructure (reuse, no parallel storage)

| Layer | Existing object | Change |
|---|---|---|
| Raw provider response | `research_source_payloads` (sanitized, 90-day retention) | none; store the hybrid prose + JSON / JSON + sources as today's envelopes |
| Evidence | `research_evidence` (append-only; `kind`, `claim`, `support`, `lineage_status`, `source_url/domain/type`, `published_at`, `confidence`, `about_identity_confidence`) | one row per finding; `claim` = `{ item, value, statement, asOf, registryStatus: mapped\|partial\|unmapped, canonicalization }`; add kind `research_finding` and lineage statuses `native_supported`, `native_retrieved`, `asserted_only` (CHECK extensions, versioned migration); `support` = bound chunk ids + quote as today |
| Canonical facts | `athlete_facts` + resolver (rules 1–7 unchanged) | candidates come from `item-mapping/1` (item → fact key + field mapping) followed by `claim-canonicalization/1`; only `native_supported`/`native_retrieved` (policy) reach the resolver |
| Affiliations | `athlete_affiliations` ledger via `syncAffiliationsFromFacts` | unchanged |
| Context | `CanonicalAthleteContext` | facts as today; `press`, `brandMentions` already come from evidence — extend the same `Evidence<T>` pattern to every section (`evidence.byItem`) so generation can read sourced statements that are not facts |
| Inferences | `athlete_inferences` (story_arc, sentiment, brand_fit_tags) | unchanged as the home of AI-derived interpretations; narrative findings from research are evidence (`narrative` items), not inferences |
| Params | `model_params` | Beta.1 normalization bundles as already designed (#441) |

**Evidence that cannot become a canonical fact** is never discarded: it stays a `research_finding` row with
`registryStatus: unmapped` or `partial` (mapped fields accepted, remainder kept in `claim.value`), fully sourced and
dated, visible in the context's evidence block for generation, and counted in an "unmapped evidence" report that drives
registry/mapping evolution globally. No LLM is used to interpret it.

### 3a. Scoring boundary (rule)

Unmapped or partially mapped evidence may be used for context, prose, narrative reasoning, Mila answers and future
canonicalization. **It may never directly affect deterministic M.I.A. scoring.** A finding influences a score only after
it has passed, in this order: accepted provenance level under the active acceptance policy → `item-mapping/1` to an
approved registry key → `claim-canonicalization/1` → strict registry validation → the resolver → an approved
canonical-fact-to-signal mapping (the Beta.1 normalization bundle). Evidence rows, statements, provider confidence,
provider-described outlet context and any model-generated classification are outside that chain and cannot reach a
signal. The context exposes evidence and facts in separate blocks so consumers cannot confuse them; the normalization
layer reads facts and features only.

## 4. Registry and mapping changes from the four-athlete ledger (339 refusals, 78% of them fully sourced)

| Pattern (count) | Verdict | Treatment |
|---|---|---|
| Endorsements/deals routed to `nil_mention` (93) | missing shape | new fact key `endorsement` `{ brand, dealType, category?, startDate?, endDate?, campaign? }` (dated_multi); `nil_mention` kept narrow for third-party valuations; commercial proof still separate |
| Award/achievement with `years: [...]` (30) | schema too strict on cardinality | `item-mapping/1` splits a years array into N dated records; registry unchanged |
| Award/achievement missing `level` (31) | mixed: the source often does not state it | make `level` optional with `null` allowed; keep the enum when present; Nomila derives level later from the awarding body via lookup, not the provider |
| `level` values outside the enum (AFLW, professional, USL W) (12) | too strict | add closed aliases: professional/league names → `pro` (new enum value), keep unknowns refused |
| JSON-stringified values (12) | mapping gap | canonicalization: parse a string value that is valid JSON before validation |
| Performance stats attached to achievements (15) | missing shape | new fact key `season_statistic` `{ metric, value, season, competition? }` (dated_multi) |
| national_team events without team/level/year (26) | mixed | team optional when the current affiliation is a national programme; `event`/`result` optional fields; keep `year` required |
| alias without kind (10), bundled `aliases[]` (3) | mapping gap | default kind `nickname` only when the item is `aliases`; split arrays |
| career_status answered with team facts (13) | extractor misuse | drop the provider-side item; derive `career_status` deterministically from affiliation dates and dated career events |
| affiliation `seasons: "2016-2020"` (15) | mapping gap | parse `YYYY-YYYY` → `from`/`to` |
| handles as aliases (4), website as affiliation (2) | misuse | keep as evidence only |

With item-typed values in direct-evidence/2 most of the "misuse" rows disappear, because the provider no longer chooses a
fact key. Nothing above loosens validation of a value once mapped.

## 5. Gemini reasoning configuration (research)

Verified facts: the installed `@google/genai` 2.7.0 exposes `thinkingConfig.thinkingBudget` ("0 is DISABLED, -1 is
AUTOMATIC; allowed range is model dependent"), `thinkingConfig.thinkingLevel` (`MINIMAL | LOW | MEDIUM | HIGH`) and
`includeThoughts`. The substrate adapter already runs `gemini-3.5-flash` on Vertex with `thinkingBudget: 256` in
production paths, so a bounded budget is proven on this model; the direct probe and run used no thinking config and
produced 20–30k thinking tokens per call. Unverified on 3.5 Flash: whether `0` is accepted (it is for 2.5 Flash) and
which `thinkingLevel` values it accepts.

Recommendation (simplest production setting): `thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false }`
for Research / Fact Mode, falling back to `thinkingBudget: 512` if the model rejects the level; never `-1`. Verify with
one Q1 call before any rerun (it also tests whether grounding empties reappear, which is why the substrate uses 256 with
a retry loop). OpenAI parity: set `reasoning: { effort: "low" }` explicitly instead of the model default. Principle
recorded: `execution = model + grounding/search mode + reasoning budget`.

## 6. What from #443 stays

Keep as production-intended: `research-spec/1` and its code mirror, `directLineage.ts` (native lineage validator),
the Gemini hybrid and OpenAI include-sources adapters, `claim-canonicalization/1`, the four arm states and abstention
semantics, `minor-evidence-policy/2`, the acceptance policies. Rewrite: `directEvidenceV1` → `direct-evidence/2` +
`item-mapping/1`. Benchmark-only: the harness, cohort/gold/targets files, Kimi cited-claims/3 partitioned path,
comparison/report modules, degenerate detection for Kimi output.

## 7. Six queries

Unchanged for this simplification; the item-typed contract makes each query self-contained, which is also the
precondition for the later consolidation test (6 → 3 → 1–2 calls).

## 8. Decisions requested

1. Approve `direct-evidence/2` (item-centric, item-typed values, no registry vocabulary at the provider).
2. Approve the registry/mapping changes in §4 as a versioned registry v2 + `item-mapping/1` (no loosening of mapped values).
3. Approve the Gemini `MINIMAL` thinking setting and OpenAI explicit `low` reasoning, verified by one call each before any rerun.
4. Approve extending `research_evidence` with kind `research_finding` and the three native lineage statuses (versioned migration, dev only).
