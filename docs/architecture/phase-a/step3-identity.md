# Phase A Step 3 — Identity: build record

Design: `step3-identity-design.md` — **LOCKED** at PR #424 head a5c0465 (11 Sep 2026; D-1 … D-14). This record is filled one slice at a time (3a → 3b → 3c → 3d). Status: **3a COMPLETE ON DEV; 3b CLOSED ON DEV; ATHLETE_INDEX_CLAIM slice CLOSED ON DEV (12 Sep 2026)** — 3b merged (#432 → 31351b3) and deployed; rollout steps 1–2 done: the preview client flag (#435) and `ATHLETE_INDEX_CLAIM=true` on dev (#436) with the acceptance fix (#437); §19 holds the evidence. `ONBOARDING_V3=false`; production untouched. — merged (#426 → d114d4a), deployed, backfilled (§8), membership shadow rollout step 1 clean (§9), membership READ rollout step 2 clean (§9): `IDENTITY_MEMBERSHIP_READ=true` is authoritative on dev, `IDENTITY_MEMBERSHIP_SHADOW=false`; production untouched with both flags false. Review round 1: P-1 … P-4 approved as written; the collision-safe 3a ownership path added (§3a-C). The as-built record is §7.

## 3a — the split: implementation plan (from main at 9be9ca1 + the 2d closure docs)

Scope (locked): `users`, `athlete_users`, `identity_claims`, `user_roles`; `connected_accounts.connected_by_user_id`; global active `connected_verified (platform, account_id)` exclusivity; `linkUserToAthlete` dual-write; `requireAuth` / `requireAdmin` membership read behind a flag with a shadow path; `verificationStateFor`; `/auth/me` additive fields; Athlete Index `hasUser` / `claimability` compatibility; guards and tests; I1 / I4 / I6 / I7 / G9 evidence. **Out of 3a:** every 3b/3c/3d item (claim UI, `human_confirmation` flows, duplicate/merge tooling, retiring the projection), the `hasAssertedAffiliations` fix (its own PR), any reader listing, any flag on, production.

### Dev facts the plan is written against (read-only, 11 Sep 2026)

| Fact | Dev |
|---|---|
| `athletes` | 24 rows; 14 with `auth_id`, all distinct (0049 holds), all `auth_provider = 'firebase'`; 0 Microsoft (`auth_id` would be `microsoft:<id>`); 0 `claimed_at`; 15 distinct emails |
| `account_roles` | 15 rows, all `athlete`; **1 row on an athlete without `auth_id`** (no user to map to) |
| `connected_accounts` active | gmail 3, instagram 1, tiktok 1; **no cross-athlete `platform_user_id` collision** |
| `social_identities` | `connected_verified/active` 3, `platform_public/active` 8, `web_researched/active` 2; **no cross-athlete active `connected_verified (platform, account_id)` collision** |
| production | 0 athletes, 0 connections, 0 identities (schema 0044–0050 present, not "recorded"); 0051 reaches it only through a future normal prod deploy |

### 1. Migration `0051_identity_users.sql` (additive, idempotent, **no transaction control**, guarded by `migrationsGuard.test.ts`)

```sql
-- users: the authenticated person (ADR-015). provider_uid is the identity-provider uid exactly as athletes.auth_id holds it
-- today ('<firebase uid>' or 'microsoft:<id>' — Firebase verifies both; the Microsoft form is minted by routes/auth.ts).
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,                                   -- 'firebase' | 'microsoft' (= athletes.auth_provider vocabulary)
  provider_uid   text NOT NULL,
  email          text,
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,
  disabled_at    timestamptz,
  CONSTRAINT users_provider_check CHECK (provider IN ('firebase','microsoft')),
  CONSTRAINT users_provider_uid_uq UNIQUE (provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- identity_claims: the claim lifecycle state (D-14). 3a creates the table; nothing writes 'proposed' rows until 3b.
CREATE TABLE IF NOT EXISTS identity_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  athlete_id  uuid NOT NULL REFERENCES athletes(id),
  match_id    uuid REFERENCES athlete_index_matches(id) ON DELETE SET NULL,
  proof       text NOT NULL,
  status      text NOT NULL DEFAULT 'proposed',
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text,
  note        text,
  CONSTRAINT identity_claims_proof_check   CHECK (proof IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation','none')),
  CONSTRAINT identity_claims_status_check  CHECK (status IN ('proposed','confirmed','rejected','expired','superseded')),
  CONSTRAINT identity_claims_decided_check CHECK (decided_by IS NULL OR decided_by IN ('user','operator','system'))
);
CREATE INDEX IF NOT EXISTS identity_claims_athlete_idx ON identity_claims (athlete_id, status);
CREATE INDEX IF NOT EXISTS identity_claims_user_idx    ON identity_claims (user_id, status);

-- athlete_users: the membership (User ↔ Athlete). relation locked to 'self' (D-1); one self per athlete (D-2).
CREATE TABLE IF NOT EXISTS athlete_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     uuid NOT NULL REFERENCES athletes(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  relation       text NOT NULL DEFAULT 'self',
  proof          text NOT NULL,
  claim_id       uuid REFERENCES identity_claims(id) ON DELETE SET NULL,
  note           text,                                            -- 3a: 'backfill' | 'legacy_path:<stage>' (see §5)
  established_at timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT athlete_users_relation_check CHECK (relation IN ('self')),
  CONSTRAINT athlete_users_proof_check    CHECK (proof IN ('existing_auth','verified_unique_email','verified_social_ownership','human_confirmation'))
);
CREATE UNIQUE INDEX IF NOT EXISTS athlete_users_active_uq   ON athlete_users (athlete_id, user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS athlete_users_one_self_uq ON athlete_users (athlete_id) WHERE relation = 'self' AND revoked_at IS NULL;
CREATE INDEX        IF NOT EXISTS athlete_users_user_idx    ON athlete_users (user_id) WHERE revoked_at IS NULL;

-- user_roles: a role belongs to a person (D-11). account_roles stays for the compatibility read (3d retires it).
CREATE TABLE IF NOT EXISTS user_roles (
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_check CHECK (role IN ('athlete','fan','brand','school_admin','admin'))
);

-- who performed the OAuth (§7); backfilled to the athlete's self user where one exists
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS connected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- D-13: one active canonical owner per account. Created ONLY after scripts/checkIdentityCollisions.ts reports zero (§2);
-- the migration file still carries it (IF NOT EXISTS) because the deploy path is the only schema path.
CREATE UNIQUE INDEX IF NOT EXISTS social_identities_owner_uq ON social_identities (platform, account_id)
  WHERE source_class = 'connected_verified' AND status = 'active';

-- Athlete Index compatibility: has_user / claimability read the membership OR the projection (dual until 3d);
-- the column list and order are unchanged (assertIndexShape pins 25 columns).
CREATE OR REPLACE VIEW athlete_index_v AS … (the 0048 SELECT with
  (a.auth_id IS NOT NULL OR EXISTS (SELECT 1 FROM athlete_users au WHERE au.athlete_id = a.id AND au.relation = 'self' AND au.revoked_at IS NULL)) AS has_user
  and the same expression inside the claimability CASE) … ;
```
`shared/schema.ts`: `users`, `identityClaims`, `athleteUsers`, `userRoles` tables, `connectedAccounts.connected_by_user_id`, the partial unique on `socialIdentities`; `scripts/db-migrate.sh` list 0031–0051. Drift gate: the four new tables and one column are `pgTable` exports (verified). The view is re-created in the same file (the gate does not see views; `assertIndexShape` does).

Dry-run: per file, `BEGIN; \i 0051 … ROLLBACK;` on **dev only** (0051 has no transaction control — asserted by the guard); production receives it through its normal deploy, never by hand.

### 2. Pre-flight and backfill (`server/scripts/backfillIdentityUsers.ts`, dry-run default, `--apply`)

Pre-flight (read-only; any non-zero blocker ⇒ the script refuses `--apply` and prints the rows):

| Check | Query | Dev today | Blocker? |
|---|---|---|---|
| P1 one uid, two athletes | `SELECT auth_id, count(*) FROM athletes WHERE auth_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1` | 0 (0049) | yes |
| P2 provider consistency | `auth_id LIKE 'microsoft:%'` ⇔ `auth_provider = 'microsoft'`; else `firebase`; any other value listed | 0 mismatches (14 firebase) | yes |
| P3 ownership collisions (D-13) | `SELECT platform, account_id, count(DISTINCT athlete_id) FROM social_identities WHERE status='active' AND source_class='connected_verified' GROUP BY 1,2 HAVING count(DISTINCT athlete_id) > 1` | 0 | yes — the index in 0051 would fail the deploy; a collision is resolved by an operator BEFORE 0051 (the later-verified row set `unverified`, recorded), never by the script |
| P4 connection collisions | same over `connected_accounts (platform, platform_user_id)` active | 0 | report only (3c lifecycle) |
| P5 roles without a user | `account_roles` rows whose athlete has no `auth_id` | 1 | report only: left in `account_roles` (compatibility read keeps serving it); not migrated |
| P6 emails | athletes with `auth_id` and NULL email → `users.email` NULL; `email_verified` **false for every backfilled user** (the projection never recorded verification; 3b sets it from the provider on next sign-in) | — | no |

Apply (one transaction; idempotent — every insert is `ON CONFLICT DO NOTHING` on the unique keys):
1. `users`: one row per distinct `auth_id` — `provider` from P2, `provider_uid = auth_id`, `email = athletes.email`, `email_verified = false`, `display_name = full_name`, `created_at = athletes.created_at`.
2. `athlete_users`: one `self` row per athlete with `auth_id` — `proof = 'existing_auth'` (grandfathered, D-14), `note = 'backfill'`, `established_at = coalesce(claimed_at, created_at)`.
3. `user_roles`: `account_roles` joined through the self-membership → `(user_id, role)`; P5 rows skipped and listed.
4. `connected_accounts.connected_by_user_id`: the athlete's self user for every row whose athlete has one (the only user that could have connected it); others stay NULL.
Report: counts per step before/after; expected on dev: 14 users, 14 memberships, 14 user_roles (+1 skipped), 5 connections attributed. `--revert` deletes only rows tagged `note = 'backfill'` / created by this script (users with no other memberships), for rollback.

### 3. Code

| Item | File | Change |
|---|---|---|
| users | `services/intelligence/identity/users.ts` (new) | `ensureUser(provider, providerUid, {email, emailVerified, displayName})` (upsert on the unique key, refreshes `last_seen_at`/`email`); `membershipsForUser(userId)`; `selfMembershipFor(athleteId)`; `providerOf(uid)` = `uid.startsWith('microsoft:') ? 'microsoft' : 'firebase'` (the one place this rule lives) |
| link | `identity/link.ts` `linkUserToAthlete` | ONE transaction: `ensureUser` → insert `athlete_users` self row `{proof, note, claim_id NULL}` — the partial unique `athlete_users_one_self_uq` is the atomic guard (a violation ⇒ `ClaimNotAuthorized`, exactly today's "never re-bind a row that has a user"; the same uid is idempotent via `athlete_users_active_uq` + a pre-check) → the existing conditional `UPDATE athletes` (projection: `auth_id`, `auth_provider`, `claimed_at`, `status`) with the same predicate. Refuses without a linking proof as today. Returns `{ status, userId, membershipId }` |
| legacy `auth_id` writers (flag-off paths, byte-for-byte behaviour) | `routes/auth.ts:115,145,188,202,365,375`, `routes/waitlist.ts:264` | unchanged writes, each followed by `grandfatherMembership(athleteId, uid, { note: 'legacy_path:<signup_create \| signup_email \| signup_name \| microsoft_create \| waitlist_create>' })` → `users` + `athlete_users` with `proof = 'existing_auth'` (D-14: a link made before the claim lifecycle exists is grandfathered, never a `human_confirmation` — see P-1). Failure of the membership write is logged, never surfaced (the response is unchanged); the nightly reconciliation (`backfillIdentityUsers --apply`, idempotent) closes any gap |
| `requireAuth` | `lib/auth.ts` | flag `IDENTITY_MEMBERSHIP_READ` (identity/config.ts): **off ⇒ today's `athletes.auth_id` lookup byte for byte**; on ⇒ `users(provider, uid)` → active memberships → the §3.2 rule: 1 ⇒ `req.athleteId`; >1 ⇒ `X-Athlete-Id` header validated against the memberships, else `409 { error: 'athlete_selection_required', athletes: [...] }`; 0 ⇒ 401 as today. Sets `req.userId` (on) and `req.roles` (token roles ∪ `user_roles` when on). Shadow flag `IDENTITY_MEMBERSHIP_SHADOW`: off-path also computes the membership answer and logs any disagreement (`{ uid, legacyAthleteId, membershipAthleteIds }`), never changes the response |
| `requireAdmin` | `lib/auth.ts` | same flag: roles = token claims ∪ `account_roles` (via the athlete row) ∪ `user_roles` (via `users`); `req.athleteId` by the same selection rule when on; `ADMIN_OPEN_ACCESS` semantics untouched |
| `verificationStateFor` | `identity/state.ts` (new) | `{ selfMember: userId \| null, authProjection: boolean, verifiedEmail: boolean, ownedAccounts: [{platform, accountId, verifiedAt, byUserId}] (active `connected_verified` only — an `unverified` collision row is listed under contestedAccounts, never as owned), connected: boolean, hasIdentitySignal: boolean }` with `hasIdentitySignal = selfMember \|\| authProjection \|\| claimedAt \|\| connected` — **exactly today's boolean**; callers: `researchDualWrite.identityResolved` (`claimed_at \|\| auth_id` → `hasIdentitySignal` without `connected`, i.e. a second field `identityResolved` = `selfMember \|\| authProjection \|\| claimedAt`), planner `loadPlannerInput` (`claimed \|\| auth \|\| connected` → `hasIdentitySignal`), `realUser` (connected) unchanged. Nothing about assertions or facts (D-10) |
| `/auth/me` | `routes/auth.ts` | additive: `user: { id, provider, emailVerified }`, `memberships: [{ athleteId, relation, proof, establishedAt }]`; every existing field unchanged (2d-3 identity view stays); flag-independent (reads the tables 0051 creates) |
| index | `identity/index.ts` | no code change: `has_user` / `claimability` come from the re-created view; `assertIndexShape` unchanged; `claimability` tests extended with a membership-only athlete (no `auth_id`) ⇒ `none` |
| connect | `routes/connections.ts` | pending row gets `connected_by_user_id = req.userId ?? selfUserOf(req.athleteId)` (the latter when the flag is off — today's caller is the self user by construction); the callback leaves it |
| ownership promotion (D-13 at runtime) | `identity/ownership.ts` (new) + `social/ingest.ts` `ensureIdentity` | `claimAccountOwnership({ athleteId, platform, accountId, connectedAccountId, byUserId })` is the ONLY path that may write an `active connected_verified` identity; `ensureIdentity` calls it whenever `sourceClass === 'connected_verified'` (connect, stories, backfill). The collision-safe path is §3a-C |
| config + YAML | `identity/config.ts`, `gcp/cloud-run-{dev,prod}.yaml` | `IDENTITY_MEMBERSHIP_READ: "false"`, `IDENTITY_MEMBERSHIP_SHADOW: "false"` in both |
| scripts | `backfillIdentityUsers.ts` (§2), `checkIdentityCollisions.ts` (P1–P5 read-only, also for prod-by-deploy evidence), `identityReadShadow.ts` (I1: for every athlete with `auth_id`, the membership resolution == the legacy resolution; prints disagreements) |

### 3a-C. The collision-safe ownership path (D-13 at runtime, before 3c exists)

Where it runs: every promotion of a `social_identities` row to `source_class = 'connected_verified', status = 'active'` — today `ensureIdentity` (`social/ingest.ts`) called from `substrate.ts` (connect ingest, lines 99/145/163), `stories.ts:83` and `backfillSocialSubstrate.ts`. In 3a `ensureIdentity` delegates that one decision to `identity/ownership.ts`:

```
claimAccountOwnership({ athleteId, platform, accountId, connectedAccountId, byUserId })
  1. owner := SELECT athlete_id FROM social_identities
              WHERE platform = $1 AND account_id = $2 AND source_class = 'connected_verified' AND status = 'active'
              AND athlete_id <> $3   (FOR SHARE)
  2. no owner  ⇒ upsert the caller's identity row as connected_verified/active (today's ensureIdentity behaviour); return { outcome: 'owner' }
  3. owner     ⇒ collision:
       a. the caller's OAuth is NOT undone: connected_accounts stays active for the caller (the tokens and the proof are hers)
       b. the caller's social_identities row is written/updated with source_class = 'connected_verified', status = 'unverified',
          evidence.ownership_collision = { ownerAthleteId, byUserId, at }  — never 'active' (the unique index cannot be violated)
       c. identity_claims INSERT { user_id = byUserId (the caller's self user; from connected_by_user_id, else selfUserOf(athleteId)),
          athlete_id = ownerAthleteId, match_id NULL, proof = 'verified_social_ownership', status = 'proposed', decided_by NULL,
          note = json { accountId, platform, claimantAthleteId, connectedAccountId } }  — idempotent on (user_id, athlete_id, proof, status='proposed', note.accountId)
       d. the existing owner's rows are untouched (identity active, connection active)
       e. return { outcome: 'collision', ownerAthleteId, claimId }; the caller of ensureIdentity continues (sync runs, observations
          and features are recorded against the caller's identity row as before — a collision is not an ingest failure)
  4. concurrency: the unique index is the arbiter. The INSERT/UPDATE to active is attempted inside a savepoint; a unique
     violation (23505 on social_identities_owner_uq) ⇒ re-read the owner (now committed by the other transaction) and take
     branch 3 with that owner. Two simultaneous completions for the same account on two athletes therefore end with exactly
     one active owner (whichever committed first) and one proposed claim from the other — no 500, no partial state.
```
Nothing else changes in 3a: no `athlete_duplicates`, no operator queue, no resolution — 3c reads the proposed `verified_social_ownership` claims (and the `unverified` identity rows carrying `evidence.ownership_collision`) to open the duplicate lifecycle. Until then the Athlete Index sees the account on two rows (one active, one unverified) and, exactly as in 2c, treats an identifier held by two rows as ambiguous (never `auto_match`).

Idempotency and repeats: a second connect by the same caller for the same colliding account updates `last_verified_at` / `evidence` on her `unverified` row and leaves the existing proposed claim in place (no duplicate claim rows). If the owner's identity is later superseded/rejected (3c), the next `claimAccountOwnership` for the caller promotes her row (branch 2) — nothing in 3a does that automatically.

The `connected_verified` source class on an `unverified` row is deliberate: it records *what was proven* (control of the account by the connecting user); `status` records that the *canonical ownership* is unresolved. `SourceClass` vocabulary is unchanged.

### 4. Guards and tests

| Test | Pins |
|---|---|
| `identity/users.test.ts` | upsert idempotent on `(provider, provider_uid)`; `providerOf` |
| `identity/link.test.ts` (extend `claim.test.ts`/`index.test.ts` fixtures) | dual-write in one transaction; refusal without proof; **concurrency**: two users claiming one unclaimed athlete ⇒ exactly one membership + projection, the other `ClaimNotAuthorized` (the partial unique index); idempotent for the same uid; projection == membership after every path |
| `lib/auth.membership.test.ts` (new; mocks the verifier like `auth.requireFirebaseUser.test.ts`) | flag off ⇒ byte-for-byte lookup (no `users` read); shadow ⇒ same response + disagreement logged when the tables disagree; on ⇒ 0 / 1 / 2 memberships (401 / auto / 409), `X-Athlete-Id` valid and foreign (403), `req.userId`; `requireAdmin` roles union from all three sources; `ADMIN_OPEN_ACCESS` unchanged |
| `identity/ownership.test.ts` (new, PGlite with 0051's index applied) | **sequential**: athlete A connects account X ⇒ A active owner; athlete B completes OAuth for X ⇒ no throw, B's `connected_accounts` active, B's identity `connected_verified/unverified` with `evidence.ownership_collision`, one `identity_claims` row `{ user: B's user, athlete: A, proof: verified_social_ownership, status: proposed }`, A's rows byte-identical, `SELECT count(*) … active connected_verified (X)` = 1. **concurrent**: fresh account Y, `Promise.all` of `claimAccountOwnership` for C and D ⇒ both resolve (no rejection), exactly one `owner` outcome and one `collision` outcome, one active row, one proposed claim, the unique index never surfaced as an error. **repeat**: B connects X again ⇒ still one claim, `last_verified_at` advanced. **release**: after A's identity is set `superseded` (simulating 3c), B's next claim promotes B (branch 2) |
| `identity/state.test.ts` | `verificationStateFor` equals the legacy expressions (`claimed \|\| auth \|\| connected`; `claimed \|\| auth`) on a fixture roster covering every combination; a membership-only athlete counts as identified |
| `identity/index.test.ts` (extend) | 0051 applied to PGlite after 0048: `has_user` / `claimability` unchanged for every roster row; a membership-only athlete ⇒ `has_user = true`, `claimability = none`; `assertIndexShape` still 25 columns |
| `identity/backfill.test.ts` | the pure planner over a fixture roster: P1–P5 outcomes; apply twice ⇒ no new rows; `--revert` removes only backfill rows |
| `identity/ownershipGuard.test.ts` (source-level, like `sourceGuard`) | only `services/intelligence/identity/**` and `scripts/backfillIdentityUsers.ts` may write `users`, `athlete_users`, `identity_claims`, `user_roles`; `connected_by_user_id` written only by `routes/connections.ts` + the backfill; no file outside `lib/auth.ts` + the identity module reads `users.provider_uid` (I6: no uid leaves the identity boundary) |
| `boundary.test.ts` | unchanged (new files import no provider) |
| `migrationsGuard.test.ts` | 0051 has no transaction control / non-transactional DDL |
| `research/persist.test.ts`, `planner.test.ts`, `researchDualWrite.hints.test.ts` | unchanged behaviour through `verificationStateFor` |
| `mediaKitService.golden`, `scoringDigest` (G9) | unchanged |

### 5. Open points — P-1 … P-4 APPROVED as written (review round 1)

| # | Point | Proposed |
|---|---|---|
| P-1 | Proof recorded for memberships created on the **legacy** (flag-off) paths — new-row signup, the email link, the name link, Microsoft, waitlist — which have no claim lifecycle in 3a | `existing_auth` with `note = 'legacy_path:<stage>'` ("grandfathered", D-14 wording); 3b records real proofs once the claim flow exists; the note lets 3c/3d find them |
| P-2 | `email_verified` on backfilled users | `false` (never recorded before); refreshed from the provider token at the next sign-in by `ensureUser` |
| P-3 | The 1 dev `account_roles` row on an athlete without `auth_id` | left in `account_roles` (compat read), listed by the pre-flight; never invented a user |
| P-4 | Shadow flag | separate `IDENTITY_MEMBERSHIP_SHADOW` (not `CONTEXT_SHADOW`, which belongs to the 2d readers) |

### 6. Evidence plan

| Gate | How, on dev |
|---|---|
| dry-run 0051 | per-file `BEGIN … ROLLBACK` on dev (guard-checked file); prod: by deploy only |
| I1 backfill parity | `checkIdentityCollisions` (P1–P5 zero blockers) → `backfillIdentityUsers` dry-run report (14 / 14 / 14+1 / 5) → `--apply` on the user's word → `identityReadShadow`: for every athlete with `auth_id`, membership resolution == legacy resolution (24/24, 0 disagreements); index `has_user`/`claimability` unchanged for all 24 rows (before/after dump diff) |
| I4 | G9 `scoringInputsDigest` before and after 0051 + backfill = `0bd3f1db…` byte-identical; no `social_features` change (Step 3 adds no scoring input) |
| I6 | `ownershipGuard.test.ts`; on dev `SELECT` proves no `provider_uid` value appears in `athlete_index_matches.query/candidates` |
| I3b (3a part) | `ownership.test.ts` (sequential + concurrent + repeat + release); on dev after deploy: `SELECT platform, account_id, count(*) FROM social_identities WHERE source_class='connected_verified' AND status='active' GROUP BY 1,2 HAVING count(*) > 1` = 0 rows; 0 `identity_claims` (no collision has occurred on dev) |
| I7 | boundary + ownership guard + source guard green in CI |
| flags / readers / prod | `IDENTITY_MEMBERSHIP_READ=false`, `IDENTITY_MEMBERSHIP_SHADOW=false`, `CANONICAL_CONTEXT_READERS` empty, `CONTEXT_SHADOW=false`, claim/substrate/refresh false; prod untouched (revision, flags, schema) |
| 2d parity | full read-only context shadow after deploy: every reader equal (the identity view reads the projection until 3d) |

Rollout decisions after 3a (each separate, never bundled): 0051 apply on dev is by deploy; `backfillIdentityUsers --apply` on dev; `IDENTITY_MEMBERSHIP_SHADOW=true` on dev; `IDENTITY_MEMBERSHIP_READ=true` on dev after I1; prod later.

### 7. As built (implementation PR, branch `feat/phase-a-step3a-identity-split`, base `main`)

Built exactly against the locked design (#424 @ a5c0465) and the approved plan (#425 @ 7c4e1f1). Flags: `IDENTITY_MEMBERSHIP_READ="false"` and `IDENTITY_MEMBERSHIP_SHADOW="false"` in both `gcp/cloud-run-dev.yaml` and `gcp/cloud-run-prod.yaml`. No reader listed, no backfill applied, no deploy, production untouched.

| Item | Where | Notes |
|---|---|---|
| 0051 | `migrations/0051_identity_users.sql` | §1 verbatim: `users`, `identity_claims`, `athlete_users` (+ `athlete_users_active_uq`, `athlete_users_one_self_uq`, `athlete_users_user_idx`), `user_roles`, `connected_accounts.connected_by_user_id`, `social_identities_owner_uq` (partial unique on active `connected_verified`), `athlete_index_v` re-created with `has_user` / `claimability` reading the projection OR a self-membership (25 columns, order unchanged). No transaction control (`migrationsGuard` 51/51). `shared/schema.ts` + `scripts/db-migrate.sh` (0031–0051) |
| users / memberships | `identity/users.ts` (new) | `providerOf`, `ensureUser` (verified email never downgraded), `findUserByUid`, `membershipsForUser`, `selfMembershipFor`, `selfUserOf`, `rolesForUser`, `insertSelfMembership` (the partial unique is the atomic guard; same user idempotent, never re-dated), `grandfatherMembership` (proof `existing_auth`, note `legacy_path:<stage>`; never surfaces a failure) |
| dual-write | `identity/link.ts` | `linkUserToAthlete` = ONE transaction: `ensureUser` → self membership → the unchanged conditional `athletes` projection UPDATE; a membership refusal or a foreign projection ⇒ `ClaimNotAuthorized` and full rollback; returns `{ status, userId, membershipId }` |
| legacy paths (P-1) | `routes/auth.ts` (signup_create ×2, signup_email, signup_name, microsoft_create ×2), `routes/waitlist.ts` (waitlist_create) | each flag-off `auth_id` write is followed by `grandfatherMembership(...)`; the 2c linked branches add the `user_roles` row beside `account_roles` (the membership itself is written by `linkUserToAthlete`) |
| auth | `lib/auth.ts` | `requireAuth`: flag off = today's `athletes.auth_id` lookup byte for byte (one SELECT, users never read); shadow = same answer + one structured log `{ shadow: "identity_membership_read", legacyAthleteId, membershipAthleteIds, agrees }`; on = `users → athlete_users` with the §3.2 rule (0 ⇒ 401; 1 ⇒ auto; >1 ⇒ `X-Athlete-Id` validated (foreign ⇒ 403 `athlete_not_held`) else 409 `athlete_selection_required` — never the first row), `req.userId`, roles token ∪ `user_roles`. `requireAdmin`: on ⇒ roles token ∪ `account_roles` ∪ `user_roles`; a selection error is not fatal; `ADMIN_OPEN_ACCESS` unchanged |
| state | `identity/state.ts` (new) | `verificationStateFor` / `verificationStatesFor` — `identityResolved = claimed_at ∨ auth_id ∨ selfMember`, `hasIdentitySignal = identityResolved ∨ connected`; `ownedAccounts` = active `connected_verified` only, `contestedAccounts` = the `unverified` collision rows. Consumed by `researchDualWrite.ts` (`identityResolved`) and `research/planner.ts` (`hasIdentitySignal`, `realUser` unchanged) |
| /auth/me | `routes/auth.ts` | additive `user { id, provider, emailVerified }` (null until a membership exists) and `memberships [{ athleteId, relation, proof, establishedAt }]`; never a provider uid |
| connect | `routes/connections.ts` | pending row `connected_by_user_id = req.userId ?? selfUserOf(athleteId)` |
| ownership (§3a-C) | `identity/ownership.ts` (new), `social/identityRow.ts` (new, the upsert body that `ensureIdentity` always had), `social/ingest.ts` | `ensureIdentity` delegates every `connected_verified` write to `claimAccountOwnership`; owner read `FOR SHARE`; no owner ⇒ the active upsert runs inside a **nested drizzle transaction = `SAVEPOINT`**; a 23505 on `social_identities_owner_uq` ⇒ drizzle issues `ROLLBACK TO SAVEPOINT`, the winner is re-read and the collision branch runs in the same (still usable) transaction: caller's row `connected_verified / unverified` + `evidence.ownership_collision`, one proposed `identity_claims { proof: verified_social_ownership, note: { accountId, platform, claimantAthleteId, connectedAccountId } }` (idempotent), owner untouched, connection untouched, outcome `collision`, ingest continues. No user to attribute ⇒ evidence only (logged). Release only when the owner's row is superseded (3c) |
| scripts | `scripts/backfillIdentityUsers.ts` (dry-run / `--apply` / `--revert`), `scripts/checkIdentityCollisions.ts` (read-only P1–P5), `scripts/identityReadShadow.ts` (I1) over the pure planner `identity/backfill.ts` | the apply refuses while a P1–P3 blocker exists; runs only after 0051 is on dev (they select the new tables/column) |
| tests | `identity/users.test.ts`, `link.test.ts`, `ownership.test.ts`, `state.test.ts`, `backfill.test.ts`, `ownershipGuard.test.ts`, `index.test.ts` (0051 applied after 0048; membership-only athlete ⇒ `has_user` true / `claimability` none; 25 columns), `lib/auth.membership.test.ts` (CI step 1) | `ownership.test.ts` forces the D-13 path deterministically: a hook after the owner read inserts the competing active owner, so the caller's active write raises the 23505 mid-flight — the test asserts no error surfaces, one active owner, one proposed claim, the caller's row `unverified`, and that the transaction stayed usable after the savepoint rollback. PGlite is one session, so a true two-connection race cannot be reproduced there; the `Promise.all` case proves both callers resolve with one `owner` + one `collision` |

Local results: `tsc` clean; CI step 1 44 suites / 400 tests; CI step 2 16 suites / 163 tests.

Dev evidence (read-only, 11 Sep 2026, dev 127.0.0.1:5440 only):

| Check | Result |
|---|---|
| 0051 per-file `BEGIN … ROLLBACK` on dev | 4 tables, 8 indexes, the column, the view created; 25 view columns; after `ROLLBACK` 0 of the tables, 0 of the index, view unchanged |
| P1 uid on >1 athlete | 0 |
| P2 provider mismatches | 0 (14 athletes with `auth_id`, all `firebase`) |
| P3 active `connected_verified` owners per account >1 | 0 rows |
| P4 `connected_accounts` collisions | 0 rows |
| P5 `account_roles` on athletes without `auth_id` | 1 (reported, left in place) |
| expected backfill | 14 users / 14 memberships / 14 user_roles / 5 connections attributed |
| I6 provider uid inside `athlete_index_matches` | 0 |

Deviations from the approved plan: none in scope. Two implementation details worth naming: (1) the shared upsert body moved from `ensureIdentity` into `social/identityRow.ts` so `identity/ownership.ts` can be the only writer of an active `connected_verified` row without a circular import; (2) `requireAdmin` with the read flag on also sets `req.userId` for a user with no membership (admin access never depended on an athlete row).

Not done in this PR (each a separate decision): deploy to dev, `backfillIdentityUsers --apply`, `identityReadShadow`, `IDENTITY_MEMBERSHIP_SHADOW=true`, `IDENTITY_MEMBERSHIP_READ=true`, 3b / 3c / 3d, the `hasAssertedAffiliations` fix, production.

### 8. Merge, deploy, backfill and the post-apply evidence gate (dev, 11–12 Sep 2026)

| # | Item | Result |
|---|---|---|
| 1 | Code review | #426 approved at exact head b421279 (after one review fix: the self-membership INSERT recovers through a savepoint, commit b421279); `checks` green on that head |
| 2 | Merge | squash-merged with the head guard as **d114d4a4a709f60338411c541f8620c0e86593c6**; #423 / #424 / #425 closed as superseded (their content landed through #426; only status/tracker lines were replaced) |
| 3 | Deploy to dev (normal path, run 34663033314) | success; migration step ran 0031–0051 (0031–0050 all "already exists, skipping"; 0051 applied first time); drift gate "No drift"; serving revision **nomila-v2-00582-2sl** at 100 % |
| 4 | 0051 on dev | tables `users`, `athlete_users`, `identity_claims`, `user_roles`; indexes `social_identities_owner_uq`, `athlete_users_one_self_uq`, `athlete_users_active_uq`, `users_email_lower_idx`; `connected_accounts.connected_by_user_id`; `athlete_index_v` reads `athlete_users`, 25 columns. Ledger unchanged (13 journal rows; hand files have none: schema present, not recorded) |
| 5 | Flags on the new revision | env diff previous → new revision: ONLY `IDENTITY_MEMBERSHIP_READ='false'` and `IDENTITY_MEMBERSHIP_SHADOW='false'` added; `CANONICAL_CONTEXT_READERS` present and empty, `CONTEXT_SHADOW=false`, `ATHLETE_INDEX_CLAIM=false`, `RESEARCH_SUBSTRATE_WRITE=false`, `RESEARCH_REFRESH_ENABLED=false`, `SOCIAL_SUBSTRATE_WRITE=true`, `SOCIAL_STORIES_WRITE=true`, `MILA_AGENT_V2=true` unchanged |
| 6 | Pre-flight (read-only, before apply) | athletes 24, with `auth_id` 14 (all firebase), active owners 3, active connections 5; P1 0 · P2 0 · P3 0 · P4 0 · P5 1 (athlete `8b3befbd…`, role athlete; reported, left in place); `identity_claims` 0; no blockers |
| 7 | Backfill dry-run | plan users 14 / memberships 14 / roles 14 / connections 5; nothing written |
| 8 | **Backfill `--apply` (dev only, approved)** | `APPLIED: users total=14 memberships inserted=14 roles attempted=14 connections attributed=5` |
| 9 | Rows after apply | `users` 14 (all firebase, all `email_verified=false`, P-2) · `athlete_users` 14, all `proof=existing_auth, note=backfill` (P-1) · `user_roles` 14 · `connected_accounts.connected_by_user_id NOT NULL` 5 · `identity_claims` 0 · `account_roles` 15 (the orphan `8b3befbd… / athlete` still present with no `user_roles` counterpart, P-3) |
| 10 | Parity | 14 athletes with `auth_id` ⇒ 14 matching `users` rows ⇒ 14 matching self-memberships; the 10 athletes without `auth_id` have 0 memberships |
| 11 | Second dry-run (idempotency) | `users=0 memberships=0 connections=0 skipped={usersExisting:14, membershipsExisting:14}`; nothing written. The planner reports `roles=14` because it does not consult existing `user_roles` (they are inserted `ON CONFLICT DO NOTHING`): SQL confirms all 14 planned (user, role) pairs already exist — 0 missing — so a re-apply writes zero rows. Reporting nit noted below |
| 12 | P1–P5 + ownership after apply | P1 0 · P2 0 · P3 0 · P4 0 · P5 1; `identity_claims` 0; one active `connected_verified` owner per account: 3 active rows over 3 distinct accounts, 0 duplicates |
| 13 | I1 `identityReadShadow` | athletes with `auth_id` = 14: **equal 14**, missingUser 0, noMembership 0, ambiguous 0, different 0. The other 10 athletes have no `auth_id` and, by construction, no membership — the §3.2 rule answers 401 for them exactly as the legacy lookup does |
| 14 | Athlete Index before / after | `athlete_id, full_name, has_user, claimability, connection_status, is_golden_anchor, athlete_status` for all 24 rows: **0 diff lines**; `has_user` 14, `claimability='none'` 19, 24 rows — identical before and after (the backfilled memberships mirror the projection) |
| 15 | I6 leakage | no `users.provider_uid` value appears in `athlete_index_matches.query / candidates` (0); no view column named like auth/uid/provider (0) |
| 16 | G9 digest | overall **0bd3f1dbf5494ac47d41ff9f2396cebd091628a26087e99210bc76e932792b1a** (24 athletes) — byte-identical to the 2d-6 baseline |
| 17 | Full 2d read-only shadow | record 24/24 · deck 10/10 (14 skipped, no `athletes_current` row) · onboarding 24/24 · identity 24/24 · search 24/24 · admin 24/24 — zero differences |
| 18 | Production | untouched; revision `nomila-v2-prod-00001-zcv` serving 100 % |

Nothing else changed: `IDENTITY_MEMBERSHIP_READ=false`, `IDENTITY_MEMBERSHIP_SHADOW=false`, no reader listed, `CONTEXT_SHADOW=false`; 3b / 3c / 3d not started.

Reporting nit (not a defect): `planIdentityBackfill` receives existing users and memberships but not existing `user_roles`, so a second dry-run prints `roles=14` for pairs that already exist. A one-line planner input (existing `user_roles`) would print 0; left for a later tidy-up PR, not bundled here.

**3a implementation / backfill closed cleanly on dev on 12 Sep 2026.** Migration 0051 and the backfill were applied; I1 (identityReadShadow 14/14), I3b (one active owner per account, 0 claims), I4 (Athlete Index before/after 0 diff), I6 (0 provider-uid leaks), I7 (flags: only the two identity flags added, both false at this point; no reader listed), G9 (digest byte-identical) and the full 2d parity (all readers equal) were clean. The subsequently approved membership shadow and READ rollouts are recorded in §9. Production is untouched.

### 9. Rollout on dev — step 1 (membership shadow) and step 2 (membership READ cutover), 12 Sep 2026

Each step was its own approved, dev-only YAML PR (no code, no migration, no other flag or reader; `cloud-run-prod.yaml` untouched with both identity flags "false"). Both were exercised with the same 14 dev users (every athlete with an `auth_id`) over the same authenticated GET routes: `/auth/me`, `/me/record`, `/me/deals`, `/me/deals/counts`, `/me/connections`, `/me/connect/status`, `/me/conversations`, `/me/media`, `/me/analytics`, `/me/inbox/threads`, `/me/pending-actions`, `/me/agent-actions/counts`, `/me/search`, plus `/me/studio/content` (404 from the `STUDIO_ENABLED` gate, which runs before `requireAuth`). Tokens: firebase-admin custom tokens for the dev uids exchanged for ID tokens; the one-off exercise scripts were local and deleted.

**Step 1 — `IDENTITY_MEMBERSHIP_SHADOW=true`, READ off** (PR #428 approved at 1f72af6, CI pass; merge bb988fd; deploy run 34666192029; revision nomila-v2-00584-92d; env diff vs 00582-2sl: only the shadow flag)

| Check | Result |
|---|---|
| requests | 196, 0 5xx; 182 × 200 + 14 × 404 (Studio gate) |
| legacy path authoritative | every `/auth/me` returned the `athletes.auth_id` athlete (0 mismatches); `req.userId` never set |
| `identity_membership_read` events | 182 (14 users × 13 routes behind `requireAuth`), all on 00584-92d; baseline before the revision 0 |
| `agrees` | true 182 · false 0 · `userFound` 182 · exactly one membership in every event · `X-Athlete-Id` present 0 |
| shadow exceptions | 0 ("identity membership shadow failed" never logged); the only WARNING lines were Cloud Run request logs for the 14 Studio 404s |

**Step 2 — `IDENTITY_MEMBERSHIP_READ=true`, `IDENTITY_MEMBERSHIP_SHADOW=false`** (PR #429 approved at 1c31aee, CI pass; merge f6fe97d; deploy run 34668364722; revision nomila-v2-00585-69p; env diff vs 00584-92d: only the two identity flags)

| Check | Result |
|---|---|
| requests | 238, 0 unexpected statuses; the 13 authenticated routes 200 for all 14 users; Studio 404 as before |
| athlete resolution | `/auth/me` id == the prior `athletes.auth_id` mapping for all 14 (0 mismatches) |
| additive `/auth/me` data | `user { id, provider: firebase, emailVerified: false }` and exactly one membership (`self` / `existing_auth`) naming the same athlete, for all 14 |
| `req.userId` | set on the membership path (the `user.id` in every response; the 403/409 shapes below are produced only by the membership selection, which sets it with `req.athleteId`) |
| foreign `X-Athlete-Id` | 403 `athlete_not_held` × 14; own `X-Athlete-Id` 200 × 14 |
| admin `/api/v1/admin/me` | 403 for all 14 normal users (dev has no admin row in `account_roles` or `user_roles`); a token carrying `roles: ["admin"]` for the x1 test account ⇒ 200, roles `["admin","athlete"]`, `openAccess: false` — behaviour unchanged |
| multi-membership (§3.2) | temporary fixture for the x1 test account (athlete `5c0aa36f-…`): one throwaway athlete `95e60f89-70c6-42d7-ba10-2b9471ff3c1a` + one self-membership (`note = rollout_step2_fixture`). No header ⇒ **409 `athlete_selection_required`** listing both ids; `/me/record` without header ⇒ 409 (never the first row); `X-Athlete-Id` = x1 ⇒ 200 with x1's id (2 memberships); `X-Athlete-Id` = fixture ⇒ 200 with the fixture id. Both rows deleted in `finally`; post-test query: 0 rows carry either fixture id, totals back to 24 athletes / 14 memberships, x1 has 1 active membership |
| 4xx on the revision (request logs) | 403 admin/me × 15 (14 users + the non-admin probe), 403 auth/me × 14 (foreign header), 404 Studio × 14, 409 × 2 (fixture) — every one expected; 0 ERROR lines; 0 shadow events (shadow off) |
| G9 / 2d after the cutover | digest **0bd3f1dbf5494ac47d41ff9f2396cebd091628a26087e99210bc76e932792b1a** (24 athletes), byte-identical; shadow record 24/24 · deck 10/10 (14 skipped) · onboarding 24/24 · identity 24/24 · search 24/24 · admin 24/24 |
| production | untouched: `nomila-v2-prod-00001-zcv` at 100 %, both identity flags "false" in `cloud-run-prod.yaml` |

**Dev identity state now:** `IDENTITY_MEMBERSHIP_READ=true` (authoritative: `requireAuth` / `requireAdmin` resolve the caller through `users` → `athlete_users` with the §3.2 selection rule), `IDENTITY_MEMBERSHIP_SHADOW=false`, `athletes.auth_id` still written as the compatibility projection for every legacy reader until 3d. **Step 3a — implementation + rollout — is COMPLETE ON DEV (12 Sep 2026).** Production: off and untouched. Next: 3b (claim lifecycle) — design / implementation plan first, reviewed before any code.

---

## 3b — the claim: implementation plan (from main at faf3a65; design §5, D-3, D-4, D-6, D-14; 2c matching/claim separation kept)

Status: **CLOSED ON DEV (12 Sep 2026) — as built §17, deployment §18.** Scope (locked, design §10): the claim lifecycle + "Is this you?" endpoint/screen; `human_confirmation` and the three new decisions; `verified_social_ownership` link when the other row has no self-member; onboarding v3 order; Microsoft verification fix (D-6); signup stage (3) retired behind the flag. **Out of 3b:** `athlete_duplicates` / merges / operator merge queue (3c, 0052→0053), membership-aware deletion (3c), retiring the projection (3d), typed handles/name/nickname as assertions (design row 11 — see P-9), any research/MIA change, production.

### What the athlete experiences, and what happens underneath

Today (flag off, live): she signs in, types her name and sport, and gets a profile — sometimes somebody else's (stage 2 links on an unverified e-mail match, stage 3 on a name substring). With `ATHLETE_INDEX_CLAIM` on (dark since 2c): the index is searched first, a unique verified e-mail links, everything else silently creates a new row and records `possible_duplicate`.

After 3b (flag on): she signs in, types her name and sport, and if the index finds her — a row research already built, or a waitlist row — she sees **"Is this you?"** with the distinguishing facts (sport, team, year, handles). If she says yes and we can *corroborate* it (her verified e-mail is that row's e-mail, or she has proven control of a social account that row is built on), she is linked and continues on that profile. If she says yes but nothing corroborates it, she continues on a **new** profile and an operator sees the pending claim (nobody takes over an existing profile on a click — D-14). If the row already belongs to someone, she gets a new profile and the pair goes to the duplicate queue (3c). If she says "none of these", she gets a new profile. Research runs **once, after** the profile is hers (Beta.1 §2 order, I9). Nothing about scoring, facts or research changes (G9).

Underneath: a `users` row (3a) is the person; the claim is an `identity_claims` row per candidate; the only thing that ever links her to a pre-existing row is a **proof** — `existing_auth`, `verified_unique_email`, `verified_social_ownership` (from a real OAuth) — or an operator; the membership records that proof and the confirming claim. `linkUserToAthlete` (3a) is still the single writer of a membership, and the membership READ path (authoritative on dev) resolves every later request.

### Dev facts the plan is written against (read-only, 12 Sep 2026)

| Fact | Dev |
|---|---|
| `ATHLETE_INDEX_CLAIM` | `false` both environments; `POST /api/v1/index/candidates` (requireFirebaseUser, dark) is the only live index endpoint |
| `identity_claims` | 0 rows; the only writer is §3a-C (connect collisions) |
| athletes / memberships | 24 / 14 (one self each, all `existing_auth`); 10 unclaimed rows (index claimability: 1 `open`, 4 `review`, 5 `none` = golden anchors) |
| onboarding | runs start on definition v2 at signup create (`routes/auth.ts:123,225`, `waitlist.ts:284`, admin promote); order research → context_ready → greet → doors → wrap |
| `athlete_index_matches.decision` | CHECK `('linked_by_auth','linked_by_verified_email','possible_duplicate','new')` (0048) — **the design's new decisions do not fit without a constraint change (P-5)** |
| client | `client/lib/auth-context.tsx` posts `/auth/signup {name, role, sport, school}` from the sign-in/setup flow; no "Is this you?" screen; no `X-Athlete-Id` handling (never needed yet: every dev user holds one membership) |

### 1. Entry points into the claim

| # | Entry | Today (flag on, dark) | 3b |
|---|---|---|---|
| E1 | app signup `POST /auth/signup` (Firebase token, no membership yet) | `resolveIdentity`: `existing_auth` ⇒ return; `verified_unique_email` ⇒ link; else create + record | **existing / verified e-mail unchanged.** Tier `auto_match` / `candidate` ⇒ the request returns **409 `confirmation_required`** with the proposed claims (the client shows "Is this you?"); the client returns after the user decided (`claimSessionId`) and the same endpoint creates the new row or returns the linked one (§3). Tier `new` ⇒ create, membership proof `human_confirmation` (P-6). Stage (2)/(3) silent links are dead on this path already; with the flag on they are never reached |
| E2 | Microsoft `POST /auth/microsoft` | as E1 with `emailVerified = !!msProfile.mail` | as E1; **D-6:** `emailVerified = false` unless the provider asserts it (Graph does not) ⇒ Microsoft never yields `verified_unique_email` in 3b |
| E3 | waitlist steps `POST /waitlist/...` (name/sport first) | `resolveIdentity` on the first step | same lifecycle through the same module: the step that first carries name + sport returns 409 `confirmation_required` when the tier is `auto_match`/`candidate`; the waitlist client shows the same screen; later steps upsert the athlete's own row exactly as today |
| E4 | connect collision (§3a-C, live since 3a) | proposed `verified_social_ownership` claim against the owner row | **confirmable** (§3, row 4): the claimant confirms ⇒ link to the owner row when it has no self-member; with a self-member the claim stays `proposed` for 3c |
| E5 | operator | — | `GET /admin/identity/claims?status=` (queue; shows the claimant's provider, e-mail and email_verified) and `POST /admin/identity/claims/:id/decide` (confirm / reject with a note). **Confirm when the claimant already holds another row** (an `auth_id` projection or an active self-membership elsewhere — every legacy name-match proposal, and an "Is this you?" claim whose user continued on a new row) **never links**: 409 `manual_merge_required` with `heldBy` and an operator message; the claim stays `proposed` (out of the 7-day expiry). See *Manual merge* below |
| E6 | `/index/candidates` (dark) | live lookup, no state | unchanged (read-only; the client may call it before the proposal for a preview); the proposal itself goes through E1/E3 so every claim row carries the path and the match telemetry |

Everything a user does before a membership exists runs behind `requireFirebaseUser` (2c); everything after runs behind `requireAuth` (membership READ, 3a). No endpoint accepts an athlete id from the caller as authority — a claim id is the only handle, and it is bound to the caller's user.

### 2. Candidate vs auto-match vs new, and why confirmation is not proof

2c's separation is kept verbatim: `findCandidates` answers *which row is this probably* (tier `auto_match` | `candidate` | `new`; minimum-evidence rule; a name never auto-matches; an ambiguous identifier caps at `candidate`); `claimProofFor` answers *what the caller has proven*. 3b adds the human step **between** them and refuses to let it become proof:

- **`auto_match`** — the strongest public evidence (open claimability, unique identifier). Still not proof: an auto-match is shown as the first candidate, pre-selected in the UI, and confirmed the same way as any candidate. Nothing links on the tier.
- **`candidate`** — shown as a list (≤ 5) with distinguishing facts; the user picks one or "none of these".
- **`new`** — no list; the row is created; membership proof `human_confirmation` on the row she creates (D-14: a new row cannot be anyone else's).
- **Why confirmation ≠ ownership (D-14):** "yes, that's me" asserts identity; it does not demonstrate control of anything the row is built on. A click could claim any public profile the index shows. So `human_confirmation` alone establishes membership only on a row created in the same flow; a pre-existing indexed row needs a corroborating proof or an operator.

### 3. Proofs and the claim authorization matrix (design §4.1 / §5, extended not changed)

| Situation at confirm time (candidate row R, caller user U) | Corroboration | Result | Membership proof | Claim status / decided_by | `athlete_index_matches.decision` |
|---|---|---|---|---|---|
| R.auth_id == U.uid (grandfathered) | `existing_auth` | already hers; idempotent | — | `confirmed` / system | `linked_by_auth` (unchanged) |
| U's provider e-mail is verified, equals R.email, unique among unclaimed rows, R has no self-member | `verified_unique_email` | link | `verified_unique_email` | `confirmed` / user (or system when the resolver linked before any UI) | `linked_by_verified_email` (unchanged) |
| U holds a `proposed` `verified_social_ownership` claim against R (§3a-C) and R has no self-member | `verified_social_ownership` | link | `verified_social_ownership` | `confirmed` / user | **`linked_by_ownership`** (new) |
| R has no self-member, nothing corroborates | none | **no link**; claim stays for an operator; U continues on a NEW row | `human_confirmation` on the new row (note `created_after_claim:<claimId>`) | `proposed` (operator queue) | `possible_duplicate` (unchanged) |
| operator confirms a `proposed` claim, R has no self-member | operator approval | link | `human_confirmation` (claim_id set, claim `decided_by = operator`) | `confirmed` / operator | **`linked_by_operator`** (new) |
| R HAS a self-member (anyone's, including U's other row) | — | never a link, never a merge (D-3) | — | `rejected` / system, note `{reason: "self_member_exists", pair: [R, U's row]}` | `possible_duplicate` |
| golden anchor | — | never linkable (2c) | — | `rejected` / system | `possible_duplicate` |
| "none of these" | — | create the new row | `human_confirmation` | every proposed claim of the session `expired` / user | `new` |
| tier `new` | — | create | `human_confirmation` | (no claim rows) | `new` |

Rules held by code, not by callers: `LINKING_PROOFS` stays `existing_auth | verified_unique_email | human_confirmation` **plus** `verified_social_ownership` (3b enables it — the 2c comment "its link is a merge (Step 3)" resolves per D-4); `proofMayLink` is checked inside `linkUserToAthlete`; `human_confirmation` may be passed to `linkUserToAthlete` **only** with a `claimId` whose claim is `decided_by = operator`, or for a row created in the same transaction (the `createAthleteForUser` helper) — the module refuses it otherwise (`ClaimNotAuthorized`), so no route can turn a click into a link. `decide()` gains the three new outputs (pure, tested). **`linked_by_confirmation`** from the design is realised as the proof-specific decisions above (`linked_by_verified_email` / `linked_by_ownership` / `linked_by_operator`), so the telemetry says *which* corroboration linked — P-7 asks whether to keep the umbrella name too.

### 4. `identity_claims` lifecycle

```
proposed ──(user confirms + corroboration)──► confirmed  (decided_by user)
proposed ──(resolver linked on verified e-mail before any UI)─► confirmed (decided_by system)
proposed ──(operator confirm)──► confirmed (decided_by operator)      proposed ──(operator reject)──► rejected (operator)
proposed ──(row has a self-member at confirm)──► rejected (system, reason self_member_exists)
proposed ──("none of these" / user dismisses)──► expired (user)
proposed ──(7 days; sweep or lazy check at confirm)──► expired (system)
proposed ──(a newer proposal for the same (user, athlete) supersedes)──► superseded (system)
```
Invariants: **candidate flow — at most one active `proposed` claim per `(user_id, athlete_id, claim_session_id)`** (enforced by a partial unique index, 0052; a repeated proposal inside the same session is a no-op, a new interaction is a new session); **social-account collision flow (§3a-C) — kept separate:** at most one `proposed` `verified_social_ownership` claim per `(user_id, athlete_id, note.accountId)`, `claim_session_id` NULL (the rule 3a already enforces in code); a `rejected` claim on a pair blocks re-proposal of that pair for that user (design §5) — the queue is the operator's; a claim never changes an athlete row; a `confirmed` claim always has exactly one membership referencing it (`athlete_users.claim_id`); every row carries `proposed_at`, `decided_at`, `decided_by`, `match_id` (per-claim provenance: the `athlete_index_matches` row the candidate came from — telemetry, never workflow state), `claim_session_id` (workflow state: one UUID minted by the claim service per candidate-selection interaction, identical on every claim proposed in that interaction; NULL for collision claims) and a `note` `{ path, tier, matchScore, reason?, pair? }` (I6 audit). Expiry: lazy at confirm (a stale claim answers 410 `claim_expired`) plus a sweep in the existing `archive-stale-cron` handler (P-8).

### 5. How `linkUserToAthlete` is invoked (the only membership writer, unchanged signature + one new option)

| Caller | Proof | claimId | Where |
|---|---|---|---|
| `resolveIdentity` (verified e-mail, as today) | `verified_unique_email` | the claim the resolver creates as `confirmed`/system | `identity/resolve.ts` |
| `confirmClaim` (user) | the corroborating proof | the confirmed claim | `identity/claims.ts` (new) |
| `decideClaim` (operator confirm) | `human_confirmation` | the claim (`decided_by = operator`) | `identity/claims.ts` |
| `createAthleteForUser` (new row in the flow) | `human_confirmation` | none (note `created:<path>` / `created_after_claim:<id>`) | `identity/claims.ts`, called by the signup/waitlist/microsoft creates when the flag is on |
| legacy paths (flag off) | `existing_auth` via `grandfatherMembership` | — | unchanged (3a) |

`linkUserToAthlete` gains one guard: `human_confirmation` is accepted only when `extra.claimId` names an operator-decided claim or `extra.createdInFlow === true` (set only by `createAthleteForUser` inside its own transaction). Dual-write, the savepoint recovery, the projection and `ClaimNotAuthorized` semantics are untouched.

### 6. Duplicate risk — where 3b stops (3c owns resolution)

3b **records**, never resolves: (a) a confirm against a row with a self-member ⇒ claim `rejected`/system with the pair in `note`; (b) a corroborated ownership link that leaves U with two self-memberships (her created row + the owner row) — allowed by D-2, resolved by 3c; (c) an operator-pending claim beside a new row. A read-only `scripts/listDuplicateRisks.ts` enumerates (a)–(c) plus the §3a-C `unverified` identities so 3c's detector starts from a list, not from scratch. **No `athlete_duplicates` rows, no merge, no revocation, no `merged_into`** — those are 0053 (3c). If a 3b flow would need any of them to be correct, the flow returns the pending state instead (409/202 with the claim id) rather than guessing.

### 7. Collision behaviour for already-owned athletes and social accounts

- **Athlete with a self-member:** never linkable in 3b by anyone but its member: claims against it are rejected/system (§3 row 6); the requester always continues on her own row.
- **Social account owned elsewhere (active `connected_verified` on another athlete):** §3a-C stays the runtime rule: the caller's OAuth completes, her identity row is `unverified`, one proposed `verified_social_ownership` claim. 3b makes that claim **confirmable** (E4): owner row without a self-member ⇒ link (`linked_by_ownership`), and her `unverified` identity row is left as is (the account keeps exactly one active owner — the row she now holds a membership on); with a self-member ⇒ the claim stays `proposed` (3c). `byUserId` for the claim now comes from `connected_accounts.connected_by_user_id` (3a column; **MODIFY**: substrate/stories ingest pass it to `ensureIdentity`; today it falls back to `selfUserOf`).
- **Verified e-mail matching a row with a self-member:** proposed claim `proof: none` rejected/system with the pair (design §4.2) — a support case, never a link.

### 8. Onboarding v3 (`ONBOARDING_V3`, new flag, off both environments)

Definition `ONBOARDING_V3 = defineWorkflow({ process: "onboarding", version: 3 })` = v2 with one leading `code` step `identity_confirmed` that requires an active self-membership on the run's athlete (else the run fails fast — research never runs for an unconfirmed candidate, I9) and the same research → context_ready → greet → doors → wrap. New runs start on v3 only when the flag is on; running v1/v2 runs finish as they are. The claim flow starts the run **after** the membership exists (E1/E3 create or link), so "identify → confirm → research once" holds by construction; `greet` keeps confirming *facts*, not identity. No change to the runner, the tools or Mila.

### 9. Onboarding v3 route / API changes (server, additive; flag-gated)

| Endpoint | Guard | Behaviour |
|---|---|---|
| `POST /auth/signup` (existing) | Firebase token | flag on: may answer **409 `{ error: "confirmation_required", claimSessionId, tier, claims: [{ claimId, candidate: publicCandidate }] }`** — `claimSessionId` is the UUID the claim service generated for this interaction; the retry sends it back, and the server treats it only as *which session's decisions to read* (every claim in it must belong to the caller's user; the session decides nothing by itself — the recorded decisions and proofs do); response shape otherwise unchanged (`{ id, role, status, claimed }`) |
| `POST /waitlist/...` first step (existing) | Firebase token | same 409 contract |
| `POST /identity/claims/:id/confirm` (new) | `requireFirebaseUser`; body `{ claimSessionId }`; the claim must belong to the caller's user AND carry that `claim_session_id` (else 404 — no existence leak) | §3 matrix ⇒ `{ outcome: "linked" \| "pending_operator" \| "taken" \| "expired", athleteId? }` |
| `POST /identity/claims/session/:claimSessionId/dismiss` (new) | `requireFirebaseUser` | "none of these": expires every `proposed` claim of the caller's user in that session (scoped by `user_id` + `claim_session_id`; another user's session id does nothing) |
| `GET /identity/claims/mine` (new) | `requireFirebaseUser` | the caller's non-final claims **grouped by `claim_session_id`** (client resume after a restart: the newest session is the one to show) |
| `GET /admin/identity/claims?status=proposed` · `POST /admin/identity/claims/:id/decide` (new) | `requireAdmin` | operator queue; decide `{ decision: "confirm" \| "reject", note }`; confirm ⇒ `{ outcome: "linked" }`, or 409 `manual_merge_required` `{ athleteId, heldBy, message }` when the claimant already holds another row |

`claimSessionId` = `identity_claims.claim_session_id`, a UUID generated by the claim service per candidate-selection interaction and written on every claim it proposes (`gen_random_uuid()`; never derived from a match row, a user, or an athlete). Match telemetry (`athlete_index_matches`) and claim workflow state are different concerns: `match_id` stays the per-claim provenance to the corresponding match row; the session groups the claims a user was shown together. **No athlete id supplied by the client ever becomes authority** — the only client-supplied handles are a claim id and a session id, both validated against the caller's user; the athlete comes from the claim row. Client (behind `EXPO_PUBLIC_IDENTITY_CLAIM`, default off): the setup step in `auth-context` handles 409 `confirmation_required` by rendering an "Is this you?" screen (candidate cards with sport / team / year / handles, "That's me" / "None of these"), calls confirm/dismiss, then retries signup with the session id; on `pending_operator` it shows "we'll check this and let you know" and continues on the new profile. Reviewed with Mia on dev before the server flag is listed (I8).

### 10. Compatibility with the membership READ path (authoritative on dev)

- Claim endpoints run before a membership exists ⇒ `requireFirebaseUser` only; after link/create the very next `requireAuth` request resolves through the membership (the projection is still written, so a flag-off environment behaves as before).
- A user with **two** self-memberships (ownership link, §7) gets 409 `athlete_selection_required` from `requireAuth` until the client sends `X-Athlete-Id`. 3b client scope: `auth-context` stores the selected athlete (the one she just confirmed/created) and sends the header on every request; the 409 body lists the held ids; no picker UI beyond "which profile?" with the memberships from `/auth/me` (P-10). Never the first row (D-2).
- `/auth/me` already returns `user` + `memberships` (3a); 3b adds `pendingClaims: n` (additive).
- `requireAdmin` unchanged.

### 11. Flags and staged rollout (each step a separate user decision)

| Flag | Default | Meaning |
|---|---|---|
| `ATHLETE_INDEX_CLAIM` (existing) | `false` both | the claim lifecycle switch: off ⇒ every path byte-for-byte as today (stage 2/3 included); on ⇒ E1–E5 |
| `ONBOARDING_V3` (new) | `false` both | new onboarding runs start on v3 (identity guard first) |
| `EXPO_PUBLIC_IDENTITY_CLAIM` (client, new) | off | renders "Is this you?" and the header handling; a client without it that meets a 409 shows the generic setup error (no silent create) |
| `IDENTITY_MEMBERSHIP_READ` / `_SHADOW` | unchanged (dev true/false, prod false/false) | — |

Rollout after merge: (c) `ATHLETE_INDEX_CLAIM=true` on dev after I2/I8 evidence (with the client flag for the dev build); (d) `ONBOARDING_V3=true` on dev after I9; (e) prod per flag, later, on the user's word. Stage (3) of the legacy signup path is **deleted only when the flag is on in prod** (design row 7) — not in 3b.

### 12. Migrations

- **0052 `identity_claims` claim session + `athlete_index_matches` decisions** (deviation from the design's "none", surfaced as **P-5**, approved in principle): (1) `ALTER TABLE identity_claims ADD COLUMN IF NOT EXISTS claim_session_id uuid NULL;` (2) `CREATE INDEX IF NOT EXISTS identity_claims_user_session_idx ON identity_claims (user_id, claim_session_id, status);` (lookup by user / session / status: confirm, dismiss, resume); (3) `CREATE UNIQUE INDEX IF NOT EXISTS identity_claims_session_proposed_uq ON identity_claims (user_id, athlete_id, claim_session_id) WHERE status = 'proposed' AND claim_session_id IS NOT NULL;` (the candidate-flow idempotency invariant, §4); (4) `ALTER TABLE athlete_index_matches DROP CONSTRAINT IF EXISTS athlete_index_matches_decision_check; ALTER TABLE athlete_index_matches ADD CONSTRAINT athlete_index_matches_decision_check CHECK (decision IN ('linked_by_auth','linked_by_verified_email','linked_by_ownership','linked_by_operator','possible_duplicate','new'));` — the 0047 DROP-then-ADD pattern. All additive and idempotent; no transaction control; no data change (existing rows keep `claim_session_id` NULL — the §3a-C collision claims never carry a session); `schema.ts` mirrors all four; `migrationsGuard` clean; dry-run per file on dev. The 3c tables move to **0053**. Nothing else: `athlete_users` and `users` already carry every column 3b writes.

### 13. Tests, invariants, observability, acceptance gates

- **Pure:** `claim.test.ts` extended — `decide()` new outputs; `human_confirmation` never links a pre-existing row without operator/claim context; `verified_social_ownership` now in `LINKING_PROOFS`.
- **`identity/claims.test.ts` (new, PGlite, 0048+0051+0052 applied):** propose (one session UUID per interaction on every claim; one claim per candidate with its own `match_id`; re-proposing inside the session is a no-op via the partial unique; a new interaction is a new session); confirm with verified e-mail ⇒ linked + membership proof/claim_id; confirm with §3a-C ownership claim ⇒ `linked_by_ownership`, one active owner unchanged; confirm without corroboration ⇒ `pending_operator`, new row on `human_confirmation`, claim still `proposed`; confirm a row with a self-member ⇒ `rejected` + pair note, no membership; golden anchor ⇒ rejected; confirm with a claim of another user, or with the wrong session id ⇒ 404 and nothing changes; dismiss expires only the caller's claims in that session; resume groups by session; a client-supplied athlete id is ignored everywhere (the athlete always comes from the claim row); dismiss ⇒ expired; 7-day lazy expiry ⇒ 410; operator confirm ⇒ `linked_by_operator`; operator confirm on a taken row ⇒ refused; concurrency: two users confirming the same open row with corroboration ⇒ one membership (3a guard), the other `taken`; the regression roster from 2c (lookalikes, shared handle, same name/sport) never links (I2).
- **Routes:** `routes/auth.signup.claim.test.ts` (flag off byte-for-byte incl. stage 2/3; flag on 409 contract, retry with session id, D-6 Microsoft), `routes/identityClaims.test.ts` (auth binding: a claim of another user ⇒ 404; requireFirebaseUser only), `routes/admin.claims.test.ts`.
- **Workflow:** `definitions.test.ts` — v3 identity guard fails fast without a membership; v2 untouched; `startRun` version selection by flag.
- **Guards:** `ownershipGuard.test.ts` — writers of `identity_claims` still only `identity/**` (routes call module functions); no route reads `users.provider_uid`; `linkUserToAthlete` remains the only `athlete_users` inserter besides `grandfatherMembership`; intelligence boundary unchanged; `migrationsGuard` 52/52.
- **Observability:** one structured log per claim transition `{ claim: "identity_claim", claimId, userId, athleteId, from, to, decidedBy, proof, decision, path }`; a counter-style daily line from the sweep; `/admin/identity/claims` as the operator view. No uid in any log (I6).
- **Gates (design §11):** I2 no silent link · I3 no silent merge / takeover · I3b one owner per account (unchanged) · I6 audit · I7 boundary · I8 client review with Mia on dev · I9 Beta.1 order; plus G9 digest byte-identical and full 2d shadow equal after the deploy (the claim writes no fact, no affiliation, no feature). CI: both jest steps green; `tsc` clean.

### 14. KEEP / MODIFY / ADD / DEFER (current → 3b)

| # | Item | Today | 3b | Class |
|---|---|---|---|---|
| 1 | `findCandidates`, tiers, `publicCandidate`, `/index/candidates`, `athlete_index_matches` telemetry, golden anchors | 2c | unchanged | KEEP |
| 2 | `claimProofFor` | pure | unchanged | KEEP |
| 3 | `decide` / `MATCH_DECISIONS` / `LINKING_PROOFS` | 4 decisions; `verified_social_ownership` non-linking | + `linked_by_ownership`, `linked_by_operator`; `verified_social_ownership` linking (D-4) | MODIFY |
| 4 | `resolveIdentity` | link on verified e-mail else create | + writes the confirmed/system claim on the e-mail link; returns `action: "confirm"` with proposed claims for `auto_match`/`candidate` (the callers turn it into 409) | MODIFY |
| 5 | `linkUserToAthlete` | 3a dual-write | + `human_confirmation` guard (operator claim or created-in-flow only); otherwise unchanged | MODIFY |
| 6 | `identity/claims.ts` — `proposeClaims`, `confirmClaim`, `dismissSession`, `decideClaim`, `createAthleteForUser`, `expireStale` | — | the lifecycle; the only writer of `identity_claims` transitions | ADD |
| 7 | `routes/auth.ts` signup + microsoft (flag on) | A′ | 409 contract; creates via `createAthleteForUser`; D-6 `emailVerified=false` for Microsoft | MODIFY (flag-off branches byte-for-byte) |
| 8 | `routes/waitlist.ts` (flag on) | A′ | same 409 contract on the first name+sport step | MODIFY |
| 9 | `routes/identityClaims.ts` + `/admin/identity/claims` | — | E1–E5 endpoints | ADD |
| 10 | `social/substrate.ts`, `stories.ts` ingest → `ensureIdentity` | no `byUserId` | pass `connected_by_user_id` | MODIFY (narrow) |
| 11 | `workflow/definitions/onboarding.ts` | v2 | + v3 (identity guard); start on v3 behind `ONBOARDING_V3` | ADD / MODIFY |
| 12 | `archive-stale-cron` handler | — | + `expireStale()` call | MODIFY (narrow) |
| 13 | client `auth-context` + "Is this you?" screen + `X-Athlete-Id` | one athlete per session | behind `EXPO_PUBLIC_IDENTITY_CLAIM` | ADD |
| 14 | `/auth/me` | 3a fields | + `pendingClaims` | MODIFY (additive) |
| 15 | migration 0052 (`identity_claims.claim_session_id` + lookup index + session-scoped partial unique; decision CHECK) | — | P-5 | ADD |
| 16 | legacy signup stages (2)/(3), flag off | live | untouched in 3b; deleted when the flag is on in prod | DEFER (3b-rollout) |
| 17 | typed handles / name / nickname as assertions (design row 11) | `athletes.socials` / `full_name` | **DEFER** to its own PR after 3b: it is the assertion-writer's projection contract (D-5), not the claim lifecycle; bundling it would widen 3b's diff into the research/context boundary (P-9) | DEFER |
| 18 | `athlete_duplicates`, merges, operator merge queue, membership-aware deletion, `merged_into` | — | 3c (0053) | DEFER |
| 19 | retiring `auth_id` readers / projection | — | 3d | DEFER |

### 15. Open points for this review (choices the locked design leaves to implementation)

| # | Point | Proposal |
|---|---|---|
| P-5 | The design says 3b has no migration, but `athlete_index_matches_decision_check` (0048) rejects the new decisions, and the claim workflow needs its own session key (review: never `athlete_index_matches.id`) | **approved in principle:** migration **0052** = `identity_claims.claim_session_id uuid NULL` + `(user_id, claim_session_id, status)` index + partial unique `(user_id, athlete_id, claim_session_id) WHERE status='proposed'` + the decision CHECK DROP/ADD; 3c's tables become 0053 |
| P-6 | Membership proof on a row **created** in the flag-on flow | `human_confirmation` (D-14: a new row cannot be anyone else's), note `created:<path>`; the flag-off creates keep `existing_auth` (3a P-1) |
| P-7 | `linked_by_confirmation` (design §5) vs proof-specific decisions | record the proof-specific decision (`linked_by_verified_email` / `linked_by_ownership` / `linked_by_operator`); no umbrella value |
| P-8 | Claim expiry | 7 days; lazy at confirm (410) + sweep in `archive-stale-cron`; no new cron |
| P-9 | Typed handles / name / nickname as assertions (design row 11, listed under 3b) | defer to its own narrow PR right after 3b (assertion-writer projection; touches research/context, not identity) |
| P-10 | Client scope for `X-Athlete-Id` | store-and-send from `auth-context` + a minimal "which profile?" choice from `/auth/me.memberships`; no profile switcher UI in 3b |
| P-11 | Operator confirm proof | membership `proof = human_confirmation`, `claim_id` set, claim `decided_by = operator` (D-14 wording); decision `linked_by_operator` |

### 16. Evidence plan (after the code PR, each on the user's word)

Per-file 0052 dry-run on dev; both CI steps; I2/I3 regression roster in PGlite; on dev with the flag still off: G9 digest + full 2d shadow unchanged, `identity_claims` still 0, every existing route byte-for-byte (the 14-user exercise from 3a re-run); then, as separate rollout decisions: `ATHLETE_INDEX_CLAIM=true` on dev + client flag in a dev build → a scripted walk of E1 (new / candidate-corroborated / candidate-uncorroborated / taken / none-of-these) with the 2c fixture roster on dev, the operator queue, I8 review with Mia; then `ONBOARDING_V3=true` on dev → I9 (one research run per confirmed athlete, none before confirmation). Production untouched throughout.

### 17. As built (implementation PR, branch `feat/phase-a-step3b-claim`, base `main` at def9cbb)

Built against the merged plan (§1–§16, P-5 … P-11 as approved). Flags after merge: `ATHLETE_INDEX_CLAIM="false"` (both YAMLs, unchanged), `ONBOARDING_V3="false"` (new, both YAMLs), `EXPO_PUBLIC_IDENTITY_CLAIM` unset (client default off). No deploy, production untouched.

| Item | Where | Notes |
|---|---|---|
| 0052 | `migrations/0052_identity_claim_sessions.sql` | exactly §12: `identity_claims.claim_session_id uuid NULL`; `identity_claims_user_session_idx (user_id, claim_session_id, status)`; partial unique `identity_claims_session_proposed_uq (user_id, athlete_id, claim_session_id) WHERE status='proposed' AND claim_session_id IS NOT NULL`; `athlete_index_matches_decision_check` DROP/ADD with `linked_by_ownership`, `linked_by_operator`. Additive, idempotent, no transaction control (`migrationsGuard` 52/52); `schema.ts` mirrors all four; `db-migrate.sh` 0031–0052. Dev `BEGIN … ROLLBACK`: column, both indexes and the new CHECK appear, nothing persists |
| decisions / proofs | `identity/claim.ts` | `MATCH_DECISIONS` + the two; `LINKING_PROOFS` + `verified_social_ownership` (D-4); `decide(tier, proof, { operator })` — a human click alone stays `possible_duplicate` |
| the lifecycle | `identity/claims.ts` (new) | `proposeClaims` (one UUID per interaction, one row per candidate with its own `match_id`, blocked pairs skipped), `confirmClaim` (the §3 matrix; corroboration = existing_auth / verified_unique_email / a §3a-C ownership claim; none ⇒ `pending_operator` with `note.userConfirmedAt`; self-member or anchor ⇒ `rejected`/system with the pair; a lost 3a race ⇒ `taken`), `dismissSession`, `listMine` (grouped by session), `sessionState`, `listClaims`, `decideClaim` (operator: `decided_by=operator` first, then `linkUserToAthlete(human_confirmation)`, then `confirmed`), `createAthleteForUser` (row + membership in one transaction, proof `human_confirmation`, note `created:<path>` / `created_after_claim:<session>`), `expireStale`, `pendingClaimCount`. One structured `identity_claim` log per transition, never a uid |
| the guard | `identity/link.ts` | `human_confirmation` links only with `createdInFlow` (set by `createAthleteForUser` inside its transaction) or a `claimId` whose claim names this athlete, belongs to this uid's user and is `decided_by = operator`; new `tx` option; `recordFollowUp` appends a telemetry row with the decided decision (the proposal row is never rewritten) |
| resolver | `identity/resolve.ts` | `existing` / `linked` unchanged (the e-mail link now writes a `confirmed`/system claim and sets `athlete_users.claim_id`); `auto_match` / `candidate` ⇒ `recordMatch(possible_duplicate)` + `proposeClaims` ⇒ action `confirm`; a `claimSessionId` ⇒ `sessionState` (confirmed ⇒ `existing`; undecided ⇒ the same `confirm` again, no new rows; all decided ⇒ `create`); unknown session ⇒ `session_unknown` |
| routes | `routes/auth.ts`, `routes/waitlist.ts`, `routes/identityClaims.ts` (new, `/api/v1/identity`), `routes/admin.ts` | signup / waitlist flag-on: 409 `confirmation_required { claimSessionId, tier, claims }`, 400 `claim_session_unknown`, creates through `createAthleteForUser`, `user_roles` beside `account_roles`; flag-off branches byte for byte. Microsoft: `microsoftEmailVerified()` = false (D-6); a `confirm` result issues the custom token without a row (the app's signup call then asks). `POST /identity/claims/:id/confirm { claimSessionId }` (404 for another user / wrong session, 410 expired), `POST /identity/claims/session/:id/dismiss`, `GET /identity/claims/mine`; `GET /admin/identity/claims?status=`, `POST /admin/identity/claims/:id/decide`. All dark (404) unless `ATHLETE_INDEX_CLAIM` |
| /auth/me | `routes/auth.ts` | + `pendingClaims` (additive) |
| membership READ compatibility | `lib/auth.ts` | the 409 `athlete_selection_required` body additionally carries `profiles [{ athleteId, fullName, relation, proof }]` so the client can ask "which profile?"; the selection rule is unchanged (never the first row) |
| §3a-C `byUserId` | `social/ingest.ts` `connectedByUserId`, `substrate.ts`, `stories.ts` | the collision claim is attributed to `connected_accounts.connected_by_user_id` (3a column) instead of the self-user fallback |
| onboarding v3 | `workflow/definitions/onboarding.ts` | `ONBOARDING_V3 = defineWorkflow({ version: 3 })` = `identity_confirmed` (code step: an active self-membership or the run fails fast) + the v2 steps; `onboardingV3Enabled()`, `onboardingStartVersion()` (3 behind the flag, else 2); v3 is registered **opt-in** (`defineWorkflow(def, { optIn: true })`, new `workflow/registry.ts` option: resolvable by a pinned version, never the default when the version is omitted), so the flag-off legacy signup, admin tooling and every older caller keep starting v2; the claim-path `startRun` callers pass the version explicitly |
| sweep | `server/index.ts` `archive-stale-cron` | `expireStale()` after the deal sweep (P-8); result carries `expiredClaims` |
| client (flag `EXPO_PUBLIC_IDENTITY_CLAIM`) | `client/lib/flags.ts`, `client/lib/athlete-selection.ts` (new), `client/lib/query-client.ts`, `client/lib/auth-context.tsx`, `client/screens/IsThisYouScreen.tsx` (new), `client/screens/ChooseProfileScreen.tsx` (new), `client/App.tsx` | signup 409 `confirmation_required` ⇒ "Is this you?" (candidate cards with sport / team / year / handles, "That's me" / "None of these"); confirm ⇒ `pending_operator` / `taken` explained, then the retry with the session id; `/auth/me` 409 ⇒ "Which profile?"; the chosen athlete rides as `X-Athlete-Id` on every request (memory + AsyncStorage; cleared at sign-out). With the client flag off a 409 is a setup failure — no silent create |
| YAML | `gcp/cloud-run-dev.yaml`, `gcp/cloud-run-prod.yaml` | `ONBOARDING_V3="false"` added; nothing else |

**Tests** — `identity/claims.test.ts` (propose / session invariant / resume; verified e-mail corroboration ⇒ `linked_by_verified_email` + `claim_id`; no corroboration ⇒ `pending_operator` + new row + operator queue; self-member ⇒ `rejected` with the pair and the pair blocked; golden anchor; another user / wrong session ⇒ not found; §3a-C ownership ⇒ `linked_by_ownership` with one active owner; dismiss user-scoped; 7-day lazy + sweep; operator confirm / refuse / reject; two users confirming one open row ⇒ one membership); `claim.test.ts` (decisions, `LINKING_PROOFS`); `link.test.ts` (the `human_confirmation` guard, `createdInFlow`, `tx`, D-4); `routes/auth.signup.claim.test.ts` (flag off byte for byte incl. stages 2/3 and `existing_auth` grandfathering, flag on 409 → retry → 201 with `human_confirmation`, unknown session 400, confirmed claim → 200 linked, verified e-mail → confirmed/system claim, onboarding version 2 vs 3 by flag, D-6); `routes/identityClaims.test.ts` (dark 404s; user + session binding; a client athlete id ignored; dismiss / mine; 410); `routes/admin.claims.test.ts` (queue without uid; decide confirm / 409 taken / reject / 400 / 404); `definitions.test.ts` (v3 guard fails fast without a membership, research never runs; proceeds with one; start version by flag); `ownershipGuard` unchanged and green (routes call the module; `identity_claims` writers stay in `identity/**`); `migrationsGuard` 52/52.

Local results: `tsc` clean (server + client); CI step 1 45 suites / 418 tests; CI step 2 19 suites / 174 tests (re-run after the registry opt-in fix). CI on GitHub: the identity module now runs as a THIRD jest step (`Identity tests`) — with it inside step 1 the runner went silent after 24 suites and the job was cancelled (run 34674173595), the same memory limit that produced the two-step split in 2d.

Deviations from the merged plan: none in scope. Implementation details worth naming: (1) `linked_by_confirmation` is not a stored value (P-7 as approved) — the follow-up telemetry row carries the proof-specific decision; (2) the "taken" branch also covers a lost 3a race (two corroborated confirms at once) — the loser's claim is `rejected`/system with the pair; (3) golden anchors are proposed like any candidate and rejected at confirm (the matrix row), so the index behaviour of 2c is unchanged; (4) `athleteIndexReport.ts` filters `possible_duplicate` only and needs no change.

Not done in this PR (each a separate decision): deploy to dev, `ATHLETE_INDEX_CLAIM=true`, `ONBOARDING_V3=true`, the client flag in a dev build, the I8 review with Mia, 3c / 3d, typed assertions (P-9), production.

### 18. Merge, deploy and the post-deploy evidence (dev, 12 Sep 2026) — 3b CLOSED ON DEV

| # | Item | Result |
|---|---|---|
| 1 | Code review | #432 approved at exact head 29317d4 (the 3b code at ac8b8e0 + two CI-only commits: the identity suites in their own jest step; `--testPathIgnorePatterns=…` — the bare flag had swallowed every following path and run the whole tree); CI run 34695335469 green (three jest steps) |
| 2 | Merge | squash-merged with the head guard as **31351b3fe1624978be682f439cdd906edefce8ee** |
| 3 | Deploy to dev (normal path, run 34698012441) | success; migration step ran 0031–0052, **0052 applied for the first time**; drift gate "No drift"; serving revision **nomila-v2-00588-gfk** at 100 % |
| 4 | 0052 on dev | `identity_claims.claim_session_id` (nullable), `identity_claims_user_session_idx`, `identity_claims_session_proposed_uq`, `athlete_index_matches_decision_check` with `linked_by_ownership` / `linked_by_operator`; no data change (identity_claims 0, athlete_index_matches 0, users 14, athlete_users 14 before and after) |
| 5 | Flags on the new revision | env diff vs 00587: ONLY `ONBOARDING_V3='false'` added; `ATHLETE_INDEX_CLAIM=false`, `IDENTITY_MEMBERSHIP_READ=true`, `IDENTITY_MEMBERSHIP_SHADOW=false`, `CONTEXT_SHADOW=false`, `CANONICAL_CONTEXT_READERS` empty — unchanged |
| 6 | Read-only smoke (14 dev users × 14 routes + the two claim endpoints) | 224 requests, 0 anomalies: the 13 authenticated routes 200 for every user, Studio 404 from its gate; `/auth/me` resolves the same athlete as before for all 14 with `user`, one membership and `pendingClaims: 0`; `/identity/claims/mine` and a confirm answer 404 (dark) |
| 7 | Full 2d shadow | record 24/24 · deck 10/10 (14 skipped) · onboarding 24/24 · identity 24/24 · search 24/24 · admin 24/24 |
| 8 | **G9 — new dev baseline** | overall **`3b5446f3299c0b2fd7b2324c4e47de1220843e3e747cddb7fed7e0f36924d20e`** (24 athletes). It differs from the 2d-6 value `0bd3f1db…`, and the cause is dev's nightly pipeline, not 3b: at 04:30 UTC on 12 Sep — nine and a half hours before the deploy — the scheduled refresh wrote Mia a new `scheduled_refresh` athlete_snapshot (carry-forward `as_of` 3 Sep) plus TikTok and Instagram analytics rows, and Lara a YouTube analytics row (19 sync runs, triggers nightly / discovery / stories). A new latest snapshot is a scoring input by design; no affiliation, deal or athlete projection changed and 3b wrote nothing to any scoring input. **This digest is the dev parity baseline for the next check.** |
| 9 | Production | untouched: `nomila-v2-prod-00001-zcv` at 100 %, both identity flags and `ATHLETE_INDEX_CLAIM` false in `cloud-run-prod.yaml`, no `ONBOARDING_V3` rollout |

**3b CLOSED ON DEV (12 Sep 2026).** The staged rollout (plan §11) follows, each step a separate user decision: (1) the dev client build with `EXPO_PUBLIC_IDENTITY_CLAIM=true` (preview channel; inert while the server flag is off), (2) `ATHLETE_INDEX_CLAIM=true` on dev and the I8 review with Mia, (3) `ONBOARDING_V3=true` on dev after I9, (4) production per flag, later. 3c (0053) not started.

### 19. Rollout — the ATHLETE_INDEX_CLAIM slice on dev, CLOSED (12 Sep 2026)

Only evidence already verified in this record's deployments and acceptance runs; no new checks.

**Step 1 — the dev client flag (preview channel only).** PR #435 approved at 9d61c54, CI green, merged as 3cc151c: `EXPO_PUBLIC_IDENTITY_CLAIM="true"` in the `preview` profile of `eas.json` and in `eas-update-preview.yml`; the `production` profile and `deploy-prod.yml` untouched. The OTA workflow (run 34701010681) published preview update group **c4d41d89-2475-4bba-8aa5-eda890a0edec**, runtime 1.1.0, android + ios, with the flag inlined. The same push redeployed dev as revision nomila-v2-00590-czt with an env identical to 00588 (no server flag changed). Inert while the server flag was off.

**Step 2 — `ATHLETE_INDEX_CLAIM=true` on dev.** PR #436 approved at 4b5f53a, CI green, merged as 0c54471; deploy run 34703115057 → revision **nomila-v2-00591-54r**; env diff vs 00590 = only `ATHLETE_INDEX_CLAIM` false → true (`ONBOARDING_V3=false`, `IDENTITY_MEMBERSHIP_READ=true`, `IDENTITY_MEMBERSHIP_SHADOW=false` unchanged).

**Acceptance (API-level, the contract the preview client drives; throwaway sign-ins, removed afterwards).**

| Case | Result |
|---|---|
| candidate shown | a new sign-in named "Mia Bhuta" ⇒ 409 `confirmation_required`, tier `candidate`, three candidates: Mia (soccer · Stanford University · D1 · ACC · tiktok/youtube/instagram · claimability none · score 1.0), Lilia (0.47), a third account (0.40); a "Lara Somfai" sign-in ⇒ Lara (Women's Basketball · Stanford · D1/ACC · youtube + instagram · claimability review · 1.0). No e-mail, no uid in any body (the index view has no e-mail column) |
| candidate information | name, sport, school, level, conference and handles present and correct — enough to recognise oneself. Class year and city are empty for every candidate, and Mia's index row still reads identity_confidence 0 / research_status seed_only: **separate data / research findings, not blockers for this slice** |
| confirm, owned row | confirming Mia's row ⇒ `taken` / `self_member_exists`; Mia's row, membership and auth linkage byte-identical; never a link |
| non-corroborated confirmation | confirming Lara's unclaimed row (no verified e-mail match) ⇒ `pending_operator`; Lara keeps no membership and a null auth_id; the claim stays `proposed` with `note.userConfirmedAt`; `/auth/me` reports `pendingClaims: 1`; the operator queue lists it by athlete name without any uid |
| none of these / wrong candidate | dismiss expires every proposed claim of the session; the retry creates a new profile; the candidate row untouched; a wrong session id and another user's confirm ⇒ 404 |
| resume / retry | the same signup with the session id ⇒ the same 409, same session, no new claims; `GET /identity/claims/mine` lists the session |
| existing athletes | Mia's own sign-in ⇒ her existing row (200, no claims); all 14 existing users still resolve to the same athlete with one membership |

**Defect found and fixed.** After the `taken` answer the signup retry answered 409 again because the session's sibling claims were still proposed. PR #437 (approved at 77a1268, CI green, merged as **6717d236aa6d0fd8e5865e1e1f3298cf524cee3a**): any user decision on one claim now supersedes the session's other proposed claims — same user, same session, `status = proposed` only — with `decided_by = system` and note reason `user_chose_other`; collision claims (no session) and every other user or session are untouched by construction. Deploy run 34705583243 → revision **nomila-v2-00592-szz**, drift clean, env identical to 00591.

**Rerun of the two affected cases on 00592 (19/19).** Taken: three candidates, confirm Mia ⇒ `taken`, the two siblings `superseded / system / user_chose_other`, retry ⇒ 201 new profile (membership `human_confirmation`, note `created_after_claim:<session>`) with no second prompt, Mia byte-identical, `pendingClaims 0`. Pending: Lara (one candidate, so zero siblings), `pending_operator`, retry ⇒ 201 new profile with no second prompt, Lara unlinked and unmodified, `pendingClaims 1`. Every superseded claim on dev belonged to the run's throwaway users.

**Cleanup and dev state.** Throwaway profiles, memberships, claims, user_roles, users, account_roles rows and Firebase test users removed after each run (the first run's cleanup was completed by hand because signup's `account_roles` row blocks deleting the athlete — noted for the next script). Dev counts back to 24 athletes / 14 users / 14 memberships / 0 claims; `athlete_index_matches` 9 rows (the proposals' telemetry, kept by design). G9 baseline `3b5446f3…` (§18) unchanged in meaning: the claim flow writes no scoring input.

**Production**: untouched throughout — `nomila-v2-prod-00001-zcv`, `ATHLETE_INDEX_CLAIM=false` and both identity flags false in `cloud-run-prod.yaml`, no client flag in the production profile.

**ATHLETE_INDEX_CLAIM slice CLOSED ON DEV (12 Sep 2026).** Not done, each a separate decision: the I8 device review with Mia on the preview build, `ONBOARDING_V3=true` on dev (I9), 3c (0053), production per flag.

### Manual merge (operator; follow-up to #951 / #957)

`decideClaim` refuses to link a claim whose user already holds another athlete row: linking would only add a second
membership (the `auth_id` projection stays on the other row; with `IDENTITY_MEMBERSHIP_READ` every request would then have
to name an athlete — 409 / `X-Athlete-Id`). The operator merges by hand, in this order:

1. **Re-check the target row first.** `athletes.auth_id` must still be NULL and the row must have no active self-membership
   (`athlete_users.revoked_at IS NULL`). Someone may have claimed it between the 409 and the merge; if so, stop and reject
   the claim.
2. Move the account's data and the sign-in to the target row, and retire the `heldBy` row.
3. Reject the claim (or leave it: it stays `proposed` and is kept out of the 7-day expiry, flagged `note.manualMergeRequired`).

