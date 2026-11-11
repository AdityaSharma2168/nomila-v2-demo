/**
 * publicPlatform.db.test.ts — "this is my Instagram / YouTube" on PGlite: the confirm step and the public-platform
 * measured facts the M.I.A. then reads. No provider is reached: the public API lookup is injected (it writes the
 * discovery row the real one would). Made-up athletes only.
 *
 *   B1 confirm: her word as a said fact (older said handle superseded), entered handle kept in athletes.socials, one
 *      lookup, and public-platform measured facts for that handle; read back by GET /me/handles' reader
 *   B2 a connected platform is never looked up and gets no public reading
 *   B3 a lookup that fails (personal account) writes no measured fact and says why
 *   B4 measured facts sync: a discovery row for a handle she did NOT confirm is never scored
 *   B5 the waitlist contract (GET /waitlist/progress `handles`, POST /waitlist/handles/:platform)
 *   B6 the score follows the read: a confirm whose public read succeeds asks for a recompute (the real request is
 *      debounced, not forced: miaPreview/preview.ts requestRescoreForReadings); a failed read or a connected platform
 *      asks nothing. The recompute request is injected (no evaluation runs here).
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.setTimeout(120_000);

import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { athletes, connectedAccounts, memoryFacts, socialAnalyticsSnapshots } from "../../../shared/schema";
import { dbStore } from "./dbStore";
import { actOnWaitlistHandle, confirmHandle, readHandles, syncPublicMeasuredFacts, waitlistHandles, PUBLIC_REF_PREFIX, type PublicPlatform } from "./publicPlatform";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });

let seq = 0;
async function athlete(): Promise<string> {
  const id = await seedAthlete(`Jordan Sample ${++seq}`, { sport: "Rowing", email: `jordan${seq}@example.com` } as any);
  await dbStore.insertFacts(id, [{ subject: { kind: "athlete", name: `Jordan Sample ${seq}` }, claim: `Jordan Sample ${seq}'s Instagram handle is @jordan_old.`, type: "said", source: { ref: "onboarding/r1#handle:instagram", title: "You told us" }, date: "2026-09-01", confidence: 1, runId: null }]);
  return id;
}
const discoveryRow = (athleteId: string, platform: string, username: string, followers: number) => db.insert(socialAnalyticsSnapshots).values({
  athlete_id: athleteId, source: "discovery", platform, snapshot_day: "2026-10-25", followers, post_count: 120, avg_engagement_rate: 3.5 as any, posts_last_30d: 6,
  raw_metrics: { discovery: { platform, username, source: platform === "instagram" ? "business_discovery" : "youtube_data_api" } } as any,
} as any);

test("B1 confirm: said fact, older handle superseded, socials kept, one lookup, public measured facts", async () => {
  const id = await athlete();
  const calls: Array<[PublicPlatform, string]> = [];
  const lookup = async (platform: PublicPlatform, handle: string) => { calls.push([platform, handle]); await discoveryRow(id, platform, handle, 15400); return { outcome: "found" as const, followers: 15400 }; };
  const rescore = jest.fn().mockResolvedValue({ runId: "r", created: true });
  const r = await confirmHandle(id, { platform: "instagram", handle: "https://instagram.com/jordan.sample/" }, { lookup, rescore });
  expect(r).toMatchObject({ platform: "instagram", handle: "jordan.sample", lookup: "found", followers: 15400, measured: 4, rescoreRequested: true });
  expect(rescore).toHaveBeenCalledTimes(1);
  expect(rescore).toHaveBeenCalledWith(id, expect.objectContaining({ createdBy: "handle_confirm" }));
  expect(calls).toEqual([["instagram", "jordan.sample"]]);
  const facts = await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id));
  expect(facts.filter((f) => f.type === "said" && f.status === "active").map((f) => f.claim)).toEqual([expect.stringContaining("Instagram handle is @jordan.sample.")]);
  expect(facts.find((f) => f.claim.includes("@jordan_old"))?.status).toBe("superseded");
  const measured = facts.filter((f) => f.type === "measured");
  expect(measured.every((f) => f.source_ref!.startsWith(PUBLIC_REF_PREFIX))).toBe(true);
  expect(measured.map((f) => f.claim)).toContain("Instagram (@jordan.sample) has 15,400 followers (public profile).");
  const [a] = await db.select({ socials: athletes.socials }).from(athletes).where(eq(athletes.id, id));
  expect(a.socials).toMatchObject({ instagram: "jordan.sample" });
  const view = await readHandles(id);
  expect(view.confirmed).toEqual([expect.objectContaining({ platform: "instagram", handle: "jordan.sample", connected: false, publicReading: { followers: 15400, asOf: "2026-10-25" } })]);
  // Confirming the same handle again writes no second said fact.
  await confirmHandle(id, { platform: "instagram", handle: "@jordan.sample" }, { lookup: async () => ({ outcome: "found", followers: 15400 }), rescore });
  expect((await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id))).filter((f) => f.type === "said" && f.status === "active")).toHaveLength(1);
});

test("B2 a connected platform: no lookup, no public reading", async () => {
  const id = await athlete();
  await db.insert(connectedAccounts).values({ athlete_id: id, platform: "instagram", platform_user_id: `ig-${id}`, platform_username: "jordan.sample", status: "active", access_token: "x" } as any);
  const lookup = jest.fn();
  const rescore = jest.fn();
  const r = await confirmHandle(id, { platform: "instagram", handle: "jordan.sample" }, { lookup, rescore });
  expect(r).toMatchObject({ lookup: "connected", measured: 0, rescoreRequested: false });
  expect(lookup).not.toHaveBeenCalled();
  expect(rescore).not.toHaveBeenCalled();   // connected data reaches the M.I.A. through social_sync
});

test("B3 a personal account (Business Discovery refuses it): her word is kept, no measured fact, the reason returned", async () => {
  const id = await athlete();
  const rescore = jest.fn();
  const r = await confirmHandle(id, { platform: "instagram", handle: "jordan.personal" }, { lookup: async () => ({ outcome: "not_business_account", followers: null }), rescore });
  expect(r).toMatchObject({ lookup: "not_business_account", measured: 0, rescoreRequested: false });
  expect(rescore).not.toHaveBeenCalled();
  expect((await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id))).filter((f) => f.type === "measured")).toHaveLength(0);
  await expect(confirmHandle(id, { platform: "tiktok", handle: "x" })).rejects.toMatchObject({ status: 400 });
});

test("B4 a discovery row for a handle she did not confirm is never turned into a measured fact", async () => {
  const id = await athlete();   // confirmed (typed) @jordan_old
  await discoveryRow(id, "instagram", "someone_else", 999999);
  expect(await syncPublicMeasuredFacts(id, "Jordan")).toMatchObject({ inserted: 0 });
  await discoveryRow(id, "youtube", "JordanYT", 500);   // no YouTube handle confirmed
  expect(await syncPublicMeasuredFacts(id, "Jordan")).toMatchObject({ inserted: 0 });
});

test("B5 the waitlist contract: suggested from research, reject (idempotent), confirm triggers the lookup; rejecting a confirmed handle stops its readings", async () => {
  const id = await seedAthlete("Avery Sample", { sport: "Rowing", email: "avery@example.com" } as any);
  await dbStore.insertFacts(id, [
    { subject: { kind: "athlete", name: "Avery Sample" }, claim: "Avery Sample posts race clips on Instagram as @avery.rows.", type: "found", topic: "social", source: { url: "https://news.example.com/avery" }, date: "2026-10-01", confidence: 0.8, runId: null },
    { subject: { kind: "athlete", name: "Avery Sample" }, claim: "Avery Sample's channel is youtube.com/@AveryRowsYT.", type: "found", topic: "social", source: { url: "https://news.example.com/avery2" }, date: "2026-10-01", confidence: 0.8, runId: null },
  ]);
  expect(await waitlistHandles(id)).toEqual([
    { platform: "instagram", handle: "avery.rows", source: "research", status: "suggested" },
    { platform: "youtube", handle: "AveryRowsYT", source: "research", status: "suggested" },
  ]);
  const r1 = await actOnWaitlistHandle(id, "youtube", { action: "reject" });
  expect(r1.handles).toContainEqual({ platform: "youtube", handle: "AveryRowsYT", source: "research", status: "rejected" });
  await actOnWaitlistHandle(id, "youtube", { action: "reject", handle: "AveryRowsYT" });   // idempotent
  expect((await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id))).filter((f) => (f.source_ref ?? "").includes("#not-handle:"))).toHaveLength(1);

  const lookup = async (platform: PublicPlatform, handle: string) => { await discoveryRow(id, platform, handle, 2100); return { outcome: "found" as const, followers: 2100 }; };
  const r2 = await actOnWaitlistHandle(id, "instagram", { action: "confirm" }, { lookup, rescore: async () => ({ runId: "r", created: true }) });
  expect(r2).toMatchObject({ lookup: "found", measured: 4 });
  expect(r2.handles[0]).toEqual({ platform: "instagram", handle: "avery.rows", source: "you", status: "confirmed" });

  await actOnWaitlistHandle(id, "instagram", { action: "reject" });
  const after = await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id));
  expect(after.filter((f) => f.type === "measured" && f.status === "active")).toHaveLength(0);
  expect(await waitlistHandles(id)).toContainEqual({ platform: "instagram", handle: "avery.rows", source: "research", status: "rejected" });
  await expect(actOnWaitlistHandle(id, "instagram", { action: "maybe" })).rejects.toMatchObject({ status: 400 });
});

test("B6 the real recompute request after a confirmed-handle read: debounced, not forced, SOCIAL_BLOCK_CHANGED", async () => {
  const orchestrator = require("../../services/marketabilityBeta1Orchestrator");
  const spy = jest.spyOn(orchestrator, "requestEvaluation").mockResolvedValue({ runId: "mia-run", created: true });
  try {
    const id = await athlete();
    const lookup = async (platform: PublicPlatform, handle: string) => { await discoveryRow(id, platform, handle, 3000); return { outcome: "found" as const, followers: 3000 }; };
    const r = await confirmHandle(id, { platform: "instagram", handle: "jordan.rows" }, { lookup });
    expect(r).toMatchObject({ lookup: "found", rescoreRequested: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ athleteId: id, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "handle_confirm" });
    expect(spy.mock.calls[0][0]).not.toHaveProperty("force");
    expect(spy.mock.calls[0][0]).not.toHaveProperty("immediate");
  } finally { spy.mockRestore(); }
});
