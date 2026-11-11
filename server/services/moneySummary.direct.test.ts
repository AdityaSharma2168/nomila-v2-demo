/**
 * Money paid to her directly by a brand (its payment notice, paperwork `payment_received` with an amount) counts as
 * money in: listed with paid, added to the month / year totals, marked `direct`. Against PGlite; no provider.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { inboxBrands, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { readFinancialSummary, recentDirectPayments } from "./moneySummary";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });

async function notice(athleteId: string, brandId: number | null, paperwork: Record<string, unknown>) {
  await db.insert(inboxThreads).values({ athlete_id: athleteId, brand_id: brandId, subject: null, status: "unread", classification: { category: "NOISE", paperwork } } as any);
}

it("a brand's payment notice with an amount is money in; one without an amount, another athlete's, or another currency is not added", async () => {
  const athleteId = await seedAthlete("Paid directly");
  const other = await seedAthlete("Someone else");
  const [b] = await db.insert(inboxBrands).values({ name: "Payerco", normalized_name: "payerco" } as any).returning({ id: inboxBrands.id });
  const base = { state: "matched", kind: "payment", event: "payment_received", source_message_ids: [], observed_at: "2026-10-15T10:00:00Z" };
  await notice(athleteId, b.id, { ...base, deal_id: null, amount_cents: 500000, currency: "usd", paid_at: "2026-10-15T10:00:00Z" });
  await notice(athleteId, b.id, { ...base, paid_at: "2026-10-16T10:00:00Z" });                                             // no amount stated
  await notice(athleteId, b.id, { ...base, amount_cents: 9900, currency: "eur", paid_at: "2026-10-16T10:00:00Z" });         // another currency
  await notice(other, b.id, { ...base, amount_cents: 777700, currency: "usd", paid_at: "2026-10-15T10:00:00Z" });

  const f = await readFinancialSummary(athleteId, new Date("2026-10-20T00:00:00Z"));
  expect(f.hasMoney).toBe(true);
  expect(f.paidMonthCents).toBe(500000);
  expect(f.paidYearCents).toBe(500000);
  expect(f.payouts.paid).toEqual([expect.objectContaining({ label: "Payerco", amountCents: 500000, currency: "usd", direct: true, at: "2026-10-15T10:00:00.000Z" })]);
});

it("no notices: nothing changes (no money, no lines)", async () => {
  const f = await readFinancialSummary(await seedAthlete("Nothing yet"), new Date("2026-10-20T00:00:00Z"));
  expect(f.hasMoney).toBe(false);
  expect(f.payouts.paid).toEqual([]);
});

it("recentDirectPayments (Home's Wins): her notices paid since the date, newest first, from the same source", async () => {
  const athleteId = await seedAthlete("Recent pay");
  const [b] = await db.insert(inboxBrands).values({ name: "Recentco", normalized_name: "recentco" } as any).returning({ id: inboxBrands.id });
  const base = { state: "matched", kind: "payment", event: "payment_received", source_message_ids: [], observed_at: "2026-10-15T10:00:00Z", currency: "usd" };
  await notice(athleteId, b.id, { ...base, deal_id: "d1", amount_cents: 500000, paid_at: "2026-10-15T10:00:00Z" });
  await notice(athleteId, b.id, { ...base, deal_id: null, amount_cents: 1000, paid_at: "2026-10-01T10:00:00Z" });   // before the window
  await notice(athleteId, b.id, { ...base, deal_id: null, paid_at: "2026-10-16T10:00:00Z" });                        // no amount
  expect(await recentDirectPayments(athleteId, new Date("2026-10-13T00:00:00Z"))).toEqual([
    { id: expect.any(String), at: "2026-10-15T10:00:00.000Z", brand: "Recentco", cents: 500000, currency: "usd", dealId: "d1" },
  ]);
});
