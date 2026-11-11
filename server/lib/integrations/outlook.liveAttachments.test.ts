/**
 * MAILBOX_LIVE_READS at Outlook ingest — the mirror of gmail.liveAttachments.test.ts.
 *
 * Flag on: a PDF on new mail is read in memory for its brief (so classification still sees
 * the terms) and recorded as an attachment REF (the Graph attachment id the Outlook mailbox
 * adapter reads live); nothing is copied to the bucket, a cloud link is never downloaded,
 * and an oversized PDF is not even fetched. Flag off: unchanged — no attachment calls, no
 * attachments on the message. Graph is a fake on global fetch; detectDeal is captured, so
 * nothing leaves the test.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../inboxAttachmentStore", () => ({
  ...jest.requireActual("../inboxAttachmentStore"),
  putAttachment: jest.fn(async () => { throw new Error("Outlook ingest must not rehost"); }),
}));
jest.mock("../pdfExtract", () => ({
  ...jest.requireActual("../pdfExtract"),
  extractPdfText: jest.fn(async () => "BRIEF TERMS"),
}));
jest.mock("../../skills/dealDetector", () => ({
  detectDeal: jest.fn(async () => ({ skipped: false, reason: "ok" })),
}));

import { eq } from "drizzle-orm";
import { syncRecent } from "./outlook";
import { putAttachment } from "../inboxAttachmentStore";
import { detectDeal } from "../../skills/dealDetector";
import { connectedAccounts } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";

const detectMock = detectDeal as jest.Mock;
const putMock = putAttachment as jest.Mock;

const CURSOR = "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=T0";

const MESSAGE = {
  id: "AAMkMsg/1+=",
  subject: "Brief",
  from: { emailAddress: { name: "Acme", address: "brand@acme.com" } },
  receivedDateTime: "2026-10-06T12:00:00Z",
  body: { contentType: "text", content: "see brief" },
  conversationId: "AAQkConv=",
  internetMessageId: "<m1@acme.com>",
  hasAttachments: true,
};

const ATTACHMENTS = [
  { "@odata.type": "#microsoft.graph.fileAttachment", id: "ATT/pdf=", name: "brief.pdf", contentType: "application/pdf", size: 8, isInline: false },
  { "@odata.type": "#microsoft.graph.referenceAttachment", id: "ATT/link=", name: "deck.pdf", contentType: "application/pdf", size: 8, isInline: false },
  { "@odata.type": "#microsoft.graph.fileAttachment", id: "ATT/huge=", name: "huge.pdf", contentType: "application/pdf", size: 50_000_000, isInline: false },
  { "@odata.type": "#microsoft.graph.fileAttachment", id: "ATT/logo=", name: "logo.png", contentType: "image/png", size: 100, isInline: true },
];

let athleteId: string;
let connectionId: string;
let graphCalls: string[];

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  connectionId = await seedConnection({ athleteId, platform: "outlook" });
});
afterAll(async () => {
  delete process.env.MAILBOX_LIVE_READS;
  await closeTestDb();
});

beforeEach(async () => {
  detectMock.mockClear();
  putMock.mockClear();
  graphCalls = [];
  await db.update(connectedAccounts).set({
    access_token: "tok", token_expires_at: new Date(Date.now() + 3600_000), sync_cursor: CURSOR,
  }).where(eq(connectedAccounts.id, connectionId));

  (globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.microsoft.com") throw new Error(`unexpected call ${url}`);
    graphCalls.push(decodeURIComponent(url.pathname));
    const seg = url.pathname.replace(/^\/v1\.0\//, "").split("/").map(decodeURIComponent);
    if (url.pathname.endsWith("/delta")) {
      return new Response(JSON.stringify({ value: [MESSAGE], "@odata.deltaLink": `${CURSOR}1` }), { status: 200 });
    }
    if (seg.length === 4 && seg[3] === "attachments") return new Response(JSON.stringify({ value: ATTACHMENTS }), { status: 200 });
    if (seg.length === 6 && seg[4] === "ATT/pdf=" && seg[5] === "$value") return new Response(Buffer.from("%PDF-1.4"), { status: 200 });
    return new Response("{}", { status: 405 });
  });
});

it("flag on: reads the brief in memory, records a Graph ref, rehosts nothing, never downloads a link or an oversized file", async () => {
  process.env.MAILBOX_LIVE_READS = "true";
  const r = await syncRecent(connectionId, athleteId);
  expect(r).toEqual({ detected: 1, skipped: 0 });

  const message = detectMock.mock.calls[0][0].message;
  expect(message).toMatchObject({ gmailMessageId: "AAMkMsg/1+=", platform: "outlook", attachmentText: "BRIEF TERMS" });
  expect(message.attachments).toEqual([
    { filename: "brief.pdf", content_type: "application/pdf", bytes: 8, attachment_ref: "ATT/pdf=", parsed: true },
  ]);
  expect(putMock).not.toHaveBeenCalled();
  const downloads = graphCalls.filter((p) => p.endsWith("/$value"));
  expect(downloads).toEqual(["/v1.0/me/messages/AAMkMsg/1+=/attachments/ATT/pdf=/$value"]);
});

it("flag on: plain mail (hasAttachments false) costs no attachment call", async () => {
  process.env.MAILBOX_LIVE_READS = "true";
  const plain = { ...MESSAGE, hasAttachments: false };
  (globalThis as any).fetch = jest.fn(async (input: any) => {
    graphCalls.push(new URL(String(input)).pathname);
    return new Response(JSON.stringify({ value: [plain], "@odata.deltaLink": `${CURSOR}1` }), { status: 200 });
  });
  await syncRecent(connectionId, athleteId);
  expect(graphCalls.filter((p) => p.includes("/attachments"))).toEqual([]);
  expect(detectMock.mock.calls[0][0].message.attachments).toBeUndefined();
});

it("flag on: an attachment failure skips the file, never the message", async () => {
  process.env.MAILBOX_LIVE_READS = "true";
  (globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/delta")) return new Response(JSON.stringify({ value: [MESSAGE], "@odata.deltaLink": `${CURSOR}1` }), { status: 200 });
    return new Response("{}", { status: 503 });
  });
  const r = await syncRecent(connectionId, athleteId);
  expect(r.detected).toBe(1);
  expect(detectMock.mock.calls[0][0].message.attachments).toBeUndefined();
});

it("flag off: unchanged — no attachment calls, no attachments, no brief", async () => {
  process.env.MAILBOX_LIVE_READS = "false";
  await syncRecent(connectionId, athleteId);
  const message = detectMock.mock.calls[0][0].message;
  expect(message.attachments).toBeUndefined();
  expect(message.attachmentText).toBeUndefined();
  expect(graphCalls.filter((p) => p.includes("/attachments"))).toEqual([]);
  expect(putMock).not.toHaveBeenCalled();
});
