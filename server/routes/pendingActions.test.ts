/**
 * pendingActions.test.ts — the co-pilot lifecycle (WS3 §3.6), end to end against
 * in-memory Postgres (PGlite) with Gmail/auth/summarizer mocked (same harness as
 * inbox.reply.test.ts). Covers create → approve → dismiss state transitions, the
 * at-most-once approve guarantee, ownership, and validation.
 *
 * The key co-pilot invariant under test: CREATING a pending action never sends —
 * only APPROVE does, and it sends through the same reply path as a manual reply.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/integrations/gmail", () => ({
  fetchMessageThreadingInfo: jest.fn(),
  sendGmailReply:            jest.fn(),
}));
jest.mock("../lib/integrations/instagram", () => ({
  sendInstagramDM: jest.fn(),
}));
jest.mock("../skills/threadSummarizer", () => ({
  summarizeThread:              jest.fn(async () => null),
  updateMechanicalThreadState:  jest.fn(async () => undefined),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import pendingActionsRouter from "./pendingActions";
import { sendGmailReply } from "../lib/integrations/gmail";
import { deals, inboxThreads, inboxMessages, pendingActions, connectedAccounts, agentActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { bodySha256 } from "../../shared/bodyHash";
import { createHash } from "node:crypto";

const sendMock = sendGmailReply as jest.Mock;
let sentSeq = 0;
let fixtureSeq = 0;

let server: Server;
let base: string;

let athleteId: string, otherAthleteId: string, inbox: string;

function asUser(id: string) {
  (globalThis as any).__TEST_ATHLETE_ID = id;
}

/** Seed a deal + its thread + one inbound gmail message ready to reply to. */
async function seedDeal(owner: string, over: { connected?: string } = {}) {
  const [deal] = await db
    .insert(deals)
    .values({ athlete_id: owner, brand_name: "Acme", status: "detected" } as any)
    .returning();
  const [thread] = await db
    .insert(inboxThreads)
    .values({
      athlete_id:           owner,
      subject:              "Sponsorship",
      deal_id:              deal.id,
      connected_account_id: over.connected ?? inbox,
    } as any)
    .returning();
  await db.insert(inboxMessages).values({
    thread_id:               thread.id,
    athlete_id:              owner,
    direction:               "inbound",
    sender_email:            "brand@acme.com",
    subject:                 "Sponsorship",
    body:                    "Want to work together?",
    platform:                "gmail",
    connected_account_id:    over.connected ?? inbox,
    gmail_thread_id:         "gt-1",
    gmail_message_id_header: `<orig-${++fixtureSeq}@acme>`,
    received_at:             new Date(Date.UTC(2026, 0, 1)),
  } as any);
  return { dealId: deal.id, threadId: thread.id };
}

/** A deal on its OWN fresh inbox. The failed-send test flags the shared `inbox` as
 *  needing reconnect, so tests that must actually send after it use their own. */
async function seedSendableDeal() {
  const connected = await seedConnection({ athleteId, email: `fresh-${++fixtureSeq}@gmail.com` });
  return seedDeal(athleteId, { connected });
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
  athleteId      = await seedAthlete("Deal Owner");
  otherAthleteId = await seedAthlete("Someone Else");
  inbox          = await seedConnection({ athleteId, email: "me@gmail.com" });

  const app = express();
  app.use(express.json());
  app.use("/", pendingActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Gmail assigns a DISTINCT Message-ID to every message it sends. A constant here
  // made two sends in one suite collide on inbox_messages_athlete_msgid_uniq.
  sendMock.mockImplementation(async () => `<sent-${++sentSeq}@mail.gmail.com>`);
  asUser(athleteId);
});

describe("create — Mila proposes, nothing sends", () => {
  it("creates a pending action in 'pending' and does NOT send", async () => {
    const { dealId, threadId } = await seedDeal(athleteId);

    const r = await api("POST", `/deals/${dealId}/pending-actions`, {
      kind: "send_reply",
      payload: { body: "Thanks — excited to chat!", reply_intent: "accept" },
    });

    expect(r.status).toBe(201);
    expect(r.json.status).toBe("pending");
    expect(r.json.kind).toBe("send_reply");
    expect(r.json.thread_id).toBe(threadId); // resolved from the deal
    expect(r.json.approved_at).toBeNull();
    expect(sendMock).not.toHaveBeenCalled(); // ← the co-pilot invariant
  });

  it("400s on an unknown kind", async () => {
    const { dealId } = await seedDeal(athleteId);
    const r = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "launch_missiles", payload: {} });
    expect(r.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("400s on a send_reply with no body", async () => {
    const { dealId } = await seedDeal(athleteId);
    const r = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { reply_intent: "accept" } });
    expect(r.status).toBe(400);
  });

  it("404s when creating on another athlete's deal", async () => {
    const { dealId } = await seedDeal(otherAthleteId);
    asUser(athleteId);
    const r = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "hi" } });
    expect(r.status).toBe(404);
  });
});

describe("approve — the only path that executes", () => {
  it("approve → sends through the real reply path once, records outbound, marks approved", async () => {
    const { dealId, threadId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "Let's do it!" } });
    expect(sendMock).not.toHaveBeenCalled();

    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Let's do it!") });

    expect(r.status).toBe(200);
    expect(r.json.status).toBe("approved");
    expect(r.json.result).toEqual({ sent: true });
    expect(r.json.approved_at).not.toBeNull();
    expect(r.json.executed_at).not.toBeNull();

    // Sent exactly once, through the reply service.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ connectionId: inbox, toEmail: "brand@acme.com", body: "Let's do it!" });

    // Outbound message recorded on the thread.
    const outbound = await db
      .select()
      .from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe("Let's do it!");
  });

  it("re-approving an already-approved action 409s and does not send again (at-most-once)", async () => {
    const { dealId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "Once only" } });
    await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Once only") });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const again = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Once only") });
    expect(again.status).toBe(409);
    expect(sendMock).toHaveBeenCalledTimes(1); // no second send
  });

  it("a failed send marks the action 'failed' (terminal) and surfaces the error", async () => {
    const { dealId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "will fail" } });

    sendMock.mockRejectedValueOnce(new Error("Google token refresh failed: invalid_grant"));
    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("will fail") });

    expect(r.status).toBe(401);
    expect(r.json.code).toBe("RECONNECT_REQUIRED");
    expect(r.json.legacy_code).toBe("REAUTH_REQUIRED");
    expect(r.json.inbox?.connection_id).toEqual(expect.any(String));
    expect(r.json.pending_action.status).toBe("failed");
    expect(r.json.pending_action.error).toMatch(/expired/i);

    // Terminal: it can't be approved again.
    const retry = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("will fail") });
    expect(retry.status).toBe(409);
  });

  it("404s approving another athlete's action", async () => {
    const { dealId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "hi" } });
    asUser(otherAthleteId);
    const r = await api("POST", `/pending-actions/${created.json.id}/approve`);
    expect(r.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("409s approving an expired action, without sending", async () => {
    const { dealId, threadId } = await seedDeal(athleteId);
    const [pa] = await db
      .insert(pendingActions)
      .values({
        athlete_id: athleteId, deal_id: dealId, thread_id: threadId,
        kind: "send_reply", status: "pending", payload: { body: "too late" },
        expires_at: new Date(Date.now() - 1000),
      } as any)
      .returning();

    const r = await api("POST", `/pending-actions/${pa.id}/approve`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/expired/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("two CONCURRENT approves of one proposal send exactly once (the claim is conditional)", async () => {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "Exactly once" } });

    // Hold the provider send open so both requests are in flight at the same time —
    // the old read-then-send-then-update shape let both through here.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sendMock.mockImplementation(async () => { await gate; return `<sent-${++sentSeq}@mail.gmail.com>`; });

    const a = api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Exactly once") });
    const b = api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Exactly once") });
    // Let both reach the claim before the winner's send settles.
    await new Promise((r) => setTimeout(r, 200));
    release();
    const results = await Promise.all([a, b]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, created.json.id));
    expect(row.status).toBe("approved");
    expect(row.executed_at).not.toBeNull();
  });

  it("an approved row that is mid-send cannot be approved again", async () => {
    const { dealId, threadId } = await seedSendableDeal();
    // The state a claimed-but-unsettled row is in: approved, executed_at still null.
    const [pa] = await db
      .insert(pendingActions)
      .values({
        athlete_id: athleteId, deal_id: dealId, thread_id: threadId,
        kind: "send_reply", status: "approved", approved_at: new Date(), payload: { body: "in flight" },
      } as any)
      .returning();
    const r = await api("POST", `/pending-actions/${pa.id}/approve`);
    expect(r.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("approve — body_sha256: the approved body is the sent body", () => {
  it("a matching hash sends", async () => {
    const { dealId } = await seedSendableDeal();
    const body = "Café — 5 posts, $1,200 ✨\nThanks!";
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body } });

    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256(body) });

    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ body });
  });

  it("the shared hash equals Node's sha256 over the UTF-8 bytes", () => {
    for (const s of ["", "hi", "Café — 5 posts ✨ 🏆", "line1\r\nline2  ", "\uD800 lone"]) {
      expect(bodySha256(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("a mismatched hash is refused with 409, sends nothing and leaves the row pending", async () => {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "What is stored" } });

    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("What the screen showed") });

    expect(r.status).toBe(409);
    expect(r.json.code).toBe("BODY_MISMATCH");
    expect(sendMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, created.json.id));
    expect(row.status).toBe("pending");
    expect(row.approved_at).toBeNull();
  });

  it("whitespace differences count — no normalisation beyond the stored payload", async () => {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "Hello there" } });
    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Hello there ") });
    expect(r.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a non-string hash is refused", async () => {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "x" } });
    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: 42 });
    expect(r.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a MISSING hash is refused (400 BODY_HASH_REQUIRED): nothing sends, the row stays pending", async () => {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "Old build" } });
    for (const body of [undefined, { body_sha256: null }, { body_sha256: "" }]) {
      const r = await api("POST", `/pending-actions/${created.json.id}/approve`, body as any);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("BODY_HASH_REQUIRED");
    }
    expect(sendMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, created.json.id));
    expect(row.status).toBe("pending");
  });
});

describe("approve — ask-terms batch rows need a per-message review", () => {
  /** A proposal marked the way askTerms.ts marks its batch rows. */
  async function proposeBatchRow(body: string) {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, {
      kind:    "send_reply",
      payload: { body, reply_intent: "request_terms", source: "ask_terms_batch", segment: "fresh" },
    });
    return created.json.id as string;
  }

  it("refuses an unreviewed batch approve with 409 NOT_REVIEWED, sends nothing, leaves the row pending", async () => {
    const body = "Could you share the budget and timeline?";
    const id = await proposeBatchRow(body);

    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256(body) });

    expect(r.status).toBe(409);
    expect(r.json.code).toBe("NOT_REVIEWED");
    expect(sendMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, id));
    expect(row.status).toBe("pending");
    expect((row.payload as any).reviewed_at).toBeUndefined();
  });

  it("refuses reviewed values other than literal true", async () => {
    const body = "Budget?";
    const id = await proposeBatchRow(body);
    for (const reviewed of ["true", 1, false, null]) {
      const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256(body), reviewed });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("NOT_REVIEWED");
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a reviewed batch approve sends and records payload.reviewed_at, keeping the rest of the payload", async () => {
    const body = "Could you share the deliverables?";
    const id = await proposeBatchRow(body);

    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256(body), reviewed: true });

    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ body });
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, id));
    const payload = row.payload as any;
    expect(typeof payload.reviewed_at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.reviewed_at))).toBe(false);
    expect(payload).toMatchObject({ body, source: "ask_terms_batch", reply_intent: "request_terms", segment: "fresh" });
  });

  it("stays narrow: a non-batch row approves without reviewed and gets no reviewed_at", async () => {
    const { dealId } = await seedSendableDeal();
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "Sounds good" } });

    const r = await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("Sounds good") });

    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((r.json.payload as any).reviewed_at).toBeUndefined();
  });
});

describe("dismiss — cancels a proposal", () => {
  it("dismiss → 'dismissed', never sends", async () => {
    const { dealId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "nope" } });

    const r = await api("POST", `/pending-actions/${created.json.id}/dismiss`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("dismissed");
    expect(r.json.dismissed_at).not.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("approving a dismissed action 409s and never sends", async () => {
    const { dealId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "nope" } });
    await api("POST", `/pending-actions/${created.json.id}/dismiss`);

    const r = await api("POST", `/pending-actions/${created.json.id}/approve`);
    expect(r.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("dismissing an already-approved action 409s", async () => {
    const { dealId } = await seedDeal(athleteId);
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "done" } });
    await api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256("done") });

    const r = await api("POST", `/pending-actions/${created.json.id}/dismiss`);
    expect(r.status).toBe(409);
  });
});

describe("list — the co-pilot queue", () => {
  it("lists the athlete's actions and filters by status", async () => {
    const { dealId } = await seedDeal(athleteId);
    const a = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "keep pending" } });
    const b = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "to dismiss" } });
    await api("POST", `/pending-actions/${b.json.id}/dismiss`);

    const pending = await api("GET", `/pending-actions?status=pending&deal_id=${dealId}`);
    expect(pending.status).toBe(200);
    const ids = pending.json.map((r: any) => r.id);
    expect(ids).toContain(a.json.id);
    expect(ids).not.toContain(b.json.id);
  });

  it("never returns another athlete's actions", async () => {
    const { dealId } = await seedDeal(otherAthleteId);
    asUser(otherAthleteId);
    await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "theirs" } });

    asUser(athleteId);
    const mine = await api("GET", `/pending-actions?deal_id=${dealId}`);
    expect(mine.json).toEqual([]);
  });
});

describe("propose — the one reply thread (12 Oct 2026)", () => {
  it("refuses a thread_id that is hers but belongs to another deal (no quoting A, sending on B)", async () => {
    const a = await seedDeal(athleteId);
    const b = await seedDeal(athleteId);
    const r = await api("POST", `/deals/${a.dealId}/pending-actions`, {
      kind: "send_reply", thread_id: b.threadId, payload: { body: "wrong thread" },
    });
    expect(r.status).toBe(404);
    const ok = await api("POST", `/deals/${a.dealId}/pending-actions`, {
      kind: "send_reply", thread_id: a.threadId, payload: { body: "right thread" },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.thread_id).toBe(a.threadId);
  });
});

describe("D4 — an approved accept moves the deal to Agreed, with Undo (DEALS_AGREE_ON_ACCEPT, retired 2 Nov 2026)", () => {
  let undoBase: string;
  let undoServer: Server;
  beforeAll(async () => {
    const { default: agentActionsRouter } = await import("./agentActions");
    const app = express();
    app.use(express.json());
    app.use("/", agentActionsRouter);
    await new Promise<void>((r) => { undoServer = app.listen(0, r); });
    undoBase = `http://127.0.0.1:${(undoServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => undoServer.close(() => r())); });

  const status = async (dealId: string) => (await db.select().from(deals).where(eq(deals.id, dealId)))[0].status;
  const send = async (dealId: string, payload: Record<string, unknown>) => {
    const created = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload });
    return api("POST", `/pending-actions/${created.json.id}/approve`, { body_sha256: bodySha256(String(payload.body)) });
  };

  it("an accept reply sent → Agreed + one receipt marked hers; Undo puts the status back", async () => {
    const { dealId } = await seedSendableDeal();
    const r = await send(dealId, { body: "Yes — let's do it!", reply_intent: "accept_terms" });
    expect(r.status).toBe(200);
    expect(r.json.deal_agreed).toBe(true);
    expect(await status(dealId)).toBe("accepted");
    const [receipt] = await db.select().from(agentActions).where(eq(agentActions.deal_id, dealId));
    expect(receipt).toMatchObject({ action: "reopen", reversible: true });
    expect(receipt.payload).toMatchObject({ kind: "deal_agreed", actor: "athlete", deal_from_status: "detected", deal_to_status: "accepted" });

    const u = await fetch(`${undoBase}/agent-actions/${receipt.id}/undo`, { method: "POST" });
    expect(u.status).toBe(200);
    expect(await status(dealId)).toBe("detected");
  });

  it("no intent on the payload: the saved draft's intent counts only when the body is exactly that draft", async () => {
    const { dealId, threadId } = await seedSendableDeal();
    await db.update(inboxThreads).set({ latest_draft: { body: "Sounds great, send the contract.", reply_intent: "accept" } as any }).where(eq(inboxThreads.id, threadId));
    await send(dealId, { body: "Sounds great, but can we talk rate first?" });       // edited: says nothing
    expect(await status(dealId)).toBe("detected");
    // (A successful send clears the saved draft; she drafts again.)
    await db.update(inboxThreads).set({ latest_draft: { body: "Sounds great, send the contract.", reply_intent: "accept" } as any }).where(eq(inboxThreads.id, threadId));
    await send(dealId, { body: "Sounds great, send the contract." });                 // exactly the accept draft
    expect(await status(dealId)).toBe("accepted");
  });

  it("Undo never writes a stale status: a deal that moved on past Agreed stays where it is", async () => {
    const { dealId } = await seedSendableDeal();
    await send(dealId, { body: "Yes, count me in!", reply_intent: "accept_terms" });
    expect(await status(dealId)).toBe("accepted");
    await db.update(deals).set({ status: "completed" }).where(eq(deals.id, dealId));
    const [receipt] = await db.select().from(agentActions).where(eq(agentActions.deal_id, dealId));
    const u = await fetch(`${undoBase}/agent-actions/${receipt.id}/undo`, { method: "POST" });
    expect(u.status).toBe(200);
    expect(await status(dealId)).toBe("completed");
  });

  it("a decline, a failed send, or the flag off never moves the deal", async () => {
    const a = await seedSendableDeal();
    await send(a.dealId, { body: "Thanks, but I'll pass.", reply_intent: "decline" });
    expect(await status(a.dealId)).toBe("detected");

    const b = await seedSendableDeal();
    sendMock.mockRejectedValueOnce(new Error("Google token refresh failed: invalid_grant"));
    await send(b.dealId, { body: "Yes!", reply_intent: "accept_terms" });
    expect(await status(b.dealId)).toBe("detected");
  });
});

describe("propose — the draft's own thread wins (12 Oct 2026, #979 review)", () => {
  it("a body that is exactly the draft saved on thread B goes out on B, even when the screen passes thread A", async () => {
    const a = await seedDeal(athleteId);
    // A second thread on the SAME deal, holding the saved draft.
    const [b] = await db.insert(inboxThreads).values({
      athlete_id: athleteId, subject: "Contract", deal_id: a.dealId, connected_account_id: inbox,
      latest_draft: { body: "Hi Sam,\n\nLooks great — send the contract.\n\nBest,\nJ", reply_intent: "accept" },
    } as any).returning();
    const r = await api("POST", `/deals/${a.dealId}/pending-actions`, {
      kind: "send_reply", thread_id: a.threadId, payload: { body: "Hi Sam,\n\nLooks great — send the contract.\n\nBest,\nJ" },
    });
    expect(r.status).toBe(201);
    expect(r.json.thread_id).toBe(b.id);

    // An edited body matches no saved draft: the screen's thread (hers, this deal's) is used.
    const edited = await api("POST", `/deals/${a.dealId}/pending-actions`, {
      kind: "send_reply", thread_id: a.threadId, payload: { body: "Edited reply" },
    });
    expect(edited.json.thread_id).toBe(a.threadId);
  });
});

describe("approve — a reply Mila drafted re-checks Draft replies at the tap (#1225 review)", () => {
  const savedWelcome = process.env.MILA_WELCOME;
  afterEach(() => { if (savedWelcome === undefined) delete process.env.MILA_WELCOME; else process.env.MILA_WELCOME = savedWelcome; jest.restoreAllMocks(); });

  async function milaDraft(body: string, draftedBy: string | null = "mila") {
    const { dealId, threadId } = await seedSendableDeal();
    const [row] = await db.insert(pendingActions).values({
      athlete_id: athleteId, deal_id: dealId, thread_id: threadId, kind: "send_reply", status: "pending",
      payload: { body, reply_intent: "accept", ...(draftedBy ? { source: "mila_chat", drafted_by: draftedBy } : {}) },
    } as any).returning();
    return row.id as string;
  }
  const rowOf = async (id: string) => (await db.select().from(pendingActions).where(eq(pendingActions.id, id)))[0];

  it("Draft replies off at the tap: declined with the reason in plain words, nothing sent", async () => {
    process.env.MILA_WELCOME = "true";
    const id = await milaDraft("Sounds great!");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Sounds great!") });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "capability_off", pending_action: { id, status: "dismissed" } });
    expect(r.json.error).toBe("Draft replies to brands is turned off now, so this was not done. Turn it on in Me if you still want it.");
    expect(sendMock).not.toHaveBeenCalled();
    expect(await rowOf(id)).toMatchObject({ status: "dismissed", approved_at: null, executed_at: null });
  });

  it("a failed check refuses without declining, so she can tap again", async () => {
    process.env.MILA_WELCOME = "true";
    const toolGate = require("../agent/welcome/toolGate");
    jest.spyOn(toolGate, "tapRefusal").mockRejectedValue(new Error("db down"));
    const id = await milaDraft("Try me");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Try me") });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("check_failed");
    expect(sendMock).not.toHaveBeenCalled();
    expect((await rowOf(id)).status).toBe("pending");
  });

  it("her own reply (not Mila's draft) is not gated", async () => {
    process.env.MILA_WELCOME = "true";
    const id = await milaDraft("My own words", null);
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("My own words") });
    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("MILA_WELCOME off: Mila's draft sends as before", async () => {
    delete process.env.MILA_WELCOME;
    const id = await milaDraft("As before");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("As before") });
    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("Draft replies still on at the tap: Mila's draft sends, once", async () => {
    process.env.MILA_WELCOME = "true";
    const { turnOnFromCard } = await import("../agent/welcome/turnOn");
    const mailbox = await seedConnection({ athleteId, platform: "gmail", email: `drafts-on-${++fixtureSeq}@example.org` } as any);
    expect(await turnOnFromCard({ athleteId, key: "draft_replies", accountRef: mailbox, consentVersion: "draft_replies/2" })).toMatchObject({ ok: true });
    const id = await milaDraft("Still on");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Still on") });
    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
