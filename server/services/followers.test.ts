/**
 * followers.test.ts — readFollowers (legacy retirement P2-3): the substrate's followers_latest first, then the newest
 * analytics snapshot, then the newest athlete snapshot's social; per platform, newest first; zero is "no count";
 * one athlete never sees another's. PGlite; nothing reaches a model.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { athleteSnapshots, socialAnalyticsSnapshots, socialFeatures } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { FEATURE_CALCULATION_VERSION } from "./intelligence/social/metrics";
import { combinedFollowing, readFollowers } from "./followers";

const feature = (athleteId: string, platform: string, value: number, asOf: string, version = FEATURE_CALCULATION_VERSION) =>
  db.insert(socialFeatures).values({
    athlete_id: athleteId, platform, feature_key: "followers_latest", value: String(value), unit: "count", n: 1, window_days: 0,
    as_of: new Date(asOf), source_class: "connected_verified", confidence: "0.90", calculation_version: version, inputs: {},
  } as any);
const analytics = (athleteId: string, platform: string, followers: number, day: string) =>
  db.insert(socialAnalyticsSnapshots).values({ athlete_id: athleteId, source: "discovery", platform, followers, snapshot_day: day, snapshot_date: new Date(`${day}T00:00:00Z`) } as any);

let a: string, b: string, bare: string;

beforeAll(async () => {
  await initTestDb();
  a = await seedAthlete("Ada");
  b = await seedAthlete("Bea");
  bare = await seedAthlete("Bare");
  await feature(a, "instagram", 1000, "2026-09-01T00:00:00Z");
  await feature(a, "instagram", 1200, "2026-09-20T00:00:00Z");          // newest wins
  await feature(a, "tiktok", 9999, "2026-09-21T00:00:00Z", "v-old");     // another calculation version: ignored
  await analytics(a, "tiktok", 800, "2026-09-19");                       // ← used for tiktok
  await analytics(a, "instagram", 5, "2026-09-25");                      // the feature already answered instagram
  await db.insert(athleteSnapshots).values({ athlete_id: a, trigger: "manual", social: { youtube: { subscribers: 300 }, x: { followers: 0 } } } as any);
  await feature(b, "instagram", 777777, "2026-09-20T00:00:00Z");
}, 30_000);
afterAll(closeTestDb);

it("takes each platform from the first source that has it, newest first; zero is no count", async () => {
  const f = await readFollowers(a);
  expect(f.counts).toEqual({ instagram: 1200, tiktok: 800, youtube: 300, x: null });
  expect(combinedFollowing(f)).toBe(2300);
  expect(f.asOf).not.toBeNull();
});

it("nothing anywhere ⇒ every count null, combined 0", async () => {
  const f = await readFollowers(bare);
  expect(f).toEqual({ counts: { instagram: null, tiktok: null, youtube: null, x: null }, asOf: null });
  expect(combinedFollowing(f)).toBe(0);
});

it("never reads another athlete's rows", async () => {
  expect(JSON.stringify(await readFollowers(a))).not.toContain("777777");
});
