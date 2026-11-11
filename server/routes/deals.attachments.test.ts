/**
 * Deal attachments — the PDF a brand sent must be listable and openable from the
 * deal card, and must NOT be reachable by another athlete.
 *
 * Real Express router against PGlite; auth and GCS signing mocked (signing needs a
 * service-account key, so it can't run outside Cloud Run).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));
jest.mock("../lib/inboxAttachmentStore", () => ({
  signedAttachmentUrl: jest.fn(async (p: string) => `https://signed.example/${p}?sig=abc`),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import dealsRouter from "./deals";
import { signedAttachmentUrl } from "../lib/inboxAttachmentStore";
import { deals, inboxThreads, inboxMessages, type InboxAttachment } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

function asUser(id: string) { (globalThis as any).__TEST_ATHLETE_ID = id; }

const BRIEF: InboxAttachment = {
  filename: "gorjana-proposal.pdf", content_type: "application/pdf",
  bytes: 4_600_000, gcs_path: "athletes/a/inbox/deadbeef/gorjana-proposal.pdf", parsed: true,
};
const HUGE: InboxAttachment = {
  filename: "lookbook.pdf", content_type: "application/pdf",
  bytes: 18_000_000, gcs_path: "athletes/a/inbox/cafe/lookbook.pdf", parsed: false,
};

/** A deal with a thread, and one message carrying `attachments`. */
async function seedDealWithAttachments(aid: string, attachments: InboxAttachment[] | null) {
  const [d] = await db.insert(deals).values({
    athlete_id: aid, brand_name: "gorjana", status: "detected", source: "inbox_scan",
  }).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: aid, deal_id: d.id, subject: "Partnership", status: "deal_detected",
  }).returning({ id: inboxThreads.id });
  const [m] = await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: aid, direction: "inbound", subject: "Partnership",
    body: "Please see the attached proposal.", received_at: new Date(), attachments,
  }).returning({ id: inboxMessages.id });
  return { dealId: d.id, threadId: t.id, messageId: m.id };
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId      = await seedAthlete();
  otherAthleteId = await seedAthlete();
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

beforeEach(() => { asUser(athleteId); (signedAttachmentUrl as jest.Mock).mockClear(); });

describe("GET /deals/:id — attachments list", () => {
  it("surfaces attachments without leaking the GCS path", async () => {
    const { dealId, messageId } = await seedDealWithAttachments(athleteId, [BRIEF]);
    const { status, json } = await get(`/deals/${dealId}`);

    expect(status).toBe(200);
    expect(json.attachments).toEqual([{
      messageId, index: 0, filename: "gorjana-proposal.pdf",
      contentType: "application/pdf", bytes: 4_600_000, parsed: true,
      receivedAt: expect.any(String),
    }]);
    // The object location is internal — the signed-url endpoint is the only way in.
    expect(JSON.stringify(json.attachments)).not.toContain("gcs_path");
    expect(JSON.stringify(json.attachments)).not.toContain("athletes/a/inbox");
  });

  it("is an empty list — not an error — when the deal has no attachments", async () => {
    const { dealId } = await seedDealWithAttachments(athleteId, null);
    const { status, json } = await get(`/deals/${dealId}`);
    expect(status).toBe(200);
    expect(json.attachments).toEqual([]);
  });

  it("marks a stored-but-unparsed PDF so the card can say its terms were not read", async () => {
    const { dealId } = await seedDealWithAttachments(athleteId, [HUGE]);
    const { json } = await get(`/deals/${dealId}`);
    expect(json.attachments[0].parsed).toBe(false);
  });

  it("dedupes the same file arriving on two messages of one thread", async () => {
    const { dealId, threadId } = await seedDealWithAttachments(athleteId, [BRIEF]);
    // A Fwd: of the original carries the identical brief.
    await db.insert(inboxMessages).values({
      thread_id: threadId, athlete_id: athleteId, direction: "inbound",
      subject: "Fwd: Partnership", body: "fwd", received_at: new Date(), attachments: [BRIEF],
    });
    const { json } = await get(`/deals/${dealId}`);
    expect(json.attachments).toHaveLength(1);
  });
});

describe("GET /deals/:id/attachments/:messageId/:index/url", () => {
  it("mints a signed URL for the owner", async () => {
    const { dealId, messageId } = await seedDealWithAttachments(athleteId, [BRIEF]);
    const { status, json } = await get(`/deals/${dealId}/attachments/${messageId}/0/url`);

    expect(status).toBe(200);
    expect(json.url).toContain("signed.example");
    expect(json.filename).toBe("gorjana-proposal.pdf");
    expect(signedAttachmentUrl).toHaveBeenCalledWith(BRIEF.gcs_path);
  });

  it("404s for another athlete — a guessed messageId must not resolve", async () => {
    const { dealId, messageId } = await seedDealWithAttachments(athleteId, [BRIEF]);
    asUser(otherAthleteId);

    const { status } = await get(`/deals/${dealId}/attachments/${messageId}/0/url`);
    expect(status).toBe(404);
    expect(signedAttachmentUrl).not.toHaveBeenCalled();
  });

  it("404s on an out-of-range index and on non-UUID ids instead of throwing", async () => {
    const { dealId, messageId } = await seedDealWithAttachments(athleteId, [BRIEF]);
    expect((await get(`/deals/${dealId}/attachments/${messageId}/7/url`)).status).toBe(404);
    expect((await get(`/deals/${dealId}/attachments/${messageId}/-1/url`)).status).toBe(404);
    expect((await get(`/deals/${dealId}/attachments/not-a-uuid/0/url`)).status).toBe(404);
  });

  it("404s when the message belongs to a different deal", async () => {
    const a = await seedDealWithAttachments(athleteId, [BRIEF]);
    const b = await seedDealWithAttachments(athleteId, [BRIEF]);
    // b's message under a's deal id — the join must reject the mismatch.
    expect((await get(`/deals/${a.dealId}/attachments/${b.messageId}/0/url`)).status).toBe(404);
  });
});
