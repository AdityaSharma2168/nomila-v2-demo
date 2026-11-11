/**
 * transcriptBackfill.test.ts — the transcript backfill (CAMERA_ROLL_INTAKE): her clips read before what is said was
 * written down are read again, in FULL, by the same call an imported clip gets.
 *
 *   B1 who: her uploads and her synced Instagram mp4s with no transcript — never a generated clip, a reference, a
 *      poster-only reel, a deleted row, or a clip that already has one
 *   B2 the write keeps the read's own discipline: vision replaced (the old one under prev), speech written, signals
 *      measured; the clip lane's own record (metadata.enrichment) untouched
 *   B3 rate-limited and resumable: `chunk` clips a pass, the daily cap, and a clip that keeps failing is set down under
 *      the backfill's own key
 *   B4 off with the flag: nothing is read
 *
 * No model, no ffmpeg, no GCS: the transport, bytes, probe and signals seams stand in.
 *
 * ⚠️ MUTATION: drop the origin clause from VIDEO_NO_SPEECH — "a generated clip is never read again" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaStore", () => ({ readObject: jest.fn(), signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`) }));
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
const prompts: string[] = [];
const ANSWER = JSON.stringify({
  subject: "the_athlete", athlete_prominence: 0.9, shot_type: "action", description: "the clip again", brands_visible: [], aesthetic_quality: 0.8,
  brand_safe: true, content_flags: {}, setting: "s", attire: "a", vibe: "v", hero_suitability: 0.8, disposition: "as_is", edit_note: "", reason: "r",
  beats: [{ start_s: 0, end_s: 3, description: "a", shot_type: "action", athlete_present: true, athlete_prominence: 0.9, setting: "s", attire: "a", vibe: "v", brands_visible: [], aesthetic_quality: 0.8, camera: "c", motion: "m", hero_suitability: 0.8 }],
  speech: { has_speech: true, language: "en", music_present: true, transcript: [{ start_s: 0.5, end_s: 2, text: "here we go" }] },
});
let transportFails = false;
const transport: VideoTagTransport = async (_b, _m, prompt) => {
  prompts.push(prompt ?? "");
  if (transportFails) throw new Error("provider down");
  return { text: ANSWER, usage: { inputTokens: 100, outputTokens: 50 }, model: "registry-flash" };
};
const SIGNALS: ClipSignals = { version: 1, fps: 30, vfr: false, slow_motion: false, width: 1, height: 1, codec: "h264", bitrate_kbps: 1, has_audio: true, loudness_lufs: -14, silence: [], blur_mean: 1, freezes: [], black: [], at: "t" };

const READ = { description: "an old read", beats: [{ start_s: 0, end_s: 3 }] };
async function clip(over: Record<string, unknown> = {}) {
  const [r] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "VIDEO", status: "stored",
    gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mp4`, gcs_thumb_path: `athletes/${athleteId}/p.jpg`,
    content_type: "video/mp4", bytes: 1000, duration_seconds_precise: 3,
    metadata: { vision: READ, enrichment: { attempts: 1 } }, ingested_at: new Date(), ...over,
  } as never).returning({ id: mediaAssets.id });
  return r.id;
}
const metaOf = async (id: string) => ((await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0].metadata as any);
const pass = (over: Record<string, unknown> = {}) => enrichVideoChunk({
  athleteId, rereadForSpeech: true, dailyCapUsd: 2, transport, loadBytes: async () => Buffer.from("b"), statBytes: async () => null,
  probeContainer: async () => null, measureSignals: async () => SIGNALS, ...over,
});

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Backfill Athlete"); });
afterAll(async () => { await closeTestDb(); delete process.env.CAMERA_ROLL_INTAKE; });
beforeEach(async () => { await db.delete(mediaAssets); prompts.length = 0; transportFails = false; });

describe("B1: who", () => {
  it("her upload and her synced Instagram mp4 are read again; the rest never", async () => {
    const upload = await clip();
    const ig = await clip({ platform: "instagram", origin: "connected" });
    const generated = await clip({ platform: "studio", origin: "generated" });
    const reference = await clip({ origin: "reference" });
    const posterOnly = await clip({ platform: "instagram", origin: "connected", content_type: "image/jpeg" });
    const deleted = await clip({ deleted_at: new Date() });
    const done = await clip({ metadata: { vision: { ...READ, speech: { has_speech: false, language: "", music_present: false, transcript: [] } } } });
    const r = await pass({ chunk: 10 });
    expect(r.tagged).toBe(2);
    expect((await metaOf(upload)).vision.speech.transcript).toEqual([{ start_s: 0.5, end_s: 2, text: "here we go" }]);
    expect((await metaOf(ig)).vision.speech.has_speech).toBe(true);
    for (const id of [generated, reference, posterOnly, deleted]) expect((await metaOf(id)).vision.speech).toBeUndefined();
    expect((await metaOf(done)).vision.speech.has_speech).toBe(false);
  });
});

describe("B2: the write", () => {
  it("full read, the old read kept under prev, signals measured, the clip lane's record untouched", async () => {
    const id = await clip();
    await pass();
    const m = await metaOf(id);
    expect(prompts[0]).toContain("SPEECH");
    expect(m.vision.description).toBe("the clip again");
    expect(m.vision.prev.description).toBe("an old read");
    expect(m.signals).toEqual(SIGNALS);
    expect(m.enrichment).toEqual({ attempts: 1 });
  });
});

describe("B3: rate-limited and resumable", () => {
  it("chunk clips a pass; the next pass picks up the rest; then nothing is left", async () => {
    await clip(); await clip(); await clip();
    expect((await pass({ chunk: 2 })).tagged).toBe(2);
    expect((await pass({ chunk: 2 })).tagged).toBe(1);
    expect((await pass({ chunk: 2 })).total).toBe(0);
  });

  it("the daily cap waits for tomorrow", async () => {
    await clip(); await clip();
    const r = await pass({ dailyCapUsd: 0.0000001 });
    expect(r.tagged).toBe(0);
    expect(r.dailyCapped).toBe(1);
  });

  it("an answer with no speech is an attempt, not a write — so the clip is not paid for again every tick", async () => {
    const noSpeech = JSON.parse(ANSWER);
    delete noSpeech.speech;
    const silent: VideoTagTransport = async () => ({ text: JSON.stringify(noSpeech), usage: { inputTokens: 100, outputTokens: 50 }, model: "registry-flash" });
    process.env.MEDIA_ENRICH_MAX_ATTEMPTS = "10";
    const id = await clip({ metadata: { vision: READ, transcript_backfill: { attempts: 9 } } });
    const r = await pass({ transport: silent });
    expect(r.tagged).toBe(0);
    const m = await metaOf(id);
    expect(m.vision.description).toBe("an old read");
    expect(m.transcript_backfill).toMatchObject({ attempts: 10, abandoned_reason: "attempts" });
    expect((await pass({ transport: silent })).total).toBe(0);
  });

  it("a clip that keeps failing is set down under the backfill's own key, never the lane's", async () => {
    process.env.MEDIA_ENRICH_MAX_ATTEMPTS = "10";
    transportFails = true;
    const id = await clip({ metadata: { vision: READ, transcript_backfill: { attempts: 9 } } });
    await pass();
    const m = await metaOf(id);
    expect(m.transcript_backfill).toMatchObject({ attempts: 10, abandoned_reason: "attempts", abandoned_missing: ["speech"] });
    expect(m.enrichment).toBeUndefined();
    expect((await pass()).total).toBe(0);
  });
});

describe("B4: the flag", () => {
  it("off: backfillTranscripts reads nothing", async () => {
    delete process.env.CAMERA_ROLL_INTAKE;
    await clip();
    const { backfillTranscripts } = await import("../../services/mediaEnrichment");
    expect(await backfillTranscripts({ athleteId })).toBeNull();
    expect(prompts).toHaveLength(0);
  });
});
