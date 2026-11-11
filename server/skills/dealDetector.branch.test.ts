/**
 * A NEW subject inside an old conversation (docs/design/brand-page-deals.md D6), through the real detector against
 * PGlite. Same mailbox + new provider thread id + known In-Reply-To parent → the same-engagement partition runs
 * (mocked here — tests never reach a model); SEPARATE → her pitch becomes its own thread, deal (direction outbound)
 * and opportunity; doubt → the old alias, with the decision recorded (never the subject); a second mailbox is the
 * dual-inbox alias and asks nothing.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
jest.mock("../lib/models", () => {
  const generateContent = jest.fn();
  const client = { models: { generateContent } };
  return { genai: () => client, GEMINI: { flash: "f", flashLite: "fl", pro: "p" }, KIMI: { vertexModel: "k", moonshotModel: "k" } };
});
jest.mock("../lib/brandResolver", () => ({ resolveBrandIdentity: jest.fn(async () => null) }));
jest.mock("./threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));
jest.mock("./researchBrand", () => ({ researchBrand: jest.fn(async () => undefined) }));
jest.mock("./dealGrouping", () => ({ partitionOrNull: jest.fn(async () => null), adoptGroupForNewDeal: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { genai } from "../lib/models";
import { partitionOrNull } from "./dealGrouping";
import { deals, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;
const partition = partitionOrNull as jest.Mock;

const PAID = {
  category: "PAID", confidence: 0.9, is_deal: true, brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
  agency_name: null, via_agency: false, summary: "Endorsement agreement", offer_amount: 500, deliverables: ["posts"],
  deadline: null, contact_name: "Sarah", contact_email: "sarah@acme.com",
};

let athleteId = "";
let inboxA = "";
let inboxB = "";

function msg(id: string, threadId: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId: id, gmailThreadId: threadId, subject: "Endorsement", from: "Sarah <sarah@acme.com>",
    body: "Here is the agreement.", date: "2026-08-01T10:00:00Z", messageIdHeader: `<${id}@acme.com>`, ...over,
  };
}

/** A brand thread with a deal, minted through the detector itself. */
async function parent(id: string, thread: string, connectionId: string) {
  const r = await detectDeal({ athleteId, connectionId, message: msg(id, thread) });
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
  const [d] = await db.select().from(deals).where(eq(deals.id, t.deal_id!));
  return { threadId: t.id, deal: d };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  inboxA = await seedConnection({ athleteId, email: "mia-a@gmail.com" });
  inboxB = await seedConnection({ athleteId, email: "mia-b@gmail.com" });
  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(PAID) }));
});
afterAll(async () => { await closeTestDb(); });
beforeEach(() => partition.mockReset());

it("a brand-minted deal records direction inbound", async () => {
  partition.mockResolvedValue(null);
  const p = await parent("dir-1", "t-dir", inboxA);
  expect(p.deal.direction).toBe("inbound");
});

it("SEPARATE: her new-subject pitch in the same mailbox becomes its own thread, deal (Pitched by you) and opportunity", async () => {
  const p = await parent("sep-1", "t-sep", inboxA);
  partition.mockImplementation(async (rows: any[]) => [[rows[0]], rows.slice(1)]);
  const r = await detectDeal({
    athleteId, connectionId: inboxA,
    message: msg("sep-2", "t-sep-pitch", { from: "Mia <mia-a@gmail.com>", subject: "Charity 5K sponsorship", body: "Would you sponsor our 5K?", inReplyToHeader: "<sep-1@acme.com>", date: "2026-10-05T10:00:00Z" }),
  });
  expect(r.reason).toBe("branch_pitch");
  expect(partition).toHaveBeenCalledTimes(1);
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, r.threadId!));
  expect(t.external_thread_id).toBe("t-sep-pitch");
  expect((t.classification as any).branch).toMatchObject({ from_thread_id: p.threadId, decision: "separate" });
  expect(JSON.stringify((t.classification as any).branch)).not.toMatch(/5K|Charity/);
  const [d] = await db.select().from(deals).where(eq(deals.id, r.dealId!));
  expect(d.direction).toBe("outbound");
  expect(d.opportunity_id).not.toBeNull();
  expect(d.opportunity_id).not.toBe(p.deal.opportunity_id);
  const [pt] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, p.threadId));
  expect(pt.alias_thread_ids ?? []).not.toContain("t-sep-pitch");
});

it("DOUBT: the partition can't tell → folded in as before, the decision recorded on the parent (no subject)", async () => {
  const p = await parent("same-1", "t-same", inboxA);
  partition.mockResolvedValue(null);
  const r = await detectDeal({
    athleteId, connectionId: inboxA,
    message: msg("same-2", "t-same-2", { from: "Mia <mia-a@gmail.com>", subject: "Re: Endorsement (new subject)", body: "Posting Friday.", inReplyToHeader: "<same-1@acme.com>" }),
  });
  expect(r.reason).toBe("self_reply_recorded");
  expect(r.threadId).toBe(p.threadId);
  const [pt] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, p.threadId));
  expect(pt.alias_thread_ids).toContain("t-same-2");
  expect((pt.classification as any).branches["t-same-2"]).toMatchObject({ decision: "same" });
  expect(JSON.stringify((pt.classification as any).branches)).not.toMatch(/subject|Posting/);
});

it("another mailbox is the dual-inbox case: alias, no decision asked", async () => {
  const p = await parent("dual-1", "t-dual", inboxA);
  const r = await detectDeal({
    athleteId, connectionId: inboxB,
    message: msg("dual-2", "t-dual-b", { from: "Mia <mia-b@gmail.com>", body: "From my other inbox.", inReplyToHeader: "<dual-1@acme.com>" }),
  });
  expect(partition).not.toHaveBeenCalled();
  expect(r.threadId).toBe(p.threadId);
});
