/**
 * agent/learning/core.ts — the learning loop's arithmetic (design "What works for you", 16 Oct 2026). Pure: no database,
 * no model, no provider. Everything is about ONE athlete's own posts: the athlete's numbers are compared with the
 * athlete's own usual, never with another athlete's, and nothing here names an athlete, sport, school or brand.
 *
 *   groupPosts       the athlete's per-post metric observations (social_metric_observations, entity_type content) → posts
 *   readingAt        a post's numbers about N days after it went up
 *   baselineFor      the athlete's usual: the median of their settled posts on that platform over 90 days, by metric
 *   judge            one reading against the athlete's usual → worked | mixed | did_not_work, with a short plain note
 *   linkPosts        a newly seen post → the plan post action it came from (same platform and format, ±3 days of due)
 *   summarise        the weekly "what works for you": by platform × format, content pillar, timing around an event and
 *                    day of week; each line with medians vs the athlete's usual, n, and `leads` once n ≥ 8
 *   exceptionalPost  the one post worth a message: ≥ 3× the athlete's usual reach or saves, with the caps
 *
 * Calendar days (day of week, event timing, the due-date window, "from Friday") are read in the athlete's phone time
 * zone (the newest push device registration's time zone), UTC when there is none.
 */
import type { Decision } from "../../../shared/agent";
import { LEARNING } from "./config";

const DAY = 86_400_000;

// ─── metrics ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The per-post metrics the loop reads (observation metric_key → the word the athlete reads). */
export const LEARNING_METRICS = {
  reach: "reach",
  save_count: "saves",
  share_count: "shares",
  comments_count: "comments",
  view_count: "views",
} as const;
export type MetricKey = keyof typeof LEARNING_METRICS;
export const METRIC_KEYS = Object.keys(LEARNING_METRICS) as MetricKey[];
/** The order metrics are shown in a note or a summary line. */
const SHOW_ORDER: MetricKey[] = ["save_count", "reach", "share_count", "view_count", "comments_count"];
/** The metrics an exceptional post is judged on (L1: reach or saves). */
const EXCEPTIONAL_METRICS: MetricKey[] = ["save_count", "reach"];

export type Reading = Partial<Record<MetricKey, number>>;

/** One observation row, as the loop reads it. */
export interface ContentObservation {
  athleteId: string;
  platform: string;
  entityId: string;
  entityTime: string | null;
  entityFormat: string | null;
  metricKey: string;
  value: number;
  observedAt: string;
  /** The post's own link, when its library row has one (media_assets.permalink via the observation's asset_id). */
  permalink?: string | null;
}

/** One of the athlete's published posts, with every observation of it. */
export interface Post {
  athleteId: string;
  platform: string;
  entityId: string;
  /** When it went up (ISO). */
  at: string;
  format: string | null;
  /** The post's link, when known: what "I posted it" with a pasted link is matched on (linkPosts, via "link"). */
  permalink: string | null;
  obs: ContentObservation[];
}

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", facebook: "Facebook" };
export const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : "social");
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ms = (iso: string) => Date.parse(iso);

/**
 * The calendar day of an instant in the athlete's time zone: the date (YYYY-MM-DD) and the weekday (0 = Sunday). UTC
 * when the zone is null or not a zone the runtime knows.
 */
export function localDay(iso: string, timeZone: string | null): { date: string; weekday: number } {
  const d = new Date(ms(iso));
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
      if (weekday >= 0) return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday };
    } catch { /* an unknown zone: UTC below */ }
  }
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}

/** Stories and posts live different lives (a story's reach is not a feed post's): each has its own usual. */
export const classOf = (format: string | null) => (format === "story" ? "story" : "post");

/** The athlete's observations → posts, one per (platform, entity). Observations without a posting time, or not the
 * athlete's, are left out. */
export function groupPosts(athleteId: string, obs: ContentObservation[]): Post[] {
  const by = new Map<string, Post>();
  for (const o of obs) {
    if (o.athleteId !== athleteId || !o.entityTime || !Number.isFinite(ms(o.entityTime))) continue;
    if (!(o.metricKey in LEARNING_METRICS) || !Number.isFinite(o.value)) continue;
    const k = `${o.platform}|${o.entityId}`;
    let p = by.get(k);
    if (!p) { p = { athleteId, platform: o.platform, entityId: o.entityId, at: new Date(ms(o.entityTime)).toISOString(), format: o.entityFormat, permalink: o.permalink ?? null, obs: [] }; by.set(k, p); }
    if (!p.format && o.entityFormat) p.format = o.entityFormat;
    if (!p.permalink && o.permalink) p.permalink = o.permalink;
    p.obs.push(o);
  }
  return [...by.values()].sort((a, b) => a.at.localeCompare(b.at) || a.entityId.localeCompare(b.entityId));
}

export const ageDays = (p: Post, now: Date) => (now.getTime() - ms(p.at)) / DAY;

/**
 * A post's numbers about `days` after it went up: per metric, the latest observation up to `days` + the slack (the
 * sync is nightly). A metric first observed later than that (a post linked or ingested late) uses its earliest
 * observation: the closest reading there is.
 */
export function readingAt(p: Post, days: number): Reading {
  const cutoff = ms(p.at) + (days + LEARNING.READING_SLACK_DAYS) * DAY;
  const out: Reading = {};
  for (const key of METRIC_KEYS) {
    const rows = p.obs.filter((o) => o.metricKey === key).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    if (!rows.length) continue;
    const before = rows.filter((o) => ms(o.observedAt) <= cutoff);
    out[key] = (before.length ? before[before.length - 1] : rows[0]).value;
  }
  return out;
}

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export type Baseline = Partial<Record<MetricKey, { median: number; n: number }>>;

/**
 * The athlete's usual on a platform: per metric, the median 7-day reading of the athlete's settled posts on that
 * platform (stories apart from posts) that went up in the last 90 days. `exclude` leaves the post being judged out of
 * its own usual.
 */
export function baselineFor(posts: Post[], platform: string, cls: "story" | "post", now: Date, exclude: string | null = null): Baseline {
  const since = now.getTime() - LEARNING.BASELINE_DAYS * DAY;
  const pool = posts.filter((p) => p.platform === platform && classOf(p.format) === cls && p.entityId !== exclude
    && ms(p.at) >= since && ageDays(p, now) >= LEARNING.SETTLED_DAYS);
  const values = new Map<MetricKey, number[]>();
  for (const p of pool) {
    const r = readingAt(p, LEARNING.SETTLED_DAYS);
    for (const k of METRIC_KEYS) if (r[k] != null) values.set(k, [...(values.get(k) ?? []), r[k]!]);
  }
  const out: Baseline = {};
  for (const [k, v] of values) out[k] = { median: median(v), n: v.length };
  return out;
}

/** A metric can be judged against the athlete's usual only with enough posts behind it and a usual above zero. */
const usable = (b: Baseline, k: MetricKey) => !!b[k] && b[k]!.n >= LEARNING.MIN_BASELINE_POSTS && b[k]!.median > 0;

/** The metric ratios (post ÷ the athlete's usual), for every metric the post has and the usual can judge. */
export function ratiosOf(r: Reading, b: Baseline): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const k of METRIC_KEYS) if (r[k] != null && usable(b, k)) out[k] = r[k]! / b[k]!.median;
  return out;
}

/** "3×", "2.1×", "0.4×", "12×" — rounded DOWN to one decimal, so a number is never overstated. */
export function fmtRatio(r: number): string {
  const v = r >= 10 ? Math.floor(r) : Math.floor(r * 10) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}×`;
}
const phrase = (k: MetricKey, r: number) => `${fmtRatio(r)} your usual ${LEARNING_METRICS[k]}`;

export type Outcome = "worked" | "mixed" | "did_not_work";
export interface Judgement { outcome: Outcome; note: string; ratios: Partial<Record<MetricKey, number>>; score: number }

/**
 * One reading against the athlete's usual. Null when no metric has enough posts behind it (the minimum sample). The
 * verdict reads the MEDIAN of the metric ratios (one great number is not the post): ≥ 1.25 worked, ≤ 0.75 did not
 * work, else mixed. The note names the strongest metric (worked), the weakest (did not work) or both (mixed).
 */
export function judge(r: Reading, b: Baseline): Judgement | null {
  const ratios = ratiosOf(r, b);
  const keys = SHOW_ORDER.filter((k) => ratios[k] != null);
  if (!keys.length) return null;
  const score = median(keys.map((k) => ratios[k]!));
  const best = [...keys].sort((a, c) => ratios[c]! - ratios[a]!)[0];
  const worst = [...keys].sort((a, c) => ratios[a]! - ratios[c]!)[0];
  if (score >= LEARNING.WORKED_AT) return { outcome: "worked", note: phrase(best, ratios[best]!), ratios, score };
  if (score <= LEARNING.DID_NOT_WORK_AT) return { outcome: "did_not_work", note: phrase(worst, ratios[worst]!), ratios, score };
  const note = best === worst ? phrase(best, ratios[best]!) : `${phrase(best, ratios[best]!)}, ${phrase(worst, ratios[worst]!)}`;
  return { outcome: "mixed", note, ratios, score };
}

// ─── link ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the loop stores on a linked post action (memory_decisions.detail.published). */
export interface PublishedDetail {
  platform: string;
  entity_id: string;
  /** When the post went up (ISO). */
  at: string;
  format: string | null;
  /**
   * How the link was made: "link" — the post's own link is the one the athlete pasted with "I posted it"; "time" — same
   * platform and format, within the window around the due date (or the time they said it went up).
   */
  via: "time" | "link";
  linkedAt: string;
  /** The post's own link when the loop knew it: what a link pasted later is checked against (edit.ts). */
  permalink?: string | null;
  /** The post's numbers at about 2 and 7 days, and what each was judged. */
  readings?: Partial<Record<"d2" | "d7", { at: string; metrics: Reading; outcome: Outcome | null; note: string | null; ratios?: Partial<Record<MetricKey, number>> }>>;
}

/** A plan post action, as linking reads it. */
export interface PostAction {
  id: string;
  athleteId: string;
  createdAt: string;
  response: Decision["response"];
  dueOn: string | null;
  platform: string | null;
  format: string | null;
  published: PublishedDetail | null;
  pillar: string | null;
  eventDate: string | null;
  /** "I posted it" (detail.posted, shared/readyQueue.ts): the link they pasted, and when they said it went up. */
  postedLink: string | null;
  postedAt: string | null;
  /** A post kit is built on the action (detail.prepared.postKit). */
  kitBuilt: boolean;
  /** When the kit was built (ISO), when there is one. */
  kitBuiltAt: string | null;
  /** When the athlete tapped "Post it" and the rights sheet passed (detail.approval.at), if they did. */
  approvedAt: string | null;
}

const KNOWN_PLATFORMS = ["instagram", "tiktok", "youtube", "facebook"];
/** "Instagram Reels" → instagram. */
export function normalizePlatform(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  const s = p.toLowerCase();
  return KNOWN_PLATFORMS.find((k) => s.includes(k)) ?? s.trim();
}

/** A post action (kind action, detail.kind post) as linking reads it; null for anything else. */
export function postActionOf(d: Decision): PostAction | null {
  const det = (d.detail ?? {}) as Record<string, any>;
  if ((d.kind ?? "other") !== "action" || det.kind !== "post") return null;
  const kit = det.prepared?.postKit;
  const pub = det.published && typeof det.published.entity_id === "string" ? (det.published as PublishedDetail) : null;
  return {
    id: d.id, athleteId: d.athleteId, createdAt: d.createdAt, response: d.response,
    dueOn: typeof det.dueOn === "string" ? det.dueOn : null,
    platform: normalizePlatform(det.deliverable?.platform),
    format: typeof det.post?.format === "string" ? det.post.format : typeof kit?.idea?.format === "string" ? kit.idea.format : null,
    published: pub,
    pillar: typeof det.idea?.pillar?.name === "string" && det.idea.pillar.name.trim() ? det.idea.pillar.name.trim() : null,
    eventDate: typeof det.event?.date === "string" ? det.event.date : null,
    postedLink: typeof det.posted?.link === "string" ? det.posted.link : null,
    postedAt: typeof det.posted?.at === "string" ? det.posted.at : null,
    kitBuilt: !!kit,
    kitBuiltAt: typeof kit?.builtAt === "string" ? kit.builtAt : null,
    approvedAt: typeof det.approval?.at === "string" ? det.approval.at : null,
  };
}

/**
 * A post's link reduced to what names the post, so a pasted link and a synced permalink compare equal however each was
 * written (www./m., query extras, a trailing slash). Null when it names no post we can tell apart — then nothing links
 * by link. Known shapes, by the post's own id:
 *   Instagram  /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>                       → instagram:<code>
 *   TikTok     /@user/video/<id>, /video/<id>                                            → tiktok:<id>
 *   YouTube    youtube.com/watch?v=<id> (the synced permalink, lib/integrations/youtube.ts), /shorts/<id>, /live/<id>,
 *              /embed/<id>, youtu.be/<id>                                                → youtube:<id>
 *   Facebook   permalink.php?story_fbid=<id>, story.php?story_fbid=<id>, watch/?v=<id>, /<page>/posts/<id>,
 *              /<page>/videos/<id>, /reel/<id>, /share/(p|r|v)/<id>                      → facebook:<id>
 * Any other host keeps its whole path AND its query (sorted), so two different posts on one path never collide. A link
 * carrying a user name or password is never a post link (null).
 */
export function postKeyOf(link: string | null | undefined): string | null {
  if (!link) return null;
  let u: URL;
  try { u = new URL(link.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^(?:www\.|m\.|mobile\.|web\.)/, "");
  const path = u.pathname.replace(/\/+$/, "");
  const q = (k: string) => { const v = u.searchParams.get(k); return v && /^[A-Za-z0-9_-]+$/.test(v) ? v : null; };
  const is = (h: string) => host === h || host.endsWith(`.${h}`);
  if (is("instagram.com")) {
    const m = /\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(path);
    return m ? `instagram:${m[1]}` : null;
  }
  if (is("tiktok.com")) {
    const m = /\/video\/(\d+)/.exec(path);
    return m ? `tiktok:${m[1]}` : null;
  }
  if (host === "youtu.be") {
    const m = /^\/([A-Za-z0-9_-]{6,})$/.exec(path);
    return m ? `youtube:${m[1]}` : null;
  }
  if (is("youtube.com")) {
    if (path === "/watch") { const v = q("v"); return v ? `youtube:${v}` : null; }
    const m = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})$/.exec(path);
    return m ? `youtube:${m[1]}` : null;
  }
  if (is("facebook.com") || host === "fb.watch") {
    if (/^\/(?:permalink|story)\.php$/.test(path)) { const id = q("story_fbid"); return id ? `facebook:${id}` : null; }
    if (path === "/watch") { const v = q("v"); return v ? `facebook:${v}` : null; }
    const m = /\/(?:posts|videos|reel|share\/[prv])\/([A-Za-z0-9_-]+)$/.exec(path);
    return m ? `facebook:${m[1]}` : null;
  }
  const params = [...u.searchParams.entries()].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${host}${path.toLowerCase()}${query}`;
}

export interface Link { actionId: string; post: Post; via: "time" | "link" }

/** The format family linking compares: reel ↔ reel, carousel ↔ carousel, story ↔ story, feed / image / photo / post ↔ feed. */
export function formatClass(f: string | null | undefined): string | null {
  if (!f) return null;
  const v = f.toLowerCase();
  return v === "feed" || v === "image" || v === "photo" || v === "post" ? "feed" : v;
}

const dayDiff = (postDate: string, dueOn: string) => Math.round((Date.parse(`${postDate}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / DAY);

/**
 * Newly seen posts → the post actions they came from. ONE athlete: a post or action that is not the athlete's is never
 * linked. A post links to an action when all hold: the same platform; the same format family (formatClass); the post
 * went up within ±3 days of the action's due date (the post's day in the athlete's time zone); the action existed
 * before the post went up; and the action was not skipped or expired. The nearest due date wins (then the oldest
 * action); each action links at most one post, each post at most one action.
 *
 * With `athleteSaid` (CONTENT_READY_QUEUE on; off = exactly the loop as it was), what "I posted it" said is read too:
 * first a pass by link (via "link") — an action whose "I posted it" carried a link takes the post with that link
 * (postKeyOf), whatever its date or format; then, in the time pass, the day they said it went up stands in for a due
 * date the action does not have.
 */
export function linkPosts(athleteId: string, posts: Post[], actions: PostAction[], timeZone: string | null = null, opts: { athleteSaid?: boolean } = {}): Link[] {
  const said = !!opts.athleteSaid;
  const live = actions.filter((a) => a.athleteId === athleteId && !a.published && a.response !== "skipped" && a.response !== "expired");
  const mine = posts.filter((x) => x.athleteId === athleteId);
  const keyOf = (p: Post) => `${p.platform}|${p.entityId}`;
  const taken = new Set<string>();
  const usedPosts = new Set<string>();
  const links: Link[] = [];
  // 1. by the link they pasted.
  for (const a of said ? live : []) {
    const key = postKeyOf(a.postedLink);
    if (!key) continue;
    const p = mine.find((x) => !usedPosts.has(keyOf(x)) && postKeyOf(x.permalink) === key);
    if (!p) continue;
    taken.add(a.id); usedPosts.add(keyOf(p));
    links.push({ actionId: a.id, post: p, via: "link" });
  }
  // 2. by time, around the due date (or the day they said it went up).
  const refDay = (a: PostAction) => a.dueOn ?? (said && a.postedAt ? localDay(a.postedAt, timeZone).date : null);
  const open = live.filter((a) => !taken.has(a.id) && refDay(a));
  for (const p of mine) {
    if (usedPosts.has(keyOf(p))) continue;
    const fmt = formatClass(p.format);
    if (!fmt) continue;
    const day = localDay(p.at, timeZone).date;
    const cands = open.filter((a) => !taken.has(a.id) && a.platform === p.platform && formatClass(a.format) === fmt
      && ms(p.at) >= ms(a.createdAt) && Math.abs(dayDiff(day, refDay(a)!)) <= LEARNING.LINK_WINDOW_DAYS);
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(dayDiff(day, refDay(a)!)) - Math.abs(dayDiff(day, refDay(b)!)) || refDay(a)!.localeCompare(refDay(b)!) || a.createdAt.localeCompare(b.createdAt));
    taken.add(cands[0].id);
    links.push({ actionId: cands[0].id, post: p, via: "time" });
  }
  return links;
}

/**
 * Whether a link the loop just made may also mark the post kit posted (detail.posted by "learning"), so the athlete
 * never has to say it. Only when it cannot close the wrong kit:
 *   - the kit is READY for you (agent/ready/readiness.ts: open, made, guarded, with media, not resting — the caller
 *     checks that on the row), and
 *   - the link is by the link they pasted (via "link"), or — by time — the post went up AFTER the kit was built AND
 *     after they tapped "Post it" (detail.approval.at): they took it to post, and a post of that format went up.
 * Every other time match stays measurement only (detail.published): a reel up on Thursday never closes Friday's kit
 * they have not taken to post.
 */
export function mayAutoMark(link: Pick<Link, "via" | "post">, a: Pick<PostAction, "kitBuilt" | "kitBuiltAt" | "approvedAt">): boolean {
  if (!a.kitBuilt) return false;
  if (link.via === "link") return true;
  const at = ms(link.post.at);
  return !!a.kitBuiltAt && !!a.approvedAt && at > ms(a.kitBuiltAt) && at > ms(a.approvedAt);
}

// ─── the weekly summary ──────────────────────────────────────────────────────────────────────────────────────────

export const WHAT_WORKS_CONTRACT = "what-works/1" as const;
export type WhatWorksDimension = "platform_format" | "pillar" | "event_timing" | "weekday";

export interface WhatWorksLine {
  dimension: WhatWorksDimension;
  key: string;
  label: string;
  /** How many of the athlete's posts the line rests on. */
  n: number;
  /** The athlete's own data leads this line (n ≥ LEADS_AT); below it the playbook leads and this is an early sign only. */
  leads: boolean;
  /** Per metric: the median of the posts' ratios to the athlete's usual on their platform, and how many posts had it. */
  metrics: Partial<Record<MetricKey, { ratio: number; n: number }>>;
}

export interface WhatWorks {
  contract: typeof WHAT_WORKS_CONTRACT;
  athleteId: string;
  asOf: string;
  /** The zone day of week and event timing were read in (null = UTC). */
  timeZone: string | null;
  windowDays: number;
  leadsAt: number;
  minSample: number;
  /** The athlete's settled posts in the window, linked or not: what everything here rests on. */
  posts: number;
  /** The athlete's usual per platform (stories apart, under "<platform>/story"). */
  baselines: Record<string, Baseline>;
  lines: WhatWorksLine[];
}

const TIMING_LABEL = { before: "Posted before an event", during: "Posted on an event day", after: "Posted after an event" } as const;
export function timingOf(postDate: string, eventDate: string | null): "before" | "during" | "after" | null {
  if (!eventDate) return null;
  return postDate < eventDate ? "before" : postDate === eventDate ? "during" : "after";
}

/**
 * The athlete's "what works for you" (pure): every settled post of the last 90 days, linked to a plan action or not,
 * each compared with the athlete's usual on its platform, grouped four ways. Pillar and event timing come from the plan
 * action a post is linked to (`actionsByEntity`), so only linked posts carry them; platform × format and day of week
 * read every post. Day of week and event timing use the athlete's time zone (UTC when unknown).
 */
export function summarise(athleteId: string, posts: Post[], actionsByEntity: Map<string, PostAction>, now: Date, timeZone: string | null = null): WhatWorks {
  const since = now.getTime() - LEARNING.BASELINE_DAYS * DAY;
  const pool = posts.filter((p) => p.athleteId === athleteId && ms(p.at) >= since && ageDays(p, now) >= LEARNING.SETTLED_DAYS);
  const baselines: Record<string, Baseline> = {};
  const baseKey = (p: Post) => (classOf(p.format) === "story" ? `${p.platform}/story` : p.platform);
  for (const p of pool) if (!baselines[baseKey(p)]) baselines[baseKey(p)] = baselineFor(posts, p.platform, classOf(p.format), now);

  const groups = new Map<string, { dimension: WhatWorksDimension; key: string; label: string; ratios: Array<Partial<Record<MetricKey, number>>> }>();
  const add = (dimension: WhatWorksDimension, key: string, label: string, r: Partial<Record<MetricKey, number>>) => {
    const k = `${dimension}|${key}`;
    if (!groups.has(k)) groups.set(k, { dimension, key, label, ratios: [] });
    groups.get(k)!.ratios.push(r);
  };
  for (const p of pool) {
    const r = ratiosOf(readingAt(p, LEARNING.SETTLED_DAYS), baselines[baseKey(p)]);
    const fmt = p.format ?? "post";
    const local = localDay(p.at, timeZone);
    add("platform_format", `${p.platform}/${fmt}`, `${platformLabel(p.platform)} ${fmt}`, r);
    const a = actionsByEntity.get(`${p.platform}|${p.entityId}`);
    if (a?.pillar) add("pillar", a.pillar.toLowerCase(), a.pillar, r);
    const t = timingOf(local.date, a?.eventDate ?? null);
    if (t) add("event_timing", t, TIMING_LABEL[t], r);
    add("weekday", String(local.weekday), `Posted on ${WEEKDAYS[local.weekday]}`, r);
  }
  const order: WhatWorksDimension[] = ["platform_format", "pillar", "event_timing", "weekday"];
  const lines: WhatWorksLine[] = [...groups.values()].map((g) => {
    const metrics: WhatWorksLine["metrics"] = {};
    for (const k of METRIC_KEYS) {
      const v = g.ratios.map((r) => r[k]).filter((x): x is number => x != null);
      if (v.length) metrics[k] = { ratio: Math.round(median(v) * 100) / 100, n: v.length };
    }
    return { dimension: g.dimension, key: g.key, label: g.label, n: g.ratios.length, leads: g.ratios.length >= LEARNING.LEADS_AT, metrics };
  }).sort((a, b) => order.indexOf(a.dimension) - order.indexOf(b.dimension) || b.n - a.n || a.key.localeCompare(b.key));
  return {
    contract: WHAT_WORKS_CONTRACT, athleteId, asOf: now.toISOString(), timeZone, windowDays: LEARNING.BASELINE_DAYS,
    leadsAt: LEARNING.LEADS_AT, minSample: LEARNING.MIN_BASELINE_POSTS, posts: pool.length, baselines, lines,
  };
}

/** The measured fact's source ref. One '#' and no '.' after it: syncMeasured keys it on its own, and the M.I.A.'s
 * measured-account reader (measuredMetricOf) reads it as no account metric, so it never enters the athlete's M.I.A. */
export const WHAT_WORKS_REF = "agent/learning#what_works_for_you";
export const WHAT_WORKS_SUBJECT = "What works for you";
const CLAIM_MAX = 1900;

/** The summary in plain words, for the athlete's memory (one measured fact): what Mila and the plan read. */
export function summaryClaim(w: WhatWorks): string {
  const head = `From the athlete's own posts in the last ${w.windowDays} days (${w.posts} measured), each compared with the athlete's usual post on that platform:`;
  const parts: string[] = [];
  for (const l of w.lines) {
    const m = SHOW_ORDER.filter((k) => l.metrics[k]).slice(0, 3).map((k) => `${LEARNING_METRICS[k]} ${fmtRatio(l.metrics[k]!.ratio)}`);
    if (!m.length) continue;
    parts.push(`${l.label}: ${m.join(", ")} (${l.n} post${l.n === 1 ? "" : "s"}, ${l.leads ? "the athlete's data leads" : "early sign only"})`);
  }
  if (!parts.length) return `${head} not enough posts on any platform to compare yet (the athlete's usual needs ${w.minSample}).`;
  let out = head;
  for (const p of parts) { if (out.length + p.length + 2 > CLAIM_MAX) break; out += ` ${p};`; }
  return out.replace(/;$/, ".");
}

// ─── what the plan, Understand and chat read ─────────────────────────────────────────────────────────────────────

/** The block title the plan, Understand and chat read the summary under (plan 1.6.0, understand 1.15.0, chat 1.2.0). */
export const WHAT_WORKS_TITLE = "WHAT WORKS FOR THIS ATHLETE";
/** How a line is marked: the athlete's own data leads it (n ≥ LEADS_AT), or it is an early sign only. */
export const WHAT_WORKS_MARK = { leads: "leads", early: "early sign" } as const;

/**
 * The summary lines a model reads: only lines resting on at least SHOW_AT posts with at least one metric judged against
 * the athlete's usual, in the summary's order. With `max`, the leading lines are kept first.
 */
export function whatWorksShown(w: WhatWorks | null | undefined, max: number = Infinity): WhatWorksLine[] {
  if (!w) return [];
  const shown = w.lines.filter((l) => l.n >= LEARNING.SHOW_AT && SHOW_ORDER.some((k) => l.metrics[k]));
  if (shown.length <= max) return shown;
  const keep = new Set([...shown].sort((a, b) => Number(b.leads) - Number(a.leads)).slice(0, max));
  return shown.filter((l) => keep.has(l));
}

/** One line in plain words: "- Instagram reel | saves 1.8×, reach 1.4× the athlete's usual | 9 posts | leads". */
export function whatWorksLine(l: WhatWorksLine): string {
  const m = SHOW_ORDER.filter((k) => l.metrics[k]).slice(0, 3).map((k) => `${LEARNING_METRICS[k]} ${fmtRatio(l.metrics[k]!.ratio)}`);
  return `- ${l.label} | ${m.join(", ")} the athlete's usual | ${l.n} post${l.n === 1 ? "" : "s"} | ${l.leads ? WHAT_WORKS_MARK.leads : WHAT_WORKS_MARK.early}`;
}

/** The rendered lines; none when no line reaches SHOW_AT posts. */
export function whatWorksLines(w: WhatWorks | null | undefined, max: number = Infinity): string[] {
  return whatWorksShown(w, max).map(whatWorksLine);
}

/** The block's heading: what the numbers are and what "leads" means. */
export function whatWorksHeading(w: WhatWorks | null | undefined): string {
  return `${WHAT_WORKS_TITLE} (the athlete's own posts in the last ${w?.windowDays ?? LEARNING.BASELINE_DAYS} days, each against their usual on that platform; "${WHAT_WORKS_MARK.leads}" = ${w?.leadsAt ?? LEARNING.LEADS_AT} or more posts, else an ${WHAT_WORKS_MARK.early})`;
}

// ─── the exceptional post ────────────────────────────────────────────────────────────────────────────────────────

export interface Exceptional { post: Post; metric: MetricKey; ratio: number; value: number; usual: number }

/**
 * The one post worth a message (L1): any of the athlete's posts, linked to a plan action or not, between 2 and 8 days
 * old at ≥ 3× the athlete's usual reach or saves on that platform, the usual resting on enough posts, and at least 5 of
 * the metric. Null when none, when that post already had its message (`celebrated`), or when a message went out in the
 * last 7 days (`lastAt`). The biggest ratio wins.
 */
export function exceptionalPost(posts: Post[], now: Date, prior: { celebrated: Set<string>; lastAt: string | null }): Exceptional | null {
  if (prior.lastAt && now.getTime() - ms(prior.lastAt) < LEARNING.EXCEPTIONAL_EVERY_DAYS * DAY) return null;
  let best: Exceptional | null = null;
  for (const p of posts) {
    const age = ageDays(p, now);
    if (age < LEARNING.CHECKPOINTS[0] || age > LEARNING.EXCEPTIONAL_MAX_AGE_DAYS) continue;
    if (prior.celebrated.has(`${p.platform}|${p.entityId}`)) continue;
    const b = baselineFor(posts, p.platform, classOf(p.format), now, p.entityId);
    const r = readingAt(p, LEARNING.SETTLED_DAYS);
    for (const k of EXCEPTIONAL_METRICS) {
      if (r[k] == null || !usable(b, k) || r[k]! < LEARNING.EXCEPTIONAL_MIN_VALUE) continue;
      const ratio = r[k]! / b[k]!.median;
      if (ratio >= LEARNING.EXCEPTIONAL_RATIO && (!best || ratio > best.ratio)) best = { post: p, metric: k, ratio, value: r[k]!, usual: b[k]!.median };
    }
  }
  return best;
}

const weekdayOf = (e: Exceptional, timeZone: string | null) => WEEKDAYS[localDay(e.post.at, timeZone).weekday];

/** The fixed words around the message (code, never a model; Prompt Register: "Learning loop — exceptional post"). The
 * weekday is the post's day in the athlete's time zone. */
export const EXCEPTIONAL_COPY = {
  chatTitle: "Mila noticed something",
  pushTitle: "One of your posts is taking off",
  suggested: (e: Exceptional, timeZone: string | null) => `Make another post like your ${formatWord(e.post.format)} from ${weekdayOf(e, timeZone)}`,
  message: (e: Exceptional, timeZone: string | null) => `Your ${platformLabel(e.post.platform)} ${formatWord(e.post.format)} from ${weekdayOf(e, timeZone)} got ${fmtRatio(e.ratio)} your usual ${LEARNING_METRICS[e.metric]}. Want another like it this week?`,
  pushBody: (e: Exceptional) => `Your ${formatWord(e.post.format)} got ${fmtRatio(e.ratio)} your usual ${LEARNING_METRICS[e.metric]}.`,
} as const;
function formatWord(f: string | null): string {
  if (!f) return "post";
  return f === "feed" || f === "image" || f === "photo" ? "photo" : f;
}
