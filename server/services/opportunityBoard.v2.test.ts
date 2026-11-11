/**
 * The board after decision D3 (DEALS_BOARD_V2, retired 2 Nov 2026: always on) + DEALS_MAYBE — her money and her move
 * first; a confirmed tier only breaks ties; unconfirmed research is never a penalty), commission only handled as product
 * only (23 Oct), per-type actions from INTENTS_BY_TYPE, the closed detail read-only instead of a 404, and the quiet Maybe
 * section (D5; DEALS_MAYBE off → no section). PGlite.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { compareOpportunitiesV2, stateOf, type OrderInput } from "../lib/opportunityOrder";
import { readOpportunityBoard } from "./opportunityBoard";
import { clearMaybeOnOpen, readOpportunityDetail } from "./opportunityDetail";

const NOW = new Date("2026-10-13T12:00:00Z");
const CONFIRMED = (domain: string) => ({ identity: { status: "confirmed", domain, own_sources: [domain], basis: "own_domain_source", checked_at: "2026-10-01" } });

describe("D3 comparator (pure)", () => {
  const o = (id: string, x: Partial<OrderInput>): OrderInput => ({ id, standing: "none", state: "needs_terms", channel: "direct", lastActivityAt: "2026-10-01", hers: true, cash: null, ...x });
  const sort = (xs: OrderInput[]) => [...xs].sort(compareOpportunitiesV2).map((x) => x.id);
  it("money first: a $5,000 agency offer from an unconfirmed brand beats a no-fee ask from an established brand", () => {
    expect(sort([o("known-no-fee", { standing: "established" }), o("agency-cash", { state: "cash", channel: "agency", cash: 5000 })]))
      .toEqual(["agency-cash", "known-no-fee"]);
  });
  it("her move first; more cash first within a state; tier only breaks a tie; no research ties with emerging", () => {
    expect(sort([o("theirs", { state: "cash", cash: 9000, hers: false }), o("mine", { state: "needs_terms" })])).toEqual(["mine", "theirs"]);
    expect(sort([o("small", { state: "cash", cash: 300 }), o("big", { state: "cash", cash: 3000 })])).toEqual(["big", "small"]);
    expect(sort([o("none", { state: "cash", cash: 500 }), o("est", { state: "cash", cash: 500, standing: "established" })])).toEqual(["est", "none"]);
    expect(sort([o("emerging", { standing: "emerging", lastActivityAt: "2026-09-01" }), o("none", { lastActivityAt: "2026-10-01" })])).toEqual(["none", "emerging"]);
  });
  it("an unverifiable sender still sorts last; product (and commission) only below any fee ask", () => {
    expect(sort([o("unv", { standing: "unverifiable", state: "cash", cash: 9000 }), o("x", { state: "product" })])).toEqual(["x", "unv"]);
    expect(sort([o("prod", { state: "product" }), o("ask", { state: "needs_terms" })])).toEqual(["ask", "prod"]);
  });
  it("commission only is the product state, flag on or off (owner, 23 Oct 2026)", () => {
    expect(stateOf("workable", { unit: "commission_only", amount: null }, "")).toBe("product");
    expect(stateOf("workable", { amount: null }, "Terms are stated (commission); …")).toBe("product");
    expect(stateOf("workable", { unit: "gifting_only", amount: null }, "")).toBe("product");
  });
});

describe("the board and the detail (PGlite)", () => {
  let her = "";
  let other = "";
  const opp: Record<string, string> = {};

  async function seed(name: string, o: { enrichment?: unknown; tier?: string; qualification?: string; channel?: string; category?: string; mediaKind?: string;
    workKind?: string; compKind?: string; offer?: unknown; reason?: string; maybe?: boolean; status?: "open" | "closed"; at?: string; athlete?: string }) {
    const who = o.athlete ?? her;
    const at = new Date(o.at ?? "2026-10-05T12:00:00Z");
    const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${who.slice(0, 4)}`, enrichment: o.enrichment ?? null, brand_tier: o.tier ?? null } as any).returning({ id: inboxBrands.id });
    const [op] = await db.insert(opportunities).values({ athlete_id: who, brand_id: b.id, status: o.status ?? "open", opened_at: at, last_activity_at: at,
      ...(o.status === "closed" ? { close_reason: "declined", closed_at: NOW } : {}) } as any).returning({ id: opportunities.id });
    const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: name, status: o.status === "closed" ? "rejected" : "detected", opportunity_id: op.id } as any).returning({ id: deals.id });
    const [t] = await db.insert(inboxThreads).values({
      athlete_id: who, deal_id: d.id, brand_id: b.id, subject: "x", status: "deal_detected", message_count: 1,
      classification: { qualification: o.qualification ?? "needs_terms", channel: o.channel ?? "direct", qualification_reason: o.reason ?? "", category: o.category ?? "PAID",
        ...(o.mediaKind ? { media_kind: o.mediaKind } : {}), ...(o.workKind ? { work_kind: o.workKind } : {}), ...(o.compKind ? { comp_kind: o.compKind } : {}),
        ...(o.maybe ? { maybe: true } : {}) },
      conversation_state: { key_details: { ask: "x", awaiting_response_from: "athlete", offer_struct: o.offer ?? null } },
    } as any).returning({ id: inboxThreads.id });
    await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, op.id));
    await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: at } as any);
    opp[name] = op.id;
  }

  beforeAll(async () => {
    await initTestDb();
    her = await seedAthlete();
    other = await seedAthlete("Someone Else");
    await seed("Knownbrand", { enrichment: CONFIRMED("known.example"), tier: "established" });
    await seed("Agencycash", { qualification: "workable", channel: "agency", compKind: "cash", offer: { amount: 5000, unit: "total" } });
    await seed("Affiliateco", { qualification: "workable", compKind: "commission", offer: { amount: null, unit: "commission_only" } });
    await seed("Giftco", { qualification: "workable", compKind: "product", offer: { amount: null, unit: "gifting_only" } });
    // Stored before the paid-no-amount rule: "cash plus product", no figure anywhere.
    await seed("Paidnofee", { qualification: "workable", channel: "agency", offer: { amount: null, unit: null },
      reason: "Terms are stated (cash plus product); it isn't a cash-only offer, so it isn't measured against your floor." });
    await seed("Pressco", { category: "MEDIA", mediaKind: "interview" });
    await seed("Maybeco", { maybe: true, at: "2026-10-06T12:00:00Z" });
    await seed("Closedco", { status: "closed" });
    await seed("Theirs", { status: "closed", athlete: other });
  });
  afterAll(async () => { await closeTestDb(); delete process.env.DEALS_MAYBE; });

  it("DEALS_MAYBE off: no Maybe section, and a Maybe email is not on the board", async () => {
    const board = await readOpportunityBoard(her, NOW);
    const names = board.needsYou.map((i) => i.brand.name);
    expect(board.maybe).toBeUndefined();
    expect(names).not.toContain("Maybeco");
  });

  it("her money first, commission only as product only, per-type actions", async () => {
    const board = await readOpportunityBoard(her, NOW);
    const names = board.needsYou.map((i) => i.brand.name);
    expect(names.indexOf("Agencycash")).toBeLessThan(names.indexOf("Knownbrand"));
    const aff = board.needsYou.find((i) => i.brand.name === "Affiliateco")!;
    expect(aff.state).toBe("product");
    expect(aff.line).toBe("Commission only, no set fee · X · Waiting on you since Oct 5");
    expect(aff.poster).toBe("product");
    expect(aff.dealType).toBe("affiliate");
    expect(aff.actions!.map((a) => a.intent)).toEqual(["ask_fee_plus_commission", "accept_affiliate", "decline"]);
    expect(board.needsYou.find((i) => i.brand.name === "Pressco")!.actions!.map((a) => a.intent))
      .toEqual(["accept_and_propose_times", "ask_questions", "ask_questions_in_advance", "redirect_to_pr", "decline"]);
    expect(board.needsYou.find((i) => i.brand.name === "Agencycash")!.actions![0]).toEqual({ intent: "accept_terms", label: "Accept terms" });
  });

  it("paid with no amount named: Needs terms + Ask for terms, never 'Accept or counter' (23 Oct)", async () => {
    const board = await readOpportunityBoard(her, NOW);
    const item = board.needsYou.find((i) => i.brand.name === "Paidnofee")!;
    expect(item).toMatchObject({ qualification: "needs_terms", state: "needs_terms", dealType: "paid_no_fee" });
    expect(item.next!.label).toBe("Ask for terms");
    expect(item.actions!.map((a) => a.intent)).toEqual(["ask_terms", "share_rate", "decline"]);
    expect(item.line).toContain("no fee yet");
    expect(item.line).not.toContain("Paid, no amount yet");
    // "Accept or counter" stays on stated terms (the $5,000 cash offer, the commission offer), never on this card.
    expect(board.needsYou.filter((x) => x.next?.label === "Accept or counter").map((x) => x.brand.name).sort()).toEqual(["Affiliateco", "Agencycash", "Giftco"]);
  });

  it("commission only is handled exactly like product only: state, chip, placement, poster, next step (owner, 23 Oct)", async () => {
    {
      const board = await readOpportunityBoard(her, NOW);
      const aff = board.needsYou.find((i) => i.brand.name === "Affiliateco")!;
      const gift = board.needsYou.find((i) => i.brand.name === "Giftco")!;
      const same = (i: typeof aff) => ({ qualification: i.qualification, state: i.state, poster: i.poster, next: i.next!.action, hers: i.next!.hers });
      expect(same(aff)).toEqual(same(gift));
      expect(aff.state).toBe("product");
      // Same rank: the two sit next to each other, below every ask that could pay a fee.
      const names = board.needsYou.map((i) => i.brand.name);
      expect(Math.abs(names.indexOf("Affiliateco") - names.indexOf("Giftco"))).toBe(1);
      expect(names.indexOf("Affiliateco")).toBeGreaterThan(names.indexOf("Agencycash"));
      expect(names.indexOf("Affiliateco")).toBeGreaterThan(names.indexOf("Paidnofee"));
      // Only the words differ, and they stay true.
      expect(aff.line.startsWith("Commission only, no set fee")).toBe(true);
      expect(gift.line.startsWith("Product only, no cash")).toBe(true);
      expect(aff.reason).toBe("They’re offering a commission on sales, not a set fee.");
    }
  });

  it("a closed opportunity opens read-only, never a 404; another athlete's is still not found", async () => {
    const d = (await readOpportunityDetail(her, opp["Closedco"], NOW))!;
    expect(d).not.toBeNull();
    expect(d.read_only).toBe(true);
    expect(d.closed).toEqual({ reason: "declined", at: NOW.toISOString() });
    expect(d.secondary).toEqual([]);
    expect(d.item.brand.name).toBe("Closedco");
    expect(await readOpportunityDetail(her, opp["Theirs"], NOW)).toBeNull();
    expect((await readOpportunityDetail(her, opp["Knownbrand"], NOW))!.read_only).toBeUndefined();
  });

  it("DEALS_MAYBE: its own quiet section, never in needsYou (Home) — and opening it makes it a real deal", async () => {
    process.env.DEALS_MAYBE = "true";
    const board = await readOpportunityBoard(her, NOW);
    expect(board.maybe!.map((i) => i.brand.name)).toEqual(["Maybeco"]);
    expect(board.maybe![0].maybe).toBe(true);
    expect(board.counts.maybe).toBe(1);
    expect(board.needsYou.map((i) => i.brand.name)).not.toContain("Maybeco");
    expect(board.order).not.toContain(opp["Maybeco"]);

    expect(await clearMaybeOnOpen(other, opp["Maybeco"])).toBe(0);      // not hers: nothing changes
    expect(await clearMaybeOnOpen(her, opp["Maybeco"])).toBe(1);
    const after = await readOpportunityBoard(her, NOW);
    expect(after.maybe).toEqual([]);
    expect(after.needsYou.map((i) => i.brand.name)).toContain("Maybeco");
  });
});
