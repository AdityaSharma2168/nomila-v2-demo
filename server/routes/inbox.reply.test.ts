/**
 * Reply-send tests — the shared send path (services/threadReply.sendThreadReply) against
 * in-memory Postgres (PGlite), with the Gmail/Instagram integrations and auth mocked. Covers
 * the multi-inbox routing fix: replies must send through the connection that received the
 * deal, legacy rows resolve lazily via mailbox probing, and threading metadata recovers live
 * when the stored cache is missing.
 *
 * The deprecated direct-send route POST /inbox/threads/:id/reply was RETIRED on 12 Oct 2026
 * (410, nothing sent). These cases used it only as a vehicle for sendThreadReply, so they now
 * drive sendThreadReply through a tiny test-only route that maps its result the same way;
 * the governed path (propose → approve with body_sha256) is covered in pendingActions.test.ts.
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
import inboxRouter from "./inbox";
import { sendThreadReply } from "../services/threadReply";
import { sendGmailReply, fetchMessageThreadingInfo } from "../lib/integrations/gmail";
import { sendInstagramDM } from "../lib/integrations/instagram";
import { summarizeThread, updateMechanicalThreadState } from "../skills/threadSummarizer";
import { inboxThreads, inboxMessages, connectedAccounts, deals, pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { bodySha256 } from "../../shared/bodyHash";

const sendMock      = sendGmailReply as jest.Mock;
let sentSeq = 0;
const probeMock     = fetchMessageThreadingInfo as jest.Mock;
const igMock        = sendInstagramDM as jest.Mock;
const summarizeMock = summarizeThread as jest.Mock;
const mechMock      = updateMechanicalThreadState as jest.Mock;

// The route triggers the summarizer fire-and-forget after responding; give the
// dynamic-import chain a tick to land before asserting on it.
const settle = () => new Promise((r) => setTimeout(r, 20));

let server: Server;
let base: string;

// Two athletes: one with two Gmail inboxes (ambiguous legacy case), one with a
// single inbox (unambiguous legacy case).
let athleteMulti: string, inboxA: string, inboxB: string, inboxRevoked: string, igConn: string;
let athleteSingle: string, inboxOnly: string;

function asUser(athleteId: string) {
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
}

async function mkThread(athleteId: string, over: Record<string, unknown> = {}) {
  const [t] = await db
    .insert(inboxThreads)
    .values({ athlete_id: athleteId, subject: "Sponsorship", ...over } as any)
    .returning();
  return t;
}

let msgSeq = 0;
async function mkMsg(threadId: string, athleteId: string, over: Record<string, unknown> = {}) {
  msgSeq++;
  const [m] = await db
    .insert(inboxMessages)
    .values({
      thread_id:           threadId,
      athlete_id:          athleteId,
      direction:           "inbound",
      sender_email:        "brand@acme.com",
      subject:             "Sponsorship",
      body:                "hey",
      platform:            "gmail",
      external_message_id: `ext-${msgSeq}`,
      received_at:         new Date(Date.UTC(2026, 0, 1, 0, msgSeq)),
      ...over,
    } as any)
    .returning();
  return m;
}

async function reply(threadId: string, body = "Sounds great!") {
  const res = await fetch(`${base}/__send/${threadId}`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ body }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  await initTestDb();

  athleteMulti  = await seedAthlete("Multi Inbox");
  inboxA        = await seedConnection({ athleteId: athleteMulti, email: "a@gmail.com" });
  inboxB        = await seedConnection({ athleteId: athleteMulti, email: "b@gmail.com" });
  inboxRevoked  = await seedConnection({ athleteId: athleteMulti, email: "old@gmail.com", status: "revoked" });
  igConn        = await seedConnection({ athleteId: athleteMulti, platform: "instagram", email: "ig-user" });

  athleteSingle = await seedAthlete("Single Inbox");
  inboxOnly     = await seedConnection({ athleteId: athleteSingle, email: "only@gmail.com" });

  const app = express();
  app.use(express.json());
  app.use("/", inboxRouter);
  // Test-only: sendThreadReply's result, mapped as the retired route mapped it.
  app.post("/__send/:id", async (req, res) => {
    const result = await sendThreadReply((globalThis as any).__TEST_ATHLETE_ID, req.params.id, String(req.body?.body ?? ""));
    if (result.ok) { res.json({ ok: true }); return; }
    const payload: Record<string, unknown> = { error: result.error };
    if (result.code) payload.code = result.code;
    if (result.legacy_code) payload.legacy_code = result.legacy_code;
    if (result.inbox) payload.inbox = result.inbox;
    res.status(result.status).json(payload);
  });
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
  asUser(athleteMulti);
});

describe("reply routing — sends from the inbox that received the deal", () => {
  it("uses the stored connected_account_id, not an arbitrary Gmail account", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxB });
    await mkMsg(t.id, athleteMulti, {
      connected_account_id:    inboxB,
      gmail_thread_id:         "gt-b",
      gmail_message_id_header: "<orig@b>",
    });

    const r = await reply(t.id);

    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      connectionId:    inboxB,
      gmailThreadId:   "gt-b",
      messageIdHeader: "<orig@b>",
      toEmail:         "brand@acme.com",
    });
    expect(probeMock).not.toHaveBeenCalled(); // no probing when the link is stored

    // Outbound row records the sending inbox and the Message-ID Gmail assigned.
    const [outbound] = await db
      .select()
      .from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, t.id), eq(inboxMessages.direction, "outbound")));
    expect(outbound.connected_account_id).toBe(inboxB);
    expect(outbound.gmail_message_id_header).toBe(await sendMock.mock.results[0].value);
    expect(outbound.gmail_thread_id).toBe("gt-b");
    // The text fingerprint (0086) the echo gate matches on: SHA-256 of the trimmed text.
    expect(outbound.body_sha256).toBe(bodySha256("Sounds great!"));
  });

  it("fails with RECONNECT_REQUIRED (legacy REAUTH_REQUIRED) when the receiving inbox is disconnected — never silently sends from another account", async () => {
    const t = await mkThread(athleteMulti);
    await mkMsg(t.id, athleteMulti, {
      connected_account_id:    inboxRevoked,
      gmail_thread_id:         "gt-old",
      gmail_message_id_header: "<orig@old>",
    });

    const r = await reply(t.id);

    expect(r.status).toBe(401);
    expect(r.json.code).toBe("RECONNECT_REQUIRED");
    expect(r.json.legacy_code).toBe("REAUTH_REQUIRED");
    expect(r.json.error).toMatch(/reconnect/i);
    expect(r.json.inbox).toEqual({ connection_id: inboxRevoked, email: "old@gmail.com" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("legacy thread + single Gmail account: uses it and writes the link back", async () => {
    asUser(athleteSingle);
    const t = await mkThread(athleteSingle);
    await mkMsg(t.id, athleteSingle, {
      gmail_thread_id:         "gt-legacy",
      gmail_message_id_header: "<orig@legacy>",
    });

    const r = await reply(t.id);

    expect(r.status).toBe(200);
    expect(sendMock.mock.calls[0][0].connectionId).toBe(inboxOnly);

    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.connected_account_id).toBe(inboxOnly);
  });

  it("legacy thread + multiple accounts: probes each mailbox and picks the one that owns the message", async () => {
    const t = await mkThread(athleteMulti);
    const m = await mkMsg(t.id, athleteMulti, {}); // no threading data, no account link

    // The Gmail message id only resolves inside the receiving mailbox (B).
    probeMock.mockImplementation(async (connId: string) =>
      connId === inboxB ? { gmailThreadId: "gt-probed", messageIdHeader: "<orig@probed>" } : null,
    );

    const r = await reply(t.id);

    expect(r.status).toBe(200);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      connectionId:    inboxB,
      gmailThreadId:   "gt-probed",
      messageIdHeader: "<orig@probed>",
    });

    // Resolution is written back: account on the thread, threading data on the message.
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.connected_account_id).toBe(inboxB);
    const [msg] = await db.select().from(inboxMessages).where(eq(inboxMessages.id, m.id));
    expect(msg.gmail_thread_id).toBe("gt-probed");
    expect(msg.gmail_message_id_header).toBe("<orig@probed>");
    expect(msg.connected_account_id).toBe(inboxB);

    // Second reply on the same thread: no probing — the link is now stored.
    probeMock.mockClear();
    sendMock.mockClear();
    sendMock.mockResolvedValue("<sent2@mail.gmail.com>");
    const r2 = await reply(t.id, "Following up!");
    expect(r2.status).toBe(200);
    expect(probeMock).not.toHaveBeenCalled();
    expect(sendMock.mock.calls[0][0].connectionId).toBe(inboxB);
  });

  it("legacy thread + multiple accounts: 422 when no mailbox owns the message (purged from Gmail)", async () => {
    const t = await mkThread(athleteMulti);
    await mkMsg(t.id, athleteMulti, {});

    probeMock.mockResolvedValue(null);

    const r = await reply(t.id);

    expect(r.status).toBe(422);
    expect(sendMock).not.toHaveBeenCalled();
    const [thread] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, t.id));
    expect(thread.connected_account_id).toBeNull();
  });
});

describe("reply threading — stored columns are a cache, live fetch is the fallback", () => {
  it("recovers Message-ID/threadId live through the stored account and caches them", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA });
    const m = await mkMsg(t.id, athleteMulti, { connected_account_id: inboxA }); // pre-June row: no threading columns

    probeMock.mockResolvedValue({ gmailThreadId: "gt-live", messageIdHeader: "<orig@live>" });

    const r = await reply(t.id);

    expect(r.status).toBe(200);
    expect(probeMock).toHaveBeenCalledWith(inboxA, m.external_message_id);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      connectionId:    inboxA,
      gmailThreadId:   "gt-live",
      messageIdHeader: "<orig@live>",
    });

    const [msg] = await db.select().from(inboxMessages).where(eq(inboxMessages.id, m.id));
    expect(msg.gmail_message_id_header).toBe("<orig@live>");
    expect(msg.gmail_thread_id).toBe("gt-live");
  });

  it("fails loudly (422) instead of sending an un-threaded email when metadata is unrecoverable", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA });
    await mkMsg(t.id, athleteMulti, { connected_account_id: inboxA });

    probeMock.mockResolvedValue(null);

    const r = await reply(t.id);

    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/Cannot thread reply/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("builds the References chain oldest-first from all stored Message-IDs", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA });
    await mkMsg(t.id, athleteMulti, { connected_account_id: inboxA, gmail_thread_id: "gt", gmail_message_id_header: "<h1>" });
    await mkMsg(t.id, athleteMulti, { connected_account_id: inboxA, gmail_thread_id: "gt", gmail_message_id_header: "<h2>" });
    await mkMsg(t.id, athleteMulti, { connected_account_id: inboxA, gmail_thread_id: "gt", gmail_message_id_header: "<h3>" });

    const r = await reply(t.id);

    expect(r.status).toBe(200);
    const args = sendMock.mock.calls[0][0];
    expect(args.messageIdHeader).toBe("<h3>"); // replies to the most recent inbound
    expect(args.references).toEqual(["<h1>", "<h2>", "<h3>"]);
  });

  it("flags the connection revoked and returns 401 when the send hits a dead OAuth grant", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA });
    await mkMsg(t.id, athleteMulti, {
      connected_account_id:    inboxA,
      gmail_thread_id:         "gt",
      gmail_message_id_header: "<h-revoked>",
    });

    sendMock.mockRejectedValue(new Error("Google token refresh failed: invalid_grant"));

    const r = await reply(t.id);

    expect(r.status).toBe(401);
    expect(r.json.code).toBe("RECONNECT_REQUIRED");
    expect(r.json.legacy_code).toBe("REAUTH_REQUIRED");
    expect(r.json.error).toMatch(/expired/i);
    expect(r.json.error).toMatch(/reconnect/i);
    expect(r.json.inbox).toEqual({ connection_id: inboxA, email: "a@gmail.com" });
    const [acct] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, inboxA));
    expect(acct.status).toBe("revoked");

    // Restore for later tests.
    await db.update(connectedAccounts).set({ status: "active" }).where(eq(connectedAccounts.id, inboxA));
  });
});

describe("reply — other paths", () => {
  it("routes an Instagram reply through the receiving connection", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: igConn });
    await mkMsg(t.id, athleteMulti, {
      platform:             "instagram",
      connected_account_id: igConn,
      sender_ig_user_id:    "ig-sender-1",
      sender_email:         null,
    });

    const r = await reply(t.id, "Thanks for reaching out!");

    expect(r.status).toBe(200);
    expect(igMock).toHaveBeenCalledWith({
      connectionId:      igConn,
      recipientIgUserId: "ig-sender-1",
      message:           "Thanks for reaching out!",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("re-summarizes the thread after a successful reply so 'whose turn' flips immediately", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA });
    await mkMsg(t.id, athleteMulti, {
      connected_account_id:    inboxA,
      gmail_thread_id:         "gt-sum",
      gmail_message_id_header: "<orig@sum>",
    });

    const r = await reply(t.id);
    expect(r.status).toBe(200);

    // The mechanical turn flip is AWAITED before the response — no settle
    // needed. The client's deals-list refetch depends on this ordering.
    expect(mechMock).toHaveBeenCalledWith(t.id);

    await settle();
    expect(summarizeMock).toHaveBeenCalledWith(t.id);
  });

  it("does not re-summarize when the send fails", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA });
    await mkMsg(t.id, athleteMulti, {
      connected_account_id:    inboxA,
      gmail_thread_id:         "gt-fail",
      gmail_message_id_header: "<orig@fail>",
    });

    sendMock.mockRejectedValue(new Error("gmail 500"));
    const r = await reply(t.id);
    expect(r.status).toBe(502);

    await settle();
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(mechMock).not.toHaveBeenCalled();
  });

  it("400s on a thread with no inbound messages", async () => {
    const t = await mkThread(athleteMulti);
    const r = await reply(t.id);
    expect(r.status).toBe(400);
  });

  it("404s on another athlete's thread", async () => {
    const t = await mkThread(athleteSingle);
    asUser(athleteMulti);
    const r = await reply(t.id);
    expect(r.status).toBe(404);
  });

  it("400s on an empty body", async () => {
    const t = await mkThread(athleteMulti);
    const r = await reply(t.id, "   ");
    expect(r.status).toBe(400);
  });

  it("400s on an over-long body instead of handing it to Gmail", async () => {
    const t = await mkThread(athleteMulti);
    const r = await reply(t.id, "a".repeat(25_001));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/too long/i);
  });

  it("accepts a long-but-legitimate reply", async () => {
    const t = await mkThread(athleteMulti, { connected_account_id: inboxB });
    await mkMsg(t.id, athleteMulti, {
      connected_account_id:    inboxB,
      gmail_thread_id:         "gt-long",
      gmail_message_id_header: "<orig@long>",
    });
    const r = await reply(t.id, "a".repeat(24_000));
    expect(r.status).toBe(200);
  });
});

/**
 * Plan §4.4: send checks exactly the row the thread points at, and every failure says
 * why and names the inbox.
 */
describe("reply — send result per state of the thread's inbox", () => {
  let athleteStates: string;
  beforeAll(async () => {
    athleteStates = await seedAthlete("Inbox States");
  });
  beforeEach(() => asUser(athleteStates));

  async function threadOn(connId: string, gt: string) {
    const t = await mkThread(athleteStates, { connected_account_id: connId });
    await mkMsg(t.id, athleteStates, {
      connected_account_id: connId, gmail_thread_id: gt, gmail_message_id_header: `<orig@${gt}>`,
    });
    return t;
  }

  it("active + send scope: sent", async () => {
    const c = await seedConnection({
      athleteId: athleteStates, email: "send@gmail.com",
      scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    });
    const r = await reply((await threadOn(c, "gt-s1")).id);
    expect(r.status).toBe(200);
    expect(sendMock.mock.calls[0][0].connectionId).toBe(c);
  });

  it("active + compose only (no gmail.send) can still send", async () => {
    const c = await seedConnection({
      athleteId: athleteStates, email: "compose@gmail.com",
      scopes: "https://www.googleapis.com/auth/gmail.compose",
    });
    const r = await reply((await threadOn(c, "gt-s2")).id);
    expect(r.status).toBe(200);
  });

  it("active with NULL scopes is treated as able to send", async () => {
    const c = await seedConnection({ athleteId: athleteStates, email: "nullscopes@gmail.com" });
    const r = await reply((await threadOn(c, "gt-s3")).id);
    expect(r.status).toBe(200);
  });

  it("active but read-only grant: 403 SCOPE_MISSING, nothing sent, inbox named", async () => {
    const c = await seedConnection({
      athleteId: athleteStates, email: "readonly@gmail.com",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    });
    const r = await reply((await threadOn(c, "gt-s4")).id);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_MISSING");
    expect(r.json.error).toMatch(/reconnect/i);
    expect(r.json.inbox).toEqual({ connection_id: c, email: "readonly@gmail.com" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("expired row: 401 RECONNECT_REQUIRED with legacy_code and inbox", async () => {
    const c = await seedConnection({ athleteId: athleteStates, email: "expired@gmail.com", status: "expired" });
    const r = await reply((await threadOn(c, "gt-s5")).id);
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({
      code: "RECONNECT_REQUIRED",
      legacy_code: "REAUTH_REQUIRED",
      inbox: { connection_id: c, email: "expired@gmail.com" },
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a revoked MESSAGE row is not rescued by an active thread row", async () => {
    const live = await seedConnection({ athleteId: athleteStates, email: "live@gmail.com" });
    const dead = await seedConnection({ athleteId: athleteStates, email: "dead@gmail.com", status: "revoked" });
    const t = await mkThread(athleteStates, { connected_account_id: live });
    await mkMsg(t.id, athleteStates, {
      connected_account_id: dead, gmail_thread_id: "gt-s6", gmail_message_id_header: "<orig@s6>",
    });
    const r = await reply(t.id);
    expect(r.status).toBe(401);
    expect(r.json.inbox).toEqual({ connection_id: dead, email: "dead@gmail.com" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("Google 403 insufficient authentication scopes during send: 403 SCOPE_MISSING, not a 502", async () => {
    const c = await seedConnection({ athleteId: athleteStates, email: "lies@gmail.com" });
    sendMock.mockRejectedValue(new Error("Gmail send failed: Request had insufficient authentication scopes."));
    const r = await reply((await threadOn(c, "gt-s7")).id);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_MISSING");
    expect(r.json.inbox).toEqual({ connection_id: c, email: "lies@gmail.com" });
    // Not a dead grant: the row stays active.
    const [acct] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, c));
    expect(acct.status).toBe("active");
  });
});

describe("reply — Instagram answers only from the account that received the DM", () => {
  async function igThread(athleteId: string, connId: string | null, sender = "ig-sender") {
    const t = await mkThread(athleteId, connId ? { connected_account_id: connId } : {});
    await mkMsg(t.id, athleteId, {
      platform: "instagram", connected_account_id: connId, sender_ig_user_id: sender, sender_email: null,
    });
    return t;
  }

  it("stored IG account revoked + another IG account active: RECONNECT_REQUIRED, nothing sent", async () => {
    const athlete = await seedAthlete("Two IG");
    asUser(athlete);
    const personal = await seedConnection({ athleteId: athlete, platform: "instagram", email: "rileyathlete", status: "revoked" });
    await seedConnection({ athleteId: athlete, platform: "instagram", email: "nomila.co" });

    const r = await reply((await igThread(athlete, personal)).id, "Hi!");

    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({
      code: "RECONNECT_REQUIRED",
      legacy_code: "REAUTH_REQUIRED",
      inbox: { connection_id: personal, email: "rileyathlete" },
    });
    expect(igMock).not.toHaveBeenCalled();
  });

  it("stored IG account active: sends from exactly that one, even with another active", async () => {
    const athlete = await seedAthlete("Two IG active");
    asUser(athlete);
    await seedConnection({ athleteId: athlete, platform: "instagram", email: "first" });
    const second = await seedConnection({ athleteId: athlete, platform: "instagram", email: "second" });

    const r = await reply((await igThread(athlete, second)).id, "Hi!");

    expect(r.status).toBe(200);
    expect(igMock.mock.calls[0][0].connectionId).toBe(second);
  });

  it("legacy (no stored id) + exactly one active IG account: uses it", async () => {
    const athlete = await seedAthlete("One IG");
    asUser(athlete);
    const only = await seedConnection({ athleteId: athlete, platform: "instagram", email: "only-ig" });

    const r = await reply((await igThread(athlete, null)).id, "Hi!");

    expect(r.status).toBe(200);
    expect(igMock.mock.calls[0][0].connectionId).toBe(only);
  });

  it("legacy (no stored id) + two active IG accounts: refuses instead of guessing", async () => {
    const athlete = await seedAthlete("Two IG legacy");
    asUser(athlete);
    await seedConnection({ athleteId: athlete, platform: "instagram", email: "a-ig" });
    await seedConnection({ athleteId: athlete, platform: "instagram", email: "b-ig" });

    const r = await reply((await igThread(athlete, null)).id, "Hi!");

    expect(r.status).toBe(422);
    expect(igMock).not.toHaveBeenCalled();
  });
});

describe("thread detail — inbox block", () => {
  it("returns the thread's own inbox and what it can do", async () => {
    const athlete = await seedAthlete("Payload");
    asUser(athlete);
    const sendOnly = await seedConnection({
      athleteId: athlete, email: "sendonly@gmail.com",
      scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    });
    const t = await mkThread(athlete, { connected_account_id: sendOnly });
    await mkMsg(t.id, athlete, { connected_account_id: sendOnly });

    const res = await fetch(`${base}/inbox/threads/${t.id}`);
    const json = (await res.json()) as any;

    expect(json.inbox).toEqual({
      connection_id: sendOnly, email: "sendonly@gmail.com", status: "active", can_draft: false, can_send: true,
    });
  });

  it("revoked inbox: status revoked, can neither draft nor send", async () => {
    const athlete = await seedAthlete("Payload revoked");
    asUser(athlete);
    const dead = await seedConnection({
      athleteId: athlete, email: "dead@gmail.com", status: "revoked",
      scopes: "https://www.googleapis.com/auth/gmail.compose",
    });
    const t = await mkThread(athlete, { connected_account_id: dead });

    const json = (await (await fetch(`${base}/inbox/threads/${t.id}`)).json()) as any;

    expect(json.inbox).toEqual({
      connection_id: dead, email: "dead@gmail.com", status: "revoked", can_draft: false, can_send: false,
    });
  });

  it("legacy thread with no connection: inbox is null", async () => {
    const athlete = await seedAthlete("Payload legacy");
    asUser(athlete);
    const t = await mkThread(athlete);
    const json = (await (await fetch(`${base}/inbox/threads/${t.id}`)).json()) as any;
    expect(json.inbox).toBeNull();
  });
});

describe("thread detail — message window", () => {
  it("returns the NEWEST 50 messages in chronological order on long threads", async () => {
    asUser(athleteSingle);
    const t = await mkThread(athleteSingle);
    for (let n = 1; n <= 55; n++) {
      await mkMsg(t.id, athleteSingle, { body: `msg ${n}` });
    }

    const res  = await fetch(`${base}/inbox/threads/${t.id}`);
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    // asc+limit used to keep the OLDEST 30 — new replies never appeared.
    expect(json.messages).toHaveLength(50);
    expect(json.messages[0].body).toBe("msg 6");   // oldest 5 fell out of the window
    expect(json.messages[49].body).toBe("msg 55"); // newest reply is present and last
  });
});

describe("POST /inbox/threads/:id/reply — retired: a direct send with no proposal and no body hash", () => {
  it("answers 410 ROUTE_RETIRED, sends nothing and records nothing", async () => {
    const [deal] = await db
      .insert(deals)
      .values({ athlete_id: athleteMulti, brand_name: "Acme", status: "detected" } as any)
      .returning();
    const t = await mkThread(athleteMulti, { connected_account_id: inboxA, deal_id: deal.id });
    await mkMsg(t.id, athleteMulti, { connected_account_id: inboxA, gmail_thread_id: "gt-ret", gmail_message_id_header: "<orig@ret>" });

    const res = await fetch(`${base}/inbox/threads/${t.id}/reply`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ body: "Should not go" }),
    });

    expect(res.status).toBe(410);
    expect(((await res.json()) as any).code).toBe("ROUTE_RETIRED");
    expect(sendMock).not.toHaveBeenCalled();
    expect(igMock).not.toHaveBeenCalled();
    expect(await db.select().from(pendingActions).where(eq(pendingActions.thread_id, t.id))).toHaveLength(0);
  });
});
