# nomila-v2 — Whole-System Audit

> READ-ONLY assessment. No code, migrations, or infra changed. Findings only — fixes are
> proposed, not applied. Product stage confirmed by maintainer: **pre-launch, no real users**
> (waitlist). Security findings are therefore rated as **must-fix-before-launch**, not
> actively-exploited-against-real-PII. The committed DB credential and open admin gate are
> noted by the maintainer as already known; documented here for completeness.

Status: scoping complete (4 subsystem maps done); deep verification in progress. This file is
written incrementally so the work survives a long run. Findings marked **CONFIRMED** were
verified against source with a repro/evidence path; **PLAUSIBLE** are strong leads not yet
fully proven.

---

## Executive summary — the 10 things that matter most (ranked)

Ranked by impact × confidence. All CONFIRMED against source unless noted. Severities are
calibrated for **pre-launch, no real users** (security = "must-fix before launch," not
"actively exploited").

1. **Admin dashboard is open to any signed-in user** (SEC-1). `ADMIN_OPEN_ACCESS` defaults
   open and prod sets it `"true"`; any self-signup token can dump every athlete's PII and
   promote/spam/burn AI spend. *Flip the default, remove the prod env, grant admins via the
   existing script.* Highest severity, ~15-min fix.
2. **Prod database superuser password is committed to git** (SEC-6, maintainer already aware).
   `setup-dev-env.sh:32`, plus the script auto-widens the Cloud SQL public-IP allowlist and
   never prunes. *Rotate, move to Secret Manager, purge history, use the Auth Proxy.*
3. **Silent, permanent inbox message loss** (PIPE-3). The Gmail cursor advances past messages
   that failed processing, and transient Kimi errors are silently reclassified as NOISE and
   never even logged. The 2-day/unread cron backstop can't recover them. *Dead-letter table +
   rethrow transport errors.* This directly drops real brand deals.
4. **Duplicate deals & forked threads under normal concurrency** (PIPE-1, PIPE-2). No unique
   constraint backs the thread key (it's a plain index, not unique), so two messages of one
   thread in a single webhook batch create duplicate threads and deal rows. *Add the unique
   index, then link deals atomically.* Keystone fix that also stops double LLM spend.
5. **Accepted deals never affect the athlete score** (SCORE-1). `snapshot.deals` is hard-coded
   `[]` everywhere, so Commercial Capital and the "full" cold-start profile are permanently
   dead. A signed $5k deal moves the score by zero. *Wire the deals table into the snapshot.*
6. **Gmail webhook is unauthenticated → cursor poisoning** (SEC-9). Anyone who knows a victim's
   Gmail address can halt their inbox ingestion. *Verify Google's OIDC push token.*
7. **No index on the auth hot path** (DB-1). Every authenticated request sequentially scans the
   `athletes` table (`auth_id`/`email` unindexed). *One index migration; use CONCURRENTLY.*
8. **Signup fuzzy-name claim can hijack pre-seeded profiles** (SEC-11); **OAuth `state` is
   forgeable** (SEC-10). Two targeted account-integrity holes. *Anchor the name match / drop the
   fuzzy claim; sign the OAuth state nonce.*
9. **OAuth tokens stored plaintext** (SEC-7) + **two schema sources of truth with broken Drizzle
   metadata** (DB-5). Both are latent foot-guns that get more expensive after launch. *Encrypt
   tokens; consolidate on migrations before more schema churn.*
10. **Near-zero test coverage on everything load-bearing** (cross-cutting). The scoring engine,
    all routes, integrations, and concurrency paths are untested; several bugs above would have
    been caught by a modest suite. *Highest long-term velocity multiplier.*

Refuted leads worth noting (so they aren't re-chased): no IDOR on `/me/*` (SEC-5); deal-status
vocabulary is consistent (the real bug was SCORE-1); weights singleton is concurrency-safe
(SCORE-5); Microsoft/waitlist auth is properly verified.

---

## System inventory (first-hand)

- ~30.5k lines TypeScript. Repo ~5 weeks old (first commit 2026-05-28), fast-moving.
- **Server** (Express, `server/`): 11 route modules, 9 "skills" (LLM pipeline: inbox sync →
  deal detection → research/enrichment → scoring), 8 platform integrations, in-process
  node-cron layered on Cloud Scheduler. Single Drizzle/pg pool. Firebase-Admin JWT auth.
- **Client** (Expo/React Native, `client/`): React Navigation + TanStack Query v5 + Firebase
  web SDK. Light-mode only. 3 real screens (Brand, Opportunities, Settings) + placeholders.
- **Data** (`shared/schema.ts`): 18 tables, Postgres 15 on Cloud SQL. Enum-as-text + CHECK.
- **Infra**: Cloud Run (minScale 1 / maxScale 3 / concurrency 80 / 2CPU 2Gi), single Cloud SQL
  instance, GitHub Actions deploy on push-to-main (runs migrations against prod directly).
- **Tests**: 2 files only — `server/lib/withTimeout.test.ts`, `server/skills/dealScoreGrid.test.ts`.
  No client tests, no route/integration tests, `scoringService` (900 loc) untested.

### Already-documented, deliberately-deferred (NOT re-sold as new findings)
- `docs/llm-concurrency-spec.md` — unbounded LLM fan-out / no global concurrency gate / no
  retry in deal path. Deferred until multi-mailbox scale.
- `docs/inbox-durability-changeset.md` — kimi timeout + cursor-after-processing + idempotency
  gate. Shipped; acknowledges a residual post-ack loss window (needs durable queue).
- `docs/r1-scoring-followups.md` — 5 deferred scoring correctness items (fit rubric, contest/
  prize-only tagging, consumer-promo detection, surface fitRead on card, one-time re-score).

These are referenced where a finding overlaps, and flagged as "known/deferred," not new.

---

## Findings — Backend / Security & Access Control

### SEC-1 · Admin dashboard open to any signed-in user (PII exposure) — **CONFIRMED**
- **Severity:** high (pre-launch: must-fix before launch) · **Confidence:** confirmed
- **Location:** `server/lib/auth.ts:95` + `:133-144`; `gcp/cloud-run-v2.yaml:139-140`; `server/routes/admin.ts:36,39`
- **Evidence:** `const ADMIN_OPEN_ACCESS = (process.env.ADMIN_OPEN_ACCESS ?? "true")... !== "false"` — defaults **open**. `requireAdmin` logs a warning for non-admins but still calls `next()`. Prod sets `ADMIN_OPEN_ACCESS: "true"`. Any Firebase self-signup token reaches: `GET /api/v1/admin/waitlist?status=…` (dumps every athlete's `full_name`, `email`, `sport`, `school`, `socials`, connected-account usernames, score/tier; limit up to 500) and `POST /api/v1/admin/waitlist/:id/promote` (flips any athlete → active, sends a real email, kicks off paid Gemini/Kimi research).
- **Root cause:** insecure opt-out default; prod opts into the open posture.
- **Recommended change:** flip default to closed (`=== "true"`, default false) or delete the flag and require the `admin` role unconditionally; remove `ADMIN_OPEN_ACCESS:"true"` from `cloud-run-v2.yaml`; grant real admins via the existing `scripts/grant-admin.ts` *before* flipping.
- **Risk/effort of fix:** low / ~15 min (grant admin first to avoid lockout).

### SEC-2 · `requireAuth`/`requireAdmin` DB lookup has no error handling → hung request — **CONFIRMED**
- **Severity:** medium · **Confidence:** confirmed
- **Location:** `server/lib/auth.ts:60-70` (and `:117-129`); no global error handler in `server/index.ts`
- **Evidence:** the athlete lookup is outside the try/catch that wraps `verifyIdToken`. Express 4.21 does not forward rejected async-middleware promises, and there is no `app.use((err,req,res,next)=>…)`. A DB blip (pool exhaustion, reset) → unhandled rejection, `next()` never called, request hangs until Cloud Run's `timeoutSeconds: 3600` cutoff.
- **Root cause:** async middleware + Express 4 + no backstop error handler.
- **Recommended change:** wrap both lookups in try/catch returning `503`; add a global Express error handler as a backstop. (Avoid pulling in `express-async-errors` — a try/catch is enough.)
- **Risk/effort:** low / ~10 min.

### SEC-3 · Non-timing-safe cron-secret comparison — **CONFIRMED (low)**
- **Severity:** low · **Confidence:** confirmed
- **Location:** `server/index.ts:92,100,187,204,226,246,264,281,314`
- **Evidence:** all internal endpoints compare `req.headers["x-cron-secret"] !== CRON_SECRET` with plain `!==`.
- **Assessment:** not practically exploitable — high-entropy Secret-Manager secret, no oracle, network jitter dwarfs the comparison delta. Defense-in-depth only.
- **Recommended change (optional):** one `crypto.timingSafeEqual` helper (length-guarded) across the 9 sites. Defer-able.
- **Risk/effort:** low / ~15 min.

### SEC-4 · Internal endpoints accept unvalidated connectionId/athleteId pairs — **CONFIRMED but MOOT**
- **Severity:** low · **Confidence:** confirmed
- **Location:** `server/index.ts:203-220` (gmail-backfill), `:241-257` (instagram-sync), `:279-309` (summarize-threads)
- **Evidence:** presence-only checks on `{connectionId, athleteId}`; no assertion the connection belongs to the athlete. **But** all are behind the `CRON_SECRET` gate, so this is an operator footgun (a wrong id in a manual curl cross-wires data), not an external vuln.
- **Recommended change (optional hardening):** assert `connected_accounts.id === connectionId AND .athlete_id === athleteId` before dispatch; 400 otherwise.
- **Risk/effort:** low / ~15 min. Defer-able.

### SEC-5 · IDOR on `/api/v1/me/*` — **REFUTED (no issue)**
- Verified: `deals.ts` (`GET/PATCH /deals/:id`, `POST /deals/:id/draft`), `inbox.ts` (`GET /inbox/threads/:id`, `POST …/reply`), and `chat.ts` deal-context all scope by `req.athleteId` in the WHERE clause (and re-scope on update). No cross-athlete access. Recorded so it isn't re-investigated.

### SEC-6 · Committed live DB superuser credential — **CONFIRMED** (maintainer already aware)
- **Severity:** high (must-fix before launch) · **Confidence:** confirmed
- **Location:** `scripts/setup-dev-env.sh:32`
- **Evidence:** `DATABASE_URL="postgresql://postgres:<redacted>@35.254.58.44:5432/nomila_v2"` — plaintext superuser password + public IP, git-tracked. The same script (`:18-30`) fetches the machine's public IP and adds it to the Cloud SQL instance's `authorized-networks` on every run, never pruning — the DB's public-IP allowlist only widens.
- **Root cause:** dev-bootstrap convenience committed to the repo.
- **Recommended change:** rotate the `postgres` password now; move the URL wholly into Secret Manager (the script already fetches other secrets that way — construct `DATABASE_URL` from the fetched password, don't hardcode); purge the string from git history (BFG/filter-repo); switch dev access to the Cloud SQL Auth Proxy (already referenced in `package.json:11`) instead of public-IP allowlisting; audit/prune `authorized-networks`.
- **Risk/effort:** medium / ~1–2 h incl. history purge + rotation. (Pre-launch data, so blast radius is limited, but the credential is real.)

### SEC-7 · OAuth tokens stored plaintext at rest — **CONFIRMED**
- **Severity:** medium (high once real creators connect inboxes) · **Confidence:** confirmed
- **Location:** `shared/schema.ts:384-385` (`connected_accounts.access_token`, `refresh_token` — plain `text`, nullable, unindexed)
- **Evidence:** Gmail/Outlook/IG/TikTok/YouTube OAuth access+refresh tokens are written directly (schema comment: "Tokens stored directly — no Composio intermediary"). Anyone with DB read (see SEC-6) or a table dump gets live mailbox/social tokens.
- **Recommended change:** application-level envelope encryption (e.g. GCP KMS `encrypt`/`decrypt`, or `pgcrypto`) on the token columns, keyed by a Secret-Manager/KMS key; decrypt only in the integration layer. Additive migration + a wrap/unwrap helper in the token read/write path.
- **Risk/effort:** medium / ~half-day. Sequence before onboarding real inboxes.

### SEC-8 · `ENABLE_TEST_PAGE:"true"` in prod — **CONFIRMED (low)**
- **Severity:** low · **Location:** `gcp/cloud-run-v2.yaml` + `server/index.ts:84-89`
- Serves `server/public/test-auth.html` at `GET /test`. Harmless-ish but an auth-testing surface on a public unauthenticated service. Turn off in prod.

---

## Findings — Data & DB

### DB-1 · No index on the auth hot path (`athletes.auth_id` / `email`) — **CONFIRMED**
- **Severity:** high (perf, scales with every request) · **Confidence:** confirmed
- **Location:** `shared/schema.ts:87-90` (no index in table def); confirmed no migration adds one (`migrations/*.sql` grep — only trgm/external_thread_id/sas indexes exist)
- **Evidence:** every `requireAuth` runs `SELECT … FROM athletes WHERE auth_id = $uid` (`auth.ts:63-66`); `athletes.auth_id` and `athletes.email` are unindexed → sequential scan on the athletes table on *every authenticated request* and on email-based signup claim/`grant-admin.ts`.
- **Recommended change:** `CREATE INDEX idx_athletes_auth_id ON athletes(auth_id)`; index (or unique-where-not-null) on `lower(email)`. Consider a partial unique on `auth_id` since it should be 1:1.
- **Risk/effort:** low / minutes (additive index migration; use `CREATE INDEX CONCURRENTLY` on a live DB).

### DB-2 · No index on FK/list-filter columns (`deals.athlete_id`, `inbox_threads.athlete_id`, `tasks.athlete_id`, `inbox_messages.athlete_id`) — **CONFIRMED**
- **Severity:** medium (grows with volume) · **Confidence:** confirmed
- **Location:** `shared/schema.ts` tables 4/8/9/11; no covering index in schema or migrations
- **Evidence:** `GET /deals`, `GET /inbox/threads`, `/analytics`, task lookups all filter by `athlete_id`; only `external_thread_id` (non-unique) and trgm indexes exist. Full scans as rows accumulate.
- **Recommended change:** add btree indexes on each `athlete_id` (composite with a sort/filter column where useful, e.g. `deals(athlete_id, created_at)`, `inbox_threads(athlete_id, last_message_at)`).
- **Risk/effort:** low / minutes.

### DB-3 · Thread-upsert race is not backed by a unique constraint — **CONFIRMED (schema side)**
- **Severity:** medium · **Confidence:** confirmed (concurrency repro pending pipeline verifier)
- **Location:** `shared/schema.ts:259` — `index("idx_threads_external_thread_id")` is a **plain index, not `uniqueIndex`**
- **Evidence:** two concurrent first-touch messages on one Gmail thread can both read "no thread" then both insert; nothing at the DB level prevents duplicate threads for the same `(athlete_id, external_thread_id)`. (Pipeline verifier confirms the read-then-insert path in `dealDetector.ts`.)
- **Recommended change:** make it `uniqueIndex` on `(athlete_id, external_thread_id)` and switch the insert to `onConflictDoNothing`/`onConflictDoUpdate` + re-select. Backfill-dedupe existing rows first.
- **Risk/effort:** medium / ~1–2 h (dedupe + constraint + insert change).

### DB-4 · No `ON DELETE` behavior on 17 of 18 tables — **CONFIRMED**
- **Severity:** medium (blocks athlete deletion / GDPR delete) · **Confidence:** confirmed
- **Location:** `shared/schema.ts` — only `social_analytics_snapshots` (`:476-477`) sets `onDelete:"cascade"`; every other FK to `athletes.id` omits it. `brand_api_keys.brand_id` (`:422`) has **no FK at all**.
- **Evidence:** deleting an athlete is blocked by 15+ RESTRICT-by-default references; a real delete needs manual multi-table choreography.
- **Recommended change:** decide the policy per table (cascade for owned child rows: snapshots, deals, threads, messages, chat, tasks, notifications, connected_accounts, roles; set-null/restrict where audit matters) and add `onDelete` in an additive migration. Add the missing FK on `brand_api_keys.brand_id` when Phase 2 activates.
- **Risk/effort:** medium / ~half-day incl. a `deleteAthlete` routine + test.

### DB-5 · Two schema sources of truth + missing Drizzle snapshots — **CONFIRMED**
- **Severity:** medium (drift/foot-gun) · **Confidence:** confirmed
- **Location:** `.github/workflows/deploy.yml` hand-written `psql` DDL block vs `migrations/`; `migrations/meta/` missing snapshots for `0003`, `0005`, `0006` (journal lists all 8)
- **Evidence:** deploy runs a large hand-DDL block (adds columns, re-creates CHECKs, the inbox_messages unique, `CREATE EXTENSION vector`) on every deploy *and then* `db:migrate` — duplicating migrations 0001/0004/0005, so additive changes must be authored twice. 0003/0005/0006 were hand-authored SQL appended to the journal with no generated snapshot, so `drizzle-kit generate`'s diff baseline no longer reflects reality → next generate emits spurious DDL.
- **Recommended change:** pick migrations as the single source; delete the hand-DDL block from deploy (fold anything still needed into real migrations); regenerate/repair `meta` snapshots (or reset the migration baseline from current prod with `drizzle-kit introspect`). Add a `drizzle-kit check` step to CI.
- **Risk/effort:** medium / ~half-day, done carefully against a prod dump.

### DB-6 · Nullable status/enum columns silently bypass CHECK constraints — **CONFIRMED (low)**
- **Severity:** low · **Location:** `shared/schema.ts` `deals.status/deal_type/source`, `inbox_threads.status`, etc.
- Postgres CHECK passes on NULL, so a NULL write evades the `IN (...)` guard. Most have defaults, so this only bites on explicit NULLs. Add `NOT NULL` where a default exists; low priority.

---

## Findings — Frontend

### FE-1 · ~3,000 loc of dead code (two parallel deal UIs) — **CONFIRMED**
- **Severity:** medium (maintenance drag, confusion) · **Confidence:** confirmed
- **Location:** `client/components/deals/opps/**` (except `opps/tokens.ts`), `client/components/deals/DealDetailSheet.tsx`, `client/screens/SearchAskSheet.tsx`
- **Evidence:** grep for importers outside `opps/` returns nothing; `FlashList` (installed) is imported nowhere; the live deal surface is `DealCard` + `DealActionSheet` only. `OppCard`/`DealDetailSheet`/`opps/detail/DealDetail` are a second, unwired implementation of the same surface (list card + detail + reply/SSE), carrying their own token system (`opps/tokens.ts`, still imported by `MilaSearchOverlay`) and divergent stale patterns.
- **Recommended change:** delete the `opps/` tree (migrate the few `N.*`/`oppsFont` tokens still used by `MilaSearchOverlay` into `constants/theme.ts` first), `DealDetailSheet.tsx`, `SearchAskSheet.tsx`. Verify no dynamic imports first.
- **Risk/effort:** low / ~1 h (mechanical deletion + token migration + typecheck).

### FE-2 · Deal list not virtualized; per-card hook fan-out — **CONFIRMED**
- **Severity:** medium (perf on large inboxes) · **Confidence:** confirmed
- **Location:** `client/screens/OpportunitiesScreen.tsx:138,220` (`ScrollView` + `dealsToShow.map`); `client/components/deals/DealCard.tsx` (1576 loc, calls `useThread`/`useConnections`/`useDealDraft`/`useThreadReply` per card)
- **Evidence:** every `DealCard` mounts at once inside a `ScrollView`; `FlashList` is installed but unused. Combined with multiple react-query hooks per card, a large inbox mounts N heavy cards + N×hooks simultaneously.
- **Recommended change:** render the list with `FlashList` (already a dep) with an `estimatedItemSize`; hoist shared data (`useConnections`) to the screen and pass down; keep `useThread`/`useDealDraft` gated on expansion (already `enabled:isExpanded`). Split `DealCard` (see FE-3).
- **Risk/effort:** medium / ~half-day.

### FE-3 · `DealCard.tsx` oversized (1576 loc, much dead style) — **CONFIRMED**
- **Severity:** low/medium · **Location:** `client/components/deals/DealCard.tsx`
- ~700 loc of `StyleSheet`, much unreferenced (`offerCard`, `factorGrid*`, `brandTier*`, `draftBanner*`, `replyBtn*`, `askMilaBtn*`, `expandedFooter*`, …). Split into collapsed-card / expanded-detail / reply-composer; prune dead styles. Low risk, high readability payoff.

### FE-4 · `staleTime: Infinity` + no refetch triggers → stale UI — **CONFIRMED (design)**
- **Severity:** low/medium · **Location:** `client/lib/query-client.ts:71-84`
- All queries never auto-refresh (`staleTime:Infinity`, `refetchOnWindowFocus:false`, `refetchInterval:false`, `retry:false`); freshness depends entirely on manual `refetch()`/`invalidateQueries`. `OpportunitiesScreen` mutations bypass react-query (`apiRequest` + `refetch()`), inconsistent with `use-deals`/`use-platform-oauth` invalidation. Consider per-query `staleTime` + consistent invalidation, and `retry:1` for transient network blips.

### FE-5 · Assistant name "Mia" vs "Mila" in live UI — **CONFIRMED (low)**
- **Location:** `client/components/deals/DealActionSheet.tsx:253,303,374` say "Mia"; rest of app says "Mila". User-facing inconsistency. Trivial fix.

### FE-6 · No error boundary; typed reply lost on send failure — **PLAUSIBLE**
- No React error boundary anywhere → any render throw crashes the app (many `as any` casts on nested `conversation_state` in `use-deals.ts` mapping). `ThreadScreen.tsx:79-85` clears the input before awaiting `mutateAsync`, so a failed send loses the message with no restore/error surface. Add a top-level error boundary; restore text on send failure.

---

## Findings — Infra / Ops

### INFRA-1 · Migrations run against prod DB from GitHub Actions on every merge — **CONFIRMED**
- **Severity:** medium · **Location:** `.github/workflows/deploy.yml`
- Push-to-main opens the Cloud SQL proxy and runs the hand-DDL block + `db:migrate` directly against prod before building the image (`set -e`/`ON_ERROR_STOP` aborts on failure). No staging gate, no dry-run. Combined with DB-5 this is the riskiest infra path. Recommend a staging DB + a manual approval gate for schema changes, or at minimum a `--dry-run`/plan step.

### INFRA-2 · No graceful shutdown (SIGTERM) — **CONFIRMED**
- **Severity:** low/medium · **Location:** `server/index.ts` (no signal handlers)
- Cloud Run sends SIGTERM on scale-down; in-flight SSE streams (chat/draft) and DB work are dropped, pool not drained. Add a SIGTERM handler that stops accepting, drains, `server.close()` + `pool.end()`.

### INFRA-3 · No boot-time env validation — **CONFIRMED**
- **Severity:** low/medium · **Location:** `server/index.ts` / `server/db.ts:9` (only `DATABASE_URL` asserted)
- Missing MOONSHOT/OAuth/IG/Google secrets fail lazily at first feature use; `/health` returns ok, so a bad secret rollout looks healthy until a user hits the path. Add a `zod` env schema validated at startup (fail fast, or warn-list optional ones).

### INFRA-4 · Single-region, single Cloud SQL instance, `minScale:1/maxScale:3` — **CONFIRMED (capacity note)**
- **Severity:** low (pre-launch) · **Location:** `gcp/cloud-run-v2.yaml`
- DB and service are SPOFs; ceiling 3×80=240 concurrent; `cpu-throttling:false` + `minScale:1` = always-on billing; `timeoutSeconds:3600` lets a hung AI call pin a 2-CPU instance. Fine for now; revisit before scale (HA Cloud SQL, lower request timeout, autoscaling headroom).

---

## Findings — Security (webhook / OAuth trust)

### SEC-9 · Gmail Pub/Sub webhook is unauthenticated → cursor poisoning / inbox DoS — **CONFIRMED**
- **Severity:** high (integrity/availability of core ingestion) · **Confidence:** confirmed
- **Location:** `server/index.ts:64` (mount, body-parse only); `server/routes/webhooks.ts:39-60` handler; cursor writes at `:92,104-105,148`
- **Evidence:** the `/gmail` handler does no OIDC/secret/signature check (the Instagram POST does HMAC via `validIgSignature`, `:212-216`). It decodes `{emailAddress, historyId}` from the body and routes purely by `emailAddress`. It then advances the stored `gmail_history_id` to the **attacker-supplied `historyId`**. NOT exfiltration (fetch uses the server's own token, nothing returned to caller) — but an attacker who knows a victim's Gmail address can POST a large/future `historyId`, moving the cursor past unprocessed real messages so `history.list?startHistoryId=` returns nothing new → deal ingestion for that victim silently stops. Re-poisonable between the 6-hourly cron backstop runs.
- **Root cause:** Pub/Sub push endpoint trusts an unauthenticated body and lets it write a persisted cursor.
- **Recommended change:** require Google's OIDC push auth — configure the subscription with a service-account OIDC token and verify the `Authorization: Bearer` JWT (issuer, audience, signature) before processing, mirroring the IG 403-on-fail pattern. Defense-in-depth: never advance the cursor to an un-vetted claimed `historyId` — advance to the actual last-fetched history id instead.
- **Risk/effort:** OIDC verify middleware on the one route — low / ~1–2 h.

### SEC-10 · OAuth callback trusts a forgeable `state` → connection injection — **CONFIRMED**
- **Severity:** medium (targeted; needs victim's athlete UUID) · **Confidence:** confirmed
- **Location:** `server/lib/integrations/gmail.ts:62-66` (state built by plain concat), `:90-115` (pending-row lookup with INSERT fallback); `server/routes/oauthCallback.ts:139-142,175`
- **Evidence:** `state = athleteId:alias:clientPlatform`, unsigned, not server-stored, validated only by `split(":")`. `handleCallback` falls back to a fresh INSERT when no pending row matches, so the `POST /connect` (the only `requireAuth` step) can be skipped. Exploit: attacker crafts the Google authorize URL with `state=<victimAthleteId>::`, authenticates with **their own** Google account, and the callback attaches the attacker's inbox as an active connection under the victim's athlete — attacker-controlled email then scanned inside the victim's account, and victim-triggered sends could route through the attacker's mailbox. Gated by needing the victim's random athlete UUID (not enumerable here), so targeted not trivial. Does not expose the victim's existing data.
- **Root cause:** no CSRF/nonce binding between `POST /connect` and the callback; `state` is attacker-authored; INSERT fallback removes the pending-row guard.
- **Recommended change:** issue a signed (HMAC) or server-stored one-time nonce in `POST /connect`, validate + consume it in the callback, and remove the INSERT-without-pending-row fallback.
- **Risk/effort:** medium / ~2–3 h.

### SEC-11 · Signup fuzzy-name claim can take over unclaimed pre-seeded profiles — **CONFIRMED**
- **Severity:** medium-high (identity/profile takeover) · **Confidence:** confirmed
- **Location:** `server/routes/auth.ts:109-144`
- **Evidence:** after UID- and email-match, a fuzzy branch claims a row by `ilike(full_name, '%' + name + '%')` (+ optional sport), gated to `auth_id IS NULL` and `status IN ('raw','enriched')`, with `LIMIT 1` and **no `ORDER BY`**. Guards prevent stealing an already-owned/active row, but the match is an unanchored, attacker-controlled substring — signing up with a distinctive substring of a target's name (+ sport) takes over that pre-seeded row: `auth_id`←attacker uid, `status='claimed'`, plus an `account_roles` row. A short common substring (`name="a"`) matches almost any unclaimed row.
- **Root cause:** fuzzy substring used as an identity claim with no proof of relationship.
- **Recommended change:** drop the fuzzy self-service claim (rely on UID + verified-email claim only), or require exact `lower(full_name)=lower(name)` **plus** an out-of-band proof (verified email or admin-issued claim token). Never claim on a bare substring.
- **Risk/effort:** low / ~1 h.
- **Note:** the Microsoft auth path (`auth.ts:219-293`) skips this claim logic entirely, so a Microsoft signup whose email matches a pre-seeded athlete creates a **duplicate** row instead of claiming — a data-hygiene gap to reconcile when the claim path is fixed.

---

## Findings — Pipeline (inbox → deal)

### PIPE-1 · Duplicate `deals` rows under concurrency (no unique backstop) — **CONFIRMED**
- **Severity:** high (correctness + double LLM spend + duplicate cards) · **Confidence:** confirmed
- **Location:** `server/skills/dealDetector.ts:440-453` (scored insert, no conflict target); `:469-482` fallback `.onConflictDoNothing()` is a **no-op** (nothing to conflict on); `shared/schema.ts:164-186` (`deals` has no unique constraint and no `thread_id` column)
- **Evidence/repro:** the webhook processes a batch with `Promise.allSettled(messages.map(detectDeal))` (`webhooks.ts:119-121`); two messages of the **same new thread in one batch** both pass the idempotency SELECT (`:173`, neither inserted yet), both find no existing thread, both insert a thread, both insert a deal. Also fires cross-path (webhook ∥ 6-hourly cron ∥ Pub/Sub at-least-once redelivery). The message-level unique `(thread_id, external_message_id)` doesn't help — the racers hold different thread_ids.
- **Root cause:** check-then-act with no DB-level uniqueness on `deals`/`inbox_threads`.
- **Recommended change:** fix PIPE-2 first (unique thread index), then link atomically: `UPDATE inbox_threads SET deal_id=$new WHERE id=$thread AND deal_id IS NULL` and delete the just-inserted deal if 0 rows updated. Or add a nullable `deals.thread_id uuid UNIQUE` and give both inserts a real conflict target.
- **Risk/effort:** low risk / small-medium (migration + ~20 lines).

### PIPE-2 · Thread-upsert TOCTOU forks one conversation into two threads — **CONFIRMED**
- **Severity:** medium-high (keystone for PIPE-1) · **Confidence:** confirmed
- **Location:** SELECT `dealDetector.ts:186-193`, INSERT `:359-373` (no `onConflict`); `shared/schema.ts:259` is `index(...)` **not** `uniqueIndex`; `migrations/0001:11` `CREATE INDEX` (non-unique)
- **Evidence/repro:** same interleavings as PIPE-1 — two first-touch messages on one Gmail thread both SELECT empty, both INSERT → two thread rows; later messages land on whichever the unordered `LIMIT 1` lookup returns.
- **Recommended change:** dedupe existing rows, then `uniqueIndex` on `(athlete_id, external_thread_id)` (per-athlete scoping is mandatory — IG `ig:<senderId>` fallback collides otherwise), convert insert to `onConflictDoNothing` + re-select.
- **Risk/effort:** small migration + change; main risk is pre-existing dup rows blocking the unique index — needs a one-time merge script first.

### PIPE-3 · Permanent message-loss window (advance-past-failure + narrow backstop) — **CONFIRMED**
- **Severity:** high (silent lost deals) · **Confidence:** confirmed
- **Location:** `server/routes/webhooks.ts:142-148` (advances cursor past `droppedIds`); sole backstop `server/lib/integrations/gmail.ts:428` (`is:unread newer_than:2d`, max 50), cron `server/index.ts:350` (`0 */6 * * *`, prod only)
- **Evidence/repro:** message arrives → `detectDeal` throws → added to `droppedIds` → cursor advances anyway → no future `history.list` returns it. If the athlete reads the email (clears `is:unread`) before the next 6h cron, or the mailbox has >50 unread in the 2-day window, it is **permanently lost** (only trace: one log line). **Aggravator:** `classifyMessage` catches transport errors and returns `emptyClassification()` = NOISE (`dealDetector.ts:560-563`), so a Kimi outage doesn't throw — the message is silently skipped as NOISE and never even reaches `droppedIds`.
- **Root cause:** at-most-once processing paired with a recovery query narrower than the failure domain.
- **Recommended change:** durable dead-letter table (`connection_id, gmail_message_id, attempts`) drained by the cron via direct `messages.get`; and make `classifyMessage` rethrow transport errors instead of returning NOISE. Cheaper stopgap: don't advance the cursor when `droppedIds.length>0` and attempts<N (next notification retries; idempotency makes the successful ones free). Overlaps `docs/inbox-durability-changeset.md` (known residual window) — this narrows it further and fixes the silent-NOISE hole, which that doc doesn't cover.
- **Risk/effort:** stopgap ~5 lines (bounded poison-message risk); dead-letter table medium effort, low risk.

### PIPE-4 · Idempotency gate is sound for Gmail; Instagram id-equality unverified — **CONFIRMED / PLAUSIBLE**
- **Severity:** low · **Confidence:** confirmed (Gmail) / plausible (IG)
- The gate (`dealDetector.ts:173`) runs before all 3 Kimi calls, and all Gmail paths (webhook/cron/backfill) key on the Gmail API message id → coverage is real. **IG soft spot:** webhook uses `m.mid` (`webhooks.ts:287`) while backfill/cron use the Conversations API `msg.id` (`instagramSync.ts:33`); the code assumes these strings are identical but nothing here proves it — if Meta formats them differently, a DM is re-classified (dup message + dup Kimi spend). Also the gate matches `external_message_id` globally, not per-athlete (astronomically-unlikely cross-mailbox skip; free to scope by `athlete_id`).
- **Recommended change:** one-time prod log check comparing a webhook `mid` to the same message's Conversations-API id; add `athlete_id` to the gate's WHERE.

### PIPE-5 · Kimi-classified NOISE is never memoized → repeated LLM re-spend — **CONFIRMED**
- **Severity:** medium (cost) · **Confidence:** confirmed
- **Location:** `server/skills/dealDetector.ts:225-231` (NOISE return happens after the classify Kimi call, before any insert); no NOISE persistence anywhere
- **Evidence:** the idempotency store is `inbox_messages`, which by design excludes NOISE, so every re-encounter re-pays the classify call. Recurring cost is mostly via the **6h cron** (`is:unread newer_than:2d` re-classifies each unread NOISE email up to ~8× over 2 days), plus backfill on each reconnect / manual trigger. `preFilterEmail` already kills obvious noise for free, so the re-spend is on the ambiguous bulk that needs Kimi to call NOISE.
- **Recommended change:** a tiny `processed_external_ids(external_message_id pk, classified_at)` table written **only on genuine NOISE verdicts** (never on the `emptyClassification()` error fallback — else you'd permanently memoize an outage as NOISE, worsening PIPE-3), checked alongside the `:173` gate.
- **Risk/effort:** very low / small table + 2 queries.

## Findings — Scoring

### SCORE-1 · Accepted/completed deals never reach the athlete score (`snapshot.deals` always `[]`) — **CONFIRMED**
- **Severity:** high (core scoring correctness) · **Confidence:** confirmed
- **Location:** `server/skills/researchAthlete.ts:605,634` (`deals: []` hard-coded); `server/skills/fetchSocialData.ts:271,292` (`deals: prevSnap?.deals ?? []` — copies the always-empty array forward); readers `scoringService.ts:851,649`
- **Evidence:** no code path ever writes real rows from the `deals` table into a snapshot's `deals` JSONB (repo-wide grep). So `computeScore`'s Commercial-Capital deal components are always 0, `hasDeals` is always false (`:866`), and `coldStartProfile` can never be `"full"` (`:871`). An athlete who accepts a $5,000 deal in-app sees **zero** effect on their M.I.A. score. The status-filter (`accepted`/`completed`) is correct and the status vocabulary is consistent across schema/routes/client (the earlier "vocab divergence" lead is **refuted**) — the bug is the missing data wiring, not the filter.
- **Root cause:** unfinished integration — the deals table and the scoring snapshot were never connected.
- **Recommended change:** in `researchAthlete`/`fetchSocialData`, query the athlete's `deals` (status in accepted/completed, with `amount`, `detected_at`) and embed into the snapshot `deals` JSONB before `computeScore`.
- **Risk/effort:** small; raises scores for deal-holding athletes (intended). Confirm this matches product intent before shipping.

### SCORE-2 · Unguarded NPE in `computeMomentumData` on null achievement name — **CONFIRMED**
- **Severity:** medium (whole scoring run throws) · **Confidence:** confirmed
- **Location:** `server/services/scoringService.ts:631-635`
- **Evidence:** `a.name.toLowerCase()` with no null guard, over LLM-extracted `research.achievements`. The upstream dedup (`researchAthlete.ts:360`) keys with `(a.name ?? "")` but **stores the raw object**, so `{name: null}` can persist. `computeAthleticCapital` guards the same field (`:380` `(a.name ?? "")`) — this site doesn't. A single null-named achievement → `TypeError` → `computeScore` throws → the research/social-connect scoring run fails.
- **Recommended change:** `(a.name ?? "").toLowerCase().trim()` in both spots (and/or filter falsy names when building `recentAwards`).
- **Risk/effort:** trivial.

### SCORE-3 · GDELT article delta is not actually time-decayed — **CONFIRMED**
- **Severity:** medium (mis-weighted Brand Capital, self-correcting) · **Confidence:** confirmed
- **Location:** `server/services/scoringService.ts:488-499`
- **Evidence:** the section is labeled "time-decaying" but applies `Math.min(8, Math.round(delta*0.8))` with no decay; the comment "No daysSince available cleanly here" is false — `daysSince` is computed 17 lines up (`:480`) and used by the sibling Trends signal. A 90-day-old +10 article delta scores +8 (treated as breaking news), while the identical-shape Trends delta decays to ~0. Clamped twice (`min(8,…)`, Brand `min(100,…)`) so max ≈ +2–3.2 internal points, and it re-bases next snapshot — a stale-signal bonus, not a runaway.
- **Recommended change:** hoist `daysSince` above both blocks and apply `delta*0.8*Math.pow(0.5, daysSince/positiveHalfLifeDays)`.
- **Risk/effort:** low / ~5 lines; slightly lowers some athletes' Brand Capital on next rescore.

### SCORE-4 · Deal score is not reproducible run-to-run (design) — **CONFIRMED (observation)**
- **Severity:** low · **Confidence:** confirmed
- The grid (`dealScoreGrid.ts`) is pure/deterministic, but its four inputs (`sportFit`/`audienceFit`/`brandTier`/`offer_struct`) come from Kimi at `temperature: 0.1` (`kimi.ts:84`, `dealDetector.ts:731`, `threadSummarizer.ts:93`). Near a bucket boundary a rating flip moves the score ±1 and can flip the verdict at the 3/5/7 edges. Coarse ordinal buckets + `validRating` fallback already absorb most variance. `temperature: 0` would reduce (not eliminate — MoE/batched serving) variance; verify Vertex accepts 0 for this model. Cheap improvement, not a correctness fix.

### SCORE-5 · Weights singleton hazards — **REFUTED (well-built)**
- Investigated and cleared: `reloadWeights` patches a **fresh** object from a new query and swaps `_cached` by atomic reference; `computeScore` is synchronous and callers capture weights once, so no mid-request mix or in-place corruption. Two trivial hardening notes only: `:333` assigns the `DEFAULT_DEAL_TYPE_WEIGHTS` module constant by reference (deep-clone to be safe), and `:327/:381` would NPE at boot if whole config sections are absent (guard them). Recorded so it isn't re-investigated.

### SCORE-6 · `google_trends_score` NaN propagation — **PLAUSIBLE (low likelihood)**
- `parseFloat(... as string)` (`researchAthlete.ts:442`, `fetchSocialData.ts:267`); a non-numeric string yields `NaN` that slips past every `?? 0` (NaN isn't null) into a `NaN` internalScore. Values are written as `String(number)`, so it needs external DB corruption to trigger. Add a `Number.isFinite` guard at the two parse sites. Trivial.

---

## Cross-cutting observations (not per-file bugs)

- **Test coverage is near-zero for the parts that matter.** The only tests cover the two pure
  modules (`withTimeout`, `dealScoreGrid`). The 900-line `computeScore`, all route handlers,
  every integration's token-refresh/cursor logic, and all concurrency/idempotency behavior are
  untested. Several confirmed bugs above (SCORE-1, SCORE-2, PIPE-1/2) would have been caught by
  a modest unit/integration suite. This is the single biggest multiplier on future velocity.
- **No global LLM concurrency gate / retry in the deal path** (documented + deferred in
  `docs/llm-concurrency-spec.md`). Real, but the maintainer has already scoped it — not re-sold.
- **Timeouts don't cancel underlying work** (`withTimeout` loser keeps running; SSE abort not
  passed to `kimiStream`). Low impact today; note for the durable-queue work.
- **DESIGN.md source-of-truth chain is broken:** `DESIGN.md:594-609` lists `Button.tsx`,
  `Card.tsx`, `web/styles/tokens.css`, `assets/logo-mark.svg` as canonical — none exist.
- **`package.json:9`** references `scripts/build.js` which doesn't exist (`expo:static:build` broken).
- **In-process cron comment mismatch:** `server/index.ts:334` says "every 50 days" but
  `0 3 1 */2 *` fires on the 1st of every other month; IG token (60-day expiry) could lapse in a
  short month before refresh. Verify against the Cloud Scheduler job (the primary trigger).
- **~27 `server/scripts/`**: underscore-prefixed ones are one-off/debug and mostly deletable;
  keep `backfillBrandIdentityWrite.ts` (CI), `createTriggers.ts` (installs the `tasks`
  LISTEN/NOTIFY trigger), `seedWeightsV7.ts` (seeds live config), and recent backfills.

---

## Architecture & direction

### Current-state assessment
The system is well-conceived for its age: a clean separation between deterministic scoring
(`dealScoreGrid`, `computeScore` are pure and one is unit-tested) and nondeterministic LLM
judgment, a sensible "skills" decomposition, and honest self-documentation of deferred work.
The design instinct — *let the LLM supply subjective components, let code own the number* — is
the right one and worth preserving. The weaknesses are not architectural taste; they're the
gaps you'd expect from moving fast: **durability of the ingest pipeline, DB-level integrity
constraints, secrets hygiene, and tests.** Fix those and the current shape scales a long way.

The three genuinely structural issues, highest-leverage first:

**1. The inbox pipeline needs a durable work queue — this is the one real architectural gap.**
Today ingestion is: Pub/Sub push → ack immediately → best-effort `Promise.allSettled` of
`detectDeal` → advance cursor. Every confirmed data-loss and duplicate finding (PIPE-1/2/3, and
the deferred `llm-concurrency-spec`) traces to the same root: *processing is coupled to the
webhook request and gated by an application-level check-then-act instead of the database.* The
fix is not a rewrite — it's inserting a durable step:
   - Enqueue each `(connection, message_id)` into a `pipeline_jobs` table (or Cloud Tasks —
     already a dependency, `@google-cloud/tasks`) on receipt; ack Pub/Sub only after the enqueue.
   - A worker drains jobs with a claimed/attempts/backoff pattern, and the DB's unique
     constraints (PIPE-1/2 fixes) make each job idempotent and each thread/deal singular.
   - The cursor advances only when the enqueue is durable, not when processing finishes.
   This single change subsumes PIPE-1, PIPE-2, PIPE-3, PIPE-5, and the deferred concurrency gate,
   and it's the precondition for scaling past one mailbox. **Sequencing: do the cheap DB-constraint
   fixes now (they're independently valuable); build the queue when you onboard real inboxes.**

**2. Push integrity constraints down into Postgres.** The pattern throughout is
application-level uniqueness (SELECT-then-INSERT) with no DB backstop, plus nullable enum
columns that void their own CHECKs, plus no ON DELETE policy. The database is doing far less
integrity work than it could. Adding the handful of unique/`NOT NULL`/FK-cascade constraints
(PIPE-1/2, DB-2/4/6) converts a class of race conditions and orphan-row problems into
impossible states. Low effort, high durability payoff, and it makes the queue in (1) simpler.

**3. Consolidate to one schema pipeline and add a test harness.** The deploy-time hand-DDL block
racing `migrations/` (DB-5) plus zero integration tests means schema and behavior drift are both
invisible until they hit prod. Pick migrations as the single source; stand up a throwaway-Postgres
integration test (the inbox durability doc already sketches the cases). This is the enabler for
touching the pipeline safely.

### On making the system "more agentic" — a measured take
The product is already LLM-heavy; the useful next step is **not** more autonomy but more
*reliable, observable* LLM use. Two directions actually pay off:
- **Tool-calling for the research/enrichment path.** `researchAthlete`/`researchBrand` currently
  orchestrate Gemini-grounding + Kimi-extraction + Trends + GDELT with hand-rolled retry in three
  places. A single agent loop with typed tools (search, fetch-social, fetch-news) and one shared
  concurrency/retry gate (the deferred `llm.ts`) would cut duplication and make cost/latency
  observable. This is consolidation, not new capability — low risk, real cleanup.
- **Draft-reply as a guarded agent.** The one user-facing LLM surface (deal draft/chat) is where
  autonomy would be felt. Keep it human-in-the-loop (the `pending_action` column already models
  approve-before-execute) — that's the right posture; don't auto-send.

What to **resist**: a full agent framework, a vector DB, or autonomous multi-step deal
negotiation. There's no evidence the current volume needs any of them, and the prompt-injection
surface (raw email bodies feed classify/summarize/score today) argues for *tighter* control of
what the LLM can act on, not looser. Sanitize/delimit untrusted email content before it enters
any prompt that influences an action.

### Tool/tech choices worth a look (each optional, with the tradeoff)
- **Cloud Tasks over a hand-rolled queue** (already a dependency) — managed retry/backoff vs. a
  little vendor coupling. Recommended if you build the queue.
- **KMS/pgcrypto for token encryption** (SEC-7) — standard, low-friction; do before real inboxes.
- **Keep Drizzle + Postgres.** No reason to change the ORM or DB; the issues are missing
  constraints and process discipline, not the tools.
- **A staging DB + migration approval gate** — the highest-value infra change; migrations
  currently hit prod from every merge (INFRA-1).

---

## Quick wins vs. deep work

### Quick wins (hours, low risk — start here, batch-able)
| Item | Fix | Effort |
|------|-----|--------|
| SEC-1 admin open | flip default closed, remove prod env, grant admins via script | ~15 min |
| SEC-2 hung request | try/catch in requireAuth/requireAdmin + global error handler | ~10 min |
| DB-1 auth index | `CREATE INDEX CONCURRENTLY` on `athletes.auth_id`/`lower(email)` | minutes |
| DB-2 FK indexes | btree on the `athlete_id` columns | minutes |
| SCORE-2 NPE | `(a.name ?? "")` guard (2 sites) | trivial |
| SCORE-3 GDELT decay | hoist `daysSince`, apply decay | ~5 lines |
| SEC-11 fuzzy claim | drop fuzzy branch / anchor to exact name+proof | ~1 h |
| FE-5 Mia→Mila | rename 3 strings | trivial |
| FE-1 dead code | delete `opps/` tree + `DealDetailSheet` + `SearchAskSheet` (migrate tokens first) | ~1 h |
| SEC-8 test page | disable `ENABLE_TEST_PAGE` in prod | trivial |
| DESIGN.md / build.js | fix or remove stale references | minutes |

### Medium (half-day each, needs a little care)
- **PIPE-2 → PIPE-1**: dedupe threads, add unique `(athlete_id, external_thread_id)` index,
  make deal linking atomic. Do PIPE-2 first (keystone). Needs a one-time merge script.
- **SEC-6 credential**: rotate password, move to Secret Manager, purge git history, switch dev to
  Auth Proxy, prune `authorized-networks`.
- **SEC-9 Gmail webhook**: add OIDC push-token verification.
- **SEC-10 OAuth state**: signed/stored nonce, remove INSERT-without-pending fallback.
- **SCORE-1**: wire the deals table into the scoring snapshot (confirm product intent first).
- **SEC-7 token encryption**: KMS/pgcrypto envelope on token columns.
- **INFRA-2/3**: SIGTERM graceful shutdown; boot-time `zod` env validation.
- **FE-2/3**: FlashList virtualization + split `DealCard`.

### Deep work (sequence deliberately, not blocking launch)
- **Durable ingest queue** (architecture §1) — subsumes PIPE-3/5 and the deferred concurrency
  gate. Build when onboarding real inboxes.
- **DB-5 / INFRA-1**: consolidate to migrations-only, repair Drizzle metadata, add a staging DB +
  migration approval gate + `drizzle-kit check` in CI.
- **Test harness**: throwaway-Postgres integration tests for the pipeline + unit tests for
  `computeScore`. The velocity multiplier.
- **Shared `llm.ts`** (already spec'd in `docs/llm-concurrency-spec.md`): one gate + retry +
  timeout; consolidate the 3 ad-hoc retry loops and the research orchestration.
- **DB-4**: ON DELETE policy + a `deleteAthlete` routine (needed for GDPR-style deletes).
