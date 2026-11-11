/**
 * Reply-text retention (decisions 5–6) under MAILBOX_ZERO_RETENTION — approve / dismiss write-
 * backs and the daily sweep's TTLs. Real SQL on PGlite; the send path is mocked at
 * services/threadReply (no provider is reached), auth is stubbed.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("./threadReply", () => ({ sendThreadReply: jest.fn(async () => ({ ok: true, sentMessageId: "<sent-1@mail.gmail.com>" })) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import pendingActionsRouter from "../routes/pendingActions";
import { sendThreadReply } from "./threadReply";
import { sweepMailboxRetention, retiredPayload } from "./mailboxRetentionSweep";
import { bodySha256 } from "../../shared/bodyHash";
import { deals, inboxThreads, opportunities, pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const sendMock = sendThreadReply as jest.Mock;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-07T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
/** Non-ASCII on purpose: the SQL hash must equal shared/bodyHash byte for byte. */
const BODY = "Hi Sarah — happy to do 2 reels. Merci ✨";

let server: Server;
let base: string;
let athleteId: string;
let dealId: string;
let threadId: string;

const ENV = ["MAILBOX_LIVE_READS", "MAILBOX_ZERO_RETENTION"] as const;
const saved: Record<string, string | undefined> = {};
const flagsOn = () => { process.env.MAILBOX_LIVE_READS = "true"; process.env.MAILBOX_ZERO_RETENTION = "true"; };
const flagsOff = () => { delete process.env.MAILBOX_LIVE_READS; delete process.env.MAILBOX_ZERO_RETENTION; };

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function action(over: Record<string, unknown> = {}) {
  const [r] = await db.insert(pendingActions).values({
    athlete_id: athleteId, deal_id: dealId, thread_id: threadId, kind: "send_reply", status: "pending",
    payload: { body: BODY, reply_intent: "accept" }, ...over,
  } as any).returning({ id: pendingActions.id });
  return r.id as string;
}
const row = async (id: string) => (await db.select().from(pendingActions).where(eq(pendingActions.id, id)))[0];

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  await initTestDb();
  athleteId = await seedAthlete("Retention");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", status: "negotiating" } as any).returning({ id: deals.id });
  dealId = d.id;
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: dealId, status: "deal_detected" } as any).returning({ id: inboxThreads.id });
  threadId = t.id;
  const app = express();
  app.use(express.json());
  app.use("/", pendingActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeTestDb();
});

describe("approve / dismiss write-backs", () => {
  it("flag on: approve sends, then keeps the hash and the sent Message-ID, not the body", async () => {
    flagsOn();
    const id = await action();
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256(BODY) });
    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenLastCalledWith(athleteId, threadId, BODY);   // the approved text is what sent
    const p = (await row(id)).payload as any;
    expect(p.body).toBeUndefined();
    expect(p).toMatchObject({ body_sha256: bodySha256(BODY), sent_message_id: "<sent-1@mail.gmail.com>", reply_intent: "accept" });
    expect(JSON.stringify(r.json)).not.toContain("happy to do");
  });

  it("flag on: dismiss keeps the hash, not the body", async () => {
    flagsOn();
    const id = await action();
    const r = await api("POST", `/pending-actions/${id}/dismiss`);
    expect(r.status).toBe(200);
    const p = (await row(id)).payload as any;
    expect(p.body).toBeUndefined();
    expect(p.body_sha256).toBe(bodySha256(BODY));
  });

  it("flag on: a new proposal expires in 14 days unless it says otherwise", async () => {
    flagsOn();
    const before = Date.now();
    const r = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "x" } });
    expect(r.status).toBe(201);
    const exp = new Date(r.json.expires_at).getTime();
    expect(exp - before).toBeGreaterThanOrEqual(14 * DAY - 5_000);
    expect(exp - before).toBeLessThanOrEqual(14 * DAY + 5_000);
  });

  it("flag off: approve and dismiss keep the body, and a proposal has no default expiry (unchanged)", async () => {
    flagsOff();
    const a = await action();
    await api("POST", `/pending-actions/${a}/approve`, { body_sha256: bodySha256(BODY) });
    expect(((await row(a)).payload as any).body).toBe(BODY);
    const d = await action();
    await api("POST", `/pending-actions/${d}/dismiss`);
    expect(((await row(d)).payload as any).body).toBe(BODY);
    const r = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body: "x" } });
    expect(r.json.expires_at).toBeNull();
  });

  it("retiredPayload keeps an existing hash and adds nothing it doesn't know", () => {
    expect(retiredPayload({ body: "a", body_sha256: "kept" })).toMatchObject({ body_sha256: "kept" });
    expect(retiredPayload({ body: "a" }).sent_message_id).toBeUndefined();
  });
});

describe("the daily sweep", () => {
  beforeEach(async () => {
    await db.delete(pendingActions);
  });

  it("is a no-op with the flag off", async () => {
    flagsOff();
    const id = await action({ created_at: ago(30) });
    expect(await sweepMailboxRetention({ now: NOW })).toMatchObject({ ran: false });
    expect(((await row(id)).payload as any).body).toBe(BODY);
    expect((await row(id)).status).toBe("pending");
  });

  it("pending: expires at 14 days (or its own expires_at); younger ones untouched", async () => {
    flagsOn();
    const old      = await action({ created_at: ago(15) });
    const young    = await action({ created_at: ago(13) });
    const ownTtl   = await action({ created_at: ago(2), expires_at: ago(1) });
    const r = await sweepMailboxRetention({ now: NOW });
    expect(r).toMatchObject({ ran: true, expiredPending: 2 });

    for (const id of [old, ownTtl]) {
      const x = await row(id);
      expect(x.status).toBe("dismissed");
      expect(x.result).toMatchObject({ expired: true });
      expect((x.payload as any).body).toBeUndefined();
      // Hashed IN SQL — must equal the shared JS hash, non-ASCII included.
      expect((x.payload as any).body_sha256).toBe(bodySha256(BODY));
      expect((x.payload as any).reply_intent).toBe("accept");
    }
    const y = await row(young);
    expect(y.status).toBe("pending");
    expect((y.payload as any).body).toBe(BODY);
  });

  it("failed: body kept 7 days for a retry, then removed", async () => {
    flagsOn();
    const stale = await action({ status: "failed", approved_at: ago(8), executed_at: ago(8), error: "send failed" });
    const fresh = await action({ status: "failed", approved_at: ago(6), executed_at: ago(6), error: "send failed" });
    expect(await sweepMailboxRetention({ now: NOW })).toMatchObject({ strippedFailed: 1 });
    expect(((await row(stale)).payload as any)).toMatchObject({ body_sha256: bodySha256(BODY) });
    expect(((await row(stale)).payload as any).body).toBeUndefined();
    expect(((await row(fresh)).payload as any).body).toBe(BODY);
  });

  it("backstop: settled sends and dismissals lose a leftover body; a send still settling is left alone", async () => {
    flagsOn();
    const sent      = await action({ status: "approved", approved_at: ago(1), executed_at: ago(1) });
    const dismissed = await action({ status: "dismissed", dismissed_at: ago(1) });
    const settling  = await action({ status: "approved", approved_at: NOW, executed_at: null });
    expect(await sweepMailboxRetention({ now: NOW })).toMatchObject({ strippedSettled: 2 });
    expect(((await row(sent)).payload as any).body).toBeUndefined();
    expect(((await row(dismissed)).payload as any).body).toBeUndefined();
    expect(((await row(settling)).payload as any).body).toBe(BODY);
  });

  it("drafts: deleted 30 days after the last edit, or when the opportunity closes", async () => {
    flagsOn();
    const mk = async (draft: Record<string, unknown> | null, over: Record<string, unknown> = {}) => {
      const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", status: "detected", ...over } as any).returning({ id: deals.id });
      const [t] = await db.insert(inboxThreads).values({
        athlete_id: athleteId, deal_id: d.id, status: "deal_detected", latest_draft: draft, last_message_at: ago(40),
      } as any).returning({ id: inboxThreads.id });
      return { dealId: d.id as string, threadId: t.id as string };
    };
    const stale     = await mk({ body: "old draft", saved_at: ago(31).toISOString() });
    const recent    = await mk({ body: "recent draft", saved_at: ago(29).toISOString(), generated_at: ago(60).toISOString() });
    const noStamp   = await mk({ body: "legacy draft" });                         // falls back to last_message_at (40d)
    const closedOpp = await mk({ body: "fresh but closed", saved_at: ago(1).toISOString() });
    const [o] = await db.insert(opportunities).values({
      athlete_id: athleteId, status: "closed", close_reason: "declined", closed_at: ago(1), opened_at: ago(5), last_activity_at: ago(1),
    } as any).returning({ id: opportunities.id });
    await db.update(deals).set({ opportunity_id: o.id } as any).where(eq(deals.id, closedOpp.dealId));

    const r = await sweepMailboxRetention({ now: NOW });
    expect(r.draftsDeleted).toBeGreaterThanOrEqual(3);
    const draftOf = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0].latest_draft;
    expect(await draftOf(stale.threadId)).toBeNull();
    expect(await draftOf(noStamp.threadId)).toBeNull();
    expect(await draftOf(closedOpp.threadId)).toBeNull();
    expect(await draftOf(recent.threadId)).toMatchObject({ body: "recent draft" });
  });
});
