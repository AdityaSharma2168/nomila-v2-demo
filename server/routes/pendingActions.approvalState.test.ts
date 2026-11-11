/**
 * pendingActions.approvalState.test.ts — agent_runs.approval_state (0144) through the real approve / dismiss routes on
 * PGlite: the run that queued cards goes awaiting_approval → resumed (while the approved tool runs) → completed when
 * every card is settled; all declined → cancelled; an approved action that fails → failed; a card still waiting keeps
 * the run awaiting_approval; an expired card does not. The run's own `status` never changes. The registry is a test
 * registry; nothing leaves the process.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/integrations/gmail", () => ({ fetchMessageThreadingInfo: jest.fn(), sendGmailReply: jest.fn() }));
jest.mock("../lib/integrations/instagram", () => ({ sendInstagramDM: jest.fn() }));
jest.mock("../skills/threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null), updateMechanicalThreadState: jest.fn(async () => undefined) }));
jest.mock("../services/push/events", () => ({ pushWaiting: jest.fn() }));

/** What the run's approval_state was while the approved tool ran. */
const seenWhileRunning: Array<string | null> = [];
jest.mock("../agent/coreTools", () => {
  const { z } = require("zod");
  const { ToolRegistry } = require("../agent/tools");
  const reg = new ToolRegistry()
    .register({ name: "do_it", description: "d", kind: "ours", permission: "act", args: z.object({ runId: z.string() }),
      approval: { verb: "other_act", title: () => "Do it", summary: () => "Does it" },
      execute: async (_ctx: any, args: any) => {
        const { db } = require("../testUtils/pgliteDb");
        const { agentRuns } = require("../../shared/schema");
        const { eq } = require("drizzle-orm");
        const [r] = await db.select({ s: agentRuns.approval_state }).from(agentRuns).where(eq(agentRuns.id, args.runId));
        seenWhileRunning.push(r?.s ?? null);
        return { done: true };
      } })
    .register({ name: "always_fails", description: "d", kind: "ours", permission: "act", args: z.object({}),
      approval: { verb: "other_act", title: () => "Fail", summary: () => "Fails" },
      execute: async () => { throw new Error("provider down"); } });
  return { defaultRegistry: () => reg };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import pendingActionsRouter from "./pendingActions";
import { agentRuns, pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { queueApproval, settleRunApproval } from "../agent/approvals";
import { defaultRegistry } from "../agent/coreTools";

let server: Server;
let base: string;
let athleteId: string;

const post = async (path: string) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { status: res.status, json: await res.json() };
};

/** A finished turn that queued cards: status completed, approval_state awaiting_approval (what a Mila turn writes). */
async function runWithCards(cards: Array<{ tool: "do_it" | "always_fails" }>): Promise<{ runId: string; ids: string[] }> {
  const [run] = await db.insert(agentRuns).values({
    athlete_id: athleteId, skill_id: "chat", skill_version: "x", trigger: "chat", provider: "trueforge", model: "m", effort: "low",
    status: "completed", ended_at: new Date(), approval_state: "awaiting_approval",
  }).returning({ id: agentRuns.id });
  const ids: string[] = [];
  for (const c of cards) {
    const item = await queueApproval({ athleteId, runId: run.id, skillId: "test/skill" }, defaultRegistry().get(c.tool)!, c.tool === "do_it" ? { runId: run.id } : {});
    ids.push(item.id);
  }
  return { runId: run.id, ids };
}
const runRow = async (runId: string) => (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0];

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Approval State Owner");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const app = express();
  app.use(express.json());
  app.use("/", pendingActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { seenWhileRunning.length = 0; });

test("approve: resumed while the tool runs, completed after; the run's status is untouched", async () => {
  const { runId, ids } = await runWithCards([{ tool: "do_it" }]);
  expect((await post(`/pending-actions/${ids[0]}/approve`)).status).toBe(200);
  expect(seenWhileRunning).toEqual(["resumed"]);
  expect(await runRow(runId)).toMatchObject({ status: "completed", approval_state: "completed" });
});

test("two cards: one approved keeps the run awaiting the other; declining the other completes it", async () => {
  const { runId, ids } = await runWithCards([{ tool: "do_it" }, { tool: "do_it" }]);
  await post(`/pending-actions/${ids[0]}/approve`);
  expect((await runRow(runId)).approval_state).toBe("awaiting_approval");
  expect((await post(`/pending-actions/${ids[1]}/dismiss`)).status).toBe(200);
  expect((await runRow(runId)).approval_state).toBe("completed");
});

test("every card declined: cancelled", async () => {
  const { runId, ids } = await runWithCards([{ tool: "do_it" }, { tool: "do_it" }]);
  await post(`/pending-actions/${ids[0]}/dismiss`);
  expect((await runRow(runId)).approval_state).toBe("awaiting_approval");
  await post(`/pending-actions/${ids[1]}/dismiss`);
  expect(await runRow(runId)).toMatchObject({ status: "completed", approval_state: "cancelled" });
});

test("an approved action that fails: failed", async () => {
  const { runId, ids } = await runWithCards([{ tool: "always_fails" }]);
  expect((await post(`/pending-actions/${ids[0]}/approve`)).status).toBe(502);
  expect((await runRow(runId)).approval_state).toBe("failed");
});

test("an expired card no longer keeps the run waiting", async () => {
  const { runId, ids } = await runWithCards([{ tool: "do_it" }, { tool: "do_it" }]);
  await db.update(pendingActions).set({ expires_at: new Date(Date.now() - 1000) }).where(eq(pendingActions.id, ids[1]));
  await post(`/pending-actions/${ids[0]}/dismiss`);
  expect((await runRow(runId)).approval_state).toBe("cancelled");
});

test("settle leaves a run with no cards (or no run id) alone", async () => {
  const [run] = await db.insert(agentRuns).values({
    athlete_id: athleteId, skill_id: "chat", skill_version: "x", trigger: "chat", provider: "trueforge", model: "m", effort: "low",
    status: "completed", ended_at: new Date(),
  }).returning({ id: agentRuns.id });
  expect(await settleRunApproval(athleteId, run.id)).toBeNull();
  expect((await runRow(run.id)).approval_state).toBeNull();
  expect(await settleRunApproval(athleteId, null)).toBeNull();
  expect(await settleRunApproval(athleteId, "not-a-uuid")).toBeNull();
});

test("the database refuses an unknown approval state", async () => {
  const { runId } = await runWithCards([]);
  await expect(db.update(agentRuns).set({ approval_state: "waiting" }).where(eq(agentRuns.id, runId))).rejects.toThrow();
});
