/**
 * deals dispose route — the athlete saying what a deal actually IS.
 *
 * This is the only ground truth in the system: a reply is as often a polite decline as it
 * is interest, and an advanced status can be the summarizer's own doing. So the three
 * dispositions have to stay distinguishable all the way down, and each one has a different
 * consequence that these tests pin:
 *
 *   not_a_deal      we were WRONG to surface it   → thread archived, evidence against the sender
 *   not_interested  we were RIGHT, wrong fit      → status rejected, thread left alone
 *   expired         we were RIGHT, too LATE       → thread archived, status untouched
 *
 * The failure this guards against is quiet: collapsing `expired` into either of the others
 * records the opposite of what happened, on the one signal the pipeline cannot manufacture.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import dealsRouter from "./deals";
import { deals, inboxThreads, agentActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;

async function seedDealThread(status = "detected") {
  const [d] = await db
    .insert(deals)
    .values({ athlete_id: athleteId, brand_name: "Acme", status, source: "inbox_scan" } as any)
    .returning();
  const [t] = await db
    .insert(inboxThreads)
    .values({ athlete_id: athleteId, deal_id: d.id, subject: "Acme", status: "read" } as any)
    .returning();
  return { dealId: d.id as string, threadId: t.id as string };
}

async function dispose(dealId: string, disposition: string) {
  return fetch(`${base}/deals/${dealId}/dispose`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ disposition }),
  });
}

const dealRow   = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0];
const threadRow = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0];
const labelFor  = async (dealId: string) =>
  (await db.select().from(agentActions).where(eq(agentActions.deal_id, dealId)))
    .map((a: any) => a.payload?.athlete_label)
    .filter(Boolean);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Owner");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const app = express();
  app.use(express.json());
  app.use("/", dealsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});

describe("POST /deals/:id/dispose", () => {
  it("rejects a disposition it does not know", async () => {
    const { dealId } = await seedDealThread();
    const res = await dispose(dealId, "somethingelse");
    expect(res.status).toBe(400);
  });

  it("not_a_deal archives the thread and records the label", async () => {
    const { dealId, threadId } = await seedDealThread();
    const res = await dispose(dealId, "not_a_deal");

    expect(res.status).toBe(200);
    expect((await threadRow(threadId)).status).toBe("archived");
    expect(await labelFor(dealId)).toContain("not_a_deal");
  });

  it("not_interested rejects the deal but leaves the thread alone", async () => {
    const { dealId, threadId } = await seedDealThread();
    const res = await dispose(dealId, "not_interested");

    expect(res.status).toBe(200);
    expect((await dealRow(dealId)).status).toBe("rejected");
    // Nothing was misclassified, so the conversation stays where it is.
    expect((await threadRow(threadId)).status).toBe("read");
    expect(await labelFor(dealId)).toContain("not_interested");
  });

  describe("expired — a real deal whose moment has passed", () => {
    it("files it away without claiming she turned it down", async () => {
      const { dealId, threadId } = await seedDealThread("negotiating");
      const res = await dispose(dealId, "expired");

      expect(res.status).toBe(200);
      // Off the Opportunities screen …
      expect((await threadRow(threadId)).status).toBe("archived");
      // … but NOT marked rejected. She never declined it; we were late.
      expect((await dealRow(dealId)).status).toBe("negotiating");
      expect(await labelFor(dealId)).toContain("expired");
    });

    it("is reversible — the receipt carries the thread status to restore", async () => {
      const { dealId } = await seedDealThread();
      await dispose(dealId, "expired");

      const [receipt] = (await db.select().from(agentActions).where(eq(agentActions.deal_id, dealId)))
        .filter((a: any) => a.payload?.athlete_label === "expired");
      expect(receipt.reversible).toBe(true);
      expect((receipt.payload as any).from_status).toBe("read");
      expect((receipt.payload as any).to_status).toBe("archived");
    });

    it("is marked as confirming the deal was REAL, unlike not_a_deal", async () => {
      const expiredDeal  = await seedDealThread();
      const notADealDeal = await seedDealThread();
      await dispose(expiredDeal.dealId, "expired");
      await dispose(notADealDeal.dealId, "not_a_deal");

      const flagOf = async (dealId: string, label: string) =>
        (await db.select().from(agentActions).where(eq(agentActions.deal_id, dealId)))
          .filter((a: any) => a.payload?.athlete_label === label)
          .map((a: any) => a.payload?.confirms_real)[0];

      // This flag is what keeps the sender safe and puts the row on the right side of
      // the eval corpus. Getting it backwards would be silent and expensive.
      expect(await flagOf(expiredDeal.dealId, "expired")).toBe(true);
      expect(await flagOf(notADealDeal.dealId, "not_a_deal")).toBe(false);
    });
  });
});

describe("her own 'no' is one receipt, hers, and Undo restores both statuses (12 Oct 2026)", () => {
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

  const receipts = async (dealId: string) => db.select().from(agentActions).where(eq(agentActions.deal_id, dealId));
  const undo = (id: string) => fetch(`${undoBase}/agent-actions/${id}/undo`, { method: "POST" });

  it("not_a_deal writes ONE receipt marked as her act; Undo un-archives the thread", async () => {
    const { dealId, threadId } = await seedDealThread("detected");
    expect((await dispose(dealId, "not_a_deal")).status).toBe(200);
    const rs = await receipts(dealId);
    expect(rs).toHaveLength(1);
    expect(rs[0].payload).toMatchObject({ actor: "athlete", athlete_label: "not_a_deal", thread_from_status: "read" });
    expect((await threadRow(threadId)).status).toBe("archived");

    expect((await undo(rs[0].id)).status).toBe(200);
    expect((await threadRow(threadId)).status).toBe("read");
  });

  it("not_interested: Undo puts the deal back to its status (it used to 500 on the thread CHECK)", async () => {
    const { dealId, threadId } = await seedDealThread("negotiating");
    await dispose(dealId, "not_interested");
    expect((await dealRow(dealId)).status).toBe("rejected");
    const [r] = await receipts(dealId);
    expect(r.payload).toMatchObject({ actor: "athlete", deal_from_status: "negotiating" });

    expect((await undo(r.id)).status).toBe(200);
    expect((await dealRow(dealId)).status).toBe("negotiating");
    expect((await threadRow(threadId)).status).toBe("read");
  });

  it("an OLD receipt that stored the deal's status in from_status is restored to the deal, not the thread", async () => {
    const { dealId, threadId } = await seedDealThread("rejected");
    const { writeAgentAction } = await import("../lib/agentActions");
    const old = await writeAgentAction({
      athleteId, action: "reclassify", dealId, threadId, reversible: true,
      payload: { athlete_label: "not_interested", source: "athlete", from_status: "pending" },
    });
    expect((await undo(old.id)).status).toBe(200);
    expect((await dealRow(dealId)).status).toBe("pending");
    expect((await threadRow(threadId)).status).toBe("read");
  });

  it("Undo never writes a stale status: an OLD not_a_deal receipt leaves the deal alone; a deal that moved on stays", async () => {
    const { writeAgentAction } = await import("../lib/agentActions");
    // Old not_a_deal: from_status held the deal's status, but that act only archived the thread.
    const a = await seedDealThread("negotiating");
    const oldNotADeal = await writeAgentAction({
      athleteId, action: "reclassify", dealId: a.dealId, threadId: a.threadId, reversible: true,
      payload: { athlete_label: "not_a_deal", source: "athlete", from_status: "detected" },
    });
    expect((await undo(oldNotADeal.id)).status).toBe(200);
    expect((await dealRow(a.dealId)).status).toBe("negotiating");

    // New not_interested receipt, but the deal moved on since (she re-opened and is negotiating).
    const b = await seedDealThread("detected");
    await dispose(b.dealId, "not_interested");
    const [r] = await db.select().from(agentActions).where(eq(agentActions.deal_id, b.dealId));
    await db.update(deals).set({ status: "negotiating" }).where(eq(deals.id, b.dealId));
    expect((await undo(r.id)).status).toBe(200);
    expect((await dealRow(b.dealId)).status).toBe("negotiating");
  });
});

describe("deal activity labels the D4 receipt for what it is (#988 review)", () => {
  it("a 'reopen' row with payload.kind deal_agreed reads 'Marked agreed', never 'Reopened'", async () => {
    const { writeAgentAction } = await import("../lib/agentActions");
    const { dealId, threadId } = await seedDealThread("accepted");
    await writeAgentAction({
      athleteId, action: "reopen", dealId, threadId, reversible: true, reason: "You sent your yes — marked as agreed",
      payload: { kind: "deal_agreed", actor: "athlete", deal_from_status: "detected", deal_to_status: "accepted" },
    });
    const r = await fetch(`${base}/deals/${dealId}`);
    expect(r.status).toBe(200);
    const titles = ((await r.json()).activity ?? []).filter((a: any) => a.type === "agent").map((a: any) => a.title);
    expect(titles).toEqual(["Marked agreed"]);
  });
});
