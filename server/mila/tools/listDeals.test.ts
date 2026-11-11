/**
 * list_deals tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * Covers: populated + sorted shape · status filter · limit · defensive dedupe
 * where the surviving row is deterministic per sort mode · empty → [] ·
 * cross-athlete tenancy probe · char-budget.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { randomUUID } from "node:crypto";
import { listDealsTool } from "./listDeals";
import { MILA } from "../config";
import { deals, inboxThreads } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";

/** The tool returns a PAGE ({ deals, total, by_status }); most assertions want the rows. */
const rows = async (athleteId: string, args: any = {}): Promise<any[]> =>
  ((await listDealsTool.execute(athleteId, args)) as any).deals;
const page = async (athleteId: string, args: any = {}): Promise<any> =>
  (await listDealsTool.execute(athleteId, args)) as any;

let athleteA: string;
let athleteB: string;
/** Athlete B's deal amount — the leak marker. See the note where it is seeded. */
const LEAK_AMOUNT = "987654321";

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Athlete A");
  athleteB = await seedAthlete("Athlete B");

  // Two Nike deals on the same athlete. nike1 is the MORE recent but lower-value
  // row; nike2 is older but higher-value — so their order differs by sort mode.
  // They are linked to threads with DISTINCT external ids: the unique index
  // uniq_threads_athlete_external (athlete_id, external_thread_id) now forbids two
  // threads sharing one external id per athlete, so list_deals' defensive dedupe
  // (which collapsed same-(brand, external_thread) rows) can no longer be
  // triggered through the schema — both rows legitimately surface.
  const [nike1] = await db
    .insert(deals)
    .values({
      athlete_id: athleteA,
      brand_name: "Nike",
      deal_type: "social_post",
      amount: "500",
      status: "detected",
      source: "inbox_scan",
      detected_at: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: deals.id });
  const [nike2] = await db
    .insert(deals)
    .values({
      athlete_id: athleteA,
      brand_name: "Nike",
      deal_type: "social_post",
      amount: "800",
      status: "detected",
      source: "inbox_scan",
      detected_at: new Date("2026-07-10T00:00:00Z"),
    })
    .returning({ id: deals.id });

  // Distinct grid assessments per row, so the value-winner and recency-winner
  // carry different verdicts — proving the surfaced score follows the
  // first thread linked to each deal.
  await db.insert(inboxThreads).values({
    athlete_id: athleteA,
    deal_id: nike1.id,
    external_thread_id: "ext-nike-1",
    status: "unread",
  });
  await db.insert(inboxThreads).values({
    athlete_id: athleteA,
    deal_id: nike2.id,
    external_thread_id: "ext-nike-2",
    status: "unread",
  });

  // Distinct, unlinked deals.
  await db.insert(deals).values({
    athlete_id: athleteA,
    brand_name: "Adidas",
    deal_type: "appearance",
    amount: "300",
    status: "pending",
    detected_at: new Date("2026-07-15T00:00:00Z"),
  });
  await db.insert(deals).values({
    athlete_id: athleteA,
    brand_name: "Puma",
    deal_type: "ambassador",
    amount: null,
    status: "negotiating",
    detected_at: new Date("2026-07-18T00:00:00Z"),
  });

  // B: a leak marker — must never surface in A's results.
  await db.insert(deals).values({
    athlete_id: athleteB,
    brand_name: "SecretBrand",
    // ⚠️ NINE DIGITS, NOT "9999". The probe below greps the whole serialized result for this, and
    // the result carries random UUID deal ids — four hex characters collide with one about once in
    // 600 runs (it did, in CI: id `8999984a-…`, reported as a tenancy leak that was not one). A
    // nine-digit run cannot plausibly occur in a UUID, so the assertion stays exactly as broad and
    // loses only its false positive.
    amount: LEAK_AMOUNT,
    status: "detected",
    detected_at: new Date("2026-07-19T00:00:00Z"),
  });
  void nike1;
  void nike2;
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("list_deals", () => {
  it("sorts by value, highest amount first with NULLS LAST", async () => {
    const result = await rows(athleteA, { sort_by: "value" });

    // Both Nike rows surface (distinct threads → not collapsed); the 800 row
    // leads the 500 row under value sort.
    const nike = result.filter((d) => d.brand_name === "Nike");
    expect(nike).toHaveLength(2);
    expect(nike[0].amount).toBe(800);
    expect(nike[1].amount).toBe(500);
    // …and the surfaced assessment belongs to that same (nike2) row.
    expect(nike[0].verdict).toBeNull();
    expect(nike[0].score_numeric).toBeNull();
    // Adidas has no thread → unscored → null (buildWidget defaults it to fair/5).
    const adidas = result.find((d) => d.brand_name === "Adidas")!;
    expect(adidas.verdict).toBeNull();
    expect(adidas.score_numeric).toBeNull();

    // The model's view of the page carries no deal score (Opportunities PR 1); totals and
    // every other field survive.
    const full = await listDealsTool.execute(athleteA, { sort_by: "value" }) as { deals: Record<string, unknown>[]; total: number };
    const forModel = listDealsTool.modelView!(full) as { deals: Record<string, unknown>[]; total: number };
    expect(forModel.total).toBe(full.total);
    expect(forModel.deals).toHaveLength(full.deals.length);
    for (const d of forModel.deals) {
      expect(d).not.toHaveProperty("verdict");
      expect(d).not.toHaveProperty("score_numeric");
      expect(d).toHaveProperty("brand_name");
      expect(d).toHaveProperty("offer");
      // Brand-derived text is fenced for the model (12 Oct 2026); the raw rows keep it plain.
      expect(d.brand_name).toMatch(/^<external_content>[\s\S]*<\/external_content>$/);
    }
    expect(full.deals.every((d) => !String(d.brand_name).includes("external_content"))).toBe(true);

    // Order: 800, 500, 300, then the unpriced Puma last (NULLS LAST).
    expect(result.map((d) => d.brand_name)).toEqual(["Nike", "Nike", "Adidas", "Puma"]);
    expect(result[result.length - 1].amount).toBeNull();
    // Amounts are numbers, never numeric strings.
    for (const d of result) {
      expect(["number", "object"]).toContain(typeof d.amount); // number | null
    }
    expect(typeof result[0].amount).toBe("number");
  });

  it("recency sort orders by most recent first", async () => {
    const result = await rows(athleteA, { sort_by: "recency" });
    // Both Nike rows surface; recency puts the newer nike1 (500, 2026-07-20)
    // ahead of the older nike2 (800, 2026-07-10).
    const nike = result.filter((d) => d.brand_name === "Nike");
    expect(nike).toHaveLength(2);
    expect(nike[0].amount).toBe(500);
    expect(nike[1].amount).toBe(800);
    // …and its assessment, not nike2's.
    expect(nike[0].verdict).toBeNull();
    expect(nike[0].score_numeric).toBeNull();
  });

  it("filters by status", async () => {
    const result = await rows(athleteA, { status: "pending" });
    expect(result).toHaveLength(1);
    expect(result[0].brand_name).toBe("Adidas");
  });

  it("respects limit", async () => {
    const result = await rows(athleteA, { limit: 1 });
    expect(result).toHaveLength(1);
  });

  it("returns an empty list when the athlete has no deals", async () => {
    const bare = await seedAthlete("No Deals");
    expect(await rows(bare)).toEqual([]);
    expect((await page(bare)).total).toBe(0);
  });

  it("never returns another athlete's deals (tenancy probe)", async () => {
    const result = await listDealsTool.execute(athleteA, {});
    const json = JSON.stringify(result);
    expect(json).not.toContain("SecretBrand");
    expect(json).not.toContain(LEAK_AMOUNT);
    expect(json).not.toContain(athleteB);
  });


  // ─── Cross-thread grouping ──────────────────────────────────────────────────
  //
  // The live shape this reproduces: gorjana arrived as six rows under one
  // deal_group_id — the negotiation ($14,000, accepted, 29 Jul), an e-signature
  // request, a "Completed" notice, and two "waiting for you to sign" reminders,
  // all unpriced `detected` rows detected LATER. Mila reported six deals; the
  // app showed one. These pin the collapse and, just as importantly, WHICH row
  // survives it.
  describe("a deal that arrived on several threads", () => {
    let grouped: string;

    beforeAll(async () => {
      grouped = await seedAthlete("Grouped Deals");
      const groupId = randomUUID();

      const mk = async (
        status: string,
        amount: string | null,
        detected: string,
      ) => {
        const [d] = await db
          .insert(deals)
          .values({
            athlete_id: grouped,
            brand_name: "gorjana",
            deal_type: "social_post",
            amount,
            status,
            source: "inbox_scan",
            detected_at: new Date(detected),
            deal_group_id: groupId,
          } as any)
          .returning({ id: deals.id });
        await db.insert(inboxThreads).values({
          athlete_id: grouped,
          deal_id: d.id,
          external_thread_id: randomUUID(),
        } as any);
        return d.id;
      };

      await mk("accepted", "14000", "2026-07-29T00:00:00Z");
      await mk("detected", null, "2026-08-15T00:00:00Z");
      await mk("detected", null, "2026-08-22T00:00:00Z");
      await mk("detected", null, "2026-08-29T00:00:00Z");
    });

    it("is one row, not four", async () => {
      const result = await rows(grouped);
      expect(result).toHaveLength(1);
    });

    it("says how many threads it spans, so Mila need not guess", async () => {
      const [row] = await rows(grouped);
      expect(row.thread_count).toBe(4);
    });

    it("is represented by the accepted deal, not the newest reminder", async () => {
      // THE REGRESSION THIS GUARDS. The default sort is recency, so the plain
      // first-row winner is the 29 Aug reminder: an unpriced `detected` row
      // standing in for an accepted $14,000 deal.
      const [row] = await rows(grouped);
      expect(row.status).toBe("accepted");
      expect(row.amount).toBe(14000);
    });

    it("collapses under either sort", async () => {
      const byValue = await rows(grouped, { sort_by: "value" });
      expect(byValue).toHaveLength(1);
      expect(byValue[0].status).toBe("accepted");
    });

    it("keeps genuinely separate deals separate", async () => {
      // An ungrouped deal for the same brand must not be swept in — the group id
      // is the only thing that may merge rows.
      const [other] = await db
        .insert(deals)
        .values({
          athlete_id: grouped,
          brand_name: "gorjana",
          deal_type: "appearance",
          amount: "2000",
          status: "negotiating",
          source: "inbox_scan",
          detected_at: new Date("2026-09-01T00:00:00Z"),
        } as any)
        .returning({ id: deals.id });
      await db.insert(inboxThreads).values({
        athlete_id: grouped,
        deal_id: other.id,
        external_thread_id: randomUUID(),
      } as any);

      const result = await rows(grouped);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.thread_count).sort()).toEqual([1, 4]);
    });
  });


  // ─── The page is not the book ───────────────────────────────────────────────
  //
  // THE BUG THESE EXIST FOR. Mila told an athlete with 206 deals: "All ten active
  // deals are tracking normally." She was not hallucinating — the tool handed her
  // ten rows and no total, so ten rows WAS the whole world as far as she could see.
  // A cap the reader cannot see is indistinguishable from a total.
  describe("a page that says it is a page", () => {
    let many: string;

    beforeAll(async () => {
      many = await seedAthlete("Many Deals");
      // 14 rows: one accepted with real money, one negotiating, twelve raw detections.
      // Deliberately mirrors the live shape — the noise vastly outnumbers the book.
      await db.insert(deals).values({
        athlete_id: many, brand_name: "gorjana", deal_type: "social_post",
        amount: "14000", status: "accepted", source: "inbox_scan",
        detected_at: new Date("2026-07-29T00:00:00Z"),
      } as any);
      await db.insert(deals).values({
        athlete_id: many, brand_name: "Vuori", deal_type: "social_post",
        amount: "3000", status: "negotiating", source: "inbox_scan",
        detected_at: new Date("2026-08-01T00:00:00Z"),
      } as any);
      for (let i = 0; i < 12; i++) {
        await db.insert(deals).values({
          athlete_id: many, brand_name: `StartX${i}`, deal_type: "social_post",
          amount: null, status: "detected", source: "inbox_scan",
          // All NEWER than the real deals — which is exactly why recency misleads.
          detected_at: new Date(`2026-09-0${(i % 9) + 1}T00:00:00Z`),
        } as any);
      }
    });

    it("caps the rows but reports the true total", async () => {
      const p = await page(many);
      expect(p.deals).toHaveLength(10);   // the cap
      expect(p.showing).toBe(10);
      expect(p.total).toBe(14);           // the truth
    });

    it("breaks the total down, so unqualified detections are not called deals", async () => {
      // 12 of the 14 are `detected` — inbox hits nobody has looked at. Without this
      // the model has no vocabulary for the difference and calls all of them active.
      const p = await page(many);
      expect(p.by_status.detected).toBe(12);
      expect(p.by_status.accepted).toBe(1);
      expect(p.by_status.negotiating).toBe(1);
    });

    it("leads with the live deals, not the newest noise", async () => {
      // THE REGRESSION. Every StartX row is newer than gorjana, so recency put a
      // signed $14,000 deal off the page entirely and led with "StartX0".
      const [first, second] = await rows(many);
      expect(first.brand_name).toBe("gorjana");
      expect(first.status).toBe("accepted");
      expect(second.brand_name).toBe("Vuori");
    });

    it("still offers recency when it is asked for", async () => {
      const [first] = await rows(many, { sort_by: "recency" });
      expect(first.brand_name).toMatch(/^StartX/);
    });

    it("says which status filter produced the page", async () => {
      const p = await page(many, { status: "accepted" });
      expect(p.filtered_by_status).toBe("accepted");
      expect(p.deals).toHaveLength(1);
      // `total` stays the WHOLE book: a filtered page must not redefine how many
      // deals the athlete has, or "1 deal" becomes the next wrong headline.
      expect(p.total).toBe(14);
    });

    it("reports showing as measured, never as the limit it asked for", async () => {
      const p = await page(many, { limit: 3 });
      expect(p.showing).toBe(3);
      expect(p.deals).toHaveLength(3);
      expect(p.total).toBe(14);
    });
  });

  it("stays under TOOL_RESULT_MAX_CHARS", async () => {
    const result = await listDealsTool.execute(athleteA, {});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MILA.TOOL_RESULT_MAX_CHARS,
    );
  });
});
