/**
 * agent/research/connected.ts — what the athlete's CONNECTED accounts show, read from the existing ingestion data
 * (social_analytics_snapshots, media_assets, social_audience_distributions; the plumbing stays), turned into:
 *   - a short text summary the research model reads (to confirm identity and handles), and
 *   - MEASURED facts: numbers read straight from the connected account, each with a source ref to the snapshot row;
 *   - PARTNER POSTS (research 1.8.0): her own recent posts that tag or mention an account or carry a partnership hashtag,
 *     with their dates — research confirms those partners first, and merge may cite a post as evidence that a
 *     partnership is current (the first real run kept a current partner, announced only in her own post, as a gap).
 *
 * Measured facts are written by code, never by a model: the number is the account's own. Only connected (OAuth,
 * first-party) rows count as measured; public discovery rows are left to research.
 *
 * The DB read is a dynamic import so the pure parts load without a database (the smoke script, unit tests).
 */
import type { NewFact } from "./store";

export interface ConnectedPost {
  /** media_assets row id (the post's source ref when it has no permalink). Optional for summaries built in tests. */
  id?: string;
  /** The post's own link on the platform, when the connected data has one. */
  permalink?: string | null;
  date: string;
  format: string;
  likes: number | null;
  comments: number | null;
  views: number | null;
  caption: string;
  /** @handles the caption mentions or tags (read from the full caption, before it is shortened). */
  mentions?: string[];
  /** Partnership hashtags in the caption (#ad, #sponsored, #partner, #gifted, #ambassador …). */
  partnerTags?: string[];
}

/**
 * A connected post that names a partner: it tags or mentions an account, or carries a partnership hashtag. The
 * athlete's own public statement, read from their connected account — research is told to confirm these partners
 * first, and merge may cite a post (by its key, p1 …) as evidence for a current partnership.
 */
export interface ConnectedPostEvidence {
  key: string;
  platform: string;
  handle: string | null;
  mediaId: string | null;
  url: string | null;
  date: string;
  caption: string;
  mentions: string[];
  partnerTags: string[];
}

export interface ConnectedChannel {
  platform: string;
  snapshotId: string;
  asOf: string;
  handle: string | null;
  followers: number | null;
  postCount: number | null;
  avgEngagementRate: number | null;
  avgReachPerPost: number | null;
  avgViewsPerPost: number | null;
  postsLast30d: number | null;
  totalLikes: number | null;
  totalChannelViews: number | null;
  audience: Record<string, string[]>;
  recentPosts: ConnectedPost[];
}

const LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
const label = (p: string) => LABEL[p] ?? p;
const fmt = (n: number) => n.toLocaleString("en-US");

const MENTION = /(^|[^\w.@])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g;
/** Hashtags that mark a post as a partnership (platform disclosure tags and their common forms). */
const PARTNER_TAG = /#(ad|ads|sponsored|sponsor|spon|partner|partnership|paidpartnership|paidpartner|gifted|ambassador|brandambassador|collab|collaboration)\b/gi;

/** @handles a caption mentions, in order, de-duplicated (case-insensitively), without the "@". */
export function captionMentions(caption: string): string[] {
  const out: string[] = [];
  for (const m of String(caption ?? "").matchAll(MENTION)) {
    const h = m[2];
    if (!out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h);
  }
  return out;
}

/** Partnership hashtags in a caption, lower-cased, de-duplicated, with the "#". */
export function captionPartnerTags(caption: string): string[] {
  return [...new Set([...String(caption ?? "").matchAll(PARTNER_TAG)].map((m) => `#${m[1].toLowerCase()}`))];
}

/** At most this many partner posts go to research and merge (newest first, across platforms). */
export const MAX_PARTNER_POSTS = 12;
const POST_CAPTION_CHARS = 300;

/**
 * The connected posts that name a partner (a mention or tag, or a partnership hashtag), newest first across the
 * athlete's platforms, each with a key p1, p2 … that merge cites. The athlete's own @handle is not a partner.
 */
export function partnerPosts(channels: ConnectedChannel[], max = MAX_PARTNER_POSTS): ConnectedPostEvidence[] {
  const all: Array<Omit<ConnectedPostEvidence, "key">> = [];
  for (const c of channels) {
    const own = (c.handle ?? "").toLowerCase();
    for (const p of c.recentPosts) {
      const mentions = (p.mentions ?? captionMentions(p.caption)).filter((h) => h.toLowerCase() !== own);
      const partnerTags = p.partnerTags ?? captionPartnerTags(p.caption);
      if (!mentions.length && !partnerTags.length) continue;
      all.push({
        platform: c.platform, handle: c.handle, mediaId: p.id ?? null, url: p.permalink ?? null, date: p.date,
        caption: p.caption.replace(/\s+/g, " ").trim().slice(0, POST_CAPTION_CHARS), mentions, partnerTags,
      });
    }
  }
  return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, max).map((p, i) => ({ key: `p${i + 1}`, ...p }));
}

/** One partner post as research and merge read it: key, platform, date, who it names, the caption. */
export function partnerPostLine(p: ConnectedPostEvidence): string {
  const names = [p.mentions.length ? `mentions ${p.mentions.map((h) => `@${h}`).join(", ")}` : "", p.partnerTags.length ? `tags ${p.partnerTags.join(" ")}` : ""].filter(Boolean).join(" | ");
  return `${p.key} | ${label(p.platform)}${p.handle ? ` (@${p.handle})` : ""} | posted ${p.date} | ${names} | "${p.caption}"${p.url ? ` | <${p.url}>` : ""}`;
}

export const PARTNER_POSTS_HEADING = "POSTS THAT NAME A PARTNER (the athlete's own posts on their connected accounts, newest first)";

/** The text the research model reads. Empty channels → a plain "none connected". */
export function connectedSummaryText(channels: ConnectedChannel[]): string {
  if (!channels.length) return "No accounts connected yet.";
  const out: string[] = [];
  for (const c of channels) {
    out.push(`${label(c.platform)}${c.handle ? ` (@${c.handle})` : ""} — connected account, as of ${c.asOf}`);
    const m: string[] = [];
    if (c.followers != null) m.push(`${c.platform === "youtube" ? "subscribers" : "followers"} ${fmt(c.followers)}`);
    if (c.postCount != null) m.push(`posts ${fmt(c.postCount)}`);
    if (c.avgEngagementRate != null) m.push(`avg engagement rate ${c.avgEngagementRate}%`);
    if (c.avgReachPerPost != null) m.push(`avg reach/post ${fmt(c.avgReachPerPost)}`);
    if (c.avgViewsPerPost != null) m.push(`avg views/post ${fmt(c.avgViewsPerPost)}`);
    if (c.postsLast30d != null) m.push(`posts in last 30 days ${c.postsLast30d}`);
    if (m.length) out.push(`  ${m.join("; ")}`);
    for (const [dim, buckets] of Object.entries(c.audience)) out.push(`  audience ${dim}: ${buckets.join(", ")}`);
    if (c.recentPosts.length) {
      out.push(`  last ${c.recentPosts.length} posts (newest first):`);
      for (const p of c.recentPosts) {
        const bits = [p.date, p.format, p.likes != null ? `likes ${fmt(p.likes)}` : "", p.comments != null ? `comments ${fmt(p.comments)}` : "", p.views != null ? `views ${fmt(p.views)}` : ""].filter(Boolean);
        out.push(`   - ${bits.join(" | ")}${p.caption ? ` | "${p.caption}"` : ""}`);
      }
    }
  }
  // The posts that name a partner, apart (research 1.8.0): the athlete's own public word on who they work with now.
  const partners = partnerPosts(channels);
  if (partners.length) out.push("", PARTNER_POSTS_HEADING, ...partners.map((p) => `  ${partnerPostLine(p)}`));
  return out.join("\n");
}

/** The source ref of a measured fact: the snapshot row, plus which metric (so a newer reading supersedes it). */
export const measuredRef = (snapshotId: string, platform: string, metric: string) => `social_analytics_snapshots/${snapshotId}#${platform}.${metric}`;
/** "instagram.followers" from a measured ref, or null. */
/** The platform key of a cross-platform measured reading ("#all.<metric>"): effective reach, platform breadth. */
export const CROSS_PLATFORM = "all";
export const metricOf = (ref: string | undefined): string | null => (ref && ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : null);

/** Measured facts from connected channels: one per metric the account reports. */
export function measuredFactsFrom(channels: ConnectedChannel[], athleteName: string): NewFact[] {
  const facts: NewFact[] = [];
  for (const c of channels) {
    const where = `${label(c.platform)}${c.handle ? ` (@${c.handle})` : ""}`;
    const add = (metric: string, claim: string) => facts.push({
      subject: { kind: "athlete", name: athleteName }, claim, type: "measured",
      source: { ref: measuredRef(c.snapshotId, c.platform, metric), title: `Connected ${label(c.platform)} account` },
      date: c.asOf, confidence: 1, runId: null,
    });
    if (c.followers != null) add("followers", `${where} has ${fmt(c.followers)} ${c.platform === "youtube" ? "subscribers" : "followers"}.`);
    if (c.avgEngagementRate != null) add("avg_engagement_rate", `${where} posts average a ${c.avgEngagementRate}% engagement rate.`);
    if (c.avgReachPerPost != null) add("avg_reach_per_post", `${where} posts reach ${fmt(c.avgReachPerPost)} accounts on average.`);
    if (c.avgViewsPerPost != null) add("avg_views_per_post", `${where} posts average ${fmt(c.avgViewsPerPost)} views.`);
    if (c.postsLast30d != null) add("posts_last_30d", `${where} published ${c.postsLast30d} posts in the last 30 days.`);
    if (c.totalChannelViews != null) add("total_channel_views", `${where} has ${fmt(c.totalChannelViews)} total channel views.`);
    for (const [dim, buckets] of Object.entries(c.audience)) {
      if (buckets.length) add(`audience_${dim}`, `${where} audience by ${dim}: ${buckets.slice(0, 3).join(", ")}.`);
    }
  }
  return facts;
}

/** Read the athlete's connected channels (latest connected snapshot per platform, recent posts, audience). */
export async function loadConnectedChannels(athleteId: string): Promise<ConnectedChannel[]> {
  const { db } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  const snaps: any[] = (await db.execute(sql`
    SELECT DISTINCT ON (s.platform) s.id, s.platform, s.snapshot_day, s.followers, s.post_count, s.avg_engagement_rate,
           s.avg_reach_per_post, s.avg_views_per_post, s.posts_last_30d, s.total_likes, s.total_channel_views,
           ca.platform_username
      FROM social_analytics_snapshots s
      LEFT JOIN connected_accounts ca ON ca.id = s.connected_account_id
     WHERE s.athlete_id = ${athleteId} AND s.source = 'connected'
     ORDER BY s.platform, s.snapshot_day DESC, s.created_at DESC`) as any).rows ?? [];
  const channels: ConnectedChannel[] = [];
  for (const s of snaps) {
    const posts: any[] = (await db.execute(sql`
      SELECT id, permalink, media_type, posted_at, like_count, comments_count, insights, caption FROM media_assets
       WHERE athlete_id = ${athleteId} AND platform = ${s.platform} AND origin = 'connected' AND media_type <> 'CAROUSEL_CHILD'
         AND deleted_at IS NULL AND posted_at IS NOT NULL
       ORDER BY posted_at DESC LIMIT 12`) as any).rows ?? [];
    const aud: any[] = (await db.execute(sql`
      SELECT DISTINCT ON (dimension, bucket) dimension, bucket, pct FROM social_audience_distributions
       WHERE athlete_id = ${athleteId} AND platform = ${s.platform} AND source_class = 'connected_verified'
       ORDER BY dimension, bucket, observed_at DESC`) as any).rows ?? [];
    const audience: Record<string, string[]> = {};
    for (const dim of [...new Set(aud.map((r) => String(r.dimension)))]) {
      audience[dim] = aud.filter((r) => r.dimension === dim && r.pct != null)
        .sort((a, b) => Number(b.pct) - Number(a.pct)).slice(0, 5).map((r) => `${r.bucket} ${Number(r.pct)}%`);
    }
    const num = (v: unknown) => (v == null ? null : Number(v));
    channels.push({
      platform: s.platform, snapshotId: s.id, asOf: String(s.snapshot_day instanceof Date ? s.snapshot_day.toISOString().slice(0, 10) : s.snapshot_day).slice(0, 10),
      handle: s.platform_username ? String(s.platform_username).replace(/^@/, "") : null,
      followers: num(s.followers), postCount: num(s.post_count), avgEngagementRate: num(s.avg_engagement_rate),
      avgReachPerPost: num(s.avg_reach_per_post), avgViewsPerPost: num(s.avg_views_per_post), postsLast30d: num(s.posts_last_30d),
      totalLikes: num(s.total_likes), totalChannelViews: num(s.total_channel_views), audience,
      recentPosts: posts.map((p) => {
        const full = String(p.caption ?? "").replace(/\s+/g, " ").trim();
        // Mentions and partnership tags come from the FULL caption; a partner post keeps a longer caption (its
        // announcement), every other post the short one.
        const mentions = captionMentions(full);
        const partnerTags = captionPartnerTags(full);
        return {
          id: String(p.id), permalink: p.permalink ? String(p.permalink) : null,
          date: new Date(p.posted_at).toISOString().slice(0, 10), format: String(p.media_type),
          likes: num(p.like_count), comments: num(p.comments_count),
          views: num(p.insights?.views ?? p.insights?.video_views ?? p.insights?.plays),
          caption: full.slice(0, mentions.length || partnerTags.length ? POST_CAPTION_CHARS : 120),
          mentions, partnerTags,
        };
      }),
    });
  }
  return channels;
}
