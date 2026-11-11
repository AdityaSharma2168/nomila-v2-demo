/**
 * dealMark.test.ts — her "it's done" and "bring it back" (Mila's deals_mark, run only from her tap), on PGlite:
 *   - completed moves only an agreed deal; anything else is wrong_state and nothing changes
 *   - reopen brings back a deal she said no to (status) or filed (thread), only while its opportunity is open
 *   - each writes ONE reversible receipt marked as hers, and Undo (POST /agent-actions/:id/undo) puts it back
 *   - another athlete's opportunity is not_found
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import agentActionsRouter from "../routes/agentActions";
import { agentActions, deals, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { DEAL_MARKED_KIND, markDeal } from "./dealMark";

let server: Server;
let base: string;
let athleteId: string;
let otherId: string;

async function seed(owner: string, dealStatus: string, threadStatus = "read", oppStatus: "open" | "closed" = "open") {
  const now = new Date();
  const [o] = await db.insert(opportunities).values({
    athlete_id: owner, opened_at: now, last_activity_at: now, status: oppStatus,
    ...(oppStatus === "closed" ? { closed_at: now, close_reason: "declined" } : {}),
  } as any).returning();
  const [d] = await db.insert(deals).values({ athlete_id: owner, brand_name: "Made-up Co", status: dealStatus, source: "inbox_scan", opportunity_id: o.id } as any).returning();
  const [t] = await db.insert(inboxThreads).values({ athlete_id: owner, deal_id: d.id, subject: "Hello", status: threadStatus } as any).returning();
  return { oppId: o.id as string, dealId: d.id as string, threadId: t.id as string };
}
const dealStatus = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0].status;
const threadStatus = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0].status;
const undo = (id: string) => fetch(`${base}/agent-actions/${id}/undo`, { method: "POST" });

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Owner");
  otherId = await seedAthlete("Other");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const app = express();
  app.use(express.json());
  app.use("/", agentActionsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});

test("completed: only an agreed deal; one receipt, hers; Undo puts it back", async () => {
  const s = await seed(athleteId, "accepted");
  const r = await markDeal(athleteId, s.oppId, "completed");
  expect(r.ok).toBe(true);
  expect(await dealStatus(s.dealId)).toBe("completed");
  const [rec] = await db.select().from(agentActions).where(eq(agentActions.deal_id, s.dealId));
  expect(rec).toMatchObject({ action: "reopen", reversible: true });
  expect(rec.payload).toMatchObject({ kind: DEAL_MARKED_KIND, mark: "completed", actor: "athlete", deal_from_status: "accepted", deal_to_status: "completed" });
  expect((await undo(rec.id)).status).toBe(200);
  expect(await dealStatus(s.dealId)).toBe("accepted");

  const n = await seed(athleteId, "negotiating");
  expect(await markDeal(athleteId, n.oppId, "completed")).toMatchObject({ ok: false, error: "wrong_state" });
  expect(await dealStatus(n.dealId)).toBe("negotiating");
});

test("reopen: a no or a filed thread comes back while the opportunity is open; Undo files it again", async () => {
  const s = await seed(athleteId, "rejected", "archived");
  expect((await markDeal(athleteId, s.oppId, "reopen")).ok).toBe(true);
  expect([await dealStatus(s.dealId), await threadStatus(s.threadId)]).toEqual(["pending", "read"]);
  const [rec] = await db.select().from(agentActions).where(eq(agentActions.deal_id, s.dealId));
  expect((await undo(rec.id)).status).toBe(200);
  expect([await dealStatus(s.dealId), await threadStatus(s.threadId)]).toEqual(["rejected", "archived"]);

  const live = await seed(athleteId, "pending");
  expect(await markDeal(athleteId, live.oppId, "reopen")).toMatchObject({ ok: false, error: "wrong_state" });
  const closed = await seed(athleteId, "rejected", "read", "closed");
  expect(await markDeal(athleteId, closed.oppId, "reopen")).toMatchObject({ ok: false, error: "wrong_state" });
});

test("another athlete's opportunity is not_found and nothing moves", async () => {
  const s = await seed(otherId, "accepted");
  expect(await markDeal(athleteId, s.oppId, "completed")).toMatchObject({ ok: false, error: "not_found" });
  expect(await dealStatus(s.dealId)).toBe("accepted");
});
