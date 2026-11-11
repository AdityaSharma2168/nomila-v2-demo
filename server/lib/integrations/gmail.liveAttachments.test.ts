/**
 * MAILBOX_LIVE_READS at ingest: a PDF on new mail is read in memory for its brief (so
 * classification still sees the terms) but is NOT rehosted to the bucket. The message
 * row records an attachment ref instead; the file stays in the mailbox. Flag off keeps
 * today's rehosting. Global fetch and the bucket are mocked — nothing leaves the test.
 */

// fetchFullMessage never queries; a stub keeps PGlite from booting (and outliving the suite).
jest.mock("../../db", () => ({ db: {}, pool: { end: async () => {} } }));
jest.mock("../inboxAttachmentStore", () => ({
  ...jest.requireActual("../inboxAttachmentStore"),
  putAttachment: jest.fn(async () => true),
}));
jest.mock("../pdfExtract", () => ({
  ...jest.requireActual("../pdfExtract"),
  extractPdfText: jest.fn(async () => "BRIEF TERMS"),
}));

import { fetchFullMessage } from "./gmail";
import { putAttachment } from "../inboxAttachmentStore";

const putMock = putAttachment as jest.Mock;

function respond(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

const MESSAGE = {
  id: "m1",
  threadId: "t1",
  internalDate: "1790000000000",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: "brand@acme.com" }, { name: "Subject", value: "Brief" }],
    parts: [
      { partId: "0", mimeType: "text/plain", filename: "", body: { data: Buffer.from("see brief").toString("base64url") } },
      { partId: "1", mimeType: "application/pdf", filename: "brief.pdf", body: { attachmentId: "A1", size: 2000 } },
    ],
  },
};

beforeEach(() => {
  putMock.mockClear();
  (globalThis as any).fetch = jest.fn()
    .mockResolvedValueOnce(respond(MESSAGE))
    .mockResolvedValueOnce(respond({ data: Buffer.from("%PDF-1.4").toString("base64") }));
});

afterAll(() => { delete process.env.MAILBOX_LIVE_READS; });

it("flag on: reads the brief, stores a ref, rehosts nothing", async () => {
  process.env.MAILBOX_LIVE_READS = "true";
  const msg = await fetchFullMessage("tok", "m1", "athlete-1");
  expect(msg?.attachmentText).toBe("BRIEF TERMS");
  expect(putMock).not.toHaveBeenCalled();
  expect(msg?.attachments).toEqual([
    { filename: "brief.pdf", content_type: "application/pdf", bytes: 8, attachment_ref: "1", parsed: true },
  ]);
});

it("flag off: unchanged — the PDF is rehosted to the bucket", async () => {
  process.env.MAILBOX_LIVE_READS = "false";
  const msg = await fetchFullMessage("tok", "m1", "athlete-1");
  expect(putMock).toHaveBeenCalledTimes(1);
  expect(msg?.attachments[0]).toMatchObject({ filename: "brief.pdf", parsed: true });
  expect(msg?.attachments[0].gcs_path).toMatch(/^athletes\/athlete-1\/inbox\//);
  expect(msg?.attachments[0].attachment_ref).toBeUndefined();
});
