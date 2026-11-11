/**
 * studio/edit/identityOnAccept — an accepted typed edit's face, against its own source, on HER band (PR 18, R-6).
 *
 * PR 16's K23 (typed edits ran no QA) and PR 17's carded "inspect on accept", arriving together, as an
 * OBSERVATION and nothing more:
 *
 *   * GATED on STUDIO_STYLE_SPEC && STUDIO_IDENTITY_PACK (ADI-GO18 G10). Off, nothing is read and nothing spent.
 *   * ONLY WHERE HER CONTROL PASSED. `bandFor` (identity/profile.ts) answers null unless her stranger control
 *     passed and a band is on her row, and then there is NO observation: no fallback to the global band, whose
 *     ruler failed its own control (qa/identity.ts, DEAD_RULER_CAVEAT). ⚠️ MUTATION (identityOnAccept.test "an
 *     identity score is shown for an athlete whose control failed"): read the band without `bandFor`.
 *   * OUTPUT → SOURCE (G10): `checkIdentity`, unchanged, with her band handed in. Two face boxes and two embeds,
 *     ≈ $0.00128 (qa/cost.ts:46; identity-pack.md:133). The pack comparison is carded (K-S2).
 *   * FLAG-OR-PASS, NEVER A THRESHOLD, NEVER AN ACTION. `checkIdentity`'s own wording: "above the band" is a
 *     flag to look, never `fail`. Nothing reads it to decide anything.
 *   * NEVER BLOCKS THE ACCEPT (R-13). The engine starts this AFTER the library write and does not await it. A
 *     missing pack, a failed control, an embed that does not return or any throw here produces no observation
 *     and no error: the accept is exactly today's. ⚠️ MUTATIONS: await it inside acceptEdit, or let it throw
 *     ("a failed identity check blocks an accept"); drop the call ("an accepted edit is never inspected").
 *
 * Recorded on the ACCEPTED asset's row, `metadata.edit_identity`, merged in one statement (`metadata || {...}`)
 * with her athlete id in the predicate, so no other writer's key is read back and overwritten. Nothing about her
 * face is kept: the crops are embedded in memory and dropped, and only the distance survives (qa/identity.ts,
 * "Legal").
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { readObject } from "../../lib/mediaStore";
import { GEMINI } from "../../lib/models";
import { withTimeout } from "../../lib/withTimeout";
import { createLogger } from "../../logger";
import { identityPackEnabled, styleSpecEnabled } from "../config";
import { bandFor } from "../identity/profile";
import { recordOffRouterSpend } from "../qa/cost";
import { checkIdentity, type IdentityDetail } from "../qa/identity";

const logger = createLogger("studio/edit/identityOnAccept");

/** The key this module owns inside `metadata`. Nothing else writes it. */
export const EDIT_IDENTITY_KEY = "edit_identity";

const OBSERVATION_TIMEOUT_MS = 45_000;

export interface EditIdentityObservation {
  /** "pass" inside or below her band, "flag" above it. Never "fail". */
  status: "pass" | "flag";
  summary: string;
  detail: IdentityDetail;
  /** Her band, and that it IS hers: only ever written when her control passed. */
  band: {
    min: number;
    max: number;
    pairs: number;
    source: "her-control-passed";
  };
  spendUsd: number;
  at: string;
}

export type ObserveOutcome = "observed" | "skipped" | "no_observation";

export interface AcceptedEdit {
  athleteId: string;
  sourceAssetId: string;
  outputAssetId: string;
  outputBytes: Buffer;
  outputMimeType: string;
  jobId: string;
  /** The sentence the op wrote. Recorded on the pair as every inspection's pair is; no model reads it here. */
  instruction: string;
}

async function sourceBytes(
  athleteId: string,
  assetId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const [row] = await db
    .select({ gcs_path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
    )
    .limit(1);
  if (!row?.gcs_path) return null;
  const obj = await readObject(row.gcs_path);
  return obj ? { bytes: obj.buf, mimeType: obj.contentType } : null;
}

/** One accepted edit, observed or not. Never throws. */
export async function observeAcceptedEdit(
  e: AcceptedEdit,
): Promise<ObserveOutcome> {
  if (!styleSpecEnabled() || !identityPackEnabled()) return "skipped";
  try {
    return await withTimeout(
      (async (): Promise<ObserveOutcome> => {
        const band = await bandFor(e.athleteId);
        if (!band) return "skipped"; // no pack, or her control did not pass: no observation, nothing spent
        const source = await sourceBytes(e.athleteId, e.sourceAssetId);
        if (!source) return "no_observation";
        const result = await checkIdentity(
          {
            sourceAssetId: e.sourceAssetId,
            sourceBytes: source.bytes,
            sourceMimeType: source.mimeType,
            outputAssetId: e.outputAssetId,
            outputBytes: e.outputBytes,
            outputMimeType: e.outputMimeType,
            chainDepth: 1,
            instruction: e.instruction,
          },
          band,
        );
        await recordOffRouterSpend({
          task: "image.inspect",
          model: GEMINI.flash,
          spend: result.spend,
          latencyMs: result.latencyMs,
          inputRefs: [e.sourceAssetId, e.outputAssetId],
          attribution: { assetId: e.outputAssetId, jobId: e.jobId },
        });
        // No distance (no face, or the embedding did not return): no observation. R-13.
        if (
          !result.detail ||
          (result.status !== "pass" && result.status !== "flag")
        )
          return "no_observation";
        const observation: EditIdentityObservation = {
          status: result.status,
          summary: result.summary,
          detail: result.detail,
          band: { ...band, source: "her-control-passed" },
          spendUsd: result.spend.usd,
          at: new Date().toISOString(),
        };
        await db
          .update(mediaAssets)
          .set({
            metadata: sql`coalesce(${mediaAssets.metadata}, '{}'::jsonb) || jsonb_build_object(${EDIT_IDENTITY_KEY}::text, ${JSON.stringify(observation)}::jsonb)`,
            metadata_updated_at: new Date(),
          })
          .where(
            and(
              eq(mediaAssets.id, e.outputAssetId),
              eq(mediaAssets.athlete_id, e.athleteId),
            ),
          );
        logger.info(
          {
            assetId: e.outputAssetId,
            status: observation.status,
            distance: observation.detail.distance,
            band: observation.detail.band,
            usd: observation.spendUsd,
          },
          "accepted edit's identity observed — not gated",
        );
        return "observed";
      })(),
      OBSERVATION_TIMEOUT_MS,
      "accepted edit identity",
    );
  } catch (err: unknown) {
    logger.warn(
      {
        assetId: e.outputAssetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "accepted edit's identity observation did not complete",
    );
    return "no_observation";
  }
}

/** In flight, so a test (or a graceful shutdown) can wait for them. The accept itself never does. */
const inFlight = new Set<Promise<ObserveOutcome>>();

/** Start an observation without waiting for it. The accept's response does not depend on it in any way. */
export function observeInBackground(e: AcceptedEdit): void {
  const p = observeAcceptedEdit(e).catch(
    () => "no_observation" as ObserveOutcome,
  );
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/** Resolves once every observation started so far has finished. */
export async function settleEditIdentity(): Promise<ObserveOutcome[]> {
  return Promise.all([...inFlight]);
}
