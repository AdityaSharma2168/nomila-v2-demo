/**
 * getScore tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * The score itself now comes from the ledger read of record (`buildMyIntelligence`),
 * never from the retired legacy score (its athletes_current columns are dropped) — see
 * server/mila/tools/getScore.ts. Covers: populated shape (modern score, no tier/capitals) ·
 * no rate figure, not even her own floor · no ledger read → display_score null · no score
 * and no follower count → null · followers from the social substrate (P2-3) · cross-athlete
 * tenancy probe (B has M.I.A. 733) · output stays under the TOOL_RESULT_MAX_CHARS budget.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { getScoreTool, dimensionsIn } from "./getScore";
import { eq } from "drizzle-orm";
import { athletes, athletesCurrent, intelligenceLedger, socialAnalyticsSnapshots, socialFeatures } from "../../../shared/schema";
import { FEATURE_CALCULATION_VERSION } from "../../services/intelligence/social/metrics";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";

/** A minimal ledger ASSESSMENT row: just enough for buildMyIntelligence to report `score`. */
async function seedScore(athleteId: string, score: number) {
  await db.insert(intelligenceLedger).values({
    subject_type: "athlete", subject_id: athleteId, owner: "marketability", kind: "ASSESSMENT",
    value: { score } as any, confidence: null,
    versions: { methodology: "v1.0.1-beta.1", evaluator: "mia-eval/test", params: "params/test" } as any,
    evidence_as_of: new Date("2026-09-20T00:00:00.000Z"),
  } as any);
}

/** Followers now come from the social substrate (legacy retirement P2-3): a followers_latest feature per platform. */
async function seedFollowersFeature(athleteId: string, platform: string, value: number) {
  await db.insert(socialFeatures).values({
    athlete_id: athleteId, platform, feature_key: "followers_latest", value: String(value), unit: "count", n: 1,
    window_days: 0, as_of: new Date("2026-09-20T00:00:00.000Z"), source_class: "connected_verified", confidence: "0.90",
    calculation_version: FEATURE_CALCULATION_VERSION, inputs: {},
  } as any);
}
/** …or, with no feature row, the newest analytics snapshot. */
async function seedFollowersSnapshot(athleteId: string, platform: string, followers: number) {
  await db.insert(socialAnalyticsSnapshots).values({
    athlete_id: athleteId, source: "discovery", platform, followers, snapshot_day: "2026-09-19",
    snapshot_date: new Date("2026-09-19T00:00:00.000Z"),
  } as any);
}

// Her own floor (deal_preferences.minimum_rates) is the only rate an athlete still has; get_score must never carry it.
const FLOOR_A = { socialPost: 6000, appearance: 14000 };

let athleteA: string;
let athleteB: string;

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Athlete A");
  athleteB = await seedAthlete("Athlete B");

  // The legacy score/tier/capitals/rate-card columns are dropped (P3); the row itself still exists for every athlete.
  await db.insert(athletesCurrent).values({
    athlete_id: athleteA,
  });
  await db.update(athletes).set({ deal_preferences: { minimum_rates: FLOOR_A } } as any).where(eq(athletes.id, athleteA));
  await seedScore(athleteA, 640);
  await seedFollowersFeature(athleteA, "instagram", 12000);
  await seedFollowersFeature(athleteA, "tiktok", 8000);
  await seedFollowersSnapshot(athleteA, "youtube", 300);

  // Athlete B: distinct values (M.I.A. 733, 999,999 Instagram followers) so any leak into A's result is detectable.
  await db.insert(athletesCurrent).values({
    athlete_id: athleteB,
  });
  await seedScore(athleteB, 733);
  await seedFollowersFeature(athleteB, "instagram", 999999);
  // Generous hook timeout: initTestDb pushes the whole schema into PGlite, and
  // a cold ts-jest compile can push that past jest's default 5s.
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("get_score", () => {
  it("returns the M.I.A. score, what it is made of, and followers from the substrate — no tier, capitals, pav or rates", async () => {
    const result = (await getScoreTool.execute(athleteA, {})) as Record<string, unknown>;

    expect(result).not.toBeNull();
    // The modern ledger score (640).
    expect(result.display_score).toBe(640);
    expect(result.out_of).toBe(850);
    expect(Array.isArray(result.strengths)).toBe(true);
    expect(Array.isArray(result.room_to_grow)).toBe(true);
    expect(result.followers).toEqual({
      instagram: 12000,
      tiktok: 8000,
      x: null,
      youtube: 300,
    });
    for (const key of ["tier", "capitals", "pav", "rate_card", "rate_card_summary"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("never carries a rate figure — not even her own floor, which she has (6000 / 14000)", async () => {
    const json = JSON.stringify(await getScoreTool.execute(athleteA, {}));
    for (const figure of ["6000", "14000", "minimum_rates", "floor"]) {
      expect(json).not.toContain(figure);
    }
    expect(json).not.toMatch(/pav|rate/i);
  });

  it("returns null when there is neither an assessment nor any follower count", async () => {
    const bare = await seedAthlete("No Score Yet");
    await expect(getScoreTool.execute(bare, {})).resolves.toBeNull();
  });

  it("display_score is null when there is no ledger read", async () => {
    const noLedger = await seedAthlete("No Ledger Read");
    await db.insert(athletesCurrent).values({
      athlete_id: noLedger,
    });
    await seedFollowersSnapshot(noLedger, "instagram", 500);
    const result = (await getScoreTool.execute(noLedger, {})) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.display_score).toBeNull();
    expect(result).not.toHaveProperty("pav");
    // Followers come from the substrate.
    expect((result.followers as any).instagram).toBe(500);
  });

  it("never returns another athlete's data (tenancy probe)", async () => {
    // B's own read carries B's values, so their absence from A's read below means something.
    const b = (await getScoreTool.execute(athleteB, {})) as Record<string, unknown>;
    expect(b.display_score).toBe(733);
    expect((b.followers as any).instagram).toBe(999999);

    const result = await getScoreTool.execute(athleteA, {});
    const json = JSON.stringify(result);
    expect((result as Record<string, unknown>).display_score).toBe(640);
    // As JSON values, not substrings: a bare "733" could also match a timestamp's milliseconds.
    expect(json).not.toMatch(/:\s*733\b/);
    expect(json).not.toMatch(/:\s*999999\b/);
    expect(json).not.toContain(athleteB);
  });

  it("normal results fit the tool budget", async () => {
    const { MILA } = await import("../config");
    const result = await getScoreTool.execute(athleteA, {});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MILA.TOOL_RESULT_MAX_CHARS);
  });
});

describe("dimensionsIn", () => {
  const dims = [
    { key: "audience_scale", state: "strength", score: 71 },
    { key: "athletic_authority", state: "strength", score: 88 },
    { key: "commercial_proof", state: "gap", score: 22 },
    { key: "momentum", state: "neutral", score: 50 },
    { key: "brand_fit", state: "unknown", score: null },
  ] as const;

  it("lists one state's scored dimensions, strongest first, in plain words", () => {
    expect(dimensionsIn(dims as any, "strength")).toEqual([
      { dimension: "athletic authority", score: 88 },
      { dimension: "audience scale", score: 71 },
    ]);
    expect(dimensionsIn(dims as any, "gap")).toEqual([{ dimension: "commercial proof", score: 22 }]);
  });
});
