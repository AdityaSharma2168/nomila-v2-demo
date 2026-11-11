/**
 * Paperwork (e-sign / payment mail) — matched deterministically to an existing deal or held for
 * her; never a deal, never an opportunity. Against PGlite; the classify provider, Kimi, the
 * summarizer, brand research and the brand resolver are mocked at their boundaries, so nothing
 * reaches a provider.
 *
 *   · unmatched paperwork is held: a marker on the thread, no deal, no opportunity
 *   · each deterministic match: a name in the document title, the "X sent you a document" line,
 *     the sender's organisation domain stated in the body, the only contract-stage opportunity
 *   · a contradiction holds it rather than guessing
 *   · end to end: a reminder attaches to the existing deal with no new deal row; a later
 *     "Completed" on the same envelope updates the observation; status never moves
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(async () => ({ choices: [{ message: { content: "{}" } }] })) }));
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
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { matchPaperwork, placePaperwork, paperworkEvent, nameCandidateKeys, statedDomains } from "./paperwork";
import { detectDeal } from "./dealDetector";
import { genai } from "../lib/models";
import { kimiInstant } from "../lib/kimi";
import { resolveBrandIdentity } from "../lib/brandResolver";
import { summarizeThread } from "./threadSummarizer";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;
const resolverMock = resolveBrandIdentity as jest.Mock;
const kimiMock = kimiInstant as jest.Mock;
const summarizerMock = summarizeThread as jest.Mock;

let seq = 0;
const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

async function brand(name: string, domain: string | null = null): Promise<number> {
  const [b] = await db.insert(inboxBrands)
    .values({ name, normalized_name: name.toLowerCase(), domain } as any)
    .returning({ id: inboxBrands.id });
  return b.id;
}

/** An opportunity with one deal and its brand thread. `stage` is the summarizer's observed read. */
async function engagement(athleteId: string, brandId: number, opts: { status?: string; stage?: string; oppStatus?: "open" | "closed"; closeReason?: string } = {}) {
  const closed = opts.oppStatus === "closed";
  const [o] = await db.insert(opportunities).values({
    athlete_id: athleteId, brand_id: brandId, status: closed ? "closed" : "open",
    close_reason: closed ? opts.closeReason ?? "expired" : null, closed_at: closed ? day("2026-08-01") : null,
    opened_at: day("2026-07-01"), last_activity_at: day("2026-07-01"),
  } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_id: brandId, brand_name: `Brand ${brandId}`, status: opts.status ?? "detected",
    detected_at: day("2026-07-01"), source: "inbox_scan", opportunity_id: o.id,
  } as any).returning({ id: deals.id });
  await db.insert(inboxThreads).values({
    athlete_id: athleteId, brand_id: brandId, deal_id: d.id, subject: "Partnership", status: "deal_detected",
    conversation_state: opts.stage ? { deal_stage: opts.stage } : null,
  } as any);
  return { opportunityId: o.id as string, dealId: d.id as string };
}

/** A provider thread with one message, as ingest stores it before placement. */
async function envelope(athleteId: string, subject: string, body: string) {
  const [t] = await db.insert(inboxThreads).values({ athlete_id: athleteId, subject, status: "unread" } as any)
    .returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", subject, body,
    received_at: day("2026-09-04"), external_message_id: `pw-${++seq}`, platform: "gmail",
  } as any);
  return t.id as string;
}

const place = (athleteId: string, threadId: string, subject: string, body = "", senderDomain = "docusign.net") =>
  placePaperwork({ athleteId, threadId, senderDomain, subject, body });

const threadRow = async (id: string) => (await db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0];
const oppCount = async (athleteId: string) => (await db.select().from(opportunities).where(eq(opportunities.athlete_id, athleteId))).length;
const dealCount = async (athleteId: string) => (await db.select().from(deals).where(eq(deals.athlete_id, athleteId))).length;

beforeAll(async () => {
  await initTestDb();
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

describe("reading the mail (pure)", () => {
  it("names the event from the provider's own words", () => {
    expect(paperworkEvent("docusign.net", "Please DocuSign: Agreement.pdf", "")).toEqual({ kind: "signature_request", event: "signature_requested" });
    expect(paperworkEvent("docusign.net", "Reminder: Please DocuSign: Agreement.pdf", "")).toEqual({ kind: "signature_request", event: "reminder" });
    expect(paperworkEvent("adobesign.com", "Completed: Agreement", "")).toEqual({ kind: "status", event: "completed" });
    expect(paperworkEvent("billing.stripe.com", "You have a payout", "")).toEqual({ kind: "payment", event: "payment_sent" });
  });

  it("candidate names come from the title, attachments and the sent-you line — never the provider", () => {
    const keys = nameCandidateKeys("Signature requested on Kelpco_Athlete_Agreement.pdf", "Dana from Ridgeline sent you a document to review and sign.", ["Kelpco Terms.pdf"]);
    expect(keys).toEqual(expect.arrayContaining(["kelpco", "ridgeline", "kelpcoathlete"]));
    expect(nameCandidateKeys("Please DocuSign: Agreement", "")).not.toContain("docusign");
    expect(statedDomains("Sender: Dana <dana@ridgeline.io> · sent via dse@docusign.net · me@gmail.com")).toEqual(["ridgeline.io"]);
  });
});

describe("placement", () => {
  it("unmatched paperwork is held: a marker, no deal, no opportunity", async () => {
    const athleteId = await seedAthlete();
    await engagement(athleteId, await brand("Heldbrand"));   // a pitch, not in a contract stage
    const t = await envelope(athleteId, "Please review and sign your document", "Click to review.");
    const opps = await oppCount(athleteId);
    const dealsN = await dealCount(athleteId);

    const marker = await place(athleteId, t, "Please review and sign your document", "Click to review.");

    expect(marker).toMatchObject({ state: "unmatched", kind: "signature_request", event: "signature_requested" });
    const row = await threadRow(t);
    expect((row.classification as any).paperwork).toMatchObject({ state: "unmatched", kind: "signature_request" });
    expect((row.classification as any).paperwork.source_message_ids).toHaveLength(1);
    expect(row.deal_id).toBeNull();
    expect(await oppCount(athleteId)).toBe(opps);
    expect(await dealCount(athleteId)).toBe(dealsN);
  });

  it("matches a brand named in the document title", async () => {
    const athleteId = await seedAthlete();
    const b = await brand("Titleco");
    const e = await engagement(athleteId, b);
    const t = await envelope(athleteId, "Signature requested on TITLECO_Athlete_Agreement", "");
    const marker = await place(athleteId, t, "Signature requested on TITLECO_Athlete_Agreement");
    expect(marker).toMatchObject({ state: "matched", matched_by: "name", deal_id: e.dealId, opportunity_id: e.opportunityId, brand_id: b });
    expect((await threadRow(t)).brand_id).toBe(b);
    expect((await db.select().from(opportunities).where(eq(opportunities.id, e.opportunityId)))[0].last_activity_at).toEqual(day("2026-09-04"));
  });

  it("matches the brand in the body's \"X sent you a document\" line", async () => {
    const athleteId = await seedAthlete();
    const b = await brand("Sentyouco");
    const e = await engagement(athleteId, b);
    const body = "Sentyouco sent you a document to review and sign.\nREVIEW DOCUMENT";
    const t = await envelope(athleteId, "Please DocuSign: Agreement.pdf", body);
    expect(await place(athleteId, t, "Please DocuSign: Agreement.pdf", body)).toMatchObject({ state: "matched", matched_by: "name", deal_id: e.dealId });
  });

  it("matches the sender's organisation domain when the body states it", async () => {
    const athleteId = await seedAthlete();
    await seedConnection({ athleteId, email: `own${++seq}@ownplace.io` });
    const b = await brand("Domainco", "domainco.com");
    const e = await engagement(athleteId, b);
    const body = `Jordan Lee (jordan@domainco.com) sent this envelope to own${seq}@ownplace.io.`;
    const t = await envelope(athleteId, "Please sign: Agreement", body);
    expect(await place(athleteId, t, "Please sign: Agreement", body)).toMatchObject({ state: "matched", matched_by: "sender_domain", deal_id: e.dealId });
  });

  it("matches the ONE open opportunity in a contract stage (observed counts), and holds when there are two", async () => {
    const athleteId = await seedAthlete();
    await engagement(athleteId, await brand("Pitchonly"));                                   // detected: not contract-ish
    const e = await engagement(athleteId, await brand("Contractco"), { stage: "agreed" });   // observed negotiating
    const t = await envelope(athleteId, "Your document is ready for your signature", "");
    expect(await place(athleteId, t, "Your document is ready for your signature")).toMatchObject({
      state: "matched", matched_by: "only_contract_deal", deal_id: e.dealId,
    });
    expect((await db.select().from(deals).where(eq(deals.id, e.dealId)))[0].status).toBe("detected");   // untouched

    await engagement(athleteId, await brand("Secondcontract"), { status: "accepted" });
    const t2 = await envelope(athleteId, "Your document is ready for your signature", "");
    expect(await place(athleteId, t2, "Your document is ready for your signature")).toMatchObject({ state: "unmatched" });
  });

  it("a brand named that she has no opportunity with contradicts the only-contract rule", async () => {
    const athleteId = await seedAthlete();
    await engagement(athleteId, await brand("Onlyone"), { status: "negotiating" });
    await brand("Strangerco");
    const t = await envelope(athleteId, "Please sign: Strangerco agreement", "");
    expect(await place(athleteId, t, "Please sign: Strangerco agreement")).toMatchObject({ state: "unmatched" });
  });

  it("a late \"Completed\" reopens an opportunity filed as expired — never one closed as won", async () => {
    const athleteId = await seedAthlete();
    const expired = await engagement(athleteId, await brand("Lateexp"), { oppStatus: "closed", closeReason: "expired" });
    const won = await engagement(athleteId, await brand("Latewon"), { oppStatus: "closed", closeReason: "won" });
    await place(athleteId, await envelope(athleteId, "Completed: Lateexp agreement", ""), "Completed: Lateexp agreement", "", "adobesign.com");
    await place(athleteId, await envelope(athleteId, "Completed: Latewon agreement", ""), "Completed: Latewon agreement", "", "adobesign.com");
    expect((await db.select().from(opportunities).where(eq(opportunities.id, expired.opportunityId)))[0]).toMatchObject({ status: "open", close_reason: null });
    expect((await db.select().from(opportunities).where(eq(opportunities.id, won.opportunityId)))[0]).toMatchObject({ status: "closed", close_reason: "won" });
  });
});

describe("end to end through detectDeal", () => {
  const CLS = {
    category: "PAID", confidence: 0.9, is_deal: true, brand_name: null, brand_domain: "docusign.net", advertiser: null,
    agency_name: null, via_agency: false, offer_amount: null, deliverables: [], deadline: null,
    contact_name: null, contact_email: null, channel: "unverifiable", claims_known_brand: false,
    qualification: "workable", qualification_reason: "Contract paperwork.", cash_amount: null, comp_kind: "none", work_kind: "other", work_units: null,
  };
  const send = (athleteId: string, connectionId: string, id: string, thread: string, subject: string, brandName: string | null = null) => {
    classifyMock.mockImplementationOnce(async () => ({ text: JSON.stringify({ ...CLS, brand_name: brandName, advertiser: brandName, summary: subject }) }));
    return detectDeal({
      athleteId, connectionId,
      message: { gmailMessageId: id, gmailThreadId: thread, subject, from: "Esign <dse@docusign.net>", body: subject, date: "2026-09-12T10:00:00Z", messageIdHeader: `<${id}@x>` },
    });
  };

  beforeEach(() => { resolverMock.mockClear(); kimiMock.mockClear(); summarizerMock.mockClear(); });

  it("a reminder attaches to the existing deal: no new deal row, no new opportunity, status unchanged", async () => {
    const athleteId = await seedAthlete();
    const inbox = await seedConnection({ athleteId, email: `e2e${++seq}@example.com` });
    const e = await engagement(athleteId, await brand("Remindco"), { status: "negotiating" });
    const deals0 = await dealCount(athleteId);
    const opps0 = await oppCount(athleteId);

    const r = await send(athleteId, inbox, "rem-1", "t-rem-1", "Reminder: Please DocuSign: Remindco Agreement", "Remindco");
    expect(r).toMatchObject({ skipped: false, reason: "paperwork_matched" });
    expect(r.dealId).toBeUndefined();
    expect(await dealCount(athleteId)).toBe(deals0);
    expect(await oppCount(athleteId)).toBe(opps0);
    const t = await threadRow(r.threadId!);
    expect(t.deal_id).toBeNull();
    expect((t.classification as any).paperwork).toMatchObject({ state: "matched", event: "reminder", deal_id: e.dealId });
    expect((await db.select().from(deals).where(eq(deals.id, e.dealId)))[0].status).toBe("negotiating");
    // Deterministic: no resolver (which creates brand rows), no summarizer, no scorer.
    expect(resolverMock).not.toHaveBeenCalled();
    expect(summarizerMock).not.toHaveBeenCalled();
    expect(kimiMock).not.toHaveBeenCalled();

    // "Completed" on the SAME envelope: the observation updates, still no deal.
    const done = await send(athleteId, inbox, "rem-2", "t-rem-1", "Completed: Remindco Agreement", "Remindco");
    expect(done.reason).toBe("paperwork_recorded");
    const t2 = await threadRow(r.threadId!);
    expect((t2.classification as any).paperwork).toMatchObject({ state: "matched", event: "completed", deal_id: e.dealId });
    expect((t2.classification as any).paperwork.source_message_ids).toHaveLength(2);
    expect(await dealCount(athleteId)).toBe(deals0);
    expect((await db.select().from(deals).where(eq(deals.id, e.dealId)))[0].status).toBe("negotiating");
  });

  it("paperwork for a brand she has nothing with is held: no opportunity, no deal, no brand row", async () => {
    const athleteId = await seedAthlete();
    const inbox = await seedConnection({ athleteId, email: `e2e${++seq}@example.com` });
    const brands0 = (await db.select().from(inboxBrands)).length;
    const r = await send(athleteId, inbox, "held-1", "t-held-1", "Please DocuSign: Newcomer Agreement", "Newcomer");
    expect(r).toMatchObject({ skipped: false, reason: "paperwork_unmatched" });
    expect(await oppCount(athleteId)).toBe(0);
    expect(await dealCount(athleteId)).toBe(0);
    expect((await db.select().from(inboxBrands)).length).toBe(brands0);
    expect(((await threadRow(r.threadId!)).classification as any).paperwork).toMatchObject({ state: "unmatched", kind: "signature_request" });
  });
});

describe("a company's own payment notice (remittance / payment advice paying her)", () => {
  const ADVICE = "Payment advice. We have settled the following items by bank transfer, subject to the goods and services supplied and the invoice being in order. Invoice 4471 USD 4,800.00 Net USD 5,000.00";
  const notice = (athleteId: string, connectionId: string, id: string, subject: string) =>
    detectDeal({
      athleteId, connectionId,
      message: { gmailMessageId: id, gmailThreadId: `t-${id}`, subject, from: "Payment advices <ap@payer-group.test>", body: ADVICE, date: "2026-10-15T10:00:00Z", messageIdHeader: `<${id}@x>` },
    });

  beforeEach(() => { classifyMock.mockClear(); resolverMock.mockClear(); kimiMock.mockClear(); summarizerMock.mockClear(); });

  it("lands on her deal with the payer as payment paperwork with its amount — no model call, no new deal", async () => {
    const athleteId = await seedAthlete();
    const inbox = await seedConnection({ athleteId, email: `pay${++seq}@example.com` });
    const e = await engagement(athleteId, await brand("Payerco"), { status: "accepted" });
    const deals0 = await dealCount(athleteId);
    const r = await notice(athleteId, inbox, "adv-1", "Payerco Inc. Adv.20012345;10/15/2026");
    expect(r).toMatchObject({ skipped: false, reason: "paperwork_matched" });
    expect(await dealCount(athleteId)).toBe(deals0);
    const pw = ((await threadRow(r.threadId!)).classification as any).paperwork;
    expect(pw).toMatchObject({ state: "matched", kind: "payment", event: "payment_received", deal_id: e.dealId, amount_cents: 500000, currency: "usd" });
    expect(classifyMock).not.toHaveBeenCalled();
    expect(resolverMock).not.toHaveBeenCalled();
    expect(summarizerMock).not.toHaveBeenCalled();
  });

  it("skips an open opportunity holding only the excluded deal for the payer's deal on a closed one", async () => {
    const athleteId = await seedAthlete();
    const b = await brand("Twooppco");
    const real = await engagement(athleteId, b, { oppStatus: "closed", closeReason: "expired" });
    const minted = await engagement(athleteId, b);
    const m = await matchPaperwork({
      athleteId, subject: "Twooppco Adv.1;10/15/2026", body: ADVICE, senderDomain: "payer-group.test", attachmentNames: [],
      payment: { amountCents: 500000, currency: "usd" }, excludeDealIds: [minted.dealId],
    });
    expect(m.opp?.id).toBe(real.opportunityId);
    expect(m.deal?.dealId).toBe(real.dealId);
  });

  it("lands on a deal whose opportunity was filed as expired without reopening it", async () => {
    const athleteId = await seedAthlete();
    const inbox = await seedConnection({ athleteId, email: `pay${++seq}@example.com` });
    const e = await engagement(athleteId, await brand("Expiredpayco"), { oppStatus: "closed", closeReason: "expired" });
    const r = await notice(athleteId, inbox, "adv-x", "Expiredpayco Inc. Adv.9;10/15/2026");
    expect(r).toMatchObject({ reason: "paperwork_matched" });
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, e.opportunityId));
    expect(o).toMatchObject({ status: "closed", close_reason: "expired" });
  });

  it("with no deal, it sits on the payer's brand record; with no brand either, it is filed as noise (no thread)", async () => {
    const athleteId = await seedAthlete();
    const inbox = await seedConnection({ athleteId, email: `pay${++seq}@example.com` });
    const b = await brand("Brandonlyco");
    const r = await notice(athleteId, inbox, "adv-2", "Brandonlyco Adv.555;10/15/2026");
    expect(r).toMatchObject({ skipped: false, reason: "paperwork_unmatched" });
    const t = await threadRow(r.threadId!);
    expect(t.brand_id).toBe(b);
    expect((t.classification as any).paperwork).toMatchObject({ state: "unmatched", event: "payment_received", brand_id: b, amount_cents: 500000 });
    expect(await oppCount(athleteId)).toBe(0);

    const none = await notice(athleteId, inbox, "adv-3", "Unknownpayer Adv.777;10/15/2026");
    expect(none).toMatchObject({ skipped: true, reason: "structural_billing" });
  });
});
