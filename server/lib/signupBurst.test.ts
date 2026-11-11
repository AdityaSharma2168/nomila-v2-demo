/**
 * signupBurst.test.ts — the anti-script guard on NEW account creation (lib/signupBurst.ts), through the real landing route
 * (POST /waitlist) and the app's POST /auth/signup on Express + PGlite. Research is mocked off (no provider reached).
 *
 *   B1 per IP (set low here): the IP's hourly guard on NEW accounts answers a calm 429 (Retry-After, error signups_busy) and creates
 *      nothing; an existing account updating her answers is never counted or refused
 *   B2 global, only when NEW_ACCOUNTS_PER_HOUR is explicitly set: refuses a new account from any IP; the next hour has room
 *   B3 the app's /auth/signup create is limited the same way
 *   B4 defaults: per IP 200 an hour, global OFF; 0 turns either off; an unreadable value falls back to the default
 *   B5 off means off: with both limits off nothing is counted and every new account succeeds; with the defaults a
 *      burst from many addresses is never refused (no global ceiling)
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("./auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
jest.mock("./backgroundHost", () => ({ runsBackgroundWork: () => false }));
jest.mock("../skills/researchAthlete", () => ({ ...jest.requireActual("../skills/researchAthlete"), researchAthlete: jest.fn(async () => { throw new Error("no provider in this test"); }) }));
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: jest.fn(async () => ({})), getMarketability: jest.fn(async () => null) }));
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn(async () => ({ started: false, reason: "disabled" })), reenterIdentityResolution: jest.fn() }));
jest.setTimeout(120_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb } from "../testUtils/pgliteDb";
import { athletes, publicRateCounters } from "../../shared/schema";
import authRouter from "../routes/auth";
import waitlistRouter from "../routes/waitlist";
import { newAccountAllowed, newAccountsPerHour, newAccountsPerIpPerHour } from "./signupBurst";

let server: Server; let base = ""; const env = process.env;
let n = 0; const uniq = (s: string) => `${s}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

const post = async (path: string, uid: string, body: Record<string, unknown>, ip = "203.0.113.7") => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok", "x-forwarded-for": ip }, body: JSON.stringify(body) });
  return { status: r.status, retryAfter: r.headers.get("retry-after"), json: await r.json().catch(() => ({})) as any };
};
const rowFor = async (uid: string) => (await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, uid)))[0] ?? null;

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.set("trust proxy", 1); app.use(express.json()); app.use("/auth", authRouter); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", SIGNUP_RESEARCH_AGENT: "false", RESEARCH_REFRESH_ENABLED: "false",
    NEW_ACCOUNTS_PER_IP_PER_HOUR: "2", NEW_ACCOUNTS_PER_HOUR: "100" };
  await db.delete(publicRateCounters);
});

test("B1: the per-IP ceiling refuses a third new account with a calm 429; an existing account is never refused", async () => {
  const a = uniq("uid-a"); const b = uniq("uid-b"); const c = uniq("uid-c");
  expect((await post("/waitlist", a, {})).status).toBe(200);
  expect((await post("/waitlist", b, {})).status).toBe(200);
  const third = await post("/waitlist", c, {});
  expect(third.status).toBe(429);
  expect(third.json.error).toBe("signups_busy");
  expect(Number(third.retryAfter)).toBeGreaterThan(0);
  expect(await rowFor(c)).toBeNull();                                                           // nothing created
  expect((await post("/waitlist", a, { sport: "Golf" })).status).toBe(200);                    // her later steps still save
  expect((await post("/waitlist", uniq("uid-other-ip"), {}, "198.51.100.9")).status).toBe(200); // another IP has its own count
});

test("B2: the global ceiling refuses a new account from any IP; the next hour has room again", async () => {
  process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR = "100"; process.env.NEW_ACCOUNTS_PER_HOUR = "2";
  expect((await post("/waitlist", uniq("g1"), {}, "198.51.100.1")).status).toBe(200);
  expect((await post("/waitlist", uniq("g2"), {}, "198.51.100.2")).status).toBe(200);
  expect((await post("/waitlist", uniq("g3"), {}, "198.51.100.3")).status).toBe(429);
  const nextHour = new Date(Date.now() + 3_600_000);
  expect(await newAccountAllowed({ ip: "198.51.100.4" } as any, nextHour)).toBe(true);
});

test("B3: the app's /auth/signup create is limited the same way", async () => {
  const body = { name: "App Signer", role: "athlete" };
  expect((await post("/auth/signup", uniq("s1"), body)).status).toBe(201);
  expect((await post("/auth/signup", uniq("s2"), body)).status).toBe(201);
  const third = await post("/auth/signup", uniq("s3"), body);
  expect(third.status).toBe(429);
  expect(third.json.error).toBe("signups_busy");
});

test("B4: defaults are sane and env-tunable", () => {
  delete process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR; delete process.env.NEW_ACCOUNTS_PER_HOUR;
  expect([newAccountsPerIpPerHour(), newAccountsPerHour()]).toEqual([200, null]);       // global ceiling off by default
  process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR = "0"; process.env.NEW_ACCOUNTS_PER_HOUR = "0";
  expect([newAccountsPerIpPerHour(), newAccountsPerHour()]).toEqual([null, null]);      // 0 = off
  process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR = "nope"; process.env.NEW_ACCOUNTS_PER_HOUR = "-3";
  expect([newAccountsPerIpPerHour(), newAccountsPerHour()]).toEqual([200, null]);       // unreadable = the default
  process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR = "50"; process.env.NEW_ACCOUNTS_PER_HOUR = "500";
  expect([newAccountsPerIpPerHour(), newAccountsPerHour()]).toEqual([50, 500]);
});

test("B5: off means off; the defaults never refuse a burst spread over many addresses", async () => {
  process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR = "0"; process.env.NEW_ACCOUNTS_PER_HOUR = "0";
  for (let i = 0; i < 5; i++) expect((await post("/waitlist", uniq("off"), {})).status).toBe(200);   // same IP, no limit
  expect(await db.select().from(publicRateCounters)).toEqual([]);                                 // nothing counted
  delete process.env.NEW_ACCOUNTS_PER_IP_PER_HOUR; delete process.env.NEW_ACCOUNTS_PER_HOUR;
  for (let i = 0; i < 8; i++) expect((await post("/waitlist", uniq("many"), {}, `198.51.100.${10 + i}`)).status).toBe(200);
  const buckets = await db.select().from(publicRateCounters);
  expect(buckets).toHaveLength(8);                                                                // per-IP buckets only, no global one
});
