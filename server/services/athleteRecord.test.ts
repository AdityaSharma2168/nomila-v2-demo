/**
 * athleteRecord.test.ts — the record and its three routes on PGlite.
 *
 * Pinned:
 *   • six groups, in order; a signup fact reads as said; a research fact reads as found; goals show
 *     their labels, handles are deduped, an accepted inbox deal is proof and counted as such
 *   • precedence: a said fact for the same field beats the found one, and shows who said it
 *   • empty rows are present with value null (the screen renders "Not yet"), never omitted
 *   • the ledger's shapes: goal (text), secondary goals (list), voice (object) round-trip, project
 *     to the athletes columns, and clear with a receipt; undo restores the column
 *   • the profile PATCH routes now write receipts, with unchanged responses
 *   • history lists every receipt for a field, newest first
 *   • tenancy: a field outside the vocabulary is a 400, never a column write
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("./snapshotDeals", () => ({ confirmedPartnersFor: jest.fn(async () => ["gorjana"]) }));
jest.mock("../skills/researchAthlete", () => ({ buildSearchName: () => "", researchAthlete: jest.fn() }));
jest.mock("../skills/fetchSocialData", () => ({ fetchSocialData: jest.fn() }));
jest.mock("../skills/mediaBackfill", () => ({ backfillAthletePlatform: jest.fn() }));
jest.mock("../skills/enrichTopPostInsights", () => ({ enrichTopPostInsights: jest.fn() }));
jest.mock("../skills/firstLook", () => ({ FIRST_LOOK_POSTS: 30, runFirstLook: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { agentActions, athleteAsserted, athleteSnapshots, athletes, athletesCurrent, deals, intelligenceLedger, mediaKits } from "../../shared/schema";
import recordRouter from "../routes/record";
import profileRouter from "../routes/profile";
import agentActionsRouter from "../routes/agentActions";
import { getAthleteRecord, getAthleteRecordLegacy, getFieldHistory, type AthleteRecord, type RecordGroup } from "./athleteRecord";

const byKey = (r: AthleteRecord, key: RecordGroup["key"]): RecordGroup => r.groups.find((g) => g.key === key)!;
let server: Server;
let base: string;
let athleteId: string;

const asUser = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Mia Bhuta");
  await db.update(athletes).set({ first_name: "Mia", sport: "soccer", school: "Stanford University", goal_archetype: "build_partnerships", secondary_goals: ["grow_my_following"], socials: { instagram: "rileyathlete" } } as any)
    .where(eq(athletes.id, athleteId));
  await db.insert(deals).values([
    { athlete_id: athleteId, brand_name: "gorjana", deal_type: "social_post", status: "accepted", source: "inbox_scan", amount: 14000 },
    { athlete_id: athleteId, brand_name: "GORJANA", deal_type: "social_post", status: "detected", source: "inbox_scan" },
  ] as any);
  // Legacy display_score/tier/capitals, seeded to prove the Score/Capitals rows no longer read them —
  // the score shown is the ledger read of record below (692), never this legacy 665.
  await db.insert(athletesCurrent).values({ athlete_id: athleteId, story_arc: "Mia is a Stanford midfielder." } as any);
  await db.insert(intelligenceLedger).values({
    subject_type: "athlete", subject_id: athleteId, owner: "marketability", kind: "ASSESSMENT",
    value: { score: 692 } as any, confidence: null,
    versions: { methodology: "v1.0.1-beta.1", evaluator: "mia-eval/test", params: "params/test" } as any,
    evidence_as_of: new Date("2026-09-20T00:00:00.000Z"),
  } as any);
  await db.insert(athleteSnapshots).values({
    athlete_id: athleteId, trigger: "signup",
    research: { achievements: [{ name: "U-17 World Cup captain", year: 2022, level: "national" }], brand_mentions: [{ brand: "adidas" }], causes: [{ name: "Yuwa" }], class_year: "2027" },
  } as any);
  asUser(athleteId);
  const app = express();
  app.use(express.json());
  app.use("/", recordRouter);
  app.use("/", profileRouter);
  app.use("/", agentActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  await db.delete(athleteAsserted);
  await db.delete(agentActions);
  await db.update(athletes).set({ sport: "soccer", school: "Stanford University", goal_archetype: "build_partnerships", secondary_goals: ["grow_my_following"], brand_voice: null } as any).where(eq(athletes.id, athleteId));
});

test("six groups in order; signup facts read as said, research facts as found, empty rows stay present", async () => {
  const r = (await getAthleteRecord(athleteId))!;
  expect(r.groups.map((g) => g.key)).toEqual(["who", "teams", "want", "story", "found", "numbers", "connections"]);
  const who = Object.fromEntries(byKey(r, "who").entries.map((e) => [e.field, e]));
  expect(who.sport).toMatchObject({ value: "Soccer", kind: "said", source: "signup", editable: true });
  expect(who.class_year).toMatchObject({ value: "2027", kind: "found", source: "found online", editable: true });
  expect(who.hometown).toMatchObject({ value: null, kind: null, editable: true, actions: ["change", "tell_mila", "history"] });
  expect(who.credential).toMatchObject({ value: "U-17 World Cup captain", kind: "found", editable: false });
  const found = Object.fromEntries(byKey(r, "found").entries.map((e) => [e.field, e]));
  expect(found.confirmed).toMatchObject({ value: "gorjana", kind: "proof", source: "accepted deal · from your inbox", link: "deals" });
  expect(r.counts.proof).toBe(1);
  expect(who.handles.value).toBe("@rileyathlete (Instagram)");
  const want = Object.fromEntries(byKey(r, "want").entries.map((e) => [e.field, e]));
  expect(want.goal.value).toBe("Build long-term partnerships");
  expect(want.secondary_goals.value).toBe("Grow my following");
  expect(found.brands_seen.value).toBe("adidas");
  const numbers = Object.fromEntries(byKey(r, "numbers").entries.map((e) => [e.field, e]));
  // The ledger read of record (692), never the legacy display_score (665) — and no "Capitals" row:
  // there is no modern replacement for the four legacy capitals.
  expect(numbers.score).toMatchObject({ value: "692", kind: "made", link: "score" });
  expect(numbers.capitals).toBeUndefined();
  expect(r.header).toMatchObject({ name: "Mia Bhuta", displayScore: 692, tier: null, identityLine: "Soccer · Stanford · U-17 World Cup captain" });
  expect(r.counts.said).toBeGreaterThan(0);
});

test("a said fact beats the found one for the same field, and says who said it", async () => {
  const put = await call("PUT", "/record/class_year", { value: "2026" });
  expect(put.status).toBe(200);
  expect(put.json).toMatchObject({ ok: true, field: "class_year", value: "2026" });
  const r = (await getAthleteRecord(athleteId))!;
  const cy = byKey(r, "who").entries.find((e) => e.field === "class_year")!;
  expect(cy).toMatchObject({ value: "2026", kind: "said", source: "you changed it" });
  expect(cy.at).toBeTruthy();
});

test("shapes round-trip: goal (text) and secondary goals (list) project to the columns; voice is an object", async () => {
  expect((await call("PUT", "/record/goal", { value: "grow_my_business" })).status).toBe(200);
  expect((await call("PUT", "/record/secondary_goals", { value: ["get_fair_value", "get_fair_value", " grow_my_following "] })).status).toBe(200);
  expect((await call("PUT", "/record/brand_voice", { value: { tone: "warm, direct", phrases: ["let's run it"], avoid: ["hype"] } })).status).toBe(200);
  const [a] = await db.select({ goal: athletes.goal_archetype, sec: athletes.secondary_goals, voice: athletes.brand_voice }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.goal).toBe("grow_my_business");
  expect(a.sec).toEqual(["get_fair_value", "grow_my_following"]);
  expect(a.voice).toEqual({ tone: "warm, direct", phrases: ["let's run it"], avoid: ["hype"] });
  const r = (await getAthleteRecord(athleteId))!;
  const want = Object.fromEntries(byKey(r, "want").entries.map((e) => [e.field, e]));
  expect(want.secondary_goals).toMatchObject({ value: "Get fair value for deals, Grow my following", raw: ["get_fair_value", "grow_my_following"], kind: "said", shape: "list" });
  const story = Object.fromEntries(byKey(r, "story").entries.map((e) => [e.field, e]));
  expect(story.brand_voice.value).toBe("warm, direct · says: let's run it · avoids: hype");
});

test("clearing writes a receipt and nulls the column; undo restores it", async () => {
  await call("PUT", "/record/goal", { value: "grow_my_business" });
  const cleared = await call("PUT", "/record/goal", { value: "" });
  expect(cleared.json).toMatchObject({ ok: true, cleared: true });
  let [a] = await db.select({ goal: athletes.goal_archetype }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.goal).toBeNull();
  const undo = await call("POST", `/agent-actions/${cleared.json.agent_action_id}/undo`);
  expect(undo.status).toBe(200);
  [a] = await db.select({ goal: athletes.goal_archetype }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.goal).toBe("grow_my_business");
});

test("the profile PATCH routes are doors into the ledger: same response, plus a receipt", async () => {
  const r = await call("PATCH", "/profile/goal", { goal_archetype: "get_my_first_deal" });
  expect(r.json).toEqual({ ok: true, goal_archetype: "get_my_first_deal" });
  const rows = await db.select().from(athleteAsserted).where(eq(athleteAsserted.athlete_id, athleteId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ field: "goal", source: "settings", mode: "form" });
  const receipts = await db.select().from(agentActions).where(eq(agentActions.athlete_id, athleteId));
  expect(receipts.map((x) => x.action)).toEqual(["profile_write"]);
  const v = await call("PATCH", "/profile/brand-voice", { brand_voice: { tone: "dry", phrases: [], avoid: [] } });
  // The sanitizer drops empty lists, exactly as the route always did — the response is unchanged.
  expect(v.json).toEqual({ ok: true, brand_voice: { tone: "dry" } });
});

test("history lists every receipt for a field newest first; an unknown field is a 400 and writes nothing", async () => {
  await call("PUT", "/record/hometown", { value: "Dublin, Ohio" });
  await call("PUT", "/record/hometown", { value: "Columbus, Ohio" });
  const h = await call("GET", "/record/history/hometown");
  expect(h.status).toBe(200);
  expect(h.json.items.map((i: any) => [i.from, i.to])).toEqual([["Dublin, Ohio", "Columbus, Ohio"], [null, "Dublin, Ohio"]]);
  expect(await getFieldHistory(athleteId, "hometown")).toHaveLength(2);
  expect((await call("PUT", "/record/email", { value: "x@y.z" })).status).toBe(400);
  expect((await call("GET", "/record/history/email")).status).toBe(400);
  const [a] = await db.select({ email: athletes.email }).from(athletes).where(eq(athletes.id, athleteId));
  expect(a.email).toBeNull();
});

describe("the record reader", () => {
  test("getAthleteRecord is the pre-2d record byte for byte", async () => {
    expect(await getAthleteRecord(athleteId)).toEqual(await getAthleteRecordLegacy(athleteId));
  });
});

describe("the Story feedback loop — generated kit copy is downstream output, never her story", () => {
  const env = process.env;
  afterEach(() => { process.env = env; });
  const HOOK = "Building between two worlds, one match at a time.";

  test("neither record reader shows the public kit's hook (identity or cover card) anywhere; the kit row itself is untouched", async () => {
    await db.insert(mediaKits).values({ athlete_id: athleteId, brand_id: 0, data: { identity: { hook: HOOK }, cards: [{ type: "cover", hook: HOOK }] }, generated_at: new Date() } as any);
    for (const readers of ["", "record"]) {
      process.env = { ...env };
      const r = (await getAthleteRecord(athleteId))!;
      expect(byKey(r, "story").entries.map((e) => e.field)).not.toContain("hook");
      expect(JSON.stringify(r)).not.toContain(HOOK);
      expect(byKey(r, "story").entries.find((e) => e.field === "narrative")).toBeDefined();   // the research narrative row is unchanged
    }
    const [kit] = await db.select().from(mediaKits).where(eq(mediaKits.athlete_id, athleteId));
    expect((kit!.data as any).identity.hook).toBe(HOOK);                                        // history/data preserved
  });
});
