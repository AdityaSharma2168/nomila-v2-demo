/**
 * brandFitStore.test.ts — the durable brand-fit narrative store.
 * DB is PGlite (real SQL); no network, no model.
 *
 * This replaced a file-backed store. The tests were written against the
 * INTERFACE rather than the file format precisely so they would survive that
 * swap, and most of them did — what changed is the setup, not the assertions.
 *
 * The properties that carry the design: all three angles or none (enforced now by
 * NOT NULL as well as by the writer), the composite key keeps one athlete's
 * narrative away from another's, and a read never throws — every consumer has an
 * honest answer for "nothing precomputed" and none has one for an exception.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { getBrandFitReasons, setBrandFitReasons } from "./brandFitStore";
import { brandFitNarratives, inboxBrands } from "../../shared/schema";
import { normalizeBrand } from "../lib/brandResolver";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

const REASONS = {
  audience: "Her audience is the exact women-led lifting crowd they sell to.",
  credibility:
    "A starting D1 sprinter endorsing recovery gear isn't a lookalike buy.",
  whitespace: "No sprinter on their roster — they'd own the category with her.",
};

// Research confirmed on the brand's own domain (BRAND_IDENTITY_GATE): the only state a narrative is read in.
const CONFIRMED = { identity: { status: "confirmed", domain: "brand.example", own_sources: ["brand.example"], basis: "own_domain_source", checked_at: "2026-10-01T00:00:00.000Z" } };
const UNCONFIRMED = { identity: { status: "unconfirmed", domain: "brand.example", own_sources: [], basis: "no_own_domain_source", checked_at: "2026-10-01T00:00:00.000Z" } };

let athleteA: string;
let athleteB: string;
let brand1: number;
let brand2: number;

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Fit Store A");
  athleteB = await seedAthlete("Fit Store B");

  // Real brand rows: the table has an FK, so ids must exist.
  const [b1] = await db
    .insert(inboxBrands)
    .values({
      name: "Brandone",
      normalized_name: normalizeBrand("Brandone"),
      is_agency: false,
      enrichment: CONFIRMED,
    })
    .returning({ id: inboxBrands.id });
  const [b2] = await db
    .insert(inboxBrands)
    .values({
      name: "Brandtwo",
      normalized_name: normalizeBrand("Brandtwo"),
      is_agency: false,
      enrichment: CONFIRMED,
    })
    .returning({ id: inboxBrands.id });
  brand1 = b1.id;
  brand2 = b2.id;
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await db.delete(brandFitNarratives);
});

describe("brandFitStore — the interface", () => {
  it("returns null before anything is written", async () => {
    // The normal state before the first fill. Must be a miss, not an error —
    // every caller's fallback is the enum-only answer.
    expect(await getBrandFitReasons(athleteA, brand1)).toBeNull();
  });

  it("round-trips the three angles", async () => {
    await setBrandFitReasons(athleteA, brand1, REASONS);
    expect(await getBrandFitReasons(athleteA, brand1)).toEqual(REASONS);
  });

  it("returns ONLY the three angles — no row metadata leaks out", async () => {
    await setBrandFitReasons(athleteA, brand1, REASONS);
    const hit = await getBrandFitReasons(athleteA, brand1);
    expect(Object.keys(hit!).sort()).toEqual([
      "audience",
      "credibility",
      "whitespace",
    ]);
  });

  it("overwrites an existing pair rather than duplicating", async () => {
    await setBrandFitReasons(athleteA, brand1, REASONS);
    const rewritten = { ...REASONS, audience: "A sharper second take." };
    await setBrandFitReasons(athleteA, brand1, rewritten);

    expect(await getBrandFitReasons(athleteA, brand1)).toEqual(rewritten);
    expect(await db.select().from(brandFitNarratives)).toHaveLength(1);
  });

  it("trims on the way in", async () => {
    await setBrandFitReasons(athleteA, brand1, {
      audience: "  padded  ",
      credibility: "\tcred\n",
      whitespace: " space ",
    });
    expect(await getBrandFitReasons(athleteA, brand1)).toEqual({
      audience: "padded",
      credibility: "cred",
      whitespace: "space",
    });
  });
});

describe("brandFitStore — only a CONFIRMED brand's narrative is read", () => {
  const mk = async (name: string, enrichment: unknown) => {
    const [b] = await db.insert(inboxBrands)
      .values({ name, normalized_name: normalizeBrand(name), is_agency: false, enrichment: enrichment as any })
      .returning({ id: inboxBrands.id });
    return b.id;
  };

  it("confirmed brand → the narrative", async () => {
    await setBrandFitReasons(athleteA, brand1, REASONS);
    expect(await getBrandFitReasons(athleteA, brand1)).toEqual(REASONS);
  });

  it("unconfirmed brand → null, and the stored row is kept", async () => {
    const id = await mk("Unconfirmedco", UNCONFIRMED);
    await setBrandFitReasons(athleteA, id, REASONS);
    expect(await getBrandFitReasons(athleteA, id)).toBeNull();
    expect(await db.select().from(brandFitNarratives)).toHaveLength(1);
  });

  it("never-checked brand (no identity) → null", async () => {
    const id = await mk("Uncheckedco", { industry: "Apparel" });
    await setBrandFitReasons(athleteA, id, REASONS);
    expect(await getBrandFitReasons(athleteA, id)).toBeNull();
  });
});

describe("brandFitStore — the key is athlete AND brand", () => {
  it("never serves one athlete's narrative to another", async () => {
    // The narrative is written FROM this athlete's sport and audience. A
    // brand-only key would hand A's read to B.
    await setBrandFitReasons(athleteA, brand1, REASONS);
    expect(await getBrandFitReasons(athleteB, brand1)).toBeNull();
  });

  it("never serves one brand's narrative for another", async () => {
    await setBrandFitReasons(athleteA, brand1, REASONS);
    expect(await getBrandFitReasons(athleteA, brand2)).toBeNull();
  });

  it("keeps both athletes' entries for the same brand side by side", async () => {
    const other = {
      ...REASONS,
      audience: "A different athlete, a different read.",
    };
    await setBrandFitReasons(athleteA, brand1, REASONS);
    await setBrandFitReasons(athleteB, brand1, other);

    expect(await getBrandFitReasons(athleteA, brand1)).toEqual(REASONS);
    expect(await getBrandFitReasons(athleteB, brand1)).toEqual(other);
  });
});

describe("brandFitStore — all three angles or none", () => {
  it("refuses to write a partial narrative", async () => {
    // Two of three read aloud is worse than the honest short answer, so the
    // write does not happen at all.
    await setBrandFitReasons(athleteA, brand1, {
      audience: REASONS.audience,
      credibility: "   ",
      whitespace: REASONS.whitespace,
    });
    expect(await getBrandFitReasons(athleteA, brand1)).toBeNull();
    expect(await db.select().from(brandFitNarratives)).toHaveLength(0);
  });

  it("does not clobber a good narrative with a partial one", async () => {
    await setBrandFitReasons(athleteA, brand1, REASONS);
    await setBrandFitReasons(athleteA, brand1, {
      audience: "",
      credibility: "still here?",
      whitespace: "",
    });
    expect(await getBrandFitReasons(athleteA, brand1)).toEqual(REASONS);
  });

  it("drops a hand-written row that is blank in one column", async () => {
    // The columns are NOT NULL but an empty string satisfies that. Outbound
    // validation is why the reader is still safe.
    await db.insert(brandFitNarratives).values({
      athlete_id: athleteA,
      brand_id: brand1,
      audience: REASONS.audience,
      credibility: "   ",
      whitespace: REASONS.whitespace,
    });
    expect(await getBrandFitReasons(athleteA, brand1)).toBeNull();
  });
});

describe("brandFitStore — degrades, never throws", () => {
  it("returns null rather than throwing for an unknown athlete", async () => {
    await expect(
      getBrandFitReasons("00000000-0000-0000-0000-000000000000", brand1),
    ).resolves.toBeNull();
  });

  it("swallows a write whose brand does not exist", async () => {
    // The FK would reject it. A fill failing must cost the next asker a cold
    // answer, never surface as an exception on a live call.
    await expect(
      setBrandFitReasons(athleteA, 999_999, REASONS),
    ).resolves.toBeUndefined();
    expect(await db.select().from(brandFitNarratives)).toHaveLength(0);
  });
});
