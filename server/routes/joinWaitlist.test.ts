/**
 * joinWaitlist.test.ts — sign-up status and the waitlist rank, on Express + PGlite:
 *
 *   J2 an agent-front sign-up is created 'raw' (dev today; the JOIN_WAITLIST join flow was deleted 2 Nov 2026); a plain
 *      front sign-up is 'raw' too, with today's legacy run
 *   R1 GET /waitlist/rank works for an athlete created through /auth/signup, and connecting moves her up: ACTIVE
 *      Instagram / TikTok / YouTube connections count, one per distinct provider account; revoked rows, other
 *      platforms and a typed handle on a platform she has connected do not add; sign-up time breaks ties
 *   R2 not waitlisted ⇒ 404 (unchanged)
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
jest.mock("../workflow/runner", () => ({ startRun: (...a: unknown[]) => startRun(...a) }));
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn().mockResolvedValue({ started: false, reason: "disabled" }) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedConnection } from "../testUtils/pgliteDb";
import { athletes } from "../../shared/schema";
import authRouter from "./auth";
import waitlistRouter, { RANK_FLOOR, TOTAL_BASE } from "./waitlist";

let server: Server; let base: string; const env = process.env;
const as = (uid: string) => verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
const signup = async (uid: string, body: Record<string, unknown>) => {
  as(uid);
  const r = await fetch(`${base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const rank = async (uid: string) => {
  as(uid);
  const r = await fetch(`${base}/waitlist/rank`, { headers: { authorization: "Bearer tok" } });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const statusOf = async (id: string) => (await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, id)))[0]?.status;
const onboardingStarts = () => startRun.mock.calls.filter(([o]: any[]) => o?.process === "onboarding");
const ON = { SIGNUPS_OPEN: "true", AGENT_ONBOARDING: "true" };

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/auth", authRouter); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { startRun.mockClear(); });
afterEach(() => { process.env = env; });

test.each([["legacy create branch", "false"], ["index path created branch", "true"]])("J2, %s: an agent-front sign-up is raw; a plain-front sign-up is raw with today's legacy run", async (_b, claim) => {
  process.env = { ...env, ...ON, ATHLETE_INDEX_CLAIM: claim };
  const off = await signup(`uid-off-${claim}`, { name: claim === "true" ? "Quillon Zanzibarova" : "Otto Offswitch", role: "athlete", sport: "Golf", front: "agent" });
  expect([off.status, off.json.status, off.json.error]).toEqual([201, "raw", undefined]);
  // Today's row status, unchanged: 'raw' (the index path's membership link then moves raw → 'claimed', identity/link.ts).
  expect(await statusOf(off.json.id)).toBe(claim === "true" ? "claimed" : "raw");

  const plain = await signup(`uid-plain-${claim}`, { name: claim === "true" ? "Ximena Dovrecourt" : "Pat Plainfront", role: "athlete", sport: "Golf" });
  expect([plain.status, plain.json.status, plain.json.error]).toEqual([201, "raw", undefined]);
  expect(await statusOf(plain.json.id)).toBe(claim === "true" ? "claimed" : "raw");
  expect(onboardingStarts().map(([o]: any[]) => o.athleteId)).toEqual([plain.json.id]);
});

test("R1: rank works for /auth/signup athletes and counts active connected accounts (one per distinct account) plus legacy typed handles", async () => {
  process.env = { ...env, ...ON, ATHLETE_INDEX_CLAIM: "false", WAITLIST_ALL_SIGNUPS: "true" };
  const a = await signup("uid-rank-a", { name: "Rank Alpha", role: "athlete", sport: "Golf", front: "agent" });
  const b = await signup("uid-rank-b", { name: "Rank Bravo", role: "athlete", sport: "Golf", front: "agent" });
  // Fix the sign-up order (the tie-break) and clear other waitlisted rows' influence by giving them no socials.
  await db.update(athletes).set({ created_at: new Date("2026-01-01T00:00:00Z") } as any).where(eq(athletes.id, a.json.id));
  await db.update(athletes).set({ created_at: new Date("2026-01-02T00:00:00Z") } as any).where(eq(athletes.id, b.json.id));
  const others = (await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.status, "waitlisted"))).length - 2;

  const before = await rank("uid-rank-b");
  expect(before.status).toBe(200);
  expect([TOTAL_BASE, RANK_FLOOR]).toEqual([0, 0]);                 // real numbers only: no phantom members, no floor
  expect(before.json).toMatchObject({ socials: 0, connected: 0, total: others + 2 });
  const aBefore = (await rank("uid-rank-a")).json.rank;
  expect(before.json.rank).toBeGreaterThan(aBefore);       // a tie: the earlier sign-up is ahead

  // Bravo connects Instagram (twice the same account would be one row by 0071; a second, different account counts),
  // plus noise that must not count: a revoked TikTok, a Gmail inbox.
  await seedConnection({ athleteId: b.json.id, platform: "instagram", platformUserId: "ig-1" });
  await seedConnection({ athleteId: b.json.id, platform: "tiktok", platformUserId: "tt-1", status: "revoked" });
  await seedConnection({ athleteId: b.json.id, platform: "gmail" });
  const after = await rank("uid-rank-b");
  expect(after.json).toMatchObject({ socials: 1, connected: 1 });
  expect(after.json.rank).toBe(aBefore);                    // connecting moved her past Alpha (the others have no socials, signed up later)
  expect(after.json.rank).toBeGreaterThanOrEqual(1);
  expect(after.json.rank).toBeLessThanOrEqual(after.json.total);

  await seedConnection({ athleteId: b.json.id, platform: "youtube", platformUserId: "yt-1" });
  await seedConnection({ athleteId: b.json.id, platform: "instagram", platformUserId: "ig-2" });   // a second Instagram account
  expect((await rank("uid-rank-b")).json).toMatchObject({ socials: 3, connected: 3 });

  // Legacy typed handles: one on a platform she has connected adds nothing; one on another platform adds one.
  await db.update(athletes).set({ socials: { instagram: "@bravo", twitter: "@bravo", tiktok: "" } } as any).where(eq(athletes.id, b.json.id));
  expect((await rank("uid-rank-b")).json).toMatchObject({ socials: 4, connected: 3 });

  // Alpha with typed handles only (the old landing form) still counts them.
  await db.update(athletes).set({ socials: { instagram: "@alpha", tiktok: "@alpha" } } as any).where(eq(athletes.id, a.json.id));
  expect((await rank("uid-rank-a")).json).toMatchObject({ socials: 2, connected: 0 });
});

test("R2: not on the waitlist ⇒ 404, as before", async () => {
  process.env = { ...env, ...ON, ATHLETE_INDEX_CLAIM: "false" };
  const r = await signup("uid-rank-raw", { name: "Rank Raw", role: "athlete", sport: "Golf", front: "agent" });
  expect(r.json.status).toBe("raw");
  expect((await rank("uid-rank-raw")).status).toBe(404);
});

// ─── S: the landing creates her row at sign-in (a post with no sport), and research waits for sport + a real name ───
const post = async (uid: string, body: Record<string, unknown>, token: Record<string, unknown> = {}) => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true, ...token });
  const r = await fetch(`${base}/waitlist`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const rowOf = async (uid: string) => (await db.select({ id: athletes.id, full_name: athletes.full_name, email: athletes.email, sport: athletes.sport, status: athletes.status }).from(athletes).where(eq(athletes.auth_id, uid)))[0];
const settle = () => new Promise((r) => setTimeout(r, 300));   // the research start is fire-and-forget

test.each([["legacy route", "false"], ["agent route", "true"]])("S1, %s: the sign-in post (no sport) creates her waitlisted row from the token and starts no research", async (_r, agent) => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", SIGNUP_RESEARCH_AGENT: agent };
  const uid = `uid-signin-${agent}`;
  const r = await post(uid, {}, { name: "Sasha Signin" });
  expect([r.status, r.json.returning]).toEqual([200, false]);
  expect(await rowOf(uid)).toMatchObject({ full_name: "Sasha Signin", email: `${uid}@example.com`, sport: null, status: "waitlisted" });
  await settle();
  expect(startRun).not.toHaveBeenCalled();
  // Her sport arrives later: the row is updated (returning) and research starts, once, under her name.
  const s = await post(uid, { sport: "Golf" }, { name: "Sasha Signin" });
  expect([s.status, s.json.returning]).toEqual([200, true]);
  await settle();
  expect(startRun.mock.calls.map(([o]: any[]) => o.process)).toEqual([agent === "true" ? "signup_research" : "onboarding"]);
});

test.each([["legacy route", "false"], ["agent route", "true"]])("S2, %s: a name-less sign-in is named by her e-mail's local part, and research never searches for it — it waits for the name she types", async (_r, agent) => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", SIGNUP_RESEARCH_AGENT: agent };
  const uid = `uid-noname-${agent}`;
  expect((await post(uid, {})).status).toBe(200);
  expect((await rowOf(uid)).full_name).toBe(uid);                       // the e-mail's local part (NOT NULL)
  expect((await post(uid, { sport: "Golf" })).status).toBe(200);         // a sport with no typed name: still nothing
  await settle();
  expect(startRun).not.toHaveBeenCalled();
  expect((await post(uid, { sport: "Golf", full_name: "Noor Named", first_name: "Noor", last_name: "Named" })).status).toBe(200);
  await settle();
  expect((await rowOf(uid)).full_name).toBe("Noor Named");
  expect(startRun.mock.calls.map(([o]: any[]) => o.process)).toEqual([agent === "true" ? "signup_research" : "onboarding"]);
  if (agent === "true") expect(startRun.mock.calls[0][0].input).toEqual({ name: "Noor Named", sport: "Golf" });
});

test.each([["index off", "false"], ["index on", "true"]])("S3, %s: sign-ups closed ⇒ the sign-in post is refused (403 signups_closed) and creates nothing", async (_b, claim) => {
  process.env = { ...env, SIGNUPS_OPEN: "false", ATHLETE_INDEX_CLAIM: claim, SIGNUP_RESEARCH_AGENT: "false" };
  const uid = `uid-closed-${claim}`;
  const r = await post(uid, {}, { name: claim === "true" ? "Quintessa Closedova" : "Carl Closed" });
  expect([r.status, r.json.error]).toEqual([403, "signups_closed"]);
  expect(await rowOf(uid)).toBeUndefined();
  expect(startRun).not.toHaveBeenCalled();
});
