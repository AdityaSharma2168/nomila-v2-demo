/**
 * get_analytics tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * Covers: latest follower count + 7d/30d deltas · deltas null without history ·
 * platform filter · null when no snapshots · cross-athlete tenancy probe ·
 * char-budget. One row per athlete×platform×day is enforced by a unique index,
 * so history is seeded on distinct days.
 *
 * Deltas are computed relative to the latest snapshot_day (not "today"), so
 * fixed dates keep the test deterministic.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { getAnalyticsTool } from "./getAnalytics";
import { MILA } from "../config";
import { socialAnalyticsSnapshots } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";

let athleteA: string;
let athleteB: string;

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Athlete A");
  athleteB = await seedAthlete("Athlete B");

  // Instagram history: latest 2026-07-20 = 1200, -7d = 1100, -30d = 900.
  await db.insert(socialAnalyticsSnapshots).values([
    {
      athlete_id: athleteA,
      platform: "instagram",
      snapshot_day: "2026-07-20",
      followers: 1200,
    },
    {
      athlete_id: athleteA,
      platform: "instagram",
      snapshot_day: "2026-07-13",
      followers: 1100,
    },
    {
      athlete_id: athleteA,
      platform: "instagram",
      snapshot_day: "2026-06-20",
      followers: 900,
    },
  ]);

  // TikTok: a single snapshot → no history → null deltas.
  await db.insert(socialAnalyticsSnapshots).values({
    athlete_id: athleteA,
    platform: "tiktok",
    snapshot_day: "2026-07-20",
    followers: 500,
  });

  // B: a leak marker on a platform A doesn't have.
  await db.insert(socialAnalyticsSnapshots).values({
    athlete_id: athleteB,
    platform: "youtube",
    snapshot_day: "2026-07-20",
    followers: 99999,
  });
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("get_analytics", () => {
  it("returns current followers and 7d/30d deltas", async () => {
    const result = (await getAnalyticsTool.execute(athleteA, {})) as Record<
      string,
      Record<string, unknown>
    >;

    expect(result.instagram).toEqual({
      followers: 1200,
      as_of: "2026-07-20",
      delta_7d: 100, // 1200 - 1100
      delta_30d: 300, // 1200 - 900
    });
    // A has no youtube snapshots → platform omitted.
    expect(result).not.toHaveProperty("youtube");
  });

  it("returns null deltas when there is no history", async () => {
    const result = (await getAnalyticsTool.execute(athleteA, {
      platform: "tiktok",
    })) as Record<string, Record<string, unknown>>;
    expect(result.tiktok).toEqual({
      followers: 500,
      as_of: "2026-07-20",
      delta_7d: null,
      delta_30d: null,
    });
  });

  it("limits to the requested platform", async () => {
    const result = (await getAnalyticsTool.execute(athleteA, {
      platform: "instagram",
    })) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["instagram"]);
  });

  it("returns null when the athlete has no snapshots for the scope", async () => {
    await expect(
      getAnalyticsTool.execute(athleteA, { platform: "youtube" }),
    ).resolves.toBeNull();

    const bare = await seedAthlete("No Snapshots");
    await expect(getAnalyticsTool.execute(bare, {})).resolves.toBeNull();
  });

  it("never returns another athlete's analytics (tenancy probe)", async () => {
    const result = await getAnalyticsTool.execute(athleteA, {});
    const json = JSON.stringify(result);
    expect(json).not.toContain("99999");
    expect(json).not.toContain(athleteB);
  });

  it("stays under TOOL_RESULT_MAX_CHARS", async () => {
    const result = await getAnalyticsTool.execute(athleteA, {});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MILA.TOOL_RESULT_MAX_CHARS,
    );
  });
});
