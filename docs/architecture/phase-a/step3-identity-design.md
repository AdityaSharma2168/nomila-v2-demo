# Phase A · Step 3 — Identity (DESIGN, no code)

**Status:** DRAFT, directionally approved (11 Sep 2026) — revised per design review round 1 (four corrections + one auth rule, below). Nothing in this document is implemented; no flag, reader, migration or production change accompanies it.

## Revision log (review round 1)

| Correction | Where it landed |
|---|---|
| Connected-account collision: global uniqueness for an active `connected_verified (platform, account_id)`; a proven collision records the proof and opens the claim/duplicate lifecycle but never creates a second active canonical ownership identity | §3.6, §4.1, §7, D-4, D-13 |
| Human confirmation: selecting an index candidate is not sufficient to take control of a pre-existing profile; confirmation establishes self-membership only on a profile the user creates; an existing indexed athlete needs corroborating proof or operator approval | §4.1, §4.3, §5, D-4, D-14 |
| D-10: the `hasAssertedAffiliations` bug is fixed with its resolver test at the research/assertion-resolution boundary, not moved into Identity; Identity owns membership, claims, verification/ownership, duplicates, merges — not athlete-authored facts | §3.8, §9 #5/#19, D-10 |
| Assertions vs facts: `athlete_asserted` stays separate from `athlete_facts`; no new `SourceClass`; canonical reads resolve an assertion into the displayed `Fact<T>`; compatibility projections mirror it; Step 3 never converts assertions into researched fact rows | §3.7, §4.2, §9 #11, D-5 |
| Auth rule: `requireAuth` auto-selects an athlete only when exactly one active membership exists; with more than one it requires an explicit/session-selected athlete; never the first row | §3.2, §8, D-2 |
**Spec:** Blueprint V1 / Commercial Intelligence Beta.1 §2 (Identity: cheap lookup → show the likely profile → athlete confirms → research once; ambiguity returned explicitly, never forced), §4 (onboarding order), §28.9 (source authority). ADR-015 (user ≠ athlete, LOCKED), ADR-016 (affiliation ≠ access, LOCKED). Step 2c design (Athlete Index, match tiers, claim proofs — preserved verbatim), Step 2d (canonical context, closed on dev).
**Starting point:** Step 2d CLOSED ON DEV: the canonical context and its views, the Athlete Index (`athlete_index_v`, `findCandidates`, `athlete_index_matches`), the research substrate (facts / evidence / inferences / research state), `social_identities` (Step 1a), `athlete_asserted`, the ledger (`athlete_affiliations`), and the 2c claim matrix.

## What the athlete experiences, and what happens underneath

Today a person signs in and Nomila decides who they are by three lookups in a row: the login id, then an email, then a name that *contains* what they typed — and the first row it finds becomes theirs, silently, with no confirmation and no record of the alternatives. Two people with similar names can end up on one row; one person can end up on two. The login account *is* the athlete row (`athletes.auth_id`), so a parent, an agent or a second device has no place to exist, and a researched Instagram handle looks the same to the app as one the athlete connected herself.

After Step 3 the athlete signs in, is shown the profile Nomila thinks is hers (or told plainly that it could be one of two), confirms it, and only then does research run. Her login is a **user**; her profile is an **athlete**; the link between them is a **membership** that records *how* it was proven (her existing login, a verified email that matches exactly one profile, an account she connected, or her own confirmation). What Nomila found about her stays labelled as found; what she typed stays labelled as hers; what she connected is the only thing that counts as ownership. When two profiles turn out to be the same person, an operator merges them with every fact, deal, message and score moved and a reversible record of where each came from — never by deleting history. And nothing about identity changes her marketability score: connecting an account makes Nomila *more accurate*, not her *more valuable*.

Underneath: one identity module owns the user, the membership, the claim decision, the duplicate lifecycle and the merge; every other module keeps `athlete_id` as its owner and never learns about users. The 2c rule stays the spine: **matching evidence ≠ claim authorization ≠ canonical fact authority ≠ connected-account ownership proof.**

## 1. Current state (audit, 11 Sep 2026)

### 1.1 The objects that carry identity today

| Object | Where | What it is today | Problem |
|---|---|---|---|
| `athletes` | `shared/schema.ts` | domain entity AND the user table: `auth_id` (Firebase / Microsoft uid, partial unique since 0049), `auth_provider`, `email`, `plan`, `stripe_customer_id`, `claimed_at`, `status ∈ waitlisted\|raw\|enriched\|claimed\|active`, `socials` (typed handles), `full_name/first_name/last_name` | one row = one login (ADR-015 debt); `status` conflates *research state* (raw/enriched), *claim state* (claimed) and *operator activation* (active, waitlisted); `claimed_at` written only by `linkUserToAthlete` |
| `account_roles` | `(account_id → athletes.id, role ∈ athlete\|fan\|brand\|school_admin\|admin)` | the only "user type" record, keyed by the athlete row | a role on a *profile*, not on a *person*; `requireAdmin` reads it through the athlete row |
| `requireAuth` | `server/lib/auth.ts:70` | token → `athletes.auth_id` → `req.athleteId`; **48 server files** consume `req.athleteId` | the user == athlete assumption, everywhere; a second user on the same athlete, or one user on two athletes, is impossible |
| `requireFirebaseUser` | `server/lib/auth.ts:51` | token → `req.authUid/authEmail/authEmailVerified`, no athlete lookup (2c) | correct pre-link guard; only the dark candidates endpoint uses it |
| `connected_accounts` | OAuth rows: `platform`, `platform_user_id`, `platform_username`, tokens, `status ∈ pending\|active\|expired\|revoked` | the ownership proof event | **no cross-athlete check**: the same `platform_user_id` can be active on two athlete rows (`connections.ts` deletes only *this* athlete's pending rows; the callbacks insert/update by `athlete_id` only); no record of *which user* connected it |
| `social_identities` | Step 1a: `(athlete_id, platform, account_id)` unique, `handle`, `handle_history`, `source_class`, `confidence`, `status ∈ active\|superseded\|unverified\|rejected`, `connected_account_id`, `evidence` | the durable per-account identity with authority | uniqueness is **per athlete**: a `platform_public` identity for the same account can exist on two athletes (the index treats that as an ambiguous identifier — correct — but nothing records or resolves it) |
| `athletes.socials` (typed handles) | landing page / waitlist merge (`||`), `seedGoldenAnchors` | the athlete's own entry | a jsonb column, no provenance, no history; the context labels it origin `entered` (not a `SourceClass`, per instruction) |
| `athlete_asserted` | `field ∈ ASSERTED_FIELDS` (nickname, position, hometown, teams, career, goals, voice…), `said`, `source ∈ onboarding\|chat\|voice\|settings`, `mode` | the athlete's word, with receipts (`agent_actions`) | identity fields (`nickname`) are never projected to a fact; typed handles are not assertions |
| `athlete_facts` / `research_evidence` | 2a: `name`, `alias`, `sport`, `hometown`, `nationality` keys; evidence kinds incl. `identity_signal`, `social_handle`; `athlete_research_state.identity_confidence / identity_resolved_at` | canonical research identity signals | `identityResolved` is derived from `claimed_at OR auth_id` (`researchDualWrite.ts:94`) — i.e. from the *login*, not from a confirmed identity |
| `athlete_index_v` / `findCandidates` / `athlete_index_matches` | 2c | who is this probably (tiers), what was decided (telemetry) | the "Is this you?" step the telemetry was designed for does not exist; `possible_duplicate` decisions accumulate with no lifecycle |
| `golden_athletes` | `athlete_id` unique, `active` | anchors never claimable | fine |
| `athlete_affiliations` | 2d: said / found / proof rows, `asserted_id`, `fact_id` | canonical teams | a strong *matching* signal (team + season) — never an identity proof |

### 1.2 The paths that decide identity today (hidden logic)

| Path | Where | What it does | Verdict |
|---|---|---|---|
| A · app signup, flag off (live) | `routes/auth.ts:83-215` | (1) `auth_id = uid` → existing; (2) `lower(email)` with `auth_id IS NULL` → **attach uid without checking the provider's `email_verified`** and without uniqueness; (3) `ilike '%name%'` (+sport) `LIMIT 1` → set `auth_id`, `status='claimed'`, overwrite `email` — **silent link on a substring of a name** | (2) and (3) are the two ways two people become one row; both **REPLACE** (the flag-on path already does) |
| A′ · app signup, flag on (dark) | `routes/auth.ts:105-128` | `resolveIdentity` → link only on `existing_auth` / `verified_unique_email`; else create + record `possible_duplicate` / `new` | **KEEP** as the 3b base; needs the confirmation step |
| B · Microsoft | `routes/auth.ts:340-380` | as A/A′ with `emailVerified = !!msProfile.mail` (presence, not verification) | **MODIFY**: Microsoft `mail` presence is not verification; treat as `emailVerified=false` unless the tenant asserts it (D-6) |
| C · waitlist steps | `routes/waitlist.ts:200-260` | `resolveIdentity` (flag on) then `UPDATE … coalesce(...)`, `socials ||` on the resolved/found row keyed by the caller's uid | **KEEP**; the upsert writes the athlete's own entry — after 3a it also records the typed handles as assertions |
| D · connect (OAuth) | `routes/connections.ts`, `lib/integrations/*.ts`, `routes/oauthCallback.ts` | pending row for `req.athleteId` → callback flips it active with `platform_user_id` | **MODIFY**: record the connecting user; detect the same platform account active on another athlete (`verified_social_ownership` ⇒ duplicate candidate, 2c §4.5) |
| E · admin promote / waitlist activation | `routes/admin.ts` | operator flips `status`; reads connections to "eyeball identity" | **KEEP**; gets the duplicate queue and the merge tool (3c) |
| F · onboarding v2 `greet` | `workflow/definitions/onboarding.ts`, `mila/onboarding.ts` | confirms *what research found* after research ran (silence = confirmation) | **MODIFY** (3b): identity confirmation moves *before* research (Beta.1 §2 order); the greet step keeps confirming facts |
| G · account deletion | `routes/account.ts:47-90` | deletes 15 tables' rows by `athlete_id` in one transaction, then the athlete | **MODIFY** (3c): a user deleting their *login* is not the same as deleting the *athlete*; the deletion becomes membership-aware |
| H · research identity | `researchDualWrite.ts:94`, `persist.ts:253`, planner `loadPlannerInput` (`hasIdentitySignal = claimed OR auth OR connected`) | identity "resolved" = has a login or a connection | **MODIFY** (3a): read the membership / verification state through the identity module (`identityStateFor`), same booleans, one source |
| I · `/auth/me`, `get_profile`, voice profile, chat v1, dealDraft, scoreDeal, admin (2d-3) | identity view | already behind the context boundary | **KEEP**; `/auth/me` adds the user + memberships block (3a) |
| J · client `auth-context` | `client/lib/auth-context.tsx` | `/auth/me` ⇒ `{ id (athlete), role, school … }`; the app has one athlete per session | **MODIFY** (3b): the session carries the user and the *active* athlete; the "Is this you?" screen |
| K · legacy social adapters `adapters/legacy.ts:164-213` | account id → connection → unique handle → unknown, within one athlete | correct within an athlete; no cross-athlete resolution | **KEEP** (the cross-athlete question is the index's, not the adapter's) |

### 1.3 Duplicates and merges today
No `merged_into`, no duplicate lifecycle, no merge tool. `athlete_index_matches` records `possible_duplicate` decisions (dark). `scripts/athleteIndexReport.ts --duplicates` reports pairs (dry-run). `scripts/fixDuplicateAthleteRow.ts` handles exactly one case (two rows, one uid, no dependants) by deletion after an inventory. **45 tables** carry a FK to `athletes.id` (`account_roles, agent_actions, athlete_affiliations, athlete_asserted, athlete_facts, athlete_index_matches, athlete_inferences, athlete_research_state, athlete_snapshots, athletes_current, brand_fit_narratives, card_overrides, card_shares, chat_messages, connect_accounts, connected_accounts, conversations, deals, generation_jobs, gmail_dead_letters, golden_athletes, inbox_messages, inbox_senders, inbox_threads, media_assets, media_backfill_state, media_kits, notification_log, onboarding_sessions, payments, pending_actions, raw_source_payloads, research_evidence, research_runs, research_source_payloads, social_analytics_snapshots, social_audience_distributions, social_features, social_identities, social_metric_observations, social_sync_runs, studio_generation_previews, tasks, voice_context`) — a merge is a 45-table operation and must be generated from the schema, never hand-listed.

### 1.4 What is already right (and stays)
The 2c separation (`matchTier` ⟂ `claimProof`), `linkUserToAthlete`'s atomic conditional write and its refusal without a linking proof, `requireFirebaseUser`, the index's identifier-uniqueness rule (an identifier on two rows ⇒ `candidate`, never `auto_match`), `social_identities` authority ranking and `handle_history`, the assertion/receipt model, the source-class vocabulary. None of these change.

## 2. Target Identity architecture

```
Athlete Index (view) · research identity signals (facts/evidence) · social_identities · assertions
                                   │  matching evidence only
                                   ▼
                       ┌─────────────────────────┐
                       │      IDENTITY MODULE     │  server/services/intelligence/identity/
                       │  users · memberships     │  (2c files + 3a/3b/3c additions)
                       │  claims · verification   │
                       │  duplicates · merges     │
                       └─────────────────────────┘
      writes ONLY: users, athlete_users, identity_claims, athlete_duplicates, athlete_merges,
                   athletes.merged_into, connected_accounts.connected_by_user_id, social_identities.status
                                   │
                                   ▼
        athlete_id (unchanged owner of every intelligence, commercial and media record)
                                   │
                                   ▼
        Canonical context · Marketability (Step 4) · Commercial · Strategy · Mila  — never see a user
```

Boundaries (all preserved):
- **Matching evidence** (name, sport, team, class year, a typed public handle, a researched handle, an index score) ranks candidates. It never links, never merges, never becomes a fact because it matched.
- **Claim authorization** (`claimProof`) is what a *user* has proven about a *candidate*: unchanged 2c vocabulary. Only a claim proof writes a membership.
- **Canonical fact authority** (`origin` + `sourceClass` + tier, 2a resolver) decides what the profile *says*. A membership does not change any fact's authority; an assertion does (already, via origin `athlete_asserted`).
- **Ownership proof** (a completed OAuth connection, `connected_verified`) proves control of *that account* by *the connecting user*. It becomes proof that the *athlete* owns the account only through the connecting user's membership (self, or later an authorized representative).

## 3. Canonical contracts and data model

Only four new tables and three columns. Everything else is existing.

### 3.1 `users` (new, 0051) — the authenticated person
```
users { id uuid PK, provider text, provider_uid text, email text NULL, email_verified boolean, display_name text NULL,
        created_at, last_seen_at, disabled_at NULL }
UNIQUE (provider, provider_uid)
```
Backfilled from every distinct `athletes.auth_id` (+ `auth_provider`, `email`). `plan` / `stripe_customer_id` stay on `athletes` in Step 3 (billing follows the athlete's product today; moving it is a billing decision, not identity — D-9).

### 3.2 `athlete_users` (new, 0051) — the membership (User ↔ Athlete)
```
athlete_users { id uuid PK, athlete_id → athletes, user_id → users, relation text ∈ ('self'),   -- 'agent' | 'parent' | 'org_member' reserved, not enabled (ADR-015)
                proof text ∈ claimProof \ {'none'}, claim_id → identity_claims NULL, established_at, revoked_at NULL, revoked_reason NULL }
UNIQUE (athlete_id, user_id) WHERE revoked_at IS NULL
UNIQUE (athlete_id) WHERE relation = 'self' AND revoked_at IS NULL        -- one self-member per athlete (today's auth_id uniqueness, kept)
```
`athletes.auth_id / auth_provider` become a **compatibility projection of the self-membership** (exactly the 2d projection pattern): written only by `linkUserToAthlete`, read by legacy callers until 3d, dropped in a later step. `requireAuth` resolves token → `users` → active memberships → `req.userId`, and `req.athleteId` by this rule: **exactly one active membership ⇒ auto-selected; more than one ⇒ the request must name the athlete (`X-Athlete-Id`, validated against the user's memberships) or the session must carry a selection — otherwise 409 `athlete_selection_required`; never the first row.** Zero memberships ⇒ 404 as today (the pre-link state; `requireFirebaseUser` is the guard for that stage).

### 3.3 `identity_claims` (new, 0051) — the claim lifecycle state
```
identity_claims { id, user_id → users, athlete_id → athletes, match_id → athlete_index_matches NULL, proof text (claimProof),
                  status text ∈ ('proposed','confirmed','rejected','expired','superseded'), proposed_at, decided_at NULL,
                  decided_by text ∈ ('user','operator','system') NULL, note text NULL }
```
A claim is *proposed* when the index surfaces a candidate to a signed-in user (tier `auto_match` / `candidate`) or when a connection produces `verified_social_ownership` against another row; it is *confirmed* by the user ("Is this you?") or an operator; a confirmed claim with a linking proof writes the membership. `athlete_index_matches` stays telemetry; the claim table is the state.

### 3.4 `athlete_duplicates` (new, 0052, slice 3c) — the duplicate lifecycle
```
athlete_duplicates { id, athlete_a → athletes, athlete_b → athletes (a < b), status text ∈ ('possible','evidence_gathered','verified_same','verified_distinct','unresolved','merged'),
                     evidence jsonb [{kind, detail, at, source}], opened_by text ∈ ('index','connect','operator','report'), opened_at, decided_at NULL, decided_by NULL, merge_id → athlete_merges NULL }
UNIQUE (athlete_a, athlete_b)
```
### 3.5 `athlete_merges` (new, 0052) — the reversible merge record
```
athlete_merges { id, winner_id → athletes, loser_id → athletes, duplicate_id → athlete_duplicates, performed_by, performed_at,
                 plan jsonb (per table: rows to move, conflicts and their resolution), moved jsonb (per table: [{table, row_id, from, to}]), reverted_at NULL }
athletes.merged_into uuid NULL → athletes            (new column; the loser points at the winner; status = 'merged')
```
### 3.6 Columns added to existing tables
- `connected_accounts.connected_by_user_id uuid NULL → users` — who performed the OAuth (self today; a representative later).
- `athletes.merged_into` (above).
- `social_identities`: no new column; **global ownership exclusivity**: a partial unique index `(platform, account_id) WHERE source_class = 'connected_verified' AND status = 'active'` (0051, after a pre-flight collision report — the 0049 pattern; dev today has no collision, prod has no rows). One account has one active canonical owner. A second proven control of the same account is recorded as a claim/collision (`identity_claims` with proof `verified_social_ownership`, `connected_accounts` row active for the caller), and the caller's `social_identities` row for that account is written with `status = 'unverified'` (never `active`) until the lifecycle resolves it — the index treats it as an ambiguous identifier, never as a second owner.

### 3.7 Identity assertions and typed handles — the persistence contract
No new table. The athlete's typed handles and name become **assertions** (`athlete_asserted` fields `handle_instagram | handle_tiktok | handle_youtube | handle_x`, `name`, `nickname`) with receipts. The contract:
- `athlete_asserted` **remains separate** from `athlete_facts`. Step 3 never converts an assertion into a researched fact row, and no new `SourceClass` is added (an assertion is the athlete's word, not a source class).
- **Canonical reads** resolve an assertion into the displayed `Fact<T>` contract with `origin = athlete_asserted`, `sourceClass = null`, `authorityTier = null` — exactly as the 2d builder already does for position / class year / hometown / teams (`build.ts` assertions section; the record view's `saidOr`). The context's `entered` origin label for typed handles is a display label of that resolution.
- **Compatibility projections** (`athletes.socials`, `athletes.full_name`) mirror the latest assertion, written by the assertion writer (`recordAssertions` → column projection, the existing `column:` mechanism of `ASSERTED_FIELDS`), never by research.
- A typed handle is matching evidence and a research *hint*; it never creates a `social_identities` row (that table holds evidence-backed and ownership-backed identities only). The 2a path by which an assertion may *override* a research fact for display stays in the research/assertion-resolution boundary (`resolveFacts`), unchanged.

### 3.8 Identity evidence and verification
- **Identity evidence** = the existing records: `athlete_index_matches` (telemetry), `research_evidence` (`identity_signal`, `social_handle`), `social_identities.evidence`, `athlete_duplicates.evidence`. No new evidence table.
- **Ownership verification** = `connected_accounts` (event) + `social_identities.source_class = connected_verified` with `connected_account_id` (durable). The identity module exposes `verificationStateFor(athleteId)`: `{ ownedAccounts: [{platform, accountId, verifiedAt, byUserId}], verifiedEmail: bool, selfMember: userId | null }` — the one source for research's `identityResolved`, the planner's `hasIdentitySignal` and the index's `hasUser` (all KEEP their semantics: a self-membership OR an active connected account). It says nothing about athlete-authored facts: assertion precedence over research (`hasAssertedAffiliations`, `resolveFacts`' override rules) stays in the canonical context / research / assertion-resolution boundary.

### 3.9 The canonical identity contract (read side)
```ts
interface AthleteIdentity {
  athleteId: string;
  name: Fact<{ full; first?; last? }>;                     // assertion > research > legacy row (2d contract, unchanged)
  aliases: Fact<{ text; kind }>[];
  members: Array<{ userId; relation: "self"; proof: ClaimProof; establishedAt }>;   // 3a; never exposes provider uids
  ownership: Array<{ platform; accountId; handle; verifiedAt; source: "connected_verified" }>;
  identities: HandleRecord[];                                // 2d: by authority; entered last; blob never
  claimability: "open" | "review" | "none";                  // 2c §4.6, now derived from memberships (hasUser) — same values
  duplicates: Array<{ otherAthleteId; status }>;             // open lifecycle rows only
  mergedInto: string | null;
}
```
The identity view of 2d gains `members`, `ownership`, `duplicates`, `mergedInto`; every other view is unchanged.

## 4. Authority and verification model

### 4.1 What each signal may do

| Signal | Assists matching | Establishes ownership of an account | Establishes canonical identity (a fact) | Opens a duplicate candidate | Authorizes a link | Authorizes a merge |
|---|---|---|---|---|---|---|
| athlete-typed handle (assertion) | yes (exact identifier, weight per 2c policy) | no | as an assertion of *what she calls her handle* — origin `athlete_asserted`, never `connected_verified` | when the same typed handle sits on another row (2c: ambiguous ⇒ `candidate`) | no | no |
| researched handle (`web_researched` identity / `social_handle` evidence) | yes, below typed | no | a fact/identity with tier + confidence; never ownership | when the same account id is active on another row | no | no |
| platform-discovered handle (`platform_public`) | yes | no | identity with authority above researched | same | no | no |
| OAuth-connected account (`connected_verified`) | yes (exact account id — the strongest identifier) | **yes** — for the connecting user, of *that account* | the identity becomes `connected_verified` — **only if no other athlete holds it as active `connected_verified`** (global exclusivity); otherwise the caller's identity row is `unverified` pending resolution | **yes**: the same account active on another athlete ⇒ collision recorded (`verified_social_ownership` claim against that row) and a duplicate pair (2c §4.5) | **yes**, as `verified_social_ownership` — corroborating proof for an existing indexed athlete (§5) | never alone |
| verified email (provider `email_verified`) | yes (exact) | no | no | when two unclaimed rows share it (ambiguous ⇒ `candidate`) | **yes**, `verified_unique_email` (2c, unchanged) | no |
| school / team roster evidence (`affiliation` fact, team + season) | yes (team match weight) | no | a fact (rule 7) | with name similarity (report) | no | no |
| conflicting current team/school | lowers `teamMatch`; never disqualifies | no | resolver rule 7 (the newer season wins; assertion overrides) | no | no | no |
| human confirmation ("Is this you?") | — | no | no | confirming an existing candidate WITHOUT corroboration ⇒ claim `proposed` (operator queue), not a link | **candidate confirmation** (`human_confirmation`): establishes self-membership only on a profile the user creates in that flow, or on an existing candidate **together with** a corroborating proof (`verified_unique_email`, `verified_social_ownership`, grandfathered `existing_auth`) or operator approval; selection alone never takes control of a pre-existing profile | no |
| operator decision | — | no | no | closes as `verified_same` / `verified_distinct` | operator may confirm a claim on a `review` row | **yes** — the only merge authority |
| existing self-membership (`existing_auth`) | — | — | — | — | yes (idempotent) | — |

### 4.2 Resolution rules for the named cases
- **Athlete typed Instagram handle vs researched handle:** both surface; the context ranks by authority (`connected_verified > platform_public > web_researched > entered`) — unchanged 2d. Ownership: neither.
- **OAuth-connected Instagram account:** the identity becomes `connected_verified`; a `web_researched` identity for the same account is superseded by `ensureIdentity` (already); a researched identity for a *different* account on the same platform stays `active` but is outranked — nothing is deleted (the athlete may have two accounts).
- **Verified email:** link only when unique and unclaimed (2c). If it matches a row that already has a self-member ⇒ an `identity_claims` row `proposed` with proof `none` and a duplicate pair `possible` (a second person claiming the same email is a support case, never an automatic link).
- **Two athlete records sharing a name:** never `auto_match` on a name (minimum-evidence rule, 2c); the "Is this you?" list shows both with their distinguishing facts (sport, team, year, handles); the user picks or says "neither" ⇒ `new`.
- **Renamed / transferred athlete:** a name change is an assertion (`name`) → a `name` fact (origin `athlete_asserted`) and an `alias` fact for the old name; the index matches on aliases (2c). A transfer is a ledger change (2d); the index's `teamOrSchool` follows; a stale team lowers `teamMatch` but the identifier signals (email, connected account) still decide.
- **Changed social handle:** `ensureIdentity` appends to `handle_history` on the same `account_id` (already); the index matches on current handle, `handle_history` is a matching signal in 3c (exact old-handle match = weaker exact identifier, never unique).

### 4.3 What never happens
- A match tier alone never links, never merges, never sets `claimed_at`, never writes a fact.
- A login (`existing_auth`) never merges two athlete rows: if the caller's user already has a self-membership and confirms a *different* candidate, the result is a **duplicate pair** for an operator, not a second membership and not a merge (D-3).
- A human click never merges, and never takes over a pre-existing profile on its own: `human_confirmation` is candidate confirmation — it establishes self-membership on the profile the user creates, or on an existing unclaimed candidate only with corroborating proof (`verified_unique_email` / `verified_social_ownership` / grandfathered `existing_auth`) or an operator's approval; confirming a candidate that has a self-member opens a duplicate pair.
- A second proven control of an account already owned (active `connected_verified` on another athlete) never creates a second active ownership identity: the proof is recorded, the lifecycle opens, the caller's identity row stays `unverified` until an operator or the lifecycle resolves it.
- Connection never changes marketability inputs (G9 stays byte-identical across Step 3).

## 5. Claim lifecycle (3b)

```
signed-in user (no self-membership)
   │  requireFirebaseUser
   ▼
POST /index/candidates {name, sport, team?, handles?}  ──►  tier + candidates (2c, live)        ← telemetry: athlete_index_matches
   │
   ├─ existing_auth ────────────────────────────────────────►  return the athlete (idempotent)
   ├─ verified_unique_email ─────────────────────────────────►  membership {proof: verified_unique_email}; claim confirmed by 'system'
   ├─ tier auto_match | candidate ───────────────────────────►  identity_claims {proposed} per candidate; UI "Is this you?"
   │        ├─ user confirms an OPEN candidate AND holds a corroborating proof for it
   │        │      (verified_unique_email on that row, or verified_social_ownership of one of its
   │        │       connected_verified accounts, or grandfathered existing_auth) ────────────────►  claim confirmed (user) → membership {proof: that corroborating proof; claim_id records the confirmation}
   │        ├─ user confirms an OPEN or REVIEW candidate WITHOUT corroboration ──────────────────►  claim stays proposed (operator queue); the user continues on a NEW profile she creates
   │        │      (membership {proof: human_confirmation} on the new row); operator approval later ⇒ duplicate pair verified_same ⇒ merge (3c)
   │        ├─ user confirms a row WITH a self-member ─────────►  claim rejected (system) + athlete_duplicates {possible, opened_by index}; UI: "we'll sort this out" — new row created
   │        └─ user says "none of these" ──────────────────────►  claims expired; create the new athlete; membership {proof: human_confirmation} on it; record 'new'
   └─ tier new ──────────────────────────────────────────────►  create; record 'new'
after the membership exists: onboarding runs (research once) — Beta.1 §2 order: auth → confirm name → sport → lookup → confirm → research
```
The claim matrix (2c §4.5) is **extended, not changed**:

| tier | proof | 2c decision (kept) | 3b addition |
|---|---|---|---|
| any | `existing_auth` | `linked_by_auth` | — |
| any | `verified_unique_email` | `linked_by_verified_email` | claim row `confirmed` by system |
| `auto_match` / `candidate` | `none` | create + `possible_duplicate` | **first**: propose claims and show "Is this you?"; confirmation of an existing candidate links **only with corroboration** (`verified_unique_email` / `verified_social_ownership` / `existing_auth` ⇒ `linked_by_confirmation`, new `MatchDecision`, proof = the corroborating proof) or operator approval (`linked_by_operator`); without it the claim stays `proposed` and the user proceeds on a new profile (`human_confirmation` proof on the NEW row) |
| any | `verified_social_ownership` (from connect) | recorded, no link | 3b: corroborating proof — links to the other row when it has **no** self-member (`linked_by_ownership`) and the caller confirms it; the account's active `connected_verified` identity stays where it is until the link/merge resolves (never two active owners); 3c: with a self-member ⇒ duplicate pair |
| `new` | `none` | `new` | unchanged |

Rules: `human_confirmation` alone establishes self-membership only on a profile created in the same flow (a new row cannot be anyone else's); taking control of a pre-existing indexed athlete always needs corroboration or an operator. A proposed claim expires after the session (or 7 days); a rejected claim on a pair blocks re-proposal of the same pair for that user (the pair is an operator's).

## 6. Duplicate / merge lifecycle (3c)

```
possible ──(evidence: connect collision, index possible_duplicate, report, operator)──► evidence_gathered
     └────────────────────────────────────────────────────────────────────────────────► verified_distinct (operator; pair blocked from re-opening for 90 days unless new evidence)
evidence_gathered ──(operator)──► verified_same ──(operator: dry-run plan → apply)──► merged
                  └──(operator)──► unresolved (kept open, surfaces in the queue)
```
**The merge is generated, planned, reviewed, applied in one transaction, and reversible.** `planMerge(winner, loser)` enumerates every table with a FK to `athletes.id` (from `shared/schema.ts`, never a hand list — 45 today) and produces a per-table plan:

| Data | Rule |
|---|---|
| facts (`athlete_facts`) | move all rows; then re-run `resolveFacts` over the winner's current set with the assertion rules: a loser's `single` current fact that conflicts with the winner's becomes `superseded_by` the winner's (winner's assertions/proof win; research vs research ⇒ the resolver's authority/season rules); nothing deleted; provenance gains `{mergedFrom: loserId, mergeId}` |
| evidence, research runs, payloads, inferences | move (append-only history); inferences: the winner's current per key stays current, the loser's become `superseded_by` it |
| `athlete_research_state` | winner's row kept; recomputed (`recomputeState`) after the move; loser's row deleted (derived) — recorded in `moved` |
| `social_identities` | move; on `(platform, account_id)` collision keep the row with the higher authority (`connected_verified` wins), mark the other `superseded` with `evidence.merge`; `handle_history` unioned |
| `connected_accounts` | move; the same platform account active on both ⇒ keep the most recently verified, `revoked` the other (tokens cleared) — one token per account |
| affiliations | move; said/proof rows: the winner's stay; the loser's said rows become `found`-precedence-equivalent? **No** — they stay `said` (the athlete's word on either row) but a second current primary is demoted (`replaceSaidAffiliations` semantics); the projection follows |
| assertions / receipts (`athlete_asserted`, `agent_actions`) | move; a newer loser assertion on the same field supersedes an older winner one (the athlete's latest word), with `superseded_by` |
| MIA history (`athlete_snapshots`, `athletes_current`) | snapshots move (history kept, ordered by `created_at`); `athletes_current` is derived — the winner's kept, the loser's deleted, then a rescore is queued (G9 is *not* a gate for merges: a merge changes inputs by design; the rescore is recorded on the merge row) |
| deals, inbox threads/messages/senders, pending actions, payments | move; `inbox_threads` unique keys per athlete (`external_thread_id`) collide only if both rows ingested the same mailbox ⇒ keep the winner's thread, re-point messages, record; payments never re-pointed while `pending`/escrowed — the merge is refused until settled |
| media (`media_assets`, `media_kits`, `card_*`, `generation_jobs`, previews) | move; GCS paths carry athlete ids in their keys today — the *path* stays (the row points at it), so nothing is copied; a later media step may re-home objects |
| conversations, chat, voice context, notifications, tasks | move |
| `account_roles`, memberships, claims | memberships move to the winner (a loser self-member becomes a winner member with relation `self` only if the winner had none, else the pair is refused — two self-members is the one case the model forbids; the operator resolves which login is the athlete's) |
| `golden_athletes` | a golden anchor is never a loser |
| future recommendations / actions | every writer keys by `athlete_id`; readers that hold an athlete id resolve it through `canonicalAthleteId(id)` (follows `merged_into`), exported by the identity module; the loser row stays with `status='merged'` so old links, receipts and URLs still resolve |

Reversal: `revertMerge(mergeId)` replays `moved` in reverse in one transaction (rows re-pointed back; superseded marks lifted; the loser's derived rows recomputed); refused if the winner has since gained rows that depend on merged rows in a way the log cannot separate (reported, not forced).

## 7. Connected-account lifecycle

| Event | Behaviour |
|---|---|
| attach | `connections.ts` creates the pending row for `req.athleteId` with `connected_by_user_id = req.userId`; the callback flips it active; `ensureIdentity` records `connected_verified` (already) |
| handle differs from researched data | nothing to reconcile: the connected identity outranks; the researched identity for the same `account_id` is superseded, a researched identity for a different account stays (two accounts) |
| conflicts with another athlete (same `platform_user_id` active as `connected_verified` elsewhere) | the OAuth completes for the caller (`connected_accounts` active — her *proof* stands and the tokens are hers) but **no second active canonical ownership identity is created**: the caller's `social_identities` row is written `unverified` (the global exclusivity index holds); the proof is recorded as an `identity_claims` row `verified_social_ownership` against the other athlete and a duplicate pair `possible` with evidence `{kind: 'connect_collision', accountId, byUserId}` is opened. Resolution: 3b — if the other row has no self-member and the caller confirms, she is linked to it and her new row's duplicate pair is queued for merge; 3c — otherwise an operator decides (`verified_same` ⇒ merge moves the identity; `verified_distinct` ⇒ the other row's identity is downgraded to `unverified` and the caller's promoted — someone lost control of the account). The other row's connection is never revoked automatically. |
| one person owns multiple accounts on a platform | allowed: `social_identities` is per `(athlete, platform, account_id)`; `connected_accounts` one row per account; the index's exact-handle signal treats each as an identifier |
| username changes | `ensureIdentity` appends `handle_history`; the index matches on the current handle; old handle = weaker exact signal (3c) |
| access revoked / expired | `connected_accounts.status` (already); the identity keeps `connected_verified` with `last_verified_at` (ownership was proven, freshness is orthogonal — 2d G4); the context's `connectionStatus` reports it; after 180 days without re-verification the identity's *freshness* is `stale`, its authority unchanged (D-7) |
| an agency/manager connects on behalf later | the pending row records `connected_by_user_id` = the representative's user; ownership is attributed to the *athlete* only if that user holds a membership with a relation that permits connecting (`self` today; `agent` when enabled) — the column and the check exist from 3a, the relation values stay locked to `self` (ADR-015) |
| connection is never a marketability input | unchanged: connections feed `social_features` with `input_access_class` (ADR-016); Step 3 adds no scoring input (G9 across all slices) |

## 8. Scale and future compatibility

- **Millions of athletes:** all identity lookups are index-backed (trgm on name/alias, exact indexes on lower(handle), lower(email), `(platform, account_id)`); the duplicate detector runs as a batched report (pairs from exact identifiers + `nameSim ≥ 0.8` within sport), never in a request path; the merge is per pair, transactional, and its cost is the row count of one athlete.
- **Common names:** the minimum-evidence rule (2c) means a name alone never auto-matches; the "Is this you?" list shows distinguishing facts; unresolved pairs are cheap rows.
- **Transfers / turning professional:** ledger changes (2d); the index follows; no identity change.
- **Athlete → entrepreneur / organization relationships later:** memberships are `(athlete, user, relation)`; an organization is a *principal* the same table can reference later (`principal_type`), and athlete ↔ organization relationships (`represented_by`, `plays_for`) live in a relationship table, not in identity (ADR-015 "anticipated, not built").
- **Managers / parents / agents; organizations with portfolio access; multiple users per athlete; one user managing several athletes:** the membership table already models N:M with a `relation`; Step 3 enables only `self` and one self per athlete, and `requireAuth` selects the athlete for the request by the §3.2 rule (exactly one active membership ⇒ auto; more ⇒ the client names it via `X-Athlete-Id` from the user's memberships, or the session selection; never the first row). RBAC / organizations are not built; nothing here makes them impossible (ADR-016: access is by relation + consent, never by affiliation).

## 9. Migration approach and KEEP / MODIFY / EXTRACT / REPLACE / ADD

| # | Item | Today | Target | Class | Slice |
|---|---|---|---|---|---|
| 1 | `users` + `athlete_users` + `identity_claims` | — | 0051; backfill: one user per distinct `auth_id`, one self-membership per athlete with `proof = 'existing_auth'` (pre-Step-3 links are grandfathered, recorded as such) | ADD | 3a |
| 2 | `linkUserToAthlete` | writes `auth_id` | writes user + membership + claim in one transaction AND the `auth_id` projection (dual-write); same atomic guard (one self per athlete); same refusal | MODIFY | 3a |
| 3 | `requireAuth` / `requireAdmin` | token → `athletes.auth_id` | token → `users` → memberships → `req.userId`, `req.athleteId` (self by default); flag `IDENTITY_MEMBERSHIP_READ` (off): off ⇒ today's lookup byte for byte; on ⇒ memberships; shadow logs disagreements | MODIFY | 3a |
| 4 | `account_roles` | keyed by athlete | keyed by **user** (`user_roles`, 0051) with a compatibility read through the self-membership; `requireAdmin` reads `user_roles` | EXTRACT | 3a |
| 5 | `verificationStateFor` | `claimed_at OR auth_id OR connection` in three places | one function in the identity module; research `identityResolved`, planner `hasIdentitySignal`, index `hasUser` read it (same booleans today). Nothing about athlete-authored facts moves here | EXTRACT | 3a |
| 6 | `/auth/me` | athlete fields | + `user {id, email, emailVerified}`, `memberships [{athleteId, relation, proof}]`; the athlete block unchanged (2d-3) | MODIFY | 3a |
| 7 | signup path A (flag off) stages (2) and (3) | silent email/name links | REPLACE by A′ + the claim lifecycle; the flag `ATHLETE_INDEX_CLAIM` becomes the 3b rollout switch; stage (3) is deleted when the flag is on in prod | REPLACE | 3b |
| 8 | Microsoft `emailVerified` | `!!msProfile.mail` | `false` unless the provider asserts verification (D-6) | MODIFY | 3b |
| 9 | "Is this you?" | — | `POST /index/candidates` (live), `POST /identity/claims/:id/confirm` (user), operator confirm; client screen; onboarding v3 order (identify + confirm before research) behind `ONBOARDING_V3` | ADD | 3b |
| 10 | connect callback | `athlete_id` only | + `connected_by_user_id`; cross-athlete `platform_user_id` check ⇒ `verified_social_ownership` claim / duplicate pair | MODIFY | 3b (record) / 3c (pair) |
| 11 | typed handles / name / nickname | `athletes.socials`, `full_name`, assertion `nickname` (dead) | assertions with receipts (`handle_*`, `name`, `nickname`), resolved into the displayed `Fact<T>` by the canonical reads (origin `athlete_asserted`), mirrored into `athletes.socials` / `full_name` by the assertion writer's column projection — **never converted into `athlete_facts` rows** (§3.7) | MODIFY | 3b |
| 12 | `athlete_duplicates` + detector + operator queue | report script only | 0052; detector = the report's rules + connect collisions + index `possible_duplicate` decisions; admin queue (list, evidence, decide) | ADD | 3c |
| 13 | `athlete_merges` + `athletes.merged_into` + `planMerge` / `applyMerge` / `revertMerge` + `canonicalAthleteId` | `fixDuplicateAthleteRow` (delete-only, one case) | schema-generated plan over every FK, dry-run default, one transaction, reversible | ADD | 3c |
| 14 | `social_identities` ownership exclusivity | per-athlete unique | **global** partial unique `(platform, account_id) WHERE connected_verified AND active` after a pre-flight collision report (the 0049 pattern); a colliding proof writes the caller's row `unverified` | MODIFY | 3a |
| 15 | account deletion | deletes the athlete and 15 tables | membership-aware: deleting a *login* revokes the membership and disables the user; deleting the *athlete* stays the operator's / the sole self-member's explicit action | MODIFY | 3c |
| 16 | `athletes.auth_id / auth_provider` readers (48 files via `req.athleteId`, plus direct reads in auth/admin/planner/dual-write) | direct | unchanged callers (they keep `req.athleteId`); direct `auth_id` reads move to the identity module; the columns become a projection, dropped in a later step | MODIFY | 3a (module) / 3d (drop) |
| 17 | `claimed_at` / `status='claimed'` | conflated | `status` keeps its research/activation meanings; claim state = memberships + claims; `claimed_at` = projection of the first self-membership `established_at` | MODIFY | 3a |
| 18 | index `hasUser`, `claimability` | `auth_id IS NOT NULL` | derived from active self-membership — same values, the view's one auth-derived column moves (2c §8 promised exactly this) | MODIFY | 3a |
| 19 | `hasAssertedAffiliations` slip (2d-5 follow-up) | tests org kind (`a.kind`) instead of `kindOfFact` | **stays at the research/assertion-resolution boundary** (`skills/researchDualWrite.ts` `hintsFor` → `resolveFacts`): a narrow fix plus the resolver test it lacked (a said/proof current row ⇒ research only proposes affiliations), reviewed as its own small PR before or alongside 3a; Identity does not own assertion precedence | MODIFY | own PR |
| 20 | 2c matching, tiers, proofs, `athlete_index_matches`, `requireFirebaseUser`, golden anchors, `ensureIdentity`, legacy adapters, the context views | — | unchanged | KEEP | — |

## 10. Implementation slices

| Slice | Content | Flags | Migration |
|---|---|---|---|
| **3a — the split** | `users`, `athlete_users`, `user_roles`, `identity_claims`; the global ownership-exclusivity index; backfill scripts (dry-run default, pre-flight collision reports); `linkUserToAthlete` dual-write; `requireAuth` via memberships (the §3.2 selection rule) behind `IDENTITY_MEMBERSHIP_READ` with shadow; `verificationStateFor`; `/auth/me` additions; index `hasUser` from memberships | `IDENTITY_MEMBERSHIP_READ=false` both envs | 0051 (additive + one partial unique index after pre-flight) |
| **3b — the claim** | claims lifecycle + "Is this you?" endpoint/screen; `human_confirmation` and `linked_by_confirmation`; `verified_social_ownership` link when unclaimed; onboarding v3 order; typed handles/name/nickname as assertions; Microsoft verification fix; signup stage (3) retired behind the flag | `ATHLETE_INDEX_CLAIM` (existing, off), `ONBOARDING_V3=false` | none |
| **3c — duplicates and merges** | `athlete_duplicates`, `athlete_merges`, `merged_into`, detector + admin queue, schema-generated merge plan/apply/revert, `canonicalAthleteId`, connect-collision pairs and their resolution (identity promotion/downgrade), membership-aware deletion | operator tools only (no flag; dry-run default) | 0052 (additive) |
| **3d — retire the projection** | direct `auth_id` readers off; `athletes.auth_id / auth_provider / claimed_at` become write-only projections; drop scheduled for the step after prod has run 3a–3c | — | (drop) later |

Each slice: design here → code → review → merge → deploy → dev evidence in `step3-identity.md`; flags off in both environments; prod untouched except through the normal deploy path on the user's word.

## 11. Acceptance criteria and rollout gates

| Gate | Criterion |
|---|---|
| I1 backfill parity | after 0051 + backfill on dev: one user per distinct `auth_id`; one self-membership per athlete with `auth_id`; `requireAuth` via memberships resolves the same `req.athleteId` as today for every dev token (shadow log: zero disagreements); `hasUser`/`claimability` unchanged for every index row |
| I2 no silent link | with `ATHLETE_INDEX_CLAIM` on: no path writes a membership without a linking proof; a name/sport/handle match on its own produces claims `proposed` and a new row; regression: the 2c fixture roster (lookalikes, shared handle, same name/sport) |
| I3 no silent merge, no silent takeover | a login or a confirmation never merges: confirming a candidate with a self-member yields a duplicate pair and no membership; confirming an existing candidate without corroboration yields a proposed claim and a new profile, never control of the existing one; two self-members on one athlete is impossible (index) |
| I3b one owner per account | the global exclusivity index holds; a colliding OAuth completes for the caller, records the claim and the pair, and leaves exactly one active `connected_verified` identity for the account |
| I3c athlete selection | with one active membership `requireAuth` auto-selects; with two it returns 409 until the request names an athlete the user holds; it never picks the first row |
| I4 ownership ⟂ authority | connecting an account never changes a fact's authority tier or any scoring input (G9 digest byte-identical across 3a–3c on dev); the connected identity outranks in the context (2d G3) |
| I5 merge fidelity | `planMerge` covers every FK to `athletes.id` in `schema.ts` (a test enumerates the schema and fails on any table the plan does not classify); apply then revert leaves every table row-identical (PGlite); a merge with pending payments is refused; `canonicalAthleteId` resolves a loser id |
| I6 lifecycle audit | every claim, duplicate decision and merge carries who/when/why; `athlete_index_matches` unchanged; no uid stored outside `users` |
| I7 boundary | the intelligence boundary test passes; nothing outside `identity/` writes `users`, `athlete_users`, `identity_claims`, `athlete_duplicates`, `athlete_merges`, `merged_into` (source-guard test) |
| I8 client | with the flags off the app is byte-for-byte; with `IDENTITY_MEMBERSHIP_READ` on, every screen renders for a dev token; "Is this you?" reviewed with Mia on dev before `ATHLETE_INDEX_CLAIM` is listed on dev |
| I9 Beta.1 §2 order | onboarding v3 on dev: identify → confirm → research once; a `candidate`/`auto_match` never runs research before confirmation |

Rollout (each a separate user decision, never bundled into a slice PR): a) 0051 + backfill dry-run report → apply on dev; b) `IDENTITY_MEMBERSHIP_READ=true` on dev after I1; c) `ATHLETE_INDEX_CLAIM=true` on dev after I2/I8; d) `ONBOARDING_V3=true` on dev after I9; e) prod, per flag, after dev evidence.

## 12. Decisions to lock before coding

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Introduce `users` + `athlete_users` now (3a) rather than deferring to the organization/RBAC step | **Yes** — Step 3's claim, ownership and merge rules cannot be expressed on `athletes.auth_id`; `relation` stays locked to `self` |
| D-2 | One self-membership per athlete (partial unique), and at most one athlete per user as *self* | one self per athlete: **yes**; one self per user: **not enforced** (a user may temporarily hold two self-memberships until the duplicate lifecycle resolves them). **Auth rule:** `requireAuth` auto-selects only when exactly one active membership exists; with more than one it requires an explicit `X-Athlete-Id` (validated against the memberships) or a session selection — otherwise 409; never the first row |
| D-3 | A login or a confirmation never merges; a merge is operator-only, dry-run first | **Yes** (I3) |
| D-4 | `verified_social_ownership` may link when the other row has no self-member (3b) | **Yes**, as corroborating proof with the caller's confirmation — the caller proved control of the account the other row is built on; with a self-member ⇒ duplicate pair only. In every case the account keeps exactly one active `connected_verified` identity until the link/merge resolves (never two owners) |
| D-5 | Typed handles / name / nickname become assertions (with receipts); `athlete_asserted` stays separate from `athlete_facts`; canonical reads resolve an assertion into the displayed `Fact<T>` (origin `athlete_asserted`); compatibility projections mirror it into `athletes.socials` / `full_name`; Step 3 never converts an assertion into a researched fact row; no new `SourceClass` | **Yes** (origin `entered` stays a context label, not a source class) |
| D-6 | Microsoft `emailVerified` | `false` unless the provider's claim asserts verification (today's `!!mail` is presence) |
| D-7 | A revoked/expired connection keeps `connected_verified` authority with `last_verified_at`; freshness stale after 180 days; never downgraded | **Yes** (2d G4: freshness ⟂ connection) |
| D-8 | Merge target semantics for `athletes_current` and MIA history | history moves; `athletes_current` recomputed; G9 is not a merge gate (a merge changes inputs by design) |
| D-9 | `plan` / `stripe_customer_id` stay on `athletes` in Step 3 | **Yes** (billing follows the product; a later billing decision) |
| D-10 | `hasAssertedAffiliations` | fix the existing bug at the research/assertion-resolution boundary (`hintsFor` → `resolveFacts`) with the resolver test it lacked, as its own narrow PR; general assertion-state / affiliation precedence does **not** move into Identity, which owns membership, claims, verification/ownership, duplicates and merges only |
| D-11 | `account_roles` → `user_roles` (a role belongs to a person) | **Yes** (3a, compatibility read kept) |
| D-12 | Account deletion becomes membership-aware (login deletion ≠ athlete deletion) | **Yes** (3c) |
| D-13 | **Global** ownership exclusivity: partial unique `(platform, account_id)` for active `connected_verified` identities | **Yes**, in 3a (0051) after a pre-flight report on dev (prod: by deploy, zero rows). A proven collision records the proof and opens the claim/duplicate lifecycle; the caller's identity row stays `unverified` until resolution — no second active canonical owner |
| D-14 | Candidate confirmation ≠ ownership proof | **Lock:** `human_confirmation` stays in the `ClaimProof` vocabulary; on its own it establishes self-membership only on a profile the user creates in that flow. Claiming a pre-existing indexed athlete requires a corroborating proof (`verified_unique_email`, `verified_social_ownership`, grandfathered `existing_auth`) or operator approval (`decided_by = operator`); the membership records the corroborating proof and the confirming claim |

Not decided here (out of scope): organizations, portfolios, roles beyond `self`, RBAC, athlete consent records, Step 4 MIA, any research/social redesign.
