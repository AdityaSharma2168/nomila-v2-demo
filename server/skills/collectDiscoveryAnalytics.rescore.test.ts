/**
 * collectDiscoveryAnalytics.rescore.test.ts — the score follows better data from the NIGHTLY PUBLIC DISCOVERY pass
 * (owner, 26 Oct 2026). For a handle the athlete confirmed, a new public reading (Business Discovery) becomes a
 * public-platform measured fact and asks for ONE debounced M.I.A. recompute; the same reading again asks for nothing;
 * a reading for a handle she never confirmed is never scored and asks for nothing.
 *
 * Real (PGlite) Postgres; the discovery client is mocked at its module boundary and the evaluation request at the
 * orchestrator — nothing reaches a provider or the evaluator.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

const fetchInstagramDiscovery = jest.fn();
const fetchYouTubeDiscovery = jest.fn();
jest.mock("../lib/integrations/discovery", () => ({
  fetchInstagramDiscovery: (...a: unknown[]) => fetchInstagramDiscovery(...a),
  fetchYouTubeDiscovery: (...a: unknown[]) => fetchYouTubeDiscovery(...a),
}));

const requestEvaluation = jest.fn().mockResolvedValue({ runId: "mia-run-1", created: true });
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({
  ...jest.requireActual("../services/marketabilityBeta1Orchestrator"),
  requestEvaluation: (...a: unknown[]) => requestEvaluation(...a),
}));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { memoryFacts } from "../../shared/schema";
import { dbStore } from "../agent/research/dbStore";
import { PUBLIC_REF_PREFIX } from "../agent/research/publicPlatform";
import { collectDiscoveryForAthlete } from "./collectDiscoveryAnalytics";

const env = process.env;
beforeAll(async () => { await initTestDb(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(() => {
  process.env = { ...env, SOCIAL_SUBSTRATE_WRITE: "" };
  fetchInstagramDiscovery.mockReset(); fetchYouTubeDiscovery.mockReset(); requestEvaluation.mockClear();
});

const reading = (username: string, followers: number) => ({
  found: true, error: null, native: null,
  result: {
    followers, following: null, post_count: 40, total_likes: null, total_channel_views: null, is_verified: false, reach: null, impressions: null,
    profile_views: null, avg_engagement_rate: 3.1, avg_reach_per_post: null, avg_views_per_post: null, avg_shares_per_post: null, avg_saves_per_post: null,
    avg_watch_time_sec: null, content_frequency: null, posts_last_30d: 5, top_audience_country: null, top_audience_city: null, top_audience_age_range: null,
    top_audience_gender: null, raw_metrics: { discovery: { platform: "instagram", username, source: "business_discovery" } }, toolsCalled: ["instagram_business_discovery"],
  },
});

async function memoryAthlete(name: string, confirmedHandle: string | null): Promise<string> {
  const id = await seedAthlete(name);
  await dbStore.insertFacts(id, [{ subject: { kind: "athlete", name }, claim: `The athlete's name is ${name}.`, type: "said", source: { ref: "onboarding/r1#name", title: "You told us" }, date: "2026-10-01", confidence: 1, runId: null }]);
  if (confirmedHandle) {
    await dbStore.insertFacts(id, [{ subject: { kind: "athlete", name }, claim: `${name}'s Instagram handle is @${confirmedHandle}.`, type: "said", source: { ref: "me/handles#handle:instagram", title: "You confirmed" }, date: "2026-10-20", confidence: 1, runId: null }]);
  }
  return id;
}
const publicMeasured = async (id: string) => (await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id)))
  .filter((f) => f.type === "measured" && f.status === "active" && (f.source_ref ?? "").startsWith(PUBLIC_REF_PREFIX));

test("a new public reading for her confirmed handle: public-platform measured facts + one debounced recompute; the same reading again asks nothing", async () => {
  const id = await memoryAthlete("Quinn Sample", "quinn.rows");
  fetchInstagramDiscovery.mockResolvedValue(reading("quinn.rows", 4200));
  const [row] = await collectDiscoveryForAthlete(id, { instagram: "quinn.rows" });
  expect(row).toMatchObject({ status: "written", followers: 4200 });
  expect((await publicMeasured(id)).map((f) => f.claim)).toContain("Instagram (@quinn.rows) has 4,200 followers (public profile).");
  expect(requestEvaluation).toHaveBeenCalledTimes(1);
  expect(requestEvaluation.mock.calls[0][0]).toMatchObject({ athleteId: id, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "nightly_discovery" });
  expect(requestEvaluation.mock.calls[0][0]).not.toHaveProperty("force");

  requestEvaluation.mockClear();
  await collectDiscoveryForAthlete(id, { instagram: "quinn.rows" });   // same day, same reading
  expect(requestEvaluation).not.toHaveBeenCalled();
});

test("a reading for a handle she never confirmed is never scored and asks for nothing", async () => {
  const id = await memoryAthlete("Rowan Sample", null);
  fetchInstagramDiscovery.mockResolvedValue(reading("rowan.typed", 900));
  await collectDiscoveryForAthlete(id, { instagram: "rowan.typed" });
  expect(await publicMeasured(id)).toEqual([]);
  expect(requestEvaluation).not.toHaveBeenCalled();
});
