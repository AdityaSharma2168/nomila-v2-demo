/**
 * studio/qa/chain — find the ORIGINAL photograph an output descends from.
 *
 * ─── WHY THE ROOT AND NEVER THE PARENT ─────────────────────────────────────────────────────────
 *
 * Every check compares against the root of the edit chain. Comparing against the immediately
 * preceding step is the intuitive thing and it is wrong in a specific, quiet way: a chain of edits
 * each measured against its own parent reports four small innocent deltas, and never notices that
 * the fourth output no longer resembles the photograph she uploaded. Drift accumulates; a
 * step-by-step measurement is blind to exactly the quantity it is supposed to be measuring.
 *
 * Against the root, cumulative drift is IN the number. A face distance of 0.4 at chainDepth 4 is a
 * different fact from 0.4 at depth 1, and the record carries the depth so the two are never
 * confused.
 *
 * ─── THE LINEAGE POINTER ALREADY EXISTS ────────────────────────────────────────────────────────
 *
 * `media_assets.derived_from_asset_id` is written by `recordGeneratedAsset` on every edit and is
 * NULL for a generate, which by definition has no source frame. So the root is a walk up that
 * column until it runs out. `shared/schema.ts` declares it ON DELETE SET NULL deliberately —
 * "losing a pointer is recoverable; losing the asset is not" — which means a broken link is an
 * expected state and not a bug: the walk stops and reports the furthest ancestor it could reach.
 *
 * ─── ⚠️  TENANCY IS IN THE PREDICATE AT EVERY HOP ──────────────────────────────────────────────
 *
 * A pointer is just a uuid, and this walk follows pointers. Every SELECT carries
 * `athlete_id = <caller's>`, so a row belonging to another athlete is simply not found and the walk
 * stops there — it can never read across a tenancy boundary even if a lineage pointer somehow
 * crossed one. That is the rule from `server/CLAUDE.md`, applied to the loop rather than to a
 * single query, and it is why the athlete id is a required argument here rather than optional.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { createLogger } from "../../logger";

const logger = createLogger("studio/qa/chain");

/**
 * How far up the walk will go before it stops and says so.
 *
 * A cap rather than trust: `derived_from_asset_id` is a self-referencing FK with no constraint
 * preventing a cycle, and an unbounded walk on a cycle is an infinite loop holding a database
 * connection. A `seen` set catches a true cycle; this catches a chain that is merely absurd.
 */
const MAX_CHAIN_DEPTH = Number(process.env.STUDIO_QA_MAX_CHAIN_DEPTH ?? 24);

export interface ChainRoot {
  /** The furthest ancestor reachable. Equals the input id when the asset is not derived. */
  rootAssetId: string;
  gcsPath: string | null;
  /** Hops from the output to the root. 0 = the asset IS the root; 1 = a direct edit. */
  depth: number;
  /** True when the walk stopped early — a cycle, the depth cap, or a severed pointer. */
  truncated: boolean;
  reason: "root" | "cycle" | "depth_cap" | "missing_ancestor" | null;
}

/**
 * Walk `derived_from_asset_id` to the top, scoped to one athlete.
 *
 * Returns the asset itself as its own root when nothing is above it — a `generate` output, or an
 * uploaded frame. A caller comparing an asset against itself is meaningless, so `depth === 0` is
 * the signal to skip the comparison rather than to compare.
 */
export async function findChainRoot(
  assetId: string,
  athleteId: string,
): Promise<ChainRoot | null> {
  const seen = new Set<string>([assetId]);
  let currentId = assetId;
  let current = await load(currentId, athleteId);
  if (!current) return null;

  let depth = 0;
  while (current.derived_from_asset_id) {
    const nextId = current.derived_from_asset_id;

    if (seen.has(nextId)) {
      logger.warn(
        { assetId, at: nextId, depth },
        "lineage cycle — stopping the walk",
      );
      return {
        rootAssetId: currentId,
        gcsPath: current.gcs_path,
        depth,
        truncated: true,
        reason: "cycle",
      };
    }
    if (depth >= MAX_CHAIN_DEPTH) {
      logger.warn(
        { assetId, depth },
        "lineage deeper than the cap — stopping the walk",
      );
      return {
        rootAssetId: currentId,
        gcsPath: current.gcs_path,
        depth,
        truncated: true,
        reason: "depth_cap",
      };
    }

    const next = await load(nextId, athleteId);
    if (!next) {
      // Either the row is gone or it belongs to someone else. Both stop here, and both are
      // reported rather than silently treated as the root — a caller must be able to tell
      // "this IS the original" from "we could not get to the original".
      logger.info(
        { assetId, missing: nextId, depth },
        "lineage pointer does not resolve under this athlete",
      );
      return {
        rootAssetId: currentId,
        gcsPath: current.gcs_path,
        depth,
        truncated: true,
        reason: "missing_ancestor",
      };
    }

    seen.add(nextId);
    currentId = nextId;
    current = next;
    depth++;
  }

  return {
    rootAssetId: currentId,
    gcsPath: current.gcs_path,
    depth,
    truncated: false,
    reason: "root",
  };
}

async function load(id: string, athleteId: string) {
  const [row] = await db
    .select({
      id: mediaAssets.id,
      gcs_path: mediaAssets.gcs_path,
      derived_from_asset_id: mediaAssets.derived_from_asset_id,
    })
    .from(mediaAssets)
    // TENANCY: in the predicate, every hop. See the header.
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.athlete_id, athleteId)))
    .limit(1);
  return row ?? null;
}
