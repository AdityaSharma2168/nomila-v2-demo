/**
 * auth.signup.lifecycle.test.ts — PR E2b (design record pr-e-identity-resolution-design.md §5.4, D14): POST /auth/signup
 * calls startLifecycleResearch at exactly the record's three sites — the index path's created branch (signup), its
 * claim-link branch (claim) and the legacy create branch (signup) — never awaited and never fatal. The service itself
 * (a no-op unless identityResolutionEnabled()) is covered in research/lifecycle.test.ts; here it is mocked.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn(); const setCustomUserClaims = jest.fn().mockResolvedValue(undefined);
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),   // routes/auth /signup and waitlist verify through lib/auth
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...a), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
const startRun = jest.fn().mockResolvedValue({ runId: "r" });
jest.mock("../workflow/runner", () => ({ startRun: (...a: unknown[]) => startRun(...a) }));
const startLifecycleResearch = jest.fn();
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: (...a: unknown[]) => startLifecycleResearch(...a) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes } from "../../shared/schema";
import authRouter from "./auth";

let server: Server; let base: string; const env = process.env;
const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };   // the hook loads the service only when the boundary is open
const signup = async (uid: string, body: Record<string, unknown>, email: string | null = null, emailVerified = false) => {
  verifyIdToken.mockResolvedValue({ uid, email: email ?? undefined, email_verified: emailVerified });
  const r = await fetch(`${base}/signup`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
/** The call is fire-and-forget (a dynamic import): let it land. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/", authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { startLifecycleResearch.mockReset().mockResolvedValue({ started: false, reason: "disabled" }); startRun.mockClear(); });
afterEach(() => { process.env = env; });

test("legacy create branch (claim flag off): signup → startLifecycleResearch(id, 'signup') next to the onboarding start", async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: "false" };
  const r = await signup("uid-life-legacy", { name: "Lena Fresh", role: "athlete", sport: "golf" }, "lena@example.com", true);
  expect(r.status).toBe(201);
  await settle();
  expect(startLifecycleResearch).toHaveBeenCalledTimes(1);
  expect(startLifecycleResearch).toHaveBeenCalledWith(r.json.id, "signup");
});

test("index path created branch (claim flag on): signup → startLifecycleResearch(id, 'signup')", async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: "true" };
  const r = await signup("uid-life-created", { name: "Mina Newcomer", role: "athlete", sport: "archery" }, "mina@example.com", true);
  expect(r.status).toBe(201);
  await settle();
  expect(startLifecycleResearch).toHaveBeenCalledWith(r.json.id, "signup");
});

test("index path claim-link branch: a unique verified e-mail links the row → startLifecycleResearch(id, 'claim')", async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: "true" };
  const open = await seedAthlete("Tove Lindgren"); await db.update(athletes).set({ sport: "golf", status: "enriched", email: "tove@example.com" } as any).where(eq(athletes.id, open));
  const r = await signup("uid-life-claim", { name: "Tove Lindgren", role: "athlete", sport: "golf" }, "tove@example.com", true);
  expect(r.status).toBe(200); expect(r.json.id).toBe(open);
  await settle();
  expect(startLifecycleResearch).toHaveBeenCalledTimes(1);
  expect(startLifecycleResearch).toHaveBeenCalledWith(open, "claim");
});

test("never for a non-athlete role or a signup without a sport (the onboarding guard), and never fatal", async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: "false" };
  const noSport = await signup("uid-life-nosport", { name: "Ada Nosport", role: "athlete" }, "ada@example.com", true);
  expect(noSport.status).toBe(201);
  await settle();
  expect(startLifecycleResearch).not.toHaveBeenCalled();
  startLifecycleResearch.mockRejectedValue(new Error("boom"));
  const r = await signup("uid-life-boom", { name: "Bo Boom", role: "athlete", sport: "golf" }, "bo@example.com", true);
  expect(r.status).toBe(201);                         // a failing lifecycle start never fails signup
  await settle();
  expect(startLifecycleResearch).toHaveBeenCalledTimes(1);
});

// ── PR H2 (R-a): the signup M.I.A. request moves to after Q1 when identity resolution is on ──────────────────────────
const miaStarts = () => startRun.mock.calls.filter(([o]: any[]) => o?.process === "mia_evaluation");
const until = async (ok: () => boolean, ms = 5000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 25)); };

test.each([["index path created branch (the only signup site that requests M.I.A.)", "true"]])("R-a, %s: flag ON ⇒ NO signup M.I.A. request (it is requested when identity resolves); flag OFF ⇒ today's request", async (_branch, claim) => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: claim };
  const on = await signup(`uid-ra-on-${claim}`, { name: "Quinta Zephyrine", role: "athlete", sport: "golf" }, `rae-on-${claim}@example.com`, true);
  expect(on.status).toBe(201);
  await until(() => startLifecycleResearch.mock.calls.length > 0);
  await new Promise((r) => setTimeout(r, 300));       // give a (wrong) dynamic-import request time to land
  expect(miaStarts()).toEqual([]);
  expect(startLifecycleResearch).toHaveBeenCalledWith(on.json.id, "signup");   // the lifecycle (and so Q1) still starts

  startRun.mockClear();
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: claim };
  const off = await signup(`uid-ra-off-${claim}`, { name: "Bartholomew Okonkwo", role: "athlete", sport: "golf" }, `rae-off-${claim}@example.com`, true);
  expect(off.status).toBe(201);
  await until(() => miaStarts().length > 0);
  expect(miaStarts()).toHaveLength(1);
  expect(miaStarts()[0][0]).toMatchObject({ process: "mia_evaluation", athleteId: off.json.id, input: { trigger: "IDENTITY_RESOLVED", force: false }, createdBy: "app_signup" });
});

// ── The agent onboarding front: signs up with front: "agent" once the sports are picked ──────────────────────────────
const onboardingStarts = () => startRun.mock.calls.filter(([o]: any[]) => o?.process === "onboarding");

test.each([["legacy create branch", "false"], ["index path created branch", "true"]])("agent front, %s: with AGENT_ONBOARDING on neither the legacy onboarding run nor legacy lifecycle research starts (the agent researches her — legacy intelligence switch-off); off ⇒ unchanged", async (_b, claim) => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: claim, AGENT_ONBOARDING: "true" };
  const on = await signup(`uid-front-on-${claim}`, { name: claim === "true" ? "Front Zeta" : "Front Tester", role: "athlete", sport: claim === "true" ? "Sport Z" : "Sport A", front: "agent" }, `front-on-${claim}@example.com`, true);
  expect(on.status).toBe(201);
  await settle();
  expect(onboardingStarts()).toEqual([]);
  expect(startLifecycleResearch).not.toHaveBeenCalled();
  const [row] = await db.select({ sport: athletes.sport, required: athletes.agent_onboarding_required }).from(athletes).where(eq(athletes.id, on.json.id));
  expect(row.sport).toBe(claim === "true" ? "Sport Z" : "Sport A");                  // the main sport reaches the row (and the index match)
  // fix/existing-users-skip-onboarding: only a real agent-front signup is marked as needing the agent onboarding.
  expect(row.required).toBe(true);

  startRun.mockClear();
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: claim, AGENT_ONBOARDING: "false" };
  const off = await signup(`uid-front-off-${claim}`, { name: claim === "true" ? "Quill Ottoline" : "Other Tester", role: "athlete", sport: "Sport A", front: "agent" }, `front-off-${claim}@example.com`, true);
  expect(off.status).toBe(201);
  await settle();
  expect(onboardingStarts()).toHaveLength(1);
  expect(startLifecycleResearch).toHaveBeenCalledWith(off.json.id, "signup");   // not agent-front ⇒ the legacy lifecycle, as before
  // AGENT_ONBOARDING off ⇒ agentFrontSignup() is false even though the body still says front: "agent" ⇒ not required.
  const [offRow] = await db.select({ required: athletes.agent_onboarding_required }).from(athletes).where(eq(athletes.id, off.json.id));
  expect(offRow.required).toBe(false);
});

test("agent front with identity resolution OFF: no signup M.I.A. request either — her M.I.A. runs only through the agent path; a plain signup still gets today's request", async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "true", AGENT_ONBOARDING: "true" };
  const front = await signup("uid-front-mia", { name: "Front Mia Check", role: "athlete", sport: "golf", front: "agent" }, "front-mia@example.com", true);
  expect(front.status).toBe(201);
  const plain = await signup("uid-plain-mia", { name: "Plain Mia Check", role: "athlete", sport: "golf" }, "plain-mia@example.com", true);
  expect(plain.status).toBe(201);
  await until(() => miaStarts().length > 0);
  await new Promise((r) => setTimeout(r, 300));       // give a (wrong) request for the agent-front athlete time to land
  expect(miaStarts().map(([o]: any[]) => o.athleteId)).toEqual([plain.json.id]);
});

test("a plain signup (no front: agent) never sets agent_onboarding_required, with AGENT_ONBOARDING on or off", async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ...ON, ATHLETE_INDEX_CLAIM: "false", AGENT_ONBOARDING: "true" };
  const r = await signup("uid-plain-agent-on", { name: "Plain Signup", role: "athlete", sport: "golf" }, "plain@example.com", true);
  expect(r.status).toBe(201);
  const [row] = await db.select({ required: athletes.agent_onboarding_required }).from(athletes).where(eq(athletes.id, r.json.id));
  expect(row.required).toBe(false);
});
