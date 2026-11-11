/**
 * measuredSync.db.test.ts — ONE PLACE, NO LOSS: every metric the old connected social-features block supplied to the
 * M.I.A. is now a measured memory fact (latest per metric, with its window, its date and a ref to its source row), and
 * the M.I.A.'s memory block carries every one of them. PGlite; made-up athlete; no provider is reached.
 *
 *   M1 every line of the old block (connectedBlock) has a measured-fact equivalent with the same value
 *   M2 latest per metric and window: an older row of the same metric is not used; date = the row's as-of; ref → its row
 *   M3 other numeric derived features are kept too (generic label); JSON-valued features are not facts
 *   M4 the facts-only M.I.A. block (memory only) carries every one of those values
 *   M5 a re-sync with nothing new writes nothing; a newer row supersedes the older fact
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedConnection } from "../../testUtils/pgliteDb";
import { athletes, memoryFacts, socialAnalyticsSnapshots, socialFeatures } from "../../../shared/schema";
import { FEATURE_CALCULATION_VERSION } from "../../services/intelligence/social/metrics";
import { BLOCK_FEATURE_METRICS, connectedBlock } from "../../services/marketabilityBeta1SocialBlock";
import { buildMemoryFactsSnapshot } from "../../services/miaPreview/memoryAdapter";
import { syncMemoryMeasuredFacts } from "./measuredSync";

jest.setTimeout(120_000);

let athleteId = "";
const NAME = "Quinn Harlow";
const AS_OF = new Date("2026-10-08T00:00:00.000Z");
const OLDER = new Date("2026-09-20T00:00:00.000Z");

/** A value per block metric, in its unit (ratios as ratios, percents as percents, counts as counts). */
const VALUE: Record<string, number> = {
  followers_latest: 3410, followers_growth_pct: 1.25, engagement_per_follower_median: 0.0512, reach_per_follower_median: 0.6,
  interactions_per_reach_median: 0.081, non_follower_reach_share: 0.22, saves_per_1k_reach_median: 1.4, shares_per_1k_reach_median: 2.1,
  views_per_follower_median: 0.9, completion_pct_median: 0.35, avg_view_pct_account: 0.41, story_retention_proxy: 0.77,
  story_tap_forward_rate: 0.12, story_reach_per_follower: 0.08, audience_top_country_share: 61, effective_reach_cross_platform: 5120, platform_breadth: 2,
};

const feature = (o: { key: string; platform: string | null; window: number; value: number | null; asOf?: Date; unit?: string; json?: unknown }) => ({
  athlete_id: athleteId, platform: o.platform, feature_key: o.key, value: o.value == null ? null : String(o.value), value_json: o.json ?? null,
  unit: o.unit ?? "ratio", window_days: o.window, as_of: o.asOf ?? AS_OF, source_class: "connected_verified", confidence: "0.90",
  calculation_version: FEATURE_CALCULATION_VERSION, inputs: {},
});

beforeAll(async () => {
  await initTestDb();
  const [row] = await db.insert(athletes).values({ full_name: NAME, sport: "Lacrosse" } as any).returning({ id: athletes.id });
  athleteId = row.id;
  // A new-agent athlete: memory holds what she told us.
  await db.insert(memoryFacts).values({ athlete_id: athleteId, subject_kind: "athlete", subject_name: NAME, claim: `The athlete's name is ${NAME}.`, type: "said", source_ref: "onboarding/r#name", source_title: "You told us", confidence: 1 } as any);
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "quinn.lax" });
  await db.insert(socialAnalyticsSnapshots).values({ athlete_id: athleteId, connected_account_id: connectionId, source: "connected", platform: "instagram", snapshot_day: "2026-10-08", followers: 3410, avg_engagement_rate: 4.8, posts_last_30d: 6 } as any);
  // Every metric the block reads, on the latest day …
  await db.insert(socialFeatures).values(BLOCK_FEATURE_METRICS.map((m) => feature({
    key: m.key, platform: m.scope === "cross" ? null : "instagram", window: m.window ?? 0, value: VALUE[m.key] * (m.window === 90 ? 2 : 1),
  })) as any);
  // … an OLDER reading of one of them, another numeric derived feature, and a JSON-valued one.
  await db.insert(socialFeatures).values([
    feature({ key: "followers_growth_pct", platform: "instagram", window: 30, value: 9.99, asOf: OLDER, unit: "percent" }),
    feature({ key: "posts_per_week", platform: "instagram", window: 30, value: 1.5, unit: "posts_per_week" }),
    feature({ key: "format_mix", platform: "instagram", window: 30, value: null, unit: "json", json: { reel: 0.6 } }),
  ] as any);
}, 120_000);
afterAll(closeTestDb);

const measured = async () => (await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId))).filter((f) => f.type === "measured" && f.status === "active");

test("M1–M3: every line of the old block has a measured-fact equivalent; latest per metric; derived extras kept", async () => {
  const old = await connectedBlock(athleteId);
  const lines = Object.entries(old[0].metrics);
  // The old block supplied every metric in the table (this athlete has them all), with the values it always wrote.
  expect(lines.map(([label]) => label)).toEqual(BLOCK_FEATURE_METRICS.map((m) => m.label));
  expect(old[0].metrics).toMatchObject({
    followers: "3,410", "follower growth (30 days)": "1.25%", "follower growth (90 days)": "2.50%",
    "median engagement per follower (30 days)": "5.12%", "median saves per 1k reach (30 days)": "1.40", "top audience country share": "61%",
    "cross-platform effective reach (30 days, all connected platforms)": "5,120", "platforms with content in the last 30 days": "2",
  });

  const r = await syncMemoryMeasuredFacts(athleteId);
  expect(r?.platforms).toEqual(["instagram"]);
  const facts = await measured();
  const claims = facts.map((f) => f.claim);
  for (const [label, value] of lines) {
    // One follower number: the snapshot's follower fact stands for followers_latest.
    if (label === "followers") { expect(claims).toContain(`Instagram (@quinn.lax) has ${value} followers.`); continue; }
    expect([label, claims.some((c) => c.endsWith(`${label}: ${value}.`))]).toEqual([label, true]);
  }
  // Latest per metric and window, with its date and a ref to its row.
  const growth30 = facts.filter((f) => /#instagram\.followers_growth_pct_30d$/.test(f.source_ref ?? ""));
  expect(growth30).toHaveLength(1);
  expect(growth30[0].claim).toBe("Instagram (@quinn.lax) follower growth (30 days): 1.25%.");
  expect(growth30[0].observed_on).toBe("2026-10-08");
  const [row] = await db.select({ id: socialFeatures.id }).from(socialFeatures).where(eq(socialFeatures.value, "1.25"));
  expect(growth30[0].source_ref).toBe(`social_features/${row.id}#instagram.followers_growth_pct_30d`);
  expect(claims.some((c) => c.includes("9.99"))).toBe(false);
  // Cross-platform readings are filed under "all".
  expect(facts.find((f) => /#all\.effective_reach_cross_platform_0d$/.test(f.source_ref ?? ""))?.claim)
    .toBe("Across connected platforms, cross-platform effective reach (30 days, all connected platforms): 5,120.");
  // Other numeric derived features are kept; JSON-valued ones are not facts.
  expect(claims).toContain("Instagram (@quinn.lax) posts per week (30 days): 1.5 per week.");
  expect(claims.some((c) => c.includes("format mix"))).toBe(false);
  expect(facts.every((f) => f.confidence === 1 && f.subject_kind === "athlete")).toBe(true);
});

test("M4: the facts-only M.I.A. block reads memory only and carries every value the old block had", async () => {
  const old = await connectedBlock(athleteId);
  const snap = await buildMemoryFactsSnapshot(athleteId, "USER_REQUESTED_REFRESH");
  for (const [label, value] of Object.entries(old[0].metrics)) {
    expect([label, (snap!.socialBlock ?? "").includes(label === "followers" ? `has ${value} followers` : `${label}: ${value}`)]).toEqual([label, true]);
  }
  expect(snap!.inputs.connectedPlatforms).toEqual([]);           // nothing read from the social-features block itself
});

test("M5: a re-sync with nothing new writes nothing; a newer reading supersedes the older fact", async () => {
  const before = (await measured()).length;
  expect(await syncMemoryMeasuredFacts(athleteId)).toMatchObject({ inserted: 0, superseded: 0 });
  await db.insert(socialFeatures).values(feature({ key: "followers_growth_pct", platform: "instagram", window: 30, value: 2.5, asOf: new Date("2026-10-09T00:00:00.000Z"), unit: "percent" }) as any);
  expect(await syncMemoryMeasuredFacts(athleteId)).toMatchObject({ inserted: 1, superseded: 1 });
  const after = await measured();
  expect(after).toHaveLength(before);
  expect(after.filter((f) => /followers_growth_pct_30d$/.test(f.source_ref ?? "")).map((f) => f.claim)).toEqual(["Instagram (@quinn.lax) follower growth (30 days): 2.50%."]);
});
