# Phase A · Step 1b — Instagram Stories (DESIGN, revised; not implemented)

**Status:** directionally approved 10 Sep 2026; revised the same day per review; awaiting review of the revision. No code.
**Decisions taken:** O1 last look at 22 h · O2 `listed = 1` · O3 keep `entity_format = story` (image/video is a subtype, not a format) · O4 never request media or thumbnail URLs · O5 store regional replies as reported, no feature yet · O6 in-process scheduling on dev, Cloud Scheduler later for prod · O7 probe the conditional documented metrics and omit unsupported ones gracefully · O8 live-Story acceptance · O9 clock offsets `20 */8`.
**Constraints kept:** own flag (`SOCIAL_STORIES_WRITE`, separate from `SOCIAL_SUBSTRATE_WRITE`); connected accounts only; ~8-hour cadence; observations only (no Stories model, no `media_assets` rows); identity → sync run → sanitized raw payload → canonical observation lineage; exact provider provenance and privacy class; no MIA / Rate / Strategy reader, no UI; no prod enablement.
**Schema impact:** one migration, `0045_social_sync_runs_trigger_stories.sql`, extending a CHECK constraint (§10). 0044 is released and is not edited.

## What the athlete experiences

Nothing. No screen changes, no notification, no new permission prompt: the consent she already
gave when she connected Instagram (`instagram_business_manage_insights`) covers Stories. Her
Stories are read while they are live and their numbers are kept after Instagram forgets them.

## What happens underneath

Three times a day the connected Instagram account is asked which Stories are live. Each live
Story's insights are read, sanitized and stored as raw payloads, and turned into canonical
observations (`entity_type = content`, `entity_format = story`). A Story is read again at every
sweep, and from age 22 hours an hourly tick keeps trying until it has one successful insight
reading before the 24-hour expiry, so the last observation is the final count. When Instagram
stops listing it, nothing is deleted: the observations are the durable record. Everything else
is Step 1a as merged.

## 1. What we verified (not assumed)

| Fact | Evidence |
|---|---|
| Login flow is **Instagram API with Instagram Login** (`graph.instagram.com`, v22.0), long-lived token refreshed via `ig_refresh_token` | `server/lib/integrations/instagram.ts` lines 2–40, 196 |
| Scopes requested: `instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_messages` | `instagram.ts` lines 47–49 |
| Scopes **granted** on Mia's active connection: basic, manage_messages, content_publish, manage_insights, manage_comments | `connected_accounts.scopes` (dev, 10 Sep) |
| `GET /{ig-user-id}/stories?fields=id,media_type,media_product_type,timestamp,permalink,is_shared_to_feed` succeeds with her token (`{"data":[]}`: no live Story at probe time; field names accepted, no permission error) | live probe 10 Sep 2026, token never logged |
| `/me` returns `id` (app-scoped, `344…`) and `user_id` (`178…`): the two-id alias found in Step 1a is confirmed at the API | live probe |
| Story metrics documented for v22 `STORY`: `reach`, `views`, `impressions` (deprecated for media after 2 Jul 2024), `replies`, `shares`, `navigation` (breakdown `story_navigation_action_type`: SWIPE_FORWARD, TAP_BACK, TAP_EXIT, TAP_FORWARD), `profile_activity` (breakdown `action_type`: BIO_LINK_CLICKED, CALL, DIRECTION, EMAIL, OTHER, TEXT), `profile_visits`, `follows`, `total_interactions`, `facebook_views`, `link_clicks`, `reposts` | Meta docs, Instagram Media Insights reference |
| "Story media metrics are only available for 24 hours"; "Story media metrics with values less than 5 return an error code 10 … Not enough viewers"; "For Stories created by users in Europe and Japan, the replies metric now returns a value of 0" | same page, quoted |
| Old `exits`, `taps_forward`, `taps_back` are gone: v22 rejects them (`metric[0] must be one of …`) | live probe on a feed media |
| The `story_insights` webhook (final metrics at expiry) is **Facebook Login for Business only**; the permissions table marks it unavailable for Instagram Login | Meta docs, Webhooks reference |
| Our webhook subscription is `subscribed_fields=messages` only | `instagram.ts` line 65 |
| Rate limit (Instagram Platform BUC): calls per 24 h = 4800 × impressions; error 80002 when throttled; `X-Business-Use-Case-Usage` header | Meta docs, rate limiting |
| Dev Cloud Run runs `minScale: 1`; the nightly collector is an in-process `node-cron` job (04:30 UTC); prod-style jobs use Cloud Scheduler → `/api/internal/*` with `INTERNAL_CRON_SECRET` | `gcp/cloud-run-dev.yaml`, `server/index.ts`, `gcloud scheduler jobs list` |
| An internal Instagram token-refresh endpoint already exists | `POST /api/internal/ig-token-refresh` |
| The nightly collector's auth classifier is a message regex (`401|403|unauthor|invalid.*token|token.*expired|permission`) | `collectSocialAnalytics.ts` lines 41–42; Stories will NOT reuse it (§8) |
| The Step 1a sanitizer strips `oh`, `oe`, `_nc_*`, `signature` query params (signed CDN URLs) and every token shape | `social/sanitize.ts` `SECRET_KEY` |
| `story` is already a canonical `ContentFormat`; no Story rows exist in `media_assets` | `social/metrics.ts`; dev query |
| `social_sync_runs.trigger` is constrained by `social_sync_runs_trigger_check` to `connect, nightly, backfill, discovery, manual, fixture` in 0044 and in `shared/schema.ts` | `migrations/0044` line 76; `schema.ts` line 1082 |

**Meta permission / App Review dependency:** none new. Story listing and Story insights need
exactly the two scopes we already hold with Advanced Access (the connected insights fetch has
run nightly since June). The only Story capability we cannot have is the expiry webhook, and
that is a login-type limitation, not a review item. If Nomila ever moves to Facebook Login for
Business, `story_insights` becomes available and the last-look poll below becomes redundant.

**Platform scope:** Instagram only. TikTok's Display API and YouTube's Data API expose no
Stories; no equivalence is claimed and no TikTok/YouTube code is touched.

## 2. Identity and content model

| Field | Value | Why |
|---|---|---|
| identity | the connected Instagram identity (`social_identities`, keyed on `platform_user_id 178…`) | Stories are only readable through the athlete's own token |
| `entity_type` | `content` | a Story is a content item with per-item metrics, like a reel |
| `entity_id` | the Story's IG media id | provider id; stable for the Story's life and in `raw_source_payloads` after |
| `entity_time` | the Story's `timestamp` | posting instant, the basis of the 24-hour clock and of cadence |
| `entity_format` | `story` | the only Story format (O3); image vs video is a subtype |
| `asset_id` | NULL | no `media_assets` row (below) |
| `source_class` / `source_method` / `provider` | `connected_verified` / `oauth_instagram_login` / `meta_graph` | exact provenance, same as the nightly bundle |
| `input_access_class` (features, later) | `includes_athlete_private` | every input is connected evidence |
| `definition_version` | `v1` (registry) | Story metric definitions versioned like every other metric |

**Story media stays out of `media_assets`.** `media_assets` is the durable library (pixels,
rehosting, cards, clearance). A Story's `media_url`/`thumbnail_url` are signed, expiring CDN
URLs; the item disappears in 24 hours; nothing downstream (Curator, decks) selects Stories. D1
already allowed "observations-only" for Stories. The canonical record of a Story is therefore
its observations (existence, time, format, metrics) plus the sanitized raw payload while it is
retained. **Subtype (O3):** `media_type` IMAGE/VIDEO is a subtype, not a content format. It is
kept in the raw payload (180 days) and nowhere else in 1b; a durable subtype can be added later
if evidence shows it matters. `CONTENT_FORMATS` is not changed.

## 3. Canonical metrics persisted (Instagram Story, v22)

All are cumulative counts at `observed_at` (window NULL), one observation per metric per
successful reading, `unit = count`. Registry entries in `social/metrics.ts` carry `platform:
instagram, product: STORY` and the provider metric name.

| Canonical key | Provider metric | Notes |
|---|---|---|
| `listed` (new) | presence in `/stories` | value 1: the provider listed this Story as live at `observed_at`. Gives cadence and existence even when insights are refused (< 5 viewers). It is a presence fact, never an insight (§4.4) |
| `reach` | `reach` | unique accounts |
| `view_count` | `views` | Story views; the registry definition says "Instagram Story views"; never pooled with reel views at the feature layer except through explicit per-format keys |
| `reply_count` (new) | `replies` | 0 for EU/JP creators per Meta; stored as reported with a registry note; no feature reads it until athlete region is known (O5) |
| `share_count` | `shares` | |
| `total_interactions` | `total_interactions` | |
| `story_nav_swipe_forward`, `story_nav_tap_back`, `story_nav_tap_exit`, `story_nav_tap_forward` (new) | `navigation` with `breakdown=story_navigation_action_type` | the four breakdown values; the undifferentiated total is their sum and is not stored |
| `profile_visits` (new) | `profile_visits` | |
| `follows` (new) | `follows` | |
| `story_profile_activity_<action>` (new, up to 6 keys) | `profile_activity` with `breakdown=action_type` | BIO_LINK_CLICKED, CALL, DIRECTION, EMAIL, OTHER, TEXT |
| `link_clicks`, `reposts`, `facebook_views` (new, conditional) | same names | documented for STORY; probed on the first live run per O7; a metric the API rejects (error 100) is omitted from that call and every later call in the run, recorded as `absent` in the run's `error.subCalls`, never a zero |

**Explicitly unavailable, not invented:** `impressions` (deprecated for all media created after
2 Jul 2024, i.e. every future Story); `exits`, `taps_forward`, `taps_back` (removed in v22;
replaced by `navigation`); completion / retention / watch time (no per-viewer or per-second
data for Stories); sticker taps, poll or question results, mentions, reply text (not exposed);
audience demographics per Story (none); any TikTok or YouTube counterpart.

## 4. Collection lifecycle

1. **Discovery sweep** (every 8 h at `20 */8 * * *`, flag-gated, connected and active Instagram
   connections only): `GET /{user_id}/stories?fields=id,media_type,media_product_type,timestamp,is_shared_to_feed`
   → one sync run (`endpoint_family = stories_list`, `trigger = stories`), one sanitized
   payload, one `listed = 1` observation per Story at `observed_at = fetchedAt`.
2. **Insights per live Story**, in the same run: three calls per Story (main metrics
   `reach,views,replies,shares,total_interactions,profile_visits,follows` plus the conditional
   three; `navigation` with breakdown; `profile_activity` with breakdown), each stored as its
   own payload (`story_insights`, `story_navigation`, `story_profile_activity`, `page_index` =
   Story ordinal) and adapted to observations that name their `payloadFamily` (Step 1a review 3).
3. **Repeated observations:** every sweep re-reads every live Story; each sweep adds new rows
   (`observed_at` differs), superseded rows are kept, the resolver takes the latest. A retry
   inside one run is idempotent (same `observed_at`).
4. **Last look before expiry (revised).** An hourly tick (`40 * * * *`) selects, from the
   observation table itself, every Story with `entity_time` between now − 24 h and now − 22 h
   that has **no successful insight observation at or after `entity_time + 22 h`**. A
   successful insight observation means at least one row from the `story_insights` family
   (`reach` or `view_count`) at that age; `listed = 1` never satisfies the rule. For each such
   Story the tick reads the three insight calls again. If the insight calls fail (error 10,
   rate limit, transient error) the Story stays selectable and the next hourly tick retries,
   until `entity_time + 24 h` passes; after that the window is closed, the tick stops trying,
   and the last successful sweep reading stands as final. Each attempt is its own sync run
   (`endpoint_family = story_last_look`) so the retries are visible.
5. **After disappearance:** the Story is simply absent from the next listing; nothing is
   deleted or marked. The latest successful observation is the final value; a feature treats a
   Story whose `entity_time + 24 h < as_of` as closed. A Story deleted by the athlete before its
   first sweep is never seen (accepted). A Story added to Highlights is not re-read (Meta:
   metrics are only 24 h "even if the story is a highlight").
6. **Fewer than 5 viewers** (error 10): the `listed` observation still lands; the insight call
   is recorded in the run's `error.subCalls`, the run is `partial`, and the Story is retried at
   the next sweep and by every last-look tick in its window.
7. **Shared to feed:** a Story that is also a feed post has a different media id; both are kept,
   the feed copy through the existing media path, the Story here.

## 5. Cadence: rationale and the blind spot, quantified

With fixed 8-hour sweeps a Story posted at any time is read at ages `a`, `a+8`, `a+16` hours
with `a` uniform in [0, 8). Every Story is seen at least twice (its life is 24 h ≥ 8 h). The
last fixed sweep happens 0–8 h before expiry, mean 4 h: **the numbers that accrue in that
tail are never observed** if we rely on sweeps alone.

How much is lost depends on how front-loaded Story consumption is, which we do not yet
measure. As a labelled assumption, let views accrue like an exponential with half-life `h`, so
that the amount accumulated by age `x` is proportional to `1 − 2^(−x/h)`. The share of the
Story's **full 24-hour total** that arrives in its last `t` hours is then

`share(t) = (2^(−(24−t)/h) − 2^(−24/h)) / (1 − 2^(−24/h))`

(the numerator is what accrues between age 24 − t and 24; the denominator normalizes to the
24-hour total rather than to the infinite-horizon limit):

| Unobserved tail `t` | h = 4 h | h = 6 h | h = 8 h |
|---|---|---|---|
| 8 h (worst case, sweeps only) | 4.8 % | 10.1 % | 14.3 % |
| 4 h (mean, sweeps only) | 1.6 % | 3.9 % | 5.9 % |
| 2 h (last look at 22 h, hourly tick) | 0.7 % | 1.7 % | 2.7 % |
| 1 h (last look at 23 h) | 0.3 % | 0.8 % | 1.3 % |

The blind spot is material for sweeps alone (up to a seventh of a Story's reach on a plausible
curve) and immaterial with a last look. **Strategy (O1):** 8-hour discovery sweeps **plus** a
per-Story last look from age 22 h, executed by an hourly tick that retries until it has a
successful insight reading or the Story expires. No queue, no extra table, one extra
successful observation per Story (more attempts only when the provider refuses). A last look
first attempted at 22 h lands between 22 h and 23 h on the first success, leaving at least an
hour of slack for retries under the 24-hour cutoff. The first month of real observations
replaces the assumed curve with a measured one: the repeated observations are exactly the data
needed, and the model function that produces this table ships as a tested helper.

## 6. Raw payload retention and sanitization (Step 1a contract, unchanged)

Every response goes through `storePayload`: `sanitizePayload` with the live access token as a
secret, `assertNoSecrets`, sha-256 hash, bytes, `sanitizer_version v1`, `retained_until =
fetched_at + 180 d` (connected class from the `signals` parameters; deleted nightly by
`enforceRawRetention`). Signed CDN parameters are already stripped by `SECRET_KEY`; per O4 the
Story requests **never include `media_url` or `thumbnail_url`**: 1b needs no pixels, and a
stripped CDN URL is neither useful nor evidence. `closeSyncRun` receives the same secrets.
Nothing about Stories bypasses the contract.

## 7. What these observations will support later (NOT built in 1b)

| Future feature (Step 4+) | Inputs from 1b | Measurability |
|---|---|---|
| Story reach efficiency | latest `reach` per Story ÷ followers resolved at the Story's `entity_time` (denominator in lineage, Step 1a review 5) | measurable |
| Story views per follower | `view_count` ÷ followers | measurable |
| Completion / retention | **not measurable**; only proxies: exit rate `tap_exit ÷ view_count`, skip rate `swipe_forward ÷ view_count`, hold signal `tap_back ÷ view_count`, all labelled `inferred` with their rule | proxy only |
| Reply / share efficiency | `reply_count ÷ reach`, `share_count ÷ reach` (replies excluded where the EU/JP zero applies once region is known) | measurable |
| Story cadence | Stories per week from `listed` / `entity_time` (independent of insights availability) | measurable |
| Profile impact | `profile_visits`, `follows`, `story_profile_activity_*` per Story and per 1 k reach | measurable |
| Commercial-content performance | the above split by a commercial flag on the Story | **depends on a commercial linkage that 1b does not provide** (no caption, mention or tag data for Stories; a link to a deal or brand needs Step 5/6 evidence) |
| Momentum | Story-level series over weeks | measurable once ≥ 4 weeks exist |

## 8. Failure, reconnect and token behaviour (revised)

**Error classification is by Meta error code, not by HTTP status or message text.** The Story
path has its own classifier (`classifyStoryError(json, httpStatus)`) and does not reuse the
nightly collector's message regex, which would expire a connection on any `403` or any message
containing "permission".

| Class | Meta signal | Effect on the connection | Effect on the run |
|---|---|---|---|
| `auth` | `error.type = OAuthException` **and** `code = 190` (invalid/expired token, any subcode incl. 458 app removed, 460 password changed, 463 expired, 467 invalidated) or `code = 102` (session) | `status = expired` (the only class that touches the connection); identity and observations untouched (D5); sweeps skip non-active connections | `failed`, normalized error |
| `permission` | `code` 200–299 (scope or permission scoping) | **unchanged** | `partial`; `error.reason = permission_error` so a human sees it; the Story is retried next sweep |
| `not_enough_viewers` | `code = 10` with the "Not enough viewers" message | unchanged | `partial`; Story retried next sweep and by the last-look ticks |
| `unsupported_metric` | `code = 100` naming a metric | unchanged | the metric is omitted for the rest of the run and recorded `absent` (O7); other calls proceed; `partial` |
| `rate_limited` | `code` 4, 17, 32, 613 or 80002 | unchanged | stop the sweep for that athlete, `partial`; resume next sweep |
| `transient` | HTTP 5xx, network error, malformed body | unchanged | `partial` or `failed` by extent; retried next sweep / next tick |
| `unknown` | anything else, **including a 403 without an `OAuthException` code 190/102** | unchanged | `partial`, `error.reason = unknown_provider_error` with code and subcode; surfaced in the sweep log |

Other behaviour is unchanged: token refresh stays with `/api/internal/ig-token-refresh` (a
sweep never refreshes tokens itself); revoke or disconnect stops reads and preserves history;
reconnect resumes the same identity; an instance restart mid-sweep is harmless (runs are per
identity and idempotent within `observed_at`; the last-look tick simply selects again); a
sanitizer leak refuses the payload and fails the run with nothing stored.

## 9. Cost per connected athlete

Per day: 3 listing calls, plus per live Story `3 calls × (3 sweeps + 1 last look) = 12` on the
happy path; each failed last-look attempt adds up to 3 calls per hour for at most 2 hours. An
athlete posting 5 Stories a day costs about 63 calls a day (2.6 an hour); 20 Stories a day
about 243 (10 an hour). The documented Instagram Platform allowance is 4800 × impressions per
24 h per account; an athlete with 10 000 daily impressions has 48 M calls. Storage per Story:
about 4 payload rows × 1–2 KB × 4 readings ≈ 20 KB raw (180 d) and about 60 observation rows.

## 10. Schema impact (revised)

**One migration, CHECK constraint only.** `migrations/0045_social_sync_runs_trigger_stories.sql`:

```sql
ALTER TABLE social_sync_runs DROP CONSTRAINT IF EXISTS social_sync_runs_trigger_check;
ALTER TABLE social_sync_runs ADD CONSTRAINT social_sync_runs_trigger_check
  CHECK (trigger IN ('connect','nightly','backfill','discovery','manual','fixture','stories'));
```

Listed in `scripts/db-migrate.sh` after 0044; mirrored in `shared/schema.ts`
(`social_sync_runs_trigger_check`) so the drift gate and PGlite tests see the same set; dry-run
`BEGIN … ROLLBACK` against dev before the PR; applied only by the deploy. 0044 is released and
is not edited. No other table, column or index changes. Everything else is code and registry:
new metric keys in `metrics.ts`, new endpoint families (`stories_list`, `story_insights`,
`story_navigation`, `story_profile_activity`, `story_last_look`; free text), the flag.

## 11. Current → target file map

| Current | Target (1b) | Change |
|---|---|---|
| `migrations/` (0044 released) | + `0045_social_sync_runs_trigger_stories.sql` | ADD (CHECK only) |
| `scripts/db-migrate.sh` | list 0045 after 0044 | MODIFY (one line) |
| `shared/schema.ts` `socialSyncRuns` | `social_sync_runs_trigger_check` gains `'stories'` | MODIFY (constraint text) |
| `server/lib/integrations/instagram.ts` (`fetchInstagramNative`, `graphGet`, `listMediaPage`) | + `fetchInstagramStoriesNative(connectionId)`, `fetchStoryInsightsNative(connectionId, storyId, metrics)`, `classifyStoryError(json, status)` | ADD; reuse `graphGet` and token loading; `fetchAnalytics` and the projection untouched; the nightly regex classifier is not reused |
| `server/services/intelligence/social/native.ts` | + `InstagramStoriesNative { stories: IgStoryNode[] }`, `IgStoryInsightsNative` | ADD types |
| `server/services/intelligence/social/metrics.ts` | + Story metric keys (§3); `CONTENT_FORMATS` unchanged (O3) | ADD registry rows |
| `server/services/intelligence/social/adapters/instagram.ts` | + `adaptStories(native, ctx)` (listing → `listed` observations), `adaptStoryInsights(native, ctx)` (three payload families → observations with `payloadFamily`) | ADD; `adaptInstagram` and `adaptMedia` untouched |
| `server/services/intelligence/social/substrate.ts` | + `ingestStorySweep(...)`, `ingestStoryLastLook(...)`, `selectStoriesDueForLastLook(now)` (query: age 22–24 h and no `story_insights` observation at or after age 22 h) | ADD; same identity, run, payload and write helpers |
| `server/services/intelligence/social/config.ts` | + `storiesWriteEnabled()` (`SOCIAL_STORIES_WRITE === "true"`); `signals` params gain `stories: { sweepHours: 8, lastLookHours: 22 }` defaults | ADD |
| `server/skills/collectSocialAnalytics.ts` | untouched | none |
| new `server/skills/collectInstagramStories.ts` | sweep over active Instagram connections; per-athlete error isolation; last-look tick entry point | ADD |
| `server/index.ts` | + in-process cron `20 */8 * * *` (sweep) and `40 * * * *` (last-look tick), both no-ops unless the flag is on; `POST /api/internal/stories-sweep` and `stories-last-look` behind `INTERNAL_CRON_SECRET` for Cloud Scheduler later (O6) | ADD |
| `gcp/cloud-run-dev.yaml`, `gcp/cloud-run-prod.yaml` | `SOCIAL_STORIES_WRITE` `"false"` in both at merge; dev flipped by PR after acceptance | ADD |
| `server/scripts/socialFeatureVector.ts` | `--explain` unchanged; + `--stories` ledger (per Story: entity_time, readings by age, last-look attempts, final values) | ADD |
| tests | `adapters.test.ts` (+ Story fixtures), `ingest.test.ts` (+ repeated observations, last-look selection incl. the `listed`-does-not-satisfy rule), `sanitize.test.ts` (+ Story payload with signed URLs and token), new `stories.schedule.test.ts` (pure: due selection at several clock times, retry-until-expiry, the §5 model), new `storyErrors.test.ts` (classifier), `syntheticLegacy` untouched | ADD |
| `docs/architecture/phase-a/step1b-stories.md` | build record after implementation | ADD |

## 12. Deterministic tests and acceptance evidence before merge

Tests (CI, PGlite, no network):
- adapter fixtures for a listing and the three insight responses (including a `navigation`
  breakdown and an error-10 sub-call) → exact observations with `payloadFamily`;
- the sanitizer refuses a Story payload carrying the token and strips `oh`, `oe`, `_nc_*`;
- repeated sweeps add rows and never update; a retry within a run is idempotent;
- `selectStoriesDueForLastLook` at several clock times: a Story with only `listed` at 22.5 h is
  due; one with a `reach` reading at 22.1 h is not; one at 24.5 h is never selected; a Story
  whose last-look attempt failed at 22.5 h is selected again at 23.5 h;
- the error classifier: `OAuthException 190` (each subcode) and `102` → `auth`; `10` not enough
  viewers, `100` unsupported metric, `4/17/32/613/80002`, `200–299`, a bare HTTP 403 → their
  classes, connection untouched;
- the conditional-metric probe omits a rejected metric for the rest of the run and records it
  `absent`;
- flag off means zero writes and zero calls;
- the §5 table is reproduced by the schedule helper's model function;
- migration 0045: PGlite schema build passes with `trigger = 'stories'` and rejects an unknown
  trigger.

Acceptance on dev before merge (flag on in dev only, prod off):
1. 0045 dry-run `BEGIN … ROLLBACK` against dev; then applied only by the deploy; drift gate clean.
2. A dry run listing Mia's live Stories (needs at least one live Story: O8).
3. Stored rows for one full Story life: `listed` at 2 or more sweeps, insight readings at each
   sweep, one successful last look between 22 h and 24 h (and every attempt visible as a
   `story_last_look` run), payload rows per family with hash, bytes and retention, sync runs
   `ok` or `partial` with normalized errors only, zero secret-like strings (the D7 detector over
   every stored Story byte), the connection still `active`.
4. A RAW → OBSERVATIONS ledger for that Story showing the age of each reading and the
   monotone growth of `reach` and `view_count`.
5. Confirmation that `social_analytics_snapshots`, `media_assets`, the score, the rates and
   every MIA output are byte-for-byte unchanged (same method as Step 1a).
6. The day's call count against the rate-limit headers.

## 13. Rollout

1. Revision review (this document).
2. PR: 0045 + code + tests, both YAML flags `"false"`, build-record skeleton. CI green.
3. Merge → deploy applies 0045 through `scripts/db-migrate.sh`; drift gate clean.
4. Flip `SOCIAL_STORIES_WRITE` to `"true"` in the dev YAML by PR; deploy.
5. Mia posts a Story (O8); the §12 evidence is collected over one Story life and appended to
   the build record.
6. Dev stays on; prod stays off until the prod-enablement step, which also adds the Cloud
   Scheduler jobs for the two internal endpoints (O6).

## 14. Decisions

| # | Decision | Taken |
|---|---|---|
| O1 | Last look from `entity_time + 22 h`, hourly tick, retry until a successful insight reading or expiry | Yes |
| O2 | Persist `listed = 1` per Story per sweep; it never counts as an insight reading | Yes |
| O3 | Keep `entity_format = story`; no `story_video`; image/video is a subtype kept in the raw payload, durable subtype later only on evidence | Yes (revised) |
| O4 | Never request `media_url` or `thumbnail_url` for Stories | Yes |
| O5 | Store regional `replies` as reported with a registry note; no feature reads it yet | Yes |
| O6 | In-process cron on dev; internal endpoints now; Cloud Scheduler at prod enablement | Yes |
| O7 | Probe `link_clicks`, `reposts`, `facebook_views`; omit rejected ones gracefully, record `absent` | Yes |
| O8 | Acceptance on one live Story from Mia after the dev flag flips | Yes |
| O9 | Sweep clock `20 */8 * * *` (00:20, 08:20, 16:20 UTC), tick `40 * * * *` | Yes |
| R1 | Schema impact is migration 0045 (CHECK constraint on `social_sync_runs.trigger`), not none | Yes (review) |
| R2 | Only auth-classified token failures (`OAuthException` 190/102) expire a connection; everything else leaves it intact and makes the run `partial` | Yes (review) |
| R3 | Tail-share formula normalized to the 24-hour total | Yes (review) |

Nothing remains open. Implementation starts after this revision is reviewed.
