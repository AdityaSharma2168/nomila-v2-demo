/**
 * opportunityBoard — every card's ONE next step and the "needs you" order (owner, 8 Oct 2026), against PGlite.
 *
 *   N1 new athlete     no opportunities → no needsYou, count 0
 *   N2 looks signed    e-sign paperwork reads signed and she hasn't said → "Confirm it’s signed" is the next step, with
 *                      the evidence as why, and it outranks every undated card
 *   N3 deadline        a deadline still ahead puts the card first, soonest first; a past one is ignored
 *   N4 why             the deal's own data: their ask for an ask-for-terms card, the plain qualification for a counter
 *                      (never the floor rule text), the "What's next" line when there is nothing else
 *   N5 their move      a new opportunity she wrote first and they haven't answered is never "needs you"
 *   N6 logo floor      a brand with an evidence domain but no stored logo shows the domain's favicon; no domain → none
 * Generic fixtures only: no athlete, sport, school or real brand.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { readOpportunityBoard } from "./opportunityBoard";

jest.setTimeout(120_000);

const NOW = new Date("2026-10-08T12:00:00Z");
let A = ""; let NEW = "";
let n = 0;

async function seed(athleteId: string, name: string, o: {
  qualification?: string; channel?: string; reason?: string; floor?: Record<string, unknown>; category?: string;
  ask?: string; awaiting?: string; lastIn: string; outbound?: boolean; dealStatus?: string; deadline?: string;
  domain?: string; logo?: string; signedPaperwork?: boolean;
}) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${++n}`, domain: o.domain ?? null, logo_url: o.logo ?? null } as any).returning({ id: inboxBrands.id });
  const at = new Date(o.lastIn);
  const [opp] = await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: name, status: o.dealStatus ?? "detected", opportunity_id: opp.id } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, brand_id: b.id, subject: null, status: "deal_detected", last_message_at: at,
    classification: {
      qualification: o.qualification ?? "needs_terms", channel: o.channel ?? "direct", qualification_reason: o.reason ?? "",
      ...(o.floor ? { qualification_floor: o.floor } : {}), ...(o.category ? { category: o.category } : {}), ...(o.deadline ? { deadline: o.deadline } : {}),
    },
    conversation_state: { key_details: { ask: o.ask ?? null, awaiting_response_from: o.awaiting ?? "athlete" } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, opp.id));
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "inbound", received_at: at } as any);
  if (o.outbound) await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t.id, direction: "outbound", received_at: new Date(at.getTime() + 60_000) } as any);
  if (o.signedPaperwork) {
    await db.insert(inboxThreads).values({
      athlete_id: athleteId, subject: null, status: "read", last_message_at: at,
      classification: { paperwork: { state: "matched", kind: "signature_request", event: "completed", deal_id: d.id, opportunity_id: opp.id, source_message_ids: [], observed_at: at.toISOString() } },
    } as any);
  }
  return { opp: opp.id, deal: d.id };
}

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Active Athlete");
  NEW = await seedAthlete("New Athlete");
  await seed(A, "Brand Signed", { dealStatus: "negotiating", outbound: true, awaiting: "brand", lastIn: "2026-10-01", signedPaperwork: true });
  await seed(A, "Brand Later", { ask: "two posts in November", deadline: "2026-10-20", lastIn: "2026-09-30" });
  await seed(A, "Brand Sooner", { ask: "one story", deadline: "2026-10-12", lastIn: "2026-09-29" });
  await seed(A, "Brand Past", { ask: "a reel", deadline: "2026-10-01", lastIn: "2026-10-05" });
  await seed(A, "Brand Floor", {
    qualification: "below_floor", reason: "The cash offered ($500 for 1 social post) is under your floor for this kind of work ($800 each).",
    floor: { kind: "social_post", cash: 500, units: 1, floor: 800, source: "minimum_rate" }, lastIn: "2026-10-04",
  });
  await seed(A, "Brand Mine", { awaiting: "brand", lastIn: "2026-10-06" });
  await seed(A, "Brand Domain", { domain: "brand-domain.example", ask: "a launch post", lastIn: "2026-10-03" });
});
afterAll(async () => { await closeTestDb(); });

it("N1: a new athlete has nothing waiting", async () => {
  const b = await readOpportunityBoard(NEW, NOW);
  expect(b.needsYou).toEqual([]);
  expect(b.whatMatters).toEqual([]);
  expect(b.counts.needsYou).toBe(0);
});

it("N2 + N3: a deadline still ahead first (soonest first), then looks-signed, then the rest; a past deadline is ignored", async () => {
  const b = await readOpportunityBoard(A, NOW);
  const names = b.needsYou.map((i) => i.brand.name);
  expect(names.slice(0, 3)).toEqual(["Brand Sooner", "Brand Later", "Brand Signed"]);
  expect(names).not.toContain("Brand Mine");
  expect(b.counts.needsYou).toBe(names.length);
  expect(b.whatMatters.map((i) => i.brand.name)).toEqual(names.slice(0, 5));
  const by = (x: string) => b.needsYou.find((i) => i.brand.name === x)!;
  expect(by("Brand Sooner").next).toMatchObject({ action: "ask_for_terms", label: "Ask for terms", due: "2026-10-12", hers: true });
  expect(by("Brand Past").next.due).toBeNull();
  const signed = by("Brand Signed");
  expect(signed.looks_signed).toBe(true);
  expect(signed.next).toMatchObject({ action: "confirm_signed", label: "Confirm it’s signed", why: "An e-signature email says every party has signed.", hers: true });
});

it("N4: why comes from the deal's own data, never the rule text", async () => {
  const b = await readOpportunityBoard(A, NOW);
  const by = (x: string) => b.needsYou.find((i) => i.brand.name === x)!;
  expect(by("Brand Later").next.why).toBe("Their ask: Two posts in November.");
  const floor = by("Brand Floor");
  expect(floor.next.action).toBe("counter");
  expect(floor.reason).toBe("They offered $500 for 1 social post. That’s under your minimum of $800 each.");
  expect(floor.next.why).toBe(floor.reason);
  for (const i of b.needsYou) {
    expect(i.next.why).not.toMatch(/floor|cash-only|measured against|classifier|qualification/i);
    expect(i.next.why.length).toBeGreaterThan(0);
  }
});

it("N5: their move is never 'needs you'", async () => {
  const b = await readOpportunityBoard(A, NOW);
  const mine = [...b.needsTermsBatch, ...b.explore, ...b.inMotion].find((i) => i.brand.name === "Brand Mine")!;
  expect(mine.next.hers).toBe(false);
});

it("N6: an evidence domain with no stored logo shows its favicon; no domain shows none", async () => {
  const b = await readOpportunityBoard(A, NOW);
  const by = (x: string) => b.needsYou.find((i) => i.brand.name === x)!;
  expect(by("Brand Domain").brand).toMatchObject({ domain: "brand-domain.example", safe_logo_url: "https://www.google.com/s2/favicons?domain=brand-domain.example&sz=128" });
  expect(by("Brand Later").brand).toMatchObject({ domain: null, safe_logo_url: null });
});
