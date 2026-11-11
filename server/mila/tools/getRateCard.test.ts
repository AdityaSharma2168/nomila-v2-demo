/**
 * get_rate_card tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * Legacy retirement, phase 1 (8 Oct 2026): the computed v3 rate card is retired. The tool always
 * says rates are being rebuilt and returns ONLY the athlete's own floor (deal_preferences.minimum_rates).
 * Covers: her floor, in her numbers · no floor → your_floor null · the legacy rate card / pav never
 * appear even when the column holds them · cross-athlete tenancy probe · ownFloors parsing.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { getRateCardTool, ownFloors } from "./getRateCard";
import { athletes, athletesCurrent } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";

const LEGACY_RATE_CARD = {
  version: "v3",
  social: [
    { platform: "instagram", ratePerPost: { low: 150, mid: 522, high: 700 } },
    { platform: "tiktok", ratePerPost: { low: 400, mid: 876, high: 1100 } },
  ],
  headlineSocial: { platform: "tiktok", ratePerPost: { low: 400, mid: 876, high: 1100 } },
  appearance: { ratePerEvent: { low: 250, mid: 375, high: 500 } },
  pav: { low: 17000, mid: 22700, high: 27000 },
};

let withFloor: string;
let noFloor: string;
let other: string;

beforeAll(async () => {
  await initTestDb();
  withFloor = await seedAthlete("Has A Floor");
  noFloor = await seedAthlete("No Floor");
  other = await seedAthlete("Other Athlete");

  await db.update(athletes)
    .set({ deal_preferences: { minimum_rates: { socialPost: 600, appearance: 1500 } } as any })
    .where(eq(athletes.id, withFloor));
  await db.update(athletes)
    .set({ deal_preferences: { minimum_rates: { socialPost: 99999 } } as any })
    .where(eq(athletes.id, other));

  // The legacy column is populated on purpose: none of it may come back.
  for (const id of [withFloor, noFloor]) {
    await db.insert(athletesCurrent).values({ athlete_id: id } as any);
  }
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("get_rate_card", () => {
  it("says rates are being rebuilt and returns her own floor, in her numbers", async () => {
    const result = await getRateCardTool.execute(withFloor, {});
    expect(result).toEqual({
      rates_status: "being_rebuilt",
      your_floor: { per_social_post: 600, per_appearance: 1500 },
    });
  });

  it("your_floor is null when she hasn't set one", async () => {
    const result = await getRateCardTool.execute(noFloor, {});
    expect(result).toEqual({ rates_status: "being_rebuilt", your_floor: null });
  });

  it("never carries a legacy computed rate or projected annual value", async () => {
    for (const id of [withFloor, noFloor]) {
      const json = JSON.stringify(await getRateCardTool.execute(id, {}));
      for (const legacy of ["876", "522", "22700", "17000", "375", "pav", "ratePerPost", "tiktok", "instagram"]) {
        expect(json).not.toContain(legacy);
      }
    }
  });

  it("never returns another athlete's floor (tenancy probe)", async () => {
    const json = JSON.stringify(await getRateCardTool.execute(withFloor, {}));
    expect(json).not.toContain("99999");
    expect(json).not.toContain(other);
  });
});

describe("ownFloors", () => {
  it("keeps positive per-type numbers only", () => {
    expect(ownFloors({ minimum_rates: { socialPost: "750", ambassador: 0, licensing: -5, autograph: 300.4 } }))
      .toEqual({ per_social_post: 750, per_autograph_deal: 300 });
    expect(ownFloors(null)).toBeNull();
    expect(ownFloors({ minimum_rate: 500 })).toBeNull();
  });
});
