/**
 * requalifyRetiredFloorCore — threads whose stored floor was the computed rate-card mid are re-judged against HER
 * floor only; nothing else on the classification changes; the apply is guarded and idempotent. PGlite; no model.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/models", () => ({
  genai: () => { throw new Error("tests must never reach a provider"); },
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
}));

import { eq } from "drizzle-orm";
import { athletes, inboxThreads } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { applyRequalify, requalifyAgainstHerFloor, selectRetiredFloorThreads } from "./requalifyRetiredFloorCore";

const computed = (cash: number, floor: number, qualification = "below_floor") => ({
  is_deal: true,
  category: "PAID",
  channel: "direct",
  qualification,
  qualification_reason: `The cash offered ($${cash} for 1 social post) is under your floor for this kind of work ($${floor} each).`,
  qualification_version: "opps-qual/1",
  qualification_message_id: "msg-1",
  qualification_floor: { kind: "social_post", cash, units: 1, floor, source: "rate_card_mid" },
});

const ids: Record<string, string> = {};

async function thread(athleteId: string, key: string, classification: any) {
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, subject: key, status: "deal_detected", classification } as any)
    .returning({ id: inboxThreads.id });
  ids[key] = t.id;
}

beforeAll(async () => {
  await initTestDb();
  const noFloor = await seedAthlete("Ada Lovelace");
  const withFloor = await seedAthlete("Grace Hopper");
  await db.update(athletes).set({ deal_preferences: { minimum_rates: { socialPost: 300 } } } as any).where(eq(athletes.id, withFloor));
  await thread(noFloor, "noFloorBelow", computed(500, 876));
  await thread(noFloor, "noFloorWorkable", computed(900, 876, "workable"));
  await thread(withFloor, "herFloorBelow", computed(200, 876));
  await thread(withFloor, "herFloorMeets", computed(500, 876));
  await thread(withFloor, "ownFloorAlready", { ...computed(200, 300), qualification_floor: { kind: "social_post", cash: 200, units: 1, floor: 300, source: "minimum_rate" } });
  await thread(noFloor, "unqualified", { is_deal: true, category: "PAID" });
});
afterAll(async () => { await closeTestDb(); });

it("selects only threads whose floor was the computed rate, with the verdict a fresh qualification gives", async () => {
  const rows = await selectRetiredFloorThreads();
  const by = Object.fromEntries(rows.map((r) => [r.thread_id, r]));
  expect(rows.map((r) => r.thread_id).sort()).toEqual([ids.noFloorBelow, ids.noFloorWorkable, ids.herFloorBelow, ids.herFloorMeets].sort());
  expect(by[ids.noFloorBelow].after).toMatchObject({ qualification: "workable", qualification_floor: null });
  expect(by[ids.noFloorBelow].after.qualification_reason).toMatch(/no floor set/);
  expect(by[ids.noFloorWorkable].after).toMatchObject({ qualification: "workable", qualification_floor: null });
  expect(by[ids.herFloorBelow].after).toMatchObject({ qualification: "below_floor", qualification_floor: { floor: 300, source: "minimum_rate" } });
  expect(by[ids.herFloorMeets].after).toMatchObject({ qualification: "workable", qualification_floor: { floor: 300, source: "minimum_rate" } });
  for (const r of rows) expect(r.after.qualification_message_id).toBe("msg-1");
});

it("dry run writes nothing; apply updates only the qualification keys, and a re-run is a no-op", async () => {
  const rows = await selectRetiredFloorThreads();
  const [untouched] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, ids.noFloorBelow));
  expect((untouched.classification as any).qualification).toBe("below_floor");

  expect(await applyRequalify(rows)).toBe(4);
  const [after] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, ids.noFloorBelow));
  expect(after.classification).toMatchObject({ is_deal: true, category: "PAID", channel: "direct", qualification: "workable", qualification_floor: null, qualification_message_id: "msg-1" });
  const [own] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, ids.ownFloorAlready));
  expect((own.classification as any).qualification_floor.source).toBe("minimum_rate");

  expect(await selectRetiredFloorThreads()).toHaveLength(0);
  expect(await applyRequalify(rows)).toBe(0);
});

it("a missing or odd floor check still yields a sane verdict", () => {
  const q = requalifyAgainstHerFloor({
    channel: "agency", qualification: "below_floor", qualification_reason: "x", qualification_version: "opps-qual/1",
    qualification_message_id: null, qualification_floor: { kind: "weird", cash: 100, units: 0, floor: 900, source: "rate_card_mid" } as any,
  }, {});
  expect(q).toMatchObject({ qualification: "workable", channel: "agency", qualification_floor: null });
});
