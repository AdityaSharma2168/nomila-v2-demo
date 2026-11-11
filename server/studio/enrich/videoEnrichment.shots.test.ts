/**
 * videoEnrichment.shots.test.ts — shot detection's wiring at the clip read (quality-scrappy piece 3): under
 * STUDIO_SHOT_DETECT a clip that is read gets `metadata.shots` from the SAME bytes the read downloaded; off, nothing;
 * and a clip ffmpeg cannot score is still a clip that was read — the outcome does not move.
 *
 * Harness: videoEnrichment.test.ts's seams (transport, bytes, container probe), with the bytes a real fixture clip.
 *
 * ⚠️ MUTATION M3c: drop the read's STUDIO_SHOT_DETECT branch — "a clip read under the flag gets its boundaries" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/visionTag", () => ({
  ...jest.requireActual("../../lib/visionTag"),
  tagAsset: jest.fn(),
}));
jest.mock("../../lib/mediaEmbed", () => ({
  embedImageGcsWithReason: jest.fn(),
}));
jest.mock("../../lib/mediaStore", () => ({
  readObject: jest.fn(),
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
}));
jest.mock("../../lib/models", () => ({
  genai: () => ({ models: { generateContent: jest.fn() } }),
  GEMINI: {
    flash: "registry-flash",
    flashLite: "registry-flash-lite",
    pro: "registry-pro",
  },
}));

import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { mediaAssets } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { enrichVideoChunk } from "./videoEnrichment";

jest.setTimeout(120_000);
const DIR = mkdtempSync(join(tmpdir(), "enrich-shots-"));
let twoCuts: Buffer;
let athleteId: string;

const CLIP_JSON = {
  athlete_present: true,
  athlete_prominence: 0.9,
  shot_type: "action",
  description: "a clip",
  brands_visible: [],
  aesthetic_quality: 0.8,
  brand_safe: true,
  content_flags: {},
  setting: "track",
  attire: "kit",
  vibe: "fast",
  hero_suitability: 0.8,
  disposition: "as_is",
  edit_note: "",
  reason: "r",
  beats: [
    {
      start_s: 0,
      end_s: 2,
      description: "a",
      shot_type: "action",
      athlete_present: true,
      athlete_prominence: 0.9,
      setting: "s",
      attire: "a",
      vibe: "v",
      brands_visible: [],
      aesthetic_quality: 0.8,
      camera: "c",
      motion: "m",
      hero_suitability: 0.8,
    },
    {
      start_s: 2,
      end_s: 5.5,
      description: "b",
      shot_type: "action",
      athlete_present: true,
      athlete_prominence: 0.9,
      setting: "s",
      attire: "a",
      vibe: "v",
      brands_visible: [],
      aesthetic_quality: 0.8,
      camera: "c",
      motion: "m",
      hero_suitability: 0.8,
    },
  ],
};
const transport = jest.fn(async () => ({
  text: JSON.stringify(CLIP_JSON),
  usage: { inputTokens: 1500, outputTokens: 700 },
  model: "registry-flash",
}));

beforeAll(async () => {
  const path = join(DIR, "two-cuts.mp4");
  await promisify(execFile)(
    "ffmpeg",
    [
      "-y",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=2",
      "-f",
      "lavfi",
      "-i",
      "color=red:size=360x640:rate=24:duration=1.5",
      "-f",
      "lavfi",
      "-i",
      "mandelbrot=size=360x640:rate=24",
      "-filter_complex",
      "[2:v]trim=duration=2,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1:a=0[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { timeout: 60_000 },
  );
  twoCuts = readFileSync(path);
  await initTestDb();
  athleteId = await seedAthlete("Enrich Shots Athlete");
});
afterAll(async () => {
  await closeTestDb();
  rmSync(DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.delete(mediaAssets);
  delete process.env.STUDIO_SHOT_DETECT;
  delete process.env.STUDIO_ALL_ON;
});

async function readOne(
  bytes: Buffer,
): Promise<{ outcome: unknown; metadata: any }> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: "athletes/x/studio/job/clip.mp4",
      // The read's predicate wants a poster (videoEnrichment.ts VIDEO_UNTAGGED).
      gcs_thumb_path: "athletes/x/studio/job/clip-poster.jpg",
      content_type: "video/mp4",
      bytes: bytes.byteLength,
      duration_seconds_precise: 5.5,
      metadata: { vision: { description: "poster" } },
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id });
  const r = await enrichVideoChunk({
    athleteId,
    transport,
    loadBytes: async () => bytes,
    statBytes: async () => null,
    probeContainer: async () => null,
  });
  const [after] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, row.id));
  return { outcome: r, metadata: after.metadata };
}

it("a clip read under the flag gets its boundaries — from the bytes the read downloaded, beside vision", async () => {
  process.env.STUDIO_SHOT_DETECT = "true";
  const { outcome, metadata } = await readOne(twoCuts);
  expect(outcome).toMatchObject({ tagged: 1, failed: 0 });
  expect(metadata.vision.beats).toHaveLength(2);
  expect(metadata.shots.boundaries).toHaveLength(2);
  expect(metadata.shots.boundaries[0]).toBeCloseTo(2.0, 1);
});

it("the master turns it on (it is under the master, ADI-QS-GO)", async () => {
  process.env.STUDIO_ALL_ON = "true";
  expect((await readOne(twoCuts)).metadata.shots.boundaries).toHaveLength(2);
});

it("flag off: the read is exactly what it was — no shots key", async () => {
  const { outcome, metadata } = await readOne(twoCuts);
  expect(outcome).toMatchObject({ tagged: 1 });
  expect(metadata.shots).toBeUndefined();
});

it("bytes ffmpeg cannot score: the read still counts as tagged, and no shots are written", async () => {
  process.env.STUDIO_SHOT_DETECT = "true";
  const { outcome, metadata } = await readOne(Buffer.from("not an mp4"));
  expect(outcome).toMatchObject({ tagged: 1, failed: 0 });
  expect(metadata.vision.beats).toHaveLength(2);
  expect(metadata.shots).toBeUndefined();
});
