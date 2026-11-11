/**
 * auth.me.test.ts — GET /auth/me: sport / school / conference are the projection columns, never the ledger.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
  firebaseAuth: { verifyIdToken: jest.fn() },
  verifyIdTokenChecked: jest.fn(),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes, athleteAffiliations } from "../../shared/schema";
import authRouter from "./auth";

let server: Server;
let base: string;
let athleteId: string;
const env = process.env;

async function me() { const res = await fetch(`${base}/me`); return { status: res.status, json: await res.json() as any }; }

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Me Athlete");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  await db.update(athletes).set({ sport: "soccer", school: "Stale Projection U", conference: "Old Conf", goal_archetype: "brand_builder", status: "active" } as any).where(eq(athletes.id, athleteId));
  await db.insert(athleteAffiliations).values({ athlete_id: athleteId, org_name: "Ledger University", org_kind: "school", level: "D1", conference: "Big West", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" });
  const app = express(); app.use(express.json()); app.use("/", authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
afterEach(() => { process.env = env; });

test("the projection columns, even when the ledger disagrees", async () => {
  process.env = { ...env };
  const r = await me();
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ id: athleteId, firstName: "Me", lastName: "Athlete", sport: "soccer", school: "Stale Projection U", conference: "Old Conf", goalArchetype: "brand_builder", role: "athlete" });
});

