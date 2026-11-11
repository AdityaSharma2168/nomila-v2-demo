/**
 * videoPoster.master.test.ts — the poster worker under MEDIA_VIDEO_FIXES (media-intake plan fixes 3 and 6).
 *
 *   ONE MASTER. H.264 at 1080p or less is kept as it is (no re-encode, nothing deleted). Anything else is re-encoded
 *   with its SHORT side capped at 1080, the original is PARKED (metadata.original_pending_delete, 30 days) rather than
 *   deleted on the spot, original_gcs_path is never written, and the camera's provenance is read off the original first
 *   and kept. purgeExpiredOriginals deletes a parked original only once its window has passed.
 *   THE POSTER IS THE CONTENT CHECK. An uploaded clip still marked { skipped: "video" } is SafeSearched on its poster:
 *   blocked → out of her library (deleted_at) and its bytes deleted; clean → the verdict replaces the marker; her
 *   synced posts are never checked here. An outage fails open.
 *   OFF: the existing suite (videoPoster.test.ts) holds the old behaviour byte for byte.
 *
 * ffmpeg/ffprobe, GCS and SafeSearch are mocked — nothing here runs a tool or reaches a provider.
 *
 * ⚠️ MUTATIONS: re-encode a kept master — "H.264 at 720×1280 is the master" reds; delete the original on the spot — "HEVC
 * is re-encoded and the original parked" reds; purge before the window — "a parked original inside its window" reds; moderate a connected row — "her synced clips are not checked" reds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}?sig=secret`),
  uploadLocalFile: jest.fn(async () => {}),
  deleteObject: jest.fn(async () => {}),
  removeObject: jest.fn(async () => true),
}));
jest.mock("../lib/moderation", () => ({ moderateGcsImage: jest.fn() }));
jest.mock("../studio/video/probe", () => ({ probeDurationSeconds: jest.fn(async () => 6) }));
jest.mock("child_process", () => ({ execFile: jest.fn() }));
jest.mock("fs/promises", () => ({ stat: jest.fn(async () => ({ size: 4096 })), unlink: jest.fn(async () => {}) }));
jest.mock("./mediaEnrichment", () => ({ enrichNextChunk: jest.fn(async () => ({ total: 0, remaining: 0 })) }));

import { execFile } from "child_process";
import { eq } from "drizzle-orm";
import { keepAsMaster, MASTER_SCALE, processOneVideo, purgeExpiredOriginals, sourceShape } from "./videoPoster";
import { mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { deleteObject, removeObject } from "../lib/mediaStore";
import { moderateGcsImage } from "../lib/moderation";

const execFileMock = execFile as unknown as jest.Mock;
const moderate = moderateGcsImage as jest.MockedFunction<typeof moderateGcsImage>;
const del = deleteObject as jest.MockedFunction<typeof deleteObject>;
const remove = removeObject as jest.MockedFunction<typeof removeObject>;

let athleteId: string;
let ffmpegCalls: string[][] = [];

/** The container the source probe reports: the phone's atoms ride on format.tags. */
function source(codec: string, width: number, height: number) {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    if (cmd === "ffprobe") {
      cb(null, { stdout: JSON.stringify({
        format: { tags: { "com.apple.quicktime.make": "PhoneMaker", creation_time: "2026-10-01T10:00:00Z" } },
        streams: [{ codec_type: "video", codec_name: codec, width, height }, { codec_type: "audio" }],
      }), stderr: "" });
      return;
    }
    ffmpegCalls.push(args);
    cb(null, { stdout: "", stderr: "" });
  });
}

async function seed(over: Record<string, unknown> = {}) {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "VIDEO", status: "stored",
    gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mov`, content_type: "video/quicktime",
    gcs_thumb_path: null, metadata: { moderation: { skipped: "video" } }, ingested_at: new Date(), ...over,
  } as never).returning();
  return row;
}
const after = async (id: string) => (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0] as any;
const CLEAN = { blocked: false, categories: [], scores: { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" } } as const;

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); delete process.env.MEDIA_VIDEO_FIXES; });
beforeEach(async () => {
  await db.delete(mediaAssets);
  athleteId = await seedAthlete("Master Tester");
  jest.clearAllMocks();
  ffmpegCalls = [];
  process.env.MEDIA_VIDEO_FIXES = "true";
  moderate.mockResolvedValue({ ...CLEAN, categories: [], scores: { ...CLEAN.scores } });
});

describe("the pure rules", () => {
  it("the master is H.264 with a known short side of 1080 or less — a portrait phone clip included", () => {
    expect(keepAsMaster({ codec: "h264", width: 1080, height: 1920 })).toBe(true);
    expect(keepAsMaster({ codec: "h264", width: 720, height: 1280 })).toBe(true);
    expect(keepAsMaster({ codec: "h264", width: 2160, height: 3840 })).toBe(false);
    expect(keepAsMaster({ codec: "hevc", width: 1080, height: 1920 })).toBe(false);
    expect(keepAsMaster({ codec: "h264", width: null, height: null })).toBe(false);
  });

  it("the scale caps the SHORT side, never upscales, and keeps both sides even", () => {
    expect(MASTER_SCALE).toContain("min(iw,1080)");
    expect(MASTER_SCALE).toContain("min(ih,1080)");
    expect(MASTER_SCALE).toContain("trunc(");
  });

  it("the source shape comes off the video stream; no probe is all nulls", () => {
    expect(sourceShape({ streams: [{ codec_type: "audio" }, { codec_type: "video", codec_name: "h264", width: 720, height: 1280 } as never] }))
      .toEqual({ codec: "h264", width: 720, height: 1280 });
    expect(sourceShape(null)).toEqual({ codec: null, width: null, height: null });
  });
});

describe("one master", () => {
  it("H.264 at 720×1280 is the master: postered, no re-encode, nothing deleted, no original_gcs_path", async () => {
    source("h264", 720, 1280);
    const row = await seed({ content_type: "video/mp4" });
    expect(await processOneVideo(row as never)).toBe("postered");
    expect(ffmpegCalls.some((a) => a.includes("libx264"))).toBe(false);
    expect(del).not.toHaveBeenCalled();
    const a = await after(row.id);
    expect(a.gcs_path).toBe(row.gcs_path);
    expect(a.gcs_thumb_path).toBe(`athletes/${athleteId}/uploads/${row.id}-poster.jpg`);
    expect(a.metadata.original_gcs_path).toBeUndefined();
  });

  it("HEVC 4K is re-encoded with the short-side scale, the original parked for 30 days, and the camera's provenance kept", async () => {
    source("hevc", 2160, 3840);
    const row = await seed();
    const t0 = Date.now();
    expect(await processOneVideo(row as never)).toBe("transcoded");
    const transcode = ffmpegCalls.find((a) => a.includes("libx264"))!;
    expect(transcode[transcode.indexOf("-vf") + 1]).toBe(MASTER_SCALE);
    const a = await after(row.id);
    expect(a.gcs_path).toBe(`athletes/${athleteId}/uploads/${row.id}-1080.mp4`);
    expect(a.content_type).toBe("video/mp4");
    expect(a.metadata.original_gcs_path).toBeUndefined();
    expect(a.metadata.provenance_signal.signal).toBe("device-camera");
    // Parked, not deleted: the undo window.
    expect(del).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(a.metadata.original_pending_delete.path).toBe(row.gcs_path);
    const after30 = Date.parse(a.metadata.original_pending_delete.delete_after) - t0;
    expect(after30).toBeGreaterThanOrEqual(30 * 86_400_000 - 5_000);
    expect(after30).toBeLessThanOrEqual(30 * 86_400_000 + 60_000);
  });

  it("a generated clip keeps no provenance (ground truth already) but is still one master", async () => {
    source("hevc", 1920, 1080);
    const row = await seed({ origin: "generated", platform: "studio", metadata: {} });
    expect(await processOneVideo(row as never)).toBe("transcoded");
    const a = await after(row.id);
    expect(a.metadata.provenance_signal).toBeUndefined();
    expect(a.metadata.original_pending_delete.path).toBe(row.gcs_path);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("the undo window", () => {
  const park = (path: string, deleteAfter: Date) => ({ moderation: { on: "poster" }, original_pending_delete: { path, delete_after: deleteAfter.toISOString() } });
  const NOW = new Date("2026-11-20T12:00:00Z");

  it("a parked original inside its window is kept", async () => {
    const row = await seed({ gcs_thumb_path: "t.jpg", metadata: park(`athletes/${athleteId}/uploads/orig.mov`, new Date("2026-11-21T00:00:00Z")) });
    expect(await purgeExpiredOriginals(20, NOW)).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect((await after(row.id)).metadata.original_pending_delete).toBeDefined();
  });

  it("past its window: the bytes go, then the record", async () => {
    const orig = `athletes/${athleteId}/uploads/orig.mov`;
    const row = await seed({ gcs_thumb_path: "t.jpg", metadata: park(orig, new Date("2026-11-19T00:00:00Z")) });
    expect(await purgeExpiredOriginals(20, NOW)).toBe(1);
    expect(remove).toHaveBeenCalledWith(orig);
    const a = await after(row.id);
    expect(a.metadata.original_pending_delete).toBeUndefined();
    expect(a.metadata.moderation).toEqual({ on: "poster" });
  });

  it("a delete that fails keeps the record for the next tick", async () => {
    remove.mockResolvedValueOnce(false);
    const row = await seed({ gcs_thumb_path: "t.jpg", metadata: park(`athletes/${athleteId}/uploads/orig.mov`, new Date("2026-11-19T00:00:00Z")) });
    expect(await purgeExpiredOriginals(20, NOW)).toBe(0);
    expect((await after(row.id)).metadata.original_pending_delete).toBeDefined();
  });

  it("never deletes the live file, or a path outside the row's own athlete — only forgets it", async () => {
    const live = await seed({ gcs_thumb_path: "t.jpg" });
    await db.update(mediaAssets).set({ metadata: park(live.gcs_path!, new Date("2026-11-19T00:00:00Z")) } as never).where(eq(mediaAssets.id, live.id));
    const foreign = await seed({ gcs_thumb_path: "t2.jpg", metadata: park("athletes/someone-else/uploads/x.mov", new Date("2026-11-19T00:00:00Z")) });
    expect(await purgeExpiredOriginals(20, NOW)).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect((await after(live.id)).metadata.original_pending_delete).toBeUndefined();
    expect((await after(foreign.id)).metadata.original_pending_delete).toBeUndefined();
  });
});

describe("the poster is the content check", () => {
  it("blocked: out of her library (deleted_at) and both objects deleted", async () => {
    source("h264", 720, 1280);
    moderate.mockResolvedValue({ blocked: true, categories: ["adult"], scores: { ...CLEAN.scores, adult: "LIKELY" } });
    const row = await seed();
    expect(await processOneVideo(row as never)).toBe("blocked");
    const a = await after(row.id);
    expect(a.deleted_at).not.toBeNull();
    expect(a.metadata.moderation).toMatchObject({ blocked: true, categories: ["adult"], on: "poster" });
    expect(del).toHaveBeenCalledWith(row.gcs_path);
    expect(del).toHaveBeenCalledWith(`athletes/${athleteId}/uploads/${row.id}-poster.jpg`);
  });

  it("clean: the verdict replaces the 'skipped' marker", async () => {
    source("h264", 720, 1280);
    const row = await seed();
    await processOneVideo(row as never);
    expect((await after(row.id)).metadata.moderation).toEqual({ ...CLEAN.scores, on: "poster" });
  });

  it("an outage fails open: the clip stays, the row says the check could not run", async () => {
    source("h264", 720, 1280);
    moderate.mockResolvedValue({ blocked: false, categories: [], scores: null, error: "vision down" });
    const row = await seed();
    expect(await processOneVideo(row as never)).toBe("postered");
    const a = await after(row.id);
    expect(a.deleted_at).toBeNull();
    expect(a.metadata.moderation).toEqual({ error: "vision down", on: "poster" });
  });

  it("her synced clips are not checked here", async () => {
    source("h264", 720, 1280);
    const row = await seed({ origin: "connected", platform: "instagram" });
    await processOneVideo(row as never);
    expect(moderate).not.toHaveBeenCalled();
  });

  it("flag off: no check, and the old transcode keeps the original", async () => {
    delete process.env.MEDIA_VIDEO_FIXES;
    source("h264", 720, 1280);
    const row = await seed();
    expect(await processOneVideo(row as never)).toBe("transcoded");
    expect(moderate).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect((await after(row.id)).metadata.original_gcs_path).toBe(row.gcs_path);
  });
});
