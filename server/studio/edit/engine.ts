/**
 * studio/edit/engine — quote, run, accept, discard: one typed edit op on one of her photos (PR 9, Lane 1).
 *
 * ─── GROUND RULE 06, AS FOUR STEPS ──────────────────────────────────────────────────────────────────────
 *
 *   quote    the op becomes a sentence (ops.ts), the source passes the gate (source.ts), the frame is
 *            measured, detection finds the region, the freeze fixes the intent, and previewGeneration
 *            PRICES it — the same quote machine every generation uses (a studio_generation_previews row,
 *            30-minute ttl). A studio_edit_previews row records the op under that quote. $0 beyond the
 *            detection call, which is what every sentence-derived edit already spends.
 *   run      spends, once: the quote is loaded under her id, re-priced, checked against her approval and
 *            the house caps, consumed (compare-and-set), the one image.edit call made, and the result
 *            written UNDER studio/edit-previews/ — not her library. ⚠️ MUTATION (engine.test): call the
 *            router without `consumePreview` / the cap check — "quote skipped" reds by name.
 *   accept   the ONE library write: the bytes are copied to a studio object path and recorded through
 *            `recordGeneratedAsset` — origin 'generated', derived_from_asset_id = the source, its own job.
 *            ⚠️ MUTATION: record the asset at run time — "preview written to library without accept" reds.
 *            ⚠️ MUTATION: insert the row with origin 'upload' — "edited asset claims camera provenance"
 *            reds. There is no camera column; origin IS the camera claim (studio/agent/provenance.ts),
 *            and an edited photo is not verifiable camera any more — it is made-here to the cast gates,
 *            and needs her pick on an own-footage brief. That is the law's intent (Adi, 23 Sep 2026).
 *   discard  the object is deleted and the row says so. Nothing was ever in her library.
 *
 * ─── THE LAW AT THE ENGINE: image.edit, WITH A SOURCE, OR NOTHING ──────────────────────────────────────
 *
 * The brief is assembled in mode "edit" with the verified source, the intent is frozen from OUR sentence,
 * and `run` refuses anything whose planned task is not image.edit before the router is touched. A refused
 * freeze is a refusal — never a re-plan as a generate. ⚠️ MUTATION (engine.test): on a refused freeze, plan
 * a generate with the frame as a likeness reference — "edit falls through to from-scratch generate" reds.
 */
import sharp from "sharp";
import { createLogger } from "../../logger";
import {
  deleteObject,
  readObject,
  saveBuffer,
  signedUrl,
} from "../../lib/mediaStore";
import type { StudioEditPreview } from "../../../shared/schema";
import { detectRegionsMemoized, probeBytesFor } from "../autoMask";
import {
  assembleBrief,
  type BriefInput,
  type CreativeBrief,
  type JobReference,
  type SourceAsset,
} from "../brief";
import { route } from "../classify";
import {
  maxDayUsd,
  maxJobUsd,
  nativeEditEnabled,
  styleSpecEnabled,
} from "../config";
import { STYLE_REFUSAL_COPY } from "../reference/styleSpec";
import { resolveStyleReference } from "../reference/styleStore";
import {
  resolveStoredReference,
  storeAsset,
  studioObjectBase,
} from "../generate";
import { mapRegions, NATIVE_REGION_MIN_PX } from "../geometry";
import { parseImageSize, probeImageSize } from "../imageSize";
import {
  cancelJob,
  claimJob,
  createGenerationJob,
  failJob,
  recordGeneratedAsset,
  spentTodayUsd,
  succeedJob,
} from "../jobs";
import { readNativeIntent } from "../nativeEdit";
import { attachedIn, withNativeEditIntent } from "../nativeIntent";
import {
  plannedInputs,
  previewGeneration,
  type GenerationPreview,
} from "../preview";
import {
  approvalRefusal,
  consumePreview,
  loadPreview,
  savePreview,
} from "../previewStore";
import { generate } from "../router";
import { assertSpendWithinCaps } from "../spendCaps";
import { GenerationError, type GeneratedAsset, type ImageRef } from "../types";
import { PLATFORM_CAP_MESSAGE, platformBudget } from "../../lib/platformSpend";
import {
  OPS_PROMPT_VERSION,
  opRefusal,
  parseOp,
  planOp,
  type OpPlan,
  type StudioEditOp,
} from "./ops";
import {
  advance,
  editPreviewObjectBase,
  insertEditPreview,
  isEditPreviewExpired,
  readEditPreview,
} from "./previews";
import { SOURCE_REFUSAL_COPY, verifiedSource } from "./source";
import { observeInBackground } from "./identityOnAccept";

const logger = createLogger("studio/edit/engine");

/** The style spec a job carries, or null. */
const styleOf = (refs: readonly JobReference[] | undefined) =>
  (refs ?? []).find((r) => r.role === "style_reference")?.style ?? null;

/** The output may not drift from the source's aspect by more than this (generate.ts's own bound). */
const MAX_EDIT_ASPECT_DRIFT = 0.15;
/** mediaStore's cap for a still; a native output over it is re-encoded (generate.ts's ladder, shortened). */
const STORE_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 25 * 1024 * 1024);
const JPEG_LADDER = [
  { quality: 95 },
  { quality: 90 },
  { quality: 85 },
] as const;

export interface QuoteEditInput {
  athleteId: string;
  sourceAssetId: string;
  op: unknown;
  params: unknown;
  brandId?: number | null;
  batchId?: string | null;
  /**
   * Batch metadata the row carries beside its params (studio/edit/batch.ts): `role: "intermediate"`,
   * `stage: "B"`, `after: <row id>`. Merged after validation, never read by the op — a param the door
   * would refuse cannot arrive this way, since the op's own params are parsed first.
   */
  meta?: Record<string, unknown>;
  /**
   * One of her already-read references, as a style MODIFIER on this op (PR 18, ADI-GO18 G2). The route accepts
   * it only with STUDIO_STYLE_SPEC on. Resolved here under her id; unread is refused (R-8, G8).
   */
  styleAssetId?: string | null;
}

export interface EditQuote {
  row: StudioEditPreview;
  /** What she is shown: the price, the sentence the op became, and anything the op changed about the ask. */
  quote: {
    costUsd: number | null;
    unpriced: boolean;
    sentence: string;
    warnings: string[];
    expiresAt: string;
  };
}

export type EditRefusal = {
  ok: false;
  status: 400 | 404 | 409 | 422;
  error: string;
  field?: string;
};

const refuse = (
  status: EditRefusal["status"],
  error: string,
  field?: string,
): EditRefusal => ({
  ok: false,
  status,
  error,
  ...(field ? { field } : {}),
});

/**
 * The warnings an edit quote shows: the op's own notes and the native preview's — never the brief's
 * generic gaps. A brief assembled for an edit reports what a GENERATION would miss ("No brand on this job,
 * so nothing is tailored to a partner's tone…", "No first-class aesthetic…"); on a recolour those lines
 * mean nothing and read as faults. `previewGeneration` folds `brief.gaps` (severity degraded) into its
 * warnings ahead of the native notes, so the gaps are taken out BY IDENTITY of their note, and everything
 * else the preview said (a resolution note, an invented object, a dropped word, a look covering her) stays.
 * ⚠️ MUTATION (engine.test): return preview.warnings whole — "recolour quote carries a brief-gap warning"
 * reds by name.
 */
export function editWarnings(
  brief: { gaps: { note: string }[] },
  preview: { warnings: { note: string }[] },
): string[] {
  const gaps = new Set(brief.gaps.map((g) => g.note));
  return preview.warnings.filter((w) => !gaps.has(w.note)).map((w) => w.note);
}

// ─── quote ──────────────────────────────────────────────────────────────────────────────────────────────

/** The measured frame plus the region detection found for a region-bound op — the route's own steps. */
async function measuredSource(
  athleteId: string,
  source: { id: string; gcsPath: string },
  plan: OpPlan,
): Promise<{ ok: true; source: SourceAsset } | EditRefusal> {
  const frame = await probeImageSize(source.gcsPath);
  if (!frame) {
    return refuse(
      422,
      "We couldn't read this photo's dimensions, so we can't place an edit on it accurately.",
      "sourceAssetId",
    );
  }
  if (plan.regions === "region-free") {
    return {
      ok: true,
      source: {
        mediaAssetId: source.id,
        ref: source.gcsPath,
        width: frame.width,
        height: frame.height,
        orientation: frame.orientation,
        editRegions: [],
      },
    };
  }
  const found = await detectRegionsMemoized(
    { athleteId, sourceAssetId: source.id, instruction: plan.sentence },
    async () => {
      const probe = await probeBytesFor(source.gcsPath);
      return probe
        ? {
            frameBytes: probe.bytes,
            mimeType: probe.mimeType,
            instruction: plan.sentence,
          }
        : null;
    },
  );
  if (!found.ok) return refuse(422, found.message, "op");
  if (!found.regions.length) {
    return refuse(
      422,
      "We couldn't find that in this photo, so there is nothing to change.",
      "op",
    );
  }
  const mapped = mapRegions(found.regions, frame, {
    minRegionPx: NATIVE_REGION_MIN_PX,
  });
  if ("message" in mapped) return refuse(422, mapped.message, "op");
  return {
    ok: true,
    source: {
      mediaAssetId: source.id,
      ref: source.gcsPath,
      width: frame.width,
      height: frame.height,
      orientation: frame.orientation,
      editRegions: mapped.regions,
    },
  };
}

export async function quoteEdit(
  input: QuoteEditInput,
): Promise<({ ok: true } & EditQuote) | EditRefusal> {
  const parsed = parseOp(input.op, input.params);
  if (!parsed.ok) return refuse(400, parsed.error, "params");
  const off = opRefusal(parsed.op);
  if (off) return refuse(409, off, "op");
  const styled = !!input.styleAssetId;
  if (styled && !styleSpecEnabled())
    return refuse(400, "unknown field", "styleAssetId");
  const plan = planOp(parsed.op, parsed.params, { style: styled });
  if (plan.refusal) return refuse(422, plan.refusal, "params");

  // The source, through the gate — and the product photo through the same gate: it is a reference
  // with, possibly, a person in it, and the casting law reads references too.
  const src = await verifiedSource(input.athleteId, input.sourceAssetId);
  if (!src.ok)
    return refuse(
      src.reason === "source_not_found" ? 404 : 422,
      SOURCE_REFUSAL_COPY[src.reason],
      "sourceAssetId",
    );
  const references: JobReference[] = [];
  if (plan.productAssetId) {
    const product = await verifiedSource(input.athleteId, plan.productAssetId);
    if (!product.ok) {
      return refuse(
        product.reason === "source_not_found" ? 404 : 422,
        SOURCE_REFUSAL_COPY[product.reason],
        "productAssetId",
      );
    }
    references.push({
      role: "product",
      ref: product.source.gcsPath,
      mediaAssetId: product.source.id,
    });
  }
  // The style reference: her image's newest style READING, derived into a spec and frozen onto the brief below.
  // No model call (ADI-GO18 G1). Its image is never planned or sent (studio/preview.ts PLANNED_ROLE, R-8).
  if (styled) {
    const style = await resolveStyleReference(
      input.athleteId,
      input.styleAssetId!,
    );
    if (!style.ok)
      return refuse(
        style.reason === "style_not_found" ? 404 : 422,
        STYLE_REFUSAL_COPY[style.reason],
        "styleAssetId",
      );
    references.push(style.reference);
  }

  // OUR sentence, through the rules. Anything but a routed edit is a refusal here — never an ask handed
  // on, never a generate.
  const routed = route(plan.sentence, true, attachedIn(references));
  if (
    routed.initialPath === "ASK" ||
    routed.steps.some((s) => s.op === "GENERATE")
  ) {
    logger.warn(
      {
        athleteId: input.athleteId,
        op: plan.op,
        reason: routed.reason ?? null,
      },
      "edit op's sentence did not route as an edit — refused",
    );
    return refuse(
      422,
      "That edit can't be read as a change to this photo.",
      "op",
    );
  }

  const measured = await measuredSource(input.athleteId, src.source, plan);
  if (!measured.ok) return measured;

  const briefInput: BriefInput = {
    athleteId: input.athleteId,
    brandId: input.brandId ?? null,
    origin: "system",
    objective: "showcase-product",
    deliverable: plan.op === "ad" ? "ad" : "post",
    mode: "edit",
    source: measured.source,
    direction: plan.sentence,
    references,
  };
  const assembled = await assembleBrief(briefInput);
  const brief = withNativeEditIntent(assembled, briefInput, {
    regions: plan.regions,
    constraints: plan.constraints,
  });
  const preview = previewGeneration(brief);
  if (preview.status === "blocked" || !preview.plan) {
    const why = preview.blockers.map((b) => b.note).join(" ");
    return refuse(422, why || "This edit can't run on that photo.", "op");
  }
  if (preview.plan.task !== "image.edit") {
    // Unreachable by construction (mode "edit" + a source), and asserted anyway: it is the law.
    throw new GenerationError(
      `An edit op planned ${preview.plan.task}; only image.edit may run here`,
      "invalid_input",
    );
  }

  const previewId = await savePreview(input.athleteId, preview);
  const row = await insertEditPreview({
    athleteId: input.athleteId,
    sourceAssetId: src.source.id,
    op: plan.op,
    // The sentence and the CAMPAIGN block ride on the row: the run re-checks the sentence, and appends
    // the block to the prompt as data. Nothing else in params is read back by the run.
    params: {
      ...(parsed.params as Record<string, unknown>),
      sentence: plan.sentence,
      ...(plan.campaignBlock ? { campaignBlock: plan.campaignBlock } : {}),
      // Provenance only: the spec itself is frozen on the preview's brief, and the run reads it from there.
      ...(styleOf(references)
        ? {
            style: {
              assetId: styleOf(references)!.sourceAssetId,
              analysisId: styleOf(references)!.analysisId,
              version: styleOf(references)!.version,
            },
          }
        : {}),
      ...(input.meta ?? {}),
    },
    previewId,
    costQuotedUsd: preview.cost?.amountUsd ?? null,
    batchId: input.batchId ?? null,
  });
  logger.info(
    {
      athleteId: input.athleteId,
      editPreviewId: row.id,
      previewId,
      op: plan.op,
      quotedUsd: preview.cost?.amountUsd ?? null,
      unpriced: preview.unpriced,
    },
    "edit op quoted",
  );
  return {
    ok: true,
    row,
    quote: {
      costUsd: preview.cost?.amountUsd ?? null,
      unpriced: preview.unpriced,
      sentence: plan.sentence,
      warnings: [...plan.notes, ...editWarnings(brief, preview)],
      expiresAt: row.expires_at.toISOString(),
    },
  };
}

// ─── run ────────────────────────────────────────────────────────────────────────────────────────────────

/** generate.ts's fit-to-store, shortened: a native output over the cap is stored as the best JPEG that fits. */
async function fitToStore(asset: GeneratedAsset): Promise<GeneratedAsset> {
  if (!asset.bytes || asset.bytes.length <= STORE_MAX_BYTES) return asset;
  let smallest: Buffer | null = null;
  for (const rung of JPEG_LADDER) {
    const bytes = await sharp(asset.bytes).jpeg(rung).toBuffer();
    smallest = bytes;
    if (bytes.length <= STORE_MAX_BYTES)
      return { ...asset, bytes, mimeType: "image/jpeg" };
  }
  return smallest
    ? { ...asset, bytes: smallest, mimeType: "image/jpeg" }
    : asset;
}

/** The return leg of the shape guard: an edit keeps the frame's aspect, or it did not edit the frame. */
function assertKeptItsShape(
  asset: GeneratedAsset,
  source: SourceAsset,
): { width: number; height: number } {
  const size = asset.bytes ? parseImageSize(asset.bytes) : null;
  if (!size)
    throw new GenerationError(
      "The edit came back without readable dimensions",
      "provider_error",
    );
  if (source.width && source.height) {
    const drift =
      Math.abs(size.width / size.height - source.width / source.height) /
      (source.width / source.height);
    if (drift > MAX_EDIT_ASPECT_DRIFT) {
      throw new GenerationError(
        `The edit came back ${size.width}x${size.height} for a ${source.width}x${source.height} photo — it did not keep the frame`,
        "provider_error",
      );
    }
  }
  return { width: size.width, height: size.height };
}

/**
 * A run's source, when it is not the row's own photo: the ad carousel's stage B reads its stage-A
 * intermediate (an object under edit-previews/) as the frame, while the row keeps the ORIGINAL reference as
 * its source — so derived_from at accept names the original. Only studio/edit/batch.ts passes one.
 */
export interface SourceOverride {
  ref: string;
  width: number;
  height: number;
}

interface RunPrepared {
  row: StudioEditPreview;
  brief: CreativeBrief;
  preview: GenerationPreview;
  approvedCostUsd: number;
}

/**
 * Everything a run checks BEFORE anything is claimed or spent — the quote under her id, its freshness, the
 * recheck of our sentence, the re-price, her approval and the house caps. Shared by the inline run and the
 * batch tick, so the two doors cannot check different things.
 */
export async function prepareRun(
  athleteId: string,
  id: string,
): Promise<{ ok: true; prepared: RunPrepared } | EditRefusal> {
  const row = await readEditPreview(athleteId, id);
  if (!row) return refuse(404, "We couldn't find that edit.");
  if (row.status !== "quoted")
    return refuse(409, `This edit is ${row.status}; only a quoted edit runs.`);
  if (isEditPreviewExpired(row))
    return refuse(409, "This quote has expired — check the cost again.");
  if (!row.preview_id)
    return refuse(409, "This edit's quote is gone — check the cost again.");
  if (!nativeEditEnabled())
    return refuse(409, "Editing is switched off right now.");

  const stored = await loadPreview(athleteId, row.preview_id);
  if (!stored)
    return refuse(409, "This edit's quote is gone — check the cost again.");
  const stale = approvalRefusal(stored);
  if (stale) return refuse(409, stale);

  const brief = stored.brief;
  if (
    brief.job.mode !== "edit" ||
    !brief.job.source ||
    readNativeIntent(brief).kind !== "native"
  ) {
    return refuse(
      409,
      "This quote is not an edit of a photo, so it does not run here.",
    );
  }
  // The recheck: OUR sentence (on the row) still routes as an edit under today's rules.
  const sentence = (row.params as { sentence?: string } | null)?.sentence ?? "";
  const recheck = route(sentence, true, attachedIn(brief.job.references));
  if (
    recheck.initialPath === "ASK" ||
    recheck.steps.some((s) => s.op === "GENERATE")
  ) {
    return refuse(
      409,
      "This edit no longer reads as a change to the photo — check the cost again.",
    );
  }

  const preview: GenerationPreview = previewGeneration(brief);
  if (preview.status === "blocked" || !preview.plan) {
    return refuse(
      409,
      `This edit can't run: ${preview.blockers.map((b) => b.note).join(" ")}`,
    );
  }
  if (preview.plan.task !== "image.edit") {
    throw new GenerationError(
      `An edit op planned ${preview.plan.task}; only image.edit may run here`,
      "invalid_input",
    );
  }

  // The platform-wide day ceiling first (lib/platformSpend.ts): refused for everyone once today's total reaches it.
  if ((await platformBudget()).over) throw new GenerationError(PLATFORM_CAP_MESSAGE, "invalid_input");
  // Her approval and the house caps — the same gate runStudioGeneration keeps.
  assertSpendWithinCaps(
    {
      task: preview.plan.task,
      model: preview.plan.model,
      unpriced: preview.unpriced,
      amountUsd: preview.cost ? preview.cost.amountUsd : null,
    },
    {
      approvedCostUsd: stored.approvedCostUsd ?? 0,
      maxJobUsd: maxJobUsd(),
      maxDayUsd: maxDayUsd(),
      spentTodayUsd: await spentTodayUsd(athleteId),
    },
  );
  return {
    ok: true,
    prepared: {
      row,
      brief,
      preview,
      approvedCostUsd: stored.approvedCostUsd ?? 0,
    },
  };
}

/**
 * The one paid call and its aftermath, on a row already `running` under a claimed job. Success moves the
 * row to `ready` with the bytes under edit-previews/; failure moves it to `failed` and fails the job. Never
 * writes media_assets. `sourceOverride` swaps the frame the model sees (the batch's stage B), nothing else.
 */
export async function executeEdit(
  athleteId: string,
  row: StudioEditPreview,
  brief: CreativeBrief,
  job: { id: string },
  opts: { signal?: AbortSignal; sourceOverride?: SourceOverride } = {},
): Promise<{ ok: true; row: StudioEditPreview; url: string }> {
  const id = row.id;
  try {
    const effective: CreativeBrief =
      opts.sourceOverride && brief.job.source
        ? {
            ...brief,
            job: {
              ...brief.job,
              source: {
                ...brief.job.source,
                ref: opts.sourceOverride.ref,
                width: opts.sourceOverride.width,
                height: opts.sourceOverride.height,
                orientation: 1,
              },
            },
          }
        : brief;
    const { inputs, references, providerParams } = plannedInputs(effective);
    const resolved = await Promise.all(
      references.map(
        async (r): Promise<ImageRef> => ({
          ...(await resolveStoredReference(r, effective)),
          slot: r.slot,
          label: r.label,
        }),
      ),
    );
    const campaignBlock =
      (row.params as { campaignBlock?: string } | null)?.campaignBlock ?? null;
    const prompt = campaignBlock
      ? `${inputs.prompt}\n\n${campaignBlock}`
      : inputs.prompt;
    const result = await generate(
      "image.edit",
      { ...inputs, prompt, references: resolved },
      {
        providerParams,
        refIds: references.map((r) => r.ref),
        signal: opts.signal,
        // The join keys (PR 11). No asset yet — the media_assets row is born on accept — so the
        // join walks editPreviewId → accepted_asset_id rather than reading it off the line.
        attribution: {
          jobId: job.id,
          previewId: row.preview_id,
          editPreviewId: id,
          batchId: row.batch_id,
          // A styled edit says which derivation shaped it (R-C 9), so two runs stay comparable.
          promptVersion: styleOf(effective.job.references)
            ? `${OPS_PROMPT_VERSION}+${styleOf(effective.job.references)!.version}`
            : OPS_PROMPT_VERSION,
          assetId: null,
        },
      },
    );
    const first = result.assets[0];
    if (!first)
      throw new GenerationError(
        "The provider returned no image",
        "provider_error",
      );
    const asset = await fitToStore(first);
    const size = assertKeptItsShape(asset, effective.job.source!);
    const stored = await storeAsset(
      asset,
      editPreviewObjectBase(athleteId, id),
    );
    const moved = await advance(athleteId, id, "running", "ready", {
      job_id: job.id,
      gcs_path: stored.gcs_path,
      content_type: stored.content_type,
      bytes: stored.bytes,
      width: size.width,
      height: size.height,
      cost_usd: String(result.cost.amountUsd),
    });
    if (!moved)
      throw new GenerationError(
        "The edit's row moved under it",
        "invalid_input",
      );
    // The same figure the edit row holds (cost_usd above) — one number, two rows, byte-equal.
    await succeedJob(job.id, athleteId, result.cost.amountUsd);
    logger.info(
      {
        athleteId,
        editPreviewId: id,
        jobId: job.id,
        op: row.op,
        costUsd: result.cost.amountUsd,
        ...size,
      },
      "edit ran — the result is a preview, not a library row",
    );
    const after = (await readEditPreview(athleteId, id))!;
    return { ok: true, row: after, url: await signedUrl(stored.gcs_path) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(job.id, athleteId, message);
    await advance(athleteId, id, "running", "failed", {
      job_id: job.id,
      error: message,
    });
    logger.warn(
      { athleteId, editPreviewId: id, jobId: job.id, err },
      "edit run failed",
    );
    throw err;
  }
}

export async function runEdit(input: {
  athleteId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; row: StudioEditPreview; url: string } | EditRefusal> {
  const { athleteId, id } = input;
  const prep = await prepareRun(athleteId, id);
  if (!prep.ok) return prep;
  const { row, brief, preview } = prep.prepared;

  // Claim the row first, so a second caller does nothing; then the job; then the quote, once.
  if (
    !(await advance(athleteId, id, "quoted", "running", { ran_at: new Date() }))
  ) {
    return refuse(409, "This edit is already running.");
  }
  const job = await createGenerationJob(preview);
  const claim = await consumePreview(athleteId, row.preview_id!, job.id);
  if (!claim.claimed) {
    await cancelJob(job.id, athleteId);
    await advance(athleteId, id, "running", "failed", {
      error: "The quote was already spent.",
    });
    return refuse(409, "This quote was already spent.");
  }
  if (!(await claimJob(job.id, athleteId))) {
    await advance(athleteId, id, "running", "failed", {
      job_id: job.id,
      error: "The job could not be claimed.",
    });
    return refuse(409, "This edit could not start.");
  }
  return executeEdit(athleteId, row, brief, job, { signal: input.signal });
}

// ─── accept / discard ───────────────────────────────────────────────────────────────────────────────────

export async function acceptEdit(input: {
  athleteId: string;
  id: string;
}): Promise<
  { ok: true; row: StudioEditPreview; assetId: string } | EditRefusal
> {
  const { athleteId, id } = input;
  const row = await readEditPreview(athleteId, id);
  if (!row) return refuse(404, "We couldn't find that edit.");
  // A batch's stage-A intermediate is ephemeral by law: it can never become a library row.
  // ⚠️ MUTATION (batch.test): accept it anyway — "intermediate persists as a library row" reds by name.
  if ((row.params as { role?: string } | null)?.role === "intermediate") {
    return refuse(
      409,
      "That is a working step, not a result — it is never kept.",
    );
  }
  if (row.status !== "ready" || !row.gcs_path || !row.job_id) {
    return refuse(
      409,
      `This edit is ${row.status}; only a finished preview can be accepted.`,
    );
  }
  if (isEditPreviewExpired(row))
    return refuse(409, "This preview has expired.");
  // The decision is claimed first, so two taps write one row.
  if (
    !(await advance(athleteId, id, "ready", "accepted", {
      decided_at: new Date(),
    }))
  ) {
    return refuse(409, "This edit was already decided.");
  }
  try {
    const bytes = await readObject(row.gcs_path);
    if (!bytes)
      throw new GenerationError(
        "The preview's bytes are gone",
        "provider_error",
      );
    const saved = await saveBuffer(
      bytes.buf,
      studioObjectBase(athleteId, row.job_id, 0),
      bytes.contentType,
    );
    if ("skipped" in saved)
      throw new GenerationError(
        "The edit is over the media size cap",
        "provider_error",
      );
    // THE library write. Origin 'generated', derived from the source, its own job — never 'upload'.
    const asset = await recordGeneratedAsset({
      athleteId,
      jobId: row.job_id,
      gcsPath: saved.gcs_path,
      contentType: saved.content_type,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      bytes: saved.bytes,
      bytes_buffer: bytes.buf,
      mediaType: "IMAGE",
      derivedFromAssetId: row.source_asset_id,
    });
    await advance(athleteId, id, "accepted", "accepted", {
      accepted_asset_id: asset.id,
    });
    await deleteObject(row.gcs_path).catch((err) =>
      logger.warn(
        { athleteId, editPreviewId: id, err },
        "accepted edit's preview object was not deleted",
      ),
    );
    logger.info(
      {
        athleteId,
        editPreviewId: id,
        assetId: asset.id,
        derivedFrom: row.source_asset_id,
        op: row.op,
      },
      "edit accepted — recorded as a draft asset, edited-from its source",
    );
    // PR 18 (R-6, R-13): her face, output → source, on HER band, as an observation — started AFTER the library
    // write and never awaited. The accept's result is exactly today's whether it runs, skips or fails.
    observeInBackground({
      athleteId,
      sourceAssetId: row.source_asset_id,
      outputAssetId: asset.id,
      outputBytes: bytes.buf,
      outputMimeType: bytes.contentType,
      jobId: row.job_id,
      instruction: (row.params as { sentence?: string } | null)?.sentence ?? "",
    });
    const after = (await readEditPreview(athleteId, id))!;
    return { ok: true, row: after, assetId: asset.id };
  } catch (err) {
    await advance(athleteId, id, "accepted", "ready", {
      decided_at: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function discardEdit(input: {
  athleteId: string;
  id: string;
}): Promise<{ ok: true; row: StudioEditPreview } | EditRefusal> {
  const { athleteId, id } = input;
  const row = await readEditPreview(athleteId, id);
  if (!row) return refuse(404, "We couldn't find that edit.");
  if (row.status !== "ready" && row.status !== "quoted") {
    return refuse(
      409,
      `This edit is ${row.status}; only a quote or a finished preview can be discarded.`,
    );
  }
  if (
    !(await advance(athleteId, id, row.status, "discarded", {
      decided_at: new Date(),
    }))
  ) {
    return refuse(409, "This edit was already decided.");
  }
  if (row.gcs_path) {
    await deleteObject(row.gcs_path).catch((err) =>
      logger.warn(
        { athleteId, editPreviewId: id, err },
        "discarded edit's preview object was not deleted",
      ),
    );
  }
  logger.info(
    { athleteId, editPreviewId: id, op: row.op, was: row.status },
    "edit discarded — nothing entered her library",
  );
  const after = (await readEditPreview(athleteId, id))!;
  return { ok: true, row: after };
}

/**
 * A row as the client sees it: no object paths, a signed url while the preview stands — and NOTHING signed
 * once it has expired (PR 10, R-7): `{ url: null, expired: true }`, so a screen holding a stale row can say
 * why. ⚠️ MUTATION (batch.test): sign on status alone — "an expired ready row shows under Now" reds.
 */
export async function presentEdit(row: StudioEditPreview) {
  const expired = isEditPreviewExpired(row);
  const url =
    row.status === "ready" && row.gcs_path && !expired
      ? await signedUrl(row.gcs_path)
      : null;
  return {
    expired,
    id: row.id,
    sourceAssetId: row.source_asset_id,
    op: row.op as StudioEditOp,
    status: row.status,
    batchId: row.batch_id,
    url,
    width: row.width,
    height: row.height,
    costQuotedUsd:
      row.cost_quoted_usd === null ? null : Number(row.cost_quoted_usd),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    acceptedAssetId: row.accepted_asset_id,
    /** A batch's stage-A working step (studio/edit/batch.ts) — never a candidate, never kept. */
    intermediate:
      (row.params as { role?: string } | null)?.role === "intermediate",
    error: row.error,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
