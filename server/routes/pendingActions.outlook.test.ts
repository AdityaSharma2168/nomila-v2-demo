/**
 * pendingActions.outlook.test.ts — Outlook sending (OUTLOOK_SEND) through the EXISTING governed send:
 * propose → her tap (approve with body_sha256) → claim-once → sendThreadReply → the Outlook sender →
 * Microsoft Graph `/me/messages/{id}/reply`.
 *
 * Graph is mocked at the network edge: `fetch` to graph.microsoft.com is answered here, and any other
 * non-local host throws, so nothing in this suite can reach a provider. The real outlook.ts runs
 * (token read from the seeded row, which never needs a refresh).
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
  deleteGmailDraft:          jest.fn(async () => true),
}));
jest.mock("../lib/integrations/instagram", () => ({ sendInstagramDM: jest.fn() }));
jest.mock("../skills/threadSummarizer", () => ({
  summarizeThread:             jest.fn(async () => null),
  updateMechanicalThreadState: jest.fn(async () => undefined),
}));

import express from "express";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import pendingActionsRouter from "./pendingActions";
import { deals, inboxThreads, inboxMessages, pendingActions } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { bodySha256 } from "../../shared/bodyHash";
import { inboxBodyFingerprint } from "../lib/inboxBodyFingerprint";
import { inboxCapability } from "../services/threadInbox";
import { isStructurallySendable } from "../lib/sendGate";
import { refreshScopesFor } from "../lib/integrations/outlook";

const SEND_SCOPES = "openid profile email offline_access User.Read Mail.Read Mail.Send";
const READ_SCOPES = "openid profile email offline_access User.Read Mail.Read";

const realFetch = global.fetch;
/** Every Graph call this suite saw. */
const graphCalls: Array<{ url: string; method: string; body: any }> = [];
/** What Graph answers the next /reply with. */
let graphReply: () => Promise<Response> = async () => new Response(null, { status: 202 });

let server: Server;
let base: string;
let athleteId: string;
let seq = 0;

function asUser(id: string) {
  (globalThis as any).__TEST_ATHLETE_ID = id;
}

/** A deal on an Outlook thread, answered through its own Outlook connection. */
async function seedOutlookDeal(scopes: string | null = SEND_SCOPES) {
  const n = ++seq;
  const connection = await seedConnection({ athleteId, platform: "outlook", email: `athlete-${n}@outlook.test`, scopes });
  const [deal] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Northwind", status: "detected" } as any).returning();
  const [thread] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, subject: "Partnership", deal_id: deal.id, connected_account_id: connection,
  } as any).returning();
  await db.insert(inboxMessages).values({
    thread_id:               thread.id,
    athlete_id:              athleteId,
    direction:               "inbound",
    sender_email:            "partnerships@northwind.test",
    subject:                 "Partnership",
    body:                    "Would you post for us?",
    platform:                "outlook",
    connected_account_id:    connection,
    external_message_id:     `AAMkGraphMsg-${n}`,
    gmail_thread_id:         `conv-${n}`,
    gmail_message_id_header: `<brand-${n}@northwind.test>`,
    received_at:             new Date(Date.UTC(2026, 9, 1)),
  } as any);
  return { connection, dealId: deal.id, threadId: thread.id, messageId: `AAMkGraphMsg-${n}`, conversationId: `conv-${n}` };
}

async function api(method: string, path: string, body?: unknown) {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function propose(dealId: string, body: string) {
  const r = await api("POST", `/deals/${dealId}/pending-actions`, { kind: "send_reply", payload: { body } });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

const replyCalls = () => graphCalls.filter((c) => /\/reply$/.test(c.url));

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Outlook Test Athlete");
  const app = express();
  app.use(express.json());
  app.use("/", pendingActionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  global.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const host = new URL(url).hostname;
    if (host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
    if (host === "graph.microsoft.com") {
      graphCalls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return graphReply();
    }
    throw new Error(`test tried to reach a provider: ${host}`);
  }) as typeof fetch;
});

afterAll(async () => {
  global.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

const savedEnv = { ...process.env };
beforeEach(() => {
  graphCalls.length = 0;
  graphReply = async () => new Response(null, { status: 202 });
  delete process.env.OUTLOOK_SEND;
  delete process.env.MAILBOX_ZERO_RETENTION;
  delete process.env.MAILBOX_LIVE_READS;
  asUser(athleteId);
});
afterEach(() => {
  for (const k of ["OUTLOOK_SEND", "MAILBOX_ZERO_RETENTION", "MAILBOX_LIVE_READS"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("OUTLOOK_SEND off (the default)", () => {
  it("the send gate refuses Outlook, and an approve sends nothing", async () => {
    expect(isStructurallySendable({ threadId: "t", hasInbound: true, platform: "outlook" })).toBe(false);

    const { dealId } = await seedOutlookDeal();
    const id = await propose(dealId, "Happy to talk.");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Happy to talk.") });

    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Unsupported platform: outlook/);
    expect(graphCalls).toHaveLength(0);
    const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, id));
    expect(row.status).toBe("failed");
  });

  it("an Outlook connection cannot send, even with Mail.Send granted", () => {
    expect(inboxCapability({ platform: "outlook", status: "active", scopes: SEND_SCOPES }).can_send).toBe(false);
  });
});

describe("OUTLOOK_SEND on, Graph mocked", () => {
  beforeEach(() => { process.env.OUTLOOK_SEND = "true"; });

  it("her tap sends once: a Graph reply to the received message, with exactly her text, in the same conversation", async () => {
    const { dealId, threadId, messageId, conversationId, connection } = await seedOutlookDeal();
    const body = "Thanks for reaching out!\n\nI'd love to hear more about the brief.";
    const id = await propose(dealId, body);
    expect(graphCalls).toHaveLength(0);   // proposing never sends

    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256(body) });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("approved");
    expect(r.json.result).toEqual({ sent: true });

    expect(replyCalls()).toHaveLength(1);
    const call = replyCalls()[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/reply`);
    // message.body, never `comment` (which would quote the thread under her text).
    expect(call.body).toEqual({ message: { body: { contentType: "Text", content: body } } });

    const outbound = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      platform: "outlook", connected_account_id: connection, gmail_thread_id: conversationId,
      gmail_message_id_header: null, body_sha256: inboxBodyFingerprint(body),
    });

    // Claim-once: a second tap on the same approval cannot send again.
    const again = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256(body) });
    expect(again.status).toBe(409);
    expect(replyCalls()).toHaveLength(1);
  });

  it("two concurrent taps send exactly once", async () => {
    const { dealId } = await seedOutlookDeal();
    const id = await propose(dealId, "Exactly once");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    graphReply = async () => { await gate; return new Response(null, { status: 202 }); };

    const a = api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Exactly once") });
    const b = api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Exactly once") });
    await new Promise((r) => setTimeout(r, 200));
    release();
    const results = await Promise.all([a, b]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(replyCalls()).toHaveLength(1);
  });

  it("the body hash must match what she saw, or nothing is sent", async () => {
    const { dealId } = await seedOutlookDeal();
    const id = await propose(dealId, "The stored text");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("What the screen showed") });
    expect(r.status).toBe(409);
    expect(r.json.code ?? r.json.error).toMatch(/BODY_MISMATCH/);
    expect(graphCalls).toHaveLength(0);
  });

  it("a grant without Mail.Send is refused before any Graph call, with a clear reconnect error", async () => {
    const { dealId, connection } = await seedOutlookDeal(READ_SCOPES);
    const id = await propose(dealId, "Hello");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Hello") });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_MISSING");
    expect(r.json.error).toMatch(/^Reconnect Outlook to allow sending/);
    expect(r.json.error).not.toMatch(/Gmail/);
    expect(r.json.inbox).toMatchObject({ connection_id: connection });
    expect(graphCalls).toHaveLength(0);
  });

  it("a NULL (unknown) grant is a no for Outlook", async () => {
    const { dealId } = await seedOutlookDeal(null);
    const id = await propose(dealId, "Hello");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Hello") });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_MISSING");
    expect(graphCalls).toHaveLength(0);
  });

  it("Graph refusing for permission maps to the same reconnect error", async () => {
    const { dealId } = await seedOutlookDeal();
    graphReply = async () => new Response(JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }), { status: 403 });
    const id = await propose(dealId, "Hello");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Hello") });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_MISSING");
    expect(replyCalls()).toHaveLength(1);
  });

  it("a message no longer in her mailbox says to reply in Outlook", async () => {
    const { dealId } = await seedOutlookDeal();
    graphReply = async () => new Response(JSON.stringify({ error: { code: "ErrorItemNotFound", message: "Not found." } }), { status: 404 });
    const id = await propose(dealId, "Hello");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Hello") });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/Reply in Outlook/);
  });

  it("zero retention: the sent text is not kept, only its fingerprint", async () => {
    process.env.MAILBOX_ZERO_RETENTION = "true";
    process.env.MAILBOX_LIVE_READS = "true";
    const { dealId, threadId } = await seedOutlookDeal();
    const id = await propose(dealId, "Not stored");
    const r = await api("POST", `/pending-actions/${id}/approve`, { body_sha256: bodySha256("Not stored") });
    expect(r.status).toBe(200);
    const [out] = await db.select().from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "outbound")));
    expect(out.body).toBeNull();
    expect(out.body_sha256).toBe(inboxBodyFingerprint("Not stored"));
  });

  it("an Outlook connection can send only with Mail.Send granted", () => {
    expect(inboxCapability({ platform: "outlook", status: "active", scopes: SEND_SCOPES }).can_send).toBe(true);
    expect(inboxCapability({ platform: "outlook", status: "active", scopes: READ_SCOPES }).can_send).toBe(false);
    expect(inboxCapability({ platform: "outlook", status: "active", scopes: "https://graph.microsoft.com/Mail.Send" }).can_send).toBe(true);
    expect(inboxCapability({ platform: "outlook", status: "active", scopes: "Mail.Read Mail.Send.Shared" }).can_send).toBe(false);
    expect(inboxCapability({ platform: "outlook", status: "revoked", scopes: SEND_SCOPES }).can_send).toBe(false);
  });
});

/**
 * Nothing else may call the Outlook sender: the only reference to `sendOutlookReply` outside its own
 * module is the Outlook sender, which only `sendThreadReply` dispatches to (via the platform table).
 */
describe("the Outlook send is reachable only through the governed path", () => {
  const serverRoot = join(__dirname, "..");
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") out.push(...sources(p)); }
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const rel = (p: string) => relative(serverRoot, p).split("\\").join("/");

  it("only services/replySenders.ts references sendOutlookReply", () => {
    const users = sources(serverRoot)
      .filter((p) => readFileSync(p, "utf8").includes("sendOutlookReply"))
      .map(rel)
      .sort();
    expect(users).toEqual(["lib/integrations/outlook.ts", "services/replySenders.ts"]);
  });

  it("only the platform table references the Outlook sender", () => {
    const users = sources(serverRoot)
      .filter((p) => /\boutlookSender\b/.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual(["lib/replyPlatforms.ts", "services/replySenders.ts"]);
  });

  // The table hands out senders by key (REPLY_PLATFORMS.outlook.sender.send), so the name checks above
  // can't see a new caller that reaches a sender through it. These close that door.
  it("only sendThreadReply dispatches to a platform's sender", () => {
    const users = sources(serverRoot)
      .filter((p) => /\bsender\b[^\n;]{0,30}\.send\b|\[\s*["']send["']\s*\]/.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual(["services/threadReply.ts"]);
  });

  it("only the platform table and sendThreadReply import the senders module", () => {
    const users = sources(serverRoot)
      .filter((p) => /from\s+["'][^"']*\/replySenders(\.js)?["']|import\(\s*["'][^"']*\/replySenders(\.js)?["']/.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual(["lib/replyPlatforms.ts", "services/threadReply.ts"]);
  });

  // The approve path moved out of the route into services/sendReplyApproval.ts (10 Nov 2026), unchanged, so a spoken
  // "send it" for an ordinary reply in a voice call (voice/oneMila/confirm.ts) takes exactly the same checks and claim.
  it("only the governed approve path calls sendThreadReply", () => {
    const users = sources(serverRoot)
      .filter((p) => /import\s*\{[^}]*\bsendThreadReply\b[^}]*\}\s*from|\bsendThreadReply\s*\(/.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual(["services/sendReplyApproval.ts", "services/threadReply.ts"]);
  });

  it("only the approve endpoint and the voice confirm (ordinary replies) reach the approve path", () => {
    const users = sources(serverRoot)
      .filter((p) => /\bapproveSendReply\s*\(|import\s*\{[^}]*\bapproveSendReply\b[^}]*\}\s*from/.test(readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(users).toEqual(["routes/pendingActions.ts", "services/sendReplyApproval.ts", "voice/oneMila/confirm.ts"]);
  });
});

/** A token refresh asks for what the grant has: never Mail.Send it wasn't given, never dropping one it was. */
describe("Outlook token refresh keeps each connection's granted scopes", () => {
  it("a read-only grant refreshes exactly as before; a grant with Mail.Send keeps it", () => {
    const before = "openid profile email offline_access User.Read Mail.Read";
    expect(refreshScopesFor(READ_SCOPES)).toBe(before);
    expect(refreshScopesFor(null)).toBe(before);
    expect(refreshScopesFor("Mail.Read Mail.Send.Shared")).toBe(before);
    expect(refreshScopesFor(SEND_SCOPES)).toBe(`${before} Mail.Send`);
    expect(refreshScopesFor("https://graph.microsoft.com/Mail.Send")).toBe(`${before} Mail.Send`);
  });
});
