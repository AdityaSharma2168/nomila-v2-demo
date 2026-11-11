/**
 * profileBio.test.ts — the athlete's bio as a time-stamped `profile.bio` social feature, against a
 * real (PGlite) Postgres: which envelope carries a bio per platform (and which deliberately does
 * not), store-only-when-non-empty, no duplicate of an identical consecutive value, a change is a
 * new row, and the full substrate ingest writes it with the envelope's source class. Envelopes are
 * built in the test — no provider module is imported and nothing reaches the network.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));

import { and, asc, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { socialFeatures } from "../../../../shared/schema";
import { bioOf, persistProfileBio, PROFILE_BIO_KEY, PROFILE_BIO_VERSION } from "./profileBio";
import { ensureIdentity } from "./ingest";
import { ingestNative } from "./substrate";
import type { InstagramDiscoveryNative, InstagramNative, TikTokNative, YouTubeDiscoveryNative, YouTubeNative } from "./native";

const base = { fetchedAt: "2026-10-03T04:30:00.000Z", apiVersion: "v", toolsCalled: [], errors: [] };
const yt = (description?: string): YouTubeNative => ({
  ...base, platform: "youtube", accountId: "UC123", handle: "@chan", sourceMethod: "oauth_youtube",
  channel: { id: "UC123", snippet: { title: "Chan", customUrl: "@chan", ...(description !== undefined ? { description } : {}) }, statistics: { subscriberCount: "10" } },
  analytics: { reportStart: "2026-09-03", reportEnd: "2026-10-03" }, videos: [],
});
const tt = (bio?: string): TikTokNative => ({
  ...base, platform: "tiktok", accountId: "open-1", handle: "@tt", sourceMethod: "oauth_tiktok_display",
  user: { open_id: "open-1", username: "tt", follower_count: 5, ...(bio !== undefined ? { bio_description: bio } : {}) }, videos: [], demographics: null,
});
const igConnected: InstagramNative = {
  ...base, platform: "instagram", accountId: "178", handle: "ig", sourceMethod: "oauth_instagram_login",
  profile: { id: "178", username: "ig", followers_count: 100 }, accountInsights: null, media: [], mediaFetchMode: "bare", demographics: {},
};
const igDiscovery = (biography?: string): InstagramDiscoveryNative => ({
  ...base, platform: "instagram", accountId: "179", handle: "pub", sourceMethod: "meta_business_discovery",
  businessDiscovery: { id: "179", username: "pub", followers_count: 50, ...(biography !== undefined ? { biography } : {}) },
});
const ytPublic = (description: string): YouTubeDiscoveryNative => ({
  ...base, platform: "youtube", accountId: "UC999", handle: "@pubchan", sourceMethod: "youtube_data_api",
  channel: { id: "UC999", snippet: { title: "Pub", description } }, videos: [],
});

beforeAll(initTestDb);
afterAll(closeTestDb);

describe("bioOf — where each platform's bio comes from", () => {
  test("youtube: channel snippet.description (connected and public)", () => {
    expect(bioOf(yt("  Pro athlete. Training diaries.  "))).toBe("Pro athlete. Training diaries.");
    expect(bioOf(ytPublic("public channel bio"))).toBe("public channel bio");
  });
  test("tiktok: user/info bio_description", () => {
    expect(bioOf(tt("on the road ✈️"))).toBe("on the road ✈️");
  });
  test("instagram: Business Discovery biography only — the Instagram-Login envelope carries none", () => {
    expect(bioOf(igDiscovery("public ig bio"))).toBe("public ig bio");
    expect(bioOf(igConnected)).toBeNull();
  });
  test("absent, empty or whitespace-only → null", () => {
    expect(bioOf(yt())).toBeNull();
    expect(bioOf(yt("   "))).toBeNull();
    expect(bioOf(tt(""))).toBeNull();
    expect(bioOf(igDiscovery())).toBeNull();
  });
});

describe("persistProfileBio", () => {
  let athleteId: string; let identityId: string;
  beforeAll(async () => {
    athleteId = await seedAthlete("Bio Athlete");
    const i = await ensureIdentity({ athleteId, platform: "tiktok", accountId: "tt-bio", accountIdKind: "platform_id", handle: "tt", canonicalUrl: null, sourceClass: "platform_public", sourceMethod: "test" });
    identityId = i.id;
  });
  const rows = () => db.select().from(socialFeatures)
    .where(and(eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, PROFILE_BIO_KEY))).orderBy(asc(socialFeatures.as_of));

  test("skips empty text", async () => {
    expect(await persistProfileBio({ athleteId, platform: "tiktok", identityId, sourceClass: "connected_verified", text: "  ", asOf: new Date("2026-10-01T00:00:00Z") })).toBe(false);
    expect(await persistProfileBio({ athleteId, platform: "tiktok", identityId, sourceClass: "connected_verified", text: null, asOf: new Date("2026-10-01T00:00:00Z") })).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  test("writes a time-stamped row; an identical consecutive value is not duplicated; a change is a new row", async () => {
    expect(await persistProfileBio({ athleteId, platform: "tiktok", identityId, sourceClass: "connected_verified", text: "first bio", asOf: new Date("2026-10-01T00:00:00Z") })).toBe(true);
    expect(await persistProfileBio({ athleteId, platform: "tiktok", identityId, sourceClass: "connected_verified", text: "first bio", asOf: new Date("2026-10-02T00:00:00Z") })).toBe(false);
    expect(await persistProfileBio({ athleteId, platform: "tiktok", identityId, sourceClass: "connected_verified", text: "second bio", asOf: new Date("2026-10-03T00:00:00Z") })).toBe(true);
    const r = await rows();
    expect(r.map((x) => (x.value_json as any).text)).toEqual(["first bio", "second bio"]);
    expect(r[0]).toMatchObject({
      platform: "tiktok", identity_id: identityId, value: null, unit: "text", window_days: 0,
      source_class: "connected_verified", input_access_class: "includes_athlete_private", calculation_version: PROFILE_BIO_VERSION,
    });
    expect(r[0].as_of.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("through the substrate ingest (SOCIAL_SUBSTRATE_WRITE on)", () => {
  const prev = process.env.SOCIAL_SUBSTRATE_WRITE;
  beforeAll(() => { process.env.SOCIAL_SUBSTRATE_WRITE = "true"; });
  afterAll(() => { if (prev === undefined) delete process.env.SOCIAL_SUBSTRATE_WRITE; else process.env.SOCIAL_SUBSTRATE_WRITE = prev; });

  const bios = (athleteId: string) => db.select().from(socialFeatures)
    .where(and(eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, PROFILE_BIO_KEY))).orderBy(asc(socialFeatures.as_of));

  test("connected YouTube and TikTok bios land as connected_verified; a re-sync with the same bio adds nothing", async () => {
    const athleteId = await seedAthlete("Ingest Bio");
    const ytConn = await seedConnection({ athleteId, platform: "youtube", platformUserId: "UC123" });
    const ttConn = await seedConnection({ athleteId, platform: "tiktok", platformUserId: "open-1" });
    expect((await ingestNative({ athleteId, native: yt("channel about me"), trigger: "nightly", connectedAccountId: ytConn, secrets: [] }))?.status).toBe("ok");
    await ingestNative({ athleteId, native: tt("tiktok about me"), trigger: "nightly", connectedAccountId: ttConn, secrets: [] });
    await ingestNative({ athleteId, native: { ...yt("channel about me"), fetchedAt: "2026-10-04T04:30:00.000Z" }, trigger: "nightly", connectedAccountId: ytConn, secrets: [] });

    const r = await bios(athleteId);
    expect(r.map((x) => [x.platform, (x.value_json as any).text, x.source_class])).toEqual(expect.arrayContaining([
      ["youtube", "channel about me", "connected_verified"],
      ["tiktok", "tiktok about me", "connected_verified"],
    ]));
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.platform === "youtube")!.as_of.toISOString()).toBe(base.fetchedAt);
    expect((r.find((x) => x.platform === "tiktok")!.inputs as any)).toMatchObject({ source_method: "oauth_tiktok_display" });
    expect((r.find((x) => x.platform === "tiktok")!.inputs as any).payload_id).toEqual(expect.any(String));
  });

  test("Instagram: Business Discovery bio lands as platform_public; the connected (Instagram Login) envelope writes none", async () => {
    const athleteId = await seedAthlete("IG Bio");
    const igConn = await seedConnection({ athleteId, platform: "instagram", platformUserId: "178" });
    await ingestNative({ athleteId, native: igConnected, trigger: "nightly", connectedAccountId: igConn, secrets: [] });
    expect(await bios(athleteId)).toHaveLength(0);

    await ingestNative({ athleteId, native: igDiscovery("public ig bio"), trigger: "discovery", connectedAccountId: null, secrets: [] });
    const r = await bios(athleteId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ platform: "instagram", source_class: "platform_public", input_access_class: "public_only", value_json: { text: "public ig bio" } });
  });

  test("an envelope without a bio writes no row", async () => {
    const athleteId = await seedAthlete("No Bio");
    const conn = await seedConnection({ athleteId, platform: "tiktok", platformUserId: "open-2" });
    await ingestNative({ athleteId, native: { ...tt(), accountId: "open-2" }, trigger: "nightly", connectedAccountId: conn, secrets: [] });
    expect(await bios(athleteId)).toHaveLength(0);
  });
});
