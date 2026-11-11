# Phase A Step 2d — Canonical Context: build record

Design: `step2d-canonical-context-design.md` (APPROVED / FROZEN 11 Sep 2026, #410). This record is filled in one
PR at a time (2d-1 … 2d-6). Status of the step: **OPEN — 2d-1 and 2d-2 merged and verified on dev (11 Sep 2026); 2d-6 CLOSED ON DEV — **Step 2d CLOSED ON DEV (11 Sep 2026)**; next design step: Step 3 Identity.**

## What the athlete experiences

Nothing yet. 2d-1 builds the canonical context and its five views next to today's readers; no screen, prompt,
search or endpoint reads them (`CANONICAL_CONTEXT_READERS=""`, `CONTEXT_SHADOW=false` in both environments).

## 2d-1 — builder (#411, merged a0af817)

| Item | Where | Notes |
|---|---|---|
| Contract `CanonicalAthleteContext v1` | `server/services/intelligence/context/contract.ts` | `Fact` / `Evidence` / `Inference` provenance per row; `coverage` per domain; `sourceMode` aggregate; `affiliations` from the ledger only; `commercial` from confirmed deals only (D7); `audience` from the connected analytics snapshots (D8) |
| Coverage rules | `context/coverage.ts` | `unavailable \| populated \| confirmed_empty \| disputed`; legacy admissible ONLY for `unavailable` (§3.2) |
| Builder | `context/build.ts` | provider-free; reads facts, evidence (cited, non-suspect), inferences (current), identities, connections, ledger, assertions, deals, audience; consults the adapter only for `unavailable` domains |
| Legacy adapter | `context/legacyAdapter.ts` | the ONLY blob parser: `origin legacy_blob`, `sourceClass null`, `authorityTier null`, `lineage legacy`, `freshness unknown`, dated by `as_of` (NULL = unknown); reads `profile.*` (D4); no `values/causes` (D5) |
| Views | `context/views/{record,prompt,deck,identity,search}.ts` | pure over a built context (+ each view's own KEEP inputs: score, rates, kit, first looks, analytics) |
| `searchAnchorFor`, `knownHandles` | `context/views/search.ts` | the ONE anchor from the ledger's primary current team; handles connected > entered, never the blob |
| Boundary | `context/config.ts` | `CANONICAL_CONTEXT_READERS` (comma list; empty) and `CONTEXT_SHADOW` (false); both YAMLs carry them explicitly |
| Shadow infrastructure | `context/shadow.ts`, `server/scripts/contextShadow.ts` | structural diff with documented-exception paths; the script runs every reader on dev, read-only |
| Affiliation `recordedAt` | `server/services/affiliations.ts` | `listAffiliations` exposes the ledger row's `created_at` (optional field) so the Facts rows can be dated by when the row was recorded, not when the team started |

Not in 2d-1 (by the user's instruction): no reader switched; no migration (0050 stays in 2d-6; nothing in 2d-1
needs it); no substrate / backfill / planner / claim activation; no `syncAffiliationsFromFacts`; no `projectPrimary` change.

### Tests (PGlite; all under `server/services/intelligence/context/`)

| Suite | Gates |
|---|---|
| `build.test.ts` | coverage rules; **G5b** (confirmed_empty ⇒ Brand X in no view; populated ⇒ only Brand Y; unavailable ⇒ legacy-marked); **G2** (assertion overrides for display only, legacy never tier ≤ 2, inferences only in `inferences`, suspect evidence never surfaces); **G3** (handle authority, level said > found); **G4** (connection ⟂ freshness); config parsing; shadow diff semantics |
| `parity.test.ts` | **G1** in legacy sourceMode for every view; the remaining differences are asserted as an EXACT list (below) |
| `sourceGuard.test.ts` | **G5** source-level: the files reading `athleteSnapshots.research` or `athletes.school/division/conference` equal the allow-list (the §1.2 audit); the context folder touches neither outside the adapter |
| `../boundary.test.ts` | **G10**: the builder and adapter import no provider |

### Documented legacy-mode differences (the shadow exception list for 2d-2 … 2d-5)

| Reader | Path | Why |
|---|---|---|
| record | who › division `kind / source / at` | **D2**: the level row carries the ledger row's kind (`said`), wording and recorded date, never "found online · researchedAt" |
| record | who › class_year, hometown `value / kind / source / at` | **D4**: read from `research.profile.*`; the legacy reader looked at the top level and showed nothing |
| record | who › credential, found › achievements / press / brands `source` | **§3.2**: a legacy-sourced row says "found online (earlier research)" |
| record | who › level `value`; deck / prompt / identity `division`, `segment` | **D2**: the level comes from the ledger's level record (`levelRecordFor`, what the score already uses), not the projection — on dev the projection's generated `segment` reads `unknown` for every non-D1–D3 level and a High School row keeps its raw class label as `division` |
| record | who › handles | unchanged: the row is what the athlete typed or connected (label "signup" / "N connected"); identity-sourced handles (Step 1a/2c substrate) appear in the identity and search views with their own provenance, never under "signup" |
| record | found › causes_seen `value / kind` | **D5**: never a value; a blob that carries `values`/`causes` (none does on dev — the producer never wrote them) shows them today and never will in the view |
| record | `counts.said / counts.found` | consequences of D2 (+1 said) and D4 (+2 found, −1 found) |
| record | any `at` on a research row | dated by the snapshot's `as_of` (§3.1); equal to today's while `as_of == created_at`, NULL (not today) where `as_of` is unknown |
| deck | `commercialState`, `inferredPartners` | **D7**: confirmed deals only; `inferredPartners` always `[]` (field kept for shape until Step 4) |
| deck | `research` | the passthrough is rebuilt from the contract (domain keys) — a `confirmed_empty` domain is empty whatever the blob holds; non-domain keys pass through only in legacy mode |
| prompt | the whole block | a typed fence with provenance tags instead of `ONBOARDING_CONTEXT`; the FACTS are equal (asserted per key); no guidance prose, no `causes_seen_in_public` (D5) |
| prompt | `team_or_school`, `researched` | the ledger's primary current team (equal while the projection matches it); `as_of` |
| identity | `currentTeam` vs `school` | the ledger; `legacySchool` exposed for parity until Step 4 |
| search | `searchAnchor` | the ledger's primary current team; equal to `buildSearchName` while the projection matches (asserted); differs only where the projection is stale (`legacySearchAnchor` shows today's) |
| search | `knownHandles.<platform>` | adds platform-verified identities by authority (design §2.2, G3) where today's `collectKnownHandles` sees only typed + connected; the shadow script ignores a platform only when the view's handle is identity-sourced |

### Evidence

| # | Item | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npm test -- --runInBand <CI list>` | 33 suites / 318 tests pass (11 Sep 2026) |
| 3 | Pre-merge dev shadow run `server/scripts/contextShadow.ts` (read-only, via the proxy, 11 Sep 2026) | record 24/24 equal · onboarding 24/24 · identity 24/24 · search 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row; `getAthleteContext` throws there too). Two undocumented differences the first run exposed were fixed before this result: the Facts "Handles" row had dropped a typed handle when a substrate identity outranked it (now reads the athlete's typed entry as today); the followers/audience rows lost sub-second precision on `snapshot_date` |
| 4 | Code review | approved by the user at exact head 5957b17; `checks` green on that head (10m09s) |
| 5 | Merge / deploy to dev (no migration) | squash-merged as a0af817; deploy run 34601850999 success; 0031–0049 all "already applied"; drift gate: no drift; serving revision `nomila-v2-00574-jkm`; `CANONICAL_CONTEXT_READERS` present and empty, `CONTEXT_SHADOW=false`, `ATHLETE_INDEX_CLAIM=false`, `RESEARCH_SUBSTRATE_WRITE=false`, `RESEARCH_REFRESH_ENABLED=false` on the dev service |
| 6 | Post-deploy dev shadow run (read-only, 11 Sep 2026) | record 24/24 equal · onboarding 24/24 · identity 24/24 · search 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row; `getAthleteContext` throws there too); zero differences outside the documented exception table above |

2d-1 is complete. No reader is listed; no flag changed; no migration applied; prod untouched.

## 2d-2 — Facts + greeting (readers #2, #5, #42) — #413, merged 63d5a17

What the athlete experiences: nothing yet on dev — both readers stay unlisted (`CANONICAL_CONTEXT_READERS=""`), so the Facts screen and Mila's first-entry block are byte for byte what they were. Once the user lists `record,onboarding` on dev (rollout step b, a one-line PR after this PR's shadow evidence), the Facts screen shows real provenance per row (D2/D4/D5) and Mila's block becomes the typed fence with provenance tags; the Story tab shows the one-liner it never could (D6).

| Item | Where | Notes |
|---|---|---|
| Record reader switch | `server/services/athleteRecord.ts` | `getAthleteRecord`: listed ⇒ `recordView(buildCanonicalContext)`; unlisted ⇒ `getAthleteRecordLegacy` (the pre-2d body, byte for byte); unlisted + `CONTEXT_SHADOW` ⇒ the view is also built and `shadowCompare("record")` records the diff (response unchanged; a shadow failure is logged, never surfaced) |
| Onboarding block switch | `server/mila/onboarding.ts` | `buildOnboardingPrompt`: listed ⇒ `onboardingGuidance(step, "ATHLETE_CONTEXT")` + `promptView(ctx, "onboarding")` (score + first looks via `readPromptExtras`); unlisted ⇒ today's `renderOnboardingBlock` byte for byte, with the facts comparison under `CONTEXT_SHADOW`. The builder is imported lazily (it reads the assertions through this module). `onboardingGuidance` gains an optional block-name argument; its default output is unchanged |
| Client D6 | `client/screens/brand/StoryTab.tsx` | reads `story › narrative` (the row the record emits) instead of `numbers › story_arc` (never emitted); the narrative row is not repeated in the "what she writes from" list |
| Shadow helpers | `context/shadow.ts` | `SHADOW_IGNORE` (the exception table as code, per reader), `onboardingFactsForShadow` / `promptFactsForShadow`, `recentShadowResults()` (last 50, for tests); the dev script uses the same |
| Not touched | — | no other reader; `sourceGuard` allow-list unchanged (both readers keep their legacy bodies while unlisted; those bodies leave with the readers' listing evidence, before closure); no flag, no migration, prod untouched |

Tests: `athleteRecord.test.ts` (unlisted = legacy byte for byte and no comparison; unlisted + shadow = legacy response + diff recorded with only documented exceptions ignored; listed = the record view, D6 row present, `/me/record` shape intact) and `onboarding.test.ts` (unlisted + shadow = identical prompt + `equal` comparison; listed = `ATHLETE_CONTEXT` fence, guidance points at it, facts + TOLD US present, no D5 line, no leak of prose or addresses). Context suites and the CI list green.

Retained seam (non-blocking, user's review of #413): `readPromptExtras` in the prompt view imports `latestFirstLooks` from `mila/onboarding` — the context layer depending upward on Mila. Acceptable to keep 2d-2 narrow; move that reader into a lower-level `intelligence/context` service when a later PR touches it. Not to be fixed inside 2d-3.

| # | Item | Result |
|---|---|---|
| 1 | Code review | approved by the user at exact head 854d595; `checks` green on that head (11m30s, incl. the two reader suites now in the list) |
| 2 | Merge / deploy to dev (no migration) | squash-merged as 63d5a17; deploy run 34605975171 success; drift gate: no drift; serving revision `nomila-v2-00576-528`; `CANONICAL_CONTEXT_READERS` present and empty, `CONTEXT_SHADOW=false`, claim / substrate / refresh flags `false` |
| 3 | Post-deploy dev shadow run (read-only, 11 Sep 2026) | record 24/24 equal · onboarding 24/24 · identity 24/24 · search 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row); zero differences outside the exception table |

2d-2 is complete. `record,onboarding` are NOT listed on dev and `CONTEXT_SHADOW` stays false: both are separate explicit rollout decisions (design §4 steps a/b), never bundled into 2d-3.

## 2d-3 — identity readers (#4, #7, #9, #10, #26, #28, #39) — #415/#416, merged 56882ef

What the athlete experiences: nothing yet — the `identity` and `admin` readers stay unlisted, so `/auth/me`, Mila's `get_profile`, the voice profile, chat v1, the deal draft, the deal scorer and the admin roster answer byte for byte as before. Listed (rollout step b, the user's word), the team a screen or a prompt names is the ledger's primary current team, never the projection column; chat v1 reads the athlete from a fenced block instead of interpolated prose (D12).

| Reader | Where | Listed (`identity`) | Unlisted | Shadow |
|---|---|---|---|---|
| #4 `/auth/me` | `routes/auth.ts` | `sport`, `school` (= `currentTeam`), `conference` from the identity view; response shape unchanged | projection columns | `shadowIdentity` |
| #7 `get_profile` | `mila/tools/getProfile.ts` | `sport / school / division / conference / segment` from the view; `teams` stays the ledger | projection columns | `shadowIdentity` |
| #9 chat v1 | `routes/chat.ts` | persona line names the athlete from `identityFence(view)` — `<<<ATHLETE_CONTEXT purpose=chat …>>>` with name, sport, team (kind), level, career | today's line with `school` interpolated | `shadowIdentity` |
| #10 voice profile | `voice/profileRoute.ts` | the four projection fields replaced from the view before `readAthleteProfile`; the speakable gate untouched | projection columns | `shadowIdentity` (under the same read timeout) |
| #26 `scoreDeal` | `skills/dealDetector.ts` | `Teams:` from `view.teamsLine`, fallback `School/Team:` = `currentTeam` — no projection fallback | `teamsLineFor` + `school` fallback | `shadowIdentity` |
| #28 `dealDraft` | `services/dealDraft.ts` | — | — | the selected `school` was never read: the column leaves the select; the file leaves the G5 allow-list |
| #39 admin roster | `routes/admin.ts` (`admin` reader) | `school` = `athlete_index_v.team_or_school`, `socials` = index `known_social_handles` (by source class; entered last; twitter → x) via the new bulk `readIndexRecords` | projection + landing-entered socials | `shadowCompare("admin")` per row; promote's unused `school` select removed |

Rules kept: a listed reader throws if the view cannot be built (no silent fallback to the projection); an unlisted reader's shadow failure is logged and never surfaces. `identityFieldsForShadow` compares `school` STRICTLY with the ledger team — a stale projection shows up as a diff (that is the point: the projection stops being a source). The shadow script gains the `admin` reader and uses the same helpers.

Tests: `getProfile.test.ts`, `profileRoute.test.ts` (extended), `auth.me.test.ts`, `chat.v1Identity.test.ts`, `admin.roster.test.ts` (new; the roster test applies 0048 to PGlite), `dealDetector.ingest.test.ts` (extended) — each asserts unlisted = byte for byte, shadow surfaces a stale projection, listed = the ledger. `sourceGuard`: `dealDraft.ts` removed from the projection allow-list.

Documented differences added to the exception table by this PR: admin › `socials.<platform>` — the index adds connected / platform-verified identities the landing form never saw and normalises the handle (no leading `@`); `school` is compared strictly and was equal for every dev athlete.

Pre-merge dev shadow (read-only, 11 Sep 2026): record 24/24 · onboarding 24/24 · identity 24/24 (strict `school` = ledger team) · search 24/24 · deck 10/10 (14 skipped) · admin 24/24 with the four `socials` differences above classified.

| # | Item | Result |
|---|---|---|
| 1 | Code review | #415 approved by the user at head bab2ec9 with one blocker (`sql.raw` in the bulk index read), fixed in 64807b6 and re-review approved (review 5180065347). #415 was closed by GitHub when its stacked base branch (#414) was deleted on merge and could not be reopened; #416 continued on the same branch. Delta from 64807b6 to the merged head 22bd660: one merge of `main` (docs resolved to the branch's build record) and one workflow-only commit — no code differs |
| 2 | CI | the first run on #416 (34613270331) cancelled after every reported suite passed and jest went silent for 17 min: one process for 41 PGlite suites exhausts the runner's memory. The reader suites now run as a second sequential `--runInBand` step; run 34616610165 green on 22bd660 |
| 3 | Merge / deploy to dev (no migration) | squash-merged as 56882ef; deploy run 34618178007 success; drift gate: no drift; serving revision `nomila-v2-00578-lr6`; `CANONICAL_CONTEXT_READERS` present and empty, `CONTEXT_SHADOW=false`, claim / substrate / refresh flags `false` |
| 4 | Post-deploy dev shadow run (read-only, 11 Sep 2026) | record 24/24 · onboarding 24/24 · identity 24/24 (strict `school` = ledger team) · search 24/24 · admin 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row); zero differences outside the exception table |

2d-3 is complete. `identity` and `admin` are NOT listed on dev and `CONTEXT_SHADOW` stays false: separate explicit rollout decisions (design §4 steps a/b), never bundled into 2d-4.

## 2d-4 — deck (#1, #19, #21, #22, #23, #24) — #418, merged 2d0946f

What the athlete experiences: nothing yet — the `deck` reader stays unlisted, so the media kit, the Studio brief, the shot list and the narrator copy are built from the same athlete half as before (the assembled kit JSON is pinned byte for byte by the golden test and did not move). What did change for everyone, by design: the second Narrator-context builder is gone (D6) and the two prompts that carried the athlete's facts as loose prose now carry them inside a typed fence (D12).

| Item | Where | Notes |
|---|---|---|
| #1 `getAthleteContext` switch | `services/athleteContext.ts` | listed (`deck`) ⇒ `deckView(buildCanonicalContext)`; unlisted ⇒ `getAthleteContextLegacy` byte for byte; unlisted + `CONTEXT_SHADOW` ⇒ `shadowCompare("deck")`; both paths throw for an unscored athlete (#20's contract; the studio guard is retained). The context module is imported lazily (it uses this module's helpers). `AthleteContext` gains optional `sourceMode` / `coverage` (the view fills them; the legacy reader reports `legacy`) |
| #22 `buildNarratorContext` | `services/mediaKitService.ts` | **deleted** (D6 locked): its own `athletes_current ⨝ athletes` read, its own blob read and its hard-coded `brandFitTags` are gone; `NarratorContext` is built once from the athlete context, as the assembler already did |
| #21 values card | `services/mediaKitService.ts` | reads `athlete.causes` (the same `values ?? causes` computation the context always made) instead of the `research` passthrough; D5 ⇒ empty on the view |
| #23 `deriveShotList` / `deriveDeckPlan` | `services/shotList.ts` | the context is REQUIRED (no own queries); achievements / partners from `achievementsRaw` / `brandMentions`; the `ATHLETE` facts are a `<<<ATHLETE_CONTEXT purpose=shot_list sourceMode=…>>>` fence (D12); `team` is the context's `org` (ledger-first, as the deck already showed) |
| curator fallback | `services/curator.ts` | a caller without a shot list obtains the context through `getAthleteContext` (an unscored athlete ⇒ no shot list, as before) |
| #24 `buildUserPrompt` | `services/narrator.ts` | the `ATHLETE CONTEXT` list is a `<<<ATHLETE_CONTEXT purpose=narrator>>>` fence (D12); the same fields, values sanitised (no line breaks / angle brackets) |
| G5 | `sourceGuard.test.ts` | `mediaKitService.ts` and `shotList.ts` leave both allow-lists (no blob, no projection read remains) |

D6 decided (user, 2d-4 review): the legacy/unlisted path is unchanged (the assembler still derives the public-deck lanes by rule — parity). On the canonical/listed path `deriveFitCategories` never runs: the deck view carries `brandFitTags` = the `brand_fit_tags` inference from `athlete_inferences` ONLY when its `taxonomy_version` is non-empty (the contract's `Inference.taxonomyVersion`; an unversioned row is treated as absent — read only; no inference-writing machinery in 2d-4) or `[]`; with `[]` the fit card carries no lanes and the narrator's `brand_fit_lanes` line is omitted, not invented. A brand deck keeps the brand's own category (a brand fact, not manufactured athlete intelligence).

Documented differences (the exception table): deck › `brandFitTags` — the canonical inference or `[]` on the view, undefined on the legacy reader (D6; the legacy assembler path still derives lanes by rule); deck › `sourceMode` / `coverage` — provenance on the view; the legacy reader always reports `legacy` and no coverage (on dev the seed athlete, which already holds a few canonical rows, reads `mixed`). Pre-merge dev shadow (read-only, 11 Sep 2026): every reader equal on all 24 athletes with that classified; deck 10 compared, 14 skipped (no `athletes_current` row). The two shot-list prompt goldens were re-recorded for the fence; the public-deck and brand-deck kit goldens are byte-identical.

Tests: `athleteContext.test.ts` (new: unlisted / shadow / listed / unscored throws / fenced shot-list and narrator prompts), `mediaKitService.golden.test.ts` (kit JSON unchanged; prompt goldens re-recorded), `narratorGate.test.ts`, `brief.test.ts`, `studio.test.ts`, `concept.test.ts`, context suites. The golden and narrator suites join the CI reader step.

| # | Item | Result |
|---|---|---|
| 1 | Code review | #418 approved at 969d97c with one blocker (D6: the assembler derived brand-fit on the canonical path) fixed in f59b08a; one lineage fix (unversioned `brand_fit_tags` was still surfaced) in dd10604; code-approved at dd10604; `checks` green on that head |
| 2 | Merge / deploy to dev (no migration) | squash-merged as 2d0946f; deploy run 34637626605 success; drift gate: no drift; serving revision `nomila-v2-00579-mvn`; `CANONICAL_CONTEXT_READERS` present and empty, `CONTEXT_SHADOW=false`, claim / substrate / refresh flags `false` |
| 3 | Post-deploy dev shadow run (read-only, 11 Sep 2026) | record 24/24 · onboarding 24/24 · identity 24/24 · search 24/24 · admin 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row); zero differences outside the exception table |

2d-4 is complete. `deck` is NOT listed on dev and `CONTEXT_SHADOW` stays false: separate explicit rollout decisions (design §4 steps a/b), never bundled into 2d-5.

## 2d-5 — search anchor + research hints (#15, #16, #17, #31, #33, #34, #35, #36, #41) — #420, merged f6d9f92

What the athlete experiences: nothing yet — the `search` reader stays unlisted, so every research trigger (signup, admin refresh, manual re-research, the re-enrich sweep, the 2b refresh) and discovery analytics compute exactly today's search name and handles. Listed (rollout step b), the athlete is searched for by the ledger's primary current team, with the handles the platform verified, and never by a stale projection or a handle guessed by earlier research. Search and hints locate, disambiguate and research an athlete; they are never a source of truth — the extractor and resolver keep their authority rules and nothing here writes.

The mapping (current → frozen target):

| # | Reader | Source today | Listed (`search`) | Class |
|---|---|---|---|---|
| 15 | onboarding v1 + v2 research step | projection → `buildSearchName`; `collectKnownHandles` (typed, connected overrides); v2 freshness gate ages by `created_at` | anchor = ledger primary current team (`searchAnchorFor`); handles = view `knownHandles`; discovery told the ledger team; the gate ages by `as_of` (D1) — NULL = unknown = not fresh | MODIFY |
| 16 | `collectKnownHandles` | typed socials + connected | view `knownHandles`: connected > platform-verified identity > (web-researched only when the domain is canonical) > entered; never the blob | EXTRACT (the function stays for the unlisted path; Step 4 deletes it) |
| 17 | `research_refresh` v1 | as #15 | as #15 | MODIFY |
| 31 | `buildSearchName` ×4 | four copies over the projection | ONE canonical `searchAnchorFor`; the re-enrich and route copies collapse onto the exported legacy builder for the unlisted path; the refresh module keeps its two-line local copy (it must not import the provider-bearing skill) | REPLACE |
| 33 | `reEnrichAllAthletes` | projection anchor, no handles | view anchor + `knownHandles` + ledger team (D7) | MODIFY |
| 34 | `refreshAthlete` + `hintsFor` | projection anchor; `currentAffiliation` read `primary.org_name`, a field that never existed, so it always fell to `school` | anchor + `IdentityHints` from the view (`hintsFromSearchView`); the slip is `primary.org` on both paths (design #34) | MODIFY |
| 35 | discovery `resolveHandles` | typed socials, else the latest blob's `social_handles` (any snapshot) | view `knownHandles`; the blob never | MODIFY |
| 36 | `runPlatformDiscovery` call site | team = `athletes.school` | `ResearchOptions.team` from the caller (the ledger team when listed); absent ⇒ the legacy default | MODIFY (narrow) |
| 41 | manual re-research route | inline projection anchor | `searchInputsFor` (anchor; handles + team when listed) | MODIFY |

Mechanism: ONE boundary, `context/searchInputs.ts` `searchInputsFor(athleteId, legacyInputs)` — listed ⇒ the search view (throws for a missing athlete; no silent fallback); unlisted ⇒ the caller's own inputs untouched; unlisted + `CONTEXT_SHADOW` ⇒ `shadowSearch` records the diff, with a handle classified only when the view's handle is identity-sourced (`SearchView.handleOrigins`) and the anchor compared strictly.

Callouts from the audit: (1) no search/hint is authoritative — they feed provider queries and extraction hints only; (2) legacy blob handles reach a reader only in #35, and only to fill gaps; on the listed path they are excluded (an athlete with blob-only handles gets no discovery fetch — intentional); (3) precedence: connected beats typed everywhere today; the frozen §2.2 order additionally puts a platform-verified identity above a typed handle — the one place a researched handle can outrank the athlete's own entry on the listed path; web-researched identities are excluded while the `social_handles` domain is not canonical; (4) #34 and #36 read the projection directly today and go through the view when listed; (5) a second latent slip found next to #34 and NOT changed (surfaced for the user): `hintsFor`'s `hasAssertedAffiliations` tests `a.kind`, which on an `Affiliation` is the ORG kind (school/club/…), not `kindOfFact` — so it is false even when the athlete has a said/proof row; it feeds `resolveFacts`' assertion-override rule on the flagged-off refresh and dual-write paths; fixing it is a research-resolution change, outside 2d; (6) intentional differences: anchor where the projection is stale, identity-sourced handles, the `as_of` gate, the `org_name` slip (both paths — the refresh and dual-write paths are behind flags that are false), blob handles dropped from discovery, handles + team now passed by re-enrich and the manual route.

Tests: `context/searchInputs.test.ts` (new: unlisted untouched, shadow strict on the anchor and classified on identity handles, listed = the view, blob never, missing athlete throws), `definitions.test.ts` (listed research step: ledger anchor + view handles + team; unlisted byte for byte; D1 gate: listed ignores a carry-forward's `created_at`), `researchDualWrite.hints.test.ts` (the slip), `refresh.test.ts` (listed query anchor + hints from the view), `collectDiscoveryAnalytics.handles.test.ts` and `reEnrichAthletes.test.ts` (new). Source guard: unchanged — every legacy path remains until its reader is listed. No migration, no contract change beyond `SearchView.handleOrigins` and `ResearchOptions.team`.

| # | Item | Result |
|---|---|---|
| 1 | Code review | #420 approved at exact head 586a896 (no blocker); `checks` green on that head |
| 2 | Merge / deploy to dev (no migration) | squash-merged as f6d9f92; deploy run 34644952235 success; drift gate: no drift; serving revision `nomila-v2-00580-tfx`; `CANONICAL_CONTEXT_READERS` present and empty (neither `search` nor `deck` listed), `CONTEXT_SHADOW=false`, claim / substrate / refresh flags `false`; prod service still on `nomila-v2-prod-00001-zcv` |
| 3 | Post-deploy dev shadow run (read-only, 11 Sep 2026) | record 24/24 · onboarding 24/24 · identity 24/24 · search 24/24 (anchor strict) · admin 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row); zero differences outside the exception table |

**2d-5 is CLOSED ON DEV.** `search` is NOT listed and `CONTEXT_SHADOW` stays false: separate explicit rollout decisions (design §4 steps a/b).

**Follow-up (explicit, not lost):** `hintsFor.hasAssertedAffiliations` (`server/skills/researchDualWrite.ts`) tests `a.kind` — the ORG kind on an `Affiliation` — instead of `kindOfFact`, so a said/proof row is not recognised by `resolveFacts`' assertion-override rule on the (flag-gated) refresh and dual-write paths. Agreed with the user (2d-5 review): resolve it at the research-resolution / Identity boundary (Step 3 or the research-resolution step), never as a silent 2d change. Tracked in the README's open-items list.

## 2d-6 — sync + projection + as-of (0050) — #422, merged 9be9ca1 — CLOSED ON DEV

Principle (user, 2d-5 review): the canonical profile/context is the source of truth; the projection (`athletes.school / division / conference / segment`) and the blob carry-forward are compatibility infrastructure during migration. 2d-6 does not create another projection and does not preserve obsolete authority for byte parity — where the ledger and the projection disagree, the ledger wins and the projection follows it.

### Dev state the scope is written against (11 Sep 2026, read-only)

| Fact | Dev |
|---|---|
| `athlete_snapshots` | 273 rows: signup 2, manual 15, re_enrich 10 (all research-producing, all with research), scheduled_refresh 231 (carry-forward, all with research), social_connect 15 (13 with research, 2 pre-research NULL); **`as_of` NULL on every row** |
| `athletes` | 24 rows; 18 with `school`, all 18 have a current ledger row; **0 athletes have a projection without a current row**; 11 with `conference` (3 as `Atlantic Coast Conference (ACC)`, 2 `ACC`, others short); 0 retired |
| `athlete_affiliations` | 18 said/signup (all current, all primary), 1 found/research (ended); `fact_id` does not exist |
| `athlete_facts` key `affiliation` | 0 rows (the substrate write flag is off; rule-7 has never run on dev) |

Consequence: on dev today 2d-6 changes no reader's output except the three D11 conference normalisations (if re-projected) and the research dates once `as_of` is back-filled; the NULL rule and the sync have no rows to act on until the substrate is enabled (the user's separate rollout decision).

### Mapping (current → target)

| # | Reader / writer | Today | After 2d-6 | Class |
|---|---|---|---|---|
| 38 | `projectPrimary` (`services/affiliations.ts`) | writes `school / division / conference` from the primary current row, else the newest current row; **early return keeps stale values when no current row** (C13); `conference` written raw (D11) | current-only rule (§4.4): a current row ⇒ `school = org_name`, `division = level ?? kind-derived`, `conference = normalizeConference(conference)` (the v7.2 `scoringService.normalizeConference`: `(ACC)` suffix or full-name map ⇒ short form); **no current row ⇒ all three NULL** (`segment`, generated from `division`, follows); called after the sync (§3.5) | MODIFY |
| 30 | `researchAthlete` fill-if-null (`skills/researchAthlete.ts:749-754`) | research back-fills `school / conference / division` when NULL (raw conference) | removed: research never writes the projection; it writes affiliation rows (found rows today via `proposeFoundAffiliations`; facts via the substrate). `sport` fill-if-null stays (not a projection of the ledger). The snapshot write gets `as_of = created_at` | MODIFY (narrow) |
| 12 | `refreshAthleteScore` carry-forward (`skills/refreshScores.ts:250`) | inserts a `scheduled_refresh` snapshot copying `latestSnap.research`; `as_of` not written (NULL) | same insert plus `as_of = latestSnap.as_of` (inherits; possibly NULL); scoring inputs untouched (G9) | MODIFY |
| 13 | `fetchSocialData` carry-forward (`skills/fetchSocialData.ts:308`) | inserts a `social_connect` snapshot copying `latestSnapRow.research`; `as_of` NULL | same plus `as_of = latestSnapRow.as_of` | MODIFY |
| — | `syncAffiliationsFromFacts(athleteId)` (`services/intelligence/research/affiliationSync.ts`, new) | does not exist; rule-7 facts never reach the ledger | §3.5 exactly: stable key `(athlete_id, org_kind, normalizeText(org_name), season)`, `kind='found'`, `source='fact'`, `fact_id`; reconfirm ⇒ touch + re-point; same-key date correction ⇒ update dates + re-point; different org/season ⇒ close old (`ended_on`) + insert; historical fact ⇒ `ended_on`; said/proof rows never modified or demoted; found primary only when the fact says `primary` and no confirmed current row exists; idempotent (G6); runs inside `persistResearchRun` after the facts are resolved, then `projectPrimary` — i.e. only when `RESEARCH_SUBSTRATE_WRITE` is true (dormant on dev/prod today) | ADD |
| — | migration `0050_affiliations_fact_id.sql` | — | `ALTER TABLE athlete_affiliations ADD COLUMN IF NOT EXISTS fact_id uuid NULL REFERENCES athlete_facts(id) ON DELETE SET NULL; CREATE INDEX IF NOT EXISTS idx_affiliations_fact ON athlete_affiliations(fact_id) WHERE fact_id IS NOT NULL;` — additive, idempotent, no data change; `shared/schema.ts` gains the column (drift gate); `scripts/db-migrate.sh` list 0031–0050 | ADD |
| — | `as_of` back-fill (`server/scripts/backfillSnapshotAsOf.ts`, dry-run default) | `as_of` NULL everywhere | §4.3 rule, exactly: research-producing = `trigger IN (signup, manual, re_enrich) AND research IS NOT NULL AND sources ? 'apis_called' AND NOT sources ? 'score_refresh'` ⇒ `as_of = created_at`; carry-forward = `trigger IN (scheduled_refresh, social_connect) AND research IS NOT NULL` ⇒ `as_of` of the most recent EARLIER research-producing row of the same athlete with the same `md5(research::text)`, else NULL and listed; `research IS NULL` ⇒ NULL; only fills NULLs (idempotent); prints per-athlete resolved/unknown counts before and after; `--apply` on the user's word | ADD |
| — | projection reconciliation (`server/scripts/reprojectAffiliations.ts`, dry-run default) | — | one pass of the new `projectPrimary` over every athlete, reporting each change (dev expectation: 3 conference normalisations, 0 NULLings); `--apply` on the user's word | ADD |
| — | G9 scoring-input digest (`server/scripts/scoringInputsDigest.ts`) | `testScoring.ts` exists (one athlete) | a digest of `computeScore`'s inputs (the `AthleteRecord` + snapshot fields it reads) per dev athlete, run before and after 2d-6 deploy/backfill; must be byte-identical | ADD |
| 11 / 32 | `computeScore`, `unionResearch` | read the blob / the projection | unchanged (Step 4) | KEEP |
| 37 | `listAffiliations`, `primaryAffiliation`, `levelRecordFor`, `teamsLineFor`, `proposeFoundAffiliations` | canonical | unchanged; `proposeFoundAffiliations` (legacy found-team writer from the blob) stays until Step 4 — it writes `kind='found', source='research'`, `fact_id NULL`, and the sync never touches those rows (different source) | KEEP |
| 40 | waitlist `coalesce(school)`; signup insert `school` (`routes/auth.ts:115`) | the athlete's own entry | unchanged (a write of the athlete's word; the said ledger row is written by the same flows) | KEEP |
| — | legacy adapter / views / onboarding gate | read `as_of` already (2d-1 … 2d-5) | unchanged; they start seeing real dates once the back-fill is applied | KEEP |
| — | rateService `record.school` pass-through; `levelRecordFor`'s projection fallback | read the projection | unchanged; on dev every athlete with a projection has a current row, so nothing changes; a future retired athlete gets NULL ⇒ `levelRecordFor` falls to the (empty) fallback exactly as the design intends (career_status carries the meaning) | KEEP |

### Every remaining dependency on the projection / blob that 2d-6 affects
Writers of the projection after 2d-6: `projectPrimary` (from the ledger only) and the athlete's own entry at signup/waitlist. Removed: research fill-if-null. Readers still on the projection: every migrated reader's **unlisted** path (behind the boundary until listed), scoring (`AthleteRecord.school` pass-through, `levelRecordFor` fallback), the legacy adapter (`legacy_row`). Readers of the blob: scoring (Step 4), `unionResearch`, the legacy adapter, and the unlisted paths of #2/#5/#35. None of these change in 2d-6; what changes is that the projection can no longer be stale (C13) or raw (D11), and every snapshot carries a truthful `as_of`.

### Which projection fields become nullable / stop being authoritative, and why
`school`, `division`, `conference` are already nullable; `segment` is generated. From 2d-6 they are a **derived cache of the ledger's primary current row** (NULL when there is none), never authoritative and never written by research: the ledger (`athlete_affiliations`, said/proof/found with provenance) is the source of truth for teams, `levelRecordFor` already prefers it, and every migrated reader takes the team from the view. Step 4 drops the columns' remaining readers (scoring) and then the columns.

### Rollback
- Code: revert the PR; the legacy fill-if-null and the early return come back; `as_of` values already written are harmless (readers treat them as dates; NULL stays "unknown").
- 0050: additive; a rollback leaves a nullable column + index in place (no reader depends on it) — dropping it is a separate, optional `ALTER TABLE … DROP COLUMN` (loses only fact links).
- Back-fill: `as_of` only fills NULLs; reversal = `UPDATE athlete_snapshots SET as_of = NULL` (a one-line script, kept next to the back-fill).
- Re-projection: reversible by re-running the old rule? No — the old values (raw conference / stale team) are not kept; the script prints the before/after per athlete so they can be restored by hand if ever needed (dev: 3 conference strings).

### Expected parity differences (classified)
1. **D11**: 3 dev athletes' `conference` becomes the short form (`ACC`) after re-projection — visible on the unlisted `/auth/me`, `get_profile`, voice profile, onboarding block (`conference:` line) and the Facts level row; scoring already normalises, so scores are unchanged (G9).
2. **C13 / NULL rule**: no dev athlete affected today (0 projections without a current row); a future athlete whose last team ends gets NULL `school/division/conference/segment` on every unlisted projection reader and `levelRecordFor` falls back to nothing — by design.
3. **D1 dates**: after the `as_of` back-fill, the record view's research rows, the onboarding `researched:` line and the prompt tags show the true research date instead of "unknown"/NULL on the listed paths; unlisted paths keep `created_at` (their documented exception) until listed.
4. **Sync**: no visible change until `RESEARCH_SUBSTRATE_WRITE` is on and rule-7 establishes a fact.
5. Shadow: the record/onboarding exception lists already cover the date paths; the D11 conference change is equal on both sides (both read the projection unlisted; the view's `level` comes from the ledger's raw conference — `levelRecordFor` returns the ledger value, so the LISTED identity/onboarding views will show the raw ledger string while the unlisted projection shows the short form. **Design question for review (Q1):** should `levelRecordFor` / the views normalise `conference` the same way, so listed and unlisted agree? Recommended: yes — apply `normalizeConference` in `levelRecordFor` (one place; the ledger row keeps the raw entry).

### Implementation (as built)

| Item | Where |
|---|---|
| 0050 | `migrations/0050_affiliations_fact_id.sql` — `ALTER TABLE athlete_affiliations ADD COLUMN IF NOT EXISTS fact_id uuid NULL REFERENCES athlete_facts(id) ON DELETE SET NULL; CREATE INDEX IF NOT EXISTS idx_affiliations_fact … WHERE fact_id IS NOT NULL;` additive, idempotent, no data change; `shared/schema.ts` + `scripts/db-migrate.sh` (0031–0050) |
| `projectPrimary` | `services/affiliations.ts` — exported; PRIMARY current row only (Q2), else NULL/NULL/NULL; `conference` via `scoringService.normalizeConference` (D11); accepts a transaction |
| `levelRecordFor` | same normalisation on `conference` (Q1) |
| `syncAffiliationsFromFacts` | `services/intelligence/research/affiliationSync.ts` — §3.5 as written; key `(athlete, org_kind, normalizeText(org), season ?? year(valid_from ?? from) ?? "")` (Q3); owns only `kind=found, source=fact` rows; then `projectPrimary`; called inside `persistResearchRun`'s transaction after the facts (`WriteOut.affiliationSync`) — reachable only when `RESEARCH_SUBSTRATE_WRITE` is true |
| research fill-if-null | removed for `school / conference / division` (`sport` fill stays); the source guard asserts it stays gone |
| `as_of` | `researchAthlete` stamps `created_at = as_of = now` on a research-producing snapshot; `refreshScores` and `fetchSocialData` carry-forwards inherit `latestSnap.as_of` |
| scripts | `backfillSnapshotAsOf.ts` (dry-run default; `--apply` fills NULLs only; `--revert` is the rollback) over the pure rule in `research/snapshotAsOf.ts`; `reprojectAffiliations.ts` (dry-run default; `--apply`); `scoringInputsDigest.ts` (read-only, G9) over `research/scoringDigest.ts` |
| tests | `affiliationSync.test.ts` (G6 + Q2 + Q3 + legacy rows untouched), `snapshotAsOf.test.ts` (G7), `affiliations.test.ts` (projection rule), `persist.test.ts` (the hook: found row + projection after rule 7), `scoringDigest.test.ts` (G9 on fixtures), `sourceGuard.test.ts` (research never writes the projection) |

Decisions applied: Q1 yes; Q2 primary-only (no newest-current fallback); Q3 undated facts key on org + kind, later dated evidence is a distinct key (closed + inserted).

Pre-merge dry-run evidence (dev, read-only, 11 Sep 2026):

| Check | Result |
|---|---|
| `backfillSnapshotAsOf` dry-run | 273 rows: **271 resolved, 0 unknown, 2 noResearch** (the two pre-research `social_connect` rows stay NULL); every carry-forward found its research-producing source; nothing written |
| `reprojectAffiliations` dry-run | 24 athletes: **4 changes, 0 nulled** — all D11 conference normalisations (`Atlantic Coast Conference (ACC)` → `ACC` ×3, `Girls Academy (GA)` → `GA`); no athlete loses a team (every projected athlete has a primary current row); nothing written |
| `scoringInputsDigest` baseline | overall `0bd3f1dbf5494ac47d41ff9f2396cebd091628a26087e99210bc76e932792b1a` over 24 athletes (19 skipped by refreshScores' own rules: no analytics data / no prior snapshot — their digests still cover the inputs read); the post-deploy run must match byte for byte (G9) |
| 0050 dry-run, dev | `BEGIN … 0050 … ROLLBACK`: column `fact_id` (nullable) + `idx_affiliations_fact` created, rolled back; column absent afterwards |
| 0050 on prod | **Incident** (see the README): the chained "dry-run" was committed by the inner `COMMIT` of 0040/0042; `0044–0050` schema objects — including `athlete_affiliations.fact_id` — are now PRESENT on production (schema only, zero data rows; not "recorded as applied": the hand files have no ledger). User decision: leave as is. The next normal production deploy re-runs the idempotent files (no change) and passes the drift gate |

`listAffiliations` now selects explicit columns (never the sync's `fact_id`), so the readers and the dry-run scripts behave identically before and after 0050.

### Closure evidence (dev, 11 Sep 2026)

| # | Item | Result |
|---|---|---|
| 1 | Code review | #422 approved at exact head fb1df91 (code review + the separate incident-reconciliation review); `checks` green on that head |
| 2 | Merge / deploy | squash-merged as 9be9ca1 (#421 closed as superseded — its content landed with it); deploy run 34651441753 success; **0050 applied through the normal path** (`fact_id` column + `idx_affiliations_fact` present on dev); drift gate: no drift; serving revision `nomila-v2-00581-wxk` |
| 3 | Flags / readers / prod | `CANONICAL_CONTEXT_READERS` present and empty (no reader listed), `CONTEXT_SHADOW=false`, claim / substrate / refresh flags `false`; production service unchanged (`nomila-v2-prod-00001-zcv`), production not touched |
| 4 | `as_of` reconciliation | dry-run = the approved plan (271 resolved, 0 unknown, 2 noResearch) ⇒ applied: **271 rows dated**; after: signup 2/2, manual 15/15, re_enrich 10/10, scheduled_refresh 231/231, social_connect 13/15 (the 2 pre-research rows stay NULL) |
| 5 | Projection reconciliation | dry-run = the approved plan (24 athletes, **4 changes, 0 nulled**, all D11 conference normalisations) ⇒ applied; conferences now `ACC` ×5, `SEC` ×2, `Big Ten`, `Big 12`, `Big West`, `GA` |
| 6 | G9 scoring inputs | post-deploy digest **`0bd3f1dbf5494ac47d41ff9f2396cebd091628a26087e99210bc76e932792b1a`** — byte-identical to the pre-merge baseline over 24 athletes |
| 7 | Full read-only shadow | record 24/24 · onboarding 24/24 · identity 24/24 · search 24/24 · admin 24/24 · deck 10/10 equal, 14 skipped (no `athletes_current` row); zero differences outside the exception table |

**2d-6 is CLOSED ON DEV, and with it Step 2d is CLOSED ON DEV** (all six PRs merged and deployed through the normal path with clean drift; every MODIFY/EXTRACT/REPLACE reader behind its boundary with shadow parity evidence per group; D1, D2, D4, D5, D6, D7, D8, D11, D12 and C13 fixed in code and verified by tests and dev dry-runs; G9 byte-identical; prod untouched by the step). Not part of closure and NOT done: rollout steps a/b (`CONTEXT_SHADOW=true` on dev; listing readers on dev; the Facts screen provenance review with Mia), enabling the substrate / backfill / planner / claim flags, Step 4. Open follow-up: `hasAssertedAffiliations` (README).

### Design questions (settled)
- **Q1** (above): normalise `conference` in `levelRecordFor` as well as in `projectPrimary`.
- **Q2**: `projectPrimary` today falls back to the *newest current* row when no current row is primary (a found row can be projected). §4.4 says "primary current row → …; no current row → NULL" and is silent on "current rows, none primary". Proposed: keep today's fallback (newest current), because a said row written by the team editor is always primary, and a lone found current row is the ledger's best statement — but it means a research-found team can appear as `school` on unlisted readers exactly as it does today. Alternative: project only a primary row (NULL otherwise). Your call.
- **Q3**: the sync's `season` for the dedupe key = `value.season ?? year(valid_from)`; a fact with neither ⇒ key without season (org + kind) — one row per org/kind. Confirm.

### Tests (targeted)
- G6 in `affiliationSync.test.ts` (PGlite): twice ⇒ no new rows and stable `updated_at` semantics; reconfirm ⇒ re-point only; same-key date correction ⇒ update in place; new org/season ⇒ close + insert; historical ⇒ `ended_on`; said/proof never modified or demoted; found primary only when allowed; the one-primary-current index holds; `proposeFoundAffiliations` rows (`source='research'`) untouched.
- `projectPrimary`: NULLs for an athlete whose only row ended (retired); `normalizeConference` applied; Q2 case; research no longer writes the projection (`researchAthlete` test extended).
- G7 in `backfillSnapshotAsOf.test.ts` (PGlite): research-producing ⇒ `created_at`; carry-forward chain inherits; byte-identical later re-research gets the later date; no lineage ⇒ NULL and reported; `research NULL` ⇒ NULL; idempotent; the two carry-forward writers write `as_of` (refreshScores / fetchSocialData tests extended); the gate test from 2d-5 already covers the listed reader.
- G9: `scoringInputsDigest` on PGlite fixtures before/after; on dev before/after deploy + back-fill (recorded).
- Source guard: unchanged lists (the projection writers are the write path; the adapter is the reader).

### Deployment / acceptance plan
1. PR (code + 0050 + scripts + tests) → code review → CI green → merge → normal dev deploy: `db-migrate.sh` applies 0050 (BEGIN…ROLLBACK dry-run against dev AND prod first, per the migration rule), drift gate clean, flags unchanged.
2. On dev, read-only: `scoringInputsDigest` (baseline), `backfillSnapshotAsOf` dry-run report (expect 27 research-producing dated, 244 carry-forward resolved, 2 NULL research rows untouched, 0 unknown), `reprojectAffiliations` dry-run report (expect 3 conference changes, 0 NULLings).
3. On the user's word: `--apply` both scripts; re-run the digest (must match); full read-only shadow (expect equal; the D1 date exceptions already classified).
4. Evidence recorded; **Step 2d closure review** (design §6 criteria: all six PRs, G5 source guard, shadow evidence per group, D1/D2/D4/D5/D6/D7/D8/D11/D12/C13 verified, G9, prod untouched) — noting that "readers listed on dev per rollout step b with the Facts review with Mia" is a separate rollout decision that closure depends on.

### Explicit confirmations
- No canonical reader is activated (`CANONICAL_CONTEXT_READERS` stays empty; `CONTEXT_SHADOW` stays false).
- No claim / substrate / refresh / planner flag changes; the sync is reachable only through `persistResearchRun`, which is behind `RESEARCH_SUBSTRATE_WRITE=false`.
- Not Step 3 Identity (no claim UI, no Athlete ≠ User split), not Beta.1 MIA (scoring inputs byte-for-byte, G9).
- Prod untouched (0050 applied to prod only through the normal prod deploy path, on the user's word; prod has 0 athletes).

