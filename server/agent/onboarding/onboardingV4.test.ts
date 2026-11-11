/**
 * onboardingV4.test.ts — agent_onboarding v4 reuses a fresh sign-up research (the waitlist's signup_research run) at
 * her first app launch instead of researching her again. PGlite + the real runner; the OpenAI transport is a counting
 * double that throws (no provider is ever reached), kick is a no-op and the test ticks.
 *
 *   V1 freshSignupResearch: reused for the same anchor (a shorter form of her name counts) within
 *      SIGNUP_RESEARCH_FRESH_DAYS; not when stale, the sport or name changed, the merge never finished, or none
 *   V2 a promoted waitlister's onboarding (v4, the default) reuses it: both passes and the merge finish with no model
 *      call and no cost, the merge hands on the sign-up run's gaps and identity
 *   V3 no sign-up research ⇒ v4 researches exactly as v3 (the pass calls the model)
 *   V4 her said facts are never written twice (the sign-up run wrote the same words)
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));
jest.mock("../../services/miaPreview/preview", () => ({ getMiaPreview: jest.fn(async () => { throw new Error("no M.I.A. in this test"); }), readMiaPreview: jest.fn(async () => null) }));
jest.setTimeout(180_000);

import { and, eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { configureRunner, resetRunnerConfig, tick } from "../../workflow/runner";
import { setResponsesTransport } from "../research/llm";
import { dbStore } from "../research/dbStore";
import { freshSignupResearch, parentPrefixFor } from "./workflow";
import { startOnboarding } from "./service";

const env = process.env;
const DAY = 86_400_000;
const create = jest.fn(async () => { throw new Error("no model in this test"); });

/** Her finished sign-up research: a signup_research run whose merge finished `ageDays` ago (or never). */
async function signupResearch(athleteId: string, input: { name: string; sport: string }, ageDays: number | null) {
  const [run] = await db.insert(workflowRuns).values({ athlete_id: athleteId, process: "signup_research", definition_version: 1, active_scope: "signup_research", status: "done", input, created_by: "signup", started_at: new Date(Date.now() - 50 * DAY) } as any).returning({ id: workflowRuns.id });
  await db.insert(workflowSteps).values({ run_id: run.id, step: "research_merge", ordinal: 1, kind: "model", input: {},
    status: ageDays === null ? "failed" : "done", finished_at: new Date(Date.now() - (ageDays ?? 1) * DAY),
    output: { run_id: "merge-run", inserted: 7, disputed: 0, duplicates: 1, measured: 0, identity_resolved: true, gaps: ["No recent press found."], cost_micro_usd: 70_000 } } as any);
  return run.id;
}
const stepsOf = (runId: string) => db.select().from(workflowSteps).where(eq(workflowSteps.run_id, runId));

beforeAll(async () => { await initTestDb(); setResponsesTransport({ create } as any); });
afterAll(async () => { process.env = env; setResponsesTransport(null); await closeTestDb(); });
beforeEach(async () => {
  process.env = { ...env };
  delete process.env.DAILY_RESEARCH_CAP_USD; delete process.env.SIGNUP_RESEARCH_FRESH_DAYS;
  resetRunnerConfig(); configureRunner({ retry: { minTimeoutMs: 60 * 60_000, maxTimeoutMs: 60 * 60_000, randomize: false } });   // no retry inside a test
  create.mockClear();
  await db.delete(workflowSteps); await db.delete(workflowRuns);
});

test("V1: a fresh sign-up research is reused only for the same anchor, within the window", async () => {
  const anchor = { name: "Avery Example", sport: "Golf" };
  const fresh = await seedAthlete("Avery Example");
  const runId = await signupResearch(fresh, anchor, 3);
  expect(await freshSignupResearch(fresh, anchor)).toMatchObject({ runId, merge: { gaps: ["No recent press found."], identity_resolved: true } });
  expect(await freshSignupResearch(fresh, { name: "Avery", sport: "golf" })).toMatchObject({ runId });   // a shorter form of her name, any case
  expect(await freshSignupResearch(fresh, { name: "Avery Example", sport: "Tennis" })).toBeNull();      // her sport changed
  expect(await freshSignupResearch(fresh, { name: "Jordan Other", sport: "Golf" })).toBeNull();         // a different name
  process.env.SIGNUP_RESEARCH_FRESH_DAYS = "2";
  expect(await freshSignupResearch(fresh, anchor)).toBeNull();                                          // older than the window
  expect(await freshSignupResearch(fresh, anchor, { ignoreAge: true })).toMatchObject({ runId });
  delete process.env.SIGNUP_RESEARCH_FRESH_DAYS;
  const stale = await seedAthlete("Stale Example");
  await signupResearch(stale, { name: "Stale Example", sport: "Golf" }, 31);                            // default window 30 days
  expect(await freshSignupResearch(stale, { name: "Stale Example", sport: "Golf" })).toBeNull();
  const unmerged = await seedAthlete("Unmerged Example");
  await signupResearch(unmerged, { name: "Unmerged Example", sport: "Golf" }, null);
  expect(await freshSignupResearch(unmerged, { name: "Unmerged Example", sport: "Golf" })).toBeNull();
  expect(await freshSignupResearch(await seedAthlete("Never Researched"), anchor)).toBeNull();
});

test("V2: a promoted waitlister's onboarding reuses her sign-up research: no model call, no cost, gaps handed on", async () => {
  const id = await seedAthlete("Avery Example", { agent_onboarding_required: true } as any);
  const signupRunId = await signupResearch(id, { name: "Avery Example", sport: "Golf" }, 5);
  const r = await startOnboarding(id, { name: "Avery Example", sports: ["Golf"] });
  expect(r.created).toBe(true);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.runId));
  expect(run.definition_version).toBe(4);
  await tick(); await tick();
  const steps = await stepsOf(r.runId);
  const out = (name: string) => steps.find((s) => s.step === name && s.status === "done")?.output as any;
  expect(out("research_a")).toMatchObject({ reused_from: signupRunId, cost_micro_usd: 0 });
  expect(out("research_b")).toMatchObject({ reused_from: signupRunId, cost_micro_usd: 0 });
  expect(out("research_merge")).toMatchObject({ reused_from: signupRunId, gaps: ["No recent press found."], identity_resolved: true, cost_micro_usd: 0 });
  // No research run was paid for under this onboarding.
  const research = (await dbStore.listRunsByPrefix(id, parentPrefixFor(r.runId))).filter((x) => x.skillId === "research" || x.skillId === "research-merge");
  expect(research).toEqual([]);
  const researchCalls = create.mock.calls.filter((c: any) => JSON.stringify(c?.[0] ?? {}).includes("web_search"));
  expect(researchCalls).toEqual([]);
});

test("V3: with no sign-up research, v4 researches exactly as v3", async () => {
  const id = await seedAthlete("Brand New", { agent_onboarding_required: true } as any);
  const r = await startOnboarding(id, { name: "Brand New", sports: ["Golf"] });
  await tick();
  const passes = (await stepsOf(r.runId)).filter((s) => s.step === "research_a" || s.step === "research_b");
  expect(passes.length).toBeGreaterThan(0);
  expect(passes.every((s) => !(s.output as any)?.reused_from)).toBe(true);
  expect(passes.some((s) => s.status === "failed")).toBe(true);                                         // it called the (throwing) model
  expect(create).toHaveBeenCalled();
});

test("V4: her said facts are never written twice", async () => {
  const id = await seedAthlete("Avery Example", { agent_onboarding_required: true } as any);
  await dbStore.insertFacts(id, [
    { subject: { kind: "athlete", name: "Avery Example" }, claim: "The athlete's name is Avery Example.", type: "said", source: { ref: "onboarding/signup#name", title: "You told us" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Avery Example" }, claim: "Avery Example's sport is Golf.", type: "said", source: { ref: "onboarding/signup#sport", title: "You told us" }, date: "2026-10-01", confidence: 1, runId: null },
  ]);
  await startOnboarding(id, { name: "Avery Example", sports: ["Golf", "Tennis"] });
  const said = (await dbStore.listFacts(id, ["active"])).filter((f) => f.type === "said").map((f) => f.claim).sort();
  expect(said).toEqual(["Avery Example also plays Tennis.", "Avery Example's main sport is Golf.", "Avery Example's sport is Golf.", "The athlete's name is Avery Example."]);
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.athlete_id, id), eq(workflowRuns.process, "agent_onboarding")));
  expect((await dbStore.getCheckpoints(id, run.id)).name_sport?.status).toBe("done");
});
