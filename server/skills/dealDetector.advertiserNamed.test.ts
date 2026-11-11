/**
 * advertiser_named — a described advertiser ("a home improvement brand") is never a brand row.
 * The mail goes to the agency's one opportunity instead. The real brand resolver runs against
 * PGlite; the classify provider, Kimi, the summarizer and brand research are mocked, so nothing
 * reaches a provider.
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
jest.mock("./threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));
jest.mock("./researchBrand", () => ({ researchBrand: jest.fn(async () => undefined) }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));

import { eq } from "drizzle-orm";
import { detectDeal, enforceAdvertiserNamed, type Classification } from "./dealDetector";
import { genai } from "../lib/models";
import { deals, inboxBrands, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";

const classifyMock = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;

const BASE = {
  category: "PAID", confidence: 0.9, is_deal: true, offer_amount: null, deliverables: [], deadline: null,
  contact_name: "Robin", contact_email: null, channel: "agency", claims_known_brand: false,
  qualification: "needs_terms", qualification_reason: "An agency asks about a campaign.", cash_amount: null,
  comp_kind: "none", work_kind: "social_post", work_units: null, summary: "Campaign enquiry",
};

let athleteId: string;
let inbox: string;

function send(id: string, cls: Record<string, unknown>) {
  classifyMock.mockImplementationOnce(async () => ({ text: JSON.stringify({ ...BASE, ...cls }) }));
  return detectDeal({
    athleteId, connectionId: inbox,
    message: {
      gmailMessageId: id, gmailThreadId: `t-${id}`, subject: "Campaign for a client", from: "Robin <robin@otterlanemedia.com>",
      body: "We are reaching out on behalf of a client for a paid campaign.", date: "2026-09-10T10:00:00Z", messageIdHeader: `<${id}@x>`,
    },
  });
}

const brandsNamed = async (name: string) =>
  (await db.select().from(inboxBrands)).filter((b) => (b.name ?? "").toLowerCase() === name.toLowerCase());

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  inbox = await seedConnection({ athleteId, email: "athlete-inbox@example.com" });
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  await closeTestDb();
});

describe("enforceAdvertiserNamed (pure)", () => {
  const cls = (over: Partial<Classification>): Classification => ({
    category: "PAID", confidence: 0.9, brand_name: null, brand_domain: null, advertiser: null, agency_name: null,
    via_agency: false, summary: "", offer_amount: null, deliverables: [], deadline: null, contact_name: null, contact_email: null,
    ...over,
  });

  it("false: the description is dropped and the agency stands in", () => {
    expect(enforceAdvertiserNamed(cls({
      advertiser_named: false, brand_name: "Home Improvement Brand", advertiser: "Home Improvement Brand", agency_name: "Otterlane Media",
    }))).toMatchObject({ advertiser: null, brand_name: "Otterlane Media", agency_name: "Otterlane Media", via_agency: true });
  });

  it("false with the agency captured as the brand: the agency stays, flagged as the agency", () => {
    expect(enforceAdvertiserNamed(cls({ advertiser_named: false, brand_name: "Otterlane Media", advertiser: "a leading skincare brand" })))
      .toMatchObject({ advertiser: null, brand_name: "Otterlane Media", agency_name: "Otterlane Media", via_agency: true });
  });

  it("absent or true: unchanged", () => {
    const named = cls({ brand_name: "Namedco", advertiser: "Namedco" });
    expect(enforceAdvertiserNamed(named)).toBe(named);
    const t = cls({ advertiser_named: true, brand_name: "Namedco", advertiser: "Namedco" });
    expect(enforceAdvertiserNamed(t)).toBe(t);
  });
});

describe("through detectDeal with the real resolver", () => {
  it("a described advertiser creates no brand row; the deal joins the agency's one opportunity", async () => {
    const first = await send("gen-1", {
      brand_name: "Home Improvement Brand", brand_domain: "otterlanemedia.com", advertiser: "Home Improvement Brand",
      agency_name: "Otterlane Media", via_agency: true, advertiser_named: false,
    });
    const second = await send("gen-2", {
      brand_name: "A Leading Skincare Brand", brand_domain: "otterlanemedia.com", advertiser: "A Leading Skincare Brand",
      agency_name: "Otterlane Media", via_agency: true, advertiser_named: false,
    });

    expect(await brandsNamed("Home Improvement Brand")).toHaveLength(0);
    expect(await brandsNamed("A Leading Skincare Brand")).toHaveLength(0);
    const [agency] = await brandsNamed("Otterlane Media");
    expect(agency).toMatchObject({ is_agency: true });

    const [d1] = await db.select().from(deals).where(eq(deals.id, first.dealId!));
    const [d2] = await db.select().from(deals).where(eq(deals.id, second.dealId!));
    expect(d1.brand_id).toBe(agency.id);
    expect(d1.opportunity_id).toBeTruthy();
    expect(d2.opportunity_id).toBe(d1.opportunity_id);   // one opportunity per agency
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, d1.opportunity_id!));
    expect(opp.brand_id).toBe(agency.id);
  });

  it("advertiser_named absent: today's behaviour — the named advertiser resolves", async () => {
    const r = await send("named-1", {
      brand_name: "Namedadco", brand_domain: "otterlanemedia.com", advertiser: "Namedadco",
      agency_name: "Otterlane Media", via_agency: true,
    });
    const [named] = await brandsNamed("Namedadco");
    expect(named).toBeDefined();
    expect((await db.select().from(deals).where(eq(deals.id, r.dealId!)))[0].brand_id).toBe(named.id);
  });
});
