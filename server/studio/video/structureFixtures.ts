/**
 * structureFixtures.ts — the clips the structure check is tested on (quality-scrappy piece 2), generated at test time
 * from ffmpeg's lavfi sources. Nothing committed, nothing of hers: a test pattern, a black frame, a tone.
 * Shared by video/structure.test.ts and the runners' wiring tests.
 */
import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";

const execFileP = promisify(execFile);

export type StructureFixtures = {
  /** 360x640 (9:16), 24 fps, 4 s, a moving test pattern with a 440 Hz tone — asks for nothing it does not get. */
  clean: string;
  /** The same shape, 4 s of black. */
  black: string;
  /** The same shape, one frame of test pattern held for 4 s. */
  frozen: string;
  /** 640x360 (16:9), 4 s, moving — the wrong shape for a 9:16 ask. */
  wide: string;
  /** 0.6 s of black, then 3.4 s of moving pattern — a run worth a look, not a broken clip. */
  blackStart: string;
  /** Moving, 4 s, with an audio track that is pure digital silence — the −91 dB case. */
  silentTrack: string;
  /** Moving, 4 s, no audio track at all. */
  noAudio: string;
};

const ff = (args: string[]) =>
  execFileP("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], {
    timeout: 60_000,
  });
const V = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
const A = ["-c:a", "aac"];

export async function makeStructureFixtures(
  dir: string,
): Promise<StructureFixtures> {
  const f: StructureFixtures = {
    clean: join(dir, "s-clean.mp4"),
    black: join(dir, "s-black.mp4"),
    frozen: join(dir, "s-frozen.mp4"),
    wide: join(dir, "s-wide.mp4"),
    blackStart: join(dir, "s-black-start.mp4"),
    silentTrack: join(dir, "s-silent-track.mp4"),
    noAudio: join(dir, "s-no-audio.mp4"),
  };
  await Promise.all([
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      ...V,
      ...A,
      "-shortest",
      f.clean,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "color=black:size=360x640:rate=24:duration=4",
      ...V,
      f.black,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=0.05",
      "-vf",
      "loop=loop=200:size=1:start=0,trim=duration=4,setpts=N/24/TB",
      ...V,
      f.frozen,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24:duration=4",
      ...V,
      f.wide,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "color=black:size=360x640:rate=24:duration=0.6",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=3.4",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      ...V,
      f.blackStart,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=4",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      ...V,
      ...A,
      "-t",
      "4",
      f.silentTrack,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=24:duration=4",
      ...V,
      f.noAudio,
    ]),
  ]);
  return f;
}
