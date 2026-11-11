/**
 * Deal payloads carry the thread's OWN inbox (connection-identity plan §4.6).
 *
 * The app used to decide "can draft / can send" from any active Gmail row, so a card
 * offered Save as draft while the thread's own row was revoked or lacked gmail.compose.
 * Each deal now says which connection its thread answers through and what THAT row can
 * do — resolved message-first, then thread, exactly as draft save and send resolve it.
 *
 * Real Express router against PGlite; auth mocked.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import dealsRouter from "./deals";
import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const COMPOSE = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose";
const SEND_ONLY = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

let server: Server;
let base: string;
let athleteId: string;

function asUser(id: string) { (globalThis as any).__TEST_ATHLETE_ID = id; }

async function seedDeal(opts: { threadConn: string | null; messageConn?: string | null }) {
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: "gorjana", status: "detected", source: "inbox_scan",
  }).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, subject: "Partnership", status: "deal_detected",
    connected_account_id: opts.threadConn,
  }).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", sender_email: "avery@solsticejewelry.test",
    body: "Hi", received_at: new Date(), platform: "gmail",
    connected_account_id: opts.messageConn === undefined ? opts.threadConn : opts.messageConn,
  });
  return d.id;
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  asUser(athleteId);
  const app = express();
  app.use(express.json());
  app.use("/", dealsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => asUser(athleteId));

describe("deal payloads — inbox block", () => {
  it("active + compose: can draft and send, on both the list and the detail", async () => {
    const conn = await seedConnection({ athleteId, email: "rileyathlete@gmail.com", scopes: COMPOSE });
    const dealId = await seedDeal({ threadConn: conn });
    const expected = {
      connection_id: conn, email: "rileyathlete@gmail.com", status: "active", can_draft: true, can_send: true,
    };

    const list = await get(`/deals?id=${dealId}`);
    expect(list.status).toBe(200);
    expect(list.json[0].inbox).toEqual(expected);

    const detail = await get(`/deals/${dealId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.inbox).toEqual(expected);
  });

  it("active without gmail.compose: can send, cannot draft", async () => {
    const conn = await seedConnection({ athleteId, email: "rileyathlete@rileyathlete.test", scopes: SEND_ONLY });
    const dealId = await seedDeal({ threadConn: conn });

    const detail = await get(`/deals/${dealId}`);
    expect(detail.json.inbox).toMatchObject({ connection_id: conn, can_draft: false, can_send: true });
  });

  it("the message's revoked row wins over an active thread row — no rescue", async () => {
    const live = await seedConnection({ athleteId, email: "live@gmail.com", scopes: COMPOSE });
    const dead = await seedConnection({ athleteId, email: "dead@gmail.com", status: "revoked", scopes: COMPOSE });
    const dealId = await seedDeal({ threadConn: live, messageConn: dead });

    const list = await get(`/deals?id=${dealId}`);
    expect(list.json[0].inbox).toEqual({
      connection_id: dead, email: "dead@gmail.com", status: "revoked", can_draft: false, can_send: false,
    });
  });

  it("legacy thread with no connection: inbox is null", async () => {
    const dealId = await seedDeal({ threadConn: null });

    expect((await get(`/deals?id=${dealId}`)).json[0].inbox).toBeNull();
    expect((await get(`/deals/${dealId}`)).json.inbox).toBeNull();
  });

  it("a deal with no thread: inbox is null", async () => {
    const [d] = await db.insert(deals).values({
      athlete_id: athleteId, brand_name: "contract only", status: "accepted", source: "inbox_scan",
    }).returning({ id: deals.id });

    expect((await get(`/deals?id=${d.id}`)).json[0].inbox).toBeNull();
    expect((await get(`/deals/${d.id}`)).json.inbox).toBeNull();
  });
});
