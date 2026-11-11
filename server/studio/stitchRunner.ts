/**
 * studio/stitchRunner — the consumer for detached stitch jobs.
 *
 * `POST /studio/stitch` queues a timeline and returns; this works it. One tick is:
 *
 *   reap expired leases · claim ≤ capacity · START each (detached) · return
 *
 * ─── IT RETURNS BEFORE ffmpeg DOES, AND THAT IS SAFE HERE FOR A REASON ──────────────────────────
 *
 * `run.googleapis.com/cpu-throttling: "false"` in gcp/cloud-run-dev.yaml and -prod.yaml: CPU is
 * ALWAYS allocated, so work begun after a response keeps running at full speed. That is what makes
 * a claim-and-return tick a design rather than a way to abandon an encode, and it is the same
 * property V3's inline video kick already depends on. (The older note on the media-poster cron —
 * "fire-and-forget wouldn't finish on Cloud Run" — predates that annotation.)
 *
 * Returning fast matters for two concrete reasons: the Cloud Scheduler attempt deadline stops being
 * load-bearing, and `withAdvisoryLock` — which pins a pooled PG client for the whole of its
 * callback — gives the connection back in milliseconds instead of holding it for a ten-minute
 * encode.
 *
 * ─── ⚠️  THE MEMORY BOUND IS PER INSTANCE, AND NOTHING IN THE DATABASE KNOWS THAT ────────────────
 *
 * studio/video/materialize.ts budgets ONE timeline against ONE instance's 2 GiB, because on Cloud
 * Run /tmp is RAM. Nothing in the queue enforces that only one of them runs here at a time, and
 * three mechanisms that look like they would all do not:
 *
 *   SKIP LOCKED   stops two callers taking the SAME row. Its whole purpose is to hand the second
 *                 caller a DIFFERENT one — which is exactly the case that doubles the memory.
 *   the lease     is per job. Two jobs, two leases, both valid.
 *   the advisory  is released the moment this tick returns, which is milliseconds. The scheduler
 *   lock          tick and the route's inline kick overlap trivially, and the kick never takes it.
 *
 * So the bound is held HERE, in the process that owns the memory: `inFlight` is claimed against
 * BEFORE the rows are, so a tick arriving while this instance is busy claims NOTHING and leaves the
 * work visible to another instance — which has its own 2 GiB and is the point of maxScale.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * A system consumer over every athlete's queue, so the claim is not athlete-scoped — see the note
 * in studio/stitchJobs.ts. The athlete for each job is read OFF THE CLAIMED ROW and is the only
 * value the asset ids in its spec are ever resolved against. No request, client or model supplies
 * one, and nothing here accepts one.
 *
 * ─── NO SPEND SURFACE ───────────────────────────────────────────────────────────────────────────
 *
 * Nothing in this file's import graph reaches a provider adapter, the preview store or the spend
 * gate, and the stitch engine is $0 by construction. Asserted by walking the graph in the suite.
 */
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import { join } from "path";
import { hostname } from "os";
import {
  claimStitchJobs,
  failStitch,
  leaseMs,
  maxAttempts,
  reapExpiredStitchLeases,
  stitchTimeoutMs,
  succeedStitch,
  transferTimeoutMs,
} from "./stitchJobs";
import {
  assertProbedTimelineFits,
  describeLimits,
  MaterializeError,
  materializeWorkspace,
  publishStitchOutput,
  stillWorkBytes,
  type StitchWorkspace,
} from "./video/materialize";
import {
  isRefusal,
  readStoredSpec,
  STITCH_TARGETS,
  toStitchRequest,
  type StitchSpec,
} from "./video/spec";
import { renderCaptionBand } from "./video/captionRender";
import type { ClipOverlay, StitchFinishing } from "./video/types";
import { bedFor } from "./video/beds";
import { stitch } from "./video/stitch";
import { encodeStill } from "./video/still";
import { probeHasAudio, probeMedia } from "./video/probe";
import {
  checkStructure,
  writeStructure,
  type StructureRecord,
} from "./video/structure";
import { clipQcEnabled, finishingEnabled, studioEnabled } from "./config";
import {
  TRUE_PEAK_DBTP,
  bedGainDb,
  gridForBed,
  measureLoudness,
  programmeSec,
  snapCutsToBeat,
  type SnapClip,
} from "./video/finishing";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { isRenderJobSpec, RENDER_JOB_KIND } from "../agent/postKit/render/compile";
import { failExhaustedRenders, workPostKitRender } from "../agent/postKit/render/worker";
import type { StudioStitchJob } from "../../shared/schema";

const logger = createLogger("studio/stitchRunner");

/**
 * Who this process is, for the lease. Stable for the life of the instance and unique across them —
 * the hostname alone is not, since Cloud Run reuses it. Only ever compared for equality.
 */
export const RUNNER_ID = `${hostname()}-${randomUUID().slice(0, 8)}`;

/**
 * How many stitches ONE INSTANCE may have in flight. Not a throughput knob — a memory one: each is
 * a workspace of up to 664 MB of source plus its output, in a tmpfs that is this instance's RAM.
 * Raising it multiplies studio/video/materialize.ts's budget by the same factor.
 */
export const maxConcurrent = () =>
  Number(process.env.STUDIO_STITCH_CONCURRENCY ?? 1);

/** Job ids being worked IN THIS PROCESS. The whole of the per-instance memory bound. */
const inFlight = new Set<string>();

/** For the suite, and for a future /health line. Never used to make a decision except below. */
export const inFlightCount = () => inFlight.size;

/**
 * A readable refusal for the athlete, or null when the error is ours to own.
 *
 * MaterializeError messages are written for her and name the caps ("A timeline can hold up to 12
 * clips, 664 MB of video and 3:00 of footage"). Everything else — an ffmpeg stderr tail, a GCS
 * 500 — is logged and replaced, because a decode error is not something she can act on and a
 * provider's message is not ours to hand out.
 */
function refusalFor(err: unknown): string {
  if (err instanceof MaterializeError) return err.message;
  return "We couldn't put that timeline together. Try it again, or with fewer clips.";
}

/** What one pass over a job concluded. */
export type StitchOutcome = "succeeded" | "failed";

/**
 * Work one claimed job, start to finish.
 *
 * THE `finally` IS THE LOAD-BEARING LINE. A workspace that outlives its job is RAM that never comes
 * back on this instance, so it is disposed on every path out — success, refusal, throw and the
 * abort below — and `dispose()` is idempotent precisely so this can be unconditional.
 */
/**
 * No drawn caption may be larger than this. Measured: 5–15 KB at 1080 wide. The ceiling exists for
 * the reason the bed has one — /tmp is RAM here and an uncounted file is charged at zero — and at
 * twelve positions it bounds captions to 6 MB of a workspace that budgets hundreds.
 */
const CAPTION_MAX_BYTES = 512 * 1024;

/**
 * Draw every captioned position's band into the workspace.
 *
 * FROM THE FROZEN SPEC AND NOTHING ELSE: the words, the position and the style are the ones on the
 * job row, and the frame is the row's own target. Nothing here reads a request, a client or the
 * clock, which is what makes the video that comes out the one that was queued.
 *
 * Local CPU only — satori and sharp, no network and no provider. A stitch is still $0.
 */
async function drawCaptions(
  spec: StitchSpec,
  dir: string,
): Promise<Map<number, ClipOverlay>> {
  const frame = STITCH_TARGETS[spec.target];
  const overlays = new Map<number, ClipOverlay>();
  for (const [i, clip] of spec.clips.entries()) {
    if (!clip.caption) continue;
    const band = await renderCaptionBand(clip.caption, frame);
    if (band.png.length > CAPTION_MAX_BYTES) {
      throw new Error(`The caption on clip ${i + 1} is too large to draw`);
    }
    const source = join(dir, `caption-${i}.png`);
    await writeFile(source, band.png);
    overlays.set(i, { source, y: band.y });
  }
  return overlays;
}

/**
 * Turn every still position into a clip in the workspace, keyed by POSITION — the same photo held
 * twice for two lengths is two clips (studio/video/still.ts).
 *
 * FROM THE FROZEN SPEC: the hold and the shape are the job row's, and the photo is the one the
 * workspace resolved under the row's athlete. Nothing here reads a request.
 *
 * ⚠️  IT SPENDS THE ENGINE'S BUDGET, NOT A NEW ONE. The lease is exactly the ffmpeg budget plus two
 * transfer budgets (stitchJobs.ts leaseMs), with nothing spare; an encode timed on its own clock
 * would let the work outlast the claim and hand the reaper a job that is still running. So each
 * still gets what is left before `deadline`, and the engine then gets what the stills left.
 */
async function encodeStills(
  spec: StitchSpec,
  workspace: StitchWorkspace,
  deadline: number,
): Promise<Map<number, string>> {
  const target = STITCH_TARGETS[spec.target];
  const clips = new Map<number, string>();
  for (const [i, clip] of spec.clips.entries()) {
    if (clip.stillSec === undefined) continue;
    const photo = workspace.stills.get(clip.assetId);
    // Unreachable through materializeWorkspace, which fetches every still it resolved. A throw
    // rather than a skip, for toStitchRequest's reason: a stitch that drops a position is a
    // different video from the one she asked for.
    if (!photo) throw new Error(`No photo for the still at position ${i}`);
    const left = deadline - Date.now();
    if (left <= 0)
      throw new Error("The stills used up the whole encode budget");
    const encoded = await encodeStill(
      photo,
      workspace.dir,
      i,
      clip.stillSec,
      target,
      left,
      // A slow push-in (D2) or a move toward a point (A1) when the position asks; dead still otherwise.
      clip.stillMotion,
      clip.stillFocus,
      // One look over every photo in the set (A3); absent, each photo as it is.
      spec.look,
    );
    // What it wrote is a FACT; what the door reserved for it was a ceiling (stillWorkBytes). A still
    // that outgrew its reservation is refused here, before the engine adds its own output to a
    // tmpfs that is this instance's RAM.
    if (encoded.bytes > stillWorkBytes(clip.stillSec)) {
      throw new MaterializeError(
        `A timeline can hold up to ${describeLimits()}. One of its photos came to more than that.`,
        "workspace_too_large",
      );
    }
    clips.set(i, encoded.path);
  }
  return clips;
}

export async function workStitch(job: StudioStitchJob): Promise<StitchOutcome> {
  const athleteId = job.athlete_id; // OFF THE ROW. Never from anywhere else.
  let dispose: (() => Promise<void>) | null = null;

  // Bounds the DOWNLOAD phase with a real cancellation rather than a Promise.race, so a hung
  // transfer stops writing instead of filling a deleted directory. See materialize.ts.
  const transfers = new AbortController();
  const transferDeadline = setTimeout(
    () => transfers.abort(new Error("Downloading the clips took too long")),
    transferTimeoutMs(),
  );

  try {
    // A STORED SPEC IS NOT TRUSTED. Same parser the route used: a row that could not be queued
    // today cannot be run today either.
    const spec = readStoredSpec(job.spec);
    if (isRefusal(spec)) {
      throw new MaterializeError(spec.error, "not_found");
    }

    // NULL when the bed's bytes are not installed, and that is a DOWNGRADE rather than a refusal.
    // The route already refuses a bed she asks for while it is unavailable, so reaching here with
    // one means it went away between queueing and claiming. Making the clip without music beats
    // failing a job she has been waiting on over its soundtrack.
    const bed = bedFor(spec.bed);
    if (spec.bed && !bed) {
      logger.warn(
        { stitchId: job.id, bed: spec.bed },
        "bed unavailable at run time — stitching without it",
      );
    }

    // Tenancy, the caps and the download, all inside materialize. A foreign asset id fails closed
    // here — before any bytes move — because resolution is one query carrying `athleteId`. The bed
    // is NOT athlete-scoped and cannot be: it is the product's, not hers.
    const workspace = await materializeWorkspace(
      athleteId,
      spec.clips,
      transfers.signal,
      bed,
      // Resolved against `athleteId` — OFF THE ROW — like every clip id beside it.
      spec.bedAssetId,
    );
    dispose = workspace.dispose;
    clearTimeout(transferDeadline);

    // ⚠️  THE EXACT TIMELINE BOUND, and it belongs HERE rather than at the door.
    //
    // A clip's stored duration can be NULL — 0058's column is only as populated as the probes that
    // fill it, and an Instagram row that holds a poster JPEG has no bytes to measure and never
    // will. On a NULL the route's check falls back to bytes ÷ output-bitrate, which under-counts by
    // whatever the source bitrate happens to be. A 200 MB upload at 3 Mbps is 555 s of video
    // counted as 100, so it passes the 180 s cap ALONE and then writes ≈1.1 GiB into a workspace
    // that reserved 360 MiB. That is an OOM, and the way you find out is the instance vanishing.
    //
    // 0058 makes that fallback RARER. It does not make it impossible, so this check stays exactly
    // as load-bearing as it was.
    //
    // The files are on disk by now, so the question stops being a guess: ffprobe reads the real
    // duration out of each one. Costs a local probe per unique clip, spends nothing, and runs
    // BEFORE the encode — so a timeline that slipped past the estimate is refused rather than
    // discovered.
    const probed = new Map<string, number>();
    for (const [assetId, localPath] of workspace.paths) {
      probed.set(assetId, (await probeMedia(localPath)).durationSec);
    }
    assertProbedTimelineFits(spec.clips, probed);

    // HER pick has to actually HAVE sound, and only the file can say: a screen recording, a clip
    // exported muted, a Studio-made clip (audio is parked) all have none. Asked here, before the
    // encode, so it fails with a sentence she can act on instead of the engine's message — which
    // names a local path — or, worse, a video that comes back quietly without what she chose.
    if (spec.bedAssetId) {
      if (!workspace.bedPath || !(await probeHasAudio(workspace.bedPath))) {
        throw new MaterializeError(
          "That video has no sound to use. Pick another, or choose a track.",
          "no_sound",
          "sound",
        );
      }
    }

    // After the bounds, like the captions below: a timeline that is going to be refused is not
    // encoded for first. The stills and the engine share ONE ffmpeg budget — see encodeStills.
    const ffmpegDeadline = Date.now() + stitchTimeoutMs();
    const stills = await encodeStills(spec, workspace, ffmpegDeadline);

    // After the bounds, so a timeline that is going to be refused is not drawn for first.
    const overlays = await drawCaptions(spec, workspace.dir);

    const engineMs = ffmpegDeadline - Date.now();
    if (engineMs <= 0)
      throw new Error("The stills used up the whole encode budget");

    // ─── THE FINISHING PASS (quality-scrappy piece 6), opt-in STUDIO_FINISHING ─────────────────────────
    //
    // Off: nothing below runs, the spec and the request are what they were, and the argv is byte for byte. On: cuts
    // moved back onto the bed's beat, the bed measured and brought to the reference before its level, a true-peak
    // limit on the mix, and — on a portrait target — off-shape sources cropped to fill instead of padded
    // (studio/video/finishing.ts). Everything here is local and $0.
    let timeline = spec;
    let finishing: StitchFinishing | undefined;
    if (finishingEnabled()) {
      const positions: SnapClip[] = spec.clips.map((c) => ({
        trimStartSec: c.trimStartSec,
        trimEndSec: c.trimEndSec,
        sourceSec: c.stillSec ?? probed.get(c.assetId) ?? Infinity,
        still: c.stillSec !== undefined,
        crossfadeSec: c.crossfadeSec,
      }));
      const grid = gridForBed(spec.bed);
      if (grid) {
        const snap = snapCutsToBeat(positions, grid, spec.bedStartSec ?? 0);
        if (snap.moved) {
          timeline = {
            ...spec,
            clips: spec.clips.map((c, i) =>
              snap.trimEndSec[i] === undefined
                ? c
                : { ...c, trimEndSec: snap.trimEndSec[i] },
            ),
          };
          logger.info(
            {
              stitchId: job.id,
              moved: snap.moved,
              joins: spec.clips.length - 1,
            },
            "cuts moved onto the bed's beat",
          );
        }
      }
      // Measured over what will PLAY — from where the bed starts, for as long as the programme runs (finishing.ts).
      const gain = workspace.bedPath
        ? bedGainDb(
            await measureLoudness(workspace.bedPath, {
              startSec: spec.bedStartSec ?? 0,
              durationSec: programmeSec(positions),
            }, undefined, `stitch ${job.id}`),
          )
        : null;
      finishing = {
        truePeakDbtp: TRUE_PEAK_DBTP,
        ...(gain !== null ? { bedGainDb: gain } : {}),
        ...(spec.target === "portrait" ? { cropToFill: true } : {}),
      };
    }

    const manifest = await stitch({
      ...toStitchRequest(
        timeline,
        workspace.paths,
        workspace.outputPath,
        engineMs,
        // The LOCAL path from the workspace, never anything off the spec.
        workspace.bedPath,
        overlays,
        stills,
      ),
      ...(finishing ? { finishing } : {}),
    });

    // quality-scrappy piece 2, behind STUDIO_CLIP_QC: the output's structure, checked on the LOCAL file before it is
    // published (the workspace is disposed after). $0, never throws; written onto the asset once it has an id.
    const structure: StructureRecord | null = clipQcEnabled()
      ? await checkStructure(
          workspace.outputPath,
          {
            durationSec: manifest.expectedDurationSec,
            aspect: `${STITCH_TARGETS[spec.target].width}:${STITCH_TARGETS[spec.target].height}`,
            width: STITCH_TARGETS[spec.target].width,
            height: STITCH_TARGETS[spec.target].height,
            // A bed was laid under it; a stitch that comes back silent then lost its music.
            sound: manifest.audioBed !== null,
          },
          "stitch",
        )
      : null;

    const published = await withTimeout(
      publishStitchOutput({
        athleteId,
        stitchJobId: job.id,
        localPath: workspace.outputPath,
        width: manifest.output.width,
        height: manifest.output.height,
        // The EXACT figure. publishStitchOutput rounds it for the integer column AND, since 0058,
        // stores it unrounded in duration_seconds_precise — so a reader no longer has to go
        // through the job to get the fraction the manifest holds.
        durationSeconds: manifest.output.durationSec,
      }),
      transferTimeoutMs(),
      "stitch upload",
    );

    await succeedStitch(job.id, RUNNER_ID, published.assetId);
    if (structure) {
      // Its own catch: past succeedStitch a throw here would reach the catch below and fail a stitch that is stored.
      await writeStructure(published.assetId, athleteId, structure).catch(
        () => false,
      );
    }
    logger.info(
      {
        stitchId: job.id,
        athleteId,
        assetId: published.assetId,
        clips: manifest.clips.length,
        durationSec: manifest.output.durationSec,
        sizeBytes: manifest.output.sizeBytes,
        // A curated NAME, or the fact that it was hers — never which video, and never its path.
        bed: manifest.audioBed?.source
          ? (spec.bed ?? (spec.bedAssetId ? "own-video" : null))
          : null,
        // A degraded finishing step, said out loud: the bed could not be levelled (finishing.ts measureLoudness).
        ...(manifest.audioBed?.unlevelled ? { bedUnlevelled: true } : {}),
        // A COUNT, never the words: a caption is hers and may be a name.
        captions: overlays.size,
        stills: stills.size,
        // Read off the run, not predicted: measurement (2) in the predictions doc — p95 of this
        // against the 180 s cap is what replaces the 10-minute budget with a number.
        ffmpegMs: manifest.ffmpeg.durationMs,
      },
      "stitch complete",
    );
    return "succeeded";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The full message is LOGGED; only the readable half is written to the row, because last_error
    // is rendered to the athlete by the status route.
    logger.warn(
      { stitchId: job.id, athleteId, error: message },
      "stitch failed",
    );
    await failStitch(job.id, RUNNER_ID, refusalFor(err));
    return "failed";
  } finally {
    clearTimeout(transferDeadline);
    if (dispose)
      await dispose().catch((err) =>
        logger.error(
          { stitchId: job.id, err },
          "workspace not disposed — this instance has leaked tmpfs",
        ),
      );
    inFlight.delete(job.id);
  }
}

export interface StitchTickResult {
  reaped: { exhausted: number; requeued: number };
  /** Rows taken off the queue by THIS tick. Each is now running detached in this process. */
  claimed: number;
  /** Already running here when the tick arrived. `claimed` is capped by what this leaves. */
  inFlight: number;
  /** True when this instance was already at capacity, so the tick deliberately claimed nothing. */
  atCapacity: boolean;
}

/**
 * One consumer pass. Returns as soon as the rows are claimed and started — it does NOT wait for
 * ffmpeg. See this file's header for why that is sound and why it is necessary.
 *
 * THE ORDER IS THE GUARD: capacity is computed and reserved BEFORE the claim, so a tick that has no
 * room takes no rows and leaves them visible to an instance that does. Claiming first and checking
 * after would mark the rows `running` under a lease this process was never going to honour, and the
 * work would then sit still until the lease lapsed.
 */
export async function stitchTick(): Promise<StitchTickResult> {
  // A post-kit preview render given up on marks its kit failed, or the kit would say "queued" forever.
  const reaped = await reapExpiredStitchLeases(failExhaustedRenders);

  const capacity = maxConcurrent() - inFlight.size;
  if (capacity <= 0) {
    logger.info(
      { inFlight: inFlight.size },
      "stitch tick at capacity — claimed nothing",
    );
    return { reaped, claimed: 0, inFlight: inFlight.size, atCapacity: true };
  }

  // With the Studio dark, the tick runs only because post-kit previews are on (tickGate.ts) — so it
  // claims only those, never a Studio timeline queued before the Studio went dark.
  const jobs = await claimStitchJobs(
    capacity,
    RUNNER_ID,
    studioEnabled() ? {} : { kind: RENDER_JOB_KIND },
  );
  for (const job of jobs) {
    inFlight.add(job.id);
    // DETACHED, and the catch is not optional: an unhandled rejection from a floating promise takes
    // the whole instance down, which would turn one bad timeline into every athlete's outage.
    // workStitch already closes the row and clears `inFlight` in its own finally.
    //
    // A post kit's preview render (agent/postKit/render) rides this queue — same lease, same reaper,
    // same capacity — and is told apart by its spec alone; a client's timeline can never carry that
    // `kind` (spec.ts builds every stored spec field by field). It closes its own row; `inFlight` is
    // cleared here for it, since it is not this module's to reach into.
    const work = isRenderJobSpec(job.spec)
      ? workPostKitRender(job, RUNNER_ID).finally(() => inFlight.delete(job.id))
      : workStitch(job);
    void work.catch((err) =>
      logger.error(
        { stitchId: job.id, err },
        "stitch runner threw outside its own handler",
      ),
    );
  }

  return {
    reaped,
    claimed: jobs.length,
    inFlight: inFlight.size,
    atCapacity: false,
  };
}

/** Exported for the suite: the lease must outlast the work, or the reaper races the runner. */
export const leaseCoversWork = () =>
  leaseMs() >= stitchTimeoutMs() + 2 * transferTimeoutMs();

export { maxAttempts };
