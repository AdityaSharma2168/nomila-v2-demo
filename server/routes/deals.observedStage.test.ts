/**
 * The summarizer's deal_stage is an OBSERVATION: it no longer moves deals.status, and the deals API
 * exposes it read-only as `observed_stage` (plus any paperwork matched to the deal). Readers that
 * only display or protect use max(status, observed). Real Express router + PGlite; Kimi mocked.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(), kimiStream: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import dealsRouter from "./deals";
import { summarizeThread } from "../skills/threadSummarizer";
import { kimiInstant } from "../lib/kimi";
import { effectiveDealStatus } from "../lib/observedStage";
import { isValuableOpportunity } from "../skills/archiveStaleDeals";
import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;

let server: Server;
let base: string;
let athleteId: string;

async function seedDeal(brand: string, status = "detected") {
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: brand, status, source: "inbox_scan", detected_at: new Date(),
  } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, subject: "Partnership", status: "deal_detected",
  } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", sender_email: "lee@brand.test",
    body: "Contract attached — please sign.", received_at: new Date(), platform: "gmail",
  } as any);
  return { dealId: d.id as string, threadId: t.id as string };
}

function summarizerSays(stage: string) {
  kimiMock.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({
      conversation_state: "Contract sent for signature.", offer_display: null, deal_stage: stage,
      key_details: {}, summary: "The brand sent the contract.",
    }) } }],
  });
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
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

describe("summary stage is observed, not promoted", () => {
  it("a 'signed' read leaves status alone and is exposed as observed_stage on the list and the detail", async () => {
    const { dealId, threadId } = await seedDeal("Signedlook");
    summarizerSays("signed");
    await summarizeThread(threadId);

    expect((await db.select().from(deals).where(eq(deals.id, dealId)))[0].status).toBe("detected");
    expect(((await db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId)))[0].conversation_state as any).deal_stage).toBe("signed");

    const list = await get(`/deals?id=${dealId}`);
    expect(list.json[0]).toMatchObject({ status: "detected", observed_stage: "signed", paperwork: [] });

    const detail = await get(`/deals/${dealId}`);
    expect(detail.json).toMatchObject({ observed_stage: "signed", paperwork: [] });
    expect(detail.json.deal.status).toBe("detected");
  });

  it("paperwork matched to a deal is listed on it, read-only", async () => {
    const { dealId } = await seedDeal("Paperco", "negotiating");
    await db.insert(inboxThreads).values({
      athlete_id: athleteId, subject: "Completed: Paperco agreement", status: "unread", last_message_at: new Date("2026-09-04T12:00:00Z"),
      classification: { paperwork: { state: "matched", kind: "status", event: "completed", deal_id: dealId, source_message_ids: [], observed_at: "2026-09-04T12:00:00.000Z" } },
    } as any);
    const list = await get(`/deals?id=${dealId}`);
    expect(list.json).toHaveLength(1);   // the paperwork thread never duplicates the deal row
    expect(list.json[0].paperwork).toEqual([expect.objectContaining({ event: "completed" })]);
    expect(list.json[0].status).toBe("negotiating");
  });
});

describe("max(status, observed) — display / protect only", () => {
  it("forward-only, never off a terminal or unknown status", () => {
    expect(effectiveDealStatus("detected", { deal_stage: "agreed" })).toBe("negotiating");
    expect(effectiveDealStatus("detected", { deal_stage: "signed" })).toBe("accepted");
    expect(effectiveDealStatus("accepted", { deal_stage: "negotiating" })).toBe("accepted");
    expect(effectiveDealStatus("rejected", { deal_stage: "signed" })).toBe("rejected");
    expect(effectiveDealStatus("detected", { deal_stage: "outreach" })).toBe("detected");
    expect(effectiveDealStatus("detected", null)).toBe("detected");
  });

  it("the sweep's value check counts an observed negotiation as worked", () => {
    const m = { dealStatus: "detected", dealType: null, amountCash: null, classification: null };
    expect(isValuableOpportunity([m], null)).toBe(false);
    expect(isValuableOpportunity([{ ...m, conversationState: { deal_stage: "negotiating" } }], null)).toBe(true);
  });
});
