/**
 * videoEnrichment.intake.test.ts — CAMERA_ROLL_INTAKE's clip read: a clip she imported through a camera-roll review
 * gets its FULL read (what happens and when, a transcript, quality signals) even with the Studio clip lane off — and
 * then ONLY such clips are read, under a daily cap that is never absent.
 *
 *   L1 enrichVideoChunk({ onlyIntake }) reads her imported clip and leaves every other clip alone
 *   L2 the shared worker (services/mediaEnrichment.ts) runs the lane intake-only when the Studio lane is off, with the
 *      intake's cap when STUDIO_ENRICH_DAILY_CAP_USD is unset, and full for intake rows; flags off: no lane at all
 *
 * No model, no ffmpeg, no GCS: the transport, bytes, probe and signals seams stand in.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaStore", () => ({ readObject: jest.fn(), signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));
jest.mock("../../lib/models", () => ({
  genai: () => ({ models: { generateContent: jest.fn() } }),
  GEMINI: { flash: "registry-flash", flashLite: "registry-flash-lite", pro: "registry-pro" },
}));

import { eq } from "drizzle-orm";
import { mediaAssets } from "../../../shared/schema";
import * as pglite from "../../testUtils/pgliteDb";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { enrichVideoChunk } from "./videoEnrichment";
import { isIntakeRow } from "../../lib/cameraRollIntake";
import type { VideoTagTransport } from "./videoTag";

let athleteId: string;
const prompts: string[] = [];
const ANSWER = JSON.stringify({
  subject: "the_athlete", athlete_prominence: 0.9, shot_type: "action", description: "a clip", brands_visible: [], aesthetic_quality: 0.8,
  brand_safe: true, content_flags: {}, setting: "s", attire: "a", vibe: "v", hero_suitability: 0.8, disposition: "as_is", edit_note: "", reason: "r",
  beats: [{ start_s: 0, end_s: 3, description: "a", shot_type: "action", athlete_present: true, athlete_prominence: 0.9, setting: "s", attire: "a", vibe: "v", brands_visible: [], aesthetic_quality: 0.8, camera: "c", motion: "m", hero_suitability: 0.8 }],
  speech: { has_speech: true, language: "en", music_present: false, transcript: [{ start_s: 0, end_s: 1, text: "ready" }] },
});
const transport: VideoTagTransport = async (_b, _m, prompt) => { prompts.push(prompt ?? ""); return { text: ANSWER, usage: { inputTokens: 100, outputTokens: 50 }, model: "registry-flash" }; };

async function clipRow(metadata: Record<string, unknown>) {
  const [r] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "VIDEO", status: "stored",
    gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mp4`, gcs_thumb_path: `athletes/${athleteId}/uploads/p.jpg`,
    content_type: "video/mp4", bytes: 1000, duration_seconds_precise: 3, metadata, ingested_at: new Date(),
  } as never).returning({ id: mediaAssets.id });
  return r.id;
}
const metaOf = async (id: string) => ((await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0].metadata as any);

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Intake Lane Athlete"); });
afterAll(async () => { await closeTestDb(); });
beforeEach(async () => { await db.delete(mediaAssets); prompts.length = 0; });

it("L1: reads her imported clip in full, and leaves every other clip alone", async () => {
  const imported = await clipRow({ vision: { description: "frame" }, review: { sessionId: "s1", kind: "video" } });
  const other = await clipRow({ vision: { description: "frame" } });
  const r = await enrichVideoChunk({
    athleteId, onlyIntake: true, full: (c) => isIntakeRow(c.metadata), dailyCapUsd: 2,
    transport, loadBytes: async () => Buffer.from("b"), statBytes: async () => null, probeContainer: async () => null,
    measureSignals: async () => ({ version: 1, fps: 30, vfr: false, slow_motion: false, width: 1, height: 1, codec: "h264", bitrate_kbps: 1, has_audio: true, loudness_lufs: -14, silence: [], blur_mean: 1, freezes: [], black: [], at: "t" }),
  });
  expect(r).toMatchObject({ total: 1, tagged: 1 });
  expect(prompts[0]).toContain("SPEECH");
  const m = await metaOf(imported);
  expect(m.vision.speech.transcript).toEqual([{ start_s: 0, end_s: 1, text: "ready" }]);
  expect(m.signals.fps).toBe(30);
  expect((await metaOf(other)).vision.beats).toBeUndefined();
});

describe("L2: the shared worker's lane", () => {
  const KEYS = ["CAMERA_ROLL_INTAKE", "STUDIO_VIDEO_ENRICH", "STUDIO_ALL_ON", "STUDIO_ENRICH_DAILY_CAP_USD", "MEDIA_VIDEO_FIXES"];
  let calls: any[] = [];
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    calls = [];
    jest.resetModules();
    // The SAME initialised in-memory database, not a fresh module instance of it.
    jest.doMock("../../db", () => pglite);
    jest.doMock("./videoEnrichment", () => ({
      enrichVideoChunk: jest.fn(async (o: unknown) => { calls.push(o); return { total: 0, tagged: 0, failed: 0, abandoned: 0, raced: 0, remaining: 0 }; }),
    }));
  });
  afterAll(() => { for (const k of KEYS) delete process.env[k]; });

  const pass = async () => {
    const { enrichNextChunk } = await import("../../services/mediaEnrichment");
    await enrichNextChunk({ athleteId });
  };

  it("intake on, Studio lane off: intake-only, with the intake's cap, full for intake rows", async () => {
    process.env.CAMERA_ROLL_INTAKE = "true";
    await pass();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ athleteId, onlyIntake: true, dailyCapUsd: 2 });
    expect(calls[0].full({ metadata: { review: { sessionId: "s" } } })).toBe(true);
    expect(calls[0].full({ metadata: {} })).toBe(false);
  });

  it("a configured daily cap wins over the intake's", async () => {
    process.env.CAMERA_ROLL_INTAKE = "true";
    process.env.STUDIO_ENRICH_DAILY_CAP_USD = "5";
    await pass();
    expect(calls[0]).toMatchObject({ onlyIntake: true, dailyCapUsd: 5 });
  });

  it("Studio lane on: the whole lane as before (no intake-only narrowing)", async () => {
    process.env.CAMERA_ROLL_INTAKE = "true";
    process.env.STUDIO_VIDEO_ENRICH = "true";
    await pass();
    expect(calls[0].onlyIntake).toBeUndefined();
  });

  it("both off: no clip lane at all", async () => {
    await pass();
    expect(calls).toHaveLength(0);
  });

  it("intake off, Studio lane on: exactly the call it always made", async () => {
    process.env.STUDIO_VIDEO_ENRICH = "true";
    await pass();
    expect(calls[0]).toEqual({ athleteId });
  });
});
