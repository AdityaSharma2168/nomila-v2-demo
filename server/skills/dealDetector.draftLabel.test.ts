/**
 * dealDetector.draftLabel.test.ts — unsent mail must never enter a thread.
 *
 * Gmail assigns a NEW message id on every draft autosave, so one reply being composed
 * reaches ingest as a stream of near-identical messages. The DRAFT/TRASH/SPAM filter
 * lived only in fetchMessagesByHistoryId, so the POLLING path had none — and Mia's
 * gorjana thread ended up with nine rows from a single 90-second compose, rendered in
 * "view full conversation" as if they had been sent (the self-sender gate files
 * athlete-addressed mail as OUTBOUND).
 *
 * This covers the backstop inside detectDeal, which no future fetch path can bypass.
 *
 * Real SQL against in-memory Postgres (PGlite); Kimi and brand resolution are mocked at
 * the module boundary (same as the other detector tests).
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
import { inboxMessages, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
/** Classification's actual transport since the migration off Kimi. */
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

const PAID = {
  category: "PAID", confidence: 0.9, is_deal: true,
  brand_name: "Gorjana", brand_domain: "gorjana.com",
  advertiser: null, agency_name: null, via_agency: false,
  summary: "Partnership proposal", offer_amount: 5000,
  deliverables: ["1 reel"], deadline: null, contact_name: "Avery", contact_email: "avery@solsticejewelry.test",
};

const SCORE_RESPONSE = {
  verdict: "good", scoreNumeric: 7, dollarAmount: 5000,
  factors: { rateComparison: "n/a", brandRelevance: "fits", deliverableScope: "light", exclusivity: "none" },
  factorRatings: null, reasons: ["solid"], redFlags: [],
  fitRead: { rating: "good", label: "Good fit" },
  economicsState: { state: "priced", read: "$5000 stated" },
  recommendation: "negotiate", recommendation_ui: "Counter",
  recommendation_agent: "Push.", negotiate_terms: ["$6000"],
  recommendation_confidence: "medium", urgency: "medium",
  autopilot_safe: false, draft_points: ["mention the reel"], brandAnalysis: null,
};

function gmailMessage(id: string, threadId: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId:  id,
    gmailThreadId:   threadId,
    subject:         "Partnership Proposal",
    from:            "Avery <avery@solsticejewelry.test>",
    body:            "We would love to work with you on a paid partnership.",
    date:            "2026-07-31T13:42:00Z",
    messageIdHeader: `<${id}@mail.gmail.com>`,
    ...over,
  };
}

let athleteId: string;
let connectionId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  connectionId = await seedConnection({ athleteId, email: "rileyathlete@gmail.com" });

  // Classification — Gemini. The classifier reads `.text`, not an OpenAI envelope.
  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(PAID) }));
  // Scoring — still Kimi, reached only after classification succeeds.
  kimiMock.mockImplementation(async () => ({
    choices: [{
      message: {
        content: JSON.stringify(SCORE_RESPONSE),
      },
    }],
  }));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100)); // let fire-and-forget chains settle
  await closeTestDb();
});

describe("detectDeal — label gate", () => {
  it("skips a DRAFT before any Kimi call, storing no thread or message", async () => {
    kimiMock.mockClear();

    const result = await detectDeal({
      athleteId,
      connectionId,
      message: gmailMessage("d1", "t-draft", { labelIds: ["DRAFT"] }),
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("label_draft");
    // The gate sits ahead of classification — a draft must not cost a model call.
    expect(kimiMock).not.toHaveBeenCalled();

    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "d1"));
    expect(msgs).toHaveLength(0);
    const threads = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "t-draft"));
    expect(threads).toHaveLength(0);
  });

  it.each(["TRASH", "SPAM"])("skips %s too", async (label) => {
    const result = await detectDeal({
      athleteId,
      connectionId,
      message: gmailMessage(`x-${label}`, `t-${label}`, { labelIds: [label] }),
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe(`label_${label.toLowerCase()}`);
  });

  it("still ingests ordinary INBOX mail", async () => {
    const result = await detectDeal({
      athleteId,
      connectionId,
      message: gmailMessage("ok1", "t-ok", { labelIds: ["INBOX", "UNREAD"] }),
    });

    expect(result.skipped).toBe(false);
    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "ok1"));
    expect(msgs).toHaveLength(1);
  });

  it("ingests mail with no labels at all (Instagram, legacy fetch paths)", async () => {
    const result = await detectDeal({
      athleteId,
      connectionId,
      message: gmailMessage("ok2", "t-ok2"), // no labelIds key
    });

    expect(result.skipped).toBe(false);
    const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "ok2"));
    expect(msgs).toHaveLength(1);
  });

  it("does not treat a draft-shaped autosave burst as several messages", async () => {
    // Four autosaves of one reply: distinct Gmail ids, same thread, growing body.
    for (const [i, body] of ["Hi Jenn,", "Hi Jenn,\nCongrats", "Hi Jenn,\nCongratulations!", "Hi Jenn,\nCongratulations! It wo"].entries()) {
      await detectDeal({
        athleteId,
        connectionId,
        message: gmailMessage(`burst-${i}`, "t-burst", { labelIds: ["DRAFT"], body }),
      });
    }

    const threads = await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, "t-burst"));
    expect(threads).toHaveLength(0);
  });
});
