# Phase A · Step 2c — Athlete Index (AUDIT + DESIGN + MIGRATION MAP, no code)

**Status:** APPROVED and FROZEN (11 Sep 2026) after design review round 1. The Step 2c implementation PR is built exactly against this document. Frozen model: exact identifiers may affect the match tier; only `claimProof` can authorize a link. The pre-link guard is provider-neutral (`requireIdentityUser`) if any sign-in provider does not resolve to a Firebase identity token; the contract is unchanged: verify the authenticated user without requiring `req.athleteId`.
**Spec:** Blueprint V1 / Commercial Intelligence Beta.1 §2–§4 (identity confirmation before research; the cost ladder), §6, §19. Approved Step 2 design `step2-research-canonical-profile-design.md` §5.2 (ladder), §8 (Athlete Index), §11 (2c row: "`athlete_index_v` view; candidate search endpoint (auth-scoped, public fields only); `claimable` policy; no UI"), O8 (golden anchors / discovery rows), O11 and ADR-015 (user ≠ athlete), ADR-016.
**Rules preserved:** SEED → IDENTITY RESOLUTION → FULL RESEARCH → VERIFIED SOCIAL ENRICHMENT. **Search the Athlete Index first; never pay for full research to learn whether an athlete already exists.** 2c makes zero provider calls.
**Out of scope:** the claim / "Is this you?" UI and the Athlete ≠ User split (Step 3); reader migration and the Context Builder (2d); any research execution or scoring change; enabling any flag in prod.

## Revision log (review round 1)

| Review point | Where it landed |
|---|---|
| Matching separated from claim authorization; explicit `claimProof`; public identity evidence never authorizes a claim | §4 restructured: 4.3 match tiers (which athlete?) and 4.4 claim proof (may this user link?), 4.5 the decision matrix; §5, §6, §8, §9 |
| Typed handle removed from any decisive-claim rule; stored source class describes the record, not the claimant | §4.2, §4.4 |
| Exact identifiers must be unique to count; ambiguous email/handle forces candidate/review; claim-authorizing email = unique **verified** email | §4.2 `ambiguousIdentifier`, §4.4 `verified_unique_email`, §5 |
| Minimum-evidence rule for score-based auto-match (name alone never auto-matches; one corroborating signal; gap kept); tests for name-only and same-name athletes | §4.3, §9.3 G1 |
| `claimability = open` fully derivable from existing columns; `origin` deferred to Step 3 | §4.6, D4 |
| Candidates endpoint guard that does not require an athlete linkage | §9.2 `requireFirebaseUser`, §8 |
| The auth-id unique index is part of Step 2c closure, not an optional rollout | §10, §11 D6 |

## What the athlete experiences, and what happens underneath

Today a new athlete who signs up is matched to an existing profile by a substring of her name and the first row that happens to come back, with no confirmation. If the match misses, a second profile is created for the same person, and nothing ever notices. If it hits the wrong person, she is silently attached to a stranger's profile, including the five rate-model anchors. The full paid research then runs at signup before anyone has checked who she is.

After 2c there is one place to ask "who is this athlete?": the Athlete Index, a read-only view over what Nomila already knows (name and aliases, sport, current team or school, class year, known public handles, research status, identity confidence). Every creation path asks it first, for free. But knowing *which profile this probably is* is a different question from *whether this signed-in person has proven it is hers*. The index answers the first. A profile is linked to a user only on proof: the same login as before, a verified email that matches exactly one profile, or ownership of a connected social account. A lookalike name, the right sport and team, or a typed public handle never link on their own, however well they match; they produce a candidate list for the "Is this you?" step that Step 3 builds, and until then the new profile is created and the possible duplicate is written down where an operator can see it. Nothing in 2c spends a provider call, and nothing visible changes for the athlete: the index and its endpoint ship dark, the signup change sits behind a flag that is off in both environments.

## 1. Current state (audit, 11 Sep 2026)

### 1.1 How an athlete comes to exist, and what looks her up

| # | Path | Lookup before insert | Writes | Then | Verdict |
|---|---|---|---|---|---|
| A | app signup `routes/auth.ts:83-186` | (1) `auth_id = uid`; (2) `lower(email)` with `auth_id IS NULL` → attach uid, keep status; (3) `ilike '%name%'` (+ `sport`) with `auth_id IS NULL AND status IN ('raw','enriched')` **LIMIT 1, no order, no score, no confirmation** → set `auth_id`, `status='claimed'` | `full_name, email, auth_id, sport, school, status='raw'` | onboarding run (full research at signup when a sport is given) | (1),(2) **KEEP**; (3) **REPLACE** by the index candidate query under a flag (§6); the "is this you?" UI is Step 3 |
| B | Microsoft OAuth `auth.ts:311` | `auth_id` only | `full_name, email, auth_id, status='raw'` | nothing | index query added under the same flag |
| C | landing waitlist `routes/waitlist.ts:234-254` | `auth_id` only | `full_name, first/last, school, sport, goals, email, socials{instagram,tiktok,youtube,twitter}, status='waitlisted'` | onboarding run when a sport is known | index query added under the same flag; **`waitlisted` rows join the claimable set** (today they are excluded from (3), so a waitlisted athlete who later signs in with another email is duplicated) |
| D | `scripts/seedGoldenAnchors.ts:36-44` | exact `full_name AND sport` | `status='raw'`, `socials.instagram` | `golden_athletes` anchor | index members, **never claimable** (O8) |
| E | discovery rows (4 Stanford athletes, created out of band) | none | no auth, no email | — | index members, claimability **review** (§4.4) |
| — | admin waitlist list `routes/admin.ts:60-170` | `status = ?` only, ordered by `created_at`; the admin UI has **no search input** | — | — | gains `?q=` via the index (read-only, admin-only) |
| — | admin promote `admin.ts:174-258` | `athletes.id` | `status='active'` | onboarding / re-research | unchanged |
| — | every other reader (Mila tools, onboarding, research refresh/planner, kit share, `GET /auth/me`) | `athletes.id`, `auth_id` or `status` | — | — | unchanged; none keys on name/handle/email |

There is **no athlete search endpoint** (`routes/search.ts` is brands and the caller's own deals), no `similarity()` query against `athletes`, no reader of `athletes_full_name_trgm_idx` or `athlete_facts_alias_trgm_idx` (both shipped in 0046 for 2c), no view anywhere in the database, and no `pgView` in `shared/schema.ts`.

### 1.2 Identity signals that exist today

| Signal | Where | State |
|---|---|---|
| `auth_id` (Firebase UID) on the athlete row | `athletes.auth_id`; `requireAuth` resolves token → `req.athleteId` by it | the user IS the athlete row (ADR-015 debt); the effective identity signal everywhere in 2a/2b is `auth_id IS NOT NULL OR active connection` |
| `claimed_at` | `athletes.claimed_at` | **four readers, zero writers** (dead) |
| `status='claimed'` | set by signup path (3) | not `claimed_at` |
| active `connected_accounts` | OAuth connections | the strongest ownership proof; admin reads it to "eyeball identity before promoting" |
| `social_identities` (Step 1a) | `(athlete_id, platform, account_id)` unique; `handle`, `source_class`, `confidence`, `status`, `connected_account_id` | the only durable per-account identity with confidence; **uniqueness is per athlete** (the same handle on two athletes is legal and undetected); **no index on `handle`** (handle → athlete is a sequential scan) |
| legacy resolvers `intelligence/social/adapters/legacy.ts:164-213` | exact account id → connection linkage → unique handle match → unknown; media rows only with a sole candidate | correct, but **within one athlete's identity set only**; there is no cross-athlete resolution anywhere |
| web resolver confidence `lib/socialWebResolver.ts` | `{found, handle, followers, confidence, evidence}`; never guesses a handle | confidence **logged and discarded** (`platformDiscovery.ts:329`, D10) |
| onboarding v2 `greet` step | `await_human` "confirmed / corrections" after research | confirms *what research found*, not *which athlete you are*; silence counts as confirmation; research has already run |

### 1.3 Names, aliases and hints

| Source | State |
|---|---|
| `athletes.full_name` (raw), `first_name`/`last_name` (landing only) | `/auth/me` re-splits `full_name` on spaces |
| `athlete_asserted.field='nickname'` ("Goes by") | captured; `column: null`; **never projected, never a fact** |
| `athlete_facts` `name` / `alias` (registry v1) | schema + partial trigram index on `value_text WHERE fact_key='alias'` exist; `value_text` is `normalizeText` (NFD, strip marks, lower, non-alnum → space); **zero rows** (substrate off); `hintsFor` hard-codes `aliases: []`, so the extractor's "Also known as" line never renders |
| `IdentityHints` / `athlete_research_state.search_hints` | persisted copy of the hints; nothing reads `search_hints` |
| `social_identities.handle_history` | prior handles per identity |
| `buildSearchName` (three copies) | `name + projected school + sport` (D8: a stale school anchors the search) |

### 1.4 Duplicates

- **No unique constraint on `athletes` at all** (not email, not auth_id, not name); the only uniqueness that touches athletes is `golden_athletes.athlete_id`.
- No dedupe or merge script for athletes; no `merged_into`; no duplicate detector.
- Reachable today: signup (3) misses (name typed differently, sport mismatch, `waitlisted` status) → a second row; golden anchors and discovery rows are in the claim candidate set (D9).
- The codebase's established identity pattern is **brands**: `normalizeBrand` → pre-flight collision report (`checkBrandCollisions.ts`) → evidence-validated alias table → `inbox_brands.normalized_name UNIQUE` → marker-guarded backfill in `db-migrate.sh`, with a separate trigram index for fuzzy search. 2c follows the same shape where a constraint is added.

### 1.5 What the deploy path offers a view

`db-migrate.sh` step 3 picks up any new hand-written `00NN_*.sql` in numeric order; `checkSchemaDrift.ts` iterates `pgTable` exports only, so a view is neither verified nor flagged (a `pgView` export is skipped by the gate). `athlete_index_v` would be the first view in the system; its shape needs its own gate (§9).

## 2. Target: the canonical Athlete Index record

A **SQL view, `athlete_index_v`, no new athlete state**. One row per `athletes` row. Every column is derived from a source that already has an owner; the index never stores a fact, a status or a confidence of its own.

```
AthleteIndexRecord {
  athleteId              uuid          athletes.id
  fullName               text          athletes.full_name (display, raw)
  nameNorm               text          normalized full name (§3), the match key
  aliases                text[]        athlete_facts current rows, fact_key='alias' → value_text (normalized) — [] until the substrate is on
  sport                  text|null     current `sport` fact (origin athlete_asserted > research) else athletes.sport
  teamOrSchool           text|null     primary current athlete_affiliations.org_name, else newest current, else NULL   (never athletes.school)
  orgKind, level, conf.  text|null     the same affiliation row
  affiliationKind        said|proof|found|null   whether the team of record is the athlete's word, a contract, or research
  classYear / gradYear   int|null      current `class_year.season` / `graduation_year` facts
  cityOrCountry          text|null     current `hometown` fact (city, country) — no address
  knownSocialHandles     jsonb         { platform: { handle, sourceClass, confidence } } from social_identities status='active' (one per platform: connected_verified > platform_public > web_researched), else athletes.socials as source 'entered'
  identityConfidence     numeric       athlete_research_state.identity_confidence (0 when no row)
  researchStatus         text          athlete_research_state.research_status ('seed_only' when no row)
  disputedDomains        text[]        athlete_research_state.disputed_domains
  lastResearchedAt       timestamptz|null
  nextDueAt              timestamptz|null
  connectionStatus       none|active|expired|revoked   DERIVED from connected_accounts (best active > expired > revoked), never stored (R2)
  hasUser                boolean       athletes.auth_id IS NOT NULL  — the ONLY auth-derived field; Step 3 re-points it at the user table without changing the record
  claimability           open|review|none   policy (§4.4)
  isGoldenAnchor         boolean       EXISTS golden_athletes
  athleteStatus          text          athletes.status (legacy lifecycle: waitlisted|raw|enriched|claimed|active)
  indexUpdatedAt         timestamptz   greatest(athletes.created_at, state.updated_at, affiliation.updated_at, identity.last_verified_at)
}
```

**Not in the record, by design:** `email`, `auth_id`, `auth_provider`, `stripe_customer_id`, `plan`, goals, deal preferences, private metrics, anything from `connected_verified` observations. The view is the public-fields boundary; the endpoint returns the view's columns and nothing else.

**Field sources, precedence, and why**

| Field | From | Rule |
|---|---|---|
| name | `athletes.full_name` | the legacy row is the name of record until Step 3; a current `name` fact (athlete-asserted) would override the *match key* only, not display (2d moves display) |
| aliases | canonical facts | `alias` facts of any origin with status current; 2c also starts producing them: `nickname` assertions map to `alias{kind:'nickname'}` (§6.4) |
| sport | fact > column | the athlete's assertion wins (origin rank), research next, the projected column last |
| team/school, level | `athlete_affiliations` ledger | never `athletes.school` (C13: a retired athlete keeps her last team as "current" in the projection); `affiliationKind` tells the ranker whether it is said/proof (strong) or found (weak) |
| handles | `social_identities` > `athletes.socials` | connected and platform-verified identities outrank entered text; the entered handle is still indexed (it is what a new signup will type) |
| research/identity fields | `athlete_research_state` | read live; the index never copies them |
| connection | `connected_accounts` | derived at read time |

## 3. How aliases and identity hints are indexed

Match keys and the indexes that serve them:

| Key | Indexed expression | Index | Exists? |
|---|---|---|---|
| full name (fuzzy) | `athletes.full_name` | `athletes_full_name_trgm_idx` gin trgm (0046) | yes — pg_trgm is case-insensitive and ignores non-alphanumerics, so the raw column serves fuzzy match; accents are the one gap (§11 D5) |
| alias (fuzzy) | `athlete_facts.value_text WHERE fact_key='alias'` | `athlete_facts_alias_trgm_idx` (0046, partial) | yes; queries must carry the `fact_key='alias'` predicate |
| name fact (fuzzy) | `athlete_facts.value_text WHERE fact_key='name'` | new partial trgm index | **0048** (cheap; the name fact is the athlete-asserted name once Step 3 writes it) |
| handle (exact) | `lower(social_identities.handle)` with `platform`, `WHERE status='active'` | new btree | **0048** (today a sequential scan) |
| entered handle (exact) | `athletes.socials ->> platform` | expression index per platform, or none | **decision D3**: index `lower(socials->>'instagram')` and `'tiktok'` only, or rely on 25-row scale until 2d |
| email (exact, server-side only) | `lower(athletes.email)` | new btree | **0048** (the signup email claim scans today; the index never exposes email) |
| auth id (exact) | `athletes.auth_id` | new **partial unique** `WHERE auth_id IS NOT NULL` | **0048 after a pre-flight collision report** (brand pattern); the one hard constraint 2c adds |

Normalization: the query side normalizes the typed name with the same `normalizeText` the registry uses (NFD, strip marks, lower, non-alnum → space); the stored side is `full_name` raw for trigram (tolerant) and `value_text` normalized for facts. Exact-equality checks (duplicate prevention) compare `normalizeText(full_name)` in SQL via `lower(regexp_replace(...))`, which matches the JS normalizer for ASCII; accented names are a known gap resolved by `unaccent` if the extension is available on Cloud SQL (D5) — verified on dev before the implementation PR, never assumed.

`IdentityHints` for research gain a real `aliases` (from alias facts) and `hometown` (from the hometown fact) instead of `[]` / `null`; `search_hints` stays a persisted copy of what was used.

## 4. Matching and claiming are two different questions

The index answers **"which athlete record is this probably?"** (§4.1–4.3). A link between a signed-in user and an athlete row answers **"has this user proven they may act as that athlete?"** (§4.4). They are modelled independently: the match engine produces a tier, the claim engine produces a proof, and `linkUserToAthlete()` executes only when the proof is sufficient (§4.5). **Public identity evidence — name, aliases, sport, team, class year, a typed public handle — never authorizes a claim, whatever the match score** (ADR-015: a person who can read a roster must not be able to become the athlete on it).

### 4.1 Query

```
findCandidates(q: { name, sport?, teamOrSchool?, classYear?, handles?: {platform: handle}, email? (server-side only) }, opts: { limit = 5 })
```
One SQL statement over `athlete_index_v` plus the match-key tables, returning the top `limit` rows with per-signal scores, the tier, and any exact-identifier ambiguity. `email` is accepted only from the server-side creation paths and is never returned; the public endpoint schema rejects it.

### 4.2 Match signals and weights (policy `identity_policy v0.1-alpha`, reviewed values)

| Signal | Score | Notes |
|---|---|---|
| `nameSim` | max trigram similarity over `full_name`, name fact, aliases | 0–1; below `nameFloor = 0.35` the row is not a candidate |
| `sportMatch` | 1 / 0 / null | null when either side is unknown |
| `teamMatch` | trigram similarity of the typed team/school vs the ledger org name, weighted by `affiliationKind` (said/proof 1.0, found 0.7) | null when either side is unknown |
| `yearMatch` | 1 / 0 / null | class or graduation year within ±1 |
| `handleExact` | 1 / 0 | a typed handle equals an active `social_identities` handle or an entered handle on the same platform (case-insensitive, `@` stripped). **A matching signal only**: it says nothing about who typed it |
| `emailExact` | 1 / 0, server-side only | a matching signal only; authorization is §4.4 |
| `ambiguousIdentifier` | boolean | true when an exact identifier (email or handle) maps to **more than one** athlete row — the audit shows both are legal today |

```
matchScore = clamp( 0.55·nameSim + 0.15·sport + 0.15·team + 0.05·year + 0.10·handleExact , 0, 1 )   (null signals re-normalize the weights)
corroborated = sportMatch === 1 || teamMatch ≥ 0.6 || yearMatch === 1 || handleExact === 1 || emailExact === 1
```

### 4.3 Match tiers (which athlete?) — no authorization implied

| Tier | Condition |
|---|---|
| **auto_match** | `!ambiguousIdentifier` and claimability `open` and either (a) a **unique** exact identifier (`emailExact` or `handleExact` mapping to exactly one row), or (b) `matchScore ≥ 0.90` **and** `corroborated` (**minimum-evidence rule**: re-normalized name similarity alone never reaches this tier, however high) **and** the runner-up is at least `gap = 0.15` lower |
| **candidate** | `0.60 ≤ matchScore < 0.90`; or ≥ 0.90 without corroboration or without the gap; or `ambiguousIdentifier`; or the best row is claimability `review` / `none` |
| **new** | every candidate below 0.60 |

A tie on a golden anchor or a `review` row is always `candidate`; a `hasUser = true` row is never `auto_match` (two users may relate to one athlete later, never by silent linking).

### 4.4 Claim proof (may this user link?)

```
claimProof = "existing_auth" | "verified_unique_email" | "verified_social_ownership" | "human_confirmation" | "none"
```

| Proof | Definition | Available in 2c |
|---|---|---|
| `existing_auth` | the athlete row's `auth_id` already equals the caller's uid | yes (today's stage 1) |
| `verified_unique_email` | the identity provider marks the caller's email **verified** (Firebase `email_verified = true`; Microsoft equivalent) **and** `lower(email)` matches **exactly one** athlete row with `auth_id IS NULL` | yes (today's stage 2 tightened: an unverified or non-unique email no longer links) |
| `verified_social_ownership` | the caller completed an OAuth connection whose platform account id equals an active `social_identities.account_id` of the candidate row (proof of owning that account, not of knowing its handle) | recognised and recorded; the **link** it would justify is a merge of two athlete rows (the caller already has one), which is Step 3 |
| `human_confirmation` | the athlete confirmed "Is this you?" | Step 3 |
| `none` | everything else, including any match tier on its own | — |

Stored `source_class` (`connected_verified`, `platform_public`, …) describes the authority of the **record's** identity, not the claimant, and is never a claim proof.

### 4.5 Decision matrix (2c, before the Step 3 UI)

| Match tier | Claim proof | Action |
|---|---|---|
| any | `existing_auth` | return the existing row (no change) |
| any | `verified_unique_email` | **link** (`linkUserToAthlete`), record `linked_by_verified_email` |
| `auto_match` (unique identifier or corroborated score) | `none` | **no link**: create the new row, record `possible_duplicate` with the candidates; the operator sees it; Step 3 confirms |
| `candidate` | `none` | create + record `possible_duplicate` |
| `new` | `none` | create, record `new` |
| any | `verified_social_ownership` (from the connect callback, after creation) | record `possible_duplicate` with `claim_proof = verified_social_ownership`; merge is Step 3 |

So in 2c the only paths that bind a user to an existing athlete are the two that prove something about the *user*: existing auth and a unique verified email. Everything the index infers from public evidence is recorded, never enacted.

### 4.6 Claimability (O8), fully derivable from existing columns

| Value | Rule (SQL over existing columns) | Effect |
|---|---|---|
| `open` | `auth_id IS NULL AND NOT is_golden_anchor AND (email IS NOT NULL OR status = 'waitlisted')` | may reach `auto_match`; shown as a candidate |
| `review` | `auth_id IS NULL AND NOT is_golden_anchor AND email IS NULL AND status <> 'waitlisted'` (the discovery/import rows) | never `auto_match`; shown as "unverified"; a claim needs Step 3 confirmation plus an operator |
| `none` | `is_golden_anchor OR auth_id IS NOT NULL` | never a claim target; still an index member |

No `origin` column is added; if Step 3 needs provenance of the row itself, it adds it then (D4 resolved).

## 5. Duplicate prevention

1. **Ask the index before every insert.** Signup (A, B) and waitlist (C) call `findCandidates` with the typed name, sport, school, handles and (server-side) email before `insert(athletes)`. The three-stage lookup becomes: `auth_id` exact (`existing_auth`) → **unique verified email** (`verified_unique_email`) → index tiers for telemetry and the candidate list (§4.5). The substring `ilike … LIMIT 1` is deleted when the flag is on; an unverified email or an email shared by two rows no longer links anyone.
2. **Record every decision.** New table `athlete_index_matches` (telemetry, not state): `{ id, at, path (signup|waitlist|admin|api|connect), query (sanitized hints: name, sport, team, year, handles — never email), candidates jsonb [{athleteId, matchScore, signals, tier, claimability}], tier, claim_proof, decision (linked_by_auth|linked_by_verified_email|possible_duplicate|new), chosen_athlete_id, created_athlete_id, policy_version }`. It is the source for the duplicate report and, in Step 3, the "Is this you?" list (same ranking, same telemetry).
3. **Duplicate report.** `server/scripts/athleteIndexReport.ts --duplicates`: pairs of index rows with `nameSim ≥ 0.8` and compatible sport/team, every `possible_duplicate` decision, and every exact identifier that maps to more than one row (the ambiguity the tiers refuse to resolve); dry-run only. No merge tool in 2c (a merge moves deals, connections, media; Step 3 with the user table).
4. **One hard constraint, part of closure:** `athletes_auth_id_uq` partial unique on `auth_id WHERE auth_id IS NOT NULL`, added after the pre-flight report shows zero collisions on dev and prod (§10). Email stays non-unique (shared family addresses are legitimate) — which is exactly why an email links only when unique and verified; name stays non-unique (the index handles it).
5. **Golden anchors and discovery rows** leave the auto-match set (§4.6).

## 6. Current → target migration map

| Path | Today | 2c (flag `ATHLETE_INDEX_CLAIM`, off in both YAMLs) | Later |
|---|---|---|---|
| signup stage 2 (email) | `lower(email)` + `auth_id IS NULL` → link, unverified | flag off: byte-for-byte; flag on: links only as `verified_unique_email` (provider-verified **and** exactly one row) | |
| signup stage 3 | `ilike '%name%' LIMIT 1` → silent link | flag off: byte-for-byte; flag on: `findCandidates` for the tier and telemetry; **no link without claim proof** — create + record `possible_duplicate`; `claimed_at` is written only by `linkUserToAthlete` (verified email now, confirmation in Step 3) | Step 3: candidate UI, `human_confirmation` |
| Microsoft signup | no lookup | flag on: same stages (verified email per the provider's claim) | |
| waitlist insert | `auth_id` only | flag on: index query, `waitlisted` claimable | |
| admin waitlist list | status only | `?q=` search over the index (read-only, admin-only, always on: no mutation) | |
| `POST /api/v1/index/candidates` | — | new, guarded by `requireFirebaseUser` (token verified, **no athlete linkage required**, §9.2), rate-limited per uid, returns view columns only; dark in 2c (Step 3's UI) — exercised by tests and the admin search | Step 3 |
| `nickname` assertion | dropped | `assertionsFor` maps it to an `alias{kind:'nickname'}` fact (writes only when the substrate flag is on) | |
| `hintsFor.aliases / hometown` | `[]` / `null` | from current alias / hometown facts | |
| `social_identities` handle lookup | seq scan | btree on `(platform, lower(handle)) WHERE status='active'` | |
| `claimed_at` | dead | written only by `linkUserToAthlete` (verified unique email in 2c; human confirmation in Step 3); `hasIdentitySignal` unchanged (`auth_id OR connection`) | |
| golden anchors in claim set | yes (D9) | `claimability = none` | |
| dead columns C24 (`athletes_current.brand_stories`, `.insights`) | present | **separate cleanup PR (2c-2)** after a reader grep, per the Step 2 design; not in the index PR | |
| 2b planner E1 identity signal | `auth_id OR connection` | unchanged; a proven link sets `auth_id` so the planner sees it next night; a match tier alone changes nothing | Step 3 adds "high-confidence resolver match" |

## 7. Index freshness vs research freshness

The index has **no freshness of its own**. It is a view: `researchStatus`, `identityConfidence`, `disputedDomains`, `lastResearchedAt`, `nextDueAt` are read from `athlete_research_state` at query time, exactly as the planner reads them; team from the ledger; handles from `social_identities`. `indexUpdatedAt` is the greatest source timestamp, for display and for the admin search only. Nothing is materialized in 2c: the roster is 25 on dev and the gate is a latency measurement (§9); if the index ever needs materialization, it becomes a refresh-on-write projection with the same columns, never a second research state. A candidate with `research_status = seed_only` and no identity signal is labelled "unverified" (approved §8).

## 8. The User ≠ Athlete boundary (ADR-015)

- The view carries **no auth columns**. `hasUser` is a boolean derived from `auth_id IS NOT NULL`; when Step 3 introduces the user table, the view derives it from a membership row and every reader of the index is unchanged.
- `findCandidates` accepts `email`/`auth_id` keys only from the server-side creation paths; the public endpoint schema rejects them.
- **Matching is not authorization.** The index and its tiers describe the athlete record; `claimProof` describes what the user has proven. `linkUserToAthlete` refuses (throws) unless the proof is `existing_auth`, `verified_unique_email` or, in Step 3, `human_confirmation`; a `verified_social_ownership` proof leads to a Step 3 merge, never a 2c link.
- The candidates endpoint runs before any user↔athlete link exists, so its guard verifies the identity-provider token only (`requireFirebaseUser` → `req.authUid`, `req.authEmail`, `req.authEmailVerified`) and never requires `req.athleteId`.
- A proven link binds a **user** to an **athlete** by writing the row's `auth_id` today because that is where the link lives (documented debt); the write is isolated in one function, `linkUserToAthlete(athleteId, uid, provider, proof)`, so Step 3 replaces its body with a membership insert.
- `athlete_index_matches` records `chosenAthleteId`, never the uid; the uid stays in the auth log.
- No organization or tenant column anywhere (ADR-016).

## 9. Schema and code changes actually required

### 9.1 Migration `0048_athlete_index.sql` (additive, IF NOT EXISTS / CREATE OR REPLACE)
```sql
CREATE OR REPLACE VIEW athlete_index_v AS … ;                                             -- §2, one SELECT with LEFT JOINs and LATERAL subselects
CREATE INDEX IF NOT EXISTS athlete_facts_name_trgm_idx ON athlete_facts USING gin (value_text gin_trgm_ops) WHERE fact_key = 'name';
CREATE INDEX IF NOT EXISTS social_identities_handle_idx ON social_identities (platform, lower(handle)) WHERE status = 'active' AND handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS athletes_email_lower_idx ON athletes (lower(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS athlete_index_matches ( id uuid PK, at timestamptz, path text, query jsonb, candidates jsonb, tier text, claim_proof text, decision text, chosen_athlete_id uuid NULL REFERENCES athletes ON DELETE SET NULL, created_athlete_id uuid NULL REFERENCES athletes ON DELETE SET NULL, policy_version text, CHECK (tier IN ('auto_match','candidate','new')), CHECK (claim_proof IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation','none')), CHECK (decision IN ('linked_by_auth','linked_by_verified_email','possible_duplicate','new')) );
CREATE INDEX IF NOT EXISTS athlete_index_matches_at_idx ON athlete_index_matches (at DESC);
-- athletes_auth_id_uq is a SEPARATE tiny PR (0049) applied after scripts/checkAthleteAuthCollisions.ts reports zero collisions on dev and prod; it is part of Step 2c CLOSURE (§10)
```
No column on `athletes` changes. `shared/schema.ts` gains the `athlete_index_matches` table and a typed `AthleteIndexRecord`; the view is read through `db.execute(sql)` with a runtime column check (§9.3) because the drift gate does not see views.

### 9.2 Code
| File | Change |
|---|---|
| `server/services/intelligence/identity/index.ts` | `findCandidates(q, opts)`: the SQL, the scoring (§4.2), the tiers incl. the minimum-evidence rule and identifier uniqueness (§4.3), the claimability rule (§4.6); pure scoring helpers exported for tests; no provider imports (boundary test) |
| `server/services/intelligence/identity/claim.ts` | `claimProofFor(caller, candidate)` (§4.4: existing auth, verified unique email, verified social ownership) and `decide(tier, proof)` (§4.5 matrix); pure |
| `server/services/intelligence/identity/policy.ts`, `config.ts`, `types.ts` | `identity_policy` family (weights, floors, thresholds, gap, claimability rules) with code defaults; `athleteIndexClaimEnabled()` flag |
| `server/services/intelligence/identity/link.ts` | `linkUserToAthlete(athleteId, uid, provider, proof)`: the one writer of `auth_id` + `status='claimed'` + `claimed_at`; **throws unless `proof` is sufficient**; `recordMatch(...)` |
| `server/lib/auth.ts` | additive pre-link guard (`requireFirebaseUser`, or provider-neutral `requireIdentityUser` if Microsoft has a distinct token path): verifies the identity-provider token and sets `req.authUid`, `req.authEmail`, `req.authEmailVerified`; does **not** look up an athlete row or set `req.athleteId` (the caller may not be linked yet) |
| `server/routes/index.ts` | `POST /api/v1/index/candidates` (`requireFirebaseUser`, rate limit per uid as the streaming routes, public columns only, no email/auth keys) |
| `server/routes/auth.ts`, `routes/waitlist.ts` | flag on: stage 2 requires `email_verified` and uniqueness; stage 3 → `findCandidates` + `decide` (create + record unless a claim proof exists); flag off: byte-for-byte today |
| `server/routes/oauthCallback.ts` | after a connection: if the connected account id is an active identity of a *different* athlete row, record `possible_duplicate` with `claim_proof = verified_social_ownership` (no link, no merge) |
| `server/routes/admin.ts` | `?q=` on the waitlist list via the index (always on; read-only) |
| `server/skills/researchDualWrite.ts` | `assertionsFor` maps `nickname` → `alias`; `hintsFor` fills `aliases` and `hometown` from current facts |
| `server/scripts/athleteIndexReport.ts`, `scripts/checkAthleteAuthCollisions.ts` | duplicate report; auth-id collision pre-flight |
| `server/scripts/seedModelParams.ts` | `identity_policy v0.1-alpha` draft |
| `gcp/cloud-run-{dev,prod}.yaml` | `ATHLETE_INDEX_CLAIM: "false"` |
| `scripts/db-migrate.sh` | 0048 |
| docs | `step2c-athlete-index.md` build record |

### 9.3 Gates
| Gate | Criterion |
|---|---|
| G1 tests (PGlite) | scoring: name/alias/handle/email signals, null re-normalization, tiers, the runner-up gap, **the minimum-evidence rule (a sparse name-only record at nameSim 0.97 is `candidate`, never `auto_match`; two same-name athletes in the same sport are `candidate`; the same handle on two rows sets `ambiguousIdentifier` and forces `candidate`)**, claimability for anchors / discovery / has-user / waitlisted rows; `findCandidates` on a synthetic roster of 30 names incl. near-duplicates, accents, nicknames, same-name-different-sport; **claim proof: a typed public handle never links; an unverified email never links; an email shared by two rows never links; a verified unique email links and writes `claimed_at`; `linkUserToAthlete` throws on `none`; an `auto_match` tier with proof `none` creates + records `possible_duplicate`**; signup flag off byte-for-byte (mocked request); golden anchor never linked; endpoint accepts a token without an athlete row, rejects `email`/`auth_id` keys, returns only view columns; `nickname` → alias fact; boundary test green |
| G2 migration | 0048 dry run (BEGIN … ROLLBACK) on dev: view + 3 indexes + table; nothing after rollback; the auth-id pre-flight reports collisions on dev and prod before any unique index is proposed |
| G3 view shape | a runtime check at boot and in tests: the view's column set equals `AthleteIndexRecord` keys (the drift gate cannot see it) |
| G4 latency | `findCandidates` p95 on dev under 50 ms for the 25-row roster and under 200 ms on a synthetic 10k-row copy (EXPLAIN shows the trigram and handle indexes used) |
| G5 no spend | zero provider calls anywhere in 2c code (mocked adapters assert; no provider import) |
| G6 legacy | flag off in both envs: signup, waitlist, admin promote unchanged byte-for-byte; the admin `?q=` is additive |
| G7 duplicates | the report on dev lists the known cases (golden anchors, discovery rows, any same-name pairs) with the tier each would fall in |

## 10. Rollout
| # | Step | Flags after |
|---|---|---|
| 0 | this design PR → review | — |
| 1 | implementation PR (0048 without the unique index; view; service; endpoint; admin search; hints/alias; flag off; tests) → code review | `ATHLETE_INDEX_CLAIM=false` |
| 2 | merge → deploy applies 0048; verify view, indexes, table; drift clean; latency measured; duplicate report run on dev | unchanged |
| 3 | auth-id collision pre-flight on dev and prod → separate tiny PR (0049) adding `athletes_auth_id_uq`. **Part of closure: Step 2c is not CLOSED until this index has landed or a recorded decision not to add it is taken** | unchanged |
| 4 | flip `ATHLETE_INDEX_CLAIM=true` on dev by a one-line PR (user's word); a test signup with a near-duplicate name records `possible_duplicate` instead of a silent link; a verified-email signup links | dev true |
| — | prod: nothing in 2c | |

## 11. Risks and open decisions
| # | Decision / risk | Recommendation |
|---|---|---|
| D1 | Candidate-tier behaviour before the Step 3 UI exists: create the row and record `possible_duplicate` (proposed), or refuse signup until confirmed | Create + record; never block a signup on a UI that does not exist |
| D2 | Thresholds (0.90 auto, 0.60 candidate, gap 0.15, name floor 0.35) and weights | Initial guardrails as policy values; tuned from `athlete_index_matches` after two weeks on dev |
| D3 | Index the entered handles in `athletes.socials` | Two expression indexes (instagram, tiktok) or none at this scale; recommend none until the duplicate report shows handle-only matches matter |
| D4 | Claimability without an origin column | **Resolved:** fully derivable (§4.6: `open` = no auth, not anchor, has email or `waitlisted`; `review` = no auth, no email, not waitlisted, not anchor; `none` = anchor or has user); `origin` deferred to Step 3 |
| D5 | Accent handling: `unaccent` on Cloud SQL | Verify on dev; if present, normalize both sides in SQL; if not, rely on trigram tolerance and the JS-side normalization |
| D6 | `athletes_auth_id_uq` | **Resolved:** a separate tiny PR after the pre-flight, and part of Step 2c closure (not optional) |
| D8 | `verified_social_ownership` in 2c: record only (a link would be a merge of two rows) | Record with the proof; merge in Step 3 |
| D9 | Identity providers' "email verified" semantics (Firebase `email_verified`; Microsoft Graph) | Treat an absent or false flag as unverified; document per provider in the implementation |
| D7 | Admin `?q=` search always on vs behind the flag | Always on: read-only, admin-only, no mutation |
| R1 | The view's first-in-system status: no drift coverage | G3 runtime shape check; `CREATE OR REPLACE` re-runs safely |
| R2 | Same-name athletes in the same sport (common names) | never `auto_match` without corroboration and the gap, and never a link without proof; the candidate tier records them |
| R4 | A user supplies another athlete's public identity (name, sport, team, handle) to claim her profile | impossible by construction: public evidence never authorizes; only existing auth, a unique verified email, or (Step 3) confirmation / ownership proof link |
| R3 | A user with two devices/emails creating two rows | email exact + index tiers; the report catches the rest until Step 3's merge |
