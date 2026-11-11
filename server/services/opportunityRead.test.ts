/**
 * opportunityRead — the four-line read. Money and Risk are code (pure, every state); Fit and Goal come from ONE mocked
 * model call (tests never reach providers), are checked against what the call was given, stored once per athlete + deal
 * and refilled when the brand's research / identity, her goals or the ask change. Flags off → no read on the wire.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const runSkill = jest.fn();
jest.mock("../agent/research/runSkill", () => ({ runSkill: (...a: any[]) => runSkill(...a) }));

import { eq } from "drizzle-orm";
import { dealReads, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { dbStore } from "../agent/research/dbStore";
import {
  NO_GOAL_LINE, checkFitGoal, moneyRead, readInputsKey, riskRead, safetyNote, workOf,
} from "./opportunityRead";
import { readOpportunityBoard } from "./opportunityBoard";
import { readOpportunityDetail } from "./opportunityDetail";
import { listDealsTool } from "../mila/tools/listDeals";
import type { StoredRange } from "./rates";

const NOW = new Date("2026-10-12T12:00:00Z");
const range = (low: number, high: number): StoredRange => ({ rateType: "ig_reel", low, high, currency: "USD", confidence: "medium", drivers: [], label: "Reel", source: "onboarding", shownAt: "" });

describe("Money — code", () => {
  const base = { kind: "deal" as const, minimumRates: {}, ranges: new Map() };
  it("interview and school requests are unpaid", () => {
    expect(moneyRead({ ...base, kind: "interview", offer: null }).state).toBe("unpaid");
    expect(moneyRead({ ...base, kind: "school", offer: null }).state).toBe("unpaid");
  });
  it("no fee, commission only, product only", () => {
    expect(moneyRead({ ...base, offer: null })).toMatchObject({ state: "no_fee", line: "No fee yet — ask what they’d pay" });
    expect(moneyRead({ ...base, offer: { amount: null, unit: "commission_only", commission_pct: 10 } as any })).toMatchObject({ state: "commission_only", line: "Commission only, no set fee (10% of sales)" });
    expect(moneyRead({ ...base, offer: { amount: null, unit: "gifting_only", product_value: 150 } })).toMatchObject({ state: "product_only", line: "Product only (~$150), no fee" });
    expect(moneyRead({ ...base, offer: { amount: null, unit: null, product_value: 80 } }).state).toBe("product_only");
  });
  it("a total for 3 Reels: per piece, against HER minimum (never its number) and the suggested range", () => {
    const offer = { amount: 1200, unit: "total" as const, deliverable_counts: { reels: 3 } };
    const r = moneyRead({ ...base, offer, minimumRates: { ig_reel: 350 }, ranges: new Map([["ig_reel", range(350, 550)]]) });
    expect(r).toEqual({ state: "above_min", line: "$1,200 for 3 Reels — about $400 each, meets your minimum, inside your suggested range ($350–550)", source: "Their latest email · your minimum · your suggested range" });
    expect(r.line).not.toMatch(/\$350\b(?!–)/);
    const below = moneyRead({ ...base, offer, minimumRates: { ig_reel: 500 }, ranges: new Map() });
    expect(below.state).toBe("below_min");
    expect(below.line).toBe("$1,200 for 3 Reels — about $400 each, under your minimum");
    expect(below.line).not.toContain("500");
  });
  it("per-post units multiply; the older per-kind minimum still counts; no minimum names what's missing", () => {
    expect(moneyRead({ ...base, offer: { amount: 300, unit: "per_post", deliverable_counts: { posts: 2 } }, minimumRates: { socialPost: 250 } }))
      .toMatchObject({ state: "above_min", line: "$600 for 2 posts — about $300 each, meets your minimum" });
    expect(moneyRead({ ...base, offer: { amount: 300, unit: "per_post", deliverable_counts: { posts: 2 } } }))
      .toMatchObject({ state: "no_min", line: "$600 for 2 posts — about $300 each, no minimum set for instagram feed post yet" });
  });
  it("a mix with one known minimum is below only when the known part alone is not covered", () => {
    const offer = { amount: 500, unit: "total" as const, deliverable_counts: { reels: 1, stories: 3 } };
    expect(moneyRead({ ...base, offer, minimumRates: { ig_reel: 600 } }).state).toBe("below_min");
    expect(moneyRead({ ...base, offer, minimumRates: { ig_reel: 300 } }).state).toBe("no_min");
    expect(moneyRead({ ...base, offer, minimumRates: { ig_reel: 300, ig_story: 50 } }).state).toBe("above_min");
  });
  it("monthly reads against the ambassador month; unknown work has no minimum to compare; product rides along", () => {
    expect(moneyRead({ ...base, offer: { amount: 1000, unit: "monthly" }, minimumRates: { ambassador_month: 1500 } }))
      .toMatchObject({ state: "below_min", line: "$1,000 a month, under your minimum" });
    expect(moneyRead({ ...base, offer: { amount: 900, unit: "total", product_value: 200 } }))
      .toMatchObject({ state: "no_min", line: "$900 offered plus product (~$200), no minimum to compare — the work isn’t clear yet" });
    expect(workOf({ amount: 1, unit: "total", deliverable_counts: { widgets: 2 } })).toEqual([{ rateType: null, count: 2, key: "widgets" }]);
  });
});

describe("Money — deal types and the term sheet", () => {
  const base = { kind: "deal" as const, minimumRates: {}, ranges: new Map() };
  it("press, podcast and school types are unpaid; a null type falls back to the kind", () => {
    expect(moneyRead({ ...base, dealType: "press", offer: { amount: 500, unit: "total" } }).state).toBe("unpaid");
    expect(moneyRead({ ...base, dealType: "school_compliance", offer: null }).line).toBe("From your school, not a paid offer");
    expect(moneyRead({ ...base, dealType: null, offer: null }).state).toBe("no_fee");
    expect(moneyRead({ ...base, kind: "interview", dealType: null, offer: null }).state).toBe("unpaid");
  });
  it("affiliate with no fee reads commission only; a gift with no figure reads product only", () => {
    expect(moneyRead({ ...base, dealType: "affiliate", offer: null }).state).toBe("commission_only");
    expect(moneyRead({ ...base, dealType: "gift", offer: null })).toMatchObject({ state: "product_only", line: "Product only, no fee" });
  });
  it("the term sheet fills a missing fee and its deliverables count the work", () => {
    const terms = { fee: { amount: 900, unit: "flat" }, deliverables: [{ kind: "ig_reel", count: 3 }], unknown: [] } as any;
    expect(moneyRead({ ...base, dealType: "paid_content", offer: null, terms, minimumRates: { ig_reel: 250 } }))
      .toMatchObject({ state: "above_min", line: "$900 for 3 Reels — about $300 each, meets your minimum" });
  });
  it("posts inside an ambassador deal are measured against her ambassador minimum, never per post", () => {
    const offer = { amount: 1200, unit: "total" as const, deliverable_counts: { posts: 4 } };
    const r = moneyRead({ ...base, dealType: "ambassador", workKind: "ambassador", offer, minimumRates: { ig_post: 100, ambassador_month: 2000 } });
    expect(r.state).toBe("below_min");
    expect(r.line).toContain("$1,200 for 4 posts");
  });
});

describe("Risk — code, an enum", () => {
  const base = { qualification: "workable", channel: "direct" as const, classification: {}, brandName: "Rivalwear", research: null, conflicts: [], currentPartners: [] };
  it("nothing to flag says what was checked", () => {
    expect(riskRead(base)).toEqual({ line: "Nothing to flag", flags: [], source: "Checked the sender, your partners and exclusivity" });
  });
  it("sender, classify scam signals (unknown values dropped), exclusivity via the plan's own check, competitor of a partner, safety note", () => {
    const r = riskRead({
      ...base, qualification: "verify_first", channel: "unverifiable",
      classification: { risk_flags: ["upfront_fee", "made_up", "brand_safety_note"] },
      research: { category: "Apparel", competitors: ["Acme Shoes"], brand_safety: "A 2025 labour controversy." },
      conflicts: [{ what: "Your apparel partner holds apparel", blocks: ["apparel"], factIds: [] }],
      currentPartners: ["Acme Shoes"],
    });
    expect(r.flags).toEqual(["sender_mismatch", "upfront_fee", "exclusivity_conflict", "competitor_of_partner", "brand_safety_note"]);
    expect(r.line).toBe("Sender doesn’t match the brand · Asks for a fee up front");
  });
  it("research flags only from confirmed research; 'none' is not a safety note", () => {
    expect(riskRead({ ...base, currentPartners: ["Acme Shoes"] }).flags).toEqual([]);
    expect(safetyNote("No known controversies.")).toBe(false);
    expect(safetyNote(null)).toBe(false);
  });
});

describe("Fit / Goal checks", () => {
  const goal = { id: "g1", text: "Grow my running audience", status: "active" } as any;
  it("fit needs confirmed research and a real fact key; no figures; goal_ref must be given", () => {
    const ctx = { research: { name: "B" }, factKeys: new Set(["F1"]), goals: new Map([["G1", goal]]) };
    expect(checkFitGoal({ fit: "Their trail line meets your long-run content.", fit_facts: ["F1"], goal_ref: "G1" }, ctx)).toEqual({ fit: "Their trail line meets your long-run content.", goal });
    expect(checkFitGoal({ fit: "Great fit.", fit_facts: ["F9"], goal_ref: "G7" }, ctx)).toEqual({ fit: null, goal: null });
    expect(checkFitGoal({ fit: "Their 2M fans love you.", fit_facts: ["F1"], goal_ref: "none" }, ctx).fit).toBeNull();
    expect(checkFitGoal({ fit: "A fit.", fit_facts: ["F1"], goal_ref: "none" }, { ...ctx, research: null }).fit).toBeNull();
  });
  it("the inputs key moves with research identity, goals and the ask — not with unrelated fields", () => {
    const brand = { id: 1, enrichment: { identity: { status: "confirmed", checked_at: "a" } }, enriched_at: null, logo_url: "x" };
    const k = readInputsKey({ brand, goals: [goal], ask: "3 Reels" });
    expect(readInputsKey({ brand: { ...brand, logo_url: "y" }, goals: [goal], ask: "3 Reels" })).toBe(k);
    expect(readInputsKey({ brand: { ...brand, enrichment: { identity: { status: "unconfirmed", checked_at: "b" } } }, goals: [goal], ask: "3 Reels" })).not.toBe(k);
    expect(readInputsKey({ brand, goals: [{ ...goal, text: "Earn more" }], ask: "3 Reels" })).not.toBe(k);
    expect(readInputsKey({ brand, goals: [goal], ask: "2 Reels" })).not.toBe(k);
  });
});

describe("on the board and the detail (PGlite)", () => {
  let her = "";
  const opp: Record<string, string> = {};
  const deal: Record<string, string> = {};
  const CONFIRMED = { identity: { status: "confirmed", domain: "trailco.example", own_sources: ["trailco.example"], basis: "own_domain_source", checked_at: "2026-10-01" }, competitors: ["Acme Shoes"], brand_safety: null, product_categories: ["trail shoes"] };

  async function seed(name: string, o: { enrichment?: unknown; offer?: unknown; ask?: string; classification?: Record<string, unknown> }) {
    const at = new Date("2026-10-05T12:00:00Z");
    const [b] = await db.insert(inboxBrands).values({ name, normalized_name: name.toLowerCase(), enrichment: o.enrichment ?? null, category: o.enrichment ? "Footwear" : null } as any).returning({ id: inboxBrands.id });
    const [op] = await db.insert(opportunities).values({ athlete_id: her, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
    const [d] = await db.insert(deals).values({ athlete_id: her, brand_name: name, status: "detected", opportunity_id: op.id } as any).returning({ id: deals.id });
    const [t] = await db.insert(inboxThreads).values({
      athlete_id: her, deal_id: d.id, brand_id: b.id, subject: "x", status: "deal_detected", message_count: 1,
      classification: { qualification: "workable", channel: "direct", qualification_reason: "", category: "PAID", ...(o.classification ?? {}) },
      conversation_state: { key_details: { ask: o.ask ?? "3 Reels", awaiting_response_from: "athlete", offer_struct: o.offer ?? null } },
    } as any).returning({ id: inboxThreads.id });
    await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, op.id));
    await db.insert(inboxMessages).values({ athlete_id: her, thread_id: t.id, direction: "inbound", received_at: at } as any);
    opp[name] = op.id; deal[name] = d.id;
  }

  beforeAll(async () => {
    await initTestDb();
    her = await seedAthlete();
    await seed("Trailco", { enrichment: CONFIRMED, offer: { amount: 1200, unit: "total", deliverable_counts: { reels: 3 } } });
    await seed("Quietco", { offer: null, classification: { risk_flags: ["upfront_fee"] } });
    await dbStore.insertFacts(her, [{ subject: { kind: "athlete", name: "Test Athlete" }, claim: "Posts weekly trail-running videos.", type: "said", source: { ref: "chat:1" }, date: null, confidence: 1, runId: null } as any]);
    await dbStore.writeBrief(her, { summary: "s", sections: [], factIds: [], runId: null,
      internal: { currentSponsors: [{ name: "Acme Shoes", factIds: [] }], pastSponsors: [], exclusivityConflicts: [] } as any });
  });
  afterAll(async () => { await closeTestDb(); delete process.env.DEALS_READ_MODEL; });
  beforeEach(() => { runSkill.mockReset(); });

  it("money and risk on every card; fit / goal null until stored; no model call without DEALS_READ_MODEL", async () => {
    const board = await readOpportunityBoard(her, NOW);
    const trail = board.whatMatters.find((i) => i.brand.name === "Trailco")!;
    expect(trail.read!.money).toMatchObject({ state: "no_min", line: expect.stringContaining("$1,200 for 3 Reels") });
    expect(trail.read!.risk.flags).toEqual(["competitor_of_partner"]);
    expect(trail.read!.risk.line).toBe("Competes with your partner Acme Shoes");
    expect(trail.read!.fit).toBeNull();
    const quiet = board.whatMatters.find((i) => i.brand.name === "Quietco")!;
    expect(quiet.read!.money.state).toBe("no_fee");
    expect(quiet.read!.risk.flags).toEqual(["upfront_fee"]);
    expect(runSkill).not.toHaveBeenCalled();
  });

  it("DEALS_READ_MODEL on: the detail fills once, stores it, and serves it until an input changes", async () => {
    process.env.DEALS_READ_MODEL = "true";
    const g = await dbStore.insertGoal(her, { text: "Grow my trail-running audience", source: "said", decisionId: null });
    runSkill.mockImplementation(async (req: any) => {
      expect(req.skillId).toBe("deal-read");
      if (req.input.includes("Trailco")) {
        expect(req.input).not.toContain("Acme Shoes");        // competitors feed Risk, never the fit call
      }
      return { runId: "00000000-0000-4000-8000-000000000001", json: { fit: "Their trail shoes meet your weekly trail videos.", fit_facts: ["F1"], goal_ref: "G1" }, cost: {}, sources: [], queries: [], reused: false };
    });
    const d = (await readOpportunityDetail(her, opp["Trailco"], NOW))!;
    expect(d.read!.fit).toEqual({ line: "Their trail shoes meet your weekly trail videos.", source: "Nomila’s research and what you’ve shared" });
    expect(d.read!.goal).toEqual({ line: "Helps your goal: Grow my trail-running audience", source: "Your goals" });
    // One call for this deal (the board's background fill for the other card is its own call).
    expect(runSkill.mock.calls.filter((c) => c[0].input.includes("Trailco"))).toHaveLength(1);
    const [row] = await db.select().from(dealReads).where(eq(dealReads.deal_id, deal["Trailco"]));
    expect(row).toMatchObject({ goal_id: g.id, skill_version: "1.0.0" });

    const board = await readOpportunityBoard(her, NOW);
    expect(board.whatMatters.find((i) => i.brand.name === "Trailco")!.read!.fit!.line).toBe("Their trail shoes meet your weekly trail videos.");
    await new Promise((r) => setTimeout(r, 50));             // let the board's background fill for Quietco settle
    runSkill.mockClear();

    // Her goals change → stale: not served, refilled on the next detail read.
    await dbStore.updateGoal(her, g.id, { text: "Earn from paid partnerships" } as any);
    runSkill.mockImplementation(async () => ({ runId: "00000000-0000-4000-8000-000000000002", json: { fit: "", fit_facts: [], goal_ref: "none" }, cost: {}, sources: [], queries: [], reused: false }));
    const stale = await readOpportunityBoard(her, NOW);
    expect(stale.whatMatters.find((i) => i.brand.name === "Trailco")!.read!.fit).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    const again = (await readOpportunityDetail(her, opp["Trailco"], NOW))!;
    expect(again.read!.goal).toEqual({ line: NO_GOAL_LINE, source: "Your goals" });
    expect(again.read!.fit).toBeNull();
  });

  it("a Maybe email is not on the board (it still opens in the detail)", async () => {
    await seed("Maybeco", { offer: null, classification: { maybe: true } });
    const board = await readOpportunityBoard(her, NOW);
    expect([...board.whatMatters, ...board.explore, ...board.needsTermsBatch, ...board.needsYou].some((i) => i.brand.name === "Maybeco")).toBe(false);
    expect(board.order).not.toContain(opp["Maybeco"]);
    expect(await readOpportunityDetail(her, opp["Maybeco"], NOW)).not.toBeNull();
    const listed = (await listDealsTool.execute(her, { sort_by: "recency", limit: 20 } as any)) as any;
    expect(listed.deals.map((d: any) => d.brand_name)).not.toContain("Maybeco");
    expect(listed.deals.map((d: any) => d.brand_name)).toContain("Quietco");
  });

  it("board items carry the deal type and the parsed term sheet", async () => {
    await seed("Termsco", { offer: null, classification: { work_kind: "social_post", comp_kind: "cash", cash_amount: 600 } });
    await db.update(inboxThreads).set({ conversation_state: { key_details: { ask: "2 Reels", awaiting_response_from: "athlete", offer_struct: null,
      terms: { fee: { amount: 600, unit: "flat" }, deliverables: [{ kind: "ig_reel", count: 2 }], bogus: 1 } } } } as any)
      .where(eq(inboxThreads.deal_id, deal["Termsco"]));
    const item = (await readOpportunityBoard(her, NOW)).whatMatters.find((i) => i.brand.name === "Termsco")!;
    expect(item.dealType).toBe("paid_content");
    expect(item.terms).toMatchObject({ fee: { amount: 600, unit: "flat" }, deliverables: [{ kind: "ig_reel", count: 2 }] });
    expect(item.read!.money.line).toContain("$600 for 2 Reels");
  });

  it("the skill declares the brand research as outside text (fenced at the transport)", () => {
    const { loadJob, externalInputs } = jest.requireActual("../agent/jobs");
    expect(externalInputs(loadJob("deal-read"))).toEqual(["brand"]);
  });

  it("an unconfirmed brand never gets a fit line, whatever the model says", async () => {
    runSkill.mockImplementation(async () => ({ runId: "00000000-0000-4000-8000-000000000003", json: { fit: "Looks great.", fit_facts: ["F1"], goal_ref: "none" }, cost: {}, sources: [], queries: [], reused: false }));
    await seed("Freshco", { offer: null });
    const d = (await readOpportunityDetail(her, opp["Freshco"], NOW))!;
    expect(d.read!.fit).toBeNull();
    expect(d.read!.goal).toEqual({ line: NO_GOAL_LINE, source: "Your goals" });
  });
});
