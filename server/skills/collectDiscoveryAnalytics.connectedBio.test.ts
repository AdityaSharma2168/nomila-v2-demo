/**
 * collectDiscoveryAnalytics.connectedBio.test.ts — the public bio of a CONNECTED Instagram account.
 *
 * Instagram Login exposes no bio, so the nightly discovery pass makes the existing Business
 * Discovery lookup for the connected handle and keeps ONLY the bio, as `platform_public` with the
 * discovery path's own markers (trigger 'discovery', source_method meta_business_discovery). The
 * connected account's metrics are untouched; discovery for unconnected athletes is unchanged.
 * Real (PGlite) Postgres; the discovery client is mocked at its module boundary — nothing reaches
 * a provider.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

const fetchInstagramDiscovery = jest.fn();
const fetchYouTubeDiscovery = jest.fn();
jest.mock("../lib/integrations/discovery", () => ({
  fetchInstagramDiscovery: (...a: unknown[]) => fetchInstagramDiscovery(...a),
  fetchYouTubeDiscovery: (...a: unknown[]) => fetchYouTubeDiscovery(...a),
}));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { athletes, socialAnalyticsSnapshots, socialFeatures, socialMetricObservations, socialSyncRuns } from "../../shared/schema";
import { collectDiscoveryForAthlete } from "./collectDiscoveryAnalytics";
import { ingestNative } from "../services/intelligence/social/substrate";
import { PROFILE_BIO_KEY } from "../services/intelligence/social/profileBio";
import type { InstagramDiscoveryNative, InstagramNative } from "../services/intelligence/social/native";

const env = process.env;
beforeAll(async () => { await initTestDb(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(() => {
  process.env = { ...env, SOCIAL_SUBSTRATE_WRITE: "true", DISCOVERY_IG_BUSINESS_ID: "shared-disc" };
  fetchInstagramDiscovery.mockReset(); fetchYouTubeDiscovery.mockReset();
});

const emptyResult = () => ({
  followers: 50, following: null, post_count: 3, total_likes: null, total_channel_views: null, is_verified: false, reach: null, impressions: null,
  profile_views: null, avg_engagement_rate: 1.2, avg_reach_per_post: null, avg_views_per_post: null, avg_shares_per_post: null, avg_saves_per_post: null,
  avg_watch_time_sec: null, content_frequency: null, posts_last_30d: 1, top_audience_country: null, top_audience_city: null, top_audience_age_range: null,
  top_audience_gender: null, raw_metrics: {}, toolsCalled: ["instagram_business_discovery"],
});
function found(handle: string, accountId: string, biography?: string) {
  const native: InstagramDiscoveryNative = {
    platform: "instagram", accountId, handle, fetchedAt: new Date().toISOString(), apiVersion: "v22.0", sourceMethod: "meta_business_discovery",
    toolsCalled: ["instagram_business_discovery"], errors: [],
    businessDiscovery: { id: accountId, username: handle, followers_count: 50, media_count: 3, ...(biography !== undefined ? { biography } : {}) },
  };
  return { found: true, result: emptyResult(), error: null, native };
}

const bios = (athleteId: string) => db.select().from(socialFeatures)
  .where(and(eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, PROFILE_BIO_KEY)));

test("connected Instagram: the existing discovery lookup for the CONNECTED handle stores only the bio, as platform_public; a repeat adds nothing", async () => {
  const athleteId = await seedAthlete("Connected IG Bio");
  await db.update(athletes).set({ socials: { instagram: "typed_handle" } } as any).where(eq(athletes.id, athleteId));
  await seedConnection({ athleteId, platform: "instagram", email: "conn_handle", platformUserId: "ig-1" });
  fetchInstagramDiscovery.mockResolvedValue(found("conn_handle", "ig-1", "public bio of the connected account"));

  const [row] = await collectDiscoveryForAthlete(athleteId, { instagram: "typed_handle" });
  expect(fetchInstagramDiscovery).toHaveBeenCalledWith("conn_handle");   // the connected account's known handle
  expect(row).toMatchObject({ platform: "instagram", status: "skipped", error: "connected", bio: "stored" });

  const r = await bios(athleteId);
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ platform: "instagram", source_class: "platform_public", input_access_class: "public_only", value_json: { text: "public bio of the connected account" } });
  expect((r[0].inputs as any).source_method).toBe("meta_business_discovery");
  const [run] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, (r[0].inputs as any).sync_run_id));
  expect(run).toMatchObject({ trigger: "discovery", source_class: "platform_public", endpoint_family: "business_discovery", status: "ok" });
  expect(run.connected_account_id).toBeNull();

  // Connected > discovery: no discovery analytics row, no observations from the public lookup.
  expect(await db.select().from(socialAnalyticsSnapshots).where(eq(socialAnalyticsSnapshots.athlete_id, athleteId))).toHaveLength(0);
  expect(await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.athlete_id, athleteId))).toHaveLength(0);

  const [again] = await collectDiscoveryForAthlete(athleteId, { instagram: "typed_handle" });
  expect(again.bio).toBe("unchanged");
  expect(await bios(athleteId)).toHaveLength(1);
});

test("connected Instagram: no bio on the public profile, a dry run, the shared discovery account, or the substrate flag off → nothing stored", async () => {
  const athleteId = await seedAthlete("No Public Bio");
  await seedConnection({ athleteId, platform: "instagram", email: "nobio", platformUserId: "ig-2" });
  fetchInstagramDiscovery.mockResolvedValue(found("nobio", "ig-2"));
  expect((await collectDiscoveryForAthlete(athleteId, { instagram: "nobio" }))[0].bio).toBe("none");
  expect((await collectDiscoveryForAthlete(athleteId, { instagram: "nobio" }, { dryRun: true }))[0].bio).toBeUndefined();

  const shared = await seedAthlete("Shared Account Holder");
  await seedConnection({ athleteId: shared, platform: "instagram", email: "nomila_disc", platformUserId: "shared-disc" });
  expect((await collectDiscoveryForAthlete(shared, { instagram: "nomila_disc" }))[0].bio).toBeNull();

  process.env.SOCIAL_SUBSTRATE_WRITE = "false";
  const off = await seedAthlete("Flag Off");
  await seedConnection({ athleteId: off, platform: "instagram", email: "flagoff", platformUserId: "ig-3" });
  expect((await collectDiscoveryForAthlete(off, { instagram: "flagoff" }))[0].bio).toBeNull();

  expect(fetchInstagramDiscovery).toHaveBeenCalledTimes(1);   // only the first call; dry run, shared account and flag-off never look up
  for (const a of [athleteId, shared, off]) expect(await bios(a)).toHaveLength(0);
});

test("the connected-API (Instagram Login) ingest still writes no Instagram bio", async () => {
  const athleteId = await seedAthlete("Connected API Only");
  const connId = await seedConnection({ athleteId, platform: "instagram", platformUserId: "ig-4" });
  const native: InstagramNative = {
    platform: "instagram", accountId: "ig-4", handle: "api", fetchedAt: new Date().toISOString(), apiVersion: "v22.0", sourceMethod: "oauth_instagram_login",
    toolsCalled: [], errors: [], profile: { id: "ig-4", username: "api", followers_count: 10 }, accountInsights: null, media: [], mediaFetchMode: "bare", demographics: {},
  };
  await ingestNative({ athleteId, native, trigger: "nightly", connectedAccountId: connId, secrets: [] });
  expect(await bios(athleteId)).toHaveLength(0);
});

test("unconnected athlete: discovery is unchanged — analytics row + full public ingest, bio platform_public", async () => {
  const athleteId = await seedAthlete("Unconnected");
  fetchInstagramDiscovery.mockResolvedValue(found("public_only", "ig-5", "unconnected public bio"));
  const [row] = await collectDiscoveryForAthlete(athleteId, { instagram: "public_only" });
  expect(fetchInstagramDiscovery).toHaveBeenCalledWith("public_only");
  expect(row).toMatchObject({ platform: "instagram", status: "written", followers: 50 });
  expect(row.bio).toBeUndefined();
  const snaps = await db.select().from(socialAnalyticsSnapshots).where(eq(socialAnalyticsSnapshots.athlete_id, athleteId));
  expect(snaps).toHaveLength(1);
  expect(snaps[0].source).toBe("discovery");
  expect((await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.athlete_id, athleteId))).length).toBeGreaterThan(0);
  const r = await bios(athleteId);
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ source_class: "platform_public", value_json: { text: "unconnected public bio" } });
});
