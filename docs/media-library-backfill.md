# Media library — multi-platform backfill & analysis substrate

Status: **Design — for review (no code yet).** Extends the durable-media layer
([durable-media-rehosting.md](./durable-media-rehosting.md), Phases 1–3 shipped) from
"connected-Instagram stills" to a **full-history, multi-platform content library** that feeds two
consumers: the **media kit / interactive cards** (needs a deep pool of hero-quality imagery) and
**content/brand analysis** (needs breadth across every platform to read content style + brand voice).

## Why this is needed (grounded)

Today the library holds **2 posts for Mia** — she has many more. Three compounding causes, all verified:

1. **We only re-host Instagram** — the skill is hard-scoped `PLATFORMS = ["instagram"]`
   (`rehostAthleteMedia.ts`). TikTok and YouTube are ignored by the media layer.
2. **Every fetch is single-page.** IG `/{ig}/media?limit=25` (`instagram.ts:405`), TikTok
   `video/list max_count:20` (`tiktok.ts:265`), YouTube `search order=date maxResults=10`
   (`youtube.ts:326`) — none follow the pagination cursor. We cap at page one regardless of history depth.
3. **Content already on the shelf, unused:** Mia's daily TikTok snapshot carries **20 videos**
   (covers + captions + stats), fetched every day, never stored — because of (1). Her IG snapshot
   carries 2; her YouTube channel is empty.

So the biggest immediate jump comes from data we *already pull*, and the deep jump comes from
following pagination we already have tokens for.

## What each platform can actually give us

History depth is **not** the constraint — all three paginate back to the first post. The differences
are which *pixels we can own* and whether a raw video file exists.

| Platform | History | Pixels we own | Text (brand voice) | Stats | Raw video file? |
|---|---|---|---|---|---|
| **Instagram** | Full (`after` cursor) | Images, carousel children, video **posters** | caption | likes, comments, insights | **mp4 available** (expiring) — poster-only today, full for top performers |
| **TikTok** | Full (`cursor`+`has_more`, 20/pg) | **Cover** thumbnail | title + description | views, likes, comments, **shares**, duration | **No** — Display API gives cover + share link only |
| **YouTube** | Full (uploads playlist, 50/pg) | Thumbnail (to 1280×720) | title + description | views, likes, comments, duration | **No** (ToS) |

Media URLs are short-lived CDN links (why we re-host); pagination re-issues **fresh URLs each call**,
so history isn't lost while connected — the irreversible cases are the athlete **disconnecting** or
**deleting** a post. Rate limits are mild (a few hundred posts ≈ a dozen calls).

## The model: own broad → enrich → select

Intelligence lives at **enrich** and **select**, not at ingest. Quality/brand/aesthetic judgment needs
the pixels, so "filter by quality before storing" is circular — you'd download to judge, at which point
storing is nearly free. Ingest gates only on **cheap metadata**.

- **Stage 1 · INGEST — own broadly, cheap gates only.** Full first pass, incremental after. Dedup,
  resolution floor, poster-only video (except top-performer mp4). Stamp `pixel_grade` (below). No quality
  calls here.
- **Stage 2 · ENRICH — vision + text analysis on the owned catalog.** shotType / environment / attire /
  vibe / quality / athlete-present + embedding (visual); topic / tone / cadence (text). Reversible,
  re-runnable, zero loss. **Held** until the first generator that consumes it defines "good" — then
  backfill-tag the whole catalog in one pass.
- **Stage 3 · SELECT — per-output query over enrichment.** The media kit picks best-N for *its* layout
  (quality + on-brand + diverse + aspect ratio); analysis reads the whole enriched corpus. Selection is
  a query, never a storage decision.

### `pixel_grade` — enforces "no hero imagery from thumbnails"
Stamped at ingest into `metadata` (a *fact about the source*, not a quality judgment, so it's free):

- `'full'` — IG images/carousel children, IG top-performer mp4s.
- `'thumbnail'` — TikTok covers, YouTube thumbnails, IG video posters (until/unless we grab the mp4).

The selection algo excludes `thumbnail`-grade from **hero** slots, while still using it for **stats
tiles, content-style analysis, and brand-voice signal.** The permalink stays the handle for embedding
the real TikTok/YT player.

## Analysis substrate (what we feed the models)

Content-style / brand-voice analysis runs on **owned thumbnail + text**, *not* on the permalink:

| Source | Substrate | Fidelity |
|---|---|---|
| IG image / carousel | owned full pixels + caption | high |
| IG top-performer video | owned **mp4** (frames + transcript) + caption | high, temporal |
| IG video (rest) | poster frame + caption | medium |
| TikTok | cover + title/description + stats | medium |
| YouTube | thumbnail + title/description + stats | medium |

Full mp4 (IG top performers) adds motion/temporal understanding; everything else is a representative
frame + text, which is sufficient for style and voice. The **permalink is the escape hatch** (embed /
future full-fetch), not a model input.

## Schema — no changes needed

`media_assets` is already the **unified library** — one table, platform is a column:

- `platform` — `instagram | tiktok | youtube` (extensible)
- `origin` — `connected | discovery | upload | generated`
- `permalink` — durable link (the schema marks it *"STABLE across CDN URL expiry"*)
- `pixel_grade` → lives in the reserved `metadata` jsonb (no new column)
- `status` — supports a future `'archived'` state → curation/retention is a reversible flag, not deletion
- `derived_from_asset_id` — lineage for later generated variants

**Camera-roll uploads** slot in unchanged: `origin='upload'`, `source_media_id=NULL`, `gcs_path` from a
direct upload (not a re-host). It needs a small upload endpoint, no schema change. Connected posts,
discovery media, uploads, and future generated assets all coexist in one library — a media-library
screen is a single query, grouped by `platform` as a view choice.

## Ingest policy (resolved with owner)

| Decision | Call |
|---|---|
| First pass | **Everything** — images + thumbnails + stats. Storage is negligible; breadth is exactly what the analysis goal wants. |
| Subsequent passes | **Incremental** — new-since-last-seen only. Deep pagination runs once per athlete. |
| Pacing (not truncation) | **Resumable + throttled.** Checkpoint the pagination cursor per athlete; process ~300 items/cron-tick and resume next run. A prolific account completes over a few days without starving the shared per-app rate/quota budget that every athlete's daily sync draws on, or blowing the cron window. "Everything" stays intact. |
| Safety backstop | **~10,000 items / platform** as a *broken-loop guard only* (a bad cursor that never terminates), with a log/alert when hit — not a content limit; should essentially never fire. |
| YouTube quota | Paginate via `playlistItems` (**1 unit**), never `search` (**100 units**). |
| Full IG video mp4 | **Top performers only — top 5–10 by engagement** — behind a flag (bandwidth/storage is the one non-cheap axis). |
| TikTok / YouTube | **Ingest for analysis + stats tiles**, `pixel_grade='thumbnail'` → never hero imagery. Keep the watch link. |
| Retention | **Keep broad, archive/delete later by rule** (`status`), never lose on ingest. |

## Pagination specifics (per platform)

- **Instagram** — `/{ig}/media` + follow `paging.next` until exhausted or ceiling; keep the existing
  `children{...}` expansion; poster for video, mp4 for flagged top performers.
- **TikTok** — `video/list` loop on `cursor` while `has_more`, 20/page; store cover + title/description +
  stats + `share_url` permalink.
- **YouTube** — `channels → contentDetails.relatedPlaylists.uploads → playlistItems` (50/page,
  `pageToken`), then `videos.list` for statistics + duration + `maxres` thumbnail; `watch?v=` permalink.

Backfill runs as its own skill (not the daily analytics fetch), bounded concurrency, best-effort per
item (failure → `status='failed'` + log, never throws), so a media hiccup never touches scoring.

## Build order

1. **TikTok + YouTube into the re-host skill** — unlock the 20 TikTok items already fetched; add YT.
   (Small — data's already in the snapshot for TikTok.)
2. **Full-history pagination** — IG + TikTok + YT backfill skill (full first pass + incremental),
   ceiling + `pixel_grade` stamping.
3. **Full IG mp4 for top performers** — behind a flag.
4. **Camera-roll upload endpoint** — `origin='upload'` (whenever the upload UI is wanted).
5. *(held)* Enrichment (Stage 2) — ships with the first generator that defines "good," then one backfill pass.

## Decisions (resolved)
- First pass = **everything**; pacing via **resumable+throttled** backfill, not a low truncation; **~10,000/platform** backstop as a broken-loop guard only.
- IG full-mp4 flag = **top 5–10 by engagement**.
- **Media-library screen — deferred** (next up after this, not part of this brick).
