/**
 * Instagram direct integration — Instagram API with Instagram Login (graph.instagram.com).
 * Uses "API setup with Instagram business login" product in the Meta developer console.
 *
 * OAuth flow (all Instagram-hosted, no Facebook): www.instagram.com/oauth/authorize →
 * code → short-lived IG user token (api.instagram.com, 1h) → long-lived IG user token
 * (graph.instagram.com, 60d, refreshable via ig_refresh_token).
 *
 * The token IS the Instagram professional account — there is NO Facebook Page, NO
 * /me/accounts hop, and NO Page token. Everything (profile, insights, media, DMs, webhook
 * subscribe) is done on the IG user node (/me or /{ig-user-id}) with the IG USER token.
 * connected_accounts.access_token holds the IG user token; ig_page_id is unused (null).
 *
 * Requires a professional (Business/Creator) Instagram account. Serving accounts the app
 * doesn't own needs Advanced Access (Meta App Review) + Business Verification; Dev Mode +
 * enrolled Instagram Testers works without review.
 *
 * Config: INSTAGRAM_LOGIN_APP_ID / INSTAGRAM_LOGIN_APP_SECRET are the *Instagram* app
 * credentials (distinct from the Facebook App ID). Until they're set, connect throws a
 * clear "not configured" error and everything else is inert.
 */

import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import type { SocialAnalyticsRaw } from "../../../shared/schema";
import type { InstagramNative, IgMediaNode, InstagramStoriesNative, IgStoryNode, IgStoryInsightsNative, IgStoryCallError } from "../../services/intelligence/social/native";
import { classifyMetaError } from "./metaErrors";
import { createStoryMetricCache, readStoryInsights, type InsightCall } from "./instagramStoryInsights";
import { eq } from "drizzle-orm";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";
import { signOAuthState } from "../oauthState";
import type { SnapshotSocialPlatform } from "../../services/snapshotSocial";
import type { ActivatedConnection, SocialAnalyticsResult } from "./types";
import { openTokenFields, sealTokenFields } from "../tokenCrypto";
import { activateConnection } from "./activateConnection";

const logger = createLogger("integrations/instagram");

const APP_ID     = process.env.INSTAGRAM_LOGIN_APP_ID?.trim();      // Instagram App ID (NOT the Facebook App ID)
const APP_SECRET = process.env.INSTAGRAM_LOGIN_APP_SECRET?.trim();  // Instagram App Secret
const GV         = "v22.0";
const GRAPH      = `https://graph.instagram.com/${GV}`;   // profile / insights / media / DMs / webhook subscribe
const IG_HOST    = "https://graph.instagram.com";         // unversioned host for token exchange + refresh
// api.instagram.com, not www: on an iPhone with the Instagram app installed, a tap that navigates to www.instagram.com is
// a universal link — iOS hands it to the Instagram app, which cannot run the consent step ("Something went wrong", prod
// 24 Oct 2026). api.instagram.com publishes no app-site association, so Safari loads it and Instagram's own 302 lands on
// the www consent page inside the browser (redirects do not re-trigger universal links).
const OAUTH_AUTHORIZE = "https://api.instagram.com/oauth/authorize";
const OAUTH_TOKEN     = "https://api.instagram.com/oauth/access_token"; // code → short-lived token
const API_BASE   = apiBaseUrl();
const REDIRECT   = `${API_BASE}/api/v1/auth/callback/instagram`;

const BASE_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
  "instagram_business_manage_messages",
];

// PR 20 (docs/probes/ship.md item 5, ADI-S20-GO): Studio's "Post to Instagram" needs this permission on the athlete's
// connection (studio/publish/eligibility.ts PUBLISH_SCOPE). It is requested only while IG_REQUEST_PUBLISH_SCOPE is
// exactly "true" — on in the dev config, never in prod until Meta's App Review for it is approved — so with the variable
// unset every consent screen and every stored `scopes` fallback is byte-for-byte what it was. Not a STUDIO_* flag: the
// Studio master (studio/studioFlag.ts) never reaches it. Read at call time, so a test can set it between calls.
// ⚠️ MUTATION (instagramScopes.test.ts): read it as `!== "false"` — "unset: exactly the three scopes it always asked" reds.
const PUBLISH_SCOPE = "instagram_business_content_publish";
export function requestedScopes(): string {
  return [
    ...BASE_SCOPES,
    ...(process.env.IG_REQUEST_PUBLISH_SCOPE === "true" ? [PUBLISH_SCOPE] : []),
  ].join(",");
}

async function graphGet<T>(url: string): Promise<T> {
  const res  = await fetch(url);
  const json = await res.json() as any;
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Graph API ${res.status}`);
  return json as T;
}

// Subscribe the connected Instagram account to our app's webhook `messages` field, so DMs
// are delivered in real time. Under Instagram Login this is done on the IG user node (/me)
// with the IG USER token — no Facebook Page. Non-fatal: logged but not thrown, so a missing
// scope (e.g. before App Review) doesn't block the connection — backfill/polling still works.
async function subscribeToMessages(token: string): Promise<void> {
  const url = new URL(`${GRAPH}/me/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "messages");
  url.searchParams.set("access_token",      token);
  const res  = await fetch(url.toString(), { method: "POST" });
  const json = await res.json() as any;
  if (!res.ok || json.error || json.success === false) {
    throw new Error(json.error?.message ?? `subscribed_apps failed: ${res.status}`);
  }
}

// The OAuth provider contract (connections.ts) calls
// getAuthUrl(athleteId, alias, loginHint, clientPlatform) positionally. IG doesn't use
// alias/loginHint (one IG account per athlete, no account-picker hint) — but we MUST
// accept them so clientPlatform lands in the right slot and gets encoded into the signed
// state. Without it the web flow was never marked web: the callback fell back to the
// native deep-link page (co.nomila.app://) which does nothing in a mobile browser, so a
// web connect never returned to the app. Matches gmail.getAuthUrl.
export function getAuthUrl(athleteId: string, _alias?: string, _loginHint?: string, clientPlatform?: string): string {
  if (!APP_ID) throw new Error("Instagram Login not configured (INSTAGRAM_LOGIN_APP_ID not set)");
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set("client_id",     APP_ID);
  url.searchParams.set("redirect_uri",  REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         requestedScopes());
  url.searchParams.set("state",         signOAuthState(athleteId, undefined, clientPlatform));
  return url.toString();
}

export async function handleCallback(code: string, athleteId: string): Promise<ActivatedConnection> {
  if (!APP_ID || !APP_SECRET) throw new Error("Instagram Login credentials not configured");

  // 1. Exchange the code for a short-lived IG user token (1 hour). This endpoint is
  // form-encoded and returns a NON-standard error shape ({error_type, error_message}),
  // so we don't route it through graphGet.
  const shortRes = await fetch(OAUTH_TOKEN, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     APP_ID,
      client_secret: APP_SECRET,
      grant_type:    "authorization_code",
      redirect_uri:  REDIRECT,
      code,
    }).toString(),
  });
  const shortJson = await shortRes.json() as any;
  if (!shortRes.ok || shortJson.error_type || shortJson.error || !shortJson.access_token) {
    throw new Error(shortJson.error_message ?? shortJson.error?.message ?? `Instagram token exchange failed: ${shortRes.status}`);
  }
  const shortToken = shortJson.access_token as string;
  // Scopes the user actually granted (the response returns them as `permissions`).
  const granted: string[] = Array.isArray(shortJson.permissions)
    ? shortJson.permissions
    : typeof shortJson.permissions === "string"
      ? shortJson.permissions.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

  // 2. Exchange short-lived → long-lived IG user token (60 days). Unversioned host.
  const longUrl = new URL(`${IG_HOST}/access_token`);
  longUrl.searchParams.set("grant_type",    "ig_exchange_token");
  longUrl.searchParams.set("client_secret", APP_SECRET);
  longUrl.searchParams.set("access_token",  shortToken);
  const long = await graphGet<{ access_token: string; expires_in?: number }>(longUrl.toString());
  const token     = long.access_token;
  const expiresAt = typeof long.expires_in === "number"
    ? new Date(Date.now() + long.expires_in * 1000)
    : new Date(Date.now() + 60 * 864e5);

  // 3. Identify the account. Under Instagram Login the token IS the account — /me returns
  // the IG professional account directly, no /me/accounts Page hop.
  const meUrl = new URL(`${GRAPH}/me`);
  meUrl.searchParams.set("fields",       "user_id,username,account_type");
  meUrl.searchParams.set("access_token", token);
  const me = await graphGet<{ user_id?: string; id?: string; username?: string; account_type?: string }>(meUrl.toString());
  const igUserId = String(me.user_id ?? me.id ?? "");
  if (!igUserId) throw new Error("Could not resolve Instagram account id from token");

  // Nomila's shared discovery IG account (DISCOVERY_IG_BUSINESS_ID) is the app's own lens for
  // Business Discovery — it must never be stored as an athlete's personal connection (it would then
  // be ingested as that athlete's analytics and displace their real account). Reject it explicitly.
  if (process.env.DISCOVERY_IG_BUSINESS_ID && igUserId === process.env.DISCOVERY_IG_BUSINESS_ID) {
    throw new Error("That's Nomila's shared Instagram account — connect the athlete's own Instagram instead.");
  }

  // Instagram Login requires a professional (Business/Creator) account. A personal account
  // can authenticate but exposes no insights/messaging — reject it with a clear next step.
  if (me.account_type && me.account_type.toUpperCase() === "PERSONAL") {
    throw new Error("This Instagram account is personal. Switch it to a Business or Creator account (Instagram app → Settings → Account type), then reconnect.");
  }

  const activated = await activateConnection({
    athleteId,
    platform:         "instagram",
    platformUserId:   igUserId,
    platformUsername: me.username ?? null,
    accessToken:      token,
    refreshToken:     null,
    tokenExpiresAt:   expiresAt,          // 60-day IG user token; refreshTokenIfNeeded renews it
    scopes:           granted.length ? granted.join(",") : requestedScopes(),
    extra:            { ig_page_id: null },   // no Facebook Page under Instagram Login
  });

  // Subscribe the IG account to our messaging webhook (real-time DMs). Non-fatal.
  await subscribeToMessages(token).catch((err: any) =>
    logger.warn({ athleteId, igUserId, error: err.message }, "Instagram webhook subscribe failed — falling back to backfill/polling"),
  );

  logger.info({ athleteId, igUserId, connectionId: activated.connectionId, reactivated: activated.reactivated }, "Instagram connected (Instagram Login)");
  return activated;
}

export async function refreshTokenIfNeeded(connectionId: string): Promise<void> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token || !row.token_expires_at) return;

  const daysLeft = (row.token_expires_at.getTime() - Date.now()) / 864e5;
  if (daysLeft > 7) return;

  const url = new URL(`${IG_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type",   "ig_refresh_token");
  url.searchParams.set("access_token", row.access_token);
  const res = await graphGet<{ access_token: string; expires_in?: number }>(url.toString());

  await db.update(connectedAccounts).set(await sealTokenFields({
    access_token:     res.access_token,
    token_expires_at: typeof res.expires_in === "number"
      ? new Date(Date.now() + res.expires_in * 1000)
      : row.token_expires_at,
  })).where(eq(connectedAccounts.id, connectionId));

  logger.info({ connectionId }, "Instagram token refreshed");
}

export async function fetchForScoring(connectionId: string): Promise<{
  platform: SnapshotSocialPlatform;
  toolsCalled: string[];
} | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token || !row.platform_user_id) return null;

  const token    = row.access_token;
  const igUserId = row.platform_user_id;
  const toolsCalled: string[] = [];

  // Profile
  // NOTE: `is_verified` is NOT a valid field on the IG user node in v22 (#100) —
  // requesting it makes the whole call throw. Same fix as fetchAnalytics() below.
  const profileUrl = new URL(`${GRAPH}/${igUserId}`);
  profileUrl.searchParams.set("fields",       "id,username,followers_count");
  profileUrl.searchParams.set("access_token", token);
  const profile = await graphGet<{
    id: string; username?: string; followers_count?: number;
  }>(profileUrl.toString());
  toolsCalled.push("instagram_graph_profile");

  const followers = profile.followers_count ?? 0;
  const handle    = profile.username ? `@${profile.username}` : undefined;
  const verified  = false;  // not exposed on IG user node in v22

  if (!followers) {
    return { toolsCalled, platform: { handle, followers: 0, verified, fetched_at: new Date().toISOString(), source: "connected" } };
  }

  // Recent media (last 20, last 30 days)
  const since    = Math.floor((Date.now() - 30 * 864e5) / 1000);
  const mediaUrl = new URL(`${GRAPH}/${igUserId}/media`);
  mediaUrl.searchParams.set("fields",       "id,timestamp,like_count,comments_count");
  mediaUrl.searchParams.set("limit",        "20");
  mediaUrl.searchParams.set("since",        String(since));
  mediaUrl.searchParams.set("access_token", token);

  let posts: Array<{ id: string; timestamp?: string; like_count?: number; comments_count?: number }> = [];
  try {
    const mediaRes = await graphGet<{ data?: typeof posts }>(mediaUrl.toString());
    posts = mediaRes.data ?? [];
    toolsCalled.push("instagram_graph_media");
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message?.slice(0, 80) }, "Instagram media fetch failed — using profile only");
    return { toolsCalled, platform: { handle, followers, verified, fetched_at: new Date().toISOString(), source: "connected" } };
  }

  const cutoff = Date.now() - 30 * 864e5;
  let postsLast30d = 0, totalLikes = 0, totalComments = 0;
  for (const p of posts) {
    if (p.timestamp && new Date(p.timestamp).getTime() > cutoff) postsLast30d++;
    totalLikes    += p.like_count     ?? 0;
    totalComments += p.comments_count ?? 0;
  }

  const count       = posts.length;
  const avgLikes    = count > 0 ? Math.round(totalLikes    / count) : 0;
  const avgComments = count > 0 ? Math.round(totalComments / count) : 0;
  const engRate     = followers > 0 && count > 0
    ? Math.round(((avgLikes + avgComments) / followers) * 10_000) / 100
    : 0;

  // Account insights (optional)
  try {
    const insUrl = new URL(`${GRAPH}/${igUserId}/insights`);
    insUrl.searchParams.set("metric",       "reach,views,profile_links_taps");
    insUrl.searchParams.set("metric_type",  "total_value");
    insUrl.searchParams.set("period",       "day");
    insUrl.searchParams.set("access_token", token);
    await graphGet(insUrl.toString());
    toolsCalled.push("instagram_graph_insights");
  } catch {
    // Not all account types have insights access
  }

  return {
    toolsCalled,
    platform: {
      handle,
      followers,
      verified,
      engagement_rate: engRate,
      avg_likes:       avgLikes,
      avg_comments:    avgComments,
      posts_last_30d:  postsLast30d,
      fetched_at:      new Date().toISOString(),
      source:          "connected",
    },
  };
}

// ─── Analytics (snapshot pipeline) ─────────────────────────────────────────────
// Distinct from fetchForScoring: this captures the rich, display-oriented metrics
// (account insights, per-post insights, audience demographics) for one
// social_analytics_snapshots row. Every external call is best-effort — a failure
// degrades the affected fields to null and never throws, so a missing scope or a
// non-Business account still yields a usable (if sparse) snapshot.

// Instagram-Login account-insight metrics. `impressions`/`profile_views` don't exist under
// Instagram Login: `views` is impressions' successor (captured into the snapshot's
// `impressions` column) and `profile_links_taps` stands in for the old `profile_views`
// (stored in the `profile_views` column, surfaced in the UI as "Profile Link Taps"). All
// resolve under metric_type=total_value, period=day.
const IG_ACCOUNT_METRICS = "reach,views,profile_links_taps";
// Per-post metrics valid for ALL media types (image/video/reel/carousel). Field
// expansion applies one metric list to every item, so type-specific metrics
// (views, watch_time) can't go here without erroring on image posts — those are a
// future per-type enhancement. saved/shares/reach/total_interactions are universal.
const IG_MEDIA_METRICS = "reach,saved,shares,total_interactions";

/** Pull a numeric value out of an insights `data[]` entry (handles total_value and time-series shapes). */
function igMetricValue(data: any[] | undefined, name: string): number | null {
  const m = data?.find((d) => d?.name === name);
  if (!m) return null;
  if (typeof m.total_value?.value === "number") return m.total_value.value;
  const vals = m.values;
  if (Array.isArray(vals) && vals.length) {
    const v = vals[vals.length - 1]?.value;          // latest data point
    if (typeof v === "number") return v;
  }
  return null;
}

type IgBreakdownRow = { key: string; value: number; pct: number };
/** Parse one follower_demographics breakdown call into sorted {key,value,pct} rows. */
function igDemographicRows(data: any[] | undefined): IgBreakdownRow[] {
  const breakdowns = data?.[0]?.total_value?.breakdowns;
  const results: any[] = breakdowns?.[0]?.results ?? [];
  const total = results.reduce((s, r) => s + (r?.value ?? 0), 0);
  return results
    .map((r) => ({
      key:   r?.dimension_values?.[0] ?? "unknown",
      value: r?.value ?? 0,
      pct:   total > 0 ? Math.round(((r?.value ?? 0) / total) * 100) : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

async function igFollowerDemographic(igUserId: string, token: string, breakdown: string): Promise<IgBreakdownRow[]> {
  const url = new URL(`${GRAPH}/${igUserId}/insights`);
  url.searchParams.set("metric",      "follower_demographics");
  url.searchParams.set("period",      "lifetime");
  url.searchParams.set("metric_type", "total_value");
  url.searchParams.set("timeframe",   "last_30_days");
  url.searchParams.set("breakdown",   breakdown);
  url.searchParams.set("access_token", token);
  const res = await graphGet<{ data?: any[] }>(url.toString());
  return igDemographicRows(res.data);
}

// ─── Native fetch + display projection (Phase A Step 1a) ─────────────────────
// The HTTP calls below are the ones fetchAnalytics has always made, in the same order. They now
// return the provider's responses as a native envelope (server/services/intelligence/social/native.ts)
// and `projectInstagramDisplay` turns that envelope into the SocialAnalyticsResult the daily row
// and the Growth tab read — the same arithmetic as before, moved out of the fetch. fetchAnalytics
// is the composition of the two, so its output is unchanged. The envelope is what the substrate
// sanitizes, stores and adapts when SOCIAL_SUBSTRATE_WRITE is on.

/**
 * The connected account's handle and public counts, one Graph call (the anti-fake "real athlete?" re-check reads
 * media_count: a real account with posts). Null when the connection has no token or the call fails.
 */
export async function fetchInstagramProfileCounts(connectionId: string): Promise<{ username: string | null; mediaCount: number | null; followers: number | null } | null> {
  try {
    const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
    if (!row?.access_token || !row.platform_user_id) return null;
    const url = new URL(`${GRAPH}/${row.platform_user_id}`);
    url.searchParams.set("fields", "id,username,followers_count,media_count");
    url.searchParams.set("access_token", row.access_token);
    const p = await graphGet<{ username?: string; followers_count?: number; media_count?: number }>(url.toString());
    return { username: p?.username ?? null, mediaCount: typeof p?.media_count === "number" ? p.media_count : null, followers: typeof p?.followers_count === "number" ? p.followers_count : null };
  } catch {
    return null;
  }
}

export async function fetchInstagramNative(connectionId: string): Promise<InstagramNative | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token || !row.platform_user_id) return null;

  const token    = row.access_token;
  const igUserId = row.platform_user_id;
  const toolsCalled: string[] = [];
  const errors: InstagramNative["errors"] = [];

  // ── Profile ──────────────────────────────────────────────────────────────
  // NOTE: `is_verified` is NOT a valid field on the IG user node in v22 (#100) —
  // do not add it back. Verification status isn't reliably exposed here.
  const profileUrl = new URL(`${GRAPH}/${igUserId}`);
  profileUrl.searchParams.set("fields",       "id,username,followers_count,follows_count,media_count");
  profileUrl.searchParams.set("access_token", token);
  const profile = await graphGet<InstagramNative["profile"]>(profileUrl.toString());
  toolsCalled.push("instagram_graph_profile");

  // ── Account insights (best-effort) ───────────────────────────────────────
  let accountInsights: InstagramNative["accountInsights"] = null;
  try {
    const insUrl = new URL(`${GRAPH}/${igUserId}/insights`);
    insUrl.searchParams.set("metric",       IG_ACCOUNT_METRICS);
    insUrl.searchParams.set("metric_type",  "total_value");
    insUrl.searchParams.set("period",       "day");
    insUrl.searchParams.set("access_token", token);
    accountInsights = await graphGet<{ data?: any[] }>(insUrl.toString());
    toolsCalled.push("instagram_graph_insights");
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message?.slice(0, 100) }, "IG account insights unavailable");
    errors.push({ step: "account_insights", message: String(err.message ?? err).slice(0, 200) });
  }

  // ── Recent media + per-post insights via field expansion (best-effort) ───
  // Fetch the most recent posts REGARDLESS of age (bounded by limit) — NOT gated to the last 30 days.
  // A 30-day `since` returned nothing for creators who post infrequently, nulling engagement + every
  // per-post metric even when they have plenty of history. postsLast30d/cadence below still window by date.
  let media: IgMediaNode[] = [];
  let mediaFetchMode: InstagramNative["mediaFetchMode"] = "failed";
  const fetchMedia = async (withInsights: boolean): Promise<IgMediaNode[]> => {
    // children{} expands carousel items (verified live) — a field, not a metric, so it won't trip the metric-expansion failure.
    const base = "id,permalink,media_type,media_product_type,caption,timestamp,media_url,thumbnail_url,like_count,comments_count,is_shared_to_feed,children{id,media_type,media_url,thumbnail_url}";
    const url  = new URL(`${GRAPH}/${igUserId}/media`);
    url.searchParams.set("fields",       withInsights ? `${base},insights.metric(${IG_MEDIA_METRICS})` : base);
    url.searchParams.set("limit",        "25");
    url.searchParams.set("access_token", token);
    const res = await graphGet<{ data?: IgMediaNode[] }>(url.toString());
    return res.data ?? [];
  };
  try {
    media = await fetchMedia(true);
    mediaFetchMode = "with_insights";
    toolsCalled.push("instagram_graph_media_insights");
  } catch (err: any) {
    // A metric invalid for some media type fails the whole expansion → retry bare.
    logger.warn({ connectionId, error: err.message?.slice(0, 100) }, "IG media+insights failed — retrying without insights");
    errors.push({ step: "media_insights", message: String(err.message ?? err).slice(0, 200) });
    try { media = await fetchMedia(false); mediaFetchMode = "bare"; toolsCalled.push("instagram_graph_media"); }
    catch (err2: any) {
      logger.warn({ connectionId, error: err2.message?.slice(0, 100) }, "IG media fetch failed");
      errors.push({ step: "media", message: String(err2.message ?? err2).slice(0, 200) });
    }
  }

  // ── Audience demographics (best-effort, per breakdown) ───────────────────
  const followers = profile.followers_count ?? 0;
  const demographics: InstagramNative["demographics"] = {};
  if (followers >= 100) {  // Graph requires ≥100 followers, else it errors
    for (const dim of ["country", "city", "age", "gender"] as const) {
      try {
        const rows = await igFollowerDemographic(igUserId, token, dim);
        if (rows.length) demographics[dim] = rows;
      } catch (err: any) {
        logger.warn({ connectionId, dim, error: err.message?.slice(0, 80) }, "IG demographic breakdown unavailable");
        errors.push({ step: `demographics.${dim}`, message: String(err.message ?? err).slice(0, 200) });
      }
    }
    if (Object.keys(demographics).length) toolsCalled.push("instagram_graph_demographics");
  }

  return {
    platform: "instagram", accountId: igUserId, handle: profile.username ?? null,
    fetchedAt: new Date().toISOString(), apiVersion: GV, sourceMethod: "oauth_instagram_login",
    toolsCalled, errors, profile, accountInsights, media, mediaFetchMode, demographics,
  };
}

/** The legacy display contract, computed from the native envelope. Same arithmetic as before. */
export function projectInstagramDisplay(n: InstagramNative): SocialAnalyticsResult {
  const raw: SocialAnalyticsRaw = {};
  const profile = n.profile;
  raw.account = profile as Record<string, unknown>;
  const followers = profile.followers_count ?? 0;

  let reach: number | null = null, profileLinkTaps: number | null = null, views: number | null = null;
  if (n.accountInsights) {
    raw.account_insights = n.accountInsights as Record<string, unknown>;
    reach           = igMetricValue(n.accountInsights.data, "reach");
    profileLinkTaps = igMetricValue(n.accountInsights.data, "profile_links_taps");
    views           = igMetricValue(n.accountInsights.data, "views");
  }

  const media = n.media;
  const postInsight = (m: IgMediaNode, name: string): number | null => igMetricValue(m.insights?.data, name);

  // ── Discovery/Trial-reel detection ──────────────────────────────────────────
  // A Reel is a "Discovery Test" when it is (a) NOT shared to the grid AND (b) reached at least 2× the
  // follower count. Instagram can reach at most `followers` people from the athlete's OWN audience, so a
  // reel at ≥2× followers is majority NON-follower reach by arithmetic. This is a DISPLAY heuristic; the
  // substrate records it as the inferred feature non_follower_reach_share, never as a provider fact.
  const DISCOVERY_REACH_MULTIPLE = 2;
  const discoveryIds = new Set<string>();
  if (followers > 0) {
    for (const m of media) {
      if (m.is_shared_to_feed === false && (postInsight(m, "reach") ?? 0) >= followers * DISCOVERY_REACH_MULTIPLE) {
        discoveryIds.add(m.id);
      }
    }
  }

  const cutoff30 = Date.now() - 30 * 864e5;
  let totalLikes = 0, totalComments = 0, postsLast30d = 0;
  let reachSum = 0, reachN = 0, savesSum = 0, savesN = 0, sharesSum = 0, sharesN = 0, erInteractions = 0, erReach = 0, discReachSum = 0, discReachN = 0;
  const recentMedia: NonNullable<SocialAnalyticsRaw["recent_media"]> = [];
  for (const m of media) {
    totalLikes    += m.like_count     ?? 0;
    totalComments += m.comments_count ?? 0;
    if (m.timestamp && new Date(m.timestamp).getTime() > cutoff30) postsLast30d++;
    const isDiscovery = discoveryIds.has(m.id);
    const r = postInsight(m, "reach");
    if (r != null) {
      if (isDiscovery) { discReachSum += r; discReachN++; }
      else { reachSum += r; reachN++; }
    }
    const s = postInsight(m, "saved");  if (s != null) { savesSum  += s; savesN++; }
    const h = postInsight(m, "shares"); if (h != null) { sharesSum += h; sharesN++; }
    if (r != null && r > 0 && !isDiscovery) {
      erReach += r; erInteractions += (m.like_count ?? 0) + (m.comments_count ?? 0) + (s ?? 0) + (h ?? 0);
    }
    recentMedia.push({
      id: m.id, permalink: m.permalink ?? "", media_type: m.media_type ?? "UNKNOWN",
      caption: m.caption ?? null, timestamp: m.timestamp ?? "",
      media_url: m.media_url ?? null, thumbnail_url: m.thumbnail_url ?? null,
      like_count: m.like_count ?? null, comments_count: m.comments_count ?? null,
      is_shared_to_feed: m.is_shared_to_feed ?? null,
      is_discovery: isDiscovery,
      insights: m.insights ? {
        reach:              postInsight(m, "reach")              ?? undefined,
        saved:              postInsight(m, "saved")              ?? undefined,
        shares:             postInsight(m, "shares")             ?? undefined,
        total_interactions: postInsight(m, "total_interactions") ?? undefined,
      } : null,
      children: m.children?.data?.length ? m.children.data.map((c) => ({
        id: c.id, media_type: c.media_type ?? "UNKNOWN",
        media_url: c.media_url ?? null, thumbnail_url: c.thumbnail_url ?? null,
      })) : undefined,
    });
  }
  raw.recent_media = recentMedia;
  raw.discovery = { reels: discReachN, total_reach: discReachSum, avg_reach: discReachN > 0 ? Math.round(discReachSum / discReachN) : null };

  const count       = media.length;
  const avgLikes    = count > 0 ? Math.round(totalLikes    / count) : 0;
  const avgComments = count > 0 ? Math.round(totalComments / count) : 0;
  // Reach-based engagement (interactions ÷ reach); follower-based fallback only when per-post reach is unavailable.
  const engRate = erReach > 0
    ? Math.round((erInteractions / erReach) * 10_000) / 100
    : (followers > 0 && count > 0 ? Math.round(((avgLikes + avgComments) / followers) * 10_000) / 100 : null);

  let contentFrequency: number | null = null;
  const stamps = media.map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0)).filter(Boolean).sort((a, b) => b - a);
  if (stamps.length >= 2) {
    const weeks = (stamps[0] - stamps[stamps.length - 1]) / (7 * 864e5);
    contentFrequency = weeks > 0 ? Math.round((stamps.length / weeks) * 100) / 100 : null;
  }

  let topCountry: string | null = null, topCity: string | null = null;
  let topAge: string | null = null, topGender: string | null = null;
  if (Object.keys(n.demographics).length) {
    const demographics: NonNullable<SocialAnalyticsRaw["demographics"]> = {};
    for (const dim of ["country", "city", "age", "gender"] as const) {
      const rows = n.demographics[dim];
      if (rows?.length) {
        demographics[dim] = rows;
        if (dim === "country") topCountry = rows[0].key;
        if (dim === "city")    topCity    = rows[0].key;
        if (dim === "age")     topAge     = rows[0].key;
        if (dim === "gender")  topGender  = rows[0].key;
      }
    }
    if (Object.keys(demographics).length) raw.demographics = demographics;
  }

  return {
    followers:            followers || null,
    following:            profile.follows_count ?? null,
    post_count:           profile.media_count   ?? null,
    total_likes:          null,
    total_channel_views:  null,
    is_verified:          false,                // not exposed on IG user node in v22
    reach,
    impressions:          views,                // IG-Login `views` stored in the impressions column
    profile_views:        profileLinkTaps,      // IG-Login `profile_links_taps` (UI: "Profile Link Taps")
    avg_engagement_rate:  engRate,
    avg_reach_per_post:   reachN  > 0 ? Math.round(reachSum  / reachN)  : null,
    avg_views_per_post:   null,                 // needs per-type video metric (future)
    avg_shares_per_post:  sharesN > 0 ? Math.round(sharesSum / sharesN) : null,
    avg_saves_per_post:   savesN  > 0 ? Math.round(savesSum  / savesN)  : null,
    avg_watch_time_sec:   null,                 // needs per-type reel metric (future)
    content_frequency:    contentFrequency,
    posts_last_30d:       postsLast30d,
    top_audience_country:   topCountry,
    top_audience_city:      topCity,
    top_audience_age_range: topAge,
    top_audience_gender:    topGender,
    raw_metrics:          raw,
    toolsCalled:          n.toolsCalled,
  };
}

export async function fetchAnalytics(connectionId: string): Promise<SocialAnalyticsResult | null> {
  const native = await fetchInstagramNative(connectionId);
  return native ? projectInstagramDisplay(native) : null;
}

export const fetchNative = fetchInstagramNative;
export const project = projectInstagramDisplay;

// ─── Direct Messages ─────────────────────────────────────────────────────────

export interface IgDMMessage {
  id:             string; // Instagram message ID
  conversationId: string; // Instagram conversation ID
  text:           string; // Message text
  fromId:         string; // Sender's IG-scoped user ID
  fromName:       string; // Sender display name or username
  createdTime:    string; // ISO timestamp
  isInbound:      boolean; // true = brand sent to athlete
}

// Fetch recent DM conversations and flatten into individual messages.
// Requires the instagram_business_manage_messages scope.
export async function fetchDirectMessages(params: {
  connectionId:     string;
  maxConversations?: number;
}): Promise<IgDMMessage[]> {
  const { connectionId, maxConversations = 20 } = params;

  await refreshTokenIfNeeded(connectionId);
  const row = await openTokenFields((await db.select({
    access_token:     connectedAccounts.access_token,
    platform_user_id: connectedAccounts.platform_user_id,
  }).from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);

  if (!row?.access_token || !row.platform_user_id) return [];

  const token    = row.access_token;
  const igUserId = row.platform_user_id;

  // Under Instagram Login, conversations live on the IG user node — GET /me/conversations
  // with the IG user token (platform=instagram). No Facebook Page.
  const url = new URL(`${GRAPH}/me/conversations`);
  url.searchParams.set("platform",     "instagram");
  url.searchParams.set("fields",       "id,participants,messages{id,message,from,created_time}");
  url.searchParams.set("access_token", token);
  url.searchParams.set("limit",        String(maxConversations));

  const data = await graphGet<{
    data?: Array<{
      id: string;
      participants?: { data?: Array<{ id: string; name: string }> };
      messages?: {
        data?: Array<{
          id: string;
          message: string;
          from: { id: string; name?: string };
          created_time: string;
        }>;
      };
    }>;
  }>(url.toString());

  const results: IgDMMessage[] = [];
  let noText = 0;
  for (const conv of data.data ?? []) {
    for (const msg of conv.messages?.data ?? []) {
      // No text: an attachment-only DM. This poll does not ask Graph for attachment fields, so it cannot tell a
      // photo from a share; the webhook records those in real time as a placeholder message on the thread
      // (instagramAttachments.ts). Counted and logged here rather than dropped silently.
      if (!msg.message?.trim()) { noText++; continue; }
      results.push({
        id:             msg.id,
        conversationId: conv.id,
        text:           msg.message,
        fromId:         msg.from.id,
        fromName:       msg.from.name ?? msg.from.id,
        createdTime:    msg.created_time,
        isInbound:      msg.from.id !== igUserId,
      });
    }
  }

  if (noText > 0) {
    logger.info({ connectionId, noText }, "Instagram DM poll: messages with no text left to the webhook's attachment receipt");
  }
  return results;
}

// Resolve the IG conversation id + the other participant's display name for a given
// inbound sender. Webhook `messaging` events carry only the sender's IGSID and a message
// id — no conversation id or name — so we look the conversation up by user_id. This lets
// the webhook key threads by the SAME conversation id the backfill path uses (real-time +
// polled messages land on one thread) and recover a human-readable name. Best-effort.
export async function resolveDmContext(
  connectionId: string,
  senderIgUserId: string,
): Promise<{ conversationId: string | null; senderName: string | null }> {
  const row = await openTokenFields((await db.select({
    access_token: connectedAccounts.access_token,
  }).from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return { conversationId: null, senderName: null };

  const url = new URL(`${GRAPH}/me/conversations`);
  url.searchParams.set("platform",     "instagram");
  url.searchParams.set("user_id",      senderIgUserId);
  url.searchParams.set("fields",       "id,participants");
  url.searchParams.set("access_token", row.access_token);

  try {
    const data = await graphGet<{
      data?: Array<{ id: string; participants?: { data?: Array<{ id: string; username?: string; name?: string }> } }>;
    }>(url.toString());
    const conv  = data.data?.[0];
    const other = conv?.participants?.data?.find(p => p.id === senderIgUserId);
    return { conversationId: conv?.id ?? null, senderName: other?.username ?? other?.name ?? null };
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message?.slice(0, 80) }, "resolveDmContext failed");
    return { conversationId: null, senderName: null };
  }
}

// True when Meta rejected a send because the standard 24-hour reply window has closed.
// Signalled by error code 10 / subcode 2534022 ("outside the allowed window").
function isOutsideWindowError(json: any): boolean {
  const e = json?.error;
  if (!e) return false;
  const sub = e.error_subcode ?? e.subcode;
  if (sub === 2534022) return true;
  return typeof e.message === "string" && /outside.*window|allowed window/i.test(e.message);
}

// Send a DM via the Instagram Messaging API (Instagram Login: POST /me/messages, IG user
// token). Requires the instagram_business_manage_messages scope.
//
// Reply windows: a standard RESPONSE is allowed for 24h after the user's last message. If
// that window has closed, we retry under the HUMAN_AGENT tag, which Meta permits for up to
// 7 days for human-authored replies — so an athlete answering a brand a few days later still
// goes through. NOTE: confirm the exact HUMAN_AGENT request shape with a live send during
// Dev-Mode testing (the tag/messaging_type keys aren't shown in an official IG-Login sample).
export async function sendInstagramDM(params: {
  connectionId:      string;
  recipientIgUserId: string;
  message:           string;
}): Promise<void> {
  const { connectionId, recipientIgUserId, message } = params;

  await refreshTokenIfNeeded(connectionId);
  const row = await openTokenFields((await db.select({
    access_token:     connectedAccounts.access_token,
    platform_user_id: connectedAccounts.platform_user_id,
  }).from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);

  if (!row?.access_token || !row.platform_user_id) throw new Error("Instagram connection not found or missing token");

  const token   = row.access_token;
  const sendUrl = `${GRAPH}/me/messages`;
  const base    = { recipient: { id: recipientIgUserId }, message: { text: message } };

  const send = async (body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: any }> => {
    const res  = await fetch(sendUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ...body, access_token: token }),
    });
    const json = await res.json() as any;
    return { ok: res.ok && !json.error, status: res.status, json };
  };

  // Standard reply inside the 24h window.
  let result = await send({ ...base, messaging_type: "RESPONSE" });
  // Outside the window → retry under the HUMAN_AGENT tag (7-day human-authored window).
  if (!result.ok && isOutsideWindowError(result.json)) {
    logger.info({ connectionId, recipientIgUserId }, "24h window closed — retrying send under HUMAN_AGENT tag");
    result = await send({ ...base, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  }
  if (!result.ok) throw new Error(result.json.error?.message ?? `Instagram send failed: ${result.status}`);

  logger.info({ connectionId, recipientIgUserId }, "Instagram DM sent");
}

// ─── InboxProvider contract ──────────────────────────────────────────────────

// Post-connect DM setup. Instagram is BOTH a scoring source and an inbox provider.
// The scoring fetch (fetchSocialData → snapshot/score) is NOT done here any more: the
// OAuth callback starts the first_look workflow for Instagram too, and its fetch_social
// step runs fetchSocialData awaited and retried — doing it here as well would write a
// second social_connect snapshot per connect. This handler only pulls existing DMs once
// so brand conversations surface immediately.
// The real-time DM path is an Instagram webhook subscription (object `instagram`,
// field `messages`), but serving accounts we don't own needs Advanced Access for
// instagram_business_manage_messages (Meta App Review). Until then we rely on this
// backfill + the polling fallback (inboxCronSync) and the dev "sync now" trigger.
// Dynamic imports avoid circular deps (both modules import from here).
export async function onConnected(connectionId: string, athleteId: string): Promise<void> {
  const { syncInstagramDMs } = await import("./instagramSync.js");
  await syncInstagramDMs({ connectionId, athleteId }).catch((err: any) =>
    logger.error({ athleteId, connectionId, error: err.message }, "Instagram initial DM backfill threw"),
  );
}

// Polling fallback for one connection — called by inboxCronSync and the dev
// sync-now trigger. detectDeal dedupes by (thread_id, external_message_id) so
// re-processing is safe.
export async function syncRecent(connectionId: string, athleteId: string): Promise<{ detected: number; skipped: number }> {
  const { syncInstagramDMs } = await import("./instagramSync.js");
  const r = await syncInstagramDMs({ connectionId, athleteId });
  return { detected: r.detected, skipped: r.skipped };
}

// ─── Full-history media pagination (media backfill) ──────────────────────────
// IgMediaNode now comes from services/intelligence/social/native (a superset of the old local type).

/**
 * One page of the account's full media history, newest-first, for the backfill.
 * No `since` filter and no per-post insights (older-media insights are unreliable +
 * expensive) — just the durable fields + carousel children. Returns the `after`
 * cursor to resume from, or null when history is exhausted.
 */
export async function listMediaPage(connectionId: string, after: string | null):
  Promise<{ items: NonNullable<SocialAnalyticsRaw["recent_media"]>; nextCursor: string | null; native: IgMediaNode[] }> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token || !row.platform_user_id) return { items: [], nextCursor: null, native: [] };
  const base = "id,permalink,media_type,media_product_type,caption,timestamp,media_url,thumbnail_url,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}";
  const url  = new URL(`${GRAPH}/${row.platform_user_id}/media`);
  url.searchParams.set("fields",       base);
  url.searchParams.set("limit",        "50");
  if (after) url.searchParams.set("after", after);
  url.searchParams.set("access_token", row.access_token);
  const res = await graphGet<{ data?: IgMediaNode[]; paging?: { cursors?: { after?: string }; next?: string } }>(url.toString());
  const items = (res.data ?? []).map((m) => ({
    id: m.id, permalink: m.permalink ?? "", media_type: m.media_type ?? "IMAGE", caption: m.caption ?? null,
    timestamp: m.timestamp ?? "", media_url: m.media_url ?? null, thumbnail_url: m.thumbnail_url ?? null,
    like_count: m.like_count ?? null, comments_count: m.comments_count ?? null, insights: null,
    children: m.children?.data?.length ? m.children.data.map((c) => ({
      id: c.id, media_type: c.media_type ?? "IMAGE", media_url: c.media_url ?? null, thumbnail_url: c.thumbnail_url ?? null,
    })) : undefined,
  }));
  const nextCursor = res.paging?.next ? (res.paging.cursors?.after ?? null) : null;
  return { items, nextCursor, native: (res.data ?? []) as IgMediaNode[] };
}

/**
 * Per-post insights for a single media id (targeted top-post enrichment). Universal
 * metrics (reach/saved/shares/total_interactions) work on every media type; views +
 * reels watch-time only exist on video, so they're a separate best-effort call that
 * won't fail the universal set. Returns a flat metric map, keyed by our insights schema
 * (views -> video_views). Best-effort: never throws.
 */
export async function fetchMediaInsights(
  connectionId: string, mediaId: string, mediaType: string | null,
): Promise<Record<string, number> | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;
  const token = row.access_token;
  const out: Record<string, number> = {};
  const grab = async (metrics: string) => {
    try {
      const url = new URL(`${GRAPH}/${mediaId}/insights`);
      url.searchParams.set("metric",       metrics);
      url.searchParams.set("access_token", token);
      const res = await graphGet<{ data?: Array<{ name?: string; total_value?: { value?: number }; values?: Array<{ value?: number }> }> }>(url.toString());
      for (const e of res.data ?? []) {
        const v = e.total_value?.value ?? e.values?.[0]?.value;
        if (e.name && typeof v === "number") out[e.name === "views" ? "video_views" : e.name] = v;
      }
    } catch { /* best-effort — metric may be invalid for this media type */ }
  };
  await grab("reach,saved,shares,total_interactions");
  if (mediaType === "VIDEO" || mediaType === "REELS") await grab("views,ig_reels_avg_watch_time");
  return Object.keys(out).length ? out : null;
}

/**
 * A FRESH downloadable media_url for one media id — the CDN url regenerates per call, so this
 * works for any post age (that's how we re-host a 2019 reel's mp4 on demand). For VIDEO/REELS
 * this is the mp4; for images it's the full image. Best-effort: null on any failure.
 */
export async function fetchMediaFileUrl(connectionId: string, mediaId: string): Promise<string | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;
  try {
    const url = new URL(`${GRAPH}/${mediaId}`);
    url.searchParams.set("fields",       "media_url");
    url.searchParams.set("access_token", row.access_token);
    const res = await graphGet<{ media_url?: string }>(url.toString());
    return res.media_url ?? null;
  } catch { return null; }
}

// ─── Instagram Stories (Phase A Step 1b) ──────────────────────────────────────
// Listing + per-Story insights as native envelopes for services/intelligence/social/stories.ts.
// media_url / thumbnail_url are never requested (decision O4). Errors are classified by Meta
// error CODE (metaErrors.ts); only class `auth` may expire a connection, and that decision is
// the skill's, not this module's.

const STORY_LIST_FIELDS = "id,media_type,media_product_type,timestamp,is_shared_to_feed";
async function graphGetRaw(url: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(url);
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { ok: res.ok && !json?.error, status: res.status, json };
}

export async function fetchInstagramStoriesNative(connectionId: string): Promise<InstagramStoriesNative | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token || !row.platform_user_id) return null;
  const url = new URL(`${GRAPH}/${row.platform_user_id}/stories`);
  url.searchParams.set("fields", STORY_LIST_FIELDS);
  url.searchParams.set("access_token", row.access_token);
  const fetchedAt = new Date().toISOString();
  const r = await graphGetRaw(url.toString());
  const errors: IgStoryCallError[] = [];
  let stories: IgStoryNode[] = [];
  let listingError: InstagramStoriesNative["listingError"] = null;
  if (r.ok) stories = Array.isArray(r.json?.data) ? r.json.data : [];
  else { const c = classifyMetaError(r.json, r.status); errors.push({ step: "stories_list", message: c.message, class: c.class, code: c.code, subcode: c.subcode, type: c.type, httpStatus: c.httpStatus }); listingError = { httpStatus: r.status, body: r.json ?? null }; }
  return { platform: "instagram", accountId: row.platform_user_id, handle: row.platform_username ?? null, fetchedAt, apiVersion: GV, sourceMethod: "oauth_instagram_login", toolsCalled: ["instagram_graph_stories"], errors, stories, listingError };
}

/** The three insight calls for one Story, through the pure reader (instagramStoryInsights.ts). Never throws; every failure is an entry in `errors` with its class. */
const storyMetricCache = createStoryMetricCache();
export async function fetchStoryInsightsNative(connectionId: string, story: IgStoryNode): Promise<IgStoryInsightsNative> {
  const fetchedAt = new Date().toISOString();
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return { storyId: String(story.id), story, fetchedAt, insights: null, navigation: null, profileActivity: null, requestedMetrics: [], unsupportedMetrics: [], errors: [{ step: "token", message: "no access token on the connection", class: "unknown" }] };
  const token = row.access_token;
  const call: InsightCall = async (_step, params) => {
    const url = new URL(`${GRAPH}/${story.id}/insights`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
    const r = await graphGetRaw(url.toString());
    return r.ok ? { ok: true, json: r.json } : { ok: false, c: classifyMetaError(r.json, r.status) };
  };
  return readStoryInsights(call, story, storyMetricCache, fetchedAt);
}
