/**
 * shots.test.ts — shot detection (quality-scrappy piece 3, ADI-QS-GO): ffmpeg's scene score on generated clips with
 * known cuts, the pure snap rules, and the record — one key beside `vision`, hers only.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M3a — the snap window widened to 5 s: "a boundary 0.6 s from the edge does not snap" reds.
 *   M3b — boundaries written inside `vision` instead of beside it: "writes metadata.shots beside vision" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { athletes, mediaAssets } from "../../../shared/schema";
import {
  SHOT_SCENE_THRESHOLD,
  boundariesFrom,
  detectShots,
  writeShots,
} from "./shots";
import {
  MIN_SEGMENT_SEC,
  SNAP_WITHIN_SEC,
  shotsOf,
  snapWindow,
} from "./shotSnap";

jest.setTimeout(120_000);
const execFileP = promisify(execFile);
const DIR = mkdtempSync(join(tmpdir(), "shots-test-"));
const HER = "77777777-4444-4777-8777-777777777777";
const SOMEONE_ELSE = "88888888-4444-4888-8888-888888888888";

/** 2 s of moving pattern, CUT to 1.5 s of red, CUT to 2 s of mandelbrot: boundaries at 2.0 and 3.5. */
let twoCuts: string;
/** 4 s of one moving pattern: a single take. */
let oneTake: string;

beforeAll(async () => {
  twoCuts = join(DIR, "two-cuts.mp4");
  oneTake = join(DIR, "one-take.mp4");
  const ff = (args: string[]) =>
    execFileP("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], {
      timeout: 60_000,
    });
  await Promise.all([
    ff([
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
      twoCuts,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      oneTake,
    ]),
  ]);
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Shots Test Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
});
afterAll(async () => {
  await closeTestDb();
  rmSync(DIR, { recursive: true, force: true });
});

describe("detection, on real ffmpeg", () => {
  it("finds the two hard cuts where they were made", async () => {
    const r = await detectShots(twoCuts);
    expect(r.boundaries).toHaveLength(2);
    expect(r.boundaries[0]).toBeCloseTo(2.0, 1);
    expect(r.boundaries[1]).toBeCloseTo(3.5, 1);
    expect(r).toMatchObject({
      version: 1,
      method: "ffmpeg-scene",
      threshold: SHOT_SCENE_THRESHOLD,
    });
    expect(r.durationSec).toBeCloseTo(5.5, 1);
  });

  it("finds nothing in a single moving take", async () => {
    expect((await detectShots(oneTake)).boundaries).toEqual([]);
  });

  it("reads showinfo's own lines, merges a dissolve's consecutive frames, and ignores frame 0", () => {
    const log = [
      "[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0 duration: 3",
      "[Parsed_showinfo_1 @ 0x1] n:   1 pts:  49152 pts_time:2 duration: 512",
      "[Parsed_showinfo_1 @ 0x1] n:   2 pts:  49664 pts_time:2.04167 duration: 512",
      "[Parsed_showinfo_1 @ 0x1] n:   3 pts:  86016 pts_time:3.5 duration: 512",
      "[out_0_0 @ 0x2] something with pts_time:9 that is not showinfo",
    ].join("\n");
    expect(boundariesFrom(log)).toEqual([2, 3.5]);
  });
});

describe("the snap, pure", () => {
  const cuts = [2.0, 3.5];

  it("an edge within half a second of a cut lands on the cut", () => {
    expect(snapWindow({ startSec: 1.7, endSec: 3.2 }, cuts)).toEqual({
      startSec: 2.0,
      endSec: 3.5,
      snapped: ["start", "end"],
    });
  });

  it("a boundary 0.6 s from the edge does not snap", () => {
    expect(SNAP_WITHIN_SEC).toBe(0.5);
    expect(snapWindow({ startSec: 1.4, endSec: 4.1 }, cuts)).toEqual({
      startSec: 1.4,
      endSec: 4.1,
      snapped: [],
    });
  });

  it("never leaves a segment shorter than the minimum, or runs past the clip", () => {
    // Either edge onto 2.0 would leave under half a second: neither snaps.
    expect(snapWindow({ startSec: 1.6, endSec: 2.3 }, [2.0])).toEqual({
      startSec: 1.6,
      endSec: 2.3,
      snapped: [],
    });
    // The start onto 2.0 keeps 0.6 s: it snaps. The end is 0.6 s from the cut: out of reach.
    expect(snapWindow({ startSec: 1.8, endSec: 2.6 }, [2.0])).toEqual({
      startSec: 2.0,
      endSec: 2.6,
      snapped: ["start"],
    });
    expect(MIN_SEGMENT_SEC).toBe(0.5);
    expect(
      snapWindow({ startSec: 0, endSec: 5.8 }, [6.1], { durationSec: 6 }),
    ).toEqual({ startSec: 0, endSec: 5.8, snapped: [] });
  });

  it("picks the nearer of two cuts in reach", () => {
    expect(snapWindow({ startSec: 2.3, endSec: 5 }, [2.0, 2.4]).startSec).toBe(
      2.4,
    );
  });

  it("shotsOf reads only well-formed numbers, ascending, and [] when there is no record", () => {
    expect(
      shotsOf({ shots: { boundaries: [3.5, "x", -1, 2, null, Infinity] } }),
    ).toEqual([2, 3.5]);
    expect(shotsOf({ vision: {} })).toEqual([]);
    expect(shotsOf(null)).toEqual([]);
  });
});

describe("the record: beside vision, hers only", () => {
  async function seed(owner: string): Promise<string> {
    const [row] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: owner,
        platform: "studio",
        origin: "upload",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${owner}/v-${Math.random().toString(36).slice(2)}.mp4`,
        content_type: "video/mp4",
        metadata: { vision: { beats: [{ start_s: 0, end_s: 2 }] } },
      } as never)
      .returning({ id: mediaAssets.id });
    return row.id;
  }
  const meta = async (id: string) =>
    (
      await db
        .select({ m: mediaAssets.metadata })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, id))
    )[0].m as any;

  it("writes metadata.shots beside vision, which stays exactly as it was", async () => {
    const id = await seed(HER);
    expect(await writeShots(id, HER, await detectShots(twoCuts))).toBe(true);
    const m = await meta(id);
    expect(m.vision).toEqual({ beats: [{ start_s: 0, end_s: 2 }] });
    expect(shotsOf(m)).toHaveLength(2);
  });

  it("never writes another athlete's row", async () => {
    const theirs = await seed(SOMEONE_ELSE);
    expect(await writeShots(theirs, HER, await detectShots(oneTake))).toBe(
      false,
    );
    expect((await meta(theirs)).shots).toBeUndefined();
  });
});
