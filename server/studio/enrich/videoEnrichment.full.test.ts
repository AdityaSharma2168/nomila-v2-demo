/**
 * videoEnrichment.full.test.ts — the full clip read's wiring (MEDIA_VIDEO_FIXES, media-intake plan fix 2): with the
 * flag on, a clip that is read sends the full prompt, keeps what is said (vision.speech) and gets its $0 signals
 * (metadata.signals) off the SAME bytes; a signal pass that fails never moves the read's outcome; off, the read is
 * exactly what it was. And one master: a clip whose provenance the poster worker kept is not re-probed.
 *
 * Harness: videoEnrichment.test.ts's seams (transport, bytes, container probe), plus the signals seam — no model, no
 * ffmpeg, no GCS.
 *
 * ⚠️ MUTATIONS: drop `if (full) await recordSignals` — "a clip read under the flag gets its signals" reds; drop the
 * provenance-reuse branch — "a kept provenance is not re-probed" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaStore", () => ({
  readObject: jest.fn(),
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
}));
jest.mock("../../lib/models", () => ({
  genai: () => ({ models: { generateContent: jest.fn() } }),
  GEMINI: { flash: "registry-flash", flashLite: "registry-flash-lite", pro: "registry-pro" },
}));

import { eq } from "drizzle-orm";
import { mediaAssets } from "../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { enrichVideoChunk } from "./videoEnrichment";
import type { VideoTagTransport } from "./videoTag";
import type { ClipSignals } from "../video/signals";

let athleteId: string;

const ANSWER = {
  subject: "the_athlete", athlete_prominence: 0.9, shot_type: "action", description: "a clip", brands_visible: [],
  aesthetic_quality: 0.8, brand_safe: true, content_flags: {}, setting: "track", attire: "kit", vibe: "fast",
  hero_suitability: 0.8, disposition: "as_is", edit_note: "", reason: "r",
  beats: [{ start_s: 0, end_s: 4, description: "a", shot_type: "action", athlete_present: true, athlete_prominence: 0.9,
    setting: "s", attire: "a", vibe: "v", brands_visible: [], aesthetic_quality: 0.8, camera: "c", motion: "m",
    hero_suitability: 0.8, stability: "steady" }],
  speech: { has_speech: true, language: "en", music_present: false, transcript: [{ start_s: 0.5, end_s: 2, text: "let's go" }] },
};

const prompts: string[] = [];
const transport: VideoTagTransport = async (_b, _m, prompt) => {
  prompts.push(prompt ?? "");
  return { text: JSON.stringify(ANSWER), usage: { inputTokens: 1000, outputTokens: 500 }, model: "registry-flash" };
};
const SIGNALS: ClipSignals = {
  version: 1, fps: 30, vfr: false, slow_motion: false, width: 720, height: 1280, codec: "h264", bitrate_kbps: 2000,
  has_audio: true, loudness_lufs: -16, silence: [], blur_mean: 2.1, freezes: [], black: [], at: "2026-10-12T00:00:00.000Z",
};

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Full Read Athlete");
});
afterAll(async () => { await closeTestDb(); });
beforeEach(async () => {
  await db.delete(mediaAssets);
  prompts.length = 0;
  delete process.env.MEDIA_VIDEO_FIXES;
});
afterAll(() => { delete process.env.MEDIA_VIDEO_FIXES; });

async function readOne(opts: { measure?: () => Promise<ClipSignals>; metadata?: Record<string, unknown>; probe?: jest.Mock } = {}) {
  const [row] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "VIDEO", status: "stored",
    gcs_path: `athletes/${athleteId}/uploads/clip.mp4`, gcs_thumb_path: `athletes/${athleteId}/uploads/clip-poster.jpg`,
    content_type: "video/mp4", bytes: 1000, duration_seconds_precise: 4,
    metadata: { vision: { description: "poster" }, ...(opts.metadata ?? {}) }, ingested_at: new Date(),
  } as never).returning({ id: mediaAssets.id });
  const probe = opts.probe ?? jest.fn(async () => null);
  const r = await enrichVideoChunk({
    athleteId, transport, loadBytes: async () => Buffer.from("bytes"), statBytes: async () => null,
    probeContainer: probe, measureSignals: opts.measure ?? (async () => SIGNALS), dailyCapUsd: null,
  });
  const [after] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, row.id));
  return { outcome: r, metadata: after.metadata as any, probe };
}

it("a clip read under the flag sends the full prompt, keeps what is said, and gets its signals", async () => {
  process.env.MEDIA_VIDEO_FIXES = "true";
  const { outcome, metadata } = await readOne();
  expect(outcome).toMatchObject({ tagged: 1, failed: 0 });
  expect(prompts[0]).toContain("SPEECH");
  expect(metadata.vision.speech).toEqual(ANSWER.speech);
  expect(metadata.vision.beats[0].stability).toBe("steady");
  expect(metadata.signals).toEqual(SIGNALS);
});

it("a signal pass that throws: the read still counts as tagged, and no signals are written", async () => {
  process.env.MEDIA_VIDEO_FIXES = "true";
  const { outcome, metadata } = await readOne({ measure: async () => { throw new Error("ffmpeg gone"); } });
  expect(outcome).toMatchObject({ tagged: 1, failed: 0 });
  expect(metadata.vision.speech.transcript).toHaveLength(1);
  expect(metadata.signals).toBeUndefined();
});

it("flag off: the read is exactly what it was — the old prompt, no signals", async () => {
  const { outcome, metadata } = await readOne();
  expect(outcome).toMatchObject({ tagged: 1 });
  expect(prompts[0]).not.toContain("SPEECH");
  expect(metadata.signals).toBeUndefined();
});

it("one master: a provenance the poster worker kept is not re-probed (its original is gone)", async () => {
  process.env.MEDIA_VIDEO_FIXES = "true";
  const kept = { signal: "device-camera", evidence: { make: "Phone" }, probed_at: "2026-10-12T00:00:00.000Z" };
  const { metadata, probe } = await readOne({ metadata: { provenance_signal: kept } });
  expect(probe).not.toHaveBeenCalled();
  expect(metadata.provenance_signal).toEqual(kept);
});

it("flag off: provenance is probed as before", async () => {
  const { probe } = await readOne({ metadata: { provenance_signal: { signal: "unknown" } } });
  expect(probe).toHaveBeenCalledTimes(1);
});
