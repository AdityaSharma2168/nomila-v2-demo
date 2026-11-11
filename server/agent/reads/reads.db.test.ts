/**
 * reads.db.test.ts — Mila's read tools (agent/reads/tools.ts) over the REAL services on PGlite (dbReadsSource): two
 * made-up athletes, each with a library, posts, account snapshots, money, a deliverable and a meeting. No provider:
 * the query embedding is mocked, and URL signing must never be called. Nothing here names a real person or brand.
 *
 *   R1  tenancy: each tool returns only the run's athlete's rows (the other athlete's asset, post, money, deliverable
 *       and meeting never appear), and no tool takes an athlete id
 *   R2  bounds: default limits, hard maximums in the schemas, clipped text
 *   R3  no raw rows: no storage path, URL, embedding or caption beyond the clip; media_search signs no URL
 *   R4  the flag: off ⇒ every read tool is left out of the chat run and refuses if called
 *   R5  filters: type, dates, brand, brand safe, people
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaEmbed", () => ({
  ...jest.requireActual("../../lib/mediaEmbed"),
  embedText: jest.fn(async () => [1, 0, 0, 0, 0, 0, 0, 0]),
}));
jest.mock("../../lib/mediaStore", () => ({
  ...jest.requireActual("../../lib/mediaStore"),
  signedUrl: jest.fn(async () => { throw new Error("media_search must never sign a URL"); }),
}));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dealDeliverables, deals, inboxThreads, mediaAssets, payments, socialAnalyticsSnapshots } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { signedUrl } from "../../lib/mediaStore";
import { dbStore } from "../research/dbStore";
import { createDefaultRegistry } from "../coreTools";
import { loadJob } from "../jobs";
import { visibleTools, passSkill } from "../engine/tools/registry";
import type { AgentTool, ToolContext } from "../tools";
import { dbReadsSource } from "./dbSource";
import { READS_LIMITS, readTools } from "./tools";

const TODAY = "2026-10-20";
let A = "";
let B = "";
const ids: Record<string, string> = {};

const tags = (o: Record<string, unknown> = {}) => ({
  athlete_present: true, subject: "the_athlete", athlete_prominence: 0.8, shot_type: "action", description: "Sprinting at the line",
  brands_visible: [] as string[], aesthetic_quality: 0.8, brand_safe: true, setting: "track", attire: "kit", vibe: "focused",
  hero_suitability: 0.7, disposition: "as_is", edit_note: "", reason: "sharp and clear", ...o,
});

async function asset(athleteId: string, o: { key: string; posted: string; mt?: string; ct?: string; emb?: number[]; vision?: Record<string, unknown>; origin?: string; caption?: string; insights?: Record<string, number>; likes?: number }) {
  const [r] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "instagram", origin: o.origin ?? "connected", source_media_id: `${o.key}-${randomUUID().slice(0, 6)}`,
    media_type: o.mt ?? "IMAGE", posted_at: new Date(`${o.posted}T10:00:00Z`), like_count: o.likes ?? 10, comments_count: 2,
    insights: o.insights ?? null, caption: o.caption ?? null,
    gcs_path: `athletes/${athleteId}/${o.key}.jpg`, content_type: o.ct ?? "image/jpeg", status: "stored",
    metadata: { vision: o.vision ?? tags(), embedding: o.emb ?? [0, 1, 0] },
  } as any).returning({ id: mediaAssets.id });
  ids[o.key] = r.id;
  return r.id;
}

/** An 8-dimension embedding with weight on the given axes (every pair below stays under the near-duplicate threshold). */
const vec = (w: Record<number, number>) => Array.from({ length: 8 }, (_, i) => w[i] ?? 0);

async function seedWorld(athleteId: string, tag: string, brand: string) {
  await asset(athleteId, { key: `${tag}-best`, posted: "2026-10-10", emb: vec({ 0: 1 }), vision: tags({ description: `${tag} celebrating the win`, brands_visible: [brand] }), insights: { reach: 900, saved: 40 }, caption: `${tag} caption ${"long words ".repeat(20)}` });
  await asset(athleteId, { key: `${tag}-clip`, posted: "2026-10-05", mt: "REELS", ct: "video/mp4", emb: vec({ 0: 0.6, 1: 0.8 }), vision: { ...tags({ description: `${tag} warm-up clip`, shot_type: "action" }), beats: [{ description: "lacing up" }, { description: "first stride" }], speech: { has_speech: true, transcript: [{ text: "let's go" }, { text: "big day" }] } }, insights: { reach: 400, video_views: 1200 } });
  await asset(athleteId, { key: `${tag}-unsafe`, posted: "2026-09-01", emb: vec({ 0: 0.5, 2: 0.866 }), vision: tags({ description: `${tag} party night`, brand_safe: false }) });
  await asset(athleteId, { key: `${tag}-empty`, posted: "2026-08-01", emb: vec({ 0: 0.3, 3: 0.954 }), vision: tags({ description: `${tag} empty stadium`, subject: "nobody", athlete_present: false }) });
  for (let i = 0; i < 4; i++) await asset(athleteId, { key: `${tag}-extra${i}`, posted: `2026-09-1${i}`, emb: vec({ [4 + i]: 1 }), vision: tags({ description: `${tag} ${"x".repeat(400)} ${i}` }) });

  for (const [day, followers] of [["2026-09-22", 1000], ["2026-10-19", 1100]] as const) {
    await db.insert(socialAnalyticsSnapshots).values({ athlete_id: athleteId, platform: "instagram", snapshot_date: new Date(`${day}T06:00:00Z`), snapshot_day: day, followers, avg_engagement_rate: 4.25, avg_reach_per_post: 700, posts_last_30d: 6, top_audience_country: "US" } as any);
  }

  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: brand, status: "accepted", source: "self_reported" } as any).returning({ id: deals.id });
  ids[`${tag}-deal`] = d.id;
  await db.insert(payments).values({ deal_id: d.id, athlete_id: athleteId, kind: "deal_payment", status: "settled", deal_value_cents: tag === "a" ? 125_000 : 999_900, brand_total_cents: 130_000, updated_at: new Date(`${TODAY}T09:00:00Z`), created_at: new Date("2026-09-01T00:00:00Z") } as any);
  await db.insert(payments).values({ deal_id: d.id, athlete_id: athleteId, kind: "deal_payment", status: "funded", deal_value_cents: 50_000, brand_total_cents: 52_000, created_at: new Date("2026-10-01T00:00:00Z") } as any);
  const [dl] = await db.insert(dealDeliverables).values({ deal_id: d.id, seq: 1, format: "reel", campaign: `${tag} launch reel`, due_on: "2026-10-23" } as any).returning({ id: dealDeliverables.id });
  ids[`${tag}-deliverable`] = dl.id;
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, subject: "Intro call", status: "deal_detected",
    classification: { meeting: { state: "matched", event: "invited", start: { date: "2026-10-22", time: "15:00", tz: "PDT" }, title: "secret invite words", deal_id: d.id, source_message_ids: [], observed_at: TODAY } },
  } as any).returning({ id: inboxThreads.id });
  ids[`${tag}-meeting`] = t.id;
}

const ctx = (athleteId: string): ToolContext => ({
  athleteId, runId: randomUUID(), skillId: "chat",
  turn: { factKeys: new Map(), conversationId: null, offeredConnectors: [], today: TODAY },
});
const tools = () => Object.fromEntries(readTools(dbReadsSource, dbStore).map((t) => [t.name, t])) as Record<string, AgentTool>;
const run = async (name: string, athleteId: string, args: Record<string, unknown> = {}) => {
  const t = tools()[name];
  const parsed = t.args.parse(args);
  return (await t.execute!(ctx(athleteId), parsed)) as Record<string, any>;
};

beforeAll(async () => {
  process.env.MILA_READ_TOOLS = "true";
  await initTestDb();
  A = await seedAthlete("Rowan Vale");
  B = await seedAthlete("Other Person");
  await seedWorld(A, "a", "Northpeak");
  await seedWorld(B, "b", "Southgale");
}, 120_000);
afterAll(async () => {
  delete process.env.MILA_READ_TOOLS;
  await closeTestDb();
});

describe("R1: each tool reads only the run's athlete", () => {
  it("no tool takes an athlete id", () => {
    for (const t of Object.values(tools())) expect(Object.keys((t.args as any).shape).filter((k) => /athlete/i.test(k))).toEqual([]);
  });

  it("media_search: A's library only, best match first, with the stored analysis", async () => {
    const r = await run("media_search", A, { query: "celebrating" });
    expect(r.status).toBe("ok");
    const got = r.media.map((m: any) => m.id);
    expect(got[0]).toBe(ids["a-best"]);
    expect(got.some((id: string) => Object.entries(ids).some(([k, v]) => k.startsWith("b-") && v === id))).toBe(false);
    expect(r.media[0]).toMatchObject({ type: "photo", posted: "2026-10-10", from: "their post", in_it: "them", brands: ["Northpeak"], brand_safe: true, curator: "use as is" });
    const clip = r.media.find((m: any) => m.id === ids["a-clip"]);
    expect(clip).toMatchObject({ type: "video", clip: { shots: 2, said: "let's go big day" } });
    expect(JSON.stringify(await run("media_search", B, { query: "celebrating" }))).not.toContain("a celebrating");
  });

  it("posts_performance: A's posts and account only", async () => {
    const r = await run("posts_performance", A, { view: "overview" });
    const text = JSON.stringify(r);
    expect(r.accounts).toEqual([expect.objectContaining({ platform: "Instagram", followers: 1100, followers_change: 100, since: "2026-09-22", engagement_rate_pct: 4.25 })]);
    // 30 days by default: the two posts since 20 Sep; over 90 days the overview still shows only its three.
    expect(r.posts.map((p: any) => p.id)).toEqual([ids["a-best"], ids["a-clip"]]);
    expect((await run("posts_performance", A, { view: "overview", days: 90 })).posts.length).toBe(READS_LIMITS.posts.overviewPosts);
    expect(r.posts[0]).toMatchObject({ id: ids["a-best"], posted: "2026-10-10", numbers: { likes: 10, reach: 900, saves: 40, comments: 2 } });
    for (const [k, v] of Object.entries(ids)) if (k.startsWith("b-")) expect(text).not.toContain(v);
    expect(r.what_works.lines[0]).toMatch(/not available/);
  });

  it("money_summary: A's money only", async () => {
    const r = await run("money_summary", A, {});
    expect(r).toMatchObject({ has_money: true, earned_this_month: "$1,250", earned_this_year: "$1,250", coming: "$500", payout_account: "not set up" });
    expect(JSON.stringify(r)).not.toContain("9,999");
    expect(r.paid.lines[0]).toMatchObject({ from: "Northpeak", amount: "$1,250", deal_id: ids["a-deal"] });
  });

  it("whats_next: A's deliverable and meeting, soonest first; never B's or the invite's own words", async () => {
    const r = await run("whats_next", A, { days: 7 });
    const text = JSON.stringify(r);
    expect(r.items.slice(0, 2)).toEqual([
      expect.objectContaining({ date: "2026-10-22", kind: "meeting", what: "Call with Northpeak at 15:00 PDT", deal_id: ids["a-deal"] }),
      expect.objectContaining({ date: "2026-10-23", kind: "deliverable", what: "a launch reel for Northpeak", deal_id: ids["a-deal"] }),
    ]);
    expect(text).not.toContain("Southgale");
    expect(text).not.toContain(ids["b-deal"]);
    expect(text).not.toContain("secret invite words");
    // Outside the window: nothing.
    const short = await run("whats_next", A, { days: 1 });
    expect(short.items.filter((i: any) => i.kind === "deliverable" || i.kind === "meeting")).toEqual([]);
  });
});

describe("R2: bounds", () => {
  it("default limits and hard maximums", async () => {
    const t = tools();
    expect((await run("media_search", A, { query: "anything at all" })).media.length).toBe(READS_LIMITS.media.default);
    expect(t.media_search.args.safeParse({ query: "x y", limit: READS_LIMITS.media.max + 1 }).success).toBe(false);
    expect(t.posts_performance.args.safeParse({ days: 365 }).success).toBe(false);
    expect(t.posts_performance.args.safeParse({ limit: 50 }).success).toBe(false);
    expect(t.money_summary.args.safeParse({ limit: 11 }).success).toBe(false);
    expect(t.whats_next.args.safeParse({ days: 61 }).success).toBe(false);
    expect(t.whats_next.args.safeParse({ limit: 16 }).success).toBe(false);
    expect(t.posts_performance.args.safeParse({ view: "everything" }).success).toBe(false);
    expect((await run("posts_performance", A, { view: "recent_posts", days: 90, limit: 10 })).posts.length).toBe(8);
    expect((await run("money_summary", A, { limit: 1 })).upcoming.lines.length).toBe(1);
  });

  it("text is clipped", async () => {
    const r = await run("media_search", A, { query: "extra", limit: 8 });
    for (const m of r.media) expect(m.what.length).toBeLessThanOrEqual(READS_LIMITS.textChars);
    const d = await run("posts_performance", A, { view: "recent_posts", detail: "detailed" });
    for (const p of d.posts) if (p.caption_start) expect(p.caption_start.length).toBeLessThanOrEqual(80);
  });
});

describe("R3: no raw rows", () => {
  it("no storage path, URL, embedding or full caption; media_search signs nothing", async () => {
    const all = JSON.stringify([
      await run("media_search", A, { query: "celebrating", detail: "detailed" }),
      await run("posts_performance", A, { view: "overview", detail: "detailed" }),
      await run("money_summary", A, { detail: "detailed" }),
      await run("whats_next", A, { detail: "detailed", days: 30 }),
    ]);
    expect(all).not.toMatch(/athletes\/|gcs|https?:|embedding|0\.954/);
    expect(all).not.toContain("long words long words long words long words long words long words long words long words");
    expect(signedUrl).not.toHaveBeenCalled();
  });
});

describe("R4: the flag", () => {
  it("off: the read tools are left out of the chat run and refuse when called", async () => {
    const registry = createDefaultRegistry({ reads: dbReadsSource });
    const names = ["media_search", "posts_performance", "money_summary", "whats_next"];
    const visible = () => visibleTools(passSkill(loadJob("chat"), registry), registry, { scopes: ["read", "draft", "propose", "act"] }).map((t) => t.name);
    expect(visible()).toEqual(expect.arrayContaining(names));
    process.env.MILA_READ_TOOLS = "false";
    try {
      expect(visible().filter((n) => names.includes(n))).toEqual([]);
      expect(await run("money_summary", A, {})).toMatchObject({ status: "error", reason: expect.stringMatching(/not_available/) });
    } finally { process.env.MILA_READ_TOOLS = "true"; }
  });
});

describe("R5: media_search filters", () => {
  it("type, dates, brand, brand safe and people", async () => {
    const idsOf = async (a: Record<string, unknown>) => (await run("media_search", A, { query: "anything", limit: 8, ...a })).media.map((m: any) => m.id);
    expect(await idsOf({ type: "video" })).toEqual([ids["a-clip"]]);
    expect(await idsOf({ type: "photo" })).not.toContain(ids["a-clip"]);
    expect((await idsOf({ posted_after: "2026-10-01" })).sort()).toEqual([ids["a-best"], ids["a-clip"]].sort());
    expect(await idsOf({ posted_before: "2026-08-15", posted_after: "2026-07-15" })).toEqual([ids["a-empty"]]);
    expect(await idsOf({ brand: "northpeak" })).toEqual([ids["a-best"]]);
    expect(await idsOf({ brand_safe_only: true })).not.toContain(ids["a-unsafe"]);
    expect(await idsOf({ has_people: false })).toEqual([ids["a-empty"]]);
    expect(await run("media_search", A, { query: "x y", posted_after: "2026-10-02", posted_before: "2026-10-01" })).toMatchObject({ status: "error" });
  });
  // Review fixes (3 Nov 2026): brand_safe_only is strict (an untagged shot is not "marked brand safe"); a soft-deleted
  // asset is never offered back; a brand filter naming the other athlete's brand finds nothing of theirs.
  it("brand_safe_only leaves out untagged shots; deleted assets never come back; a brand filter cannot reach B", async () => {
    const untagged = await asset(A, { key: "a-untagged", posted: "2026-10-12", emb: vec({ 0: 0.9, 5: 0.43 }) });
    await db.update(mediaAssets).set({ metadata: { embedding: vec({ 0: 0.9, 5: 0.43 }) } } as any).where(eq(mediaAssets.id, untagged));
    const deleted = await asset(A, { key: "a-deleted", posted: "2026-10-11", emb: vec({ 0: 0.85, 7: 0.53 }) });
    const idsOf = async (a: Record<string, unknown>) => (await run("media_search", A, { query: "anything", limit: 8, ...a })).media.map((m: any) => m.id);
    expect(await idsOf({})).toContain(deleted);   // found while live, so its absence below is the soft delete
    await db.update(mediaAssets).set({ deleted_at: new Date() } as any).where(eq(mediaAssets.id, deleted));
    expect(await idsOf({})).toContain(untagged);
    expect(await idsOf({ brand_safe_only: true })).not.toContain(untagged);
    const untaggedView = (await run("media_search", A, { query: "anything", limit: 8 })).media.find((m: any) => m.id === untagged);
    expect(untaggedView).toMatchObject({ brand_safe: null, what: "(not looked at yet)" });
    expect(await idsOf({})).not.toContain(deleted);
    expect(await idsOf({ type: "photo", limit: 8 })).not.toContain(deleted);
    expect(await idsOf({ brand: "Southgale" })).toEqual([]);
  });
});
