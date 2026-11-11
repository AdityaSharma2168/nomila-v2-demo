# Phase A · Step 2c — Athlete Index (BUILD RECORD)

**Design (frozen 11 Sep 2026):** `step2c-athlete-index-design.md` (PR #403). This record is the implementation against it: what was built, the gates as run, and the dev evidence. **Step 2c CLOSED 11 Sep 2026** (§5). `ATHLETE_INDEX_CLAIM` is `false` in both environments at merge; `identity_policy v0.1-alpha` is a draft (not seeded, not activated); `athletes_auth_id_uq` is NOT in this PR (a separate tiny PR after the collision pre-flight; part of Step 2c closure).

## 1. What was built (design §9)

### 1.1 Migration `0048_athlete_index.sql` (design §9.1)
Additive: the view `athlete_index_v` (the first view in the system; `CREATE OR REPLACE`), three lookup indexes (`athlete_facts_name_trgm_idx` partial trigram, `social_identities_handle_idx` on `(platform, lower(handle)) WHERE status='active'`, `athletes_email_lower_idx`), and the telemetry table `athlete_index_matches` (+ index). No column on `athletes` changes. The view carries no auth or private column. Listed in `scripts/db-migrate.sh` (0031–0048). The view is deliberately not declared in `shared/schema.ts` (the drift gate cannot see views); its column set is pinned in `identity/index.ts` (`ATHLETE_INDEX_COLUMNS`) and checked by `assertIndexShape()` (G3).

### 1.2 Matching ≠ claiming (design §4, review round 1)
| Module | Role |
|---|---|
| `identity/index.ts` | the record (`AthleteIndexRecord`, `toIndexRecord`), `findCandidates` (one SQL over the view + match keys; pure `scoreCandidate` + `tierFor`), `searchIndex` (admin, read-only), `publicCandidate`. Tiers `auto_match \| candidate \| new` say which athlete this probably is; **never** authorize. Minimum-evidence rule (name alone never auto-matches), runner-up gap, identifier uniqueness (`ambiguousIdentifier` forces candidate), claimability `open` required for auto_match |
| `identity/policy.ts`, `config.ts` | `IdentityPolicy` defaults (weights, floors, thresholds), the query-side `normalizeIdentityText`, `athleteIndexClaimEnabled()`, `getIdentityPolicy()` (active `identity_policy` row over defaults) |
| `identity/claim.ts` | `claimProofFor` (`existing_auth \| verified_unique_email \| verified_social_ownership \| human_confirmation \| none`), `decide(tier, proof)` (the §4.5 matrix), `proofMayLink` |
| `identity/link.ts` | `linkUserToAthlete(athleteId, uid, provider, proof)` — the ONE writer of `auth_id` + `auth_provider` + `claimed_at` (+ `status` raw/enriched → claimed, otherwise preserved); **throws `ClaimNotAuthorized` without a linking proof** and never re-binds a row that already has a user; `recordMatch` (telemetry: no email in the query, no uid in the row) |
| `identity/resolve.ts` | `resolveIdentity` for the creation paths: existing auth → return; unique provider-verified email → link + record; otherwise `create` with the decision recorded after the insert (`finalizeResolution`). No provider call |
| `lib/auth.ts` | `requireFirebaseUser`: the pre-link guard (token verified; `req.authUid / authEmail / authEmailVerified`; never `req.athleteId`). Every sign-in resolves to a Firebase ID token (Microsoft signs in through a Firebase custom token), so one Firebase verifier is provider-neutral |
| `routes/index.ts` | `POST /api/v1/index/candidates` (pre-link guard, 20/min per uid, rejects `email`/`authId`/`uid` keys with 400, returns view columns + score/tier). Dark: nothing calls it until Step 3 |
| `routes/auth.ts` | signup: after the existing-auth check, when the flag is on → `resolveIdentity`; linked only on `verified_unique_email`; else insert + record. Microsoft: Graph `mail` counts as provider-verified, a `userPrincipalName` fallback does not (D9). Flag off ⇒ the pre-Step-2c path, byte for byte |
| `routes/waitlist.ts` | `verifyCaller` exposes `email_verified`; when the flag is on the insert branch resolves first (a linked row then takes the normal COALESCE update path); flag off ⇒ unchanged |
| `routes/admin.ts` | `GET /admin/waitlist?q=` searches the index by name/alias within the status (read-only, always on) |
| `skills/researchDualWrite.ts` | `assertionsFor`: `nickname` → `alias{kind:'nickname'}`; `hintsFor`: aliases and hometown from current facts |
| `server/scripts/athleteIndexReport.ts` | `--duplicates`: similar-name pairs, emails/handles on more than one row, every `possible_duplicate` decision. Dry run |
| `server/scripts/checkAthleteAuthCollisions.ts` | the closure pre-flight for `athletes_auth_id_uq` (exit 1 on collisions) |
| `server/scripts/seedModelParams.ts` | `identity_policy v0.1-alpha` draft; `PARAM_FAMILIES` gains `identity_policy` |
| `gcp/cloud-run-{dev,prod}.yaml` | `ATHLETE_INDEX_CLAIM: "false"` |
| `server/testUtils/pgliteDb.ts` | PGlite loads `pg_trgm` so suites apply 0048 verbatim |

### 1.3 One scoring correction found by the roster tests
Re-normalizing a null signal away must apply only when the **query** omits the signal. When the query supplies a team and a row has none, that row scores 0 on team (not "unknown"), otherwise a row with missing data out-ranks a row whose team matches. Design §4.2's "null when either side is unknown" is implemented as "null when the query does not supply it"; the row side is a miss. Pinned by the same-name test (State University vs a row with no affiliation).

### 1.4 Code review (PR #404) fixes
- `link.ts`: `linkUserToAthlete` is one atomic conditional `UPDATE … WHERE id = target AND (auth_id IS NULL OR auth_id = uid) RETURNING`; no row ⇒ reload and refuse (`ClaimNotAuthorized`) when another user owns it. Idempotent for the same uid (`claimed_at = coalesce(claimed_at, now)`), status raw/enriched → claimed else preserved. Regression: two uids race for one unclaimed athlete — exactly one wins, the loser is refused, the winner cannot be overwritten.
- `index.ts`: exact-handle membership = an ACTIVE `social_identities` row on that platform with that handle (all active identities, not the one preferred handle the view projects) OR the entered-socials fallback; identifier ambiguity = the count of DISTINCT athletes reached by the identifier across all athletes (identities ∪ entered; every email row), never derived from the returned rows or the JSON projection; exact-identifier rows are ordered first so the candidate window cannot hide them. Regressions: a non-preferred active handle still gives `handleExact = 1` (a superseded one does not); the same active handle on two athletes where one occurrence is not the projected handle ⇒ `ambiguousIdentifier`, tier `candidate`.

- `index.ts` (round 2): the final ranking puts an unambiguous `uniqueIdentifier` candidate above every score-only candidate, with `matchScore` ordering within each class, so `tierFor` examines the identifier's owner. Regressions: a lookalike with a very high name score vs the owner of the one unique active handle (and, separately, the unique email) — the owner is best, `uniqueIdentifier = true`, tier `auto_match`; without the identifier the lookalike is best again.

- Follow-up (G4): `findCandidates` and `searchIndex` now select the candidate ids FIRST from the match-key tables (trigram on `athletes.full_name`, the partial trigram on name/alias facts, the email and handle btrees, the entered-socials fallback; name matches capped at 60 by similarity, exact-identifier ids kept in full) and evaluate the view only for those ids. Measured on the rolled-back synthetic 10k roster: 92 ms on the sequential-scan path and 15–19 ms when the planner takes `athletes_full_name_trgm_idx`, against 210–236 ms for the single-statement form. Behaviour unchanged (all identity suites green).

## 2. Gates as run (design §9.3)

| Gate | Result |
|---|---|
| G1 tests | `identity/index.test.ts` (view shape, field sources, claimability, 30-name roster: near-duplicates, accents, nickname alias, same-name-same-sport ⇒ candidate, minimum-evidence rule, ambiguous handle ⇒ candidate, unique handle ⇒ auto_match tier, anchors / review / has-user never auto_match, email unique-only, admin search; pure scoring and tiers), `identity/claim.test.ts` (proofs, matrix, protected link, resolver: typed handle never links, unverified email never links, shared email never links, unique verified email links and writes `claimed_at`, existing auth authoritative, anchor never linked, telemetry carries no email/uid), `lib/auth.requireFirebaseUser.test.ts`, `skills/researchDualWrite.hints.test.ts`; boundary test green; counts in §3 |
| G2 migration | 0048 dry run on dev (BEGIN … ROLLBACK, 11 Sep 2026): the view (25 columns = `ATHLETE_INDEX_COLUMNS`), the four indexes and the table created in-transaction; 25 index rows (claimability none 20 · open 1 · review 4); after rollback 0 views, 0 tables, 0 indexes remain. Nothing applied by hand |
| G3 view shape | `assertIndexShape()` in tests and at first use; the column list is the contract |
| G4 latency | inside the dry-run transaction, a trigram candidate query over the 25-row dev roster returned in 51 ms measured from a workstation over the Cloud SQL proxy (network-dominated); the in-service p95 and the synthetic 10k-row copy are measured after deploy (§4) |
| G5 no spend | no provider import under `identity/` (boundary test); no provider call in any 2c path |
| G6 legacy | flag off in both envs: the signup, Microsoft and waitlist paths are the pre-existing code (the new branch is entered only under the flag); admin `?q=` additive; byte-for-byte no diff vs `main` on `researchAthlete.ts`, `research/persist.ts`, `research/planner.ts`, `scoringService.ts`, `rateService.ts`, `definitions/onboarding.ts`, `mila/onboarding.ts` |
| G7 duplicates | the report needs the view (after deploy, §4). **The auth-id collision pre-flight already ran read-only on dev: 25 rows, 15 with `auth_id`, ONE `auth_id` on two rows** (see §4 step 3) — `athletes_auth_id_uq` cannot be added until that pair is resolved or the constraint is waived |

## 3. Tests
Full CI list at the merged #404 head b8c5793 (`--runInBand`): 30 suites, 280 tests, all green (the 2a/2b suites unchanged). New: `identity/index.test.ts` 16, `identity/claim.test.ts` 8, `lib/auth.requireFirebaseUser.test.ts` 3, `skills/researchDualWrite.hints.test.ts` 2.

## 4. Dev evidence (design §10)
| Step | Status | Evidence |
|---|---|---|
| 2 deploy applies 0048; view, indexes, table; drift; latency; duplicate report | **done 11 Sep 2026** | merge 728357b (#404, reviewed head b8c5793); deploy run 34575954978 applied `0048_athlete_index` in the hand-written migrations step; drift "No drift"; dev revision `nomila-v2-00569-8tn`. On dev: `athlete_index_v` present with the 25 pinned columns and `assertIndexShape()` passing against dev; all four 0048 indexes and `athlete_index_matches` present (0 rows); no `identity_policy` rows (v0.1-alpha not seeded, nothing active); no `athletes_auth_id_uq`; 25 index rows (claimability none 20 · open 1 · review 4; has_user 15/10). `ATHLETE_INDEX_CLAIM=false` on dev, absent on prod (revision `nomila-v2-prod-00001-zcv` unchanged). Health 200; 0 error-level log lines on the revision; 0 athlete-index / research-substrate / research-planner log lines (no provider call on any index path); the dark candidates endpoint answers 401 unauthenticated and with a bad token (2 × 401 in the request log, nothing else). **G4 latency:** the candidate query on the real 25-row roster executes in 2.5–6.7 ms server-side (EXPLAIN ANALYZE, 5 runs; planning 8–14 ms). On a synthetic 10k roster inserted and rolled back inside one transaction the shipped single-statement form took 210–236 ms with the planner choosing a sequential scan of `athletes` (the OR across the view's columns defeats the trigram index); the same 10k set with the pre-filtered two-step form takes 92 ms on the seq-scan path and 15–19 ms on the forced index path (`athletes_full_name_trgm_idx` used) — **the gate is met only with the two-step query**, shipped as the separate follow-up PR "candidate query latency". **Duplicate report on dev:** 4 similar-name pairs (Aditya Sharma ×2 — one with 3 connections and 11 deals, one empty; the three `demo` rows, two of which shared the auth_id below), 1 email on two rows (the two shared-auth demo rows), 0 active handles on more than one athlete, 0 possible_duplicate decisions (the flag is off). Legacy signup/waitlist: the flag is false on the revision, so the pre-existing creation code runs unchanged (the index branch is never entered); no "index consulted" log line exists |
| 3 auth-id collision pre-flight on dev and prod → 0049 `athletes_auth_id_uq` (closure) | **done 11 Sep 2026** | **Data fix (dev):** `server/scripts/fixDuplicateAthleteRow.ts --keep b4a557c2… --delete b50f37fc…` re-ran the dependency inventory as a precondition (only one `account_roles` row duplicating the kept row's role; view columns excluded from the inventory), then in one transaction deleted that role row and the duplicate athlete row; the kept row still has its 2 connections, 2 snapshots and role; the deleted id returns 0 rows; athletes now 24 rows / 14 with auth_id. **Pre-flight dev:** NO COLLISIONS. **Pre-flight prod** (through the proxy to `nomila-prod-db`, read-only): 0 athlete rows, NO COLLISIONS, no `athlete_index_v`, no unique index (prod has not run Phase A migrations). **0049 dry run on dev (BEGIN … ROLLBACK):** `athletes_auth_id_uq` created as `CREATE UNIQUE INDEX … ON athletes USING btree (auth_id) WHERE (auth_id IS NOT NULL)`, gone after rollback. The 0049 PR is the closure step |
| 4 `ATHLETE_INDEX_CLAIM=true` on dev (user's word) | pending | |

## 5. Closure (11 Sep 2026)

| Item | Evidence |
|---|---|
| Implementation | #404 merged 728357b (reviewed head b8c5793); G4 follow-up #408 merged 1851b02 |
| 0049 `athletes_auth_id_uq` | #407 merged 026e6ab (reviewed head 4daacca); deploy run 34593085951 applied `0049_athletes_auth_id_unique` in the hand-written migrations step (0031–0049); drift "No drift"; dev revision `nomila-v2-00571-jf6` |
| Index on dev | `CREATE UNIQUE INDEX athletes_auth_id_uq ON public.athletes USING btree (auth_id) WHERE (auth_id IS NOT NULL)` — unique = true, partial = true |
| Pre-flight after deploy | NO COLLISIONS (24 rows, 14 with auth_id, 14 distinct) |
| Drift gate (local, against dev) | clean |
| Health / logs | 200; 0 error-level log lines on the revision |
| Flags | `ATHLETE_INDEX_CLAIM=false` on dev, absent on prod (revision `nomila-v2-prod-00001-zcv` unchanged); Step 2b flags unchanged |
| `identity_policy` | no rows; nothing activated |
| Repaired canonical demo row | `b4a557c2…` intact: 2 connections, 2 snapshots, `athletes_current` 1, `media_backfill_state` 1, role 1; the deleted duplicate returns 0 rows |

Claim activation (`ATHLETE_INDEX_CLAIM=true` on dev) and `identity_policy` activation remain separate user-approved rollout decisions; neither is part of closure.
