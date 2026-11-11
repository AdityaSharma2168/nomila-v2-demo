/**
 * collectSocialAnalytics.test.ts — the `trigger` pass-through added for connect-triggered
 * substrate sync (server/workflow/definitions/socialSync.ts).
 *
 * collectSocialAnalytics is the existing connected-sync entry point, reused (not reimplemented)
 * by the new social_sync workflow. What's pinned here:
 *   - default call (the nightly cron's collectAllAnalyticsSnapshots) still ingests with
 *     trigger 'nightly' — byte for byte the pre-existing behavior.
 *   - an explicit 'connect' trigger reaches ingestNative unchanged.
 *   - SOCIAL_SUBSTRATE_WRITE off is a clean no-op for the substrate write (ingestNative never
 *     called) while the social_analytics_snapshots row is still written — a substrate failure
 *     or flag-off can never regress the existing display/trend row.
 *   - the nightly batch refreshes a new-agent athlete's measured memory facts (the one measured source M.I.A. and the
 *     screens read); a no-op for anyone else.
 *   - the score follows better data: a nightly reading that is new (or moved ≥ 10%) asks for ONE debounced M.I.A.
 *     recompute; the same reading again asks for nothing. The evaluation request is mocked at the orchestrator.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

const fetchNative = jest.fn();
const project = jest.fn();
const refreshTokenIfNeeded = jest.fn().mockResolvedValue(undefined);
jest.mock("../lib/integrations/instagram", () => ({
  refreshTokenIfNeeded: (...a: unknown[]) => refreshTokenIfNeeded(...a),
  fetchNative: (...a: unknown[]) => fetchNative(...a),
  project: (...a: unknown[]) => project(...a),
}));

const ingestNative = jest.fn().mockResolvedValue({ runId: "sr-1", identityId: "id-1", payloads: 1, observations: 1, distributions: 0, contentLinked: 0, status: "ok" });
jest.mock("../services/intelligence/social/substrate", () => ({
  ingestNative: (...a: unknown[]) => ingestNative(...a),
  runSubstrateNightly: jest.fn(),
}));

const requestEvaluation = jest.fn().mockResolvedValue({ runId: "mia-run-1", created: true });
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({
  ...jest.requireActual("../services/marketabilityBeta1Orchestrator"),
  requestEvaluation: (...a: unknown[]) => requestEvaluation(...a),
}));

let substrateWriteEnabled = true;
jest.mock("../services/intelligence/social/config", () => ({
  substrateWriteEnabled: () => substrateWriteEnabled,
}));

import { eq } from "drizzle-orm";
import { initTestDb, closeTestDb, db, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { memoryFacts } from "../../shared/schema";
import { collectAllAnalyticsSnapshots, collectSocialAnalytics } from "./collectSocialAnalytics";

const NATIVE = { platform: "instagram", accountId: "ig-1", handle: "athlete", sourceMethod: "oauth_instagram_login", fetchedAt: new Date().toISOString(), apiVersion: "v22.0", errors: [], profile: {}, accountInsights: null, media: [], demographics: null } as any;
const PROJECTED = {
  followers: 100, following: 10, post_count: 5, total_likes: null, total_channel_views: null, is_verified: false,
  reach: null, impressions: null, profile_views: null, avg_engagement_rate: null, avg_reach_per_post: null,
  avg_views_per_post: null, avg_shares_per_post: null, avg_saves_per_post: null, avg_watch_time_sec: null,
  content_frequency: null, posts_last_30d: null, top_audience_country: null, top_audience_city: null,
  top_audience_age_range: null, top_audience_gender: null, raw_metrics: {}, toolsCalled: [],
};

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Analytics Athlete");
});
afterAll(closeTestDb);

beforeEach(() => {
  jest.clearAllMocks();
  substrateWriteEnabled = true;
  fetchNative.mockResolvedValue(NATIVE);
  project.mockReturnValue(PROJECTED);
});

test("default trigger (the nightly cron's call shape) reaches ingestNative as 'nightly'", async () => {
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "nightly@example.com" });
  const saved = await collectSocialAnalytics(connectionId);
  expect(saved).not.toBeNull();
  expect(ingestNative).toHaveBeenCalledTimes(1);
  expect(ingestNative.mock.calls[0][0]).toMatchObject({ athleteId, native: NATIVE, trigger: "nightly", connectedAccountId: connectionId });
});

test("an explicit 'connect' trigger (the social_sync workflow's call) reaches ingestNative unchanged", async () => {
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "connect@example.com" });
  const saved = await collectSocialAnalytics(connectionId, "connect");
  expect(saved).not.toBeNull();
  expect(ingestNative).toHaveBeenCalledTimes(1);
  expect(ingestNative.mock.calls[0][0]).toMatchObject({ athleteId, native: NATIVE, trigger: "connect", connectedAccountId: connectionId });
});

test("SOCIAL_SUBSTRATE_WRITE off: the display snapshot is still written, but the substrate ingest never runs", async () => {
  substrateWriteEnabled = false;
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "flagoff@example.com" });
  const saved = await collectSocialAnalytics(connectionId, "connect");
  expect(saved).not.toBeNull();          // social_analytics_snapshots row still written
  expect(saved!.followers).toBe(100);
  expect(ingestNative).not.toHaveBeenCalled();
});

test("the nightly batch refreshes a new-agent athlete's MEASURED memory facts (one measured source); others get none", async () => {
  const memoryAthlete = await seedAthlete("Nightly Memory Athlete");
  await db.insert(memoryFacts).values({
    athlete_id: memoryAthlete, subject_kind: "athlete", subject_name: "Nightly Memory Athlete", claim: "The athlete's name is Nightly Memory Athlete.",
    type: "said", source_ref: "onboarding/x#name", source_title: "You told us", confidence: 1,
  } as any);
  await seedConnection({ athleteId: memoryAthlete, platform: "instagram", email: "memory-nightly@example.com" });
  const r = await collectAllAnalyticsSnapshots();
  expect(r.failed).toBe(0);
  expect(r.memorySynced).toBe(1);                                   // the earlier athlete has no memory: a no-op
  const measured = (await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, memoryAthlete))).filter((f) => f.type === "measured");
  expect(measured.map((f) => f.claim)).toEqual([expect.stringMatching(/^Instagram .*has 100 followers\.$/)]);
  expect(measured[0].source_ref).toMatch(/^social_analytics_snapshots\/.+#instagram\.followers$/);
  expect(await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId))).toEqual([]);

  // A new reading: one recompute request, through the existing debounced path (not forced, not immediate).
  expect(r.rescoreRequested).toBe(1);
  expect(requestEvaluation).toHaveBeenCalledTimes(1);
  expect(requestEvaluation.mock.calls[0][0]).toMatchObject({ athleteId: memoryAthlete, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "nightly_social_sync" });
  expect(requestEvaluation.mock.calls[0][0]).not.toHaveProperty("force");
  expect(requestEvaluation.mock.calls[0][0]).not.toHaveProperty("immediate");

  // The same reading the next run: nothing moved, nothing asked (idempotent).
  requestEvaluation.mockClear();
  const again = await collectAllAnalyticsSnapshots();
  expect(again.rescoreRequested).toBe(0);
  expect(requestEvaluation).not.toHaveBeenCalled();

  // A reading that moved ≥ 10% (100 → 150 followers): asked again.
  project.mockReturnValue({ ...PROJECTED, followers: 150 });
  const moved = await collectAllAnalyticsSnapshots();
  expect(moved.rescoreRequested).toBe(1);
  expect(requestEvaluation).toHaveBeenCalledTimes(1);
});
