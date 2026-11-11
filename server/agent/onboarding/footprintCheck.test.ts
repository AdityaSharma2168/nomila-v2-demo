/**
 * footprintCheck.test.ts — the "real athlete?" check in front of the sign-up research (ATHLETE_FOOTPRINT_CHECK; anti-fake
 * plan, owner, 24 Oct 2026), end to end through the landing route (POST /waitlist, GET /waitlist/progress) on Express +
 * PGlite. The model is a fake transport (setResponsesTransport) and Instagram's Graph read is mocked: nothing here
 * reaches a provider.
 *
 *   P1 found ⇒ the full signup_research run starts as before; no flag
 *   P2 not found ⇒ no research run; she is still on the waitlist; the admin flag no_athlete_footprint carries the reason;
 *      progress answers research.state "needs_more" with the reason; repeated posts with the same inputs pay once
 *   P3 adding a team re-runs the check (new inputs) ⇒ found ⇒ research starts, the flag is cleared
 *   P4 connecting Instagram (a real account with posts) ⇒ re-check with the account ⇒ found ⇒ research; an account with
 *      no posts adds nothing (no new check, still held)
 *   P5 a model error ⇒ treated as found ⇒ research (fail open)
 *   P6 flag off ⇒ no check at all, research as before; the check's cost counts toward the daily cap even with no run;
 *      a spent cap skips the check (no call) and the research starts held under the cap
 *   P7 the request: ONE web search, the fast (OpenAI) tier, the structured schema
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op: nothing executes
jest.mock("../../skills/researchAthlete", () => ({ ...jest.requireActual("../../skills/researchAthlete"), researchAthlete: jest.fn(async () => { throw new Error("no provider in this test"); }) }));
jest.mock("../../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: jest.fn(async () => ({})), getMarketability: jest.fn(async () => null) }));
jest.mock("../../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn(async () => ({ started: false, reason: "disabled" })), reenterIdentityResolution: jest.fn() }));
const mockIgCounts = jest.fn();
jest.mock("../../lib/integrations/instagram", () => ({ ...jest.requireActual("../../lib/integrations/instagram"), fetchInstagramProfileCounts: (...a: unknown[]) => mockIgCounts(...a) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { agentRuns, athletes } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { resetRunnerConfig } from "../../workflow/runner";
import { setResponsesTransport } from "../research/llm";
import { fakeResponses, skillOf } from "../../testUtils/agentModel";
import waitlistRouter from "../../routes/waitlist";
import { signupSpendTodayMicroUsd } from "./dailyCap";
import { FOOTPRINT_SKILL_ID, recheckAfterInstagram } from "./footprintCheck";

let server: Server; let base = ""; const env = process.env;
let n = 0; const uniq = (s: string) => `${s}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

/** The fake model: whatever `answer` says for a footprint request (by the athlete's inputs), or throws. */
let answer: (input: string) => Record<string, unknown> | Error = () => ({ found: true, confidence: "high", evidence_url: "https://example.com/roster", reason: "I found a roster page." });
const transport = fakeResponses(async (params) => {
  if (skillOf(params) !== FOOTPRINT_SKILL_ID) throw new Error(`unexpected skill ${skillOf(params)}`);
  const a = answer(JSON.stringify(params.input));
  if (a instanceof Error) throw a;
  return { json: a, sources: [{ url: "https://example.com/roster", title: "Roster" }], usage: { input: 3000, output: 120, reasoning: 20 } };
});

const post = async (path: string, uid: string, body: Record<string, unknown>) => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const get = async (path: string, uid: string) => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
  const r = await fetch(`${base}${path}`, { headers: { authorization: "Bearer tok" } });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const idByUid = async (uid: string) => (await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, uid)))[0]!.id;
const runsOf = async (id: string) => db.select({ process: workflowRuns.process }).from(workflowRuns).where(eq(workflowRuns.athlete_id, id));
const checksOf = async (id: string) => (await db.select({ skill: agentRuns.skill_id }).from(agentRuns).where(eq(agentRuns.athlete_id, id))).filter((r) => r.skill === FOOTPRINT_SKILL_ID);
const flagsOf = async (id: string) => (await db.select({ f: athletes.signup_flags }).from(athletes).where(eq(athletes.id, id)))[0]!.f as any;
/** The start is fire-and-forget: wait until `cond` holds (or give up). */
async function until(cond: () => Promise<boolean>, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); }
}
const settle = () => new Promise((r) => setTimeout(r, 400));

/** Joins with a name and sport (the post that starts research). */
async function join(name: string, extra: Record<string, unknown> = {}) {
  const uid = uniq("uid");
  expect((await post("/waitlist", uid, {})).status).toBe(200);                                   // the sign-in's own post
  expect((await post("/waitlist", uid, { full_name: name, sport: "Rowing", ...extra })).status).toBe(200);
  return { uid, id: await idByUid(uid) };
}

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.use(express.json()); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { setResponsesTransport(null); process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", SIGNUP_RESEARCH_AGENT: "true", ATHLETE_FOOTPRINT_CHECK: "true",
    DAILY_RESEARCH_CAP_USD: "300", AGENT_ONBOARDING_COST_CAP_USD: "2", DAILY_CAP_MIA_RESERVE_USD: "0", NEW_ACCOUNTS_PER_IP_PER_HOUR: "0",
    RESEARCH_REFRESH_ENABLED: "false", RESEARCH_SUBSTRATE_WRITE: "false", RESEARCH_REFRESH_PROVIDER: "kimi", OPENAI_API_KEY: "test-key" };
  resetRunnerConfig();
  setResponsesTransport(transport as any);
  transport.calls.length = 0;
  mockIgCounts.mockReset();
  answer = (input) => (/Nobody/.test(input) && !/Harbor Rowing Club|real_handle/.test(input)
    ? { found: false, confidence: "medium", evidence_url: null, reason: "I couldn't find any public page for this name in this sport yet." }
    : { found: true, confidence: "high", evidence_url: "https://example.com/roster", reason: "I found a roster page for this name." });
  await db.delete(workflowSteps); await db.delete(workflowRuns); await db.delete(agentRuns);
});

test("P1: found ⇒ the full research starts as before; no flag", async () => {
  const { id } = await join(`Real ${uniq("Person")}`);
  await until(async () => (await runsOf(id)).length > 0);
  expect((await runsOf(id)).map((r) => r.process)).toEqual(["signup_research"]);
  expect(await checksOf(id)).toHaveLength(1);
  expect(await flagsOf(id)).toBeNull();
});

test("P2: not found ⇒ no research, still waitlisted, flagged, progress says needs_more; the same inputs pay once", async () => {
  const { uid, id } = await join(`Nobody ${uniq("Fake")}`);
  await until(async () => !!(await flagsOf(id))?.no_athlete_footprint);
  await settle();
  expect(await runsOf(id)).toEqual([]);
  const row = (await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, id)))[0];
  expect(row.status).toBe("waitlisted");
  expect((await flagsOf(id)).no_athlete_footprint).toMatchObject({ reason: "I couldn't find any public page for this name in this sport yet.", confidence: "medium" });
  const p = await get("/waitlist/progress", uid);
  expect(p.status).toBe(200);
  expect(p.json.research).toMatchObject({ state: "needs_more", reason: "I couldn't find any public page for this name in this sport yet." });

  expect((await post("/waitlist", uid, { career_status: "active" })).status).toBe(200);         // a later step, same inputs
  expect((await post("/waitlist", uid, { sport: "Rowing" })).status).toBe(200);
  await settle();
  expect(transport.calls).toHaveLength(1);                                                         // the finished check is reused
  expect(await runsOf(id)).toEqual([]);
});

test("P3: adding a team re-runs the check ⇒ found ⇒ research starts and the flag clears", async () => {
  const { uid, id } = await join(`Nobody ${uniq("Teamless")}`);
  await until(async () => !!(await flagsOf(id))?.no_athlete_footprint);
  expect((await post("/waitlist", uid, { team: "Harbor Rowing Club", school: "Harbor Rowing Club" })).status).toBe(200);
  await until(async () => (await runsOf(id)).length > 0);
  expect((await runsOf(id)).map((r) => r.process)).toEqual(["signup_research"]);
  expect(await checksOf(id)).toHaveLength(2);
  expect(await flagsOf(id)).toBeNull();
  expect((await get("/waitlist/progress", uid)).json.research.state).not.toBe("needs_more");
});

test("P4: connecting a real Instagram account with posts re-checks ⇒ research; one with no posts adds nothing", async () => {
  const { id } = await join(`Nobody ${uniq("Insta")}`);
  await until(async () => !!(await flagsOf(id))?.no_athlete_footprint);
  await seedConnection({ athleteId: id, platform: "instagram" });

  mockIgCounts.mockResolvedValue({ username: "empty_handle", mediaCount: 0, followers: 3 });
  await recheckAfterInstagram(id);
  expect(transport.calls).toHaveLength(1);                                                         // same inputs: reused, no new call
  expect(await runsOf(id)).toEqual([]);

  mockIgCounts.mockResolvedValue({ username: "real_handle", mediaCount: 57, followers: 800 });
  await recheckAfterInstagram(id);
  await until(async () => (await runsOf(id)).length > 0);
  expect((await runsOf(id)).map((r) => r.process)).toEqual(["signup_research"]);
  expect(JSON.stringify(transport.calls[1].input)).toContain("real_handle");
  expect(await flagsOf(id)).toBeNull();

  await recheckAfterInstagram(id);                                                                 // not held any more: nothing
  expect(transport.calls).toHaveLength(2);
});

test("P5: a model error is treated as found ⇒ research (fail open)", async () => {
  answer = () => new Error("provider down");
  const { id } = await join(`Nobody ${uniq("Outage")}`);
  await until(async () => (await runsOf(id)).length > 0);
  expect((await runsOf(id)).map((r) => r.process)).toEqual(["signup_research"]);
  expect(await flagsOf(id)).toBeNull();
});

test("P6: flag off ⇒ no check; the check's cost counts in the daily cap without a run; a spent cap skips the call", async () => {
  process.env.ATHLETE_FOOTPRINT_CHECK = "false";
  const off = await join(`Nobody ${uniq("Off")}`);
  await until(async () => (await runsOf(off.id)).length > 0);
  expect(transport.calls).toHaveLength(0);
  expect(await checksOf(off.id)).toHaveLength(0);

  process.env.ATHLETE_FOOTPRINT_CHECK = "true";
  const before = (await signupSpendTodayMicroUsd()).agentRuns;
  const held = await join(`Nobody ${uniq("Counted")}`);
  await until(async () => !!(await flagsOf(held.id))?.no_athlete_footprint);
  expect(await runsOf(held.id)).toEqual([]);
  expect((await signupSpendTodayMicroUsd()).agentRuns).toBeGreaterThan(before);                   // counted with no research run

  const old = await seedAthlete(uniq("Old Account"));                                              // not a sign-up: still counted
  await db.insert(agentRuns).values({ athlete_id: old, skill_id: FOOTPRINT_SKILL_ID, skill_version: "1.0.0", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: 20_000, started_at: new Date(), ended_at: new Date() } as any);
  expect((await signupSpendTodayMicroUsd()).agentRuns).toBeGreaterThanOrEqual(before + 20_000);

  process.env.DAILY_RESEARCH_CAP_USD = "0.000001";                                                 // spent
  const calls = transport.calls.length;
  const capped = await join(`Nobody ${uniq("Capped")}`);
  await until(async () => (await runsOf(capped.id)).length > 0);
  expect(transport.calls).toHaveLength(calls);                                                     // no check bought past the cap
  expect((await runsOf(capped.id)).map((r) => r.process)).toEqual(["signup_research"]);           // starts held under the cap
});

test("P7: one web search on the fast (OpenAI) tier with the structured schema", async () => {
  await join(`Real ${uniq("Shape")}`);
  await until(async () => transport.calls.length > 0);
  const body = transport.calls[0];
  expect(body.max_tool_calls).toBe(1);
  expect(body.tools).toEqual([expect.objectContaining({ type: "web_search" })]);
  expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
  expect(Object.keys(body.text.format.schema.properties).sort()).toEqual(["confidence", "evidence_url", "found", "reason"]);
});
