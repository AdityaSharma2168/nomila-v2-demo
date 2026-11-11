# nomila-v2

React Native / Expo app with an Express + Drizzle/Postgres backend, deployed to Cloud Run.

## Session startup checklist

At the start of every session, run these checks before doing any work:

### 1. Populate .env if DATABASE_URL is missing

```bash
grep -q DATABASE_URL .env 2>/dev/null || bash scripts/setup-dev-env.sh
```

`setup-dev-env.sh` fetches all secrets from GCP Secret Manager and writes `.env`.
Requires `gcloud` to be authenticated to the `gamechanger-pocket-agent` project.
The Cloud SQL instance (`nomila-v2-db`) is reachable directly via TCP from this machine —
the local IP (`73.183.50.21`) is already in its authorized networks.

### 2. Start the server (if the user needs it)

```bash
npm run server:dev
```

Works in PowerShell, Git Bash and WSL alike — the script uses `cross-env`, so there is no
longer a separate Windows incantation. (`npm test` is the same; `npm run server:prod` keeps
the bare `NODE_ENV=` prefix on purpose, because it is the container start command and
cross-env is a devDependency that `--omit=dev` will not install.)

A local server does **not** run background work (workflow steps, Studio video jobs) against the shared dev
database; the cloud's minute tick does. Set `LOCAL_BACKGROUND_WORK=true` only when you deliberately want your
local server to run them (server/lib/backgroundHost.ts).

### 3. Start Expo / Metro (if the user needs it)

```powershell
npm run expo:dev
```

Metro runs on port 8081. The Expo client points at `https://nomila-v2-iau7alh5qq-uc.a.run.app` by default.

## Project layout

- `client/` — React Native screens and components
- `server/` — Express API (routes, skills, lib, services)
- `shared/schema.ts` — Drizzle ORM schema (single source of truth for DB types)
- `scripts/setup-dev-env.sh` — populates `.env` from Secret Manager

## GCP

- **Project**: `gamechanger-pocket-agent`
- **Cloud SQL instance**: `nomila-v2-db` (Postgres 15, `us-central1-a`, IP `35.254.58.44`)
- **Database**: `nomila_v2`, user `postgres`
- **Cloud Run service**: `nomila-v2-iau7alh5qq-uc.a.run.app`
- Secrets live in Secret Manager — never commit credentials to the repo

## Key env vars (all fetched by setup-dev-env.sh)

| Var | Source |
|-----|--------|
| `DATABASE_URL` | constructed from Cloud SQL IP + Secret Manager password |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Secret Manager |
| `GEMINI_API_KEY` | Secret Manager |
| `SESSION_SECRET` | Secret Manager |
| `INTERNAL_CRON_SECRET` | Secret Manager |
