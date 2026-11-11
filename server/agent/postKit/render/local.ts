/**
 * agent/postKit/render/local.ts — a compiled render, carried out on LOCAL files (the workspace the runner downloaded).
 * Local CPU only: sharp, the caption renderer and ffmpeg. No network, no provider, no model — $0 like every stitch.
 *
 *   a reel or story   each photo fill-cropped to the frame (sharp, upright first) and held as a clip
 *                     (studio/video/still.ts); the overlay line drawn to a PNG band inside Reels' safe zones
 *                     (captionRender.ts); the bed measured and brought to the reference loudness (finishing.ts); ONE
 *                     engine run (studio/video/stitch.ts) with the look; then the cover still taken off the result
 *   a feed post or    each photo fill-cropped to the frame and written as a JPEG with the look applied by the same ffmpeg
 *   carousel          filter the videos use; a clip slide is its own short engine run; the cover is the cover slide's
 *                     picture, or a still taken off a clip slide
 *
 * Every ffmpeg run shares ONE budget (`deadline`): each is handed what is left of it, as the stitch runner does for its
 * stills, so the render can never outlast the job's lease.
 */
import { execFile } from "child_process";
import { stat, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";
import { withTimeout } from "../../../lib/withTimeout";
import { renderCaptionBand } from "../../../studio/video/captionRender";
import { bedGainDb, measureLoudness } from "../../../studio/video/finishing";
import { windowFor } from "../../../studio/video/firstFrame";
import { lookFilter } from "../../../studio/video/look";
import { assertLocalPath, fmt } from "../../../studio/video/plan";
import { encodeStill, FRAMING_PRIOR } from "../../../studio/video/still";
import { stitch } from "../../../studio/video/stitch";
import type { ClipOverlay } from "../../../studio/video/types";
import {
  RENDER_FPS, slideRequestFor, stitchRequestFor, timelineOf,
  type RenderPlan, type SlidesRenderPlan, type VideoRenderPlan,
} from "./compile";

const execFileP = promisify(execFile);

/** One photo's decode, rotate, crop and resize. Bounded: if it has not finished by here, something is wrong. */
const PHOTO_TIMEOUT_MS = 20_000;
/** A drawn overlay band is 5–15 KB at 1080 wide; anything near this is not a caption (stitchRunner.ts's bound). */
const OVERLAY_MAX_BYTES = 512 * 1024;
const JPEG_QUALITY = 92;

export interface LocalInputs {
  /** Each clip's downloaded file, by asset id. */
  clips: ReadonlyMap<string, string>;
  /** Each photo's downloaded file, by asset id. */
  photos: ReadonlyMap<string, string>;
  /** The bed's downloaded file, or null for no music. */
  bedPath: string | null;
}

export interface LocalOutput {
  path: string;
  kind: "video" | "image";
  contentType: "video/mp4" | "image/jpeg";
  width: number;
  height: number;
  /** A video's measured length; null on a picture. */
  durationSec: number | null;
  sourceAssetId: string;
}

export interface LocalRender {
  outputs: LocalOutput[];
  /** The cover still, and which output it is the poster of — null when the cover is a picture output itself. */
  cover: { outputIndex: number; path: string | null };
}

const left = (deadline: number, what: string): number => {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error(`The preview used up its whole encode budget before ${what}`);
  return ms;
};

/**
 * Her photo, upright, cut to the frame's shape and sized to it exactly. `fill` takes the largest window of the frame's
 * shape around the framing prior (the upper middle, studio/video/still.ts FRAMING_PRIOR) — every pixel in it is one she
 * took, nothing black is added; without `fill` the whole photo is fitted inside the frame on black. A vertical photo into
 * a vertical frame keeps its full height.
 */
export async function framePhoto(
  photoPath: string, outPath: string, frame: { width: number; height: number }, fill: boolean, as: "jpeg" | "png",
  /** What is left of the render's budget; the photo gets at most PHOTO_TIMEOUT_MS of it. */
  timeoutMs: number = PHOTO_TIMEOUT_MS,
): Promise<void> {
  assertLocalPath(photoPath, "photo");
  const work = async () => {
    const meta = await sharp(photoPath, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) throw new Error("A photo in this post could not be read");
    // EXIF orientations 5–8 are a quarter turn: the upright picture's edges swap.
    const turned = (meta.orientation ?? 1) >= 5;
    const w = turned ? meta.height : meta.width;
    const h = turned ? meta.width : meta.height;
    let img = sharp(photoPath, { failOn: "none" }).rotate();
    if (fill) {
      img = img.extract(windowFor(w, h, frame.width / frame.height, { x: FRAMING_PRIOR.x, y: FRAMING_PRIOR.y, width: 0, height: 0 }))
        .resize(frame.width, frame.height, { fit: "fill" });
    } else {
      img = img.resize(frame.width, frame.height, { fit: "contain", background: "#000000" });
    }
    img = img.flatten({ background: "#000000" });
    await (as === "png" ? img.png() : img.jpeg({ quality: JPEG_QUALITY })).toFile(outPath);
  };
  await withTimeout(work(), Math.min(PHOTO_TIMEOUT_MS, timeoutMs), "photo frame");
}

/** The argv that writes one picture as a JPEG, with the look's filter when it has one. Pure, so the flags are pinned. */
export function pictureArgs(inputPath: string, outputPath: string, look: RenderPlan["look"]): string[] {
  assertLocalPath(inputPath, "picture input");
  assertLocalPath(outputPath, "picture output");
  const vf = lookFilter(look);
  return ["-y", "-nostdin", "-i", inputPath, ...(vf ? ["-vf", vf] : []), "-frames:v", "1", "-q:v", "2", outputPath];
}

/** The argv that takes one still off a video at `atSec`. Pure. */
export function coverStillArgs(videoPath: string, atSec: number, outputPath: string): string[] {
  assertLocalPath(videoPath, "cover source");
  assertLocalPath(outputPath, "cover output");
  return ["-y", "-nostdin", "-ss", fmt(Math.max(0, atSec)), "-i", videoPath, "-frames:v", "1", "-q:v", "3", outputPath];
}

async function ffmpeg(args: string[], timeoutMs: number, what: string): Promise<void> {
  try {
    await execFileP("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  } catch (err: any) {
    const stderr = String(err?.stderr ?? "").trim();
    throw new Error(`ffmpeg ${what} failed${err?.killed ? ` (killed after ${timeoutMs}ms)` : ""}: ${stderr.slice(-400) || String(err?.message ?? err)}`);
  }
  if ((await stat(args[args.length - 1])).size === 0) throw new Error(`ffmpeg ${what} wrote an empty file`);
}

const need = (m: ReadonlyMap<string, string>, id: string, what: string): string => {
  const p = m.get(id);
  // Unreachable through the worker, which materializes every position first. A throw rather than a skip: a preview
  // that silently drops a picture is a different post from the kit's.
  if (!p) throw new Error(`No downloaded ${what} for ${id}`);
  return p;
};

async function renderVideo(plan: VideoRenderPlan, inputs: LocalInputs, dir: string, deadline: number): Promise<LocalRender> {
  const frame = { width: plan.width, height: plan.height, fps: RENDER_FPS };
  const sources: string[] = [];
  for (const [i, p] of plan.positions.entries()) {
    if (p.kind === "clip") { sources.push(need(inputs.clips, p.assetId, "clip")); continue; }
    const cropped = join(dir, `frame-${i}.jpg`);
    await framePhoto(need(inputs.photos, p.assetId, "photo"), cropped, frame, plan.cropToFill, "jpeg", left(deadline, "a photo"));
    sources.push((await encodeStill(cropped, dir, i, p.holdSec!, frame, left(deadline, "a held photo"))).path);
  }
  let overlay: ClipOverlay | null = null;
  if (plan.overlay) {
    const band = await renderCaptionBand(plan.overlay, frame, { safe: true });
    if (band.png.length > OVERLAY_MAX_BYTES) throw new Error("The overlay line is too large to draw");
    const source = join(dir, "overlay.png");
    await writeFile(source, band.png);
    overlay = { source, y: band.y };
  }
  // Measured over what will PLAY — from the top of the bed, for as long as the cut runs (finishing.ts).
  const gain = inputs.bedPath ? bedGainDb(await measureLoudness(inputs.bedPath, { startSec: 0, durationSec: plan.totalSec }, left(deadline, "the music's loudness"), "post-kit preview")) : null;
  const outputPath = join(dir, "preview.mp4");
  const manifest = await stitch(stitchRequestFor(plan, { sources, overlay, bedPath: inputs.bedPath, bedGainDb: gain }, outputPath, left(deadline, "the cut")));

  const { starts } = timelineOf(plan.positions);
  const coverAt = Math.min(starts[plan.cover.position] + plan.cover.offsetSec, Math.max(0, manifest.output.durationSec - 1 / RENDER_FPS));
  const coverPath = join(dir, "preview.cover.jpg");
  await ffmpeg(coverStillArgs(outputPath, coverAt, coverPath), left(deadline, "the cover"), "cover still");
  return {
    outputs: [{
      path: outputPath, kind: "video", contentType: "video/mp4", width: manifest.output.width, height: manifest.output.height,
      durationSec: manifest.output.durationSec, sourceAssetId: plan.positions[0].assetId,
    }],
    cover: { outputIndex: 0, path: coverPath },
  };
}

async function renderSlides(plan: SlidesRenderPlan, inputs: LocalInputs, dir: string, deadline: number): Promise<LocalRender> {
  const frame = { width: plan.width, height: plan.height };
  const outputs: LocalOutput[] = [];
  let coverPath: string | null = null;
  for (const [i, p] of plan.positions.entries()) {
    if (p.kind === "still") {
      const png = join(dir, `slide-${i}.png`);
      const jpg = join(dir, `slide-${i}.jpg`);
      await framePhoto(need(inputs.photos, p.assetId, "photo"), png, frame, plan.cropToFill, "png", left(deadline, "a photo"));
      await ffmpeg(pictureArgs(png, jpg, plan.look), left(deadline, "a picture"), "picture");
      outputs.push({ path: jpg, kind: "image", contentType: "image/jpeg", width: plan.width, height: plan.height, durationSec: null, sourceAssetId: p.assetId });
      continue;
    }
    const mp4 = join(dir, `slide-${i}.mp4`);
    const manifest = await stitch(slideRequestFor(plan, i, need(inputs.clips, p.assetId, "clip"), mp4, left(deadline, "a clip slide")));
    outputs.push({
      path: mp4, kind: "video", contentType: "video/mp4", width: manifest.output.width, height: manifest.output.height,
      durationSec: manifest.output.durationSec, sourceAssetId: p.assetId,
    });
    if (i === plan.cover.position) {
      coverPath = join(dir, `slide-${i}.cover.jpg`);
      const at = Math.min(plan.cover.offsetSec, Math.max(0, manifest.output.durationSec - 1 / RENDER_FPS));
      await ffmpeg(coverStillArgs(mp4, at, coverPath), left(deadline, "the cover"), "cover still");
    }
  }
  return { outputs, cover: { outputIndex: plan.cover.position, path: coverPath } };
}

/** Carry out a (conformed) plan in `dir`. Every file it writes is in `dir`, which the caller disposes. */
export function renderLocal(plan: RenderPlan, inputs: LocalInputs, dir: string, deadline: number): Promise<LocalRender> {
  return plan.output === "video" ? renderVideo(plan, inputs, dir, deadline) : renderSlides(plan, inputs, dir, deadline);
}
