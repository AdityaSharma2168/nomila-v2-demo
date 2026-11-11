/**
 * getProfile tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * Covers: populated shape (including connected-platform count) · missing
 * athlete → null · cross-athlete tenancy probe · no sensitive columns ·
 * output stays under the TOOL_RESULT_MAX_CHARS budget.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { getProfileTool } from "./getProfile";
import { MILA } from "../config";
import { athletes, athleteAffiliations } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
  seedConnection,
} from "../../testUtils/pgliteDb";

let athleteA: string;
let athleteB: string;

beforeAll(async () => {
  await initTestDb();

  const [a] = await db
    .insert(athletes)
    .values({
      full_name: "Athlete A",
      sport: "Soccer",
      school: "San Jose State",
      division: "D1",
      conference: "Mountain West",
      status: "active",
      email: "athlete-a@example.com",
      auth_id: "firebase-uid-a",
    })
    .returning({ id: athletes.id });
  athleteA = a.id;

  const [b] = await db
    .insert(athletes)
    .values({
      full_name: "Athlete B",
      sport: "Basketball",
      school: "Rival University",
      division: "D2",
      status: "active",
    })
    .returning({ id: athletes.id });
  athleteB = b.id;

  // A: two active platforms + one expired (must not count) + a duplicate gmail.
  await seedConnection({ athleteId: athleteA, platform: "gmail" });
  await seedConnection({
    athleteId: athleteA,
    platform: "gmail",
    email: "second@gmail.com",
  });
  await seedConnection({ athleteId: athleteA, platform: "instagram" });
  await seedConnection({
    athleteId: athleteA,
    platform: "tiktok",
    status: "expired",
  });
  // B: a platform A doesn't have — a leak marker.
  await seedConnection({ athleteId: athleteB, platform: "youtube" });
  // Generous hook timeout: initTestDb pushes the whole schema into PGlite, and
  // a cold ts-jest compile can push that past jest's default 5s.
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("get_profile", () => {
  it("returns the expected shape for a populated athlete", async () => {
    const result = (await getProfileTool.execute(athleteA, {})) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({
      full_name: "Athlete A",
      sport: "Soccer",
      school: "San Jose State",
      division: "D1",
      conference: "Mountain West",
      segment: "college", // generated column: D1 → college
      career_status: "active", // declared, default until the athlete says otherwise (0041)
      teams: [], // no affiliation rows seeded; the school column alone does not invent one
      status: "active",
      plan: "free",
      goal_archetype: null,
      secondary_goals: null,
      brand_voice: null,
      connected_platform_count: 2,
      connected_platforms: expect.arrayContaining(["gmail", "instagram"]),
    });
    // Distinct active platforms only: duplicate gmail deduped, expired tiktok excluded.
    expect(result.connected_platforms).toHaveLength(2);
  });

  it("surfaces durable secondary_goals + brand_voice so Mila sees what it proposes against", async () => {
    const id = await seedAthlete("Goals Athlete");
    await db
      .update(athletes)
      .set({
        secondary_goals: ["Grow audience", "Land NIL deals"],
        brand_voice: { tone: "warm and direct", avoid: ["corporate speak"] },
      })
      .where(eq(athletes.id, id));

    const result = (await getProfileTool.execute(id, {})) as Record<
      string,
      unknown
    >;
    expect(result.secondary_goals).toEqual(["Grow audience", "Land NIL deals"]);
    expect(result.brand_voice).toEqual({
      tone: "warm and direct",
      avoid: ["corporate speak"],
    });
  });

  it("never exposes sensitive fields", async () => {
    const result = await getProfileTool.execute(athleteA, {});
    const json = JSON.stringify(result);

    for (const key of [
      "email",
      "auth_id",
      "auth_provider",
      "access_token",
      "photo_url",
      "stripe",
    ]) {
      expect(json).not.toContain(key);
    }
    expect(json).not.toContain("athlete-a@example.com");
    expect(json).not.toContain("firebase-uid-a");
  });

  it("returns null when the athlete doesn't exist", async () => {
    await expect(
      getProfileTool.execute("00000000-0000-0000-0000-000000000000", {}),
    ).resolves.toBeNull();
  });

  it("never returns another athlete's data (tenancy probe)", async () => {
    const result = (await getProfileTool.execute(athleteA, {})) as Record<
      string,
      unknown
    >;
    const json = JSON.stringify(result);

    expect(result.full_name).toBe("Athlete A");
    expect(json).not.toContain("Athlete B");
    expect(json).not.toContain("Basketball");
    expect(json).not.toContain("Rival University");
    // B's youtube connection must not leak into A's platform list.
    expect(result.connected_platforms).not.toContain("youtube");
    expect(json).not.toContain(athleteB);
  });

  it("stays under TOOL_RESULT_MAX_CHARS", async () => {
    const result = await getProfileTool.execute(athleteA, {});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MILA.TOOL_RESULT_MAX_CHARS,
    );
  });
});

// ─── Sport / school / level: the projection columns ─────────────────────────────

describe("get_profile identity", () => {
  it("reads sport / school / level from the projection columns, not the ledger", async () => {
    await db.insert(athleteAffiliations).values({ athlete_id: athleteA, org_name: "Ledger University", org_kind: "school", level: "D1", conference: "Big West", is_primary: true, kind: "said", source: "settings", started_on: "2024-08-01" });
    const legacy = (await getProfileTool.execute(athleteA, {}))!;
    expect(legacy).toMatchObject({ school: "San Jose State", conference: "Mountain West", division: "D1" });
  });
});
