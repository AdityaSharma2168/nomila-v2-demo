/**
 * waitlistProgress.test.ts — GET /api/v1/waitlist/progress (the join flow's wait and score screens) and POST
 * /api/v1/waitlist's `team`, on Express + PGlite with the real runner. Providers are never reached: the OpenAI
 * transport is a test double, the M.I.A. read is mocked, researchAthlete throws, kick is a no-op (ticks are explicit).
 *
 *   P1 pure: findings are only her found, active, sourced, non-care, non-disputed facts about her, mapped to the five
 *      kinds, a few of each in turn; the score card is the M.I.A.'s own numbers and words; the research state
 *   P2 auth: 401 without a token, 404 with no row
 *   P3 a legacy-researched athlete: not_started, [] and null, with her rank and connected socials
 *   P4 queued (daily cap) → queued + queuedUntil; running → [] / null even when an M.I.A. exists
 *   P5 done: her real facts (third person, with sources) and the real M.I.A. card
 *   P6 an exhausted OpenAI quota (429 insufficient_quota): the run fails, she stays waitlisted, the POST was 200,
 *      progress answers 200 with research "failed", no findings, no score — never an error
 *   P7 POST team: stored as her school / team; school wins when both are sent
 *   P8 research could not confirm who she is (a disputed identity fact) ⇒ findings [] (a namesake's facts are never hers)
 *   P9 her own referral code: stable, derived from her id, resolves back; a ?ref= code she arrives with is stored
 *   P10 /progress is rate-limited per signed-in user, not per IP (teammates on one network are never limited by each
 *       other); a 429 carries Retry-After
 *   P11 quick only (signup_research v4, dev): the quick score with its confidence; scoreStage quick, full processing
 *   P12 the full score lands: it replaces the quick one (no quickScore), scoreStage final + replacedQuick + timestamps
 *   P13 identity disputed: no quick score, before or after the research is done
 *   P14 flag off: a v2 run carries neither quickScore nor scoreStage (payload unchanged); the store gate off or the
 *       quick step off shows no quick score and never claims a replacement
 *   P15 research.live is the runner's real stage: the lean step's own writer on its running row (finding → reading N →
 *       checking N), then scoring, then final_ready; never written over a finished row; absent on a v2 run
 *   P16 liveStatusFrom (pure) and the stage reporter: ordered, throttled (latest count wins), pending dropped at the
 *       end, a failing write never throws
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
}));
jest.mock("../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op: the test ticks
jest.mock("../skills/researchAthlete", () => ({ ...jest.requireActual("../skills/researchAthlete"), researchAthlete: jest.fn(async () => { throw new Error("no provider in this test"); }) }));
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: jest.fn(async () => ({})), getMarketability: jest.fn(async () => null) }));
jest.mock("../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn(async () => ({ started: false, reason: "disabled" })), reenterIdentityResolution: jest.fn() }));
const mockReadMia = jest.fn();
const mockGetMia = jest.fn(async () => { throw new Error("no M.I.A. in this test"); });
jest.mock("../services/miaPreview/preview", () => ({ readMiaPreview: (...a: unknown[]) => mockReadMia(...a), getMiaPreview: (...a: unknown[]) => (mockGetMia as any)(...a) }));
const mockReadObject = jest.fn();
jest.mock("../lib/mediaStore", () => ({ ...jest.requireActual("../lib/mediaStore"), readObject: (...a: unknown[]) => mockReadObject(...a) }));   // never GCS
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { client, closeTestDb, db, initTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { agentRuns, athletes, intelligenceLedger, mediaAssets } from "../../shared/schema";
import { pickHeroPhoto } from "../agent/onboarding/heroPhoto";
import { workflowRuns, workflowSteps } from "../../shared/schemaWorkflow";
import type { MemoryFact, MiaPreview } from "../../shared/agent";
import { configureRunner, HELD_READY_AT, resetRunnerConfig, tick } from "../workflow/runner";
import { setResponsesTransport } from "../agent/research/llm";
import { dbStore } from "../agent/research/dbStore";
import { nextUtcMidnight } from "../agent/onboarding/dailyCap";
import { findingsFrom, liveStatusFrom, MAX_FINDING_TEXT, MAX_FINDINGS, plainLine, researchStateFrom, researchStepsFrom, scoreFrom } from "../agent/onboarding/waitlistProgress";
import { stageReporter, writeStepProgress } from "../agent/onboarding/leanResearchStep";
import waitlistRouter from "./waitlist";
import { athleteIdFromReferralCode, referralCodeFor } from "../lib/referralCode";
import { recordIdentityOutcome } from "../agent/research/research";

let server: Server; let base = ""; const env = process.env;
let n = 0; const uniq = (s: string) => `${s}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

const as = (uid: string) => verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
async function get(uid: string | null) {
  if (uid) as(uid);
  const r = await fetch(`${base}/waitlist/progress`, { headers: uid ? { authorization: "Bearer tok" } : {} });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
}
async function post(uid: string, body: Record<string, unknown>) {
  as(uid);
  const r = await fetch(`${base}/waitlist`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
}
/** A waitlisted athlete signed in as `uid`. */
const waitlister = (name: string, uid: string, extra: Record<string, unknown> = {}) => seedAthlete(name, { auth_id: uid, status: "waitlisted", sport: "Golf", ...extra } as any);
/** Her signup_research run with the given step rows (as the runner writes them). */
async function signupRun(athleteId: string, name: string, status: string, steps: Array<{ step: string; status: string; ready_at?: Date; output?: unknown; finished_at?: Date }>, version = 1) {
  const [run] = await db.insert(workflowRuns).values({ athlete_id: athleteId, process: "signup_research", definition_version: version, active_scope: "signup_research", status, input: { name, sport: "Golf" }, created_by: "signup", started_at: new Date() } as any).returning({ id: workflowRuns.id });
  for (const [i, s] of steps.entries()) await db.insert(workflowSteps).values({ run_id: run.id, ordinal: i, kind: "model", input: {}, ...s } as any);
  return run.id;
}

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAME = "Avery Example";
let fid = 0;
const fact = (over: Partial<MemoryFact>): MemoryFact => ({
  id: `f${++fid}`, athleteId: "a", subject: { kind: "athlete", name: NAME }, claim: `${NAME} won the regional title.`, type: "found",
  source: { url: "https://www.example-news.com/story", title: "Example News" }, date: "2026-05-01", confidence: 0.8, status: "active",
  supersededBy: null, runId: null, createdAt: "2026-10-01T00:00:00Z", topic: "achievement", ...over,
});
function preview(over: Partial<MiaPreview> = {}): MiaPreview {
  const group = (key: any, name: string, score: number | null) => ({ key, name, contribution: null, score, dimensions: [] });
  return {
    contract: "mia-preview/1", athleteId: "a", status: "ready", score: 512.4, scale: { min: 0, max: 850 },
    groups: [group("audience", "Audience", 41.6), group("commercial", "Commercial", 30), group("brand", "Brand", 66), group("performance", "Performance", null)],
    assessment: {
      entryId: "e", evidenceAsOf: "2026-10-01", createdAt: "2026-10-01", versions: { methodology: null, evaluator: null, params: null }, score: 512.4,
      readState: "assessed", overall: { level: "MEDIUM", explanation: null }, confidenceBand: null, summary: "A rising competitor with a clear story.",
      hasReasons: true, dimensions: [], evidence: [],
      notes: { strengths: ["Consistent podium results this season are well covered by regional press."], constraints: ["Little evidence of past brand partnerships."], missingEvidence: [], evaluationRisks: [] },
    },
    preliminary: true, label: "Preliminary — connect to sharpen", confidence: { level: "MEDIUM", explanation: null },
    inputs: { public: [], measured: [] },
    sharpen: [{ kind: "evidence", connector: null, text: "Recent press coverage." }, { kind: "connect", connector: "tiktok", service: "TikTok", reason: "measured_audience" }, { kind: "connect", connector: "instagram", service: "Instagram", reason: "measured_audience" }],
    evidenceAsOf: "2026-10-01", identity: { uncertain: false, factIds: [] }, provenance: null, ...over,
  };
}

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; setResponsesTransport(null); await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(async () => {
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", SIGNUP_RESEARCH_AGENT: "false",
    RESEARCH_REFRESH_ENABLED: "false", RESEARCH_SUBSTRATE_WRITE: "false", RESEARCH_REFRESH_PROVIDER: "kimi" };
  delete process.env.DAILY_RESEARCH_CAP_USD;
  resetRunnerConfig(); mockReadMia.mockReset(); mockReadMia.mockResolvedValue(preview({ status: "not_assessed", score: null, assessment: null }));
  setResponsesTransport((async () => { throw new Error("no model in this test"); }) as any);
  await db.delete(workflowSteps); await db.delete(workflowRuns);
});

// ─── P1 pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("P1: findings are only her real, sourced, shareable facts; the score card is the M.I.A.'s own; the research state", () => {
  const facts = [
    fact({ claim: `${NAME} plays for Example University.`, topic: "team", confidence: 0.9 }),
    fact({ claim: `${NAME} won the regional title.`, topic: "achievement" }),
    fact({ claim: `${NAME} is sponsored by Example Shoes.`, topic: "sponsor", source: { url: "https://brand.example.com/a" } }),
    fact({ claim: `${NAME} was featured on Example TV.`, topic: "media" }),
    fact({ claim: `${NAME} has 12,000 Instagram followers.`, topic: "social" }),
    fact({ claim: `${NAME} is recovering from an injury.`, topic: "status", sensitive: true }),           // care: never shown
    fact({ claim: `${NAME} might be a different athlete.`, topic: "identity", status: "disputed" }),         // disputed: never shown
    fact({ claim: `${NAME} said she loves golf.`, type: "said", topic: "story" }),                          // said: not research
    fact({ claim: `${NAME} competes in Example League.`, topic: "career", source: { ref: "onboarding/x#a" } }),   // no URL: no source to show
    fact({ subject: { kind: "athlete", name: "Somebody Else" }, claim: "Somebody Else won a medal.", topic: "achievement" }),
    fact({ claim: `${NAME} posted a recap.`, topic: "unknown_topic" }),
  ];
  const out = findingsFrom(facts, NAME);
  expect(out).toEqual([
    { kind: "about", text: `${NAME} plays for Example University.`, source: { label: "Example News", url: "https://www.example-news.com/story" } },
    { kind: "results", text: `${NAME} won the regional title.`, source: { label: "Example News", url: "https://www.example-news.com/story" } },
    { kind: "partners", text: `${NAME} is sponsored by Example Shoes.`, source: { label: "brand.example.com", url: "https://brand.example.com/a" } },
    { kind: "press", text: `${NAME} was featured on Example TV.`, source: { label: "Example News", url: "https://www.example-news.com/story" } },
    { kind: "audience", text: `${NAME} has 12,000 Instagram followers.`, source: { label: "Example News", url: "https://www.example-news.com/story" } },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => fact({ claim: `${NAME} result number ${i}.` }));
  expect(findingsFrom(many, NAME)).toHaveLength(MAX_FINDINGS);
  expect(findingsFrom([], NAME)).toEqual([]);

  expect(scoreFrom(preview())).toEqual({
    value: 512,
    groups: [{ key: "audience", label: "Audience", value: 42 }, { key: "commercial", label: "Commercial", value: 30 }, { key: "brand", label: "Brand", value: 66 }, { key: "performance", label: "Performance", value: null }],
    bands: [],
    confidence: "medium",
    lines: ["Consistent podium results this season are well covered by regional press.", "Little evidence of past brand partnerships."],
    raise: { text: "Connect your Instagram so your real audience numbers count.", action: "connect_instagram" },
  });
  expect(scoreFrom(preview({ sharpen: [{ kind: "evidence", connector: null, text: "Recent press coverage." }] }))!.raise).toEqual({ text: "Recent press coverage.", action: null });
  // The ring's bands: each dimension's stored contribution above zero, as the app's ring draws them.
  const dim = (key: string, contribution: number | null) => ({ key, contribution } as any);
  const withDims = preview(); withDims.assessment = { ...withDims.assessment!, dimensions: [dim("audience_scale", 8.44), dim("engagement_quality", 0), dim("brand_fit", null), dim("momentum", 6)] };
  expect(scoreFrom(withDims)!.bands).toEqual([{ key: "audience_scale", contribution: 8.4 }, { key: "momentum", contribution: 6 }]);
  expect(scoreFrom(preview({ status: "withheld_identity", score: null }))).toBeNull();
  expect(scoreFrom(null)).toBeNull();
  expect(plainLine("x".repeat(300))!.length).toBeLessThanOrEqual(201);

  const now = new Date();
  expect(researchStateFrom(null, [], now)).toEqual({ state: "not_started", queuedUntil: null });
  expect(researchStateFrom({ status: "running" }, [{ step: "research_a", status: "ready", ready_at: HELD_READY_AT }], now)).toEqual({ state: "queued", queuedUntil: nextUtcMidnight(now).toISOString() });
  expect(researchStateFrom({ status: "running" }, [{ step: "research_a", status: "running", ready_at: now }], now).state).toBe("running");
  expect(researchStateFrom({ status: "running" }, [{ step: "research_merge", status: "done", ready_at: now }, { step: "mia_preview", status: "running", ready_at: now }], now).state).toBe("done");
  expect(researchStateFrom({ status: "failed" }, [{ step: "research_a", status: "failed", ready_at: now }], now).state).toBe("failed");
});

// ─── route ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test("P2: 401 without a token, 404 with no waitlist row", async () => {
  expect((await get(null)).status).toBe(401);
  expect((await get(uniq("uid-nobody"))).status).toBe(404);
});

test("P3: a legacy-researched athlete: not_started, nothing invented, with her rank and connected socials", async () => {
  const uid = uniq("uid-legacy");
  const id = await waitlister("Legacy Athlete", uid);
  await db.insert(workflowRuns).values({ athlete_id: id, process: "onboarding", definition_version: 2, active_scope: "onboarding", status: "waiting", input: {}, created_by: "signup", started_at: new Date() } as any);
  await seedConnection({ athleteId: id, platform: "instagram" });
  await seedConnection({ athleteId: id, platform: "gmail" });                                   // not a waitlist social
  mockReadMia.mockResolvedValue(preview());                                                     // even with a score of record: not a new-route read
  const r = await get(uid);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ status: "waitlisted", research: { state: "not_started", queuedUntil: null }, findings: [], score: null, connected: ["instagram"] });
  expect(r.json.rank).toEqual({ position: expect.any(Number), total: expect.any(Number) });
});

test("P4: queued while the daily cap holds her research; running shows nothing yet", async () => {
  const uid = uniq("uid-queued");
  const id = await waitlister("Queued Athlete", uid);
  const runId = await signupRun(id, "Queued Athlete", "running", [{ step: "research_a", status: "ready", ready_at: HELD_READY_AT }, { step: "research_b", status: "ready", ready_at: HELD_READY_AT }]);
  let r = await get(uid);
  expect(r.json.research).toEqual({ state: "queued", queuedUntil: nextUtcMidnight(new Date()).toISOString(), readyEmail: false,   // v1 run: no email step
    steps: [{ key: "web", status: "pending" }, { key: "merge", status: "pending" }, { key: "score", status: "pending" }] });
  await db.update(workflowSteps).set({ status: "running", ready_at: new Date() }).where(eq(workflowSteps.run_id, runId));
  mockReadMia.mockResolvedValue(preview());
  r = await get(uid);
  expect(r.json).toMatchObject({ research: { state: "running", queuedUntil: null }, findings: [], score: null });
});

test("P5: done: her real facts with their sources and the real M.I.A. card", async () => {
  const uid = uniq("uid-done");
  const id = await waitlister(NAME, uid);
  await signupRun(id, NAME, "running", [{ step: "research_a", status: "done" }, { step: "research_b", status: "done" }, { step: "research_merge", status: "done" }, { step: "mia_preview", status: "running" }]);
  await dbStore.insertFacts(id, [
    { subject: { kind: "athlete", name: NAME }, claim: `${NAME} won the regional title.`, type: "found", source: { url: "https://www.example-news.com/story", title: "Example News" }, date: "2026-05-01", confidence: 0.8, runId: null, topic: "achievement" },
    { subject: { kind: "athlete", name: NAME }, claim: `${NAME} is recovering from an injury.`, type: "found", source: { url: "https://www.example-news.com/injury" }, date: "2026-05-01", confidence: 0.8, runId: null, topic: "status", sensitive: true, careKind: "personal" },
    { subject: { kind: "athlete", name: NAME }, claim: `The athlete's name is ${NAME}.`, type: "said", source: { ref: "onboarding/x#name", title: "You told us" }, date: "2026-10-01", confidence: 1, runId: null },
  ] as any);
  let r = await get(uid);                                                                       // merged, M.I.A. not ready yet
  expect(r.json.research.state).toBe("done");
  expect(r.json.findings).toEqual([{ kind: "results", text: `${NAME} won the regional title.`, source: { label: "Example News", url: "https://www.example-news.com/story" } }]);
  expect(r.json.score).toBeNull();
  mockReadMia.mockResolvedValue(preview());
  r = await get(uid);
  expect(r.json.score).toMatchObject({ value: 512, confidence: "medium", raise: { action: "connect_instagram" } });
  expect(r.json.score.groups.map((g: any) => g.key)).toEqual(["audience", "commercial", "brand", "performance"]);
  expect(mockReadMia).toHaveBeenCalledWith(id);
});

test("P6: an exhausted OpenAI quota fails the research, never the sign-up or the progress read", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  process.env.OPENAI_API_KEY = "test-not-used";
  const quota = Object.assign(new Error("429 You exceeded your current quota, please check your plan and billing details."), { status: 429, code: "insufficient_quota", type: "insufficient_quota" });
  const create = jest.fn(async () => { throw quota; });
  setResponsesTransport({ create } as any);
  configureRunner({ retry: { minTimeoutMs: 0, maxTimeoutMs: 0, randomize: false } });
  const uid = uniq("uid-quota");
  const joined = await post(uid, { first_name: "Quota", last_name: uniq("Case"), sport: "Golf" });
  expect(joined.status).toBe(200);                                                              // the sign-up never waits on research
  const [me] = await db.select({ id: athletes.id, status: athletes.status }).from(athletes).where(eq(athletes.auth_id, uid));
  let run: any;
  for (let i = 0; i < 60 && !run; i++) { [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.athlete_id, me.id)); if (!run) await new Promise((r) => setTimeout(r, 40)); }
  expect(run.process).toBe("signup_research");
  for (let i = 0; i < 12; i++) {
    await tick();
    const [now] = await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, run.id));
    if (now.status === "failed") break;
  }
  expect(create).toHaveBeenCalled();
  const [after] = await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, run.id));
  expect(after.status).toBe("failed");
  expect((await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, me.id)))[0].status).toBe("waitlisted");
  const r = await get(uid);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ status: "waitlisted", research: { state: "failed", queuedUntil: null }, findings: [], score: null });
  expect(r.json.rank).toEqual({ position: expect.any(Number), total: expect.any(Number) });
  expect((await post(uid, { career_status: "active" })).status).toBe(200);                     // later steps still work
});

test("P7: POST team is stored as her school / team; school wins when both are sent", async () => {
  const uid = uniq("uid-team");
  expect((await post(uid, { first_name: "Team", last_name: uniq("Player"), team: "Example City FC" })).status).toBe(200);
  const read = async () => (await db.select({ school: athletes.school }).from(athletes).where(eq(athletes.auth_id, uid)))[0].school;
  expect(await read()).toBe("Example City FC");
  expect((await post(uid, { sport: "Soccer" })).status).toBe(200);                              // a later step never clears it
  expect(await read()).toBe("Example City FC");
  expect((await post(uid, { team: "Other Team", school: "Example High" })).status).toBe(200);
  expect(await read()).toBe("Example High");
  expect((await post(uid, { team: "x".repeat(121) })).status).toBe(400);
});

test("P8: an unconfirmed identity shows no findings", async () => {
  const uid = uniq("uid-namesake");
  const id = await waitlister(NAME, uid);
  await signupRun(id, NAME, "done", [{ step: "research_merge", status: "done" }]);
  await dbStore.insertFacts(id, [
    { subject: { kind: "athlete", name: NAME }, claim: `${NAME} won the regional title.`, type: "found", source: { url: "https://www.example-news.com/story", title: "Example News" }, date: "2026-05-01", confidence: 0.8, runId: null, topic: "achievement" },
  ] as any);
  expect((await get(uid)).json.findings).toHaveLength(1);
  // What research writes when it cannot tell which public profile is hers (research.ts recordIdentityOutcome).
  const [merge] = await db.insert(agentRuns).values({ athlete_id: id, skill_id: "research-merge", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: 0, started_at: new Date(), ended_at: new Date() } as any).returning({ id: agentRuns.id });
  await recordIdentityOutcome(dbStore, id, { runId: merge.id, resolved: false, ambiguity: "two athletes share the name", athlete: { name: NAME, sport: "Golf" } });
  const r = await get(uid);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ research: { state: "done" }, findings: [] });
});

test("P9: her own referral code is stable and resolves back; a ?ref= code she arrives with is stored", async () => {
  const uid = uniq("uid-ref");
  const id = await waitlister("Referrer Example", uid);
  const r = await get(uid);
  expect(r.json.referralCode).toBe(referralCodeFor(id));
  expect(r.json.referrals).toBe(0);                                                              // no one joined yet
  expect(r.json.referralCode).toMatch(/^[0-9A-Za-z]{1,22}$/);
  expect((await get(uid)).json.referralCode).toBe(r.json.referralCode);                         // stable
  expect(athleteIdFromReferralCode(r.json.referralCode)).toBe(id);
  expect(r.json.referralCode).not.toContain(id.slice(0, 8));                                    // the internal id stays out of links
  for (const bad of ["", "!!", "x".repeat(23), 42, null]) expect(athleteIdFromReferralCode(bad)).toBeNull();
  // A new athlete arriving with that code keeps it as the code she came with.
  const newcomer = uniq("uid-referred");
  expect((await post(newcomer, { first_name: "Referred", last_name: uniq("Friend"), referral_code: r.json.referralCode })).status).toBe(200);
  const [row] = await db.select({ referral_code: athletes.referral_code }).from(athletes).where(eq(athletes.auth_id, newcomer));
  expect(row.referral_code).toBe(r.json.referralCode);
  // The sharer now sees the count (display only: the rank never reads it).
  expect((await get(uid)).json.referrals).toBe(1);
});

test("P10: /progress is rate-limited per signed-in user, with Retry-After", async () => {
  const uid = uniq("uid-burst");
  const mate = uniq("uid-teammate");
  await waitlister("Burst Example", uid);
  await waitlister("Teammate Example", mate);
  let last: Response | null = null;
  for (let i = 0; i < 60; i++) {
    as(uid);
    last = await fetch(`${base}/waitlist/progress`, { headers: { authorization: "Bearer tok" } });
    if (last.status === 429) break;
  }
  expect(last!.status).toBe(429);
  expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await get(mate)).status).toBe(200);                                                   // same IP, another athlete: not limited
  expect((await get(null)).status).toBe(401);                                                   // no token: refused before the limit
});

// ─── the wait screen's live checklist: real step statuses only ───────────────────────────────────────────────────────
test("S1 pure: the checklist from step rows — web, Instagram (when connected), merge with its count, score", () => {
  const row = (step: string, status: string, extra: Record<string, unknown> = {}) => ({ step, status, ...extra });
  const base = { instagram: null, evaluation: null, scoreReady: false };
  expect(researchStepsFrom({ ...base, run: [row("research_a", "ready"), row("research_b", "ready")] }))
    .toEqual([{ key: "web", status: "pending" }, { key: "merge", status: "pending" }, { key: "score", status: "pending" }]);
  // one pass done, the other still searching: the web line is running
  expect(researchStepsFrom({ ...base, run: [row("research_a", "done"), row("research_b", "running")] })[0]).toEqual({ key: "web", status: "running" });
  // a retried pass: the latest attempt counts
  expect(researchStepsFrom({ ...base, run: [row("research_a", "failed", { attempt: 1 }), row("research_a", "done", { attempt: 2 }), row("research_b", "done")] })[0].status).toBe("done");
  // merged with its count; Instagram read while connected; the score running
  const merged = [row("research_a", "done"), row("research_b", "skipped"), row("research_merge", "done", { output: { inserted: 7 } }), row("mia_preview", "running")];
  expect(researchStepsFrom({ ...base, run: merged, instagram: [row("fetch_social", "done"), row("collect_analytics", "waiting")] })).toEqual([
    { key: "web", status: "done" }, { key: "instagram", status: "running" }, { key: "merge", status: "done", count: 7 }, { key: "score", status: "running" },
  ]);
  // connected but nothing has read it yet: the line is left out (never invented)
  expect(researchStepsFrom({ ...base, run: merged, instagram: [] }).map((x) => x.key)).toEqual(["web", "merge", "score"]);
  const mia = (output: unknown) => [...merged.slice(0, 3), row("mia_preview", "done", { output })];
  // in flight: the evaluation decides — running, then failed when it fails; a ready score is done whatever the rows say
  expect(researchStepsFrom({ ...base, run: mia({ status: "not_assessed", computed: "in_flight" }), evaluation: { status: "running", steps: [row("evaluate", "running")] } })[2].status).toBe("running");
  expect(researchStepsFrom({ ...base, run: mia({ status: "not_assessed", computed: "in_flight" }), evaluation: { status: "running", steps: [row("evaluate", "failed")] } })[2].status).toBe("failed");
  expect(researchStepsFrom({ ...base, run: mia({ status: "not_assessed", computed: "in_flight" }), evaluation: { status: "failed", steps: [] } })[2].status).toBe("failed");
  expect(researchStepsFrom({ ...base, run: mia({ status: "failed" }) })[2].status).toBe("failed");
  expect(researchStepsFrom({ ...base, run: mia({ status: "failed" }), scoreReady: true })[2].status).toBe("done");
});

test("S2: GET /progress carries research.steps from her runs (Instagram read, evaluation in flight)", async () => {
  const uid = uniq("uid-steps");
  const id = await waitlister("Steps Athlete", uid);
  await signupRun(id, "Steps Athlete", "running", [{ step: "research_a", status: "done" }, { step: "research_b", status: "done" }, { step: "research_merge", status: "done", output: { inserted: 4 } }, { step: "mia_preview", status: "done", output: { status: "not_assessed", computed: "in_flight" } }]);
  await seedConnection({ athleteId: id, platform: "instagram" });
  const [look] = await db.insert(workflowRuns).values({ athlete_id: id, process: "first_look", definition_version: 1, active_scope: "first_look:instagram", status: "done", input: { platform: "instagram", connectionId: "c" }, created_by: "connect", started_at: new Date() } as any).returning({ id: workflowRuns.id });
  await db.insert(workflowSteps).values({ run_id: look.id, step: "fetch_social", ordinal: 0, kind: "code", status: "done", input: {} } as any);
  const [ev] = await db.insert(workflowRuns).values({ athlete_id: id, process: "mia_evaluation", definition_version: 1, active_scope: "mia_evaluation", status: "running", input: {}, created_by: "t", started_at: new Date() } as any).returning({ id: workflowRuns.id });
  await db.insert(workflowSteps).values({ run_id: ev.id, step: "evaluate", ordinal: 2, kind: "model", status: "running", input: {} } as any);
  mockReadMia.mockResolvedValue(preview({ status: "not_assessed", score: null, assessment: null }));
  const r = await get(uid);
  expect(r.json.research.state).toBe("done");
  expect(r.json.research.steps).toEqual([{ key: "web", status: "done" }, { key: "instagram", status: "done" }, { key: "merge", status: "done", count: 4 }, { key: "score", status: "running" }]);
  mockReadMia.mockResolvedValue(preview());
  expect((await get(uid)).json.research.steps[3]).toEqual({ key: "score", status: "done" });
});

// ─── the share card's photo: her own, by the Me hero's bar, served through the API ───────────────────────────────────
test("H1 pure: the hero is hers (connected / upload), of her, never a group or a text graphic, face clear; portrait first", () => {
  const row = (id: string, over: Record<string, unknown> = {}, vision: Record<string, unknown> | null = { subject: "the_athlete", face_visibility: "clear", shot_type: "action" }) =>
    ({ id, gcs_path: `p/${id}.jpg`, content_type: "image/jpeg", origin: "connected", width: 1080, height: 1080, metadata: vision ? { vision } : {}, ...over });
  expect(pickHeroPhoto([])).toBeNull();
  expect(pickHeroPhoto([row("a", { origin: "discovery" }), row("b", { origin: "generated" })])).toBeNull();
  expect(pickHeroPhoto([row("a", {}, { subject: "teammate" }), row("b", {}, { subject: "the_athlete", shot_type: "group" }), row("c", {}, { subject: "the_athlete", shot_type: "text_graphic" }), row("d", {}, { subject: "the_athlete", face_visibility: "partial" })])).toBeNull();
  expect(pickHeroPhoto([row("a", { content_type: "video/mp4" }), row("b", { gcs_path: null })])).toBeNull();
  expect(pickHeroPhoto([row("square"), row("tall", { height: 1350 })])!.id).toBe("tall");          // portrait first
  expect(pickHeroPhoto([row("new"), row("old")])!.id).toBe("new");                                  // else the most recent
  expect(pickHeroPhoto([row("unread", {}, null)])!.id).toBe("unread");                              // not read yet: hers by origin
});

test("H2: progress says whether she has a hero photo (+ her sport / team); GET /hero-photo serves its bytes, 404 without one", async () => {
  const uid = uniq("uid-hero");
  const id = await waitlister("Hero Athlete", uid);
  await db.update(athletes).set({ sport: "Soccer", school: "Example University" } as any).where(eq(athletes.id, id));
  const photo = async () => { as(uid); const r = await fetch(`${base}/waitlist/hero-photo`, { headers: { authorization: "Bearer tok" } }); return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }; };
  let p = await get(uid);
  expect(p.json).toMatchObject({ profile: { sport: "Soccer", team: "Example University" }, heroPhoto: false });
  expect((await photo()).status).toBe(404);
  await db.insert(mediaAssets).values({ athlete_id: id, platform: "instagram", origin: "connected", media_type: "IMAGE", status: "stored", gcs_path: "media/hero.jpg", content_type: "image/jpeg", posted_at: new Date("2026-10-01T00:00:00Z"), metadata: { vision: { subject: "the_athlete", face_visibility: "clear", shot_type: "portrait" } } } as any);
  mockReadObject.mockResolvedValue({ buf: Buffer.from("JPEGBYTES"), contentType: "image/jpeg" });
  p = await get(uid);
  expect(p.json.heroPhoto).toBe(true);
  const r = await photo();
  expect([r.status, r.type, r.body.toString()]).toEqual([200, "image/jpeg", "JPEGBYTES"]);
  expect(mockReadObject).toHaveBeenCalledWith("media/hero.jpg");
  as(uid); expect((await fetch(`${base}/waitlist/hero-photo`)).status).toBe(401);
});

test("P11: a finding's web-derived text is capped at 300 characters and an over-long source URL is never shown", () => {
  const long = `${NAME} ${"won another remarkable title ".repeat(30)}`;
  const [capped] = findingsFrom([fact({ claim: long, topic: "achievement" })], NAME);
  expect(capped.text.length).toBeLessThanOrEqual(MAX_FINDING_TEXT);
  expect(capped.text.endsWith("…")).toBe(true);
  const hugeUrl = `https://www.example-news.com/${"a".repeat(2100)}`;
  expect(findingsFrom([fact({ claim: `${NAME} won the cup.`, topic: "achievement", source: { url: hugeUrl } })], NAME)).toEqual([]);
});

// ─── P11–P14 quick score → full score (signup_research v4; dev only) ──────────────────────────────────────────────────
const QUICK_OUT = {
  status: "ready", score: 470.2, confidence: "low", low_confidence: true, reasons: ["Regional press covers her results."],
  dimensions: [{ key: "audience_scale", score: 40, weight: 0.15, contribution: 6 }, { key: "athletic_authority", score: 70, weight: 0.2, contribution: 14 }],
  display: { sources: [{ uri: "https://www.example-news.com/a", title: "Example News" }] },
};
const QUICK_AT = new Date("2026-10-26T15:00:00Z");
/** A v4 run: lean research, the quick score beside it, then the M.I.A. step and the email. */
const v4 = (lean: string, mia: string, quick: unknown = QUICK_OUT) => [
  { step: "lean_research", status: lean, ...(lean === "done" ? { output: { inserted: 7 } } : {}) },
  { step: "quick_score", status: "done", output: quick, finished_at: QUICK_AT },
  { step: "mia_preview", status: mia, ...(mia === "done" ? { output: { status: "ready", computed: "evaluated", score: 512 } } : {}) },
  { step: "score_email", status: "ready" },
];
async function ledgerEntry(athleteId: string): Promise<{ id: string; at: Date }> {
  const [row] = await db.insert(intelligenceLedger).values({ subject_type: "athlete", subject_id: athleteId, owner: "mia", kind: "marketability", value: {}, evidence_as_of: new Date() } as any)
    .returning({ id: intelligenceLedger.id, at: intelligenceLedger.created_at });
  return row;
}
const restart = async () => { await db.delete(workflowSteps); await db.delete(workflowRuns); };

test("P11: quick only — her quick score with its confidence while the full score is still processing", async () => {
  const uid = uniq("uid-quick");
  const id = await waitlister(NAME, uid);
  await signupRun(id, NAME, "running", v4("running", "ready"), 4);
  let r = await get(uid);
  expect(r.status).toBe(200);
  expect(r.json.score).toBeNull();
  expect(r.json.quickScore).toMatchObject({ quick: true, value: 470, confidence: "low", lowConfidence: true, lines: ["Regional press covers her results."] });
  expect(r.json.scoreStage).toEqual({ stage: "quick", full: "processing", replacedQuick: false, quickAt: QUICK_AT.toISOString(), finalAt: null });
  // Research done, the full score still being worked out: still the quick score.
  await restart();
  await signupRun(id, NAME, "running", v4("done", "running"), 4);
  r = await get(uid);
  expect(r.json.research.state).toBe("done");
  expect(r.json.quickScore).toMatchObject({ value: 470 });
  expect(r.json.scoreStage).toMatchObject({ stage: "quick", full: "processing" });
  // The full score ended without one: the quick score stays, and the stage says the full one failed.
  await restart();
  await signupRun(id, NAME, "running", v4("done", "failed"), 4);
  r = await get(uid);
  expect(r.json.quickScore).toMatchObject({ value: 470 });
  expect(r.json.scoreStage).toMatchObject({ stage: "quick", full: "failed", replacedQuick: false });
});

test("P12: the full score lands and replaces the quick one", async () => {
  const uid = uniq("uid-full");
  const id = await waitlister(NAME, uid);
  await signupRun(id, NAME, "running", v4("done", "done"), 4);
  const entry = await ledgerEntry(id);
  mockReadMia.mockResolvedValue(preview({ provenance: { ledgerEntryId: entry.id, evaluationRunId: null, snapshotId: null, digest: null, evidenceAsOf: "2026-10-26" } }));
  const r = await get(uid);
  expect(r.json.score).toMatchObject({ value: 512, confidence: "medium" });
  expect(r.json.quickScore).toBeUndefined();
  expect(r.json.scoreStage).toEqual({ stage: "final", full: "ready", replacedQuick: true, quickAt: QUICK_AT.toISOString(), finalAt: entry.at.toISOString() });
  expect(r.json.research.steps.find((s: any) => s.key === "score")).toEqual({ key: "score", status: "done" });
});

test("P13: identity disputed — no quick score, before or after the research is done", async () => {
  const uid = uniq("uid-disputed");
  const id = await waitlister(NAME, uid);
  const [merge] = await db.insert(agentRuns).values({ athlete_id: id, skill_id: "research-merge", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: 0, started_at: new Date(), ended_at: new Date() } as any).returning({ id: agentRuns.id });
  await recordIdentityOutcome(dbStore, id, { runId: merge.id, resolved: false, ambiguity: "two athletes share the name", athlete: { name: NAME, sport: "Golf" } });
  await signupRun(id, NAME, "running", v4("running", "ready"), 4);
  let r = await get(uid);
  expect(r.json.quickScore).toBeUndefined();
  expect(r.json.scoreStage).toMatchObject({ stage: "none", full: "processing", replacedQuick: false });
  await restart();
  await signupRun(id, NAME, "running", v4("done", "done"), 4);              // the M.I.A. step held her score: none of record
  r = await get(uid);
  expect(r.json.research.state).toBe("done");
  expect(r.json.score).toBeNull();
  expect(r.json.quickScore).toBeUndefined();
  expect(r.json.scoreStage.stage).toBe("none");
});

test("P14: flag off — a v2 run's payload is unchanged; the quick step off shows no quick score", async () => {
  const uid = uniq("uid-v2");
  const id = await waitlister(NAME, uid);
  await signupRun(id, NAME, "running", [{ step: "research_a", status: "running" }, { step: "research_b", status: "running" }, { step: "research_merge", status: "ready" }, { step: "mia_preview", status: "ready" }, { step: "score_email", status: "ready" }], 2);
  let r = await get(uid);
  expect(r.json).not.toHaveProperty("quickScore");
  expect(r.json).not.toHaveProperty("scoreStage");
  await restart();
  await signupRun(id, NAME, "done", [{ step: "research_merge", status: "done" }, { step: "mia_preview", status: "done" }, { step: "score_email", status: "done", output: { sent: false } }], 2);
  mockReadMia.mockResolvedValue(preview());
  r = await get(uid);
  expect(r.json.score).toMatchObject({ value: 512 });
  expect(r.json).not.toHaveProperty("quickScore");
  expect(r.json).not.toHaveProperty("scoreStage");

  // QUICK_SCORE_ONE_CALL off on a v4 run: the step answers "off"; the full score is simply the score.
  await restart();
  await signupRun(id, NAME, "running", v4("done", "done", { status: "off", reason: "flag_off" }), 4);
  mockReadMia.mockResolvedValue(preview());
  r = await get(uid);
  expect(r.json.quickScore).toBeUndefined();
  expect(r.json.scoreStage).toMatchObject({ stage: "final", full: "ready", replacedQuick: false, quickAt: null });
});

test("P15: the live status is the runner's real stage — the lean step writes it on its running row; v2 has none", async () => {
  const uid = uniq("uid-live");
  const id = await waitlister(NAME, uid);
  const runId = await signupRun(id, NAME, "running", v4("running", "ready"), 4);
  await db.update(workflowSteps).set({ attempt: 1 } as any).where(eq(workflowSteps.run_id, runId));
  // Running, nothing reported yet: finding her.
  let r = await get(uid);
  expect(r.json.research.live).toEqual({ stage: "finding", at: null });
  // The step reports through the same writer it uses live (leanResearchStep.writeStepProgress).
  const ctx = { runId, step: "lean_research", attempt: 1 };
  await writeStepProgress(ctx, { stage: "reading", count: 12 });
  r = await get(uid);
  expect(r.json.research.live).toMatchObject({ stage: "reading", count: 12 });
  expect(typeof r.json.research.live.at).toBe("string");
  await writeStepProgress(ctx, { stage: "checking", count: 18 });
  expect((await get(uid)).json.research.live).toMatchObject({ stage: "checking", count: 18 });
  // Never on a row that is not running (a finished step's real output is never overwritten).
  await db.update(workflowSteps).set({ status: "done", output: { inserted: 7 } as any }).where(and(eq(workflowSteps.run_id, runId), eq(workflowSteps.step, "lean_research")));
  await writeStepProgress(ctx, { stage: "reading", count: 99 });
  const [lean] = await db.select().from(workflowSteps).where(and(eq(workflowSteps.run_id, runId), eq(workflowSteps.step, "lean_research")));
  expect(lean.output).toEqual({ inserted: 7 });
  // Research done, the M.I.A. step still to run: scoring. Then the full score: final_ready.
  r = await get(uid);
  expect(r.json.research.live).toEqual({ stage: "scoring", at: null });
  mockReadMia.mockResolvedValue(preview());
  expect((await get(uid)).json.research.live).toEqual({ stage: "final_ready", at: null });

  // A v2 run: no live key at all (the landing keeps its own state-based line).
  await restart();
  mockReadMia.mockResolvedValue(preview({ status: "not_assessed", score: null, assessment: null }));
  await signupRun(id, NAME, "running", [{ step: "research_a", status: "running" }, { step: "research_b", status: "running" }, { step: "research_merge", status: "ready" }, { step: "mia_preview", status: "ready" }, { step: "score_email", status: "ready" }], 2);
  expect((await get(uid)).json.research).not.toHaveProperty("live");
});

test("P16: liveStatusFrom and the stage reporter (pure): real transitions only, ordered, throttled, never throws", async () => {
  const lean = (status: string, output?: unknown) => [{ step: "lean_research", status, output }];
  expect(liveStatusFrom({ run: [], scoreReady: false, scoreStep: null, quickShown: true })).toBeNull();                 // not v4
  expect(liveStatusFrom({ run: lean("running", { progress: { stage: "pulling", at: "t" } }), scoreReady: false, scoreStep: "pending", quickShown: false })).toEqual({ stage: "pulling", at: "t" });
  expect(liveStatusFrom({ run: lean("running", { progress: { stage: "made_up" } }), scoreReady: false, scoreStep: "pending", quickShown: false })).toEqual({ stage: "finding", at: null });
  expect(liveStatusFrom({ run: lean("ready"), scoreReady: false, scoreStep: "pending", quickShown: true })).toEqual({ stage: "quick_ready", at: null });   // queued, quick shown
  expect(liveStatusFrom({ run: lean("ready"), scoreReady: false, scoreStep: "pending", quickShown: false })).toBeNull();
  expect(liveStatusFrom({ run: lean("done"), scoreReady: false, scoreStep: "failed", quickShown: false })).toBeNull();   // the checklist says it failed
  expect(liveStatusFrom({ run: lean("failed"), scoreReady: false, scoreStep: "pending", quickShown: false })).toBeNull();

  const writes: Array<{ stage: string; count?: number }> = [];
  const rep = stageReporter({ runId: "r", step: "lean_research", attempt: 1 }, { write: async (_c, s) => { writes.push(s); }, minGapMs: 40 });
  rep.report({ stage: "finding" });
  rep.report({ stage: "reading", count: 1 });
  rep.report({ stage: "reading", count: 5 });            // inside the gap: held…
  rep.report({ stage: "reading", count: 9 });            // …the latest count wins
  await new Promise((res) => setTimeout(res, 80));
  rep.report({ stage: "pulling" });
  rep.report({ stage: "checking", count: 3 });
  rep.report({ stage: "checking", count: 4 });           // pending at the end: dropped by done() (the real output replaces it)
  await rep.done();
  expect(writes).toEqual([{ stage: "finding" }, { stage: "reading", count: 1 }, { stage: "reading", count: 9 }, { stage: "pulling" }, { stage: "checking", count: 3 }]);
  const failing = stageReporter({ runId: "r", step: "lean_research", attempt: 1 }, { write: async () => { throw new Error("db down"); } });
  failing.report({ stage: "finding" });
  await expect(failing.done()).resolves.toBeUndefined();
});
