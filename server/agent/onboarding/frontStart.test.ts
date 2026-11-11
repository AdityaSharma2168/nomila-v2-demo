/**
 * frontStart.test.ts — what the onboarding FRONT sends, end to end on Express + PGlite. The workflow is never kicked
 * (research would reach a model): `kick` is mocked, so no provider is reached.
 *
 *   S1 the sport grid's sports: athletes.sport stays the MAIN sport (filled only when empty), the others land in
 *      other_sports (0122) without repeating it, and every sport is a "said" fact beside the name
 *   S2 an athlete whose sport is already known keeps it; the picks that differ go to other_sports
 *   S3 one sport (the old first screen's body) behaves exactly as before: no other_sports, "X's sport is Y."
 *   S4 validation: sports must be a list, at most MAX_SPORTS, and a name and one sport are required
 *   S5 Mila's intro: each interest tile is saved as a "said" fact through the existing `capability` action (a catalog
 *      id or the tile's own key), once; reply:false asks no model
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../../workflow/runner", () => ({ ...jest.requireActual("../../workflow/runner"), kick: jest.fn(async () => 0) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { athletes } from "../../../shared/schema";
import { dbStore } from "../research/dbStore";
import { setResponsesTransport } from "../research/llm";
import { agentOnboardingRouter } from "./routes";
import { MAX_SPORTS } from "./service";
import { ONBOARDING_INTERESTS, interestActionId } from "../../../shared/onboardingInterests";

let server: Server;
let base = "";
const modelCalls: unknown[] = [];

async function call(as: string, method: string, path: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const row = async (id: string) => (await db.select({ sport: athletes.sport, other: athletes.other_sports }).from(athletes).where(eq(athletes.id, id)))[0];
const said = async (id: string) => (await dbStore.listFacts(id, ["active"])).filter((f) => f.type === "said").map((f) => f.claim).sort();

beforeAll(async () => {
  await initTestDb();
  // Any model call fails the test: the front's writes never ask a model.
  setResponsesTransport((async (body: unknown) => { modelCalls.push(body); throw new Error("no model in this test"); }) as any);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", agentOnboardingRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  setResponsesTransport(null);
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

test("S1: main sport to athletes.sport, the others to other_sports, every sport a said fact", async () => {
  const a = await seedAthlete("Sam Test");
  const r = await call(a, "POST", "/agent/onboarding/start", { name: "Sam Test", sport: "Sport A", sports: ["Sport A", "Sport B", "sport b", "Sport C"] });
  expect(r.status).toBe(202);
  expect(await row(a)).toEqual({ sport: "Sport A", other: ["Sport B", "Sport C"] });
  expect(await said(a)).toEqual(["Sam Test also plays Sport B.", "Sam Test also plays Sport C.", "Sam Test's main sport is Sport A.", "The athlete's name is Sam Test."]);
  // Resumable: starting again returns the same run and writes nothing twice.
  const again = await call(a, "POST", "/agent/onboarding/start", { name: "Sam Test", sports: ["Sport A", "Sport B"] });
  expect(again.status).toBe(200);
  expect(again.body.runId).toBe(r.body.runId);
  expect((await said(a))).toHaveLength(4);
});

test("S2: a sport already on record stays the main one; the picks that differ go to other_sports", async () => {
  const a = await seedAthlete("Kai Test");
  await db.update(athletes).set({ sport: "Sport K" }).where(eq(athletes.id, a));
  await call(a, "POST", "/agent/onboarding/start", { name: "Kai Test", sports: ["Sport K", "Sport L"] });
  expect(await row(a)).toEqual({ sport: "Sport K", other: ["Sport L"] });
});

test("S3: one sport behaves as before", async () => {
  const a = await seedAthlete("Ari Test");
  const r = await call(a, "POST", "/agent/onboarding/start", { name: "Ari Test", sport: "Sport X" });
  expect(r.status).toBe(202);
  expect(await row(a)).toEqual({ sport: "Sport X", other: [] });
  expect(await said(a)).toEqual(["Ari Test's sport is Sport X.", "The athlete's name is Ari Test."]);
});

test("S4: validation", async () => {
  const a = await seedAthlete("Val Test");
  expect((await call(a, "POST", "/agent/onboarding/start", { name: "Val Test", sports: "Sport A" })).status).toBe(400);
  expect((await call(a, "POST", "/agent/onboarding/start", { name: "Val Test", sports: Array.from({ length: MAX_SPORTS + 1 }, (_, i) => `Sport ${i}`) })).status).toBe(400);
  expect((await call(a, "POST", "/agent/onboarding/start", { name: "Val Test", sports: [] })).status).toBe(400);
  expect((await call(a, "POST", "/agent/onboarding/start", { sports: ["Sport A"] })).status).toBe(400);
  expect(await row(a)).toEqual({ sport: null, other: [] });
});

test("S5: the intro's interests are said facts through the capability action, once each, with no model call", async () => {
  const a = await seedAthlete("Rio Test");
  await call(a, "POST", "/agent/onboarding/start", { name: "Rio Test", sports: ["Sport R"] });
  const actions = ONBOARDING_INTERESTS.map((i) => ({ type: "capability", capabilityId: interestActionId(i) }));
  const r = await call(a, "POST", "/agent/onboarding/turn", { actions, reply: false });
  expect(r.status).toBe(200);
  expect(r.body.problems).toEqual([]);
  await call(a, "POST", "/agent/onboarding/turn", { actions: [{ type: "capability", capabilityId: "brand" }], reply: false });
  const chose = (await said(a)).filter((c) => c.includes("chose where to start"));
  expect(chose).toHaveLength(ONBOARDING_INTERESTS.length);
  expect(chose).toContain('Rio Test chose where to start: "Your brand".');
  expect(chose).toContain('Rio Test chose where to start: "Money".');
  expect(modelCalls).toEqual([]);
  // An unknown id is still refused.
  const bad = await call(a, "POST", "/agent/onboarding/turn", { actions: [{ type: "capability", capabilityId: "nope" }], reply: false });
  expect(bad.body.problems).toEqual(["unknown capability nope"]);
});
