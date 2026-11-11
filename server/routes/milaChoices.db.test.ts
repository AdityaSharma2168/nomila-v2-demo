/**
 * milaChoices.db.test.ts — Me's capability switches (routes/milaChoices.ts) on PGlite. Made-up athletes, no provider.
 *   M1 404 while MILA_WELCOME is off
 *   M2 GET lists the switches, all unset for a new athlete (no backfill)
 *   M3 turning on needs the consent version Me showed; on, then off, recorded via "me"; the athlete is the session's
 *   M4 every listed switch carries its Turn-on sheet (presentation) and a per-account one its fitting accounts; pause
 *      and resume from Me
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, initTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { getChoice } from "../agent/welcome/choices";
import router from "./milaChoices";

let server: Server, base = "", A = "", B = "";
const saved = { w: process.env.MILA_WELCOME, p: process.env.AGENT_PLAN };
beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Cara Example");
  B = await seedAthlete("Dev Example");
  const app = express();
  app.use(express.json());
  app.use("/", router);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  process.env.MILA_WELCOME = saved.w; process.env.AGENT_PLAN = saved.p;
  if (saved.w === undefined) delete process.env.MILA_WELCOME;
  if (saved.p === undefined) delete process.env.AGENT_PLAN;
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});
beforeEach(() => { process.env.MILA_WELCOME = "true"; process.env.AGENT_PLAN = "true"; });

const as = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
const post = (key: string, body: unknown) => fetch(`${base}/mila/capabilities/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("M1 404 while MILA_WELCOME is off", async () => {
  delete process.env.MILA_WELCOME;
  as(A);
  expect((await fetch(`${base}/mila/capabilities`)).status).toBe(404);
  expect((await post("plan_refresh", { to: "enabled", consentVersion: "plan_refresh/1" })).status).toBe(404);
});

test("M2 every switch starts unset", async () => {
  as(A);
  const r = await (await fetch(`${base}/mila/capabilities`)).json() as { capabilities: Array<{ key: string; choices: unknown[]; consent: { version: string } }> };
  const plan = r.capabilities.find((c) => c.key === "plan_refresh")!;
  expect(plan.consent.version).toBe("plan_refresh/1");
  expect(r.capabilities.every((c) => c.choices.length === 0)).toBe(true);
  expect(r.capabilities.some((c) => c.key === "deal_watch")).toBe(false);
});

test("M3 on needs the version shown; on then off via me; only the session's athlete", async () => {
  as(A);
  expect((await post("plan_refresh", { to: "enabled" })).status).toBe(409);
  expect((await post("plan_refresh", { to: "enabled", consentVersion: "plan_refresh/0" })).status).toBe(409);
  expect((await getChoice(A, "plan_refresh")).state).toBe("unset");
  expect((await post("plan_refresh", { to: "enabled", consentVersion: "plan_refresh/1", expectedVersion: 0 })).status).toBe(200);
  expect(await getChoice(A, "plan_refresh")).toMatchObject({ state: "enabled", via: "me", consentVersion: "plan_refresh/1" });
  expect((await getChoice(B, "plan_refresh")).state).toBe("unset");
  expect((await post("plan_refresh", { to: "revoked" })).status).toBe(200);
  expect((await getChoice(A, "plan_refresh")).state).toBe("revoked");
  expect((await post("deal_watch", { to: "enabled", consentVersion: "deal_watch/1" })).status).toBe(400);
});

test("M4 every switch carries its sheet; draft replies lists their fitting accounts; pause and resume from Me", async () => {
  const flags = ["AGENT_MOMENTS", "AGENT_POST_KITS", "AGENT_LEARNING_LOOP", "AGENT_RESEARCH_REFRESH", "BOOKINGS_ENABLED", "SHOP_V1"];
  const before = flags.map((k) => process.env[k]);
  for (const k of flags) process.env[k] = "true";
  try {
    const C = await seedAthlete("Eve Example");
    const mail = await seedConnection({ athleteId: C, platform: "gmail", email: "eve@example.com" });
    await seedConnection({ athleteId: C, platform: "youtube", email: "eve-yt" });
    as(C);
    type Row = { key: string; scope: string; presentation: { headline: string; sheet: { rows: unknown[] } } | null; accounts: Array<{ accountRef: string; platform: string; label: string; status: string }> };
    const r = await (await fetch(`${base}/mila/capabilities`)).json() as { capabilities: Row[] };
    // Not on the bookings pilot: no bookings row; shop is planned (it guards nothing yet), so it is never listed.
    expect(r.capabilities.map((c) => c.key).sort()).toEqual(["auto_archive", "brand_book", "draft_replies", "moments_scan", "pitch_deck", "plan_refresh", "post_ideas", "post_took_off", "profile_refresh", "voice_send"]);
    const pilotBefore = process.env.BOOKINGS_PILOT_ATHLETE_IDS;
    process.env.BOOKINGS_PILOT_ATHLETE_IDS = C;
    try {
      const piloted = await (await fetch(`${base}/mila/capabilities`)).json() as { capabilities: Row[] };
      expect(piloted.capabilities.map((c) => c.key)).toContain("bookings");
      expect(piloted.capabilities.map((c) => c.key)).not.toContain("shop");
    } finally {
      if (pilotBefore === undefined) delete process.env.BOOKINGS_PILOT_ATHLETE_IDS; else process.env.BOOKINGS_PILOT_ATHLETE_IDS = pilotBefore;
    }
    expect(r.capabilities.filter((c) => !c.presentation || c.presentation.sheet.rows.length !== 3)).toEqual([]);
    const drafts = r.capabilities.find((c) => c.key === "draft_replies")!;
    expect(drafts.accounts).toEqual([{ accountRef: mail, platform: "gmail", label: "eve@example.com", status: "active" }]);
    expect(r.capabilities.find((c) => c.key === "pitch_deck")!.accounts).toEqual([]);

    expect((await post("pitch_deck", { to: "enabled", consentVersion: "pitch_deck/2" })).status).toBe(200);
    expect((await post("pitch_deck", { to: "paused" })).status).toBe(200);
    expect((await getChoice(C, "pitch_deck")).state).toBe("paused");
    expect((await post("pitch_deck", { to: "enabled", consentVersion: "pitch_deck/2" })).status).toBe(200);
    expect((await getChoice(C, "pitch_deck")).state).toBe("enabled");
    expect((await post("draft_replies", { to: "enabled", accountRef: mail, consentVersion: "draft_replies/2" })).status).toBe(200);
    const again = await (await fetch(`${base}/mila/capabilities`)).json() as { capabilities: Array<Row & { choices: Array<{ accountRef: string | null; state: string }> }> };
    expect(again.capabilities.find((c) => c.key === "draft_replies")!.choices).toEqual([expect.objectContaining({ accountRef: mail, state: "enabled" })]);
  } finally {
    flags.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; });
  }
});
