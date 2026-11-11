/**
 * routes/meMemory.test.ts — GET /me/scouting and the /me/facts routes over HTTP on PGlite (Express + the real router;
 * only auth, the M.I.A. preview read and the M.I.A. trigger are replaced, and the evaluator throws if reached).
 *
 *   auth        401 without a session
 *   empty       an athlete with no memory facts gets { status: "no_memory" } from both reads
 *   scouting    hero, defines, notes tagged from the evaluation run's stored answer, brands from facts about you only
 *   knows       grouped by topic; subject filter (default you); care facts only in `private`; made facts never
 *   edits       correct (a new said fact supersedes; history kept; 409 on a replaced fact) · hide · restore · dispute
 *               (seed) · confirm; each but confirm queues a re-run behind the 30-minute window, nothing runs now
 *   tenancy     another athlete's fact id is a 404, for every verb
 *
 * Made-up athletes and brands; no sport, school or person is assumed.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));
const readMiaPreview = jest.fn();
jest.mock("../services/miaPreview/preview", () => ({ readMiaPreview: (...a: any[]) => readMiaPreview(...a) }));
const requestEvaluation = jest.fn();
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: (...a: any[]) => requestEvaluation(...a) }));
jest.mock("../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: () => { throw new Error("provider reached from a Me route"); } };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import meMemoryRouter from "./meMemory";
import "../workflow/definitions/memoryChanged";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletes, memoryBriefs, memoryFactReviews, memoryFacts, miaEvaluationRuns, miaEvidenceSnapshots, workflowSteps } from "../../shared/schema";
import { QUIET_WINDOW_MS } from "../agent/memoryRerun";

jest.setTimeout(180_000);

const g = globalThis as any;
let server: Server; let base = "";
const call = async (method: string, path: string, athleteId: string | null, body?: unknown) => {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => undefined) as any };
};

const NAME = "Robin Example";
let A = ""; let B = ""; let legacy = "";
const F: Record<string, string> = {};
let evalRunId = "";

async function addFact(athleteId: string, key: string, v: Record<string, unknown>) {
  const [row] = await db.insert(memoryFacts).values({
    athlete_id: athleteId, subject_kind: "athlete", subject_name: NAME, type: "found", confidence: 0.8, source_url: `https://example.org/${key}`, ...v,
  } as any).returning({ id: memoryFacts.id });
  F[key] = row.id;
}

beforeAll(async () => {
  await initTestDb();
  [{ id: A }] = await db.insert(athletes).values({ full_name: NAME, sport: "Rowing" } as any).returning({ id: athletes.id });
  await addFact(A, "name", { type: "said", source_url: null, source_ref: "onboarding/r#name", claim: `The athlete's name is ${NAME}.`, confidence: 1 });
  await addFact(A, "career", { claim: `${NAME} rows in the first boat.`, topic: "career", observed_on: "2026-03-01" });
  await addFact(A, "honour", { claim: `${NAME} won a regional final.`, topic: "achievement", observed_on: "2026-05-01" });
  await addFact(A, "sponsor", { claim: `${NAME} is a partner of Brand One.`, topic: "sponsor", observed_on: "2026-06-01" });
  await addFact(A, "teamSponsor", { claim: "The club is sponsored by Brand Two.", topic: "sponsor", subject_kind: "organization", subject_name: "Club Example" });
  await addFact(A, "care", { claim: `${NAME} missed a month with an injury.`, topic: "career", sensitive: true, care_kind: "personal" });
  await addFact(A, "measured", { type: "measured", source_url: null, source_ref: "connected:x#instagram.followers", claim: "1,200 followers on the main account.", confidence: 1 });
  await addFact(A, "weak", { claim: `${NAME} was born abroad.`, topic: "identity", confidence: 0.3 });
  await addFact(A, "made", { type: "made", source_url: null, source_ref: "run:x", claim: "An inference." });
  await db.insert(memoryBriefs).values({
    athlete_id: A, version: 1, status: "current", summary: "s", sections: [], fact_ids: [F.career],
    internal: { currentSponsors: [{ name: "Brand One", factIds: [F.sponsor] }, { name: "Brand Two", factIds: [F.teamSponsor] }], pastSponsors: [] },
    display: {
      stage: { label: "Club rower", band: "developing", confidence: 0.7, why: "w", factIds: [] },
      positioning: { from: "Known for results", to: "Known for your story", statement: "A rower the club builds around.", pillars: [{ name: "Grit", line: "Early mornings.", factIds: [] }], factIds: [] },
    },
  } as any);
  // The evaluation run behind the read, with the evaluator's tagged answer stored as it came back.
  const [snap] = await db.insert(miaEvidenceSnapshots).values({ athlete_id: A, name: NAME, sport: "Rowing", evidence_as_of: new Date(), digest: "d", trigger_reason: "USER_REQUESTED_REFRESH" } as any).returning({ id: miaEvidenceSnapshots.id });
  const raw = { text: JSON.stringify({ key_strengths: [{ text: "Results are climbing.", dimension: "athletic_authority", evidence_ids: [F.honour] }], key_constraints: [{ text: "A small audience so far.", dimension: "audience_scale", evidence_ids: [] }], important_missing_data: [{ text: "Insights from your account", dimension: "engagement_quality", evidence_ids: [] }] }) };
  [{ id: evalRunId }] = await db.insert(miaEvaluationRuns).values({ snapshot_id: snap.id, athlete_id: A, status: "ok", evaluator_version: "facts-eval-spec/0.4.0", provider: "p", model: "m", started_at: new Date(), raw } as any).returning({ id: miaEvaluationRuns.id });

  [{ id: B }] = await db.insert(athletes).values({ full_name: "Kai Sample", sport: "Judo" } as any).returning({ id: athletes.id });
  await db.insert(memoryFacts).values({ athlete_id: B, subject_kind: "athlete", subject_name: "Kai Sample", claim: "Kai Sample competes nationally.", type: "found", source_url: "https://example.org/b", confidence: 0.9 } as any);
  legacy = await seedAthlete("Pat Legacy");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", meMemoryRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await closeTestDb(); });
beforeEach(() => {
  readMiaPreview.mockReset();
  readMiaPreview.mockImplementation(async (id: string) => id === A ? {
    contract: "mia-preview/1", athleteId: A, status: "ready", score: 512, scale: { min: 0, max: 850 }, groups: [], preliminary: true, label: "Preliminary",
    confidence: { level: "MEDIUM", explanation: null }, sharpen: [], evidenceAsOf: "2026-10-01", identity: { uncertain: false, factIds: [] },
    inputs: { public: [{ kind: "public", factId: F.honour, platform: null, label: "x", source: { url: null, title: null, ref: null }, observedAt: null }], measured: [] },
    provenance: { ledgerEntryId: "l", evaluationRunId: evalRunId, snapshotId: null, digest: null, evidenceAsOf: "2026-10-01" },
    assessment: { notes: { strengths: ["Results are climbing."], constraints: ["A small audience so far.", "Few partners."], missingEvidence: ["Insights from your account"], evaluationRisks: [] } },
  } : { contract: "mia-preview/1", athleteId: id, status: "not_assessed", score: null, scale: { min: 0, max: 850 }, groups: [], assessment: null, preliminary: true, label: null, confidence: { level: null, explanation: null }, inputs: { public: [], measured: [] }, sharpen: [], evidenceAsOf: null, identity: { uncertain: false, factIds: [] }, provenance: null });
  requestEvaluation.mockReset();
  requestEvaluation.mockImplementation(async () => { throw new Error("the M.I.A. must not re-run inside the quiet window"); });
});

test("401 without a session", async () => {
  expect((await call("GET", "/scouting", null)).status).toBe(401);
  expect((await call("GET", "/facts", null)).status).toBe(401);
  expect((await call("PATCH", `/facts/${F.career}`, null, { claim: "x" })).status).toBe(401);
});

test("an athlete with no memory facts gets the explicit empty state from both reads", async () => {
  expect((await call("GET", "/scouting", legacy)).body).toEqual({ contract: "scouting/1", status: "no_memory" });
  expect((await call("GET", "/facts", legacy)).body).toEqual({ contract: "knows/1", status: "no_memory" });
});

test("scouting: hero, defines, tagged notes, brands from facts about you only, the Knows door", async () => {
  const r = await call("GET", "/scouting", A);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({
    contract: "scouting/1", status: "ready", version: 1,
    hero: { statement: "A rower the club builds around.", stage: { label: "Club rower", band: "developing" } },
    defines: { today: "Known for results", headed: "Known for your story", pillars: [{ key: "pillar_1", label: "Grit", definition: "Early mornings." }] },
    mia: { status: "ready", score: 512, preliminary: true },
    notes: {
      workingForYou: [{ text: "Results are climbing.", dimension: "athletic_authority", group: "performance" }],
      roomToGrow: [{ text: "A small audience so far.", dimension: "audience_scale", group: "audience" }, { text: "Few partners.", dimension: null, group: null }],
      notOnRecordCount: 1,
    },
  });
  expect(r.body.brands.current.map((b: any) => b.name)).toEqual(["Brand One"]);
  expect(r.body.brands.current[0]).toMatchObject({ status: "current", latestConfirmedOn: "2026-06-01", factIds: [F.sponsor] });
  expect(JSON.stringify(r.body)).not.toContain("Brand Two");
  expect(JSON.stringify(r.body)).not.toContain("currentSponsors");
  // About you, in use, not made: name, career, honour, sponsor, care, measured, weak → 7; weak couldn't be confirmed.
  expect(r.body.knows).toEqual({ facts: 7, unconfirmed: 1 });
});

test("knows: grouped by topic, your facts by default, care facts private, made facts never", async () => {
  const r = await call("GET", "/facts", A);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ contract: "knows/1", status: "ready", subject: "athlete" });
  const section = (k: string) => r.body.sections.find((s: any) => s.key === k).facts.map((f: any) => f.id);
  expect(r.body.sections.map((s: any) => s.key)).toEqual(["glance", "career", "honours", "academics", "brands", "media", "interests", "details"]);
  expect(section("career")).toEqual([F.career]);
  expect(section("honours")).toEqual([F.honour]);
  expect(section("brands")).toEqual([F.sponsor]);
  expect(section("media")).toEqual([F.measured]);
  expect(section("glance")).toEqual([F.weak]);
  expect(r.body.private.map((f: any) => f.id)).toEqual([F.care]);
  const all = JSON.stringify(r.body);
  expect(all).not.toContain(F.made);
  expect(all).not.toContain(F.teamSponsor);
  const measured = r.body.sections.find((s: any) => s.key === "media").facts[0];
  expect(measured).toMatchObject({ provenance: "accounts", editable: false });
  expect(r.body.sections.find((s: any) => s.key === "glance").facts[0]).toMatchObject({ unconfirmed: true });
  expect(r.body.counts).toMatchObject({ total: 7, you: 1, found: 5, accounts: 1, unconfirmed: 1, hidden: 0, private: 1 });

  const others = await call("GET", "/facts?subject=others", A);
  expect(others.body.sections.flatMap((s: any) => s.facts).map((f: any) => f.id)).toEqual([F.teamSponsor]);
  expect((await call("GET", "/facts?subject=everyone", A)).status).toBe(400);
});

test("tenancy: another athlete's fact is a 404 for every verb, and reads never cross", async () => {
  for (const [m, p, b] of [["GET", `/facts/${F.career}`], ["PATCH", `/facts/${F.career}`, { claim: "x" }], ["DELETE", `/facts/${F.career}`], ["POST", `/facts/${F.career}/restore`], ["POST", `/facts/${F.career}/dispute`], ["POST", `/facts/${F.career}/confirm`]] as const) {
    expect((await call(m, p, B, b)).status).toBe(404);
  }
  expect((await call("GET", "/facts/not-a-uuid", A)).status).toBe(404);
  expect(JSON.stringify((await call("GET", "/facts?subject=all", B)).body)).not.toContain(F.career);
});

test("correct: your words become a new said fact; the old one is kept as history; a replaced fact answers 409", async () => {
  const r = await call("PATCH", `/facts/${F.career}`, A, { claim: `${NAME} rows in the second boat.` });
  expect(r.status).toBe(200);
  expect(r.body.fact).toMatchObject({ claim: `${NAME} rows in the second boat.`, provenance: "you", topic: "career", status: "active" });
  expect(r.body.rerun.runId).toBeTruthy();
  expect(Date.parse(r.body.rerun.after) - Date.now()).toBeGreaterThan(QUIET_WINDOW_MS - 60_000);

  const [old] = await db.select().from(memoryFacts).where(eq(memoryFacts.id, F.career));
  expect(old).toMatchObject({ status: "superseded", superseded_by: r.body.fact.id, claim: `${NAME} rows in the first boat.` });

  const again = await call("PATCH", `/facts/${F.career}`, A, { claim: "Something else." });
  expect(again.status).toBe(409);
  expect(again.body).toMatchObject({ code: "superseded", currentId: r.body.fact.id });

  const sheet = await call("GET", `/facts/${r.body.fact.id}`, A);
  expect(sheet.status).toBe(200);
  expect(sheet.body.history.filter((h: any) => h.kind === "version").map((h: any) => h.claim)).toEqual([`${NAME} rows in the first boat.`, `${NAME} rows in the second boat.`]);
  expect(sheet.body.history.filter((h: any) => h.kind === "review")).toEqual([expect.objectContaining({ action: "correct", correction: `${NAME} rows in the second boat.` })]);
  expect(sheet.body.usedIn).toEqual({ scouting: true, mia: false });

  expect((await call("PATCH", `/facts/${F.measured}`, A, { claim: "2,000 followers." })).body.code).toBe("not_editable");
  expect((await call("PATCH", `/facts/${F.honour}`, A, { claim: "" })).status).toBe(400);
  // Inside the window nothing re-ran: the edit only joined the waiting run.
  expect(requestEvaluation).not.toHaveBeenCalled();
});

test("hide, then restore; dispute returns Mila's seed; confirm re-runs nothing", async () => {
  const hid = await call("DELETE", `/facts/${F.honour}`, A, { note: "not me" });
  expect(hid.status).toBe(200);
  let knows = await call("GET", "/facts", A);
  expect(knows.body.hidden).toEqual([{ id: F.honour, claim: `${NAME} won a regional final.` }]);
  expect(knows.body.sections.find((s: any) => s.key === "honours").facts).toEqual([]);

  const back = await call("POST", `/facts/${F.honour}/restore`, A);
  expect(back.status).toBe(200);
  expect(back.body.fact).toMatchObject({ id: F.honour, status: "active" });
  expect((await call("POST", `/facts/${F.honour}/restore`, A)).status).toBe(409);

  const d = await call("POST", `/facts/${F.sponsor}/dispute`, A, { said: "That ended last year." });
  expect(d.status).toBe(200);
  expect(d.body.seed).toMatchObject({ factId: F.sponsor, claim: `${NAME} is a partner of Brand One.` });
  knows = await call("GET", "/facts", A);
  expect(knows.body.sections.find((s: any) => s.key === "brands").facts[0]).toMatchObject({ id: F.sponsor, status: "disputed", unconfirmed: true });

  expect((await call("POST", `/facts/${F.weak}/confirm`, A)).status).toBe(204);
  knows = await call("GET", "/facts", A);
  expect(knows.body.sections.find((s: any) => s.key === "glance").facts[0]).toMatchObject({ id: F.weak, confirmedByYou: true });

  const actions = (await db.select({ action: memoryFactReviews.action }).from(memoryFactReviews).where(eq(memoryFactReviews.athlete_id, A))).map((x) => x.action).sort();
  expect(actions).toEqual(["confirm", "correct", "dispute", "remove", "restore"]);
  // Every edit joined ONE waiting memory_changed run (a batch), still in its quiet window.
  const quiet = await db.select({ status: workflowSteps.status }).from(workflowSteps).where(and(eq(workflowSteps.step, "quiet")));
  expect(quiet).toEqual([{ status: "ready" }]);
  expect(requestEvaluation).not.toHaveBeenCalled();
  expect(readMiaPreview.mock.calls.every(([id]) => id === A || id === B || id === legacy)).toBe(true);
});
