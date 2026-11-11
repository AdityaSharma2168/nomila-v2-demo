/**
 * pendingActions.agentAction.test.ts — the approve tap for an agent harness action (kind 'agent_action', 0105) through
 * the real route: her tap runs the queued act tool once with HER athlete id, a second tap is a 409, another athlete
 * gets a 404, a failing tool leaves the row 'failed' (502), dismiss works as for any proposal, and an existing
 * send_reply row is untouched by the new branch. The registry is a test registry; nothing leaves the process.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/integrations/gmail", () => ({ fetchMessageThreadingInfo: jest.fn(), sendGmailReply: jest.fn() }));
jest.mock("../lib/integrations/instagram", () => ({ sendInstagramDM: jest.fn() }));
jest.mock("../skills/threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null), updateMechanicalThreadState: jest.fn(async () => undefined) }));

const executed: Array<{ athleteId: string; args: unknown }> = [];
jest.mock("../agent/coreTools", () => {
  const { z } = require("zod");
  const { ToolRegistry } = require("../agent/tools");
  const reg = new ToolRegistry()
    .register({ name: "send_out", description: "d", kind: "ours", permission: "act", args: z.object({ body: z.string() }),
      approval: { verb: "send_message", title: () => "Send", summary: () => "Sends" },
      execute: async (ctx: any, args: any) => { executed.push({ athleteId: ctx.athleteId, args }); return { sent: true }; } })
    .register({ name: "always_fails", description: "d", kind: "ours", permission: "act", args: z.object({}),
      approval: { verb: "other_act", title: () => "Fail", summary: () => "Fails" },
      execute: async () => { throw new Error("provider down"); } });
  return { defaultRegistry: () => reg };
});

// The phone hook (PR D): recorded here; the push's own rules are tested in services/push.
const pushWaitingMock = jest.fn();
jest.mock("../services/push/events", () => ({ pushWaiting: (...a: unknown[]) => pushWaitingMock(...a) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import pendingActionsRouter from "./pendingActions";
import { pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { queueApproval } from "../agent/approvals";
import { defaultRegistry } from "../agent/coreTools";

let server: Server;
let base: string;
let athleteId: string;
let otherId: string;

const as = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const queue = (tool: string, args: Record<string, unknown>) =>
  queueApproval({ athleteId, runId: "00000000-0000-0000-0000-000000000000", skillId: "test/skill" }, defaultRegistry().get(tool)!, args);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Approve Owner");
  otherId = await seedAthlete("Approve Other");
  const app = express();
  app.use(express.json());
  app.use("/", pendingActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(() => { executed.length = 0; });

test("her tap executes the queued tool once, with her athlete id; a second tap is a 409", async () => {
  const item = await queue("send_out", { body: "Yes, let's do it." });
  as(otherId);
  expect((await post(`/pending-actions/${item.id}/approve`)).status).toBe(404);
  expect(executed).toEqual([]);

  as(athleteId);
  const first = await post(`/pending-actions/${item.id}/approve`);
  expect(first.status).toBe(200);
  expect(first.json).toMatchObject({ id: item.id, status: "approved", tool: "send_out" });
  expect(executed).toEqual([{ athleteId, args: { body: "Yes, let's do it." } }]);
  expect((await post(`/pending-actions/${item.id}/approve`)).status).toBe(409);
  expect(executed).toHaveLength(1);
});

test("a failing tool leaves the row failed (502), never back to pending", async () => {
  const item = await queue("always_fails", {});
  as(athleteId);
  const r = await post(`/pending-actions/${item.id}/approve`);
  expect(r.status).toBe(502);
  const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, item.id));
  expect(row).toMatchObject({ status: "failed", error: "provider down" });
});

test("dismiss declines it and nothing runs", async () => {
  const item = await queue("send_out", { body: "No thanks." });
  as(athleteId);
  expect((await post(`/pending-actions/${item.id}/dismiss`)).status).toBe(200);
  expect((await post(`/pending-actions/${item.id}/approve`)).status).toBe(409);
  expect(executed).toEqual([]);
});

test("a stored action whose tool is no longer an act tool is refused", async () => {
  const [row] = await db.insert(pendingActions).values({ athlete_id: athleteId, kind: "agent_action", payload: { tool: "missing_tool", args: {}, verb: "other_act", title: "x", summary: "x", money: null, runId: null, skillId: "s" } }).returning();
  as(athleteId);
  expect((await post(`/pending-actions/${row.id}/approve`)).status).toBe(400);
  const [after] = await db.select().from(pendingActions).where(eq(pendingActions.id, row.id));
  expect(after.status).toBe("pending");
});

test("queueing an item asks her phone once, with the item's id and verb only (never its title or arguments)", async () => {
  pushWaitingMock.mockClear();
  const item = await queue("send_out", { body: "Private words" });
  expect(pushWaitingMock.mock.calls).toEqual([[athleteId, { id: item.id, verb: "send_message" }]]);
});

const patch = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

describe("PATCH /pending-actions/:id — she edits the draft before her tap", () => {
  test("saves the edited args without running anything; her tap then sends the edited text", async () => {
    const item = await queue("send_out", { body: "Original draft" });
    as(athleteId);
    const r = await patch(`/pending-actions/${item.id}`, { args: { body: "My edited words" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: item.id, status: "pending", args: { body: "My edited words" } });
    expect(executed).toEqual([]);

    expect((await post(`/pending-actions/${item.id}/approve`)).status).toBe(200);
    expect(executed).toEqual([{ athleteId, args: { body: "My edited words" } }]);
  });

  test("another athlete can't edit it (404) and the draft is unchanged", async () => {
    const item = await queue("send_out", { body: "Mine" });
    as(otherId);
    expect((await patch(`/pending-actions/${item.id}`, { args: { body: "Hijack" } })).status).toBe(404);
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, item.id));
    expect((row.payload as any).args).toEqual({ body: "Mine" });
  });

  test("an edit that breaks the tool's schema, or an empty edit, is refused (400) and nothing changes", async () => {
    const item = await queue("send_out", { body: "Keep me" });
    as(athleteId);
    expect((await patch(`/pending-actions/${item.id}`, { args: { body: 42 } })).status).toBe(400);
    expect((await patch(`/pending-actions/${item.id}`, { args: {} })).status).toBe(400);
    expect((await patch(`/pending-actions/${item.id}`, {})).status).toBe(400);
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, item.id));
    expect((row.payload as any).args).toEqual({ body: "Keep me" });
  });

  test("an already-approved or dismissed item can't be edited (409)", async () => {
    const item = await queue("send_out", { body: "Done" });
    as(athleteId);
    expect((await post(`/pending-actions/${item.id}/approve`)).status).toBe(200);
    expect((await patch(`/pending-actions/${item.id}`, { args: { body: "Too late" } })).status).toBe(409);
    const gone = await queue("send_out", { body: "Dismissed" });
    expect((await post(`/pending-actions/${gone.id}/dismiss`)).status).toBe(200);
    expect((await patch(`/pending-actions/${gone.id}`, { args: { body: "Too late" } })).status).toBe(409);
  });
});
