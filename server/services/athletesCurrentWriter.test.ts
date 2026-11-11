/**
 * athletesCurrentWriter.test.ts — the ONE writer, after the legacy retirement (P2-4): it writes the story arc and the
 * research timestamp (research), or just makes sure the row exists (a social connect) — never the legacy score, tier,
 * capitals, rate card, PAV, follower copies or research counts.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athletesCurrent } from "../../shared/schema";
import { WRITTEN_COLUMNS, writeAthletesCurrent } from "./athletesCurrentWriter";

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Writer Test");
});
afterAll(closeTestDb);

async function current() {
  const [row] = await db.select({
    story_arc: athletesCurrent.story_arc, research_updated_at: athletesCurrent.research_updated_at, updated_at: athletesCurrent.updated_at,
  }).from(athletesCurrent).where(eq(athletesCurrent.athlete_id, athleteId)).limit(1);
  return row;
}

test("connect path (no research): the row exists, nothing else is set", async () => {
  await writeAthletesCurrent({ athleteId });
  const row = await current();
  expect(row).toBeDefined();
  expect(row.updated_at).not.toBeNull();
  expect(row.story_arc).toBeNull();
  expect(row.research_updated_at).toBeNull();
});

test("research path: story arc + research timestamp", async () => {
  await writeAthletesCurrent({ athleteId, research: { storyArc: "A trailblazer." } });
  const row = await current();
  expect(row.story_arc).toBe("A trailblazer.");
  expect(row.research_updated_at).not.toBeNull();
});

test("a later connect keeps the research columns from the last research write", async () => {
  await writeAthletesCurrent({ athleteId });
  expect((await current()).story_arc).toBe("A trailblazer.");
});

test("never writes a legacy score / rate / follower / count column", async () => {
  const legacy = ["display_score", "tier", "internal_score", "capitals", "pav", "deal_type_rates", "rate_card",
    "ig_followers", "tk_followers", "x_followers", "yt_subscribers", "spotify_listeners", "achievements_count",
    "press_count", "brand_mentions_count", "latest_snapshot_id", "score_updated_at", "social_updated_at"];
  for (const c of legacy) expect(WRITTEN_COLUMNS as readonly string[]).not.toContain(c);
  // Since 0110 (P3-1) the columns themselves are gone: the row is exactly what the writer may touch.
  const res: any = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'athletes_current' ORDER BY column_name`);
  expect((res.rows ?? res).map((r: any) => r.column_name)).toEqual(["athlete_id", ...[...WRITTEN_COLUMNS].sort()].sort());
});
