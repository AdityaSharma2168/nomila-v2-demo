/**
 * miaIdentityGate.test.ts — PR H1: the identity invariant on every identity-dependent M.I.A. trigger.
 *
 * "No identity-dependent M.I.A. trigger may evaluate an unresolved or ambiguous public identity" (research-acquisition
 * architecture, Invariant; R-a; §10(c)). Behind the ONE shared boundary, identityResolutionEnabled() (PR E §5.7):
 *   flag OFF  ⇒ Beta.1 behaviour unchanged: the evaluator is called exactly as before, identity is never even read;
 *   flag ON   ⇒ blocked for NULL (no row, or a row with no determination), pending, ambiguous, failed;
 *               permitted for resolved; no historical-user exceptions;
 *   blocked   ⇒ recorded (the workflow run is kept, with the reason on its steps), zero provider calls, no snapshot,
 *               no evaluation run, no ledger entry; re-requested on a WRITTEN resolution by H2 (miaIdentityRetrigger.test.ts);
 *   Q1        ⇒ identity resolution itself never passes through the gate.
 *
 * Driven through the REAL runner and the REAL orchestrator (real params, real snapshot, real parse/score/ledger), with
 * the provider replaced at the evaluator boundary (`callEvaluator`) by a frozen golden response. Every trigger is
 * requested exactly as its production caller requests it.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

/** The provider boundary. Never a real call. */
const callEvaluator = jest.fn();
jest.mock("../../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: (...args: any[]) => callEvaluator(...args) };
});

/** Spied, so "flag off reads nothing" is provable. Still the real reader. */
const readIdentityStateSpy = jest.fn();
jest.mock("../../services/intelligence/research/identityResolution", () => {
  const actual = jest.requireActual("../../services/intelligence/research/identityResolution");
  return { ...actual, readIdentityState: (...args: any[]) => { readIdentityStateSpy(...args); return actual.readIdentityState(...args); } };
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import {
  athleteResearchState, athletes, intelligenceLedger, miaEvaluationRuns, miaEvidenceSnapshots, workflowRuns, workflowSteps,
} from "../../../shared/schema";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../../services/marketabilityBeta1FrozenParams";
import { BETA1_FREEZE_AS_OF, BETA1_GOLDENS_PATH } from "../../services/marketabilityBeta1Freeze";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, seedBeta1Params } from "../../services/marketabilityBeta1Params";
import { MIA_DEBOUNCE_MS, miaIdentityGate, requestEvaluation, type EvaluationRequest } from "../../services/marketabilityBeta1Orchestrator";
import { promptFor } from "../../services/marketabilityBeta1Snapshot";
import { identityResolutionEnabled } from "../../services/intelligence/research/config";
import { applyIdentityTransition, readIdentityState, type IdentityValue } from "../../services/intelligence/research/identityResolution";
import { configureRunner, resetRunnerConfig, getRun, tick } from "../runner";
import "./index";

const REPO = join(__dirname, "..", "..", "..");

// ── flags ─────────────────────────────────────────────────────────────────────
const FLAGS = ["RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_ENABLED", "RESEARCH_REFRESH_PROVIDER"] as const;
const env = process.env;
const setFlags = (f: Partial<Record<(typeof FLAGS)[number], string>>) => {
  process.env = { ...env }; for (const k of FLAGS) delete process.env[k]; Object.assign(process.env, f);
};
const FLAG_ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const FLAG_OFF = {};

// ── every trigger, requested exactly as its production caller requests it ─────
const TRIGGERS: Record<string, Omit<EvaluationRequest, "athleteId">> = {
  "IDENTITY_RESOLVED (auth.ts signup)": { trigger: "IDENTITY_RESOLVED", createdBy: "app_signup" },
  "SOCIAL_BLOCK_CHANGED (socialSync.ts)": { trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" },
  "USER_REQUESTED_REFRESH (admin manual refresh)": { trigger: "USER_REQUESTED_REFRESH", force: true, reason: "score looks wrong", createdBy: "admin_manual_refresh" },
  "USER_REQUESTED_REFRESH (miaRefreshCohort script)": { trigger: "USER_REQUESTED_REFRESH", force: true, reason: "cohort", createdBy: "cohort_validation" },
  "ADMIN_REQUESTED_REFRESH (enum value, no caller today)": { trigger: "ADMIN_REQUESTED_REFRESH" },
};

/** "NULL" twice: no athlete_research_state row at all, and a row with no determination recorded. */
type IdentityCase = "no_row" | "NULL" | "pending" | "ambiguous" | "failed" | "resolved";
const IDENTITY_CASES: IdentityCase[] = ["no_row", "NULL", "pending", "ambiguous", "failed", "resolved"];
const valueOf = (c: IdentityCase): IdentityValue => (c === "no_row" || c === "NULL" ? null : c);

// ── fixtures ──────────────────────────────────────────────────────────────────
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

let seq = 0;
/** A fresh athlete per case (a unique name, so the digest never matches an earlier case and skips). */
async function seedCase(identity: IdentityCase): Promise<{ athleteId: string; name: string }> {
  const name = `${GOLDEN.name} H1-${++seq}`;
  const [row] = await db.insert(athletes)
    .values({ full_name: name, sport: GOLDEN.sport, created_at: new Date(BETA1_FREEZE_AS_OF) } as any)
    .returning({ id: athletes.id });
  if (identity !== "no_row") {
    const value = valueOf(identity);
    await db.insert(athleteResearchState).values({
      athlete_id: row.id,
      identity_resolution: value,
      identity_resolution_detail: value === null ? null : ({ at: "2026-10-01T00:00:00.000Z", basis: "fixture", previous: null } as any),
    } as any);
  }
  return { athleteId: row.id, name };
}

let now = new Date("2026-10-01T10:00:00.000Z");

/** Request through the real entry point, then let the runner finish the run (past the debounce window if any). */
async function requestAndDrain(athleteId: string, req: Omit<EvaluationRequest, "athleteId">) {
  const { runId, created } = await requestEvaluation({ athleteId, ...req });
  expect(created).toBe(true);
  now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
  for (let i = 0; i < 10 && (await getRun(runId))!.run.status === "running"; i++) await tick();
  const got = (await getRun(runId))!;
  const out = (step: string) => got.steps.find((s) => s.step === step)?.output as any;
  return { runId, run: got.run, snapshot: out("snapshot"), evaluate: out("evaluate"), score: out("score") };
}

const rowsFor = async (athleteId: string) => ({
  snapshots: await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.athlete_id, athleteId)),
  evalRuns: await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId)),
  ledger: await db.select().from(intelligenceLedger).where(eq(intelligenceLedger.subject_id, athleteId)),
});

beforeAll(async () => {
  await initTestDb();
  await seedBeta1Params({
    engine: MARKETABILITY_BETA1_FROZEN_PARAMS, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0,
    priors: BETA1_PRIORS_V1, cohorts: BETA1_COHORTS_V0, activate: true, createdBy: "h1-identity-gate-test",
  });
}, 180_000);
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  now = new Date("2026-10-01T10:00:00.000Z");
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
  callEvaluator.mockReset();
  callEvaluator.mockImplementation(async () => frozenCall());
  readIdentityStateSpy.mockClear();
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});
afterEach(() => { process.env = env; });

// ── the truth table ───────────────────────────────────────────────────────────
const TABLE = (["off", "on"] as const).flatMap((flag) =>
  IDENTITY_CASES.flatMap((identity) => Object.keys(TRIGGERS).map((trigger) => [flag, identity, trigger] as const)));

describe("truth table: flag × identity × trigger", () => {
  test("covers 2 × 6 × 5 cases", () => { expect(TABLE).toHaveLength(60); });

  test.each(TABLE)("flag %s · identity %s · %s", async (flag, identity, triggerName) => {
    setFlags(flag === "on" ? FLAG_ON : FLAG_OFF);
    const req = TRIGGERS[triggerName];
    const { athleteId, name } = await seedCase(identity);
    const r = await requestAndDrain(athleteId, req);
    const rows = await rowsFor(athleteId);
    expect(r.run.status).toBe("done");

    const permitted = flag === "off" || identity === "resolved";
    if (permitted) {
      // Permitted by the gate, but these athletes hold no memory facts: since 4 Nov 2026 M.I.A. scores only from facts
      // we hold and never searches, so nothing is evaluated ("no facts yet"): zero provider calls, no snapshot.
      void name;
      expect(callEvaluator).not.toHaveBeenCalled();
      expect(r.snapshot).toEqual({ skipped: "no_facts" });
      expect(r.evaluate).toEqual({ status: "skipped_no_facts" });
      expect(r.score).toEqual({ recorded: false, reason: "skipped_no_facts" });
      expect(rows).toEqual({ snapshots: [], evalRuns: [], ledger: [] });
    } else {
      // Blocked: recorded with its reason, zero provider calls, nothing evaluated or scored.
      expect(callEvaluator).not.toHaveBeenCalled();
      expect(r.snapshot).toEqual({ blocked: "identity_gate", identity: valueOf(identity), trigger: req.trigger, force: !!req.force });
      expect(r.evaluate).toEqual({ status: "blocked_identity", reason: "identity_gate", identity: valueOf(identity) });
      expect(r.score).toEqual({ recorded: false, reason: "blocked_identity" });
      expect(rows).toEqual({ snapshots: [], evalRuns: [], ledger: [] });
    }

    // Flag off: identity is never read — the gate is invisible.
    if (flag === "off") expect(readIdentityStateSpy).not.toHaveBeenCalled();
  }, 60_000);
});

// ── flag off is Beta.1, byte for byte ─────────────────────────────────────────
describe("flag off ⇒ Beta.1 behaviour unchanged", () => {
  test("miaIdentityGate permits every identity without reading anything", async () => {
    setFlags(FLAG_OFF);
    for (const c of IDENTITY_CASES) {
      const { athleteId } = await seedCase(c);
      await expect(miaIdentityGate(athleteId)).resolves.toEqual({ permitted: true });
    }
    expect(readIdentityStateSpy).not.toHaveBeenCalled();
  });

  test("the deployed prod yaml keeps the gate off: an unresolved athlete is not blocked (dev turned it on 1 Oct 2026); with no facts nothing is evaluated", async () => {
    for (const file of ["cloud-run-prod.yaml"]) {
      const doc = parse(readFileSync(join(REPO, "gcp", file), "utf8"));
      const deployed = Object.fromEntries((doc.spec.template.spec.containers[0].env as { name: string; value?: string }[])
        .filter((e) => (FLAGS as readonly string[]).includes(e.name)).map((e) => [e.name, e.value]));
      setFlags(deployed);
      expect(identityResolutionEnabled()).toBe(false);

      callEvaluator.mockClear();
      const { athleteId } = await seedCase("pending");
      const r = await requestAndDrain(athleteId, TRIGGERS["SOCIAL_BLOCK_CHANGED (socialSync.ts)"]);
      expect(r.snapshot).toEqual({ skipped: "no_facts" });
      expect(callEvaluator).not.toHaveBeenCalled();
    }
  }, 120_000);
});

// ── blocked is recorded, not dropped ──────────────────────────────────────────
describe("a blocked request is recorded so it can run later", () => {
  test("the run is kept with its trigger, input and reason; a raw column write (not the writer) re-triggers nothing", async () => {
    setFlags(FLAG_ON);
    const { athleteId } = await seedCase("pending");
    const r = await requestAndDrain(athleteId, TRIGGERS["SOCIAL_BLOCK_CHANGED (socialSync.ts)"]);

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.runId));
    expect(run).toMatchObject({ process: "mia_evaluation", athlete_id: athleteId, status: "done", created_by: "social_sync" });
    expect(run.input).toMatchObject({ trigger: "SOCIAL_BLOCK_CHANGED", force: false });
    expect(r.snapshot).toEqual({ blocked: "identity_gate", identity: "pending", trigger: "SOCIAL_BLOCK_CHANGED", force: false });

    // The block is not a failure: the run does not retry, and it does not hold the active scope (a later request opens
    // a new run rather than joining a dead one).
    expect(run.last_error).toBeNull();
    await db.update(athleteResearchState).set({ identity_resolution: "resolved" }).where(eq(athleteResearchState.athlete_id, athleteId));
    for (let i = 0; i < 3; i++) await tick();
    expect(callEvaluator).not.toHaveBeenCalled();   // no transition was WRITTEN, so H2's listener never fired

    const again = await requestAndDrain(athleteId, TRIGGERS["SOCIAL_BLOCK_CHANGED (socialSync.ts)"]);
    expect(again.runId).not.toBe(r.runId);
    // Now permitted; with no memory facts there is nothing to score from (no search since 4 Nov 2026).
    expect(again.snapshot).toEqual({ skipped: "no_facts" });
    expect(callEvaluator).not.toHaveBeenCalled();
  }, 60_000);

  test("identity is read when the run EXECUTES, not when it was requested", async () => {
    setFlags(FLAG_ON);
    const { athleteId } = await seedCase("resolved");
    const { runId } = await requestEvaluation({ athleteId, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" });
    // A re-entry (T9) inside the debounce window: by the time the run fires, identity is pending again.
    await db.update(athleteResearchState).set({ identity_resolution: "pending" }).where(eq(athleteResearchState.athlete_id, athleteId));
    now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
    for (let i = 0; i < 10 && (await getRun(runId))!.run.status === "running"; i++) await tick();
    const snap = (await getRun(runId))!.steps.find((s) => s.step === "snapshot")!.output as any;
    expect(snap).toMatchObject({ blocked: "identity_gate", identity: "pending" });
    expect(callEvaluator).not.toHaveBeenCalled();
  }, 60_000);
});

// ── identity resolution is never blocked ──────────────────────────────────────
describe("the identity-resolution path is unaffected by the gate", () => {
  test("with the gate ON, T1 and a Q1 resolution still write; the gate then permits", async () => {
    setFlags(FLAG_ON);
    const { athleteId } = await seedCase("NULL");
    await expect(miaIdentityGate(athleteId)).resolves.toMatchObject({ permitted: false, identity: null });

    const t1 = await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, { kind: "enter", trigger: "signup", by: null, anchorHash: "h1" });
    expect(t1).toMatchObject({ written: true, transition: "T1", to: "pending" });
    await expect(miaIdentityGate(athleteId)).resolves.toMatchObject({ permitted: false, identity: "pending" });

    const t2 = await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, {
      kind: "q1", determination: { outcome: "resolved", anchorMatch: "matched", confidence: 0.9, namesakes: 0, corroboratedBy: [] },
      researchRunId: "rr-1", workflowRunId: "wf-1", requestAnchorHash: "h1", currentAnchorHash: "h1",
    });
    expect(t2).toMatchObject({ written: true, transition: "T2", to: "resolved" });
    await expect(miaIdentityGate(athleteId)).resolves.toEqual({ permitted: true });
  });

  test("no research / identity-resolution module depends on the gate or the M.I.A. orchestrator", () => {
    const dir = join(REPO, "server", "services", "intelligence", "research");
    const offenders = walk(dir).filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => /miaIdentityGate|(?:from\s*|import\(\s*)["'][^"']*marketabilityBeta1Orchestrator/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

// ── one choke point ───────────────────────────────────────────────────────────
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const SOURCE = [...walk(join(REPO, "server")), ...walk(join(REPO, "scripts"))]
  .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${join("server", "testUtils")}`));
const usersOf = (re: RegExp) => SOURCE.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(REPO, f).replace(/\\/g, "/")).sort();

describe("every trigger reaches the evaluator only through the gated workflow step", () => {
  test("only the mia_evaluation workflow runs an evaluation (runEvaluation)", () => {
    expect(usersOf(/\brunEvaluation\b/)).toEqual([
      "server/services/marketabilityBeta1Orchestrator.ts",
      "server/workflow/definitions/miaEvaluation.ts",
    ]);
  });

  test("only requestEvaluation starts that workflow (MIA_EVALUATION_PROCESS / the literal process name)", () => {
    expect(usersOf(/\bMIA_EVALUATION_PROCESS\b|["'`]mia_evaluation["'`]/)).toEqual([
      "server/agent/onboarding/waitlistProgress.ts",            // READ-ONLY: the wait screen's checklist reads her latest run's evaluate step; starts nothing
      "server/services/intelligence/seams/inspect.ts",          // READ-ONLY: the dev/admin inspect seam reads the latest run; starts nothing
      "server/services/marketabilityBeta1Orchestrator.ts",
      "server/workflow/definitions/miaEvaluation.ts",
    ]);
  });

  test("the known requesters (inventory): signup, social_sync, admin refresh, cohort script", () => {
    expect(usersOf(/\brequestEvaluation\s*\(/)).toEqual([
      "server/agent/memoryRerun.ts",                            // the athlete changed a fact the last read used (memory_changed, debounced, capped 1/day)
      "server/routes/admin.ts",
      "server/routes/auth.ts",
      "server/scripts/intelligence/miaRefreshCohort.ts",
      "server/services/intelligence/seams/miaRecompute.ts",     // the dev/admin seam: identity preflight first, then the manual refresh
      "server/services/marketabilityBeta1Orchestrator.ts",
      "server/services/miaPreview/preview.ts",                  // the M.I.A. preview (immediate) + the memory recompute after a connect
      "server/workflow/definitions/socialSync.ts",
    ]);
  });
});
