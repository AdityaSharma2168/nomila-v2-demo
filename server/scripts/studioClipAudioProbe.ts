/**
 * studioClipAudioProbe — ONE Veo clip with audio on, so a person can LISTEN to it.
 *
 * It settles two things the audio decision memo (docs/probes/video-prompt-quality-ledger.md) lists
 * as unverified, and nothing else:
 *
 *   1. What Veo generates for sound when the prompt says NOTHING about sound — ambient, or speech
 *      coming out of her. The direction below is the first-frame probe's sentence, unchanged, and
 *      carries no sound word on purpose. Only a listen answers this; the script does not judge it.
 *   2. Whether the audio stream's length matches the video stream's. If they drift, every stitched
 *      clip desyncs. ffprobe answers this, per stream, and the record carries both numbers.
 *
 * ─── WHY THIS DOES NOT GO THROUGH THE JOB QUEUE ────────────────────────────────────────────────
 *
 * The product path cannot carry audio yet: the runner replays the brief with empty options
 * (studio/videoRunner.ts `inputsFor`), so `generateAudio` is quoted and then lost. That is the card
 * this probe gates. So this calls `runGeneration` inline, the one path that honours the option —
 * which means NO job row, NO approval, and ⚠️ NO SPEND CAP but this script's own. `--run` is the
 * only thing that spends, it requires `--cap`, and the quote is counted BEFORE the provider call.
 *
 * The first frame is cut to the clip's shape with the same `frameForClip` the runner uses: Veo
 * letterboxes a non-9:16 frame for the whole clip (docs/probes/video-first-frame-crop-probe.md).
 *
 * Reads one media_assets row, scoped to --athlete. Writes nothing to the database.
 *
 *   dry:   npx tsx --require dotenv/config server/scripts/studioClipAudioProbe.ts --frame <assetId>
 *   live:  … --frame <assetId> --run --cap 3.30
 */
import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { assembleBrief } from "../studio/brief";
import { resolveStoredReference } from "../studio/generate";
import {
  previewGeneration,
  runGeneration,
  type PreviewOptions,
} from "../studio/preview";
import { frameForClip } from "../studio/video/firstFrame";

const run = promisify(execFile);

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RUN = argv.includes("--run");
const CAP_USD = Number(arg("cap", "0"));
const OUT_DIR = arg("out", "probe-out/clip-audio")!;
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
const FRAME = arg("frame");
/**
 * `--broll`: no person reference, so the brief routes to seedance over OpenRouter. That adapter
 * forces `generate_audio: false` BELOW the params spread, on purpose (it is what stops a Kling
 * under-quote) and the product keeps it. So the ONLY way to hear seedance is to rewrite that one
 * field on the wire, here, in the probe: everything else — auth, poll, download — is the real
 * adapter. Seedance bills audio at the same token rate, so the quote is the quote.
 */
const BROLL = argv.includes("--broll");
/**
 * ⚠️ 6, AND IT IS LEGAL ON BOTH ROUTES ON PURPOSE. Seedance serves 4–15s and Veo serves 4/6/8 only
 * (config.supportedDurationsFor), so 5s quoted fine against seedance and then died at the provider
 * with "supported durations are [8,4,6]" — the quote and the run had picked different models. The
 * routing is fixed below; this stays inside BOTH sets so that class of mismatch can never again be
 * what a failed run is telling us. 6s is long enough to hear a room and $0.18 cheaper than 8s.
 */
const SECONDS = BROLL ? 6 : 8;
const ASPECT = "9:16";
/** More than a frame at 24fps is a drift worth reading; less is container rounding. */
const DRIFT_TOLERANCE_SEC = 0.05;

/**
 * ⚠️ THE TWO ARMS NEED DIFFERENT SENTENCES, AND USING ONE FOR BOTH COST A SUBMITTED JOB.
 *
 * The identity sentence names no sound on purpose: that is what proved the flag alone buys silence
 * (-91 dB). Handing it to `--broll` was a straight mistake. The b-roll template renders "a deserted
 * scene … unpopulated, with the setting alone in view", so "She holds her pose and looks into the
 * camera" contradicts the template it is pasted into AND asks a text-to-video model to synthesise a
 * person. That job was accepted and then refused at OUTPUT moderation ("the output video may
 * contain sensitive information", gen-vid-…mMJsPz9rw3J5unYqK0wK).
 *
 * ⚠️ NOT the refusal docs/probes/kling-moderation.md measured. That one is seedance refusing a real
 * person on the INPUT image, 6 of 6, with a named policy code
 * (`InputImageSensitiveContentDetected.PrivacyInformation`). This cell sends no image at all.
 *
 * So b-roll gets a sentence that is what b-roll IS — a place, no one in it — and that NAMES ITS
 * SOUND, because the identity probe already established that a clip which does not ask for sound
 * does not get any. `withSound` is identity-only in the product and stays that way; here the sound
 * is asked for in the direction itself, which changes no product behaviour.
 */
const DIRECTION =
  arg("direction") ??
  (BROLL
    ? "An empty outdoor basketball court just after dawn, chain nets shifting in the wind, long " +
      "shadows across wet asphalt. The sound of the place: wind across the court, a chain net " +
      "ticking, faint traffic a street away."
    : "She holds her pose and looks into the camera, breathing, with a small natural shift of weight.");

/**
 * What Vertex was actually SENT — `parameters` only, never `instances` (her frame and her words).
 * A silent track is otherwise ambiguous between "the flag never left" and "Veo chose silence".
 */
let sentParameters: unknown = null;

/**
 * Thrown by the tap in dry mode, once the body has been captured and BEFORE it is sent.
 *
 * ⚠️ RECOGNISED BY THE FLAG, NOT BY `instanceof`. The adapter catches whatever the transport throws
 * and re-throws its own `GenerationError` ("OpenRouter /videos failed: …"), so the class is gone by
 * the time the caller sees it — the first version of this checked `instanceof`, missed, and exited 1
 * with the wire it had just captured unprinted. The flag is set on the way out of the tap, which is
 * the one place that cannot be wrapped.
 */
class DryWireStop extends Error {}
let dryStopped = false;

/**
 * ⚠️ THE OVERRIDE LIVES HERE, AND ONLY HERE. `openrouter.ts` is NOT edited by this probe: that
 * adapter's `generate_audio: false` sits below its params spread because Kling bills $0.126/s with
 * audio against the flat $0.084/s we quote, and a caller able to flip it rebuilds a ~50%
 * under-quote. Teaching the adapter to honour an explicit true would put that switch on a shipped
 * code path — so the rewrite happens on the wire, in a script nothing imports, and the product's
 * wire is byte-identical with or without this file.
 *
 * TWO GATES, both required: `--broll` (this probe, this run) and a seedance model READ OFF THE BODY
 * — not off our own route table, because the body is what is actually about to be sent. A Kling
 * bridge reaching this tap is passed through untouched and keeps the forced false.
 */
function installWireTap() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(":predictLongRunning") && typeof init?.body === "string")
      sentParameters = JSON.parse(init.body)?.parameters ?? null;
    if (BROLL && init?.method === "POST" && /\/videos$/.test(url) && typeof init.body === "string") {
      const parsed = JSON.parse(init.body);
      // The gate. Anything that is not seedance leaves exactly as the adapter built it.
      if (typeof parsed?.model === "string" && parsed.model.includes("seedance")) {
        const { prompt: _prompt, ...body } = { ...parsed, generate_audio: true };
        sentParameters = body;
        if (RUN)
          return real(input, { ...init, body: JSON.stringify({ ...body, prompt: _prompt }) });
      }
    }
    // ⚠️ DRY MODE IS FAIL-CLOSED, AND THE ORDER ABOVE IS THE WHOLE POINT. A dry run that only
    // stopped the request it RECOGNISED would send any it did not — and an unrecognised POST to a
    // video endpoint is precisely the case worth being wrong about, because it bills. So in dry mode
    // nothing leaves, matched or not; whether the tap recognised anything is then read off
    // `sentParameters` by the caller.
    if (!RUN) {
      dryStopped = true;
      throw new DryWireStop("dry wire capture");
    }
    return real(input, init);
  }) as typeof fetch;
}

const AUDIO_ON = { generateAudio: true } as const;

async function briefFor(assetId: string | undefined) {
  if (BROLL)
    return assembleBrief({
      athleteId: ATHLETE_ID,
      brandId: null,
      origin: "system",
      objective: "grow-following",
      deliverable: "clip",
      mode: "generate",
      direction: DIRECTION,
      references: [],
      durationSeconds: SECONDS,
    });
  if (!assetId) throw new Error("--frame <assetId> is required (an IMAGE of this athlete's), or --broll.");
  const [row] = await db
    .select({
      id: mediaAssets.id,
      gcs_path: mediaAssets.gcs_path,
      media_type: mediaAssets.media_type,
    })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.athlete_id, ATHLETE_ID), eq(mediaAssets.id, assetId)),
    );
  if (!row?.gcs_path || row.media_type !== "IMAGE")
    throw new Error(`asset ${assetId} is not an image of this athlete's`);
  return assembleBrief({
    athleteId: ATHLETE_ID,
    brandId: null,
    origin: "system",
    objective: "grow-following",
    deliverable: "clip",
    mode: "generate",
    direction: DIRECTION,
    references: [{ role: "person", ref: row.gcs_path, mediaAssetId: row.id }],
    durationSeconds: SECONDS,
  });
}

interface StreamRead {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  start_time?: string;
}

async function streamsOf(path: string): Promise<StreamRead[]> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,duration,start_time",
    "-of", "json",
    path,
  ]);
  return (JSON.parse(stdout) as { streams?: StreamRead[] }).streams ?? [];
}

async function main() {
  const brief = await briefFor(FRAME);
  const preview = previewGeneration(brief, AUDIO_ON);
  if (preview.status === "blocked" || !preview.plan || !preview.cost)
    throw new Error(`blocked — ${preview.blockers.map((b) => b.note).join(" | ")}`);

  const quote = preview.cost.amountUsd;
  const plan = preview.plan;
  console.log(
    `  ${plan.provider}/${plan.model}  ${plan.inputs.durationSeconds}s  quote $${quote.toFixed(4)}  — ${preview.cost.detail}`,
  );
  if (BROLL ? plan.provider !== "openrouter" : plan.provider !== "vertex")
    throw new Error(
      BROLL
        ? `--broll expected openrouter, got ${plan.provider}. Stopping.`
        : `the identity route is ${plan.provider}, not vertex — that adapter forces audio off, so this would buy a silent clip at the audio quote. Stopping.`,
    );

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "prompt.txt"), plan.inputs.prompt);

  /**
   * ⚠️ THE RUN IS PINNED TO THE MODEL THE QUOTE RESOLVED — a defect this probe found, since FIXED.
   *
   * `previewGeneration` spreads the shot-type route into `estimate`, but `runGeneration` used to
   * hand `generate` only `{ ...opts, providerParams }` — no route — so the run re-resolved through
   * the DEFAULT video provider. B-roll therefore quoted seedance and generated on Veo, which is what
   * "supported durations are [8,4,6]" was: Veo's list, not seedance's. `runGeneration` now spreads
   * the same route (preview.ts, "THE ROUTE THE QUOTE PRICED"; pinned in preview.test.ts). The pin
   * below is kept: it names the same route the fix does, so it is redundant rather than wrong, and a
   * re-run of this probe should not change shape.
   */
  const runOpts: PreviewOptions = {
    ...AUDIO_ON,
    provider: plan.provider,
    model: plan.model,
    resolveReference: async (r) => {
      const resolved = await resolveStoredReference(r, brief);
      return (await frameForClip([resolved], ASPECT)).references[0];
    },
  };

  if (!RUN) {
    // ─── THE WIRE, READ WITHOUT SENDING IT ──────────────────────────────────────────────────────
    //
    // A quote is a claim about a route; it is not evidence of what the body says. So the dry run
    // builds the REAL request through the REAL adapter and stops it inside the tap, one step before
    // it leaves. Nothing is sent, nothing is billed, and what prints is the body itself.
    if (BROLL) {
      installWireTap();
      try {
        await runGeneration(brief, runOpts);
      } catch (err) {
        if (!dryStopped) throw err;
      }
      const wire = sentParameters as Record<string, unknown> | null;
      // Nothing was sent either way. An empty capture means the request was not the one this probe
      // believes it is making, and no number printed below could be trusted.
      if (!wire)
        throw new Error(
          "the tap recognised no seedance video request — nothing was sent, and this probe cannot show you the wire. Stopping.",
        );
      console.log(`  WIRE  model           ${String(wire?.model)}`);
      console.log(`  WIRE  generate_audio  ${JSON.stringify(wire?.generate_audio)}`);
      console.log(`  WIRE  duration        ${JSON.stringify(wire?.duration ?? wire?.duration_seconds)}`);
      console.log(`  WIRE  full body (prompt withheld)  ${JSON.stringify(wire)}`);
    }
    console.log("DRY RUN — nothing was written to the database and nothing was spent.");
    console.log(`  to run:  --run --cap ${(Math.ceil(quote * 100) / 100 + 0.1).toFixed(2)}`);
    return;
  }
  if (!(CAP_USD > 0)) throw new Error("--run requires --cap <usd>. Refusing to spend without a ceiling.");
  if (quote > CAP_USD)
    throw new Error(`$${quote.toFixed(4)} would pass --cap $${CAP_USD.toFixed(2)}. Stopping.`);

  // ⚠️ COUNTED BEFORE ANYTHING THAT CAN THROW. One call, no retry: a failure after this line is a
  // recorded loss of up to the quote, never a second attempt.
  console.log(`  spending up to $${quote.toFixed(4)} — one call, no retry.`);
  installWireTap();
  const result = await runGeneration(brief, runOpts);

  const asset = result.assets[0];
  const bytes =
    asset?.bytes ??
    (asset?.url ? Buffer.from(await (await fetch(asset.url)).arrayBuffer()) : null);
  if (!bytes) throw new Error(`the call returned no clip. Spent (quoted) $${quote.toFixed(4)}.`);
  const clipPath = join(OUT_DIR, "clip.mp4");
  await writeFile(clipPath, bytes);

  const { stderr: vol } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", clipPath, "-af", "volumedetect", "-vn", "-f", "null", "-"]).catch(() => ({ stderr: "" }));
  const meanDb = Number(/mean_volume: (-?[\d.]+) dB/.exec(vol)?.[1] ?? NaN);
  const streams = await streamsOf(clipPath);
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const v = Number(video?.duration);
  const a = Number(audio?.duration);
  const drift = Number.isFinite(v) && Number.isFinite(a) ? a - v : null;
  const verdict = !audio
    ? "NO AUDIO STREAM — the flag bought nothing audible; check the invoice arm"
    : drift === null
      ? "a stream reports no duration — read `streams` by hand"
      : Math.abs(drift) <= DRIFT_TOLERANCE_SEC
        ? "lengths match"
        : `DRIFT ${drift > 0 ? "+" : ""}${drift.toFixed(3)}s (audio − video)`;

  await writeFile(
    join(OUT_DIR, "record.json"),
    JSON.stringify(
      {
        model: plan.model,
        provider: plan.provider,
        secondsAsked: plan.inputs.durationSeconds,
        quoteUsd: quote,
        cost: result.cost,
        direction: DIRECTION,
        sentParameters,
        meanVolumeDb: Number.isFinite(meanDb) ? meanDb : null,
        streams,
        audioMinusVideoSec: drift,
        verdict,
      },
      null,
      2,
    ),
  );
  console.log(`  sent parameters ${JSON.stringify(sentParameters)}`);
  console.log(`  video ${video?.codec_name} ${video?.duration}s (start ${video?.start_time})`);
  console.log(`  audio ${audio?.codec_name ?? "—"} ${audio?.duration ?? "—"}s (start ${audio?.start_time ?? "—"})`);
  console.log(`  mean volume ${Number.isFinite(meanDb) ? meanDb + " dB" : "— (no audio stream)"}   (-90 is silence; the audible Veo clip was -13)`);
  console.log(`  ${verdict}`);
  console.log(`  listen:  open ${clipPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
