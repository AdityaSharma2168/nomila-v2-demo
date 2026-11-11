/**
 * seed-dev-athlete.ts — deterministic synthetic data for ONE dev athlete so
 * Mila's read tools return real, grounded results in local/dev.
 *
 * Usage (a person runs this — with --apply it writes to the shared DB):
 *   1. DRY RUN (default; checks the shapes and the athlete, writes nothing):
 *        npx tsx --require dotenv/config scripts/seed-dev-athlete.ts --athlete <uuid>
 *   2. APPLY:  the same plus --apply
 *   The Mila golden eval then runs against that athlete:
 *        npm run eval:mila -- --athlete <uuid>
 *
 * SAFETY
 * ──────
 * · One athlete per run, named explicitly with --athlete (no id is baked in).
 *   It is for a DEV/test athlete: the rows it writes are synthetic. Every
 *   write is scoped to that athlete id.
 * · Idempotent. Every table is delete-then-insert (or upsert) scoped by a
 *   recognizable marker so it NEVER touches email-ingested rows:
 *     - deals   : raw_data->>'seed' = SEED_MARKER   (inbox_scan deals lack it)
 *     - snapshots: source='research' AND snapshot_day in the fixed seed days
 *                  (real connected snapshots are source='connected')
 *     - athletes_current: upsert on the PK (one row per athlete)
 * · Deterministic. All dates are fixed literals (anchored 2026-07-23), never
 *   Date.now(), so reruns produce identical data and get_analytics deltas are
 *   stable regardless of when the script runs.
 * · Does NOT create or modify the `athletes` row itself — that is the athlete's
 *   real profile (read by get_profile). It only preflight-checks it exists.
 *
 * Requires DATABASE_URL (.env, via the Cloud SQL Auth Proxy).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../server/db";
import {
  athletes,
  athletesCurrent,
  deals,
  socialAnalyticsSnapshots,
  type SocialAnalyticsRaw,
} from "../shared/schema";

// The athlete this run seeds: --athlete <uuid> (required). --apply writes; the default is a dry run.
const ARGV = process.argv.slice(2);
const ATHLETE_ARG_INDEX = ARGV.indexOf("--athlete");
const TARGET_ATHLETE_ID = ATHLETE_ARG_INDEX >= 0 ? (ARGV[ATHLETE_ARG_INDEX + 1] ?? "") : "";
const APPLY = ARGV.includes("--apply");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Marker stamped into rows this script owns, so re-runs delete only seed rows
// and never collide with real (email-ingested) data.
const SEED_MARKER = "mila-dev-seed";

// Fixed anchor so data is deterministic across runs. get_analytics computes
// deltas relative to the latest snapshot_day (not "today"), so a fixed anchor
// keeps 7d/30d deltas stable forever.
const ANCHOR = "2026-07-23T12:00:00.000Z";
const DAY_30D_AGO = "2026-06-23";
const DAY_7D_AGO = "2026-07-16";
const DAY_LATEST = "2026-07-23";
const SNAPSHOT_DAYS = [DAY_30D_AGO, DAY_7D_AGO, DAY_LATEST];

// ─── Seed payloads ────────────────────────────────────────────────────────────

// Obviously-synthetic brands; statuses NOT used by inbox-detected deals
// (accepted / completed / negotiating). Marker lives in raw_data.
const SEED_DEALS = [
  {
    brand_name: "Sunrise Oats Co. (SEED)",
    deal_type: "social_post" as const,
    amount: "1500",
    status: "accepted" as const,
    detected_at: new Date("2026-07-10T00:00:00.000Z"),
    negotiation_state: null as Record<string, unknown> | null,
  },
  {
    brand_name: "Trailhead Running Club (SEED)",
    deal_type: "appearance" as const,
    amount: "3200",
    status: "completed" as const,
    detected_at: new Date("2026-06-15T00:00:00.000Z"),
    negotiation_state: null as Record<string, unknown> | null,
  },
  {
    brand_name: "Foglight Studios (SEED)",
    deal_type: "ambassador" as const,
    amount: "5000",
    status: "negotiating" as const,
    detected_at: new Date("2026-07-21T00:00:00.000Z"),
    negotiation_state: {
      stage: "counter_sent",
      last_offer: 4000,
      target: 5000,
    },
  },
];

// Per-platform scalar columns, production-shaped (mirrors what instagram.ts /
// tiktok.ts write). avg_engagement_rate is a PERCENT (e.g. 4.1 = 4.1%), matching
// instagram.ts:508 — the analytics screen renders it via fmtPct (`${n}%`). IG has
// no lifetime likes / views-per-post; TikTok has no reach / saves. null where
// production leaves it null.
const IG_SCALARS = {
  following: 850,
  post_count: 320,
  total_likes: null,
  total_channel_views: null,
  is_verified: false,
  reach: 45600,
  impressions: 61000,
  profile_views: 1400,
  avg_engagement_rate: 4.1,
  avg_reach_per_post: 5200,
  avg_views_per_post: null,
  avg_shares_per_post: 210,
  avg_saves_per_post: 640,
  avg_watch_time_sec: null,
  content_frequency: 3.5,
  posts_last_30d: 12,
  top_audience_country: "US",
  top_audience_city: "Los Angeles",
  top_audience_age_range: "25-34",
  top_audience_gender: "F",
};
const TT_SCALARS = {
  following: 420,
  post_count: 180,
  total_likes: 240000,
  total_channel_views: null,
  is_verified: false,
  reach: null,
  impressions: null,
  profile_views: null,
  avg_engagement_rate: 5.2,
  avg_reach_per_post: null,
  avg_views_per_post: 18000,
  avg_shares_per_post: 340,
  avg_saves_per_post: null,
  avg_watch_time_sec: null,
  content_frequency: 4.2,
  posts_last_30d: 17,
  top_audience_country: "US",
  top_audience_city: "Los Angeles",
  top_audience_age_range: "18-24",
  top_audience_gender: "F",
};

// raw_metrics for the LATEST snapshot per platform — the analytics screen reads
// demographics + recent_media off this. Fixed timestamps (deterministic). Media
// URLs are null (placeholder render, no network fetch); permalinks use the
// reserved `.invalid` TLD so nothing ever resolves. One IG reel and the TikTok
// clips are engineered as "breakouts" (reach/views ≥ 2× followers) so the reach
// hero has a virality story to show.
const IG_RAW: SocialAnalyticsRaw = {
  account: { username: "dev.seed.athlete", display_name: "Dev Seed Athlete" },
  demographics: {
    gender: [
      { key: "F", value: 7800, pct: 65 },
      { key: "M", value: 3960, pct: 33 },
      { key: "U", value: 240, pct: 2 },
    ],
    age: [
      { key: "25-34", value: 5400, pct: 45 },
      { key: "18-24", value: 3600, pct: 30 },
      { key: "35-44", value: 1800, pct: 15 },
    ],
    country: [
      { key: "US", value: 8400, pct: 70 },
      { key: "CA", value: 1200, pct: 10 },
      { key: "GB", value: 720, pct: 6 },
    ],
    city: [
      { key: "Los Angeles", value: 2400, pct: 20 },
      { key: "New York", value: 1440, pct: 12 },
    ],
  },
  recent_media: [
    {
      id: "seed_ig_1",
      permalink: "https://example.invalid/seed/ig1",
      media_type: "IMAGE",
      caption: "Synthetic seed post 1",
      timestamp: "2026-07-21T17:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 620,
      comments_count: 48,
      is_shared_to_feed: true,
      is_discovery: false,
      insights: {
        reach: 15200,
        saved: 210,
        shares: 95,
        total_interactions: 973,
      },
    },
    {
      id: "seed_ig_2",
      permalink: "https://example.invalid/seed/ig2",
      media_type: "REELS",
      caption: "Synthetic seed reel (breakout)",
      timestamp: "2026-07-18T16:30:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 1800,
      comments_count: 120,
      is_shared_to_feed: false,
      is_discovery: true,
      insights: {
        reach: 42000,
        saved: 640,
        shares: 410,
        total_interactions: 2970,
      },
    },
    {
      id: "seed_ig_3",
      permalink: "https://example.invalid/seed/ig3",
      media_type: "IMAGE",
      caption: "Synthetic seed post 3",
      timestamp: "2026-07-14T15:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 540,
      comments_count: 40,
      is_shared_to_feed: true,
      is_discovery: false,
      insights: {
        reach: 13800,
        saved: 180,
        shares: 70,
        total_interactions: 830,
      },
    },
    {
      id: "seed_ig_4",
      permalink: "https://example.invalid/seed/ig4",
      media_type: "CAROUSEL_ALBUM",
      caption: "Synthetic seed post 4",
      timestamp: "2026-07-10T14:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 500,
      comments_count: 36,
      is_shared_to_feed: true,
      is_discovery: false,
      insights: {
        reach: 12600,
        saved: 160,
        shares: 60,
        total_interactions: 756,
      },
    },
  ],
};
const TT_RAW: SocialAnalyticsRaw = {
  account: { username: "dev.seed.athlete", display_name: "Dev Seed Athlete" },
  demographics: {
    gender: [
      { key: "F", value: 5200, pct: 65 },
      { key: "M", value: 2640, pct: 33 },
      { key: "U", value: 160, pct: 2 },
    ],
    age: [
      { key: "18-24", value: 4000, pct: 50 },
      { key: "25-34", value: 2400, pct: 30 },
      { key: "13-17", value: 800, pct: 10 },
    ],
    country: [
      { key: "US", value: 5600, pct: 70 },
      { key: "CA", value: 800, pct: 10 },
      { key: "GB", value: 480, pct: 6 },
    ],
  },
  recent_media: [
    {
      id: "seed_tt_1",
      permalink: "https://example.invalid/seed/tt1",
      media_type: "VIDEO",
      caption: "Synthetic seed clip 1",
      timestamp: "2026-07-22T18:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 1400,
      comments_count: 90,
      insights: { video_views: 22000, shares: 320, total_interactions: 1810 },
    },
    {
      id: "seed_tt_2",
      permalink: "https://example.invalid/seed/tt2",
      media_type: "VIDEO",
      caption: "Synthetic seed clip 2 (breakout)",
      timestamp: "2026-07-19T17:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 5200,
      comments_count: 260,
      insights: { video_views: 96000, shares: 1400, total_interactions: 6860 },
    },
    {
      id: "seed_tt_3",
      permalink: "https://example.invalid/seed/tt3",
      media_type: "VIDEO",
      caption: "Synthetic seed clip 3",
      timestamp: "2026-07-15T16:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 2100,
      comments_count: 130,
      insights: { video_views: 34000, shares: 520, total_interactions: 2750 },
    },
    {
      id: "seed_tt_4",
      permalink: "https://example.invalid/seed/tt4",
      media_type: "VIDEO",
      caption: "Synthetic seed clip 4",
      timestamp: "2026-07-11T15:00:00.000Z",
      media_url: null,
      thumbnail_url: null,
      like_count: 1200,
      comments_count: 80,
      insights: { video_views: 18000, shares: 280, total_interactions: 1560 },
    },
  ],
};

// Follower series → get_analytics deltas: IG 7d +200 / 30d +600, TT 7d +150 /
// 30d +400. Latest per platform matches athletes_current followers and carries
// the full raw_metrics; older days carry the scalar shape (the screen reads
// raw_metrics off the latest snapshot only). Every row is full production shape.
const SNAPSHOT_SERIES = [
  { platform: "instagram" as const, day: DAY_30D_AGO, followers: 11400 },
  { platform: "instagram" as const, day: DAY_7D_AGO, followers: 11800 },
  { platform: "instagram" as const, day: DAY_LATEST, followers: 12000 },
  { platform: "tiktok" as const, day: DAY_30D_AGO, followers: 7600 },
  { platform: "tiktok" as const, day: DAY_7D_AGO, followers: 7850 },
  { platform: "tiktok" as const, day: DAY_LATEST, followers: 8000 },
];

function buildSnapshotRow(s: (typeof SNAPSHOT_SERIES)[number]) {
  const scalars = s.platform === "instagram" ? IG_SCALARS : TT_SCALARS;
  const raw: SocialAnalyticsRaw | null =
    s.day === DAY_LATEST
      ? s.platform === "instagram"
        ? IG_RAW
        : TT_RAW
      : null;
  return {
    athlete_id: TARGET_ATHLETE_ID,
    source: "research" as const,
    platform: s.platform,
    snapshot_day: s.day,
    snapshot_date: new Date(`${s.day}T12:00:00.000Z`),
    followers: s.followers,
    ...scalars,
    raw_metrics: raw,
  };
}

const SNAPSHOT_ROWS = SNAPSHOT_SERIES.map(buildSnapshotRow);

// ─── Shape contract ───────────────────────────────────────────────────────────
//
// The analytics snapshots the screens read unguarded are parsed against the schemas below and the run throws before
// any DB write if a seeded row drifts. zod ignores EXTRA keys by design (only required keys matter).

const DemographicRowSchema = z.object({
  key: z.string(),
  value: z.number(),
  pct: z.number(),
});

const SnapshotMediaSchema = z.object({
  id: z.string(),
  permalink: z.string(),
  media_type: z.string(),
  caption: z.string().nullable(),
  timestamp: z.string(),
  media_url: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  like_count: z.number().nullable(),
  comments_count: z.number().nullable(),
  insights: z
    .object({
      reach: z.number().optional(),
      saved: z.number().optional(),
      shares: z.number().optional(),
      video_views: z.number().optional(),
      total_interactions: z.number().optional(),
    })
    .nullable(),
});

const RawMetricsSchema = z.object({
  account: z.object({ username: z.string() }).passthrough(),
  demographics: z.object({
    gender: z.array(DemographicRowSchema).min(1),
    country: z.array(DemographicRowSchema).min(1),
    age: z.array(DemographicRowSchema).optional(),
    city: z.array(DemographicRowSchema).optional(),
  }),
  recent_media: z.array(SnapshotMediaSchema).min(1),
});

const SnapshotRowSchema = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  snapshot_day: z.string(),
  snapshot_date: z.date(),
  followers: z.number(),
  following: z.number().nullable(),
  post_count: z.number().nullable(),
  total_likes: z.number().nullable(),
  is_verified: z.boolean(),
  reach: z.number().nullable(),
  impressions: z.number().nullable(),
  profile_views: z.number().nullable(),
  avg_engagement_rate: z.number().nullable(),
  avg_reach_per_post: z.number().nullable(),
  avg_views_per_post: z.number().nullable(),
  avg_shares_per_post: z.number().nullable(),
  avg_saves_per_post: z.number().nullable(),
  avg_watch_time_sec: z.number().nullable(),
  content_frequency: z.number().nullable(),
  top_audience_country: z.string().nullable(),
  top_audience_city: z.string().nullable(),
  top_audience_age_range: z.string().nullable(),
  top_audience_gender: z.string().nullable(),
  raw_metrics: RawMetricsSchema.nullable(),
});

/** Throw loudly, listing every missing/bad path, if any seeded analytics
 *  snapshot drifts from the production analytics shape the screen reads. Runs
 *  before any DB write. */
function assertSnapshotShapes(rows: unknown[]): void {
  const problems: string[] = [];
  rows.forEach((row, i) => {
    const parsed = SnapshotRowSchema.safeParse(row);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      problems.push(
        `  · snapshot[${i}].${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
    }
  });
  if (problems.length === 0) return;
  throw new Error(
    `Seeded analytics snapshots are missing keys the production analytics ` +
      `interface requires — the analytics screen would render wrong. Fix these ` +
      `before running:\n${problems.join("\n")}`,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // GUARD — first executable line: one explicitly named athlete per run.
  if (!UUID_RE.test(TARGET_ATHLETE_ID)) {
    throw new Error(
      "usage: seed-dev-athlete.ts --athlete <uuid> [--apply]  (dry run unless --apply)",
    );
  }

  // Fail loudly (before touching the DB) if the seeded analytics snapshots no
  // longer match the production shapes the screens read unguarded.
  assertSnapshotShapes(SNAPSHOT_ROWS);

  // Preflight (read-only): the athlete must already exist. We never create or
  // edit the athletes row — get_profile reads the real profile.
  const [athlete] = await db
    .select({ id: athletes.id, full_name: athletes.full_name })
    .from(athletes)
    .where(eq(athletes.id, TARGET_ATHLETE_ID))
    .limit(1);

  if (!athlete) {
    throw new Error(
      `Athlete ${TARGET_ATHLETE_ID} not found. This script seeds dependent ` +
        `rows only; the athletes row must already exist.`,
    );
  }

  if (!APPLY) {
    console.log(
      `DRY RUN — nothing written. Would seed ${TARGET_ATHLETE_ID} (${athlete.full_name}): ` +
        `athletes_current upsert, ${SEED_DEALS.length} seed deals, ${SNAPSHOT_ROWS.length} research snapshots ` +
        `(marker '${SEED_MARKER}'). Re-run with --apply to write.`,
    );
    return;
  }

  await db.transaction(async (tx) => {
    // ── athletes_current: upsert (one row per athlete) ──
    await tx
      .insert(athletesCurrent)
      // The row only (legacy retirement P2-5, 8 Oct 2026): no legacy score, tier, capitals, rate card or follower
      // copies — the score is M.I.A. and followers come from the analytics snapshots seeded below.
      .values({ athlete_id: TARGET_ATHLETE_ID, updated_at: new Date(ANCHOR) })
      .onConflictDoUpdate({ target: athletesCurrent.athlete_id, set: { updated_at: new Date(ANCHOR) } });

    // ── deals: delete seed-marked rows, then insert ──
    await tx
      .delete(deals)
      .where(
        and(
          eq(deals.athlete_id, TARGET_ATHLETE_ID),
          sql`${deals.raw_data}->>'seed' = ${SEED_MARKER}`,
        ),
      );
    await tx.insert(deals).values(
      SEED_DEALS.map((d) => ({
        athlete_id: TARGET_ATHLETE_ID,
        brand_name: d.brand_name,
        deal_type: d.deal_type,
        amount: d.amount,
        status: d.status,
        source: "self_reported" as const,
        detected_at: d.detected_at,
        negotiation_state: d.negotiation_state,
        raw_data: { seed: SEED_MARKER, note: "synthetic dev seed" },
      })),
    );

    // ── social_analytics_snapshots: delete seed-marked rows, then insert ──
    // Scoped to source='research' + the fixed seed days so real connected
    // snapshots (source='connected') are never touched.
    await tx
      .delete(socialAnalyticsSnapshots)
      .where(
        and(
          eq(socialAnalyticsSnapshots.athlete_id, TARGET_ATHLETE_ID),
          eq(socialAnalyticsSnapshots.source, "research"),
          inArray(socialAnalyticsSnapshots.snapshot_day, SNAPSHOT_DAYS),
        ),
      );
    await tx.insert(socialAnalyticsSnapshots).values(SNAPSHOT_ROWS);
  });

  // ── Summary ──
  console.log(
    "✓ Seeded dev athlete",
    TARGET_ATHLETE_ID,
    `(${athlete.full_name})`,
  );
  console.log("  athletes_current : row present (no legacy score or rates)");
  console.log(
    "  deals            : 3 — accepted $1,500 · completed $3,200 · negotiating $5,000",
  );
  console.log(
    "  snapshots        : 6 — IG 11.4k→12.0k (7d +200/30d +600), TT 7.6k→8.0k (7d +150/30d +400)",
  );
  console.log(
    "                     full shape: scalars + demographics + recent_media on latest per platform",
  );
  console.log(
    `  marker           : '${SEED_MARKER}' (re-runnable; email rows untouched)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
