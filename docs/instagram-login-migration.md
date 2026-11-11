# Migration: Instagram via Facebook Login → **Instagram API with Instagram Login**

Status: **code implemented** on branch `feat/instagram-login-migration` — merges *ready-but-dormant*
(IG connect returns a clear "not configured" error until the Instagram app credentials + console
setup land; nothing else changes). Goal: athletes connect **Instagram directly** — no Facebook
account, no Facebook Page — while keeping everything we do today (profile + analytics for scoring,
DM read + reply into the deal inbox, real-time DM webhooks).

Sources: official Meta docs (developers.facebook.com/docs/instagram-platform, "Instagram API with
Instagram Login" sections) + a full codebase audit. Doc URLs inline where load-bearing.

### Decisions locked (this migration)
- **`profile_views` → `profile_links_taps`**, surfaced in the Analytics tab as **"Profile Link Taps"** (relabeled, not dropped).
- **`HUMAN_AGENT` 7-day reply window kept** — standard `RESPONSE` inside 24h, auto-retry under the `HUMAN_AGENT` tag when the window has closed.
- **Instagram App ID supplied later** — built against `INSTAGRAM_LOGIN_APP_ID` / `INSTAGRAM_LOGIN_APP_SECRET`; dormant until set.
- **Correction vs. the original audit:** `igTokenRefresh.ts` is **NOT deleted** — it refreshes the *global app-owned* `IG_PAGE_ACCESS_TOKEN` used by the separate **business-discovery** subsystem (`platformDiscovery.ts`), which stays on the Facebook-Login model. Per-athlete connection tokens are refreshed by `refreshTokenIfNeeded` (fires on every DM read/send + inbox poll).

---

## 1. Why & what changes at a glance
We currently use **Instagram API with *Facebook* Login**: the athlete's IG Business account must be
linked to a Facebook **Page**, we authenticate the **Facebook** admin, and we read IG *through* that
Page (`/me/accounts` → `instagram_business_account`, a **Page token**, page-scoped DMs). That's why
Mia is being asked for Facebook + a Page + a Facebook app-role — pure plumbing, not the goal.

**Instagram Login** removes all of that: the athlete logs in with **Instagram**, we get an **IG user
token**, and everything hangs off the IG account (`graph.instagram.com`). No Page, no Facebook.

| | Today (Facebook Login) | After (Instagram Login) |
|---|---|---|
| Auth screen | `facebook.com/<v>/dialog/oauth` | `www.instagram.com/oauth/authorize` |
| App id used | Facebook App ID | **Instagram App ID** (different — easy to get wrong) |
| Token | Facebook **Page** token (no expiry) | **IG user** token (60-day, refreshable) |
| Account resolution | `/me/accounts` → pick Page → its IG business account | none — token *is* the IG account; call `/me` |
| API host | `graph.facebook.com` | `graph.instagram.com` |
| DMs | `/{page-id}/conversations`, `/{page-id}/messages` (Page token) | `/me/conversations`, `/me/messages` (IG token) |
| Webhook | `page` object, subscribe `/{page-id}/subscribed_apps` | `instagram` object, subscribe `/me/subscribed_apps` |
| Athlete needs | Professional IG **+ FB Page + FB account admin** | Professional IG **only** |

**What does NOT change:** the athlete's IG must still be a **Professional (Business/Creator)** account,
and **DMs + insights still require Meta App Review (Advanced Access) + Business Verification** to serve
real (non-tester) athletes. Migration removes the *Facebook* friction; it does **not** remove the App
Review gate. (Today's flow needs App Review too — so this is net-neutral on review, net-win on friction.)

**Lucky break:** after the connection purge, there are **zero active IG connections** in the DB — so
there is **no data migration**; every athlete reconnects fresh through the new flow.

---

## 2. New OAuth + token flow (exact)
- **Authorize:** `GET https://www.instagram.com/oauth/authorize?client_id=<IG_APP_ID>&redirect_uri=<URI>&response_type=code&scope=<comma-separated>&state=<signed>`
- **Short-lived token:** `POST https://api.instagram.com/oauth/access_token` (`client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`) → `{access_token, user_id, permissions}`, **1-hour** life.
- **Long-lived token:** `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=<secret>&access_token=<short>` → **60-day** token.
- **Refresh:** `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<long>` (token must be ≥24h old) → another 60 days.
- **Identify account:** `GET https://graph.instagram.com/me?fields=user_id,username,account_type,followers_count,follows_count,media_count`.

**Scopes** (comma-separated): `instagram_business_basic`, `instagram_business_manage_messages`,
`instagram_business_manage_insights`. **Drop** `pages_show_list`, `pages_read_engagement`,
`pages_manage_metadata`, and rename `instagram_basic`→`instagram_business_basic` etc. (old
`business_*` names were deprecated Jan 27 2025.)

---

## 3. DMs (read / reply / webhook) — exact
- **List conversations:** `GET graph.instagram.com/me/conversations?platform=instagram` (append `&user_id=<IGSID>` to find one).
- **Read messages:** `GET graph.instagram.com/<CONVERSATION_ID>?fields=messages` (returns 20 most recent); message details `GET /<MESSAGE_ID>?fields=id,created_time,from,to,message`.
- **Send/reply:** `POST graph.instagram.com/me/messages` body `{recipient:{id:<IGSID>}, message:{text:<≤1000 bytes UTF-8>}}`. **24-hour** reply window after the user's last message (no cold-start); `HUMAN_AGENT` tag extends to 7 days.
- **Webhook:** object **`instagram`**, field **`messages`**; subscribe the account via `POST graph.instagram.com/me/subscribed_apps?subscribed_fields=messages`. Inbound payload: `entry[].id` = the IG account id, `entry[].messaging[].sender.id` = **IGSID**, `message.mid`, `message.text` — same nesting as today.

⚠️ **IGSIDs are a fresh identity space** (scoped to person × app × IG account) and are **not**
interchangeable with any Page-scoped IDs we stored before. Re-key threads off inbound webhooks; don't
map old IDs.

---

## 4. Analytics / insights — exact
- **Account insights:** `GET graph.instagram.com/me/insights` (scope `instagram_business_manage_insights`). Valid metrics include `reach`, `views`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `shares`, `saves`, `follower_demographics` (breakdown `age|city|country|gender`, `timeframe`, **≥100 followers**).
- **Media insights:** `GET graph.instagram.com/<MEDIA_ID>/insights` (feed/reels/story metric sets; reels adds watch-time).
- **Profile + media:** `GET /me?fields=followers_count,follows_count,media_count,...`, `GET /me/media`.

**Two metric breakages to handle:**
1. **`profile_views` is gone** under Instagram Login (we currently request it). Replace with account
   `profile_links_taps` or media `profile_visits`, or drop it. **Decision needed.**
2. **`impressions` is deprecated** (use `views`). We already store `views` in the `impressions`
   column, so low impact — just stop requesting `impressions`.

---

## 5. Code change map (from the audit)
**`server/lib/integrations/instagram.ts`** — the main surface:
- `getAuthUrl` → Instagram authorize URL + new scopes.
- `handleCallback` → new token chain (`api.instagram.com` → `graph.instagram.com`); **delete the `/me/accounts` Page lookup**; store the **IG user token** + `token_expires_at` (~60d); drop `ig_page_id`; reject non-professional accounts with a clear error.
- `refreshTokenIfNeeded` → `ig_refresh_token` on the user token (real refresh now, not a no-op).
- `fetchForScoring` / `fetchAnalytics` → host `graph.facebook.com` → `graph.instagram.com`; replace `profile_views`.
- `fetchDirectMessages` / `resolveDmContext` / `sendInstagramDM` → `/{ig_page_id}/…` → `/me/…` (IG token).
- `subscribePageToMessages` → replace with `POST /me/subscribed_apps` (IG webhook subscribe).

**Other files (done):**
- `server/routes/webhooks.ts` → HMAC secret now prefers `INSTAGRAM_LOGIN_APP_SECRET` (falls back to `INSTAGRAM_APP_SECRET`). The messaging handler already routed by `platform_user_id` (= `entry.id` under Instagram Login), so no routing change needed; the `ig_page_id` branch just goes dormant.
- `client/components/analytics/AnalyticsTab.tsx` → "Profile Views" tile relabeled "Profile Link Taps".
- `shared/schema.ts` → **unchanged.** `connected_accounts.ig_page_id` stays a nullable column (now written as `null` for IG-Login connections); `token_expires_at` now populated (60d); `refresh_token` stays null (IG refreshes the access token in place). No migration needed.
- Env: **add** `INSTAGRAM_LOGIN_APP_ID` + `INSTAGRAM_LOGIN_APP_SECRET` (the *Instagram* app credentials). **Keep** `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` / `IG_PAGE_ACCESS_TOKEN` / `IG_BUSINESS_ACCOUNT_ID` — still used by business-discovery + `igTokenRefresh.ts`.

**Unchanged (orchestration):** `registry`, `oauthCallback`, `oauthState`, `connections` (incl. the
#69 web-return fix), `instagramSync`, `dealDetector`, `inboxCronSync`, `fetchSocialData`,
`scoringService`, `collectSocialAnalytics`, `igTokenRefresh.ts` + business-discovery, snapshot
schema, the `can_send` flag, the client connect hook (already sends `clientPlatform`). Blast radius
is contained to `instagram.ts` + a webhook-secret tweak + a UI relabel.

---

## 6. Meta console setup (manual — you/the app admin, not code)
1. App Dashboard → add **Instagram** product → **"API setup with Instagram business login"** (not "…with Facebook login").
2. Set **OAuth redirect URI** = our callback (`…/api/v1/auth/callback/instagram`), plus **Deauthorize** + **Data Deletion** callback URLs.
3. Grab the **Instagram App ID + secret** (may differ from the Facebook App ID/secret we use today).
4. Configure the **`instagram` webhook** (field `messages`) with a verify token.
5. Confirm Mia's IG is an **accepted Instagram Tester** (she already appears as `GameChanger-IG` in her Tester Invites — good for Dev-Mode testing).
6. **For production (all athletes):** **App Review** (Advanced Access for `instagram_business_manage_messages` + `instagram_business_manage_insights`) + **Business Verification**. Screencast + step-by-step reviewer instructions per permission.

---

## 7. Phased rollout
1. **Meta console setup** (§6 steps 1–4) — unblocks everything; you do this.
2. **Code migration** (§5) behind the existing IG connect button — I do this. Test end-to-end against **Mia (tester)** in Dev Mode: connect → profile/insights snapshot → DM backfill → send a reply → webhook delivers an inbound DM.
3. **App Review + Business Verification** (§6.6) — you submit; unlocks non-tester athletes.
4. **Flip on for all athletes** once Advanced Access is granted.

Steps 1–2 can happen now (Mia's a tester). Step 3 is the long pole (Meta review timelines), but it's
the same gate the current flow needs — and after step 2, onboarding no longer requires Facebook.

---

## 8. Open items
**Resolved:**
- ✅ **`profile_views`** → `profile_links_taps`, relabeled "Profile Link Taps" (display-only; confirmed not a scoring input).
- ✅ **`INSTAGRAM_APP_ID`** (`876239621775424`) is the **Facebook App ID** (used as the FB-dialog `client_id`). Instagram Login uses a **separate Instagram App ID** → new `INSTAGRAM_LOGIN_APP_ID` env var.
- ✅ **Thread continuity** — only 4 IG messages / 1 IGSID / 4 deals exist, all test data. Clean slate; no re-keying concern.

**Verify during Dev-Mode testing (not design blockers):**
- **`HUMAN_AGENT` send body** exact keys (`messaging_type: "MESSAGE_TAG"` + `tag: "HUMAN_AGENT"`) + the outside-window error subcode (`2534022`) — wired with a retry; confirm against a live send.
- **Versioned host paths** — code uses `graph.instagram.com/v22.0/...`; if any endpoint 404s on the version prefix, drop to unversioned.
- **IG User node fields** (`followers_count`/`follows_count`/`media_count`) — one Meta ref 404'd; confirm names live.
- **`instagram_business_manage_insights`** App-Review row (Meta docs inconsistent) — confirm at submission.
- **Rate limits** — numeric quotas weren't on the fetched pages; confirm before load-testing.

## 9. Effort
Code: contained to `instagram.ts` (rewrite ~5 functions) + delete one cron + a webhook tweak + a metric
swap + env — roughly a focused day or two with tests, since the surrounding pipeline is unchanged. The
real timeline driver is **Meta App Review + Business Verification** (external, days-to-weeks), which is
required for production regardless of this migration.
