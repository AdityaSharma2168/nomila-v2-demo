/**
 * Opportunities PR 2 — one opportunity per brand, against PGlite. Kimi (the same-deal partition and
 * the scorer), the classify provider, the summarizer and brand research are mocked at their
 * boundaries, so nothing reaches a provider.
 *
 *   · create, then attach: a brand's next thread joins its open opportunity; a one-group answer
 *     and a FAILED partition both attach; a clear split opens a second
 *   · the advisory lock: two concurrent first mints for one brand make ONE opportunity
 *   · the agency rule: one opportunity per agency, no split call; a thread that later names its
 *     advertiser moves to the advertiser's opportunity (created if needed)
 *   · a reply advances last_activity_at (the SENT time) with no model call
 *   · OPPS_ONE_PER_BRAND: the opportunity id becomes every member's deal_group_id
 *   · end to end through detectDeal: proposal + e-sign request = one opportunity, one deal (the
 *     request is a paperwork observation on that deal — paperwork.test.ts covers the matching)
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
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
import { placeNewDeal, noteThreadActivity } from "./opportunities";
import { detectDeal } from "./dealDetector";
import { kimiInstant } from "../lib/kimi";
import { genai } from "../lib/models";
import { resolveBrandIdentity } from "../lib/brandResolver";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
const resolverMock = resolveBrandIdentity as jest.Mock;
const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

const PARTITION = "concern the SAME underlying brand deal";
const partitionCalls = () => kimiMock.mock.calls.filter(([system]) => String(system).includes(PARTITION)).length;

let athleteId: string;
let seq = 0;

async function brand(name: string, opts: { agency?: boolean; domain?: string } = {}): Promise<number> {
  const [b] = await db.insert(inboxBrands)
    .values({ name, normalized_name: name.toLowerCase(), domain: opts.domain ?? null, is_agency: opts.agency ?? false } as any)
    .returning({ id: inboxBrands.id });
  return b.id;
}

/** A minted deal with its thread and one message SENT at `sentAt` (ingest time is "now"). */
async function mint(brandId: number | null, summary: string, sentAt: Date, status = "detected") {
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_id: brandId, brand_name: `Brand ${brandId ?? "none"}`, status,
    detected_at: new Date(), source: "inbox_scan", raw_data: { summary },
  } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, brand_id: brandId, deal_id: d.id, subject: summary, status: "deal_detected", last_message_at: new Date(),
  } as any).returning({ id: inboxThreads.id });
  await message(t.id, sentAt);
  return { dealId: d.id as string, threadId: t.id as string };
}
async function message(threadId: string, sentAt: Date) {
  await db.insert(inboxMessages).values({
    thread_id: threadId, athlete_id: athleteId, direction: "inbound", subject: "s", body: "b",
    received_at: sentAt, external_message_id: `m-${++seq}`, platform: "gmail",
  } as any);
}
const dealRow = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0];
const oppRow = async (id: string) => (await db.select().from(opportunities).where(eq(opportunities.id, id)))[0];
const oppsFor = async (brandId: number) => db.select().from(opportunities).where(eq(opportunities.brand_id, brandId));

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  // Partition stub: a row whose summary says "unrelated" is its own deal; everything else is one deal.
  kimiMock.mockImplementation(async (system: string, user: string) => {
    if (String(system).includes(PARTITION)) {
      const lines = String(user).split("\n").filter((l) => /^\[\d+\]/.test(l));
      const same: number[] = [];
      const own: number[][] = [];
      for (const l of lines) {
        const i = Number(l.match(/^\[(\d+)\]/)![1]);
        if (/unrelated/i.test(l)) own.push([i]); else same.push(i);
      }
      return { choices: [{ message: { content: JSON.stringify({ groups: [same, ...own].filter((g) => g.length) }) } }] };
    }
    return { choices: [{ message: { content: "{}" } }] };
  });
});

beforeEach(() => {
  kimiMock.mockClear();
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

describe("create vs attach", () => {
  it("a brand's first thread creates the opportunity; the next one attaches (one-group answer = same)", async () => {
    const b = await brand("Attachco");
    const first = await mint(b, "Sponsorship proposal", day("2026-09-01"));
    const oppId = await placeNewDeal({ athleteId, dealId: first.dealId, threadId: first.threadId, brandId: b });
    expect(oppId).toBeTruthy();
    expect(partitionCalls()).toBe(0);   // nothing to compare against: no model call
    expect(await oppRow(oppId!)).toMatchObject({
      athlete_id: athleteId, brand_id: b, status: "open", lead_thread_id: first.threadId,
      opened_at: day("2026-09-01"), last_activity_at: day("2026-09-01"), close_reason: null, closed_at: null,
    });

    const second = await mint(b, "Contract for the sponsorship", day("2026-09-03"));
    expect(await placeNewDeal({ athleteId, dealId: second.dealId, threadId: second.threadId, brandId: b })).toBe(oppId);
    expect(partitionCalls()).toBe(1);
    expect((await dealRow(second.dealId)).opportunity_id).toBe(oppId);
    const o = await oppRow(oppId!);
    expect(o.lead_thread_id).toBe(first.threadId);                // the first email stays the lead
    expect(o.last_activity_at).toEqual(day("2026-09-03"));        // the SENT time, not ingest time
    expect((await dealRow(second.dealId)).deal_group_id).toBe(o.id);   // the opportunity id is its deal_group_id
  });

  it("when the partition fails, the deal ATTACHES (doubt means attach)", async () => {
    const b = await brand("Failco");
    const first = await mint(b, "Proposal", day("2026-09-01"));
    const oppId = await placeNewDeal({ athleteId, dealId: first.dealId, threadId: first.threadId, brandId: b });
    kimiMock.mockRejectedValueOnce(new Error("timeout"));
    const second = await mint(b, "Unrelated idea", day("2026-09-02"));
    expect(await placeNewDeal({ athleteId, dealId: second.dealId, threadId: second.threadId, brandId: b })).toBe(oppId);
  });

  it("a clearly separate engagement opens a second open opportunity for the same brand", async () => {
    const b = await brand("Splitco");
    const first = await mint(b, "Season sponsorship", day("2026-09-01"));
    const a = await placeNewDeal({ athleteId, dealId: first.dealId, threadId: first.threadId, brandId: b });
    const other = await mint(b, "Unrelated product launch next year", day("2026-09-05"));
    const c = await placeNewDeal({ athleteId, dealId: other.dealId, threadId: other.threadId, brandId: b });
    expect(c).not.toBe(a);
    expect((await oppsFor(b)).filter((o) => o.status === "open")).toHaveLength(2);
  });

  it("no brand resolved: each thread is its own opportunity", async () => {
    const x = await mint(null, "Something", day("2026-09-01"));
    const y = await mint(null, "Something else", day("2026-09-01"));
    const ox = await placeNewDeal({ athleteId, dealId: x.dealId, threadId: x.threadId, brandId: null });
    const oy = await placeNewDeal({ athleteId, dealId: y.dealId, threadId: y.threadId, brandId: null });
    expect(ox).toBeTruthy();
    expect(oy).not.toBe(ox);
  });
});

describe("the advisory lock", () => {
  it("two concurrent first mints for one brand create ONE opportunity", async () => {
    const b = await brand("Raceco");
    const one = await mint(b, "Proposal A", day("2026-09-10"));
    const two = await mint(b, "Proposal A, resent", day("2026-09-10"));
    const [x, y] = await Promise.all([
      placeNewDeal({ athleteId, dealId: one.dealId, threadId: one.threadId, brandId: b }),
      placeNewDeal({ athleteId, dealId: two.dealId, threadId: two.threadId, brandId: b }),
    ]);
    expect(x).toBe(y);
    expect(await oppsFor(b)).toHaveLength(1);
  });
});

// E-sign / payment mail no longer reaches placeNewDeal (it never mints a deal): see paperwork.test.ts.

describe("agency that does not name the advertiser", () => {
  it("ONE opportunity per agency with no split call; a thread that later names its advertiser moves to it", async () => {
    const agency = await brand("Agencyco", { agency: true });
    const first = await mint(agency, "Campaign for a client", day("2026-09-01"));
    const second = await mint(agency, "Unrelated campaign for another client", day("2026-09-02"));
    const a = await placeNewDeal({ athleteId, dealId: first.dealId, threadId: first.threadId, brandId: agency });
    const b = await placeNewDeal({ athleteId, dealId: second.dealId, threadId: second.threadId, brandId: agency });
    expect(b).toBe(a);
    expect(partitionCalls()).toBe(0);

    // A later email on the first thread names the advertiser.
    const advertiser = await brand("Advertiserco");
    await message(first.threadId, day("2026-09-05"));
    await noteThreadActivity({ athleteId, threadId: first.threadId, dealId: first.dealId, advertiser: async () => advertiser });
    const moved = await dealRow(first.dealId);
    expect(moved.opportunity_id).not.toBe(a);
    expect(moved).toMatchObject({ brand_id: advertiser, broker_brand_id: agency });
    const [advOpp] = await oppsFor(advertiser);
    expect(advOpp).toMatchObject({ id: moved.opportunity_id, status: "open", lead_thread_id: first.threadId, last_activity_at: day("2026-09-05") });
    expect((await db.select().from(inboxThreads).where(eq(inboxThreads.id, first.threadId)))[0].brand_id).toBe(advertiser);
    expect((await dealRow(second.dealId)).opportunity_id).toBe(a);   // the other thread stays with the agency

    // The second thread names the same advertiser later: it joins the advertiser's existing opportunity.
    await noteThreadActivity({ athleteId, threadId: second.threadId, dealId: second.dealId, advertiser: async () => advertiser });
    expect((await dealRow(second.dealId)).opportunity_id).toBe(advOpp.id);
    expect(await oppsFor(advertiser)).toHaveLength(1);
  });

  it("naming another agency is not naming an advertiser", async () => {
    const agency = await brand("Agency Two", { agency: true });
    const other = await brand("Agency Three", { agency: true });
    const t = await mint(agency, "Campaign", day("2026-09-01"));
    const a = await placeNewDeal({ athleteId, dealId: t.dealId, threadId: t.threadId, brandId: agency });
    await noteThreadActivity({ athleteId, threadId: t.threadId, dealId: t.dealId, advertiser: async () => other });
    expect((await dealRow(t.dealId)).opportunity_id).toBe(a);
  });
});

describe("replies", () => {
  it("advance last_activity_at to the newest SENT time and clear the going-quiet mark, with no model call", async () => {
    const b = await brand("Replyco");
    const t = await mint(b, "Proposal", day("2026-09-01"));
    const id = await placeNewDeal({ athleteId, dealId: t.dealId, threadId: t.threadId, brandId: b });
    await db.update(opportunities).set({ going_quiet_at: day("2026-09-20") }).where(eq(opportunities.id, id!));
    await message(t.threadId, day("2026-09-25"));
    let resolved = false;
    await noteThreadActivity({ athleteId, threadId: t.threadId, dealId: t.dealId, advertiser: async () => { resolved = true; return null; } });
    expect(await oppRow(id!)).toMatchObject({ last_activity_at: day("2026-09-25"), going_quiet_at: null });
    expect(resolved).toBe(false);   // a direct brand's reply never touches the resolver
    expect(kimiMock).not.toHaveBeenCalled();
  });
});

describe("one opportunity per brand (OPPS_ONE_PER_BRAND, retired 2 Nov 2026: always on)", () => {
  it("copies the opportunity id into every member's deal_group_id", async () => {
    const b = await brand("Mirrorco");
    const first = await mint(b, "Proposal", day("2026-09-01"));
    const id = await placeNewDeal({ athleteId, dealId: first.dealId, threadId: first.threadId, brandId: b });
    expect((await dealRow(first.dealId)).deal_group_id).toBe(id);

    const second = await mint(b, "Contract", day("2026-09-02"));
    expect(await placeNewDeal({ athleteId, dealId: second.dealId, threadId: second.threadId, brandId: b })).toBe(id);
    expect((await dealRow(first.dealId)).deal_group_id).toBe(id);     // healed on the next attach
    expect((await dealRow(second.dealId)).deal_group_id).toBe(id);
  });
});

describe("end to end through detectDeal", () => {
  it("a proposal makes the opportunity; the e-sign provider's signature request attaches to its deal, minting nothing", async () => {
    const inbox = await seedConnection({ athleteId, email: "athlete-inbox@example.com" });
    const b = await brand("E2eco", { domain: "e2eco.com" });
    resolverMock.mockImplementation(async () => ({ brand_id: b, brand_name: "E2eco", brand_domain: "e2eco.com", logo_url: null, is_new: false }));
    const base = {
      category: "PAID", confidence: 0.9, is_deal: true, brand_name: "E2eco", brand_domain: "e2eco.com", advertiser: "E2eco",
      agency_name: null, via_agency: false, offer_amount: null, deliverables: [], deadline: null,
      contact_name: "Lee", contact_email: "lee@e2eco.com", channel: "direct", claims_known_brand: false,
      qualification: "needs_terms", qualification_reason: "Wants to talk.", cash_amount: null, comp_kind: "none", work_kind: "social_post", work_units: null,
    };
    const msg = (id: string, from: string, summary: string) => {
      classifyMock.mockImplementationOnce(async () => ({ text: JSON.stringify({ ...base, summary }) }));
      return detectDeal({
        athleteId, connectionId: inbox,
        message: { gmailMessageId: id, gmailThreadId: `t-${id}`, subject: summary, from, body: summary, date: "2026-09-10T10:00:00Z", messageIdHeader: `<${id}@x>` },
      });
    };
    try {
      const pitch = await msg("e2e-1", "Lee <lee@e2eco.com>", "Sponsorship proposal");
      const dealsBefore = (await db.select().from(deals)).length;
      const sig = await msg("e2e-2", "E2eco via Esign <dse@docusign.net>", "Please sign: E2eco agreement");
      const p = await dealRow(pitch.dealId!);
      expect(p.opportunity_id).toBeTruthy();
      expect(sig.dealId).toBeUndefined();
      expect(sig.reason).toBe("paperwork_matched");
      expect((await db.select().from(deals)).length).toBe(dealsBefore);   // no pseudo-deal
      const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, sig.threadId!));
      expect(t.deal_id).toBeNull();
      expect((t.classification as any).paperwork).toMatchObject({
        state: "matched", event: "signature_requested", deal_id: pitch.dealId, opportunity_id: p.opportunity_id, matched_by: "name",
      });
      expect(partitionCalls()).toBe(0);   // paperwork matches without a model call (and mints no deal to group)
      expect((await oppRow(p.opportunity_id!)).last_activity_at).toEqual(new Date("2026-09-10T10:00:00Z"));
    } finally {
      resolverMock.mockImplementation(async () => null);
    }
  });
});
