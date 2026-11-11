/**
 * Opportunities PR 1 — qualification at ingest, end to end through detectDeal. Real SQL against
 * PGlite; the classify provider (Gemini via lib/models), Kimi (score + same-deal partition), the
 * summarizer and brand research are mocked at their boundaries, so nothing reaches a provider.
 *
 *   · flag OFF: minting is unchanged; the new classification fields are written (observational)
 *   · flag ON: not_relevant is filed with the junk receipt (no thread, no deal); verify_first is
 *     minted, marked, and never auto-filed
 *   · re-qualification on a later message moves needs_terms → workable; terms are not erased
 *   · floor arithmetic lands as below_floor at ingest
 *   · a contract-signature email still links to the original deal with the flag ON
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
// The classify provider boundary. Without this, genai() would pick up ADC and bill real calls.
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

import { and, eq, sql } from "drizzle-orm";
import { detectDeal } from "./dealDetector";
import { kimiInstant } from "../lib/kimi";
import { genai } from "../lib/models";
import { resolveBrandIdentity } from "../lib/brandResolver";
import { agentActions, athletes, deals, inboxBrands, inboxMessages, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
const resolverMock = resolveBrandIdentity as jest.Mock;
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

let nextClassification: Record<string, unknown>;
let nextScore: Record<string, unknown>;

const BASE = {
  category: "PAID", confidence: 0.9, is_deal: true,
  brand_name: "Acme", brand_domain: "acme.com", advertiser: "Acme",
  agency_name: null, via_agency: false,
  summary: "Partnership enquiry", offer_amount: null,
  deliverables: [], deadline: null,
  contact_name: "Sarah", contact_email: "sarah@acme.com",
  channel: "direct", claims_known_brand: false,
  qualification: "needs_terms", qualification_reason: "Acme wants to talk about a partnership.",
  cash_amount: null, comp_kind: "none", work_kind: "social_post", work_units: null,
};

// A red flag floors the reconciled action at reject, so the scorer's auto-file genuinely fires.
const CONFIDENT_REJECT = {
  recommendation: "reject", recommendation_confidence: "high", redFlags: ["Asks the athlete to pay a deposit"],
};

const SCORE = {
  verdict: "fair", scoreNumeric: 5, dollarAmount: null,
  factors: {}, factorRatings: null, reasons: ["ok"], redFlags: [],
  fitRead: { rating: "fair", label: "Fair" },
  economicsState: { state: "unpriced", read: "no price" },
  recommendation: "negotiate", recommendation_ui: "Ask for terms", recommendation_agent: "Ask.",
  negotiate_terms: [], recommendation_confidence: "medium", urgency: "medium",
  autopilot_safe: false, draft_points: [], brandAnalysis: null,
};

function msg(id: string, threadId: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId:  id,
    gmailThreadId:   threadId,
    subject:         "Partnership",
    from:            "Sarah <sarah@acme.com>",
    body:            "We'd love to work with you on our next campaign.",
    date:            new Date().toISOString(),
    messageIdHeader: `<${id}@mail.acme.com>`,
    ...over,
  };
}

const threadByExt = async (ext: string) =>
  (await db.select().from(inboxThreads).where(eq(inboxThreads.external_thread_id, ext)))[0];

let athleteId: string;
let inbox: string;
beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  inbox = await seedConnection({ athleteId, email: "athlete-inbox@gmail.com" });
  await db.update(athletes)
    .set({ deal_preferences: { minimum_rates: { socialPost: 1000 } } } as any)
    .where(eq(athletes.id, athleteId));

  classifyMock.mockImplementation(async () => ({ text: JSON.stringify(nextClassification) }));
  kimiMock.mockImplementation(async (system: string, user: string) => {
    // Same-deal partition (dealGrouping): rows whose summary says "unrelated" are their own deal,
    // everything else in the cluster is one deal.
    if (String(system).includes("concern the SAME underlying brand deal")) {
      const lines = String(user).split("\n").filter((l) => /^\[\d+\]/.test(l));
      const same: number[] = [];
      const groups: number[][] = [];
      for (const l of lines) {
        const i = Number(l.match(/^\[(\d+)\]/)![1]);
        if (/unrelated/i.test(l)) groups.push([i]); else same.push(i);
      }
      return { choices: [{ message: { content: JSON.stringify({ groups: [same, ...groups] }) } }] };
    }
    return { choices: [{ message: { content: JSON.stringify(nextScore) } }] };
  });
});

beforeEach(() => {
  nextScore = SCORE;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

// Qualified intake (OPPS_QUALIFIED_INTAKE) has been always on since 2 Nov 2026: its flag-off tests are gone.
describe("verify_first", () => {
  it("verify_first is minted and stays live (the scorer's auto-file is retired)", async () => {
    nextClassification = { ...BASE, channel: "unverifiable", claims_known_brand: true, qualification: "workable" };
    const r = await detectDeal({ athleteId, connectionId: inbox, message: msg("off-2", "t-off-2", { from: "Rep <rep@odd-domain.biz>" }) });
    expect(r.dealId).toBeDefined();
    const t = await threadByExt("t-off-2");
    expect((t.classification as any).qualification).toBe("verify_first");
    expect(t.status).toBe("deal_detected"); // held for her to verify, never filed by itself
  });
});

describe("qualified intake", () => {
  it("not_relevant ⇒ filed with the junk receipt; no thread, no message, no deal", async () => {
    nextClassification = { ...BASE, qualification: "not_relevant", qualification_reason: "A brand's marketing newsletter." };
    const r = await detectDeal({ athleteId, connectionId: inbox, message: msg("on-nr", "t-on-nr", { subject: "New season drop" }) });

    expect(r).toEqual({ skipped: true, reason: "qualified_not_relevant", category: "PAID" });
    expect(await threadByExt("t-on-nr")).toBeUndefined();
    expect(await db.select().from(inboxMessages).where(eq(inboxMessages.external_message_id, "on-nr"))).toHaveLength(0);

    const receipts = await db.select().from(agentActions).where(and(
      eq(agentActions.athlete_id, athleteId),
      sql`${agentActions.payload} ->> 'external_message_id' = 'on-nr'`,
    ));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].action).toBe("file");
    expect(receipts[0].reason).toBe("A brand's marketing newsletter.");
    expect(receipts[0].payload).toMatchObject({
      kind: "junk", qualification: "not_relevant", qualification_version: "opps-qual/1",
      external_message_id: "on-nr",
    });
    // Her receipt, never a training sample: no sender, subject or body of the message.
    for (const k of ["sample_from", "sample_subject", "sample_body"]) expect(receipts[0].payload).not.toHaveProperty(k);
    expect(JSON.stringify(receipts[0].payload)).not.toContain("New season drop");
  });

  it("verify_first ⇒ minted, marked, and never auto-filed even on a confident scorer reject", async () => {
    nextClassification = { ...BASE, channel: "unverifiable", claims_known_brand: true, qualification: "workable" };
    nextScore = { ...SCORE, ...CONFIDENT_REJECT };
    const r = await detectDeal({ athleteId, connectionId: inbox, message: msg("on-vf", "t-on-vf", { from: "Rep <rep@odd-domain.biz>" }) });

    expect(r).toMatchObject({ skipped: false, reason: "processed" });
    const t = await threadByExt("t-on-vf");
    expect(t.deal_id).toBe(r.dealId);
    expect((t.classification as any).qualification).toBe("verify_first");
    expect(t.status).toBe("deal_detected"); // held for her, not filed
  });

  it("needs_terms / below_floor / workable are minted as today", async () => {
    for (const [id, cls] of [
      ["on-nt", { ...BASE }],
      ["on-bf", { ...BASE, qualification: "workable", cash_amount: 150, comp_kind: "cash", work_units: 1 }],
      ["on-wk", { ...BASE, qualification: "workable", cash_amount: 5000, comp_kind: "cash", work_units: 2 }],
    ] as const) {
      nextClassification = cls;
      const r = await detectDeal({ athleteId, connectionId: inbox, message: msg(id, `t-${id}`) });
      expect(r).toMatchObject({ skipped: false, reason: "processed" });
      expect(r.dealId).toBeDefined();
    }
    expect(((await threadByExt("t-on-nt")).classification as any).qualification).toBe("needs_terms");
    const bf = (await threadByExt("t-on-bf")).classification as any;
    expect(bf.qualification).toBe("below_floor"); // $150 vs her $1,000 social-post floor — arithmetic
    expect(bf.qualification_floor).toEqual({ kind: "social_post", cash: 150, units: 1, floor: 1000, source: "minimum_rate" });
    expect(((await threadByExt("t-on-wk")).classification as any).qualification).toBe("workable");
  });

  it("a configured internal test sender is filed; with the list empty the same email is minted", async () => {
    const prev = process.env.INTERNAL_TEST_SENDERS;
    try {
      nextClassification = { ...BASE };
      process.env.INTERNAL_TEST_SENDERS = "qa.example";
      const filed = await detectDeal({ athleteId, connectionId: inbox, message: msg("on-int-1", "t-on-int-1", { from: "Dev <dev@qa.example>" }) });
      expect(filed).toMatchObject({ skipped: true, reason: "qualified_not_relevant" });
      const [receipt] = await db.select().from(agentActions).where(sql`${agentActions.payload} ->> 'external_message_id' = 'on-int-1'`);
      expect(receipt.payload).toMatchObject({ qualification: "not_relevant" });

      process.env.INTERNAL_TEST_SENDERS = "";
      const minted = await detectDeal({ athleteId, connectionId: inbox, message: msg("on-int-2", "t-on-int-2", { from: "Dev <dev@qa.example>" }) });
      expect(minted).toMatchObject({ skipped: false, reason: "processed" });
    } finally {
      if (prev === undefined) delete process.env.INTERNAL_TEST_SENDERS; else process.env.INTERNAL_TEST_SENDERS = prev;
    }
  });

  it("a message on an existing thread is never filed, even when it reads not_relevant", async () => {
    nextClassification = { ...BASE };
    const first = await detectDeal({ athleteId, connectionId: inbox, message: msg("on-ex-1", "t-on-ex") });
    nextClassification = { ...BASE, confidence: 0.7, qualification: "not_relevant" };
    const follow = await detectDeal({ athleteId, connectionId: inbox, message: msg("on-ex-2", "t-on-ex", { subject: "Re: Partnership" }) });
    expect(follow).toMatchObject({ skipped: false, reason: "reply_recorded", threadId: first.threadId });
    expect(((await threadByExt("t-on-ex")).classification as any).qualification).toBe("needs_terms");
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("re-qualification on every message", () => {
  it("needs_terms → workable when terms arrive; a later 'sounds good' does not erase them", async () => {
    nextClassification = { ...BASE };
    const first = await detectDeal({ athleteId, connectionId: inbox, message: msg("rq-1", "t-rq") });
    expect(((await threadByExt("t-rq")).classification as any).qualification).toBe("needs_terms");

    // Lower confidence ⇒ the preserved-thread reply path (classification otherwise untouched).
    nextClassification = { ...BASE, confidence: 0.8, qualification: "workable", cash_amount: 2500, comp_kind: "cash", work_units: 2, deliverables: ["2 posts"] };
    await detectDeal({ athleteId, connectionId: inbox, message: msg("rq-2", "t-rq", { subject: "Re: Partnership", body: "Budget is $2,500 for 2 posts." }) });
    let t = await threadByExt("t-rq");
    expect((t.classification as any).qualification).toBe("workable");
    expect((t.classification as any).qualification_message_id).toBe("rq-2");
    expect((t.classification as any).category).toBe("PAID");          // category untouched
    expect((t.classification as any).gmail_thread_id).toBe("t-rq");   // the rest of the jsonb survives
    expect(t.deal_id).toBe(first.dealId);

    nextClassification = { ...BASE, confidence: 0.7, qualification: "needs_terms" };
    await detectDeal({ athleteId, connectionId: inbox, message: msg("rq-3", "t-rq", { subject: "Re: Partnership", body: "Sounds good!" }) });
    t = await threadByExt("t-rq");
    expect((t.classification as any).qualification).toBe("workable");
    await new Promise((r) => setTimeout(r, 50));
  });

  it("the upgrade path (a stronger re-read) also re-qualifies", async () => {
    nextClassification = { ...BASE, confidence: 0.7 };
    await detectDeal({ athleteId, connectionId: inbox, message: msg("rq-up-1", "t-rq-up") });
    nextClassification = { ...BASE, confidence: 0.95, qualification: "workable", cash_amount: 400, comp_kind: "cash", work_units: 1 };
    await detectDeal({ athleteId, connectionId: inbox, message: msg("rq-up-2", "t-rq-up", { subject: "Re: Partnership" }) });
    const c = (await threadByExt("t-rq-up")).classification as any;
    expect(c.qualification).toBe("below_floor");
    expect(c.confidence).toBe(0.95);
  });
});

describe("contract-signature email still links to the original deal", () => {
  it("an e-sign provider's signature request on a NEW thread attaches to the original deal, minting none", async () => {
    const [brand] = await db.insert(inboxBrands).values({ name: "Signco", domain: "signco.com" } as any).returning({ id: inboxBrands.id });
    resolverMock.mockImplementation(async () => ({ brand_id: brand.id, brand_name: "Signco", brand_domain: "signco.com", logo_url: null, is_new: false }));
    try {
      // 1. The original proposal — the lead thread.
      nextClassification = { ...BASE, brand_name: "Signco", advertiser: "Signco", summary: "Sponsorship proposal for the season", qualification: "workable", cash_amount: 5000, comp_kind: "cash" };
      const original = await detectDeal({ athleteId, connectionId: inbox, message: msg("sig-1", "t-sig-1", { from: "Lee <lee@signco.com>" }) });
      // 2. An unrelated offer from the same brand (gives the partition a second deal to tell apart).
      nextClassification = { ...BASE, brand_name: "Signco", advertiser: "Signco", summary: "Unrelated product gifting idea" };
      const unrelated = await detectDeal({ athleteId, connectionId: inbox, message: msg("sig-2", "t-sig-2", { from: "Lee <lee@signco.com>" }) });
      // The summarizer reads the original as being negotiated — an observation (status untouched)
      // that still marks it as the one being worked.
      await db.update(inboxThreads).set({ conversation_state: { deal_stage: "negotiating" } }).where(eq(inboxThreads.id, original.threadId!));
      const dealsBefore = (await db.select().from(deals)).length;

      // 3. The e-signature request, from the e-sign provider, on its own thread. Worst case: the
      //    model calls it not_relevant (automated mail) — which, without the workflow rule, the
      //    flag would file and the deal would never reach its signature.
      nextClassification = {
        ...BASE, brand_name: "Signco", advertiser: "Signco", brand_domain: "docusign.net",
        summary: "Signature request for the Sponsorship proposal agreement",
        qualification: "not_relevant", qualification_reason: "Automated notification.",
      };
      const sig = await detectDeal({
        athleteId, connectionId: inbox,
        message: msg("sig-3", "t-sig-3", { from: "Signco via Esign <dse@docusign.net>", subject: "Please sign: Signco Athlete Agreement" }),
      });

      expect(sig).toMatchObject({ skipped: false, reason: "paperwork_matched" });
      expect(sig.dealId).toBeUndefined();
      expect((await db.select().from(deals)).length).toBe(dealsBefore);   // no pseudo-deal
      const [o] = await db.select().from(deals).where(eq(deals.id, original.dealId!));
      expect(o.status).toBe("detected");                                  // an observation never moves status
      const sigThread = await threadByExt("t-sig-3");
      expect(sigThread.deal_id).toBeNull();
      expect((sigThread.classification as any).paperwork).toMatchObject({ state: "matched", deal_id: original.dealId, matched_by: "name" });
      expect(unrelated.dealId).not.toBe(original.dealId);
      // The lead thread is untouched.
      expect((await threadByExt("t-sig-1")).deal_id).toBe(original.dealId);
      expect((sigThread.classification as any).qualification).not.toBe("not_relevant");
    } finally {
      resolverMock.mockImplementation(async () => null);
    }
  });
});
