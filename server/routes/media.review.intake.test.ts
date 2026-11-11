/**
 * "Review my camera roll" under CAMERA_ROLL_INTAKE — the three endpoints and Discard, end to end against PGlite.
 *
 * Held here, in order of how badly they'd hurt if they broke silently:
 *
 *  1. CARRY-OVER IS THE SERVER'S OWN RECORD. Import carries a ticked item's tags and embedding from what the review
 *     scored (media_review_items) — never from anything the phone sends back, never across sessions or athletes — so
 *     the enrichment worker finds both present and does not pay for them a second time.
 *  2. NOTHING ABOUT WHAT SHE DIDN'T PICK STAYS. Import and Discard scrub the session's rows (and Discard deletes the
 *     previews now, not in a day).
 *  3. THE DAILY CAP, counted on the server's record, with a message she can act on.
 *  4. Videos: a phone-made frame is scored like a photo; the imported clip keeps the "skipped: video" marker so the
 *     server still checks its own poster (the preview verdict is only a record).
 *  5. A targeted review leans the ranking toward what it looks for (words, or what a post needs).
 *  6. OFF IS OFF: no rows, no extra fields, Discard is 404.
 *
 * GCS, Gemini, Vertex and SafeSearch are mocked — the point is the wiring, not the models.
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
    deletePrefix:    jest.fn(async () => 3),
  };
});
jest.mock("../services/mediaEnrichment", () => ({ enrichNextChunk: jest.fn(async () => {}) }));
jest.mock("../studio/orient", () => ({ normalizeStoredImage: jest.fn(async () => null) }));
jest.mock("../studio/video/probe", () => ({ probeDurationSeconds: jest.fn(async () => 9.5) }));
jest.mock("../lib/visionTag", () => {
  const actual = jest.requireActual("../lib/visionTag");
  return { ...actual, tagAsset: jest.fn() };
});
jest.mock("../lib/mediaEmbed", () => ({ embedImageGcs: jest.fn(), embedText: jest.fn() }));
jest.mock("../lib/moderation", () => ({ moderateGcsImage: jest.fn() }));
jest.mock("../agent/postKit/deps", () => ({ dbPostKitDeps: () => ({ store: {}, preferences: async () => [] }) }));
jest.mock("../agent/postKit/intake", () => ({ postNeeds: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import mediaRouter from "./media";
import { mediaAssets, mediaReviewItems } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { deletePrefix } from "../lib/mediaStore";
import { tagAsset, type AssetTags } from "../lib/visionTag";
import { embedImageGcs, embedText } from "../lib/mediaEmbed";
import { moderateGcsImage } from "../lib/moderation";
import { postNeeds } from "../agent/postKit/intake";

const mockTag = tagAsset as jest.MockedFunction<typeof tagAsset>;
const mockEmbed = embedImageGcs as jest.MockedFunction<typeof embedImageGcs>;
const mockEmbedText = embedText as jest.MockedFunction<typeof embedText>;
const mockModerate = moderateGcsImage as jest.MockedFunction<typeof moderateGcsImage>;
const mockNeeds = postNeeds as jest.MockedFunction<typeof postNeeds>;

let server: Server;
let base: string;
let athleteId: string;
let otherAthleteId: string;

const asUser = (id: string) => { (globalThis as any).__TEST_ATHLETE_ID = id; };
async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const CLEAN = { blocked: false, categories: [] as string[], scores: { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" } } as const;
const tags = (over: Partial<AssetTags> = {}): AssetTags => ({
  athlete_present: true, athlete_prominence: 0.8, shot_type: "portrait", description: "on court", brands_visible: [],
  aesthetic_quality: 0.8, brand_safe: true, setting: "gym", attire: "kit", vibe: "focused", hero_suitability: 0.8,
  disposition: "as_is", edit_note: "", reason: "Looks great.", ...over,
} as AssetTags);

const item = (n: number, kind: "photo" | "video" = "photo", session = "sess1", athlete = athleteId) => ({
  itemId: `i${n}`, gcsPath: `athletes/${athlete}/review/${session}/i${n}.review.jpg`, width: 512, height: 512, kind,
});
const original = (n: number, contentType = "image/jpeg", athlete = athleteId) => ({
  itemId: `i${n}`, uploadedGcsPath: `athletes/${athlete}/uploads/u${n}.${contentType.startsWith("video") ? "mp4" : "jpg"}`, contentType, width: 1080, height: 1920,
});
const rowsFor = (athlete: string) => db.select().from(mediaReviewItems).where(eq(mediaReviewItems.athlete_id, athlete));

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
  delete process.env.CAMERA_ROLL_INTAKE;
  delete process.env.CAMERA_ROLL_INTAKE_DAILY_PREVIEWS;
});
beforeEach(async () => {
  jest.clearAllMocks();
  process.env.CAMERA_ROLL_INTAKE = "true";
  delete process.env.CAMERA_ROLL_INTAKE_DAILY_PREVIEWS;
  athleteId = await seedAthlete();
  otherAthleteId = await seedAthlete();
  asUser(athleteId);
  mockTag.mockImplementation(async (p: string) => tags({ description: `scene ${p.match(/i(\d+)\./)?.[1]}` }));
  mockEmbed.mockImplementation(async (p: string) => (p.includes("i2.") ? [0, 1, 0] : [1, 0, 0]));
  mockEmbedText.mockResolvedValue(null);
  mockModerate.mockResolvedValue({ ...CLEAN, categories: [], scores: { ...CLEAN.scores } });
});

describe("the review", () => {
  it("scores photos and videos alike; every entry carries its kind and a short description; the server records each", async () => {
    const { status, json } = await post("/media/review", { sessionId: "sess1", items: [item(1), item(2, "video")] });
    expect(status).toBe(200);
    const byId = new Map(json.keep.map((k: any) => [k.itemId, k]));
    expect(byId.get("i2")).toMatchObject({ kind: "video", summary: { shotType: "portrait", setting: "gym", doing: "scene 2", quality: "great" }, fit: null });
    expect(byId.get("i1")).toMatchObject({ kind: "photo" });
    expect(json.daily).toEqual({ limit: 600, used: 2 });
    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => [r.item_id, r.kind, Array.isArray(r.embedding)]).sort()).toEqual([["i1", "photo", true], ["i2", "video", true]]);
  });

  it("a kind it doesn't know is refused, saying which kinds it takes", async () => {
    const { status, json } = await post("/media/review", { sessionId: "sess1", items: [{ ...item(1), kind: "gif" }] });
    expect(status).toBe(400);
    expect(json.error).toMatch(/photo, video/);
  });

  it("the day's cap: refused before anything is scored, with a line she can act on", async () => {
    process.env.CAMERA_ROLL_INTAKE_DAILY_PREVIEWS = "3";
    expect((await post("/media/review", { sessionId: "s1", items: [item(1, "photo", "s1"), item(2, "photo", "s1")] })).status).toBe(200);
    mockTag.mockClear();
    const { status, json } = await post("/media/review", { sessionId: "s2", items: [item(3, "photo", "s2"), item(4, "photo", "s2")] });
    expect(status).toBe(429);
    expect(json).toMatchObject({ code: "daily_limit", limit: 3, used: 2 });
    expect(json.error).toMatch(/tomorrow/);
    expect(mockTag).not.toHaveBeenCalled();
  });

  it("a targeted review leans toward what it looks for (her words)", async () => {
    // i1 is the better photo; i2 matches the words exactly.
    mockTag.mockImplementation(async (p: string) => (p.includes("i1.") ? tags({ hero_suitability: 0.95, aesthetic_quality: 0.95 }) : tags({ hero_suitability: 0.6, aesthetic_quality: 0.6 })));
    mockEmbedText.mockResolvedValue([0, 1, 0]);
    const untargeted = await post("/media/review", { sessionId: "a", items: [item(1, "photo", "a"), item(2, "photo", "a")] });
    expect(untargeted.json.keep.map((k: any) => k.itemId)).toEqual(["i1", "i2"]);
    const targeted = await post("/media/review", { sessionId: "b", items: [item(1, "photo", "b"), item(2, "photo", "b")], target: { lookingFor: "a clip of the warm-up" } });
    expect(targeted.json.keep.map((k: any) => k.itemId)).toEqual(["i2", "i1"]);
    expect(targeted.json.lookingFor).toBe("a clip of the warm-up");
    expect(targeted.json.keep[0].reason).toMatch(/^Close to what you're looking for/);
    expect(mockEmbedText).toHaveBeenCalledWith("a clip of the warm-up");
  });

  it("for a post: what the post needs is read off the post itself", async () => {
    mockNeeds.mockResolvedValue({ lookingFor: "a short clip of the warm-up", kind: "videos" });
    mockEmbedText.mockResolvedValue([1, 0, 0]);
    const { json } = await post("/media/review", { sessionId: "p", items: [item(1, "video", "p")], target: { forPost: "post-1", lookingFor: "ignored when the post answers" } });
    expect(mockNeeds).toHaveBeenCalledWith(expect.anything(), expect.any(Function), athleteId, "post-1");
    expect(json.lookingFor).toBe("a short clip of the warm-up");
  });
});

describe("import carries what the review paid for — from the server's record only", () => {
  it("a ticked photo arrives tagged and embedded (no second charge); the session's rows are scrubbed", async () => {
    await post("/media/review", { sessionId: "sess1", items: [item(1), item(2)] });
    const { status, json } = await post("/media/review/import", {
      sessionId: "sess1", items: [{ ...original(1), rank: 0.9, reason: "Looks great.",
        // Anything the phone sends back as tags is ignored:
        tags: { athlete_present: false }, vision: { description: "forged" }, embedding: [9, 9, 9] }],
    });
    expect(status).toBe(201);
    expect(json.imported).toHaveLength(1);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.gcs_path, original(1).uploadedGcsPath));
    const m = row.metadata as any;
    expect(m.vision).toMatchObject({ description: "scene 1", athlete_present: true });
    expect(m.embedding).toEqual([1, 0, 0]);
    expect(m.vision_from).toBe("review_preview");
    expect(m.review).toMatchObject({ sessionId: "sess1", kind: "photo", rank: 0.9 });
    const rows = await rowsFor(athleteId);
    expect(rows.every((r) => r.tags === null && r.embedding === null && r.scrubbed_at !== null)).toBe(true);
    expect(rows).toHaveLength(2);   // still counted for the day
  });

  it("a ticked clip: tagged from its frame, and the server still checks its own poster (the preview verdict is a record)", async () => {
    await post("/media/review", { sessionId: "sess1", items: [item(1, "video")] });
    const { status } = await post("/media/review/import", { sessionId: "sess1", items: [{ ...original(1, "video/mp4"), durationSeconds: 9.4 }] });
    expect(status).toBe(201);
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.gcs_path, original(1, "video/mp4").uploadedGcsPath));
    const m = row.metadata as any;
    expect(row.media_type).toBe("VIDEO");
    expect(row.duration_seconds_precise).toBe(9.5);   // measured, not asserted
    expect(m.moderation).toEqual({ skipped: "video" });
    expect(m.review).toMatchObject({ kind: "video", previewModeration: { ...CLEAN.scores } });
    expect(m.vision).toMatchObject({ description: "scene 1" });
  });

  it("another session's or another athlete's scores are never carried", async () => {
    await post("/media/review", { sessionId: "other", items: [item(1, "photo", "other")] });
    asUser(otherAthleteId);
    await post("/media/review", { sessionId: "sess1", items: [item(1, "photo", "sess1", otherAthleteId)] });
    asUser(athleteId);
    await post("/media/review/import", { sessionId: "sess1", items: [original(1)] });
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.gcs_path, original(1).uploadedGcsPath));
    expect((row.metadata as any).vision).toBeUndefined();
    expect((row.metadata as any).embedding).toBeUndefined();
    // The other athlete's row is untouched by this import.
    const theirs = await rowsFor(otherAthleteId);
    expect(theirs[0].tags).not.toBeNull();
  });
});

describe("discard", () => {
  it("deletes the previews now and scrubs the scores", async () => {
    await post("/media/review", { sessionId: "sess1", items: [item(1)] });
    const { status, json } = await post("/media/review/discard", { sessionId: "sess1" });
    expect(status).toBe(200);
    expect(json).toEqual({ deleted: 3, scrubbed: 1 });
    expect(deletePrefix).toHaveBeenCalledWith(`athletes/${athleteId}/review/sess1/`);
    expect((await rowsFor(athleteId))[0].tags).toBeNull();
  });

  it("scrubs only her own session", async () => {
    asUser(otherAthleteId);
    await post("/media/review", { sessionId: "sess1", items: [item(1, "photo", "sess1", otherAthleteId)] });
    asUser(athleteId);
    await post("/media/review/discard", { sessionId: "sess1" });
    expect((await rowsFor(otherAthleteId))[0].tags).not.toBeNull();
  });
});

describe("old rows are purged", () => {
  it("a review call deletes her rows past the purge window", async () => {
    await db.insert(mediaReviewItems).values({ athlete_id: athleteId, session_id: "old", item_id: "i9", kind: "photo", created_at: new Date(Date.now() - 49 * 3_600_000) } as never);
    await post("/media/review", { sessionId: "new", items: [item(1, "photo", "new")] });
    const rows = await rowsFor(athleteId);
    expect(rows.map((r) => r.session_id)).toEqual(["new"]);
  });
});

describe("off is off", () => {
  beforeEach(() => { delete process.env.CAMERA_ROLL_INTAKE; });

  it("the review records nothing and answers as before; import carries nothing; discard is 404", async () => {
    const { json } = await post("/media/review", { sessionId: "sess1", items: [item(1)] });
    expect(json.daily).toBeUndefined();
    expect(Object.keys(json.keep[0]).sort()).toEqual(["itemId", "rank", "reason", "tags"]);
    expect(await rowsFor(athleteId)).toEqual([]);
    await post("/media/review/import", { sessionId: "sess1", items: [original(1)] });
    const [row] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.gcs_path, original(1).uploadedGcsPath)));
    expect((row.metadata as any).vision).toBeUndefined();
    expect((await post("/media/review/discard", { sessionId: "sess1" })).status).toBe(404);
  });
});
