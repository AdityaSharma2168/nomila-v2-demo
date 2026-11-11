/**
 * studio/reference/styleStore — her already-read style references, read under her athlete id (PR 18).
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `athleteId` is ALWAYS `req.athleteId` (or the engine's). The analysis and the asset are read with it in the
 * predicate, so another athlete's reference is indistinguishable from one that was never read.
 * ⚠️ MUTATION (styleSpec.test "another athlete's reading resolves to nothing"): drop the athlete predicate.
 *
 * No model call anywhere in this file: the spec is derived from what is stored (styleSpec.ts, ADI-GO18 G1).
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets, studioReferenceAnalyses } from "../../../shared/schema";
import { referenceDecompositionSchema } from "./schema";
import {
  styleSpecFrom,
  type AnalysisRow,
  type StyleRefusal,
  type StyleSpec,
} from "./styleSpec";

type Client = Pick<typeof db, "select">;

/** Her newest style reading of one image, or null. Tenancy in the predicate. */
export async function newestStyleReading(
  athleteId: string,
  assetId: string,
  client: Client = db,
): Promise<AnalysisRow | null> {
  const [row] = await client
    .select({
      id: studioReferenceAnalyses.id,
      source_asset_id: studioReferenceAnalyses.source_asset_id,
      role: studioReferenceAnalyses.role,
      decomposition: studioReferenceAnalyses.decomposition,
      prompt_version: studioReferenceAnalyses.prompt_version,
      model: studioReferenceAnalyses.model,
    })
    .from(studioReferenceAnalyses)
    .where(
      and(
        eq(studioReferenceAnalyses.athlete_id, athleteId),
        eq(studioReferenceAnalyses.source_asset_id, assetId),
        eq(studioReferenceAnalyses.role, "style_reference"),
      ),
    )
    .orderBy(desc(studioReferenceAnalyses.created_at))
    .limit(1);
  return row ?? null;
}

/** A style reference as the brief carries it. `ref` is the stored path for provenance; it is never planned. */
export interface ResolvedStyleReference {
  role: "style_reference";
  ref: string;
  mediaAssetId: string;
  style: StyleSpec;
}

/**
 * One of her images, as a style reference: the asset under her id, then its newest style reading, then the spec.
 * `known` is the asset row when the caller already read it under her id (the preview route's `readOwnedImage`).
 */
export async function resolveStyleReference(
  athleteId: string,
  assetId: string,
  known?: { id: string; gcs_path: string | null } | null,
): Promise<
  | { ok: true; reference: ResolvedStyleReference }
  | { ok: false; reason: StyleRefusal }
> {
  let asset = known ?? null;
  if (!asset) {
    const [row] = await db
      .select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, assetId),
          eq(mediaAssets.athlete_id, athleteId),
          eq(mediaAssets.status, "stored"),
          eq(mediaAssets.media_type, "IMAGE"),
          isNull(mediaAssets.deleted_at),
        ),
      )
      .limit(1);
    asset = row ?? null;
  }
  if (!asset?.gcs_path) return { ok: false, reason: "style_not_found" };
  const reading = await newestStyleReading(athleteId, asset.id);
  const spec = reading ? styleSpecFrom(reading) : null;
  if (!spec) return { ok: false, reason: "style_unread" };
  return {
    ok: true,
    reference: {
      role: "style_reference",
      ref: asset.gcs_path,
      mediaAssetId: asset.id,
      style: spec,
    },
  };
}

/** One row of the picker: an image of hers that has a style reading. The picker offers nothing else (G8). */
export interface ReadStyleReference {
  assetId: string;
  analysisId: string;
  gcsPath: string;
  /** Her reading's light and mood, for the tile's caption. Model-written; the client renders it as text only. */
  caption: string;
  readAt: string;
}

/** Her already-read style references, newest first, one per image. */
export async function listReadStyleReferences(
  athleteId: string,
  limit = 30,
): Promise<ReadStyleReference[]> {
  const rows = await db
    .select({
      analysisId: studioReferenceAnalyses.id,
      assetId: studioReferenceAnalyses.source_asset_id,
      decomposition: studioReferenceAnalyses.decomposition,
      createdAt: studioReferenceAnalyses.created_at,
      gcsPath: mediaAssets.gcs_path,
    })
    .from(studioReferenceAnalyses)
    .innerJoin(
      mediaAssets,
      and(
        eq(mediaAssets.id, studioReferenceAnalyses.source_asset_id),
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .where(
      and(
        eq(studioReferenceAnalyses.athlete_id, athleteId),
        eq(studioReferenceAnalyses.role, "style_reference"),
      ),
    )
    .orderBy(desc(studioReferenceAnalyses.created_at))
    .limit(limit * 3);
  const seen = new Set<string>();
  const out: ReadStyleReference[] = [];
  for (const r of rows) {
    if (!r.assetId || !r.gcsPath || seen.has(r.assetId)) continue;
    const parsed = referenceDecompositionSchema.safeParse(r.decomposition);
    if (!parsed.success) continue;
    seen.add(r.assetId);
    const i = parsed.data.reference_intent;
    out.push({
      assetId: r.assetId,
      analysisId: r.analysisId,
      gcsPath: r.gcsPath,
      caption: i.lighting.summary,
      readAt: r.createdAt.toISOString(),
    });
    if (out.length >= limit) break;
  }
  return out;
}
