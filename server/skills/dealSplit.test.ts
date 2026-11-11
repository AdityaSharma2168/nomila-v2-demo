/**
 * dealSplit — "This is a separate deal" (docs/design/brand-page-deals.md D7), against PGlite. gorjana's shape: the
 * ThetaBreakers chain folded into the endorsement thread becomes its own thread, deal (Pitched by you) and
 * opportunity, with a receipt; Undo puts it back while safe and refuses once the new deal has moved on. A deal
 * sharing an opportunity moves to its own. Tenancy holds. No provider is reached.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("./threadSummarizer", () => ({ summarizeThread: jest.fn(async () => null) }));

import { and, eq } from "drizzle-orm";
import { agentActions, dealPeriods, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { splitDeal, undoSplit } from "./dealSplit";

let athleteId = "";
let other = "";
let seq = 0;

async function endorsement(who: string) {
  const [b] = await db.insert(inboxBrands).values({ name: "gorjana", normalized_name: `gorjana-${++seq}` } as any).returning({ id: inboxBrands.id });
  const at = new Date("2026-07-29T00:00:00Z");
  const [o] = await db.insert(opportunities).values({ athlete_id: who, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_id: b.id, brand_name: "gorjana", status: "accepted", opportunity_id: o.id, deal_type: "ambassador", source: "inbox_scan" } as any).returning({ id: deals.id });
  const ext = `19fac-${++seq}`;
  const chain = `1a10dc60-${seq}`;
  const [t] = await db.insert(inboxThreads).values({ athlete_id: who, deal_id: d.id, brand_id: b.id, subject: null, status: "deal_detected", message_count: 4,
    external_thread_id: ext, alias_thread_ids: [chain], classification: { category: "PAID", brand_name: "gorjana" } } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, o.id));
  const rows = [
    { dir: "inbound", at: "2026-07-29T00:00:00Z", g: ext }, { dir: "outbound", at: "2026-07-30T00:00:00Z", g: ext },
    { dir: "outbound", at: "2026-10-05T00:00:00Z", g: chain }, { dir: "inbound", at: "2026-10-06T00:00:00Z", g: chain },
  ];
  for (const r of rows) await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: r.dir, received_at: new Date(r.at), gmail_thread_id: r.g } as any);
  return { brandId: b.id, oppId: o.id, dealId: d.id, threadId: t.id, ext, chain };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  other = await seedAthlete("Other");
});
afterAll(async () => { await closeTestDb(); });

it("splits the folded-in chain into its own thread, deal (outbound) and opportunity, with a reversible receipt; Undo restores it", async () => {
  const g = await endorsement(athleteId);
  const out = await splitDeal(athleteId, g.dealId, g.chain);
  if (!out.ok) throw new Error(out.error);
  const [nt] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, out.new_thread_id!));
  expect(nt).toMatchObject({ external_thread_id: g.chain, message_count: 2, deal_id: out.new_deal_id, brand_id: g.brandId });
  const [nd] = await db.select().from(deals).where(eq(deals.id, out.new_deal_id));
  // Its own group whatever OPPS_ONE_PER_BRAND says (off here): a split is "not the same deal".
  expect(nd).toMatchObject({ direction: "outbound", status: "detected", opportunity_id: out.new_opportunity_id, brand_id: g.brandId, deal_group_id: out.new_opportunity_id });
  const [no] = await db.select().from(opportunities).where(eq(opportunities.id, out.new_opportunity_id));
  expect(no).toMatchObject({ status: "open", brand_id: g.brandId, lead_thread_id: nt.id });
  const [old] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, g.threadId));
  expect(old.alias_thread_ids).toEqual([]);
  expect(old.message_count).toBe(2);
  const [orig] = await db.select().from(deals).where(eq(deals.id, g.dealId));
  expect(orig).toMatchObject({ status: "accepted", opportunity_id: g.oppId });
  const [r] = await db.select().from(agentActions).where(eq(agentActions.id, out.receipt_id));
  expect(r).toMatchObject({ action: "split_deal", reversible: true, deal_id: g.dealId });

  expect(await undoSplit(athleteId, r.payload as any)).toBe(true);
  const back = await db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, g.threadId));
  expect(back).toHaveLength(4);
  const [restored] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, g.threadId));
  expect(restored.alias_thread_ids).toEqual([g.chain]);
  expect(restored.message_count).toBe(4);
  expect(await db.select().from(deals).where(eq(deals.id, out.new_deal_id))).toHaveLength(0);
  expect(await db.select().from(opportunities).where(eq(opportunities.id, out.new_opportunity_id))).toHaveLength(0);
});

it("Undo is refused once the new deal has moved on (a contract schedule on it); nothing changes", async () => {
  const g = await endorsement(athleteId);
  const out = await splitDeal(athleteId, g.dealId, g.chain);
  if (!out.ok) throw new Error(out.error);
  await db.insert(dealPeriods).values({ deal_id: out.new_deal_id, seq: 1 } as any);
  const [r] = await db.select().from(agentActions).where(eq(agentActions.id, out.receipt_id));
  expect(await undoSplit(athleteId, r.payload as any)).toBe(false);
  expect(await db.select().from(deals).where(eq(deals.id, out.new_deal_id))).toHaveLength(1);
});

it("refuses the deal's own conversation, an unknown chain, and another athlete", async () => {
  const g = await endorsement(athleteId);
  expect(await splitDeal(athleteId, g.dealId, g.ext)).toMatchObject({ ok: false, status: 400 });
  expect(await splitDeal(athleteId, g.dealId, "nope")).toMatchObject({ ok: false, status: 404 });
  expect(await splitDeal(other, g.dealId, g.chain)).toMatchObject({ ok: false, status: 404 });
  const msgs = await db.select().from(inboxMessages).where(eq(inboxMessages.thread_id, g.threadId));
  expect(msgs).toHaveLength(4);
});

it("a deal sharing an opportunity moves to its own; a deal alone is already separate; undo moves it back", async () => {
  const g = await endorsement(athleteId);
  expect(await splitDeal(athleteId, g.dealId, null)).toMatchObject({ ok: false, status: 409 });
  const [second] = await db.insert(deals).values({ athlete_id: athleteId, brand_id: g.brandId, brand_name: "gorjana", status: "detected", opportunity_id: g.oppId } as any).returning({ id: deals.id });
  const out = await splitDeal(athleteId, second.id, null);
  if (!out.ok) throw new Error(out.error);
  const [moved] = await db.select().from(deals).where(eq(deals.id, second.id));
  expect(moved.opportunity_id).toBe(out.new_opportunity_id);
  expect(moved.deal_group_id).toBe(out.new_opportunity_id);
  const [r] = await db.select().from(agentActions).where(and(eq(agentActions.id, out.receipt_id)));
  expect(await undoSplit(athleteId, r.payload as any)).toBe(true);
  const [back] = await db.select().from(deals).where(eq(deals.id, second.id));
  expect(back.opportunity_id).toBe(g.oppId);
  expect(back.deal_group_id).toBeNull(); // the group it had before the split
});

it("awaitSummaries: the split resolves only after both threads are re-summarised (a script can close its pool)", async () => {
  const { summarizeThread } = jest.requireMock("./threadSummarizer") as { summarizeThread: jest.Mock };
  let finished = 0;
  summarizeThread.mockImplementation(() => new Promise((r) => setTimeout(() => { finished++; r(null); }, 20)));
  const g = await endorsement(athleteId);
  const out = await splitDeal(athleteId, g.dealId, g.chain, new Date(), { awaitSummaries: true });
  expect(out.ok).toBe(true);
  expect(finished).toBe(2);
  summarizeThread.mockImplementation(async () => null);
});

it("the thread and opportunity left behind keep their OWN dates, not the newest of the chain that moved away; Undo restores them", async () => {
  const g = await endorsement(athleteId);
  // As ingest left them: stamped with the moved chain's newest message.
  const stale = new Date("2026-10-06T00:00:00Z");
  await db.update(inboxThreads).set({ last_message_at: stale } as any).where(eq(inboxThreads.id, g.threadId));
  await db.update(opportunities).set({ last_activity_at: stale } as any).where(eq(opportunities.id, g.oppId));

  const out = await splitDeal(athleteId, g.dealId, g.chain);
  if (!out.ok) throw new Error(out.error);
  const [left] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, g.threadId));
  expect(left.last_message_at!.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, g.oppId));
  expect(opp.last_activity_at!.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  const [nt] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, out.new_thread_id!));
  expect(nt.last_message_at!.toISOString()).toBe("2026-10-06T00:00:00.000Z");

  const [r] = await db.select().from(agentActions).where(eq(agentActions.id, out.receipt_id));
  expect(await undoSplit(athleteId, r.payload as any)).toBe(true);
  const [back] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, g.threadId));
  expect(back.last_message_at!.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  const [oppBack] = await db.select().from(opportunities).where(eq(opportunities.id, g.oppId));
  expect(oppBack.last_activity_at!.toISOString()).toBe("2026-10-06T00:00:00.000Z");
});

it("a deal moved to its own opportunity takes its activity with it", async () => {
  const g = await endorsement(athleteId);
  const [second] = await db.insert(deals).values({ athlete_id: athleteId, brand_id: g.brandId, brand_name: "Second", status: "detected", opportunity_id: g.oppId } as any).returning({ id: deals.id });
  const [t2] = await db.insert(inboxThreads).values({ athlete_id: athleteId, deal_id: second.id, brand_id: g.brandId, status: "deal_detected", message_count: 1, last_message_at: new Date("2026-11-01T00:00:00Z") } as any).returning({ id: inboxThreads.id });
  await db.insert(inboxMessages).values({ athlete_id: athleteId, thread_id: t2.id, direction: "inbound", received_at: new Date("2026-11-01T00:00:00Z") } as any);
  await db.update(opportunities).set({ last_activity_at: new Date("2026-11-01T00:00:00Z") } as any).where(eq(opportunities.id, g.oppId));

  const out = await splitDeal(athleteId, second.id, null);
  if (!out.ok) throw new Error(out.error);
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, g.oppId));
  expect(opp.last_activity_at!.toISOString()).toBe("2026-10-06T00:00:00.000Z");
});
