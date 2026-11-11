/**
 * A10 — classifier LLM errors must not silently become NOISE.
 * classifyMessage retries transient failures; on exhaustion detectDeal skips with
 * a retryable classify_error (message NOT recorded), so a later retry can succeed.
 *
 * ── WHY THIS FILE MOCKS `lib/models` AND NOT JUST `lib/kimi` ────────────────
 * It used to mock only `lib/kimi`, and injected classifier failures by making `kimiInstant`
 * throw. That stopped testing anything when classification moved to Gemini: `classifyMessage`
 * calls `genai().models.generateContent` now, `kimiInstant` is only reached for SCORING, and
 * the failure injection was landing on a code path the classifier no longer uses.
 *
 * The consequence was worse than a skipped test. With `lib/models` unmocked, `genai()` picks up
 * Application Default Credentials — present on any developer machine that has run
 * `gcloud auth login` — so this suite was issuing REAL, BILLED calls to production Vertex on
 * every run. That is why one case "passed" (real Gemini classified the fixture happily,
 * ignoring the injected outage) while the other failed, and why the file took ~60s.
 *
 * So the Gemini path is mocked here, and the failure injection goes through it. Nothing in this
 * suite reaches the network. `lib/kimi` stays mocked for the scoring call that follows.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
jest.mock("../lib/models", () => {
  // One memoised client, so the test can reach the same mock the code under test calls.
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
import { inboxMessages, deals } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
/** The classifier's actual transport since the migration off Kimi. */
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } })
  .models.generateContent;

const PAID = {
  category: "PAID", confidence: 0.9, is_deal: true, brand_name: "Acme", brand_domain: "acme.com",
  advertiser: "Acme", agency_name: null, via_agency: false, summary: "Paid offer", offer_amount: 500,
  deliverables: ["1 IG post"], deadline: null, contact_name: "Sarah", contact_email: "sarah@acme.com",
};
const SCORE = {
  verdict: "good", scoreNumeric: 6, dollarAmount: 500, factors: {}, factorRatings: null,
  reasons: ["ok"], redFlags: [], fitRead: { rating: "good", label: "Good" },
  economicsState: { state: "priced", read: "$500" }, recommendation: "negotiate",
  recommendation_ui: "Counter", recommendation_agent: "Push", negotiate_terms: ["$600"],
  recommendation_confidence: "medium", urgency: "medium", autopilot_safe: false, draft_points: [], brandAnalysis: null,
};

let classifyCalls = 0;
let classifyFailures = 0; // number of classify attempts that should throw before succeeding

function gmailMessage(id: string, threadId: string) {
  return { gmailMessageId: id, gmailThreadId: threadId, subject: "Sponsorship", from: "Sarah <sarah@acme.com>", body: "We'll pay $500 for a post.", date: "2026-07-01T10:00:00Z", messageIdHeader: `<${id}@acme.com>` };
}

beforeAll(async () => {
  await initTestDb();

  // Classification — Gemini. `generateContent` resolves to an object whose `.text` the
  // classifier parses, so the mock returns that shape rather than the OpenAI-style envelope
  // the Kimi mock below uses.
  classifyMock.mockImplementation(async () => {
    classifyCalls++;
    if (classifyCalls <= classifyFailures) throw new Error("vertex 503");
    return { text: JSON.stringify(PAID) };
  });

  // Scoring — still Kimi, and reached only once classification has succeeded.
  kimiMock.mockImplementation(async () => ({
    choices: [{ message: { content: JSON.stringify(SCORE) } }],
  }));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

it("retries a transient classifier failure and still creates the deal", async () => {
  const aid = await seedAthlete();
  const conn = await seedConnection({ athleteId: aid });
  classifyCalls = 0; classifyFailures = 2; // throw twice, succeed on the 3rd attempt

  const r = await detectDeal({ athleteId: aid, connectionId: conn, message: gmailMessage("m1", "t1") });
  expect(r.skipped).toBe(false);
  const dealRows = await db.select().from(deals).where(eq(deals.athlete_id, aid));
  expect(dealRows).toHaveLength(1);
});

it("skips (classify_error, retryable) without recording the message when the classifier stays down; a later retry succeeds", async () => {
  const aid = await seedAthlete();
  const conn = await seedConnection({ athleteId: aid });

  classifyCalls = 0; classifyFailures = 99; // always down
  const r1 = await detectDeal({ athleteId: aid, connectionId: conn, message: gmailMessage("m2", "t2") });
  expect(r1.skipped).toBe(true);
  expect(r1.reason).toBe("classify_error");
  expect(r1.retryable).toBe(true);

  // The message must NOT be recorded — otherwise the idempotency gate would block the retry.
  const before = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m2"));
  expect(before).toHaveLength(0);

  // Outage over — the same message reprocesses cleanly.
  classifyCalls = 0; classifyFailures = 0;
  const r2 = await detectDeal({ athleteId: aid, connectionId: conn, message: gmailMessage("m2", "t2") });
  expect(r2.skipped).toBe(false);
  const after = await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "m2"));
  expect(after).toHaveLength(1);
});
