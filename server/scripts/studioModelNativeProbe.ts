/**
 * studioModelNativeProbe — PR-0, the capability probe.
 *
 * Answers ONE question per section: does Nano Pro do this job model-natively, on the full frame,
 * with no SAM and no compositing — or does it stay on the masked pipeline?
 *
 *   Q1  two-image add-object          direct router, bypasses classify/autoMask/composite
 *   Q2  background swap               direct router, compared against sweep 4.2
 *   Q3  compound edit in one call     direct router, two cells only
 *   Q4  rim deconfound                THE NORMAL MASKED PIPELINE (runStudioGeneration)
 *   Q5  recolor head-to-head          BOTH — the masked pipeline AND full-frame direct, 1008px source
 *   Q5L the owed 4000px arm of Q5     the same two arms and prompts on 5581e882 (PR N, item N.1)
 *   Q6  text rendered in-model        direct router, two cells (T1 banner, T2 logo + wordmark), Q1 frame
 *   Q7  a CLEAN removal, full-frame   direct router, the PRODUCT'S OWN compiled instruction, --src-q7
 *
 * DRY RUN IS THE DEFAULT. Every section prints its plan and its quote and makes no billable call
 * until `--run`, and `--cap` refuses to start a call that would carry cumulative spend past it.
 *
 *   npx tsx --require dotenv/config server/scripts/studioModelNativeProbe.ts --q 1
 *   npx tsx --require dotenv/config server/scripts/studioModelNativeProbe.ts --q 1 --run
 *   npx tsx --require dotenv/config server/scripts/studioModelNativeProbe.ts --cell q1-a --run
 *   npx tsx --require dotenv/config server/scripts/studioModelNativeProbe.ts --q 5L --run --cap 2
 *   npx tsx --require dotenv/config server/scripts/studioModelNativeProbe.ts --sheet 5L
 *
 * ─── WHAT THIS SCRIPT IS NOT ────────────────────────────────────────────────────────────────────
 *
 * It is not a product path and nothing here should ever be imported by one. Q1-Q3 deliberately
 * skip every guard the real pipeline has — no classifier, no person guard, no region derivation,
 * no composite — because the question is what the MODEL does when nothing protects the frame.
 * Q4 is the opposite: it runs the real thing end to end, because the question there is about our
 * geometry rather than the model's behaviour.
 *
 * ─── WHY Q1 SETS SLOTS EXPLICITLY ───────────────────────────────────────────────────────────────
 *
 * `refOrder.ts` is the only thing that makes "the second image" a true sentence: SLOT_ORDER puts
 * `frame` before `object`, and position IS the addressing scheme because the provider has no typed
 * reference field. Sweep 7.2 observed the UI getting this backwards (the ball tagged source-frame,
 * the athlete tagged portrait). This script sets the slots itself, so Q1 measures the MODEL and not
 * that bug — which is why a Q1 pass does not make PR R optional.
 */
import { writeFile, mkdir, appendFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { generate, estimate } from "../studio/router";
import {
  compileNativeInstruction,
  preservationClause,
} from "../studio/compile";
// The content-bounds aligner the QA stage ships (wave B, addition (a)) — the probe reads the frame with
// the same instrument the record will, so a number here and a number there mean the same thing.
import { alignContent } from "../studio/qa/framing";
import {
  smallestImageSizeFor,
  imageSizeParams,
  routeFor,
  vertexModelFor,
  MODELS,
} from "../studio/config";
import type { GenerationInputs, ImageRef, RefSlot } from "../studio/types";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "6"));
const OUT_DIR = arg("out", "probe-out")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;

// ─── Sources ────────────────────────────────────────────────────────────────────────────────────
//
// media_assets UUIDs. Resolved read-only, under this athlete's id, and never written.

const SRC = {
  /** 1008x1476. Sweep 1.1/1.3a/1.4/2.4b/3.1/4.1. The small-source arm of the rim matrix. */
  small: arg("src-small", "afc78262-f4ce-4637-bc26-658b5f63ca0e")!,
  /** 4000x6000, orientation 8. Sweep 1.2/4.2 — the green-halo case. */
  halo: arg("src-halo", "a81be2c0-4755-49fe-ab18-2e28dd05f563")!,
  /** 4000x6000. Sweep 1.3b/4.3. The full-res arm of the rim matrix. */
  large: arg("src-large", "5581e882-fae1-4255-8951-4c037275e29e")!,
  /** The soccer ball reference. */
  ball: arg("ref-ball", "e64e900a-8d63-458b-a631-cb09567c9c1d")!,
  /** The water bottle reference — the positive control. */
  bottle: arg("ref-bottle", "")!,
  /**
   * Q7's frame. NO DEFAULT ON PURPOSE — Q7 measures what a removal leaves behind, so the frame has to
   * be one where the thing REMOVED casts a visible shadow and sits in light the rest of the frame
   * shares. No frame already in this file is known to satisfy that, and picking one that does not
   * would produce a clean-looking result that answers nothing. Pass `--src-q7 <assetId|path>` with
   * `--q7-target`, or Q7 skips and says so.
   */
  q7: arg("src-q7", "")!,
};

/** What Q7 removes, as the classifier's target — the noun alone, no determiner. */
const Q7_TARGET = arg("q7-target", "goalpost")!;

// ─── Reference resolution — READ ONLY ───────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Resolved {
  ref: ImageRef;
  /** Local path when the reference came off disk, GCS path when it came out of the table. */
  origin: string;
  width: number;
  height: number;
  bytes: Buffer;
}

/**
 * An asset id, a gs:// path or a local file → bytes we can both send and diff against.
 *
 * Bytes rather than a signed url on purpose: the patch diff needs the exact pixels the model was
 * given, and a url would leave this script measuring against a second fetch of the same object.
 */
async function resolveRef(idOrPath: string, slot: RefSlot): Promise<Resolved> {
  let bytes: Buffer;
  let origin: string;

  if (UUID_RE.test(idOrPath)) {
    const { db } = await import("../db");
    const { mediaAssets } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const { signedUrl } = await import("../lib/mediaStore");
    // TENANCY: the athlete id is in the predicate, not checked after the fact.
    const [row] = await db
      .select({ path: mediaAssets.gcs_path })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, idOrPath),
          eq(mediaAssets.athlete_id, ATHLETE_ID),
        ),
      )
      .limit(1);
    if (!row?.path)
      throw new Error(
        `No stored pixels for asset ${idOrPath} under this athlete`,
      );
    origin = row.path;
    const res = await fetch(await signedUrl(row.path));
    if (!res.ok) throw new Error(`Fetch ${row.path} failed: ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    const { readFile } = await import("fs/promises");
    origin = idOrPath;
    bytes = await readFile(idOrPath);
  }

  // EXIF-normalized, because the model ignores orientation (studio/orient.ts measured it) and the
  // patch diff would otherwise compare a rotated source against an upright output.
  const upright = await sharp(bytes).rotate().toBuffer();
  const meta = await sharp(upright).metadata();
  return {
    ref: {
      kind: "bytes",
      bytes: upright,
      mimeType: `image/${meta.format ?? "jpeg"}`,
      slot,
    },
    origin,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes: upright,
  };
}

// ─── The frame-preservation measurement ─────────────────────────────────────────────────────────
//
// ⚠️ "UNCHANGED" NEEDS A CONTROL OR IT IS NOT A NUMBER. `imageSize` caps AREA and redistributes it
// by aspect ratio (studio/config.ts SIZE_PIXELS: a 4000x6000 frame asked for 4K came back
// 3392x5056), so the output is NEVER the source's dimensions and every patch diff includes a
// resample that the model had nothing to do with.
//
// So each patch is reported twice:
//
//   modelDiff     source patch  vs  output resized back to source dimensions
//   resampleDiff  source patch  vs  source round-tripped through the output's dimensions
//
// `resampleDiff` is the floor — what this measurement reads on a hypothetical model that changed
// nothing at all. Only the gap between them is the model's doing. A modelDiff at or under its
// resampleDiff is "unchanged" as precisely as this method can say it.

interface PatchResult {
  patch: string;
  modelDiff: number;
  resampleDiff: number;
  excess: number;
}

/** Three 200x200 windows, placed away from the lower-centre where every Q1 insertion lands. */
const PATCHES: Array<{ name: string; fx: number; fy: number }> = [
  { name: "top-left", fx: 0.04, fy: 0.04 },
  { name: "top-right", fx: 0.74, fy: 0.04 },
  { name: "mid-left", fx: 0.04, fy: 0.34 },
];

const PATCH_PX = 200;

async function meanAbsDiff(a: Buffer, b: Buffer): Promise<number> {
  // ⚠️ removeAlpha() ON BOTH SIDES, ALWAYS. The sources are PNGs with an alpha channel and the
  // outputs come back 3-channel. Comparing an RGBA buffer against an RGB one walks two different
  // strides down the same index and produces large, stable, entirely meaningless numbers — it read
  // 52-79 "excess" on frames whose true difference was JPEG noise. Normalize, then compare.
  const [ra, rb] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (ra.data.length !== rb.data.length) {
    throw new Error(
      `meanAbsDiff got mismatched buffers (${ra.data.length} vs ${rb.data.length}) — ` +
        `${ra.info.width}x${ra.info.height}x${ra.info.channels} vs ${rb.info.width}x${rb.info.height}x${rb.info.channels}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < ra.data.length; i++)
    sum += Math.abs(ra.data[i] - rb.data[i]);
  return ra.data.length ? Number((sum / ra.data.length).toFixed(3)) : NaN;
}

async function patchDiffs(
  srcBytes: Buffer,
  srcW: number,
  srcH: number,
  outBytes: Buffer,
): Promise<{
  outWidth: number;
  outHeight: number;
  aspectDeltaPct: number;
  patches: PatchResult[];
}> {
  const outMeta = await sharp(outBytes).metadata();
  const outW = outMeta.width ?? 0;
  const outH = outMeta.height ?? 0;

  const aspectDeltaPct = Number(
    ((Math.abs(outW / outH - srcW / srcH) / (srcW / srcH)) * 100).toFixed(3),
  );

  // Everything below is 3-channel from here down — see meanAbsDiff for what mixing strides cost.
  const src3 = await sharp(srcBytes).removeAlpha().png().toBuffer();
  const out3 = await sharp(outBytes).removeAlpha().png().toBuffer();

  // The output, brought back to the source's grid.
  const outAligned = await sharp(out3)
    .resize(srcW, srcH, { fit: "fill" })
    .toBuffer();
  // The source, through the SAME two resamples, having changed nothing. This is the floor.
  //
  // ⚠️ TWO PIPELINES, NOT TWO .resize() CALLS. sharp does not CHAIN resizes — a second .resize()
  // on the same pipeline REPLACES the first. Written as one chain this silently became "resize the
  // source to its own dimensions", i.e. a no-op, and the control read exactly 0.000 on every patch
  // of every cell. A control that is always zero looks like a clean result and is worth nothing;
  // it made `excess` a copy of `modelDiff`. Materialize the upscale, then downscale the result.
  const srcUp = await sharp(src3)
    .resize(outW, outH, { fit: "fill" })
    .toBuffer();
  const srcRoundTrip = await sharp(srcUp)
    .resize(srcW, srcH, { fit: "fill" })
    .toBuffer();

  const patches: PatchResult[] = [];
  for (const p of PATCHES) {
    const left = Math.min(
      Math.round(srcW * p.fx),
      Math.max(0, srcW - PATCH_PX),
    );
    const top = Math.min(Math.round(srcH * p.fy), Math.max(0, srcH - PATCH_PX));
    const w = Math.min(PATCH_PX, srcW);
    const h = Math.min(PATCH_PX, srcH);
    const box = { left, top, width: w, height: h };

    // Extract as PNG rather than raw, so meanAbsDiff re-decodes a real image instead of us
    // re-declaring a channel count by hand. The hand-declared `channels: 3` was the other half of
    // the stride bug.
    const cut = (buf: Buffer) =>
      sharp(buf).extract(box).removeAlpha().png().toBuffer();
    const [srcPatch, outPatch, rtPatch] = await Promise.all([
      cut(src3),
      cut(outAligned),
      cut(srcRoundTrip),
    ]);
    const modelDiff = await meanAbsDiff(srcPatch, outPatch);
    const resampleDiff = await meanAbsDiff(srcPatch, rtPatch);
    patches.push({
      patch: `${p.name}@${left},${top}`,
      modelDiff,
      resampleDiff,
      excess: Number((modelDiff - resampleDiff).toFixed(3)),
    });
  }
  return { outWidth: outW, outHeight: outH, aspectDeltaPct, patches };
}

// ─── Spend accounting ───────────────────────────────────────────────────────────────────────────

let spentUsd = 0;

function assertBudget(nextUsd: number, cell: string): void {
  if (spentUsd + nextUsd > CAP_USD) {
    throw new Error(
      `BUDGET STOP before ${cell}: $${spentUsd.toFixed(4)} spent, next call quotes $${nextUsd.toFixed(4)}, ` +
        `cap is $${CAP_USD}. Raise --cap deliberately or stop here.`,
    );
  }
}

async function logRun(entry: Record<string, unknown>): Promise<void> {
  await appendFile(
    join(OUT_DIR, "runs.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

// ─── The direct arm — Q1, Q2, Q3 ────────────────────────────────────────────────────────────────

interface DirectCell {
  id: string;
  question: string;
  prompt: string;
  /** Frame first, then any object reference. Slots are set here, never left to insertion order. */
  frame: keyof typeof SRC;
  object?: keyof typeof SRC;
  /** Q1 only — the frame-preservation measurement is meaningless where the whole frame changes. */
  measurePatches: boolean;
  /**
   * Q7 — the CONTENT BOUNDS, on top of the patch windows (wave B, addition (a)'s instrument).
   *
   * The patches answer "did the light drift where nothing was asked"; they cannot answer "is the whole
   * photograph 11% smaller than it was", because a window compared against a resampled control reads a
   * reframe as diffuse difference everywhere rather than as geometry. Probe 1 built an instrument for
   * exactly that question, and it now SHIPS as studio/qa/framing.ts — so this imports the product's
   * own aligner rather than carrying a second copy, and the probe and the QA record cannot disagree.
   */
  measureBounds?: boolean;
  /**
   * An explicit output ratio, e.g. "2:3". Rides in generationConfig.imageConfig.aspectRatio
   * (studio/adapters/vertex.ts). Left unset the model picks, and Q1's first round showed it picking
   * SQUARE whenever a square object reference was attached — see q1-a-ratio.
   */
  aspect?: string;
}

/**
 * Q7's prompt: the instruction the PRODUCT compiles for a one-target removal, or that instruction with
 * the preservation clause taken off.
 *
 * Built from `compileNativeInstruction` over a minimal version-1 intent rather than written out here,
 * so the cell measures the shipped wording and moves with it. With `keepScene` false the preservation
 * sentence is stripped from the END of the compiled string — `preservationClause` is what put it there,
 * so the same function says exactly what to remove, and nothing is matched by hand.
 */
function compiledRemoval(target: string, keepScene: boolean): string {
  const full = compileNativeInstruction({
    version: 1,
    initialPath: "MASKED",
    steps: [
      { op: "REMOVE_OBJECT", targets: [target], value: null, scope: "REGION" },
    ],
    changes: [{ op: "REMOVE_OBJECT", target, change: null }],
    imageSize: "2K",
  });
  if (keepScene) return full;
  const clause = preservationClause(["REMOVE_OBJECT"]);
  return clause ? full.replace(` ${clause}`, "") : full;
}

const DIRECT_CELLS: DirectCell[] = [
  // ─── Q1 — two-image add-object, the mandate ────────────────────────────────────────────────
  {
    id: "q1-a",
    question: "Q1",
    frame: "small",
    object: "ball",
    measurePatches: true,
    prompt:
      "add the soccer ball from the second image, place it between her cleats",
  },
  {
    id: "q1-b",
    question: "Q1",
    frame: "small",
    object: "ball",
    measurePatches: true,
    prompt: "place this ball at her feet",
  },
  {
    id: "q1-c",
    question: "Q1",
    frame: "small",
    object: "ball",
    measurePatches: true,
    prompt:
      "put the soccer ball from the second image on the grass beside her right foot",
  },
  // No reference at all — isolates whether the ref helps or the model is happy to invent one.
  {
    id: "q1-d",
    question: "Q1",
    frame: "small",
    measurePatches: true,
    prompt: "add a soccer ball at her feet",
  },
  // POSITIVE CONTROL. Reproduced cleanly on nano pro months ago. If this fails, the prompt shape is
  // wrong and Q1's other four cells say nothing about the capability.
  {
    id: "q1-e-control",
    question: "Q1",
    frame: "small",
    object: "bottle",
    measurePatches: true,
    prompt: "place the water bottle from the second image on top of her head",
  },

  // Q1's first round returned SQUARE from all three ball cells (aspect delta 46.4%) while the
  // portrait bottle ref and the no-ref cell both held the frame within 2%. The one thing the square
  // outputs share is a SQUARE 700x700 object reference. This pins the ratio and changes nothing
  // else, so a 2:3 result says the reframing is ours to control and a square result says it is not.
  {
    id: "q1-a-ratio",
    question: "Q1",
    frame: "small",
    object: "ball",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "add the soccer ball from the second image, place it between her cleats",
  },

  // ─── Q2 — background swap, model-native vs the sweep 4.2 composite ─────────────────────────
  {
    id: "q2-a",
    question: "Q2",
    frame: "halo",
    measurePatches: false,
    prompt:
      "change the background to a beach at sunset, keep the person exactly as-is",
  },

  // ─── Q3 — compound edit in one call. TWO CELLS. Not a recolor relitigation. ────────────────
  {
    id: "q3-a",
    question: "Q3",
    frame: "small",
    measurePatches: false,
    prompt: "make the jersey red and the shorts black",
  },
  // ─── Q5 path B — recolor FULL-FRAME, the arm classify.ts:166 falsified ────────────────────
  //
  // ⚠️ THIS IS THE MEASUREMENT THAT NOTE SAYS IT IS WAITING FOR, so the prompt is deliberately the
  // strongest honest version rather than the bare sentence Q3 used. The original falsification ran
  // `STUDIO_GARMENT_MASK=false` through the PRODUCT's prompt, which never had a preservation clause
  // and never pinned a ratio — so "full-image is worse" and "that prompt was worse" were not
  // separated. Here they are: explicit preservation clause, ratio pinned to the source.
  //
  // Both colours per garment on purpose. A two-colour target is a real multi-value directive, which
  // is the exact shape sweep 3.1 collapsed into a bare value on the masked path.
  {
    id: "q5-p1-B-r1",
    question: "Q5",
    frame: "small",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
  },
  {
    id: "q5-p1-B-r2",
    question: "Q5",
    frame: "small",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
  },
  {
    id: "q5-p2-B-r1",
    question: "Q5",
    frame: "small",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the socks blue and green. Keep everything else exactly as-is — change only the socks.",
  },
  {
    id: "q5-p2-B-r2",
    question: "Q5",
    frame: "small",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the socks blue and green. Keep everything else exactly as-is — change only the socks.",
  },

  {
    id: "q3-b",
    question: "Q3",
    frame: "small",
    measurePatches: false,
    prompt: "make the jersey red and add an adidas logo",
  },

  // ─── Q5L path B — the same full-frame cells on the 4000px source ───────────────────────────
  //
  // THE ARM Q5 SAID IT WAS OWED. Q5 ran on the small frame, which Q4 had already measured as the
  // masked path's WEAK arm (band "0+3", rim 58–71%), so a masked loss there was the expected result
  // of the source rather than a verdict on masking. This reruns the identical prompts, ratio and
  // repeat count on 5581e882, where Q4 measured the masked rim at its strongest (82–97%).
  //
  // Nothing about the cell changes except the frame, and that includes the SIZE: runDirect derives it
  // from the frame's pixels through smallestImageSizeFor, which is 4K here (24 MP) where it was 2K on
  // the small source. 4K is also what the native edit path requests for a frame this size, so this
  // arm measures the resolution the product would actually return (~3392x5056), not a cheaper one.
  {
    id: "q5L-p1-B-r1",
    question: "Q5L",
    frame: "large",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
  },
  {
    id: "q5L-p1-B-r2",
    question: "Q5L",
    frame: "large",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
  },
  {
    id: "q5L-p2-B-r1",
    question: "Q5L",
    frame: "large",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the socks blue and green. Keep everything else exactly as-is — change only the socks.",
  },
  {
    id: "q5L-p2-B-r2",
    question: "Q5L",
    frame: "large",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "make the socks blue and green. Keep everything else exactly as-is — change only the socks.",
  },

  // ─── Q6 — does the model render TEXT legibly and correctly spelled? ───────────────────────────
  //
  // ONE verdict, and it decides the ad-treatment feature's architecture: text rendered in-model, or
  // text composited outside the model. The verdict is Adi's, at 1:1, on the saved outputs.
  //
  // Hand-written prompts sent verbatim, because the product path cannot carry them: on b9ad08b both
  // sentences route as CHANGE_BACKGROUND and compile to "change the background to <a phrase from
  // the sentence>". So this measures the MODEL, the way Q1-Q3 do, and says nothing about the
  // classifier's handling of them.
  //
  // Ratio pinned 2:3 — what aspectFor (studio/compile/aspect.ts) asks for on this frame — so the text
  // is not confounded with a reframe. ⚠️ The top-left and top-right patch windows sit exactly where
  // both cells were told to put text. Their excess measures the insertion, not preservation. Only
  // mid-left is a preservation number here.
  {
    id: "q6-t1",
    question: "Q6",
    frame: "small",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "Add a large banner across the top of the background that reads GET LOUD in bold white capital letters. Keep the person, her pose, clothing, lighting and everything else exactly as they are.",
  },
  {
    id: "q6-t2",
    question: "Q6",
    frame: "small",
    measurePatches: true,
    aspect: "2:3",
    prompt:
      "Add a small adidas logo with the words IMPOSSIBLE IS NOTHING beneath it in the upper right corner of the background. Keep everything else exactly as it is.",
  },

  // ─── Q7 — what does a CLEAN removal leave behind on the full-frame path? (wave B, card 1) ─────
  //
  // ⚠️ THE CARD'S CITED REPRO DOES NOT SUPPORT THE CARD, WHICH IS WHY THIS EXISTS. Object removals run
  // unmasked full-frame under STUDIO_NATIVE_EDIT: the masked stack is unreachable for them
  // (studio/preview.ts `wantsCrops` is false for any brief with a frozen intent, and `usesMaskedPath`
  // returns false for one). The drift on asset `c877f259` is attributed by ledger F-L4 to the SENTENCE
  // — main froze REMOVE [goalpost, ball] — and the same line records that "remove the goalpost" alone
  // HELD on that same unmasked path. K2 (#488) fixed the sentence. So before an arm is built to give
  // removals a mask, the question is whether a clean one needs it.
  //
  // What DOES argue for the card is in this file's own memo: Q2's full-frame background swap silently
  // deleted "the white goal net crossing the entire foreground", which nothing asked for, and Q1's
  // frame excess is 2.3–4.5 against a ~1.3 resample floor with one window at 14.8. Those measure a
  // background swap and an add. Neither measures a removal, and a removal is the case where the model
  // must INVENT what was behind the thing — which is exactly when it has most licence to repaint.
  //
  // ─── THE TWO CELLS ARE A PAIR, AND THE SECOND IS THE ONE NOBODY HAS RUN ────────────────────────
  //
  // Both send the PRODUCT'S OWN compiled instruction, built at run time by `compileNativeInstruction`
  // from a frozen REMOVE_OBJECT intent — not a hand-written prompt. So this measures what ships, and
  // it cannot go stale when the template moves. r2 is r1 with the preservation clause removed, and
  // that comparison is owed: compile/preservation.ts says of that clause, in its own header,
  // "REQUIRED-BUT-UNVALIDATED ... nothing has measured it yet". This is the measurement.
  //
  //   q7-r1   compiled removal, preservation clause IN   → does the lighting hold, is the shadow gone
  //   q7-r2   the same, clause STRIPPED                  → does the clause do anything at all
  //
  // ⚠️ READ THE PATCH WINDOWS AND THE PIXELS. The windows say whether light drifted where nothing was
  // asked for; only a 1:1 look says whether the object's cast shadow survived it, which is the half
  // of the card no number here can answer. Outputs are saved, so that read costs nothing extra.
  {
    id: "q7-r1",
    question: "Q7",
    frame: "q7",
    measurePatches: true,
    measureBounds: true,
    prompt: compiledRemoval(Q7_TARGET, true),
  },
  {
    id: "q7-r2",
    question: "Q7",
    frame: "q7",
    measurePatches: true,
    measureBounds: true,
    prompt: compiledRemoval(Q7_TARGET, false),
  },
];

/**
 * Q6's refusal. Its verdict is about the model the product ships, so a local override pointing
 * `image.edit` at Flash or OpenRouter would answer a different question and still look like an
 * answer. Refuses before any spend, the way assertMaskParity does for Q5.
 */
function assertShippedEditModel(): void {
  const r = routeFor("image.edit");
  const model = vertexModelFor(MODELS.nanoPro);
  if (r.provider !== "vertex" || r.model !== model) {
    throw new Error(
      `image.edit resolves to ${r.model} via ${r.provider}, not the shipped ${model} via vertex — ` +
        "a STUDIO_IMAGE*_PROVIDER / _MODEL override is set. Q6 would measure a different model. Refusing to spend.",
    );
  }
}

async function runDirect(cell: DirectCell): Promise<void> {
  if (!SRC[cell.frame]) {
    console.log(`\n── ${cell.id} (${cell.question})`);
    console.log(
      `   SKIPPED — no "${cell.frame}" frame configured. Pass --src-${cell.frame} <assetId|path>.`,
    );
    return;
  }
  if (cell.object && !SRC[cell.object]) {
    console.log(`\n── ${cell.id} (${cell.question})`);
    console.log(
      `   SKIPPED — no "${cell.object}" reference configured. Pass --ref-${cell.object} <assetId|path>.`,
    );
    return;
  }
  const frame = await resolveRef(SRC[cell.frame], "frame");
  const object = cell.object
    ? await resolveRef(SRC[cell.object], "object")
    : null;

  const size = smallestImageSizeFor(frame.width * frame.height);
  const inputs: GenerationInputs = {
    prompt: cell.prompt,
    references: object ? [frame.ref, object.ref] : [frame.ref],
    ...(cell.aspect ? { aspectRatio: cell.aspect } : {}),
  };
  const opts = { providerParams: imageSizeParams(size), noLog: false };

  const plan = estimate("image.edit", inputs, opts);
  const refManifest = [
    `1:frame  ${cell.frame} ${frame.width}x${frame.height}  ${frame.origin}`,
    ...(object
      ? [
          `2:object ${cell.object} ${object.width}x${object.height}  ${object.origin}`,
        ]
      : []),
  ];

  console.log(`\n── ${cell.id} (${cell.question})`);
  console.log(`   prompt   "${cell.prompt}"`);
  refManifest.forEach((l) => console.log(`   ref      ${l}`));
  console.log(
    `   size     ${size}${cell.aspect ? `   aspect ${cell.aspect} (pinned)` : "   aspect (model's choice)"}   model ${plan.model} via ${plan.provider}`,
  );
  console.log(`   quote    $${plan.cost.amountUsd.toFixed(4)}`);

  if (!RUN) {
    console.log("   DRY RUN — no call made.");
    return;
  }

  assertBudget(plan.cost.amountUsd, cell.id);
  const res = await generate("image.edit", inputs, opts);
  spentUsd += res.cost.amountUsd;

  const asset = res.assets[0];
  if (!asset?.bytes) throw new Error(`${cell.id}: provider returned no bytes`);
  const ext = (asset.mimeType.split("/")[1] ?? "png").replace("jpeg", "jpg");
  const outPath = join(OUT_DIR, `${cell.id}.${ext}`);
  await writeFile(outPath, asset.bytes);

  const measurement = cell.measurePatches
    ? await patchDiffs(frame.bytes, frame.width, frame.height, asset.bytes)
    : null;
  // The product's own aligner, at its shipped canvas. ~4s of CPU, no call, no spend.
  const bounds = cell.measureBounds
    ? await alignContent(frame.bytes, asset.bytes)
    : null;

  console.log(
    `   cost     $${res.cost.amountUsd.toFixed(4)}  (${res.cost.basis})   ${res.timings.ms}ms`,
  );
  console.log(`   output   ${outPath}`);
  if (measurement) {
    console.log(
      `   out dims ${measurement.outWidth}x${measurement.outHeight}  aspect delta ${measurement.aspectDeltaPct}%`,
    );
    for (const p of measurement.patches) {
      console.log(
        `   patch    ${p.patch.padEnd(20)} model ${String(p.modelDiff).padStart(7)}  resample ${String(p.resampleDiff).padStart(7)}  excess ${String(p.excess).padStart(7)}`,
      );
    }
  }
  if (bounds) {
    // scale < 1 ⇒ the output's content is SMALLER than the source's, i.e. the frame zoomed out. 1b's
    // four add cells read 0.8651-0.8931 with dy +0.0405-+0.0519; anything inside ~2% is the canvas snap.
    console.log(
      `   bounds   scale ${bounds.scale.toFixed(4)}  dx ${bounds.dxFrac.toFixed(4)}  dy ${bounds.dyFrac.toFixed(4)}  ncc ${bounds.ncc.toFixed(4)} (identity ${bounds.nccAtIdentity.toFixed(4)})`,
    );
  }

  await logRun({
    cell: cell.id,
    question: cell.question,
    kind: "direct",
    prompt: cell.prompt,
    references: refManifest,
    provider: res.provider,
    model: res.model,
    imageSize: size,
    costUsd: res.cost.amountUsd,
    costBasis: res.cost.basis,
    costDetail: res.cost.detail ?? null,
    latencyMs: res.timings.ms,
    outputPath: outPath,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    measurement,
    bounds,
    at: new Date().toISOString(),
  });
}

// ─── Q5 path A — THE REAL MASKED PIPELINE ───────────────────────────────────────────────────────
//
// Same product path Q4 used: assembleBrief → previewGeneration → savePreview → runStudioGeneration,
// with the sweep's flag set forced in-process. NO BAND FORCING — the ramp knob is reverted and the
// erode override is deliberately left unset, so this runs at shipped defaults, which is the only
// setting a masked-vs-full-frame comparison may use.
//
// ⚠️ WRITES REAL ROWS under this athlete. Every asset id lands in docs/probes/probe-cleanup-list.txt.

const CLEANUP_LIST = "docs/probes/probe-cleanup-list.txt";

/** The sweep's flag set, and the refusal that stops a flagless run measuring nothing. See Q4. */
async function assertMaskParity(): Promise<void> {
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_SERVER_ROUTING = "true";
  process.env.STUDIO_GARMENT_MASK = "true";
  process.env.STUDIO_BACKGROUND_MASK = "true";
  process.env.STUDIO_OBJECT_MASK = "false";
  // The masked arm must stay MASKED once the native edit path exists. It could not go native today —
  // native needs an intent frozen by the preview route, and this arm assembles its brief directly —
  // but a parity guard that relies on a second mechanism holding is not a parity guard.
  process.env.STUDIO_NATIVE_EDIT = "false";
  // Never band-force on this question. Q4 forced these; Q5 must not.
  delete process.env.STUDIO_MASK_ERODE_PX;
  delete process.env.STUDIO_MASK_RAMP_PX;
  const { garmentMaskEnabled } = await import("../studio/config");
  if (!garmentMaskEnabled()) {
    throw new Error(
      "STUDIO_GARMENT_MASK is not enabled — the composite would fall back to the rectangle and " +
        'report mask "off" with an EMPTY maskEdgePx. That is not a masked run. Refusing to spend.',
    );
  }
}

interface MaskedCell {
  id: string;
  prompt: string;
  frame: keyof typeof SRC;
  /** Which question the cell answers. Absent on the original Q5 cells, which predate Q5L. */
  question?: string;
}

const Q5_MASKED: MaskedCell[] = [
  {
    id: "q5-p1-A-r1",
    frame: "small",
    prompt: "make the shorts black and green",
  },
  {
    id: "q5-p1-A-r2",
    frame: "small",
    prompt: "make the shorts black and green",
  },
  { id: "q5-p2-A-r1", frame: "small", prompt: "make the socks blue and green" },
  { id: "q5-p2-A-r2", frame: "small", prompt: "make the socks blue and green" },
];

/**
 * Q5L path A — the masked pipeline on the 4000px source, at shipped defaults.
 *
 * Same prompts, same repeat count, same no-band-forcing rule as Q5. Detection is memoized per
 * prompt, so each pair of repeats shares one set of boxes and the repeat measures model variance.
 */
const Q5L_MASKED: MaskedCell[] = [
  {
    id: "q5L-p1-A-r1",
    question: "Q5L",
    frame: "large",
    prompt: "make the shorts black and green",
  },
  {
    id: "q5L-p1-A-r2",
    question: "Q5L",
    frame: "large",
    prompt: "make the shorts black and green",
  },
  {
    id: "q5L-p2-A-r1",
    question: "Q5L",
    frame: "large",
    prompt: "make the socks blue and green",
  },
  {
    id: "q5L-p2-A-r2",
    question: "Q5L",
    frame: "large",
    prompt: "make the socks blue and green",
  },
];

async function runMasked(cell: MaskedCell): Promise<void> {
  const { assembleBrief } = await import("../studio/brief");
  const { previewGeneration } = await import("../studio/preview");
  const { savePreview } = await import("../studio/previewStore");
  const { runStudioGeneration } = await import("../studio/generate");
  const { detectRegionsMemoized, probeBytesFor } = await import(
    "../studio/autoMask"
  );
  const { mapRegions } = await import("../studio/geometry");
  const { probeImageSize } = await import("../studio/imageSize");
  const { signedUrl } = await import("../lib/mediaStore");
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");

  const assetId = SRC[cell.frame];
  const [row] = await db
    .select({ id: mediaAssets.id, path: mediaAssets.gcs_path })
    .from(mediaAssets)
    // TENANCY in the predicate.
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, ATHLETE_ID)),
    )
    .limit(1);
  if (!row?.path)
    throw new Error(`No stored pixels for ${assetId} under this athlete`);

  // ⚠️ DRY RUN RETURNS BEFORE DETECTION, BECAUSE DETECTION SPENDS. `detectRegionsMemoized` is a
  // Gemini call (studio/autoMask.ts uses `genai()` directly), and it bills WITHOUT appearing in
  // studio-cost-log.jsonl — the router never sees it. A dry run that reaches it is a dry run that
  // charges invisibly, which is the one thing the default exists to prevent. Same defect this
  // script's Q4 sibling had; do not move this guard down to print a nicer plan.
  const question = cell.question ?? "Q5";

  if (!RUN) {
    console.log(`\n── ${cell.id} (${question} path A — MASKED)`);
    console.log(`   prompt   "${cell.prompt}"`);
    console.log(`   src      ${assetId}`);
    console.log(
      "   regions  derived at --run time (detection is a billable call)",
    );
    console.log(
      "   DRY RUN — no detection, no segmentation, no generation, no rows written.",
    );
    return;
  }

  // Detection is memoized on (athlete, asset, instruction), so the two repeats of one prompt share
  // one detection call and one set of boxes — the repeat measures MODEL variance, not box variance.
  const found = await detectRegionsMemoized(
    { athleteId: ATHLETE_ID, sourceAssetId: row.id, instruction: cell.prompt },
    async () => {
      const probe = await probeBytesFor(row.path!);
      return probe
        ? {
            frameBytes: probe.bytes,
            mimeType: probe.mimeType,
            instruction: cell.prompt,
          }
        : null;
    },
  );
  if (!found.ok) throw new Error(`Detection refused: ${found.message}`);

  const frameSize = await probeImageSize(row.path);
  if (!frameSize) throw new Error(`Could not measure ${assetId}`);
  const mapped = mapRegions(found.regions, frameSize);
  if ("message" in mapped)
    throw new Error(`mapRegions refused: ${mapped.message}`);

  const brief = await assembleBrief({
    athleteId: ATHLETE_ID,
    origin: "system",
    objective: "grow-following",
    deliverable: "post",
    mode: "edit",
    source: {
      mediaAssetId: row.id,
      ref: row.path,
      width: frameSize.width,
      height: frameSize.height,
      orientation: frameSize.orientation,
      editRegions: mapped.regions,
    },
    direction: cell.prompt,
  });

  const preview = previewGeneration(brief);
  if (preview.status === "blocked" || !preview.plan || !preview.cost) {
    throw new Error(
      `preview blocked: ${preview.blockers.map((b) => `${b.field}:${b.note}`).join(" | ")}`,
    );
  }

  console.log(`\n── ${cell.id} (${question} path A — MASKED)`);
  console.log(`   prompt   "${cell.prompt}"`);
  console.log(
    `   regions  ${mapped.regions.length}  ${mapped.regions.map((r) => `${r.width}x${r.height}@${r.left},${r.top}`).join(", ")}`,
  );
  console.log(
    `   labels   ${mapped.regions.map((r) => JSON.stringify(r.label ?? null)).join(", ")}`,
  );
  console.log(`   quote    $${preview.cost.amountUsd.toFixed(4)}`);

  assertBudget(preview.cost.amountUsd, cell.id);

  const previewId = await savePreview(ATHLETE_ID, preview);
  const started = Date.now();
  const out = await runStudioGeneration({
    athleteId: ATHLETE_ID,
    brief,
    previewId,
    approvedCostUsd: preview.cost.amountUsd,
  });
  const latencyMs = Date.now() - started;
  spentUsd += preview.cost.amountUsd;

  const outputs: string[] = [];
  for (const [i, a] of out.assets.entries()) {
    if (!a.gcsPath) continue;
    const res = await fetch(await signedUrl(a.gcsPath));
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    const path = join(
      OUT_DIR,
      `${cell.id}${out.assets.length > 1 ? `-${i}` : ""}.jpg`,
    );
    await writeFile(path, buf);
    outputs.push(path);
  }

  const assetIds = out.assets.map((a) => a.id);
  await appendFile(
    CLEANUP_LIST,
    assetIds
      .map(
        (id) =>
          `${id}  ${cell.id}  job=${out.jobId}  ${new Date().toISOString()}\n`,
      )
      .join(""),
    "utf8",
  );

  // The composite returns the frame at its ORIGINAL dimensions, so no resample control is needed
  // and none is meaningful — outAligned is a no-op resize. Everything outside the region is supposed
  // to be pixel-identical, which makes this a LEAK TEST rather than a preservation estimate.
  const frameRef = await resolveRef(assetId, "frame");
  const measurement = await patchDiffs(
    frameRef.bytes,
    frameRef.width,
    frameRef.height,
    await readFileB(outputs[0]),
  );

  console.log(`   jobId    ${out.jobId}   assets ${assetIds.join(", ")}`);
  console.log(
    `   cost     $${preview.cost.amountUsd.toFixed(4)}   ${latencyMs}ms`,
  );
  console.log(`   output   ${outputs.join(", ")}`);
  for (const p of measurement.patches) {
    const leak =
      p.excess > 1.0
        ? "   <<< LEAK — outside the region should be pixel-identical"
        : "";
    console.log(
      `   patch    ${p.patch.padEnd(20)} model ${String(p.modelDiff).padStart(7)}  excess ${String(p.excess).padStart(7)}${leak}`,
    );
  }

  await logRun({
    cell: cell.id,
    question,
    kind: "masked",
    prompt: cell.prompt,
    // POSITION as well as size, in the source's DISPLAY pixels — the zoom strips in `--sheet` cut
    // the garment boundary from exactly these boxes. The original Q5 rows logged only w/h, which is
    // why its zoom sheets had to be aimed by hand.
    regions: mapped.regions.map((r) => ({
      left: r.left,
      top: r.top,
      w: r.width,
      h: r.height,
      label: r.label ?? null,
    })),
    jobId: out.jobId,
    assetIds,
    costUsd: preview.cost.amountUsd,
    latencyMs,
    outputPath: outputs[0] ?? null,
    measurement,
    at: new Date().toISOString(),
  });
}

async function readFileB(p: string): Promise<Buffer> {
  const { readFile } = await import("fs/promises");
  return readFile(p);
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────────────

/**
 * `--list-assets` — every upload this athlete owns, so the probe's sources can be pinned to real
 * ids rather than prefixes. READ ONLY, and scoped to one athlete in the predicate.
 */
async function listAssets(): Promise<void> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and, isNotNull, desc } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: mediaAssets.id,
      w: mediaAssets.width,
      h: mediaAssets.height,
      path: mediaAssets.gcs_path,
      created: mediaAssets.created_at,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, ATHLETE_ID),
        eq(mediaAssets.origin, "upload"),
        isNotNull(mediaAssets.gcs_path),
      ),
    )
    .orderBy(desc(mediaAssets.created_at));

  console.log(`\n${rows.length} upload(s) for athlete ${ATHLETE_ID}\n`);
  for (const r of rows) {
    const dims = `${r.w ?? "?"}x${r.h ?? "?"}`;
    console.log(
      `${r.id}  ${dims.padEnd(11)}  ${r.created?.toISOString() ?? ""}  ${r.path?.split("/").pop() ?? ""}`,
    );
  }
  console.log("");
}

/**
 * `--dump <id,id,...>` — pull assets to disk so a human can SEE what a source actually is before a
 * cell is written against it. Free, and the reason Q1 is not pointed at the wrong ball.
 */
async function dumpAssets(ids: string[]): Promise<void> {
  await mkdir(join(OUT_DIR, "sources"), { recursive: true });
  for (const id of ids) {
    const r = await resolveRef(id.trim(), "frame");
    const out = join(OUT_DIR, "sources", `${id.trim().slice(0, 8)}.jpg`);
    await sharp(r.bytes)
      .resize(720, 720, { fit: "inside" })
      .jpeg({ quality: 82 })
      .toFile(out);
    console.log(`${id.trim().slice(0, 8)}  ${r.width}x${r.height}  → ${out}`);
  }
}

/**
 * `--analyze` — recompute the frame-preservation numbers from outputs ALREADY on disk.
 *
 * Free, and the reason the resample-control bug cost nothing to correct: the generations are saved,
 * so a mistake in the MEASUREMENT is re-runnable without a second call. Any change to `patchDiffs`
 * should be re-reported through here rather than by regenerating.
 */
async function analyzeSaved(): Promise<void> {
  const { readdir, readFile } = await import("fs/promises");
  const files = (await readdir(OUT_DIR)).filter((f) =>
    /^q[123].*\.(png|jpg)$/.test(f),
  );

  console.log(
    "\ncell        out dims      aspect Δ   patch                model   resample   excess",
  );
  for (const f of files.sort()) {
    const cellId = f.replace(/\.(png|jpg)$/, "");
    const cell = DIRECT_CELLS.find((c) => c.id === cellId);
    if (!cell?.measurePatches) continue;
    const frame = await resolveRef(SRC[cell.frame], "frame");
    const outBytes = await readFile(join(OUT_DIR, f));
    const m = await patchDiffs(
      frame.bytes,
      frame.width,
      frame.height,
      outBytes,
    );
    for (const [i, p] of m.patches.entries()) {
      console.log(
        `${(i === 0 ? cellId : "").padEnd(11)} ${(i === 0 ? `${m.outWidth}x${m.outHeight}` : "").padEnd(13)} ` +
          `${(i === 0 ? `${m.aspectDeltaPct}%` : "").padEnd(10)} ${p.patch.padEnd(20)} ` +
          `${String(p.modelDiff).padStart(7)} ${String(p.resampleDiff).padStart(10)} ${String(p.excess).padStart(8)}`,
      );
    }
  }
  console.log("");
}

// ─── `--sheet` — contact sheets and boundary zoom strips, from outputs already on disk ──────────
//
// Free, like --analyze: it reads the saved outputs and the source frame and makes no model call.
//
// One CONTACT SHEET per prompt — the source, every masked repeat, every full-frame repeat, side by
// side at one height, each labelled with the dimensions it actually came back at.
//
// One ZOOM STRIP per prompt — the garment boundary cut from the SAME source-grid coordinates on every
// image, so a rim on the masked arm and a redrawn edge on the full-frame arm are compared at one
// magnification. The full-frame outputs are resized onto the source grid BEFORE cutting (the same
// alignment patchDiffs does): a 4K return is 3392x5056, and a window at source coordinates would
// otherwise land on a different part of her.
//
// The windows come from the masked arm's own logged regions (runs.jsonl) — the boxes detection drew
// for that prompt on that frame. With no positioned masked run on record there is nothing honest to
// aim at, and the strip is skipped rather than aimed by guess.

/** Which garment each prompt of a Q5-shaped question edits — the file name, and the thing zoomed on. */
const SHEET_PROMPTS: Record<string, string> = { p1: "shorts", p2: "socks" };

/** Contact-sheet tile height. A 2:3 frame renders 600 wide at this height. */
const SHEET_TILE_H = 900;
const SHEET_LABEL_H = 72;
/** How far a zoom window extends past its region, as a share of the region's own size, per side. */
const ZOOM_PAD = 0.35;
/** Every zoom window renders at this height, so each column of the strip is one scale. */
const ZOOM_TILE_H = 520;
const ZOOM_LABEL_W = 300;
const GAP = 12;

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A dark label tile, drawn as SVG through sharp so the sheet needs no font files of its own. */
async function labelTile(
  lines: string[],
  width: number,
  height: number,
): Promise<Buffer> {
  const step = 30;
  const first = Math.round(height / 2 - ((lines.length - 1) * step) / 2);
  const text = lines
    .map(
      (l, i) =>
        `<text x="14" y="${first + i * step}" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#f2f2f2" dominant-baseline="middle">${xmlEscape(l)}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#141414"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface SheetImage {
  name: string;
  arm: string;
  bytes: Buffer;
  width: number;
  height: number;
}

async function contactSheets(q: string): Promise<void> {
  const { readdir, readFile } = await import("fs/promises");
  const prefix = `q${q}`;
  const frameKey = [...DIRECT_CELLS, ...Q5_MASKED, ...Q5L_MASKED].find((c) =>
    c.id.startsWith(`${prefix}-`),
  )?.frame;
  if (!frameKey) {
    console.log(`No cells named ${prefix}-… — nothing to sheet.`);
    return;
  }

  const files = await readdir(OUT_DIR);
  const runs = (await readFile(join(OUT_DIR, "runs.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const src = await resolveRef(SRC[frameKey], "frame");

  for (const [pk, garment] of Object.entries(SHEET_PROMPTS)) {
    const outputs = files
      .filter((f) =>
        new RegExp(`^${prefix}-${pk}-[AB]-r\\d+\\.(png|jpg)$`).test(f),
      )
      .sort();
    if (!outputs.length) {
      console.log(`${prefix}-${pk}: no saved outputs — skipped.`);
      continue;
    }

    const images: SheetImage[] = [
      {
        name: "SOURCE",
        arm: SRC[frameKey].slice(0, 8),
        bytes: src.bytes,
        width: src.width,
        height: src.height,
      },
    ];
    for (const f of outputs) {
      const bytes = await readFile(join(OUT_DIR, f));
      const meta = await sharp(bytes).metadata();
      images.push({
        name: f.replace(/\.(png|jpg)$/, ""),
        arm: /-A-/.test(f) ? "masked" : "full-frame",
        bytes,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      });
    }

    // ── The contact sheet.
    const tiles = [];
    for (const img of images) {
      const tile = await sharp(img.bytes)
        .removeAlpha()
        .resize({ height: SHEET_TILE_H })
        .jpeg({ quality: 90 })
        .toBuffer();
      const w = (await sharp(tile).metadata()).width ?? 0;
      const label = await labelTile(
        [img.name, `${img.arm} · ${img.width}x${img.height}`],
        w,
        SHEET_LABEL_H,
      );
      tiles.push({ tile, label, w });
    }
    const sheetW =
      tiles.reduce((s, t) => s + t.w, 0) + GAP * (tiles.length - 1);
    const sheetLayers: sharp.OverlayOptions[] = [];
    let x = 0;
    for (const t of tiles) {
      sheetLayers.push({ input: t.label, left: x, top: 0 });
      sheetLayers.push({ input: t.tile, left: x, top: SHEET_LABEL_H });
      x += t.w + GAP;
    }
    const sheetPath = join(OUT_DIR, `${prefix}-${garment}.jpg`);
    await sharp({
      create: {
        width: sheetW,
        height: SHEET_LABEL_H + SHEET_TILE_H,
        channels: 3,
        background: "#000000",
      },
    })
      .composite(sheetLayers)
      .jpeg({ quality: 88 })
      .toFile(sheetPath);
    console.log(`${prefix}-${pk}: sheet → ${sheetPath}`);

    // ── The zoom strip, aimed at the masked arm's own boxes.
    const masked = runs.filter(
      (r) =>
        typeof r.cell === "string" &&
        r.cell.startsWith(`${prefix}-${pk}-A-`) &&
        Array.isArray(r.regions),
    );
    const boxes = (
      (masked.at(-1)?.regions ?? []) as {
        left?: number;
        top?: number;
        w: number;
        h: number;
      }[]
    ).filter((b) => typeof b.left === "number" && typeof b.top === "number");
    if (!boxes.length) {
      console.log(
        `${prefix}-${pk}: no POSITIONED masked regions on record — zoom strip skipped.`,
      );
      continue;
    }
    const windows = boxes.map((b) => {
      const px = Math.round(b.w * ZOOM_PAD);
      const py = Math.round(b.h * ZOOM_PAD);
      const left = Math.max(0, b.left! - px);
      const top = Math.max(0, b.top! - py);
      const right = Math.min(src.width, b.left! + b.w + px);
      const bottom = Math.min(src.height, b.top! + b.h + py);
      return { left, top, width: right - left, height: bottom - top };
    });

    const rows: { label: Buffer; cuts: { buf: Buffer; w: number }[] }[] = [];
    for (const img of images) {
      // ONE materialized, source-grid copy per image, then every window cut from it. Raw rather than
      // re-encoded, so the strip shows the pixels that came back and not a second JPEG pass over them.
      const aligned = await sharp(img.bytes)
        .removeAlpha()
        .resize(src.width, src.height, { fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const cuts = [];
      for (const win of windows) {
        const scale = ZOOM_TILE_H / win.height;
        // channels: 3 — removeAlpha above guarantees it (see meanAbsDiff for what mixed strides cost).
        const buf = await sharp(aligned.data, {
          raw: {
            width: aligned.info.width,
            height: aligned.info.height,
            channels: 3,
          },
        })
          .extract(win)
          .resize({
            height: ZOOM_TILE_H,
            // Nearest when enlarging, so a one-pixel rim stays a crisp line instead of a soft blur.
            kernel: scale > 1 ? "nearest" : "lanczos3",
          })
          .png()
          .toBuffer();
        cuts.push({ buf, w: (await sharp(buf).metadata()).width ?? 0 });
      }
      rows.push({
        label: await labelTile([img.name, img.arm], ZOOM_LABEL_W, ZOOM_TILE_H),
        cuts,
      });
    }
    const zoomW =
      ZOOM_LABEL_W + rows[0].cuts.reduce((s, c) => s + c.w + GAP, 0);
    const zoomH = rows.length * ZOOM_TILE_H + GAP * (rows.length - 1);
    const zoomLayers: sharp.OverlayOptions[] = [];
    rows.forEach((row, i) => {
      const top = i * (ZOOM_TILE_H + GAP);
      zoomLayers.push({ input: row.label, left: 0, top });
      let cx = ZOOM_LABEL_W + GAP;
      for (const c of row.cuts) {
        zoomLayers.push({ input: c.buf, left: cx, top });
        cx += c.w + GAP;
      }
    });
    const zoomPath = join(OUT_DIR, `${prefix}-${garment}-zoom.jpg`);
    await sharp({
      create: {
        width: zoomW,
        height: zoomH,
        channels: 3,
        background: "#000000",
      },
    })
      .composite(zoomLayers)
      .jpeg({ quality: 92 })
      .toFile(zoomPath);
    console.log(
      `${prefix}-${pk}: zoom → ${zoomPath}  (windows ${windows.map((w) => `${w.width}x${w.height}@${w.left},${w.top}`).join(", ")})`,
    );
  }
}

async function main(): Promise<void> {
  if (flag("list-assets")) {
    await listAssets();
    return;
  }
  const sheet = arg("sheet");
  if (sheet) {
    await contactSheets(sheet);
    return;
  }
  if (flag("analyze")) {
    await analyzeSaved();
    return;
  }
  const dump = arg("dump");
  if (dump) {
    await dumpAssets(dump.split(","));
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  const only = arg("cell");
  const q = arg("q");
  const cells = DIRECT_CELLS.filter(
    (c) => (only ? c.id === only : true) && (q ? c.question === `Q${q}` : true),
  );

  // Q5 and Q5L run BOTH arms: the masked cells first, so a mask-parity refusal costs nothing rather
  // than landing after four full-frame calls have already billed.
  const maskedByQuestion: Record<string, MaskedCell[]> = {
    "5": Q5_MASKED,
    "5L": Q5L_MASKED,
  };
  const maskedCells = only
    ? [...Q5_MASKED, ...Q5L_MASKED].filter((c) => c.id === only)
    : q
      ? (maskedByQuestion[q] ?? [])
      : [];

  if (!cells.length && !maskedCells.length) {
    console.log("No cells selected. Q4 runs from studioRimMatrixProbe.ts.");
    return;
  }

  if (cells.some((c) => c.question === "Q6" || c.question === "Q7")) {
    // Q7's verdict is about the model the product ships, on the wording the product compiles, so an
    // override pointing image.edit elsewhere would answer a different question and still look like an
    // answer. Same refusal Q6 takes, and for the same reason.
    assertShippedEditModel();
    console.log(
      "Flags: image.edit → the shipped Nano Pro on vertex, no provider or model override.",
    );
  }

  if (cells.some((c) => c.question === "Q7")) {
    console.log(
      `Q7 removes "${Q7_TARGET}" with the product's own compiled instruction. r1 keeps the ` +
        "preservation clause, r2 has it stripped — the clause's first measurement.",
    );
    console.log(
      "   Read BOTH: the patch windows for light where nothing was asked, and the saved output at " +
        "1:1 where the thing was, for the shadow. No number here can answer the second.",
    );
  }

  if (maskedCells.length) {
    await assertMaskParity();
    console.log(
      "Flags: garment mask ON (sweep parity), no band forcing — shipped defaults.",
    );
    for (const cell of maskedCells) {
      try {
        await runMasked(cell);
      } catch (err: any) {
        if (/BUDGET STOP/.test(err?.message ?? "")) throw err;
        console.error(`   FAILED  ${cell.id}: ${err?.message ?? err}`);
        await logRun({
          cell: cell.id,
          question: "Q5",
          kind: "masked",
          error: String(err?.message ?? err),
          at: new Date().toISOString(),
        });
      }
    }
  }

  // No up-front total: the size is derived per frame (2K on the 1008px source, 4K on the 4000px ones),
  // so a flat per-cell figure here would under-state a 4K run by half. Each cell prints its own quote.
  console.log(
    `\nPROBE — ${cells.length} direct cell(s). Each prints its own quote at its own size.`,
  );
  console.log(
    `Cap $${CAP_USD}. ${RUN ? "LIVE — these calls will spend." : "DRY RUN."}`,
  );

  for (const cell of cells) {
    try {
      await runDirect(cell);
    } catch (err: any) {
      if (/BUDGET STOP/.test(err?.message ?? "")) throw err;
      console.error(`   FAILED  ${cell.id}: ${err?.message ?? err}`);
      await logRun({
        cell: cell.id,
        question: cell.question,
        kind: "direct",
        error: String(err?.message ?? err),
        at: new Date().toISOString(),
      });
    }
  }

  console.log(`\nTotal spent this invocation: $${spentUsd.toFixed(4)}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  },
);
