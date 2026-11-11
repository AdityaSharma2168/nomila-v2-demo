# Phase A · Step 2 — Research / Canonical Athlete Profile (AUDIT + MIGRATION MAP, design only)

**Status:** directionally approved 11 Sep 2026; **revised the same day per review (R1–R8 below)**; awaiting review of the revision. No code. No production behaviour changes. Step 1b Story acceptance runs untouched in parallel.
**Revisions:** R1 canonical SourceClass unchanged, athlete assertion is an origin, `inferred` can never source a fact · R2 `connected` removed from the research states; connection status is orthogonal · R3 source-type authority policy inside web research · R4 authoritative web evidence may establish a current affiliation for unclaimed athletes; assertion/proof overrides · R5 exact claim-to-source lineage, no approximate URLs · R6 prompt-injection controls at the extraction boundary and the Context Builder · R7 domain-aware completeness · R8 versioned Fact Registry.
**Spec:** Blueprint V1 / Commercial Intelligence Beta.1 §2–§6 (identity confirmation before research, canonical Athlete Intelligence Profile with provenance, Context Builder, "LLM researches and classifies, Nomila calculates"), §19, §21.1 (evidence timestamps, as-of dates, signal-family freshness), §28.9 (source authority). Phase A decision 1: keep Gemini/Kimi as production defaults behind a `ResearchProvider` abstraction; do not hard-code OpenAI.
**Rules preserved:** athlete ≠ user; research belongs to `athlete_id`; no organization/tenant columns on intelligence tables; provenance separate from privacy class; no paid social-data provider.

## What the athlete experiences today, and what changes

Today: at signup a workflow searches the web five times under "name + school + sport", an
extraction model turns the text into a JSON blob, the blob is stored inside a score snapshot,
and the Brand › Facts screen shows achievements, press count and "brands seen with you" from
it. Every re-score copies that blob forward with a new date. Monthly, every enriched athlete is
fully re-researched whether anything changed or not.

After Step 2 (built in stages, nothing visible in 2a): the same facts, but each one knows
where it came from, when it was seen, how sure we are and whether it is current or historical.
A stale school can no longer look current. Research runs once after identity is confirmed and
then refreshes only the domains that have gone stale. Later, a new athlete can find herself in
the Nomila Athlete Index by name before any expensive research runs.

## 1. Current-state research architecture map

### 1.1 Components (what exists, classified)

| # | Component | Where | What it does today | Class |
|---|---|---|---|---|
| C1 | Research orchestrator | `server/skills/researchAthlete.ts` (793 lines) | One function: load athlete → `levelRecordFor` → prior snapshots → 5 Gemini grounded searches ‖ Trends ‖ GDELT → 5 Kimi extractions → merge → union with priors → platform discovery → build `research` JSON → merge social → `computeScore` → insert `athlete_snapshots` → propose found affiliations → `writeAthletesCurrent` → patch `athletes` | **EXTRACT INTO SERVICE** (search, extraction, normalization, persistence, scoring and projection are one procedure) |
| C2 | Search-name builder | `buildSearchName` (3 copies: `researchAthlete.ts:472`, `reEnrichAthletes.ts:30`, `server/index.ts:295`) | `"<full_name> <athletes.school> <sport>"`; the projected school is the only disambiguator | **REPLACE** with identity hints (name, aliases, sport, current affiliation from the ledger, hometown, known handles) |
| C3 | Query set | `buildQueries` `:180` | Five fixed prompts (profile+social, commercial+brand, performance+press, media assets, social handles) | **MODIFY** → domain-scoped query plans (one plan per research domain) |
| C4 | Gemini grounded search | `runGemini` `:220`, `runGeminiWithRetry` `:253`, `server/lib/models.ts` | Vertex Gemini + `googleSearch` tool, temp 1.0, up to 5 retries × 5 queries, cache-buster nonce; not behind `geminiGate` | **EXTRACT INTO SERVICE** as `GeminiGroundedSearchAdapter` (search + synthesis provider) |
| C5 | Kimi extraction | `extractFromText` `:310`, `server/lib/kimi.ts` `kimiInstant` | JSON-mode extraction per query with an inline schema; 60 s timeout; `kimiGate` 8 | **EXTRACT INTO SERVICE** as `KimiExtractionAdapter` (extract/classify provider) |
| C6 | Inline prompts | `GEMINI_SYSTEM :40`, `EXTRACTION_SYSTEM :48`, `EXTRACTION_SCHEMA :59-87` | Not in the prompt registry (unlike `first_look.themes`) | **MODIFY** → registry keys, versioned with the extraction schema version |
| C7 | Merge rules | `mergeExtractions :347`, `server/skills/researchMerge.ts` `unionResearch` | First-non-null wins per profile field; "richest run wins" per list; `profile` and `social_handles` spread-merge so prior values survive forever | **REPLACE** with evidence-level dedupe + fact resolution by authority, recency and status |
| C8 | Google Trends, GDELT | `server/lib/trends.ts`, `server/lib/gdelt.ts` | 30-day interest score; 30-day article count/tone; injected as prose into every Kimi prompt; stored as two numeric columns | **KEEP** as signal providers; **MODIFY** to write evidence rows (with `retrieved_at`) instead of prompt text |
| C9 | Platform discovery | `server/lib/platformDiscovery.ts`, `socialWebResolver.ts` (Claude web_search, inert without `ANTHROPIC_API_KEY`), `lib/integrations/discovery.ts` | Verifies an IG handle by name+sport+team, then Business Discovery / YouTube Data | **KEEP** (Step 1a substrate owns the metrics); **MODIFY** so the resolved handle and its confidence land in `social_identities` (today the confidence is logged and discarded) |
| C10 | Research JSON persistence | `athlete_snapshots.research` + `sources` (`:618-698`) | One blob per run inside the score snapshot: achievements, press, brand_mentions, story_arc, teams, sentiment, social_handles, profile, nil mentions, media_assets | **REPLACE** (keep the column for the legacy readers until Step 4; new evidence/fact tables become the truth) |
| C11 | Carry-forward | `refreshScores.ts:253`, `fetchSocialData.ts:288,311` | Nightly re-score and social connect copy the latest `research` verbatim into a new snapshot with `created_at = now` | **REMOVE** (after readers move); the cause of "fresh date on stale facts" |
| C12 | Found affiliations | `proposeFoundAffiliations` (`services/affiliations.ts:269`) | `kind='found'`, needs a date, never projects to `athletes` | **KEEP** (already the right shape: ledger, provenance, current vs historical) |
| C13 | Projection | `projectPrimary` (`affiliations.ts:219`), `athletes.school/division/conference`, generated `segment` | Written only from athlete assertions; returns early with no current row, so a retired athlete keeps her last team as "current"; `research` back-fills the columns when NULL | **MODIFY** (see §4.4) |
| C14 | Level derivation | `levelRecordFor` (`affiliations.ts:361`), `normalizeConference` (`scoringService.ts:731`) | Ranks affiliations; ignores `found` rows when any said/proof exists; conference normalized only inside scoring, raw string written to `athletes.conference` | **KEEP**; **MODIFY** normalization to happen at fact-write time |
| C15 | Athletes-current writer | `athletesCurrentWriter.ts` | Single writer; copies counts + `story_arc` on the research path | **KEEP** (Step 4 changes what feeds it) |
| C16 | Workflow runner + definitions | `server/workflow/*`, `definitions/onboarding.ts` (v2: 7-day freshness gate), `researchRefresh.ts` | Signup/waitlist/promote start `onboarding`; `research_refresh` on explicit re-research | **KEEP**; **MODIFY** definitions to call the service and the state machine |
| C17 | Monthly re-enrich | `reEnrichAthletes.ts`, cron `0 5 1 * *` | Full research for every enriched/claimed/active athlete, unconditionally, concurrency 2, and without the connected handles | **REPLACE** with the domain refresh planner |
| C18 | Freshness params | `seedModelParams.ts` `research_freshness v0.1-alpha` (draft, unseeded, unread) | Family TTLs per domain | **KEEP** → activate as the policy input (§6) |
| C19 | Story arc | Kimi schema field; `athletes_current.story_arc`; read by context, record ("made"), kit hook, scoring bonus | Generated prose stored beside facts | **MODIFY** → an inference with lineage, never a fact (§3) |
| C20 | Readers of raw research JSON (7) | `athleteContext.ts:183`, `athleteRecord.ts:126`, `mila/onboarding.ts:476`, `mediaKitService.ts:382`, `shotList.ts:126`, `collectDiscoveryAnalytics.ts:35`, `researchAthlete.ts:578` (+ scoring via `snapshotAdapter`) | Each parses the blob its own way | **MODIFY** → one Context Builder read (`getCanonicalProfile` views) — migrated reader by reader, scoring last (Step 4) |
| C21 | Projection readers bypassing the ledger (14) | context, record, onboarding block, `getProfile` tool, voice profile, legacy chat, kit, shot list, deal draft, admin, workflow definitions | Read `athletes.school/division/conference/segment` directly | **MODIFY** (same Context Builder) |
| C22 | Claim flow | `routes/auth.ts:124-159` | Name claim = `ilike '%name%' AND auth_id IS NULL AND status IN (raw, enriched) LIMIT 1`, optional sport; no confirmation; golden-anchor rows are in the candidate set | **REPLACE** in Step 3 (identity); the Athlete Index candidate search (§5) is its input |
| C23 | Golden athletes | `golden_athletes` + five `athletes` rows `status='raw'` | Rate-model anchors; not fenced from athlete-facing code | **KEEP**; **MODIFY** fencing via `research_status` / index flags |
| C24 | Dead columns | `athletes_current.brand_stories`, `.insights` (never written or read); `athlete_snapshots.as_of` (NULL everywhere, read by nothing) | | **REMOVE** later (2c cleanup PR); `as_of` becomes written by the service |

### 1.2 Provider inventory (facts, not assumptions)

| Provider | Role today | Gate | Cost telemetry |
|---|---|---|---|
| Gemini (Vertex, grounding) | search + synthesis | none (geminiGate exists, unused here) | `sources.gemini_usage`, `gemini_stats` |
| Kimi (Vertex MaaS `kimi-k2-thinking`) | extraction to JSON | `kimiGate` 8 | `sources.kimi_usage` (cost USD is 0 — not computed) |
| Google Trends | interest score | none | — |
| GDELT DOC 2.0 | article count/tone | 2 retries on 429 | — |
| Claude Haiku web_search | IG handle verification | inert without key | — |
| Instagram Business Discovery, YouTube Data | public metrics | — | — |
| Tavily | **not used** on main (only a scratch worktree script) | — | — |
| Kimi `$web_search` | declared, **no caller** | — | — |

Both models in code are sunset per the earlier Mila audit (Kimi k2-thinking EOL 25 May 2026; Gemini 2.5 line retiring 16 Oct 2026) — a second reason the provider must sit behind an adapter.

### 1.3 Storage today (live on dev, 11 Sep)

| Fact | Evidence |
|---|---|
| 272 `athlete_snapshots`; 230 are `scheduled_refresh` carry-forwards | dev query |
| Mia: 66 snapshots with research, **5 distinct research versions** (md5) between 9 Jun and 10 Sep | dev query |
| `research.profile` for Mia: `class_year: "Senior (2026 season)"`, `division: "Division 1"`, `conference: "ACC"` — free text, no date, no source | dev query |
| Press mentions have `date: null`; achievements carry `year` as free text, no source URL | dev query |
| `athlete_snapshots.as_of` NULL on every row | schema map |
| `athletes` has `auth_provider`/`auth_id` on the athlete row itself: user and athlete are one row today | schema map (ADR-015 debt) |
| 25 athletes, 10 with no auth (5 golden anchors, 4 Stanford discovery athletes, 1 test) | dev query |
| 19 affiliation rows (18 athletes): one `signup` said row each; Mia also has a dated `found` U-17 USWNT row | dev query |
| `athlete_asserted`: 1 row | dev query |
| Workflow runs: onboarding 3, first_look 2, research_refresh 3, all done | dev query |

### 1.4 Defects found during the audit (no fixes applied)

| # | Defect | Where | Effect |
|---|---|---|---|
| D1 | Carry-forward re-stamps stale research with a fresh date | `refreshScores.ts:253`, `fetchSocialData.ts:288,311` | every "latest research" reader sees today's date on June facts |
| D2 | `athletes.division/conference` shown as "found online · researchedAt" | `athleteRecord.ts:198` | the projection is presented as a dated research finding |
| D3 | `profile` / `social_handles` spread-merge keeps prior keys forever | `researchMerge.ts:113-114` | a 2024 school never leaves the blob |
| D4 | Record reads `research.position/class_year/hometown` at top level; producer writes them under `research.profile` | `athleteRecord.ts:200-202` | three Facts rows are always empty unless asserted |
| D5 | `research.causes/values` never written but read in 4 places | `athleteContext.ts:270`, `athleteRecord.ts:272`, `mediaKitService.ts:306`, `onboarding.ts:483` | values card never renders; `hasCauses` always false |
| D6 | Story tab looks for a field that no group emits | `StoryTab.tsx:21` vs `athleteRecord.ts:262` | "today's one-liner" never renders |
| D7 | Monthly re-enrich omits `{ handles }` | `reEnrichAthletes.ts:55` | a model-guessed handle can beat the connected one |
| D8 | Search anchored to the projected school only | `buildSearchName` ×3 | a stale or past school anchors all five searches to the wrong institution |
| D9 | Name-claim is a substring match with no confirmation | `routes/auth.ts:124-159` | golden anchors and discovery rows are claimable by name |
| D10 | Identity confidence from the web resolver is logged, not stored | `platformDiscovery.ts:329` | no durable identity confidence anywhere except the Step 1a `social_identities` |
| D11 | Conference written raw to `athletes.conference`; normalized only inside scoring | `researchAthlete.ts:740` vs `scoringService.ts:731` | "Atlantic Coast Conference (ACC)" vs "ACC" drift |
| D12 | Model-extracted web text interpolated unfenced into prompts | `narrator.ts:176-181`, `shotList.ts:90-94` | prompt-injection surface (already noted in-tree for brand text) |

## 2. Data-flow map

### 2.1 Today

```
signup / waitlist / promote ──► workflow onboarding ──► researchAthlete(searchName = name + athletes.school + sport)
cron monthly ──► reEnrichAll ─────────────────────────┘        │
                                                               ▼
        Gemini ×5 (grounded)  ‖  Trends  ‖  GDELT  ──► Kimi ×5 extract ──► mergeExtractions ──► unionResearch(prior×5)
                                                               │
        platformDiscovery (Claude verify → IG BD / YouTube) ◄──┤ handles
                                                               ▼
        athlete_snapshots { research JSON, sources, social, score }  ──► athletes_current (counts, story_arc)
                                                               │                     ▲
        proposeFoundAffiliations (kind=found, dated only) ◄────┤                     │ carry-forward (nightly)
        athletes.sport/school/division/conference (fill-if-null)◄┘                     │
                                                                                     │
   readers: scoring ─ context ─ record ─ onboarding block ─ kit/narrator/shot list ─ discovery handles
   (7 read the raw blob; 14 read the projected columns; none reads as_of; none reads the ledger for level except scoring)
```

### 2.2 Target

```
Athlete / candidate ──► IdentityHints { name, aliases, sport, current affiliation (ledger), hometown, known handles, connections }
                                │
                                ▼
                         ResearchService (server/services/intelligence/research/)
                          plan(domains due) → run(job) → normalize → resolve → persist → state
                                │
              provider adapters (injected; never imported by the service)
              ├─ search:      GeminiGroundedSearchAdapter  (future: OpenAI, Tavily, direct sources)
              ├─ extract:     KimiExtractionAdapter        (future: Gemini, OpenAI)
              ├─ signals:     TrendsAdapter, GdeltAdapter
              └─ identity:    SocialWebResolverAdapter (existing), IG BD / YouTube (Step 1a path)
                                │
                                ▼
        research_runs → research_source_payloads (sanitized envelopes, 90 d) → research_evidence (claims with URL, published_at, retrieved_at, extractor, confidence)
                                │
                                ▼
        Canonical Athlete Profile = athlete_facts (current | historical | superseded) + athlete_affiliations (ledger) + social_identities + athlete_inferences (story arc, classifications, with lineage)
                                │
                                ▼
        athlete_research_state (status, identity confidence, per-domain freshness, cost) ──► Athlete Index view
                                │
                                ▼
        Context Builder views ──► Identity (Step 3) · MIA / Signal Engine (Step 4) · Opportunity · Strategy · Mila · Record screen
```

## 3. Evidence → facts → inferences (the separation)

| Layer | What it is | Table | Mutability | Example |
|---|---|---|---|---|
| **Evidence / observations** | What a provider returned, as a claim tied to the exact source segment that supports it | `research_evidence` (+ `research_source_payloads` raw) | append-only; superseded evidence kept | "ESPN, 2025-11-02: 'Bhuta named All-ACC First Team'" — payload id, grounding chunk 7, quoted span, url from that chunk, published_at, retrieved_at, extractor kimi-k2@v3, confidence 0.8 |
| **Canonical facts** | What Nomila currently holds true about the athlete, with status, validity and origin | `athlete_facts`, `athlete_affiliations`, `social_identities` | resolved rows; status transitions, never silent overwrite | `achievement: All-ACC First Team, 2025, level conference` status current, origin research, source_class web_researched, provenance [evidence ids], confidence 0.8 |
| **Derived inferences** | Interpretations Nomila or a model produced from facts/evidence | `athlete_inferences` | versioned by model/rule; regenerable | `story_arc` text; `narrative_distinctiveness: high` (bounded taxonomy), lineage = fact ids + evidence ids + model version |

### 3.1 Provenance vocabulary (R1)

Two separate fields on every fact, never merged into one enum:

| Field | Values | Meaning |
|---|---|---|
| `source_class` (authority of the evidence) | **canonical, unchanged:** `connected_verified` \| `platform_public` \| `web_researched` \| `inferred` \| `imputed` | how trustworthy the evidence class is (spec §28.9). On `athlete_facts` a CHECK forbids `inferred` (an inference never becomes a fact) and `imputed` (an imputed value is a signal-engine concern, not a fact). |
| `origin` (who put the fact forward) | `athlete_asserted` \| `athlete_proof` \| `connection` \| `research` \| `backfill` | the provenance path. `athlete_asserted` / `athlete_proof` rows reference `athlete_asserted.id` (and a proof document later) and carry `source_class = NULL`: the athlete's own word is not evidence of a class, it is authority above the ladder. |

Precedence when resolving one fact key: `athlete_proof` > `athlete_asserted` > `connection` (`connected_verified`) > `research` by the source-type authority policy (§4.3) > `backfill` (treated as `research` with the original run's date). `inferred` output lives only in `athlete_inferences`.

### 3.2 Claim-to-source lineage (R5)

An extracted claim is only as good as the segment that supports it. The design makes lineage exact:

- The search adapter returns **chunks**, not a synthesized paragraph alone: for Gemini grounding, each `groundingChunk` (its own URI, title, retrieved text) and the `groundingSupports` that map spans of the synthesized answer to chunk indices, stored verbatim in the sanitized payload.
- The extraction adapter receives the chunk list with stable ids and must return, for every claim, `supporting_chunk_ids[]` and the quoted span (≤ 300 chars) it relied on. Extraction runs over the chunk texts (per chunk or per batch of chunks with ids), never over the synthesized prose alone.
- The service **validates** each citation: the chunk id must exist in the stored payload, the quoted span must occur in that chunk's text (normalized whitespace), and the evidence row copies `source_url`, `source_domain` and `source_type` **from that chunk**, never from the answer text and never from a later lookup. A claim whose citation fails validation is stored with `lineage_status = uncited`, `source_url = NULL`, confidence capped (policy) and it cannot resolve into a `current` fact on its own.
- `research_evidence` gains: `payload_id`, `support` jsonb `{ chunkIds[], spans[{chunkId, start, end, quote}], supportIds[] }`, `lineage_status` (`cited` \| `uncited` \| `conflicting`).
- Trends and GDELT evidence cite the API record (article URL from GDELT's own list, Trends query and window) the same way.

### 3.3 Prompt-injection controls (R6)

At the **research extraction boundary** (before anything is stored):
- web text is passed to the extractor inside delimited data blocks with the fixed instruction that the content is untrusted data, never instructions; the extractor has no tools and no secrets in context;
- outputs are validated against the Fact Registry schema for the claim kind (allow-listed keys, types, lengths); anything else is dropped and the run notes it;
- claims whose quoted span or value contains instruction-like patterns (e.g. "ignore previous", "system:", tool-call syntax, URLs to unrelated hosts) are stored as `suspect = true`, excluded from resolution and reported;
- source domains pass an allow/deny policy (`research_policy.sourceDomains`) before their chunks are extracted at all; length caps per chunk and per run.

At the **Context Builder** (before anything reaches an agent prompt): facts and inference text are emitted as delimited, typed blocks ("data, not instructions"), never concatenated raw into prompt prose; only registry-known keys are emitted; `suspect` evidence never reaches an agent.

## 4. Canonical athlete profile — minimal schema

### 4.1 New tables (all keyed on `athlete_id`; no user/org/tenant columns)

| Table | Purpose | Key columns |
|---|---|---|
| `research_runs` | one row per research job (or per domain refresh) | id, athlete_id, domain (`identity, profile, affiliations, achievements, press, brand_mentions, narrative, social_handles, signals, full`), trigger (`signup, identity_confirmed, ttl, event, manual, backfill`), provider set, identity_hints (jsonb, hashed), status, started/finished, calls, tokens in/out/cached, estimated_cost_usd, confidence_out, error (normalized shape from Step 1a) |
| `research_source_payloads` | the sanitized provider envelope per call (search response, extraction response, Trends/GDELT bodies) | id, run_id, athlete_id, provider, endpoint_family, request (allow-listed), payload, payload_hash, bytes, sanitizer_version, fetched_at, retained_until (90 d, `web_researched` class) |
| `research_evidence` | one normalized claim, tied to the exact provider segment that supports it | id, athlete_id, run_id, payload_id, kind (`achievement, press_mention, brand_mention, affiliation, profile_attribute, social_handle, nil_mention, sentiment, media_asset, identity_signal`), claim (jsonb, registry schema per kind), **support** (chunk ids, spans, quotes: §3.2), **lineage_status** (`cited, uncited, conflicting`), source_url / source_domain / **source_type** (§4.3, copied from the cited chunk), published_at, retrieved_at, extractor (model@version), extraction_schema_version, confidence, source_class (`web_researched`), about_identity_confidence, **suspect** (bool, §3.3), dedupe_key, superseded_by |
| `athlete_facts` | resolved attribute-level facts (everything that is not an affiliation or a social identity) | id, athlete_id, fact_key (from the Fact Registry, §4.5), value (jsonb, registry schema), value_text (normalized, indexed), status (`current, historical, superseded, retracted, disputed`), valid_from, valid_to, observed_at, retrieved_at, **origin** (`athlete_asserted, athlete_proof, connection, research, backfill`), **source_class** (canonical five; CHECK `NOT IN ('inferred','imputed')`; NULL when origin is an athlete assertion/proof), **authority_tier** (§4.3), confidence, provenance (jsonb: evidence_ids[], asserted_id, connection_id, proof_id), freshness_family, resolver_version, registry_version, created_at |
| `athlete_inferences` | derived interpretations | id, athlete_id, inference_key (`story_arc, narrative_distinctiveness, brand_fit_lanes, identity_line, …`), value (jsonb/text), taxonomy_version, producer (model@version or rule@version), lineage (fact_ids[], evidence_ids[]), confidence, computed_at, superseded_by |
| `athlete_research_state` | one row per athlete: the lifecycle and the cheap-lookup summary | athlete_id (PK), research_status (§5, research only), identity_confidence (0–1), identity_resolved_at, domains (jsonb: domain → {status `missing\|partial\|complete\|stale\|disputed`, last_run_id, last_researched_at, stale_after}), disputed_domains[], last_researched_at, next_due_at, total_cost_usd, search_hints (jsonb), updated_at. **Connection status is not stored here** (§5.1) |

Existing tables reused as-is: `athlete_affiliations` (the affiliation ledger already models current vs historical, said/found/proof), `athlete_asserted`, `social_identities` (Step 1a), `athletes` (identity/auth row; its `school/division/conference` become a projection of **current** facts only, §4.4), `model_params` (policy).

Migration: one `0046_research_substrate.sql`, pure DDL, `IF NOT EXISTS`, six tables plus `CREATE EXTENSION IF NOT EXISTS pg_trgm` and a trigram index on `athletes.full_name` and on `athlete_facts.value_text WHERE fact_key = 'alias'` for the index search. Nothing dropped; `athlete_snapshots.research` stays until Step 4 reads move.

### 4.2 Field-by-field: the requested canonical profile

| Requested field | Canonical home | Current vs historical | Notes |
|---|---|---|---|
| name / aliases | `athletes.full_name` (asserted); `athlete_facts` `alias` rows | n/a | aliases from research evidence (nicknames, maiden names, transliterations) with confidence |
| sport | `athlete_facts` `sport` (origin athlete_asserted > research) + `athletes.sport` projection | status | multi-sport = several current rows (registry cardinality `multi`) |
| position / event | `athlete_facts` `position` / `event` | status, valid_from/to | today only in `research.profile` free text |
| team / school / organization | `athlete_affiliations` (+ `origin`, `authority_tier`, evidence ids on found rows) | `ended_on IS NULL` = current; `is_primary` | found rows require a date (kept); a tier ≤ 2 found row may be current and primary for an unclaimed athlete (§4.3 rule 7) |
| competition level | `athlete_affiliations.level` per row; derived `levelRecord` | per affiliation | `level` gets a CHECK vocabulary in 2b |
| graduation / class year | `athlete_facts` `graduation_year` (integer) and `class_year` (label, dated) | `class_year` is historical by construction: a label observed at a date | "Senior (2026 season)" becomes `{label, season: 2026}` observed 2026-06 |
| geography / nationality | `athlete_facts` `hometown`, `nationality` | | only when publicly supported evidence exists; confidence carried |
| achievements | `athlete_facts` `achievement` rows `{name, year/date, level, org}` | dated → historical facts by nature; "recency" is a signal concern (spec §21.1) | replaces the JSON list; each row cites evidence |
| rankings / awards / national team | `athlete_facts` `ranking`, `award`, `national_team_participation` (+ affiliation `org_kind=national`) | dated | |
| known social identities | `social_identities` | status active/superseded | research-found handles land as `web_researched` identities with the resolver's confidence (fixes D10) |
| media / news evidence | `research_evidence` kind `press_mention`, `media_asset` | evidence, not facts | counts derived at read time |
| current vs historical affiliations | `athlete_affiliations` | native | |
| career status | `athlete_facts` `career_status` (asserted) + `athletes.career_status` projection | | |
| research status / last researched / freshness | `athlete_research_state` | | |
| confidence / provenance | on every fact, evidence and inference row | | |

### 4.3 Resolution rules (evidence → fact), with the source-type authority policy (R3)

**Source-type authority tiers** (`research_policy.sourceTypeAuthority`, versioned; initial v1):

| Tier | `source_type` | Examples | Notes |
|---|---|---|---|
| 1 | `official_governing_body` | federation / league / NCAA results, rankings, national-team rosters | authoritative for affiliations, level, results, national-team participation |
| 2 | `official_team_or_school` | athletics-department roster or bio page, club/pro team site | authoritative for current affiliation, position, class year, hometown |
| 3 | `major_news` | national outlets and wire services (allow-list) | authoritative for achievements, press, brand mentions; dated |
| 4 | `reference` | encyclopedic / stats references (allow-list) | good for historical facts; weaker for "current" |
| 5 | `regional_news` | local and campus press | as 3 with lower weight |
| 6 | `athlete_authored_public` | the athlete's own public bio / posts (public platform text) | strong for handles, self-described position/hometown; still `web_researched` unless it came through a connection |
| 7 | `aggregator_or_blog` | NIL trackers, blogs, forums | may corroborate; never establishes a fact alone |
| 8 | `unknown` | domain not classified | as 7 |

Rules, applied per fact key by the registry's resolver (§4.5):

1. **Group** evidence by fact key + normalized value (registry normalizer; conference normalization at write time, fixes D11). `suspect` and `uncited` evidence is excluded from resolution (uncited may corroborate only).
2. **Origin first**: `athlete_proof` > `athlete_asserted` > `connection` > `research`. An athlete assertion or proof always wins for its key and marks conflicting researched rows `superseded`, not `disputed` (R4: the athlete overrides research).
3. **Within `research`**: rank candidate values by (best authority tier among their evidence, then corroboration count across distinct source domains, then recency of `published_at`/`retrieved_at`, then extractor confidence). Newer-plus-higher-confidence alone never displaces a higher-tier current value.
4. **Displacement**: a candidate from a lower tier may replace a current higher-tier value only when the current value's evidence is older than the key's freshness TTL **and** the candidate is corroborated by at least two independent domains, or when the candidate is itself tier ≤ 2. Otherwise the candidate is recorded `disputed` beside the current row.
5. **Time**: a fact with `valid_to` in the past is `historical`; a class-year label is `current` only for the season it names; dated achievements are historical facts by nature (recency is a signal concern).
6. **Supersede, never overwrite**: every resolution inserts and sets `superseded_by`.
7. **Establishing a current affiliation without the athlete (R4)**: for an athlete with no `said` or `proof` affiliation rows, a `found` affiliation may become **current and primary** — and project into `athletes.school/division/conference` — when it is supported by tier ≤ 2 evidence with a season or date, or by two independent tier ≤ 3 sources agreeing on org and season; the row keeps `kind = 'found'`, `origin = research`, its evidence ids and its authority tier, so the Record screen and the Index show it as researched, not said. The moment the athlete asserts or proves affiliations, `levelRecordFor`'s existing rule applies (found rows yield to said/proof) and the projection follows the athlete.

### 4.4 Current affiliation vs historical (the projectPrimary fix, revised per R4)

- `athletes.school/division/conference` are projected **only** from the primary **current** affiliation (`ended_on IS NULL`), whether that row is `said`, `proof`, or a `found` row that met §4.3 rule 7. With no current affiliation the projection becomes NULL and `career_status` carries the meaning (`between_teams`, `retired`); a retired athlete's last team stays in the ledger as historical.
- Research never back-fills those columns directly (today it does when NULL); it writes affiliation rows with evidence, and the projection follows the ledger.
- Athlete assertion or proof overrides: `replaceSaidAffiliations` remains the athlete's path; a found current affiliation that conflicts with a said one becomes `ended_on = asserted date` (historical), not deleted.
- The Record screen and the Index label division/conference by real provenance (`said` / `found` + authority tier / `proof`) and the affiliation's dates, never "found online · researchedAt" (fixes D2).
- Search hints use the primary current affiliation from the ledger, not the projection (fixes D8).

### 4.5 Fact Registry (R8)

A versioned, code-owned registry (`server/services/intelligence/research/factRegistry.ts`, `FACT_REGISTRY_VERSION = "v1"`) is the single source of truth for what a fact key is. Nothing writes an `athlete_facts` row whose key is not in the registry; `registry_version` is stamped on every fact row. Each entry declares:

| Attribute | Meaning |
|---|---|
| `key` | the `fact_key` |
| `schema` | zod schema of `value` (typed, allow-listed keys, length caps) |
| `cardinality` | `single` (one current value), `multi` (several current values, e.g. aliases, sports), `dated_multi` (many rows each with a date, e.g. achievements) |
| `normalizer` | canonical form for `value_text` and grouping (name case/diacritics, conference normalization, year parsing) |
| `resolver` | which policy resolves it: `authority_default` (§4.3), `affiliation` (rule 7), `dated_event` (dedupe by name+year), `identity_signal` |
| `freshness_family` | the `research_freshness` family whose TTL applies |
| `scoring_eligible` | whether the Signal Engine may consume it (Step 4), and the owning dimension when yes |
| `blocking` | whether a dispute on this key blocks `research_complete` (R7): `identity` and `current_affiliation` keys only |
| `display` | label and the Record screen group; provenance always shown |

Initial keys (v1):

| key | cardinality | schema (value) | resolver | freshness | scoring_eligible | blocking |
|---|---|---|---|---|---|---|
| `name` | single | `{ full, first?, last? }` | authority_default | identity | no | yes |
| `alias` | multi | `{ text, kind: nickname\|maiden\|transliteration\|handle_name }` | authority_default | identity | no | no |
| `sport` | multi | `{ sport, discipline? }` | authority_default | identity | yes · athletic_authority (cohort) | yes |
| `position` | single | `{ text }` | authority_default | affiliations | no | no |
| `event` | multi | `{ text }` | authority_default | affiliations | no | no |
| `class_year` | single | `{ label, season }` | authority_default | affiliations | no | no |
| `graduation_year` | single | `{ year }` | authority_default | affiliations | yes · athletic_authority (career stage) | no |
| `hometown` | single | `{ city?, region?, country? }` | authority_default | identity | no | no |
| `nationality` | multi | `{ country }` | authority_default | identity | no | no |
| `career_status` | single | `{ status }` | authority_default (assertion expected) | affiliations | yes · momentum/brand_fit gating | no |
| `achievement` | dated_multi | `{ name, year?, date?, level, org? }` | dated_event | achievements | yes · athletic_authority | no |
| `award` | dated_multi | `{ name, year, org?, level }` | dated_event | achievements | yes · athletic_authority | no |
| `ranking` | dated_multi | `{ body, rank, year, scope }` | dated_event | achievements | yes · athletic_authority | no |
| `national_team_participation` | dated_multi | `{ team, level, year, role? }` | dated_event | achievements | yes · athletic_authority | no |
| `nil_mention` | dated_multi | `{ source, value, year? }` | dated_event | brand_mentions | no (never commercial_proof) | no |

Affiliations keep their own table and the `affiliation` resolver; social identities keep `social_identities`. Press and brand mentions are evidence, not facts, and are counted or classified at read time.

Registry changes are versioned: a new key or a changed schema/resolver bumps `FACT_REGISTRY_VERSION`; rows written under an older version stay readable (the version is on the row) and can be re-resolved by a backfill.

## 5. Research lifecycle and cost ladder

### 5.1 States (`athlete_research_state.research_status`, research only — R2, R7)

| State | Meaning | Enters on | Cost so far |
|---|---|---|---|
| `seed_only` | a name (+ maybe sport/school) exists; nothing verified | signup/waitlist/discovery insert, or backfill of a `raw` athlete | 0 |
| `identity_resolved` | the candidate is disambiguated: identity hints + at least one identity signal (confirmed by the athlete, a connection, or a high-confidence resolver match) | claim/confirm, OAuth connect, or the identity step | SEED + IDENTITY RESOLUTION (1–2 cheap calls) |
| `research_partial` | a **blocking** domain is missing or disputed (identity, current affiliation), or fewer than the required domains have completed | first run with blocking gaps; a blocking dispute | FULL RESEARCH partly |
| `research_complete` | every required domain `complete` within its TTL; non-blocking domains may be `disputed` or `partial` and are listed in `disputed_domains` | full run success | FULL RESEARCH |
| `research_stale` | at least one required domain past its TTL | nightly planner | 0 until refreshed |

**Connection is orthogonal (R2).** `connection_status` (`none` \| `active` \| `expired` \| `revoked`) is derived from `connected_accounts` (and `social_identities`) at read time, never stored in the research state. The UI and the Index may show a composite label (e.g. "researched · connected"), but no research transition depends on it; a connection changes the *authority* of social facts (connected beats web-researched), not the research status.

**Domain-aware completeness (R7).** Each domain carries its own status (`missing` \| `partial` \| `complete` \| `stale` \| `disputed`). Only disputes on **blocking** keys (registry `blocking = true`: `name`, `sport`, and the current affiliation) hold the athlete at `research_partial`. A disputed `hometown` or `class_year` leaves the athlete `research_complete` with `disputed_domains = ['profile']`, visible to the Record screen and the Index, and refreshable on its own.

### 5.2 Ladder

SEED (free) → IDENTITY RESOLUTION (index lookup, one resolver call at most, "is this you?" or a connection) → FULL RESEARCH (once, after identity is resolved; domain plans, capped calls, stop when evidence confidence is sufficient) → VERIFIED SOCIAL ENRICHMENT (connections, Step 1a; changes authority, not research status). Full research never runs from a bare auth name (spec §4); today it does at signup when a sport is supplied. Identity may be resolved without the athlete for public athletes when tier ≤ 2 evidence agrees on name + sport + current affiliation (R4); the athlete's confirmation raises `identity_confidence` to 1.0 but is not a precondition.

### 5.3 Domains, independently refreshable

| Domain | Evidence kinds | TTL (from `research_freshness v0.1-alpha`, to be activated) | Refresh trigger |
|---|---|---|---|
| identity | aliases, identity signals, social handles | 365 d | assertion changes name/sport/school; connect |
| affiliations / competition level | affiliation, level | 180 d | season boundary; assertion |
| achievements | achievement, award, ranking, national team | never expire; **new-achievement scan** every 90 d | event (press spike) |
| press | press_mention | 30 d current / 90 d history | GDELT count change |
| brand_mentions | brand_mention, nil_mention | 180 d | |
| narrative (inference) | story_arc, classifications | 180 d or on any domain refresh | |
| signals | Trends, GDELT numbers | 30 d | nightly (cheap) |

The nightly planner reads the state rows, picks domains past `stale_after` under a daily budget (`model_params` family `research_policy`: max runs/day, max calls/run, providers per domain), and enqueues `research_refresh` workflow runs per domain. The monthly full re-enrich cron is retired once the planner is live.

## 6. Freshness / cache policy

- TTLs come from the `research_freshness` param family (activate `v0.1-alpha` in 2b after review), never from constants; the Step 1a `signals.freshnessDays.web_researched = 30` remains the metric-level rule.
- Evidence is never deleted (raw payloads are, at 90 days). Freshness is a property of the fact's domain; a stale fact stays visible, marked stale, until refreshed or asserted.
- Dedupe by `dedupe_key` (kind + normalized claim + source_domain): the same headline seen in two runs is one evidence row with `retrieved_at` of the first sighting and a `last_seen_at` update; no more "richest run wins".
- Cache: the canonical profile is the cache. A run only executes when the planner says a domain is due or an event fired. No search runs on login, on Mila open, or on re-score.
- Cost telemetry per run (model, tokens in/out/cached, calls, latency, estimated USD, confidence) is recorded on `research_runs` (spec §4); today only tokens are stored and cost is 0.

## 7. Provider abstraction

```ts
// server/services/intelligence/research/providers.ts (types only; the service receives implementations by injection — the
// intelligence boundary test keeps provider modules out of this directory, as with the Stories `call`)
interface SearchProvider   { id: string; search(plan: DomainQueryPlan, hints: IdentityHints, opts: { maxCalls: number }): Promise<SearchEnvelope[]> }   // envelope = raw response + chunks[{ id, url, title, text }] + supports[] (R5)
interface ExtractProvider  { id: string; extract(chunks: Chunk[], schema: ExtractionSchema, hints: IdentityHints): Promise<ExtractionEnvelope> }   // every claim cites chunk ids + quoted spans; text passed as delimited untrusted data (R6)
interface ClassifyProvider { id: string; classify(input: ClassificationInput, taxonomy: Taxonomy): Promise<ClassificationEnvelope> }
interface SignalProvider   { id: string; fetch(hints: IdentityHints): Promise<SignalEnvelope> }   // Trends, GDELT
interface ResearchProviders { search: SearchProvider[]; extract: ExtractProvider; classify?: ClassifyProvider; signals: SignalProvider[] }
```

- Adapters live under `server/lib/research/providers/` (`geminiGrounded.ts`, `kimiExtract.ts`, `trends.ts`, `gdelt.ts`, later `openai*.ts`, `tavily.ts`), each returning a **native envelope** (raw response + request record + usage + errors classified as in Step 1b) that the service sanitizes and stores before adapting. The search envelope must expose the provider's own citation structure (Gemini: `groundingChunks` + `groundingSupports`); a provider that cannot cite is limited to `uncited` evidence by policy.
- Provider choice and caps are policy (`model_params` family `research_policy`), never schema: evidence rows carry `extractor`/`provider` as provenance strings; no column is provider-shaped.
- Gemini and Kimi stay the defaults. Adding OpenAI later is a new adapter and a policy row.
- The Step 1a sanitizer contract applies unchanged (secrets: provider API keys; URL param stripping; leak gate refuses the write).

## 8. Athlete Index

What exists today: `athletes` rows for non-users (`auth_id IS NULL`, status `raw/enriched/waitlisted`), `athletes.socials`, `social_identities` (Step 1a), `athlete_affiliations`, no trigram index, no aliases, no identity confidence, no research status.

Proposal: a SQL view `athlete_index_v` (no new table) over `athletes` ⨝ `athlete_research_state` ⨝ current primary affiliation ⨝ `social_identities` (active) ⨝ alias facts:

```
AthleteIndexRecord { athleteId, fullName, aliases[], sport, teamOrSchool?, level?, graduationYear?, cityOrCountry?, knownSocialHandles?, identityConfidence, researchStatus, connectionStatus (derived, never stored), disputedDomains[], lastResearchedAt? }
```

- Candidate search = `pg_trgm` similarity on `full_name` and aliases, optionally narrowed by sport / school, returning top-N with a match score and `identityConfidence`; a candidate with `research_status = seed_only` and no signals is shown as "unverified".
- Claim / "is this you?" / confirm is Step 3 UI; the index query and a `POST /api/v1/index/candidates` endpoint (auth-scoped, rate-limited, returns public index fields only) are 2c. Golden anchors and discovery-only rows are index members but flagged `claimable: false` unless policy allows (open decision).
- Targeted refresh on claim: the state machine moves `seed_only → identity_resolved` and the planner schedules only stale domains.

## 9. Migration / backfill strategy

1. **Dual-write, flag-gated** (`RESEARCH_SUBSTRATE_WRITE`, default off, dev on after verification): `researchAthlete` keeps producing `athlete_snapshots.research` for legacy readers and additionally hands its native envelopes to the service, which stores payloads, evidence and resolved facts. Byte-for-byte preservation of the snapshot blob, scores, rates and MIA outputs (same method as Steps 1a/1b).
2. **Backfill** from existing data (dry-run first, per-athlete report, skips reported not guessed):
   - the 5 distinct research versions per athlete (not the 66 carry-forwards) → one `research_run` each with `trigger = backfill`, `retrieved_at` = first `created_at` of that version; `sources` → run telemetry; the blob → evidence rows (achievements, press, brand mentions, profile attributes, handles, nil mentions) with `published_at` NULL where the blob has no date and **`lineage_status = uncited`, `source_url = NULL`** (the blob kept no citations; no URL is reconstructed after the fact, R5) — backfilled evidence may corroborate but cannot alone establish a `current` fact; a first live domain refresh re-cites what is still true;
   - facts resolved by §4.3 with `origin = backfill`; class-year labels dated by the run; `athlete_affiliations` untouched (already canonical; existing `said` rows keep precedence);
   - `story_arc` → `athlete_inferences` with lineage to that run;
   - `athlete_research_state` seeded: `raw` → `seed_only`; `enriched` with research → `research_partial` (backfilled evidence is uncited) until the first cited refresh, then `research_complete` or `research_stale` by TTL; identity_confidence 1.0 for athletes with a connection or a claim, 0.5 for researched-only rows; connection status derived, not stored.
3. **Reader migration** (2d and Step 4): Context Builder views replace the seven raw-blob readers and the fourteen projection readers one at a time, each with a byte-for-byte check of its output; scoring reads move in Step 4 (Signal Engine). Carry-forward (D1) is removed only after the last reader is off the blob.
4. `athlete_snapshots.research` is then frozen (kept for history) and the monthly re-enrich cron retired.

## 10. Risks and open decisions

| # | Item | Recommendation |
|---|---|---|
| O1 | Table set: `athlete_facts` generic (kind + jsonb) vs typed tables per fact kind | generic with a per-kind claim schema and `value_text` for search; typed views later |
| O2 | Achievements as facts rows vs staying a list | rows (each cites evidence; recency is per row) |
| O3 | `class_year` handling | store the dated label and a derived `graduation_year` integer; never treat a label as current beyond its season |
| O4 | Dispute policy for conflicting single-valued facts | **decided (R3):** authority tier → corroboration → recency → confidence; lower tier displaces only past TTL with two independent domains; otherwise `disputed` beside the current row |
| O5 | Raw research payload retention | 90 d (D2 `web_researched`) |
| O6 | Prompt-injection fencing for web text (D12) | **decided (R6):** at the extraction boundary (2a) and at the Context Builder (2d), §3.3 |
| O7 | pg_trgm on Cloud SQL | supported; extension created in 0046 |
| O8 | Golden anchors / discovery-only rows in the index and the claim flow (D9) | index members, `claimable = false` by default; the claim flow itself is Step 3. Per R4 their affiliations may be established from tier ≤ 2 evidence without a claim |
| O9 | Full research at signup when sport is supplied (today) | stop after 2b: signup → `seed_only`; identity step → `identity_resolved` (athlete confirmation or tier ≤ 2 evidence); full research once |
| O10 | Which readers move in Step 2 vs Step 4 | Record screen, onboarding block, context, kit/narrator/shot list, discovery handles in 2d; scoring in Step 4 |
| O11 | User/athlete coupling on `athletes` (auth columns on the athlete row) | unchanged in Step 2; Step 3 splits it; nothing in Step 2 assumes athlete = user |
| O12 | OpenAI adapter | not built; policy row and adapter slot exist |
| R1 | Both production models are sunset by Oct 2026 | adapters make the swap a policy change |
| R2 | Kimi extraction cost telemetry is zero today | compute USD from a priced model table in `research_policy` |
| R3 | Prior-union semantics change (richest-run-wins → evidence dedupe) can change achievement counts the score reads | scoring keeps reading the legacy blob until Step 4; the reconciliation compares counts per athlete before the switch |
| R4 | Gemini grounding supports may not cover every claim the extractor makes | such claims are `uncited` by construction; the first month measures the cited share per domain and the query plans are tuned before 2b |
| R5 | Source-type classification of domains needs an allow-list to be maintained | policy rows in `research_policy` (versioned); unknown domains default to tier 8 |

## 11. Exact implementation sequence

| PR | Scope | Gates |
|---|---|---|
| **2a foundations** | migration 0046 (six tables + pg_trgm, IF NOT EXISTS; `athlete_facts` CHECKs on `source_class`, `origin`, registry key); **Fact Registry v1**; evidence kinds, domains, states; provider interfaces and the four adapters wrapping today's Gemini/Kimi/Trends/GDELT calls unchanged **but returning chunks + supports**; extraction with citation validation and injection controls (§3.2–3.3); `ResearchService.persist` (sanitize → payloads → evidence → resolve by the authority policy → facts/inferences → domain statuses → state); flag `RESEARCH_SUBSTRATE_WRITE` off; dual-write from `researchAthlete` behind the flag; backfill script (dry-run default, uncited lineage) | tests (PGlite): registry validation, citation validation (cited / uncited / conflicting), authority-tier resolution incl. displacement and dispute, rule 7 affiliation establishment, assertion override, `inferred` refused as a fact source, class-year dating, injection heuristics, sanitizer; byte-for-byte snapshot/score/rate/MIA check; migration dry-run; drift gate; no readers |
| **2b lifecycle** | state machine + `athlete_research_state`; domain plans; nightly planner behind the flag (writes runs, executes only when `RESEARCH_REFRESH_ENABLED`); activate `research_freshness v0.1-alpha` + seed `research_policy v0.1-alpha` (reviewed); `research_runs` cost telemetry; monthly re-enrich becomes a no-op when the planner is on; signup no longer runs full research (state `seed_only`) | planner tests; cost per athlete/day evidence on dev; Mia domain-refresh dry runs |
| **2c index** | `athlete_index_v` view; candidate search endpoint (auth-scoped, public fields only); `claimable` policy; no UI | search tests with synthetic names; latency on dev |
| **2d readers** | Context Builder (`getCanonicalProfile`, purpose views); migrate Record screen, onboarding block, `getAthleteContext`, kit/narrator/shot list, discovery handles; `projectPrimary` current-only rule; fix D2, D4, D5, D6, D7, D11 as part of the moves; carry-forward removed | per-reader byte-for-byte on dev; Facts screen provenance review with Mia |
| **Step 4 (not Step 2)** | scoring/Signal Engine reads facts and features; freeze the blob | — |

Each PR: design shown here → code → review → merge → deploy via the normal path → dev evidence appended to `docs/architecture/phase-a/step2-research.md`. Prod stays off until the prod-enablement step.

## 12. Note on the external-reviewer-access plan

No record of an "external-reviewer-access implementation plan" exists in this session, in the project docs, or in my notes; I have not touched DB, IAM or runtime for it. Point me to the plan (file, PR or page) and I will continue it as a plan-only track until Story acceptance is finished and the plan is reviewed.
