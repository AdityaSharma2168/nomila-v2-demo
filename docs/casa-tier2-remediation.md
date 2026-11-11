# CASA Tier 2 — Backend Remediation

Scope: the Gmail-handling API (`api-dev.nomila.co`, Cloud Run + Node/TS/Express,
Cloud SQL Postgres, Firebase Auth). This documents what was fixed in code on branch
`security/casa-tier2-hardening`, what you (operator) must still do, and how the
original checklist held up against the actual CASA Tier 2 (OWASP ASVS) requirements.

The audit was run as a multi-agent pass across every checklist dimension plus a
requirements-research agent; findings were cross-checked against the code before fixing.

---

## TL;DR — before the DAST/lab scan

Three things gate everything and are **operator actions** (can't be done from a code branch):

1. **Rotate the Cloud SQL `postgres` password immediately.** `[REDACTED]` was committed
   in `scripts/setup-dev-env.sh` + 5 `server/scripts/*.ts` and is in git history. Treat
   it as fully compromised. The code no longer contains it, but rotating the live
   password is what actually closes it. Then store the new password in Secret Manager
   as `NOMILA_V2_DB_PASSWORD` (see the updated `setup-dev-env.sh`).
2. **Grant yourself admin before deploying.** `ADMIN_OPEN_ACCESS` is now fail-closed
   (`false`). Run `npx tsx --require dotenv/config scripts/grant-admin.ts <your-email>`
   against prod so you keep admin access when the branch ships.
3. **Scrub `[REDACTED]` from git history** (BFG or `git filter-repo`) *after* rotating —
   rotation is what neutralizes it; history scrub removes the artifact.

> **Update 4 Nov 2026:** item 1 is done (password rotated). Item 3 was decided against:
> the repo is private, the password is rotated, and a history rewrite would disrupt every
> open branch. The value is redacted on `main` instead.

---

## Fixed in code (this branch)

### Security headers — was: none at all
- Added `helmet` as the first middleware (`server/lib/securityHeaders.ts`,
  `server/index.ts`). Every response now carries **HSTS** (2y, includeSubDomains,
  preload), **CSP** (`default-src 'none'` for the JSON API), **X-Frame-Options: DENY**
  + `frame-ancestors 'none'`, **X-Content-Type-Options: nosniff**,
  **Cross-Origin-Resource-Policy: same-origin** (the commonly-missing one),
  **Referrer-Policy: no-referrer**, **upgrade-insecure-requests**, and **X-Powered-By
  removed**. Verified live: all present.
- OAuth callback HTML pages get a per-response **nonce'd CSP** (no `unsafe-inline`).

### OAuth callback CSRF — was: unsigned `athleteId:alias` state
- New `server/lib/oauthState.ts`: HMAC-SHA256 signed, 10-minute-expiring `state` with a
  per-request nonce. All six providers (gmail, outlook, youtube, instagram, tiktok,
  spotify) now emit signed state; the callback rejects any forged/tampered/expired/
  legacy-plaintext state with a 400 **before** touching the provider. Verified with a
  test harness (tamper, expiry, legacy format all rejected).

### Reflected XSS in OAuth callback — was: `platform`/`error` interpolated raw into HTML
- All interpolated values are now `htmlEscape()`d; inline script/style are nonce-bound.

### Account & data deletion — was: nonexistent (Apple + CASA + Google blocker)
- New `DELETE /api/v1/me/account` (`server/routes/account.ts`): best-effort revokes
  provider grants, then transactionally purges **all 14 athlete-scoped tables**
  (inbox threads/messages, deals, summaries, analytics snapshots, chat, tasks,
  notifications, onboarding, connected accounts, roles, snapshots, current score) and
  the athlete row, then deletes the Firebase user. **You still need to add a "Delete
  account" entry in the app's Settings screen that calls this** (see below).
- Disconnect endpoints now **revoke the provider token and null the stored tokens**
  instead of only flipping a status column (`server/lib/oauthRevoke.ts`).

### Error handling & info disclosure
- Central Express error handler + JSON 404 (`server/index.ts`) — generic message +
  reqId to the client, full detail logged server-side. `express-async-errors` added so
  async route rejections reach it instead of hanging (Express 4).
- Removed raw `err.message` from client responses (5 routes in `index.ts`, Microsoft
  auth detail, dev IG sync).
- `ENABLE_TEST_PAGE` set to `false` in prod **and** `/test` hard-disabled when
  `NODE_ENV=production` regardless of the flag.

### Secrets & logging
- Removed hardcoded `[REDACTED]` from all 6 tracked files; scripts and `setup-dev-env.sh`
  now source the DB credential from `DATABASE_URL`/Secret Manager.
- `META_WEBHOOK_VERIFY_TOKEN` moved from committed plaintext to a Secret Manager ref.
- Logger: sensitive query params (`code`, `state`, tokens) redacted from logged URLs;
  pino `redact` list added for auth headers, tokens, and email fields (`from`/`subject`/
  `body`). Removed sender/subject from two `dealDetector` log lines.

### Access control & anti-automation
- `ADMIN_OPEN_ACCESS` now **fail-closed** in code + prod yaml (was: any signed-in user
  = full admin, all-athlete PII).
- Constant-time (`timingSafeEqual`) comparison for the `x-cron-secret` on all
  `/api/internal/*` + weights routes (was `!==`).
- Rate limiting added to `/api/v1/auth/signup` and `/api/v1/auth/microsoft`.
- `Cache-Control: no-store` on `/api/v1/me`, `/api/v1/admin`, `/api/v1/auth`.

Verification: `tsc --noEmit` clean, existing jest suite (49 tests) green, and a
dedicated harness of 21 assertions (headers, CSP nonce, state sign/verify/tamper/expiry,
404 + error-handler leak check) all pass.

---

## Confirmed already-good (don't re-litigate)

- **IDOR / tenant isolation**: every data route in deals/inbox/connections/chat/search/
  analytics filters by the authenticated `req.athleteId`; swapping an id returns 404.
- **SQL injection**: all request-facing queries go through Drizzle builders / `sql`
  bind-param templates. No string-concatenated SQL on any route.
- **No command injection / eval / unsafe deserialization** anywhere in `server/`.
- **Firebase token verification** validates signature + expiry; no route trusts a
  client-supplied identity; roles set server-side (not self-escalatable).
- **No source maps** emitted or served.
- **Webhook HMAC** (Instagram X-Hub-Signature-256) already uses `timingSafeEqual`.
- **Encryption at rest**: Cloud SQL default AES-256 (Google-managed) — document it.
- **TLS**: terminated by Cloud Run's Google Front End (TLS 1.2+, modern ciphers,
  HTTP→HTTPS redirect) — platform-provided; state this in the evidence pack.

---

## Operator action items (not code)

**Must-do before the scan**
- [x] Rotate Cloud SQL `postgres` password; store as `NOMILA_V2_DB_PASSWORD` secret.
      **Done 4 Nov 2026.** The legacy v1 dev instance `gamechanger-db-dev` (which still
      used the old password) had no live clients and was backed up and stopped the same day.
- [x] ~~`git filter-repo`/BFG to purge `[REDACTED]` from history (after rotation).~~
      **Decided against (4 Nov 2026):** the repo is private, the password is rotated, and a
      history rewrite would disrupt every open branch. The value is redacted on `main` instead.
- [ ] `grant-admin.ts <your-email>` before deploying the fail-closed admin gate.
- [ ] Create the `META_WEBHOOK_VERIFY_TOKEN` secret if not already present (yaml now refs it).
- [ ] Add a **"Delete account"** control in the app Settings screen calling
      `DELETE /api/v1/me/account` (closes the Apple 5.1.1(v) blocker; the API is done).

**Self-scan / evidence**
- [ ] `npm audit` / osv-scanner / Snyk (CASA 6.1.1 SCA) — no dep ≥ CVSS 7.0. The
      pre-configured FluidAttacks SAST is **not** JS/TS-compatible, so SCA evidence must
      come from a JS scanner.
- [ ] Run OWASP ZAP as a readiness check, then note: **the ZAP self-submit route is
      deprecated** — Tier 2 now goes through an ADA authorized lab (e.g. TAC Security)
      running an **authenticated Burp** scan. Prepare a **test account + auth state**.
- [ ] SSL Labs on `api-dev.nomila.co` → confirm A/A+; securityheaders.com → confirm A+
      (should be A+ now that helmet is deployed).

**Config hardening**
- [ ] Cloud SQL: set `sslMode=ENCRYPTED_ONLY`, prefer the Cloud SQL Auth Proxy, and
      create a least-privilege app DB role (stop using `postgres` for the app).
- [ ] Restrict the Firebase Web API key in GCP console (referrer/app + API allowlist) —
      it's public-by-design but should be scoped.
- [ ] Consider OIDC/IAM auth for Pub/Sub push + `/api/internal/*` instead of a shared
      header secret (CASA webhook chapter prefers this over static secrets).

**Data-protection / policy (Google Limited Use)**
- [ ] Privacy policy must disclose the **Gmail → Moonshot AI (Kimi)** data flow, obtain
      a **no-training attestation** from the vendor, and name it as a subprocessor.
- [ ] Document data retention + add a cleanup cron (expired onboarding sessions, old
      chat/notification bodies).

---

## Checklist gaps the research surfaced (beyond your original list)

These are things a CASA Tier 2 assessor/DAST checks that weren't on the checklist:
SCA/dependency CVEs (6.1.1), anti-automation on **all** unauthenticated endpoints
(3.1.5 — partially addressed), **SSRF** on the web-enrichment resolver
(`socialWebResolver.ts` — block `169.254.169.254`/link-local; currently inert until
keyed), open-redirect allowlisting on the callback, subdomain-takeover check on DNS,
JWT lifecycle/logout token-invalidation evidence, and the annual-revalidation reality
(medium-severity CWEs also fail at year 2 — fix mediums now). Full detail in the audit
synthesis.

## Follow-up code hardening (recommended, not blocking the DAST)

- **Encrypt OAuth token columns at rest** (envelope encryption via Cloud KMS) — tokens
  are currently plaintext columns. Not a Tier-2 DAST blocker (at-rest is covered by
  Cloud SQL default encryption) but strong defense-in-depth.
- **SSRF guard** in `socialWebResolver.ts` before it's keyed on.
