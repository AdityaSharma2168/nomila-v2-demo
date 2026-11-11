# Inbox Providers: Outlook + Instagram (modernized)

**Status:** Phase 0 + Phase 1 code complete (uncommitted) — pending deploy + test
**Owner:** Aaron
**Last updated:** 2026-06-08

> **Implementation status**
> - **Phase 0 (refactor):** ✅ code written. `types.ts`, `registry.ts`, `inboxCronSync.ts`;
>   `gmail.ts` gained `onConnected`/`syncRecent`; `connections.ts`/`oauthCallback.ts` use the
>   registry; `gmailCronSync.ts` deleted. Builds clean, 0 new type errors. Not yet deployed.
> - **Phase 1 (Outlook):** ✅ code written. `outlook.ts` (delta polling, read-only) + registered
>   in `registry.ts`. Frontend row already present. Builds clean. **Needs manual setup before
>   testing** (see "Manual setup" below).
> - **Both untested** — blocked on git write access + deploy (only `main` deploys, via
>   `.github/workflows/deploy.yml`). No staging backend; deploy lands on the live `nomila-v2`.
>
> **Manual setup required before Outlook can connect:**
> 1. Register an app in Azure/Entra (multi-tenant + personal accounts, authority `common`).
> 2. Add redirect URI: `${API_BASE_URL}/api/v1/auth/callback/outlook`.
> 3. Delegated scopes: `Mail.Read`, `offline_access`, `User.Read`.
> 4. Add secrets to Secret Manager + `gcp/cloud-run-v2.yaml`: `MICROSOFT_CLIENT_ID`,
>    `MICROSOFT_CLIENT_SECRET` (optional `MICROSOFT_TENANT`, default `common`).

## Goal

Add **Outlook** (Microsoft Graph) as a real email inbox provider, and **finish/modernize
Instagram** by migrating from the Facebook-Page-linked flow to the direct **Instagram Login**
flow. Do a small **provider-interface refactor** first so adding providers is additive instead
of editing scattered switch statements.

## Decisions locked

| # | Decision | Choice |
|---|----------|--------|
| 1 | Outlook realtime | **Delta-query polling** (reuse cron + `sync_cursor`). Webhooks deferred. |
| 2 | Instagram flow | **Instagram Login** (direct Business Login, no Facebook Page). |
| 3 | Replies | **Deferred** for both. v1 = read/sync only (feed `detectDeal`). |
| 4 | Refactor | **Yes, first.** Provider interface + registry before adding providers. |
| 5 | IG dual-role | IG `onConnected` does **webhook-subscribe only**; scoring stays in `fetchSocialData`. |
| 6 | Cron route | Keep `/api/internal/gmail-cron-sync` name as an **alias**; generalize the handler. No Scheduler change. |
| 7 | Token encryption | **Tracked separately**, not blocking v1. Ship with existing plaintext storage like Gmail. |
| 8 | Outlook backfill | First delta pass filters to **last 90 days** (matches Gmail backfill). |

## Sequencing

1. **Phase 0 — Provider interface refactor** (½–1 day)
2. **Phase 1 — Outlook** (delta polling, read-only) (~2 days)
3. **Phase 2 — Instagram modernization** (Instagram Login + webhooks, read-only) (~3–4 days dev)
   - **Start Meta App Review in parallel with Phase 1** — it is the long pole (days→weeks).

---

## How the inbox works today (grounding)

Single ingestion funnel: **everything flows into `detectDeal()`** which classifies, scores,
upserts `inbox_threads` + `inbox_messages`, dedupes on `(thread_id, external_message_id)`.

- `server/skills/dealDetector.ts` — `detectDeal({ athleteId, connectionId, message })`.
  `IncomingMessage` (line ~55) fields: `gmailMessageId`, `gmailThreadId`, `subject`, `from`,
  `body`, `date`, `messageIdHeader`, `platform?` (`'gmail'|'instagram'`, default gmail),
  `senderIgUserId?`. The `gmail*` names are historical — they're really generic
  `externalMessageId` / `externalThreadId`. **Outlook reuses these as-is.**
- `connected_accounts` (schema.ts ~line 360): tokens, `platform_user_id/username`, `scopes`,
  `gmail_history_id`, **`sync_cursor`** (already exists — perfect for Outlook deltaLink + IG
  webhook cursor), `last_fetched_at`, `alias`, status lifecycle `pending→active→expired→revoked`.
- OAuth dispatch lives in **two switch statements**:
  - `server/routes/connections.ts:39` — `getAuthUrl`
  - `server/routes/oauthCallback.ts:141` — `handleCallback` + post-connect side effects
- Post-connect side effects (`oauthCallback.ts:157`): gmail → `setupPushNotifications` + 90-day
  `runGmailBackfill`; everything else → `fetchSocialData` (scoring).
- Sync: `server/skills/gmailCronSync.ts` (`fetchRecentMessages` → `detectDeal`) on a 6h
  node-cron + Cloud Scheduler `/api/internal/gmail-cron-sync`. IG: `instagramSync.ts` →
  `/api/internal/instagram-sync`. Watch renew: `/api/internal/gmail-watch-renew` (6 days).
- Webhooks: `server/routes/webhooks.ts` — `/api/webhooks/gmail` (Pub/Sub). Mounted with
  `express.raw` at `index.ts:47`. CRON endpoints guarded by `x-cron-secret` (`CRON_SECRET`).
- Frontend: `client/components/deals/InboxConnectSheet.tsx:28` — `INBOX_PLATFORMS` already
  lists Outlook (with `hasAlias: true`); social list has Instagram. Connect flow via
  `usePlatformOAuth` → deep link `co.nomila.app://connect/callback`.

---

## Phase 0 — Provider interface refactor

**Why:** two `switch` blocks must currently be edited in lockstep for every provider; miss one
and you get a half-wired provider. Replace with one contract + one registry.

**Important nuance — two kinds of provider:**
- **OAuth** is common to *all* platforms (inbox + social: ig/tiktok/youtube/spotify/gmail/outlook).
- **Inbox sync** (normalize → `detectDeal`) applies only to gmail/outlook/instagram-DMs.
- **Instagram is dual-role:** it's a *social/scoring* provider (`fetchForScoring`) **and** an
  inbox/DM provider. Keep both responsibilities; don't collapse them.

**New files**
- `server/lib/integrations/types.ts`
  ```ts
  export interface OAuthProvider {
    getAuthUrl(athleteId: string, alias?: string): string;
    handleCallback(code: string, athleteId: string, alias?: string): Promise<void>;
  }
  export interface InboxProvider extends OAuthProvider {
    /** fire-and-forget after an active connection exists (push setup, backfill, webhook sub) */
    onConnected?(connectionId: string, athleteId: string): Promise<void>;
    /** periodic + webhook-driven pull → normalize → detectDeal */
    syncRecent(connectionId: string, athleteId: string): Promise<{ detected: number; skipped: number }>;
    refreshToken?(connectionId: string): Promise<void>;
  }
  ```
- `server/lib/integrations/registry.ts`
  ```ts
  export const OAUTH: Record<string, OAuthProvider> = {
    instagram, tiktok, youtube, gmail, spotify, outlook,
  };
  export const INBOX: Record<string, InboxProvider> = {
    gmail, outlook, // instagram DMs are webhook-driven; can be added once modernized
  };
  ```

**Refactor (wrap existing functions — do NOT rewrite them):**
- `connections.ts` switch → `const p = OAUTH[platform]; if (!p) return 400; redirectUrl = p.getAuthUrl(...)`.
- `oauthCallback.ts` switch → `OAUTH[platform].handleCallback(...)`; post-connect becomes
  `INBOX[platform]?.onConnected?.(connectionId, athleteId)` else `fetchSocialData(...)`.
  - Move gmail's existing push+backfill logic into `gmail.onConnected`.
- Generalize `gmailCronSync` → `inboxCronSync` looping `Object.values(INBOX)` calling `syncRecent`.
  (Keep the existing `/api/internal/gmail-cron-sync` route name as an alias to avoid breaking
  Cloud Scheduler, or add `/api/internal/inbox-cron-sync` and repoint Scheduler.)

**Acceptance:** Gmail + existing social connect/sync behave identically; new providers are
"add a module + one registry line."

**Risk:** low. Pure indirection over working code. Validate by reconnecting Gmail end-to-end.

---

## Phase 1 — Outlook (Microsoft Graph, delta polling, read-only)

Structurally a clone of `gmail.ts`. Real email → maps cleanly onto threads/messages/brands.

### Azure / app registration (manual, one-time)
- Register app in Entra (Azure portal) → **multi-tenant + personal Microsoft accounts**
  (`/common` authority) so both work and @outlook/@hotmail accounts connect.
- Redirect URI: `${API_BASE_URL}/api/v1/auth/callback/outlook`.
- Delegated scopes: `Mail.Read`, `offline_access` (refresh tokens), `User.Read`.
  (Add `Mail.Send` later in the replies phase — **not now**. The send code is built behind
  `OUTLOOK_SEND` (4 Nov 2026); what adding the scope changes is in
  [`outlook-send-azure-checklist.md`](outlook-send-azure-checklist.md).)
- Secrets → Google Secret Manager: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
  optional `MICROSOFT_TENANT` (default `common`).

### New file: `server/lib/integrations/outlook.ts`
Mirror gmail.ts. Endpoints:
- Authorize: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- Token: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- Graph base: `https://graph.microsoft.com/v1.0`

Functions:
- `getAuthUrl(athleteId, alias?)` — same `state = athleteId[:alias]` encoding as gmail.
- `handleCallback(code, athleteId, alias?)` — exchange code; `GET /me` for `mail`/`userPrincipalName`
  → `platform_username`, `id` → `platform_user_id`; store access/refresh/expiry like gmail.
- `refreshToken(connectionId)` — MS refresh grant; mirror `refreshTokenIfNeeded`.
- `syncRecent(connectionId, athleteId)` — **delta query**:
  - First run: `GET /me/mailFolders/Inbox/messages/delta?$select=...&$top=50`.
  - Page `@odata.nextLink`; store final `@odata.deltaLink` in **`sync_cursor`**.
  - Next runs: GET the saved `deltaLink` → only changed messages.
  - Normalize each → `detectDeal({ athleteId, connectionId, message: { gmailMessageId: msg.id,
    gmailThreadId: msg.conversationId, subject, from: msg.from.emailAddress.address, body:
    msg.body.content (strip HTML, cap 4000), date: msg.receivedDateTime, messageIdHeader:
    msg.internetMessageId, platform: 'outlook' } })`.
  - Update `last_fetched_at`.
- `onConnected(connectionId, athleteId)` — initial backfill: run the first delta pass (seeds
  cursor + ingests recent inbox). Optionally bound to "last 90 days" by filtering
  `receivedDateTime` on the first pass to match Gmail's backfill window.

### Wiring
- Register in `registry.ts` (`OAUTH.outlook`, `INBOX.outlook`).
- Add `'outlook'` to `dealDetector` platform comment / any platform allowlist (`platform` is a
  free-text column — confirm no CHECK constraint blocks `'outlook'`; schema shows none on
  `inbox_messages.platform`, default `'gmail'`).
- Frontend: `InboxConnectSheet.tsx` Outlook row already present — works once backend supports it.
- Cron: picked up automatically by the generalized `inboxCronSync` (Phase 0).

### Notes / gotchas
- Delta tokens can expire/410 → on `410 Gone`, drop cursor and re-seed from a fresh delta.
- HTML bodies: Graph returns HTML by default; request `Prefer: outlook.body-content-type="text"`
  to get plain text and skip stripping.
- No Pub/Sub-style infra needed. No webhook endpoint, no subscription renewal cron.

**Acceptance:** connect an @outlook.com and an M365 account → recent brand emails appear in
Opportunities within one poll cycle; reconnect/refresh works; multi-account via alias works.

---

## Phase 2 — Instagram (Instagram Login + webhooks, read-only)

Modernize the existing `instagram.ts` from Facebook-Page-linked → **Instagram API with Instagram
Login**. Keep `fetchForScoring` (scoring) working; swap the auth + DM ingestion path.

### Platform constraints to design around
- **Business/Creator accounts only** — personal IG can't use messaging. Need explicit UX/error.
- **24-hour messaging window** — only matters for *replies* (deferred). Read/sync unaffected.
- **Reply-initiated** — can only message users who messaged first (fine for inbox).
- **Meta App Review required** for `instagram_business_manage_messages` — **start early.**

### Meta app config (manual)
- Use **Instagram API with Instagram Login** product (not Facebook Login).
- Permissions: `instagram_business_basic`, `instagram_business_manage_messages`.
- OAuth host: `https://www.instagram.com/oauth/authorize` (Instagram-hosted, not facebook.com).
- Token exchange: `https://api.instagram.com/oauth/access_token` → short-lived, then long-lived
  (`https://graph.instagram.com/access_token?grant_type=ig_exchange_token`, 60-day).
- Refresh: `grant_type=ig_refresh_token` (the existing refresh logic mostly carries over).
- Webhooks: subscribe app to `messages` field; set callback `${API_BASE}/api/webhooks/instagram`
  with a verify token. Secrets: `IG_WEBHOOK_VERIFY_TOKEN`, reuse `INSTAGRAM_APP_SECRET` for
  payload HMAC (`X-Hub-Signature-256`).

### Changes to `server/lib/integrations/instagram.ts`
- `getAuthUrl` → Instagram-hosted authorize URL + new scopes.
- `handleCallback` → Instagram token exchange (drop the `/me/accounts` Facebook Page lookup;
  the token *is* the IG business account). Store `platform_user_id` = IG user id.
- `fetchForScoring` → repoint profile/media reads to `graph.instagram.com` (was
  `graph.facebook.com`). Field set is largely the same.
- `fetchDirectMessages` → `graph.instagram.com/{ig-user-id}/conversations` (same shape).
- `onConnected` → subscribe the connection to the `messages` webhook field; optional initial DM
  backfill via `syncRecent`.

### New: `server/routes/webhooks.ts` → add `/instagram`
- `GET /api/webhooks/instagram` — verification handshake: echo `hub.challenge` when
  `hub.verify_token === IG_WEBHOOK_VERIFY_TOKEN`.
- `POST /api/webhooks/instagram` — verify `X-Hub-Signature-256`, ack 200 fast, then per inbound
  message: look up `connected_accounts` by `platform_user_id` (recipient IG id), normalize →
  `detectDeal({ ..., platform: 'instagram', senderIgUserId, gmailMessageId: msg.id,
  gmailThreadId: conversationId })`. Mirror the gmail webhook's ack-first pattern.
- Mounting note: `index.ts:47` mounts `/api/webhooks` with `express.raw`. HMAC needs the raw
  body — already satisfied. Parse JSON manually like the gmail handler does.

### Keep as fallback
- `instagramSync.ts` polling (`/api/internal/instagram-sync`) stays as a safety net for dropped
  webhooks, same as Gmail keeps its cron fallback.

**Acceptance:** connect an IG Business account via Instagram login (no Facebook prompt); DMs to
the account create threads in Opportunities in near-real-time via webhook; scoring still works;
personal-account attempt shows a clear error.

---

## Cross-cutting / explicitly out of scope for v1

- **Replies** — IG DM send shipped. Outlook replies are BUILT (4 Nov 2026) behind `OUTLOOK_SEND` (off),
  via Graph `/me/messages/{id}/reply` through the governed approve path; they need `Mail.Send`, which the live
  OAuth request does not ask for yet — see [`outlook-send-azure-checklist.md`](outlook-send-azure-checklist.md).
- **Outlook webhooks** — deferred; delta polling only.
- **Token encryption at rest** — tokens are currently plaintext in `connected_accounts`. Adding
  Microsoft + Meta tokens is a good moment to add encryption (also relevant to Meta App Review
  data-handling). **Flag for a decision — not blocking v1, but recommended.**
- **24h-window-aware reply copilot** — lands with the replies phase.

## Schema impact

Likely **none required** for v1 — `sync_cursor` covers Outlook deltaLink and IG webhook cursor;
`platform` is free-text. Possible small additions if we want them:
- `connected_accounts.webhook_subscription_id` (IG) — only if we track subscriptions per-account.
- Confirm no `CHECK` on `inbox_messages.platform` (verified: none) so `'outlook'` is accepted.

## Env / secrets to add

```
MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT            # optional, default "common"
IG_WEBHOOK_VERIFY_TOKEN
# reuse: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, API_BASE_URL, CRON_SECRET
```

## Testing strategy

- Phase 0: regression — reconnect Gmail, confirm push + backfill + 6h sync unchanged.
- Phase 1: real @outlook + M365 test accounts; send a "brand" email, confirm thread appears;
  force a 410 to test delta re-seed; alias multi-account.
- Phase 2: IG Business test account; trigger a DM; verify webhook signature path; verify
  personal-account rejection; verify scoring unaffected.

## Resolved decisions (was: open questions)

1. ✅ **Instagram dual-role:** IG `onConnected` does **webhook-subscribe only**; scoring stays in
   the existing `fetchSocialData` path. Cleanest separation, least disruption to scoring.
2. ✅ **Cron route naming:** keep `/api/internal/gmail-cron-sync` as an **alias** and generalize
   the handler to loop all `INBOX` providers. No Cloud Scheduler change.
3. ✅ **Token encryption:** **tracked separately** as hardening; not blocking v1. Ship with
   existing plaintext storage (same as Gmail today).
4. ✅ **Outlook backfill window:** first delta pass filters to **last 90 days** (matches Gmail).

## Still needs an owner / external input

- **Meta App Review:** who owns submission + screencast, and what's the business-verification
  status of the Meta app today? This gates Phase 2 go-live (not Phase 2 dev — we can build
  against a dev/test account while review is pending). **Start the submission during Phase 1.**
