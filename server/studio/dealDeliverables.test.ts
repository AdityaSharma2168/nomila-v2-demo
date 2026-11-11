/**
 * dealDeliverables.test.ts — what she owes, and whose it is.
 *
 * PGlite, so the FK to deals, the CHECK constraints and the partial unique index are all real
 * Postgres. `initTestDb()` pushes shared/schema.ts, which is where deal_deliverables is declared —
 * no extra DDL file is needed for this table.
 *
 * The properties that matter, in order:
 *   1. TENANCY. A deliverable has no athlete_id; it is reached only through a deal, and a deal
 *      belongs to somebody. Athlete B's work must never appear for A — by any route, including a
 *      brandId filter aimed at a brand only B has a deal with.
 *   2. It returns OUTSTANDING work. Fulfilled, waived, cancelled, superseded and rejected-deal
 *      rows are all excluded, and each exclusion is asserted separately so a regression names
 *      itself rather than collapsing the count by one.
 *   3. `dueOn` survives as the DATE STRING it was stored as. Never a Date, never an instant —
 *      that conversion is the off-by-one nowLogic exists to avoid.
 *   4. `delivered` is DERIVED and is 0 while nothing writes media_assets.deal_deliverable_id.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, dealDeliverables, deals, inboxBrands, mediaAssets } from "../../shared/schema";
import { listOutstandingDeliverables } from "./dealDeliverables";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
const OTHER_ATHLETE_ID = "99999999-8888-4777-8666-555555555555";

let herDealId: string;
let hisDealId: string;
let rejectedDealId: string;

const GORJANA = 1;
const OTHER_BRAND = 2;

beforeAll(async () => {
  await initTestDb();

  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" },
    { id: OTHER_ATHLETE_ID, full_name: "Other Athlete", sport: "soccer" },
  ] as never);

  await db.insert(inboxBrands).values([
    { id: GORJANA, name: "gorjana" },
    { id: OTHER_BRAND, name: "Someone Else" },
  ] as never);

  const [hers] = await db.insert(deals).values(
    { athlete_id: ATHLETE_ID, brand_name: "gorjana", brand_id: GORJANA, status: "accepted" } as never,
  ).returning({ id: deals.id });
  herDealId = hers.id;

  const [his] = await db.insert(deals).values(
    { athlete_id: OTHER_ATHLETE_ID, brand_name: "Someone Else", brand_id: OTHER_BRAND, status: "accepted" } as never,
  ).returning({ id: deals.id });
  hisDealId = his.id;

  const [rejected] = await db.insert(deals).values(
    { athlete_id: ATHLETE_ID, brand_name: "Turned Down", brand_id: null, status: "rejected" } as never,
  ).returning({ id: deals.id });
  rejectedDealId = rejected.id;
});

afterAll(async () => { await closeTestDb(); });

/** One obligation. `seq` is explicit so the partial unique index is exercised as it would be live. */
async function seed(over: Record<string, unknown>) {
  const [row] = await db.insert(dealDeliverables).values({
    deal_id: herDealId, seq: 1, format: "Reel · 9:16", kind: "reel", quantity: 3,
    ...over,
  } as never).returning({ id: dealDeliverables.id });
  return row.id;
}

// ─── 1. Tenancy ─────────────────────────────────────────────────────────────────────────────────

describe("whose deliverables these are", () => {
  it("NEVER returns another athlete's, even when hers is empty", async () => {
    await db.insert(dealDeliverables).values(
      { deal_id: hisDealId, seq: 1, format: "3x Story", kind: "story", quantity: 3, campaign: "His Campaign" } as never,
    );

    const mine = await listOutstandingDeliverables(ATHLETE_ID);
    expect(mine).toEqual([]);

    // Proof the row exists and is reachable for its OWNER — otherwise this test passes for the
    // wrong reason the day the seed breaks.
    const his = await listOutstandingDeliverables(OTHER_ATHLETE_ID);
    expect(his).toHaveLength(1);
    expect(his[0].campaign).toBe("His Campaign");
  });

  it("returns only hers when both athletes have work", async () => {
    await seed({ seq: 10, campaign: "Coastal Capsule" });

    const mine = await listOutstandingDeliverables(ATHLETE_ID);
    expect(mine.map((d) => d.campaign)).toEqual(["Coastal Capsule"]);
    expect(mine.every((d) => d.dealId === herDealId)).toBe(true);
  });

  it("a brandId aimed at a brand only the OTHER athlete deals with returns nothing", async () => {
    // The filter narrows her own set; it can never reach across to somebody else's deal. If the
    // predicate were ever applied INSTEAD of the athlete one rather than alongside it, this is the
    // test that catches it.
    const leaked = await listOutstandingDeliverables(ATHLETE_ID, { brandId: OTHER_BRAND });
    expect(leaked).toEqual([]);
  });

  it("a brandId narrows to that brand's deals and nothing else", async () => {
    const forGorjana = await listOutstandingDeliverables(ATHLETE_ID, { brandId: GORJANA });
    expect(forGorjana).toHaveLength(1);
    expect(forGorjana[0].brandId).toBe(GORJANA);
    expect(forGorjana[0].brandName).toBe("gorjana");
  });
});

// ─── 2. Outstanding, not all ────────────────────────────────────────────────────────────────────

describe("what counts as still owed", () => {
  it("excludes fulfilled, waived and cancelled work — each on its own", async () => {
    const base = await listOutstandingDeliverables(ATHLETE_ID);

    await seed({ seq: 20, status: "fulfilled", campaign: "Done" });
    expect(await listOutstandingDeliverables(ATHLETE_ID)).toHaveLength(base.length);

    await seed({ seq: 21, status: "waived", campaign: "Waived" });
    expect(await listOutstandingDeliverables(ATHLETE_ID)).toHaveLength(base.length);

    await seed({ seq: 22, status: "cancelled", campaign: "Cancelled" });
    expect(await listOutstandingDeliverables(ATHLETE_ID)).toHaveLength(base.length);
  });

  it("excludes a superseded row and keeps the one that replaced it", async () => {
    // The amendment shape: the old row is stamped, not rewritten, and both keep their own seq.
    await seed({ seq: 30, quantity: 3, campaign: "Amended", superseded_at: new Date() });
    await seed({ seq: 31, quantity: 5, campaign: "Amended" });

    const rows = (await listOutstandingDeliverables(ATHLETE_ID)).filter((d) => d.campaign === "Amended");
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(5);
  });

  it("excludes obligations on a deal she rejected", async () => {
    await db.insert(dealDeliverables).values(
      { deal_id: rejectedDealId, seq: 1, format: "1x Post", kind: "post", campaign: "Never Happened" } as never,
    );
    const rows = await listOutstandingDeliverables(ATHLETE_ID);
    expect(rows.map((d) => d.campaign)).not.toContain("Never Happened");
  });
});

// ─── 3. The date stays a date ───────────────────────────────────────────────────────────────────

describe("due_on survives the read", () => {
  it("comes back as the DATE STRING it was stored as, not an instant", async () => {
    await seed({ seq: 40, due_on: "2026-10-12", campaign: "Dated" });

    const row = (await listOutstandingDeliverables(ATHLETE_ID)).find((d) => d.campaign === "Dated")!;
    // The exact string. A Date here — or an ISO instant — is the off-by-one that renders work due
    // today as "1 day late" for every athlete west of Greenwich. See nowLogic.localDay.
    expect(row.dueOn).toBe("2026-10-12");
    expect(typeof row.dueOn).toBe("string");
  });

  it("orders soonest first and sinks the undated", async () => {
    await seed({ seq: 41, due_on: "2026-09-01", campaign: "Soonest" });
    await seed({ seq: 42, due_on: null, campaign: "Undated" });

    const rows = await listOutstandingDeliverables(ATHLETE_ID);
    const dated = rows.filter((d) => d.dueOn);
    const sorted = [...dated].sort((a, b) => (a.dueOn as string).localeCompare(b.dueOn as string));
    expect(dated.map((d) => d.dueOn)).toEqual(sorted.map((d) => d.dueOn));
    expect(rows[rows.length - 1].dueOn).toBeNull();
  });
});

// ─── 4. delivered is derived ────────────────────────────────────────────────────────────────────

describe("the delivered count", () => {
  it("is 0 while nothing writes media_assets.deal_deliverable_id — which is TRUE, not a stub", async () => {
    const id = await seed({ seq: 50, quantity: 3, campaign: "Uncounted" });
    const row = (await listOutstandingDeliverables(ATHLETE_ID)).find((d) => d.id === id)!;
    expect(row.delivered).toBe(0);
    expect(row.total).toBe(3);
  });

  it("counts approved assets pointing at it once something does write the link", async () => {
    // Written by hand here precisely BECAUSE no production path does it yet. This is the assertion
    // that the derivation is real rather than hardcoded — the day the attribution PR lands, the
    // numbers start moving with no change to the read.
    const id = await seed({ seq: 51, quantity: 3, campaign: "Counted" });

    await db.insert(mediaAssets).values([
      { athlete_id: ATHLETE_ID, platform: "studio", media_type: "IMAGE", origin: "generated",
        status: "stored", approval_status: "approved", deal_deliverable_id: id },
      { athlete_id: ATHLETE_ID, platform: "studio", media_type: "IMAGE", origin: "generated",
        status: "stored", approval_status: "approved", deal_deliverable_id: id },
      // draft — cleared for nothing yet, so it does not count
      { athlete_id: ATHLETE_ID, platform: "studio", media_type: "IMAGE", origin: "generated",
        status: "stored", approval_status: "draft", deal_deliverable_id: id },
      // approved but soft-deleted — gone is gone
      { athlete_id: ATHLETE_ID, platform: "studio", media_type: "IMAGE", origin: "generated",
        status: "stored", approval_status: "approved", deal_deliverable_id: id, deleted_at: new Date() },
    ] as never);

    const row = (await listOutstandingDeliverables(ATHLETE_ID)).find((d) => d.id === id)!;
    expect(row.delivered).toBe(2);
    expect(row.total).toBe(3);
  });
});

// ─── 5. The shape the client renders ────────────────────────────────────────────────────────────

describe("the mapping to the client's Deliverable", () => {
  it("falls back through the brand rather than leaving the row title blank", async () => {
    // `campaign` is the row TITLE on both surfaces that render it, so it must never be empty.
    const id = await seed({ seq: 60, campaign: null });
    const row = (await listOutstandingDeliverables(ATHLETE_ID)).find((d) => d.id === id)!;
    expect(row.campaign).toBe("gorjana");
  });

  it("renders the contract's own words for the format, not our vocabulary", async () => {
    const id = await seed({ seq: 61, format: "1x static IG post, in-feed", kind: "post" });
    const row = (await listOutstandingDeliverables(ATHLETE_ID)).find((d) => d.id === id)!;
    expect(row.format).toBe("1x static IG post, in-feed");
  });
});
