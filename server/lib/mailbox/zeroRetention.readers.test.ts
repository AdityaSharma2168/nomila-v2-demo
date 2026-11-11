/**
 * MAILBOX_ZERO_RETENTION — the READERS, with both flags on, against PGlite with the mailbox
 * adapter replaced by an in-memory fake (no test reaches Gmail; the Gmail integration and Kimi
 * are mocked too).
 *
 * The fixture is a LEGACY thread: written before zero retention, so its rows still hold a
 * stored subject, body and sender name (sentinels) — exactly what the purge has not reached
 * yet. With both flags on, no reader may read any of it (every SQL statement is captured), and
 * no response may carry it: the screens get a Nomila-written title, conversations come live,
 * and a pseudonymised sender is never shown or sent to. Flag off: today's responses.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../kimi", () => ({ kimiInstant: jest.fn(), kimiStream: jest.fn() }));
jest.mock("../models", () => {
  const generateContent = jest.fn();
  return {
    genai: () => ({ models: { generateContent } }),
    GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
    KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
  };
});
jest.mock("../integrations/gmail", () => ({
  fetchMessageThreadingInfo: jest.fn(async () => null),
  sendGmailReply:            jest.fn(async () => "<sent@x>"),
  upsertGmailDraft:          jest.fn(async () => "draft-1"),
  deleteGmailDraft:          jest.fn(async () => true),
  refreshTokenIfNeeded:      jest.fn(async () => { throw new Error("tests never reach Gmail"); }),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import inboxRouter from "../../routes/inbox";
import dealsRouter from "../../routes/deals";
import askTermsRouter from "../../routes/askTerms";
import { getDealTool } from "../../mila/tools/getDeal";
import { listTasksThreadsTool } from "../../mila/tools/listTasksThreads";
import { resolveAthleteDealsByCampaign } from "../../voice/dealResolver";
import { saveThreadDraft } from "../../services/saveThreadDraft";
import { upsertGmailDraft } from "../integrations/gmail";
import { genai } from "../models";
import { directionFor, setMailboxAdapterForTests, type MailboxAdapter, type MailboxMessage } from "./index";
import { pseudonymousSender } from "./retention";
import { deals, inboxMessages, inboxThreads } from "../../../shared/schema";
import { client, db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";

const draftMock = upsertGmailDraft as jest.Mock;
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;
const ATHLETE_EMAIL = "athlete@example.com";
const SENT = "STORED-SENTINEL";

// ─── Fake mailbox ────────────────────────────────────────────────────────────

let accountId: string;
const LIVE: { id: string; conv: string; from: string; subject: string; text: string; sentAt: string }[] = [];
const calls = { conversation: 0, message: 0 };
const toMsg = (r: (typeof LIVE)[number]): MailboxMessage => {
  const m = r.from.match(/<([^>]+)>/);
  const fromEmail = (m ? m[1] : r.from).toLowerCase();
  return {
    ref: { provider: "gmail", accountId, messageRef: r.id, conversationRef: r.conv, internetMessageId: `<${r.id}@x>` },
    from: r.from, fromEmail, fromName: r.from.match(/^([^<]+)</)?.[1].trim() ?? null, subject: r.subject,
    sentAt: r.sentAt, direction: directionFor(fromEmail, [ATHLETE_EMAIL]), text: r.text, attachments: [],
  };
};
const fake: MailboxAdapter = {
  provider: "gmail",
  async fetchMessage(_a, ref) { calls.message++; const r = LIVE.find((x) => x.id === ref); if (!r) throw new Error("gone"); return toMsg(r); },
  async fetchConversation(_a, conv) { calls.conversation++; return LIVE.filter((x) => x.conv === conv).map(toMsg); },
  async fetchAttachment() { return { kind: "not_downloadable", reason: "link" }; },
  async search() { return []; },
};

// ─── SQL capture ─────────────────────────────────────────────────────────────

async function captureSql<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const seen: string[] = [];
  const orig = client.query.bind(client);
  const spy = jest.spyOn(client, "query").mockImplementation(((q: any, ...rest: any[]) => {
    seen.push(String(q));
    return (orig as any)(q, ...rest);
  }) as any);
  try { return { result: await fn(), sql: seen }; } finally { spy.mockRestore(); }
}

/** A read of inbox_messages body / subject / sender_name or inbox_threads subject. */
function readsStoredContent(statements: string[]): string | undefined {
  return statements.find((s) => {
    // `NULL as "subject"` is the masked column, not a read of it.
    const q = s.replace(/\s+/g, " ").replace(/NULL as "\w+"/gi, "NULL");
    if (!/^\s*(select|with)\b/i.test(q)) return false;
    const msgs = /"inbox_messages"|\binbox_messages\b/i.test(q);
    const threads = /"inbox_threads"|\binbox_threads\b/i.test(q);
    if (msgs && /"inbox_messages"\."(body|subject|sender_name)"|[^_a-z]"(body|sender_name)"|\bm\.(body|subject|sender_name)\b/i.test(q)) return true;
    if (threads && /"inbox_threads"\."subject"|\bt\.subject\b/i.test(q)) return true;
    if ((msgs || threads) && /[^_a-z.]"subject"/.test(q)) return true;
    return false;
  });
}

// ─── Fixture: a legacy thread that still holds stored content ───────────────

let server: Server;
let base: string;
let athleteId: string;
let dealId: string;
let threadId: string;
let fanThreadId: string;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const ENV = ["MAILBOX_LIVE_READS", "MAILBOX_ZERO_RETENTION"] as const;
const saved: Record<string, string | undefined> = {};
const flagsOn = () => { process.env.MAILBOX_LIVE_READS = "true"; process.env.MAILBOX_ZERO_RETENTION = "true"; };
const flagsOff = () => { delete process.env.MAILBOX_LIVE_READS; delete process.env.MAILBOX_ZERO_RETENTION; };

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MAILBOX_RETRY_BASE_MS = "1";
  await initTestDb();
  setMailboxAdapterForTests("gmail", fake);
  athleteId = await seedAthlete("Readers");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  accountId = await seedConnection({
    athleteId, email: ATHLETE_EMAIL,
    scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose",
  });

  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", status: "negotiating", source: "inbox_scan", detected_at: new Date() } as any)
    .returning({ id: deals.id });
  dealId = d.id;
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: dealId, subject: `${SENT} subject`, status: "deal_detected",
    connected_account_id: accountId, external_thread_id: "conv-1", last_message_at: new Date(),
    summary: "Acme wants two reels.", classification: { category: "PAID", brand_name: "Acme", advertiser: "Acme", confidence: 0.9 },
    conversation_state: { deal_stage: "negotiating", conversation_state: "Negotiating.", key_details: {} },
  } as any).returning({ id: inboxThreads.id });
  threadId = t.id;
  await db.insert(inboxMessages).values({
    thread_id: threadId, athlete_id: athleteId, direction: "inbound", platform: "gmail",
    sender_email: "sarah@acme.com", sender_name: `${SENT} name`, subject: `${SENT} msg subject`, body: `${SENT} body`,
    external_message_id: "m-1", gmail_thread_id: "conv-1", gmail_message_id_header: "<m-1@x>",
    connected_account_id: accountId, received_at: new Date(Date.UTC(2026, 9, 1)),
  } as any);
  LIVE.push({ id: "m-1", conv: "conv-1", from: "Sarah Lee <sarah@acme.com>", subject: "Live subject: reels", text: "LIVE: two reels for $5,000?", sentAt: "2026-10-01T00:00:00.000Z" });

  // A non-deal (fan) thread whose sender was kept as a pseudonym.
  const [f] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, subject: null, status: "unread", connected_account_id: accountId, external_thread_id: "conv-fan",
    last_message_at: new Date(), classification: { category: "FAN", confidence: 0.9 },
  } as any).returning({ id: inboxThreads.id });
  fanThreadId = f.id;
  await db.insert(inboxMessages).values({
    thread_id: fanThreadId, athlete_id: athleteId, direction: "inbound", platform: "gmail",
    sender_email: pseudonymousSender("fan@gmail.com"), external_message_id: "m-fan", gmail_thread_id: "conv-fan",
    connected_account_id: accountId, received_at: new Date(),
  } as any);
  LIVE.push({ id: "m-fan", conv: "conv-fan", from: "A Fan <fan@gmail.com>", subject: "hi", text: "Love your game!", sentAt: "2026-10-02T00:00:00.000Z" });

  classifyMock.mockImplementation(async () => ({ text: JSON.stringify({
    category: "PAID", is_deal: true, confidence: 0.9, brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
    agency_name: null, via_agency: false, summary: "Acme wants reels.", offer_amount: 5000, deliverables: [], deadline: null,
    contact_name: "Sarah", contact_email: "sarah@acme.com",
  }) }));

  const app = express();
  app.use(express.json());
  app.use("/", inboxRouter);
  app.use("/", dealsRouter);
  app.use("/", askTermsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setMailboxAdapterForTests("gmail", undefined);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

describe("both flags on — no reader reads or returns stored mail content", () => {
  beforeEach(flagsOn);

  it("GET /inbox/threads: no stored subject; a Nomila title instead", async () => {
    const { result: r, sql } = await captureSql(() => api("GET", "/inbox/threads"));
    expect(r.status).toBe(200);
    const row = r.json.find((x: any) => x.id === threadId);
    expect(row.subject).toBeNull();
    expect(row.title).toBe("Acme · Paid offer");
    expect(JSON.stringify(r.json)).not.toContain(SENT);
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("GET /inbox/threads/:id: conversation live, thread subject masked, nothing stored read", async () => {
    const { result: r, sql } = await captureSql(() => api("GET", `/inbox/threads/${threadId}`));
    expect(r.status).toBe(200);
    expect(r.json.thread.subject).toBeNull();
    expect(r.json.thread.title).toBe("Acme · Negotiating");
    expect(r.json.messages.map((m: any) => m.body)).toEqual(["LIVE: two reels for $5,000?"]);
    expect(JSON.stringify(r.json)).not.toContain(SENT);
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("GET /deals and GET /deals/:id: no stored subject / sender name / body; pseudonyms never shown", async () => {
    const { result: list, sql: listSql } = await captureSql(() => api("GET", "/deals"));
    expect(list.status).toBe(200);
    const card = (list.json.deals ?? list.json).find((x: any) => x.id === dealId);
    expect(card.subject).toBeNull();
    expect(card.title).toBe("Acme · Negotiating");
    expect(JSON.stringify(list.json)).not.toContain(SENT);
    expect(readsStoredContent(listSql)).toBeUndefined();

    const { result: det, sql: detSql } = await captureSql(() => api("GET", `/deals/${dealId}`));
    expect(det.status).toBe(200);
    expect(det.json.thread.subject).toBeNull();
    expect(det.json.messages[0]).toMatchObject({ subject: null, sender_name: null, body: null, sender_email: "sarah@acme.com" });
    expect(det.json.activity.find((a: any) => a.type === "message")).toMatchObject({ title: "Message from sarah@acme.com", detail: null });
    expect(JSON.stringify(det.json)).not.toContain(SENT);
    expect(readsStoredContent(detSql)).toBeUndefined();
  });

  it("POST reclassify: classifies the LIVE message; no stored content read", async () => {
    classifyMock.mockClear();
    const { result: r, sql } = await captureSql(() => api("POST", `/inbox/threads/${threadId}/reclassify`));
    expect(r.status).toBe(200);
    expect(r.json.thread.subject).toBeNull();
    const prompt = JSON.stringify(classifyMock.mock.calls[0][0]);
    expect(prompt).toContain("LIVE: two reels");
    expect(prompt).toContain("Live subject: reels");
    expect(prompt).not.toContain(SENT);
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("POST /deals/ask-terms-batch: the greeting name is live; no stored sender name read", async () => {
    const { result: r, sql } = await captureSql(() => api("POST", "/deals/ask-terms-batch", { dealIds: [dealId] }));
    expect(r.status).toBe(201);
    if (r.json.created.length) expect(r.json.created[0].payload.body).not.toContain(SENT);
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("Mila get_deal / list_tasks_threads: a Nomila title, never the stored subject", async () => {
    const { result: deal, sql: s1 } = await captureSql(() => getDealTool.execute(athleteId, { deal_id: dealId } as any));
    expect(JSON.stringify(deal)).toContain("Acme · Negotiating");
    expect(JSON.stringify(deal)).not.toContain(SENT);
    expect(readsStoredContent(s1)).toBeUndefined();

    const { result: lt, sql: s2 } = await captureSql(() => listTasksThreadsTool.execute(athleteId, {} as any));
    expect(JSON.stringify(lt)).toContain("Message");          // the fan thread's derived title
    expect(JSON.stringify(lt)).not.toContain(SENT);
    expect(readsStoredContent(s2)).toBeUndefined();
  });

  it("voice campaign lookup: derived summaries only", async () => {
    const { sql } = await captureSql(() => resolveAthleteDealsByCampaign(athleteId, "acme reels"));
    expect(readsStoredContent(sql)).toBeUndefined();
  });

  it("Gmail draft mirror: subject read live, recipient the counterparty; nothing stored read", async () => {
    draftMock.mockClear();
    const { result: r, sql } = await captureSql(() => saveThreadDraft({ athleteId, dealId, body: "Draft reply", mirrorToGmail: true }));
    expect(r.ok).toBe(true);
    expect(draftMock).toHaveBeenCalledTimes(1);
    expect(draftMock.mock.calls[0][0]).toMatchObject({ toEmail: "sarah@acme.com", subject: "Live subject: reels" });
    expect(readsStoredContent(sql)).toBeUndefined();
  });
});

describe("flags off — today's responses", () => {
  beforeEach(flagsOff);

  it("thread, list and detail carry the stored subject; no title field", async () => {
    const { result: t, sql } = await captureSql(() => api("GET", `/inbox/threads/${threadId}`));
    // The detector is real: flag off, the stored path IS a content read.
    expect(readsStoredContent(sql)).toBeDefined();
    expect(t.json.thread.subject).toBe(`${SENT} subject`);
    expect(t.json.thread.title).toBeUndefined();
    const list = await api("GET", "/deals");
    const card = (list.json.deals ?? list.json).find((x: any) => x.id === dealId);
    expect(card.subject).toBe(`${SENT} subject`);
    expect(card.title).toBeUndefined();
    const det = await api("GET", `/deals/${dealId}`);
    expect(det.json.messages[0]).toMatchObject({ subject: `${SENT} msg subject`, sender_name: `${SENT} name`, body: `${SENT} body` });
  });

  it("Mila get_deal returns the stored subject", async () => {
    const deal = await getDealTool.execute(athleteId, { deal_id: dealId } as any);
    expect(JSON.stringify(deal)).toContain(`${SENT} subject`);
  });
});
