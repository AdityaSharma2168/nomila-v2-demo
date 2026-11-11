/**
 * studio/qa/inspect — the entry point. Resolve an asset's chain, fetch both frames, run the stage.
 *
 * Two callers, one path: the observation-only hook in studio/generate.ts, and the backfill script
 * that re-inspects assets already in the library. Both get the same verdict for the same reason —
 * a backfilled verdict that was computed differently from a live one is not comparable to it, and
 * comparing them is the entire purpose of recording them.
 *
 * ─── ⚠️  NOTHING HERE CAN FAIL A GENERATION ────────────────────────────────────────────────────
 *
 * `inspectAsset` returns null instead of throwing, on every path: the asset is not derived, the
 * root has no pixels, GCS is unreachable, the checks all fail. By the time this runs the model call
 * is paid for and the asset is stored, so an exception escaping here would destroy something
 * valuable to report something worthless. That is the same inversion studio/segment.ts argues for.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { signedUrl } from "../../lib/mediaStore";
import { withTimeout } from "../../lib/withTimeout";
import { createLogger } from "../../logger";
import { findChainRoot } from "./chain";
import { observeAddFraming } from "./framing";
import {
  observeGenerateIdentity,
  type GenerateIdentityObservation,
} from "./identity";
import { identityTargetsFor } from "./identitySet";
import { bandFor } from "../identity/profile";
import { identityPackEnabled } from "../config";
import { writeVerdict } from "./record";
import { GEMINI } from "../../lib/models";
import { recordOffRouterSpend } from "./cost";
import {
  runCreativeQa,
  runGenerateQa,
  summarize,
  withFramingObservation,
  withIdentityObservation,
  type CreativeQaVerdict,
} from "./verdict";
import type { ComparisonPair, MarkProvenance } from "./types";

const logger = createLogger("studio/qa/inspect");

/** The whole stage, end to end. Generous, because four checks run inside it. */
const QA_TOTAL_TIMEOUT_MS = Number(process.env.STUDIO_QA_TIMEOUT_MS ?? 90_000);

/**
 * The identity observation's own bound, well inside the stage's. It runs beside the generate checks,
 * and a slow comparison must never be the reason the whole stage times out and the text check's
 * verdict never reaches the record.
 */
const IDENTITY_OBSERVATION_TIMEOUT_MS = 45_000;

async function fetchBytes(
  gcsPath: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(await signedUrl(gcsPath));
    if (!res.ok) return null;
    const ext = gcsPath.split(".").pop()?.toLowerCase() ?? "jpg";
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mimeType:
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg",
    };
  } catch {
    return null;
  }
}

export interface InspectOptions {
  /** Her instruction for this step. Falls back to the frozen brief's direction when absent. */
  instruction?: string;
  /**
   * Which brand marks the edit asked to bring in or take away, on a job the interpreter proposed
   * (qa/marks.ts, N7). Absent: marks are judged by the instruction alone, as always.
   */
  provenance?: MarkProvenance;
  /**
   * The things this edit's frozen intent added AT A PLACE — `placedAdds` off the compile tier (wave B,
   * addition (a)). Non-empty is what fires the framing observation, and the caller reads the SAME
   * predicate the prompt's framing line fires on, so the record can never say "the frame moved" about
   * a prompt that never carried the line. Absent or empty: nothing is measured and nothing is recorded.
   */
  placedAdds?: readonly string[];
  /** Write the verdict to the asset's metadata. The script passes false for a dry run. */
  persist?: boolean;
}

/**
 * Inspect one stored asset: an EDIT against the root of its chain, or a GENERATE on its own.
 *
 * Returns null — and records nothing — only when there is genuinely nothing to look at: no stored
 * pixels, unreadable lineage, a root whose pixels are gone, or a depth-0 asset we did not generate
 * (an upload). A generate is no longer one of those cases; see the depth-0 branch in `inner`.
 */
export async function inspectAsset(
  assetId: string,
  athleteId: string,
  opts: InspectOptions = {},
): Promise<CreativeQaVerdict | null> {
  try {
    return await withTimeout(
      inner(assetId, athleteId, opts),
      QA_TOTAL_TIMEOUT_MS,
      "creative QA",
    );
  } catch (err: unknown) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "creative QA did not complete",
    );
    return null;
  }
}

async function inner(
  assetId: string,
  athleteId: string,
  opts: InspectOptions,
): Promise<CreativeQaVerdict | null> {
  const [row] = await db
    .select({
      gcs_path: mediaAssets.gcs_path,
      generation_job_id: mediaAssets.generation_job_id,
    })
    .from(mediaAssets)
    // TENANCY: in the predicate, as everywhere on this path.
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
    )
    .limit(1);

  if (!row?.gcs_path) {
    logger.info({ assetId }, "asset has no stored pixels — nothing to inspect");
    return null;
  }

  const chain = await findChainRoot(assetId, athleteId);
  if (!chain) {
    logger.info({ assetId }, "lineage did not resolve — not inspecting");
    return null;
  }

  // ─── A GENERATE IS INSPECTED NOW, AND UNTIL TODAY IT NEVER WAS ────────────────────────────────
  //
  // This branch used to read `chain.depth === 0 → return null`, on the reasoning that a generate
  // has no source frame to compare against. That was true of every check that existed, and it
  // meant NOT ONE generated image has ever been inspected — which is also why the record could
  // never answer whether a generate holds a face worse than an edit does.
  //
  // Two checks need no source at all (verdict.ts `runGenerateQa`): the text check that reads a
  // name off the kit, and anatomy, which only ever looked at the output anyway.
  //
  // ⚠️ ONLY SOMETHING WE MADE. `generation_job_id` is the gate, because an UPLOADED photograph is
  // also depth 0 — her own camera roll is not ours to inspect, and reading text off her real life
  // would spend her money to do it.
  if (chain.depth === 0) {
    if (!row.generation_job_id) {
      logger.info(
        { assetId },
        "asset is depth 0 and was not generated here — not inspecting",
      );
      return null;
    }
    const generated = await fetchBytes(row.gcs_path);
    if (!generated) {
      logger.warn(
        { assetId },
        "could not fetch the generated frame — not inspecting",
      );
      return null;
    }
    const [checked, observation] = await Promise.all([
      runGenerateQa({
        outputAssetId: assetId,
        outputBytes: generated.bytes,
        outputMimeType: generated.mimeType,
        instruction:
          opts.instruction ??
          (await instructionFor(row.generation_job_id, athleteId)),
      }),
      observeIdentity(assetId, row.generation_job_id, athleteId, generated),
    ]);
    const verdict = withIdentityObservation(checked, observation);
    logger.info(
      { assetId, verdict: summarize(verdict) },
      "creative QA complete (generate)",
    );
    if (opts.persist !== false) await writeVerdict(assetId, athleteId, verdict);
    // The cost line (PR 11, R-2): what this inspection spent, joined to the asset and its job. The
    // verdict already carries the total; this is the same figure where the cost report can see it.
    await recordOffRouterSpend({
      task: "image.inspect",
      model: GEMINI.flash,
      spend: verdict.spend,
      latencyMs: verdict.latencyMs,
      inputRefs: [assetId],
      attribution: { assetId, jobId: row.generation_job_id },
    });
    return verdict;
  }
  if (!chain.gcsPath) {
    logger.info(
      { assetId, rootAssetId: chain.rootAssetId },
      "chain root has no stored pixels",
    );
    return null;
  }

  const [source, output] = await Promise.all([
    fetchBytes(chain.gcsPath),
    fetchBytes(row.gcs_path),
  ]);
  if (!source || !output) {
    logger.warn({ assetId }, "could not fetch both frames — not inspecting");
    return null;
  }

  const instruction =
    opts.instruction ??
    (await instructionFor(row.generation_job_id, athleteId));

  const pair: ComparisonPair = {
    sourceAssetId: chain.rootAssetId,
    sourceBytes: source.bytes,
    sourceMimeType: source.mimeType,
    outputAssetId: assetId,
    outputBytes: output.bytes,
    outputMimeType: output.mimeType,
    chainDepth: chain.depth,
    instruction,
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  };

  // The framing observation runs BESIDE the checks rather than inside them, for the same reason the
  // identity one does on the generate branch: it is not a check, and a slow alignment must not be the
  // reason a check's verdict never reaches the record. It makes no model call, so nothing here spends.
  // HER band, only with STUDIO_IDENTITY_PACK on and only when her stranger control passed (PR 17,
  // R-4); otherwise undefined and checkIdentity reads the global const exactly as before.
  const band = identityPackEnabled() ? await bandFor(athleteId) : null;
  const [checked, framing] = await Promise.all([
    runCreativeQa(pair, {
      chainTruncated: chain.truncated,
      ...(band ? { band } : {}),
    }),
    observeAddFraming({
      sourceBytes: source.bytes,
      outputBytes: output.bytes,
      placedAdds: opts.placedAdds ?? [],
    }),
  ]);
  const verdict = withFramingObservation(checked, framing);
  if (framing) {
    logger.info(
      {
        assetId,
        placedAdds: framing.placedAdds,
        reframed: framing.reframed,
        reason: framing.reason,
        scale: framing.fit?.scale ?? null,
        dxFrac: framing.fit?.dxFrac ?? null,
        dyFrac: framing.fit?.dyFrac ?? null,
        baseline: framing.baseline?.convention ?? null,
        excessScale: framing.excess?.scale ?? null,
        excessShift: framing.excess?.shift ?? null,
        ms: framing.latencyMs,
      },
      "add framing observed — not gated",
    );
  }
  logger.info({ assetId, verdict: summarize(verdict) }, "creative QA complete");

  if (opts.persist !== false) await writeVerdict(assetId, athleteId, verdict);
  // The cost line (PR 11, R-2) — same as the generate branch above; the chain root is the second
  // input the checks read.
  await recordOffRouterSpend({
    task: "image.inspect",
    model: GEMINI.flash,
    spend: verdict.spend,
    latencyMs: verdict.latencyMs,
    inputRefs: [chain.rootAssetId, assetId],
    attribution: { assetId, jobId: row.generation_job_id },
  });
  return verdict;
}

/**
 * R0.b — a generate's face against the photographs of her it was built from and her held-out set.
 *
 * OBSERVATION ONLY. It returns a record for `withIdentityObservation` to attach and nothing reads it
 * to decide anything. Null — with nothing fetched and nothing spent — when the job carried no person
 * reference; null on any failure, because this stage never fails anything.
 */
async function observeIdentity(
  assetId: string,
  jobId: string,
  athleteId: string,
  output: { bytes: Buffer; mimeType: string },
): Promise<GenerateIdentityObservation | null> {
  try {
    return await withTimeout(
      (async () => {
        const targets = await identityTargetsFor(jobId, athleteId);
        if (targets.length === 0) return null;
        const fetched = await Promise.all(
          targets.map(async (t) => {
            const image = await fetchBytes(t.gcsPath);
            return {
              ...t,
              bytes: image?.bytes ?? null,
              mimeType: image?.mimeType ?? "image/jpeg",
            };
          }),
        );
        const observation = await observeGenerateIdentity(
          { ...output, assetId },
          fetched,
        );
        // ⚠️ DEAD RULER: these numbers failed their stranger control (qa/identity.ts). Logged and
        // recorded for a replacement instrument to be validated against — never read as her likeness.
        logger.info(
          {
            assetId,
            references: fetched.filter(
              (t) => t.comparedAgainst === "references",
            ).length,
            identitySet: fetched.filter(
              (t) => t.comparedAgainst === "identity-set",
            ).length,
            outputFace: observation.outputFace !== null,
            outputReason: observation.outputReason,
            referencesMean: observation.referencesMean,
            referencesCount: observation.referencesCount,
            identitySetMean: observation.identitySetMean,
            identitySetCount: observation.identitySetCount,
            // Codes and asset ids only — which photograph scored nothing, and why.
            misses: observation.comparisons.flatMap((c) =>
              c.reason ? [{ assetId: c.assetId, reason: c.reason }] : [],
            ),
            usd: observation.spend.usd,
          },
          "generate identity observed — not gated, dead ruler",
        );
        return observation;
      })(),
      IDENTITY_OBSERVATION_TIMEOUT_MS,
      "generate identity observation",
    );
  } catch (err: unknown) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "generate identity observation did not complete",
    );
    return null;
  }
}

/**
 * Her sentence, out of the frozen brief: `brief.job.direction.statement`.
 *
 * `generation_jobs.brief` is the immutable record of exactly what was asked (studio/jobs.ts), so it
 * is the right source rather than anything reconstructed from a route or a log.
 *
 * ⚠️ THE STATEMENT IS NOT ALWAYS SOMETHING A HUMAN WROTE, AND THE BRIEF CANNOT TELL YOU WHICH.
 *
 * `directionFor` (studio/brief.ts) falls back to `goalFor(objective, brand)` when she typed
 * nothing, and stamps the result `set: "chosen", untrusted: false` — THE SAME VALUES her own typed
 * words get. So on a system-origin brief with no written direction, `statement` is our own
 * boilerplate with the brand's name interpolated into it, and nothing on the frozen record
 * distinguishes that from a real request. PR R (#380) added a private `explicitAsk()` for exactly
 * this distinction and did not export it.
 *
 * WHY THIS IS LATENT AND NOT LIVE: QA only inspects DERIVED assets (`chainDepth >= 1`), i.e. edits,
 * and an edit exists only because she wrote a sentence naming one — `editBaseFor` requires the
 * instruction before a job is an edit at all. So in the shipped path the statement on an inspected
 * job is her text. That is a coupling, not a guarantee, and it is written down rather than relied
 * on quietly: if a future path can produce an edit from an untyped brief, Q.4 will start scoring
 * outputs against a goal string nobody asked for and will look like it is working.
 *
 *   PROPOSAL FOR MIA — either export `explicitAsk`, or add `typed: boolean` to `BriefDirection` so
 *   the frozen record says whether a human wrote the statement. Blast radius for the second: one
 *   new field on a jsonb payload, written by one function, read by nobody today; old briefs simply
 *   lack it, which is what `undefined` is for. Not made here — brief.ts is shared code and outside
 *   this PR's scope.
 *
 * The sibling `untrusted` marks brand-authored text on the inbound arm. qa/adherence.ts delimits
 * the statement UNCONDITIONALLY rather than consulting it: a fence that trusts a label is one
 * mislabelled row away from being no fence.
 */
async function instructionFor(
  jobId: string | null,
  athleteId: string,
): Promise<string> {
  if (!jobId) return "";
  try {
    const { generationJobs } = await import("../../../shared/schema");
    const [job] = await db
      .select({ brief: generationJobs.brief })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.id, jobId),
          eq(generationJobs.athlete_id, athleteId),
        ),
      )
      .limit(1);
    const brief = job?.brief as Record<string, unknown> | undefined;
    const jobHalf = brief?.job as Record<string, unknown> | undefined;
    const direction = jobHalf?.direction as Record<string, unknown> | undefined;
    return typeof direction?.statement === "string" ? direction.statement : "";
  } catch {
    return "";
  }
}
