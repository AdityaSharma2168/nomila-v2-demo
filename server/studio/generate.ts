/**
 * studio/generate — the general generation path: brief → job → pixels → a draft asset.
 *
 * The mirror of `runConceptGeneration` for work that is NOT a campaign concept. Both walk the same
 * loop (open a job, claim it, call the router, store what came back, record it, close the job); they
 * differ in what they are allowed to be. `runConceptGeneration` pins `objective: "concept"`,
 * `mode: "generate"` and a real `brandId`, because a concept has exactly one place to land — the
 * deck's concept slot. Studio's workspace has no such constraint: the athlete picks any objective,
 * any format, and a brand only when she wants one. Routing the workspace through the concept door
 * would either have to lie about the objective or refuse most of what the workspace offers.
 *
 * THIS MODULE DOES NOT RE-IMPLEMENT GENERATION. The verdict is studio/preview.ts's, the routing and
 * the billing are studio/router.ts's, the job rows are studio/jobs.ts's, and the clearance is
 * studio/approval.ts's. What lives here is the ORDER those are called in, which is the part that
 * has to be right for money not to be spent twice or spent unapproved.
 *
 * ─── THE ORDER, AND WHY IT IS THIS ORDER ────────────────────────────────────────────────────────
 *
 *   1. re-derive the verdict from the STORED brief          — never trust a client "I previewed"
 *   2. refuse if blocked / unpriced / over the approval / over the hard cap
 *   3. open the job row
 *   4. CONSUME THE APPROVAL (atomic) — the last thing before anything billable
 *   5. claim, call the router, store, record, close
 *
 * Step 5 has one preparation step inside it: a source frame stored with an EXIF orientation has
 * that rotation baked into its pixels before the router is called, because the provider ignores the
 * flag (studio/orient.ts). It happens in `resolveStoredReference`, after the approval is claimed
 * and before anything bills, and a failure there REFUSES rather than falling through to the
 * un-normalized bytes.
 *
 * Step 4 sits where it does deliberately. Consuming after a successful generation would leave the
 * window that matters wide open: two taps would both pass step 2, both would call the model, and
 * only then would one discover it lost. The approval is claimed BEFORE the spend, so the loser
 * never reaches the router at all.
 *
 * ─── TWO EXECUTION MODELS, ONE SPEND PATH — THE FORK IS AT STEP 4a ──────────────────────────────
 *
 * Images run INLINE: generation happens inside the request, and the job-status route exists for
 * reconnect and refresh rather than as the execution mechanism. That is right for both image tasks,
 * which are the same single synchronous `generateContent` call and beat the request timeout easily.
 *
 * Video CANNOT. The A6.1 spike measured Veo at ~63s for an 8s clip and `videoPoll()` permits 600s.
 * Cloud Run would tolerate that (`timeoutSeconds: 3600`) — the reason it still cannot run inline is
 * that Google's load balancer drops a connection held open that long with no bytes flowing, the same
 * reason server/lib/sse.ts keepalives at 15s; and 63s was the BEST case (8s, 720p, no audio,
 * unloaded). So `video.generate` is QUEUED here and worked by a leased runner
 * (studio/videoRunner.ts), and the client polls the job.
 *
 * ─── WHAT THE DETACHED PATH DOES *NOT* CHANGE, WHICH IS THE IMPORTANT PART ──────────────────────
 *
 * Steps 1-4 above are identical for both. In particular the approval is consumed at step 4, IN THE
 * REQUEST, before the job is queued and therefore before any runner can see it. The approval is
 * claimed exactly once, by the one actor there is only one of — this tap. A runner that picks the
 * job up later, or a second runner that picks it up after a lease handoff, finds `consumed_at`
 * already set and has nothing left to claim.
 *
 * That is deliberately NOT the same guard as "don't call the provider twice", which is a different
 * hazard belonging to the runner and answered by the submit-once pair in studio/videoJobs.ts.
 * Neither stands in for the other, and collapsing them is the mistake to watch for in review.
 */
import { PLATFORM_CAP_MESSAGE, platformBudget } from "../lib/platformSpend";
import { db } from "../db";
import { generationJobs } from "../../shared/schema";
import { and, eq } from "drizzle-orm";
import { signedUrl, saveBuffer, rehostFromUrl } from "../lib/mediaStore";
import { withTimeout } from "../lib/withTimeout";
import { needsOrienting, orientToPixels } from "./orient";
import { parseImageSize } from "./imageSize";
import sharp from "sharp";
import {
  cropFrame,
  pasteBack,
  JPEG_LADDER,
  type CompositeInput,
} from "./composite";
import { createLogger } from "../logger";
import {
  maxDayUsd,
  maxJobUsd,
  maxVideoBytes,
  nativeEditEnabled,
  outputGateEnabled,
  promptRegistryEnabled,
  studioVideoEnabled,
} from "./config";
import type { EditPath } from "./classify";
import { readNativeIntent } from "./nativeEdit";
import {
  createGenerationJob,
  claimJob,
  cancelJob,
  failJob,
  succeedJob,
  recordGeneratedAsset,
  assetsForJob,
  spentTodayUsd,
} from "./jobs";
import { queueJob } from "./videoJobs";
import { inspectAsset } from "./qa/inspect";
import { placedAdds } from "./compile";
import { markProvenanceFor } from "./interpret/markProvenance";
import { creativeQaEnabled } from "./qa/record";
import { recordGate, templateOf } from "./outputGate";
import { recordScore } from "./templateScore";
import {
  editCropsFor,
  plannedInputs,
  previewGeneration,
  runGeneration,
  type GenerationPreview,
  type PlannedReference,
  type PreviewOptions,
} from "./preview";
import { masksForCrop, polarityFor, type MaskMiss } from "./segment";
import { consumePreview } from "./previewStore";
import { assertSpendWithinCaps } from "./spendCaps";
import {
  GenerationError,
  type GeneratedAsset,
  type GenerationResult,
  type GenerationTask,
  type ImageRef,
} from "./types";
import type { CreativeBrief } from "./brief";

const logger = createLogger("studio/generate");

/** Reading one source frame off GCS. Generous — a 4000x6000 original is tens of megabytes. */
const REFERENCE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Tasks this module runs INSIDE the request. Both image tasks are one synchronous provider call and
 * beat the request timeout comfortably. The absent entry is `video.generate` — not on capability
 * grounds (the engine and the adapter both do video) but on wall-clock ones; it is queued instead.
 */
const INLINE_SAFE_TASKS = new Set<GenerationTask>([
  "image.generate",
  "image.edit",
  // PR 19: a crop is milliseconds of sharp, in-process — never a queued job.
  "image.crop",
]);

/**
 * Does this task run inside the request, or get queued for a runner?
 *
 * The spike answered the question the module header left open: Veo took ~63s for an 8s clip, and
 * `videoPoll()` permits 600s. Cloud Run itself would tolerate that (timeoutSeconds is 3600), but
 * Google's load balancer drops a connection held open that long with nothing flowing — the same
 * reason server/lib/sse.ts keepalives at 15s — and 63s was the BEST case: one clip, 8s, 720p, no
 * audio, an unloaded provider. So video is detached, and this is the fork that decides it.
 */
const runsInline = (task: GenerationTask): boolean =>
  INLINE_SAFE_TASKS.has(task);

export const VIDEO_NOT_ENABLED =
  "Video isn't switched on yet. Everything else about this brief checks out — clips are being " +
  "turned on carefully, a little at a time, because each one costs real money to make.";

/**
 * THE ONE PLACE VIDEO IS HELD, and the replacement for `assertRunnableInline`.
 *
 * The old hold was a hard-coded refusal: video was unreachable and the only way to change that was
 * to delete the line. V3 deleted it — so this is what stands in its place, with the difference that
 * it is a SWITCH (`STUDIO_VIDEO_ENABLED`, default off, per environment) rather than a deploy.
 *
 * ─── WHY IT SITS ABOVE THE MONEY CHECKS ─────────────────────────────────────────────────────────
 *
 * Same reason the hold did: refusing earlier is cheaper. With the flag off a clip opens no job row,
 * consumes no approval and never reaches the router, so there is nothing to reconcile and nothing to
 * refund. That also means the caps in studio/spendCaps.ts are again unreachable for video while the
 * flag is off — which is correct, and is exactly the state spendCaps.test.ts was written to survive:
 * it calls the gate directly with real video quotes, so the refusals stay proven either way.
 *
 * The flag is deliberately NOT `studioEnabled`. Turning Studio on for an environment must not turn
 * video on with it.
 */
function assertVideoEnabled(task: GenerationTask): void {
  if (task === "video.generate" && !studioVideoEnabled()) {
    throw new GenerationError(VIDEO_NOT_ENABLED, "unsupported_task");
  }
}

export interface RunStudioGenerationInput {
  /** TENANCY: from `req.athleteId`. Every read and write below is scoped by it. */
  athleteId: string;
  /** The FROZEN brief off the stored preview — never re-built from the request. */
  brief: CreativeBrief;
  /** The preview whose approval this spend is claimed against. */
  previewId: string;
  /**
   * The figure the athlete was SHOWN, read back from the server's own preview row. Never a number
   * that arrived in a request body — see the studio/previewStore.ts header for why the dangerous
   * forgery is an inflated ceiling rather than a deflated one.
   */
  approvedCostUsd: number;
}

export interface StudioGeneration {
  jobId: string;
  /**
   * True when this call CLAIMED THE APPROVAL. False ⇒ an earlier identical tap did, and `jobId` is
   * its job.
   *
   * Note it means "the approval is spent", not "the provider has been paid" — for a queued video the
   * two are deliberately not the same moment, which is what `queued` below distinguishes.
   */
  spent: boolean;
  /**
   * True ⇒ nothing has been generated yet and nothing will be, in this request: the job is on the
   * queue and a runner will work it. `assets` is empty by construction and the caller must poll.
   * Absent/false for the inline image path, whose assets are already in `assets` when it returns.
   */
  queued?: boolean;
  preview: GenerationPreview;
  assets: {
    id: string;
    gcsPath: string | null;
    approvalStatus: string | null;
  }[];
  /**
   * Targets a masked edit could not apply, when at least one other did. A PARTIAL success.
   *
   * Undefined on a clean run and on a duplicate tap. A job where nothing landed throws instead, so
   * this never carries "all of them" — if it is set, she has an asset and it is missing something.
   */
  failedTargets?: string[];
}

/**
 * Resolve a stored reference into something a provider can read.
 *
 * The default in preview.ts is a pass-through, right for brand imagery (real https urls) and wrong
 * for a GCS path. The fork is on the ref itself because one brief can carry both.
 *
 * ─── THE SOURCE FRAME MAY HAVE TO BE NORMALIZED FIRST ───────────────────────────────────────────
 *
 * Gemini reads the raw buffer and ignores EXIF orientation (measured — see the studio/orient.ts
 * header). For a rotated frame that puts the model 90 degrees out from the athlete, the mask and
 * the prompt, and returns the edit rotated as well. So when the frozen brief says the source
 * declares an orientation, its pixels are made upright HERE, before any provider sees them, and the
 * reference travels as bytes rather than as a url.
 *
 * ONLY the source frame, and only when the BRIEF says it needs it — and it refuses rather than guess.
 * Brand imagery and product shots are art direction rather than the frame an edit has to stay
 * continuous with — nothing is measured against them and no coordinate points into them — so they
 * have their own, forgiving arm below. A `generate` has no source at all and never reaches the branch.
 *
 * ─── A PHOTOGRAPH OF HER IS DOWNSCALED, AND THAT IS THE OTHER FORK ──────────────────────────────
 *
 * The person slot now holds up to three photographs, and the vertex adapter inlines every reference
 * whole. `personReference` shrinks them to a fixed long edge first.
 *
 * ─── A PHOTOGRAPH OF A THING IS PUT UPRIGHT, AND THAT IS THE THIRD ─────────────────────────────
 *
 * A product, an object she tagged, a brand's imagery: `thingReference` reads the file's own flag and
 * straightens it only when it has one. Never resized. An upright one goes on the url path exactly as
 * before. Only the source frame that needs nothing still takes the url path unconditionally.
 */
export async function resolveStoredReference(
  r: PlannedReference,
  brief: CreativeBrief,
): Promise<ImageRef> {
  const source = brief.job.source;
  const isSourceFrame =
    r.role === "source-frame" && !!source && source.ref === r.ref;

  if (isSourceFrame && needsOrienting(source.orientation)) {
    try {
      const fetched = await fetchReferenceBytes(r.ref);
      const oriented = await orientToPixels(fetched.bytes, fetched.contentType);
      logger.info(
        {
          athleteId: brief.athlete.athleteId,
          orientation: source.orientation,
          ref: r.ref,
        },
        "source frame normalized before generation — provider will see upright pixels",
      );
      return {
        kind: "bytes",
        bytes: oriented.bytes,
        mimeType: oriented.mimeType,
      };
    } catch (err) {
      // REFUSE, never fall back to the un-normalized url. Sending the raw bytes is precisely the
      // failure this exists to stop, and it fails silently: the generation succeeds, bills, and
      // comes back edited in the wrong place. A refusal she can read is the only honest answer.
      //
      // The MESSAGE, never the error object — a serialized fetch error can carry the signed url,
      // whose query string is the credential (the rule costLog.safeRef follows).
      logger.warn(
        {
          athleteId: brief.athlete.athleteId,
          orientation: source.orientation,
          error: err instanceof Error ? err.message : String(err),
        },
        "could not normalize the source frame — refusing rather than sending rotated pixels",
      );
      throw new GenerationError(
        "We couldn't prepare this photo for editing. It's stored rotated, and we have to straighten " +
          "it before the edit or the change would land in the wrong place. Try another photo, or " +
          "re-upload this one.",
        "provider_error",
      );
    }
  }

  if (r.role === "person") return personReference(r, brief);
  if (
    r.role === "product" ||
    r.role === "object" ||
    r.role === "brand-imagery"
  ) {
    return thingReference(r, brief);
  }

  return referenceUrl(r);
}

/** A reference as the url it has always travelled as: its own https url, or a GCS path signed. */
async function referenceUrl(r: PlannedReference): Promise<ImageRef> {
  if (/^https?:\/\//i.test(r.ref)) return { kind: "url", url: r.ref };
  return { kind: "url", url: await signedUrl(r.ref) };
}

/**
 * A photograph of a THING — a product, an object she tagged, a brand's own imagery — put upright
 * before it is sent, when the file says it is not.
 *
 * ─── THE SAME DEFECT AS HER PHOTOGRAPHS, LEFT OPEN ON PURPOSE UNTIL NOW ─────────────────────────
 *
 * `personReference` below was given `.rotate()` after a flagged pack photograph reached the model on
 * its side (measured 2026-09-16: two of athlete 3811cedd's three are stored 6000x4000 with
 * `orientation=8`). Every other reference kept the url path, and `toInlinePart`
 * (studio/adapters/vertex.ts) base64s a url's stored bytes whole — flag included, ignored by the
 * model. So a flagged product shot, object photo or brand image reached the model sideways too; that
 * PR fixed the person slot only and wrote the rest down as open. This closes it with the same
 * `.rotate()` — the EXIF-driven form, a no-op on a file with no flag.
 *
 * ─── WHAT IT CHANGES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────────
 *
 * UPRIGHT (no flag, or `orientation=1`) → the url path, byte for byte what shipped before. Re-encoding
 * a correct photograph would cost detail for nothing — and the fine detail of a product is exactly
 * what the model is told to reproduce. The price is that its bytes are fetched once here, to read
 * the flag, and again by the adapter.
 *
 * FLAGGED → decoded, rotated, re-encoded, and sent as bytes. NEVER RESIZED: nothing here is a pack,
 * and shrinking a product is a change to an output nobody asked about (see `personReference`). The
 * encode is the ladder's top rung (JPEG_LADDER, q100 4:4:4 — the encode an over-cap native output is
 * kept at, measured at a max Δ of 4/255) so the rotation is the only thing that visibly changes; a
 * file with an alpha channel goes as PNG, because a JPEG would flatten a cut-out product onto black.
 *
 * ON FAILURE IT FALLS BACK to the url, as `personReference` does and for its reason: this path
 * existed before, and a fetch or decode failure is no reason to refuse a generation that was already
 * running on it. Unlike the source frame, no mask or coordinate depends on these pixels.
 */
async function thingReference(
  r: PlannedReference,
  brief: CreativeBrief,
): Promise<ImageRef> {
  try {
    const fetched = await fetchReferenceBytes(r.ref, `${r.role} reference`);
    const image = sharp(fetched.bytes);
    const { orientation, hasAlpha } = await image.metadata();
    if (!needsOrienting(orientation)) return referenceUrl(r);

    // `.rotate()` with no angle applies the file's own flag and drops it, so nothing downstream can
    // rotate the result a second time (studio/orient.ts, `orientToPixels`).
    const upright = image.rotate();
    const bytes = hasAlpha
      ? await upright.png().toBuffer()
      : await upright.jpeg(JPEG_LADDER[0]).toBuffer();
    logger.info(
      {
        athleteId: brief.athlete.athleteId,
        role: r.role,
        orientation,
        from: fetched.bytes.length,
        to: bytes.length,
      },
      "reference straightened before send — its file carried an orientation flag",
    );
    return {
      kind: "bytes",
      bytes,
      mimeType: hasAlpha ? "image/png" : "image/jpeg",
    };
  } catch (err) {
    // The MESSAGE, never the error object — a serialized fetch error can carry the signed url, whose
    // query string is the credential (the rule costLog.safeRef follows).
    logger.warn(
      {
        athleteId: brief.athlete.athleteId,
        role: r.role,
        error: err instanceof Error ? err.message : String(err),
      },
      "could not read a reference's orientation — sending it as stored, as before",
    );
    return referenceUrl(r);
  }
}

/**
 * The long edge a photograph of HER is sent at.
 *
 * ─── WHY THERE IS A NUMBER HERE AT ALL ──────────────────────────────────────────────────────────
 *
 * `studio/adapters/vertex.ts` has no url form for a reference: `toInlinePart` fetches each one and
 * base64s it into the request body. A pack of three 24 MP camera-roll uploads is therefore ~20 MB of
 * JSON assembled in memory inside a Cloud Run request — three times what a single reference cost
 * before packs existed, on the one path where the athlete is most likely to attach her best,
 * largest photographs. The inline-request ceiling was not verifiable from Google's docs this
 * session, so this is a payload judgement rather than a measured limit, and it is stated as one.
 *
 * ─── AND WHY IT COSTS NOTHING ───────────────────────────────────────────────────────────────────
 *
 * The model bills a fixed 560 input tokens per image whatever its resolution, so this buys no money
 * — it removes a cliff. 2048 is above what the renderer is documented to work from and well above
 * the face-region detail any of this needs; 1K and 2K outputs are themselves 1024 and 2048 on the
 * long edge.
 *
 * ⚠️ NOT MEASURED AGAINST IDENTITY. Every image in the probe went out at full resolution. If a pack
 * ever looks worse than the same photographs did before this, THIS is the first thing to rule out —
 * raise it to 4096 and compare, rather than assuming the wording moved.
 */
const PERSON_REF_LONG_EDGE_PX = 2048;

/** Quality 88 keeps skin and hair detail at this size; the file is a request body, not an archive. */
const PERSON_REF_QUALITY = 88;

/**
 * A photograph of her, downscaled before it is sent.
 *
 * ONLY the person slot. A product shot is a thing whose fine detail the model is asked to reproduce
 * exactly, brand imagery is art direction on somebody else's cdn, and the source frame is the
 * photograph an edit must stay pixel-continuous with — none of them are packs, none of them arrive
 * three at a time, and shrinking any of them would be a change to an output nobody asked about.
 *
 * ─── ⚠️ IT ROTATES, AND THE FIRST VERSION OF THIS FUNCTION DID NOT. MEASURED 2026-09-16. ────────
 *
 * That version carried a paragraph arguing rotation was out of scope: `sharp` ignores the EXIF
 * orientation flag unless told and so does Gemini, so the model would see the same pixels either
 * way; and references come from the picker, which is filtered to uploads, and an upload is
 * straightened on the way in — so a flagged person reference should not exist.
 *
 * The last clause is FALSE, and it was checkable in thirty seconds. Of the three photographs in
 * athlete 3811cedd's own pack, TWO are stored 6000x4000 carrying `orientation=8` — upright they are
 * 4000x6000 portraits. Sent as stored, the model is handed a woman lying on her side, and it does
 * what you would expect: a live 8-image run through this path came back with four strangers, roughly
 * a decade too old, one of a different apparent ethnicity. The router-direct probe that produced a
 * real likeness of her had `sharp(raw).rotate()` in it, commented "ingest already straightens
 * uploads; this is belt-and-braces". The belt-and-braces was the load-bearing part.
 *
 * ⚠️ THE DEFECT IS OLDER THAN THIS FUNCTION. Before packs a person reference travelled as a signed
 * url and `toInlinePart` (studio/adapters/vertex.ts) base64'd the stored bytes whole — flag included,
 * ignored by the model, sideways. So every generate conditioned on a flagged photograph has been
 * conditioned on a sideways one. This is the first place on that path that decodes the pixels at
 * all, which makes it the first place that can put them upright.
 *
 * It is NOT studio/orient.ts's job. That is about an EDIT's frame, where a mask and coordinates have
 * to agree with the pixels, and it REFUSES rather than guessing. Here there is no mask and no
 * coordinate — just a photograph of a face that should be the right way up.
 *
 * ON FAILURE IT FALLS BACK rather than refusing, which is the opposite of the source-frame arm above
 * and deliberately so: that one refuses because sending un-normalized bytes produces a wrong edit
 * that still bills. This one is an optimization. If sharp or the fetch fails, the url path is
 * exactly what shipped before packs, so the honest answer is to send it and say so in the log.
 */
async function personReference(
  r: PlannedReference,
  brief: CreativeBrief,
): Promise<ImageRef> {
  try {
    const fetched = await fetchReferenceBytes(r.ref, "person reference");
    const resized = await sharp(fetched.bytes)
      // FIRST, and before the resize, or a flagged portrait is measured on its long edge sideways.
      .rotate()
      .resize(PERSON_REF_LONG_EDGE_PX, PERSON_REF_LONG_EDGE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: PERSON_REF_QUALITY })
      .toBuffer();
    logger.info(
      {
        athleteId: brief.athlete.athleteId,
        from: fetched.bytes.length,
        to: resized.length,
      },
      "person reference downscaled before send",
    );
    return { kind: "bytes", bytes: resized, mimeType: "image/jpeg" };
  } catch (err) {
    // The MESSAGE, never the error object — a serialized fetch error can carry the signed url, whose
    // query string is the credential (the rule costLog.safeRef follows).
    logger.warn(
      {
        athleteId: brief.athlete.athleteId,
        error: err instanceof Error ? err.message : String(err),
      },
      "could not downscale a person reference — sending it full size, as before",
    );
    if (/^https?:\/\//i.test(r.ref)) return { kind: "url", url: r.ref };
    return { kind: "url", url: await signedUrl(r.ref) };
  }
}

/**
 * The stored object's bytes, through the same signed-url door everything else in studio uses.
 *
 * `what` names the thing in the timeout label and the failure, because this has two callers now and
 * they are not the same photograph: the source frame an edit must stay continuous with, and a
 * photograph of HER on a generate. "could not read the source frame" on a reference-pack timeout is
 * a log line that sends the next reader to the wrong half of the file.
 */
async function fetchReferenceBytes(
  ref: string,
  what = "source frame",
): Promise<{ bytes: Buffer; contentType?: string }> {
  const url = /^https?:\/\//i.test(ref) ? ref : await signedUrl(ref);
  const res = await withTimeout(
    fetch(url),
    REFERENCE_FETCH_TIMEOUT_MS,
    `${what} fetch`,
  );
  if (!res.ok) throw new Error(`could not read the ${what} (${res.status})`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType:
      (res.headers.get("content-type") ?? "").split(";")[0].trim() || undefined,
  };
}

/** Where a job's output lives. Same convention as the concept path and mediaStore.uploadObjectPath. */
export const studioObjectBase = (
  athleteId: string,
  jobId: string,
  index: number,
): string => `athletes/${athleteId}/studio/${jobId}/${index}`;

/**
 * How far an edit's output may drift from the frame it was editing, as a share of the aspect ratio.
 *
 * Set to catch a TRANSPOSE and nothing else. A sideways return — a 3024x4032 source coming back
 * 4032x3024 — is a 78% swing and is caught comfortably; the model rescaling a frame (400x300 in,
 * 1200x896 out, measured on the live project) moves the ratio by well under a percent and is
 * deliberately NOT caught here. That rescaling is the separate "retouch, not a new photograph"
 * problem and it gets its own investigation; this guard is only about the picture arriving on its
 * side.
 */
const MAX_EDIT_ASPECT_DRIFT = 0.15;

/**
 * Refuse an edit whose output does not have the shape of the frame it edited.
 *
 * ─── THIS GUARD WAS NEVER THE CAUSE, AND IT WAS ALSO NEVER THE CURE ────────────────────────────
 *
 * Rotated edits were shipping while this guard sat here passing them, and the reason is worth
 * keeping: the shape it compared against was itself wrong. `parseImageSize` let a file's second
 * APP1 segment (XMP) overwrite the orientation declared by its first (Exif), so every 24MP upload
 * measured 6000x4000 landscape when it displays 4000x6000 portrait. The request then ASKED for a
 * landscape canvas, the model obligingly returned one, and `drift` came out near zero — the guard
 * agreeing with the bug rather than catching it. Fixed in studio/imageSize.ts; pinned by
 * imageSize.test.ts and orientPath.test.ts.
 *
 * With the measurement corrected, the inbound leg is upright (studio/orient.ts) and the canvas we
 * ask for is the frame's own — so an upright return is what the provider now produces. Verified on
 * the live project: three real edits of a portrait 24MP frame, all returned portrait.
 *
 * ─── WHY IT STILL REFUSES RATHER THAN ROTATING ─────────────────────────────────────────────────
 *
 * The round trip is not symmetric. The inbound leg has an EXIF flag saying exactly what transform
 * to apply; the outbound leg has nothing — the provider returns a NEW image with no orientation
 * metadata and no record of what it did. A transposed return says a 90-degree turn happened but
 * not which way, and correcting it would mean guessing between two directions on an image that
 * already cost real money. There is no observation to calibrate that guess against: across every
 * real edit measured on this project, not one output came back transposed from the shape it was
 * asked for.
 *
 * So this stays a BACKSTOP, and a meaningful one for the first time — it is now comparing against
 * the shape the athlete actually sees. If it ever does fire, the job fails with something she can
 * read, the approval stays consumed (that spend happened), and no sideways asset reaches her
 * library where an approval tap could publish it. A rotation invented here would instead be wrong
 * half the time and silent about it, which is the failure this whole area has been about.
 *
 * Measured from the returned BYTES with the same header parser the source frame uses — the adapters
 * report `width`/`height` off their own inputs rather than the response, so those cannot answer
 * this. An asset that arrives as a url rather than bytes is not measured and not blocked; it is
 * logged, because refusing on something we did not look at would be worse than passing it on.
 */
function assertEditKeptItsShape(
  asset: GeneratedAsset,
  source: { width: number | null; height: number | null },
  ctx: { athleteId: string; jobId: string },
): void {
  if (!source.width || !source.height) return; // nothing to compare against
  if (!asset.bytes) {
    logger.info(
      { ...ctx },
      "edit output arrived as a url — shape not verified",
    );
    return;
  }
  const out = parseImageSize(asset.bytes);
  if (!out) {
    logger.warn(
      { ...ctx },
      "could not measure the edit output — shape not verified",
    );
    return;
  }
  const want = source.width / source.height;
  const got = out.width / out.height;
  const drift = Math.abs(got - want) / want;
  if (drift <= MAX_EDIT_ASPECT_DRIFT) return;

  logger.warn(
    {
      ...ctx,
      sourceW: source.width,
      sourceH: source.height,
      outW: out.width,
      outH: out.height,
      drift,
    },
    "edit output came back a different shape than the frame it edited — refusing",
  );
  throw new GenerationError(
    `The edit came back the wrong shape — your photo is ${source.width}x${source.height} and the ` +
      `result is ${out.width}x${out.height}, so it would have landed rotated. Nothing was saved to ` +
      "your library. This is on us, not on the photo — try again.",
    "provider_error",
  );
}

/**
 * The composite's own guarantee, asserted rather than assumed: the output IS the original's frame.
 *
 * `assertEditKeptItsShape` allows 15% of aspect drift because it is guarding against a TRANSPOSE on
 * a path where the provider chooses the canvas. Here we chose it — the paste-back composites into
 * the source's own pixels — so anything other than exact equality means the composite did not
 * happen, and a "close enough" result would be the model's re-render wearing the right shape.
 *
 * Measured from the returned BYTES, like its neighbour, because the adapters report width/height off
 * their own inputs rather than the response.
 */
function assertCompositeIsTheOriginal(
  asset: GeneratedAsset,
  source: { width: number | null; height: number | null },
  ctx: { athleteId: string; jobId: string },
): void {
  if (!source.width || !source.height || !asset.bytes) return;
  const out = parseImageSize(asset.bytes);
  if (!out) {
    logger.warn(
      { ...ctx },
      "could not measure the composited edit — full-res claim not verified",
    );
    return;
  }
  if (out.width === source.width && out.height === source.height) return;

  logger.warn(
    {
      ...ctx,
      sourceW: source.width,
      sourceH: source.height,
      outW: out.width,
      outH: out.height,
    },
    "composited edit is not the source's own frame — refusing",
  );
  throw new GenerationError(
    `The edit came back at ${out.width}x${out.height} instead of your photo's ${source.width}x${source.height}, ` +
      "so it isn't the full-resolution original any more. Nothing was saved to your library. This is " +
      "on us, not on the photo — try again.",
    "provider_error",
  );
}

/**
 * The store's ceiling — mediaStore's MEDIA_MAX_BYTES, read the way studio/composite.ts reads it:
 * mirrored, never written. Read at call time rather than frozen at load, so a test can lower it.
 */
const storeMaxBytes = () =>
  Number(process.env.MEDIA_MAX_BYTES ?? 25 * 1024 * 1024);

/**
 * A NATIVE edit's output, made to fit the store — so a paid generation is never thrown away for
 * being too large to keep.
 *
 * ─── WHAT WENT WRONG ────────────────────────────────────────────────────────────────────────────
 *
 * Vertex returns a native edit as PNG. At 4K that is 3392x5056 and 26.8–27.1 MB (all four of the
 * probe's Q5L outputs), over mediaStore's 25 MB cap — so `storeAsset` refused it AFTER the approval
 * was claimed and the call had billed. She was charged $0.24, answered "Couldn't generate that", and
 * a retry was a fresh approval at the full quote: the approval is consumed before the call on
 * purpose (it is the double-tap guard), and the refused bytes were never uploaded anywhere. The
 * probe never met this because it wrote its outputs to disk and never stored one.
 *
 * ─── THE FIX, AND WHY IT IS THIS ONE ───────────────────────────────────────────────────────────
 *
 * An output that fits is stored exactly as it came back — nothing changes for it. One that does not
 * is re-encoded down the composite's MEASURED ladder (JPEG_LADDER: q100 4:4:4, then 95, then 90),
 * at the highest rung that fits. On the four real 4K outputs the top rung is 17.8–17.9 MB — about
 * 7 MB under the cap — at a max Δ of 4/255 and a mean Δ of 0.41: the same error the ladder was
 * measured at for the composite.
 *
 * NOT raising the cap: it is shared infrastructure (studio/composite.ts `encodeToFit` records the same
 * refusal), and `readObject()` returns null above it too — a 27 MB asset would store and then be
 * invisible to every capped reader. NOT dropping to 2K: that trades 71% of the frame's pixels for 18%
 * to dodge an encoding choice (PR N, D1).
 *
 * The FORMAT change is not the surprise here that it would be on the masked path, where the composite
 * keeps her photograph's own format: a native output is the model's canvas, and PNG was the
 * provider's choice, not hers.
 *
 * ⚠️ NEVER WORSE THAN BEFORE. If every rung is still over the cap, the smallest goes on to
 * `storeAsset` and it refuses exactly as it did — no fourth rung nobody has measured. A frame sharp
 * cannot decode is passed through unchanged, for the same reason.
 */
async function fitNativeOutputToStore(
  asset: GeneratedAsset,
  ctx: { athleteId: string; jobId: string },
): Promise<GeneratedAsset> {
  const cap = storeMaxBytes();
  if (!asset.bytes || asset.bytes.length <= cap) return asset;
  const fromBytes = asset.bytes.length;
  try {
    let smallest: Buffer | null = null;
    for (const rung of JPEG_LADDER) {
      const bytes = await sharp(asset.bytes).jpeg(rung).toBuffer();
      smallest = bytes;
      if (bytes.length <= cap) {
        logger.info(
          {
            ...ctx,
            fromBytes,
            toBytes: bytes.length,
            quality: rung.quality,
            cap,
          },
          "native output over the store cap — stored as JPEG at the highest rung that fits",
        );
        return { ...asset, bytes, mimeType: "image/jpeg" };
      }
    }
    logger.warn(
      { ...ctx, fromBytes, smallest: smallest?.length ?? null, cap },
      "native output over the store cap at every rung — the store will refuse it",
    );
    return smallest
      ? { ...asset, bytes: smallest, mimeType: "image/jpeg" }
      : asset;
  } catch (err) {
    logger.warn(
      {
        ...ctx,
        fromBytes,
        error: err instanceof Error ? err.message : String(err),
      },
      "could not re-encode the native output — handing it to the store as it came back",
    );
    return asset;
  }
}

/** Persist one produced asset's pixels — inline bytes or a fetchable url, through one return type. */
export async function storeAsset(asset: GeneratedAsset, basePath: string) {
  // VIDEO GETS ITS OWN CEILING. mediaStore's default is 25 MB — right for the stills it was written
  // for, and a trap here: an oversized clip failed with "over the media size cap" AFTER the provider
  // had been paid. studio/preview.ts now refuses a clip projected over `maxVideoBytes` before the
  // approval is consumed; this is the matching ceiling on the storage side, so the two agree.
  const cap = asset.mimeType.startsWith("video/") ? maxVideoBytes() : undefined;
  const stored = asset.bytes
    ? await saveBuffer(asset.bytes, basePath, asset.mimeType, cap)
    : asset.url
      ? await rehostFromUrl(asset.url, basePath, cap)
      : null;

  if (!stored) {
    throw new GenerationError(
      "The provider returned an asset with neither bytes nor a url",
      "provider_error",
    );
  }
  if ("skipped" in stored) {
    throw new GenerationError(
      "Generated asset is over the media size cap and was not stored",
      "provider_error",
    );
  }
  return stored;
}

/**
 * A masked edit: N crops out, N patches back, one full-res original with the marked rectangles
 * changed. A crop that fails is recorded and skipped, never fatal while another one landed.
 *
 * ─── WHY THIS IS A LOOP AND NOT ONE CALL ────────────────────────────────────────────────────────
 *
 * Each CROP gets its own provider call. One crop around all the regions is the obvious
 * implementation and it fails the motivating case: two logos in opposite corners of a 4000x6000
 * frame union to 18.6 megapixels, which is the whole photograph, which is the re-render this path
 * exists to leave (studio/composite.ts).
 *
 * A crop is not a region, and since the merge it is often several: regions naming the same target
 * ride one call together where their union stays tight. The loop is bounded by `maxEditCalls()`
 * (studio/config.ts), refused in the PREVIEW before it spends — that cap is a wall-clock bound as
 * much as a spend one, because these calls are sequential and inline.
 *
 * ─── THE CROP RIDES IN THROUGH THE EXISTING RESOLVER SEAM ───────────────────────────────────────
 *
 * `runGeneration` is unchanged and unaware. It plans the brief, and when it asks the caller to
 * resolve the source-frame reference it is handed the CROP's bytes instead of the frame's. So every
 * one of these calls is an ordinary single generation whose frame happens to be a crop — the
 * re-derivation gate inside `runGeneration` still runs on every one of them, which is the defence in
 * depth that would have been lost by calling the router directly.
 *
 * `cropIndex` is the only thing that varies between the calls, and it moves the PROMPT and nothing
 * else: the task, the references, the image size and the quote are derived from the frozen brief
 * alone. That is what keeps the figure she approved and the figure this spends the same number.
 *
 * The frame is read and straightened ONCE, not per region. It is the expensive part (a 24MP decode)
 * and it is identical for every crop.
 */
async function runMaskedEdit(
  brief: CreativeBrief,
  crops: NonNullable<ReturnType<typeof editCropsFor>>,
  baseOpts: PreviewOptions,
  ctx: { athleteId: string; jobId: string },
): Promise<GenerationResult> {
  const frame = await uprightSourceBytes(brief);
  const patches: CompositeInput[] = [];
  const failed: string[] = [];
  /** Why each one failed, kept so a TOTAL failure can still say what went wrong rather than only that it did. */
  const reasons: string[] = [];
  const startedAll = Date.now();
  let last: Awaited<ReturnType<typeof runGeneration>> | null = null;

  for (const [cropIndex, plan] of crops.entries()) {
    const startedOne = Date.now();
    try {
      const cropBytes = await cropFrame(frame.bytes, plan);
      const result = await runGeneration(brief, {
        ...baseOpts,
        cropIndex,
        // The source frame becomes THIS crop. Everything else still resolves normally, so a product
        // shot or brand imagery on the same edit is untouched.
        resolveReference: async (r): Promise<ImageRef> =>
          r.role === "source-frame"
            ? { kind: "bytes", bytes: cropBytes, mimeType: "image/png" }
            : resolveStoredReference(r, brief),
      });
      const patch = result.assets[0];
      if (!patch?.bytes) {
        // A url-returning provider cannot be composited — there is nothing to paste. Falling back to
        // the model's own frame would hand her the re-render, so this crop is a loss like any other.
        throw new GenerationError(
          "the edit came back in a form we can't paste into your photo",
          "provider_error",
        );
      }
      // The mask, AFTER the patch has already landed. Ordering matters: this call cannot fail the
      // crop (studio/segment.ts never throws), but running it second also means a crop whose EDIT
      // failed never pays for a mask it will not use.
      // ONE MASK PER REGION, not one per crop. A merged crop rides one paid edit call but each of
      // its rectangles gets its own $0.005 probe — see studio/segment.ts for why merging the cheap
      // call is what produced the paired-garment bug.
      // WHY each region got no mask, filled in by masksForCrop as it goes. Indexed by region, so
      // an entry is the reason FOR the null at the same index — see MaskMiss.
      const maskMisses: (MaskMiss | null)[] = plan.regions.map(() => null);
      const masks = await masksForCrop({
        plan,
        cropBytes,
        signal: baseOpts.signal,
        jobId: ctx.jobId,
        onMiss: (i, reason) => {
          maskMisses[i] = reason;
        },
      });
      // The POLARITY rides with the patch and comes from the REGIONS, never from whether a mask
      // arrived — see studio/segment.ts polarityFor. A background edit that failed to get its
      // subject mask must reach pasteBack still declaring itself a background edit, or it is
      // indistinguishable from a garment edit with no mask and takes the rectangle, which is the
      // full re-render of her.
      patches.push({
        plan,
        patchBytes: patch.bytes,
        maskPolarity: polarityFor(plan.regions),
        // WHY each region has no mask, straight from the code that tried. Supersedes the
        // `maskAsked` boolean: that could separate "nothing named a noun" from everything else,
        // and this separates all four — including a THROW, which is the one that was reading as
        // "the feature is off" while sharp rejected an extract rectangle.
        maskMisses,
        // Passed even when every entry is null: an all-null array IS the identity case, and the
        // composite reads it as "no mask offered" exactly as an absent field.
        masks,
      });
      last = result;
      // ms PER CALL. The number the inline-safety argument needs and has never had — see the cap in
      // studio/config.ts, which is deliberately low until this log has said what p95 actually is.
      logger.info(
        {
          ...ctx,
          cropIndex,
          ms: Date.now() - startedOne,
          regions: plan.regions.length,
        },
        "masked edit crop complete",
      );
    } catch (err) {
      // ─── ONE CROP FAILING MUST NOT THROW AWAY THE CROPS THAT ALREADY SPENT ──────────────────
      //
      // This used to rethrow, and the arithmetic of that was bad in one direction only. The approval
      // is consumed BEFORE the first provider call (studio/previewStore.ts — it has to be, it is the
      // double-tap guard), so a failure on crop 4 of 4 meant three calls had billed, the job was
      // failed, nothing was saved, and the retry needed a FRESH approval at the FULL price. She paid
      // twice for the crops that worked the first time.
      //
      // So a failed crop is recorded and the loop continues. She gets the changes that landed and is
      // told, by name, which one did not — and the retry is a new preview for that one target, which
      // quotes one call rather than four. Nothing here can un-spend the failed call; what it can do
      // is stop that call from taking the successful ones down with it.
      failed.push(plan.regions[0]?.label ?? `area ${cropIndex + 1}`);
      reasons.push(err instanceof Error ? err.message : String(err));
      logger.warn(
        {
          ...ctx,
          cropIndex,
          ms: Date.now() - startedOne,
          // The MESSAGE, never the error object — a serialized provider error can carry request
          // content, and the request carries her photograph. Same rule costLog.safeRef keeps.
          error: err instanceof Error ? err.message : String(err),
        },
        "masked edit crop failed — keeping the crops that landed",
      );
    }
  }

  // NOTHING landed: there is no composite to make and nothing to hand back. This is the one case
  // that still fails the job, and it fails it having produced no asset — the same outcome as before.
  if (!patches.length) {
    // The REASON survives, not just the count. Every crop failing for the same cause is the common
    // shape (a provider returning urls, a model refusing the whole frame), and answering "none of
    // them worked" without saying why turns a diagnosable failure into a shrug. Deduped, because
    // three identical causes read as one fact rather than three.
    const why = [...new Set(reasons)].join("; ");
    throw new GenerationError(
      `None of the changes could be applied to your photo${why ? ` — ${why}` : ""}. Nothing was ` +
        "saved to your library. This is on us, not on the photo — try again.",
      "provider_error",
    );
  }

  const composited = await pasteBack(frame.bytes, patches);

  // ─── REGIONS THE COMPOSITE REFUSED, WHICH IS A FAILURE THE CROP LOOP CANNOT SEE ──────────────
  //
  // An inversion region whose subject mask is missing or untrustworthy is skipped by pasteBack
  // rather than pasted on its rectangle (the mask-type-dependent fallback rule, stated there). That
  // decision is made during the composite — after this function's per-crop try/catch has already
  // finished — so those targets have to be collected here or she is never told they did not change.
  //
  // maskVerdicts carries exactly one entry per region, in the plans' own order, including for the
  // regions that were skipped. That alignment is what lets a verdict name a target.
  const composedRegions = patches.flatMap((p) => p.plan.regions);
  composited.maskVerdicts.forEach((verdict, i) => {
    if (!verdict.startsWith("refused_")) return;
    const label = composedRegions[i]?.label ?? `area ${i + 1}`;
    failed.push(label);
    reasons.push(
      "we couldn't separate you from the background reliably enough to change it without redrawing you",
    );
  });

  // NOTHING was actually composited — every region refused. The output would be the original frame,
  // byte for byte, and handing that back as a finished edit is the silent failure this whole path
  // exists to prevent: she would be shown her own unchanged photograph as the thing she paid for.
  // `length` guarded because `every` on an empty array is vacuously true — a composite that
  // reported no verdicts at all would otherwise fail a job that actually succeeded.
  if (
    composited.maskVerdicts.length > 0 &&
    composited.maskVerdicts.every((v) => v.startsWith("refused_"))
  ) {
    throw new GenerationError(
      "We couldn't separate you from the background well enough to change it, and we won't redraw " +
        "you to get around that. Nothing was saved to your library — try a photo where you stand " +
        "clear of the background.",
      "provider_error",
    );
  }
  logger.info(
    {
      ...ctx,
      calls: crops.length,
      applied: patches.length,
      failed: failed.length,
      // The job's own wall-clock, against which maxEditCalls() is set. Read this before raising it.
      ms: Date.now() - startedAll,
      width: composited.width,
      height: composited.height,
      jpegQuality: composited.jpegQuality,
    },
    "masked edit composited — the original with only the marked regions changed",
  );

  // The LAST SUCCESSFUL call's envelope, carrying the composited pixels. Provider, model, task and
  // cost stay the router's own words; only the asset is ours. `cost` is one call's — the job's total
  // is the preview's quote, which scaled by the crop count before she approved it.
  return {
    ...last!,
    assets: [
      {
        bytes: composited.bytes,
        mimeType: composited.mimeType,
        width: composited.width,
        height: composited.height,
      },
    ],
    // Only when something actually failed, so a clean edit's envelope is byte-for-byte what it was.
    ...(failed.length ? { failedTargets: failed } : {}),
  };
}

/**
 * The source frame, upright, once per job.
 *
 * Same normalization `resolveStoredReference` does per reference, hoisted because the masked path
 * needs the BYTES to crop rather than a reference to hand over, and needs them once rather than
 * once per region. A failure REFUSES for the same reason it does there: sending rotated pixels
 * succeeds, bills, and comes back edited in the wrong place.
 */
async function uprightSourceBytes(
  brief: CreativeBrief,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const source = brief.job.source!;
  const fetched = await fetchReferenceBytes(source.ref);
  if (!needsOrienting(source.orientation)) {
    return {
      bytes: fetched.bytes,
      mimeType: fetched.contentType ?? "image/jpeg",
    };
  }
  try {
    const oriented = await orientToPixels(fetched.bytes, fetched.contentType);
    logger.info(
      { athleteId: brief.athlete.athleteId, orientation: source.orientation },
      "source frame normalized before cropping — the crop and the paste-back share one space",
    );
    return oriented;
  } catch (err) {
    logger.warn(
      {
        athleteId: brief.athlete.athleteId,
        orientation: source.orientation,
        error: err instanceof Error ? err.message : String(err),
      },
      "could not normalize the source frame — refusing rather than cropping rotated pixels",
    );
    throw new GenerationError(
      "We couldn't prepare this photo for editing. It's stored rotated, and we have to straighten " +
        "it before the edit or the change would land in the wrong place. Try another photo, or " +
        "re-upload this one.",
      "provider_error",
    );
  }
}

/**
 * Generate from an approved preview.
 *
 * The output lands in `draft`. This function NEVER approves anything and never touches a deck —
 * clearance is a human act that happens afterwards, through studio/approval.ts.
 */
/**
 * Which IMPLEMENTATION a path runs on — the dispatch decision, named so it can be tested.
 *
 * It was an inline ternary, and that is precisely why nothing could pin it: removing the whole
 * path branch left every test green. A decision worth threading a parameter for is a decision
 * worth being able to assert.
 *
 * ⚠️ MASKED AND BACKGROUND BOTH ANSWER TRUE, and that is not a special case: they are two rows of
 * ROUTE over one implementation. Both run `runMaskedEdit`, both crop, both composite; the only
 * difference is that a background region carries a `subjectNoun`, which `polarityFor` turns into
 * `maskPolarity: "preserve-inside"` and the composite inverts. See the note on ROUTE in
 * studio/classify.ts.
 *
 * WITH NO PATH IT DEDUCES FROM BRIEF SHAPE, exactly as this always did — which is what keeps every
 * existing caller byte-identical. A job that passes no path cannot tell this parameter was added.
 *
 * ─── A NATIVE EDIT ROUTES AROUND THE MASKED STACK, AND IT WINS OVER EVERYTHING ELSE HERE ───────
 *
 * `native` is true when the brief carries a frozen intent (studio/nativeEdit.ts) and STUDIO_NATIVE_EDIT
 * is on. It outranks both other inputs: a native brief still has its detection regions frozen on it,
 * so `hasCrops` says "croppable", and `path` may say MASKED or BACKGROUND — and neither may send a job
 * that was quoted as ONE full-frame call through a crop loop. The masked stack itself is not touched;
 * this is the only place a native job leaves it. Omitted, it is false, and the two-argument answer is
 * the one this function always gave.
 */
export function usesMaskedPath(
  path: EditPath | undefined,
  hasCrops: boolean,
  native = false,
): boolean {
  if (native) return false;
  if (!path) return hasCrops;
  return path === "MASKED" || path === "BACKGROUND";
}

export const NATIVE_EDIT_SWITCHED_OFF =
  "Edits changed how they run since your cost check, so that check no longer describes this job. " +
  "Check the cost again — nothing was spent.";

export async function runStudioGeneration(
  input: RunStudioGenerationInput,
  opts: PreviewOptions = {},
): Promise<StudioGeneration> {
  const { athleteId, brief, previewId, approvedCostUsd } = input;

  // ── 1. The verdict, re-derived from the stored brief. Not read off the stored row, and not taken
  //    on trust from the client: if the world moved between the check and the tap, this catches it.
  // ─── ASK REFUSES HERE, BEFORE ANYTHING IS SPENT, AND CARRIES ITS REASON ────────────────────
  //
  // ASK is not a path; it is the classifier declining to route. Reaching a provider with it would
  // mean spending on a request we already decided we could not read.
  //
  // ⚠️ THE REASON TRAVELS WITH IT, and that is the whole point of refusing here rather than with a
  // generic decline. `person_target` and `fast_path_declined` want DIFFERENT UI — one is "we won't
  // do that", the other is "which did you mean" — and the classifier already did the work of
  // telling them apart (studio/classify.ts). Collapsing them into one message at the dispatch
  // throws that work away at the last moment, and the guard's whole value is that it can say WHY.
  if (opts.path === "ASK") {
    throw new GenerationError(
      `Refusing to generate — the request was not routed: ${opts.askReason ?? "unspecified"}`,
      "invalid_input",
    );
  }

  // ─── FROZEN AS A NATIVE EDIT, SPENT AFTER THE FLAG WENT OFF — REFUSE, NEVER FALL BACK ─────────
  //
  // The quote she approved was one full-frame call at a frozen size. With STUDIO_NATIVE_EDIT off,
  // the only thing left to run is the masked stack — a different implementation at a different
  // price, and not what the flag being switched off means. So the job refuses here, before a job row
  // opens or the approval is claimed, and she re-checks against whatever is on now.
  const native = readNativeIntent(brief);
  if (native.kind !== "none" && !nativeEditEnabled()) {
    throw new GenerationError(NATIVE_EDIT_SWITCHED_OFF, "invalid_input");
  }

  const preview = previewGeneration(brief, opts);

  if (preview.status === "blocked" || !preview.plan) {
    throw new GenerationError(
      `Refusing to generate — ${preview.blockers.length} blocking gap(s): ` +
        preview.blockers.map((b) => `${b.field}: ${b.note}`).join(" | "),
      "invalid_input",
    );
  }

  // ⚠️  THE HOLD THAT USED TO SIT HERE IS NOW A SWITCH, AND THE CAPS BELOW SIT BEHIND IT.
  //
  //  `assertRunnableInline(preview.plan.task)` stood on this line and threw for `video.generate`
  //  unconditionally, so no clip ever reached the spend gate. The gate was deliberately built
  //  DOWNSTREAM of it, in studio/spendCaps.ts, and proven against a video quote there
  //  (spendCaps.test.ts) precisely so that removing the hold would not also remove the refusals.
  //
  //  V3 removed it, and the order held: every cap below is load-bearing for video without a line of
  //  it changing. What takes the hold's place is a FLAG rather than nothing — video is reachable
  //  only when STUDIO_VIDEO_ENABLED is on, so it stays dark on merge and is turned on per
  //  environment as a decision. With the flag off this throws here, above the row and above the
  //  approval; with it on, a clip is checked against the same approved figure, the same per-job
  //  ceiling and the same rolling day total as an image, and only then queued at 4a.
  assertVideoEnabled(preview.plan.task);

  // ── 2. The money checks, in the order of who they protect. The order, the comparisons and the
  //    refusal messages all live in studio/spendCaps.ts; this reads the four figures and calls it.
  //    `spentTodayUsd` is this athlete's rolling 24h total, and is the one that needs a query.
  //    The platform-wide day ceiling first (lib/platformSpend.ts): refused for everyone once today's total reaches it.
  if ((await platformBudget()).over) throw new GenerationError(PLATFORM_CAP_MESSAGE, "invalid_input");
  const caps = {
    approvedCostUsd,
    maxJobUsd: maxJobUsd(),
    maxDayUsd: maxDayUsd(),
    spentTodayUsd: await spentTodayUsd(athleteId),
  };
  let quotedUsd: number;
  try {
    quotedUsd = assertSpendWithinCaps(
      {
        task: preview.plan.task,
        model: preview.plan.model,
        unpriced: preview.unpriced,
        amountUsd: preview.cost ? preview.cost.amountUsd : null,
      },
      caps,
    );
  } catch (err) {
    // Logged HERE rather than in the gate, which is deliberately pure: this is the layer that knows
    // which athlete and which preview it was. The quote is a figure we produced, never her words.
    logger.warn(
      {
        athleteId,
        previewId,
        task: preview.plan.task,
        model: preview.plan.model,
        unpriced: preview.unpriced,
        quotedUsd: preview.cost?.amountUsd ?? null,
        ...caps,
      },
      "job refused by the spend gate",
    );
    throw err;
  }

  // ── 3. Open the job. createGenerationJob refuses a blocked preview too — a third re-check of the
  //    same gate, on the write side.
  const job = await createGenerationJob(preview);

  // ── 4. Claim the approval. THE LAST THING BEFORE ANYTHING BILLABLE.
  const claim = await consumePreview(athleteId, previewId, job.id);
  if (!claim.claimed) {
    // Another tap already bought this. Cancel the row we just opened — it is a real thing that
    // happened and it stays in the record, but it is `canceled`, was never claimed, and never
    // reached the router — and answer with the WINNER's job so both taps agree.
    await cancelJob(job.id, athleteId);
    const winner = claim.jobId ?? job.id;
    logger.info(
      { athleteId, previewId, orphanJobId: job.id, winnerJobId: winner },
      "duplicate generate — no second spend",
    );
    return {
      jobId: winner,
      spent: false,
      preview,
      assets: await assetsFor(winner, athleteId),
    };
  }

  // ── 4a. THE FORK. Video stops here and is handed to a runner; images carry straight on.
  //
  // Note WHERE this sits: after the approval is consumed, and before any provider call. That is not
  // an accident of ordering, it is the invariant. The approval is claimed exactly once, by the one
  // actor there is only one of — this request — so a runner picking the job up later, or a second
  // runner picking it up after a lease handoff, has nothing left to claim and cannot re-spend it.
  // The runner's own hazard is different (don't call the provider twice) and has its own guard, the
  // submit-once pair in studio/videoJobs.ts. Neither guard stands in for the other.
  if (!runsInline(preview.plan.task)) {
    if (!(await queueJob(job.id, athleteId))) {
      throw new GenerationError(
        `Job ${job.id} could not be queued — it was not pending`,
        "invalid_input",
      );
    }
    // `quotedUsd` rather than `preview.cost.amountUsd`: it is the figure the caps above actually
    // checked, and it is non-null by the time we are here because the gate throws when it is not.
    logger.info(
      {
        jobId: job.id,
        athleteId,
        previewId,
        model: preview.plan.model,
        quotedUsd,
      },
      "video generation queued — the runner takes it from here",
    );
    // No assets yet, by construction: nothing has been generated. The caller polls the job.
    return { jobId: job.id, spent: true, queued: true, preview, assets: [] };
  }

  if (!(await claimJob(job.id, athleteId))) {
    throw new GenerationError(
      `Job ${job.id} could not be claimed — it was not pending`,
      "invalid_input",
    );
  }

  // ── 5. Run it.
  const assets: StudioGeneration["assets"] = [];
  const crops = editCropsFor(brief);
  /** What a native edit actually returned, measured — for the record and the closing log line. */
  let nativeOutput: { width: number; height: number } | null = null;
  // Hoisted out of the try so the partial-failure report survives to the return below.
  let result: GenerationResult;
  try {
    const baseOpts: PreviewOptions = {
      resolveReference: (r) => resolveStoredReference(r, brief),
      ...opts,
      // Paths only — never the signed urls resolveStoredReference mints, whose query string IS the
      // credential (the rule costLog.safeRef exists to keep).
      refIds: opts.refIds ?? preview.references.map((r) => r.ref),
      // The join keys (PR 11). A generate has no edit row; the prompt version is the interpreter's
      // when it proposed this job, and null on every other brief.
      attribution: {
        jobId: job.id,
        previewId,
        editPreviewId: null,
        batchId: null,
        promptVersion: brief.job.interpretation?.promptVersion ?? null,
        assetId: null,
      },
    };

    // ─── THE PATH IS CHOSEN, NOT DEDUCED ───────────────────────────────────────────────────────
    //
    // This read `crops?.length ? runMaskedEdit : runGeneration`, which meant the whole-frame
    // re-render was never a decision anyone made — it was what happened when `editCropsFor` came
    // back empty. That is indistinguishable from a chosen full-image job right up until the moment
    // the two disagree, and a path that can only be inferred cannot be tested, logged or changed
    // by a table.
    //
    // `plannedInputs` has already dropped the crops for a path that does not want them, so the
    // fallback below is not a second opinion — with no path given, `crops` is exactly what it has
    // always been and this line behaves exactly as it always did.
    //
    // A NATIVE brief goes to `runGeneration` — the same single call, now planned by plannedInputs as
    // the whole frame, the compiled instruction and the frozen size (studio/preview.ts).
    const masked = usesMaskedPath(
      opts.path,
      Boolean(crops?.length),
      native.kind === "native",
    );
    result =
      masked && crops?.length
        ? await runMaskedEdit(brief, crops, baseOpts, {
            athleteId,
            jobId: job.id,
          })
        : await runGeneration(brief, baseOpts);

    // A native output too large for the store is re-encoded HERE, before the shape guard, the
    // measurement and the store read it — so all three see the bytes that will actually be kept.
    // Native only: the composite already encodes its own output to fit (studio/composite.ts).
    if (native.kind === "native") {
      const ctx = { athleteId, jobId: job.id };
      result = {
        ...result,
        assets: await Promise.all(
          result.assets.map((a) => fitNativeOutputToStore(a, ctx)),
        ),
      };
    }

    for (const [i, asset] of result.assets.entries()) {
      // The return leg of the orientation round trip. Checked BEFORE anything is written, so a
      // sideways result never reaches her library at all.
      //
      // ON THE MASKED PATH THIS IS NOW A TAUTOLOGY, AND IT STAYS ANYWAY. The composite pastes into
      // the original, so the output has the source's dimensions by construction and the drift guard
      // cannot fail. That is not a reason to delete it: it costs one header parse, and it is the
      // assertion that would catch a future refactor which stopped compositing and started returning
      // the model's own frame — which is precisely the regression that would be invisible otherwise.
      // The composite path additionally demands EXACT equality below, which is a stronger claim than
      // the 15% drift this allows.
      //
      // ⚠️ THE EXACTNESS CLAIM BELONGS TO THE JOB THAT COMPOSITED, not to a brief that happens to have
      // crops. A native brief keeps its detection regions, so `crops` is non-empty on it, and a
      // native output is the model's own canvas — 3392x5056 from a 4000x6000 frame at 4K — which
      // this assertion would refuse every time. Keyed on `masked`, which is `crops?.length` exactly
      // for every job that passes no native intent.
      if (preview.plan.task === "image.edit" && brief.job.source) {
        assertEditKeptItsShape(asset, brief.job.source, {
          athleteId,
          jobId: job.id,
        });
        if (masked && crops?.length)
          assertCompositeIsTheOriginal(asset, brief.job.source, {
            athleteId,
            jobId: job.id,
          });
      }
      // ─── A NATIVE OUTPUT IS RECORDED AT THE SIZE IT CAME BACK (PR N, N.3) ─────────────────────
      //
      // The adapter stamps `width`/`height` from the REQUEST, which for an edit names none — so a
      // whole-frame output landed with null dimensions, and a 4K canvas returned for a 24 MP photo
      // would have been invisible on the record. Measured from the bytes, with the parser the shape
      // guard above uses. Native only: a composite already reports the source's own frame, and
      // every other path is recorded exactly as it was.
      const measured =
        native.kind === "native" && asset.bytes
          ? parseImageSize(asset.bytes)
          : null;
      if (measured && !nativeOutput) {
        nativeOutput = { width: measured.width, height: measured.height };
      }
      const stored = await storeAsset(
        asset,
        studioObjectBase(athleteId, job.id, i),
      );
      const row = await recordGeneratedAsset({
        athleteId,
        jobId: job.id,
        gcsPath: stored.gcs_path,
        contentType: stored.content_type,
        mediaType: asset.mimeType.startsWith("video/") ? "VIDEO" : "IMAGE",
        width: measured?.width ?? asset.width ?? null,
        height: measured?.height ?? asset.height ?? null,
        bytes: stored.bytes,
        // The pixels we already hold, so the thumbnail costs no second download of what we just
        // uploaded. Absent for a rehosted-from-url asset, which reads the object back instead.
        bytes_buffer: asset.bytes,
        durationSeconds: asset.durationSeconds ?? null,
        // Provenance. `edit` is the only mode with a frame to stay continuous with, and it now
        // reaches here — so the link is recorded rather than dropped. The id is the one off the
        // STORED brief, which the route already resolved from a row it proved was hers; `generate`
        // has no source at all and stays null.
        derivedFromAssetId: brief.job.source?.mediaAssetId ?? null,
      });
      assets.push({
        id: row.id,
        gcsPath: row.gcs_path,
        approvalStatus: row.approval_status,
      });

      // ─── CREATIVE QA — OBSERVATION ONLY, AND PERMANENTLY SO ────────────────────────────────
      //
      // Behind STUDIO_CREATIVE_QA, default off. It reads the stored asset and the root of its
      // edit chain, writes a verdict to `media_assets.metadata.creative_qa`, and RETURNS NOTHING
      // ANYONE READS. That is this call site's contract, not a stage it is passing through:
      //
      //   * the return value is discarded, so no verdict can reach `assets`, the job row or the
      //     response;
      //   * `inspectAsset` never throws — timeout-bounded, every failure swallowed — so a
      //     generation cannot fail because an inspection did;
      //   * nothing here blocks, retries, or downgrades an approval.
      //
      // Enforcement (block / auto-retry / warn) is a later flag at a DIFFERENT call site, and
      // deliberately not an evolution of this line: a gate belongs where the decision to hand her
      // the image is made, and a measurement that quietly grew teeth is how a stage nobody has
      // watched run ends up rejecting her work.
      //
      // Awaited rather than fired and forgotten: the verdict must be on the record by the time
      // the asset is, or a client can read a row whose QA has not landed — and a floating promise
      // would outlive the request on Cloud Run. ~4s on a ~25s generation; with the flag off it
      // costs one boolean.
      if (creativeQaEnabled()) {
        // On a job the interpreter proposed, which marks the edit asked to bring in or take away, and
        // who asked (N7) — so an ad's swapped-away Nike reads as the brand's request, not as vanished.
        // Absent on every other job, which QA judges exactly as before.
        const provenance = markProvenanceFor(brief.job.interpretation);
        // What this edit added AT A PLACE, off the frozen intent — the compile tier's own predicate,
        // the one the prompt's framing line fires on (compile/templates.ts, `placedAdds`). Empty on
        // every other job, and then the framing observation measures nothing (wave B, addition (a)).
        const placed =
          native.kind === "native" ? placedAdds(native.intent.changes) : [];
        await inspectAsset(row.id, athleteId, {
          instruction: brief.job.direction.statement,
          ...(provenance ? { provenance } : {}),
          ...(placed.length ? { placedAdds: placed } : {}),
        });
      }

      // ─── THE OUTPUT GATE (quality-scrappy piece 5), opt-in STUDIO_OUTPUT_GATE ───────────────────
      //
      // The later flag and the different call site the note above asks for: after the inspection has written, before
      // the answer is built, so the generate response carries the gate on the asset (routes/studio.ts `withGates`).
      // It marks the OUTPUT failed on a name or handle she did not ask for — never the job, and never a retry.
      if (outputGateEnabled())
        await recordGate(
          row.id,
          athleteId,
          "image",
          templateOf(brief, plannedInputs(brief, {}).templateKey),
        );

      // ─── THE TEMPLATE'S SCORE (quality-scrappy piece 10), STUDIO_PROMPT_REGISTRY ──────────────────────────────
      //
      // LAST: it reads what QA and the gate wrote. Observation only, on the asset and one log line per output by
      // template key and version — never the frozen brief, never anything she sees. recordScore never throws.
      if (promptRegistryEnabled())
        await recordScore(
          row.id,
          athleteId,
          "image",
          brief.job.mode,
          templateOf(brief, plannedInputs(brief, {}).templateKey),
        );
    }

    await succeedJob(job.id, athleteId, result.cost.amountUsd);
  } catch (err) {
    // The job row tells the truth, and the approval STAYS consumed: a spend may well have happened,
    // and a re-run is a new check and a new cost line — never a silent retry against the same
    // approval. Same rule studio/jobs.ts states for jobs.
    await failJob(
      job.id,
      athleteId,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  logger.info(
    {
      jobId: job.id,
      athleteId,
      previewId,
      assets: assets.length,
      quotedUsd,
      failedTargets: result.failedTargets?.length ?? 0,
      // The resolution record, side by side in the line that closes the job: the tier she was
      // quoted, the frame she gave, and the canvas that came back (PR N, N.3).
      ...(native.kind === "native"
        ? {
            native: {
              imageSize: native.intent.imageSize,
              sourceW: brief.job.source?.width ?? null,
              sourceH: brief.job.source?.height ?? null,
              outW: nativeOutput?.width ?? null,
              outH: nativeOutput?.height ?? null,
            },
          }
        : {}),
    },
    "studio generation complete — awaiting approval",
  );
  // A PARTIAL success is still a success and still returns her asset — it just does not pretend the
  // whole instruction was carried out. The route turns these into a line she can read.
  return {
    jobId: job.id,
    spent: true,
    preview,
    assets,
    failedTargets: result.failedTargets,
  };
}

/**
 * The draft rows a job produced, for the duplicate-tap answer.
 *
 * May legitimately be EMPTY: the winner can still be mid-run when the loser returns. That is not an
 * error — it is why the response carries `spent: false`, so the caller knows to watch the job rather
 * than conclude nothing was made.
 */
async function assetsFor(jobId: string, athleteId: string) {
  const rows = await assetsForJob(jobId, athleteId);
  return rows.map((r) => ({
    id: r.id,
    gcsPath: r.gcs_path,
    approvalStatus: r.approval_status,
  }));
}

/** One job, under the authenticated athlete. Null when it is not hers — never a different answer. */
export async function readJob(athleteId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ?? null;
}
