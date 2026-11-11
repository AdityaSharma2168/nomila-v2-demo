/**
 * videoPoster.duration.test.ts — the media-poster worker's duration rider (migration 0058).
 *
 * The poster cron is where the clips the upload probe could not reach end up: a row whose probe
 * failed, every Studio-generated clip, and the Instagram top-performer mp4s that fetchTopVideoFiles
 * swaps in. It already signs a URL and already UPDATEs the row, so the duration costs one ffprobe
 * of a container header and no extra round trip.
 *
 * ─── WHAT THIS SUITE EXISTS TO HOLD ─────────────────────────────────────────────────────────────
 *
 * Two orderings, and they are the whole design:
 *
 *   1. THE PROBE NEVER COSTS THE POSTER. It runs in its own try/catch, ahead of the frame extract.
 *      The poster is what makes a clip visible in her library at all; a missing number is nothing
 *      beside a grey tile, so a clip ffprobe cannot read must still be postered.
 *   2. A FAILED PROBE WRITES NOTHING. The key is omitted, not set to null — otherwise the cron
 *      would erase a duration the upload probe had already measured correctly, every time it ran.
 *
 * ffmpeg/ffprobe and GCS are mocked: there is no binary contract being tested here, only which
 * column ends up with what. The ffprobe wrapper itself is covered by the stitch engine's suites.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(
    async (p: string) => `https://signed.example/${p}?sig=secret`,
  ),
  uploadLocalFile: jest.fn(async () => {}),
}));
jest.mock("../studio/video/probe", () => ({ probeDurationSeconds: jest.fn() }));
// The poster itself: stub the ffmpeg spawn and the size check it uses to decide the frame landed.
jest.mock("child_process", () => ({ execFile: jest.fn() }));
jest.mock("fs/promises", () => ({
  stat: jest.fn(async () => ({ size: 4096 })),
  unlink: jest.fn(async () => {}),
}));

import { execFile } from "child_process";
import { eq } from "drizzle-orm";
import { processOneVideo } from "./videoPoster";
import { mediaAssets } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import { probeDurationSeconds } from "../studio/video/probe";

const probeMock = probeDurationSeconds as jest.MockedFunction<
  typeof probeDurationSeconds
>;
const execFileMock = execFile as unknown as jest.Mock;

let athleteId: string;

/** promisify(execFile) calls this shape; succeed unless a test says otherwise. */
function ffmpegSucceeds() {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, { stdout: "", stderr: "" });
    },
  );
}

async function seedPosterlessVideo(
  opts: {
    durationSeconds?: number | null;
    durationSecondsPrecise?: number | null;
  } = {},
) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: athleteId,
      platform: "upload",
      origin: "upload",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: `athletes/${athleteId}/uploads/${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      duration_seconds: opts.durationSeconds ?? null,
      duration_seconds_precise: opts.durationSecondsPrecise ?? null,
      gcs_thumb_path: null,
      ingested_at: new Date(),
    } as never)
    .returning();
  return row;
}

async function durationsOf(id: string) {
  const [row] = await db
    .select({
      rounded: mediaAssets.duration_seconds,
      precise: mediaAssets.duration_seconds_precise,
      thumb: mediaAssets.gcs_thumb_path,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  return row;
}

beforeAll(async () => {
  await initTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  athleteId = await seedAthlete("Poster Tester");
  probeMock.mockReset();
  execFileMock.mockReset();
  ffmpegSucceeds();
});

describe("processOneVideo: the duration rider", () => {
  /**
   * ⚠️  THE REVERT CHECK FOR THE RIDER.
   *
   * MUTATION: delete the `duration_seconds_precise` spread from the poster's `.set({...})`. The
   * poster still lands and the function still returns, so nothing else notices — this is the only
   * assertion that does.
   */
  it("writes the measured duration alongside the poster", async () => {
    probeMock.mockResolvedValue(14.72);
    const row = await seedPosterlessVideo();

    await processOneVideo(row as never);

    const d = await durationsOf(row.id);
    expect(d.precise).toBeCloseTo(14.72, 6);
    expect(d.thumb).toBe(`athletes/${athleteId}/uploads/${row.id}-poster.jpg`);
  });

  /**
   * It probes the SOURCE url — the one the poster is cut from — and does so before the transcode
   * in step 2 can repoint gcs_path. Pinned because probing after the transcode would work by luck
   * (a re-encode preserves duration) and break the moment that stops being true.
   */
  it("probes the same signed URL the poster is cut from, and only once", async () => {
    probeMock.mockResolvedValue(3);
    const row = await seedPosterlessVideo();

    await processOneVideo(row as never);

    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(probeMock).toHaveBeenCalledWith(
      `https://signed.example/${row.gcs_path}?sig=secret`,
    );
  });

  /**
   * ⚠️  ORDERING REVERT CHECK 1 — the probe must never cost the poster.
   *
   * MUTATION: move the probe inside the poster's try block, or let it throw. The poster is then
   * lost for every clip ffprobe cannot read, and a posterless clip is an empty tile in her library.
   */
  it("still posters a clip whose duration cannot be read", async () => {
    probeMock.mockRejectedValue(
      new Error("ffprobe failed: moov atom not found"),
    );
    const row = await seedPosterlessVideo();

    const outcome = await processOneVideo(row as never);

    expect(outcome).not.toBe("failed");
    const d = await durationsOf(row.id);
    expect(d.thumb).toBe(`athletes/${athleteId}/uploads/${row.id}-poster.jpg`);
    expect(d.precise).toBeNull();
  });

  /**
   * ⚠️  ORDERING REVERT CHECK 2 — a failed probe writes NOTHING.
   *
   * MUTATION: replace the conditional spread with a bare
   * `duration_seconds_precise: probedSeconds`. On a probe failure that writes null over a duration
   * the upload probe had already measured, and it would do it on every cron pass — a value that
   * silently degrades instead of one that is simply missing.
   */
  it("does not erase a duration already on the row when the probe fails", async () => {
    probeMock.mockRejectedValue(new Error("ffprobe failed: 403"));
    const row = await seedPosterlessVideo({ durationSecondsPrecise: 6.25 });

    await processOneVideo(row as never);

    expect((await durationsOf(row.id)).precise).toBeCloseTo(6.25, 6);
  });

  /**
   * The integer column is not the rider's business — same fence the upload probe keeps. A measured
   * 14.72 must not become a 15 in the column that means "what the picker said".
   */
  it("leaves duration_seconds untouched", async () => {
    probeMock.mockResolvedValue(14.72);
    const row = await seedPosterlessVideo({ durationSeconds: 9 });

    await processOneVideo(row as never);

    const d = await durationsOf(row.id);
    expect(d.rounded).toBe(9);
    expect(d.precise).toBeCloseTo(14.72, 6);
  });

  /**
   * A row with no pixels never reaches the probe — there is nothing to sign a URL for, and the
   * function bails before any work. Cheap to assert, and it pins that the rider did not move the
   * early return.
   */
  it("never probes a row with no gcs_path", async () => {
    const row = await seedPosterlessVideo();

    const outcome = await processOneVideo({ ...row, gcs_path: null } as never);

    expect(outcome).toBe("failed");
    expect(probeMock).not.toHaveBeenCalled();
  });
});
