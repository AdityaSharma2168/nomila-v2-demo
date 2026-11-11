/**
 * marketabilityBeta1SocialBlock.ts — builds the AUTHORITATIVE SOCIAL DATA block the M.I.A. evaluator receives.
 *
 * Production code, because the evaluator service sends this text. It moved out of
 * server/scripts/calibration/blindEval/ for the same reason the evaluator spec did: methodology and the evidence that
 * feeds it belong in production, and the calibration CLI imports FROM here (server/scriptsBoundary.test.ts forbids the
 * reverse). Behaviour is unchanged by the move.
 *
 * Sources, in authority order: (1) an athlete-connected account's stored social features (connected_verified);
 * (2) Instagram Business Discovery / YouTube Data API for a public handle that Nomila's research cited, supplied ONLY
 * when the account identity is highly certain. TikTok and X have no authoritative route and are reported as not
 * available. Nothing is guessed; an unresolved platform is omitted with a note.
 *
 * Every metric here is a FACTUAL RATE Nomila computed — engagement per follower, reach per follower, saves per 1k
 * reach. The 0-100 judgment of what those rates mean stays the evaluator's under the frozen rubric. This file must
 * never map a metric onto a sub-signal score; that is the withdrawn path (ADR-017).
 */

import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { FEATURE_CALCULATION_VERSION } from "./intelligence/social/metrics";
import { athletes, connectedAccounts, researchEvidence, socialFeatures } from "../../shared/schema";
import { type BlindEvalAthlete } from "./marketabilityBeta1EvaluatorSpec";
import {
  IG_FIELDS, getDiscoveryIgAuth, requestInstagramBusinessDiscovery, requestYouTubeChannel, requestYouTubePlaylistItems, requestYouTubeVideos,
  type ProviderCall,
} from "../lib/integrations/discovery";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const num = (v: number) => Math.round(v).toLocaleString("en-US");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

export interface SocialAccountBlock { platform: string; handle: string; source: "connected_verified" | "meta_business_discovery" | "youtube_data_api"; observedAt: string; identityBasis: string; identityConfidence: "HIGH"; metrics: Record<string, string | number>; }
export interface SocialBlockRecord { athlete: BlindEvalAthlete; accounts: SocialAccountBlock[]; unavailable: Array<{ platform: string; reason: string }>; candidates: Array<{ platform: string; handle: string; outcome: string }>; text: string }

export async function athleteRow(a: BlindEvalAthlete) {
  const [row] = await db.select({ id: athletes.id, authId: athletes.auth_id, claimedAt: athletes.claimed_at }).from(athletes)
    .where(and(sql`lower(${athletes.full_name}) = lower(${a.name})`, sql`lower(coalesce(${athletes.sport}, '')) = lower(${a.sport})`)).limit(1);
  return row ?? null;
}

/**
 * THE METRICS THE AUTHORITATIVE BLOCK SUPPLIES from connected social features, in the order the block renders them:
 * which feature (and window) each line reads, its label and how its value is written. One table, two readers: the
 * frozen connected block below (output unchanged) and the new agent's measured memory facts
 * (agent/research/measuredSync.ts), which write every one of these as a measured fact so the M.I.A. preview reads one
 * place without losing any of them. `scope: "account"` lines go on each platform's account; `"cross"` lines are the
 * cross-platform features (platform NULL), which the block puts on its first account.
 */
export type FeatureFormat = "num" | "pct" | "fixed2" | "percent2" | "percent0" | "round";
export interface BlockFeatureMetric { key: string; window: number | null; label: string; format: FeatureFormat; scope: "account" | "cross" }
export const BLOCK_FEATURE_METRICS: readonly BlockFeatureMetric[] = [
  { key: "followers_latest", window: null, label: "followers", format: "num", scope: "account" },
  { key: "followers_growth_pct", window: 30, label: "follower growth (30 days)", format: "percent2", scope: "account" },
  { key: "followers_growth_pct", window: 90, label: "follower growth (90 days)", format: "percent2", scope: "account" },
  ...([
    ["engagement_per_follower_median", "median engagement per follower (30 days)", true], ["reach_per_follower_median", "median reach per follower (30 days)", true],
    ["interactions_per_reach_median", "median interactions per reach (30 days)", true], ["non_follower_reach_share", "non-follower share of reach (30 days)", true],
    ["saves_per_1k_reach_median", "median saves per 1k reach (30 days)", false], ["shares_per_1k_reach_median", "median shares per 1k reach (30 days)", false],
    ["views_per_follower_median", "median views per follower (30 days)", true], ["completion_pct_median", "median video completion (30 days)", true],
    ["avg_view_pct_account", "average percentage of video viewed (30 days, provider-reported)", true], ["story_retention_proxy", "median story retention (30 days, 1 - exits/reach)", true],
    ["story_tap_forward_rate", "median story tap-forward rate (30 days)", true], ["story_reach_per_follower", "median story reach per follower (30 days)", true],
  ] as const).map(([key, label, asPct]) => ({ key, window: 30, label, format: (asPct ? "pct" : "fixed2") as FeatureFormat, scope: "account" as const })),
  { key: "audience_top_country_share", window: null, label: "top audience country share", format: "percent0", scope: "account" },
  { key: "effective_reach_cross_platform", window: null, label: "cross-platform effective reach (30 days, all connected platforms)", format: "num", scope: "cross" },
  { key: "platform_breadth", window: null, label: "platforms with content in the last 30 days", format: "round", scope: "cross" },
];

/** A feature value written exactly as the block writes it. */
export function formatFeature(format: FeatureFormat, v: number): string | number {
  switch (format) {
    case "num": return num(v);
    case "pct": return pct(v);
    case "fixed2": return v.toFixed(2);
    case "percent2": return `${v.toFixed(2)}%`;
    case "percent0": return `${v.toFixed(0)}%`;
    case "round": return String(Math.round(v));
  }
}

/** Connected-account features on dev (Mia): the latest as-of per platform, the substrate's own windows. */
export async function connectedBlock(athleteId: string): Promise<SocialAccountBlock[]> {
  const conns = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username }).from(connectedAccounts).where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  const handles = new Map(conns.filter((c) => ["instagram", "tiktok", "youtube", "x"].includes(c.platform)).map((c) => [c.platform, c.username ?? ""]));
  if (!handles.size) return [];
  // PINNED TO ONE CALCULATION VERSION. Without this the block serves whatever rows happen to exist, mixing versions:
  // suppressing a feature in a new version does not delete the row an older version already wrote, so a metric the
  // current definition deliberately refuses to emit would keep rendering from a stale row. That is not hypothetical —
  // v3 stopped emitting avg_view_pct_account for a channel with no views, and the v2 row went on telling the
  // evaluator "0.00% of video viewed" until this filter was added. It also makes calculation_version able to answer
  // the question it exists for: why did the same evidence produce a different block before and after a given date?
  const rows = await db.select().from(socialFeatures).where(and(
    eq(socialFeatures.athlete_id, athleteId),
    eq(socialFeatures.source_class, "connected_verified"),
    eq(socialFeatures.calculation_version, FEATURE_CALCULATION_VERSION),
  ));
  const latest = rows.reduce((m, r) => (m == null || r.as_of > m ? r.as_of : m), null as Date | null);
  if (!latest) return [];
  const fresh = rows.filter((r) => r.as_of.toISOString().slice(0, 10) === latest.toISOString().slice(0, 10));
  const out: SocialAccountBlock[] = [];
  const valueOf = (pool: typeof fresh, m: BlockFeatureMetric) => { const r = pool.find((x) => x.feature_key === m.key && (m.window == null || x.window_days === m.window)); return r?.value == null ? null : Number(r.value); };
  for (const [platform, handle] of handles) {
    const mine = fresh.filter((r) => r.platform === platform);
    if (!mine.length) continue;
    const metrics: Record<string, string | number> = {};
    for (const m of BLOCK_FEATURE_METRICS) {
      if (m.scope !== "account") continue;
      const v = valueOf(mine, m); if (v != null) metrics[m.label] = formatFeature(m.format, v);
    }
    out.push({ platform, handle, source: "connected_verified", observedAt: latest.toISOString().slice(0, 10), identityBasis: "athlete-connected account (OAuth), Nomila social substrate", identityConfidence: "HIGH", metrics });
  }
  // Cross-platform features (effective reach; platform_breadth — computed by the substrate and never surfaced before,
  // so audience_scale.platform_breadth had no measured path to the evaluator) go on the first account.
  for (const m of BLOCK_FEATURE_METRICS) {
    if (m.scope !== "cross") continue;
    const r = fresh.find((x) => x.feature_key === m.key);
    if (r?.value != null && out.length) out[0].metrics[m.label] = formatFeature(m.format, Number(r.value));
  }
  return out;
}

/** Public handles that Nomila's research cited for the athlete (research_evidence social_handle rows, not superseded). */
export async function citedHandles(athleteId: string): Promise<Array<{ platform: string; handle: string; url: string | null }>> {
  const rows = await db.select({ claim: researchEvidence.claim, lineage: researchEvidence.lineage_status }).from(researchEvidence)
    .where(and(eq(researchEvidence.athlete_id, athleteId), eq(researchEvidence.kind, "social_handle"), eq(researchEvidence.suspect, false), isNull(researchEvidence.superseded_by), inArray(researchEvidence.lineage_status, ["cited", "native_supported", "native_retrieved", "asserted_only"])));
  const out: Array<{ platform: string; handle: string; url: string | null }> = [];
  for (const r of rows) {
    const c = r.claim as Record<string, unknown>;
    const platform = String(c.platform ?? "").toLowerCase().replace(/\s*\(twitter\)/, "");
    const url = typeof c.url === "string" ? c.url : null;
    let handle = typeof c.handle === "string" ? c.handle.replace(/^@/, "").trim() : "";
    if ((!handle || /\s/.test(handle)) && url) { const m = /(?:instagram\.com|youtube\.com|tiktok\.com|x\.com|twitter\.com)\/@?([A-Za-z0-9._-]+)/.exec(url); if (m) handle = m[1]; }
    if (!handle || /\s/.test(handle)) continue;
    if (["instagram", "youtube", "tiktok", "x"].includes(platform)) out.push({ platform, handle, url });
  }
  return out;
}

const nameMatches = (profileName: string | null | undefined, athlete: string) => { const p = (profileName ?? "").toLowerCase(); const parts = athlete.toLowerCase().split(/\s+/); return parts.length ? parts.every((w) => p.includes(w)) : false; };

/**
 * Platform lookups for the experiment, on the one discovery client (lib/integrations/discovery.ts). They request the
 * `identity` field set because the identity check below needs the profile name. The mapping and failure policy are the
 * pre-consolidation ones, unchanged, so the block — and the evaluator digest — is byte-identical for the same responses
 * (discovery.parity.test.ts): a transport failure on the profile/channel call throws, an error body becomes a candidate
 * outcome, and any failure fetching recent uploads leaves them empty.
 */
const bodyOrThrow = (call: ProviderCall): any => { if (call.kind === "response") return call.body; throw call.cause; };
async function igDiscovery(handle: string): Promise<{ ok: true; username: string; name: string | null; followers: number | null; media: number | null; posts: Array<{ likes: number | null; comments: number | null; at: string | null; type: string | null }> } | { ok: false; error: string }> {
  const auth = await getDiscoveryIgAuth();
  if (!auth) return { ok: false, error: "no_token" };
  const call = await requestInstagramBusinessDiscovery(handle, { auth, fields: IG_FIELDS.identity });
  if (call.kind === "network") throw call.cause;
  if (call.kind !== "response" || !call.httpOk || !call.businessDiscovery) {
    const j: any = call.kind === "response" ? call.body : {};
    return { ok: false, error: String(j?.error?.message ?? call.status).slice(0, 120) };
  }
  const bd = call.businessDiscovery;
  const posts: any[] = bd.media?.data ?? [];
  return { ok: true, username: bd.username ?? handle, name: call.name, followers: bd.followers_count ?? null, media: bd.media_count ?? null, posts: posts.map((m) => ({ likes: typeof m.like_count === "number" ? m.like_count : null, comments: typeof m.comments_count === "number" ? m.comments_count : null, at: m.timestamp ?? null, type: m.media_type ?? null })) };
}
async function ytDiscovery(handle: string): Promise<{ ok: true; title: string | null; subscribers: number | null; views: number | null; videos: number | null; recent: Array<{ views: number | null; likes: number | null; comments: number | null; at: string | null }> } | { ok: false; error: string }> {
  const key = process.env.YOUTUBE_DATA_API_KEY;
  if (!key) return { ok: false, error: "not_configured" };
  const call = await requestYouTubeChannel(handle.replace(/^@/, ""), { key, part: "snippet,statistics,contentDetails", lookup: "handle" });
  if (call.kind === "network") throw call.cause;
  if (call.kind !== "response" || !call.httpOk || !call.channel) {
    const j: any = call.kind === "response" ? call.body : {};
    return { ok: false, error: String(j?.error?.message ?? (call.httpOk ? "not_found" : call.status)).slice(0, 120) };
  }
  const ch = call.channel;
  const st = ch.statistics ?? {};
  // public interaction metrics of the most recent uploads (uploads playlist → video statistics)
  let recent: Array<{ views: number | null; likes: number | null; comments: number | null; at: string | null }> = [];
  try {
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      const pl: any = bodyOrThrow(await requestYouTubePlaylistItems(uploads, { key, part: "contentDetails", maxResults: 10 }));
      const ids = (pl?.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
      if (ids.length) {
        const vs: any = bodyOrThrow(await requestYouTubeVideos(ids, { key, part: "statistics,snippet" }));
        recent = (vs?.items ?? []).map((v: any) => ({ views: Number(v.statistics?.viewCount ?? NaN) || null, likes: Number(v.statistics?.likeCount ?? NaN) || null, comments: Number(v.statistics?.commentCount ?? NaN) || null, at: v.snippet?.publishedAt ?? null }));
      }
    }
  } catch { recent = []; }
  return { ok: true, title: ch.snippet?.title ?? null, subscribers: call.subscribers || null, views: Number(st.viewCount ?? NaN) || null, videos: Number(st.videoCount ?? NaN) || null, recent };
}

export async function discoveryBlock(a: BlindEvalAthlete, handles: Array<{ platform: string; handle: string }>, record: SocialBlockRecord): Promise<SocialAccountBlock[]> {
  const out: SocialAccountBlock[] = [];
  const seen = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);
  for (const h of handles) {
    const key = `${h.platform}:${h.handle.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key);
    if (out.some((x) => x.platform === h.platform)) { record.candidates.push({ platform: h.platform, handle: h.handle, outcome: "skipped: platform already resolved" }); continue; }
    if (h.platform === "instagram") {
      const r = await igDiscovery(h.handle);
      if (!r.ok) { record.candidates.push({ platform: "instagram", handle: h.handle, outcome: `discovery: ${r.error}` }); continue; }
      const certain = nameMatches(r.name, a.name);
      record.candidates.push({ platform: "instagram", handle: h.handle, outcome: certain ? `resolved (profile name "${r.name}" matches)` : `NOT supplied: identity not certain (profile name "${r.name ?? "?"}")` });
      if (!certain) continue;
      const metrics: Record<string, string | number> = {};
      if (r.followers != null) metrics.followers = num(r.followers);
      if (r.media != null) metrics["posts (media count)"] = num(r.media);
      const likes = r.posts.map((x) => x.likes).filter((v): v is number => v != null), comments = r.posts.map((x) => x.comments).filter((v): v is number => v != null);
      if (likes.length) { metrics[`median likes per post (last ${likes.length} public posts)`] = num(median(likes)); if (r.followers) metrics["median likes per post as % of followers"] = pct(median(likes) / r.followers); }
      if (comments.length) metrics[`median comments per post (last ${comments.length} public posts)`] = num(median(comments));
      const dates = r.posts.map((x) => x.at).filter((v): v is string => !!v).map((d) => new Date(d).getTime()).filter((t) => Number.isFinite(t));
      if (dates.length >= 2) { const span = (Math.max(...dates) - Math.min(...dates)) / 86_400_000; if (span > 0) metrics["public posting cadence"] = `${((dates.length - 1) / span * 7).toFixed(1)} posts/week over the last ${dates.length} posts`; }
      out.push({ platform: "instagram", handle: r.username, source: "meta_business_discovery", observedAt: today, identityBasis: `handle cited by Nomila research; Instagram profile name "${r.name}" matches the athlete`, identityConfidence: "HIGH", metrics });
    } else if (h.platform === "youtube") {
      const r = await ytDiscovery(h.handle);
      if (!r.ok) { record.candidates.push({ platform: "youtube", handle: h.handle, outcome: `discovery: ${r.error}` }); continue; }
      const certain = nameMatches(r.title, a.name) || nameMatches(r.title, a.name.split(" ").slice(-1)[0]);
      record.candidates.push({ platform: "youtube", handle: h.handle, outcome: certain ? `resolved (channel "${r.title}")` : `NOT supplied: identity not certain (channel "${r.title ?? "?"}")` });
      if (!certain) continue;
      const metrics: Record<string, string | number> = {};
      if (r.subscribers != null) metrics.subscribers = num(r.subscribers);
      if (r.views != null) metrics["total channel views"] = num(r.views);
      if (r.videos != null) metrics.videos = num(r.videos);
      const rv = r.recent.map((x) => x.views).filter((v): v is number => v != null), rl = r.recent.map((x) => x.likes).filter((v): v is number => v != null), rc = r.recent.map((x) => x.comments).filter((v): v is number => v != null);
      if (rv.length) { metrics[`median views per video (last ${rv.length} uploads)`] = num(median(rv)); if (r.subscribers) metrics["median views per video as % of subscribers"] = pct(median(rv) / r.subscribers); }
      if (rl.length) metrics[`median likes per video (last ${rl.length} uploads)`] = num(median(rl));
      if (rc.length) metrics[`median comments per video (last ${rc.length} uploads)`] = num(median(rc));
      const dates = r.recent.map((x) => x.at).filter((v): v is string => !!v).map((d) => new Date(d).getTime()).filter((t) => Number.isFinite(t));
      if (dates.length >= 2) { const span = (Math.max(...dates) - Math.min(...dates)) / 86_400_000; if (span > 0) metrics["upload cadence"] = `${((dates.length - 1) / span * 30).toFixed(1)} uploads/month over the last ${dates.length} uploads`; }
      out.push({ platform: "youtube", handle: h.handle.replace(/^@/, ""), source: "youtube_data_api", observedAt: today, identityBasis: `handle cited by Nomila research; YouTube channel title "${r.title}" matches the athlete`, identityConfidence: "HIGH", metrics });
    } else {
      record.candidates.push({ platform: h.platform, handle: h.handle, outcome: "no authoritative route (TikTok/X): not supplied" });
    }
  }
  return out;
}

/**
 * One leading "@", whatever the platform stored.
 *
 * YouTube stores handles WITH the sigil ("@athletehandle2514"); Instagram and TikTok without it ("athletehandle"). Rendering
 * "@" unconditionally produced "@@athletehandle2514" in the block — cosmetic elsewhere, but this sits in the identity line
 * of a document whose rubric asks the evaluator to judge identity confidence, so a malformed handle is evidence
 * pointing the wrong way.
 */
const handle = (h: string): string => h.replace(/^@+/, "");

export function renderBlock(rec: SocialBlockRecord): string {
  if (!rec.accounts.length) return "";
  const lines = ["AUTHORITATIVE SOCIAL DATA", "", "Measured platform facts supplied by Nomila. Each account states its source, observation date and identity-resolution basis/confidence. Treat these as authoritative; do not replace them with web estimates."];
  for (const acc of rec.accounts) lines.push(`- ${acc.platform} @${handle(acc.handle)} — source: ${acc.source.replace(/_/g, " ")}; observed ${acc.observedAt}; identity: ${acc.identityBasis} (${acc.identityConfidence}). ${Object.entries(acc.metrics).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  for (const u of rec.unavailable) lines.push(`- ${u.platform}: not available (${u.reason})`);
  return lines.join("\n");
}
