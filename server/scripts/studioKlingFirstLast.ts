/**
 * studioKlingFirstLast — FOUR CELLS. Does Kling's `last_frame` actually BRIDGE two arbitrary frames,
 * or was the prompt doing the arriving all along?
 *
 * ─── WHY THIS IS NOT THE MODERATION PROBE AGAIN ────────────────────────────────────────────────
 *
 * `studioKlingModeration` (2026-09-19, 4/4 accepted, $2.0160) asked whether this route TAKES a real
 * athlete's photograph as a first frame. It does — 5 of 5 across four photographs. That is a
 * moderation finding and its own header says it is the only thing it may be read as.
 *
 * ⚠️ IT SENT NO LAST FRAME. Every cell was ordinary image-to-video with one anchor, so nothing in it
 * speaks to the question `videoRouteFor("transition")` is parked on: given frame A and frame B, does
 * the clip START at A and ARRIVE at B?
 *
 * ─── ⚠️  WHY c4 IS THE CELL THAT MAKES THIS A PROBE AND NOT A DEMO ─────────────────────────────
 *
 * V2b's turn-and-return cell held identity 3/3 with NO last frame at all — a first frame plus a
 * prompt describing a turn was enough to get it there. So a clip that appears to "arrive" somewhere
 * may be the PROMPT arriving, not the frame.
 *
 * c4 therefore omits `lastFrame` entirely and is measured against c2's B anyway. If c4 lands as near
 * to B as c2 does, `frame_images[1]` is decoration and c2 proved nothing. Without that control, a
 * pass on the far-apart cell is uninterpretable, and wiring first-last on it would be wiring on
 * evidence that never touched the field under test.
 *
 * ─── ⚠️  WHAT IS MEASURED, AND THE ONE THING THAT IS NOT ───────────────────────────────────────
 *
 * MEASURED: how near the clip's final frame lands to B, against how near it lands to A. Both terms
 * come off the SAME clip on the SAME grid, so the comparison needs no calibration.
 *
 * NOT MEASURED — IDENTITY. The project has no identity number. `qa/identity.ts` carries
 * DEAD_RULER_CAVEAT because multimodalembedding@001 scored an invented person at 0.3584 inside her
 * own same-person band of 0.3158–0.4186, and a later curated run put a stranger at 0.304 against a
 * 0.3158 floor: the metric tracks framing, not faces. Whether Kling holds her face across a bridge
 * is a different question with no instrument, and NO CLIP HERE MAY BE READ FOR IT.
 *
 * ─── HOUSE RULES THIS FOLLOWS, EACH ONE A SCAR ─────────────────────────────────────────────────
 *
 *   • DRY RUN IS THE DEFAULT. `--run` is the only thing that spends; `--cap` refuses BEFORE each
 *     call, cumulatively, and `maxJobUsd()` applies on top.
 *   • THE MONEY IS COUNTED BEFORE ANYTHING THAT CAN THROW. V2 billed $5.6007 while its counter read
 *     $0.00, because the download threw first.
 *   • THE DOWNLOAD CARRIES THE BEARER. `unsigned_urls` are authenticated endpoints; a bare fetch
 *     gets 401 and the V2 bake-off lost all seven of its billed clips that way.
 *   • THE BALANCE IS READ BEFORE THE FIRST CALL.
 *   • THE PREDICTIONS ARE IN docs/probes/kling-first-last.md §4, DATED BEFORE THE RUN.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   npx tsx --require dotenv/config server/scripts/studioKlingFirstLast.ts
 *   OPENROUTER_API_KEY="$(gcloud secrets versions access latest --secret=OPENROUTER_API_KEY \
 *     --project=gamechanger-pocket-agent)" \
 *     npx tsx --require dotenv/config server/scripts/studioKlingFirstLast.ts \
 *       --run --cap 1.75 --confirm-pairs
 *
 * The key is taken from the environment. Passing it inline keeps it out of .env and out of every
 * file this script writes — nothing here logs, prints or stores it.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { generate, estimate } from "../studio/router";
import { MODELS, maxJobUsd } from "../studio/config";
import {
  GenerationError,
  type GenerationInputs,
  type ImageRef,
  type ProviderOpts,
} from "../studio/types";
import {
  DRIFT_HEIGHT,
  DRIFT_WIDTH,
  extractStrip,
  stripFps,
} from "../studio/video/frames";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : fallback;
}
const flag = (name: string) => argv.includes(`--${name}`);

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "0"));
const OUT_DIR = arg("out", "probe-out/kling-first-last")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const ONLY_CELL = arg("cell");
/**
 * `--pairs` — ENUMERATE AND MEASURE. Spends nothing, generates nothing, and **does not choose the
 * cells**. That last clause is the whole history of this mode.
 *
 * ─── ⚠️  d(A,B) MEASURES BACKDROP COLOUR. IT CANNOT SELECT A PAIR. ─────────────────────────────
 *
 * It was added to fix a cell selection whose measured gaps came out inverted, on the theory that a
 * number beats an impression. Measured across this library, the theory is false:
 *
 *   77146781 <-> 3b9be374   0.316   SAME shoot — same field, same net, same outfit
 *   3b9be374 <-> 37df2f85   0.301   field -> a branded indoor backdrop
 *   3b9be374 <-> 7fe0b609   0.281   field -> a white studio sweep
 *
 * A same-scene pair scores FARTHER APART than two different-scene pairs. Within-shoot distances span
 * 0.174..0.405 and cross-shoot distances span 0.281..0.504 — the ranges overlap almost entirely and
 * no threshold separates them. What the grid actually tracks is how much green versus white is in the
 * frame, which is the same lesson `qa/identity.ts` carries for its own ruler and
 * `stranger-scores-below-her-own-band` carries for framing.
 *
 * ⚠️ AND IT IS BLIND TO WHAT IS IN THE FRAME AT ALL. The pair this mode scored "widest" — and which
 * was very nearly bought — had a subject with NO FACE IN IT, a detail crop ending at the chin. It
 * scored far because it was neither green nor white. A bridge from that to a portrait is an image
 * morph, and the number it produced would have meant nothing about the feature under test.
 *
 * ─── SO WHAT THIS MODE IS FOR ──────────────────────────────────────────────────────────────────
 *
 * Reporting, and `--dump`. The cells are chosen BY EYE, from what the photographs are of; every cell
 * below cites its d as a recorded fact and none is justified by it. c1 and c2 now sit 0.015 apart and
 * that is fine — they differ by what they ARE, not by their distance.
 */
const PAIRS = flag("pairs");
/**
 * `--dump` — write the PREPARED frames to disk so the pairs can actually be looked at.
 *
 * ⚠️ IT EXISTS BECAUSE `--confirm-pairs` ASKED FOR A JUDGEMENT NOBODY COULD MAKE. The flag is Adi
 * asserting that c2's two frames are the same woman, and until this mode there was nothing on disk to
 * assert it from: `prepareFrame` holds its bytes in memory and only `pairs.json` is ever written. A
 * confirmation gate that cannot be satisfied is worse than no gate, because the only way past it is
 * to wave it through.
 *
 * What lands is the EXACT 720x1280 upright bytes a cell would send — not the original upload. That is
 * the point: a 9:16 cover crop can take a frame the model never sees, so the thing to look at is the
 * thing that travels.
 *
 * `probe-out/` is gitignored (`.gitignore:49`), so her photographs stay out of the repo. Alone it
 * dumps the four cells' frames; with `--pairs` it dumps every enumerated candidate.
 */
const DUMP = flag("dump");
/** How many of the athlete's image uploads to consider. Read at call time like every other knob. */
const PAIRS_LIMIT = Math.max(2, Number(arg("limit", "24")));

const MODEL = MODELS.kling;

// 9:16 720p, natively served (GET /api/v1/videos/models, re-read 2026-09-18: kling-v3.0-std serves
// 3..15s and 16:9 / 9:16 / 1:1 at 720p).
const W = 720;
const H = 1280;
const ASPECT = "9:16";

/**
 * FIVE SECONDS, not the moderation probe's six.
 *
 * `supportedDurationsFor(MODELS.kling)` allows 3..15. Five is the shortest that leaves a bridge room
 * to actually happen — three is two frames and a cut — and it is $0.42/cell against 6s's $0.504,
 * which is the whole difference between this probe's $1.68 and that one's $2.02.
 */
const SECONDS = Number(arg("seconds", "5"));

/**
 * ─── AUDIO OFF ON THE WIRE, AND NOW IT IS VERIFIED RATHER THAN HOPED ───────────────────────────
 *
 * The moderation run invoiced exactly `6s x $0.084` on all four cells — the first Kling invoices this
 * account has seen — so `generate_audio: false` IS honoured and the flat $0.084 arm is real. It is
 * still sent explicitly: OpenRouter's documented default is true for audio-capable models, and an
 * unset flag buys the $0.126 arm for a soundtrack this probe has no use for.
 */
const PROVIDER_PARAMS: Record<string, unknown> = { generate_audio: false };

/**
 * ─── THE PRICE OVERRIDE, AND WHY IT IS STILL AN ENV VAR ────────────────────────────────────────
 *
 * Carried forward verbatim from `studioKlingModeration`, for the reason that script states: adding
 * Kling's audio arm to `defaultPrices()` turns `router.test.ts`'s "leaves a single-arm per-second
 * model alone — Kling has no audio arm to pick" red, and that test PINS a deliberate exemption
 * somebody decided with a reason. `STUDIO_PRICE_JSON` is the designed extension point and changes
 * nothing for anybody else.
 *
 * ⚠️ THE STANDING PROPOSAL TO MOVE IT INTO config.ts IS NOW BETTER EVIDENCED, and is still Mia's
 * call rather than this probe's: the moderation invoices settled which arm a flagged request buys.
 */
process.env.STUDIO_PRICE_JSON ??= JSON.stringify({
  [MODELS.kling]: { unit: "per_second", usd: 0.084, usdWithAudio: 0.126 },
});

// ─── The cells ──────────────────────────────────────────────────────────────────────────────────

/**
 * ONE PROMPT, EVERY CELL, AND IT NAMES NO DESTINATION.
 *
 * The house rule is that the prompt travels with the frame, and it exists to stop the prompt
 * confounding a MOTION reading. Here the prompt is precisely what must not confound the reading, so
 * it is held fixed across all four and says nothing about where the clip ends. A sentence like "she
 * turns to face the other way" would hand c2 its arrival for free and make c4 unreadable.
 */
const PROMPT =
  "A single continuous live-action shot of her, moving naturally. One take, no cut.";

interface Cell {
  id: string;
  /** The first frame. Always sent. */
  a: string;
  /**
   * The frame the clip is told to ARRIVE at — and on `c4-no-last-frame`, the frame it is MEASURED
   * against without ever being sent one. See `sendsLastFrame`.
   */
  b: string;
  /** False on the control cell only. The whole probe turns on this column. */
  sendsLastFrame: boolean;
  label: string;
  rules_out: string;
  /** Written before the run (docs/probes/kling-first-last.md §4). Echoed by the dry run. */
  prediction: "arrive" | "not-arrive";
  confidence: "high" | "medium" | "low";
}

/**
 * ⚠️ ONE WOMAN, AND THIS SET CANNOT PROVE THAT BY ITSELF.
 *
 * `athlete-library-is-several-women`: this athlete's uploads are 3+ different people, and an earlier
 * reference pack was two of them. A mixed pair here would ask the model to morph one person into
 * another and every number would be measuring the morph.
 *
 * The maroon cluster is the known-consistent group, so c1, c3 and c4 stay inside it. **c2 cannot** —
 * its entire job is a DIFFERENT backdrop, and the maroon frames share one. So c2 pairs a maroon frame
 * with the studio frame, and whether those are the same woman is the one thing this script cannot
 * check and must not assume.
 *
 * Hence `--confirm-pairs`, which `--run` requires. The dry run prints every pair with its stored size,
 * its EXIF orientation and its free `d(A,B)`; the flag is the human saying they looked. It is not
 * ceremony — it is the difference between a finding and a morph.
 *
 * `e58f3a5a` IS DELIBERATELY ABSENT, as in the moderation probe: a recognizable real public figure
 * with her name legible on the bib, excluded on likeness-exposure grounds. `--asset` does not exist
 * here on purpose.
 */
/**
 * ─── ⚠️  CHOSEN BY EYE, FROM `--dump`. THE DISTANCES ARE RECORDED, NOT RELIED ON. ──────────────
 *
 * Every frame here was looked at. That is not thoroughness, it is the only method that works: see the
 * `--pairs` header for why d(A,B) cannot tell a same-scene pair from a cross-scene one, and for the
 * faceless detail crop it ranked as the best possible c2.
 *
 * Two frames a metric-chosen set had picked are rejected outright and must stay rejected:
 *
 *   2bc354e4   a jewellery detail crop, cut off at the chin. NO FACE. Unusable as an identity
 *              anchor at either end of a bridge, and unusable as a bridge target.
 *   a81be2c0   a wide action frame shot through a goal net; the face is roughly 3% of frame height,
 *              below the judgement floor `generate-identity-probe` records for action faces.
 *
 * `e58f3a5a` stays excluded (see EXCLUDED), and five uploads with a short side under 700px are out as
 * inputs regardless of content — resizing a 222x148 file to 720x1280 upscales it.
 */
// The field session: one shoot, one outfit, a goal net behind. Both faces clear, different poses.
const FIELD_SEATED = "77146781-cedc-44e4-a437-f0f0f98626a0";
const FIELD_STANDING = "3b9be374-7b0e-4372-a506-4f48e3d89ac9";
/**
 * A different session indoors, against a branded backdrop: front-facing, and the largest, clearest
 * face in the library. Chosen over the white-studio frame as c2's ARRIVAL target deliberately — that
 * one is full-body, so its face is small, and it was only ever preferred for a more dramatic backdrop
 * change. Backdrop drama is exactly the noise d(A,B) turned out to be measuring, so trading it for a
 * clear face to arrive AT is the right way round.
 */
const PORTRAIT = "37df2f85-8ff6-4726-bef9-7129c5e9d105";
/**
 * ⚠️ A DUPLICATE UPLOAD OF `PORTRAIT` — a distinct row whose pixels are identical after the crop,
 * `d = 0.000` exactly, found by `--pairs`. That makes the instrument check stronger than passing one
 * asset id twice: the gap is still zero by construction, but the request genuinely carries two rows,
 * two signed urls and a `lastFrame` populated from a row of its own. The same-id form could be
 * short-circuited somewhere and read as a pass it had not earned.
 */
const PORTRAIT_DUPE = "517ed082-5e66-4f72-ba1f-e710daa3fe4c";

/**
 * ⚠️ NEVER A CANDIDATE, IN ANY MODE. A recognizable real public figure with her name legible on the
 * bib, excluded by V2b on likeness-exposure grounds and kept excluded here at Adi's word. `--pairs`
 * enumerates the whole library, so the exclusion has to live where the enumeration can see it rather
 * than only in a comment about the hand-written cells.
 */
const EXCLUDED = new Set(["e58f3a5a"]);
const isExcluded = (assetId: string) =>
  [...EXCLUDED].some((prefix) => assetId.startsWith(prefix));

const CELLS: Cell[] = [
  {
    id: "c1-same-scene",
    a: FIELD_SEATED,
    b: FIELD_STANDING,
    sendsLastFrame: true,
    label:
      "one shoot, one outfit, the same goal net behind both · two clear faces, different poses · d = 0.316 (recorded, not the reason)",
    rules_out:
      "the floor. A bridge the prompt could plausibly manage on its own; if even this does not arrive, the feature does not exist and the rest is moot.",
    prediction: "arrive",
    confidence: "high",
  },
  {
    id: "c2-far-apart",
    a: FIELD_STANDING,
    b: PORTRAIT,
    sendsLastFrame: true,
    label:
      "outdoor field → an indoor branded backdrop, different kit · both faces clear, front-facing target · d = 0.301",
    rules_out:
      "luck. No sentence in the prompt names this destination, so arrival here is the last frame doing work. ⚠️ SAME-WOMAN: both frames were looked at and read as one person — Adi confirms via --confirm-pairs.",
    prediction: "arrive",
    confidence: "low",
  },
  {
    id: "c3-identical",
    a: PORTRAIT,
    b: PORTRAIT_DUPE,
    sendsLastFrame: true,
    label:
      "a duplicate upload · two DISTINCT rows, d = 0.000 exactly — a zero gap that still sends two real references",
    rules_out:
      "the instrument. A clip told to end where it began must arrive with ratio near 0; if it does not, the measurement is wrong and NO cell may be read.",
    prediction: "arrive",
    confidence: "high",
  },
  {
    id: "c4-no-last-frame",
    a: FIELD_STANDING,
    b: PORTRAIT,
    sendsLastFrame: false,
    label:
      "c2's A and B exactly, with the last frame NOT SENT · the only difference from c2 is the field under test",
    rules_out:
      "the prompt. If this arrives as near to B as c2 does, frame_images[1] is decoration and c2 proved nothing.",
    prediction: "not-arrive",
    confidence: "medium",
  },
];

// ─── Frames ─────────────────────────────────────────────────────────────────────────────────────

interface PreparedFrame {
  ref: ImageRef;
  /** The exact bytes handed to the model. Kept so a distance can be taken against them directly. */
  bytes: Buffer;
  storedOrientation: number | null;
  storedSize: string;
}

const frameCache = new Map<string, PreparedFrame>();

/**
 * An asset id → the exact 720x1280 upright bytes the model is handed. Lifted from
 * `studioKlingModeration.prepareFrame`, whose three steps are all load-bearing:
 *
 *   1. `.rotate()` FIRST — the EXIF-driven form, a no-op on an unflagged file. Most of the maroon
 *      cluster is stored `orientation=8`; the model ignores the stored flag, and sideways references
 *      voided an identity result once already (`person-refs-sent-sideways`).
 *   2. A COVER CROP to 9:16. These are 2:3; letterboxing hands the model bars to hallucinate into.
 *   3. The OUTPUT's dimensions are asserted — `sharp(raw).rotate().metadata()` reports the INPUT's,
 *      so the only honest check is on the bytes that leave.
 */
async function prepareFrame(assetId: string): Promise<PreparedFrame> {
  const hit = frameCache.get(assetId);
  if (hit) return hit;

  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const { signedUrl } = await import("../lib/mediaStore");

  // TENANCY: the athlete id is IN the predicate, never checked after the fact.
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

// ─── The measurement ────────────────────────────────────────────────────────────────────────────

/**
 * Mean absolute greyscale difference on frames.ts's own grid, 0..1.
 *
 * ⚠️ THE ARITHMETIC IS A DELIBERATE COPY OF `driftCurve`'S, NOT A NEW METRIC — same DRIFT_WIDTH x
 * DRIFT_HEIGHT, same `fit: "fill"`, same greyscale, same `/255`, same 3dp rounding. It is copied
 * rather than imported because `driftCurve` takes a FrameStrip and measures every frame against
 * frame 0 of the SAME clip; this needs the distance between two arbitrary images, which that
 * signature cannot express. The constants ARE imported, so the grid cannot drift even though the
 * loop is restated.
 *
 * `fit: "fill"` distorts aspect on purpose — frames.ts's reason, unchanged: it puts every shape on
 * one scale, and the distortion is identical for both operands so it cancels in the difference.
 */
async function distance(
  a: Buffer | string,
  b: Buffer | string,
): Promise<number> {
  // The branch rather than a cast: sharp's overloads take Buffer or string separately and a union
  // satisfies neither, but `as never` to quiet that is the same sin as `as any`.
  const grey = (src: Buffer | string) =>
    (typeof src === "string" ? sharp(src) : sharp(src))
      .resize(DRIFT_WIDTH, DRIFT_HEIGHT, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
  const [x, y] = await Promise.all([grey(a), grey(b)]);
  let sum = 0;
  // Guarded rather than assumed, exactly as driftCurve guards it: a decode that came back a
  // different size would otherwise read past the end of one buffer and quietly produce a number.
  const len = Math.min(x.length, y.length);
  if (!len) throw new Error("distance: an operand decoded to zero bytes");
  for (let i = 0; i < len; i++) sum += Math.abs(x[i] - y[i]);
  return Math.round((sum / len / 255) * 1000) / 1000;
}

/**
 * The clip's final frame, as a file path.
 *
 * ⚠️ IT IS THE LAST SAMPLED FRAME, NOT PROVABLY THE LAST ENCODED ONE — within `1/stripFps()` of the
 * end, so ≤0.25s at the default 4fps. That is deliberately the same thing `selectFrames` already
 * calls `"last"` (studio/video/frames.ts), and re-using the repo's existing notion beats introducing
 * a second, stricter one that only this probe would hold. A bridge that has not arrived by 0.25s
 * before the end has not arrived.
 */
async function lastFrameOf(clipPath: string): Promise<{
  path: string;
  dispose: () => Promise<void>;
  sampledAtSec: number;
}> {
  const strip = await extractStrip(clipPath, { kind: "fps" });
  if (!strip.frames.length) {
    await strip.dispose();
    throw new Error(`No frames came out of ${clipPath}`);
  }
  const last = strip.frames[strip.frames.length - 1];
  return {
    path: last.path,
    dispose: () => strip.dispose(),
    sampledAtSec: last.timeSec,
  };
}

// ─── Money ──────────────────────────────────────────────────────────────────────────────────────

let spent = 0;

/** Both ceilings, per cell: this run's cumulative `--cap` and the product's own per-job maximum. */
function assertBudget(cellId: string, amount: number, unpriced: boolean) {
  if (unpriced) {
    throw new Error(
      `${cellId}: ${MODEL} quotes as UNPRICED. An unknown cost must never spend as if it were $0. ` +
        "Add it to STUDIO_PRICE_JSON before running.",
    );
  }
  const jobCap = maxJobUsd();
  if (amount > jobCap) {
    throw new Error(
      `${cellId}: quotes $${amount.toFixed(4)}, over maxJobUsd $${jobCap.toFixed(2)}.`,
    );
  }
  if (spent + amount > CAP_USD) {
    throw new Error(
      `${cellId}: $${(spent + amount).toFixed(4)} cumulative — over the --cap $${CAP_USD.toFixed(2)}. ` +
        "Stopping BEFORE the call.",
    );
  }
}

/**
 * Read the account balance before the first paid call and refuse if it cannot cover the quote.
 * Lifted from `studioKlingModeration.assertFunded`: the raw readout is PRINTED, the numeric gate
 * applies only when both fields are present and numeric, and an unrecognized shape STOPS the run
 * rather than being narrated into a pass.
 */
async function assertFunded(quotedTotal: number): Promise<void> {
  if (flag("skip-balance")) {
    console.log(
      "⚠️  --skip-balance: the balance was NOT read. You are asserting it by eye.\n",
    );
    return;
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key)
    throw new Error(
      "OPENROUTER_API_KEY is not set — nothing to authenticate the balance read with.",
    );

  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.text();
  if (!res.ok)
    throw new Error(
      `Balance read failed (${res.status}): ${body.slice(0, 300)}`,
    );
  console.log(`   balance readout (raw): ${body.slice(0, 400)}`);

  let parsed: { data?: { total_credits?: unknown; total_usage?: unknown } };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      "Balance read returned non-JSON. Read the line above, then --skip-balance if it is fine.",
    );
  }
  const credits = parsed?.data?.total_credits;
  const usage = parsed?.data?.total_usage;
  if (typeof credits !== "number" || typeof usage !== "number") {
    throw new Error(
      "Balance read did not carry the numeric total_credits/total_usage this gate knows how to " +
        "check. Read the raw line above, then --skip-balance if it is fine.",
    );
  }
  const remaining = credits - usage;
  console.log(
    `   remaining: $${remaining.toFixed(4)} · this run quotes $${quotedTotal.toFixed(4)}`,
  );
  if (remaining < quotedTotal) {
    throw new Error(
      `Balance $${remaining.toFixed(4)} does not cover the quoted $${quotedTotal.toFixed(4)}. ` +
        "Top up before running; a mid-run exhaustion bills for the cells that already went.",
    );
  }
  console.log("   ✅ funded\n");
}

// ─── One cell ───────────────────────────────────────────────────────────────────────────────────

type Outcome =
  | "measured"
  | "refused_at_submit"
  | "failed_after_submit"
  | "error";

interface CellResult {
  cellId: string;
  aAssetId: string;
  bAssetId: string;
  sentLastFrame: boolean;
  prediction: string;
  outcome: Outcome;
  status?: number;
  detail?: string;
  submittedAt: string;
  elapsedMs: number;
  costUsd?: number;
  costBasis?: "estimated" | "reported";
  clipPath?: string;
  /** The free control distance, on the two INPUTS. Computed at dry run, before any spend. */
  dAB?: number;
  /** How near the clip's final frame landed to B, and to A. Both off the same clip, same grid. */
  dLastB?: number;
  dLastA?: number;
  /** Where the last sampled frame sat, in seconds. ≤ 1/stripFps() from the end — see lastFrameOf. */
  sampledAtSec?: number;
  /**
   * ⚠️ THE VERDICT — `dLastB < dLastA`, and **null when A and B are the same image**.
   *
   * The first paid run found that out the expensive way. With an identical pair, d(last,A) and
   * d(last,B) are THE SAME NUMBER, so a strict `<` is false however well the clip performed: c3
   * reported "did not arrive" having ended 0.005 from its target. That is a tautology, not a
   * measurement, and printing it as a failure invites exactly the wrong conclusion about a cell whose
   * whole job is to validate the instrument.
   */
  arrived?: boolean | null;
  /** Colour only: how much of the given gap was closed. NEVER a threshold — see the doc's §2. */
  ratio?: number;
}

async function runCell(cell: Cell): Promise<CellResult> {
  const a = await prepareFrame(cell.a);
  const b = await prepareFrame(cell.b);
  const dAB = await distance(a.bytes, b.bytes);

  const inputs: GenerationInputs = {
    prompt: PROMPT,
    references: [a.ref],
    width: W,
    height: H,
    aspectRatio: ASPECT,
    durationSeconds: SECONDS,
    // ⚠️ THE FIELD UNDER TEST. Absent on c4, which is the control the whole probe rests on.
    ...(cell.sendsLastFrame ? { lastFrame: b.ref } : {}),
  };
  const opts: ProviderOpts = {
    provider: "openrouter",
    model: MODEL,
    providerParams: PROVIDER_PARAMS,
    // Log-only, never sent. Both frames, because both are inputs to the cell even when one is only
    // a measuring stick.
    refIds: cell.sendsLastFrame ? [cell.a, cell.b] : [cell.a],
  };

  const plan = estimate("video.generate", inputs, opts);
  assertBudget(cell.id, plan.cost.amountUsd, !!plan.cost.unpriced);

  const submittedAt = new Date().toISOString();
  const started = Date.now();

  // COUNT THE MONEY FIRST. Past this line a charge may have happened, and everything after it is
  // written to be safe with that being true.
  spent += plan.cost.amountUsd;

  const base: CellResult = {
    cellId: cell.id,
    aAssetId: cell.a,
    bAssetId: cell.b,
    sentLastFrame: cell.sendsLastFrame,
    prediction: cell.prediction,
    outcome: "measured",
    submittedAt,
    elapsedMs: 0,
    dAB,
  };

  try {
    const out = await generate("video.generate", inputs, opts);
    const result: CellResult = {
      ...base,
      elapsedMs: Date.now() - started,
      costUsd: out.cost.amountUsd,
      costBasis: out.cost.basis,
    };

    // ─── THE DOWNLOAD CARRIES THE BEARER ──────────────────────────────────────────────────────
    // `unsigned_urls` reads as "no credential needed" and is not: they are
    // `/api/v1/videos/{id}/content`, ordinary authenticated endpoints. A bare fetch gets 401, and
    // the V2 bake-off lost all seven of its billed clips exactly that way. The header goes ONLY to
    // the provider's own host, so a signed GCS url can never carry an OpenRouter token to Google.
    const asset = out.assets[0];
    let clip: string | undefined;
    if (asset?.url) {
      const key = process.env.OPENROUTER_API_KEY?.trim();
      const toOpenRouter = /^https:\/\/openrouter\.ai\//i.test(asset.url);
      const dl = await fetch(asset.url, {
        headers: toOpenRouter && key ? { Authorization: `Bearer ${key}` } : {},
      });
      if (dl.ok) {
        clip = join(OUT_DIR, `${cell.id}.mp4`);
        await writeFile(clip, Buffer.from(await dl.arrayBuffer()));
      } else {
        // NOT fatal and NOT a refusal: the cell was billed, only the file was lost. Without the file
        // there is no measurement, so the cell is reported unmeasured rather than guessed at.
        result.detail = `billed, but the download returned ${dl.status}. The url is in studio-cost-log.jsonl as outputRef — fetch it by hand rather than re-running, which buys a second clip.`;
      }
    } else if (asset?.bytes) {
      clip = join(OUT_DIR, `${cell.id}.mp4`);
      await writeFile(clip, asset.bytes);
    }
    if (!clip) return { ...result, outcome: "error" };
    result.clipPath = clip;

    // ── The measurement. Both terms off the same clip, on the same grid. ──
    const last = await lastFrameOf(clip);
    try {
      result.sampledAtSec = last.sampledAtSec;
      result.dLastB = await distance(last.path, b.bytes);
      result.dLastA = await distance(last.path, a.bytes);
      // Null rather than false for an identical pair — see the field's note. `heldTarget` below is
      // what that cell is actually read on.
      result.arrived = dAB > 0 ? result.dLastB < result.dLastA : null;
      // Colour. `dAB` of 0 is c3 by construction, and a ratio over it would be a division by zero
      // reported as Infinity — so it is simply not computed there.
      result.ratio =
        dAB > 0 ? Math.round((result.dLastB / dAB) * 1000) / 1000 : undefined;
    } finally {
      await last.dispose();
    }
    return result;
  } catch (err: unknown) {
    const status = err instanceof GenerationError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const submitFailed = /\/videos failed/.test(message);
    const outcome: Outcome =
      submitFailed &&
      typeof status === "number" &&
      status >= 400 &&
      status < 500
        ? "refused_at_submit"
        : /Video job .* failed/.test(message)
          ? "failed_after_submit"
          : "error";
    // A refusal at submit bills nothing — give the budget back so the cap keeps its meaning across
    // the remaining cells.
    if (outcome === "refused_at_submit") spent -= plan.cost.amountUsd;
    return {
      ...base,
      outcome,
      status,
      detail: message.slice(0, 600),
      elapsedMs: Date.now() - started,
    };
  }
}

/**
 * Write prepared frames to `probe-out/.../frames/` and print the paths. $0 — sharp and a file write.
 *
 * Named by asset id and nothing else. No caption, no handle, no filename derived from anything she
 * typed: `never paste personal data into anything` applies to a filename as much as to a log line.
 */
async function dumpFrames(assetIds: string[]): Promise<void> {
  const dir = join(OUT_DIR, "frames");
  await mkdir(dir, { recursive: true });
  console.log(`\n   ── prepared frames, exactly as a cell would send them ──`);
  for (const id of assetIds) {
    const f = await prepareFrame(id);
    const out = join(dir, `${id.slice(0, 8)}.jpg`);
    await writeFile(out, f.bytes);
    console.log(
      `   ${out}   (from ${f.storedSize}, orientation=${f.storedOrientation ?? "none"})`,
    );
  }
  console.log(
    `\n   ⚠️  gitignored, and these are real photographs of a real person. Look, decide, delete.`,
  );
  console.log(`   open them:  open ${dir}\n`);
}

// ─── `--pairs`: choose the cells from MEASURED distance, never from what the photographs are of ──

/**
 * Every image upload of this athlete's, as the pairwise distance matrix on the verdict's own grid.
 *
 * ⚠️ $0 AND READ-ONLY. One SELECT filtered by athlete id, GCS reads of her own pixels, sharp, and
 * arithmetic. No model call, no write, no other athlete's rows.
 *
 * ⚠️ IT REPORTS GEOMETRY AND DISTANCE, AND IDENTIFIES NOBODY. A low distance means "these two frames
 * LOOK alike after the crop", which is a decent proxy for one shoot and **no evidence at all about
 * who is in them** — a different woman in the same location scores just as close. This athlete's
 * library is 3+ different people (`athlete-library-is-several-women`), so the same-woman judgement is
 * Adi's and `--confirm-pairs` is where he makes it. Nothing here prints a name, a caption or a handle.
 *
 * The CROP-LOSS column is why this mode exists: it is the confound that inverted the first selection.
 */
/** What `reportPairs` last enumerated, so `--dump` beside it covers the same set. */
let lastEnumerated: string[] = [];

async function reportPairs(): Promise<void> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and, isNotNull, desc } = await import("drizzle-orm");

  // TENANCY: the athlete id is IN the predicate. `origin: 'upload'` matches what ReferencePicker
  // offers her (uploads are straightened on the way in); IMAGE excludes clips and carousel parents.
  const rows = await db
    .select({ id: mediaAssets.id, w: mediaAssets.width, h: mediaAssets.height })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, ATHLETE_ID),
        eq(mediaAssets.origin, "upload"),
        eq(mediaAssets.media_type, "IMAGE"),
        isNotNull(mediaAssets.gcs_path),
      ),
    )
    .orderBy(desc(mediaAssets.created_at))
    .limit(PAIRS_LIMIT);

  const candidates = rows.filter((r) => !isExcluded(r.id));
  const skipped = rows.length - candidates.length;

  console.log(
    "\n─── Candidate frames, and the pairwise distance that must choose the cells ──",
  );
  console.log(
    `   athlete    ${ATHLETE_ID}  ·  ${candidates.length} image upload(s)${skipped ? `  (${skipped} excluded by name)` : ""}`,
  );
  console.log(
    `   grid       ${DRIFT_WIDTH}x${DRIFT_HEIGHT}, the same one the verdict uses`,
  );
  console.log(
    `   ⚠️  distance is APPEARANCE AFTER THE CROP. It identifies nobody — see this function's note.\n`,
  );

  // Prepare every candidate once. `prepareFrame` caches, rotates before cropping and asserts the
  // output's dimensions, so what is measured here is byte-for-byte what a cell would send.
  const prepared: { id: string; f: PreparedFrame; keptWidthPct: number }[] = [];
  for (const r of candidates) {
    try {
      const f = await prepareFrame(r.id);
      // How much of the source width survives a 9:16 cover crop. Derived from the frame's REAL
      // stored size (after rotation), not from the width/height columns, which can disagree with
      // the bytes for an EXIF-flagged file.
      const [sw, sh] = f.storedSize.split("x").map(Number);
      const rotated = (f.storedOrientation ?? 1) >= 5 ? [sh, sw] : [sw, sh];
      const needW = rotated[1] * (W / H);
      prepared.push({
        id: r.id,
        f,
        keptWidthPct: Math.min(
          100,
          Math.round((needW / rotated[0]) * 1000) / 10,
        ),
      });
    } catch (err) {
      console.log(
        `   ${r.id}  ⚠️  skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const c of prepared) {
    console.log(
      `   ${c.id}  ${c.f.storedSize.padEnd(11)} orientation=${String(c.f.storedOrientation ?? "none").padEnd(4)} → keeps ${c.keptWidthPct}% of its width`,
    );
  }

  // The matrix. Every unordered pair once — d is symmetric.
  const pairs: { a: string; b: string; d: number }[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      pairs.push({
        a: prepared[i].id,
        b: prepared[j].id,
        d: await distance(prepared[i].f.bytes, prepared[j].f.bytes),
      });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  lastEnumerated = prepared.map((c) => c.id);

  const short = (id: string) => id.slice(0, 8);
  console.log(
    `\n   ── ${pairs.length} pairs, by measured d(A,B) ────────────────────────────────`,
  );
  console.log(`   CLOSEST — candidates for c1 (the floor, a small gap):`);
  for (const p of pairs.slice(0, 8))
    console.log(`     ${short(p.a)} ↔ ${short(p.b)}   d = ${p.d.toFixed(3)}`);
  console.log(
    `\n   FARTHEST — candidates for c2 (the discriminator, a large gap):`,
  );
  for (const p of pairs.slice(-8).reverse())
    console.log(`     ${short(p.a)} ↔ ${short(p.b)}   d = ${p.d.toFixed(3)}`);

  const spread = pairs.length
    ? `${pairs[0].d.toFixed(3)} … ${pairs[pairs.length - 1].d.toFixed(3)}`
    : "n/a";
  console.log(`\n   full range  ${spread}`);
  console.log(
    `   ⚠️  a small d is evidence of ONE SHOOT, never of one woman. Confirm the people yourself.`,
  );
  console.log(
    `   ⚠️  c2 also needs a DIFFERENT BACKDROP, which a large d suggests and does not prove.\n`,
  );

  await writeFile(
    join(OUT_DIR, "pairs.json"),
    JSON.stringify(
      {
        athleteId: ATHLETE_ID,
        grid: { width: DRIFT_WIDTH, height: DRIFT_HEIGHT },
        frames: prepared.map((c) => ({
          assetId: c.id,
          storedSize: c.f.storedSize,
          storedOrientation: c.f.storedOrientation,
          keptWidthPct: c.keptWidthPct,
        })),
        pairs,
      },
      null,
      2,
    ),
  );
  console.log(`   written  ${join(OUT_DIR, "pairs.json")}\n`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  // `--pairs` is a different question from the probe's own and shares only the measurement. It runs
  // first and returns: there is no path from here to a paid call.
  if (PAIRS || DUMP) {
    if (RUN)
      throw new Error(
        "--pairs and --dump measure and spend nothing. They are different jobs from --run; drop it.",
      );
    await mkdir(OUT_DIR, { recursive: true });
    if (PAIRS) await reportPairs();
    if (DUMP) {
      // The cells' own frames by default — those are the ones --confirm-pairs is a judgement about.
      // With --pairs, everything it just enumerated, which is the wider set to choose from.
      const ids = PAIRS
        ? [...new Set(lastEnumerated)]
        : [...new Set(CELLS.flatMap((c) => [c.a, c.b]))];
      await dumpFrames(ids);
    }
    return;
  }

  const cells = ONLY_CELL ? CELLS.filter((c) => c.id === ONLY_CELL) : CELLS;
  if (!cells.length)
    throw new Error(
      `--cell ${ONLY_CELL} matched nothing. Known: ${CELLS.map((c) => c.id).join(", ")}`,
    );

  console.log(
    "\n─── Kling first-and-last: does a last frame BRIDGE? ────────────────────────",
  );
  console.log(`   model      ${MODEL}`);
  console.log(
    `   shape      ${W}x${H} ${ASPECT} · ${SECONDS}s · generate_audio=false (verified honoured)`,
  );
  console.log(
    `   question   given A and B, does the clip ARRIVE at B — or was the prompt doing it?`,
  );
  console.log(`   verdict    d(last,B) < d(last,A). No invented threshold.`);
  console.log(
    `   NOT        identity. There is no instrument for it — see the header.`,
  );
  console.log(
    `   predictions docs/probes/kling-first-last.md §4, written before the run`,
  );
  console.log(
    `   measure    frames.ts grid ${DRIFT_WIDTH}x${DRIFT_HEIGHT}, last sampled frame at ${stripFps()}fps\n`,
  );

  // Quote and measure d(A,B) for every cell before anything is called. Both are free.
  let quotedTotal = 0;
  for (const cell of cells) {
    const a = await prepareFrame(cell.a);
    const b = await prepareFrame(cell.b);
    const dAB = await distance(a.bytes, b.bytes);
    const plan = estimate(
      "video.generate",
      {
        prompt: PROMPT,
        references: [a.ref],
        width: W,
        height: H,
        aspectRatio: ASPECT,
        durationSeconds: SECONDS,
        ...(cell.sendsLastFrame ? { lastFrame: b.ref } : {}),
      },
      { provider: "openrouter", model: MODEL, providerParams: PROVIDER_PARAMS },
    );
    quotedTotal += plan.cost.amountUsd;

    console.log(`   ${cell.id}`);
    console.log(`     pair       ${cell.label}`);
    console.log(
      `     A ${cell.a}  ${a.storedSize}, orientation=${a.storedOrientation ?? "none"}`,
    );
    console.log(
      `     B ${cell.b}  ${b.storedSize}, orientation=${b.storedOrientation ?? "none"}${cell.sendsLastFrame ? "" : "   ⚠️ NOT SENT — control cell"}`,
    );
    console.log(`     d(A,B)     ${dAB.toFixed(3)}   (free, on the inputs)`);
    console.log(`     rules out  ${cell.rules_out}`);
    console.log(
      `     predicted  ${cell.prediction.toUpperCase()} (${cell.confidence})`,
    );
    console.log(
      `     quote      $${plan.cost.amountUsd.toFixed(4)}${plan.cost.unpriced ? "  ⚠️ UNPRICED" : ""}  ${plan.cost.detail ?? ""}\n`,
    );
  }

  console.log(
    `   ── quoted total  $${quotedTotal.toFixed(4)} across ${cells.length} cells`,
  );
  console.log(
    `      a refusal bills $0, so this is the CEILING, not the expectation.\n`,
  );

  if (!RUN) {
    console.log(`   DRY RUN — nothing was called and nothing was billed.`);
    console.log(
      `   ⚠️  BEFORE --run: look at the pairs above. c2 crosses clusters and this athlete's library`,
    );
    console.log(
      `      is 3+ different people; a mixed pair measures a morph, not a bridge.`,
    );
    console.log(
      `   to run:  --run --cap ${(Math.ceil(quotedTotal * 100) / 100 + 0.07).toFixed(2)} --confirm-pairs\n`,
    );
    return;
  }

  if (!(CAP_USD > 0))
    throw new Error(
      "--run requires --cap <usd>. Refusing to spend without a ceiling.",
    );
  if (CAP_USD < quotedTotal) {
    throw new Error(
      `--cap $${CAP_USD.toFixed(2)} is under the quoted $${quotedTotal.toFixed(4)}. Raise it or use --cell to run fewer.`,
    );
  }
  if (!flag("confirm-pairs")) {
    throw new Error(
      "--run requires --confirm-pairs. This athlete's library is 3+ different people " +
        "(athlete-library-is-several-women), and c2 deliberately crosses clusters. Read the dry run's " +
        "pair lines, satisfy yourself every pair is ONE woman, then pass the flag. A mixed pair does " +
        "not produce a weaker finding — it produces a measurement of a morph.",
    );
  }

  await assertFunded(quotedTotal);
  await mkdir(OUT_DIR, { recursive: true });

  const results: CellResult[] = [];
  for (const cell of cells) {
    process.stdout.write(`   ${cell.id} … `);
    const r = await runCell(cell);
    results.push(r);
    if (r.outcome !== "measured") {
      console.log(`⚠️  ${r.outcome}${r.status ? ` (${r.status})` : ""}`);
      if (r.detail) console.log(`      ${r.detail.split("\n")[0]}`);
      continue;
    }
    const billed =
      r.costBasis === "reported"
        ? `billed $${r.costUsd!.toFixed(4)}`
        : "billed UNREPORTED";
    console.log(
      `${r.arrived === null ? "·  N/A (identical pair — read d(last,B))" : r.arrived ? "✅ ARRIVED" : "🛑 did NOT arrive"}  ` +
        `d(last,B)=${r.dLastB!.toFixed(3)} vs d(last,A)=${r.dLastA!.toFixed(3)}` +
        `${r.ratio !== undefined ? ` · ratio ${r.ratio.toFixed(3)}` : ""}  ` +
        `(${(r.elapsedMs / 1000).toFixed(1)}s, ${billed}, quoted so far $${spent.toFixed(4)})`,
    );
  }

  await writeFile(
    join(OUT_DIR, "results.json"),
    JSON.stringify(
      {
        model: MODEL,
        seconds: SECONDS,
        grid: { width: DRIFT_WIDTH, height: DRIFT_HEIGHT },
        stripFps: stripFps(),
        prompt: PROMPT,
        results,
      },
      null,
      2,
    ),
  );

  // ─── The gate, as agreed before the run (docs/probes/kling-first-last.md §6) ─────────────────
  const by = (id: string) => results.find((r) => r.cellId === id);
  const c1 = by("c1-same-scene");
  const c2 = by("c2-far-apart");
  const c3 = by("c3-identical");
  const c4 = by("c4-no-last-frame");

  console.log(
    "\n─── Verdict ────────────────────────────────────────────────────────────────",
  );
  for (const r of results) {
    console.log(
      `   ${r.cellId.padEnd(18)} predicted ${r.prediction.padEnd(11)} → ` +
        (r.outcome === "measured"
          ? `${r.arrived === null ? `N/A — d(last,B) ${r.dLastB!.toFixed(3)}` : r.arrived ? "ARRIVED" : "did not arrive"}${r.ratio !== undefined ? ` (ratio ${r.ratio.toFixed(3)})` : ""}`
          : r.outcome),
    );
  }
  console.log(`   quoted ceiling $${spent.toFixed(4)}`);

  // ⚠️ THE INSTRUMENT CHECK COMES FIRST AND CAN VOID EVERYTHING ELSE.
  //
  // It cannot use `arrived`, which is null for an identical pair, and it may not use an invented
  // threshold. So it compares c3's distance-from-target against the FREE DRIFT this very run
  // measured: the smallest d(last,A) among the cells that did move is how far a 5s clip wanders from
  // its own first frame. A clip told to end where it began must sit far below that.
  const freeDrift = results
    .filter((r) => r.outcome === "measured" && r.arrived !== null)
    .map((r) => r.dLastA!)
    .reduce((a, b) => Math.min(a, b), Infinity);
  const c3Held =
    c3?.outcome === "measured" &&
    Number.isFinite(freeDrift) &&
    c3.dLastB! < freeDrift;

  if (c3?.outcome === "measured" && !c3Held) {
    console.log(
      `\n   🛑 c3-identical ended ${c3.dLastB!.toFixed(3)} from a target it started on, against a free`,
    );
    console.log(
      `      drift of ${freeDrift.toFixed(3)} measured in this run. THE INSTRUMENT IS WRONG, not the model.`,
    );
    console.log(`      No cell may be read.`);
  } else if (c4?.outcome === "measured" && c4.arrived) {
    console.log(
      "\n   🛑 c4 arrived WITHOUT a last frame. The prompt was doing the work, so frame_images[1]",
    );
    console.log(
      "      is unproven whatever c2 did. Wire nothing; redesign the probe before buying more.",
    );
  } else if (c1?.arrived && c2?.arrived) {
    console.log(
      "\n   → the last frame is load-bearing on arbitrary pairs. Kling first-last can be wired,",
    );
    console.log("     and card 2's ladder proceeds as planned.");
  } else if (c1?.arrived && c2 && !c2.arrived) {
    console.log(
      "\n   → Kling bridges NEAR pairs only. That is a real feature and a narrower one: a transition",
    );
    console.log(
      "     between two clips of the same scene. Card 2 ships with a same-scene precondition, or not.",
    );
  } else {
    console.log(
      "\n   → c1 did not arrive. The floor failed, so first-last does not work here at all and the",
    );
    console.log("     remaining cells are moot. Wire nothing.");
  }

  console.log(`\n   results  ${join(OUT_DIR, "results.json")}`);
  console.log(
    "   ⚠️  bridging only. No clip here may be read for identity or quality.\n",
  );
  console.log("   The count is reported. The decision is Adi's.\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    if (spent > 0)
      console.error(
        `   ⚠️  $${spent.toFixed(4)} was already quoted-and-committed before this threw.\n`,
      );
    process.exit(1);
  });
