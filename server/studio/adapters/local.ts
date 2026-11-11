/**
 * studio/adapters/local — the in-process provider (PR 19, S-7; ADI-R19-S). It serves ONE task, `image.crop`: a window of
 * her own photograph, cut by sharp. No model, no network beyond reading her photo, $0.
 *
 * It is an adapter, not a side door, on purpose: the crop runs through the router like every generation, so it has a
 * quote, a job, a consumed approval, and the standard cost line written at the router's one door (studio/router.ts,
 * `recordGeneration`) with the caller's join keys — PR 11's joins hold for a $0 line as for any other.
 *
 * ─── THE TERMS (ADI-R19-S) ──────────────────────────────────────────────────────────────────────────────
 *
 *   EXIF first      `.rotate()` before `.extract()`, one pipeline: the window is cut from the UPRIGHT photo, and the
 *                   upright size is checked against the planned one before any pixel is cut.
 *   Never upscale   the window lies inside the upright photo by construction (studio/crop.ts) and is cut at its own
 *                   pixel size; nothing is resized.
 *   The format      kept: a PNG stays PNG, a WebP stays WebP, everything else is JPEG at quality 95 with no chroma
 *                   subsampling. The colour profile is kept (`keepIccProfile`); the rest of the metadata is not.
 *   Its own guard   the output must be EXACTLY the planned window, or the run fails — the crop's guard in place of
 *                   the edit's aspect guard, which a crop changes by design (R-12).
 *
 * `cropToAspect` (studio/video/firstFrame.ts) is not called: it encodes JPEG at 88, drops the profile, and without a
 * focus box takes a saliency window that no quote could plan. Its window math (`windowFor`) is what studio/crop.ts
 * reuses.
 */
import sharp from "sharp";
import { safeFetch } from "../../lib/safeFetch";
import { httpTimeoutMs } from "../config";
import { estimateCost } from "../pricing";
import {
  GenerationError,
  type GenerationAdapter,
  type GenerationInputs,
  type GenerationResult,
  type GenerationTask,
  type ImageRef,
  type ProviderOpts,
} from "../types";

/** The JPEG quality a crop is written at: over the ruling's floor of 90. */
export const CROP_JPEG_QUALITY = 95;

async function bytesOf(ref: ImageRef, opts: ProviderOpts): Promise<Buffer> {
  if (ref.kind === "bytes") return ref.bytes;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error("timeout")),
    opts.timeoutMs ?? httpTimeoutMs(),
  );
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A signed storage url for her photo — safeFetch, as vertex reads one (https only, redirects pinned).
    const res = await safeFetch(ref.url, { signal: ctrl.signal });
    if (!res.ok)
      throw new GenerationError(
        `Could not read the photo to crop (${res.status})`,
        "invalid_input",
        "local",
      );
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * THE CROP'S OWN GUARD (ADI-R19-S): the output is EXACTLY the planned window, or the run fails. ⚠️ MUTATION M-CRguard:
 * let a wrong size through — "a crop that is not its planned window fails" reds by name.
 */
export function assertIsWindow(
  out: { width: number; height: number },
  win: { width: number; height: number },
): void {
  if (out.width !== win.width || out.height !== win.height) {
    throw new GenerationError(
      `The crop came back ${out.width}x${out.height}, not its planned ${win.width}x${win.height} window`,
      "provider_error",
      "local",
    );
  }
}

/** Cut the planned window from her photo. Exported for the crop's own tests. */
export async function cutWindow(
  input: Buffer,
  win: NonNullable<GenerationInputs["crop"]>,
): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number }> {
  const meta = await sharp(input).metadata();
  const sideways = (meta.orientation ?? 1) >= 5;
  const uprightWidth = sideways ? meta.height : meta.width;
  const uprightHeight = sideways ? meta.width : meta.height;
  if (
    uprightWidth !== win.uprightWidth ||
    uprightHeight !== win.uprightHeight
  ) {
    throw new GenerationError(
      `The photo is ${uprightWidth}x${uprightHeight} upright, not the ${win.uprightWidth}x${win.uprightHeight} this crop was quoted for`,
      "invalid_input",
      "local",
    );
  }
  const cut = sharp(input)
    .rotate()
    .extract({
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
    })
    .keepIccProfile();
  const [encoded, mimeType] =
    meta.format === "png"
      ? [cut.png(), "image/png"]
      : meta.format === "webp"
        ? [cut.webp({ quality: CROP_JPEG_QUALITY }), "image/webp"]
        : [
            cut.jpeg({
              quality: CROP_JPEG_QUALITY,
              chromaSubsampling: "4:4:4",
            }),
            "image/jpeg",
          ];
  const out = await encoded.toBuffer({ resolveWithObject: true });
  assertIsWindow(out.info, win);
  return {
    bytes: out.data,
    mimeType,
    width: out.info.width,
    height: out.info.height,
  };
}

export const localAdapter: GenerationAdapter = {
  name: "local",
  supports: (task: GenerationTask) => task === "image.crop",
  estimate: (_task, inputs, model, opts) => estimateCost(inputs, model, opts),
  async generate(task, inputs, model, opts): Promise<GenerationResult> {
    const startedAt = new Date();
    const ref = inputs.references?.[0];
    if (task !== "image.crop" || !inputs.crop || !ref) {
      throw new GenerationError(
        "image.crop needs her photo and its planned window",
        "invalid_input",
        "local",
      );
    }
    const asset = await cutWindow(await bytesOf(ref, opts), inputs.crop);
    const completedAt = new Date();
    return {
      task,
      provider: "local",
      model,
      assets: [asset],
      // $0, and known exactly: nothing was billed.
      cost: { ...estimateCost(inputs, model, opts), basis: "reported" },
      timings: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        ms: completedAt.getTime() - startedAt.getTime(),
      },
      raw: { crop: inputs.crop },
    };
  },
};
