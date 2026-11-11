/**
 * nomilaDeals.db.test.ts — Understand's `nomila_deals` input (understand 1.13.0), against PGlite with made-up athletes and
 * brands; no provider is reached.
 *
 *   N1 only her agreed deals: accepted, completed or signed — never detected, pending, negotiating or rejected
 *   N2 never another athlete's deals (nor their periods or deliverables)
 *   N3 the fee comes from the contract schedule (guaranteed, live periods) before the recorded offer; product only and
 *      commission only are named, never a price; signed contract vs email only
 *   N4 several threads of one deal (deal_group_id) count once, the signed one kept
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { dealDeliverables, dealPeriods, deals, inboxBrands } from "../../../shared/schema";
import { loadNomilaDeals, oneRowPerDeal } from "./nomilaDeals";

jest.setTimeout(120_000);

let her = "";
let someoneElse = "";

const insertDeal = async (athleteId: string, v: Record<string, unknown>) => {
  const [row] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Unnamed brand", ...v } as any).returning({ id: deals.id });
  return row.id as string;
};

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Test Athlete One");
  someoneElse = await seedAthlete("Test Athlete Two");
  const [brand] = await db.insert(inboxBrands).values({ name: "Example Outfitters", normalized_name: "example outfitters" } as any).returning({ id: inboxBrands.id });

  // Hers, agreed: a signed contract with a schedule (guaranteed cash, a conditional year, a superseded row) and deliverables.
  const signed = await insertDeal(her, {
    brand_name: "example outfitters inc", brand_id: brand.id, deal_type: "social_post", status: "accepted", source: "contract_upload",
    signed_at: new Date("2026-05-01T12:00:00Z"), signed_source: "contract", amount_cash: "999", created_at: new Date("2026-05-01T00:00:00Z"),
  });
  await db.insert(dealPeriods).values([
    { deal_id: signed, seq: 1, cash_cents: 100_000, guaranteed: true },
    { deal_id: signed, seq: 2, cash_cents: 50_000, guaranteed: true },
    { deal_id: signed, seq: 3, cash_cents: 900_000, guaranteed: false, condition: "if she turns professional" },
    { deal_id: signed, seq: 2, cash_cents: 777_700, guaranteed: true, superseded_at: new Date("2026-04-01T00:00:00Z") },
  ] as any);
  await db.insert(dealDeliverables).values([
    { deal_id: signed, seq: 1, format: "Reel · 9:16", kind: "reel", quantity: 2 },
    { deal_id: signed, seq: 2, format: "Static post", kind: "post", quantity: 1 },
  ] as any);
  // Hers, accepted by email: product only.
  await insertDeal(her, { brand_name: "A Local Cafe", deal_type: "other", status: "accepted", source: "inbox_scan", amount_product: "120", created_at: new Date("2026-03-01T00:00:00Z") });
  // Hers, completed, commission only, self-reported.
  await insertDeal(her, { brand_name: "An Affiliate Shop", deal_type: "other", status: "completed", source: "self_reported", commission_pct: "10", created_at: new Date("2026-02-01T00:00:00Z") });
  // Hers, NOT agreed: detected, pending, negotiating, rejected (even one marked signed).
  for (const status of ["detected", "pending", "negotiating"]) await insertDeal(her, { brand_name: `Not agreed ${status}`, status, source: "inbox_scan", amount_cash: "5000" });
  await insertDeal(her, { brand_name: "Rejected one", status: "rejected", source: "inbox_scan", signed_at: new Date(), signed_source: "confirmed" });
  // Hers: two threads of one deal (grouped), the signed one kept, its fee from the recorded offer.
  const group = "00000000-0000-4000-8000-00000000abcd";
  await insertDeal(her, { brand_name: "Grouped Brand", status: "accepted", source: "inbox_scan", amount_cash: "300", deal_group_id: group, created_at: new Date("2026-06-02T00:00:00Z") });
  await insertDeal(her, { brand_name: "Grouped Brand", status: "negotiating", source: "inbox_scan", amount_cash: "300", deal_group_id: group, signed_at: new Date("2026-06-01T00:00:00Z"), signed_source: "confirmed", created_at: new Date("2026-06-01T00:00:00Z") });

  // Someone else's agreed, signed deal: never hers.
  const theirs = await insertDeal(someoneElse, { brand_name: "Their Brand", status: "accepted", source: "inbox_scan", signed_at: new Date(), signed_source: "confirmed", amount_cash: "88888" });
  await db.insert(dealPeriods).values({ deal_id: theirs, seq: 1, cash_cents: 8_888_800, guaranteed: true } as any);
  await db.insert(dealDeliverables).values({ deal_id: theirs, seq: 1, format: "Their deliverable", kind: "post", quantity: 9 } as any);
});
afterAll(async () => { await closeTestDb(); });

test("N1–N4: her agreed deals only, the fee from the schedule first, one per grouped deal, newest first", async () => {
  const list = await loadNomilaDeals(her);
  expect(list).toEqual([
    { brand: "Grouped Brand", dealType: null, deliverables: [], fee: { amount: 300, currency: "USD", basis: "deal_record" }, productOnly: false, commissionOnly: false, date: "2026-06-01", confirmedBy: "signed_contract" },
    { brand: "Example Outfitters", dealType: "social_post", deliverables: ["2x Reel · 9:16", "1x Static post"], fee: { amount: 1500, currency: "USD", basis: "contract_schedule" }, productOnly: false, commissionOnly: false, date: "2026-05-01", confirmedBy: "signed_contract" },
    { brand: "A Local Cafe", dealType: "other", deliverables: [], fee: null, productOnly: true, commissionOnly: false, date: "2026-03-01", confirmedBy: "email_only" },
    { brand: "An Affiliate Shop", dealType: "other", deliverables: [], fee: null, productOnly: false, commissionOnly: true, date: "2026-02-01", confirmedBy: "not_signed" },
  ]);
  const text = JSON.stringify(list);
  expect(text).not.toMatch(/Not agreed|Rejected one|Their Brand|Their deliverable|88888/);
});

test("N2: someone else sees only their own", async () => {
  const theirs = await loadNomilaDeals(someoneElse);
  expect(theirs.map((d) => d.brand)).toEqual(["Their Brand"]);
  expect(theirs[0]).toMatchObject({ fee: { amount: 88888, basis: "contract_schedule" }, deliverables: ["9x Their deliverable"] });
  expect(await loadNomilaDeals("00000000-0000-4000-8000-000000000000")).toEqual([]);
});

test("oneRowPerDeal keeps ungrouped rows and the signed row of a group", () => {
  const rows = [
    { id: "a", deal_group_id: "g", signed_at: null },
    { id: "b", deal_group_id: null, signed_at: null },
    { id: "c", deal_group_id: "g", signed_at: "2026-01-01" },
  ];
  expect(oneRowPerDeal(rows).map((r) => r.id)).toEqual(["c", "b"]);
});
