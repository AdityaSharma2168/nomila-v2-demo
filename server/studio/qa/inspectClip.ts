/**
 * studio/qa/inspectClip — the entry point for a generated CLIP. Resolve it, cut a strip, run the stage.
 *
 * The same split `qa/inspect.ts` has from `qa/verdict.ts`, for the same reason: this half owns the
 * database, the bytes and the filesystem, and `qa/videoClip.ts` owns the arithmetic of a verdict.
 * One of them can be tested without a disk and the other without a model.
 *
 * ─── ⚠️  NOTHING HERE CAN FAIL A GENERATION ────────────────────────────────────────────────────
 *
 * `inspectClipAsset` returns null instead of throwing, on every path: the asset is not hers, it has
 * no stored pixels, ffmpeg is unavailable, the strip is empty, a check dies. By the time this runs
 * the clip has been PAID FOR, STORED and the job has been closed as succeeded — so an exception
 * escaping here would destroy something valuable in order to report something worthless. That is
 * the same inversion `inspect.ts` and `segment.ts` both argue for.
 *
 * ─── WHY THE BYTES GO TO A TEMP FILE ───────────────────────────────────────────────────────────
 *
 * `studio/video/frames.ts` takes LOCAL PATHS ONLY and refuses a URL by name, because it carries no
 * credential and ffmpeg echoes its input back in stderr — a signed URL's query string IS the
 * credential. So the caller writes bytes to disk and hands over a path, exactly as
 * `video/materialize.ts` does for the stitch engine.
 *
 * ⚠️ ON CLOUD RUN /tmp IS RAM (services/videoPoster.ts:13-16). A generated clip is small — V2b's 6s
 * Veo clips are ~1 MB and an 8s one is on the order of 16 MB — and the file is removed in a
 * `finally`. This is not the place a 200 MB upload would ever arrive: it inspects what the runner
 * just made.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { readObject } from "../../lib/mediaStore";
import { withTimeout } from "../../lib/withTimeout";
import { createLogger } from "../../logger";
import {
  driftCurve,
  extractStrip,
  selectFrames,
  type FrameStrip,
} from "../video/frames";
import { probeMedia } from "../video/probe";
import { writeVerdict } from "./record";
import { GEMINI } from "../../lib/models";
import { recordOffRouterSpend } from "./cost";
import { rerollFor } from "../video/reroll";
import { runClipQa } from "./videoClip";
import {
  withDriftObservation,
  withRerollAdvice,
  type CreativeQaVerdict,
} from "./verdict";
import { identityDriftEnabled, identityPackEnabled } from "../config";
import { bandFor, readProfile } from "../identity/profile";
import { DRIFT_ANCHORS, observeDrift, type DriftObservation } from "./drift";
import type { ShotType } from "../types";

const logger = createLogger("studio/qa/inspectClip");

/**
 * The whole stage's bound. Generous, because it shells out to ffmpeg twice and then makes up to
 * twelve vision calls — and cheap to be generous with, because this runs AFTER the job is closed
 * and nothing is waiting on it.
 */
const CLIP_QA_TIMEOUT_MS = Number(
  process.env.STUDIO_QA_CLIP_TIMEOUT_MS ?? 180_000,
);

export interface InspectClipInput {
  assetId: string;
  /** TENANCY: off the claimed row, never from a request, a client or a model. */
  athleteId: string;
  /** The shot direction this clip was generated from. Untrusted — the checks delimit it. */
  instruction: string;
  /**
   * The pixels, if the caller still holds them.
   *
   * The runner does: the adapter returned them and `storeAsset` uploaded them, so re-downloading
   * what we just uploaded is a round trip for nothing. Absent for a rehosted-from-url asset and for
   * a backfill, which read the object back instead.
   */
  bytes?: Buffer;
  /** What kind of segment this was, for the re-roll record. */
  shotType?: ShotType | null;
  /**
   * `generation_jobs.cost_estimated_usd` for this clip — what a re-roll would cost, because a
   * re-roll of the same brief is the same job at the same price. Null when we do not know, and
   * NEVER zero: pricing.ts refuses a confident zero and so does the recommendation.
   */
  quotedUsd?: number | null;
  /** Write the verdict to the asset's metadata. A dry run passes false. */
  persist?: boolean;
}

/**
 * Inspect one stored clip. Returns the verdict, or null when there was nothing to look at.
 *
 * Null is a SUPPORTED OUTCOME and never an error: the asset is not hers, its pixels never arrived,
 * ffmpeg could not read it. Each one is logged and each one leaves the generation exactly as it was.
 */
export async function inspectClipAsset(
  input: InspectClipInput,
): Promise<CreativeQaVerdict | null> {
  try {
    return await withTimeout(inner(input), CLIP_QA_TIMEOUT_MS, "clip QA");
  } catch (err: unknown) {
    logger.warn(
      {
        assetId: input.assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "clip QA did not complete",
    );
    return null;
  }
}

async function inner(
  input: InspectClipInput,
): Promise<CreativeQaVerdict | null> {
  const { assetId, athleteId } = input;

  const [row] = await db
    .select({
      gcs_path: mediaAssets.gcs_path,
      media_type: mediaAssets.media_type,
      // For the cost line's join key (PR 11); the row is read once either way.
      generation_job_id: mediaAssets.generation_job_id,
      // PR 17 (R-6): the beats 9.5's clip read wrote, for drift's frame stamps. Read, never written.
      metadata: mediaAssets.metadata,
    })
    .from(mediaAssets)
    // TENANCY: in the predicate. An asset that is not hers is NOT FOUND rather than forbidden —
    // the same answer for "does not exist" and "is not yours", as everywhere on this path.
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
    )
    .limit(1);

  if (!row) {
    logger.info(
      { assetId },
      "no such asset under this athlete — not inspecting",
    );
    return null;
  }
  if (row.media_type !== "VIDEO") {
    // Not a failure: the image path has its own entry point and its own checks. Refusing by name
    // means a caller that pointed this at a still learns so instead of getting a clip verdict about
    // one frame.
    logger.info({ assetId }, "not a clip — the image stage owns this one");
    return null;
  }

  const bytes = input.bytes ?? (await readObject(row.gcs_path ?? ""))?.buf;
  if (!bytes?.length) {
    logger.warn({ assetId }, "no pixels to inspect");
    return null;
  }

  const dir = await mkdtemp(join(tmpdir(), "studio-clipqa-"));
  const path = join(dir, `${assetId}.mp4`);
  try {
    await writeFile(path, bytes);

    // Probed separately from `extractStrip`'s own probe, which costs ~18ms and buys the frame rate
    // the coverage denominator needs. `selectFrames` takes it as an argument rather than reading it
    // off the strip, which is the one thing a caller here could get wrong — so it is read from the
    // SAME file, on the line above the strip, where a mismatch would be visible.
    const probed = await probeMedia(path);
    const strip = await extractStrip(path, { kind: "fps" });
    try {
      const curve = await driftCurve(strip);
      const sample = selectFrames(strip, curve, probed.fps);

      // HER band, only with STUDIO_IDENTITY_PACK on and only when her stranger control passed (PR 17,
      // R-4); else null and every frame is placed against the global const as before.
      const band = identityPackEnabled() ? await bandFor(athleteId) : null;

      const checked0 = await runClipQa({
        assetId,
        strip,
        curve,
        sample,
        instruction: input.instruction,
        ...(band ? { band } : {}),
      });

      // ─── DRIFT (PR 17, R-6) — an observation beside the verdict, never a check ───────────────
      //
      // Behind STUDIO_IDENTITY_DRIFT. Frames at the beat boundaries off `metadata.vision.beats`;
      // is-it-her anchors are handed over ONLY when `band` answered, i.e. her control passed.
      // ⚠️ MUTATION (drift.test "is-it-her shown for an athlete whose control failed"): pass anchors
      // without the `band &&`. Any failure here leaves the verdict exactly what runClipQa returned.
      const checked = identityDriftEnabled()
        ? withDriftObservation(
            checked0,
            await driftFor(
              assetId,
              athleteId,
              path,
              probed.durationSec,
              row.metadata,
              strip,
              band !== null,
            ),
          )
        : checked0;

      // RECORDED, NEVER ACTED ON. A failed clip gets a recommendation with its reasons and what a
      // re-run would cost; nothing here calls a provider, opens a row or claims an approval. See
      // studio/video/reroll.ts for why that is a money rule rather than a product preference.
      const verdict = withRerollAdvice(
        checked,
        rerollFor(checked, {
          shotType: input.shotType ?? null,
          quotedUsd: input.quotedUsd ?? null,
        }),
      );

      if (input.persist !== false)
        await writeVerdict(assetId, athleteId, verdict);
      // The cost line (PR 11, R-2): what inspecting this clip spent, joined to the clip and its job.
      await recordOffRouterSpend({
        task: "clip.inspect",
        model: GEMINI.flash,
        spend: verdict.spend,
        latencyMs: verdict.latencyMs,
        inputRefs: [assetId],
        attribution: { assetId, jobId: row.generation_job_id },
      });
      logger.info(
        {
          assetId,
          overall: verdict.overall,
          unknownChecks: verdict.unknownChecks,
          checked: verdict.clip?.coverage.checked,
          scanned: verdict.clip?.coverage.scanned,
          total: verdict.clip?.coverage.total,
          usd: verdict.spend.usd,
          ms: verdict.latencyMs,
          // Named so a log reader can see a recommendation was made without opening the jsonb — and
          // see that nothing acted on it.
          rerollReasons:
            verdict.clip?.reroll?.reasons.map((r) => r.check) ?? null,
        },
        "clip QA complete — not gated",
      );
      return verdict;
    } finally {
      await strip.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The drift observation for one clip, or null. Anchors (is-it-her) are fetched ONLY when
 * `controlPassed` — the caller's `band !== null`, which profile.ts answers only on control_passed.
 */
async function driftFor(
  assetId: string,
  athleteId: string,
  clipPath: string,
  durationSec: number,
  metadata: unknown,
  strip: FrameStrip,
  controlPassed: boolean,
): Promise<DriftObservation | null> {
  try {
    const beats = (metadata as { vision?: { beats?: unknown } } | null)?.vision
      ?.beats;
    const anchors: { assetId: string; bytes: Buffer; mimeType: string }[] = [];
    if (controlPassed) {
      const profile = await readProfile(athleteId);
      const top = [...(profile?.pack ?? [])]
        .sort((a, b) => (b.faceSizeFrac ?? 0) - (a.faceSizeFrac ?? 0))
        .slice(0, DRIFT_ANCHORS);
      for (const e of top) {
        const [r] = await db
          .select({ gcs_path: mediaAssets.gcs_path })
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.id, e.assetId),
              eq(mediaAssets.athlete_id, athleteId),
            ),
          )
          .limit(1);
        const obj = r?.gcs_path ? await readObject(r.gcs_path) : null;
        if (obj)
          anchors.push({
            assetId: e.assetId,
            bytes: obj.buf,
            mimeType: obj.contentType,
          });
      }
    }
    const obs = await observeDrift({
      assetId,
      clipPath,
      durationSec,
      beats,
      strip,
      anchors,
    });
    if (obs)
      logger.info(
        {
          assetId,
          framesFrom: obs.framesFrom,
          frames: obs.frames.length,
          medianStep: obs.medianStep,
          maxStep: obs.maxStep,
          atSec: obs.maxStepAtSec,
          maxOverMedian: obs.maxOverMedian,
          isHer: obs.isHer ? obs.isHer.anchors : null,
          usd: obs.spend.usd,
          ms: obs.latencyMs,
        },
        "identity drift observed — not gated",
      );
    return obs;
  } catch (err: unknown) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "drift observation did not complete",
    );
    return null;
  }
}
