/**
 * studio/agent/beatPoster — a frame from INSIDE a beat's window, for the row that shows the beat.
 *
 * Every Board beat row of one clip showed the clip's poster — frame 0 — so four rows cut from the
 * 51 s upload were four copies of her tying her cleats (enrichment eval, cards, 22 Sep 2026). A
 * beat row wants a frame the beat actually holds: the WINDOW'S MIDPOINT, because a boundary frame
 * on a soft transition is the neighbouring beat's last frame.
 *
 * ─── LAZY, CACHED IN GCS, NO DB WRITE ───────────────────────────────────────────────────────────
 *
 * Grabbed at CAST time, the first time a plan cuts this clip to this window, and stored once at
 * `athletes/<athleteId>/studio/beats/<assetId>/<start>-<end>.jpg`. The next plan finds the object
 * (`headObject`) and signs it — no ffmpeg. No row is written and no cron changes; a re-tag with
 * new windows simply makes new objects, and the old ones sit unreferenced (a few tens of KB each).
 * The other home — posters written by the enrichment worker beside each beat — is the cleaner one
 * and is carded: it writes into every athlete's `vision.beats` and needs a backfill, which this does
 * not. Rejected outright: a client-side seek-and-capture, which would load the whole mp4 into every
 * clip row and has no capture API on React Native.
 *
 * ─── FAILURE KEEPS TODAY'S POSTER ───────────────────────────────────────────────────────────────
 *
 * Any failure — an object that will not stream, ffmpeg missing, a timeout, an upload error —
 * returns null, logged with the asset id, and the caster keeps the clip's own poster. A plan is
 * never refused over a thumbnail.
 *
 * ffmpeg reads the signed URL directly, the way services/videoPoster.ts does: `-ss` BEFORE `-i`
 * is the fast, keyframe-accurate seek, which pulls only the bytes around the frame over https
 * range requests — one to two seconds for a 51 s clip, once.
 */
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import { headObject, signedUrl, uploadLocalFile } from "../../lib/mediaStore";
import { createLogger } from "../../logger";

const execFileP = promisify(execFile);
const logger = createLogger("studio/agent/beatPoster");

/** One ffmpeg's ceiling. The grab is a seek and one frame; anything slower is a stuck stream. */
export const BEAT_POSTER_TIMEOUT_MS = 20_000;

// ffmpeg needs the https protocol whitelisted to read a signed URL (services/videoPoster.ts).
const PROTO = ["-protocol_whitelist", "file,https,tls,tcp,crypto"];

/** The window, in seconds of the source. */
export interface BeatWindow {
  startSec: number;
  endSec: number;
}

/** Where a window's poster lives. Tenths of a second in the name, so 9.5 and 9.50 are one object. */
export const beatPosterPath = (
  athleteId: string,
  assetId: string,
  w: BeatWindow,
): string =>
  `athletes/${athleteId}/studio/beats/${assetId}/${w.startSec.toFixed(1)}-${w.endSec.toFixed(1)}.jpg`;

/** The moment the frame is taken from: the window's midpoint. */
export const beatPosterAt = (w: BeatWindow): number =>
  Math.round(((w.startSec + w.endSec) / 2) * 100) / 100;

/** What the grabber does: a frame of `sourceUrl` at `atSec`, written to `outPath`. Injected in tests. */
export type FrameGrabber = (
  sourceUrl: string,
  atSec: number,
  outPath: string,
) => Promise<void>;

export const ffmpegFrameGrabber: FrameGrabber = async (
  sourceUrl,
  atSec,
  outPath,
) => {
  await execFileP(
    "ffmpeg",
    [
      "-y",
      "-nostdin",
      ...PROTO,
      "-ss",
      String(atSec),
      "-i",
      sourceUrl,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outPath,
    ],
    { timeout: BEAT_POSTER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
};

/** The storage the poster goes through. Injected in tests; the product passes lib/mediaStore. */
export interface BeatPosterStore {
  headObject: typeof headObject;
  signedUrl: typeof signedUrl;
  uploadLocalFile: typeof uploadLocalFile;
}

const productStore: BeatPosterStore = {
  headObject,
  signedUrl,
  uploadLocalFile,
};

/**
 * A signed URL for a frame inside the window — from the cache when the object exists, else grabbed,
 * uploaded and signed. Null on any failure (the caller keeps the clip's poster).
 */
export async function beatPosterUrl(
  given: {
    athleteId: string;
    assetId: string;
    /** The clip's `gcs_path` — the mp4 the frame is read from. */
    videoPath: string;
    window: BeatWindow;
  },
  deps: { grab?: FrameGrabber; store?: BeatPosterStore } = {},
): Promise<string | null> {
  const grab = deps.grab ?? ffmpegFrameGrabber;
  const store = deps.store ?? productStore;
  const { athleteId, assetId, videoPath, window } = given;
  if (!(window.endSec > window.startSec)) return null;
  const path = beatPosterPath(athleteId, assetId, window);
  try {
    if (await store.headObject(path)) return await store.signedUrl(path);
    const dir = await mkdtemp(join(tmpdir(), "beat-poster-"));
    try {
      const out = join(dir, "frame.jpg");
      const source = await store.signedUrl(videoPath, 15 * 60_000);
      await grab(source, beatPosterAt(window), out);
      await store.uploadLocalFile(out, path, "image/jpeg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return await store.signedUrl(path);
  } catch (err) {
    logger.warn(
      { err, athleteId, assetId, window },
      "beat poster not made — the clip's poster stands",
    );
    return null;
  }
}
