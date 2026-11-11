# Phase A · Step 2d — Reader Migration / Canonical Context (AUDIT + DESIGN + MIGRATION MAP, no code)

**Status:** APPROVED and FROZEN (11 Sep 2026) after design review round 1 plus three consistency corrections. The 2d-1 implementation PR is built exactly against this document; no further design review unless implementation reveals a material architectural conflict.
**Spec:** Blueprint V1 / Commercial Intelligence Beta.1 §3 (canonical Athlete Intelligence Profile with provenance), §5 (Context Builder: one canonical context, purpose views, "data, not instructions"), §6 (as-of dates), §28.9 (source authority). Approved Step 2 design `step2-research-canonical-profile-design.md` §2.2 (target flow), §3 (evidence → facts → inferences), §4.4 (projection current-only rule), §11 "2d readers" row, O10; the 2a/2b/2c records that defer items to 2d.
**Objective:** move every downstream reader off the legacy research blob (`athlete_snapshots.research`, carried forward nightly) and the sticky projections (`athletes.school/division/conference/segment`, `athletes.socials`, `athletes_current.story_arc/*_count`) onto ONE canonical context built from the substrate: `research_evidence → athlete_facts / athlete_affiliations / social_identities / athlete_inferences → canonical athlete context → readers`.
**Invariants preserved:** facts, inferences, assertions and provenance stay distinct; authority `connected_verified > platform_public > web_researched > inferred > imputed`; assertions override where policy permits and never become research evidence; current affiliation comes from the canonical affiliation/fact resolution, never the stale projection; research freshness and social connection stay orthogonal; no reader falls back to stale legacy data silently; no Beta.1 MIA logic (Marketability is Step 4); the 2b planner and 2c claim flags stay off; production behaviour is preserved while readers migrate behind explicit boundaries.

## Revision log (review round 1)

| Review point | Where it landed |
|---|---|
| Canonical-empty never falls back to legacy: per-domain coverage `unavailable \| populated \| confirmed_empty \| disputed`; legacy only for `unavailable`; aggregate `sourceMode` with section-level provenance; Brand X regression | §3.2, §2.2 `coverage`, G5b |
| Uncited legacy blob data is not `web_researched`: `origin legacy_blob, sourceClass null, lineage legacy, authorityTier null`; never wins an authority comparison | §2.2 rules, §3.1 |
| Historical `as_of` backfill from authoritative lineage, not MD5 alone; NULL over a false date | §4.3 (writer audit + the deterministic rule) |
| Counts reconciled (63 concrete read sites → 43 logical readers); `audience` section added to the contract | §1.2, §2.2 |
| `syncAffiliationsFromFacts` explicitly idempotent (stable key, reconfirm, change, historical, said/proof precedence); G6 tests | §3.5, G6 |
| Locked: D2 adapter approved; D3 carry-forward kept through 2d with `as_of`, removed in Step 4; D6 delete `buildNarratorContext`, `brandFitTags` only as a versioned inference; D7 `commercialState` from confirmed deals only | §1.2 #22, §2.2 `commercial`, §4, §9 |

## What the athlete experiences, and what happens underneath

Today every screen and every agent that talks about an athlete reads its own copy of her: the Facts screen parses the research blob one way, the onboarding greeting another, the deck a third, the shot list a fourth, and most of them read the school off a column that research back-filled once and the nightly re-score re-dates every night. Three Facts rows never fill (position, class year, hometown), the "causes" card never renders, the Story tab looks for a field nobody emits, and "found online · today" is written under a team she typed herself.

After 2d there is one place that says who she is and how we know: the canonical athlete context. Every field carries where it came from (her word, a contract, a connected account, a cited web source), when it was retrieved, and whether it is still fresh. The Facts screen, the greeting, the deck and the search anchor all read that one context, so a correction she makes once shows up everywhere, a stale team reads as stale, and a research date is the day the research ran. Nothing visible changes at merge: the context builder ships behind a reader flag that is off in both environments, each reader is moved one at a time with a proof that its legacy output is unchanged, and the score itself keeps reading exactly what it reads today until Step 4.

## 1. Current state (audit, 11 Sep 2026)

### 1.1 The two legacy sources and how they are fed

| Source | Written by | Read by | Defects |
|---|---|---|---|
| **The research blob** `athlete_snapshots.research` (jsonb: `achievements, press_mentions, brand_mentions, story_arc, teams, sentiment, social_handles, profile{position,class_year,hometown,…}, nil_valuation_mentions, media_assets`) | `researchAthlete` (`:701-711`) after a 5-deep `unionResearch` with prior blobs (`:591-597`, D3 spread-merge keeps every prior `profile`/`social_handles` key forever); **copied forward verbatim** with `created_at = now` by the nightly re-score (`refreshScores.ts:253-255`) and by connect (`fetchSocialData.ts:288, 311`) | 7 production readers + scoring (§1.2) | D1 (re-dated), D3 (never forgets), D4 (`profile.*` vs top-level), D5 (`values/causes` never written) |
| **The projection** `athletes.school/division/conference/segment` | `projectPrimary` from the said ledger only (`affiliations.ts:219-229`; early return keeps stale values when no current row, C13); research **fill-if-null** (`researchAthlete.ts:749-754`, raw conference D11); waitlist `coalesce` | 21 direct readers (§1.2) | C13 (retired athlete keeps last team), D2 (shown as "found online"), D8 (search anchored to it), D11 |
| `athletes.socials` (entered handles) | landing page merge; nothing else | `collectKnownHandles`, `knownHandlesFor`, Record handle line, discovery, admin | D7 (monthly sweep passes no handles), D10 (resolver confidence discarded) |
| `athletes_current.story_arc / achievements_count / press_count / brand_mentions_count` | `writeAthletesCurrent` only when a research run passes `research` (`athletesCurrentWriter.ts:76-82`); a nightly re-score leaves them untouched | context, Record, kit, shot list, brief | `brand_mentions_count` has no reader; `brand_stories`, `insights` dead (C24); D6 (Story tab reads a field no group emits) |

**The substrate read side today:** exactly one production reader outside `services/intelligence/` — `hintsFor` (`researchDualWrite.ts:72`) reading alias/hometown facts for extraction hints. No display, prompt or scoring reader touches `athlete_facts`, `athlete_inferences`, `research_evidence`, `athlete_research_state`, `athlete_index_v`, `social_features` or `social_metric_observations`. On dev the research substrate holds zero rows (`RESEARCH_SUBSTRATE_WRITE=false`, backfill unapplied), which fixes the shape of the migration: **2d must work in a legacy-populated world and switch to canonical without a second code path per reader.**

### 1.2 Reader inventory and classification

Classification: **KEEP** (unchanged in 2d), **MODIFY** (reads the canonical context instead of legacy sources), **EXTRACT** (duplicated logic pulled into the context builder), **REPLACE** (behaviour replaced), **ADD** (new). Audience: A athlete-facing, B brand-facing, M admin, I internal.

| # | Reader | Where | Legacy dependency | Aud. | 2d |
|---|---|---|---|---|---|
| 1 | `getAthleteContext` (deck/brief athlete half) | `services/athleteContext.ts:162` | blob (`brand_mentions`, `achievements`, `values/causes`), projection, `story_arc`, `org` falls back to `schoolShort(school)` | A+B | **MODIFY** → `deck` view; the blob parse and the projection fallback leave |
| 2 | `getAthleteRecord` (Facts / Story / Teams) | `services/athleteRecord.ts:110` | blob (8 keys), projection (D2 at `:198`), socials, `story_arc` (D6) | A | **MODIFY** → `record` view with real provenance; fixes D2, D4, D5, D6 |
| 3 | `GET /me/record`, history, `PUT /me/record/:field` | `routes/record.ts` | inherits #2; the PUT re-projects | A | KEEP (route) / MODIFY (#2) |
| 4 | `GET /auth/me` | `routes/auth.ts:250-272` | `school`, `conference` columns | A | **MODIFY** → identity view (`currentTeam`, `conference`) |
| 5 | `loadOnboardingFacts` / `renderOnboardingBlock` ("what Mila found") | `mila/onboarding.ts:466, 560` | blob (`achievements, brand_mentions, causes` D5), projection, `researched:` date (D1) | A (prompt) | **MODIFY** → `prompt` view (fenced, typed, provenance-labelled); the date becomes the real research as-of |
| 6 | `readColumn` (receipt "from") | `mila/onboarding.ts:235` | projection | I | KEEP (the receipt records what the column held; assertions are the athlete's word) |
| 7 | `get_profile` tool | `mila/tools/getProfile.ts:26` | projection | A | **MODIFY** → identity view |
| 8 | `get_score`, `get_rate_card`, `get_brand_fit`, `get_first_look` tools | `mila/tools/*` | `athletes_current` / none | A | KEEP |
| 9 | legacy chat v1 inline prompt | `routes/chat.ts:318, 359` | `school` interpolated unfenced | A | **MODIFY** → identity view, fenced (D12 class) |
| 10 | voice `get_athlete_profile` | `voice/profileRoute.ts:74` (+ pure speakable gate) | projection | A | **MODIFY** → identity view; the speakable gate unchanged |
| 11 | `computeScore` | `services/scoringService.ts:741` | blob via `snapshotAdapter`, projection via `AthleteRecord` | I | **KEEP** (Step 4 moves scoring onto facts + features; not 2d) |
| 12 | `refreshAthleteScore` (nightly) | `skills/refreshScores.ts:186` | carry-forward `:253-255` (D1); `levelRecordFor`; `school` column | I | **MODIFY** — carry-forward keeps feeding scoring but stops re-dating: writes `athlete_snapshots.as_of` = the research as-of (§4); `school` from the ledger |
| 13 | `fetchSocialData` (connect) | `skills/fetchSocialData.ts:155` | carry-forward `:288, 311` | I | **MODIFY** — same `as_of` rule |
| 14 | `computeRateCardFromScore` | `services/rateService.ts:242` | `record.school` (pass-through), ledger for level | A+B | KEEP (rates are Step 5; `school` is not used in arithmetic) |
| 15 | onboarding v1/v2 `research` step | `workflow/definitions/onboarding.ts:59, 118` | `buildSearchName` on the projection (D8); freshness gate on `created_at` (D1) | I | **MODIFY** → `searchAnchorFor` from the `search` view; the freshness gate reads `as_of` |
| 16 | `collectKnownHandles` | `onboarding.ts:32` | socials + connections | I | **EXTRACT** → `knownHandles` in the `search` view (identities > connections > entered) |
| 17 | `research_refresh` v1 | `definitions/researchRefresh.ts:27` | projection + socials | M | **MODIFY** → `searchAnchorFor` |
| 18 | `firstLook` | `skills/firstLook.ts` | none | A | KEEP |
| 19 | `assembleBrief` / `athleteHalf` (Studio) | `studio/brief.ts:761, 330` | via #1 (`division/conference/segment`, `storyArc`) | A | MODIFY via #1 (no direct change) |
| 20 | studio route guard | `routes/studio.ts:585-596` | `athletes_current` existence (because #1 throws) | A | KEEP; retire when #1 no longer throws (D-x) |
| 21 | `assembleMediaKit` | `services/mediaKitService.ts:91-363` | via #1; `research.values/causes` (D5); `cur.school` | B | MODIFY via #1 |
| 22 | `buildNarratorContext` (second copy) | `mediaKitService.ts:377-406` | own `athletes_current ⨝ athletes` + own blob read; hard-coded `brandFitTags` | B | **EXTRACT (D6 locked):** deleted; `NarratorContext` is built from `deckView`; `brandFitTags` survive only as an explicit versioned inference with provenance (`athlete_inferences` key `brand_fit_tags`, producer + taxonomy version), otherwise they are dropped from the prompt |
| 23 | `deriveShotList` | `services/shotList.ts:113-137` | ctx prop **or** own blob/projection queries; unfenced prompt line (D12) | B | **MODIFY** → `deck` view only (no own queries); fenced |
| 24 | `narrateKit` | `services/narrator.ts:93-444` | `NarratorContext` prop (`school`, `storyArc` unfenced, D12) | B | **MODIFY** → `NarratorContext` built from the `deck` view; fenced blocks |
| 25 | kit renderer / themes | `kitRenderer.ts`, `themes/*` | `kit.identity.school` prop | B | KEEP (prop; `identity.school` filled from `currentTeam`) |
| 26 | `scoreDeal` | `skills/dealDetector.ts:1240-1283` | `teamsLineFor` first, `school` fallback | A | **MODIFY** → identity view (`teamsLine` + `currentTeam`); no projection fallback |
| 27 | dealDetector self-send filter | `dealDetector.ts:375` | `platform_username` as email | I | KEEP |
| 28 | `dealDraft` | `services/dealDraft.ts:244-259` | `school` | A | **MODIFY** → identity view |
| 29 | `pitches` | `services/pitches.ts:183` | name, sport | B | KEEP |
| 30 | `researchAthlete` prior-blob union, level, discovery anchor, fill-if-null | `skills/researchAthlete.ts:591-612, 749-754` | blob (D3), projection (D8 anchor, D11 raw conference, back-fill) | I | **MODIFY (narrow):** the fill-if-null of `school/conference/division` is removed (§4.4: research never back-fills the projection; it writes affiliation rows); `sport` fill stays; the union and the blob write stay until Step 4 |
| 31 | `buildSearchName` ×4 | `researchAthlete.ts:485`, `reEnrichAthletes.ts:30`, `index.ts:298`, `research/refresh.ts:72` | projection | I | **REPLACE** → one `searchAnchorFor(searchView)` (ledger primary current team, else no team); the four copies go |
| 32 | `unionResearch` | `skills/researchMerge.ts:107` | blob (D3) | I | KEEP (Step 4 retires the blob) |
| 33 | `reEnrichAllAthletes` | `skills/reEnrichAthletes.ts` | no handles (D7) | I | **MODIFY:** passes `knownHandles` from the `search` view (D7) |
| 34 | `refreshAthlete` (2b) + `hintsFor` | `research/refresh.ts:101`, `researchDualWrite.ts:65-83` | `school` fallback; `primary.org_name` typo (`Affiliation.org`) | I | **MODIFY** → `IdentityHints` from the `search` view; fixes the `org_name` slip |
| 35 | `resolveHandles` (discovery analytics) | `skills/collectDiscoveryAnalytics.ts:31-43` | socials, blob `social_handles` (no null filter) | I | **MODIFY** → `knownHandles` from the `search` view |
| 36 | `runPlatformDiscovery` call site | `researchAthlete.ts:605-612` | blob handles + `school` as team | I | **MODIFY (narrow):** team from the `search` view |
| 37 | `listAffiliations`, `primaryAffiliation`, `levelRecordFor`, `teamsLineFor`, `proposeFoundAffiliations` | `services/affiliations.ts` | canonical | shared | KEEP (the builder calls them) |
| 38 | `projectPrimary` | `affiliations.ts:219` | writes the projection; early return keeps stale values | I | **MODIFY** → current-only rule (§4.4): NULL when no current row; `conference` normalized (D11); called after research affiliation facts are synced (§3.5) |
| 39 | admin roster / detail | `routes/admin.ts:72, 153, 187` | `school`, `socials` | M | **MODIFY** → `athlete_index_v` (team, handles) — the index already exists for this |
| 40 | waitlist upsert `coalesce(school)` | `routes/waitlist.ts:237` | writes `school` | I | KEEP (a write of the athlete's own entry; the said ledger is Step 3's editor) |
| 41 | manual re-research route | `index.ts:287-301` | projection (D8) | M | **MODIFY** → `searchAnchorFor` |
| 42 | client `FactsTab` / `TeamSheet` / `StoryTab` / `BrandHeader` / `auth-context` | `client/**` | via `/me/record`, `/auth/me` | A | **MODIFY (client):** `StoryTab` reads the `story` group / `narrative` field the record emits (D6); nothing else changes shape |
| 43 | `dbSnapshotToScoring`, `writeAthletesCurrent`, `weightsService`, `deckRateFigures` | services | blob / `athletes_current` | I | KEEP (Step 4 / 5) |

Counts: the audit found **63 concrete read sites** (every file:line that reads athlete/research context, incl. the four `buildSearchName` copies, the client screens and the renderer/theme files); the map above groups them into **43 logical readers**: MODIFY 24, EXTRACT 2, REPLACE 1, KEEP 15, ADD 1 (the builder and its views). The per-site list with file:line is the audit table this design was written from and is carried into the 2d-1 PR as the source of G5's allow-list.

### 1.3 Defects 2d owns (from the Step 2 design) and where each is fixed

| # | Defect | Fix |
|---|---|---|
| D1 | carry-forward re-dates stale research | every true research-producing snapshot gets `as_of` = its own `created_at`; every carry-forward inherits the `as_of` of the research-producing snapshot it copied; ambiguous historical lineage stays NULL. MD5 is used only to connect a carry-forward row to a qualifying prior research-producing row, never to define the research date itself. Readers and the onboarding freshness gate use `as_of` (§4.3) |
| D2 | projection shown as "found online · researchedAt" | `record` view labels division/conference with the affiliation row's real kind and dates (said / proof / found + tier) |
| D4 | Record reads `research.position/class_year/hometown` at top level | those rows come from `athlete_facts` (`position`, `class_year`, `hometown`) in canonical mode and from `research.profile.*` in legacy mode, through one adapter |
| D5 | `values/causes` never written but read ×4 | the field is dropped from every reader; a `values` fact key does not exist in registry v1 (reintroducing it is a registry change, not 2d) |
| D6 | Story tab reads a field no group emits | the client reads `story.narrative`; the record emits it as an **inference** labelled "made · written from research" |
| D7 | monthly sweep passes no handles | `reEnrichAllAthletes` passes `knownHandles` from the `search` view (the sweep is already a no-op when the planner runs) |
| D8 | search anchored to the projection | `searchAnchorFor` uses the ledger's primary current team; the four `buildSearchName` copies are replaced |
| D11 | raw conference written | `normalizeConference` applied in `projectPrimary`; the research fill-if-null is removed |
| D12 | unfenced web text in prompts | the `prompt` view emits fenced typed blocks; narrator / shot list / onboarding / chat v1 consume them |
| C13 | retired athlete keeps last team as current | `projectPrimary` current-only rule (§4.4) |
| C24 | dead columns | out of scope for 2d (a later cleanup PR once nothing types against them) |

## 2. Target: the canonical context contract

### 2.1 One builder, one contract, purpose views

```
buildCanonicalContext(athleteId, opts?) → CanonicalAthleteContext            // server/services/intelligence/context/build.ts
recordView(ctx) | promptView(ctx, purpose) | deckView(ctx) | searchView(ctx) | identityView(ctx)   // pure projections of the contract
```

The builder lives under `server/services/intelligence/context/` (provider-free; the boundary test applies), reads only canonical tables plus the two legacy sources through a single adapter (§3), and never writes. Every consumer takes a **view**, never the raw contract sections it does not need; no reader parses the blob or reads a projection column again.

### 2.2 `CanonicalAthleteContext` v1

```
CanonicalAthleteContext {
  contractVersion: "v1"
  athleteId, builtAt
  sourceMode: "canonical" | "legacy" | "mixed"                  // §3.2 — the AGGREGATE of coverage, never silent
  coverage: { [domain]: "unavailable" | "populated" | "confirmed_empty" | "disputed" }   // §3.2, per research domain
  identity {
    name: Fact<{ full, first?, last? }>                          // athletes.full_name until Step 3 writes a name fact; origin 'legacy_row'
    aliases: Fact<{ text, kind }>[]
    sport: Fact<{ sport, discipline? }>
    hometown?: Fact<{ city, region, country }>
    nationality?: Fact[]
    careerStatus: Fact<{ status }>                                // athletes.career_status (assertion-backed today)
    identityConfidence, researchStatus                            // from athlete_research_state (or 'seed_only')
  }
  affiliations {
    current: AffiliationRow | null                                // the primary current ledger row — the ONLY "current team" anywhere
    all: AffiliationRow[]                                         // said / proof / found, dated
    level: { org, kind, division, conference, segment, alsoNational }   // levelRecordFor (confirmed > found)
    teamsLine: string                                             // teamsLineFor
  }
  profile { position?, classYear?, graduationYear?, event?: Fact[] }
  achievements: Fact<{ name, year, level }>[]                      // dated_multi facts (achievement, award, ranking, national_team_participation)
  press: Evidence<{ outlet, headline, publishedAt, url? }>[]        // evidence-only domain; cited rows only
  brandMentions: Evidence<{ brand, type }>[] + nilMentions: Fact[]
  inferences { storyArc?: Inference<string>, sentiment?: Inference }   // distinct from facts, labelled 'made'
  social {
    handles: { [platform]: { handle, sourceClass, connected: boolean, confidence } }   // social_identities > connected_accounts > entered
    connectionStatus: 'none'|'active'|'expired'|'revoked'         // derived, never stored
  }
  assertions: Assertion[]                                          // the said ledger verbatim (latestAssertions) — separate from facts
  freshness { byDomain: { [domain]: { status, lastResearchedAt, staleAfter } }, researchAsOf: date | null }
  commercial { confirmedPartners: string[], commercialState: 'active'|'none' }   // D7 locked: from confirmed/verified deals ONLY; brand mentions never feed it
  audience {                                                       // D8: KEPT in 2d, unchanged source (social_analytics_snapshots, source='connected'); Step 4 moves it onto social_features
    gender?, ageRange?, topCity?, geoCountry: [], share?, sourceClass: 'connected_verified', asOf, connected: boolean
  }
  provenanceSummary { canonicalFacts: n, legacyFacts: n, assertions: n }
}
Fact<T>      = { value: T, origin: 'athlete_asserted'|'athlete_proof'|'connection'|'research'|'backfill'|'legacy_row'|'legacy_blob',
                 sourceClass: SourceClass|null, authorityTier: 1..8|null, status: 'current'|'historical'|'disputed',
                 retrievedAt: date|null, validFrom?, validTo?, evidenceIds: string[], freshness: 'fresh'|'stale'|'unknown', factId?: string }
Evidence<T>  = { value: T, sourceClass: SourceClass|null, sourceType: SourceType|null, sourceUrl?, sourceDomain?, retrievedAt: date|null, publishedAt?, evidenceId?, lineage: 'cited'|'uncited'|'legacy' }
Inference<T> = { value: T, producer, computedAt, lineage: { runId?, evidenceIds }, legacy: boolean }
```

Rules the contract enforces:
- `origin` and `sourceClass` are separate (R1); an assertion is `origin athlete_asserted, sourceClass null`. **A legacy blob value without recoverable item-level source lineage is `origin legacy_blob, sourceClass null, lineage 'legacy', authorityTier null`** — compatibility data, not evidence. `web_researched` (and a tier) is assigned only where actual source provenance exists (a canonical evidence row). In any authority comparison the adapter's data ranks below every canonical tier (a non-resolving "legacy rank" that sorts last) and can never displace a canonical fact; in practice the comparison never happens because a `populated` domain does not consult the adapter (§3.2).
- Inferences never appear in `identity`, `profile`, `achievements` or `press`; `storyArc` is only under `inferences`.
- `affiliations.current` is the ledger's primary current row or `null`; the builder never reads `athletes.school/division/conference`.
- `freshness.byDomain` comes from `athlete_research_state` when present; in legacy mode every domain is `unknown` with `researchAsOf` from the real research date (§4.3); `connectionStatus` is computed independently.
- Assertions override for display where the registry key is `single` and the assertion is live (the same rule `resolveFacts` applies for research); they are listed separately and never merged into `press`/`achievements`.

### 2.3 Purpose views

| View | Consumers | Shape |
|---|---|---|
| `identityView` | `/auth/me`, `get_profile`, voice profile, chat v1, dealDraft, scoreDeal, admin | `{ name, sport, currentTeam, orgKind, level, conference, segment, teamsLine, careerStatus, handles (public), connectionStatus }` + `sourceMode` |
| `recordView` | `getAthleteRecord` | the Facts groups (`who / teams / story / found / connections / numbers`) as today's `RecordEntry` shape, each row with `{ provenance: origin, sourceClass, tier, retrievedAt, freshness }` and the editable `shape`; fixes D2/D4/D5/D6 |
| `promptView(purpose)` | onboarding block, narrator, shot list, chat v1 | fenced typed blocks: `<<<ATHLETE_CONTEXT purpose=…>>>` … `<<<END_ATHLETE_CONTEXT>>>`, one `key: value [origin, retrieved YYYY-MM-DD, fresh|stale]` line per emitted field, registry keys only, `suspect` evidence excluded, inferences in their own `INFERENCES` sub-block; never raw prose |
| `deckView` | `getAthleteContext` → brief, kit, narrator context, shot list | today's `AthleteContext` fields (name, identityLine, org, level, marquee, achievementsRaw, ranked, brandMentions, storyArc, commercialState, signalHighlights) built from the contract — so #1's consumers see the same field names |
| `searchView` | `searchAnchorFor`, `IdentityHints`, `knownHandles`, discovery | `{ fullName, aliases, sport, currentTeam, hometown, knownHandles, searchAnchor }` |

## 3. Compatibility and fallback strategy (no silent legacy reads)

### 3.1 One adapter for the legacy world (D2 locked: approved)
`legacyAdapter(athleteId)` is the **only** code that parses `athlete_snapshots.research` or reads the projection columns for display. It maps the blob to the contract's `Fact`/`Evidence`/`Inference` shapes with `origin: 'legacy_blob'` (or `'legacy_row'` for `athletes.*` columns), `sourceClass: null`, `authorityTier: null`, `lineage: 'legacy'`, `retrievedAt = as_of` of the snapshot the blob came from (§4.3; `null` when unknown), `freshness: 'unknown'`. It fixes D4 (`profile.position/class_year/hometown`) and drops D5 (`values/causes`) in one place. It never refuses service when canonical rows are absent: it is the sole compatibility bridge, always marked, deleted in Step 4 with the blob.

### 3.2 Per-domain coverage decides where a section may come from; nothing is inferred silently
Each research domain (identity, profile, affiliations, achievements, press, brand_mentions, narrative, social_handles, signals) gets a **coverage** value from `athlete_research_state.domains[d]` (written by 2b's outcome-based persist):

| Coverage | Rule (from the state row) | Where the section comes from |
|---|---|---|
| `unavailable` | no `athlete_research_state` row, or the domain has never reached a fresh outcome (`lastResearchedAt` null and no canonical rows) — the substrate has not covered it yet | the legacy adapter, every row marked `origin legacy_blob` (compatibility) |
| `populated` | the domain's last outcome is `refreshed` (canonical rows exist), whether currently `complete` or `stale` | canonical rows only; the adapter is **not consulted**, even if the canonical list is short |
| `confirmed_empty` | the domain's last outcome is `confirmed_empty` (a completed search found nothing new and no canonical rows exist) | **empty**; the adapter is not consulted; a legacy value can never resurrect |
| `disputed` | the domain holds a `disputed` canonical fact | canonical rows incl. the disputed ones, labelled; the adapter is not consulted |

`sourceMode` is the **aggregate**: `canonical` when every domain the view needs is `populated | confirmed_empty | disputed`; `legacy` when every such domain is `unavailable`; `mixed` otherwise. Section-level provenance is always preserved: each `Fact`/`Evidence` row carries its own origin and lineage, and each view reports `coverage` next to `sourceMode`. The record view shows "from earlier research" only on `unavailable` sections; the prompt view labels those `[legacy]`. There is no "prefer legacy when canonical looks empty": a `confirmed_empty` brand domain yields `brandMentions = []` regardless of what the blob still holds (gate G5b). The ledger (`athlete_affiliations`) and the assertions are canonical in every mode.

### 3.3 The reader switch
One env var, `CANONICAL_CONTEXT_READERS` (comma list, empty in both YAMLs): a reader consults the builder only when its name is listed (`record, onboarding, identity, deck, search, admin, client`). Unlisted readers run their pre-2d code byte for byte. This is a boundary, not a behaviour flag: the builder in `legacy` sourceMode is designed to reproduce each legacy reader's output exactly, and gate G1 proves it per reader before the reader is listed on dev.

### 3.4 Shadow comparison
With a reader unlisted, `CONTEXT_SHADOW=true` on dev makes the reader ALSO run the view and log a structural diff (no behaviour change, no prompt change). That is how the byte-for-byte gate is evidenced on the real dev roster before flipping each reader.

### 3.5 Affiliation facts → ledger, idempotently
Rule-7 established affiliations are `athlete_facts` rows today (2a boundary). 2d adds `syncAffiliationsFromFacts(athleteId)` after `persistResearchRun`, and it must be safe to run after every persist:

- **Stable key.** A ledger row created by the sync carries `kind = 'found'`, `source = 'fact'` and the originating fact id in a new nullable column `athlete_affiliations.fact_id` (FK to `athlete_facts`, ON DELETE SET NULL; the one schema addition of 2d, additive). The dedupe key is `(athlete_id, org_kind, normalizeText(org_name), season)` where `season` is the fact's `value.season` (or the year of `valid_from`); the same key with the same fact id is the same affiliation.
- **Reconfirmed fact** (the resolver re-confirmed the same current fact; same fact id, or a new fact id with the same key): the existing found row is touched (`updated_at`, `fact_id` re-pointed to the newest fact) — **no new row**.
- **Same org, same season, corrected dates** (the same key with a different `valid_from`/`valid_to`): the existing found row's dates are updated in place and `fact_id` is re-pointed — **no new row**.
- **Different org or season** (a new current fact with a different key): the previous found row is closed (`ended_on = the new fact's valid_from`, or the old fact's `valid_to`) and one new found row is inserted; a found row is never edited into a different team.
- **A found affiliation becomes historical** (the fact's status is `historical`/`superseded` with `valid_to`): the row gets `ended_on = valid_to`; it is never deleted (the ledger keeps history).
- **Precedence.** A confirmed `said`/`proof` row is never modified by the sync. A found row is never primary while a said/proof current row exists; it becomes primary current only when the fact carries rule-7 `primary = true` and no confirmed current row exists — and it is demoted (never deleted) the moment a said/proof current row appears (`replaceSaidAffiliations` already demotes other current primaries).
- **Never duplicates.** Running the sync twice on the same facts is a no-op (G6 idempotency test); the unique partial index `idx_affiliations_one_primary_current` stays the guard for "one primary current".
The ledger stays the single source of "current team"; the projection follows the ledger (§4.4).

## 4. Migration sequence (current → target), one reader at a time

| PR | Scope | Readers moved | Gates |
|---|---|---|---|
| **2d-1 builder** | contract, builder, adapter, five views, `CANONICAL_CONTEXT_READERS`/`CONTEXT_SHADOW` (empty/false), `searchAnchorFor`, `knownHandles`; no reader switched | none (shadow only) | unit + PGlite tests of the contract in canonical, legacy and mixed modes; boundary test; shadow diffs on dev for every reader listed below = empty in legacy mode |
| **2d-2 Facts + greeting** | `getAthleteRecord` → `recordView`; onboarding block → `promptView('onboarding')`; client `StoryTab` field fix | #2, #5, #42 | byte-for-byte in legacy mode (shadow); Facts screen provenance review with Mia on dev in canonical mode (needs the substrate populated — user's rollout decision); D2/D4/D5/D6 verified |
| **2d-3 identity readers** | `/auth/me`, `get_profile`, voice profile, chat v1 (fenced), dealDraft, scoreDeal, admin (index) | #4, #7, #9, #10, #26, #28, #39 | byte-for-byte on `school`/`conference` values in legacy mode; prompt fencing tests |
| **2d-4 deck** | `getAthleteContext` → `deckView`; `buildNarratorContext` deleted (EXTRACT); shot list and narrator take the view; fenced blocks (D12) | #1, #19, #21, #22, #23, #24 | byte-for-byte of the assembled kit JSON in legacy mode on dev for Mia's deck; studio guard retained |
| **2d-5 search + hints** | `searchAnchorFor` replaces the four `buildSearchName`; `knownHandles` feeds onboarding, refresh v1, 2b `hintsFor`, discovery, the monthly sweep (D7); `org_name` slip fixed | #15, #16, #17, #31, #33, #34, #35, #36, #41 | the anchor string equals today's for every dev athlete whose projection equals the ledger (shadow); differs only where the projection is stale (listed) |
| **2d-6 projection + as-of** | `projectPrimary` current-only + `normalizeConference` (§4.4, C13, D11); research fill-if-null of `school/conference/division` removed; `syncAffiliationsFromFacts` (+ `athlete_affiliations.fact_id`, migration 0050 additive); carry-forward keeps flowing but writes `as_of` (D1, D3 locked) and the onboarding freshness gate reads it | #12, #13, #30, #38 | scoring inputs byte-for-byte (the blob still flows); `as_of` back-filled by the deterministic rule in §4.3 (dry-run-default script); the retired-athlete case on dev |
| — | Step 4 | scoring off the blob; **blob carry-forward removed** (D3 locked: retained through 2d); `unionResearch` and the legacy adapter retired | #11, #32, #43 | — |

Each PR: design here → code → review → merge → deploy → dev evidence in `step2d-canonical-context.md`. Order within the sequence may be reviewed, but 2d-1 precedes all and 2d-6 follows 2d-5 (search anchors must be off the projection before the projection may go NULL).

### 4.1 What "byte-for-byte" means per reader
The reader's output (JSON response, prompt string, kit JSON, anchor string) with the reader unlisted equals its output with the reader listed while `sourceMode = legacy`, for every athlete on dev. Documented exceptions only: D4 rows now filled, D5 rows now absent, D6 field now emitted, D2 labels corrected, dates now as-of. Each exception is listed in the PR with the athletes affected.

### 4.2 Prod
Nothing in 2d changes prod behaviour: both env vars are empty/false in `cloud-run-prod.yaml`; the builder is never called there.

### 4.3 The research as-of (D1) without breaking scoring — runtime rule and historical backfill

**Runtime rule (from 2d-6 on).** `athlete_snapshots.as_of` (in the schema, NULL on every row today) is the date of the research the row carries: a **true research run** writes `as_of = created_at`; a **carry-forward** inherits `as_of` from the snapshot it copied the blob from (`latestSnap.as_of`, possibly NULL). Scoring keeps reading the blob unchanged (Step 4 retires it); every 2d reader dates research by `as_of` and treats NULL as "unknown", never as today.

**Writer audit (what distinguishes a research-producing snapshot).** There are exactly three `athlete_snapshots` writers: `researchAthlete.ts:701` (a real run; `trigger` = its parameter — callers pass `signup`, `manual` or `re_enrich`; `sources` is built fresh: `apis_called`, `kimi_usage`, `gemini_usage`, `gemini_stats`, `enrichment`, `search_name`), `refreshScores.ts:250` (carry-forward; `trigger = 'scheduled_refresh'`; `sources = { ...inheritedSources, score_refresh: {at, source} }`), `fetchSocialData.ts:308` (carry-forward; `trigger = 'social_connect'`; inherits `research`). No writer uses `inbox_connect` or `first_look` as a trigger (`first_look` is a column). On dev (11 Sep): 273 snapshots — signup 2, manual 15, re_enrich 10 (all with research), scheduled_refresh 231 (all with inherited research), social_connect 15 (13 with research, 2 pre-research NULL); every distinct research blob per athlete is first seen under a research-producing trigger (27 of 27); `research_runs` (2a) has 0 rows; `tasks(type='research')` has 3 rows and is not a usable lineage.

**Deterministic historical backfill rule** (`server/scripts/backfillSnapshotAsOf.ts`, dry-run default, applied on dev with the user's word):
1. A row is **research-producing** iff `trigger IN ('signup','manual','re_enrich')` **and** `research IS NOT NULL` **and** `sources ? 'apis_called'` **and** `NOT (sources ? 'score_refresh')`. Such a row gets `as_of = created_at`. A later genuine re-research that returns a byte-identical blob is its own research-producing row and receives its own later date — MD5 is never the key.
2. A row is a **carry-forward** iff `trigger IN ('scheduled_refresh','social_connect')` and `research IS NOT NULL`. It gets `as_of` = the `as_of` of the **most recent earlier** snapshot of the same athlete (by `created_at`) that is research-producing and whose `md5(research::text)` equals this row's — i.e. the run it copied from, walking back through the chain. If no such earlier research-producing row exists (a blob that appears only under carry-forward triggers, or an inconsistent `trigger`/`sources` pair), `as_of` stays **NULL (unknown)** and the row is listed in the script's report; a falsely precise date is never written.
3. Rows with `research IS NULL` keep `as_of` NULL.
4. The script is idempotent (it only fills NULLs, never overwrites) and prints per-athlete counts of resolved / unknown rows before and after.
On dev this rule resolves every carried-forward blob (every first sighting is a research-producing row); the report proves it before apply.

### 4.4 The projection current-only rule (approved §4.4)
`projectPrimary`: primary current row → `school = org_name`, `division = level ?? kind-derived`, `conference = normalizeConference(conference)`; **no current row → all three NULL** (career_status carries the meaning); research never back-fills them; assertion/proof override stays `replaceSaidAffiliations`; a found current row conflicting with a said one ends on the asserted date. The 21 projection readers are off the columns by 2d-3/2d-4/2d-5, so NULL cannot blank a display; `rateService` reads `record.school` only as pass-through and `levelRecordFor` already prefers the ledger.

## 5. Tests and gates

| Gate | Criterion |
|---|---|
| G1 parity | per reader: shadow diff empty in legacy mode on every dev athlete (documented exceptions only); PGlite fixtures for the legacy blob shape (incl. `profile.*`, missing `values`) and for the canonical shape |
| G2 provenance | contract tests: an assertion appears in `assertions` and overrides a `single` fact for display without touching `press`/`achievements`; a legacy value carries `origin legacy_blob`/`lineage legacy` and never `authorityTier ≤ 2`; an inference never appears outside `inferences`; `suspect` evidence never reaches any view |
| G3 authority | `social.handles` picks `connected_verified > platform_public > web_researched > inferred > imputed`, entered handles last; `affiliations.level` confirmed > found |
| G4 freshness ⟂ connection | changing `connected_accounts` changes `connectionStatus` and nothing in `freshness`; a stale domain shows `stale` regardless of connection |
| G5 no silent fallback | `sourceMode` and `coverage` present on every view; a `mixed` row is marked; a reader with the flag unlisted never calls the builder (spy); no reader outside the adapter reads `athlete_snapshots.research` (a source-level test like the boundary test: `grep` for `.research` reads outside `context/legacyAdapter.ts`, scoring and the write path) |
| **G5b canonical-empty regression** | the legacy blob holds `brand_mentions: [Brand X]`; the athlete's `brand_mentions` domain has outcome `confirmed_empty` and no canonical rows ⇒ `context.brandMentions = []`, `coverage.brand_mentions = 'confirmed_empty'`, and Brand X appears in no view (record, prompt, deck); the same with `populated` (one canonical mention Brand Y) ⇒ only Brand Y; with `unavailable` ⇒ Brand X marked `origin legacy_blob, sourceClass null, lineage legacy, authorityTier null` |
| G6 projection rule + sync idempotency | `projectPrimary` yields NULLs for a retired athlete; `normalizeConference` applied; research no longer writes `school/conference/division`; `syncAffiliationsFromFacts`: running twice on the same facts inserts nothing (row count and `updated_at` semantics asserted); a reconfirmed fact re-points `fact_id` without a new row; a same-key date correction updates the existing row's dates and re-points `fact_id` without a new row; a changed org or season closes the old found row and inserts one; a historical fact sets `ended_on`; a said/proof current row is never modified, never demoted by the sync, and keeps precedence over a rule-7 primary found row; the one-primary-current unique index holds |
| G7 as-of | regressions: a research-producing row gets `as_of = created_at`; a scheduled/social carry-forward inherits the source research `as_of`; a later genuine re-research with byte-identical JSON gets the later run's date; a row with no trustworthy source lineage gets `as_of = NULL`; the onboarding freshness gate reads `as_of`, never a carry-forward's `created_at` |
| G8 fencing | every prompt view is wrapped and typed; narrator/shot list/onboarding/chat v1 prompts contain no unfenced athlete text (snapshot tests) |
| G9 scoring untouched | `computeScore` inputs byte-for-byte before/after every 2d PR on dev (`_dryRun` script), incl. after 2d-6 |
| G10 boundary | builder under `services/intelligence/` passes the boundary test; the adapter imports no provider |

## 6. Rollout
| # | Step | Env after |
|---|---|---|
| 1–6 | the six PRs, each reviewed, merged, deployed with both vars empty/false | `CANONICAL_CONTEXT_READERS=""`, `CONTEXT_SHADOW=false` |
| a | `CONTEXT_SHADOW=true` on dev by a one-line PR (user's word) → shadow diffs for all readers | dev shadow on |
| b | list readers on dev one group at a time (`record,onboarding` → `identity` → `deck` → `search`) by one-line PRs after each group's shadow evidence | dev readers on |
| c | canonical mode on dev requires the substrate populated (`RESEARCH_SUBSTRATE_WRITE=true` + backfill) — the pending 2b rollout decisions; until then dev runs the readers in legacy sourceMode | unchanged |
| — | prod: nothing in 2d | — |

## 7. Policy
`context_policy v0.1-alpha` (draft, not activated): `assertionOverrides` (single-cardinality keys the athlete's word overrides for display), `promptFieldAllowlist` per purpose, `staleLabelDays` per domain (display only; the TTLs stay in `research_freshness`). There is no policy knob for legacy fallback: the coverage rule in §3.2 is fixed by design (legacy only for `unavailable`).

## 8. Definition of CLOSED
Step 2d is CLOSED when all of the following hold: PRs 2d-1 to 2d-6 merged and deployed on dev through the normal path with clean drift; every reader classified MODIFY/EXTRACT/REPLACE in §1.2 reads a view (G5's source-level test passes: no blob or projection read outside the adapter, scoring and the write path); shadow parity evidence recorded for every reader group on dev; D1, D2, D4, D5, D6, D7, D8, D11, D12 and C13 verified fixed on dev; scoring inputs unchanged (G9); the readers listed on dev per rollout step b with the Facts screen provenance review done with Mia (in legacy sourceMode if the substrate is still unpopulated, repeated in canonical mode when it is); prod untouched. Not part of closure: enabling the substrate, backfill, planner or claim flags; Step 4 scoring migration; C24 cleanup.

## 9. Risks and open decisions
| # | Decision / risk | Recommendation |
|---|---|---|
| D1 | Flag granularity: one comma-list env var vs one flag per reader | one list var (`CANONICAL_CONTEXT_READERS`): fewer YAML edits, same per-reader control |
| D2 | Legacy-mode adapter vs refusing to serve when canonical rows are absent | **Locked: adapter approved.** Never refuse service; the sole compatibility bridge, always marked; legacy data carries no source class or tier; deleted in Step 4 |
| D3 | Carry-forward | **Locked: kept through Step 2d with the corrected `as_of`; blob carry-forward removed in Step 4 when scoring leaves the blob** |
| D4 | Deals/dealDraft/pitches in scope | dealDraft and scoreDeal move to the identity view (they read `school`); pitches keeps name/sport |
| D5 | Admin and waitlist | admin list moves to `athlete_index_v` (read-only); the waitlist `coalesce(school)` write stays (the athlete's own entry) |
| D6 | `buildNarratorContext` second copy | **Locked: delete it; `NarratorContext` from `deckView`; `brandFitTags` kept only as an explicit versioned inference with provenance, otherwise dropped** |
| D7 | `commercialState` | **Locked: derived from confirmed/verified deals only** (`'active' \| 'none'`); brand mentions — cited or not — are evidence of public association, kept separately under `brandMentions` for future affinity/opportunity intelligence and never a commercial state input; the deck's `'undisclosed'` state and `inferredPartners` are retired |
| D8 | Audience demographics | **Resolved: the contract has an `audience` section** (§2.2) read from `social_analytics_snapshots` (source `connected`) exactly as today, marked `connected_verified` with its own `asOf`; Step 4 moves it onto `social_features` |
| D9 | `sport` fill-if-null by research | keep (sport is identity, needed for the first research); `school/conference/division` fills removed |
| D10 | `as_of` back-fill for the 273 existing snapshots | dry-run default; the deterministic rule of §4.3; NULL where provenance is ambiguous; apply on dev with the user's word |
| D11 | `athlete_affiliations.fact_id` (the one additive column 2d needs for an idempotent sync) | add in 2d-6 (migration 0050); alternative — a synthetic key in `source` — is weaker (no FK) |
| R1 | The legacy adapter becomes a permanent second path | it is the only blob parser and is deleted in Step 4 with the blob; G5 keeps every other path closed |
| R2 | Byte-for-byte hides intended fixes | exceptions are enumerated per PR (D2/D4/D5/D6, dates) |
| R3 | Prompt fencing changes model behaviour in narrator/shot list | snapshot tests + a Mia deck regeneration review on dev before listing `deck` |
| R4 | Projection NULL surprises a reader that was missed | G5's source-level test fails the build on any remaining `athletes.school/division/conference` read outside the allowed set |
