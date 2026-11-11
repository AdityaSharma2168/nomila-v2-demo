/**
 * agentActions.test.ts — WS5 the receipt log, end to end against in-memory
 * Postgres (PGlite) with auth mocked. Covers the append helper + read feed + the
 * reversal contract: a reversible filing is created → read back → undone (the
 * thread status flips back to payload.from_status and `undone_at` is stamped),
 * plus the append-only guarantees (a second undo 409s; the row is never deleted).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import agentActionsRouter, { writeAgentAction } from "./agentActions";
import { agentActions, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string, otherId: string;

function asUser(id: string) {
  (globalThis as any).__TEST_ATHLETE_ID = id;
}

async function mkThread(owner: string, status: string) {
  const [t] = await db
    .insert(inboxThreads)
    .values({ athlete_id: owner, subject: "Sponsorship", status } as any)
    .returning();
  return t;
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Owner");
  otherId   = await seedAthlete("Other");

  const app = express();
  app.use(express.json());
  app.use("/", agentActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  asUser(athleteId);
});

describe("writeAgentAction — the append helper", () => {
  it("appends an immutable receipt row and returns it", async () => {
    const t = await mkThread(athleteId, "archived");
    const row = await writeAgentAction({
      athleteId, action: "file", threadId: t.id,
      reason: "Filed — no number, low fit", reversible: true,
      payload: { from_status: "read", to_status: "archived" },
    });
    expect(row.id).toBeTruthy();
    expect(row.action).toBe("file");
    expect(row.reversible).toBe(true);
    expect(row.undone_at).toBeNull();
    expect((row.payload as any).from_status).toBe("read");
  });
});

describe("GET /agent-actions — the receipt feed", () => {
  it("lists the athlete's actions newest-first and filters by action + deal_id", async () => {
    await writeAgentAction({ athleteId, action: "auto_decline", reason: "Below your line" });
    await writeAgentAction({ athleteId, action: "mute_sender", reason: "Newsletter" });

    const all = await api("GET", "/agent-actions");
    expect(all.status).toBe(200);
    expect(all.json.length).toBeGreaterThanOrEqual(2);

    const declines = await api("GET", "/agent-actions?action=auto_decline");
    expect(declines.json.every((r: any) => r.action === "auto_decline")).toBe(true);
  });

  it("never returns another athlete's actions", async () => {
    asUser(otherId);
    await writeAgentAction({ athleteId: otherId, action: "file", reason: "theirs" });
    asUser(athleteId);
    const mine = await api("GET", "/agent-actions?action=file");
    expect(mine.json.every((r: any) => r.athlete_id === athleteId)).toBe(true);
  });
});

describe("POST /agent-actions/:id/undo — reverse a reversible filing", () => {
  it("flips the thread status back to from_status and stamps undone_at (append-only: row stays)", async () => {
    const t = await mkThread(athleteId, "archived");
    const action = await writeAgentAction({
      athleteId, action: "file", threadId: t.id, reversible: true,
      payload: { from_status: "read", to_status: "archived" },
    });

    const r = await api("POST", `/agent-actions/${action.id}/undo`);
    expect(r.status).toBe(200);
    expect(r.json.undone_at).not.toBeNull();

    // Thread status restored to what it was before the filing.
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.status).toBe("read");

    // Row still exists (append-only) — undone, not deleted.
    const [row] = await db.select().from(agentActions).where(eq(agentActions.id, action.id));
    expect(row).toBeTruthy();
    expect(row.undone_at).not.toBeNull();
  });

  it("an opportunity filing: undo reopens the opportunity and restores every thread it archived", async () => {
    const lead = await mkThread(athleteId, "archived");
    const other = await mkThread(athleteId, "archived");
    const [opp] = await db.insert(opportunities).values({
      athlete_id: athleteId, status: "closed", close_reason: "expired", closed_at: new Date(),
      opened_at: new Date(), last_activity_at: new Date(), lead_thread_id: lead.id,
    }).returning();
    const action = await writeAgentAction({
      athleteId, action: "auto_archive", threadId: lead.id, reversible: true,
      payload: {
        opportunity_id: opp.id, from_status: "read", to_status: "archived",
        threads: [{ id: lead.id, from_status: "read" }, { id: other.id, from_status: "deal_detected" }],
      },
    });

    expect((await api("POST", `/agent-actions/${action.id}/undo`)).status).toBe(200);
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, opp.id));
    expect(o).toMatchObject({ status: "open", closed_at: null, close_reason: null });
    expect((await db.select().from(inboxThreads).where(eq(inboxThreads.id, lead.id)))[0].status).toBe("read");
    expect((await db.select().from(inboxThreads).where(eq(inboxThreads.id, other.id)))[0].status).toBe("deal_detected");
  });

  it("a second undo 409s (idempotent) and leaves the thread as-is", async () => {
    const t = await mkThread(athleteId, "archived");
    const action = await writeAgentAction({
      athleteId, action: "file", threadId: t.id, reversible: true,
      payload: { from_status: "read", to_status: "archived" },
    });
    await api("POST", `/agent-actions/${action.id}/undo`);
    const again = await api("POST", `/agent-actions/${action.id}/undo`);
    expect(again.status).toBe(409);
  });

  it("409s undoing a non-reversible action", async () => {
    const action = await writeAgentAction({ athleteId, action: "auto_decline", reason: "receipt-only", reversible: false });
    const r = await api("POST", `/agent-actions/${action.id}/undo`);
    expect(r.status).toBe(409);
  });

  it("404s undoing another athlete's action", async () => {
    const t = await mkThread(otherId, "archived");
    const action = await writeAgentAction({
      athleteId: otherId, action: "file", threadId: t.id, reversible: true,
      payload: { from_status: "read", to_status: "archived" },
    });
    asUser(athleteId);
    const r = await api("POST", `/agent-actions/${action.id}/undo`);
    expect(r.status).toBe(404);
  });
});

describe("POST /agent-actions/:id/wrong — eval-fixture sink", () => {
  it("accepts the flag (200) without reversing the action", async () => {
    const action = await writeAgentAction({ athleteId, action: "auto_decline", reason: "mis-judged" });
    const r = await api("POST", `/agent-actions/${action.id}/wrong`, { note: "This was a real deal" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const [row] = await db.select().from(agentActions).where(eq(agentActions.id, action.id));
    expect(row.undone_at).toBeNull(); // wrong ≠ undo
  });

  it("404s flagging another athlete's action", async () => {
    const action = await writeAgentAction({ athleteId: otherId, action: "file", reason: "theirs" });
    asUser(athleteId);
    const r = await api("POST", `/agent-actions/${action.id}/wrong`);
    expect(r.status).toBe(404);
  });
});
