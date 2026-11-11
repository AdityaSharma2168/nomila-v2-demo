/**
 * studio/qa/drift — did her face change ACROSS a clip? (PR 17, R-6). Display only; never a check.
 *
 * ─── (a) SELF-CONSISTENCY, RULER-TOLERANT ──────────────────────────────────────────────────────
 *
 * Frames at the clip's beat boundaries (`metadata.vision.beats[].start_s / end_s`, written by PR 9.5's
 * clip read) → one face box and one embed per frame → the distance between each frame and the one
 * before it. The series is reported with its median and its largest step. A step far above the
 * median is DRIFT: something about her face changed more at that beat than it does between any
 * two neighbouring beats. Camera, light and framing are held constant by construction across ONE
 * clip, which is exactly the confound that killed the cross-photograph version of this instrument —
 * so a within-clip step is the one comparison a semantic embedding can be trusted to rank. It is
 * still a RANKING: no multiplier here decides anything (the ledger's P-drift multiplier is a
 * prediction for a probe, not a product rule).
 *
 * ─── (b) IS-IT-HER, ONLY WHEN HER CONTROL PASSED ──────────────────────────────────────────────
 *
 * Each frame against up to four anchors from her pack. Computed and written ONLY when the caller
 * hands anchors, and the caller hands them only when `bandFor` answered (control_passed = true).
 * For anyone else this field is ABSENT — not null, not empty, not captioned — so a surface cannot
 * render a stranger-blind number as if it meant her. ⚠️ MUTATION (drift.test "is-it-her shown for
 * an athlete whose control failed"): compute it from the pack regardless of the control.
 *
 * ─── FRAMES ────────────────────────────────────────────────────────────────────────────────────
 *
 * 9.5 grabs NO frames (it sends the mp4 to the model), so this cuts its own: ONE ffmpeg pass at the
 * beat stamps, ≤ DRIFT_MAX_FRAMES, on the same temp file inspectClip already wrote. A clip with no
 * beats reuses the dense strip inspectClip already holds — never a second pass — picking ≤ 8 frames
 * evenly along it. The embeds are the spend; ffmpeg and sharp are $0.
 *
 * Nothing about her face is kept: vectors live in this function's frame and die with it.
 */
import { readFile } from "fs/promises";

import { SpendMeter, type QaSpend } from "./cost";
import { embedImageBytes, embeddingDistance } from "./embed";
import { faceCrop } from "./face";
import { extractStrip, type FrameStrip } from "../video/frames";

export const DRIFT_MAX_FRAMES = 8;
export const DRIFT_ANCHORS = 4;

export const DRIFT_CAPTION = "Observation only, not a check" as const;
export const DRIFT_CAVEAT =
  "Frame-to-frame face distance within one clip, on multimodalembedding@001. A step above the clip's median is worth a look; no threshold is asserted and nothing acts on it.";

export interface DriftFrame {
  timeSec: number;
  /** Distance from the previous frame WITH a face; null on the first, and where either face is missing. */
  stepFromPrev: number | null;
  face: { confidence: number; sizeFrac: number; small: boolean } | null;
  /** Mean distance to her pack anchors — present only when `isHer` is. */
  toAnchorsMean?: number | null;
}

export interface DriftObservation {
  method: "face-crop/multimodalembedding@001";
  caption: typeof DRIFT_CAPTION;
  caveat: string;
  /** Where the frames came from: the clip's beats, or the strip when it had none. */
  framesFrom: "beats" | "strip";
  frames: DriftFrame[];
  /** Over the steps that exist. Null with fewer than one step. */
  medianStep: number | null;
  maxStep: number | null;
  /** The frame the largest step landed ON. */
  maxStepAtSec: number | null;
  /** maxStep / medianStep — the ranking number. Null when either is missing or the median is 0. */
  maxOverMedian: number | null;
  /**
   * (b). ABSENT unless her stranger control passed. `anchors` is how many pack photographs produced
   * a face vector for this run.
   */
  isHer?: { anchors: number; caveat: string };
  spend: QaSpend;
  latencyMs: number;
}

export interface Beat {
  start_s?: unknown;
  end_s?: unknown;
}

/** The stamps a clip's beats name, clipped to the clip, deduplicated, ≤ DRIFT_MAX_FRAMES. */
export function beatStamps(
  beats: unknown,
  durationSec: number,
  max = DRIFT_MAX_FRAMES,
): number[] {
  if (!Array.isArray(beats) || beats.length === 0) return [];
  const raw: number[] = [];
  for (const b of beats as Beat[]) {
    if (typeof b?.start_s === "number" && Number.isFinite(b.start_s))
      raw.push(b.start_s);
    if (typeof b?.end_s === "number" && Number.isFinite(b.end_s))
      raw.push(b.end_s);
  }
  const inside = raw
    .map((t) => Math.min(Math.max(0, t), Math.max(0, durationSec - 0.05)))
    .map((t) => Number(t.toFixed(2)));
  const uniq = [...new Set(inside)].sort((a, b) => a - b);
  return thin(uniq, max);
}

/** Keep first and last, and spread the rest evenly, so a long list never loses its ends. */
export function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < max; i++)
    out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Number(((s[mid - 1] + s[mid]) / 2).toFixed(4));
};

export interface DriftInput {
  assetId: string;
  /** The clip on disk — inspectClip's temp file. Local path only (frames.ts refuses a url). */
  clipPath: string;
  durationSec: number;
  /** `metadata.vision.beats`, as stored. Anything else reads as "no beats". */
  beats: unknown;
  /** inspectClip's dense strip, reused when there are no beats. */
  strip: FrameStrip;
  /**
   * Her pack anchors' bytes — ONLY when her control passed. The caller decides; this module never
   * reads the profile. Empty or absent → no is-it-her.
   */
  anchors?: { assetId: string; bytes: Buffer; mimeType: string }[];
}

/**
 * Never throws: the clip is paid for and stored. Any failure logs at the caller and yields null.
 */
export async function observeDrift(
  input: DriftInput,
): Promise<DriftObservation | null> {
  const started = Date.now();
  const meter = new SpendMeter();
  const stamps = beatStamps(input.beats, input.durationSec);

  let framesFrom: DriftObservation["framesFrom"];
  let frames: { timeSec: number; path: string }[];
  let own: FrameStrip | null = null;
  if (stamps.length >= 2) {
    framesFrom = "beats";
    own = await extractStrip(input.clipPath, {
      kind: "stamps",
      seconds: stamps,
    });
    frames = own.frames.map((f) => ({ timeSec: f.timeSec, path: f.path }));
  } else {
    framesFrom = "strip";
    frames = thin(input.strip.frames, DRIFT_MAX_FRAMES).map((f) => ({
      timeSec: f.timeSec,
      path: f.path,
    }));
  }
  try {
    if (frames.length < 2) return null;

    // Anchors first (b), only if handed — one face box + one embed each, vectors in memory.
    const anchorVecs: number[][] = [];
    for (const a of input.anchors ?? []) {
      const r = await faceCrop(a.bytes, a.mimeType, "drift:anchor", a.assetId);
      meter.vision(r.usage);
      if (!r.crop) continue;
      const v = await embedImageBytes(r.crop.bytes, a.assetId);
      meter.embed(1);
      if (v) anchorVecs.push(v);
    }
    const withAnchors = (input.anchors?.length ?? 0) > 0;

    // Sequential, like videoClip: a burst of face boxes against one project's quota buys nothing here.
    const out: DriftFrame[] = [];
    const vecs: (number[] | null)[] = [];
    for (const f of frames) {
      let bytes: Buffer;
      try {
        bytes = await readFile(f.path);
      } catch {
        out.push({ timeSec: f.timeSec, stepFromPrev: null, face: null });
        vecs.push(null);
        continue;
      }
      const r = await faceCrop(
        bytes,
        "image/jpeg",
        "drift:frame",
        input.assetId,
      );
      meter.vision(r.usage);
      let v: number[] | null = null;
      if (r.crop) {
        v = await embedImageBytes(r.crop.bytes, input.assetId);
        meter.embed(1);
      }
      vecs.push(v);
      const prev = [...vecs.slice(0, -1)].reverse().find((x) => x) ?? null;
      const step =
        v && prev ? Number(embeddingDistance(prev, v).toFixed(4)) : null;
      const frame: DriftFrame = {
        timeSec: f.timeSec,
        stepFromPrev: step,
        face: r.crop
          ? {
              confidence: r.crop.confidence,
              sizeFrac: Number(r.crop.sizeFrac.toFixed(4)),
              small: r.crop.small,
            }
          : null,
      };
      if (withAnchors) {
        frame.toAnchorsMean =
          v && anchorVecs.length
            ? Number(
                (
                  anchorVecs.reduce(
                    (acc, a) => acc + embeddingDistance(a, v),
                    0,
                  ) / anchorVecs.length
                ).toFixed(4),
              )
            : null;
      }
      out.push(frame);
    }

    const steps = out.flatMap((f) =>
      f.stepFromPrev === null ? [] : [f.stepFromPrev],
    );
    const med = median(steps);
    const max = steps.length ? Math.max(...steps) : null;
    const at =
      max === null
        ? null
        : (out.find((f) => f.stepFromPrev === max)?.timeSec ?? null);

    return {
      method: "face-crop/multimodalembedding@001",
      caption: DRIFT_CAPTION,
      caveat: DRIFT_CAVEAT,
      framesFrom,
      frames: out,
      medianStep: med,
      maxStep: max,
      maxStepAtSec: at,
      maxOverMedian:
        med !== null && med > 0 && max !== null
          ? Number((max / med).toFixed(2))
          : null,
      ...(withAnchors
        ? {
            isHer: {
              anchors: anchorVecs.length,
              caveat:
                "Each frame's mean distance to her pack anchors, on the same ruler. Shown only because her stranger control passed; still an observation.",
            },
          }
        : {}),
      spend: meter.total(),
      latencyMs: Date.now() - started,
    };
  } finally {
    if (own) await own.dispose();
  }
}
