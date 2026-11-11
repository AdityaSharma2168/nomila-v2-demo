/**
 * studioVideoBakeoff — video V2, the Veo-vs-Seedance bake-off.
 *
 * ─── WHAT THIS DECIDES ─────────────────────────────────────────────────────────────────────────
 *
 * Whether the video arc has Paths 2-3 in it at all, and if so which model owns which job:
 *
 *   1. Does EITHER model hold identity through motion? If neither does, video ships as Path 1
 *      (stitch her own clips) + b-roll, which is still a product — and the ladder stops.
 *   2. Which model owns IDENTITY segments.
 *   3. Which model owns B-ROLL, where volume makes cost/sec compound.
 *   4. Real cost per second per model, on record.
 *
 * It is the FIRST real measurement, not a re-measure. The two prior clips are both void: the EXIF
 * orientation fixes postdate them (docs/probes/video-scope-audit.md §4.1), and 6 of the 7 photos in
 * the cluster this probe uses are stored `orientation=8` — so the model was handed a woman on her
 * side and returned whoever it liked. Every frame here is put upright before it is sent, and the
 * exact bytes that travelled are written beside the clip.
 *
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts --arm identity
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts --model veo --run --cap 8.47
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts --run --cap 16.45
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts --v2b
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts --sheet
 *   npx tsx --require dotenv/config server/scripts/studioVideoBakeoff.ts --reveal
 *
 * ─── DRY RUN IS THE DEFAULT, AND THE CAP IS THE ONLY CEILING ───────────────────────────────────
 *
 * ⚠️ V1's spend caps DO NOT BIND HERE, and that is worth knowing before reading `--cap` as a
 * belt-and-braces. `assertSpendWithinCaps` is called from studio/generate.ts's runStudioGeneration,
 * on the product path, behind an approval row. This script calls studio/router directly — the same
 * door Q7/Q8 use — which bypasses the per-job cap, the $25 rolling day ceiling AND the video hold.
 * So there is no STUDIO_MAX_DAY_USD to raise for a run, and nothing downstream will stop a runaway.
 * `assertBudget` below is the whole guard, which is why it refuses BEFORE a call rather than
 * totalling up after one. The per-job cap is re-applied per cell by hand, from the same config
 * `maxJobUsd()` the product reads, so a single mispriced cell cannot pass on the cumulative total
 * alone.
 *
 * ─── WHAT IS MECHANICAL AND WHAT IS ADI'S EYE ──────────────────────────────────────────────────
 *
 * Mechanical, and written to disk: the exact first frame sent, wall clock, bytes, the clip's own
 * encoded dimensions and duration, cost and cost/sec, and a frame strip at fixed timestamps when
 * ffmpeg is present.
 *
 * NOT mechanical, and deliberately: identity. This project has no working identity ruler — a
 * stranger scores below the athlete's own floor on a curated one-person set, so the metric tracks
 * framing rather than faces and no bar may be written in it. The frame strip is EVIDENCE, and the
 * drift number below is a measure of CHANGE, not of identity; a clip that pans has a large drift
 * and may hold identity perfectly. Identity hold, mark integrity and motion plausibility are scored
 * by eye off a blind sheet, and the key is revealed after.
 */
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import sharp from "sharp";
import { generate, estimate } from "../studio/router";
import { MODELS, vertexModelFor, maxJobUsd } from "../studio/config";
import type { GenerationInputs, ImageRef, ProviderOpts } from "../studio/types";

const execFileP = promisify(execFile);

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "0"));
/**
 * UNDER `probe-out/`, which `.gitignore` already covers (`probe-out/*`, keeping only runs.jsonl).
 *
 * A paid run writes 15 mp4s, two frames, a sheet and a key. Anywhere else in the tree those land as
 * untracked files in a worktree whose next `git add -A` is a commit nobody meant to make — and the
 * clips are of a real athlete, which is not something to push by accident.
 */
/**
 * `--v2b` swaps the cell list for the identity-only re-probe (see V2B_CELLS). Everything else — the
 * frame preparation, the spend guard, the blind sheet — is shared, which is the point: the two
 * probes must be measured by the same instrument or their numbers do not compare.
 */
const V2B = flag("v2b");
const PROBE = V2B ? "v2b" : "v2";
const OUT_DIR = arg(
  "out",
  V2B ? "probe-out/video-v2b" : "probe-out/video-bakeoff",
)!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const ONLY_ARM = arg("arm");
const ONLY_CELL = arg("cell");
/**
 * `--model veo` runs one model's cells across both arms.
 *
 * It exists because the arms are not equally reachable: Veo is on Vertex and runs today, while both
 * Seedance models need an `OPENROUTER_API_KEY` that has never been provisioned on this machine. So
 * "the half that can run now" is a real thing to ask for, and without this it is six separate
 * `--cell` invocations with six separate caps.
 *
 * Matched as a prefix of the model TAG, so `--model seedance` takes both Seedance arms and
 * `--model seedance-2.0-fast` takes only the cheap one.
 */
const ONLY_MODEL = arg("model");

// ─── The output size, and why it is pinned ──────────────────────────────────────────────────────
//
// 720p 9:16, on every cell and both arms. Three reasons, all of which would otherwise be confounds:
//
//   • It is the size Seedance's base rate is published for, so the quote is the invoice rather than
//     an interpolation (studio/config.ts, videoTierFor).
//   • It is Veo 3.1's default on Vertex, which sends no resolution parameter — so asking for it
//     costs nothing and matching it costs nothing.
//   • A first frame at exactly the output size removes every provider's own downscale from the
//     comparison. The SAME BYTES go to both models.
const W = 720;
const H = 1280;
const ASPECT = "9:16";

/** Veo serves 4/6/8 only (studio/config.ts supportedDurationsFor); Seedance serves 4..15. */
const IDENTITY_SECONDS = 8;
const BROLL_SECONDS = 6;

// ─── Sources ────────────────────────────────────────────────────────────────────────────────────
//
// media_assets UUIDs, read-only, under this athlete's id and never written.
//
// ⚠️ THE CLUSTER IS PINNED AND THAT IS NOT PEDANTRY. This athlete's 17 uploads are at least three
// different women, so an identity finding drawn from the library at large measures the wrong face.
// Both frames below are the maroon adidas cluster — one woman.
//
// ─── THE TWO WERE CHOSEN BY LOOKING AT ALL SEVEN, AND THE REJECTS MATTER ───────────────────────
//
// An i2v first frame is the opening shot, so its POSE is load-bearing in a way a still reference's
// is not. Of the cluster:
//
//   5581e882 · a81be2c0   full-body action, face ~5% of frame height. This project has already
//                         recorded that action faces that small are below the judgment floor — a
//                         frame nobody can score identity on cannot answer this probe's question.
//   2bc354e4              a torso close-up with the face cropped off entirely.
//   25499d98              a large face, but in PROFILE with a hand held against it. Two confounds
//                         at once: a profile is a hard anchor, and a hand at the face is exactly
//                         the fusion the 2026-08-27 run reported.
//   b2d6edcd              head tilted back, eyes nearly closed — an unusual pose to hold.
//
//   A `77146781`  ✓ seated on the grass tying a boot, front-facing and smiling, mid-size face,
//                   adidas three stripes on the top and a trefoil on the sock.
//                   This is also the SHOELACE-TYING BEAT the 2026-09-07 spike used, which makes the
//                   new result speak directly to the old claim rather than beside it.
//   B `3b9be374`  ✓ a standing medium shot, the LARGEST clean face of the seven, three stripes
//                   unmissable down both sleeves — the mark a swoosh was seen coexisting with.
//
// Both are stored `orientation=8` (6 of the 7 in this cluster are). An unflagged control was
// considered and dropped: the only unflagged photo is one of the tiny-face rejects, and the
// rotation is already proven by assertion (`prepareFrame` refuses anything that is not W×H) and by
// eye on the bytes written to disk. Evidence beats a control that costs the measurement its face.
const FRAME_A = arg("frame-a", "77146781-cedc-44e4-a437-f0f0f98626a0")!;
const FRAME_B = arg("frame-b", "3b9be374-7b0e-4372-a506-4f48e3d89ac9")!;

// ─── V2b's three, one per difficulty level (approved 2026-09-18) ───────────────────────────────
//
// Chosen by rendering all 18 uploads through this script's own crop and looking at every one. Six
// are not people at all (a bottle, earrings, a bracelet, two colour test cards); of the rest:
//
//   e58f3a5a   EXCLUDED ON PRINCIPLE, not on quality — a recognizable real public figure with her
//              name legible on the bib. Generating video of her is a likeness exposure.
//   37df2f85   usable front-facing alternates, but near-duplicates of each other and both carry
//   517ed082   large "GET LOUD" background text for the model to invent around.
//   afc78262   face turned away.   25499d98  profile behind a raised hand.
//   b2d6edcd   head back, eyes nearly shut.
//   a81be2c0   action frames whose face is ~5% of frame height — below the judgment floor.
//   5581e882
//   2bc354e4   no face inside the 9:16 crop at all.
//
// EASY  `7fe0b609`  1106x1518, NO EXIF flag. The strongest frame in the corpus and not close:
//                   studio light, plain seamless background, dead-on front-facing, full face
//                   unobstructed and sharp, whole body in frame with room to move. Face is ~12.5%
//                   of frame height — well clear of the judgment floor and larger than the frame
//                   that failed. Native resolution exceeds the 9:16 crop, so nothing is upscaled.
//                   If Veo fails the CONTROL on this frame, no frame-quality story survives.
// MED   `77146781`  the contested frame, kept deliberately: a Veo hold here against V2's fail is
//                   directly interpretable rather than a fresh, unanchored data point.
// HARD  `3b9be374`  largest clean face in the maroon set, standing medium with room to turn away
//                   and come back. Same frame as V2's hard failure, so that cell stays a re-test.
const FRAME_EASY = arg("frame-easy", "7fe0b609-740e-409b-a0e0-b159f5a7718e")!;
const FRAME_MED = arg("frame-med", FRAME_A)!;
const FRAME_HARD = arg("frame-hard", FRAME_B)!;

// ─── The arms ───────────────────────────────────────────────────────────────────────────────────

type Arm = "identity" | "broll";

interface ModelArm {
  /** Short tag used in filenames and in key.json. Never shown on the blind sheet. */
  tag: string;
  provider: "vertex" | "openrouter";
  model: string;
  providerParams?: Record<string, unknown>;
}

/**
 * ─── AUDIO IS OFF ON BOTH, AND THAT IS NOT A NEUTRAL DEFAULT ───────────────────────────────────
 *
 * Veo bills a SEPARATE and 2x SKU for audio, and `wantsAudio` treats an absent flag as audio — so
 * omitting this doubles the Veo arm from $0.20/s to $0.40/s and the probe from $16.38 to $23.55.
 * The product path sets it false explicitly (studio/preview.ts), so false is also the arm the
 * product actually buys.
 *
 * Seedance bills the SAME either way — `video_tokens_without_audio` equals `video_tokens` on both
 * its models. It is set false anyway, for parity: a clip with a soundtrack and a clip without are
 * not the same thing to score for motion.
 */
const VEO: ModelArm = {
  tag: "veo-3.1",
  provider: "vertex",
  model: vertexModelFor(MODELS.veo),
  providerParams: { parameters: { generateAudio: false } },
};
const SEEDANCE: ModelArm = {
  tag: "seedance-2.0",
  provider: "openrouter",
  model: MODELS.seedance,
  providerParams: { generate_audio: false },
};
const SEEDANCE_FAST: ModelArm = {
  tag: "seedance-2.0-fast",
  provider: "openrouter",
  model: MODELS.seedanceFast,
  providerParams: { generate_audio: false },
};

interface Cell {
  id: string;
  arm: Arm;
  /** Null for a text-to-video cell — b-roll is identity-free by construction. */
  frame: string | null;
  frameLabel: string;
  prompt: string;
  seconds: number;
  model: ModelArm;
  /** What this cell is for, printed in the dry run so a cell nobody can justify is visible. */
  asks: string;
}

/**
 * ─── IDENTITY: THREE SENTENCES, TWO FRAMES, THE SAME PAIR ON BOTH MODELS ───────────────────────
 *
 * I1 vs I2 isolates the PROMPT (same frame, different motion). I1 vs I3 isolates the FRAME (same
 * motion, different photograph — and different EXIF provenance). Every one of the three runs on
 * both models with byte-identical inputs, so the third comparison is the MODEL.
 *
 * ⚠️ A NOTE ON THE "3-REF PACK". The brief asked for her 3-ref pack on both arms; it cannot be run
 * fairly and this is why. Veo on Vertex reads `refParts[0]` and ONLY that — references 2 and 3
 * never reach the model. A pack is therefore measurable on Seedance alone, which makes it a
 * model-vs-model confound rather than a finding. One frame, both arms, same bytes.
 *
 * All three sentences keep her kit on screen for the full clip, because the kit is where the known
 * failure lives: the 2026-09-07 spike saw a Nike swoosh FADE IN on adidas kit and COEXIST with the
 * three stripes — an addition, not a morph. A mixed-brand frame is the NIL hazard.
 */
interface IdentityPrompt {
  id: string;
  frame: string;
  frameLabel: string;
  prompt: string;
  asks: string;
}

const IDENTITY_PROMPTS: IdentityPrompt[] = [
  {
    id: "i1",
    frame: FRAME_A,
    frameLabel: "A",
    prompt:
      "She finishes tying her boot, stands up and looks into the camera. Handheld, natural " +
      "daylight, her kit and the field behind her unchanged.",
    asks: "identity across a whole-body pose change; kit on screen throughout",
  },
  {
    id: "i2",
    frame: FRAME_A,
    frameLabel: "A",
    prompt:
      "She looks up from her boot into the camera and breaks into a smile. Minimal camera " +
      "movement, natural daylight, her kit and the field behind her unchanged.",
    asks: "the strictest face test — least motion, most face, same frame as i1",
  },
  {
    id: "i3",
    frame: FRAME_B,
    frameLabel: "B",
    prompt:
      "She turns and walks a few steps away from the camera, then looks back over her shoulder. " +
      "Handheld, natural daylight, her kit and the field behind her unchanged.",
    // The face LEAVES and COMES BACK, which is the sharpest form of the question this probe exists
    // to ask: not "is frame 0 still her" but "is she the same person after the model has had to
    // re-draw her from scratch". The three stripes are on both sleeves and stay on screen throughout.
    asks: "identity across a face that exits and returns; stripes centre-frame the whole clip",
  },
];

/**
 * ─── B-ROLL: A LOWER BAR AND A DIFFERENT ONE ───────────────────────────────────────────────────
 *
 * No person, so no identity to hold. The bar is: it looks good, it invents no brand mark, and it
 * invents no recognizable person. That last one is the exposure — a t2v crowd that renders a
 * real-looking athlete is the same class of problem as putting a competitor's swoosh on her chest.
 *
 * B1 and B3 are the risk cells by design: a stadium has sponsor boards and a crowd has faces. B2 is
 * the control — an object on grass has neither, so a failure there is about the MODEL rather than
 * about what the sentence invited.
 */
const BROLL_PROMPTS: { id: string; prompt: string; asks: string }[] = [
  {
    id: "b1",
    prompt:
      "An empty football stadium at dusk, floodlights on, a slow push in along an empty touchline. " +
      "No people, no text, no signage.",
    asks: "does it invent sponsor boards and logos on the hoardings",
  },
  {
    id: "b2",
    prompt:
      "A close, slow shot of a football rolling to a stop on wet grass, late afternoon light. " +
      "No people, no text.",
    asks: "the control — nothing in the sentence invites a mark or a face",
  },
  {
    id: "b3",
    prompt:
      "A packed stadium crowd seen from the pitch at night, hands in the air, motion blur. " +
      "No text, no signage.",
    asks: "does it render a recognizable real person (the exposure case)",
  },
];

// ─── V2b — the identity-only re-probe ───────────────────────────────────────────────────────────
//
// V2's verdict 1 was too thin to ship: Veo held identity 0/2 by blind score, Seedance 1/1, and the
// Seedance route refused real-person i2v nondeterministically so most of its arm never rendered.
//
// ⚠️ THE FRAME HYPOTHESIS IS ALREADY DEAD, AND THIS IS WHY THE PROBE CHANGED SHAPE. The obvious
// reading of V2 was that Veo failed the easy cell because the first frame was weak. It was not:
// `i2-veo-3.1` and `i2-seedance-2.0` ran BYTE-IDENTICAL frames (the harness prepares each frame
// once and reuses the buffer) and a verbatim-identical prompt. Veo failed, Seedance held. The
// difference between those two cells is the model and nothing else.
//
// So V2b asks a sharper question: does Veo have a FACE-FORWARD identity problem that Seedance does
// not? The axis is motion difficulty, and frame quality is held out of it.
//
// ─── WHY V2's "EASY" CELL WAS NOT ACTUALLY EASY ─────────────────────────────────────────────────
//
// Worth recording, because it is a third explanation neither "weak frame" nor "bad model" covers.
// V2's easy prompt was "She looks up from her boot into the camera and breaks into a smile" — but
// in frame 77146781 she is ALREADY looking at the camera and already smiling. The sentence asks for
// a state change from a state the frame is not in, which invites the model to animate DOWN first
// and then back up: a large head movement, in the cell labelled near-static. The easy prompt below
// is consistent with its frame, so "easy" means easy this time.
const V2B_SECONDS = 6;

interface DifficultyCell {
  id: string;
  frame: string;
  frameLabel: string;
  prompt: string;
  asks: string;
}

/**
 * ─── ONE FRAME PER DIFFICULTY, THE SAME BYTES ACROSS ALL THREE MODELS ──────────────────────────
 *
 * Frame choice is the confound being removed, so it is constant across the model tiers. It varies
 * across difficulty by design — each level needs a frame that can actually perform its motion — and
 * the three were picked to be as close to equally strong as the corpus allows, so difficulty and
 * frame quality do not move together.
 *
 * ⚠️ IDENTITY IS JUDGED WITHIN A CELL, AGAINST THAT CELL'S OWN FIRST FRAME. The easy frame is a
 * different subject from the other two, and that is NOT a confound: the question each cell answers
 * is "is the person at t=end the person in this cell's first frame", which needs no comparison
 * across cells and no shared subject. The pin-the-cluster rule from earlier probes governs scores
 * AVERAGED over cells; nothing here is averaged over cells.
 */
const V2B_CELLS: DifficultyCell[] = [
  {
    id: "easy",
    frame: FRAME_EASY,
    frameLabel: "E",
    prompt:
      "She holds her stance and looks straight into the camera, breathing gently, her expression " +
      "barely changing. The camera does not move. Studio light and plain background unchanged.",
    asks: "THE CONTROL — near-static, face forward for the whole clip, on the corpus's strongest frame",
  },
  {
    id: "med",
    frame: FRAME_MED,
    frameLabel: "M",
    prompt:
      "She finishes tying her boot and stands up, keeping her face toward the camera throughout. " +
      "Handheld, natural daylight, the field behind her unchanged.",
    asks: "a whole-body pose change with the face never leaving frame",
  },
  {
    id: "hard",
    frame: FRAME_HARD,
    frameLabel: "H",
    prompt:
      "She turns away from the camera, walks a few steps, then turns back and looks into the lens. " +
      "Handheld, natural daylight, her kit and the field behind her unchanged.",
    asks: "the face EXITS and RETURNS — the model must re-draw her from nothing",
  },
];

/**
 * 3 difficulties x 3 models. Every cell is identity (i2v), 6s, 9:16, 720p, audio off.
 *
 * 6s AND NOT 5s, WHICH WAS ASKED FOR: Veo 3.1 serves 4/6/8 only (studio/config supportedDurationsFor,
 * and OpenRouter's capability API agrees). The verdict rests on Veo's three cells, so a uniform 5s
 * would have deleted the arm the probe is built around. 6s is the only length in the 5-6s range all
 * three models serve, and it gives the hard turn-and-return more room rather than less.
 */
function buildCellsV2b(): Cell[] {
  const cells: Cell[] = [];
  for (const m of [VEO, SEEDANCE, SEEDANCE_FAST]) {
    for (const d of V2B_CELLS) {
      cells.push({
        ...d,
        id: `${d.id}-${m.tag}`,
        arm: "identity",
        seconds: V2B_SECONDS,
        model: m,
      });
    }
  }
  return cells.filter(
    (c) =>
      (!ONLY_MODEL || c.model.tag.startsWith(ONLY_MODEL)) &&
      (!ONLY_CELL || c.id.startsWith(ONLY_CELL)),
  );
}

function buildCells(): Cell[] {
  const cells: Cell[] = [];
  for (const m of [VEO, SEEDANCE]) {
    for (const p of IDENTITY_PROMPTS) {
      cells.push({
        ...p,
        id: `${p.id}-${m.tag}`,
        arm: "identity",
        seconds: IDENTITY_SECONDS,
        model: m,
      });
    }
  }
  for (const m of [VEO, SEEDANCE, SEEDANCE_FAST]) {
    for (const p of BROLL_PROMPTS) {
      cells.push({
        ...p,
        id: `${p.id}-${m.tag}`,
        arm: "broll",
        frame: null,
        frameLabel: "—",
        seconds: BROLL_SECONDS,
        model: m,
      });
    }
  }
  return cells.filter(
    (c) =>
      (!ONLY_ARM || c.arm === ONLY_ARM) &&
      (!ONLY_MODEL || c.model.tag.startsWith(ONLY_MODEL)) &&
      (!ONLY_CELL || c.id.startsWith(ONLY_CELL)),
  );
}

// ─── Frames ─────────────────────────────────────────────────────────────────────────────────────

interface PreparedFrame {
  ref: ImageRef;
  bytes: Buffer;
  storedOrientation: number | null;
  storedSize: string;
}

const frameCache = new Map<string, PreparedFrame>();

/**
 * An asset id → the exact 720x1280 upright bytes both models are handed.
 *
 * THREE THINGS HAPPEN HERE AND EACH ONE IS LOAD-BEARING:
 *
 *   1. `.rotate()` FIRST. The EXIF-driven form, a no-op on an unflagged file. 6 of the 7 photos in
 *      this cluster are stored `orientation=8`, and the model ignores the flag — which is what
 *      voided both earlier spike runs. It must precede the resize or a flagged portrait is measured
 *      on its long edge sideways.
 *   2. A COVER CROP to the output's own aspect. Her photographs are 2:3 and the clip is 9:16, so
 *      something has to give; cropping is the honest choice because letterboxing would hand the
 *      model bars to hallucinate into. It is a centre crop and it loses ~15% of the width, which is
 *      a framing change and is recorded as one.
 *   3. The result is written to disk beside the clip. The blind sheet shows THIS, not the library
 *      thumbnail — the sheet has to show what the model actually saw or the scoring is of a
 *      different image.
 */
async function prepareFrame(assetId: string): Promise<PreparedFrame> {
  const hit = frameCache.get(assetId);
  if (hit) return hit;

  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const { signedUrl } = await import("../lib/mediaStore");

  // TENANCY: the athlete id is in the predicate, not checked after the fact.
  const [row] = await db
    .select({ path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, ATHLETE_ID)),
    )
    .limit(1);
  if (!row?.path)
    throw new Error(`No stored pixels for asset ${assetId} under this athlete`);

  const res = await fetch(await signedUrl(row.path));
  if (!res.ok) throw new Error(`Fetch of ${assetId} failed: ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(raw).metadata();

  const bytes = await sharp(raw)
    .rotate()
    .resize(W, H, { fit: "cover", position: "centre" })
    .jpeg({ quality: 92 })
    .toBuffer();

  // Prove it rather than assume it — `sharp(raw).rotate().metadata()` reports the INPUT's
  // dimensions, so the only honest check is on the buffer that leaves.
  const out = await sharp(bytes).metadata();
  if (out.width !== W || out.height !== H) {
    throw new Error(
      `Frame ${assetId} came out ${out.width}x${out.height}, expected ${W}x${H}`,
    );
  }

  const prepared: PreparedFrame = {
    ref: { kind: "bytes", bytes, mimeType: "image/jpeg", slot: "frame" },
    bytes,
    storedOrientation: meta.orientation ?? null,
    storedSize: `${meta.width}x${meta.height}`,
  };
  frameCache.set(assetId, prepared);
  return prepared;
}

// ─── The clip's own numbers, without ffmpeg ─────────────────────────────────────────────────────

/**
 * Width, height and duration read straight out of the MP4 container.
 *
 * ffmpeg is in the Dockerfile but not on this laptop, and the numbers that decide verdict 4
 * (cost/sec, and whether both arms really rendered at the same resolution) must not depend on a
 * tool that may be absent. This walks the box tree to `mvhd` for duration and the first video
 * `tkhd` for dimensions — enough for the record, and no dependency.
 *
 * Returns nulls rather than throwing: a clip we cannot parse is still a clip worth watching.
 */
function mp4Facts(buf: Buffer): {
  width: number | null;
  height: number | null;
  seconds: number | null;
} {
  let width: number | null = null;
  let height: number | null = null;
  let seconds: number | null = null;

  const walk = (start: number, end: number) => {
    let p = start;
    while (p + 8 <= end) {
      const size = buf.readUInt32BE(p);
      const type = buf.toString("ascii", p + 4, p + 8);
      if (size < 8) return;
      const body = p + 8;
      const stop = Math.min(p + size, end);

      if (type === "mvhd") {
        const version = buf[body];
        const timescale =
          version === 1
            ? buf.readUInt32BE(body + 20)
            : buf.readUInt32BE(body + 12);
        const duration =
          version === 1
            ? Number(buf.readBigUInt64BE(body + 24))
            : buf.readUInt32BE(body + 16);
        if (timescale) seconds = duration / timescale;
      } else if (type === "tkhd" && width === null) {
        const version = buf[body];
        // The track matrix precedes width/height; both are 16.16 fixed point at the box's tail.
        const w = buf.readUInt32BE(stop - 8) / 65536;
        const h = buf.readUInt32BE(stop - 4) / 65536;
        // A sound track carries 0x0 — keep walking until a visual one turns up.
        if (w > 0 && h > 0) {
          width = Math.round(w);
          height = Math.round(h);
        }
        void version;
      } else if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) {
        walk(body, stop);
      }
      p += size;
    }
  };

  try {
    walk(0, buf.length);
  } catch {
    /* a container we cannot parse is not a reason to lose the clip */
  }
  return { width, height, seconds };
}

const haveFfmpeg = async (): Promise<boolean> => {
  try {
    await execFileP("ffmpeg", ["-version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * A strip of stills at fixed timestamps — the evidence for "does it survive to t=end".
 *
 * Best-effort. Without ffmpeg the sheet still plays the clips; only the strip and the drift numbers
 * are lost, and the dry run says so up front rather than at the end of a paid run.
 */
async function extractStrip(
  mp4: string,
  outBase: string,
  seconds: number,
): Promise<string[]> {
  const stamps = [0, 2, 4, 6, 8].filter((t) => t < seconds);
  const made: string[] = [];
  for (const t of stamps) {
    const out = `${outBase}-t${t}.jpg`;
    try {
      await execFileP(
        "ffmpeg",
        [
          "-y",
          "-nostdin",
          "-ss",
          String(t),
          "-i",
          mp4,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          out,
        ],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      made.push(out);
    } catch {
      /* a missing stamp is not a failed cell */
    }
  }
  return made;
}

/**
 * Mean absolute pixel difference between the first extracted still and each later one.
 *
 * ⚠️ THIS IS A MEASURE OF CHANGE, NOT OF IDENTITY, and the distinction is the reason this project
 * has no identity number at all: the QA ruler scores a stranger BELOW the athlete's own floor on a
 * curated one-person set, so it tracks framing rather than faces. A clip that pans scores a large
 * drift and may hold identity perfectly; a clip that holds still and swaps her face scores a small
 * one. It is here to rank clips for attention, never to decide a verdict.
 */
async function driftCurve(strip: string[]): Promise<number[]> {
  if (strip.length < 2) return [];
  const base = await sharp(strip[0])
    .resize(180, 320, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  const out: number[] = [];
  for (const f of strip.slice(1)) {
    const cur = await sharp(f)
      .resize(180, 320, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Math.abs(base[i] - cur[i]);
    out.push(Math.round((sum / base.length / 255) * 1000) / 1000);
  }
  return out;
}

// ─── Spend ──────────────────────────────────────────────────────────────────────────────────────

let spent = 0;

/**
 * Refuse BEFORE the call, never total up after one.
 *
 * Both limits are applied per cell: the cumulative `--cap` this run was launched with, and the
 * product's own `maxJobUsd()` read from studio/config. The second is not redundant — the cumulative
 * cap alone would happily admit one mispriced $9 cell inside a $16 budget.
 */
function assertBudget(cell: Cell, amount: number, unpriced: boolean) {
  if (unpriced) {
    throw new Error(
      `${cell.id}: refusing to run — ${cell.model.model} quoted no price. An unknown cost must ` +
        "never spend as if it were $0 (studio/spendCaps.ts makes the same refusal first).",
    );
  }
  const perJob = maxJobUsd();
  if (amount > perJob) {
    throw new Error(
      `${cell.id}: quotes $${amount.toFixed(4)}, over the $${perJob.toFixed(2)} per-job cap`,
    );
  }
  if (spent + amount > CAP_USD) {
    throw new Error(
      `${cell.id}: quotes $${amount.toFixed(4)}, which would take this run to ` +
        `$${(spent + amount).toFixed(4)} — over the --cap $${CAP_USD.toFixed(2)}. Stopping before the call.`,
    );
  }
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────

interface CellResult {
  cell: string;
  arm: Arm;
  model: string;
  provider: string;
  frameLabel: string;
  /** The asset the first frame came from, so the sheet shows the bytes THIS cell was given. */
  frameAsset: string | null;
  prompt: string;
  requestedSeconds: number;
  quotedUsd: number;
  quoteDetail?: string;
  /** Present only after --run. */
  actualUsd?: number;
  costBasis?: string;
  wallClockMs?: number;
  bytes?: number;
  encodedWidth?: number | null;
  encodedHeight?: number | null;
  encodedSeconds?: number | null;
  usdPerSecond?: number | null;
  /** The provider's own url, when it returned one instead of bytes — so a failed download is recoverable. */
  assetUrl?: string;
  strip?: string[];
  drift?: number[];
  error?: string;
}

function inputsFor(cell: Cell, frame: PreparedFrame | null): GenerationInputs {
  return {
    prompt: cell.prompt,
    durationSeconds: cell.seconds,
    width: W,
    height: H,
    aspectRatio: ASPECT,
    ...(frame ? { references: [frame.ref] } : {}),
  };
}

/**
 * ─── THE RESULTS FILE IS PER-FILTER, AND IT IS WRITTEN AFTER EVERY CELL ────────────────────────
 *
 * Two failures from the V2 run, both of which lost data that had already been paid for:
 *
 *   • ONE NAME FOR EVERY RUN. `--model veo` and `--model seedance` both wrote `results.json`, so
 *     the second half silently overwrote the first half's costs, wall clocks and encoded sizes.
 *     The clips survived only because their filenames carry the cell id.
 *   • WRITTEN ONCE, AT THE END. Every url needed to recover a billed-but-undownloaded clip sat in
 *     memory until the loop finished. A run that died in the middle would have taken them with it —
 *     and "the run died in the middle" is exactly when they are needed.
 *
 * So: the filter is in the filename, and the file is rewritten after each cell. Rewriting the whole
 * array each time is fine at this size and keeps the file valid JSON at every instant, which an
 * append-per-line format would not.
 */
const RESULTS_PATH = join(
  OUT_DIR,
  ["results", PROBE, ONLY_MODEL, ONLY_ARM, ONLY_CELL]
    .filter(Boolean)
    .join("-") + ".json",
);

const saveResults = (results: CellResult[]) =>
  writeFile(RESULTS_PATH, JSON.stringify(results, null, 2));

const optsFor = (cell: Cell): ProviderOpts => ({
  provider: cell.model.provider,
  model: cell.model.model,
  ...(cell.model.providerParams
    ? { providerParams: cell.model.providerParams }
    : {}),
});

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const cells = V2B ? buildCellsV2b() : buildCells();

  if (flag("sheet")) return buildSheet();
  if (flag("reveal")) return reveal();

  const ffmpeg = await haveFfmpeg();
  console.log(
    `\nvideo bake-off — ${cells.length} cells, ${W}x${H} ${ASPECT}, ` +
      `${RUN ? `LIVE (cap $${CAP_USD.toFixed(2)})` : "DRY RUN"}\n`,
  );
  if (!ffmpeg) {
    console.log(
      "⚠️  ffmpeg not found. Clips still download and the blind sheet still plays them; the frame\n" +
        "   strips and drift curves will be skipped. `brew install ffmpeg` before --run to get them.\n",
    );
  }

  // Frames FIRST, before any quote is printed, so a broken source fails at $0 rather than mid-run.
  const needed = [
    ...new Set(cells.map((c) => c.frame).filter(Boolean) as string[]),
  ];
  const frames = new Map<string, PreparedFrame>();
  for (const id of needed) {
    const f = await prepareFrame(id);
    frames.set(id, f);
    const path = join(OUT_DIR, `frame-${id.slice(0, 8)}.jpg`);
    await writeFile(path, f.bytes);
    console.log(
      `frame ${id.slice(0, 8)}  stored ${f.storedSize} exif=${f.storedOrientation ?? "-"} ` +
        `→ sent ${W}x${H} upright  (${(f.bytes.length / 1e6).toFixed(2)} MB)  ${path}`,
    );
  }
  console.log("");

  const results: CellResult[] = [];
  let quotedTotal = 0;

  for (const cell of cells) {
    const frame = cell.frame ? frames.get(cell.frame)! : null;
    const inputs = inputsFor(cell, frame);
    const opts = optsFor(cell);
    const plan = estimate("video.generate", inputs, opts);
    const quoted = plan.cost.amountUsd;
    quotedTotal += quoted;

    const r: CellResult = {
      cell: cell.id,
      arm: cell.arm,
      model: cell.model.model,
      provider: cell.model.provider,
      frameLabel: cell.frameLabel,
      frameAsset: cell.frame,
      prompt: cell.prompt,
      requestedSeconds: cell.seconds,
      quotedUsd: quoted,
      quoteDetail: plan.cost.detail,
    };

    console.log(
      `${cell.id.padEnd(24)} ${cell.arm.padEnd(9)} frame ${cell.frameLabel.padEnd(2)} ` +
        `${String(cell.seconds).padStart(2)}s  $${quoted.toFixed(4)}${plan.cost.unpriced ? "  UNPRICED" : ""}`,
    );
    console.log(`${" ".repeat(26)}${cell.asks}`);
    console.log(`${" ".repeat(26)}${plan.cost.detail ?? ""}`);

    if (!RUN) {
      results.push(r);
      continue;
    }

    try {
      assertBudget(cell, quoted, !!plan.cost.unpriced);
    } catch (err) {
      console.error(`\n🛑 ${(err as Error).message}\n`);
      results.push({ ...r, error: (err as Error).message });
      await saveResults(results);
      break;
    }

    const started = Date.now();
    try {
      const out = await generate("video.generate", inputs, opts);
      const ms = Date.now() - started;

      // ─── THE MONEY IS COUNTED HERE, BEFORE ANYTHING ELSE CAN THROW ─────────────────────────────
      //
      // This used to sit further down, after the download and the mp4 parse. The V2 Seedance run
      // found out why that is wrong: seven cells billed and then every download 401'd, so every one
      // of them threw before reaching this line — and `spent` stayed at $0.00 while $5.6007 left
      // the account. The cap is computed from `spent`, so a run in that state would have kept going
      // until it ran out of cells rather than until it ran out of budget.
      //
      // `--cap` is the only ceiling this probe has (V1's caps are on the product path, see the
      // header), so it may never be fed a total that a later failure can suppress. A clip we paid
      // for and could not download is still a clip we paid for.
      spent += out.cost.amountUsd;
      r.actualUsd = out.cost.amountUsd;
      r.costBasis = out.cost.basis;
      r.wallClockMs = ms;

      const asset = out.assets[0];
      if (!asset) throw new Error("provider returned no asset");

      // Vertex hands back bytes; OpenRouter hands back a url the caller streams. Both end as a file.
      //
      // THE STATUS IS CHECKED, because by this point the clip is PAID FOR. An unchecked fetch writes
      // whatever came back — a 404's error body lands on disk named `.mp4`, the run carries on, and
      // the loss only surfaces when the sheet will not play it. Raising here keeps the spend on the
      // record (the cost log is already written by the router) and names the cell that lost its file.
      let buf: Buffer;
      if (asset.bytes) {
        buf = asset.bytes;
      } else {
        r.assetUrl = asset.url;
        // ─── "unsigned_urls" IS A LIE, AND IT COST SEVEN CLIPS ────────────────────────────────
        //
        // OpenRouter returns finished videos in a field called `unsigned_urls`, which reads as "no
        // credential needed". It is not: the urls are `/api/v1/videos/{id}/content`, ordinary
        // authenticated API endpoints. A bare fetch gets 401, and the V2 run lost all seven billed
        // Seedance clips that way — generated, paid for, undownloadable.
        //
        // Sent only to the provider's own host, so a signed GCS url (the Vertex shape) can never
        // carry an OpenRouter bearer token to Google.
        const key = process.env.OPENROUTER_API_KEY?.trim();
        const toOpenRouter = /^https:\/\/openrouter\.ai\//i.test(asset.url!);
        const dl = await fetch(asset.url!, {
          headers:
            toOpenRouter && key ? { Authorization: `Bearer ${key}` } : {},
        });
        if (!dl.ok) {
          throw new Error(
            `clip generated and billed, but the download failed (${dl.status}). ` +
              `Its url is on this cell in the results file, and also in studio-cost-log.jsonl as ` +
              `outputRef — fetch it by hand rather than re-running the cell, which would buy a second copy.`,
          );
        }
        buf = Buffer.from(await dl.arrayBuffer());
      }
      const mp4 = join(OUT_DIR, `${cell.id}.mp4`);
      await writeFile(mp4, buf);

      const facts = mp4Facts(buf);
      r.bytes = buf.length;
      r.encodedWidth = facts.width;
      r.encodedHeight = facts.height;
      r.encodedSeconds = facts.seconds;
      r.usdPerSecond = facts.seconds
        ? out.cost.amountUsd / facts.seconds
        : null;

      if (ffmpeg) {
        r.strip = await extractStrip(mp4, join(OUT_DIR, cell.id), cell.seconds);
        r.drift = await driftCurve(r.strip);
      }

      console.log(
        `${" ".repeat(26)}→ $${out.cost.amountUsd.toFixed(4)} (${out.cost.basis}) · ` +
          `${(ms / 1000).toFixed(1)}s wall · ${(buf.length / 1e6).toFixed(2)} MB · ` +
          `${facts.width ?? "?"}x${facts.height ?? "?"} · ${facts.seconds?.toFixed(1) ?? "?"}s encoded · ` +
          `running $${spent.toFixed(4)}\n`,
      );
    } catch (err) {
      r.error = (err as Error).message;
      console.error(`${" ".repeat(26)}✗ ${r.error}\n`);
    }
    results.push(r);
    await saveResults(results);
  }

  await saveResults(results);

  console.log(`\n${"─".repeat(78)}`);
  console.log(
    `cells: ${results.length}   quoted total: $${quotedTotal.toFixed(4)}`,
  );
  if (RUN) {
    console.log(
      `actually spent: $${spent.toFixed(4)} of the $${CAP_USD.toFixed(2)} cap`,
    );
    const ok = results.filter((r) => !r.error).length;
    console.log(`clips: ${ok} of ${results.length}`);
  } else {
    console.log(`nothing was called and nothing was spent.`);
    console.log(
      `to run:  --run --cap ${(Math.ceil(quotedTotal * 100) / 100 + 0.07).toFixed(2)}`,
    );
  }
  console.log(`results → ${RESULTS_PATH}`);
  console.log(`${"─".repeat(78)}\n`);
  process.exit(0);
}

// ─── The blind sheet ────────────────────────────────────────────────────────────────────────────

/**
 * An HTML sheet with the source frame beside each clip, cells in a shuffled order and labelled by
 * an opaque code. `key.json` is written at the same time and is NOT linked from the sheet.
 *
 * WHAT IS HIDDEN IS THE MODEL, NOT THE QUESTION. The prompt and the source frame are shown, because
 * a scorer who cannot see what was asked for cannot score "did it do the thing". What is hidden is
 * which of the three models produced it, and the order, so the three arms cannot be read off the
 * layout.
 */
async function buildSheet() {
  const results: CellResult[] = JSON.parse(
    await readFile(RESULTS_PATH, "utf8"),
  );
  const done = results.filter((r) => !r.error);
  if (!done.length) {
    console.log("No completed cells to sheet — run with --run first.");
    return process.exit(0);
  }

  // Deterministic shuffle: a fixed seed means a re-sheet of the same run keeps the same codes, so a
  // half-finished scoring pass is not invalidated by re-running this.
  let seed = 20260918;
  const rand = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffled = [...done].sort(() => rand() - 0.5);

  const key: Record<string, unknown> = {};
  const cards = shuffled.map((r, i) => {
    const code = `C${String(i + 1).padStart(2, "0")}`;
    key[code] = {
      cell: r.cell,
      model: r.model,
      provider: r.provider,
      arm: r.arm,
      frame: r.frameLabel,
      quotedUsd: r.quotedUsd,
      actualUsd: r.actualUsd,
      usdPerSecond: r.usdPerSecond,
      wallClockMs: r.wallClockMs,
      encoded: `${r.encodedWidth}x${r.encodedHeight}`,
    };
    const strip = (r.strip ?? [])
      .map((s) => `<img src="${s.split("/").pop()}" alt="">`)
      .join("");
    const src = r.frameAsset
      ? `<div class="src"><h4>the frame it was given</h4><img src="frame-${r.frameAsset.slice(0, 8)}.jpg" alt=""></div>`
      : "";
    return `
<section class="card">
  <header><span class="code">${code}</span><span class="arm">${r.arm}</span></header>
  <p class="prompt">${r.prompt}</p>
  <div class="row">
    ${src}
    <div class="out"><h4>what came back</h4><video src="${r.cell}.mp4" controls loop muted playsinline></video></div>
  </div>
  ${strip ? `<div class="strip"><h4>t = 0 · 2 · 4 · 6 · 8s</h4><div class="films">${strip}</div></div>` : ""}
  <table class="scores">
    <tr><th>identity hold</th><th>mark integrity</th><th>motion plausibility</th></tr>
    <tr><td>__ / 5</td><td>__ / 5</td><td>__ / 5</td></tr>
  </table>
  ${r.drift?.length ? `<p class="drift">frame change vs t=0: ${r.drift.join(" · ")} <em>(change, NOT identity)</em></p>` : ""}
</section>`;
  });

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Video bake-off — blind sheet</title>
<style>
  :root { color-scheme: light dark; --bg:#0d0b08; --fg:#f5f2ec; --dim:#a39c90; --line:#2a2620; }
  body { background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,system-ui,sans-serif; margin:0; padding:32px; }
  h1 { font-size:20px; margin:0 0 4px; } .lede { color:var(--dim); margin:0 0 28px; max-width:70ch; }
  .card { border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:24px; }
  header { display:flex; gap:12px; align-items:baseline; margin-bottom:8px; }
  .code { font:600 18px ui-monospace,monospace; } .arm { color:var(--dim); font-size:13px; text-transform:uppercase; letter-spacing:.08em; }
  .prompt { color:var(--dim); margin:0 0 16px; max-width:80ch; }
  .row { display:flex; gap:20px; flex-wrap:wrap; }
  h4 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:0 0 6px; font-weight:600; }
  .src img { width:180px; border-radius:8px; display:block; }
  .out video { width:320px; border-radius:8px; display:block; background:#000; }
  .films { display:flex; gap:6px; } .films img { width:110px; border-radius:4px; }
  .strip { margin-top:16px; }
  .scores { margin-top:16px; border-collapse:collapse; } .scores th,.scores td { text-align:left; padding:4px 24px 4px 0; }
  .scores th { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); font-weight:600; }
  .scores td { font:600 15px ui-monospace,monospace; }
  .drift { color:var(--dim); font-size:12px; margin:12px 0 0; } .drift em { color:#8a8377; }
</style></head><body>
<h1>Video bake-off — blind sheet</h1>
<p class="lede">Three models, shuffled and coded. The prompt and the source frame are shown; which model made each
clip is not. Score identity hold, mark integrity and motion plausibility 1–5, then run <code>--reveal</code>.
The frame-change numbers measure CHANGE, not identity — a clip that pans scores high and may be perfect.</p>
${cards.join("\n")}
</body></html>`;

  const sheetPath = join(OUT_DIR, "sheet.html");
  await writeFile(sheetPath, html);
  await writeFile(join(OUT_DIR, "key.json"), JSON.stringify(key, null, 2));
  console.log(`\nblind sheet → ${sheetPath}`);
  console.log(
    `key (do not open until scored) → ${join(OUT_DIR, "key.json")}\n`,
  );
  process.exit(0);
}

async function reveal() {
  const key = JSON.parse(await readFile(join(OUT_DIR, "key.json"), "utf8"));
  console.log(
    "\ncode   cell                     model                      $/s      wall",
  );
  console.log("─".repeat(78));
  for (const [code, v] of Object.entries(key) as [string, any][]) {
    console.log(
      `${code}   ${String(v.cell).padEnd(24)} ${String(v.model).padEnd(26)} ` +
        `${v.usdPerSecond ? `$${v.usdPerSecond.toFixed(4)}` : "—".padEnd(7)}  ` +
        `${v.wallClockMs ? `${(v.wallClockMs / 1000).toFixed(1)}s` : "—"}`,
    );
  }
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(1);
});
