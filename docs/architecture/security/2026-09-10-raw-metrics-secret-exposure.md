# 2026-09-10 — Secret-like strings in stored social payloads (dev)

Status: remediated on dev the same day; production unaffected. Recorded under Phase A decision
D7 (10 Sep 2026). Prevention is the Step 1a sanitizer.

## What was found

An audit of `social_analytics_snapshots.raw_metrics` during the Step 1 design found 82 of 218
rows containing a string matching `access_token=|refresh_token=|Bearer `:

| Rows | Platform | Location in `raw_metrics` | What it was |
|---|---|---|---|
| 9 (snapshot days 30 Jun – 8 Jul 2026) | Instagram, source connected | `account_insights.paging.next` | A Graph API paging URL (`graph.facebook.com/v24.0/…/insights?access_token=…`) carrying a Meta long-lived user token (prefix `EAA`, 220 chars) for Mia's original Instagram connection, made through Facebook Login before the migration to Instagram Login (PR #71). |
| 73 (30 Jun – 10 Sep 2026, every TikTok row) | TikTok, source connected | `recent_media[].thumbnail_url` | TikTok CDN cover-image URLs whose signed query string includes a parameter literally named `refresh_token`, alongside `x-expires` and `x-signature`. This is the CDN's own signing parameter, not a Nomila credential. |

No other table held a match: `athlete_snapshots` (research, social, sources), `media_assets`
(insights, metadata, permalink), `workflow_steps` (output, error) all returned 0.

## Environment

- **dev** (`nomila-v2-db`): the 82 rows above.
- **production** (`nomila-prod-db`): 0 rows in `social_analytics_snapshots`, `media_assets`,
  `connected_accounts` and `athletes`; the instance is bootstrapped with schema and reference
  rows only. Nothing to remediate.

## Was a live credential exposed?

The Instagram token was tested against `GET graph.facebook.com/v24.0/me` on 10 Sep: Meta
returned error code 190, subcode 458 ("user has not authorized the application"), i.e. the
token is invalid. It stopped matching any `connected_accounts.access_token` row in July, when
the Facebook-Login connections were revoked during the Instagram-Login migration. No rotation
was possible or needed; no current token was stored in any payload.

The TikTok parameter is a CDN signing value with an expiry of hours; it grants nothing beyond
the cover image it signs and is not a Nomila or TikTok OAuth credential.

Not verified: whether request URLs containing tokens were ever printed to Cloud Logging by
older code. Current integration code logs `error.message` slices only.

## Remediation

`server/scripts/sanitizeStoredRawMetrics.ts` (idempotent, dry-run by default, `--apply` to
write) removes, anywhere in the JSON tree: every `paging` object (Graph paging URLs embed the
token); the query string of any URL whose parameters include a secret-like or signing name
(`access_token`, `refresh_token`, `token`, `key`, `signature`, `x-signature`, `x-expires`,
`oh`, `oe`, `_nc_*`); and any Meta-token-shaped value (`EAA` + ≥100 characters).

Run on dev 10 Sep 2026: dry run listed 82 rows, all clean after transformation; `--apply`
rewrote 82 rows; a second dry run found 0.

## Verification

- `select count(*) from social_analytics_snapshots where raw_metrics::text ~
  'access_token|refresh_token|Bearer |EAA[A-Za-z0-9]{100,}'` → 0.
- Data the display layer reads is intact: 147 rows still carry `recent_media`, 72 still carry
  `account_insights.data`.
- Nothing reads `paging` from a stored row, and the CDN URLs in question had expired hours
  after capture; pixels are re-hosted to GCS by `rehostAthleteMedia`, never fetched from a
  stored raw URL.

## Prevention

- Step 1a introduces `raw_source_payloads` behind a sanitizer contract (exact-value redaction of
  live secrets, key-name redaction, URL query stripping, request parameter allow-list, and a
  refuse-on-leak assertion before insert), with tests and an audit script.
- Until Step 1a lands, the nightly TikTok row will again carry CDN cover URLs with the
  `refresh_token` signing parameter. The interim fix in the same change set as this record
  runs `scrubStoredRawMetrics({ apply: true, keepLatest: true })` as the last step of the
  04:30 UTC cron. It scrubs every row except each athlete × platform's newest, because the
  Growth tab renders that row's cover thumbnails and `rehostAthleteMedia` fetches pixels from
  its URLs inside the CDN expiry window; that row is scrubbed on the following night, by which
  time its signed URLs have expired. Steady state: at most one signed row per platform, holding
  no Nomila credential.
- The one-off run on 10 Sep scrubbed the newest rows too; Mia's Instagram and TikTok rows for
  that day were re-collected immediately afterwards (idempotent same-day upsert), restoring
  usable URLs for the display layer and the re-host.
