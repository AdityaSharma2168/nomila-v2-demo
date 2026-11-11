/**
 * ingest.test.ts — the substrate tables against a real (PGlite) Postgres: identity upsert with
 * handle history, payload store refuses secrets, observation uniqueness lets v1 and v2
 * definitions coexist while the same evidence is idempotent, media_assets rows are linked but
 * never created, features upsert, retention deletes payloads and observations survive.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { mediaAssets, rawSourcePayloads, socialFeatures, socialMetricObservations, socialSyncRuns } from "../../../../shared/schema";
import { attachContentNative, closeSyncRun, ensureIdentity, errorRecord, loadObservations, openSyncRun, payloadIdFor, storePayload, writeFeatures, writeObservations } from "./ingest";
import { enforceRawRetention } from "./retention";
import { ingestStoryLastLook, ingestStorySweep, selectStoriesDueForLastLook } from "./stories";
import type { IgStoryInsightsNative, InstagramStoriesNative } from "./native";
import { SanitizerLeakError } from "./sanitize";
import { calculateSocialFeatures } from "./features";

let athleteId: string, connId: string, identityId: string;
const SECRET = "IGQVJ" + "s".repeat(64);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Substrate Test");
  connId = await seedConnection({ athleteId, platform: "instagram" });
});
afterAll(closeTestDb);

describe("identities", () => {
  it("upserts on account id, appends prior handles, keeps the strongest source class", async () => {
    const a = await ensureIdentity({ athleteId, platform: "instagram", accountId: "178", accountIdKind: "platform_id", handle: "old", canonicalUrl: null, sourceClass: "platform_public", sourceMethod: "meta_business_discovery", confidence: 0.7 });
    identityId = a.id;
    const b = await ensureIdentity({ athleteId, platform: "instagram", accountId: "178", accountIdKind: "platform_id", handle: "new", canonicalUrl: "https://www.instagram.com/new/", sourceClass: "connected_verified", sourceMethod: "oauth_instagram_login", connectedAccountId: connId });
    expect(b.id).toBe(a.id);
    expect(b.handle).toBe("new");
    expect((b.handle_history as any[])[0].handle).toBe("old");
    expect(b.source_class).toBe("connected_verified");
    expect(b.connected_account_id).toBe(connId);
    const c = await ensureIdentity({ athleteId, platform: "instagram", accountId: "178", accountIdKind: "platform_id", handle: "new", canonicalUrl: null, sourceClass: "web_researched", sourceMethod: "research_extraction" });
    expect(c.source_class).toBe("connected_verified");   // a weaker source never downgrades
  });
});

describe("payloads", () => {
  it("stores a sanitized envelope with hash, bytes, version and retention, and refuses a leak", async () => {
    const runId = await openSyncRun({ athleteId, identityId, platform: "instagram", provider: "meta_graph", endpointFamily: "test", sourceClass: "connected_verified", trigger: "fixture" });
    const stored = await storePayload({ runId, athleteId, platform: "instagram", provider: "meta_graph", endpointFamily: "test", sourceClass: "connected_verified", request: { path: "/x", params: { access_token: SECRET, fields: "id" } }, payload: { data: [1], paging: { next: `https://g/?access_token=${SECRET}` } }, fetchedAt: new Date("2026-09-01T00:00:00Z"), retentionDays: 180, secrets: [SECRET] });
    const [row] = await db.select().from(rawSourcePayloads).where(eq(rawSourcePayloads.id, stored.id));
    expect(JSON.stringify(row.payload)).not.toContain(SECRET);
    expect(JSON.stringify(row.request)).not.toContain(SECRET);
    expect(row.sanitizer_version).toBe("v1");
    expect(row.retained_until?.toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(row.payload_hash).toHaveLength(64);
    await closeSyncRun(runId, { status: "ok", pages: 1, items: 0 });
    // A payload that still matches the leak detector after sanitization (here: a literal
    // `client_secret` mention the key/URL rules cannot rewrite) is REFUSED, never stored.
    const countBefore = (await db.select().from(rawSourcePayloads)).length;
    await expect(storePayload({ runId, athleteId, platform: "instagram", provider: "meta_graph", endpointFamily: "test", sourceClass: "connected_verified", request: null, payload: { note: "the client_secret is elsewhere" }, fetchedAt: new Date(), retentionDays: 1, secrets: [] }))
      .rejects.toBeInstanceOf(SanitizerLeakError);
    expect((await db.select().from(rawSourcePayloads)).length).toBe(countBefore);
    // A Bearer token is redacted by shape and the payload is stored clean.
    const ok = await storePayload({ runId, athleteId, platform: "instagram", provider: "meta_graph", endpointFamily: "test", sourceClass: "connected_verified", request: null, payload: { headers: { Authorization: "Bearer " + "z".repeat(40) } }, fetchedAt: new Date(), retentionDays: 1, secrets: [] });
    const [okRow] = await db.select().from(rawSourcePayloads).where(eq(rawSourcePayloads.id, ok.id));
    expect(JSON.stringify(okRow.payload)).not.toContain("z".repeat(40));
  });
});

describe("sync run close", () => {
  it("persists only the normalized error and pagination shapes, sanitized with the live secrets, and withholds a leak", async () => {
    const runId = await openSyncRun({ athleteId, identityId, platform: "instagram", provider: "meta_graph", endpointFamily: "test", sourceClass: "connected_verified", trigger: "fixture" });
    const providerError = { message: `Request failed https://graph/?fields=id&access_token=${SECRET}`, code: 190, headers: { Authorization: "Bearer " + "q".repeat(40) }, body: { access_token: SECRET, huge: "x".repeat(5000) }, subCalls: [{ step: "media", message: `boom ${SECRET}`, raw: { token: SECRET } }] };
    await closeSyncRun(runId, { status: "failed", error: providerError, paginationState: { cursor: `https://graph/?after=abc&access_token=${SECRET}`, pageIndex: 3, extra: "not persisted" }, secrets: [SECRET] });
    const [row] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, runId));
    expect(Object.keys(row.error as object).sort()).toEqual(["code", "message", "reason", "subCalls"]);
    expect(JSON.stringify(row.error)).not.toContain(SECRET);
    expect(JSON.stringify(row.error)).not.toContain("q".repeat(40));
    expect(JSON.stringify(row.error)).not.toContain("headers");
    expect((row.error as any).message).toBe("Request failed https://graph/");
    expect((row.error as any).subCalls[0]).toEqual({ step: "media", message: expect.not.stringContaining(SECRET) });
    expect(row.pagination_state).toEqual({ cursor: "https://graph/", pageIndex: 3 });   // a paging URL carrying a token loses its whole query string
    // A message the sanitizer cannot rewrite (a literal client_secret mention) is withheld, not stored.
    await closeSyncRun(runId, { status: "failed", error: new Error("the client_secret was rejected"), secrets: [] });
    const [again] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, runId));
    expect(again.error).toEqual({ reason: "sanitizer_leak", message: expect.stringContaining("withheld") });
    expect(errorRecord(null)).toBeNull();
    expect(errorRecord("plain")).toEqual({ reason: "error", message: "plain" });
  });
});

describe("payload lineage", () => {
  it("resolves payload_id by family only; an unknown family stores NULL, never another payload", async () => {
    expect(payloadIdFor({ payloadIds: { profile: "p1", media: "p2" } } as any, "profile")).toBe("p1");
    expect(payloadIdFor({ payloadIds: { profile: "p1", media: "p2" } } as any, "demographics")).toBeNull();
    expect(payloadIdFor({ payloadIds: { profile: "p1" } } as any, undefined)).toBeNull();
    expect(payloadIdFor({ payloadId: "single" } as any, "anything")).toBe("single");
    expect(payloadIdFor({} as any, "anything")).toBeNull();

    const runId = await openSyncRun({ athleteId, identityId, platform: "instagram", provider: "meta_graph", endpointFamily: "profile", sourceClass: "connected_verified", trigger: "fixture" });
    const p1 = await storePayload({ runId, athleteId, platform: "instagram", provider: "meta_graph", endpointFamily: "profile", pageIndex: 0, sourceClass: "connected_verified", request: null, payload: { followers_count: 5 }, fetchedAt: new Date("2026-09-03T00:00:00Z"), retentionDays: 1, secrets: [] });
    const p2 = await storePayload({ runId, athleteId, platform: "instagram", provider: "meta_graph", endpointFamily: "media", pageIndex: 1, sourceClass: "connected_verified", request: null, payload: { data: [] }, fetchedAt: new Date("2026-09-03T00:00:00Z"), retentionDays: 1, secrets: [] });
    const ctx = { athleteId, platform: "instagram", identityId, sourceClass: "connected_verified" as const, sourceMethod: "oauth_instagram_login", provider: "meta_graph", runId, payloadIds: { profile: p1.id, media: p2.id } };
    await writeObservations(ctx, [
      { entityType: "account", entityId: "178", metricKey: "following", value: 5, unit: "count", observedAt: "2026-09-03T00:00:00.000Z", payloadFamily: "profile" },
      { entityType: "account", entityId: "178", metricKey: "likes_total", value: 9, unit: "count", observedAt: "2026-09-03T00:00:00.000Z", payloadFamily: "not_stored" },
      { entityType: "account", entityId: "178", metricKey: "views_total", value: 1, unit: "count", observedAt: "2026-09-03T00:00:00.000Z" },
    ]);
    const rows = await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.sync_run_id, runId));
    const byKey = Object.fromEntries(rows.map((r) => [r.metric_key, r.payload_id]));
    expect(byKey).toEqual({ following: p1.id, likes_total: null, views_total: null });
    await closeSyncRun(runId, { status: "ok", pages: 2, items: 3 });
  });
});

describe("observations", () => {
  const ctx = { athleteId, platform: "instagram", identityId: "", sourceClass: "connected_verified" as const, sourceMethod: "oauth_instagram_login", provider: "meta_graph" };
  it("is idempotent on the same evidence and lets a later definition version coexist", async () => {
    ctx.athleteId = athleteId; ctx.identityId = identityId;
    const row = { entityType: "account" as const, entityId: "178", metricKey: "followers" as const, value: 100, unit: "count" as const, observedAt: "2026-09-01T00:00:00.000Z" };
    expect(await writeObservations(ctx, [row])).toBe(1);
    expect(await writeObservations(ctx, [row])).toBe(0);
    expect(await writeObservations({ ...ctx, definitionVersion: "v2" }, [row])).toBe(1);
    const all = (await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.identity_id, identityId))).filter((o) => o.metric_key === "followers");
    expect(all.map((o) => o.definition_version).sort()).toEqual(["v1", "v2"]);
  });
  it("windowed metrics with different windows never collide", async () => {
    const base = { entityType: "account" as const, entityId: "178", metricKey: "account_reach" as const, value: 5, unit: "count" as const, observedAt: "2026-09-01T00:00:00.000Z" };
    expect(await writeObservations(ctx, [{ ...base, windowStart: "2026-08-31T00:00:00.000Z", windowEnd: "2026-09-01T00:00:00.000Z" }])).toBe(1);
    expect(await writeObservations(ctx, [{ ...base, windowStart: "2026-08-02T00:00:00.000Z", windowEnd: "2026-09-01T00:00:00.000Z" }])).toBe(1);
    expect(await writeObservations(ctx, [{ ...base, windowStart: "2026-08-02T00:00:00.000Z", windowEnd: "2026-09-01T00:00:00.000Z" }])).toBe(0);
  });
  it("content observations link to an existing media_assets row and never create one", async () => {
    const [asset] = await db.insert(mediaAssets).values({ athlete_id: athleteId, platform: "instagram", origin: "connected", source_media_id: "m1", media_type: "VIDEO", status: "stored" } as any).returning({ id: mediaAssets.id });
    const linked = await attachContentNative({ athleteId, platform: "instagram", identityId }, [
      { sourceMediaId: "m1", postedAt: "2026-08-20T00:00:00.000Z", contentFormat: "reel", native: { media_product_type: "REELS", cover: `https://cdn/x.jpg?x-signature=abc&refresh_token=${SECRET}` } },
      { sourceMediaId: "m-not-there", postedAt: null, contentFormat: "post", native: {} },
    ], [SECRET]);
    expect([...linked.keys()]).toEqual(["m1"]);
    const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(a.content_format).toBe("reel");
    expect(a.social_identity_id).toBe(identityId);
    expect((a.native as any).cover).toBe("https://cdn/x.jpg");
    const total = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect(total).toHaveLength(1);
    const n = await writeObservations(ctx, [{ entityType: "content", entityId: "m1", entityTime: "2026-08-20T00:00:00.000Z", entityFormat: "reel", metricKey: "reach", value: 4000, unit: "count", observedAt: "2026-09-01T00:00:00.000Z" }], linked);
    expect(n).toBe(1);
    const [o] = await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.entity_id, "m1"));
    expect(o.asset_id).toBe(asset.id);
  });
});

describe("features and retention", () => {
  it("features upsert on their key and are computed from stored observations only", async () => {
    const obs = await loadObservations(athleteId, new Date("2026-01-01"), new Date("2026-12-31"));
    const rows = calculateSocialFeatures({ identities: [{ id: identityId, platform: "instagram" }], observations: obs, distributions: [], asOf: "2026-09-02T00:00:00.000Z" });
    expect(rows.find((r) => r.featureKey === "followers_latest")!.value).toBe(100);
    expect(await writeFeatures(athleteId, rows)).toBe(rows.length);
    expect(await writeFeatures(athleteId, rows)).toBe(rows.length);   // rerun replaces, no duplicate
    const stored = await db.select().from(socialFeatures).where(eq(socialFeatures.athlete_id, athleteId));
    expect(stored.length).toBe(rows.length);
    for (const r of stored) expect(r.input_access_class).toBe("includes_athlete_private");   // every input was connected evidence
  });
  it("retention deletes expired payloads and the observations survive", async () => {
    const before = await db.select().from(rawSourcePayloads);
    expect(before.length).toBeGreaterThan(0);
    const { deleted } = await enforceRawRetention(new Date("2030-01-01T00:00:00Z"));
    expect(deleted).toBe(before.length);
    const obs = await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.identity_id, identityId));
    expect(obs.length).toBeGreaterThan(0);
  });
});

describe("Stories (Step 1b)", () => {
  const H = 3_600_000;
  const NOW = new Date("2026-09-12T20:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const insights = (storyId: string, postedAt: string, at: string, over: Partial<IgStoryInsightsNative> = {}): IgStoryInsightsNative => ({
    storyId, story: { id: storyId, timestamp: postedAt, media_product_type: "STORY" }, fetchedAt: at,
    insights: { data: [{ name: "reach", values: [{ value: 120 }] }, { name: "views", values: [{ value: 140 }] }] } as any,
    navigation: { data: [{ name: "navigation", total_value: { breakdowns: [{ dimension_keys: ["story_navigation_action_type"], results: [{ dimension_values: ["TAP_EXIT"], value: 10 }] }] } }] } as any,
    profileActivity: null, requestedMetrics: ["reach", "views"], unsupportedMetrics: [], errors: [], ...over,
  });
  const listNative = (stories: Array<{ id: string; timestamp: string }>, at: string): InstagramStoriesNative => ({ platform: "instagram", accountId: "178", handle: "new", fetchedAt: at, apiVersion: "v22.0", sourceMethod: "oauth_instagram_login", toolsCalled: [], errors: [], stories: stories.map((s) => ({ ...s, media_product_type: "STORY", media_type: "IMAGE" })) });
  let prevFlag: string | undefined;
  beforeAll(() => { prevFlag = process.env.SOCIAL_STORIES_WRITE; process.env.SOCIAL_STORIES_WRITE = "true"; });
  afterAll(() => { if (prevFlag === undefined) delete process.env.SOCIAL_STORIES_WRITE; else process.env.SOCIAL_STORIES_WRITE = prevFlag; });

  it("0045: trigger 'stories' is accepted and an unknown trigger is rejected by the CHECK", async () => {
    const id = await openSyncRun({ athleteId, identityId, platform: "instagram", provider: "meta_graph", endpointFamily: "stories_list", sourceClass: "connected_verified", trigger: "stories" });
    expect(id).toBeTruthy();
    await closeSyncRun(id, { status: "ok" });
    await expect(db.insert(socialSyncRuns).values({ athlete_id: athleteId, identity_id: identityId, platform: "instagram", provider: "meta_graph", endpoint_family: "x", source_class: "connected_verified", trigger: "bogus" } as any)).rejects.toThrow();
  });

  it("flag off: a sweep writes nothing and returns null", async () => {
    process.env.SOCIAL_STORIES_WRITE = "false";
    const before = (await db.select().from(socialSyncRuns)).length;
    expect(await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([{ id: "off1", timestamp: iso(NOW.getTime() - H) }], NOW.toISOString()), readInsights: async () => { throw new Error("must not be called"); }, secrets: [] })).toBeNull();
    expect((await db.select().from(socialSyncRuns)).length).toBe(before);
    process.env.SOCIAL_STORIES_WRITE = "true";
  });

  it("a sweep stores the listing and three insight payloads per Story, writes observations by family, and a later sweep adds rows", async () => {
    const posted = iso(NOW.getTime() - 3 * H);
    const at1 = iso(NOW.getTime() - 2 * H), at2 = iso(NOW.getTime() - 1 * H);
    const r1 = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([{ id: "st1", timestamp: posted }], at1), readInsights: async (s) => insights(s.id, posted, at1), secrets: [SECRET] });
    expect(r1).toMatchObject({ status: "ok", stories: 1, payloads: 3, authFailure: false });   // list + insights + navigation (no profile activity body)
    const [run] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, r1!.runId));
    expect(run.trigger).toBe("stories"); expect(run.endpoint_family).toBe("stories_list");
    const rows = await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.entity_id, "st1"));
    const byKey = Object.fromEntries(rows.map((o) => [o.metric_key, o]));
    expect(byKey.listed).toMatchObject({ entity_format: "story", entity_type: "content", asset_id: null, source_class: "connected_verified", source_method: "oauth_instagram_login" });
    expect(byKey.reach.payload_id).not.toBeNull(); expect(byKey.story_nav_tap_exit.payload_id).not.toBeNull();
    expect(byKey.reach.payload_id).not.toBe(byKey.listed.payload_id);
    expect(byKey.reach.payload_id).not.toBe(byKey.story_nav_tap_exit.payload_id);   // each row points at its own family's payload
    const families = await db.select({ f: rawSourcePayloads.endpoint_family }).from(rawSourcePayloads).where(eq(rawSourcePayloads.sync_run_id, r1!.runId));
    expect(families.map((x) => x.f).sort()).toEqual(["stories_list", "story_insights", "story_navigation"]);
    const r2 = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([{ id: "st1", timestamp: posted }], at2), readInsights: async (s) => insights(s.id, posted, at2), secrets: [SECRET] });
    expect(r2!.status).toBe("ok");
    const rows2 = await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.entity_id, "st1"));
    expect(rows2.length).toBe(rows.length * 2);                                   // repeated observations add rows, never update
    const media = await db.select().from(mediaAssets).where(eq(mediaAssets.source_media_id, "st1"));
    expect(media).toHaveLength(0);                                                  // never a media_assets row
  });

  it("a failed listing writes no `listed` observation and no synthetic empty-list payload; the provider failure is preserved", async () => {
    const at = iso(NOW.getTime() - 5 * H);
    const before = (await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.metric_key, "listed"))).length;
    let insightCalls = 0;
    const errBody = { error: { message: "(#4) Application request limit reached", type: "OAuthException", code: 4, fbtrace_id: "AbC" } };
    const failed = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: { ...listNative([], at), errors: [{ step: "stories_list", message: "(#4) Application request limit reached", class: "rate_limited", code: 4, httpStatus: 400 } as any], listingError: { httpStatus: 400, body: errBody } }, readInsights: async () => { insightCalls++; return insights("never", at, at); }, secrets: [] });
    expect(failed).toMatchObject({ status: "failed", stories: 0, observations: 0, payloads: 1, authFailure: false });
    expect(insightCalls).toBe(0);
    expect((await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.metric_key, "listed"))).length).toBe(before);
    const payloads = await db.select().from(rawSourcePayloads).where(eq(rawSourcePayloads.sync_run_id, failed!.runId));
    expect(payloads.map((p) => p.endpoint_family)).toEqual(["stories_list_error"]);
    expect(payloads[0].payload).toEqual(errBody);                               // the actual provider envelope, not {data: []}
    const [run] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, failed!.runId));
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ reason: "rate_limited", subCalls: [{ step: "stories_list", message: expect.stringContaining("rate_limited") }] });
    // No body at all → no raw list payload, still no listed rows.
    const bare = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: { ...listNative([], at), errors: [{ step: "stories_list", message: "HTTP 502", class: "transient", httpStatus: 502 } as any], listingError: { httpStatus: 502, body: null } }, readInsights: async () => insights("never", at, at), secrets: [] });
    expect(bare).toMatchObject({ status: "failed", payloads: 0, observations: 0 });
    expect((await db.select().from(rawSourcePayloads).where(eq(rawSourcePayloads.sync_run_id, bare!.runId))).length).toBe(0);
    // A genuinely empty listing is still a real payload.
    const empty = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([], at), readInsights: async () => insights("never", at, at), secrets: [] });
    expect(empty).toMatchObject({ status: "ok", payloads: 1, observations: 0 });
    expect((await db.select().from(rawSourcePayloads).where(eq(rawSourcePayloads.sync_run_id, empty!.runId))).map((p) => p.endpoint_family)).toEqual(["stories_list"]);
  });

  it("insight refusals make the run partial with normalized sub-calls; only an auth class marks authFailure", async () => {
    const posted = iso(NOW.getTime() - 4 * H), at = iso(NOW.getTime() - 3.5 * H);
    const partial = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([{ id: "st2", timestamp: posted }], at), readInsights: async (s) => insights(s.id, posted, at, { insights: null, navigation: null, errors: [{ step: "story_insights", message: "(#10) Not enough viewers for the media to show insights", class: "not_enough_viewers", code: 10 }, { step: "story_navigation", message: "(#10) Not enough viewers", class: "not_enough_viewers", code: 10 }] }), secrets: [] });
    expect(partial).toMatchObject({ status: "partial", authFailure: false });
    const [run] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, partial!.runId));
    expect((run.error as any).subCalls[0].step).toBe("story:st2:story_insights");
    const listedOnly = await db.select().from(socialMetricObservations).where(eq(socialMetricObservations.entity_id, "st2"));
    expect(listedOnly.map((o) => o.metric_key)).toEqual(["listed"]);
    const forbidden = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([{ id: "st3", timestamp: posted }], at), readInsights: async (s) => insights(s.id, posted, at, { insights: null, navigation: null, errors: [{ step: "story_insights", message: "Forbidden", class: "unknown", httpStatus: 403 }] }), secrets: [] });
    expect(forbidden).toMatchObject({ status: "partial", authFailure: false });     // a bare 403 never expires anything
    const auth = await ingestStorySweep({ athleteId, connectedAccountId: connId, list: listNative([{ id: "st4", timestamp: posted }], at), readInsights: async (s) => insights(s.id, posted, at, { insights: null, navigation: null, errors: [{ step: "story_insights", message: "Invalid OAuth access token", class: "auth", code: 190, subcode: 463 }] }), secrets: [] });
    expect(auth).toMatchObject({ status: "failed", authFailure: true });
  });

  it("last-look selection: listed never satisfies it; a reading at/after 22 h does; expiry closes the window; a failed attempt stays due", async () => {
    const ctx = { athleteId, platform: "instagram", identityId, sourceClass: "connected_verified" as const, sourceMethod: "oauth_instagram_login", provider: "meta_graph" };
    const row = (id: string, postedMs: number, key: "listed" | "reach", atMs: number) => ({ entityType: "content" as const, entityId: id, entityTime: iso(postedMs), entityFormat: "story" as const, metricKey: key, value: key === "listed" ? 1 : 50, unit: "count" as const, observedAt: iso(atMs) });
    const t = NOW.getTime();
    await writeObservations(ctx, [
      row("ll-a", t - 22.5 * H, "listed", t - 14.5 * H),                                   // listed only → due
      row("ll-b", t - 22.5 * H, "listed", t - 14.5 * H), row("ll-b", t - 22.5 * H, "reach", t - 0.4 * H),   // reading at 22.1 h → not due
      row("ll-c", t - 24.5 * H, "listed", t - 16.5 * H),                                   // expired → never
      row("ll-d", t - 23.5 * H, "listed", t - 15.5 * H), row("ll-d", t - 23.5 * H, "reach", t - 1.6 * H),   // reading at 21.9 h → still due
      row("ll-e", t - 8 * H, "listed", t - 0.1 * H),                                        // too young → not due
    ]);
    const due = (await selectStoriesDueForLastLook(NOW)).map((d) => d.entityId).filter((id) => id.startsWith("ll-")).sort();
    expect(due).toEqual(["ll-a", "ll-d"]);
    // A successful last look removes the Story from the due set; a refused one leaves it there.
    const [a] = (await selectStoriesDueForLastLook(NOW)).filter((d) => d.entityId === "ll-a");
    expect(a.connectedAccountId).toBe(connId);
    const refused = await ingestStoryLastLook({ due: a, accountId: "178", secrets: [], readInsights: async () => insights("ll-a", iso(t - 22.5 * H), iso(t - 0.2 * H), { insights: null, navigation: null, errors: [{ step: "story_insights", message: "(#10) Not enough viewers", class: "not_enough_viewers", code: 10 }] }) });
    expect(refused!.status).toBe("partial");
    expect((await selectStoriesDueForLastLook(NOW)).some((d) => d.entityId === "ll-a")).toBe(true);
    const ok = await ingestStoryLastLook({ due: a, accountId: "178", secrets: [], readInsights: async () => insights("ll-a", iso(t - 22.5 * H), iso(t - 0.1 * H)) });
    expect(ok!.status).toBe("ok");
    const [llRun] = await db.select().from(socialSyncRuns).where(eq(socialSyncRuns.id, ok!.runId));
    expect(llRun.endpoint_family).toBe("story_last_look"); expect(llRun.trigger).toBe("stories");
    expect((await selectStoriesDueForLastLook(NOW)).some((d) => d.entityId === "ll-a")).toBe(false);
    expect((await selectStoriesDueForLastLook(NOW)).some((d) => d.entityId === "ll-d")).toBe(true);
  });
});
