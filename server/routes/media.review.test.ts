/**
 * "Review my camera roll" — the three endpoints, end to end against PGlite.
 *
 * What these lock down, in order of how badly they'd hurt if they broke silently:
 *
 *  1. TENANCY. Every path in every request is asserted by the client. A request naming another
 *     athlete's object must be refused, not partially honoured — otherwise this feature becomes a
 *     way to read or register someone else's photos.
 *  2. THE CONTENT GATE, both directions: blocked content never registers (and its bytes are
 *     deleted), and a Vision OUTAGE does not block an ordinary upload — the deliberate
 *     open/closed asymmetry documented in lib/moderation.ts.
 *  3. posted_at. Uploads used to be stamped `now`, so every imported photo would have claimed to
 *     be shot today and won every recency tie in the library. The capture date is the fix, and it
 *     is invisible when it regresses.
 *  4. The ≤100 caps, so one call can't fan out into hundreds of Gemini/Vertex/Vision requests.
 *
 * Real Express router; GCS, Gemini, Vertex and SafeSearch are all mocked — none of them can run
 * outside Cloud Run, and the point here is the wiring, not the models.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/mediaStore", () => {
  const actual = jest.requireActual("../lib/mediaStore");
  return {
    ...actual,
    signedUrl:       jest.fn(async (p: string) => `https://signed.example/${p}`),
    signedUploadUrl: jest.fn(async (p: string) => `https://signed.example/upload/${p}?sig=abc`),
    deleteObject:    jest.fn(async () => {}),
    deletePrefix:    jest.fn(async () => 0),
  };
});
jest.mock("../services/mediaEnrichment", () => ({ enrichNextChunk: jest.fn(async () => {}) }));
jest.mock("../studio/orient", () => ({ normalizeStoredImage: jest.fn(async () => null) }));
jest.mock("../lib/visionTag", () => {
  const actual = jest.requireActual("../lib/visionTag");
  return { ...actual, tagAsset: jest.fn() };
});
jest.mock("../lib/mediaEmbed", () => ({ embedImageGcs: jest.fn(async () => [1, 0, 0, 0]) }));
jest.mock("../lib/moderation", () => ({ moderateGcsImage: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import mediaRouter from "./media";
import { mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { deleteObject, deletePrefix } from "../lib/mediaStore";
import { tagAsset } from "../lib/visionTag";
import { embedImageGcs } from "../lib/mediaEmbed";
import { moderateGcsImage } from "../lib/moderation";
import type { AssetTags } from "../lib/visionTag";

const mockTag = tagAsset as jest.MockedFunction<typeof tagAsset>;
const mockEmbed = embedImageGcs as jest.MockedFunction<typeof embedImageGcs>;
const mockModerate = moderateGcsImage as jest.MockedFunction<typeof moderateGcsImage>;

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

function asUser(id: string) { (globalThis as any).__TEST_ATHLETE_ID = id; }

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const CLEAN = {
  blocked: false, categories: [] as string[],
  scores: { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" },
} as const;

function tags(over: Partial<AssetTags> = {}): AssetTags {
  return {
    athlete_present: true, athlete_prominence: 0.8, shot_type: "portrait",
    description: "on court", brands_visible: [], aesthetic_quality: 0.8, brand_safe: true,
    setting: "gym", attire: "kit", vibe: "focused", hero_suitability: 0.8,
    disposition: "as_is", edit_note: "", reason: "Looks great.",
    ...over,
  } as AssetTags;
}

/** A library asset the likeness centroid can be built from. */
async function seedLibraryAsset(id: string, athlete: string, athletePresent: boolean, embedding: number[]) {
  await db.insert(mediaAssets).values({
    athlete_id: athlete, platform: "instagram", origin: "connected", source_media_id: id,
    media_type: "IMAGE", gcs_path: `athletes/${athlete}/ig/${id}.jpg`, status: "stored",
    metadata: { vision: { athlete_present: athletePresent }, embedding } as any,
  } as any);
}

const reviewItem = (n: number, athlete = athleteId, session = "sess1") => ({
  itemId: `i${n}`, gcsPath: `athletes/${athlete}/review/${session}/i${n}.review.jpg`, width: 512, height: 512,
});

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/", mediaRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  jest.clearAllMocks();
  athleteId = await seedAthlete();
  otherAthleteId = await seedAthlete();
  asUser(athleteId);
  mockTag.mockResolvedValue(tags());
  mockEmbed.mockResolvedValue([1, 0, 0, 0]);
  mockModerate.mockResolvedValue({ ...CLEAN, categories: [], scores: { ...CLEAN.scores } });
});

describe("POST /media/review/upload-url — the thumbnail mint", () => {
  it("mints WITHOUT the rights acknowledgment", async () => {
    // The ack is an attestation about media we KEEP. A review thumbnail is scored and thrown away,
    // so demanding the attestation here would be asking her to promise something about nothing —
    // and would put the legal moment before she has seen a single suggestion.
    const { status, json } = await post("/media/review/upload-url", { sessionId: "sess1", itemId: "i1" });
    expect(status).toBe(200);
    // The `.review.jpg` suffix is what the bucket's 1-day lifecycle rule matches on — see
    // reviewObjectPath. Changing it without changing the rule leaks thumbnails forever.
    expect(json.gcsPath).toBe(`athletes/${athleteId}/review/sess1/i1.review.jpg`);
    expect(json.uploadUrl).toContain("https://signed.example/upload/");
  });

  it("refuses a thumbnail over the review size cap", async () => {
    const { status, json } = await post("/media/review/upload-url", { sessionId: "sess1", itemId: "i1", bytes: 900_000 });
    expect(status).toBe(413);
    expect(json.error).toContain("400KB");
  });

  it("refuses ids that could escape the session prefix", async () => {
    for (const bad of [{ sessionId: "../..", itemId: "i1" }, { sessionId: "s", itemId: "../../uploads/x" }, {}]) {
      const { status } = await post("/media/review/upload-url", bad);
      expect(status).toBe(400);
    }
  });
});

describe("POST /media/review — scoring a batch", () => {
  it("returns keep/more/drop and the tags the grid shows", async () => {
    mockTag.mockImplementation(async (p: string) =>
      p.includes("/i2.") ? tags({ athlete_present: false, reason: "nobody here" }) : tags({ brands_visible: ["Nike"] }));

    const { status, json } = await post("/media/review", { sessionId: "sess1", items: [reviewItem(1), reviewItem(2)] });

    expect(status).toBe(200);
    expect(json.keep.map((k: any) => k.itemId)).toEqual(["i1"]);
    expect(json.keep[0].tags).toEqual({ shot_type: "portrait", brand_safe: true, brands_visible: ["Nike"], disposition: "as_is" });
    expect(json.keep[0].rank).toBeCloseTo(0.8);
    expect(json.drop).toEqual([{ itemId: "i2", code: "not_present", reason: expect.any(String) }]);
  });

  it("never registers anything — review is read-only", async () => {
    await post("/media/review", { sessionId: "sess1", items: [reviewItem(1)] });
    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect(rows).toHaveLength(0);
  });

  it("caps a call at 100 items", async () => {
    const items = Array.from({ length: 101 }, (_, i) => reviewItem(i));
    const { status, json } = await post("/media/review", { sessionId: "sess1", items });
    expect(status).toBe(413);
    expect(json.error).toContain("100");
    expect(mockTag).not.toHaveBeenCalled();   // refused before any model was touched
  });

  it("refuses a batch containing another athlete's path, without scoring any of it", async () => {
    const { status } = await post("/media/review", {
      sessionId: "sess1",
      items: [reviewItem(1), reviewItem(2, otherAthleteId)],
    });
    expect(status).toBe(400);
    expect(mockTag).not.toHaveBeenCalled();
  });

  it("drops content the SafeSearch gate blocks, and never scores it", async () => {
    mockModerate.mockImplementation(async (p: string) =>
      p.includes("/i2.")
        ? { blocked: true, categories: ["adult"], scores: null }
        : { ...CLEAN, categories: [], scores: { ...CLEAN.scores } });

    const { json } = await post("/media/review", { sessionId: "sess1", items: [reviewItem(1), reviewItem(2)] });

    expect(json.keep.map((k: any) => k.itemId)).toEqual(["i1"]);
    expect(json.drop).toContainEqual({ itemId: "i2", code: "content", reason: expect.any(String) });
    // Blocked ⇒ we don't spend a vision call on it either.
    expect(mockTag).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED when the content gate is unavailable", async () => {
    mockModerate.mockResolvedValue({ blocked: false, categories: [], scores: null, error: "deadline exceeded" });
    const { json } = await post("/media/review", { sessionId: "sess1", items: [reviewItem(1)] });
    expect(json.keep).toHaveLength(0);
    expect(json.drop[0].code).toBe("moderation_unavailable");
  });

  it("skips the likeness rule with fewer than 5 reference photos, and SAYS so", async () => {
    for (let i = 0; i < 4; i++) await seedLibraryAsset(`ref${i}`, athleteId, true, [1, 0, 0, 0]);
    mockEmbed.mockResolvedValue([0, 1, 0, 0]);   // nothing like the centroid — would fail rule 4

    const { json } = await post("/media/review", { sessionId: "sess1", items: [reviewItem(1)] });

    expect(json.likenessAvailable).toBe(false);
    expect(json.likenessNote).toContain("5");
    expect(json.keep.map((k: any) => k.itemId)).toEqual(["i1"]);   // kept — the rule did not run
  });

  it("applies the likeness rule once there are enough reference photos", async () => {
    for (let i = 0; i < 5; i++) await seedLibraryAsset(`ref${i}`, athleteId, true, [1, 0, 0, 0]);
    // Only assets she is IN count — a friend's photo in her library must not move the centroid.
    await seedLibraryAsset("notHer", athleteId, false, [0, 1, 0, 0]);
    mockEmbed.mockImplementation(async (p: string) => (p.includes("/i2.") ? [0, 1, 0, 0] : [1, 0, 0, 0]));

    const { json } = await post("/media/review", { sessionId: "sess1", items: [reviewItem(1), reviewItem(2)] });

    expect(json.likenessAvailable).toBe(true);
    expect(json.keep.map((k: any) => k.itemId)).toEqual(["i1"]);
    expect(json.drop).toContainEqual({ itemId: "i2", code: "likeness", reason: expect.any(String) });
  });

  it("does not build the centroid from another athlete's library", async () => {
    for (let i = 0; i < 8; i++) await seedLibraryAsset(`other${i}`, otherAthleteId, true, [1, 0, 0, 0]);
    const { json } = await post("/media/review", { sessionId: "sess1", items: [reviewItem(1)] });
    expect(json.likenessAvailable).toBe(false);
  });
});

describe("POST /media/review/import", () => {
  const uploaded = (n: number, over: Record<string, unknown> = {}) => ({
    itemId: `i${n}`, uploadedGcsPath: `athletes/${athleteId}/uploads/u${n}.jpg`,
    contentType: "image/jpeg", width: 1200, height: 1600, ...over,
  });

  it("stamps posted_at with the photo's CAPTURE date, not now", async () => {
    const shotOn = "2026-06-01T10:30:00.000Z";
    const { status } = await post("/media/review/import", {
      sessionId: "sess1", items: [uploaded(1, { createdAt: shotOn, rank: 0.81, reason: "Great light." })],
    });
    expect(status).toBe(201);

    const [row] = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.origin, "upload")));
    expect(row.posted_at?.toISOString()).toBe(shotOn);
    // ingested_at still says when it arrived — the two are different questions.
    expect(row.ingested_at!.getTime()).toBeGreaterThan(new Date(shotOn).getTime());
  });

  it("records the review provenance and the moderation verdict on the row", async () => {
    await post("/media/review/import", {
      sessionId: "sess7", items: [uploaded(1, { rank: 0.77, reason: "You're the subject." })],
    });
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect((row.metadata as any).review).toEqual({ sessionId: "sess7", rank: 0.77, reason: "You're the subject." });
    expect((row.metadata as any).moderation.adult).toBe("VERY_UNLIKELY");
  });

  it("falls back to now when no capture date is sent (unchanged behaviour)", async () => {
    const before = Date.now();
    await post("/media/review/import", { sessionId: "sess1", items: [uploaded(1)] });
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect(row.posted_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("does not trust a future capture date", async () => {
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString();
    await post("/media/review/import", { sessionId: "sess1", items: [uploaded(1, { createdAt: future })] });
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect(row.posted_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("refuses to register an object under another athlete's prefix", async () => {
    const { status } = await post("/media/review/import", {
      sessionId: "sess1",
      items: [{ itemId: "i1", uploadedGcsPath: `athletes/${otherAthleteId}/uploads/u1.jpg`, contentType: "image/jpeg" }],
    });
    expect(status).toBe(400);
    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect(rows).toHaveLength(0);
  });

  it("refuses a review-prefix path — only real uploads become library rows", async () => {
    const { status, json } = await post("/media/review/import", {
      sessionId: "sess1",
      items: [{ itemId: "i1", uploadedGcsPath: `athletes/${athleteId}/review/sess1/i1.jpg`, contentType: "image/jpeg" }],
    });
    // Passes the tenancy prefix but not the uploads/ prefix — reported per item, nothing registered.
    expect(status).toBe(207);
    expect(json.failed[0]).toMatchObject({ itemId: "i1", status: 400 });
    expect(json.imported).toHaveLength(0);
  });

  it("caps an import at 100 items", async () => {
    const items = Array.from({ length: 101 }, (_, i) => uploaded(i));
    const { status } = await post("/media/review/import", { sessionId: "sess1", items });
    expect(status).toBe(413);
  });

  it("bins the session's review thumbnails afterwards", async () => {
    await post("/media/review/import", { sessionId: "sess9", items: [uploaded(1)] });
    expect(deletePrefix).toHaveBeenCalledWith(`athletes/${athleteId}/review/sess9/`);
  });
});

describe("the content gate on registration", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    gcsPath: `athletes/${athleteId}/uploads/u1.jpg`, contentType: "image/jpeg", ...over,
  });

  it("refuses blocked content, deletes the bytes and registers nothing", async () => {
    mockModerate.mockResolvedValue({ blocked: true, categories: ["adult", "racy"], scores: null });

    const { status, json } = await post("/media", body());

    expect(status).toBe(422);
    expect(json.error).toBe("content_rejected");
    expect(json.categories).toEqual(["adult", "racy"]);
    expect(deleteObject).toHaveBeenCalledWith(`athletes/${athleteId}/uploads/u1.jpg`);
    expect(await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId))).toHaveLength(0);
  });

  it("blocks the same content coming in through the camera-roll import", async () => {
    mockModerate.mockResolvedValue({ blocked: true, categories: ["adult"], scores: null });
    const { json } = await post("/media/review/import", {
      sessionId: "sess1",
      items: [{ itemId: "i1", uploadedGcsPath: `athletes/${athleteId}/uploads/u1.jpg`, contentType: "image/jpeg" }],
    });
    expect(json.imported).toHaveLength(0);
    expect(json.failed[0]).toMatchObject({ status: 422, error: "content_rejected" });
  });

  it("FAILS OPEN for an ordinary upload when SafeSearch is down — and says so on the row", async () => {
    // The deliberate asymmetry: this photo was chosen one at a time, deliberately. A Vision outage
    // must not stop an athlete adding her own picture to her own library — but the row must carry
    // the fact that the check did not run, rather than looking like a pass.
    mockModerate.mockResolvedValue({ blocked: false, categories: [], scores: null, error: "503 backend" });

    const { status } = await post("/media", body());

    expect(status).toBe(201);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect((row.metadata as any).moderation).toEqual({ error: "503 backend" });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("does not pretend to have screened a video", async () => {
    const { status } = await post("/media", body({ gcsPath: `athletes/${athleteId}/uploads/u1.mp4`, contentType: "video/mp4" }));
    expect(status).toBe(201);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect((row.metadata as any).moderation).toEqual({ skipped: "video" });
    expect(mockModerate).not.toHaveBeenCalled();
  });

  it("takes a capture date on the ordinary upload path too", async () => {
    const shotOn = "2025-12-24T08:00:00.000Z";
    await post("/media", body({ createdAt: shotOn }));
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
    expect(row.posted_at?.toISOString()).toBe(shotOn);
  });
});
