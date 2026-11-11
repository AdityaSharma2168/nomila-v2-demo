/**
 * dealDetector duplicate-thread hardening (A5) — real SQL against PGlite.
 *
 * Two guarantees:
 *   1. The 0010 migration collapses pre-existing duplicate (athlete, external_thread)
 *      threads into one, merging messages + deals, and then the unique index blocks
 *      new dupes. Runs the real migration file, twice, to prove idempotency.
 *   2. detectDeal never produces two threads/deals for one email, whether the same
 *      message is redelivered or two invocations race it concurrently.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
// Classification runs on Gemini, not Kimi. Without this mock `genai()` picks up Application
// Default Credentials and this suite issues real, billed calls to production Vertex — which
// is what it did until 24d84d0. See dealDetector.classifyRetry.test.ts for the full account.
jest.mock("../lib/models", () => {
  const generateContent = jest.fn();
  const client = { models: { generateContent } };
  return {
    genai: () => client,
    GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
    KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
  };
});
jest.mock("../lib/brandResolver", () => ({ resolveBrandIdentity: jest.fn(async () => null) }));
jest.mock("./threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));
jest.mock("./researchBrand", () => ({ researchBrand: jest.fn(async () => undefined) }));

import * as fs from "fs";
import * as path from "path";
import { eq } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { kimiInstant } from "../lib/kimi";
import { genai } from "../lib/models";
import { inboxThreads, inboxMessages, deals } from "../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
/** Classification's actual transport since the migration off Kimi. */
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

const PAID_CLASSIFICATION = {
  category: "PAID", confidence: 0.9, is_deal: true,
  brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
  agency_name: null, via_agency: false,
  summary: "Paid sponsorship offer", offer_amount: 500,
  deliverables: ["1 IG post"], deadline: null,
  contact_name: "Sarah", contact_email: "sarah@acme.com",
};

const SCORE_RESPONSE = {
  verdict: "good", scoreNumeric: 6, dollarAmount: 500,
  factors: {}, factorRatings: null, reasons: ["solid"], redFlags: [],
  fitRead: { rating: "good", label: "Good fit" },
  economicsState: { state: "priced", read: "$500" },
  recommendation: "negotiate", recommendation_ui: "Counter", recommendation_agent: "Push.",
  negotiate_terms: ["$600"], recommendation_confidence: "medium", urgency: "medium",
  autopilot_safe: false, draft_points: ["mention post"], brandAnalysis: null,
};

let nextClassification: Record<string, unknown> = PAID_CLASSIFICATION;
let nextScoreResponse: Record<string, unknown> = SCORE_RESPONSE;

function gmailMessage(id: string, threadId: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId: id, gmailThreadId: threadId,
    subject: "Sponsorship opportunity", from: "Sarah <sarah@acme.com>",
    body: "We'd love to pay you $500 for one Instagram post.",
    date: "2026-07-01T10:00:00Z", messageIdHeader: `<${id}@mail.acme.com>`,
    ...over,
  };
}

beforeAll(async () => {
  await initTestDb();
  // Classification — Gemini. The classifier reads `.text`, not an OpenAI envelope.
  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(nextClassification) }));
  // Scoring — still Kimi, reached only after classification succeeds.
  kimiMock.mockImplementation(async () => ({
    choices: [{ message: { content: JSON.stringify(nextScoreResponse) } }],
  }));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

describe("0010 migration — dedups duplicate threads", () => {
  it("merges a duplicate (athlete, external_thread) pair into one thread + one deal", async () => {
    const aid = await seedAthlete();
    // Simulate the pre-migration state: drop the unique index so dupes can exist.
    await client.exec(`DROP INDEX IF EXISTS uniq_threads_athlete_external`);

    const [dealKeep] = await db.insert(deals).values({ athlete_id: aid, brand_name: "Acme", status: "detected", source: "inbox_scan" }).returning({ id: deals.id });
    const [dealDup]  = await db.insert(deals).values({ athlete_id: aid, brand_name: "Acme", status: "detected", source: "inbox_scan" }).returning({ id: deals.id });

    const older = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-07-01T00:05:00Z");
    const [tKeep] = await db.insert(inboxThreads).values({ athlete_id: aid, external_thread_id: "gt-dup", deal_id: dealKeep.id, created_at: older, message_count: 1 }).returning({ id: inboxThreads.id });
    const [tDup]  = await db.insert(inboxThreads).values({ athlete_id: aid, external_thread_id: "gt-dup", deal_id: dealDup.id, created_at: newer, message_count: 1 }).returning({ id: inboxThreads.id });

    await db.insert(inboxMessages).values({ thread_id: tKeep.id, athlete_id: aid, external_message_id: "mA", direction: "inbound", received_at: older });
    await db.insert(inboxMessages).values({ thread_id: tKeep.id, athlete_id: aid, external_message_id: "mB", direction: "inbound", received_at: older });
    await db.insert(inboxMessages).values({ thread_id: tDup.id,  athlete_id: aid, external_message_id: "mA", direction: "inbound", received_at: newer }); // collides with keeper's mA
    await db.insert(inboxMessages).values({ thread_id: tDup.id,  athlete_id: aid, external_message_id: "mC", direction: "inbound", received_at: newer });

    const sql = fs.readFileSync(path.join(__dirname, "../../migrations/0010_thread_dedup_unique.sql"), "utf-8");
    await client.exec(sql);

    const threads = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "gt-dup"));
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(tKeep.id);
    expect(threads[0].message_count).toBe(3);

    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, tKeep.id));
    expect(msgs.map((m) => m.external_message_id).sort()).toEqual(["mA", "mB", "mC"]);

    const remaining = await db.select().from(deals).where(eq(deals.athlete_id, aid));
    expect(remaining.map((d) => d.id)).toEqual([dealKeep.id]); // dupe's deal removed

    // Idempotent re-run + the unique index now blocks new dupes.
    await client.exec(sql);
    const after = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "gt-dup"));
    expect(after).toHaveLength(1);
    await expect(
      db.insert(inboxThreads).values({ athlete_id: aid, external_thread_id: "gt-dup" }),
    ).rejects.toThrow();
  });
});

describe("detectDeal — no duplicate threads/deals for one email", () => {
  it("redelivery of the same message: one thread, one deal, second skips", async () => {
    const aid  = await seedAthlete();
    const conn = await seedConnection({ athleteId: aid });
    nextClassification = PAID_CLASSIFICATION;

    const msg = gmailMessage("redeliver", "gt-redeliver");
    const r1 = await detectDeal({ athleteId: aid, connectionId: conn, message: msg });
    const r2 = await detectDeal({ athleteId: aid, connectionId: conn, message: msg });

    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(true);

    const threads = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "gt-redeliver"));
    expect(threads).toHaveLength(1);
    const dealRows = await db.select().from(deals).where(eq(deals.athlete_id, aid));
    expect(dealRows).toHaveLength(1);
  });

  it("concurrent processing of the same message: one thread, one deal", async () => {
    const aid  = await seedAthlete();
    const conn = await seedConnection({ athleteId: aid });
    nextClassification = PAID_CLASSIFICATION;

    const msg = gmailMessage("concurrent", "gt-concurrent");
    const results = await Promise.all([
      detectDeal({ athleteId: aid, connectionId: conn, message: msg }),
      detectDeal({ athleteId: aid, connectionId: conn, message: msg }),
    ]);

    const threads = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "gt-concurrent"));
    expect(threads).toHaveLength(1);
    const dealRows = await db.select().from(deals).where(eq(deals.athlete_id, aid));
    expect(dealRows).toHaveLength(1);
    expect(results.filter((r) => r.skipped)).toHaveLength(1); // exactly one did the work
  });
});
