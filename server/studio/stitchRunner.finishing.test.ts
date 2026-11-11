/**
 * stitchRunner.finishing.test.ts — the finishing pass's wiring in the stitch runner (quality-scrappy piece 6,
 * ADI-QS-GO): under STUDIO_FINISHING (opt-in) the engine is asked for the limiter, the fill-crop on a portrait
 * target and the bed's measured gain, and a cut near a beat reaches it moved; off — and under the master — the request
 * the engine gets is the request it always got.
 *
 * Harness: stitchRunner.test.ts's (PGlite, GCS stubbed, the engine stood in and inspected), with a real audio bed
 * served for a curated track, so the measurement and the grid both run.
 *
 * ⚠️ MUTATION M6h: drop the runner's finishing block — "under the flag the engine is asked for the finishing pass" reds.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(),
  uploadLocalFile: jest.fn(),
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: [] },
    video: { max: 200 * 1024 * 1024, types: [] },
  },
}));
jest.mock("./video/stitch", () => ({ stitch: jest.fn() }));

import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, mediaAssets, studioStitchJobs } from "../../shared/schema";
import { signedUrl, uploadLocalFile } from "../lib/mediaStore";
import { stitch } from "./video/stitch";
import { claimStitchJobs, queueStitch } from "./stitchJobs";
import { MUSIC_TRACKS } from "./music/tracks";
import { makeFixtures, type Fixtures } from "./video/testFixtures";
import { RUNNER_ID, workStitch } from "./stitchRunner";

jest.setTimeout(180_000);
const ROOT = mkdtempSync(join(tmpdir(), "stitch-finishing-test-"));
const HER = "77777777-6666-4777-8777-777777777777";
const TRACK = "walking-around" as const; // 84 BPM, first beat 0.696 → beats 0.696, 1.410, 2.125 …
let clips: Fixtures;
let bedBytes: Buffer;
let served: Map<string, Buffer>;
const mockStitch = stitch as jest.MockedFunction<typeof stitch>;

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values({ id: HER, full_name: "Finishing Athlete" } as never);
  process.env.STUDIO_STITCH_WORKSPACE_DIR = ROOT;
  clips = await makeFixtures(ROOT);
  const bed = join(ROOT, "track.m4a");
  await promisify(execFile)("ffmpeg", [
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=12",
    "-c:a",
    "aac",
    bed,
  ]);
  bedBytes = readFileSync(bed);
});
afterAll(async () => {
  await closeTestDb();
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.STUDIO_STITCH_WORKSPACE_DIR;
});
beforeEach(async () => {
  await db.delete(studioStitchJobs);
  await db.delete(mediaAssets);
  delete process.env.STUDIO_FINISHING;
  delete process.env.STUDIO_ALL_ON;
  process.env.STUDIO_STITCH_BEDS_READY = "true";
  jest.clearAllMocks();
  served = new Map([[MUSIC_TRACKS[TRACK].gcsPath, bedBytes]]);
  (signedUrl as jest.Mock).mockImplementation(
    async (p: string) => `https://signed.test/${p}`,
  );
  (uploadLocalFile as jest.Mock).mockResolvedValue(undefined);
  mockStitch.mockImplementation((async (req: { outputPath: string }) => {
    writeFileSync(req.outputPath, Buffer.alloc(1234, 3));
    return {
      outputPath: req.outputPath,
      clips: [{}],
      audioBed: null,
      expectedDurationSec: 3,
      output: { width: 1080, height: 1920, durationSec: 3, sizeBytes: 1234 },
      ffmpeg: { args: [], filterGraph: "", durationMs: 10 },
    };
  }) as never);
  global.fetch = jest.fn(async (url: unknown) => {
    const body = served.get(String(url).replace("https://signed.test/", ""));
    return body
      ? new Response(new Uint8Array(body))
      : new Response(null, { status: 404 });
  }) as never;
});

/** Two of her clips (clipA, 2.0 s), the first cut at 1.6 s — 0.19 s past the beat at 1.410 — under the track. */
async function runOne(): Promise<Record<string, any>> {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: HER,
        platform: "studio",
        origin: "upload",
        media_type: "VIDEO",
        status: "stored",
        approval_status: "approved",
        gcs_path: `athletes/${HER}/clip-${i}-${Math.random().toString(36).slice(2)}.mp4`,
        content_type: "video/mp4",
        bytes: 1000,
        duration_seconds: 2,
        ingested_at: new Date(),
      } as never)
      .returning({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path });
    served.set(row.gcs_path!, readFileSync(clips.clipA.path));
    ids.push(row.id);
  }
  await queueStitch(HER, {
    clips: [{ assetId: ids[0], trimEndSec: 1.6 }, { assetId: ids[1] }],
    target: "portrait",
    bed: TRACK,
  });
  const [job] = await claimStitchJobs(1, RUNNER_ID);
  expect(await workStitch(job)).toBe("succeeded");
  return mockStitch.mock.calls[0][0] as unknown as Record<string, any>;
}

it("under the flag the engine is asked for the finishing pass: limiter, fill-crop on portrait, the bed's gain", async () => {
  process.env.STUDIO_FINISHING = "true";
  const req = await runOne();
  expect(req.finishing).toMatchObject({
    truePeakDbtp: -1,
    cropToFill: true,
    bedGainDb: expect.any(Number),
  });
});

it("under the flag a cut 0.19 s past a beat reaches the engine moved onto it", async () => {
  process.env.STUDIO_FINISHING = "true";
  const req = await runOne();
  expect(req.clips[0].trimEndSec).toBeCloseTo(0.696 + 60 / 84, 2); // 1.410
  expect(req.clips[1].trimEndSec).toBeUndefined();
});

it("flag off: no finishing key, and the cut where she put it", async () => {
  const req = await runOne();
  expect("finishing" in req).toBe(false);
  expect(req.clips[0].trimEndSec).toBe(1.6);
});

it("the master does not turn it on (opt-in, ADI-QS-GO)", async () => {
  process.env.STUDIO_ALL_ON = "true";
  const req = await runOne();
  expect("finishing" in req).toBe(false);
  expect(req.clips[0].trimEndSec).toBe(1.6);
});
