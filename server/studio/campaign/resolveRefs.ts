/**
 * studio/campaign/resolveRefs — `ref_N` → the asset it was read from (PR 14, R-6).
 *
 * A brief's reference is an opaque handle (`ref_1`) with a role and its §7 reading. The reading was
 * written by the reference engine and stored as `studio_reference_analyses.decomposition`, whose
 * `reference_intent` IS the brief's `intent`, unedited (the client only renders it). So the row is
 * found by equality, under her athlete id: same role, same reading, newest first. No id crosses the
 * wire for this — the handle stays opaque and the join is ours.
 *
 * Runs ONCE, on the plan route at save time, so the plan row is self-contained. A reference whose
 * analysis no longer exists (her photo deleted → CASCADE) or was read from text (no asset) resolves to
 * nothing and the brief is stored without an `assetId` for it — never an error: an unresolved reading
 * still reaches the planner exactly as it did before this existed.
 *
 * ⚠️ TENANCY: `athlete_id` is in every query. ⚠️ MUTATION (resolveRefs.test): drop it — "ref_N resolves
 * to another athlete's reading" reds by name.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { studioReferenceAnalyses } from "../../../shared/schema";
import type { CampaignBrief } from "./brief";

type Client = Pick<typeof db, "select">;

/** The brief with each resolvable reference's `assetId` set. Pure over its input; one SELECT per reference. */
export async function resolveReferenceAssets(
  athleteId: string,
  brief: CampaignBrief,
  client: Client = db,
): Promise<CampaignBrief> {
  if (!brief.references.length) return brief;
  const references = await Promise.all(
    brief.references.map(async (r) => {
      const { assetId: _posted, ...clean } = r as typeof r & {
        assetId?: string;
      };
      if (!r.intent) return clean;
      const [row] = await client
        .select({ assetId: studioReferenceAnalyses.source_asset_id })
        .from(studioReferenceAnalyses)
        .where(
          and(
            eq(studioReferenceAnalyses.athlete_id, athleteId),
            eq(studioReferenceAnalyses.role, r.role),
            sql`${studioReferenceAnalyses.decomposition}->'reference_intent' = ${JSON.stringify(r.intent)}::jsonb`,
          ),
        )
        .orderBy(desc(studioReferenceAnalyses.created_at))
        .limit(1);
      return row?.assetId ? { ...clean, assetId: row.assetId } : clean;
    }),
  );
  return { ...brief, references };
}

/** The brief with every server-set `assetId` removed — what the replan route re-posts, so the child re-resolves. */
export function stripReferenceAssets(brief: unknown): unknown {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) return brief;
  const b = brief as { references?: unknown };
  if (!Array.isArray(b.references)) return brief;
  return {
    ...b,
    references: b.references.map((r) => {
      if (!r || typeof r !== "object") return r;
      const { assetId: _dropped, ...rest } = r as { assetId?: unknown };
      return rest;
    }),
  };
}

/** True when any posted reference carries an `assetId` — refused at the plan route: it is set here, never sent. */
export function postsReferenceAsset(raw: unknown): boolean {
  const refs = (raw as { references?: unknown } | null)?.references;
  return (
    Array.isArray(refs) &&
    refs.some((r) => !!r && typeof r === "object" && "assetId" in (r as object))
  );
}
