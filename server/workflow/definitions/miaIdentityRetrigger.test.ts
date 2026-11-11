/**
 * miaIdentityRetrigger.test.ts — PR H2 (R-a): M.I.A. is re-requested when identity RESOLVES, and a blocked run is never
 * an evaluated one.
 *
 *   - resolution via T2 (the v3 Q1 gate's writer call), T6 (her confirmation, through the real confirmation service) and
 *     the identity TTL (T7 ttl → T2, and T10) requests EXACTLY ONE evaluation when one is owed (a request the identity
 *     gate held, or no current assessment), none when it is not, and stays idempotent across re-written resolutions;
 *   - the request is the ordinary one: trigger IDENTITY_RESOLVED, debounced, not forced — the digest skip still applies;
 *   - latestEvaluationOutcome's truth table; a `done` blocked run is never "evaluated" (the ledger decides);
 *   - flag off ⇒ nothing is requested and nothing changes.
 *
 * The REAL runner, orchestrator, params, snapshot, parse, score and ledger on PGlite; the provider is replaced at the
 * evaluator boundary (`callEvaluator`) by a frozen golden response, exactly as miaIdentityGate.test.ts (H1) does.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

/** The provider boundary. Never a real call. */
const callEvaluator = jest.fn();
jest.mock("../../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: (...args: any[]) => callEvaluator(...args) };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athleteResearchState, athletes, intelligenceLedger, memoryFacts, miaEvaluationRuns, researchEvidence, researchRuns, workflowRuns, workflowSteps,
} from "../../../shared/schema";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../../services/marketabilityBeta1FrozenParams";
import { BETA1_FREEZE_AS_OF, BETA1_GOLDENS_PATH } from "../../services/marketabilityBeta1Freeze";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, seedBeta1Params } from "../../services/marketabilityBeta1Params";
import {
  MIA_DEBOUNCE_MS, evaluationOwed, getMarketability, latestEvaluationOutcome, requestEvaluation, requestEvaluationIfOwed,
  type EvaluationOutcome,
} from "../../services/marketabilityBeta1Orchestrator";
import { applyIdentityTransition, readIdentityState, type Q1Determination } from "../../services/intelligence/research/identityResolution";
import { applyQ1Gate } from "../../services/intelligence/research/identityGate";
import { confirmPublicIdentity, rejectPublicIdentity } from "../../services/intelligence/research/confirmation";
import { grandfatherMembership } from "../../services/intelligence/identity/users";
import { configureRunner, resetRunnerConfig, getRun, tick } from "../runner";
import "./index";

// ── flags (as H1) ─────────────────────────────────────────────────────────────
const FLAGS = ["RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_ENABLED", "RESEARCH_REFRESH_PROVIDER"] as const;
const env = process.env;
const setFlags = (f: Partial<Record<(typeof FLAGS)[number], string>>) => {
  process.env = { ...env }; for (const k of FLAGS) delete process.env[k]; Object.assign(process.env, f);
};
const FLAG_ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const FLAG_OFF = {};

// ── fixtures (as H1) ──────────────────────────────────────────────────────────
const bundle = JSON.parse(readFileSync(BETA1_GOLDENS_PATH, "utf8")) as { athletes: { key: string; name: string; sport: string }[] };
const GOLDEN = bundle.athletes[0];
const ARTIFACTS = join(__dirname, "..", "..", "scripts", "calibration", "runs", "blind-eval-v2", "gemini");
function frozenCall() {
  const raw = JSON.parse(readFileSync(join(ARTIFACTS, `${GOLDEN.key}.dev37.raw.json`), "utf8").replace(/\r\n/g, "\n"));
  return {
    model: raw.model, modelVersion: raw.modelVersion ?? null, responseId: raw.responseId ?? null,
    latencyMs: raw.latencyMs ?? 0, finishReason: raw.finishReason ?? null, truncated: !!raw.truncated,
    usage: raw.usage ?? { promptTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null, searchCalls: null },
    costUsd: raw.costUsd ?? 0, text: raw.text, native: raw.native ?? {},
  };
}

const RESOLVED: Q1Determination = { outcome: "resolved", anchorMatch: "matched", confidence: 0.9, namesakes: 0, corroboratedBy: [] };
const AMBIGUOUS: Q1Determination = { outcome: "ambiguous", anchorMatch: "matched", confidence: 0.6, namesakes: 2, reason: "namesakes_unseparated" };
const FAILED: Q1Determination = { outcome: "failed", anchorMatch: "not_resolved", confidence: null, namesakes: 0, reason: "no_public_match" };

let seq = 0;
/** A fresh athlete with a self membership and an athlete_research_state row with NO determination (NULL). */
async function seedAthlete(opts: { sport?: string | null } = {}): Promise<{ athleteId: string; userId: string }> {
  const [row] = await db.insert(athletes)
    .values({ full_name: `${GOLDEN.name} H2-${++seq}`, sport: opts.sport === undefined ? GOLDEN.sport : opts.sport, created_at: new Date(BETA1_FREEZE_AS_OF) } as any)
    .returning({ id: athletes.id });
  await db.insert(athleteResearchState).values({ athlete_id: row.id, identity_resolution: null } as any);
  const m = await grandfatherMembership({ athleteId: row.id, uid: `uid-h2-${row.id}`, note: "h2 test" });
  return { athleteId: row.id, userId: m!.userId };
}

/** T1: the lifecycle/admin entry (NULL → pending). Never resolves, so it never fires the listener. */
async function enter(athleteId: string) {
  const r = await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, { kind: "enter", trigger: "signup", by: null, anchorHash: "h" });
  expect(r).toMatchObject({ written: true, transition: "T1" });
}

/** A completed Q1 research_runs row of hers with one evidence row: what the v3 Q1 step persists before the gate. */
async function q1Row(athleteId: string): Promise<{ researchRunId: string; evidenceId: string }> {
  const [run] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "manual", status: "ok", query_id: "Q1" } as any).returning({ id: researchRuns.id });
  const [ev] = await db.insert(researchEvidence).values({ athlete_id: athleteId, run_id: run.id, kind: "press_mention", claim: { title: "roster" } as any, lineage_status: "native_supported", retrieved_at: new Date(), dedupe_key: `h2-${run.id}` } as any).returning({ id: researchEvidence.id });
  return { researchRunId: run.id, evidenceId: ev.id };
}

/** The v3 Q1 step's writer call (T2 / T3 / T4 from pending; T10 from resolved), exactly as v3Stage.ts makes it. */
async function q1Gate(athleteId: string, determination: Q1Determination, researchRunId?: string) {
  const rr = researchRunId ?? (await q1Row(athleteId)).researchRunId;
  return applyQ1Gate({ athleteId, governIdentity: true, determination, researchRunId: rr, workflowRunId: null, requestAnchorHash: "h", currentAnchorHash: "h", namesakeEvidenceIds: [] });
}

let now = new Date("2026-10-01T10:00:00.000Z");

const miaRuns = (athleteId: string) => db.select().from(workflowRuns)
  .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, "mia_evaluation")));
const resolutionRuns = async (athleteId: string) => (await miaRuns(athleteId)).filter((r) => r.created_by === "identity_resolved");

/** Let the runner finish a run (past the debounce window). */
async function drain(runId: string) {
  now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
  for (let i = 0; i < 10 && (await getRun(runId))!.run.status === "running"; i++) await tick();
  const got = (await getRun(runId))!;
  const out = (step: string) => got.steps.find((s) => s.step === step)?.output as any;
  return { run: got.run, snapshot: out("snapshot"), evaluate: out("evaluate"), score: out("score") };
}

/** A blocked request: SOCIAL_BLOCK_CHANGED while identity is not resolved, run to completion (ends `done`, H1). */
async function blockedRequest(athleteId: string) {
  const { runId } = await requestEvaluation({ athleteId, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" });
  const r = await drain(runId);
  expect(r.run.status).toBe("done");
  expect(r.evaluate).toMatchObject({ status: "blocked_identity" });
  return runId;
}

/** An athlete already evaluated once (identity resolved, a current assessment of record). */
async function evaluatedAthlete() {
  const a = await seedAthlete();
  await enter(a.athleteId);
  await q1Gate(a.athleteId, RESOLVED);                       // T2 → the owed first assessment is requested …
  const [run] = await resolutionRuns(a.athleteId);
  const r = await drain(run.id);                              // … and evaluated
  expect(r.score).toMatchObject({ recorded: true });
  callEvaluator.mockClear();
  return a;
}

beforeAll(async () => {
  await initTestDb();
  await seedBeta1Params({
    engine: MARKETABILITY_BETA1_FROZEN_PARAMS, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0,
    priors: BETA1_PRIORS_V1, cohorts: BETA1_COHORTS_V0, activate: true, createdBy: "h2-identity-retrigger-test",
  });
}, 180_000);
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  now = new Date("2026-10-01T10:00:00.000Z");
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
  callEvaluator.mockReset();
  callEvaluator.mockImplementation(async () => frozenCall());
  setFlags(FLAG_ON);
  // tick() is global: a run left in flight by an earlier test must not execute inside this one.
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});
afterEach(() => { process.env = env; });

// ── 4 Nov 2026: an athlete with no memory facts is never owed an evaluation ───
// M.I.A. scores only from the facts we hold and never searches (one search provider, owner decision). The legacy
// re-trigger cases this file used to drive (T2 / T6 / T7 / T10 resolving for an athlete with no memory) can no longer
// lead to an evaluation: identity resolving requests nothing for her, and a later trigger records "no facts yet".
describe("identity resolves for an athlete with no memory facts → nothing is owed, nothing searches", () => {
  test("T2 at account creation: no request, owed says no_facts; a direct request records no facts and makes no call", async () => {
    const { athleteId } = await seedAthlete();
    await enter(athleteId);
    await q1Gate(athleteId, RESOLVED);
    await expect(evaluationOwed(athleteId)).resolves.toEqual({ owed: false, why: "no_facts" });
    await expect(requestEvaluationIfOwed(athleteId, { transition: "T2" })).resolves.toMatchObject({ requested: false, owed: { why: "no_facts" } });
    expect(callEvaluator).not.toHaveBeenCalled();
  }, 60_000);
});

// ── the re-trigger itself is still live for an athlete WITH memory facts ──────
// Restored from the cases above that drove a no-memory athlete: the owed / in-flight / blocked-run rules of
// requestEvaluationIfOwed are unchanged code, reached by every memory athlete, so they stay pinned here on one.

/** A made-up facts-only answer citing the prompt's first fact id for every signal (the facts-only parser's input). */
function factsAnswerFor(prompt: string) {
  const id = /^- \[(F\d+|[0-9a-f-]{36})\]/m.exec(prompt)?.[1];
  const dims: any = {};
  for (const [d, sw] of Object.entries(MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>)) {
    dims[d] = {};
    for (const k of Object.keys(sw)) dims[d][k] = id ? { status: "scored", score: 62, confidence: "MEDIUM", evidence_ids: [id], rationale: "From the facts." } : { status: "missing" };
  }
  const json = { athlete: { identity_confidence: "HIGH" }, marketability_summary: "From the facts.", evidence: id ? [{ id, claim: "c", source_url: "https://example.org/x" }] : [], dimensions: dims };
  return { ...frozenCall(), text: "```json\n" + JSON.stringify(json) + "\n```", native: {} };
}

/** A memory athlete: the onboarding's said name and sport, and one found fact. */
async function seedMemoryAthlete(): Promise<{ athleteId: string; userId: string; name: string }> {
  const a = await seedAthlete();
  const [row] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, a.athleteId));
  const name = row.name!;
  const base = { athlete_id: a.athleteId, subject_kind: "athlete", subject_name: name, confidence: 1 };
  await db.insert(memoryFacts).values([
    { ...base, claim: `The athlete's name is ${name}.`, type: "said", source_ref: "onboarding/run#name", source_title: "You told us" },
    { ...base, claim: `${name}'s sport is ${GOLDEN.sport}.`, type: "said", source_ref: "onboarding/run#sport", source_title: "You told us" },
    { ...base, claim: `${name} started every match of the season.`, type: "found", source_url: "https://example.org/season", source_title: "Public page", confidence: 0.8, observed_on: "2026-09-20" },
  ] as any);
  return { ...a, name };
}

describe("a memory athlete: identity resolving requests the owed evaluation once; a blocked run is never evaluated", () => {
  beforeEach(() => { callEvaluator.mockImplementation(async (prompt: string) => factsAnswerFor(prompt)); });

  test("T2 with no assessment → ONE IDENTITY_RESOLVED request that evaluates; the same Q1 re-applied (T10) asks nothing more", async () => {
    const { athleteId } = await seedMemoryAthlete();
    await enter(athleteId);
    const q1 = await q1Row(athleteId);
    await q1Gate(athleteId, RESOLVED, q1.researchRunId);
    const runs = await resolutionRuns(athleteId);
    expect(runs).toHaveLength(1);
    expect(runs[0].input).toMatchObject({ trigger: "IDENTITY_RESOLVED", force: false });
    const r = await drain(runs[0].id);
    expect(r.evaluate).toMatchObject({ status: "ok" });
    expect(r.score).toMatchObject({ recorded: true });
    expect(callEvaluator).toHaveBeenCalledTimes(1);

    await q1Gate(athleteId, RESOLVED, q1.researchRunId);
    await expect(evaluationOwed(athleteId)).resolves.toMatchObject({ owed: false, why: "current_assessment" });
    expect(await resolutionRuns(athleteId)).toHaveLength(1);
    expect(callEvaluator).toHaveBeenCalledTimes(1);
  }, 60_000);

  test("requestEvaluationIfOwed twice in a row: the second finds the first in flight", async () => {
    const { athleteId } = await seedMemoryAthlete();
    await enter(athleteId);
    await db.update(athleteResearchState).set({ identity_resolution: "resolved" }).where(eq(athleteResearchState.athlete_id, athleteId));
    await expect(requestEvaluationIfOwed(athleteId, { transition: "T2" })).resolves.toMatchObject({ requested: true, created: true, owed: { why: "no_assessment" } });
    await expect(requestEvaluationIfOwed(athleteId, { transition: "T10" })).resolves.toMatchObject({ requested: false, owed: { owed: false, why: "in_flight" } });
    expect(await miaRuns(athleteId)).toHaveLength(1);
  });

  test("a disputed identity fact blocks: the run ends done yet reads blocked_identity, no ledger row; settled, the held request is owed", async () => {
    const { athleteId, name } = await seedMemoryAthlete();
    const [dispute] = await db.insert(memoryFacts).values({
      athlete_id: athleteId, subject_kind: "athlete", subject_name: name, type: "made", status: "disputed", confidence: 0.5,
      claim: `Research could not yet confirm which public profile belongs to ${name}: two people share the name.`,
      source_ref: "agent_runs/r1#identity", source_title: "Nomila research",
    } as any).returning({ id: memoryFacts.id });
    await blockedRequest(athleteId);
    expect(callEvaluator).not.toHaveBeenCalled();
    expect((await latestEvaluationOutcome(athleteId)).outcome).toBe("blocked_identity");
    expect(await getMarketability(athleteId)).toBeNull();
    await expect(evaluationOwed(athleteId)).resolves.toMatchObject({ owed: false, why: "identity_not_resolved" });

    await db.update(memoryFacts).set({ status: "active" } as any).where(eq(memoryFacts.id, dispute.id));
    await expect(evaluationOwed(athleteId)).resolves.toMatchObject({ owed: true, why: "blocked_request" });
  }, 60_000);
});

// ── the outcome helper's truth table ──────────────────────────────────────────
describe("latestEvaluationOutcome: truth table", () => {
  /** Hand-written run + step rows, for the states a real run passes through too quickly to observe. */
  async function fakeRun(athleteId: string, status: string, outputs: Record<string, unknown>, opts: { forced?: boolean } = {}) {
    now = new Date(now.getTime() + 1000);
    const [run] = await db.insert(workflowRuns).values({
      athlete_id: athleteId, process: "mia_evaluation", definition_version: 1, active_scope: opts.forced ? "mia_evaluation:forced" : "mia_evaluation",
      status, input: { trigger: "SOCIAL_BLOCK_CHANGED", force: !!opts.forced, reason: null } as any, started_at: now, created_by: "test",
    }).returning();
    let ordinal = 0;
    for (const [step, output] of Object.entries(outputs)) {
      await db.insert(workflowSteps).values({ run_id: run.id, step, ordinal: ordinal++, kind: step === "evaluate" ? "model" : "code", status: "done", output: output as any });
    }
    return run.id;
  }
  const outcomeOf = async (athleteId: string) => (await latestEvaluationOutcome(athleteId)).outcome;

  const CASES: Array<[string, (athleteId: string) => Promise<unknown>, EvaluationOutcome]> = [
    ["no run ever", async () => {}, "none"],
    ["requested, debounce pending", async (id) => requestEvaluation({ athleteId: id, trigger: "SOCIAL_BLOCK_CHANGED" }), "in_flight"],
    ["blocked, run done", async (id) => fakeRun(id, "done", { wait: {}, snapshot: { blocked: "identity_gate", identity: "pending", trigger: "SOCIAL_BLOCK_CHANGED", force: false }, evaluate: { status: "blocked_identity" }, score: { recorded: false, reason: "blocked_identity" } }), "blocked_identity"],
    ["blocked, run still finishing", async (id) => fakeRun(id, "running", { wait: {}, snapshot: { blocked: "identity_gate", identity: null, trigger: "SOCIAL_BLOCK_CHANGED", force: false } }), "blocked_identity"],
    ["skipped_unchanged", async (id) => fakeRun(id, "done", { wait: {}, snapshot: { snapshotId: "s", digest: "d", unchanged: true }, evaluate: { status: "skipped_unchanged" }, score: { recorded: false } }), "skipped_unchanged"],
    ["no snapshot (no sport)", async (id) => fakeRun(id, "done", { wait: {}, snapshot: { skipped: "no resolvable identity" }, evaluate: { status: "skipped_no_identity" }, score: { recorded: false } }), "skipped"],
    ["refusal (failed_validation)", async (id) => fakeRun(id, "done", { wait: {}, snapshot: { snapshotId: "s", digest: "d", unchanged: false }, evaluate: { runId: "00000000-0000-0000-0000-000000000001", status: "failed_validation" }, score: { recorded: false } }), "not_evaluated"],
    ["evaluate ok but NO ledger row, run done", async (id) => fakeRun(id, "done", { wait: {}, snapshot: { snapshotId: "s", digest: "d", unchanged: false }, evaluate: { runId: "00000000-0000-0000-0000-000000000002", status: "ok" }, score: { recorded: false } }), "not_evaluated"],
    ["evaluate ok, score pending (run active)", async (id) => fakeRun(id, "running", { wait: {}, snapshot: { snapshotId: "s", digest: "d", unchanged: false }, evaluate: { runId: "00000000-0000-0000-0000-000000000003", status: "ok" } }), "in_flight"],
    ["workflow failed", async (id) => fakeRun(id, "failed", { wait: {} }), "not_evaluated"],
    ["evaluated earlier, then a newer blocked run (latest wins)", async (id) => {
      await fakeRun(id, "done", { wait: {}, snapshot: { snapshotId: "s", digest: "d", unchanged: true }, evaluate: { status: "skipped_unchanged" } });
      await fakeRun(id, "done", { wait: {}, snapshot: { blocked: "identity_gate", identity: "ambiguous", trigger: "SOCIAL_BLOCK_CHANGED", force: false } }, { forced: true });
    }, "blocked_identity"],
  ];

  test.each(CASES.map(([n, arrange, expected]) => [n, expected, arrange] as const))("%s → %s", async (_name, expected, arrange) => {
    setFlags(FLAG_ON);
    const { athleteId } = await seedAthlete();
    await arrange(athleteId);
    expect(await outcomeOf(athleteId)).toBe(expected);
  });

});

// ── flag off ──────────────────────────────────────────────────────────────────
describe("flag off ⇒ nothing changes", () => {
  test("no transition is written, so nothing is requested; requestEvaluationIfOwed is inert", async () => {
    setFlags(FLAG_ON);
    const { athleteId } = await seedAthlete();
    await enter(athleteId);
    setFlags(FLAG_OFF);
    expect(await q1Gate(athleteId, RESOLVED)).toEqual({ written: false, reason: "observed" });
    expect(await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, { kind: "q1", determination: RESOLVED, researchRunId: "rr", workflowRunId: null, requestAnchorHash: "h", currentAnchorHash: "h" }))
      .toEqual({ written: false, reason: "disabled" });
    await db.update(athleteResearchState).set({ identity_resolution: "resolved" }).where(eq(athleteResearchState.athlete_id, athleteId));
    await expect(evaluationOwed(athleteId)).resolves.toEqual({ owed: false, why: "disabled" });
    await expect(requestEvaluationIfOwed(athleteId, { transition: "T2" })).resolves.toMatchObject({ requested: false });
    expect(await miaRuns(athleteId)).toHaveLength(0);
  });
});
