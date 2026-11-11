/**
 * admin.promote.test.ts — POST /admin/waitlist/:id/promote never researches an agent-front sign-up twice.
 *
 *   P1 an agent-front sign-up (agent_onboarding_required — researched by her agent_onboarding run at sign-up) is promoted
 *      to active and notified, but the legacy `onboarding` run is NOT started
 *   P2 any other waitlisted athlete with a sport: the legacy onboarding run starts, as today
 *   P3 a waitlister researched on the agent route (signup_research) with the agent app front on: no legacy run; she is
 *      marked for the agent onboarding (v4 reuses her research at first launch)
 *   P4 the same athlete with the agent app front OFF (rollback): the legacy run starts, so the legacy app has research
 *   P5 front on: a held (queued) or unmerged sign-up research is CANCELED at promotion (v4 researches her once); a
 *      merged one is kept (v4 reuses it)
 *   P6 front off (rollback): any active sign-up research is canceled, merged or not (the legacy app researches her)
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({ requireAdmin: (_req: any, _res: any, next: any) => next(), requireAuth: (_req: any, _res: any, next: any) => next() }));
const notifyPromotion = jest.fn().mockResolvedValue({ logged: true, emailed: false });
jest.mock("../lib/notify", () => ({ notifyPromotion: (...a: unknown[]) => notifyPromotion(...a) }));
const startRun = jest.fn().mockResolvedValue({ run: { id: "run-1" }, created: true });
jest.mock("../workflow/runner", () => ({ ...jest.requireActual("../workflow/runner"), startRun: (...a: unknown[]) => startRun(...a) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import adminRouter from "./admin";
import { athletes } from "../../shared/schema";
import { workflowRuns, workflowSteps } from "../../shared/schemaWorkflow";
import { HELD_READY_AT } from "../workflow/runner";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server; let base: string;
const promote = async (id: string) => {
  const r = await fetch(`${base}/waitlist/${id}/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { status: r.status, json: (await r.json()) as any };
};
const statusOf = async (id: string) => (await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, id)))[0]?.status;

beforeAll(async () => {
  await initTestDb();
  const app = express(); app.use(express.json()); app.use("/", adminRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
const env = process.env;
beforeEach(() => { startRun.mockClear(); notifyPromotion.mockClear(); process.env = { ...env }; delete process.env.AGENT_ONBOARDING; });
afterAll(() => { process.env = env; });
/** A waitlister whose sign-up research ran on the agent route. */
async function agentResearched(name: string, status = "done", steps: Array<{ step: string; status: string; ready_at?: Date }> = []) {
  const id = await seedAthlete(name, { sport: "Golf", status: "waitlisted" } as any);
  const [run] = await db.insert(workflowRuns).values({ athlete_id: id, process: "signup_research", definition_version: 1, active_scope: "signup_research", status, input: { name, sport: "Golf" }, created_by: "signup", started_at: new Date() } as any).returning({ id: workflowRuns.id });
  for (const [i, s] of steps.entries()) await db.insert(workflowSteps).values({ run_id: run.id, ordinal: i, kind: "model", input: {}, ...s } as any);
  return { id, runId: run.id };
}
const runStatus = async (runId: string) => (await db.select({ s: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.s;
const HELD = [{ step: "research_a", status: "ready", ready_at: HELD_READY_AT }, { step: "research_b", status: "ready", ready_at: HELD_READY_AT }];
const MERGED = [{ step: "research_a", status: "done" }, { step: "research_b", status: "done" }, { step: "research_merge", status: "done" }, { step: "mia_preview", status: "running" }];
const requiredOf = async (id: string) => (await db.select({ r: athletes.agent_onboarding_required }).from(athletes).where(eq(athletes.id, id)))[0]?.r;

test("P1: an agent-front sign-up is promoted and notified without a second (legacy) research run", async () => {
  const id = await seedAthlete("Agent Front", { sport: "Golf", status: "waitlisted", agent_onboarding_required: true } as any);
  const r = await promote(id);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: true, status: "active", onboarding: null, refresh: null });
  expect(await statusOf(id)).toBe("active");
  expect(notifyPromotion).toHaveBeenCalledTimes(1);
  expect(startRun).not.toHaveBeenCalled();
});

test("P2: any other waitlisted athlete with a sport still gets today's legacy onboarding run", async () => {
  const id = await seedAthlete("Landing Signup", { sport: "Golf", status: "waitlisted" } as any);
  const r = await promote(id);
  expect(r.status).toBe(200);
  expect(r.json.onboarding).toEqual({ runId: "run-1", created: true });
  expect(startRun).toHaveBeenCalledTimes(1);
  expect(startRun.mock.calls[0][0]).toMatchObject({ process: "onboarding", athleteId: id, createdBy: "admin", idempotencyKey: `onboarding:${id}` });
});

test("P3: an agent-researched waitlister with the agent app front on: no legacy run, marked for the agent onboarding", async () => {
  process.env.AGENT_ONBOARDING = "true";
  const { id, runId } = await agentResearched("Agent Researched");
  const r = await promote(id);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: true, status: "active", onboarding: null, refresh: null, signupResearch: { runId, status: "done", agentFront: true } });
  expect(startRun).not.toHaveBeenCalled();
  expect(await requiredOf(id)).toBe(true);
  expect(notifyPromotion).toHaveBeenCalledTimes(1);
});

test("P4: the same athlete with the agent app front off (rollback): the legacy run starts so the legacy app has research", async () => {
  const { id } = await agentResearched("Rollback Researched");
  const r = await promote(id);
  expect(r.status).toBe(200);
  expect(startRun).toHaveBeenCalledTimes(1);
  expect(startRun.mock.calls[0][0]).toMatchObject({ process: "onboarding", athleteId: id, createdBy: "admin" });
  expect(r.json.signupResearch).toMatchObject({ agentFront: false });
  expect(await requiredOf(id)).toBe(false);
});

test("P5: front on: a held or unmerged sign-up research is canceled at promotion; a merged one is kept for v4", async () => {
  process.env.AGENT_ONBOARDING = "true";
  const held = await agentResearched("Held Researched", "running", HELD);
  let r = await promote(held.id);
  expect(r.json).toMatchObject({ onboarding: null, signupResearch: { runId: held.runId, status: "canceled", agentFront: true } });
  expect(await runStatus(held.runId)).toBe("canceled");
  expect((await db.select({ s: workflowSteps.status }).from(workflowSteps).where(eq(workflowSteps.run_id, held.runId))).map((s) => s.s)).toEqual(["skipped", "skipped"]);

  const researching = await agentResearched("Researching Now", "running", [{ step: "research_a", status: "running" }, { step: "research_b", status: "ready" }]);
  r = await promote(researching.id);
  expect(await runStatus(researching.runId)).toBe("canceled");

  const merged = await agentResearched("Merged Researched", "running", MERGED);
  r = await promote(merged.id);
  expect(r.json.signupResearch).toMatchObject({ status: "running", agentFront: true });
  expect(await runStatus(merged.runId)).toBe("running");                                       // v4 reuses it
  expect(startRun).not.toHaveBeenCalled();
});

test("P6: front off (rollback): any active sign-up research is canceled and the legacy run starts", async () => {
  for (const steps of [HELD, MERGED]) {
    startRun.mockClear();
    const a = await agentResearched(`Rollback ${steps.length}`, "running", steps);
    const r = await promote(a.id);
    expect(r.json.signupResearch).toMatchObject({ status: "canceled", agentFront: false });
    expect(await runStatus(a.runId)).toBe("canceled");
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0][0]).toMatchObject({ process: "onboarding", athleteId: a.id, createdBy: "admin" });
  }
});
