/**
 * agent/research/publicPlatform.ts — audience numbers from the PLATFORMS' OWN APIs, for a handle the athlete confirmed
 * (owner, 26 Oct 2026: the scoring source rule for social and audience data).
 *
 * THE RULE. The M.I.A.'s AUTHORITATIVE social data (the measured accounts in its evidence block) comes only from
 *   (a) her connected accounts (measured facts, connected_verified — agent/research/measuredSync.ts), else
 *   (b) the platforms' public APIs read by Nomila — Instagram Business Discovery from Nomila's own business account
 *       and the YouTube Data API (lib/integrations/discovery.ts, the one client) — and only for a handle SHE confirmed.
 * Precedence, per platform: connected > public API (confirmed handle) > web-found. Follower counts or social numbers
 * found on web pages are FOUND facts: they reach the scorer only as public evidence in its public-facts block ("weigh
 * and verify"), never as authoritative data (owner, 26 Oct 2026, reversing #1142's hold-back of them from the scorer's
 * input on the lean path).
 *
 * The score follows better data: a confirm whose public read succeeds, and a nightly reading that is new or moved
 * ≥ 10%, ask for a recompute (miaPreview/preview.ts requestRescoreForReadings: debounced, digest-skipped). A connect
 * asks through social_sync (workflow/definitions/socialSync.ts).
 *
 * What counts as CONFIRMED: a SAID fact that names her handle on a platform — the handle she typed at sign-up
 * (onboarding/<run>#handle:<platform>, signupResearch.ts; or typed later on the waitlist while her identity is held,
 * waitlist#handle:<platform>, researchRefresh/identityRecheck.ts), her correction of it, or the confirm step below
 * (me/handles#handle:<platform>). Nothing else: not a handle research found, not one the legacy blob holds.
 *
 * What this module writes: MEASURED memory facts with a ref under PUBLIC_REF_PREFIX
 * ("platform_public/social_analytics_snapshots/<id>#<platform>.<metric>"), read by code from Nomila's own
 * source='discovery' snapshot row whose looked-up username is the confirmed handle. The prefix is how the scorer's
 * block labels them public-platform data (meta business discovery / youtube data api), never connected_verified. A
 * platform she has CONNECTED is never written here (connected data wins; the snapshot table holds one row per
 * athlete × platform × day, so a discovery lookup must not run for it either).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { MemoryFact } from "../../../shared/agent";
import type { NewFact } from "./store";

/** The platforms with a public API route Nomila uses (TikTok and X have none: lib/integrations/discovery.ts). */
export const PUBLIC_PLATFORMS = ["instagram", "youtube"] as const;
export type PublicPlatform = (typeof PUBLIC_PLATFORMS)[number];
const LABEL: Record<PublicPlatform, string> = { instagram: "Instagram", youtube: "YouTube" };

/** Measured facts read from a platform's public API carry a source ref under this prefix. */
export const PUBLIC_REF_PREFIX = "platform_public/";
export const isPublicPlatformRef = (ref: string | null | undefined) => !!ref && ref.startsWith(PUBLIC_REF_PREFIX);
/** The ref of the confirm step's said fact. */
export const HANDLE_REF = (platform: PublicPlatform) => `me/handles#handle:${platform}`;

/** Pure: a handle as stored and compared — no "@", no URL, trimmed, lower-cased for comparison only by callers. */
export function cleanHandle(raw: string): string | null {
  let h = String(raw ?? "").trim();
  const url = h.match(/(?:instagram\.com|youtube\.com)\/(?:@)?([A-Za-z0-9._-]+)/i);
  if (url) h = url[1];
  // A handle never ends in a period (Instagram does not allow one): a trailing one ends the sentence.
  h = h.replace(/^@+/, "").replace(/\/+$/, "").replace(/\.+$/, "");
  return /^[A-Za-z0-9._-]{1,64}$/.test(h) ? h : null;
}

const HANDLE_CLAIM = /\b(instagram|youtube)\b handle is @?([A-Za-z0-9._-]{1,64})/i;

/**
 * Pure: the handle she confirmed per platform — from her ACTIVE SAID facts that name one (her own word: typed at
 * sign-up, corrected, or confirmed). The newest wins (date, then when recorded).
 */
export function confirmedHandlesFrom(facts: MemoryFact[]): Partial<Record<PublicPlatform, { handle: string; factId: string }>> {
  const out: Partial<Record<PublicPlatform, { handle: string; factId: string; at: string }>> = {};
  for (const f of facts) {
    if (f.type !== "said" || f.status !== "active") continue;
    const m = f.claim.match(HANDLE_CLAIM);
    if (!m) continue;
    const platform = m[1].toLowerCase() as PublicPlatform;
    const handle = cleanHandle(m[2].replace(/\.$/, ""));
    if (!handle) continue;
    const at = `${f.date ?? ""}|${f.createdAt ?? ""}`;
    if (!out[platform] || at > out[platform]!.at) out[platform] = { handle, factId: f.id, at };
  }
  return Object.fromEntries(Object.entries(out).map(([p, v]) => [p, { handle: v!.handle, factId: v!.factId }]));
}

const PROFILE_URL = /(?:https?:\/\/)?(?:www\.)?(instagram\.com|youtube\.com)\/(@?[A-Za-z0-9._-]{2,64})/gi;
const AT_HANDLE = /\b(instagram|youtube)\b[^.@]{0,40}@([A-Za-z0-9._]{2,30})/gi;
const NOT_A_PROFILE = new Set(["p", "reel", "reels", "tv", "stories", "explore", "watch", "channel", "c", "user", "results", "shorts", "playlist", "embed"]);

/**
 * Pure: the handles research FOUND (candidates for "Is this you?"), per platform, from her active found facts — a
 * profile link as a fact's source or in its claim, or "@handle" named beside the platform — plus any the caller adds
 * (social_identities rows). Handles she already confirmed are not candidates. Each with the facts that name it.
 */
export function candidateHandlesFrom(facts: MemoryFact[], confirmed: Partial<Record<PublicPlatform, { handle: string }>>, extra: Array<{ platform: string; handle: string; source: string }> = []): Array<{ platform: PublicPlatform; handle: string; sources: string[] }> {
  const found = new Map<string, { platform: PublicPlatform; handle: string; sources: Set<string> }>();
  const add = (platformRaw: string, raw: string, source: string) => {
    const platform = (/youtube/i.test(platformRaw) ? "youtube" : /instagram/i.test(platformRaw) ? "instagram" : null) as PublicPlatform | null;
    const handle = platform ? cleanHandle(raw) : null;
    if (!platform || !handle || NOT_A_PROFILE.has(handle.toLowerCase())) return;
    if (confirmed[platform]?.handle.toLowerCase() === handle.toLowerCase()) return;
    const k = `${platform}:${handle.toLowerCase()}`;
    const cur = found.get(k) ?? { platform, handle, sources: new Set<string>() };
    cur.sources.add(source);
    found.set(k, cur);
  };
  for (const f of facts) {
    if (f.type !== "found" || f.status !== "active") continue;
    for (const text of [f.source.url ?? "", f.claim]) for (const m of text.matchAll(PROFILE_URL)) add(m[1], m[2], f.id);
    for (const m of f.claim.matchAll(AT_HANDLE)) add(m[1], m[2], f.id);
  }
  for (const e of extra) add(e.platform, e.handle, e.source);
  return [...found.values()].map((c) => ({ platform: c.platform, handle: c.handle, sources: [...c.sources] }))
    .sort((a, b) => b.sources.length - a.sources.length || a.platform.localeCompare(b.platform) || a.handle.localeCompare(b.handle));
}

/** The fields of a source='discovery' snapshot row this module reads. */
export interface DiscoveryRow {
  id: string;
  platform: string;
  snapshot_day: string | Date;
  followers: number | null;
  post_count: number | null;
  avg_engagement_rate: number | string | null;
  posts_last_30d: number | null;
  total_channel_views: number | string | null;
  raw_metrics: unknown;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const day = (d: string | Date) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
/** The username a discovery row was looked up for (collectDiscoveryAnalytics stores it in raw_metrics.discovery). */
export const discoveryUsername = (r: DiscoveryRow): string | null => {
  const u = (r.raw_metrics as any)?.discovery?.username;
  return typeof u === "string" && u ? u.replace(/^@+/, "") : null;
};

/**
 * Pure: measured facts from the latest discovery row per confirmed platform, ONLY when that row was looked up for the
 * confirmed handle (a row for any other handle — an entered or legacy one — is not hers to score). Connected
 * platforms are skipped (connected data wins). Each claim names the platform's API as its source.
 */
export function publicMeasuredFactsFrom(rows: DiscoveryRow[], confirmed: Partial<Record<PublicPlatform, { handle: string }>>, connected: ReadonlySet<string>, athleteName: string): NewFact[] {
  const facts: NewFact[] = [];
  for (const platform of PUBLIC_PLATFORMS) {
    const c = confirmed[platform];
    if (!c || connected.has(platform)) continue;
    const row = rows.filter((r) => r.platform === platform && discoveryUsername(r)?.toLowerCase() === c.handle.toLowerCase())
      .sort((a, b) => day(b.snapshot_day).localeCompare(day(a.snapshot_day)))[0];
    if (!row) continue;
    const via = platform === "instagram" ? "Instagram Business Discovery" : "the YouTube Data API";
    const where = `${LABEL[platform]} (@${c.handle})`;
    const add = (metric: string, claim: string) => facts.push({
      subject: { kind: "athlete", name: athleteName }, claim, type: "measured",
      source: { ref: `${PUBLIC_REF_PREFIX}social_analytics_snapshots/${row.id}#${platform}.${metric}`, title: `Public ${LABEL[platform]} profile, read through ${via}` },
      date: day(row.snapshot_day), confidence: 1, runId: null,
    });
    const followers = num(row.followers), er = num(row.avg_engagement_rate), p30 = num(row.posts_last_30d), views = num(row.total_channel_views), posts = num(row.post_count);
    if (followers != null) add("followers", `${where} has ${fmt(followers)} ${platform === "youtube" ? "subscribers" : "followers"} (public profile).`);
    if (er != null) add("avg_engagement_rate", `${where} recent posts average a ${er}% engagement rate (likes and comments on public posts).`);
    if (p30 != null) add("posts_last_30d", `${where} published ${p30} posts in the last 30 days.`);
    if (views != null) add("total_channel_views", `${where} has ${fmt(views)} total channel views.`);
    if (posts != null) add("post_count", `${where} has ${fmt(posts)} ${platform === "youtube" ? "videos" : "posts"} in total.`);
  }
  return facts;
}

// ── DB ──────────────────────────────────────────────────────────────────────

/** The athlete's active connected platforms. */
async function connectedPlatforms(athleteId: string): Promise<Set<string>> {
  const { db } = await import("../../db");
  const { connectedAccounts } = await import("../../../shared/schema");
  const rows = await db.select({ platform: connectedAccounts.platform }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  return new Set(rows.map((r) => r.platform));
}

/**
 * Write her public-platform measured facts from the discovery rows Nomila already holds (no API call). Called with the
 * connected sync (measuredSync.syncMemoryMeasuredFacts, which runs before every M.I.A. preview and after every social
 * sync) and right after a confirm. A newer reading of a metric supersedes the older one (research.syncMeasured).
 */
export async function syncPublicMeasuredFacts(athleteId: string, athleteName: string): Promise<{ inserted: number; superseded: number; moved: number; platforms: string[] }> {
  const { db } = await import("../../db");
  const { socialAnalyticsSnapshots } = await import("../../../shared/schema");
  const { dbStore } = await import("./dbStore");
  const { syncMeasured } = await import("./research");
  const confirmed = confirmedHandlesFrom(await dbStore.listFacts(athleteId, ["active"]));
  if (!Object.keys(confirmed).length) return { inserted: 0, superseded: 0, moved: 0, platforms: [] };
  const rows = await db.select({
    id: socialAnalyticsSnapshots.id, platform: socialAnalyticsSnapshots.platform, snapshot_day: socialAnalyticsSnapshots.snapshot_day,
    followers: socialAnalyticsSnapshots.followers, post_count: socialAnalyticsSnapshots.post_count, avg_engagement_rate: socialAnalyticsSnapshots.avg_engagement_rate,
    posts_last_30d: socialAnalyticsSnapshots.posts_last_30d, total_channel_views: socialAnalyticsSnapshots.total_channel_views, raw_metrics: socialAnalyticsSnapshots.raw_metrics,
  }).from(socialAnalyticsSnapshots)
    .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.source, "discovery")))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_day)).limit(20);
  const facts = publicMeasuredFactsFrom(rows as DiscoveryRow[], confirmed, await connectedPlatforms(athleteId), athleteName);
  const platforms = [...new Set(facts.map((f) => (f.source.ref ?? "").split("#")[1]?.split(".")[0]).filter(Boolean))] as string[];
  if (!facts.length) return { inserted: 0, superseded: 0, moved: 0, platforms };
  const r = await syncMeasured(dbStore, athleteId, facts);
  return { inserted: r.inserted, superseded: r.superseded, moved: r.moved ?? 0, platforms };
}

export type HandleLookup = "found" | "connected" | "not_business_account" | "not_found" | "not_configured" | "no_token" | "rate_limited" | "token_expired" | "failed";

export interface HandlesView {
  /** platform → the handle she confirmed (her own word), whether it is a connected account, and the latest public reading. */
  confirmed: Array<{ platform: PublicPlatform; handle: string; factId: string; connected: boolean; publicReading: { followers: number | null; asOf: string } | null }>;
  /** Handles research found that she has not confirmed: the "Is this you?" list. */
  candidates: Array<{ platform: PublicPlatform; handle: string; sources: string[] }>;
}

/** GET /me/handles: what she confirmed, and what research found for her to confirm. Reads only. */
export async function readHandles(athleteId: string): Promise<HandlesView> {
  const { db } = await import("../../db");
  const { socialAnalyticsSnapshots, socialIdentities } = await import("../../../shared/schema");
  const { dbStore } = await import("./dbStore");
  const facts = await dbStore.listFacts(athleteId, ["active"]);
  const confirmed = confirmedHandlesFrom(facts);
  const connected = await connectedPlatforms(athleteId);
  const ids = await db.select({ platform: socialIdentities.platform, handle: socialIdentities.handle, sourceClass: socialIdentities.source_class, id: socialIdentities.id })
    .from(socialIdentities).where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.status, "active")));
  const extra = ids.filter((r) => r.handle && r.sourceClass !== "connected_verified").map((r) => ({ platform: r.platform, handle: String(r.handle), source: `social_identities/${r.id}` }));
  const snaps = await db.select({ id: socialAnalyticsSnapshots.id, platform: socialAnalyticsSnapshots.platform, snapshot_day: socialAnalyticsSnapshots.snapshot_day, followers: socialAnalyticsSnapshots.followers, raw_metrics: socialAnalyticsSnapshots.raw_metrics })
    .from(socialAnalyticsSnapshots).where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.source, "discovery")))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_day)).limit(20);
  return {
    confirmed: PUBLIC_PLATFORMS.filter((p) => confirmed[p]).map((p) => {
      const c = confirmed[p]!;
      const row = (snaps as any[]).find((r) => r.platform === p && discoveryUsername(r)?.toLowerCase() === c.handle.toLowerCase());
      return { platform: p, handle: c.handle, factId: c.factId, connected: connected.has(p), publicReading: row ? { followers: row.followers ?? null, asOf: day(row.snapshot_day) } : null };
    }),
    candidates: candidateHandlesFrom(facts, confirmed, extra),
  };
}

/**
 * POST /me/handles/confirm { platform, handle }: "this is my Instagram / YouTube". Writes her word as a SAID fact (the
 * earlier said handle for that platform is superseded by it), then — unless the platform is connected — reads the
 * public profile once through the platform's API (lib/integrations/discovery.ts; the snapshot row as the nightly
 * discovery collection writes it) and turns it into public-platform measured facts, then asks for a recompute (the
 * M.I.A. rescores when the evidence changed; an unchanged digest is free). Returns the lookup outcome so the app can
 * say "we couldn't read it: switch to a professional account".
 */
export async function confirmHandle(athleteId: string, input: { platform?: unknown; handle?: unknown }, deps: {
  lookup?: (platform: PublicPlatform, handle: string) => Promise<{ outcome: HandleLookup; followers: number | null }>;
  /** The recompute request (default: miaPreview/preview.ts requestRescoreForReadings). */
  rescore?: (athleteId: string, why: { reason: string; createdBy: string }) => Promise<unknown>;
} = {}): Promise<{ platform: PublicPlatform; handle: string; factId: string; lookup: HandleLookup; followers: number | null; measured: number; rescoreRequested: boolean }> {
  const platform = String(input.platform ?? "").toLowerCase() as PublicPlatform;
  if (!(PUBLIC_PLATFORMS as readonly string[]).includes(platform)) throw new HandleError(400, "invalid", "platform must be instagram or youtube");
  const handle = cleanHandle(String(input.handle ?? ""));
  if (!handle) throw new HandleError(400, "invalid", "handle is not a valid Instagram or YouTube handle");
  const { db } = await import("../../db");
  const { athletes } = await import("../../../shared/schema");
  const { dbStore } = await import("./dbStore");
  const [row] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const name = row?.name ?? "Athlete";
  const facts = await dbStore.listFacts(athleteId, ["active"]);
  const prior = confirmedHandlesFrom(facts)[platform];
  let factId = prior?.factId ?? "";
  if (!prior || prior.handle.toLowerCase() !== handle.toLowerCase()) {
    const [f] = await dbStore.insertFacts(athleteId, [{
      subject: { kind: "athlete", name }, claim: `${name}'s ${LABEL[platform]} handle is @${handle}.`, type: "said",
      source: { ref: HANDLE_REF(platform), title: "You confirmed" }, date: new Date().toISOString().slice(0, 10), confidence: 1, runId: null,
    }]);
    factId = f.id;
    // Her newer word replaces her older one for this platform (history kept: superseded, not deleted).
    for (const old of facts) if (old.type === "said" && old.status === "active" && HANDLE_CLAIM.exec(old.claim)?.[1].toLowerCase() === platform) {
      await dbStore.setFactStatus(athleteId, old.id, "superseded", { supersededBy: f.id });
    }
    // Her entered handle for the platform too, so the nightly discovery collection (collectDiscoveryAnalytics, which
    // looks up athletes.socials) keeps the public reading current.
    await db.update(athletes).set({ socials: sql`coalesce(${athletes.socials}, '{}'::jsonb) || ${JSON.stringify({ [platform]: handle })}::jsonb` }).where(eq(athletes.id, athleteId));
    // A new handle is identity evidence: a held identity (an open "#identity" verdict) is re-checked with it
    // (researchRefresh/identityRecheck.ts; a no-op without one, at most once a day). Not awaited, never fatal.
    void import("../researchRefresh/identityRecheck").then(({ recheckIdentityInBackground }) => recheckIdentityInBackground(athleteId, "handle", `confirm:${platform}`)).catch(() => undefined);
  }
  const connected = (await connectedPlatforms(athleteId)).has(platform);
  let lookup: HandleLookup = "connected", followers: number | null = null;
  if (!connected) ({ outcome: lookup, followers } = await (deps.lookup ?? lookupAndStore(athleteId))(platform, handle));
  const synced = lookup === "found" ? await syncPublicMeasuredFacts(athleteId, name) : { inserted: 0 };
  // The read succeeded: the M.I.A. should see it. Debounced and not forced, so a repeat confirm (or an unchanged
  // reading) joins the scheduled run or is digest-skipped — never a second paid evaluation of the same evidence.
  let rescoreRequested = false;
  if (lookup === "found") {
    const rescore = deps.rescore ?? (await import("../../services/miaPreview/preview")).requestRescoreForReadings;
    rescoreRequested = !!(await rescore(athleteId, { reason: `confirmed ${platform} handle read through the platform's public API`, createdBy: "handle_confirm" }).catch(() => null));
  }
  return { platform, handle, factId, lookup, followers, measured: synced.inserted, rescoreRequested };
}

// ── the waitlist contract (GET /waitlist/progress `handles`, POST /waitlist/handles/:platform) ───────────────────

/** The ref of her "that is not me" for a suggested handle (a said fact: her word, kept as history). */
export const NOT_HANDLE_REF = (platform: PublicPlatform) => `me/handles#not-handle:${platform}`;
const NOT_HANDLE_CLAIM = /says @([A-Za-z0-9._-]{1,64}) is not their (Instagram|YouTube) account/i;

export interface WaitlistHandle {
  platform: PublicPlatform;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  /** Where the handle came from: she typed it at sign-up, she confirmed it, or research found it. */
  source: "signup" | "you" | "research";
  status: "suggested" | "confirmed" | "rejected";
}

/** Pure: the handles she said are NOT hers, per platform (newest first). */
export function rejectedHandlesFrom(facts: MemoryFact[]): Array<{ platform: PublicPlatform; handle: string; factId: string }> {
  return facts.filter((f) => f.type === "said" && f.status === "active" && (f.source.ref ?? "").includes("#not-handle:"))
    .sort((a, b) => `${b.date ?? ""}|${b.createdAt ?? ""}`.localeCompare(`${a.date ?? ""}|${a.createdAt ?? ""}`))
    .flatMap((f) => { const m = f.claim.match(NOT_HANDLE_CLAIM); return m ? [{ platform: m[2].toLowerCase() as PublicPlatform, handle: m[1], factId: f.id }] : []; });
}

/**
 * Pure: the waitlist's handle list — per platform, what she confirmed (her own word), else the best handle research
 * found that she has not rejected ("suggested"), plus what she rejected. One confirmed-or-suggested entry per platform.
 */
export function waitlistHandlesFrom(facts: MemoryFact[], extra: Array<{ platform: string; handle: string; source: string }> = []): WaitlistHandle[] {
  const confirmed = confirmedHandlesFrom(facts);
  const rejected = rejectedHandlesFrom(facts);
  const isRejected = (p: string, h: string) => rejected.some((r) => r.platform === p && r.handle.toLowerCase() === h.toLowerCase());
  const candidates = candidateHandlesFrom(facts, confirmed, extra).filter((c) => !isRejected(c.platform, c.handle));
  const out: WaitlistHandle[] = [];
  for (const p of PUBLIC_PLATFORMS) {
    const c = confirmed[p];
    if (c) {
      const ref = facts.find((f) => f.id === c.factId)?.source.ref ?? "";
      out.push({ platform: p, handle: c.handle, source: ref.startsWith("onboarding/") ? "signup" : "you", status: "confirmed" });
    } else {
      const s = candidates.find((x) => x.platform === p);
      if (s) out.push({ platform: p, handle: s.handle, source: "research", status: "suggested" });
    }
  }
  const seen = new Set<string>();
  for (const r of rejected) {
    const k = `${r.platform}:${r.handle.toLowerCase()}`;
    if (seen.has(k) || confirmed[r.platform]?.handle.toLowerCase() === r.handle.toLowerCase()) continue;
    seen.add(k);
    out.push({ platform: r.platform, handle: r.handle, source: "research", status: "rejected" });
  }
  return out;
}

async function factsAndExtra(athleteId: string) {
  const { db } = await import("../../db");
  const { socialIdentities } = await import("../../../shared/schema");
  const { dbStore } = await import("./dbStore");
  const facts = await dbStore.listFacts(athleteId, ["active"]);
  const ids = await db.select({ platform: socialIdentities.platform, handle: socialIdentities.handle, sourceClass: socialIdentities.source_class, id: socialIdentities.id })
    .from(socialIdentities).where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.status, "active")));
  const extra = ids.filter((r) => r.handle && r.sourceClass !== "connected_verified").map((r) => ({ platform: r.platform, handle: String(r.handle), source: `social_identities/${r.id}` }));
  return { facts, extra, dbStore };
}

/** GET /waitlist/progress `handles`. Reads only. */
export async function waitlistHandles(athleteId: string): Promise<WaitlistHandle[]> {
  const { facts, extra } = await factsAndExtra(athleteId);
  return waitlistHandlesFrom(facts, extra);
}

/**
 * POST /waitlist/handles/:platform { action, handle? }. The handle is the one shown for that platform (the suggestion,
 * or the confirmed one) unless the body names one. Idempotent: confirming what is confirmed, or rejecting what is
 * rejected, writes nothing new (a confirm still refreshes the public reading once).
 *   confirm  confirmHandle: her word as a said fact, then the Business Discovery / YouTube Data API read → measured
 *   reject   her word "that is not my account" as a said fact; a confirmed handle she rejects is superseded by it
 */
export async function actOnWaitlistHandle(athleteId: string, platformRaw: string, body: { action?: unknown; handle?: unknown }, deps: Parameters<typeof confirmHandle>[2] = {}): Promise<{ handles: WaitlistHandle[]; lookup?: HandleLookup; measured?: number }> {
  const platform = String(platformRaw ?? "").toLowerCase() as PublicPlatform;
  if (!(PUBLIC_PLATFORMS as readonly string[]).includes(platform)) throw new HandleError(400, "invalid", "platform must be instagram or youtube");
  const action = String(body.action ?? "");
  if (action !== "confirm" && action !== "reject") throw new HandleError(400, "invalid", "action must be confirm or reject");
  const { facts, extra, dbStore } = await factsAndExtra(athleteId);
  const shown = waitlistHandlesFrom(facts, extra).find((h) => h.platform === platform && h.status !== "rejected");
  const handle = body.handle != null ? cleanHandle(String(body.handle)) : shown?.handle ?? null;
  if (!handle) throw new HandleError(404, "no_handle", `no ${platform} handle to ${action}`);
  if (action === "confirm") {
    const r = await confirmHandle(athleteId, { platform, handle }, deps);
    return { handles: await waitlistHandles(athleteId), lookup: r.lookup, measured: r.measured };
  }
  if (!rejectedHandlesFrom(facts).some((r) => r.platform === platform && r.handle.toLowerCase() === handle.toLowerCase())) {
    const { db } = await import("../../db");
    const { athletes } = await import("../../../shared/schema");
    const [row] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    const name = row?.name ?? "The athlete";
    const [f] = await dbStore.insertFacts(athleteId, [{
      subject: { kind: "athlete", name }, claim: `${name} says @${handle} is not their ${LABEL[platform]} account.`, type: "said",
      source: { ref: NOT_HANDLE_REF(platform), title: "You told us" }, date: new Date().toISOString().slice(0, 10), confidence: 1, runId: null,
    }]);
    const c = confirmedHandlesFrom(facts)[platform];
    if (c && c.handle.toLowerCase() === handle.toLowerCase()) {
      await dbStore.setFactStatus(athleteId, c.factId, "superseded", { supersededBy: f.id });
      // The public readings of an account she now says is not hers are no longer scored (kept as history: removed).
      for (const m of facts) if (m.type === "measured" && isPublicPlatformRef(m.source.ref) && (m.source.ref ?? "").includes(`#${platform}.`)) await dbStore.setFactStatus(athleteId, m.id, "removed");
    }
  }
  return { handles: await waitlistHandles(athleteId) };
}

/** The real lookup: one public API read, stored as the nightly discovery collection stores it (source='discovery'). */
function lookupAndStore(athleteId: string) {
  return async (platform: PublicPlatform, handle: string): Promise<{ outcome: HandleLookup; followers: number | null }> => {
    // Through the registered discovery entry point (acquisitionRegistry "public-platform-discovery").
    const { discoverConfirmedHandle } = await import("../../skills/collectDiscoveryAnalytics");
    const r = await discoverConfirmedHandle(athleteId, platform, handle);
    if (r.status === "written") return { outcome: "found", followers: r.followers ?? null };
    const e = String(r.error ?? "failed");
    const known: HandleLookup[] = ["not_business_account", "not_found", "not_configured", "no_token", "rate_limited", "token_expired"];
    return { outcome: (known as string[]).includes(e) ? (e as HandleLookup) : "failed", followers: null };
  };
}

export class HandleError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
