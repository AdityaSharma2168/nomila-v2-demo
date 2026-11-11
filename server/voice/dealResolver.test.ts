/**
 * dealResolver.test.ts — CHARACTERIZATION suite for findAthleteDealsByBrand.
 * PGlite (real SQL), no network, no model.
 *
 * ── Why this file exists, and what it is NOT ─────────────────────────────────
 * This is Stage 0 of the fuzzy-brand work (Track 3). `findAthleteDealsByBrand`
 * is SHIPPED and reached by two live routes — ./dealBriefRoute and
 * ./draftIntentRoute — and until now had no direct test of its own; it was only
 * ever exercised through those two suites. Stage 2 changes its matching rule, so
 * this suite is written FIRST and against the CURRENT implementation, to pin the
 * behaviour that must survive the change.
 *
 * So §1–§6 describe today, not the desired end state. In particular §3 asserts a
 * set of MISSES that are the entire motivation for the work — "Fog Light" not
 * finding "Foglight Studios" is the bug, and it is asserted there as current
 * behaviour on purpose.
 *
 * §7 pins resolveAthleteDealsByBrand's outcomes. The fuzzy fallback (MILA_FUZZY_BRAND)
 * was never switched on and was deleted 2 Nov 2026, so the §3 misses stay misses.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import {
  findAthleteDealsByBrand,
  resolveAthleteDealsByBrand,
} from "./dealResolver";
import { deals } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

let athleteId: string;
let otherAthleteId: string;

/** Insert one deal for the primary athlete. Returns its generated id. */
async function seedDeal(
  brandName: string,
  detectedAt: Date | null = null,
  owner?: string,
): Promise<string> {
  const [row] = await db
    .insert(deals)
    .values({
      athlete_id: owner ?? athleteId,
      brand_name: brandName,
      detected_at: detectedAt,
    } as any)
    .returning({ id: deals.id });
  return row.id;
}

const names = (rows: { brandName: string }[]) => rows.map((r) => r.brandName);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Resolver Athlete");
  otherAthleteId = await seedAthlete("Other Athlete");

  // ── Plain single-brand deals ────────────────────────────────────────────────
  await seedDeal("Gorjana", new Date("2026-07-01T00:00:00Z"));
  await seedDeal("Foglight Studios", new Date("2026-06-01T00:00:00Z"));
  await seedDeal("xAI", new Date("2026-05-01T00:00:00Z"));
  await seedDeal("Prime Hydration", new Date("2026-04-01T00:00:00Z"));

  // Stored-side normalization probes: the suffix/parenthetical stripping has to
  // work on `deals.brand_name` too, not just on what the athlete said.
  await seedDeal("Alani Nu, LLC", new Date("2026-03-05T00:00:00Z"));
  await seedDeal("Celsius Holdings Inc", new Date("2026-03-04T00:00:00Z"));

  // A brand_name that normalizes to the empty key. `brand_name` is NOT NULL in
  // the schema, so an empty string is the reachable form of the `?? ""` guard.
  await seedDeal("!!!", new Date("2026-03-03T00:00:00Z"));

  // ── Tenancy probes — same names, different athlete ─────────────────────────
  await seedDeal("Gorjana", new Date("2026-07-02T00:00:00Z"), otherAthleteId);
  await seedDeal("Onlyother", new Date("2026-07-03T00:00:00Z"), otherAthleteId);
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

// ─── §1. Tenancy ─────────────────────────────────────────────────────────────
// The load-bearing property. Every other section assumes it holds.

describe("tenancy", () => {
  it("returns only the calling athlete's deals for a shared brand name", async () => {
    const rows = await findAthleteDealsByBrand(athleteId, "Gorjana");
    expect(rows).toHaveLength(1);

    // The other athlete's Gorjana row is newer, so a missing athlete filter
    // would surface it first rather than not at all.
    const [owned] = await db
      .select({ athlete_id: deals.athlete_id })
      .from(deals)
      .where(eq(deals.id, rows[0].dealId));
    expect(owned.athlete_id).toBe(athleteId);
  });

  it("never returns a brand only the other athlete holds", async () => {
    expect(await findAthleteDealsByBrand(athleteId, "Onlyother")).toEqual([]);
  });

  it("resolves the same brand independently for each athlete", async () => {
    const mine = await findAthleteDealsByBrand(athleteId, "Gorjana");
    const theirs = await findAthleteDealsByBrand(otherAthleteId, "Gorjana");
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0].dealId).not.toBe(theirs[0].dealId);
  });

  it("returns nothing for an athlete id that owns no deals", async () => {
    const stranger = await seedAthlete("Stranger");
    expect(await findAthleteDealsByBrand(stranger, "Gorjana")).toEqual([]);
  });
});

// ─── §2. What normalizeBrand equality already accepts ────────────────────────
// These are HITS today and must remain hits after Stage 2 — the fuzzy tiers are
// only ever consulted when exact returns nothing, so none of this may change.

describe("normalized exact match (current hits)", () => {
  it("matches the stored name verbatim", async () => {
    expect(names(await findAthleteDealsByBrand(athleteId, "Gorjana"))).toEqual([
      "Gorjana",
    ]);
  });

  it("is case-insensitive", async () => {
    for (const spoken of ["gorjana", "GORJANA", "GoRjAnA"]) {
      expect(names(await findAthleteDealsByBrand(athleteId, spoken))).toEqual([
        "Gorjana",
      ]);
    }
  });

  it("ignores surrounding and repeated whitespace", async () => {
    expect(
      names(await findAthleteDealsByBrand(athleteId, "  Prime   Hydration  ")),
    ).toEqual(["Prime Hydration"]);
  });

  it("ignores trailing punctuation", async () => {
    expect(
      names(await findAthleteDealsByBrand(athleteId, "Gorjana!!!")),
    ).toEqual(["Gorjana"]);
  });

  it("strips legal-entity suffixes on the SPOKEN side", async () => {
    for (const spoken of ["Gorjana Inc", "Gorjana LLC", "Gorjana Group"]) {
      expect(names(await findAthleteDealsByBrand(athleteId, spoken))).toEqual([
        "Gorjana",
      ]);
    }
  });

  it("strips legal-entity suffixes on the STORED side", async () => {
    expect(names(await findAthleteDealsByBrand(athleteId, "Alani Nu"))).toEqual(
      ["Alani Nu, LLC"],
    );
    expect(
      names(await findAthleteDealsByBrand(athleteId, "Celsius Holdings")),
    ).toEqual(["Celsius Holdings Inc"]);
  });

  it("strips parentheticals", async () => {
    expect(
      names(
        await findAthleteDealsByBrand(athleteId, "Gorjana (via EezyCollab)"),
      ),
    ).toEqual(["Gorjana"]);
  });
});

// ─── §3. The Track 3 misses — CURRENT behaviour, deliberately asserted ───────
// Every case here is a real voice-transcription failure. They are asserted as
// misses because that is what ships (exact match only).

describe("known misses (exact match only; no fuzzy fallback)", () => {
  it("MISSES punctuated/spaced letter brands: 'X.A.I.' does not find 'xAI'", async () => {
    // normalizeBrand punctuation → SPACE: "x a i" ≠ "xai".
    expect(await findAthleteDealsByBrand(athleteId, "X.A.I.")).toEqual([]);
    expect(await findAthleteDealsByBrand(athleteId, "X A I")).toEqual([]);
  });

  it("MISSES a split compound: 'Fog Light' does not find 'Foglight Studios'", async () => {
    expect(await findAthleteDealsByBrand(athleteId, "Fog Light")).toEqual([]);
  });

  it("MISSES a descriptor-suffixed brand: 'Foglight' does not find 'Foglight Studios'", async () => {
    // "studios" is not a legal-entity token, so it is not stripped.
    expect(await findAthleteDealsByBrand(athleteId, "Foglight")).toEqual([]);
  });

  it("MISSES a phonetic near-miss: 'Gorgona' does not find 'Gorjana'", async () => {
    expect(await findAthleteDealsByBrand(athleteId, "Gorgona")).toEqual([]);
  });

  it("MISSES a leading-token ask: 'Prime' does not find 'Prime Hydration'", async () => {
    expect(await findAthleteDealsByBrand(athleteId, "Prime")).toEqual([]);
  });

  it("MISSES a semantic transcription swap: 'Transfer' finds nothing", async () => {
    // Recorded for completeness: no string algorithm recovers this one, so it
    // must STILL be a miss after Stage 2. It is not a fuzzy-matching failure.
    expect(await findAthleteDealsByBrand(athleteId, "Transfer")).toEqual([]);
  });
});

// ─── §4. Input guards ────────────────────────────────────────────────────────
// The `if (!key) return []` early exit. Must survive Stage 2 unchanged: a query
// that carries no signal must never reach a fuzzy scan either.

describe("empty-key guard", () => {
  it("returns [] for empty and whitespace-only input", async () => {
    for (const spoken of ["", "   ", "\t\n"]) {
      expect(await findAthleteDealsByBrand(athleteId, spoken)).toEqual([]);
    }
  });

  it("returns [] for punctuation-only input", async () => {
    expect(await findAthleteDealsByBrand(athleteId, "!!!")).toEqual([]);
    expect(await findAthleteDealsByBrand(athleteId, "...")).toEqual([]);
  });

  it("returns [] when the input is nothing BUT a stripped suffix", async () => {
    // "Inc" normalizes to the empty key, so it must not match everything.
    expect(await findAthleteDealsByBrand(athleteId, "Inc")).toEqual([]);
    expect(await findAthleteDealsByBrand(athleteId, "Group")).toEqual([]);
  });

  it("never returns a deal whose stored name normalizes to empty", async () => {
    // The "!!!" deal exists but is unreachable: the guard fires before the scan,
    // so an empty stored key can never be matched by an empty spoken key.
    for (const spoken of ["", "!!!", "Inc"]) {
      expect(await findAthleteDealsByBrand(athleteId, spoken)).toEqual([]);
    }
  });
});

// ─── §5. Duplicates and ordering ─────────────────────────────────────────────
// Duplicate-brand deals are real (the module header documents a live athlete
// holding two "Handshake AI" rows), and both callers read [0]. The total order
// is therefore load-bearing, and Stage 2 must preserve it exactly.

describe("duplicates and ordering", () => {
  let dupAthlete: string;

  beforeAll(async () => {
    dupAthlete = await seedAthlete("Duplicate Athlete");
    // Deliberately inserted OUT of the expected output order.
    await seedDeal("Ordertest", new Date("2026-01-01T00:00:00Z"), dupAthlete);
    await seedDeal("Ordertest", null, dupAthlete);
    await seedDeal("Ordertest", new Date("2026-02-01T00:00:00Z"), dupAthlete);
  });

  it("returns EVERY match, not just one", async () => {
    const rows = await findAthleteDealsByBrand(dupAthlete, "Ordertest");
    expect(rows).toHaveLength(3);
  });

  it("orders by detected_at descending", async () => {
    const rows = await findAthleteDealsByBrand(dupAthlete, "Ordertest");
    expect(rows[0].detectedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(rows[1].detectedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("sorts undated deals LAST, never first", async () => {
    // An undated row is missing information, not new information.
    const rows = await findAthleteDealsByBrand(dupAthlete, "Ordertest");
    expect(rows[2].detectedAt).toBeNull();
  });

  it("breaks a detected_at tie by dealId, totally and repeatably", async () => {
    const tieAthlete = await seedAthlete("Tie Athlete");
    const when = new Date("2026-05-05T00:00:00Z");
    await seedDeal("Tiedtest", when, tieAthlete);
    await seedDeal("Tiedtest", when, tieAthlete);
    await seedDeal("Tiedtest", when, tieAthlete);

    const rows = await findAthleteDealsByBrand(tieAthlete, "Tiedtest");
    expect(rows).toHaveLength(3);

    const ids = rows.map((r) => r.dealId);
    expect(ids).toEqual([...ids].sort());

    // The property the tiebreak exists for: identical calls agree. Without it a
    // SELECT with no ORDER BY could hand callers a different [0] per request.
    const again = await findAthleteDealsByBrand(tieAthlete, "Tiedtest");
    expect(again.map((r) => r.dealId)).toEqual(ids);
  });

  it("breaks a tie between two UNDATED deals by dealId", async () => {
    const undatedAthlete = await seedAthlete("Undated Athlete");
    await seedDeal("Undatedtest", null, undatedAthlete);
    await seedDeal("Undatedtest", null, undatedAthlete);

    const rows = await findAthleteDealsByBrand(undatedAthlete, "Undatedtest");
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.dealId);
    expect(ids).toEqual([...ids].sort());
  });
});

// ─── §6. Result shape ────────────────────────────────────────────────────────
// Both callers destructure these three fields; dealBriefRoute also derives
// otherDealCount from the array length.

describe("result shape", () => {
  it("returns exactly dealId, brandName and detectedAt", async () => {
    const [row] = await findAthleteDealsByBrand(athleteId, "Gorjana");
    expect(Object.keys(row).sort()).toEqual([
      "brandName",
      "dealId",
      "detectedAt",
    ]);
  });

  it("returns the STORED brand name, not the spoken one", async () => {
    // The card and the spoken answer are labelled from this value, so it has to
    // be our record of the brand rather than the transcription.
    const [row] = await findAthleteDealsByBrand(athleteId, "gorjana inc");
    expect(row.brandName).toBe("Gorjana");
  });

  it("returns detectedAt as a Date, and null when undated", async () => {
    const [dated] = await findAthleteDealsByBrand(athleteId, "Gorjana");
    expect(dated.detectedAt).toBeInstanceOf(Date);

    const nullAthlete = await seedAthlete("Null Date Athlete");
    await seedDeal("Nulldatetest", null, nullAthlete);
    const [undated] = await findAthleteDealsByBrand(
      nullAthlete,
      "Nulldatetest",
    );
    expect(undated.detectedAt).toBeNull();
  });
});

// ─── §7. resolveAthleteDealsByBrand — match or none ──────────────────────────

describe("resolveAthleteDealsByBrand — outcomes", () => {
  it("reports a match with its deals", async () => {
    const r = await resolveAthleteDealsByBrand(athleteId, "Gorjana");
    expect(r.outcome).toBe("match");
    if (r.outcome !== "match") return;
    expect(names(r.deals)).toEqual(["Gorjana"]);
  });

  it("reports a mangled or partial spoken name as none (exact match only)", async () => {
    expect((await resolveAthleteDealsByBrand(athleteId, "Gorgona")).outcome).toBe("none");
    expect(await findAthleteDealsByBrand(athleteId, "Gorgona")).toEqual([]);
  });
});
