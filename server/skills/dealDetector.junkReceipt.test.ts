/**
 * dealDetector.junkReceipt.test.ts — ISSUE-9: Mila's auto-handling of inbound junk
 * is logged to `agent_actions` so The Week's "Set aside by Nomila" receipt populates.
 *
 * Real SQL against in-memory Postgres (PGlite); Kimi, brand resolution, and thread
 * summarization are mocked at the module boundary (same as the ingest tests).
 *
 * Covers:
 *   - a NEW inbound the classifier confidently calls NOISE logs exactly one `file`
 *     agent_action with the junk reason/payload (and no thread/deal/message row);
 *   - a scoreable deal (PAID) logs NOTHING to agent_actions (it flows to the Brief);
 *   - FAN mail logs nothing (kept off the receipt on purpose);
 *   - an uncertain NOISE (high deal-probability) logs nothing;
 *   - a redelivered junk message logs nothing (idempotent — junk isn't in
 *     inbox_messages, so the log itself is the idempotency gate).
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

import { eq } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { kimiInstant } from "../lib/kimi";
import { genai } from "../lib/models";
import { agentActions, inboxMessages, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
/** Classification's actual transport since the migration off Kimi. */
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

// What the classifier / scorer "return" for the next message — switched per test.
let nextClassification: Record<string, unknown>;
let nextScoreResponse: Record<string, unknown>;

// confidence here is P(genuine deal): ≤0.3 is a CONFIDENT-junk verdict per the rubric.
const JUNK_NOISE = {
  category: "NOISE", confidence: 0.15, is_deal: false,
  noise_reason: "Retail marketing blast",
  brand_name: "MegaMart", brand_domain: "mkt.megamart.com",
  advertiser: null, agency_name: null, via_agency: false,
  summary: "Weekend sale announcement", offer_amount: null,
  deliverables: [], deadline: null, contact_name: null, contact_email: null,
};

const PAID_CLASSIFICATION = {
  category: "PAID", confidence: 0.9, is_deal: true,
  brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
  agency_name: null, via_agency: false,
  summary: "Paid sponsorship offer", offer_amount: 500,
  deliverables: ["1 IG post"], deadline: null,
  contact_name: "Sarah", contact_email: "sarah@acme.com",
};

const FAN_CLASSIFICATION = {
  category: "FAN", confidence: 0.1, is_deal: false,
  noise_reason: "Fan message", brand_name: null, brand_domain: null,
  advertiser: null, agency_name: null, via_agency: false,
  summary: "You're my favorite!", offer_amount: null,
  deliverables: [], deadline: null, contact_name: null, contact_email: null,
};

const SCORE_RESPONSE = {
  verdict: "good", scoreNumeric: 6, dollarAmount: 500,
  factors: { rateComparison: "n/a", brandRelevance: "fits", deliverableScope: "light", exclusivity: "none" },
  factorRatings: null, reasons: ["solid offer"], redFlags: [],
  fitRead: { rating: "good", label: "Good fit" },
  economicsState: { state: "priced", read: "$500 stated" },
  recommendation: "negotiate", recommendation_ui: "Counter at $600",
  recommendation_agent: "Push on rate.", negotiate_terms: ["$600 flat"],
  recommendation_confidence: "medium", urgency: "medium",
  autopilot_safe: false, draft_points: ["mention the post"], brandAnalysis: null,
};

// A benign, prefilter-passing sender so we always reach the classifier (which is
// mocked). The CATEGORY is the mock's to decide — but the body still has to be real
// enough to reach it. structuralNonDeal() files anything under MIN_READABLE_BODY (25
// readable chars, subject included) as "empty" BEFORE the classifier is ever called, so
// the old placeholder — "Hello" + "Some message body." = 24 — short-circuited every case
// here to `nothing to evaluate (24 chars)`. That is the pre-filter working as designed;
// the fixture simply predated it.
function gmailMessage(id: string, threadId: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId:  id,
    gmailThreadId:   threadId,
    subject:         "Hello",
    from:            "Sender <hello@example.com>",
    body:            "Some message body that clears the emptiness gate.",
    date:            "2026-07-01T10:00:00Z",
    messageIdHeader: `<${id}@mail.example.com>`,
    ...over,
  };
}

let athleteId: string;
let inboxA: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  inboxA = await seedConnection({ athleteId, email: "inbox-a@gmail.com" });

  // Classification — Gemini. The classifier reads `.text`, not an OpenAI envelope.
  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(nextClassification) }));
  // Scoring — still Kimi, reached only after classification succeeds.
  kimiMock.mockImplementation(async () => ({
    choices: [{
      message: {
        content: JSON.stringify(
          nextScoreResponse,
        ),
      },
    }],
  }));
});

beforeEach(() => {
  nextScoreResponse = SCORE_RESPONSE;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100)); // let fire-and-forget chains settle
  await closeTestDb();
});

async function junkRows() {
  return db
    .select()
    .from(agentActions)
    .where(eq(agentActions.athlete_id, athleteId));
}

describe("detectDeal — junk auto-handling receipt (ISSUE-9)", () => {
  it("logs one `file` agent_action when a NEW inbound is confidently NOISE", async () => {
    nextClassification = JUNK_NOISE;

    const before = (await junkRows()).length;
    const result = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("j1", "tj1") });

    // Skipped as junk — no thread / message / deal created.
    expect(result.skipped).toBe(true);
    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "j1"));
    expect(msgs).toHaveLength(0);
    const threads = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "tj1"));
    expect(threads).toHaveLength(0);

    // …but the receipt log gained exactly one row with the junk shape.
    const rows = (await junkRows()).filter((r) => (r.payload as any)?.external_message_id === "j1");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe("file");
    expect(row.reversible).toBe(false);
    expect(row.reason).toBe("Retail marketing blast");
    expect(row.deal_id).toBeNull();
    expect(row.thread_id).toBeNull();
    expect(row.payload).toMatchObject({
      kind: "junk",
      category: "NOISE",
      brand_name: "MegaMart",
      external_message_id: "j1",
    });
    // An athlete-facing record, never a training sample: no message content is kept.
    for (const k of ["sample_from", "sample_subject", "sample_body"]) expect(row.payload).not.toHaveProperty(k);

    // Net: exactly one new receipt row overall.
    expect((await junkRows()).length).toBe(before + 1);
  });

  it("logs NOTHING for a scoreable deal (it flows to the Brief, not the receipt)", async () => {
    nextClassification = PAID_CLASSIFICATION;

    const before = (await junkRows()).length;
    const result = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("p1", "tp1") });

    expect(result.skipped).toBe(false);
    expect(result.dealId).toBeDefined();
    expect((await junkRows()).length).toBe(before); // no receipt row for a real deal
  });

  it("logs NOTHING for FAN mail (kept off the receipt on purpose)", async () => {
    nextClassification = FAN_CLASSIFICATION;

    const before = (await junkRows()).length;
    const result = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("f1", "tf1") });

    expect(result.skipped).toBe(true);
    expect((await junkRows()).length).toBe(before);
  });

  it("logs NOTHING for an UNCERTAIN NOISE (high deal-probability is not confident junk)", async () => {
    nextClassification = { ...JUNK_NOISE, confidence: 0.5 }; // > 0.35 floor → uncertainty

    const before = (await junkRows()).length;
    const result = await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("u1", "tu1") });

    expect(result.skipped).toBe(true);
    expect((await junkRows()).length).toBe(before);
  });

  it("is idempotent — a redelivered junk message logs no second row", async () => {
    nextClassification = JUNK_NOISE;

    await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("j2", "tj2") });
    const afterFirst = (await junkRows()).filter((r) => (r.payload as any)?.external_message_id === "j2").length;
    expect(afterFirst).toBe(1);

    // Same gmail message id redelivered (Pub/Sub is at-least-once). Junk is never in
    // inbox_messages, so gate 1a can't catch it — the receipt log is the gate.
    await detectDeal({ athleteId, connectionId: inboxA, message: gmailMessage("j2", "tj2") });
    const afterSecond = (await junkRows()).filter((r) => (r.payload as any)?.external_message_id === "j2").length;
    expect(afterSecond).toBe(1);
  });
});
