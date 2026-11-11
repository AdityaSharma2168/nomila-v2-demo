/**
 * "Save as contract" on mail ingested under MAILBOX_LIVE_READS: the PDF was never
 * rehosted, so the extract step reads it LIVE through the mailbox adapter (mocked here —
 * no test reaches Gmail) and writes nothing. A disconnected mailbox degrades to a clear
 * 404 with the reason, again writing nothing. The bucket is never touched. Outlook mail
 * runs through the REAL Outlook adapter over a fake Graph (global fetch).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/inboxAttachmentStore", () => ({
  ...jest.requireActual("../lib/inboxAttachmentStore"),
  getAttachment: jest.fn(async () => { throw new Error("bucket must not be read"); }),
  signedAttachmentUploadUrl: jest.fn(),
}));
// The real Outlook adapter's only dependency on the integration: a token. No test reaches Microsoft.
jest.mock("../lib/integrations/outlook", () => ({
  getAccessToken: jest.fn(async () => "graph-test-token"),
}));
jest.mock("../services/contractExtract", () => ({
  ...jest.requireActual("../services/contractExtract"),
  extractContract: jest.fn(async () => ({ status: "ok", extract: null })),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import contractsRouter from "./dealContracts";
import { extractContract } from "../services/contractExtract";
import { MailboxError, setMailboxAdapterForTests, type MailboxAdapter } from "../lib/mailbox";
import { deals, inboxThreads, inboxMessages, dealPeriods } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const extractMock = extractContract as jest.Mock;

let server: Server;
let base: string;
let athleteId: string;
let accountId: string;
let dealId: string;
let messageId: string;
const fetchAttachment = jest.fn();

const fake: MailboxAdapter = {
  provider: "gmail",
  fetchMessage: jest.fn(),
  fetchConversation: jest.fn(),
  fetchAttachment,
  search: jest.fn(),
};

beforeAll(async () => {
  await initTestDb();
  setMailboxAdapterForTests("gmail", fake);
  athleteId = await seedAthlete();
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  accountId = await seedConnection({ athleteId, platform: "gmail" });
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", status: "detected" } as any).returning({ id: deals.id });
  dealId = d.id;
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: dealId, subject: "Contract" } as any).returning({ id: inboxThreads.id });
  const [m] = await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", platform: "gmail",
    connected_account_id: accountId, external_message_id: "gm-1", gmail_thread_id: "gt-1", received_at: new Date(),
    attachments: [{ filename: "Acme_signed.pdf", content_type: "application/pdf", bytes: 10, attachment_ref: "2", parsed: true }],
  } as any).returning({ id: inboxMessages.id });
  messageId = m.id;

  const app = express();
  app.use(express.json());
  app.use("/", contractsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setMailboxAdapterForTests("gmail", undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(() => { fetchAttachment.mockReset(); extractMock.mockClear(); });

async function fromAttachment() {
  const res = await fetch(`${base}/deals/${dealId}/contract/from-attachment`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, index: 0 }),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

it("reads a non-rehosted attachment live from the mailbox and writes nothing", async () => {
  fetchAttachment.mockResolvedValue({ kind: "bytes", bytes: Buffer.from("%PDF"), filename: "Acme_signed.pdf", mimeType: "application/pdf" });
  const r = await fromAttachment();
  expect(r.status).toBe(200);
  expect(fetchAttachment).toHaveBeenCalledWith(accountId, "gm-1", "2", expect.objectContaining({ maxBytes: expect.any(Number) }));
  expect(extractMock).toHaveBeenCalledWith(expect.any(Buffer), "Acme_signed.pdf");
  expect(await db.select().from(dealPeriods)).toHaveLength(0);
});

it("a disconnected mailbox degrades with the reason, writes nothing", async () => {
  fetchAttachment.mockRejectedValue(new MailboxError("disconnected", "revoked"));
  const r = await fromAttachment();
  expect(r.status).toBe(404);
  expect(r.json.error).toBe("Conversation unavailable — reconnect Gmail");
  expect(extractMock).not.toHaveBeenCalled();
  expect(await db.select().from(dealPeriods)).toHaveLength(0);
});

// ── Outlook: the REAL outlookAdapter (via the registry) over a fake Graph on global fetch ──

describe("Outlook mail — read live through the real Outlook adapter", () => {
  const realFetch = globalThis.fetch;
  let outlookDealId: string;
  let outlookMessageId: string;
  let graphCalls: string[];
  let graphStatus: number;
  const FILE_REF = "AAMkAtt/file+1=";
  const LINK_REF = "AAMkAtt/link+2=";
  const MSG_REF = "AAMkMsg/1+x=";

  beforeAll(async () => {
    const outlookAccountId = await seedConnection({ athleteId, platform: "outlook" });
    const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Contoso", status: "detected" } as any).returning({ id: deals.id });
    outlookDealId = d.id;
    const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: outlookDealId, subject: "Contract" } as any).returning({ id: inboxThreads.id });
    const [m] = await db.insert(inboxMessages).values({
      thread_id: t.id, athlete_id: athleteId, direction: "inbound", platform: "outlook",
      connected_account_id: outlookAccountId, external_message_id: MSG_REF, gmail_thread_id: "AAQkConv=", received_at: new Date(),
      attachments: [
        { filename: "Contoso_signed.pdf", content_type: "application/pdf", bytes: 8, attachment_ref: FILE_REF, parsed: true },
        { filename: "Contoso_contract.pdf", content_type: "application/pdf", bytes: 8, attachment_ref: LINK_REF, parsed: false },
      ],
    } as any).returning({ id: inboxMessages.id });
    outlookMessageId = m.id;

    (globalThis as any).fetch = jest.fn(async (input: any, init?: any) => {
      const url = new URL(String(input));
      if (url.hostname !== "graph.microsoft.com") return realFetch(input, init);
      graphCalls.push(decodeURIComponent(url.pathname));
      const seg = url.pathname.replace(/^\/v1\.0\//, "").split("/").map(decodeURIComponent);
      if (graphStatus !== 200) return new Response("{}", { status: graphStatus });
      if (seg[2] !== MSG_REF) return new Response("{}", { status: 404 });
      if (seg.length === 4) {
        return new Response(JSON.stringify({ value: [
          { "@odata.type": "#microsoft.graph.fileAttachment", id: FILE_REF, name: "Contoso_signed.pdf", contentType: "application/pdf", size: 8, isInline: false },
          { "@odata.type": "#microsoft.graph.referenceAttachment", id: LINK_REF, name: "Contoso_contract.pdf", contentType: "application/pdf", size: 8, isInline: false },
        ] }), { status: 200 });
      }
      if (seg.length === 6 && seg[4] === FILE_REF && seg[5] === "$value") return new Response(Buffer.from("%PDF-1.7"), { status: 200 });
      return new Response("{}", { status: 405 });
    });
  });

  afterAll(() => { (globalThis as any).fetch = realFetch; });
  beforeEach(() => { graphCalls = []; graphStatus = 200; });

  async function fromOutlookAttachment(index: number) {
    const res = await realFetch(`${base}/deals/${outlookDealId}/contract/from-attachment`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: outlookMessageId, index }),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  }

  it("a file attachment is read live from Graph (/$value) and handed to the extractor; nothing written", async () => {
    const r = await fromOutlookAttachment(0);
    expect(r.status).toBe(200);
    expect(graphCalls).toContain(`/v1.0/me/messages/${MSG_REF}/attachments/${FILE_REF}/$value`);
    expect(extractMock).toHaveBeenCalledWith(Buffer.from("%PDF-1.7"), "Contoso_signed.pdf");
    expect(await db.select().from(dealPeriods)).toHaveLength(0);
  });

  it("a cloud-link attachment is never downloaded: a clear 404, nothing written", async () => {
    const r = await fromOutlookAttachment(1);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("That file can't be downloaded from your mailbox");
    expect(graphCalls.some((p) => p.endsWith("/$value"))).toBe(false);
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("a revoked Graph grant (401) degrades with the Outlook reason, nothing written", async () => {
    graphStatus = 401;
    const r = await fromOutlookAttachment(0);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("Conversation unavailable — reconnect Outlook");
    expect(extractMock).not.toHaveBeenCalled();
    expect(await db.select().from(dealPeriods)).toHaveLength(0);
  });
});
