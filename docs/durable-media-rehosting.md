# Durable media re-hosting layer

Status: **Phases 1–3 built + validated** (2026-07-12 — 22 stills re-hosted from Mia's posts; `GET /me/media` + in-app gallery proven end-to-end, signed URL → HTTP 200/image). Owner decisions D1–D4 resolved (below). This is **brick 1** of
rebuilding a media/content capability in nomila-2 — the foundation the media-kit, pitch-deck,
highlight, and AI-generation features all sit on.

## Objective
Instagram (and Business Discovery) hand us **ephemeral CDN URLs** for post media that expire within
hours-to-days. To build anything durable *from* an athlete's content — media kits, pitch decks,
highlight reels, AI-generated variants — we must **own the pixels**. This layer re-hosts IG post media
into our own GCS bucket + an asset table, for connected athletes now and unconnected athletes (via
Business Discovery) once Advanced Access lands, with full carousels.

The `recent_media[]` snapshot field already flags this as the planned next step (`shared/schema.ts:451`).

## Where this fits — the 4-layer roadmap
This layer is deliberately the smallest useful brick. Each later layer is additive and maps to a
piece nomila-1's Studio already proved out:

| Layer | What | nomila-1 analogue | This doc |
|---|---|---|---|
| **0 · OWN** | re-host IG media → GCS + `media_assets` | `assets` table + `gcsService` | **← scope here** |
| 1 · ENRICH | AI-tag each asset (shot/env/attire/vibe/quality) + pgvector embedding | `photoAnalysisService` | next |
| 2 · COMPOSE | media kit / pitch deck (layout + Gemini copy → Puppeteer PDF → GCS; the render runs in a per-task Cloud Run job, never the API¹) | `mediaKitAgent` | later |
| 3 · GENERATE | AI image/video, template + asset matching | Studio + `generationService` | later |

¹ Per the sandbox design (https://claude.ai/artifact/QDZ6mRjZTtjiu8NvhnhUMP). `puppeteer` was removed from
`package.json` on 3 Nov 2026 while unused; it comes back in that job, not in the API image.

Layer 0 is a clean base for all of it **provided the table is the unified asset library** (see schema),
not an IG-only cache. Layers 1–3 then extend the same table (enrichment columns, `origin='generated'`
rows) rather than replacing it.

**Generation path note:** nomila-2 already uses `@google/genai` (Gemini) and `@google-cloud/vertexai`
(Imagen images / Veo video). Layer 3 extends those SDKs — no WaveSpeed/fal/Replicate raw-HTTP stack
like nomila-1 (which was removed). Cleaner and already-wired.

## Grounded facts (verified against the repo)
- `@google-cloud/storage@7.18.0` is **already a dependency** — unused; we write the wrapper, add no dep.
- `@google-cloud/tasks` is **already present, unused** — the natural home for the async download queue if/when we outgrow the in-cron loop.
- `recent_media[]` shape (`schema.ts:463`) already carries `id, permalink, media_type, media_url, thumbnail_url, caption, timestamp, like/comments_count, insights` — but **no carousel children** (added below).
- Daily analytics cron is `30 4 * * *` → `collectAllAnalyticsSnapshots` (`server/index.ts:476`). Re-host runs right after, same cron.
- Discovery does **not** populate `recent_media` today, and its BD media sub-query fetches only `media.limit(10){like_count,comments_count,timestamp}` (`discovery.ts:65`) — no media_url/permalink/caption. Both are added below.
- Auth: use **ADC / the Cloud Run runtime SA** (`gamechanger-runtime`), granted `objectAdmin` on the bucket. Do not plumb `GOOGLE_SERVICE_ACCOUNT_JSON` into the storage client.

## Architecture — 4 pieces

### 1. Storage — GCS bucket
- New **private** bucket `nomila-athlete-media`. Runtime SA granted `roles/storage.objectAdmin` on it.
- Path: `athletes/{athlete_id}/instagram/{media_id}.{ext}` + `…/{media_id}_thumb.jpg`.
- Access via **signed URLs** (D2). One small `server/lib/mediaStore.ts` wrapper around `@google-cloud/storage` (upload stream, signed-URL getter, exists-check) — auth via ADC.

### 2. Schema — `media_assets` table (additive)
Shaped as the **unified asset library** (amendment vs. the original proposal — extensible `origin`,
lineage pointer, reserved enrichment jsonb) so Layers 1–3 extend it instead of migrating.

```
media_assets (
  id                   uuid PK default random,
  athlete_id           uuid NOT NULL FK -> athletes(id) ON DELETE CASCADE,
  platform             text NOT NULL,          -- 'instagram' (extensible)
  origin               text NOT NULL,          -- 'connected' | 'discovery' | (later) 'upload' | 'generated'
  source_media_id      text,                   -- IG media id; NULL for upload/generated
  parent_media_id      text,                   -- carousel parent's media id (set on child rows)
  derived_from_asset_id uuid FK -> media_assets(id),  -- lineage for generated/derived variants (NULL in v1)
  media_type           text NOT NULL,          -- IMAGE|VIDEO|REELS|CAROUSEL_ALBUM|CAROUSEL_CHILD
  permalink            text,
  caption              text,
  posted_at            timestamptz,
  like_count           integer,
  comments_count       integer,
  insights             jsonb,                  -- per-post reach/saved/shares/... (best-effort)
  gcs_path             text,                   -- re-hosted still; album parent carries its COVER (verified live); NULL only if no downloadable still
  gcs_thumb_path       text,
  content_type         text,
  bytes                bigint,
  width                integer,
  height               integer,
  status               text NOT NULL,          -- 'stored' | 'failed' | 'skipped_size'
  metadata             jsonb,                  -- reserved: Layer-1 enrichment (tags, embedding ref)
  ingested_at          timestamptz,
  metadata_updated_at  timestamptz,
  created_at           timestamptz default now(),
  UNIQUE (athlete_id, platform, source_media_id),
  INDEX  (athlete_id, posted_at DESC)
)
```
`recent_media` in the snapshot stays as the **display cache** (fresh each day); `media_assets` is the
**durable owned copy**. Applied via `CREATE TABLE IF NOT EXISTS` in the deploy DDL block + `schema.ts` — the repo is **migration-managed + additive-DDL**; `db:push` was deliberately removed (`deploy.yml:120`).

### 3. Ingest — `rehostAthleteMedia` skill
Runs in the `30 4 * * *` cron **immediately after** `collectAllAnalyticsSnapshots` (reads fresh,
unexpired URLs from the just-written snapshot), in its own try/catch so a media failure never touches
analytics (already committed by then).

Per athlete, per item in the latest snapshot's `recent_media`:
- **Seen `source_media_id`?** → update counts/insights/caption only (pixels are immutable — download once).
- **New?** → stream media (+ generate/fetch thumb) → GCS → insert row `status='stored'`.
- **Carousel?** → the `CAROUSEL_ALBUM` parent **carries a cover** (`media_url`, verified live) → store it as the parent's `gcs_path` + iterate `children` → one `CAROUSEL_CHILD` row each (`parent_media_id` set). (The cover ≈ child[0]; small, acceptable dup.)
- **Video (D1)** → store **poster/thumbnail only** in v1; record `permalink`+`source_media_id` so the full file can be fetched on demand later.
Idempotent, bounded concurrency, best-effort. Failures → `status='failed'` + log, never throw.

### 4. Fetch additions (the two you asked for)
- **Carousel children** — add `children{media_url,media_type,thumbnail_url}` to the media field-expansion in `instagram.ts fetchAnalytics`. Safe: `children` is a *field*, not a metric, so it won't trip the invalid-metric expansion failure. Extend `recent_media[]` type with an optional `children[]`.
- **Unconnected media** — add `media_url,thumbnail_url,permalink,caption` (+ `children{…}` where supported) to the Business Discovery media sub-query in `discovery.ts` + `platformDiscovery.ts`, and have `discovery.ts` populate `raw_metrics.recent_media` (it doesn't today) so the *same* re-host skill handles it with `origin='discovery'`.

## Decisions (resolved)
| # | Decision | Call |
|---|---|---|
| D1 | Videos: full file vs thumbnail | **Thumbnail/poster only** in v1; full-video behind a flag + size cap later. Keep `permalink`+`media_id` to fetch on demand. |
| D2 | Serving: signed URL vs public | **Signed URLs, private bucket.** Public/CDN path only when a shareable media kit ships. |
| D3 | Retention | **Keep all images/thumbs** (cheap); **cap full videos** when they arrive. Cascade-delete with the athlete. |
| D4 | Unconnected (BD) media | **Build now, dormant** until Advanced Access. |
| — | Carousel children | **In scope** (one field + child rows). |
| — | Schema shape | **Unified asset library** (`origin` extensible + `derived_from_asset_id`) — amendment for the generation roadmap. |

## Build order
1. ✅ **Bucket + `media_assets` table + `rehostAthleteMedia` skill** — connected stills, wired into the daily cron. Proven on Mia's real posts.
2. ✅ **Carousel children** — `children{}` fetch (verified live) + child rows.
3. ✅ **Signed-URL serving + consumer** — `GET /api/v1/me/media` (keyset-paginated, carousels grouped, fresh signed URLs) + an in-app **MediaGallery** (grid, carousel/video badges, tap-to-expand). Shipped together — never an orphaned endpoint.
4. **Unconnected (Business Discovery) media** — dormant until Advanced Access.
5. *(later)* full-video download behind a flag; public path; resized thumbnails.

## Layer 1 — future enrichment (reference design; DO NOT build in this brick)
**Held deliberately.** Unlike re-hosting (CDN URLs expire → waiting = permanent loss), owned pixels
are **permanent**, so enrichment can be computed over the whole catalog anytime with zero loss from
waiting. And the **consumer should define the taxonomy** — nomila-1 tagged for a template-matching
engine; nomila-2's pitch-deck / interactive-card generator doesn't exist yet, so enriching now bets
on a schema before its consumer. So enrichment ships **with the first generator that consumes it**
(which defines its own signal), then we backfill-enrich the whole catalog in one pass. The table
already reserves the seam (`metadata` jsonb + `derived_from_asset_id`) — a column + backfill later,
not a redesign.

Reference design to reuse (nomila-1's `photoAnalysisService`), so we don't re-derive it:
- **Categorical tags** per asset (derive-don't-emit — the model grades, code composes):
  `shotType`, `environment`, `attire`, `vibe`, `quality`, `emotionalTone`.
- A **1408-dim multimodal embedding** per asset in **pgvector**, for asset↔template / asset↔brand
  similarity matching.
- Generated variants land as `origin='generated'` rows with `derived_from_asset_id` → lineage.

## Verify items / risks
- **BD `children{}` support** — Business Discovery's media edge may not expand carousel children for unconnected accounts; unconnected carousels may yield only the cover image. Not a blocker — degrade to cover-only.
- **30-day window (matters less than it reads)** — `recent_media` is the last-30-days posts, but the cron runs daily and pixels download **once and persist**, so `media_assets` **accumulates**: any post captured within its window stays owned forever. There is **no forward gap** — only pre-existing history older than 30 days at first capture (Mia's older videos). Full-history `/me/media` pagination is a **run-once-when-a-generator-needs-deep-catalog** item, not a now-priority.
- **CDN expiry race** — mitigated by re-hosting in the *same* cron run that wrote the snapshot (URLs are freshest then).
- **Storage cost** — mitigated by thumbnails-first + images-only in v1.
- **Download timeouts / oversized media** — size cap + `status='skipped_size'`, bounded concurrency.
- Blast radius is low: one new table + one new skill + two additive fetch fields. Nothing existing changes behavior.

## Effort
~1.5–2 weeks for Phases 1–3 (the useful core); Phase 4 small (dormant); Phase 5 (full video / public
path) deferred. Verified end-to-end on Mia's actual Instagram posts as the acceptance test.
