/**
 * agent/reads/tools.ts — Mila's READ tools over what Nomila already holds (owner directive 3 Nov 2026: Mila sees and
 * knows everything we have). Four grouped reads, behind MILA_READ_TOOLS (`enabled`; off ⇒ left out of every run):
 *
 *   media_search        read   her library by what is in the picture (services/mediaSearch.ts searchMedia), with the
 *                              analysis already stored per asset: vision tags, brand safe, the curator's keep-or-edit
 *                              note, a clip's shots and a snippet of what is said
 *   posts_performance   read   her recent posts' numbers against her usual, her accounts' trend over the window, and
 *                              what works (agent/learning whatWorksIfOn) — view: overview | recent_posts | accounts |
 *                              what_works
 *   money_summary       read   earned this month / year, coming, holds, refunds, payout account (readFinancialSummary)
 *   whats_next          read   one dated list: deliverables due, meetings on her deals, booked sessions, this week's
 *                              plan actions, dated events, and what waits on her (readWhatMattersNext)
 *
 * The rules every one of them keeps:
 *   - the athlete is the run's (ToolContext), never an argument; every read below filters by it;
 *   - bounded: a default limit and a hard maximum on every list, every text clipped, concise by default;
 *   - no raw rows: each result is a small view built here (no URLs, no storage paths, no embeddings, no buyer or
 *     sender contact details, no other person's data); no card (no card type fits yet: the reply describes);
 *   - nothing is written, sent or moved; an empty or failed read says so in words the model can act on.
 */
import { z } from "zod";
import { readGoals } from "../plan/goals";
import { isoDay } from "../plan/input";
import { LEARNING_METRICS, platformLabel, whatWorksLines, type Baseline, type WhatWorks } from "../learning/core";
import type { AgentStore } from "../research/store";
import { errorResult, okResult, type AgentTool, type ToolContext } from "../tools";
import type { SearchResult } from "../../services/mediaSearch";
import type { FinancialSummary, MoneyLine, NextCandidate } from "../../../shared/meSummaries";
import {
  MEDIA_SEARCH_ARGS, MEDIA_SEARCH_DESCRIPTION, MONEY_SUMMARY_ARGS, MONEY_SUMMARY_DESCRIPTION, POSTS_PERFORMANCE_ARGS,
  POSTS_PERFORMANCE_DESCRIPTION, WHATS_NEXT_ARGS, WHATS_NEXT_DESCRIPTION,
} from "./prompts";
import { milaReadToolsEnabled, type PostRow, type ReadsSource } from "./source";

const DAY = 86_400_000;
export const DETAILS = ["concise", "detailed"] as const;
export type Detail = (typeof DETAILS)[number];
export const MEDIA_TYPES = ["photo", "video", "any"] as const;
export const POSTS_VIEWS = ["overview", "recent_posts", "accounts", "what_works"] as const;
export type PostsView = (typeof POSTS_VIEWS)[number];
export const MONEY_PERIODS = ["this_month", "this_year"] as const;

/** The bounds (defaults and hard maximums). Tests read them. */
export const READS_LIMITS = {
  media: { default: 5, max: 8, pool: 24 },
  posts: { default: 5, max: 10, daysDefault: 30, daysMin: 7, daysMax: 90, patterns: 5, overviewPosts: 3, overviewPatterns: 3 },
  money: { default: 3, max: 10 },
  next: { default: 8, max: 15, daysDefault: 7, daysMax: 60 },
  textChars: 160,
} as const;

const OFF = "not_available: this read is not switched on. Say you can't look that up from chat yet.";
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: unknown, n: number = READS_LIMITS.textChars) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (cents: number, currency: string) => {
  const v = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return currency.toLowerCase() === "usd" ? `$${v}` : `${v} ${currency.toUpperCase()}`;
};
const nowOf = (ctx: ToolContext) => (ctx.turn?.today && DAY_RE.test(ctx.turn.today) ? new Date(`${ctx.turn.today}T12:00:00Z`) : new Date());
const detailArg = (text: string) => z.enum(DETAILS).optional().describe(text);

// ─── media_search ──────────────────────────────────────────────────────────────────────────────────────────────────

const FROM: Record<string, string> = { connected: "their post", discovery: "found publicly", upload: "their upload", generated: "made in Studio" };
const IN_IT: Record<string, string> = { the_athlete: "them", another_person: "someone else", nobody: "nobody" };
const CURATOR: Record<string, string> = { as_is: "use as is", crop: "crop first", enhance: "enhance first", reject: "not usable" };

/** One hit as the model reads it: the stored analysis, clipped. Never a URL, a storage path or an embedding. */
export function mediaView(r: SearchResult, detail: Detail) {
  const t = (r.tags ?? null) as (Record<string, any> | null);
  const video = r.playable || /^(VIDEO|REELS)$/i.test(r.mediaType);
  const speech = t?.speech as { has_speech?: boolean; transcript?: Array<{ text?: string }> } | undefined;
  const beats = Array.isArray(t?.beats) ? (t!.beats as Array<{ description?: string }>) : [];
  const said = speech?.has_speech ? clip((speech.transcript ?? []).map((s) => s.text ?? "").join(" "), 140) : "";
  const curatorNote = t ? `${CURATOR[String(t.disposition)] ?? "not judged"}${t.edit_note ? `: ${clip(t.edit_note, 100)}` : ""}` : null;
  return {
    id: r.id,
    type: video ? "video" : "photo",
    posted: day(r.postedAt),
    from: FROM[r.origin] ?? r.origin,
    what: t ? clip(t.description) : "(not looked at yet)",
    shot: t?.shot_type ?? null,
    in_it: t?.subject ? IN_IT[String(t.subject)] ?? null : t ? (t.athlete_present ? "them" : "unsure") : null,
    brands: Array.isArray(t?.brands_visible) ? (t!.brands_visible as string[]).slice(0, 5).map((b) => clip(b, 40)) : [],
    brand_safe: t && typeof t.brand_safe === "boolean" ? t.brand_safe : null,
    quality: typeof t?.aesthetic_quality === "number" ? Math.round(t.aesthetic_quality * 100) / 100 : null,
    ...(r.views ? { views: r.views } : {}),
    curator: curatorNote,
    ...(video ? { clip: { shots: beats.length, ...(said ? { said } : {}) } } : {}),
    ...(detail === "detailed" && t ? {
      setting: clip(t.setting, 80), vibe: clip(t.vibe, 80), curator_reason: clip(t.reason, 140),
      ...(video && beats.length ? { first_shots: beats.slice(0, 3).map((b) => clip(b.description, 80)) } : {}),
    } : {}),
  };
}

function mediaSearchTool(source: ReadsSource): AgentTool {
  const A = MEDIA_SEARCH_ARGS;
  return {
    name: "media_search", kind: "ours", permission: "read", description: MEDIA_SEARCH_DESCRIPTION, enabled: milaReadToolsEnabled,
    args: z.object({
      query: z.string().min(2).max(200).describe(A.query),
      type: z.enum(MEDIA_TYPES).optional().describe(A.type),
      posted_after: z.string().regex(DAY_RE).optional().describe(A.posted_after),
      posted_before: z.string().regex(DAY_RE).optional().describe(A.posted_before),
      brand: z.string().min(2).max(80).optional().describe(A.brand),
      brand_safe_only: z.boolean().optional().describe(A.brand_safe_only),
      has_people: z.boolean().optional().describe(A.has_people),
      limit: z.number().int().min(1).max(READS_LIMITS.media.max).optional().describe(A.limit),
      detail: detailArg(A.detail),
    }),
    async execute(ctx: ToolContext, a: {
      query: string; type?: (typeof MEDIA_TYPES)[number]; posted_after?: string; posted_before?: string; brand?: string;
      brand_safe_only?: boolean; has_people?: boolean; limit?: number; detail?: Detail;
    }) {
      if (!milaReadToolsEnabled()) return errorResult(OFF);
      if (a.posted_after && a.posted_before && a.posted_after > a.posted_before) return errorResult("posted_after is later than posted_before: swap them or drop one");
      const limit = Math.min(a.limit ?? READS_LIMITS.media.default, READS_LIMITS.media.max);
      const hits = await source.searchMedia(ctx.athleteId, {
        query: oneLine(a.query),
        k: limit,
        filters: {
          notDeleted: true,
          ...(a.type && a.type !== "any" ? { kind: a.type } : {}),
          ...(a.posted_after ? { postedAfter: new Date(`${a.posted_after}T00:00:00Z`) } : {}),
          ...(a.posted_before ? { postedBefore: new Date(`${a.posted_before}T23:59:59Z`) } : {}),
          ...(a.brand ? { brandVisible: oneLine(a.brand) } : {}),
          ...(a.brand_safe_only ? { brandSafe: true, markedBrandSafe: true } : {}),
          ...(a.has_people != null ? { people: a.has_people } : {}),
        },
      });
      const media = hits.slice(0, limit).map((h) => mediaView(h, a.detail ?? "concise"));
      return okResult({
        query: clip(a.query, 200), count: media.length, media,
        note: media.length
          ? "Best match first. They can't see these from here: describe a pick by what is in it and when it was posted. Anything marked not brand safe or not usable stays out of a brand pick."
          : "Nothing in their library matches. Say so; if they shot it recently, offer check_camera_roll.",
      });
    },
  };
}

// ─── posts_performance ─────────────────────────────────────────────────────────────────────────────────────────────

/** A post's metric (observation key) from the stored counts. */
function postMetrics(p: PostRow): Partial<Record<keyof typeof LEARNING_METRICS, number>> {
  const out: Partial<Record<keyof typeof LEARNING_METRICS, number>> = {};
  if (p.insights.reach != null) out.reach = p.insights.reach;
  if (p.insights.saved != null) out.save_count = p.insights.saved;
  if (p.insights.shares != null) out.share_count = p.insights.shares;
  if (p.insights.video_views != null) out.view_count = p.insights.video_views;
  if (p.comments != null) out.comments_count = p.comments;
  return out;
}

/** "reach 1.4× their usual" lines, against the learning loop's per-platform usual (its baselines). */
function vsUsual(p: PostRow, baselines: Record<string, Baseline> | undefined): string[] {
  const b = baselines?.[p.platform];
  if (!b) return [];
  const m = postMetrics(p);
  const out: string[] = [];
  for (const k of ["reach", "save_count", "view_count", "share_count", "comments_count"] as const) {
    const usual = b[k]?.median;
    if (m[k] == null || !usual) continue;
    out.push(`${LEARNING_METRICS[k]} ${(Math.round((m[k]! / usual) * 10) / 10).toFixed(1)}× their usual`);
    if (out.length >= 2) break;
  }
  return out;
}

function postView(p: PostRow, ww: WhatWorks | null, detail: Detail) {
  const m = postMetrics(p);
  const numbers: Record<string, number> = {};
  if (p.likes != null) numbers.likes = p.likes;
  for (const [k, v] of Object.entries(m)) numbers[LEARNING_METRICS[k as keyof typeof LEARNING_METRICS]] = v;
  const usual = vsUsual(p, ww?.baselines);
  return {
    id: p.id, platform: platformLabel(p.platform), format: oneLine(p.mediaType).toLowerCase().replace(/_/g, " ") || "post",
    posted: day(p.postedAt), numbers,
    ...(usual.length ? { against_usual: usual.join(", ") } : {}),
    ...(detail === "detailed" && p.caption ? { caption_start: clip(p.caption, 80) } : {}),
  };
}

function postsPerformanceTool(source: ReadsSource): AgentTool {
  const A = POSTS_PERFORMANCE_ARGS;
  const L = READS_LIMITS.posts;
  return {
    name: "posts_performance", kind: "ours", permission: "read", description: POSTS_PERFORMANCE_DESCRIPTION, enabled: milaReadToolsEnabled,
    args: z.object({
      view: z.enum(POSTS_VIEWS).optional().describe(A.view),
      days: z.number().int().min(L.daysMin).max(L.daysMax).optional().describe(A.days),
      limit: z.number().int().min(1).max(L.max).optional().describe(A.limit),
      detail: detailArg(A.detail),
    }),
    async execute(ctx: ToolContext, a: { view?: PostsView; days?: number; limit?: number; detail?: Detail }) {
      if (!milaReadToolsEnabled()) return errorResult(OFF);
      const view = a.view ?? "overview";
      const detail = a.detail ?? "concise";
      const days = Math.min(Math.max(a.days ?? L.daysDefault, L.daysMin), L.daysMax);
      const now = nowOf(ctx);
      const since = new Date(now.getTime() - days * DAY);
      const wantPosts = view === "overview" || view === "recent_posts";
      const wantAccounts = view === "overview" || view === "accounts";
      const postLimit = Math.min(a.limit ?? (view === "overview" ? L.overviewPosts : L.default), L.max);
      // what works carries the per-platform usual the posts are compared with, so it is read for posts too (not for
      // the accounts view, which needs neither).
      const [ww, posts, accounts] = await Promise.all([
        view === "accounts" ? Promise.resolve(null) : source.whatWorks(ctx.athleteId, now).catch(() => null),
        wantPosts ? source.recentPosts(ctx.athleteId, { since, limit: postLimit }) : Promise.resolve([] as PostRow[]),
        wantAccounts ? source.accountTrend(ctx.athleteId, { since }) : Promise.resolve([]),
      ]);
      const out: Record<string, unknown> = { view, window_days: days };
      if (wantAccounts) {
        out.accounts = accounts.map(({ platform, newest, oldest }) => ({
          platform: platformLabel(platform), as_of: newest.day,
          followers: newest.followers,
          ...(newest.followers != null && oldest.followers != null && oldest.day !== newest.day ? { followers_change: newest.followers - oldest.followers, since: oldest.day } : {}),
          ...(newest.engagementRate != null ? { engagement_rate_pct: Math.round(newest.engagementRate * 100) / 100 } : {}),
          ...(newest.avgReach != null ? { avg_reach_per_post: newest.avgReach } : {}),
          ...(newest.avgViews != null ? { avg_views_per_post: newest.avgViews } : {}),
          ...(newest.postsLast30d != null ? { posts_last_30_days: newest.postsLast30d } : {}),
          ...(detail === "detailed" && (newest.topCountry || newest.topAgeRange) ? { top_audience: [newest.topCountry, newest.topAgeRange].filter(Boolean).map((s) => clip(s, 40)).join(", ") } : {}),
        }));
      }
      if (wantPosts) out.posts = posts.map((p) => postView(p, ww, detail));
      if (view !== "accounts") {
        const max = view === "what_works" ? L.patterns : L.overviewPatterns;
        const lines = whatWorksLines(ww, max).map((l) => l.replace(/^- /, "").replace(/the athlete's usual/g, "their usual"));
        out.what_works = ww
          ? { posts_measured: ww.posts, window_days: ww.windowDays, lines: lines.length ? lines : ["not enough posts measured yet to see a pattern"] }
          : { lines: ["not available: what works is not being measured for them yet"] };
      }
      const nothing = (!wantPosts || !posts.length) && (!wantAccounts || !accounts.length) && !whatWorksLines(ww, 1).length;
      if (nothing) {
        out.note = "No numbers on record for this window. If CONNECTED shows no social account, offer to connect one. Never estimate them.";
      } else {
        out.note = "Numbers are as their accounts reported them; \"leads\" = enough of their own posts, \"early sign\" = too few to rely on.";
      }
      return okResult(out);
    },
  };
}

// ─── money_summary ─────────────────────────────────────────────────────────────────────────────────────────────────

const STAGE: Record<string, string> = {
  awaiting_delivery: "waiting on their delivery", awaiting_confirmation: "waiting on the brand's confirmation",
  in_review: "in review", after_booking: "after the session",
};

function moneyLine(l: MoneyLine) {
  return {
    from: clip(l.label || (l.source === "booking" ? "a booking" : "a deal"), 80), amount: money(l.amountCents, l.currency),
    on: day(l.at), ...(l.stage ? { stage: STAGE[l.stage] ?? l.stage } : {}), ...(l.direct ? { paid_directly_by_brand: true } : {}),
    ...(l.dealId ? { deal_id: l.dealId } : {}), ...(l.bookingId ? { booking_id: l.bookingId } : {}),
  };
}

function moneySummaryTool(source: ReadsSource): AgentTool {
  const A = MONEY_SUMMARY_ARGS;
  const L = READS_LIMITS.money;
  return {
    name: "money_summary", kind: "ours", permission: "read", description: MONEY_SUMMARY_DESCRIPTION, enabled: milaReadToolsEnabled,
    args: z.object({
      period: z.enum(MONEY_PERIODS).optional().describe(A.period),
      limit: z.number().int().min(1).max(L.max).optional().describe(A.limit),
      detail: detailArg(A.detail),
    }),
    async execute(ctx: ToolContext, a: { period?: (typeof MONEY_PERIODS)[number]; limit?: number; detail?: Detail }) {
      if (!milaReadToolsEnabled()) return errorResult(OFF);
      const now = nowOf(ctx);
      const f: FinancialSummary = await source.money(ctx.athleteId, now);
      const limit = Math.min(a.limit ?? L.default, L.max);
      const period = a.period ?? "this_year";
      const from = period === "this_month" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const paid = f.payouts.paid.filter((l) => l.at && Date.parse(l.at) >= from.getTime());
      if (!f.hasMoney) {
        return okResult({ has_money: false, payout_account: f.account.state, note: "No money is on record in Nomila yet: no payments, holds or refunds. Say so plainly; never guess an amount." });
      }
      return okResult({
        has_money: true,
        currency: f.currency.toUpperCase(),
        earned_this_month: money(f.paidMonthCents, f.currency),
        earned_this_year: money(f.paidYearCents, f.currency),
        coming: money(f.comingCents, f.currency),
        payout_account: f.account.state === "active" ? "set up" : f.account.state === "pending" ? `not finished${f.account.requirementsDue ? ` (${f.account.requirementsDue} item${f.account.requirementsDue === 1 ? "" : "s"} due)` : ""}` : "not set up",
        period,
        paid: { count: paid.length, lines: paid.slice(0, limit).map(moneyLine) },
        upcoming: { count: f.payouts.upcoming.length, lines: f.payouts.upcoming.slice(0, limit).map(moneyLine) },
        ...(a.detail === "detailed" ? {
          holds: { count: f.holds.length, lines: f.holds.slice(0, limit).map(moneyLine) },
          refunds: { this_year: f.refunds.countYear, total: money(f.refunds.cents, f.currency), lines: f.refunds.items.slice(0, limit).map(moneyLine) },
        } : { holds: f.holds.length, refunds_this_year: f.refunds.countYear }),
        note: "Read only: nothing can be paid, invoiced or moved from chat. Lists are capped; the earned totals count everything.",
      });
    },
  };
}

// ─── whats_next ────────────────────────────────────────────────────────────────────────────────────────────────────

interface NextItem { date: string | null; overdue?: boolean; what: string; kind: string; [k: string]: unknown }

const NEXT_KIND: Record<string, string> = {
  booking_request: "a booking request to answer", serious_offer: "an offer with a deposit held", deal_waiting: "a deal waiting on them",
  payout_setup: "set up their payout account", money_paid: "a payment came in", mila_suggestion: "a suggestion from you to answer",
};

function nextItemOf(c: NextCandidate, detail: Detail): NextItem | null {
  if (c.kind === "money_paid" || c.kind === "card_views") return null;
  const target = c.target as { screen: string; opportunityId?: string; dealId?: string | null; id?: string };
  return {
    date: day(c.dueAt), kind: c.kind === "booking_request" ? "booking" : c.kind === "payout_setup" ? "money" : c.kind === "mila_suggestion" ? "suggestion" : "deal",
    what: `${NEXT_KIND[c.kind] ?? c.kind}${c.brandName ? `: ${clip(c.brandName, 60)}` : c.title ? `: ${clip(c.title, 80)}` : ""}${c.need ? ` (${clip(c.need, 60)})` : ""}`,
    ...(target.dealId ? { deal_id: target.dealId } : {}), ...(target.screen === "booking" && target.id ? { booking_id: target.id } : {}),
    ...(detail === "detailed" && c.why ? { why: clip(c.why, 120) } : {}),
  };
}

function whatsNextTool(source: ReadsSource, store: AgentStore): AgentTool {
  const A = WHATS_NEXT_ARGS;
  const L = READS_LIMITS.next;
  return {
    name: "whats_next", kind: "ours", permission: "read", description: WHATS_NEXT_DESCRIPTION, enabled: milaReadToolsEnabled,
    args: z.object({
      days: z.number().int().min(1).max(L.daysMax).optional().describe(A.days),
      limit: z.number().int().min(1).max(L.max).optional().describe(A.limit),
      detail: detailArg(A.detail),
    }),
    async execute(ctx: ToolContext, a: { days?: number; limit?: number; detail?: Detail }) {
      if (!milaReadToolsEnabled()) return errorResult(OFF);
      const detail = a.detail ?? "concise";
      const now = nowOf(ctx);
      const today = isoDay(now);
      const days = Math.min(a.days ?? L.daysDefault, L.daysMax);
      const until = isoDay(new Date(now.getTime() + days * DAY));
      const limit = Math.min(a.limit ?? L.default, L.max);
      const failed: string[] = [];
      const safe = <T,>(label: string, p: Promise<T>, empty: T) => p.catch(() => { failed.push(label); return empty; });
      const [next, deliverables, meetings, bookings, goals] = await Promise.all([
        safe("deals and money", source.next(ctx.athleteId, now), { version: "what-matters-next/0.1" as const, items: [], waiting: 0 }),
        safe("deliverables", source.deliverables(ctx.athleteId), []),
        safe("meetings", source.meetings(ctx.athleteId, { fromDay: today, toDay: until }), []),
        safe("bookings", source.bookings(ctx.athleteId), null),
        safe("plan", readGoals(ctx.athleteId, { store, now }), null),
      ]);
      const inWindow = (d: string | null) => !!d && d <= until;
      const items: NextItem[] = [];
      for (const d of deliverables) {
        if (!d.dueOn || !inWindow(d.dueOn)) continue;   // undated ones are counted below; overdue ones stay in
        items.push({
          date: d.dueOn, ...(d.dueOn < today ? { overdue: true } : {}), kind: "deliverable",
          what: `${clip(d.campaign, 80)} for ${clip(d.brandName, 60)}${d.optional ? " (optional)" : ""}`, deal_id: d.dealId,
          ...(detail === "detailed" ? { format: clip(d.format, 40), progress: `${d.delivered} of ${d.total} done` } : {}),
        });
      }
      for (const m of meetings) {
        items.push({ date: m.start.date, kind: "meeting", what: `${m.event === "updated" ? "Call (moved)" : "Call"}${m.brand ? ` with ${clip(m.brand, 60)}` : ""}${m.start.time ? ` at ${m.start.time}${m.start.tz ? ` ${clip(m.start.tz, 30)}` : ""}` : ""}`, ...(m.dealId ? { deal_id: m.dealId } : {}) });
      }
      for (const b of bookings?.upcoming ?? []) {
        const d = day(b.startsAt);
        if (!d || d < today || !inWindow(d)) continue;
        items.push({ date: d, kind: "session", what: `${clip(b.title, 80)} at ${b.startsAt!.slice(11, 16)} UTC`, booking_id: b.id });
      }
      for (const g of goals?.goals ?? []) for (const act of g.actions) {
        if (act.state === "done" || !act.dueOn || !inWindow(act.dueOn)) continue;
        items.push({ date: act.dueOn, ...(act.dueOn < today ? { overdue: true } : {}), kind: "plan", what: clip(act.title, 100) });
      }
      for (const e of goals?.comingUp ?? []) {
        if (e.date < today || !inWindow(e.date) || e.precision !== "day") continue;
        items.push({ date: e.date, kind: "event", what: clip(e.label, 80) });
      }
      for (const c of next.items) {
        const it = nextItemOf(c, detail);
        if (it && (!it.date || inWindow(it.date))) items.push(it);
      }
      // Dated first (overdue, then soonest), then what waits on them with no date, in Home's order.
      const dated = items.filter((i) => i.date).sort((x, y) => String(x.date).localeCompare(String(y.date)));
      const undated = items.filter((i) => !i.date);
      const all = [...dated, ...undated];
      const undatedDeliverables = deliverables.filter((d) => !d.dueOn).length;
      return okResult({
        today, through: until, count: all.length, items: all.slice(0, limit),
        ...(all.length > limit ? { more: all.length - limit } : {}),
        ...(undatedDeliverables ? { deliverables_without_a_date: undatedDeliverables } : {}),
        ...(failed.length ? { not_read: failed } : {}),
        note: all.length ? "Only dates on record. An item marked overdue is past its date." : `Nothing dated on record through ${until}. Say so; never invent a deadline.`,
      });
    },
  };
}

export function readTools(source: ReadsSource, store: AgentStore): AgentTool[] {
  return [mediaSearchTool(source), postsPerformanceTool(source), moneySummaryTool(source), whatsNextTool(source, store)];
}
