/**
 * liveConversation.test.ts — MAILBOX_LIVE_READS end to end, against in-memory Postgres
 * (PGlite), with the MAILBOX ADAPTER BOUNDARY replaced by an in-memory fake. No test
 * reaches Gmail or Outlook; the real Gmail module is mocked out as a backstop.
 *
 * Every reader is exercised with the flag ON and must not read a stored body: each
 * stored body is a sentinel, AND every SQL statement is captured and checked for a
 * `body` column read on inbox_messages. Disconnected / deleted mailboxes must degrade
 * with NO state change (deal, thread, pending actions snapshot-compared). Flag OFF must
 * be today's behaviour (sentinel bodies, adapter never called).
 *
 * CONTRACT: the whole suite runs three times — against a Gmail-like fake, an Outlook-like
 * fake (ids with '/', '+', '='; conversation fetched by filtering a flat list and sorting
 * client-side; a cloud-link attachment that cannot be downloaded), and the REAL
 * outlookAdapter, loaded through the registry, talking to a fake Microsoft Graph on global
 * fetch (queued failures become Graph's 401 / 404 / 429 / 503). A reader that leans on a
 * Gmail-ism fails an Outlook pass; an adapter that breaks the contract fails the last.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(), kimiStream: jest.fn() }));
jest.mock("../lib/integrations/gmail", () => ({
  fetchMessageThreadingInfo: jest.fn(),
  sendGmailReply:            jest.fn(),
  refreshTokenIfNeeded:      jest.fn(async () => { throw new Error("tests never reach Gmail"); }),
}));
// The real Outlook adapter's only dependency on the integration: a token per account.
jest.mock("../lib/integrations/outlook", () => ({
  ...jest.requireActual("../lib/integrations/outlook"),
  getAccessToken: jest.fn(async (accountId: string) => `graph-tok:${accountId}`),
}));
jest.mock("../lib/pdfExtract", () => ({
  ...jest.requireActual("../lib/pdfExtract"),
  extractPdfText: jest.fn(async () => "BRIEF: $9,000 for 3 reels"),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import inboxRouter from "../routes/inbox";
import askTermsRouter from "../routes/askTerms";
import voiceThreadRouter from "../voice/threadRoutes";
import { summarizeThread } from "../skills/threadSummarizer";
import { generateDealDraft } from "./dealDraft";
import { requalifyAthlete } from "../scripts/opps/requalifyCore";
import { kimiInstant, kimiStream } from "../lib/kimi";
import {
  MailboxError,
  directionFor,
  setMailboxAdapterForTests,
  type MailboxAdapter,
  type MailboxErrorKind,
  type MailboxMessage,
  type MailboxProvider,
} from "../lib/mailbox";
import { connectedAccounts, deals, inboxMessages, inboxThreads, pendingActions } from "../../shared/schema";
import { client, db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiInstantMock = kimiInstant as jest.Mock;
const kimiStreamMock = kimiStream as jest.Mock;

const SENTINEL = "STORED-BODY-SENTINEL";
const SECRET = "voice-test-secret-0123456789";
const ATHLETE_EMAIL = "athlete@example.com";

// ─── The fake mailbox ────────────────────────────────────────────────────────

/** "graph" = the real outlookAdapter over a fake Microsoft Graph. */
type Style = "gmail" | "outlook" | "graph";

interface FakeRecord {
  account: string;
  id:      string;
  conv:    string;
  from:    string;
  subject: string;
  sentAt:  string;
  text:    string;
  attachments: MailboxMessage["attachments"];
}

/**
 * An in-memory MailboxAdapter. The Outlook style deliberately differs where Graph does:
 * ids are opaque immutable ids, a conversation is a FILTER over a flat message list
 * sorted client-side (no thread object), and attachments can be cloud links.
 */
function makeFake(provider: MailboxProvider, style: Style) {
  const records: FakeRecord[] = [];
  const own = new Map<string, string>();
  const failures = new Map<string, MailboxErrorKind[]>();   // accountId → queued failures
  const calls = { conversation: 0, message: 0, attachment: [] as string[] };

  // Each call consumes one queued failure; an empty queue answers normally.
  const fail = (accountId: string) => {
    const kind = failures.get(accountId)?.shift();
    if (kind) throw new MailboxError(kind, `fake ${kind}`);
  };
  const toMsg = (r: FakeRecord): MailboxMessage => {
    const m = r.from.match(/<([^>]+)>/);
    const fromEmail = (m ? m[1] : r.from).toLowerCase();
    return {
      ref: { provider, accountId: r.account, messageRef: r.id, conversationRef: r.conv, internetMessageId: `<${r.id}@x>` },
      from: r.from,
      fromEmail,
      fromName: r.from.match(/^([^<]+)</)?.[1].trim() ?? null,
      subject: r.subject,
      sentAt: r.sentAt,
      direction: directionFor(fromEmail, [own.get(r.account) ?? ""]),
      text: r.text,
      attachments: r.attachments,
    };
  };

  const adapter: MailboxAdapter = {
    provider,
    async fetchMessage(accountId, messageRef) {
      calls.message++;
      fail(accountId);
      const r = records.find((x) => x.account === accountId && x.id === messageRef);
      if (!r) throw new MailboxError("not_found", "gone");
      return toMsg(r);
    },
    async fetchConversation(accountId, conversationRef) {
      calls.conversation++;
      fail(accountId);
      const hits = style === "outlook"
        // Graph: GET /me/messages?$filter=conversationId eq '…', sorted here.
        ? records.filter((x) => x.account === accountId && x.conv === conversationRef)
            .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
        : records.filter((x) => x.account === accountId && x.conv === conversationRef);
      if (hits.length === 0) throw new MailboxError("not_found", "gone");
      return hits.map(toMsg);
    },
    async fetchAttachment(accountId, _messageRef, attachmentRef) {
      calls.attachment.push(attachmentRef);
      fail(accountId);
      return { kind: "bytes", bytes: Buffer.from("%PDF-fake"), filename: "brief.pdf", mimeType: "application/pdf" };
    },
    async search() { return []; },
  };
  return { adapter, records, own, failures, calls };
}

const GRAPH_STATUS: Record<MailboxErrorKind, number> = { disconnected: 401, not_found: 404, rate_limited: 429, transient: 503 };

/**
 * The same records served as Microsoft Graph would serve them, for the REAL outlookAdapter.
 * Global fetch is wrapped: graph.microsoft.com is answered here, everything else (the
 * test's own HTTP calls) goes to the real fetch. The account is read off the bearer token
 * (`graph-tok:<accountId>`, minted by the getAccessToken mock). Queued failures are
 * consumed by the same calls the in-memory fake consumes them on, as Graph HTTP errors.
 */
function makeGraphFake() {
  const base = makeFake("outlook", "outlook");
  const { records, own, failures, calls } = base;
  const realFetch = globalThis.fetch;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const failed = (accountId: string) => {
    const kind = failures.get(accountId)?.shift();
    if (!kind) return null;
    return json(GRAPH_STATUS[kind], { error: { code: kind } }, kind === "rate_limited" ? { "retry-after": "0" } : {});
  };
  const graphMessage = (r: FakeRecord) => {
    const m = r.from.match(/^\s*([^<]*?)\s*<([^>]+)>/);
    return {
      id: r.id,
      subject: r.subject,
      from: { emailAddress: { name: m ? m[1] : "", address: m ? m[2] : r.from } },
      receivedDateTime: r.sentAt,
      body: { contentType: "text", content: r.text },
      conversationId: r.conv,
      internetMessageId: `<${r.id}@x>`,
      hasAttachments: r.attachments.length > 0,
      isDraft: false,
      parentFolderId: "FOLDER-inbox",
    };
  };

  async function graph(url: URL, accountId: string): Promise<Response> {
    // Raw pathname split first, so an encoded '/' inside an id stays inside its segment.
    const seg = url.pathname.replace(/^\/v1\.0\//, "").split("/").map(decodeURIComponent);
    if (seg.join("/") === "me") return json(200, { mail: own.get(accountId) });
    if (seg[1] === "mailFolders") return json(200, { id: `FOLDER-${seg[2]}` });
    if (seg[0] !== "me" || seg[1] !== "messages") return json(400, { error: { code: "UnexpectedPath" } });

    const mine = records.filter((r) => r.account === accountId);
    if (seg.length === 2) {
      // GET /me/messages?$filter=conversationId eq '…' — flat list, NOT in sent order.
      calls.conversation++;
      const f = failed(accountId);
      if (f) return f;
      const conv = url.searchParams.get("$filter")?.match(/^conversationId eq '(.*)'$/)?.[1]?.replace(/''/g, "'");
      return json(200, { value: mine.filter((r) => r.conv === conv).map(graphMessage) });
    }
    const rec = mine.find((r) => r.id === seg[2]);
    if (seg.length === 3) {
      calls.message++;
      const f = failed(accountId);
      if (f) return f;
      return rec ? json(200, graphMessage(rec)) : json(404, { error: { code: "ErrorItemNotFound" } });
    }
    if (!rec) return json(404, { error: { code: "ErrorItemNotFound" } });
    if (seg.length === 4 && seg[3] === "attachments") {
      return json(200, {
        value: rec.attachments.map((a) => ({
          "@odata.type": a.kind === "link" ? "#microsoft.graph.referenceAttachment" : "#microsoft.graph.fileAttachment",
          id: a.attachmentRef, name: a.filename, contentType: a.mimeType, size: a.size, isInline: false,
        })),
      });
    }
    if (seg.length === 6 && seg[5] === "$value") {
      calls.attachment.push(seg[4]);
      const f = failed(accountId);
      if (f) return f;
      const att = rec.attachments.find((a) => a.attachmentRef === seg[4]);
      if (!att) return json(404, { error: { code: "ErrorItemNotFound" } });
      return att.kind === "link" ? json(405, {}) : new Response(Buffer.from("%PDF-fake"), { status: 200 });
    }
    return json(400, { error: { code: "UnexpectedPath" } });
  }

  const install = () => {
    (globalThis as any).fetch = jest.fn(async (input: any, init?: any) => {
      const url = new URL(String(input));
      if (url.hostname !== "graph.microsoft.com") return realFetch(input, init);
      const auth = String(init?.headers?.Authorization ?? "");
      return graph(url, auth.replace(/^Bearer graph-tok:/, ""));
    });
  };
  const uninstall = () => { (globalThis as any).fetch = realFetch; };
  return { records, own, failures, calls, install, uninstall };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let server: Server;
let base: string;
let seq = 0;

const PROVIDERS: { provider: MailboxProvider; style: Style; label: string; id: (n: number) => string }[] = [
  { provider: "gmail",   style: "gmail",   label: "Gmail",   id: (n) => `18c0f${n}a2b` },
  { provider: "outlook", style: "outlook", label: "Outlook", id: (n) => `AAMkAGI2T/${n}+Q=AAA=` },
  { provider: "outlook", style: "graph",   label: "Outlook", id: (n) => `AAMkAGI2T/${n}+R=AAA=` },
];

/** The brand's brief on the inbound message: a downloadable file, except the Outlook fake's cloud link. */
const briefOf = (style: Style) =>
  style === "gmail"   ? { attachmentRef: "1", kind: "file" as const }
  : style === "graph" ? { attachmentRef: "AAMkAtt/1+=", kind: "file" as const }
  :                     { attachmentRef: "AAMkAtt/1=", kind: "link" as const };

/** SQL captured while `fn` runs. */
async function captureSql<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const seen: string[] = [];
  const orig = client.query.bind(client);
  const spy = jest.spyOn(client, "query").mockImplementation(((q: any, ...rest: any[]) => {
    seen.push(String(q));
    return (orig as any)(q, ...rest);
  }) as any);
  try {
    return { result: await fn(), sql: seen };
  } finally {
    spy.mockRestore();
  }
}

/** True when a statement reads inbox_messages.body. */
function readsStoredBody(sql: string[]): string | undefined {
  return sql.find((s) => /from "inbox_messages"/i.test(s) && /"body"/.test(s) && /^\s*select/i.test(s));
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, cache: res.headers.get("cache-control"), json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  await initTestDb();
  process.env.VOICE_SERVICE_SECRET = SECRET;
  process.env.MAILBOX_RETRY_BASE_MS = "1";
  const app = express();
  app.use(express.json());
  app.use("/", inboxRouter);
  app.use("/", askTermsRouter);
  app.use("/", voiceThreadRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setMailboxAdapterForTests("gmail", undefined);
  setMailboxAdapterForTests("outlook", undefined);
  delete process.env.MAILBOX_LIVE_READS;
  await closeTestDb();
});

describe.each(PROVIDERS)("MAILBOX_LIVE_READS readers — $label mailbox ($style)", ({ provider, style, label, id }) => {
  let fake: Pick<ReturnType<typeof makeFake>, "records" | "own" | "failures" | "calls">;
  let graph: ReturnType<typeof makeGraphFake> | null = null;
  let athleteId: string;
  let accountId: string;
  let dealId: string;
  let threadId: string;
  let inboundRef: string;
  let outboundRef: string;
  let conv: string;

  beforeAll(async () => {
    if (style === "graph") {
      // No override: the registry must hand out the REAL outlookAdapter.
      graph = makeGraphFake();
      graph.install();
      fake = graph;
      setMailboxAdapterForTests(provider, undefined);
    } else {
      const f = makeFake(provider, style);
      fake = f;
      setMailboxAdapterForTests(provider, f.adapter);
    }
  });

  afterAll(() => { graph?.uninstall(); });

  beforeEach(async () => {
    process.env.MAILBOX_LIVE_READS = "true";
    kimiInstantMock.mockReset();
    kimiStreamMock.mockReset();
    fake.records.length = 0;
    fake.failures.clear();
    fake.calls.conversation = 0;
    fake.calls.message = 0;
    fake.calls.attachment.length = 0;

    const n = ++seq;
    athleteId = await seedAthlete(`Athlete ${n}`);
    (globalThis as any).__TEST_ATHLETE_ID = athleteId;
    accountId = await seedConnection({ athleteId, platform: provider, email: ATHLETE_EMAIL });
    fake.own.set(accountId, ATHLETE_EMAIL);
    conv = style === "gmail" ? `thr${n}` : `AAQkAGI2T/conv${n}=`;
    inboundRef = id(n * 10 + 1);
    outboundRef = id(n * 10 + 2);

    const [deal] = await db.insert(deals)
      .values({ athlete_id: athleteId, brand_name: "Acme", status: "negotiating", amount: null } as any)
      .returning({ id: deals.id });
    dealId = deal.id;
    const [thread] = await db.insert(inboxThreads).values({
      athlete_id: athleteId, subject: "Collab?", deal_id: dealId, status: "unread",
      connected_account_id: accountId, external_thread_id: conv, last_message_at: new Date(),
      conversation_state: { conversation_state: "Prior state.", summary: "Prior summary." },
    } as any).returning({ id: inboxThreads.id });
    threadId = thread.id;

    const row = (direction: "inbound" | "outbound", ext: string, minute: number) => ({
      thread_id: threadId, athlete_id: athleteId, direction,
      sender_email: direction === "inbound" ? "jordan@acme.com" : null,
      sender_name:  direction === "inbound" ? "Stored Name" : null,
      subject: "Collab?", body: SENTINEL, platform: provider,
      external_message_id: ext, gmail_thread_id: conv, connected_account_id: accountId,
      received_at: new Date(Date.UTC(2026, 9, 1, 0, minute)),
    });
    await db.insert(inboxMessages).values([row("inbound", inboundRef, 1), row("outbound", outboundRef, 2)] as any);

    // The mailbox: the brand's pitch with a brief, then her reply. The Outlook fake's brief
    // is a cloud LINK (no bytes); Gmail's and the Graph pass's are files.
    fake.records.push(
      {
        account: accountId, id: inboundRef, conv, from: "Jordan Lee <jordan@acme.com>", subject: "Collab?",
        sentAt: "2026-10-01T00:01:00.000Z", text: "LIVE-INBOUND: we can do $7,500 for 2 reels",
        attachments: [{ ...briefOf(style), filename: "brief.pdf", mimeType: "application/pdf", size: 1000 }],
      },
      {
        account: accountId, id: outboundRef, conv, from: `Me <${ATHLETE_EMAIL}>`, subject: "Re: Collab?",
        sentAt: "2026-10-01T00:02:00.000Z", text: "LIVE-OUTBOUND: sounds great", attachments: [],
      },
    );
    if (style !== "gmail") fake.records.reverse();   // Graph order is not sent order
  });

  async function snapshot() {
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId));
    const pa = await db.select({ id: pendingActions.id }).from(pendingActions).where(eq(pendingActions.athlete_id, athleteId));
    const [c] = await db.select({ status: connectedAccounts.status }).from(connectedAccounts).where(eq(connectedAccounts.id, accountId));
    return JSON.stringify({ d, t, pa: pa.length, c });
  }

  // ── Thread / conversation view ─────────────────────────────────────────────

  describe("GET /inbox/threads/:id", () => {
    it("flag on: reads the conversation live, oldest first, no stored body, no-store", async () => {
      const { result: r, sql } = await captureSql(() => api("GET", `/inbox/threads/${threadId}`));
      expect(r.status).toBe(200);
      expect(r.cache).toBe("no-store");
      expect(r.json.conversation).toEqual({ available: true });
      expect(r.json.messages.map((m: any) => m.body)).toEqual([
        "LIVE-INBOUND: we can do $7,500 for 2 reels",
        "LIVE-OUTBOUND: sounds great",
      ]);
      expect(r.json.messages.map((m: any) => m.direction)).toEqual(["inbound", "outbound"]);
      expect(JSON.stringify(r.json)).not.toContain(SENTINEL);
      expect(readsStoredBody(sql)).toBeUndefined();
    });

    it("disconnected mailbox: degrades with a reconnect message and changes nothing", async () => {
      await db.update(connectedAccounts).set({ status: "revoked" }).where(eq(connectedAccounts.id, accountId));
      const before = await snapshot();
      const r = await api("GET", `/inbox/threads/${threadId}`);
      expect(r.status).toBe(200);
      expect(r.json.messages).toEqual([]);
      expect(r.json.conversation).toMatchObject({ available: false, reason: "disconnected", message: `Conversation unavailable — reconnect ${label}` });
      expect(fake.calls.conversation).toBe(0);
      expect(await snapshot()).toBe(before);
    });

    it("deleted in the mailbox: says so and changes nothing", async () => {
      fake.records.length = 0;
      const before = await snapshot();
      const r = await api("GET", `/inbox/threads/${threadId}`);
      expect(r.json.conversation).toMatchObject({ available: false, reason: "not_found", message: `This email was deleted in ${label}` });
      expect(await snapshot()).toBe(before);
    });

    it("flag off: unchanged — stored bodies, no adapter call, no conversation key", async () => {
      process.env.MAILBOX_LIVE_READS = "false";
      const { result: r, sql } = await captureSql(() => api("GET", `/inbox/threads/${threadId}`));
      expect(r.json.messages.map((m: any) => m.body)).toEqual([SENTINEL, SENTINEL]);
      // Proves the detector the flag-on tests rely on actually sees a body read.
      expect(readsStoredBody(sql)).toBeDefined();
      expect(r.json.conversation).toBeUndefined();
      expect(fake.calls.conversation).toBe(0);
    });
  });

  // ── Thread summarizer ──────────────────────────────────────────────────────

  describe("summarizeThread", () => {
    const STATE = { conversation_state: "Agreed $7.5K.", deal_stage: "negotiating", key_details: {}, summary: "s" };

    it("flag on: live transcript, provenance ids recorded, no stored body", async () => {
      kimiInstantMock.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(STATE) } }] });
      const { result, sql } = await captureSql(() => summarizeThread(threadId));
      expect(result).not.toBeNull();
      const transcript = kimiInstantMock.mock.calls[0][1] as string;
      expect(transcript).toContain("LIVE-INBOUND");
      expect(transcript).toContain("LIVE-OUTBOUND");
      expect(transcript).not.toContain(SENTINEL);
      expect(readsStoredBody(sql)).toBeUndefined();
      // A downloadable PDF brief is read live; a cloud link never is.
      if (briefOf(style).kind === "file") {
        expect(transcript).toContain("BRIEF: $9,000");
        expect(fake.calls.attachment).toEqual([briefOf(style).attachmentRef]);
      } else {
        expect(transcript).not.toContain("BRIEF:");
        expect(fake.calls.attachment).toEqual([]);
      }
      const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId));
      expect((t.conversation_state as any).source_message_ids).toEqual([inboundRef, outboundRef]);
      expect(typeof (t.conversation_state as any).derived_at).toBe("string");
      expect((t.conversation_state as any).key_details.awaiting_response_from).toBe("brand");
    });

    it("transient failures retry with backoff, then succeed", async () => {
      kimiInstantMock.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(STATE) } }] });
      fake.failures.set(accountId, ["transient", "rate_limited"]);
      expect(await summarizeThread(threadId)).not.toBeNull();
      expect(fake.calls.conversation).toBe(3);
    });

    it.each(["disconnected", "not_found", "transient"] as const)(
      "%s: writes nothing — summary, deal and turn state untouched, no model call",
      async (kind) => {
        fake.failures.set(accountId, Array(5).fill(kind));
        const before = await snapshot();
        expect(await summarizeThread(threadId)).toBeNull();
        expect(kimiInstantMock).not.toHaveBeenCalled();
        expect(await snapshot()).toBe(before);
      },
    );

    it("flag off: unchanged transcript (stored bodies) and provenance from stored ids", async () => {
      process.env.MAILBOX_LIVE_READS = "false";
      kimiInstantMock.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(STATE) } }] });
      await summarizeThread(threadId);
      expect(kimiInstantMock.mock.calls[0][1]).toContain(SENTINEL);
      expect(fake.calls.conversation).toBe(0);
      const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId));
      expect((t.conversation_state as any).source_message_ids).toEqual([inboundRef, outboundRef]);
    });
  });

  // ── Reply drafter ──────────────────────────────────────────────────────────

  describe("generateDealDraft", () => {
    async function* streamOf(parts: string[]) {
      for (const p of parts) yield { choices: [{ delta: { content: p } }] } as any;
    }
    const params = () => ({ athleteId, dealId, replyIntent: "accept" as const, style: "friendly" as const, voice: "athlete" as const });

    it("flag on: drafts from the live thread and greets the live sender", async () => {
      kimiStreamMock.mockImplementation(async () => streamOf(["Thanks for the details on the reels."]));
      const { result, sql } = await captureSql(() => generateDealDraft(params()));
      expect(result.ok).toBe(true);
      const prompt = JSON.stringify(kimiStreamMock.mock.calls[0][0]);
      expect(prompt).toContain("LIVE-INBOUND");
      expect(prompt).not.toContain(SENTINEL);
      expect(readsStoredBody(sql)).toBeUndefined();
      expect(result.ok && result.fullText).toMatch(/Jordan/);
      expect(result.ok && result.fullText).not.toMatch(/Stored Name/);
    });

    it.each(["disconnected", "not_found"] as const)("%s: drafting pauses with the reason, nothing written", async (kind) => {
      fake.failures.set(accountId, Array(5).fill(kind));
      const before = await snapshot();
      const result = await generateDealDraft(params());
      expect(result).toMatchObject({ ok: false, reason: "mailbox_unavailable" });
      expect(!result.ok && "message" in result && result.message).toContain(label);
      expect(kimiStreamMock).not.toHaveBeenCalled();
      expect(await snapshot()).toBe(before);
    });

    it("flag off: unchanged — stored bodies", async () => {
      process.env.MAILBOX_LIVE_READS = "false";
      kimiStreamMock.mockImplementation(async () => streamOf(["Thanks."]));
      await generateDealDraft(params());
      expect(JSON.stringify(kimiStreamMock.mock.calls[0][0])).toContain(SENTINEL);
      expect(fake.calls.conversation).toBe(0);
    });
  });

  // ── Ask-terms draft context ────────────────────────────────────────────────

  describe("POST /deals/ask-terms-batch", () => {
    it("flag on: the greeting uses the live sender name", async () => {
      const { result: r, sql } = await captureSql(() => api("POST", "/deals/ask-terms-batch", { dealIds: [dealId] }));
      expect(r.status).toBe(201);
      expect(r.json.created).toHaveLength(1);
      expect(r.json.created[0].payload.body).toMatch(/Jordan/);
      expect(r.json.created[0].payload.body).not.toMatch(/Stored Name/);
      expect(readsStoredBody(sql)).toBeUndefined();
    });

    it("deleted in the mailbox: skipped with a reason, no proposal, nothing changed", async () => {
      fake.records.length = 0;
      const before = await snapshot();
      const r = await api("POST", "/deals/ask-terms-batch", { dealIds: [dealId] });
      expect(r.json.created).toHaveLength(0);
      expect(r.json.skipped).toEqual([{ deal_id: dealId, reason: "mailbox_unavailable" }]);
      expect(await snapshot()).toBe(before);
    });

    it("flag off: unchanged — stored sender name", async () => {
      process.env.MAILBOX_LIVE_READS = "false";
      const r = await api("POST", "/deals/ask-terms-batch", { dealIds: [dealId] });
      expect(r.json.created[0].payload.body).toMatch(/Stored/);
      expect(fake.calls.conversation).toBe(0);
    });
  });

  // ── Voice deal brief (get_thread) ──────────────────────────────────────────

  describe("voice GET /athletes/:id/deals/:dealId/thread", () => {
    const path = () => `/athletes/${athleteId}/deals/${dealId}/thread`;
    const auth = { "x-voice-secret": SECRET };

    it("flag on: the brand's words come from the mailbox", async () => {
      const { result: r, sql } = await captureSql(() => api("GET", path(), undefined, auth));
      expect(r.status).toBe(200);
      expect(r.json.messages.map((m: any) => m.body)).toEqual(["LIVE-INBOUND: we can do $7,500 for 2 reels", "LIVE-OUTBOUND: sounds great"]);
      expect(r.json.messages[0].from).toBe("Jordan Lee");
      expect(JSON.stringify(r.json)).not.toContain(SENTINEL);
      expect(readsStoredBody(sql)).toBeUndefined();
    });

    it("disconnected: 503 with the reason, nothing changed", async () => {
      await db.update(connectedAccounts).set({ status: "expired" }).where(eq(connectedAccounts.id, accountId));
      const before = await snapshot();
      const r = await api("GET", path(), undefined, auth);
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ code: "MAILBOX_UNAVAILABLE", reason: "disconnected" });
      expect(await snapshot()).toBe(before);
    });

    it("flag off: unchanged — stored bodies", async () => {
      process.env.MAILBOX_LIVE_READS = "false";
      const r = await api("GET", path(), undefined, auth);
      expect(r.json.messages.map((m: any) => m.body)).toEqual([SENTINEL, SENTINEL]);
    });
  });

  // ── requalifyCore ──────────────────────────────────────────────────────────

  describe("requalifyAthlete", () => {
    const cls = { category: "PAID", confidence: 0.9, is_deal: true, deliverables: [], model_qualification: null } as any;

    it("flag on: classifies the live message (with its brief), no stored body read", async () => {
      const classify = jest.fn(async () => cls);
      const { result: report, sql } = await captureSql(() => requalifyAthlete({ dbx: db, athleteId, limit: 5, classify }));
      expect(report.examined).toBe(1);
      const [from, subject, body] = classify.mock.calls[0] as unknown as string[];
      expect(from).toBe("Jordan Lee <jordan@acme.com>");
      expect(subject).toBe("Collab?");
      expect(body).toContain("LIVE-INBOUND");
      expect(body).not.toContain(SENTINEL);
      expect(readsStoredBody(sql)).toBeUndefined();
    });

    it("deleted: reported as an error row, never classified, nothing written", async () => {
      fake.records.length = 0;
      const classify = jest.fn(async () => cls);
      const before = await snapshot();
      const report = await requalifyAthlete({ dbx: db, athleteId, limit: 5, classify });
      expect(classify).not.toHaveBeenCalled();
      expect(report.rows[0]).toMatchObject({ flag_action: "error", error: `This email was deleted in ${label}` });
      expect(await snapshot()).toBe(before);
    });

    it("flag off: unchanged — stored body", async () => {
      process.env.MAILBOX_LIVE_READS = "false";
      const classify = jest.fn(async () => cls);
      await requalifyAthlete({ dbx: db, athleteId, limit: 5, classify });
      expect((classify.mock.calls[0] as unknown as string[])[2]).toBe(SENTINEL);
      expect(fake.calls.message).toBe(0);
    });
  });
});

describe("providers without a live adapter keep the stored path", () => {
  it("an Instagram thread reads stored bodies even with the flag on", async () => {
    process.env.MAILBOX_LIVE_READS = "true";
    const athleteId = await seedAthlete("IG Athlete");
    (globalThis as any).__TEST_ATHLETE_ID = athleteId;
    const ig = await seedConnection({ athleteId, platform: "instagram", email: "athlete_ig" });
    const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, subject: "DM", connected_account_id: ig } as any).returning({ id: inboxThreads.id });
    await db.insert(inboxMessages).values({
      thread_id: t.id, athlete_id: athleteId, direction: "inbound", body: SENTINEL, platform: "instagram",
      connected_account_id: ig, external_message_id: "ig-1", received_at: new Date(),
    } as any);
    const r = await api("GET", `/inbox/threads/${t.id}`);
    expect(r.json.messages.map((m: any) => m.body)).toEqual([SENTINEL]);
    expect(r.json.conversation).toBeUndefined();
  });
});
