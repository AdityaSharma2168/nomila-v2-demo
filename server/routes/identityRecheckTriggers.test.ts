/**
 * identityRecheckTriggers.test.ts — the write paths that carry new identity evidence ask for an identity re-check
 * (agent/researchRefresh/identityRecheck.ts recheckIdentityInBackground, mocked here: its own guards are pinned in
 * identityRecheck.db.test.ts). On Express + PGlite; no provider, no runner execution. Made-up athletes only.
 *
 *   T1 the waitlist POST: a new school / team ⇒ "school"; a new handle ⇒ "handle"; the same school or handle again, or a
 *      post with neither (sport, goals) ⇒ nothing
 *   T2 the record editor / Mila / onboarding (recordAssertions): a new school, or a teams list that changes the primary
 *      team ⇒ "school"; the same school again or another field ⇒ nothing
 *   T3 the handle confirm (waitlist and app: confirmHandle): a new or different handle ⇒ "handle"; the same one ⇒ nothing
 * The OAuth connect ("account") is pinned in oauthCallback.socialSync.test.ts.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
const startRun = jest.fn().mockResolvedValue({ run: { id: "r" }, created: true });
jest.mock("../workflow/runner", () => ({ ...jest.requireActual("../workflow/runner"), startRun: (...a: unknown[]) => startRun(...a), kick: jest.fn().mockResolvedValue(0) }));
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn().mockResolvedValue({ started: false, reason: "disabled" }) }));
const recheck = jest.fn();
jest.mock("../agent/researchRefresh/identityRecheck", () => ({
  ...jest.requireActual("../agent/researchRefresh/identityRecheck"),
  recheckIdentityInBackground: (...a: unknown[]) => recheck(...a),
}));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, closeTestDb, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { recordAssertions } from "../mila/onboarding";
import { confirmHandle } from "../agent/research/publicPlatform";
import waitlistRouter from "./waitlist";

let server: Server; let base: string; const env = process.env;
const settle = () => new Promise((r) => setTimeout(r, 30));   // the dynamic imports behind the background calls
const post = async (uid: string, body: Record<string, unknown>) => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
  const r = await fetch(`${base}/waitlist`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  await settle();
  return r.status;
};

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false" }; recheck.mockClear(); startRun.mockClear(); });

test("T1: the waitlist POST — a new school or handle asks for a re-check; nothing new, nothing asked", async () => {
  const id = await seedAthlete("Avery Sample", { sport: "Rowing", status: "waitlisted", auth_id: "uid-t1", email: "uid-t1@example.com", socials: { instagram: "avery" } } as any);
  expect(await post("uid-t1", { school: "Example State" })).toBe(200);
  expect(recheck).toHaveBeenCalledWith(id, "school", "waitlist", {});
  recheck.mockClear();
  expect(await post("uid-t1", { team: "example  state" })).toBe(200);       // the same team, spelled differently
  expect(await post("uid-t1", { socials: { instagram: "@Avery" } })).toBe(200);
  expect(await post("uid-t1", { sport: "Rowing" })).toBe(200);
  expect(recheck).not.toHaveBeenCalled();
  expect(await post("uid-t1", { socials: { tiktok: "avery.rows" } })).toBe(200);
  expect(recheck).toHaveBeenCalledWith(id, "handle", "waitlist", { typedHandles: { tiktok: "avery.rows" } });   // recorded as her word for the re-check
});

test("T2: recordAssertions — a new school or a teams list that moves her primary team ⇒ school; the same school or another field ⇒ nothing", async () => {
  const id = await seedAthlete("Blair Sample", { sport: "Rowing", status: "active" } as any);
  const record = (field: string, value: unknown) => recordAssertions({ athleteId: id, runId: null, mode: "form", source: "settings", corrections: [{ field: field as any, value: value as any }] });
  await record("school", "Example State");
  await settle();
  expect(recheck).toHaveBeenCalledWith(id, "school", "record:settings");
  recheck.mockClear();
  await record("school", "Example State");
  await record("goal", "brand_builder");
  await settle();
  expect(recheck).not.toHaveBeenCalled();
  await record("affiliations", "Example Rowing Club | club | | athlete | 2025- | primary");
  await settle();
  expect(recheck).toHaveBeenCalledWith(id, "school", "record:settings");
});

test("T3: the handle confirm — a new or different handle ⇒ handle; the same one ⇒ nothing", async () => {
  const id = await seedAthlete("Casey Sample", { sport: "Rowing", status: "active" } as any);
  const deps = { lookup: async () => ({ outcome: "not_found" as const, followers: null }), rescore: async () => null };
  await confirmHandle(id, { platform: "instagram", handle: "casey.rows" }, deps);
  await settle();
  expect(recheck).toHaveBeenCalledWith(id, "handle", "confirm:instagram");
  recheck.mockClear();
  await confirmHandle(id, { platform: "instagram", handle: "@casey.rows" }, deps);
  await settle();
  expect(recheck).not.toHaveBeenCalled();
  await confirmHandle(id, { platform: "instagram", handle: "casey.rows.official" }, deps);
  await settle();
  expect(recheck).toHaveBeenCalledWith(id, "handle", "confirm:instagram");
});
