# Beta launch checklist — what Mia has to do

Written 14 Sep 2026, after the second production promotion. Companion to
`docs/plans/production-environment-split.md`.

**Where things stand.** Production exists and works: `api.nomila.co` is the new `nomila-v2-prod`
service on its own database (backups, point-in-time recovery, alerts), `app.nomila.co` serves the web
app, seven scheduled jobs run against it, and every promotion leaves a backup, a tag and a health check
behind. Two promotions have run end to end (`v1.1.0-2026-09-13`, `v1.1.0-2026-09-14`). Dev is untouched.

**What is missing is registration, not infrastructure.** The providers (Google, Meta, Microsoft, TikTok,
Stripe, LiveKit, Langfuse) still only know the dev hostnames. Until the items in section A are done, an
athlete on `app.nomila.co` can sign in but cannot connect Gmail or Instagram. Everything below is
console work that needs your accounts; where a step then needs a code change, it says "tell Aaron" and
what he does.

Exact values to paste are in code spans. Production hostnames: API `https://api.nomila.co`, web app
`https://app.nomila.co`, landing `https://nomila.co`. Dev stays `https://api-dev.nomila.co` and
`https://nomila-dev.web.app`.

---

## A. Before the first beta athlete (in this order)

### 1. Google OAuth client — Gmail and YouTube connect on prod

Google Cloud console → APIs & Services → Credentials → OAuth 2.0 Client IDs → the web client
`241621020090-iedv8l2vs8cujmfmlu1i4adgbs4q1ev2.apps.googleusercontent.com`.

- Authorized redirect URIs, **add** (keep the existing dev ones):
  - `https://api.nomila.co/api/v1/auth/callback/gmail`
  - `https://api.nomila.co/api/v1/auth/callback/youtube`
- Authorized JavaScript origins, **add**: `https://app.nomila.co`
- OAuth consent screen / the restricted-scope verification pack: homepage → `https://nomila.co`
  (the pack wants production hosts, not `nomila-dev.web.app`).

Firebase Auth's authorized domains already include `app.nomila.co` and `nomila.co` — nothing to do there.

### 2. Meta — Instagram connect and DMs on prod. Order matters.

The live Meta app is what dev uses today, and it will serve production. Dev moves to a *test app* of it.
Do **(a) before (b)**, otherwise dev loses Instagram webhooks in between.

**(a) Create the test app for dev.** Meta App Dashboard → the live app → Create Test App. In the test app:

- Instagram → API setup with Instagram business login → Valid OAuth redirect URIs:
  `https://api-dev.nomila.co/api/v1/auth/callback/instagram`
- Webhooks → Instagram → callback URL `https://api-dev.nomila.co/api/webhooks/instagram`,
  verify token = the value of the Secret Manager secret `META_WEBHOOK_VERIFY_TOKEN`
  (`gcloud secrets versions access latest --secret=META_WEBHOOK_VERIFY_TOKEN`). Subscribe the same
  fields the live app has.
- Put the test app's four credentials into Secret Manager as **new** secrets, so prod keeps the live
  ones: `INSTAGRAM_APP_ID_DEV`, `INSTAGRAM_APP_SECRET_DEV`, `INSTAGRAM_LOGIN_APP_ID_DEV`,
  `INSTAGRAM_LOGIN_APP_SECRET_DEV`.
- **Tell Aaron.** He points the dev config at the `_DEV` secrets (one PR, dev redeploys itself).

**(b) Point the live app at production.** In the live app:

- Valid OAuth redirect URIs, **add**: `https://api.nomila.co/api/v1/auth/callback/instagram`
- Webhooks callback URL → `https://api.nomila.co/api/webhooks/instagram`, same verify token.

### 3. Microsoft — Outlook connect on prod

Azure portal → App registrations → the app with client id `69d824c0-dc83-4dfb-b3d8-101a76f65e09`
(the server's Outlook connect app, `MICROSOFT_CLIENT_ID` in Secret Manager — not `d614f3fe…`, which
is the Expo mobile sign-in client and needs nothing) → Authentication → Web → **add** redirect URI
`https://api.nomila.co/api/v1/auth/callback/outlook`.

### 4. TikTok — TikTok connect on prod

TikTok for Developers → the app → Login Kit → **add** redirect URI
`https://api.nomila.co/api/v1/auth/callback/tiktok`.

### 5. Sign up on production, then admin

Both of you: sign up at `https://app.nomila.co` (Google sign-in already works). Then **tell Aaron** the
emails you used; he grants the admin role on the production database. The admin console is fail-closed,
so nobody can open `/admin` on prod until this is done, and the grant script needs your athlete row to
exist first.

### 6. Production mobile binary (you or Aaron)

From `main`: `eas build --profile production --platform all`, then submit to TestFlight and Play internal
testing. The production profile already points at `api.nomila.co` and the `production` update channel;
JS-only changes reach installed builds over the air on every promotion. `runtimeVersion` follows the app
version (`1.1.0`), so bump `expo.version` in `app.json` whenever a native change ships.

### 7. Billing budget

Google Cloud console → Billing → Budgets & alerts (enable the Cloud Billing Budget API if asked).
One budget on the billing account with email alerts at 50 / 90 / 100 % to `mia@nomila.co`. Vertex AI is
the line that moves; Cloud SQL and Cloud Run are flat.

---

## B. Before voice goes on for beta

### 8. A second LiveKit worker pointed at production

Voice is deliberately **off** on prod (`MILA_VOICE_WEB=false`) until a worker exists that talks to the
prod API with the prod secret. The prod server already expects a worker named `mila-voice-prod`.

In the `mila-voice` repo, deploy a second agent to LiveKit Cloud project `nomila-qi7makh2`
(`lk agent create` with its own agent entry, then `lk agent deploy`) with this environment:

| Variable | Value |
|---|---|
| `MILA_VOICE_AGENT_NAME` | `mila-voice-prod` (must match exactly; a mismatch is silent — rooms never get an agent) |
| `NOMILA_API_URL` | `https://api.nomila.co` |
| `VOICE_SERVICE_SECRET` | the value of Secret Manager secret `VOICE_SERVICE_SECRET_PROD` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | same LiveKit project as today |
| `XAI_API_KEY` (and any OpenAI key the worker uses) | its own keys, not dev's |
| `MILA_VOICE_WEB_SEARCH` | `true` |

Then **tell Aaron**: he sets `MILA_VOICE_WEB=true` in `gcp/cloud-run-prod.yaml` and promotes.

---

## C. Decisions that gate features (your call; each is a few minutes once decided)

### 9. Stripe live — only if payments are in beta

Everything Stripe is on `main` and runs on dev with test keys (merged 7–8 Oct: the four payments
PRs #826 #827 #830 #834, the Connect webhook secret #839, Bookings v2 and the Partner "serious
offer" hold). Production mounts no Stripe secrets, so every payment path on prod answers "payments
are unavailable", which is honest until this is done.

Stripe dashboard, **live mode** → Developers → Webhooks → add **two** endpoints:

1. `https://api.nomila.co/api/webhooks/stripe` — events on Nomila's own account:
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`,
   `charge.succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
   `charge.dispute.closed`, `transfer.created`, `transfer.reversed`.
2. `https://api.nomila.co/api/webhooks/stripe/connect` — a **Connect** endpoint ("Listen to events
   on Connected accounts"), event `account.updated`. Without it an athlete's payout account only
   updates when she comes back from onboarding.

Create three Secret Manager secrets: `STRIPE_SECRET_KEY_LIVE` (`sk_live_…`),
`STRIPE_WEBHOOK_SECRET_LIVE` (endpoint 1's `whsec_…`) and `STRIPE_CONNECT_WEBHOOK_SECRET_LIVE`
(endpoint 2's `whsec_…`). **Tell Aaron**; he uncomments the Stripe block in the prod config and
promotes.

Still to build before a brand can pay an athlete: the app calls none of the deal-payment routes yet
(`POST /api/v1/me/deals/:id/request-payment`, `mark-delivered`, `deposit-link`, `deposit/release`,
`refund`, `GET /api/v1/me/deals/:id/payment`, `GET /api/v1/me/connect/status`). Only "Set up
payouts" on the Financials screen (`POST /api/v1/me/connect/onboard`) and the Bookings screens are
wired. Build and test that against dev's test keys first; live keys can wait for it.

### 10. Langfuse — roadmap decision D1

Traces carry inbox bodies, contract text and chat transcripts unmasked, so prod tracing is **off** until
this is decided. Either:

- **Langfuse Cloud, paid tier with a data-processing agreement**: create a separate project (e.g.
  `nomila-prod`), take its keys, and create secrets `LANGFUSE_PUBLIC_KEY_PROD`,
  `LANGFUSE_SECRET_KEY_PROD`, `LANGFUSE_BASE_URL_PROD`; or
- **Self-host** (web, worker and ClickHouse on one always-on VM plus a Cloud SQL database and a bucket).

**Tell Aaron**; he mounts the keys and flips `LANGFUSE_TRACING` and `PROMPT_REGISTRY` on prod. Dev keeps
tracing as it is.

### 11. The landing page and share cards

`nomila.co`'s sign-up calls and its share-card links (`/c/…`) still point at **dev**. Flipping them to
production is a one-line change, but it breaks the demo link `nomila.co/miabhuta-gorjana`, because that
card lives in dev data. Say when; Aaron flips it, and the demo card can be minted again on prod.

---

## D. Not yours — listed so the picture is complete

Aaron (with Claude) does these; several wait on an item above.

- After 2(a): switch dev's Instagram secrets to the `_DEV` ones. After 5: grant admin. After 8: turn prod
  voice on. After 9: mount Stripe live. After 10: mount Langfuse. After 11: flip the landing page and
  remove the landing deploy from the dev web workflow.
- Later, no user impact: delete v1 outright (three services, two SQL instances, five schedulers, three
  hosting sites — both databases are already exported to `gs://nomila-db-dumps/v1-export/`); require SSL
  on the dev database and prune its authorized networks; re-baseline the migrations; narrow developer
  IAM; a separate bundle id for dev builds.

## E. Before the CASA assessment (Google's restricted-scope verification)

Gmail connect asks for `gmail.readonly` and `gmail.compose` (restricted) plus `gmail.send` and
`youtube.readonly` (sensitive), so the verification needs a CASA letter. The assessment covers the
**production** app, so the lab's scan should target the production hosts — and what is live at
`api.nomila.co` / `app.nomila.co` when it runs is what gets assessed.

### 12. Promote `main` first (Aaron) — the one thing to do before the kickoff

Production still runs the 14 Sep image. Since then `main` gained: the account data export and the
one manifest behind delete + export (#803), the payments hardening (#826–#834), tighter rate limits
and security headers on the API, the browser security headers on `app.nomila.co` / `nomila.co`, and
the per-environment session secret (`SESSION_SECRET_PROD`, created 9 Oct) — a scan of the old image
reports findings that are already fixed. Two things ride along with that promotion:

- rotate the production database password (`nomila_app`): new `NOMILA_PROD_DATABASE_URL` version,
  then the promotion picks it up. The current value was echoed into a local transcript on 18 Sep.
- the dependency bump (`npm audit fix`, lockfile only) — it clears every critical advisory.

### 13. What the lab asks for (you)

- Hosts: `https://api.nomila.co` (API, OAuth callbacks), `https://app.nomila.co` (web app),
  `https://nomila.co` (landing). Privacy policy `https://nomila.co/privacy-policy`, data deletion
  `https://nomila.co/data-deletion`, terms `https://nomila.co/terms` — all live; the consent screen
  should list the same URLs.
- A production test account that can connect Gmail: sign up at `app.nomila.co` (item 5) with a
  mailbox you can share with the assessor. On prod, not dev.
- The scopes and why: readonly (deal detection from the inbox), compose + send (replies drafted in
  the app and sent from her own mailbox), youtube.readonly (channel stats on her card).

### 14. Not needed before the kickoff

The admin grant, the production mobile binary, Stripe live keys, Langfuse, the landing flip, TikTok,
and disconnecting your mailboxes from dev are all independent of CASA — do them in their own order.
Meta's Instagram app review is separate too; nothing on the code side is waiting on it.

## How a promotion works from now on

GitHub → Actions → **Promote main to production** → Run workflow → type `promote`. Only `miabhuta-code`
and `aaronsongnguyen` may run it (GitHub's required-reviewer gate needs the Enterprise plan, so the
allow-list is the gate). It fast-forwards `production` to `main`, tags `v<version>-<date>`, backs up the
prod database, runs the schema script, deploys the image dev already ran, checks
`https://api.nomila.co/health`, publishes the web app to `app.nomila.co` and an over-the-air update to
the production channel. About ten minutes. If any stage fails it stops there; nothing after it runs.
