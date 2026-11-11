# Athlete Data Inventory (audited 2026-07-11)

Everything we hold on an athlete — first-party, connected-platform, external, and
derived — with where it's stored, how often it's acquired, and how it updates.
Derived from a code audit (`shared/schema.ts`, `server/index.ts` cron blocks, all
integration modules) plus prod DB spot-checks. Companion: `docs/feasibility-audit.md`.

**Storage model in one line:** `athletes` = identity/goals, edited in place ·
`athlete_snapshots` = append-only history (research + social + score per event) ·
`athletes_current` = latest projection, overwritten · `social_analytics_snapshots` =
one row per athlete × platform × UTC day · inbox tables = real-time deal pipeline.

---

## The update clock (verified in `server/index.ts`)

| Cadence | Job | What it does |
|---|---|---|
| Real-time | Gmail Pub/Sub push · IG DM webhook | inbound messages → `detectDeal` (IG webhook pending app Live) |
| Every 6 h | `inboxCronSync` | Gmail poll (unread <2d, max 50) + IG last-20-conversations fallback |
| Daily 04:30 UTC | the big refresh | ① `collectAllAnalyticsSnapshots` (connected) ② `collectAllDiscoveryAnalytics` (unconnected w/ handle) ③ `refreshAllScores` (re-score everyone; writes only on change) |
| Every 6 days 02:00 | Gmail watch renewal | watches expire at 7 days |
| Monthly 1st 05:00 | `reEnrichAllAthletes` | re-research Trends, GDELT, press, achievements (otherwise frozen at activation) |
| Bi-monthly 1st 03:00 | IG token refresh | 60-day Instagram-Login tokens |
| On event | connect / claim / manual | `fetchSocialData` + `researchAthlete` write a new snapshot; 90-day Gmail backfill on connect |

---

## 1 · First-party — the athlete tells us

| Data | How we get it | Stored in | Acquired | Updated | Status |
|---|---|---|---|---|---|
| Identity (name, sport, school, division, handles, email, photo) | signup / waitlist form | `athletes` (+ generated `segment`) | at signup | on profile edit | live |
| Goals | onboarding: `goal_archetype` + `secondary_goals[]` | `athletes` | at onboarding | static until edited | live |
| Deal preferences | set/patched from deals UI | `athletes.deal_preferences` | on use | PATCH merge per edit | live |
| Brand voice | field defined for onboarding | `athletes.brand_voice` | — | — | **never written** |
| Platform connections | OAuth (IG, TikTok, YouTube, Gmail, Outlook, Spotify): tokens, scopes, platform ids | `connected_accounts` | at connect | token-refresh crons; auth failure → `status='expired'` | live |
| Chat / agent conversation | athlete ↔ AI chat | `chat_messages` | real-time | append-only | live |
| Deal actions | save, approve pending actions, status moves, negotiation inputs | `deals` (saved, status, negotiation_state, pending_action) | on interaction | in place | live |

## 2 · Connected platforms — the athlete's own accounts (OAuth)

Two parallel writes: scoring path → `athlete_snapshots.social`; display path →
`social_analytics_snapshots` (source=`connected`).

| Data | API | Fields | Stored in | Frequency | Status |
|---|---|---|---|---|---|
| Instagram profile + posts | Instagram API w/ Instagram Login | followers, following, media count; per-post likes, comments, **reach, saves, shares**, total interactions; captions, permalinks, thumbnails (ephemeral CDN) | both paths + `raw_metrics.recent_media` | daily 04:30 + on connect | live |
| Instagram account insights | `instagram_business_manage_insights` | reach, views, profile-link taps (account-level) | reach / impressions / profile_views columns | daily 04:30 | live |
| Instagram audience | `follower_demographics` (needs ≥100 followers) | age brackets, gender, top cities/countries (full breakdowns in `raw_metrics.demographics`) | top-N columns + raw_metrics | daily 04:30 | live |
| Instagram DMs | Messaging API (`…manage_messages`) | conversations, messages, sender IG user ids → deal pipeline | `inbox_threads` / `inbox_messages` | real-time webhook + 6 h poll | **webhook needs app Live** |
| TikTok | Open API v2 (`user.info.stats`, `video.list`) | followers, lifetime likes, video count; last 20 videos: views, likes, comments, shares, duration | both paths | daily 04:30 (24 h tokens auto-refresh) | live |
| TikTok audience | `creator_info` scope | gender / geo demographics | coded, feature-flagged off | — | **needs TikTok Business approval** |
| YouTube channel | Data API v3 | subscribers, total views, video count; recent videos w/ stats, topics, short-form ratio | both paths | daily 04:30 | live |
| YouTube analytics | Analytics API (`yt-analytics.readonly`) | 30-day views + watch-time, avg view duration + **retention %**, subs gained/lost, age/gender, geography, **traffic sources**, devices | columns + `raw_metrics.youtube` | daily 04:30 | live (validated 2026-07-10) |
| Email inbox | Gmail API (push) / MS Graph (Outlook) | brand-relevant messages → classify → threads, senders, deals | inbox tables (idempotent on `external_message_id`) | real-time + 6 h; 90-day backfill on connect | live |
| Spotify taste | Web API `/me/top` | top artists, top tracks, genres, playlists — personality/brand-fit, not audience | `sources.spotify_profile` (snapshot) | at connect only | **no app credentials yet** |

## 3 · External sources — no athlete auth needed

| Data | Source | Fields | Stored in | Frequency | Status |
|---|---|---|---|---|---|
| IG public stats (unconnected) | Business Discovery — Nomila's own FB-Login token | followers, media count, recent-post likes/comments → engagement, cadence | `social_analytics_snapshots` source=`discovery` + snapshot.social | daily 04:30 (handle, no connection) | **blocked on Meta Advanced Access (#10)** |
| Verified handle + followers | Claude `web_search` resolver (Haiku, evidence-gated) | confirmed handle, follower estimate, confidence, evidence — fail-safe null | snapshot.social source=`research` | during research / as BD fallback | live — the active unconnected path |
| YouTube public (unconnected) | Data API v3 (API key) | subscribers, channel views, video count | source=`discovery` rows | daily 04:30 | live |
| Deep research | Gemini grounding (5 parallel searches) + Kimi extraction | achievements, press mentions, brand-deal mentions, social handles, NIL-valuation mentions, media-asset URLs, sentiment, story arc | `athlete_snapshots.research` + counts on `athletes_current` | at activation + monthly re-enrich | live |
| Search interest | Google Trends | interest score (0–100) | `athlete_snapshots.google_trends_score` | at research + monthly | live |
| News presence | GDELT | article count, average tone | `athlete_snapshots.gdelt_article_count` | at research + monthly | live |
| Inbound brand demand | brands emailing / DMing the athlete | offers, amounts, deliverables, deadlines — the realest market signal we hold | inbox pipeline → `deals` | real-time | live |

## 4 · Derived & computed

Deterministic code computes all numbers; LLMs emit only categorical judgments
(the derive-don't-emit pattern, `dealScoreGrid.ts`).

| Output | Computed from | By | Stored in | Recomputed |
|---|---|---|---|---|
| Capital scores (5) | social + research + Trends + GDELT + deals (audience / athletic / brand / commercial / narrative) | `scoringService.computeScore` | per-snapshot `score` jsonb + `athletes_current.capitals` | daily + on connect/enrich (writes only on change) |
| M.I.A. display score + tier | weighted capitals → 0–850, tier, pts-to-next, fill % | same | same — **history exists** (e.g. Mia 455→500→551) | daily |
| Momentum | follower growth rate, engagement delta, trends velocity, GDELT delta, new deals | same | `score.momentum` per snapshot | daily · **not surfaced in UI** |
| Audience sub-scores | cross-platform consistency, audience quality, engagement stability, content consistency | same | folded into Audience capital | daily · not itemized anywhere |
| Rate card v3.1 | followers × IMH anchors × athlete premium × engagement × score-mod × confidence bands; appearance / ambassador / autograph / licensing / PAV | `rateService.computeRateCardFromScore` | `athletes_current.rate_card` (+ legacy `deal_type_rates`, `pav`) | whenever the score writes |
| Engagement rates | platform-specific: IG (likes+comments)/followers · TikTok /views · YT /subs | integration modules | both snapshot paths | daily |
| Trend deltas | followers 7d/30d, engagement/reach/views 30d from daily rows | `routes/analytics.ts` `/history` | computed on request — not stored | live per API call |
| Deal classification | message text → category (PAID/GIFTING/FAN/…), confidence, offer amount, deliverables | Kimi (categorical) | `inbox_threads.classification` | per message, real-time |
| Deal score 1–10 + verdict | offer positioned in the athlete's own rate card (Econ band) × fit grid — **derived, not LLM-emitted** | `dealScoreGrid` | `inbox_threads.score` jsonb (not on `deals`) | per message + rescore on reply |
| Thread state + offer struct | conversation summary, offer amount/unit/deliverables, deadlines, who-owes-reply | `threadSummarizer` (Kimi) | `inbox_threads.conversation_state` | per new message |
| Brand identity | sender → normalized brand, agency detection, fuzzy dedup | `brandResolver` (4-strategy) | `inbox_brands` (`normalized_name` unique, `is_agency`) | per message |
| Story arc | research narrative synthesis | research pipeline | `athletes_current.story_arc` | at research + monthly |
| Brand stories / insights | columns + `tasks.type` values reserved | — | `athletes_current.brand_stories` / `insights` | **no handler — never populated** |

## 5 · Known gaps, in one place

- **Collected-but-hidden:** momentum block + audience sub-scores computed daily, never shown.
- **Defined-but-dead:** `brand_voice` never written; `brand_stories`/`insights` have no
  generator; IG DM `sync_cursor` declared, never used.
- **Gated externally:** Business Discovery (Meta Advanced Access pending), IG DM webhooks
  (app must go Live), TikTok demographics (Business API approval), Spotify (no app
  credentials), X (no connector; analytics paywalled).
- **Never touched:** durable media storage (IG CDN links rot; GCS re-hosting flagged as
  future in `schema.ts:451`), comment text, follower lists (impossible via any IG API
  tier), sports schedules/results.
