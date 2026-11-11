/**
 * stitchRunner.structure.test.ts — the structure check's wiring on the STITCH path (quality-scrappy piece 2): under
 * STUDIO_CLIP_QC the stitched output is checked on its local file before publish and the record lands on the
 * published asset; off, nothing is written; a failing check never fails the stitch.
 *
 * Harness: stitchRunner.test.ts's (PGlite, the GCS boundary and the engine stubbed), with the engine writing a real
 * fixture clip so the check has something to measure.
 *
 * ⚠️ MUTATION M2e: drop the stitch runner's structure write — "a published stitch carries its structure record" reds.
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

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { athletes, mediaAssets, studioStitchJobs } from "../../shared/schema";
import { signedUrl, uploadLocalFile } from "../lib/mediaStore";
import { stitch } from "./video/stitch";
import { claimStitchJobs, queueStitch } from "./stitchJobs";
import { makeFixtures, type Fixtures } from "./video/testFixtures";
import {
  makeStructureFixtures,
  type StructureFixtures,
} from "./video/structureFixtures";
import { RUNNER_ID, workStitch } from "./stitchRunner";

jest.setTimeout(180_000);
const execFileP = promisify(execFile);

const ROOT = mkdtempSync(join(tmpdir(), "stitch-structure-test-"));
const HER = "77777777-3333-4777-8777-777777777777";
let clips: Fixtures;
let fx: StructureFixtures;
/** A clean 1080x1920 4 s clip — what a portrait stitch is asked to be. */
let portrait: string;
let served: Map<string, Buffer>;

const mockStitch = stitch as jest.MockedFunction<typeof stitch>;
/** The engine stand-in: puts `clip` where the output belongs and reports a 4 s portrait with no bed. */
const engineWrites = (clip: string) =>
  mockStitch.mockImplementation((async (req: { outputPath: string }) => {
    copyFileSync(clip, req.outputPath);
    return {
      outputPath: req.outputPath,
      clips: [{}],
      audioBed: null,
      expectedDurationSec: 4,
      output: { width: 1080, height: 1920, durationSec: 4, sizeBytes: 1234 },
      ffmpeg: { args: [], filterGraph: "", durationMs: 10 },
    };
  }) as never);

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values({ id: HER, full_name: "Stitch Structure Athlete" } as never);
  process.env.STUDIO_STITCH_WORKSPACE_DIR = ROOT;
  [clips, fx] = await Promise.all([
    makeFixtures(ROOT),
    makeStructureFixtures(ROOT),
  ]);
  portrait = join(ROOT, "portrait-1080.mp4");
  await execFileP("ffmpeg", [
    "-y",
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1080x1920:rate=30:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    portrait,
  ]);
});
afterAll(async () => {
  await closeTestDb();
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.STUDIO_STITCH_WORKSPACE_DIR;
});
beforeEach(async () => {
  await db.delete(studioStitchJobs);
  await db.delete(mediaAssets);
  delete process.env.STUDIO_CLIP_QC;
  delete process.env.STUDIO_ALL_ON;
  jest.clearAllMocks();
  served = new Map();
  (signedUrl as jest.Mock).mockImplementation(
    async (p: string) => `https://signed.test/${p}`,
  );
  (uploadLocalFile as jest.Mock).mockResolvedValue(undefined);
  global.fetch = jest.fn(async (url: unknown) => {
    const body = served.get(String(url).replace("https://signed.test/", ""));
    return body
      ? new Response(new Uint8Array(body))
      : new Response(null, { status: 404 });
  }) as never;
});

async function stitchOne(): Promise<{ outcome: string; creativeQa: any }> {
  const [src] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: HER,
      platform: "studio",
      origin: "upload",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "approved",
      gcs_path: `athletes/${HER}/clip-${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      bytes: 1000,
      duration_seconds: 2,
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path });
  served.set(src.gcs_path!, readFileSync(clips.clipA.path));
  await queueStitch(HER, { clips: [{ assetId: src.id }], target: "portrait" });
  const [job] = await claimStitchJobs(1, RUNNER_ID);
  const outcome = await workStitch(job);
  const [row] = await db
    .select()
    .from(studioStitchJobs)
    .where(eq(studioStitchJobs.id, job.id));
  const out = row.output_asset_id
    ? (
        await db
          .select()
          .from(mediaAssets)
          .where(eq(mediaAssets.id, row.output_asset_id))
      )[0]
    : undefined;
  return { outcome, creativeQa: (out?.metadata as any)?.creative_qa };
}

it("a published stitch carries its structure record — the portrait it was asked to be passes", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  engineWrites(portrait);
  const { outcome, creativeQa } = await stitchOne();
  expect(outcome).toBe("succeeded");
  expect(creativeQa.structure).toMatchObject({
    subject: "stitch",
    status: "pass",
  });
  expect(creativeQa.structure.expected).toEqual({
    durationSec: 4,
    aspect: "1080:1920",
    width: 1080,
    height: 1920,
    sound: false,
  });
});

it("a black, wrong-size output is recorded as failing — and the stitch still succeeds", async () => {
  process.env.STUDIO_CLIP_QC = "true";
  engineWrites(fx.black);
  const { outcome, creativeQa } = await stitchOne();
  expect(outcome).toBe("succeeded");
  expect(creativeQa.structure.status).toBe("fail");
  expect(
    creativeQa.structure.findings
      .map((f: { reason: string }) => f.reason)
      .sort(),
  ).toEqual(expect.arrayContaining(["black", "resolution"]));
});

it("flag off: nothing is written", async () => {
  engineWrites(fx.black);
  const { outcome, creativeQa } = await stitchOne();
  expect(outcome).toBe("succeeded");
  expect(creativeQa).toBeUndefined();
});
