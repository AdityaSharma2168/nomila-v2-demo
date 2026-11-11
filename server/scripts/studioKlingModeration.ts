/**
 * studioKlingModeration — FOUR CELLS. Does Kling's route accept a real athlete's photograph as an
 * image-to-video first frame RELIABLY, or only sometimes?
 *
 * ─── WHY THIS RUNS BEFORE ANY KLING ADAPTER CODE ───────────────────────────────────────────────
 *
 * Kling's real-athlete acceptance is n = 1. One cell on 2026-09-18 submitted one photograph and the
 * route took it. That is an anecdote, not a property, and the comparison case is ugly: Seedance's
 * route REFUSED real-person i2v 6 of 6 as stated BytePlus policy. Kling's user policy has no
 * real-person clause at all — only a discretion to "moderate, block, or delete the Input" — and
 * discretion is exactly the shape that produces an intermittent refusal.
 *
 * An adapter wired on a single acceptance would fail INTERMITTENTLY in production, which is the
 * worst failure mode available: it looks like a bug, it is not reproducible, and it burns an
 * athlete's approval each time. So acceptance gets confirmed first, on four different photographs,
 * and the wiring waits for the count.
 *
 * ⚠️ THIS MEASURES ACCEPTANCE AND NOTHING ELSE. Not identity, not quality, not cost. No clip this
 * produces may be scored. If you want to know whether Kling holds a face, that is a different probe
 * with a different design (see docs/probes/kling-first-last.md).
 *
 * ─── WHY ONE PROMPT ACROSS ALL FOUR CELLS ──────────────────────────────────────────────────────
 *
 * The usual house rule is that the prompt travels with the frame — V2 asked a woman already looking
 * up to look up, and measured the disagreement. That rule exists to stop the PROMPT confounding a
 * motion reading.
 *
 * Here the variable under test is the FRAME, so the rule inverts: a per-frame prompt would confound
 * "the route refused this photograph" with "the route refused this sentence". One neutral,
 * near-static, backdrop-agnostic beat for every cell, and the frame is the only thing that moves.
 *
 * ─── HOUSE RULES THIS FOLLOWS ──────────────────────────────────────────────────────────────────
 *
 *   • DRY RUN IS THE DEFAULT. `--run` is the only thing that spends, and `--cap` refuses BEFORE
 *     each call, cumulatively. The product's own maxJobUsd() is applied on top.
 *   • THE MONEY IS COUNTED BEFORE ANYTHING THAT CAN THROW. V2 billed $5.6007 while its counter read
 *     $0.00, because the download threw first.
 *   • THE QUOTE IS THE EXPENSIVE ARM. See the STUDIO_PRICE_JSON note below.
 *   • THE BALANCE IS READ BEFORE THE FIRST CALL and the run refuses if it cannot cover the quote.
 *   • THE PREDICTIONS ARE IN docs/probes/kling-moderation.md, DATED BEFORE THE RUN.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   npx tsx --require dotenv/config server/scripts/studioKlingModeration.ts
 *   OPENROUTER_API_KEY="$(gcloud secrets versions access latest --secret=OPENROUTER_API_KEY \
 *     --project=gamechanger-pocket-agent)" \
 *     npx tsx --require dotenv/config server/scripts/studioKlingModeration.ts --run --cap 3.10
 *
 * The key is taken from the environment. Passing it inline as above keeps it out of .env and out of
 * any file this script writes — nothing here logs, prints or stores it.
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
const OUT_DIR = arg("out", "probe-out/kling-moderation")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const ONLY_CELL = arg("cell");
/** Re-submit the SAME cell N times — how "this image is refused" is told from "this submission was". */
const REPEAT = Math.max(1, Number(arg("repeat", "1")));

const MODEL = MODELS.kling;

// 6s 9:16 720p. Kling v3 serves 3..15s and 16:9 / 9:16 / 1:1 at 720p (GET /api/v1/videos/models,
// re-read 2026-09-18), so 6s is served natively rather than rounded to.
const W = 720;
const H = 1280;
const ASPECT = "9:16";
const SECONDS = Number(arg("seconds", "6"));

/**
 * ─── AUDIO OFF ON THE WIRE, AUDIO ON IN THE QUOTE ──────────────────────────────────────────────
 *
 * Two different questions and they get two different answers on purpose.
 *
 * ON THE WIRE: OpenRouter's video guide says `generate_audio` "defaults to true for models that
 * support audio output", and kling-v3.0-std advertises audio. An unset flag therefore buys the
 * DEARER arm (0.126/s against 0.084/s) for a soundtrack this probe has no use for, so the flag is
 * sent explicitly false. `generateVideo` spreads `providerParams` at the TOP level of the body,
 * which is where OpenRouter documents this field.
 *
 * IN THE QUOTE: that field name is UNVERIFIED on this provider — nobody has seen it honoured on an
 * invoice from this account. So pricing ignores it and quotes the with-audio arm anyway. If the
 * flag works we are over-quoted by 33% and nothing breaks; if it does not, the quote was right.
 * Over-quoting is the safe direction, and it is the same rule `openrouterAdapter.estimate` already
 * applies to Veo.
 */
const PROVIDER_PARAMS: Record<string, unknown> = { generate_audio: false };

/**
 * ─── THE PRICE OVERRIDE, AND WHY IT IS AN ENV VAR AND NOT AN EDIT TO THE TABLE ─────────────────
 *
 * `defaultPrices()` gives Kling a flat `{ per_second, usd: 0.084 }` and exempts its audio arm IN
 * WRITING — "Nothing sends Kling an audio flag today, so a second arm would be one no request could
 * ever select". These cells are the first requests that could select it, which makes the flat rate a
 * 50% under-quote: the one direction a pre-generation check exists to prevent.
 *
 * ⚠️ FIXED HERE, NOT IN config.ts, DELIBERATELY. Adding the arm to the shared table turns
 * `router.test.ts`'s "leaves a single-arm per-second model alone — Kling has no audio arm to pick"
 * red, and that test is not a bug — it PINS a deliberate exemption somebody decided with a reason.
 * Rewriting someone's decision-test to match my own change to shared pricing wants sign-off, not a
 * quiet commit. `STUDIO_PRICE_JSON` is the designed extension point, it is merged over the defaults
 * by `priceFor`, and it changes nothing for anybody else.
 *
 * Adding `usdWithAudio` (rather than flattening `usd` to 0.126) is what makes the OpenRouter
 * adapter's existing always-quote-the-audio-arm gate do the work, instead of a second mechanism.
 *
 * The standing proposal to move this into config.ts is docs/probes/kling-first-last.md §2 and is
 * Mia's call. Both figures re-read live from `GET /api/v1/videos/models` on 2026-09-18.
 */
process.env.STUDIO_PRICE_JSON ??= JSON.stringify({
  [MODELS.kling]: { unit: "per_second", usd: 0.084, usdWithAudio: 0.126 },
});

// ─── The cells ──────────────────────────────────────────────────────────────────────────────────

/**
 * One neutral beat, every cell. Near-static on purpose: a large motion ask would give a refusal a
 * second possible cause, and motion is not what is being measured.
 */
const PROMPT =
  "She stands facing the camera and shifts her weight slightly, a small natural movement. " +
  "The light and the background behind her are unchanged.";

interface Cell {
  id: string;
  assetId: string;
  /** What this frame is, in one line — printed on the dry run so the set can be checked by eye. */
  label: string;
  /** Written before the run. Echoed by the dry run so it cannot be revised afterwards. */
  prediction: "accept" | "refuse";
  confidence: "high" | "medium" | "medium-low";
}

/**
 * Three frames V2b vetted by rendering all 18 of this athlete's uploads through the 9:16 crop and
 * looking at every one; a fourth from that pass's named "usable front-facing alternates".
 *
 * ⚠️ `e58f3a5a` IS DELIBERATELY ABSENT — a recognizable real public figure with her name legible on
 * the bib, excluded by V2b on likeness-exposure grounds. It is also the frame most likely to trip a
 * moderation route, which is exactly why leaving it out is a choice worth stating rather than a gap.
 * Reversing that exclusion is Adi's call; `--asset` does not exist here on purpose.
 *
 * ⚠️ THE EXIF FLAG IS NOT ASSERTED HERE, IT IS REPORTED. Most of the maroon cluster is stored
 * `orientation=8`, and a sideways reference voided an identity result once already — so the set
 * deliberately includes that cluster rather than only the unflagged studio frame. `prepareFrame`
 * rotates before cropping, and the dry run PRINTS each frame's real stored size and orientation
 * straight off the bytes. Read those lines; do not take a comment's word for which frame is flagged.
 */
const CELLS: Cell[] = [
  {
    id: "c1-studio",
    assetId: "7fe0b609-740e-409b-a0e0-b159f5a7718e",
    label:
      "studio subject · 1106x1518 png · plain seamless backdrop, dead-on, face ~12.5% of frame height",
    prediction: "accept",
    confidence: "high",
  },
  {
    id: "c2-maroon-med",
    assetId: "77146781-cedc-44e4-a437-f0f0f98626a0",
    label: "maroon cluster · 6000x4000 jpeg · V2b's MED frame, field backdrop",
    prediction: "accept",
    confidence: "medium",
  },
  {
    id: "c3-maroon-hard",
    assetId: "3b9be374-7b0e-4372-a506-4f48e3d89ac9",
    label:
      "maroon cluster · 4000x6000 jpeg · V2b's HARD frame, largest clean face in the set",
    prediction: "accept",
    confidence: "medium",
  },
  {
    id: "c4-alt",
    assetId: "37df2f85-8ff6-4726-bef9-7129c5e9d105",
    label:
      "unpinned front-facing alternate · 1056x1408 png · large 'GET LOUD' background text · submitted nowhere before",
    prediction: "accept",
    confidence: "medium-low",
  },
];

// ─── Frames ─────────────────────────────────────────────────────────────────────────────────────

interface PreparedFrame {
  ref: ImageRef;
  storedOrientation: number | null;
  storedSize: string;
}

const frameCache = new Map<string, PreparedFrame>();

/**
 * An asset id → the exact 720x1280 upright bytes the model is handed.
 *
 *   1. `.rotate()` FIRST — the EXIF-driven form, a no-op on an unflagged file. The model ignores the
 *      stored flag, which is what voided two earlier spike runs.
 *   2. A COVER CROP to 9:16. These photographs are 2:3; letterboxing would hand the model bars to
 *      hallucinate into. It loses ~15% of the width and that is recorded, not hidden.
 *   3. The result's dimensions are ASSERTED, not assumed — `sharp(raw).rotate().metadata()` reports
 *      the INPUT's dimensions, so the only honest check is on the output bytes.
 */
async function prepareFrame(assetId: string): Promise<PreparedFrame> {
  const hit = frameCache.get(assetId);
  if (hit) return hit;

  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const { signedUrl } = await import("../lib/mediaStore");

  // TENANCY: the athlete id is IN the predicate, not checked after the fact.
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
    storedOrientation: meta.orientation ?? null,
    storedSize: `${meta.width}x${meta.height}`,
  };
  frameCache.set(assetId, prepared);
  return prepared;
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
 *
 * ⚠️ THE SHAPE IS NOT ASSUMED. `GET /api/v1/credits` is printed RAW, and the numeric gate applies
 * only when both fields are present and numeric. An unrecognized shape STOPS the run rather than
 * being narrated into a pass — `--skip-balance` is the manual override for when the printed readout
 * has been eyeballed.
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

  let parsed: any;
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
  | "accepted"
  | "refused_at_submit"
  | "failed_after_submit"
  | "error";

/**
 * ─── WHAT A HONOURED `generate_audio: false` WOULD COST, AND WHY IT IS RECORDED HERE ───────────
 *
 * These cells send `generate_audio: false` on a 6s clip. OpenRouter's completed video job returns
 * `usage.cost`, which the adapter surfaces as `basis: "reported"` — a REAL invoice, the first one
 * anybody has seen for Kling on this account. That makes this probe the evidence for a question it
 * was not designed to answer and which nothing else is going to answer for free:
 *
 *   reported ≈ $0.504 (6s × $0.084)  → the flag WAS honoured. A quote at the $0.084 arm is real.
 *   reported ≈ $0.756 (6s × $0.126)  → the flag was IGNORED. Quoting $0.084 would UNDER-quote by
 *                                      50%, which is the one direction the pre-generation check
 *                                      exists to prevent.
 *
 * So the figure is captured, printed per cell, and totalled — not because acceptance needs it, but
 * because the alternative is spending $3 and throwing the answer away.
 */
const SECONDS_RATE_AUDIO_OFF = 0.084;
const SECONDS_RATE_AUDIO_ON = 0.126;

interface CellResult {
  cellId: string;
  attempt: number;
  assetId: string;
  prediction: string;
  outcome: Outcome;
  /** HTTP status when the provider gave one. A moderation refusal is a 4xx at submit. */
  status?: number;
  /** The provider's own words, truncated. THE classification evidence — read it, do not trust the label. */
  detail?: string;
  submittedAt: string;
  elapsedMs: number;
  /** What the provider actually billed, when it said. See SECONDS_RATE_AUDIO_* above. */
  costUsd?: number;
  /** "reported" = a real invoice figure. "estimated" = the provider said nothing; prove nothing from it. */
  costBasis?: "estimated" | "reported";
  clipPath?: string;
}

/**
 * ⚠️ THE OUTCOME LABEL IS A CONVENIENCE, NOT A VERDICT. Kling's error-code table is client-rendered
 * and has not been read, so nothing here claims to recognize a moderation refusal specifically. What
 * it does claim: a 4xx AT SUBMIT is a refusal of the INPUT and bills nothing, which is the bounded
 * downside this probe was approved on. The raw `detail` is recorded on every non-accept so the
 * classification can be checked rather than believed.
 */
async function runCell(cell: Cell, attempt: number): Promise<CellResult> {
  const frame = await prepareFrame(cell.assetId);
  const inputs: GenerationInputs = {
    prompt: PROMPT,
    references: [frame.ref],
    width: W,
    height: H,
    aspectRatio: ASPECT,
    durationSeconds: SECONDS,
  };
  const opts: ProviderOpts = {
    provider: "openrouter",
    model: MODEL,
    providerParams: PROVIDER_PARAMS,
    refIds: [cell.assetId],
  };

  const plan = estimate("video.generate", inputs, opts);
  assertBudget(cell.id, plan.cost.amountUsd, !!plan.cost.unpriced);

  const submittedAt = new Date().toISOString();
  const started = Date.now();

  // COUNT THE MONEY FIRST. Past this line a charge may have happened, and everything after it is
  // written to be safe with that being true.
  spent += plan.cost.amountUsd;

  try {
    const out = await generate("video.generate", inputs, opts);
    const result: CellResult = {
      cellId: cell.id,
      attempt,
      assetId: cell.assetId,
      prediction: cell.prediction,
      outcome: "accepted",
      submittedAt,
      elapsedMs: Date.now() - started,
      costUsd: out.cost.amountUsd,
      costBasis: out.cost.basis,
    };

    // Download the clip so an accepted cell leaves evidence rather than a claim. NOT scored.
    //
    // ─── "unsigned_urls" IS A LIE, AND IT COST SEVEN CLIPS ────────────────────────────────────
    // OpenRouter returns finished videos in a field called `unsigned_urls`, which reads as "no
    // credential needed". It is not: those urls are `/api/v1/videos/{id}/content`, ordinary
    // authenticated API endpoints. A bare fetch gets 401 and the V2 run lost all seven of its
    // billed Seedance clips that way. The header goes ONLY to the provider's own host, so a signed
    // GCS url can never carry an OpenRouter bearer token to Google.
    const asset = out.assets[0];
    if (asset?.url) {
      const key = process.env.OPENROUTER_API_KEY?.trim();
      const toOpenRouter = /^https:\/\/openrouter\.ai\//i.test(asset.url);
      const dl = await fetch(asset.url, {
        headers: toOpenRouter && key ? { Authorization: `Bearer ${key}` } : {},
      });
      if (dl.ok) {
        const clip = join(OUT_DIR, `${cell.id}-${attempt}.mp4`);
        await writeFile(clip, Buffer.from(await dl.arrayBuffer()));
        result.clipPath = clip;
      } else {
        // NOT fatal and NOT a refusal. The cell was accepted and billed; only the file was lost.
        result.detail = `accepted and billed, but the download returned ${dl.status}. Url is in studio-cost-log.jsonl as outputRef — fetch it by hand rather than re-running, which buys a second copy.`;
      }
    } else if (asset?.bytes) {
      const clip = join(OUT_DIR, `${cell.id}-${attempt}.mp4`);
      await writeFile(clip, asset.bytes);
      result.clipPath = clip;
    }
    return result;
  } catch (err: any) {
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
      cellId: cell.id,
      attempt,
      assetId: cell.assetId,
      prediction: cell.prediction,
      outcome,
      status,
      detail: message.slice(0, 600),
      submittedAt,
      elapsedMs: Date.now() - started,
    };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const cells = (
    ONLY_CELL ? CELLS.filter((c) => c.id === ONLY_CELL) : CELLS
  ).flatMap((c) =>
    Array.from({ length: REPEAT }, (_, i) => ({ cell: c, attempt: i + 1 })),
  );
  if (!cells.length)
    throw new Error(
      `--cell ${ONLY_CELL} matched nothing. Known: ${CELLS.map((c) => c.id).join(", ")}`,
    );

  console.log(
    "\n─── Kling moderation confirmation ──────────────────────────────────────────",
  );
  console.log(`   model      ${MODEL}`);
  console.log(
    `   shape      ${W}x${H} ${ASPECT} · ${SECONDS}s · generate_audio=false on the wire`,
  );
  console.log(
    `   question   does this route accept real-athlete i2v input RELIABLY?`,
  );
  console.log(
    `   NOT        identity, quality or cost. Nothing here may be scored.`,
  );
  console.log(
    `   predictions docs/probes/kling-moderation.md §4, written before the run\n`,
  );

  // Quote every cell before anything is called, so the total is known up front.
  let quotedTotal = 0;
  const quotes: Array<{
    id: string;
    attempt: number;
    usd: number;
    detail?: string;
    unpriced?: boolean;
  }> = [];
  for (const { cell, attempt } of cells) {
    const frame = await prepareFrame(cell.assetId);
    const plan = estimate(
      "video.generate",
      {
        prompt: PROMPT,
        references: [frame.ref],
        width: W,
        height: H,
        aspectRatio: ASPECT,
        durationSeconds: SECONDS,
      },
      { provider: "openrouter", model: MODEL, providerParams: PROVIDER_PARAMS },
    );
    quotedTotal += plan.cost.amountUsd;
    quotes.push({
      id: cell.id,
      attempt,
      usd: plan.cost.amountUsd,
      detail: plan.cost.detail,
      unpriced: plan.cost.unpriced,
    });
    console.log(`   ${cell.id}${REPEAT > 1 ? ` #${attempt}` : ""}`);
    console.log(`     asset      ${cell.assetId}`);
    console.log(`     frame      ${cell.label}`);
    console.log(
      `     stored     ${frame.storedSize}, orientation=${frame.storedOrientation ?? "none"} → sent ${W}x${H} upright`,
    );
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
    `      a refusal bills $0, so this is the CEILING, not the expectation.`,
  );
  console.log(
    `      the quote is the with-audio arm on purpose — see the STUDIO_PRICE_JSON note.\n`,
  );

  if (!RUN) {
    console.log(`   DRY RUN — nothing was called and nothing was billed.`);
    console.log(
      `   to run:  --run --cap ${(Math.ceil(quotedTotal * 100) / 100 + 0.08).toFixed(2)}\n`,
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

  await assertFunded(quotedTotal);
  await mkdir(OUT_DIR, { recursive: true });

  const results: CellResult[] = [];
  for (const { cell, attempt } of cells) {
    process.stdout.write(`   ${cell.id}${REPEAT > 1 ? ` #${attempt}` : ""} … `);
    const r = await runCell(cell, attempt);
    results.push(r);
    const mark =
      r.outcome === "accepted"
        ? "✅ accepted"
        : r.outcome === "refused_at_submit"
          ? "🛑 REFUSED at submit"
          : `⚠️  ${r.outcome}`;
    const billed =
      r.costBasis === "reported"
        ? `, billed $${r.costUsd!.toFixed(4)}`
        : r.outcome === "accepted"
          ? ", billed UNREPORTED"
          : "";
    console.log(
      `${mark}  (${(r.elapsedMs / 1000).toFixed(1)}s${billed}, quoted so far $${spent.toFixed(4)})`,
    );
    if (r.detail) console.log(`      ${r.detail.split("\n")[0]}`);
  }

  await writeFile(
    join(OUT_DIR, "results.json"),
    JSON.stringify({ model: MODEL, seconds: SECONDS, results }, null, 2),
  );

  const accepted = results.filter((r) => r.outcome === "accepted").length;
  const refused = results.filter(
    (r) => r.outcome === "refused_at_submit",
  ).length;
  const other = results.length - accepted - refused;

  console.log(
    "\n─── Verdict ────────────────────────────────────────────────────────────────",
  );
  console.log(
    `   accepted ${accepted}/${results.length} · refused at submit ${refused} · other ${other}`,
  );
  console.log(`   quoted ceiling $${spent.toFixed(4)}`);

  // ── The free second reading: was `generate_audio: false` honoured? ───────────────────────────
  // Stated as a comparison against two published rates, never as a bare verdict — an invoice
  // landing between the two arms means the rate card is not what we think it is, and that is a
  // finding, not a rounding error.
  const invoiced = results.filter(
    (r) => r.costBasis === "reported" && typeof r.costUsd === "number",
  );
  if (invoiced.length) {
    const total = invoiced.reduce((n, r) => n + r.costUsd!, 0);
    const perClip = total / invoiced.length;
    const offArm = SECONDS_RATE_AUDIO_OFF * SECONDS;
    const onArm = SECONDS_RATE_AUDIO_ON * SECONDS;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
    const read = near(perClip, offArm)
      ? `✅ HONOURED — a quote at $${SECONDS_RATE_AUDIO_OFF}/s is real.`
      : near(perClip, onArm)
        ? `🛑 IGNORED — quoting $${SECONDS_RATE_AUDIO_OFF}/s would UNDER-quote by 50%.`
        : "⚠️  NEITHER published arm. The rate card is not what we think it is — do not price off this.";
    console.log(
      `\n   invoiced $${total.toFixed(4)} across ${invoiced.length} clip(s) = $${perClip.toFixed(4)}/clip`,
    );
    console.log(
      `   vs audio-off $${offArm.toFixed(4)} · audio-on $${onArm.toFixed(4)}  →  generate_audio:false ${read}`,
    );
  } else if (accepted > 0) {
    console.log(
      "\n   ⚠️  no cell carried a provider-reported cost, so the generate_audio question is UNANSWERED.",
    );
  }

  if (accepted === results.length) {
    console.log(
      "   → every cell accepted. Kling's moderation is reliable enough to wire.",
    );
  } else {
    console.log(
      "   → NOT clean. The gate agreed before the run says wiring Kling as load-bearing",
    );
    console.log(
      "     is off the table until an alternate route is recon'd. Write it down; wire nothing.",
    );
  }
  console.log(`   results  ${join(OUT_DIR, "results.json")}`);
  console.log(
    "   ⚠️  acceptance only. No clip here may be read for identity or quality.\n",
  );
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
